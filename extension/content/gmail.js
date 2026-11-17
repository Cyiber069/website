// Gmail adapter. Runs in the isolated world next to core.js on https://mail.google.com/*.
//
// What it does, in the words of the adapter contract in core.js:
//   probe     is Gmail loaded and signed in, and how many unread emails are in Primary
//   scan      unread Primary threads that look like a person writing (Atom feed first, list scan as fallback)
//   read      open one thread by its id, return its messages as plain text, go back to the inbox
//   prepare   for a new email: the compose address to load first
//   send      type a reply (or the new email) above the signature, press Send, prove it was sent
//   selftest  check the selectors and the Gmail settings this adapter depends on (never sends)
//
// Rules this file keeps:
//   * every selector and text pattern comes from the pack (extension/selectors/gmail.json)
//   * never wait on the address bar: Gmail rewrites #inbox/<hex id> to its own token right away
//   * never press a toolbar button unless the right thread is proven to be on screen
//   * never press Send unless the reply box shows exactly the text of the job
//   * an unclear send is reported as failed and not retryable, so a customer is never mailed twice
(() => {
  const ACX = globalThis.ACX;
  if (!ACX || ACX.channel !== 'gmail' || globalThis.__acxGmail) return;
  globalThis.__acxGmail = true;

  const { Fail, q, qa, val, rx, lookup, chain, visible, textOf, click, squash, sleep, waitFor } = ACX;
  const quiet = { quiet: true };
  const loadedAt = Date.now();

  // ---- small helpers ---------------------------------------------------------------------------

  const isHidden = () => document.visibilityState === 'hidden';

  /** A number from the pack, or the default. */
  const num = (key, dflt) => {
    const v = Number(lookup(key));
    return Number.isFinite(v) && v >= 0 ? v : dflt;
  };

  /**
   * How long to wait for Gmail to react. Gmail's own code is throttled in a hidden or covered
   * window, so waits are much longer there. `cap` keeps the wait inside the service worker's limit.
   */
  const patience = (cap) => Math.min(cap, isHidden() ? num('timing.waitHiddenMs', 70_000) : num('timing.waitVisibleMs', 20_000));

  /** Selector strings of a pack key (for keys that are plain lists, such as message.strip). */
  const selectorsOf = (key) => chain(key).map((e) => e.s);

  /** First element of the pack key that is actually laid out. Gmail keeps hidden decoys in the page. */
  function qShown(key, root = document) {
    for (const e of chain(key)) {
      try {
        for (let el of root.querySelectorAll(e.s)) {
          if (e.closest) el = el.closest(e.closest);
          if (el && visible(el)) return el;
        }
      } catch { /* a bad selector in a hot update */ }
    }
    return null;
  }

  /** Gmail writes "undefined" or "null" into some id attributes on some accounts: treat those as absent. */
  const cleanId = (v) => (v && v !== 'undefined' && v !== 'null' ? String(v).replace(/^#/, '') : '');

  const HEX_ID = /^[0-9a-f]{8,32}$/i;
  const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

  // ---- what this adapter remembers (survives page loads and Chrome restarts) -------------------------

  const STATE_KEY = 'gmail_adapter';
  let state = {
    jobs: {}, // job id -> { ids, at }: jobs already sent, so a job delivered twice is never sent twice
    sends: [], // { thread, text, parts, id, at }: what we sent, to recognise our own emails when reading
    skip: {}, // thread or feed id -> time: threads found to be automated mail when they were opened
    legacy: {}, // job id -> true: the new compose address did not open, use the old one next time
    email: '', // the account address, kept for pages whose title does not show it
  };
  const stateReady = (async () => {
    try {
      const raw = await chrome.storage.local.get(STATE_KEY);
      if (raw[STATE_KEY]) state = { ...state, ...raw[STATE_KEY] };
    } catch { /* storage unavailable: work from memory */ }
  })();

  async function saveState() {
    const cutoff = Date.now() - 14 * 86_400_000;
    for (const group of ['jobs', 'skip']) {
      for (const [k, v] of Object.entries(state[group])) {
        const at = typeof v === 'number' ? v : v && v.at;
        if (!at || at < cutoff) delete state[group][k];
      }
    }
    state.sends = state.sends.filter((s) => s.at > cutoff).slice(-80);
    const legacyKeys = Object.keys(state.legacy);
    for (const k of legacyKeys.slice(0, Math.max(0, legacyKeys.length - 20))) delete state.legacy[k];
    try { await chrome.storage.local.set({ [STATE_KEY]: state }); } catch { /* ignore */ }
  }

  // ---- account -------------------------------------------------------------------------------------

  /** Which signed-in account this tab shows: /mail/u/<index>/ and the address from the title. */
  function account() {
    const index = (location.pathname.match(/\/mail\/u\/(\d+)/) || [])[1] || '0';
    let email = (document.title.match(EMAIL) || [])[0] || '';
    if (!email) email = (val('app.accountButton').match(EMAIL) || [])[0] || '';
    email = email.toLowerCase();
    if (email && email !== state.email) { state.email = email; saveState(); }
    return { index, email: email || state.email || '' };
  }

  /** Every address that counts as "us": the account, plus "Send mail as" aliases listed in the pack. */
  function myEmails() {
    const out = new Set();
    const me = account().email;
    if (me) out.add(me);
    if (feedCache.email) out.add(feedCache.email);
    const aliases = lookup('account.aliases');
    if (Array.isArray(aliases)) for (const a of aliases) if (typeof a === 'string' && a.includes('@')) out.add(a.trim().toLowerCase());
    return out;
  }

  const homeUrl = () => String(lookup('routes.home') || 'https://mail.google.com/mail/u/{index}/#inbox').replace('{index}', account().index);

  // ---- which page is this ----------------------------------------------------------------------------

  /** True on the full window compose page that the new email address opens. */
  function isStandaloneCompose() {
    const p = new URLSearchParams(location.search);
    if (p.get('tf') === 'cm' || p.get('view') === 'cm') return true;
    const classes = lookup('compose.standaloneBodyClasses');
    return Array.isArray(classes) && classes.length > 0 && !!document.body && classes.every((c) => document.body.classList.contains(c));
  }

  const mainRoot = () => q('app.main', document, quiet);

  /** The open thread's header inside the active view, or null while a list is showing. */
  function threadHeader(main = mainRoot()) {
    return main ? q('thread.idEl', main, quiet) : null;
  }

  let goingHome = false;
  /** Leave the compose page for the inbox. The page unloads, so this is always the last thing done. */
  function goHomeSoon(ms = 500) {
    if (goingHome) return;
    goingHome = true;
    sleep(ms).then(() => { location.href = homeUrl(); }); // core's sleep is not slowed down in a hidden tab
  }

  // ---- the unread feed ------------------------------------------------------------------------------------

  const feedCache = { at: 0, count: null, email: '' };

  const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
  const xmlTag = (xml, name) => {
    const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
    return m ? unescapeXml(m[1].trim()) : '';
  };

  /**
   * Gmail's Atom feed of unread mail in the Primary category. It needs no page at all, shows the sender
   * before a thread is opened (opening marks it read) and keeps working while the tab is throttled.
   * Returns null when the feed cannot be trusted (signed out, removed by Google, network error).
   */
  /**
   * Inboxes with the Primary / Promotions / Social tabs: watch Primary only. Inboxes without them
   * (categories switched off): the Primary feed is always empty there, so watch the whole inbox
   * and rely on the sender filters and the customers only rule.
   */
  function hasCategoryTabs() {
    for (const el of document.querySelectorAll('[role="tab"]')) {
      const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.trim();
      if (/^primary\b/i.test(label)) return true;
    }
    return false;
  }

  async function fetchFeed() {
    const which = hasCategoryTabs() ? 'primary' : 'inbox';
    const fallback = which === 'primary' ? 'https://mail.google.com/mail/u/{index}/feed/atom/%5Esq_ig_i_personal' : 'https://mail.google.com/mail/u/{index}/feed/atom';
    const url = String(lookup(`feed.${which}`) || fallback).replace('{index}', account().index);
    let xml = '';
    try {
      const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
      if (!res.ok) return null;
      if (new URL(res.url).hostname !== 'mail.google.com') return null; // redirected to a sign-in page
      xml = await res.text();
    } catch {
      return null; // a redirect to another host surfaces as a thrown TypeError
    }
    if (!xml.includes('<feed')) return null;
    const head = xml.split('<entry>')[0];
    const entries = xml.split('<entry>').slice(1).map((chunk) => {
      const e = chunk.split('</entry>')[0];
      const href = unescapeXml((e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '');
      return {
        id: ((href.match(/[?&]message_id=([0-9a-f]+)/i) || [])[1] || '').toLowerCase(),
        subject: xmlTag(e, 'title'),
        snippet: xmlTag(e, 'summary'),
        name: xmlTag(e, 'name'),
        email: xmlTag(e, 'email').toLowerCase(),
        stamp: xmlTag(e, 'modified') || xmlTag(e, 'issued'),
      };
    });
    const feed = { count: Number(xmlTag(head, 'fullcount')) || 0, email: ((xmlTag(head, 'title').match(EMAIL) || [])[0] || '').toLowerCase(), entries };
    feedCache.at = Date.now();
    feedCache.count = feed.count;
    if (feed.email) feedCache.email = feed.email;
    return feed;
  }

  // ---- automated mail ------------------------------------------------------------------------------------------

  /**
   * Why this sender or subject is not a person, or '' when it may be one. Only obvious cases are
   * dropped here; the brain makes the finer call after the thread has been read.
   */
  function automatedReason(email, subject) {
    email = (email || '').toLowerCase();
    if (email && rx('classify.allowSenders').test(email)) return '';
    if (email && myEmails().has(email)) return 'own address';
    if (email && rx('classify.automatedSender').test(email)) return 'automated sender';
    if (email && rx('classify.denySenders').test(email)) return 'sender on the deny list';
    if (email) {
      const domain = email.split('@')[1] || '';
      if (ignoreSenders.some((i) => i && (i.includes('@') ? email === i : domain === i || domain.endsWith(`.${i}`)))) return 'on your never answer list';
    }
    if (subject && rx('classify.autoReplySubject').test(subject.trim())) return 'automatic reply';
    return '';
  }

  /** Gmail shows an "Unsubscribe" link beside the sender when the email carries a List-Unsubscribe header. */
  function hasUnsubscribeMarker(messageEl, bodyEl) {
    const label = rx('text.unsubscribeLabel');
    for (const sel of selectorsOf('message.unsubscribeCandidates')) {
      let els = [];
      try { els = messageEl.querySelectorAll(sel); } catch { continue; }
      for (const el of els) {
        if (bodyEl && bodyEl.contains(el)) continue; // only Gmail's own chrome, never the email content
        if (el.children.length === 0 && label.test((el.textContent || '').trim())) return true;
      }
    }
    return false;
  }

  /** Newsletter shaped content: the usual footer words together with many links. */
  function bodyLooksBulk(bodyEl, text) {
    if (!bodyEl || !rx('classify.bulkBody').test(text)) return false;
    return bodyEl.querySelectorAll('a[href]').length >= num('classify.bulkBodyMinLinks', 4);
  }

  // ---- probe ---------------------------------------------------------------------------------------------------

  function titleUnread() {
    const m = document.title.match(/\((\d[\d,.]*)\)/);
    return m ? Number(m[1].replace(/[,.]/g, '')) || 0 : 0;
  }

  // The inbox the owner chose in the dashboard (Connections, Channels). Kept in sync from storage.
  let wantedAccount = '';
  let ignoreSenders = [];
  const takeConfig = (cfg) => {
    wantedAccount = String(cfg?.gmail_account || '').toLowerCase();
    ignoreSenders = Array.isArray(cfg?.gmail_ignore_senders) ? cfg.gmail_ignore_senders.map((x) => String(x).toLowerCase().replace(/^@/, '')) : [];
  };
  try {
    chrome.storage.local.get('config', (r) => takeConfig(r?.config));
    chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.config) takeConfig(ch.config.newValue); });
  } catch { /* storage unavailable */ }

  function probe() {
    if (q('auth.signIn', document, quiet)) return { state: 'logged_out', detail: 'Sign in to Gmail in this tab', unread: 0 };

    if (isStandaloneCompose()) {
      // The service worker loads this page for a new email and waits for "ready" before it calls send.
      if (qShown('compose.body')) return { state: 'ready', detail: 'Writing a new email', unread: feedCache.count || 0 };
      // A compose page nobody is using (the job never came, or it is already sent): go back to the inbox.
      if (!sending && Date.now() - loadedAt > 30_000) goHomeSoon();
      return { state: 'loading', detail: 'Opening a new email', unread: 0 };
    }

    if (!mainRoot()) {
      if (!q('app.loading', document, quiet) && rx('text.signIn').test(document.title.trim())) return { state: 'logged_out', detail: 'Sign in to Gmail in this tab', unread: 0 };
      return { state: 'loading', detail: 'Gmail is loading', unread: 0 };
    }

    // Never answer mail from an inbox the owner did not choose.
    const shown = account().email;
    if (wantedAccount && shown && shown !== wantedAccount) {
      return { state: 'blocked', detail: `This tab shows ${shown}. Switch it to ${wantedAccount}`, unread: 0 };
    }

    // The feed count is the real number of unread Primary emails. Refresh it in the background.
    if (Date.now() - feedCache.at > 45_000) { feedCache.at = Date.now(); fetchFeed().catch(() => null); }
    const unread = feedCache.count != null ? feedCache.count : titleUnread();
    // The detail names the inbox so the dashboard can show which Gmail account the agent uses.
    return { state: 'ready', detail: shown || '', unread };
  }

  // ---- finding unread threads ----------------------------------------------------------------------------

  /** One row of a Gmail list as plain data. */
  function parseRow(row) {
    const idEl = q('list.threadIdEl', row, quiet);
    const senderEl = q('list.sender', row, quiet);
    const snippetEl = q('list.snippet', row, quiet);
    return {
      id: cleanId(idEl && idEl.getAttribute('data-legacy-thread-id')).toLowerCase(),
      lastMessageId: cleanId(idEl && idEl.getAttribute('data-legacy-last-message-id')),
      email: senderEl ? (senderEl.getAttribute('email') || '').toLowerCase() : '',
      name: senderEl ? (senderEl.getAttribute('name') || textOf(senderEl)) : '',
      subject: val('list.subject', row),
      snippet: textOf(snippetEl).replace(/^[\s \-–—]+/, ''),
      date: val('list.date', row),
      unread: row.classList.contains(String(lookup('list.unreadClass') || 'zE')),
    };
  }

  function listRows(main) {
    const ignore = lookup('list.ignoreRowClasses');
    return qa('list.row', main).filter((r) => visible(r) && !(Array.isArray(ignore) && ignore.some((c) => r.classList.contains(c))));
  }

  /**
   * Fallback when the feed is not available: show Gmail's own search for unread Primary mail and
   * read the rows. Every row of that search is unread by definition, so the row classes are not trusted.
   */
  async function scanList() {
    const main = mainRoot();
    // Only take over the view when a list is showing. The owner may be reading or writing an email.
    if (!main || threadHeader(main) || ownerBusy()) return null;
    const route = String(lookup('routes.searchUnreadPrimary') || '#search/in%3Ainbox%20is%3Aunread%20category%3Aprimary');
    const onSearch = () => location.hash.toLowerCase().startsWith(route.split('/')[0].toLowerCase() + '/');
    try {
      location.hash = route;
      await sleep(700); // let Gmail swap the inbox list for the search results
      const settled = await waitFor(() => {
        const m = mainRoot();
        if (!m || !onSearch() || !q('app.threadList', m, quiet)) return null;
        return listRows(m).length > 0 || q('list.empty', m, quiet) ? m : null;
      }, { timeout: patience(12_000) });
      // No rows and no "nothing found" marker within the wait: treat it as an empty result.
      const view = settled || mainRoot();
      if (!view || !onSearch()) return null;
      return listRows(view).map(parseRow).filter((r) => HEX_ID.test(r.id));
    } finally {
      await goInbox();
      await sleep(500); // a list is on screen either way: give Gmail a moment to swap the results for the inbox
    }
  }

  // The list fallback takes over the view (a search, then back to the inbox): at most once a minute.
  let listScanAt = 0;

  async function scan() {
    await stateReady;
    if (isStandaloneCompose()) {
      if (!sending) goHomeSoon();
      return { threads: [] };
    }
    let found = [];
    const feed = await fetchFeed();
    if (feed) {
      found = feed.entries.filter((e) => HEX_ID.test(e.id)).map((e) => {
        const at = Date.parse(e.stamp);
        return {
          key: e.id, name: e.name, email: e.email, subject: e.subject, preview: e.snippet, sig: `${e.id}|${e.stamp}|${e.snippet.slice(0, 80)}`,
          ts_max: Number.isFinite(at) ? at + 1000 : null,
        };
      });
    } else {
      if (Date.now() - listScanAt < 60_000) return { threads: [], source: 'none' };
      listScanAt = Date.now();
      const rows = await scanList();
      if (!rows) return { threads: [], source: 'none' };
      const looksRead = rows.filter((r) => !r.unread).length;
      if (looksRead) ACX.diag('note', { where: 'gmail.scanList', note: 'rows of the unread search without the unread class', count: looksRead, of: rows.length });
      found = rows.map((r) => ({
        key: r.id, name: r.name, email: r.email, subject: r.subject, preview: r.snippet, sig: `${r.id}|${r.lastMessageId}|${r.date}|${r.snippet.slice(0, 80)}`,
      }));
    }
    const threads = [];
    for (const t of found) {
      if (state.skip[t.key]) continue; // opened before and found to be automated
      if (automatedReason(t.email, t.subject)) continue; // never opened, so it stays unread for the owner
      threads.push({
        key: t.key,
        title: t.name || t.email || 'Unknown sender',
        unread: 1,
        preview: [t.subject, t.preview].filter(Boolean).join(': ').slice(0, 200),
        is_group: false,
        sig: t.sig,
        ts_max: t.ts_max ?? null,
      });
    }
    return { threads, source: feed ? 'feed' : 'list' };
  }

  /**
   * Safety net, run every 10 minutes: the newest threads of the inbox list that is on screen, read or
   * not, whose latest sender is not us. Catches an email the owner opened on the phone (so it left the
   * unread feed) before the agent saw it. Never changes the view: only works when the inbox list is
   * already showing and the owner is not busy in it.
   */
  async function sweep() {
    await stateReady;
    if (isStandaloneCompose()) return { threads: [] };
    const main = mainRoot();
    const route = String(lookup('routes.inbox') || '#inbox');
    const onInbox = !location.hash || location.hash === route || location.hash === '#inbox';
    if (!main || !onInbox || threadHeader(main) || ownerBusy()) return { threads: [] };
    const mine = myEmails();
    const threads = [];
    for (const row of listRows(main)) {
      if (threads.length >= 8) break;
      const r = parseRow(row);
      if (!HEX_ID.test(r.id)) continue;
      // Gmail lists every sender of the thread ("Jake, me"): the last one wrote last.
      const senders = qa('list.sender', row).map((el) => (el.getAttribute('email') || '').toLowerCase()).filter(Boolean);
      const lastFrom = senders.length ? senders[senders.length - 1] : r.email;
      if (!lastFrom || mine.has(lastFrom)) continue;
      if (state.skip[r.id] || automatedReason(lastFrom, r.subject)) continue;
      const at = parseDate(r.date);
      if (at && Date.now() - at > 24 * 3600_000) continue; // older mail is the owner's to deal with
      threads.push({
        key: r.id,
        title: r.name || lastFrom || 'Unknown sender',
        unread: r.unread ? 1 : 0,
        preview: [r.subject, r.snippet].filter(Boolean).join(': ').slice(0, 200),
        is_group: false,
        sig: `sw|${r.id}|${r.lastMessageId || r.date}`,
      });
    }
    return { threads };
  }

  // ---- moving around -----------------------------------------------------------------------------------------

  /** Text the owner typed above the signature of a compose box ('' for a fresh, untouched box). */
  function composeUserText(body) {
    const clone = body.cloneNode(true);
    for (const sel of selectorsOf('compose.strip')) {
      try { clone.querySelectorAll(sel).forEach((n) => n.remove()); } catch { /* ignore */ }
    }
    // A bare "--" line is the signature divider on accounts where it carries no class.
    return textOf(clone).split('\n').filter((line) => !/^--\s*$/.test(line)).join('\n').trim();
  }

  /** Why the agent must not touch this tab right now, or '' when it may. */
  function ownerBusy() {
    if (/^#settings/i.test(location.hash)) return 'Gmail settings are open in this tab';
    for (const dlg of qa('compose.windowRoot')) {
      if (!visible(dlg)) continue;
      const body = qShown('compose.body', dlg);
      if (body && composeUserText(body)) return 'An email is being written in this tab';
    }
    const active = document.activeElement;
    if (!isHidden() && document.hasFocus() && active && active !== document.body) {
      const typing = active.isContentEditable || active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(active.type));
      if (typing) return 'Someone is typing in this tab';
    }
    return '';
  }

  function requireFree() {
    const why = ownerBusy();
    if (why) throw new Fail('composer_busy', why, true);
  }

  /** Back to the inbox list. Used after every read and send, and after anything that went wrong. */
  async function goInbox() {
    if (isStandaloneCompose()) return;
    const listShowing = () => { const m = mainRoot(); return m && !threadHeader(m) ? m : null; };
    const route = String(lookup('routes.inbox') || '#inbox');
    if (location.hash !== route) location.hash = route;
    await waitFor(listShowing, { timeout: patience(10_000) });
  }

  /**
   * Open a thread by its 16 character id and wait until it is really on screen. The id may be a
   * thread id or (from the feed) the id of one message in it, so arrival is proven on the page:
   * the header carries the thread id, or a message with that id is present. Returns the real thread id.
   */
  async function openThread(id, cap) {
    id = String(id || '').toLowerCase();
    if (!HEX_ID.test(id)) throw new Fail('thread_not_found', 'That is not a Gmail thread id', false);

    const arrived = () => {
      const main = mainRoot();
      const header = threadHeader(main);
      if (!header) return null;
      const threadId = cleanId(header.getAttribute('data-legacy-thread-id')).toLowerCase();
      let hit = threadId === id;
      if (!hit) { try { hit = !!main.querySelector(`[data-legacy-message-id="${id}"]`); } catch { hit = false; } }
      if (!hit) return null;
      const msgs = qa('message.root', main);
      const last = msgs[msgs.length - 1];
      return last && q('message.body', last, quiet) ? { main, threadId: threadId || id } : null; // the last message is rendered
    };

    if (!arrived()) {
      const route = String(lookup('routes.thread') || '#inbox/{hexThreadId}').replace('{hexThreadId}', id);
      const before = location.hash;
      // A hidden link is clicked instead of assigning the hash: with a compose window open Gmail
      // otherwise appends ?compose= to the address and breaks its own history.
      const a = document.createElement('a');
      a.href = route;
      a.style.display = 'none';
      document.body.appendChild(a);
      click(a);
      a.remove();
      await sleep(400);
      if (location.hash === before && !arrived()) location.hash = route;
    }
    const hit = await waitFor(arrived, { timeout: patience(cap) });
    if (!hit) {
      ACX.snapshot('gmail.openThread', mainRoot());
      await goInbox();
      throw new Fail('thread_not_found', 'The email did not open', true);
    }
    return hit;
  }

  /** Older messages of a long thread are collapsed and have no body until expanded. */
  async function expandAll(main) {
    const collapsed = () => q('thread.collapsedMessage', main, quiet) || q('thread.hiddenNotice', main, quiet);
    if (!collapsed()) return;
    const icon = q('thread.expandAllIcon', main, quiet);
    if (icon) click(icon.closest('[role=button]') || icon);
    else {
      const notice = q('thread.hiddenNotice', main, quiet);
      if (notice) click(notice);
      for (const el of qa('thread.collapsedMessage', main)) click(el);
    }
    await waitFor(() => !collapsed(), { timeout: patience(8000) });
  }

  // ---- reading -----------------------------------------------------------------------------------------------

  /** "Nov 14, 2026, 10:32 AM" (Gmail uses narrow spaces) -> unix ms, or null. */
  function parseDate(title) {
    if (!title) return null;
    const t = Date.parse(String(title).replace(/[  ]/g, ' ').replace(/\s+at\s+/i, ' '));
    return Number.isFinite(t) && t > 1_000_000_000_000 ? t : null;
  }

  /** Drop quoted history and signatures that carry no markup (mail written in other programs). */
  function cutQuotedText(text) {
    const lines = text.split('\n');
    const quote = rx('text.quoteHeader');
    const sig = rx('text.signatureLine');
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const next = (lines[i + 1] || '').trim();
      const outlookHeader = /^from:\s.+/i.test(line) && /^(sent|date|to|subject):\s/i.test(next);
      const quotedRun = line.startsWith('>') && next.startsWith('>');
      // "On <date> <name> wrote:" is often wrapped over two lines.
      if (quote.test(line) || (line && next && quote.test(`${line} ${next}`) && /^on\s/i.test(line)) || outlookHeader || quotedRun || sig.test(line)) { end = i; break; }
    }
    const cut = lines.slice(0, end).join('\n').trim();
    if (cut) return cut;
    // Everything was cut: the person answered underneath the quote. Keep what is not quoted.
    return lines.filter((l) => !l.trim().startsWith('>') && !quote.test(l.trim())).join('\n').trim();
  }

  /** Plain text of a message body as the sender wrote it, without quoted history and signature. */
  function cleanBody(bodyEl) {
    const clone = bodyEl.cloneNode(true);
    for (const sel of selectorsOf('message.strip')) {
      try { clone.querySelectorAll(sel).forEach((n) => n.remove()); } catch { /* ignore */ }
    }
    return cutQuotedText(textOf(clone));
  }

  /** Every message of the open thread, oldest first, with the element kept for later checks. */
  function parseMessages(main) {
    const mine = myEmails();
    const sentIds = new Set(state.sends.map((s) => s.id).filter(Boolean));
    return qa('message.root', main).map((el) => {
      const from = q('message.sender', el, quiet);
      const bodyEl = q('message.body', el, quiet);
      const id = cleanId(el.getAttribute('data-legacy-message-id')).toLowerCase();
      const email = from ? (from.getAttribute('email') || '').toLowerCase() : '';
      const body = bodyEl ? cleanBody(bodyEl) : '';
      return {
        el,
        bodyEl,
        id: id || null,
        email,
        name: from ? (from.getAttribute('name') || textOf(from)) : '',
        out: (!!email && mine.has(email)) || (!!id && sentIds.has(id)),
        body,
        ts: parseDate(val('message.date', el)),
        attachments: q('message.attachmentCards', el, quiet) ? 1 : 0,
        unsubscribe: hasUnsubscribeMarker(el, bodyEl),
      };
    });
  }

  /**
   * A reply of several parts goes out as one email, but the server keeps one record per part. Report
   * such an email as its parts again (with ids derived from the email's id) so both sides agree.
   */
  function splitOwnMessage(m) {
    const key = squash(m.body);
    const sent = state.sends.find((s) => m.id && s.id === m.id) || state.sends.find((s) => s.text === key);
    if (!sent || !Array.isArray(sent.parts) || sent.parts.length < 2) return [m];
    return sent.parts.map((part, i) => ({ ...m, body: part, id: partId(m.id, i) }));
  }
  const partId = (id, i) => (id ? (i === 0 ? id : `${id}#p${i + 1}`) : null);

  async function read({ key }) {
    await stateReady;
    if (isStandaloneCompose()) { if (!sending) goHomeSoon(); throw new Fail('timeout', 'Gmail is returning to the inbox', true); }
    requireFree();
    const { main, threadId } = await openThread(key, 35_000);
    try {
      await expandAll(main);
      const all = parseMessages(main).filter((m) => m.bodyEl);
      if (!all.length) throw new Fail('thread_not_found', 'The email opened without any readable message', true);

      const lastIn = [...all].reverse().find((m) => !m.out) || null;
      const subject = val('thread.subject', main);

      // Second look at automated mail, now that Gmail's own markers are visible.
      if (lastIn) {
        const why = automatedReason(lastIn.email, subject) || (lastIn.unsubscribe ? 'unsubscribe marker' : '') || (bodyLooksBulk(lastIn.bodyEl, lastIn.body) ? 'newsletter content' : '');
        if (why) {
          state.skip[String(key).toLowerCase()] = Date.now();
          state.skip[threadId] = Date.now();
          await saveState();
          return { thread: null, messages: [], skipped: why };
        }
      }

      // The customer is whoever wrote last. In a thread we started it is the person we wrote to.
      let contact = lastIn ? { name: lastIn.name, email: lastIn.email } : null;
      if (!contact) {
        const to = q('message.recipients', all[0].el, quiet);
        contact = { name: to ? (to.getAttribute('name') || textOf(to)) : '', email: to ? (to.getAttribute('email') || '').toLowerCase() : '' };
      }
      const title = contact.name || contact.email || 'Unknown sender';

      const messages = [];
      for (const m of all) {
        for (const part of m.out ? splitOwnMessage(m) : [m]) {
          const kind = !part.body && part.attachments ? 'document' : 'text';
          // A customer email that shows a picture (an attachment card or an inline photo): copy it for the brain.
          const _media = !part.out && ACX.hasMedia(m.el, 'image') ? { el: m.el, kind: 'image' } : null;
          if (!part.body && kind === 'text' && !_media) continue;
          messages.push({ external_id: part.id, direction: part.out ? 'out' : 'in', body: part.body, kind, ts: part.ts, _media });
        }
      }
      await ACX.captureMedia(messages); // never throws, at most about 5 s
      for (const msg of messages) {
        // A photo with no words is a photo, not a file. Without a copy and without words there is nothing to report.
        if (msg.media && !msg.body) msg.kind = 'image';
        delete msg._media;
      }
      for (let i = messages.length - 1; i >= 0; i--) if (!messages[i].body && messages[i].kind === 'text') messages.splice(i, 1);
      const shown = messages.slice(-40);
      return {
        thread: {
          external_id: threadId,
          title,
          is_group: false,
          subject: subject || null,
          contact: { name: title, phone: null, email: contact.email || null, handle: null },
        },
        messages: shown,
        tail: ACX.tailRef(shown), // send() refuses the reply if the customer wrote again since
      };
    } finally {
      await goInbox();
    }
  }

  // ---- the reply box ---------------------------------------------------------------------------------------

  /** A compose box that is open inside the thread: { root, body } or null. */
  function openCompose(main) {
    const root = qShown('reply.inlineComposeRoot', main);
    const body = root ? qShown('compose.body', root) : null;
    return body ? { root, body } : null;
  }

  /** Press Reply on the last message and wait for the box. */
  async function openReplyBox(main) {
    const bars = qa('reply.bar', main).filter(visible);
    const bar = bars[bars.length - 1];
    let btn = bar ? q('reply.replyLink', bar) : null;
    if (!btn) {
      const msgs = qa('message.root', main);
      btn = msgs.length ? q('reply.headerButton', msgs[msgs.length - 1], quiet) : null;
    }
    if (!btn) {
      // Last resort, English only. The last match is used: a floating Reply button comes first in the page.
      const label = rx('text.replyLabel');
      for (const sel of selectorsOf('reply.textFallback')) {
        let els = [];
        try { els = Array.from(main.querySelectorAll(sel)); } catch { continue; }
        btn = els.filter((e) => visible(e) && label.test((e.textContent || '').trim())).pop() || null;
        if (btn) break;
      }
    }
    if (!btn) {
      ACX.snapshot('gmail.replyButton', main);
      throw new Fail('composer_missing', 'Could not find the Reply button', true);
    }
    click(btn);
    const box = await waitFor(() => openCompose(mainRoot() || main), { timeout: patience(15_000) });
    if (!box) {
      ACX.snapshot('gmail.replyBox', main);
      throw new Fail('composer_missing', 'The reply box did not open', true);
    }
    return box;
  }

  /** Close a compose box without sending. True when it is gone. */
  async function discardCompose(box, main) {
    const btn = qShown('compose.discard', box.root);
    if (btn) click(btn);
    return !!(await waitFor(() => !box.body.isConnected || !visible(box.body), { timeout: patience(8000), root: main || document.documentElement }));
  }

  // ---- typing ------------------------------------------------------------------------------------------------

  /** A fresh empty line at the very top of the body, above the signature, with the caret in it. */
  function newTopLine(body) {
    const line = document.createElement('div');
    line.appendChild(document.createElement('br'));
    body.insertBefore(line, body.firstChild);
    body.focus();
    const range = document.createRange();
    range.setStart(line, 0);
    range.collapse(true);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    return line;
  }

  // Three ways to put text into Gmail's editor, tried in the order of typing.order in the pack.
  const typingTiers = {
    // The browser's own editing commands: fires trusted input events, so Gmail saves the draft.
    async exec(body, text) {
      newTopLine(body);
      await sleep(60);
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (line) document.execCommand('insertText', false, line);
        if (i < lines.length - 1) document.execCommand('insertParagraph', false);
      });
    },
    // Insert the lines as elements and tell Gmail something changed (what other Gmail extensions do).
    async range(body, text) {
      const frag = document.createDocumentFragment();
      for (const line of text.split('\n')) {
        const div = document.createElement('div');
        if (line) div.textContent = line; else div.appendChild(document.createElement('br'));
        frag.appendChild(div);
      }
      body.focus();
      body.insertBefore(frag, body.firstChild);
      body.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      body.dispatchEvent(new Event('change', { bubbles: true }));
    },
    // Real keyboard input through the service worker. Only when the owner switched on stronger typing.
    async trusted(body, text) {
      newTopLine(body);
      await sleep(60);
      const res = await ACX.toWorker({ type: 'trusted_type', text });
      if (!res || !res.ok) throw new Error('trusted input is off');
    },
  };

  /**
   * Type `text` at the top of a compose body, above Gmail's signature, and confirm that the box
   * shows exactly that text. Returns the name of the method that worked.
   */
  async function typeAboveSignature(body, text) {
    const want = squash(text);
    const landed = () => squash(composeUserText(body)) === want;
    const order = Array.isArray(lookup('typing.order')) ? lookup('typing.order') : ['exec', 'range', 'trusted'];
    for (const name of order) {
      const tier = typingTiers[name];
      if (!tier) continue;
      const anchor = body.firstChild; // everything that ends up before this node was put there by this try
      try { await tier(body, text); } catch { /* fall through to the check and the clean up */ }
      if (await waitFor(landed, { timeout: 1500, interval: 150, root: body })) return name;
      // Half typed text must never be sent: remove what this try left behind.
      while (body.firstChild && body.firstChild !== anchor) body.firstChild.remove();
      if (anchor && anchor.parentNode !== body) break; // the editor rebuilt itself: stop rather than guess
    }
    ACX.diag('error', { where: 'gmail.type', note: 'no typing method worked', tried: order });
    throw new Fail('composer_missing', 'Could not type into the reply box', true);
  }

  /**
   * A pause that scales with the length of the text (older servers send a typing speed). typing_cps 0
   * means as fast as possible: no pause at all.
   */
  async function typingPause(text, cps, share) {
    if (ACX.instant(cps)) return;
    const total = Math.min(6000, Math.max(400, (text.length / Math.max(3, ACX.cpsOf(cps))) * 1000));
    await sleep(total * share * ACX.rand(0.8, 1.2));
  }

  // ---- sending -----------------------------------------------------------------------------------------------

  function toastText() {
    const box = q('toast.container', document, quiet);
    const notice = box ? q('toast.notice', box, quiet) : null;
    return notice && visible(notice) ? squash(textOf(notice)) : '';
  }

  /** Messages in the open thread, counted two ways because Gmail may collapse the previous one on send. */
  function countMessages(main) {
    let items = 0;
    for (const sel of selectorsOf('thread.listItems')) {
      try { items = Math.max(items, main.querySelectorAll(sel).length); } catch { /* ignore */ }
    }
    return Math.max(qa('message.anyMessage', main).length, items);
  }

  let sending = false;

  function remember(job, ids, threadId, text) {
    state.jobs[job.id] = { ids, at: Date.now() };
    state.sends.push({ thread: threadId, text: squash(text), parts: job.parts, id: ids[0] || null, at: Date.now() });
    return saveState();
  }

  const jobText = (job) => (Array.isArray(job.parts) ? job.parts : []).map((p) => String(p).replace(/\r\n?/g, '\n').trim()).filter(Boolean).join('\n\n');

  async function sendReply(job, newerThan) {
    const text = jobText(job);
    const target = job.target || {};
    requireFree();
    const { threadId } = await openThread(target.thread_external_id, 60_000);
    let done = false;
    let box = null;
    let weOpened = false; // we opened the reply box, so we close it again if the reply does not go out
    let pressed = false;
    try {
      let main = mainRoot();
      await expandAll(main);
      const before = parseMessages(main);
      const last = before[before.length - 1];

      // Already sent (the confirmation got lost on the way to the server): say so, never send twice.
      if (last && last.out && squash(last.body).startsWith(squash(text))) {
        const ids = last.id ? job.parts.map((_, i) => partId(last.id, i)) : [];
        await remember(job, ids, threadId, text);
        done = true;
        return { sent_external_ids: ids, already_sent: true };
      }

      // The customer wrote again after the read this reply was decided on: refuse it. A box holding
      // exactly our text (an earlier try cut short) is ours to throw away, so it never blocks the chat.
      if (newerThan && ACX.newerInbound(before.map((m) => ({ external_id: m.id, direction: m.out ? 'out' : 'in', body: m.body })), newerThan)) {
        const left = openCompose(main);
        if (left && squash(composeUserText(left.body)) === squash(text)) await discardCompose(left, main);
        throw new Fail('newer_message', 'The customer wrote again before this reply went out', false);
      }

      // A box that is already open is a draft: the owner's, or ours from a try that stopped half way.
      box = openCompose(main);
      let typed = false;
      if (box) {
        const draft = squash(composeUserText(box.body));
        if (draft && draft !== squash(text)) throw new Fail('composer_busy', 'There is already a draft reply in this email', true);
        typed = !!draft;
      } else {
        box = await openReplyBox(main);
        // Gmail restores a saved draft into the box it opens: that draft is not ours to touch.
        if (composeUserText(box.body)) throw new Fail('composer_busy', 'There is already a draft reply in this email', true);
        weOpened = true;
      }

      const cps = job.pacing && job.pacing.typing_cps;
      if (!typed) {
        await typingPause(text, cps, 0.35);
        await typeAboveSignature(box.body, text);
        await typingPause(text, cps, 0.25);
      }
      // Read back once more right before sending.
      if (squash(composeUserText(box.body)) !== squash(text)) throw new Fail('composer_missing', 'The reply box does not show the reply text', true);

      const sendBtn = qShown('compose.send', box.root);
      if (!sendBtn) {
        ACX.snapshot('gmail.sendButton', box.root);
        throw new Fail('composer_missing', 'Could not find the Send button', true);
      }

      main = mainRoot() || main;
      const was = { count: countMessages(main), toast: toastText(), ids: new Set(before.map((m) => m.id).filter(Boolean)) };
      pressed = true;
      click(sendBtn);

      // Proof that does not depend on the language: the box is gone and the thread has one more message.
      // The "Message sent" notice is the second proof. A notice is only trusted when it changed.
      const outcome = await waitFor(() => {
        const m = mainRoot();
        if (!m) return null;
        if (!openCompose(m) && countMessages(m) > was.count) return { proof: 'dom' };
        const t = toastText();
        if (t && t !== was.toast) {
          if (rx('text.sent').test(t)) return { proof: 'toast' };
          if (rx('text.sendError').test(t)) return { error: t };
        }
        return null;
      }, { timeout: patience(30_000) });

      if (outcome && outcome.error) {
        // Gmail says it did not send. The text stays in the box as a draft; the next try picks it up.
        throw new Fail('send_not_confirmed', `Gmail said: ${outcome.error.slice(0, 120)}`, true);
      }
      if (!outcome) {
        ACX.snapshot('gmail.sendProof', mainRoot());
        throw new Fail('send_not_confirmed', 'Pressed Send but could not confirm that the email went out', false);
      }

      // The new message gets its permanent id a moment after sending.
      const fresh = await waitFor(() => {
        const m = mainRoot();
        const msgs = m ? parseMessages(m) : [];
        const newest = msgs[msgs.length - 1];
        return newest && newest.id && !was.ids.has(newest.id) ? newest : null;
      }, { timeout: patience(8000) });
      if (fresh && fresh.bodyEl && !squash(fresh.body).includes(squash(text))) {
        ACX.diag('error', { where: 'gmail.sendReply', note: 'sent email differs from the reply text', got: fresh.body.length, want: text.length });
        throw new Fail('send_not_confirmed', 'The email that went out does not match the reply text', false);
      }
      const ids = fresh ? job.parts.map((_, i) => partId(fresh.id, i)) : [];
      await remember(job, ids, threadId, text);
      done = true;

      // Gmail holds the email for the Undo period: do not move away before it is really gone.
      await sleep(num('timing.afterSendMs', 7000));
      return { sent_external_ids: ids, proof: outcome.proof };
    } finally {
      // Nothing was sent and the box is ours: do not leave a half written draft in the owner's mailbox.
      if (!done && weOpened && !pressed && box && box.body.isConnected) await discardCompose(box, mainRoot());
      await goInbox();
    }
  }

  /** Address of the full window compose page for a new email. The text is typed, not put in the address. */
  function composeUrl(job, legacy) {
    const target = job.target || {};
    const tpl = String(lookup(legacy ? 'routes.composeUrlLegacy' : 'routes.composeUrl') || 'https://mail.google.com/mail/u/{index}/?to={to}&su={su}&body={body}&tf=cm');
    return tpl
      .replace('{index}', account().index)
      .replace('{to}', encodeURIComponent(target.email || ''))
      .replace('{su}', encodeURIComponent(target.subject || ''))
      .replace('{body}', '');
  }

  async function prepare({ job }) {
    await stateReady;
    if (!job || job.kind !== 'new_chat') return { ready: true };
    if (state.jobs[job.id]) return { ready: true }; // already sent: send() will just confirm it
    const email = String((job.target && job.target.email) || '').trim();
    if (!EMAIL.test(email)) throw new Fail('thread_not_found', 'This job has no email address to write to', false);
    if (!isStandaloneCompose()) requireFree();
    return { navigate: composeUrl(job, !!state.legacy[job.id]) };
  }

  async function sendNew(job) {
    const text = jobText(job);
    const target = job.target || {};
    const wantTo = String(target.email || '').trim().toLowerCase();

    if (!isStandaloneCompose()) {
      // Gmail sometimes sends the new compose address to the inbox. Use the older address on the next try.
      if (state.legacy[job.id]) throw new Fail('composer_missing', 'Gmail did not open a new email window', false);
      state.legacy[job.id] = true;
      await saveState();
      throw new Fail('composer_missing', 'Gmail did not open a new email window', true);
    }

    try {
      // The first laid out body, preferring the one inside the compose form (hidden decoys exist outside it).
      const body = await waitFor(() => {
        for (const root of qa('compose.root')) { const b = qShown('compose.body', root); if (b) return b; }
        return qShown('compose.body');
      }, { timeout: patience(40_000) });
      if (!body) {
        ACX.snapshot('gmail.newCompose');
        throw new Fail('composer_missing', 'The new email window did not load', true);
      }
      const root = body.closest(selectorsOf('compose.root').join(',') || '.M9') || document.body;

      // The address and subject must be the ones of the job before anything is typed.
      const chips = [];
      for (const e of chain('compose.recipientChips')) {
        try { root.querySelectorAll(e.s).forEach((c) => chips.push(String((e.attr ? c.getAttribute(e.attr) : c.textContent) || '').toLowerCase())); } catch { /* ignore */ }
      }
      const toInput = q('compose.recipientInput', root, quiet);
      const typedTo = toInput ? String(toInput.value || '').toLowerCase() : '';
      if (!chips.includes(wantTo) && !typedTo.includes(wantTo)) {
        ACX.snapshot('gmail.newComposeTo', root);
        throw new Fail('composer_missing', 'The new email does not show the right address', true);
      }
      const subjectEl = q('compose.subject', root, quiet);
      const wantSubject = String(target.subject || '');
      if (subjectEl && wantSubject && subjectEl.value !== wantSubject) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(subjectEl, wantSubject);
        subjectEl.dispatchEvent(new Event('input', { bubbles: true }));
        subjectEl.dispatchEvent(new Event('change', { bubbles: true }));
      }

      const draft = squash(composeUserText(body));
      if (draft && draft !== squash(text)) throw new Fail('composer_busy', 'The new email already has text in it', true);
      const cps = job.pacing && job.pacing.typing_cps;
      if (!draft) {
        await typingPause(text, cps, 0.35);
        await typeAboveSignature(body, text);
        await typingPause(text, cps, 0.25);
      }
      if (squash(composeUserText(body)) !== squash(text)) throw new Fail('composer_missing', 'The new email does not show the message text', true);

      const sendBtn = qShown('compose.send', root) || qShown('compose.send');
      if (!sendBtn) {
        ACX.snapshot('gmail.newComposeSend', root);
        throw new Fail('composer_missing', 'Could not find the Send button', true);
      }
      const toastBefore = toastText();
      click(sendBtn);

      // The window closes its form and shows a sent notice. An error notice is the only clear "no".
      const outcome = await waitFor(() => {
        const t = toastText();
        if (t && t !== toastBefore && rx('text.sendError').test(t)) return { error: t };
        if (t && t !== toastBefore && rx('text.sent').test(t)) return { proof: 'toast' };
        if (!body.isConnected || !visible(body)) return { proof: 'closed' };
        return null;
      }, { timeout: patience(30_000) });
      if (outcome && outcome.error) throw new Fail('send_not_confirmed', `Gmail said: ${outcome.error.slice(0, 120)}`, true);
      if (!outcome) {
        ACX.snapshot('gmail.newComposeProof');
        throw new Fail('send_not_confirmed', 'Pressed Send but could not confirm that the email went out', false);
      }
      delete state.legacy[job.id];
      await remember(job, [], null, text);
      await sleep(num('timing.afterSendMs', 7000)); // the Undo period
      return { sent_external_ids: [], proof: outcome.proof };
    } finally {
      goHomeSoon(); // after the answer has gone back to the service worker
    }
  }

  async function send({ job, newer_than: newerThan }) {
    await stateReady;
    if (!job || !job.id || !jobText(job)) throw new Fail('unknown', 'Empty job', false);
    // A job that was already sent from this browser is only confirmed again.
    if (state.jobs[job.id]) {
      if (isStandaloneCompose()) goHomeSoon();
      return { sent_external_ids: state.jobs[job.id].ids || [], already_sent: true };
    }
    if (probe().state === 'logged_out') throw new Fail('logged_out', 'Gmail is signed out', true);
    sending = true;
    try {
      if (job.kind === 'new_chat') return await sendNew(job);
      if (isStandaloneCompose()) { goHomeSoon(); throw new Fail('timeout', 'Gmail is returning to the inbox', true); }
      return await sendReply(job, newerThan);
    } finally {
      sending = false;
    }
  }

  // ---- self test ---------------------------------------------------------------------------------------------

  /**
   * Checks the owner can run from the popup: selectors that everything depends on, the Gmail settings
   * the adapter needs, and typing into a reply box that is then discarded. Nothing is ever sent.
   */
  async function selftest() {
    await stateReady;
    const checks = [];
    const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail || '') });

    const p = probe();
    add('Gmail is open and signed in', p.state === 'ready' && !isStandaloneCompose(), p.state === 'ready' ? account().email : p.detail);
    if (p.state !== 'ready' || isStandaloneCompose()) return { checks };

    const lang = document.documentElement.lang || '';
    add('Gmail language is English', /^en\b/i.test(lang), lang ? `language is ${lang}` : 'language not shown by the page');
    const split = !!q('settings.splitPane', document, quiet);
    add('Reading pane is off (no split)', !split, split ? 'Settings, Inbox, Reading pane: No split' : '');

    const feed = await fetchFeed();
    add('Unread feed for Primary', !!feed, feed ? `${feed.count} unread` : 'not available, the inbox list is scanned instead');

    const busy = ownerBusy();
    if (busy) { add('Inbox and email checks', false, `skipped: ${busy}`); return { checks }; }

    try {
      if (threadHeader()) await goInbox();
      const main = mainRoot();
      add('Inbox list', !!(main && q('app.threadList', main)));
      const rows = main ? listRows(main).map((el) => ({ el, ...parseRow(el) })) : [];
      if (!rows.length) {
        add('Email rows', true, 'the inbox is empty, so rows and emails could not be checked');
        return { checks };
      }
      add('Email rows', true, `${rows.length} rows`);
      add('Thread id on rows', rows.some((r) => HEX_ID.test(r.id)));
      add('Sender address on rows', rows.some((r) => r.email));
      const anyUnread = rows.some((r) => r.unread);
      const readClass = String(lookup('list.readClass') || 'yO');
      add('Unread marker on rows', anyUnread || rows.some((r) => r.el.classList.contains(readClass)), anyUnread ? '' : 'no unread email on screen to compare');

      // Open an email that is already read (opening an unread one would mark it read behind the owner's back).
      const pick = rows.find((r) => !r.unread && HEX_ID.test(r.id) && !q('list.draftMarker', r.el, quiet));
      if (!pick) {
        add('Open an email', true, 'skipped: every email on screen is unread or has a draft');
        return { checks };
      }
      let opened = null;
      try { opened = await openThread(pick.id, 15_000); } catch { opened = null; }
      add('Open an email', !!opened, opened ? '' : 'the email did not open from its id');
      if (!opened) return { checks };

      const tmain = opened.main;
      const hasList = !!q('thread.messageList', tmain, quiet);
      add('Conversation view is on', hasList, hasList ? '' : 'Settings, General, Conversation view: on');
      add('Subject', !!val('thread.subject', tmain));
      const msgs = parseMessages(tmain);
      const lastMsg = msgs[msgs.length - 1];
      add('Message id', !!(lastMsg && lastMsg.id));
      add('Message sender', !!(lastMsg && lastMsg.email));
      add('Message text', !!(lastMsg && lastMsg.bodyEl));
      add('Message date', !!(lastMsg && lastMsg.ts), lastMsg && lastMsg.ts ? '' : 'the date could not be read (not needed for replies)');
      add('Mark unread and archive buttons', !!q('toolbar.markUnread', document, quiet) && !!q('toolbar.archive', document, quiet), 'optional');

      // Type into a reply box and throw it away. The Send button is looked up but never pressed.
      if (openCompose(tmain)) {
        add('Reply box', true, 'skipped: this email already has a draft');
      } else {
        let box = null;
        try { box = await openReplyBox(tmain); } catch { box = null; }
        add('Reply box opens', !!box);
        if (box) {
          const stray = composeUserText(box.body);
          add('Reply box starts empty', !stray, stray ? 'the signature is not recognised, or a draft was restored' : '');
          let how = '';
          if (!stray) {
            try { how = await typeAboveSignature(box.body, 'ACX check\n\nplease ignore'); } catch { how = ''; }
            add('Typing into the reply box', !!how, how ? `method: ${how}` : 'no typing method worked');
          }
          add('Send button', !!qShown('compose.send', box.root), 'found, not pressed');
          const gone = await discardCompose(box, tmain);
          add('Draft discarded', gone, gone ? '' : 'please delete the test draft in this email by hand');
        }
      }
    } finally {
      await goInbox();
    }
    return { checks };
  }

  // ---- start -------------------------------------------------------------------------------------------------

  ACX.register({ probe, scan, sweep, read, prepare, send, selftest });

  // New mail changes the inbox list: tell the service worker so it looks right away.
  ACX.watch(() => {
    const main = mainRoot();
    return main ? q('app.threadList', main, quiet) : null;
  });
})();
