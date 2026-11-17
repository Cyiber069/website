// WhatsApp Web adapter. Runs in the isolated world next to core.js (see its header for the contract).
//
// How it works, in short:
//   * Everything it DOES goes through the real page: click a chat row, type in the message box,
//     click Send. Nothing is ever sent through WhatsApp's internals.
//   * Everything it READS comes from the page first. A small read only bridge (whatsapp-main.js,
//     running in the page's own world) fills in what the page hides on some builds: the chat id
//     (JID), the phone number behind a hidden id, full message text. Every bridge answer is optional.
//   * Selectors and text patterns live in the selector pack (extension/selectors/whatsapp.json),
//     so a WhatsApp redesign is fixed from the dashboard.
//
// WhatsApp currently ships two shapes of message id (data-id), depending on the account:
//   compound  "false_447700900123@c.us_3EB0A1..."   direction, chat id, message id
//   bare      "3EB0A1B2C3D4E5F60718"                message id only, no chat id anywhere on the page
// Both are handled everywhere below.
(() => {
  const ACX = globalThis.ACX;
  if (!ACX || ACX.channel !== 'whatsapp') return;
  const { Fail, q, qa, val, rx, lookup, sleep, rand, waitFor, squash, textOf, visible } = ACX;

  /** Optional lookup: no "selector missing" report when nothing matches. */
  const Q = (key, root) => q(key, root || document, { quiet: true });

  // ---- small helpers ----------------------------------------------------------------------------

  const digitsOf = (s) => String(s || '').replace(/\D/g, '');

  /** Comparable form of a chat title: accents and case removed; a phone number becomes its digits. */
  function normTitle(t) {
    const s = String(t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().replace(/^~\s*/, '');
    return isPhoneTitle(s) ? digitsOf(s) : s.toLowerCase().replace(/\s+/g, ' ');
  }

  /** An unsaved contact's title is the phone number itself ("+44 7700 900123"). */
  function isPhoneTitle(t) {
    const s = String(t || '').trim();
    const n = digitsOf(s).length;
    return n >= 7 && n <= 15 && rx('text.phoneTitle').test(s);
  }

  /** Icon names under an element, whichever way this build draws icons (data-icon or svg title). */
  function iconNames(root) {
    if (!root) return '';
    const out = [];
    root.querySelectorAll('[data-icon]').forEach((e) => out.push(e.getAttribute('data-icon')));
    root.querySelectorAll('svg > title').forEach((e) => out.push((e.textContent || '').trim()));
    return out.join(' ').toLowerCase();
  }

  const packRe = (key, fallback) => {
    try { return new RegExp(lookup(key) || fallback); } catch { return new RegExp(fallback); }
  };

  /**
   * True when a delivery tick (ours) is inside el. Icons of the media type of the message (photo,
   * voice note, sticker) sit right next to the tick on current builds and are left out.
   */
  function hasTick(el) {
    if (!el) return false;
    const media = ACX.chain('chatList.rowMediaSymbol').map((e) => e.s).join(', ') || '[data-testid="chat-msg-symbol"]';
    const names = el.hasAttribute('data-icon') ? [el.getAttribute('data-icon')] : [];
    el.querySelectorAll('[data-icon], svg > title').forEach((n) => {
      try { if (n.closest(media)) return; } catch { /* bad selector in a hot update */ }
      names.push(n.hasAttribute('data-icon') ? n.getAttribute('data-icon') : (n.textContent || '').trim());
    });
    return packRe('icons.rowTick', 'msg-(dbl)?check|msg-time|status-(dbl)?check|status-time|ic-(dbl)?check|ic-done|ic-read|ic-delivered|ic-schedule|ic-msg-time|message-fail').test(names.join(' ').toLowerCase());
  }

  /** Split a data-id into its parts. Returns null for things that are not messages. */
  function parseDataId(v) {
    v = String(v || '');
    const m = packRe('dataId.compound', '^(true|false)_([^_]+@[^_]+)_([^_]+)(?:_(.+))?$').exec(v);
    if (m) return { form: 'compound', fromMe: m[1] === 'true', jid: m[2], msgId: m[3] };
    if (packRe('dataId.bare', '^[0-9A-Za-z]{16,}$').test(v)) return { form: 'bare', fromMe: null, jid: null, msgId: v };
    return null;
  }

  const serverOf = (jid) => String(jid || '').split('@')[1] || '';
  const isGroupJid = (jid) => (lookup('dataId.groupServers') || ['g.us', 'newsletter', 'broadcast']).includes(serverOf(jid));
  const isRealJid = (jid) => String(jid || '').includes('@');

  // ---- bridge to the page world (optional) -----------------------------------------------------------

  const TAG = 'acx-wa-bridge';
  const waiting = new Map();
  let bridgeSeq = 0;
  let bridgeDownUntil = 0;

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.tag !== TAG || d.dir !== 'res') return;
    const done = waiting.get(d.id);
    if (done) done(d.ok ? d.res : null);
  });

  /** Ask the page world something. Resolves to null when the bridge is off, missing, slow or failed. */
  function bridge(fn, ...args) {
    if (lookup('bridge.enabled') === false || Date.now() < bridgeDownUntil) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = `${Date.now()}-${++bridgeSeq}`;
      const timer = setTimeout(() => {
        if (!waiting.delete(id)) return;
        bridgeDownUntil = Date.now() + 60_000; // no answer at all: do not slow every call down
        resolve(null);
      }, 1200);
      waiting.set(id, (res) => { clearTimeout(timer); waiting.delete(id); resolve(res ?? null); });
      try {
        window.postMessage({ tag: TAG, dir: 'req', id, fn, args, modules: lookup('bridge.modules') || {} }, location.origin);
      } catch { clearTimeout(timer); waiting.delete(id); resolve(null); }
    });
  }

  let chatsCache = { at: 0, list: null };
  /** All chats WhatsApp has loaded, from the bridge: [{ jid, title, is_group, unread, archived }] or null. */
  async function bridgeChats() {
    if (Date.now() - chatsCache.at < 4000) return chatsCache.list;
    const list = await bridge('chats');
    chatsCache = { at: Date.now(), list: Array.isArray(list) ? list : null };
    return chatsCache.list;
  }

  // ---- IndexedDB lookup (read only, for builds with bare ids and no bridge) ------------------------------

  /**
   * WhatsApp keeps messages in IndexedDB under their compound id. Find the key ending in the bare
   * message id to learn the chat id. Never creates the database: it is only opened when it exists.
   */
  async function idbFind(msgId) {
    const cfg = lookup('idb') || {};
    if (!cfg.db || !cfg.messageStore || !msgId || !indexedDB.databases) return null;
    try {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === cfg.db)) return null;
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(cfg.db);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('blocked'));
      });
      try {
        if (!db.objectStoreNames.contains(cfg.messageStore)) return null;
        const store = db.transaction(cfg.messageStore, 'readonly').objectStore(cfg.messageStore);
        const max = Number(cfg.maxKeys) || 20000;
        const suffix = `_${msgId}`;
        const key = await new Promise((res) => {
          let n = 0;
          const cur = store.openKeyCursor(null, 'prev');
          cur.onerror = () => res(null);
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c || ++n > max) return res(null);
            const k = String(c.key);
            if (k.endsWith(suffix) || k.includes(`${suffix}_`)) return res(k);
            c.continue();
          };
        });
        const p = key ? parseDataId(key) : null;
        if (!p || !p.jid) return null;
        let phone = null;
        if (serverOf(p.jid) === 'lid' && cfg.contactStore && db.objectStoreNames.contains(cfg.contactStore)) {
          const rec = await new Promise((res) => {
            const g = db.transaction(cfg.contactStore, 'readonly').objectStore(cfg.contactStore).get(p.jid);
            g.onsuccess = () => res(g.result || null);
            g.onerror = () => res(null);
          });
          phone = rec ? digitsOf(String(rec[cfg.contactPhoneField || 'phoneNumber'] || '').split('@')[0]) || null : null;
        }
        return { jid: p.jid, phone };
      } finally { db.close(); }
    } catch { return null; }
  }

  // ---- what the adapter remembers while the page lives ------------------------------------------------------

  const known = {};    // chat title -> { jid, is_group } learned by opening it
  const lastSeen = {}; // chat title -> id of the last message when we last read or sent there
  const sentIds = new Set(); // ids of messages this adapter sent (always outgoing, whatever the page shows)
  const jobProgress = new Map(); // job id -> ids of the parts already sent, in case the same job comes again

  // A new_chat job reloads the page. This note (extension storage, invisible to the page) tells the
  // freshly loaded script that the dialog it may find belongs to that job.
  const PENDING_KEY = 'wa_pending';
  const setPending = (v) => chrome.storage.local.set({ [PENDING_KEY]: v }).catch(() => {});
  async function getPending() {
    try {
      const p = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY];
      return p && Date.now() - p.at < 3 * 60_000 ? p : null;
    } catch { return null; }
  }

  // ---- dialogs and page state ----------------------------------------------------------------------------------

  const dialogs = () => qa('state.anyDialog').filter(visible);

  /** conflict | invalid | restricted | closable | unknown | other (other = not modal, not in the way). */
  function dialogKind(d) {
    const text = squash(d.textContent);
    if (rx('text.useHere').test(text)) return 'conflict';
    if (rx('text.invalidNumber').test(text)) return 'invalid';
    if (rx('text.restricted').test(text)) return 'restricted';
    const modal = qa('state.modalDialog').includes(d);
    if (!modal) return 'other';
    return Q('state.dialogClose', d) ? 'closable' : 'unknown';
  }

  const MSG = {
    conflict: 'WhatsApp is open in another window. Press "Use here" on the WhatsApp tab.',
    restricted: 'WhatsApp shows a restriction notice on this account. Look at the WhatsApp tab.',
    unknown: 'A WhatsApp pop-up needs you. Look at the WhatsApp tab.',
  };

  /**
   * Close "what's new" style pop-ups (only through their Close button, never "Continue" or "OK")
   * and a left over invalid-number box. Throws `blocked` for anything a person has to deal with.
   */
  async function closeDialogs() {
    for (let round = 0; round < 3; round++) {
      let acted = false;
      for (const d of dialogs()) {
        const kind = dialogKind(d);
        if (kind === 'conflict' || kind === 'unknown') throw new Fail('blocked', MSG[kind], true);
        if (kind === 'restricted') throw new Fail('blocked', MSG.restricted, false);
        const btn = kind === 'closable' ? Q('state.dialogClose', d) : kind === 'invalid' ? Q('state.dialogButton', d) : null;
        if (!btn) continue;
        ACX.click(btn);
        acted = true;
        await waitFor(() => !d.isConnected || !visible(d), { timeout: 2500, interval: 150 });
      }
      if (!acted) return;
    }
  }

  async function probe() {
    const unread = countUnread();
    // The chat list wins: a logged in page can never be "signed out", whatever else matches the QR selectors.
    if (!Q('state.loggedIn') && Q('state.qr')) return { state: 'logged_out', detail: 'Scan the QR code with your phone to link WhatsApp', unread: 0 };

    const open = dialogs().map((d) => dialogKind(d));
    if (open.includes('conflict')) return { state: 'blocked', detail: MSG.conflict, unread };

    const st = await bridge('state');
    const flags = st ? [st.socket, st.mode].filter(Boolean) : [];
    if (flags.some((f) => (lookup('bridge.statesStop') || []).includes(f))) return { state: 'blocked', detail: MSG.conflict, unread };

    if (!Q('state.loggedIn')) {
      if (flags.some((f) => (lookup('bridge.statesLogin') || []).includes(f))) return { state: 'logged_out', detail: 'WhatsApp is logged out', unread: 0 };
      // A full screen notice with a "Use here" button and no dialog role.
      const btn = Array.from(document.querySelectorAll('#app button, #app [role="button"]')).find((b) => rx('text.useHere').test(b.textContent || ''));
      if (btn) return { state: 'blocked', detail: MSG.conflict, unread: 0 };
      return { state: 'loading', detail: 'WhatsApp is loading', unread: 0 };
    }

    // While a new chat is being opened, its dialogs are for send() to judge (so the job gets the right error).
    if (open.includes('restricted') && !(await getPending())) return { state: 'blocked', detail: MSG.restricted, unread };
    if (open.includes('unknown')) return { state: 'blocked', detail: MSG.unknown, unread };
    // WhatsApp shows this when the phone has been offline too long. Chats on screen still work, new ones may be late.
    const paused = /syncing paused|open whatsapp on your phone to continue/i.test((document.querySelector('#main')?.textContent || '').slice(0, 2000) + ' ' + (document.querySelector('#side')?.textContent || '').slice(0, 2000));
    return { state: 'ready', detail: paused ? 'WhatsApp says syncing is paused. Open WhatsApp on your phone' : '', unread };
  }

  // ---- chat list -----------------------------------------------------------------------------------------------

  /** Chat rows in the order they are shown. The list is virtualised: DOM order is not visual order. */
  function chatRows() {
    const grid = Q('chatList.grid');
    if (!grid) return [];
    const y = (el) => {
      for (let n = el, i = 0; n && i < 3; n = n.parentElement, i++) {
        const m = /translateY\(([-\d.]+)px\)/.exec((n.style && n.style.transform) || '');
        if (m) return Number(m[1]);
      }
      return 0;
    };
    return qa('chatList.row', grid).map((r, i) => [y(r), i, r]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  }

  function parseRow(row) {
    const title = val('chatList.rowTitle', row).trim();
    if (!title) return null; // the "Archived" entry, section headers, placeholders

    let unread = 0;
    const badge = Q('chatList.unreadBadge', row);
    if (badge) unread = parseInt(badge.textContent, 10) || 1; // a chat marked unread by hand has no number
    if (!unread) {
      for (const el of row.querySelectorAll('span[aria-label]')) {
        const txt = (el.textContent || '').trim();
        const label = el.getAttribute('aria-label') || '';
        if (/^\d{1,4}\+?$/.test(txt) && label.includes(txt.replace('+', ''))) { unread = parseInt(txt, 10); break; }
        if (rx('text.unreadAria').test(label)) { unread = parseInt(txt, 10) || 1; break; }
      }
    }
    const previewEl = Q('chatList.rowPreview', row);
    const icons = iconNames(row);
    return {
      row,
      title,
      unread,
      preview: squash(textOf(previewEl)).slice(0, 200),
      time: squash(textOf(Q('chatList.rowTime', row))),
      // The last message is ours when the preview carries a tick. Current builds show the status
      // element (chatList.rowLastMine) for the customer's last message too, so only a tick in it counts.
      lastMine: hasTick(Q('chatList.rowLastMine', row) || previewEl) || /msg-(dbl)?check|ic-check|ic-done/.test(iconNames(previewEl)),
      groupHint: rx('icons.defaultGroup').test(icons),
    };
  }

  const parsedRows = () => chatRows().map(parseRow).filter(Boolean);

  function countUnread() {
    try { return parsedRows().filter((r) => r.unread > 0 && !r.lastMine && !(known[r.title] && known[r.title].is_group)).length; } catch { return 0; }
  }

  // The agent moved the chat list itself (scrolled a row into view): put it back on the next look.
  let listMovedByUs = false;
  let lastOwnerReset = 0;

  /**
   * New activity is shown under the "All" filter at the top of the list. Scans run every few seconds,
   * so while the owner is looking at this tab the list is only moved back when the agent moved it, or
   * once a minute, never on every scan. `force` is for opening a chat, which needs the list.
   */
  async function resetList(force = false) {
    const looking = !document.hidden && document.hasFocus();
    if (!force && looking && !listMovedByUs && Date.now() - lastOwnerReset < 60_000) return;
    if (looking && !listMovedByUs) lastOwnerReset = Date.now();
    listMovedByUs = false;
    const all = Q('chatList.filterAll');
    const selected = qa('chatList.filterTab').find((b) => b.getAttribute('aria-selected') === 'true');
    if (all && selected && selected !== all) { ACX.click(all); await sleep(350); }
    const pane = Q('chatList.scroller');
    if (pane && pane.scrollTop > 0) { pane.scrollTop = 0; await sleep(300); }
  }

  /** "typing…" or "recording audio…" shown in place of the last message: not a message. */
  function isTypingPreview(preview) {
    const re = lookup('text.typingPreview') ? rx('text.typingPreview') : /^(typing|recording audio|recording)\s*(…|\.\.\.)?$/i;
    return re.test(String(preview || '').trim());
  }

  const dupWarned = new Set();

  // Last seen time and preview of each chat row, to notice messages already read on the phone:
  // title -> { time, preview, stamp }. `stamp` is the last clock time the row showed, so the
  // signature does not change when "23:50" turns into "Yesterday" at midnight.
  const rowSeen = new Map();

  /** Signature of a row for the worker: changes with a new message, not with an ageing time label. */
  function rowThreadSig(r) {
    const prev = rowSeen.get(r.title);
    const typing = isTypingPreview(r.preview);
    const preview = typing && prev ? prev.preview : r.preview;
    return `${ACX.stableTime(prev && prev.stamp, r.time)}|${preview}${typing ? '|typing' : ''}`;
  }

  /** True for a row that is a 1:1 chat the agent may answer (not a group, not a title shared by two chats). */
  function isPersonRow(r, titleCount, byTitle) {
    const nt = normTitle(r.title);
    if (titleCount[nt] > 1) {
      // Two chats with the same name cannot be told apart safely: leave them for the owner.
      if (!dupWarned.has(nt)) { dupWarned.add(nt); ACX.diag('note', { where: 'scan', note: 'two chats share a title, skipped' }); }
      return false;
    }
    const info = byTitle[nt] && byTitle[nt].length === 1 ? byTitle[nt][0] : null;
    if (info && (info.is_group || info.archived || !(lookup('dataId.personServers') || ['c.us', 'lid']).includes(info.server))) return false;
    if (!info && ((known[r.title] && known[r.title].is_group) || r.groupHint)) return false;
    return true;
  }

  /** Rows of the list plus what is needed to tell people from groups. */
  async function listContext() {
    const rows = parsedRows();
    const titleCount = {};
    for (const r of rows) titleCount[normTitle(r.title)] = (titleCount[normTitle(r.title)] || 0) + 1;
    // The bridge knows what kind of chat each row is without opening it.
    const chats = await bridgeChats();
    const byTitle = {};
    for (const c of chats || []) (byTitle[normTitle(c.title)] = byTitle[normTitle(c.title)] || []).push(c);
    return { rows, titleCount, byTitle };
  }

  /**
   * Safety net, run every 10 minutes: the most recent 1:1 chats whose last message is from the
   * customer, badge or not. Catches a message that was read on the phone while the agent missed it.
   * Same signature as scan(), so a chat the worker already reported is not read again.
   */
  async function sweep() {
    if (!Q('state.loggedIn')) return { threads: [] };
    await closeDialogs();
    await resetList();
    if (!q('chatList.grid', document, { quiet: true })) return { threads: [] };
    const { rows, titleCount, byTitle } = await listContext();
    const now = Date.now();
    const threads = [];
    for (const r of rows) {
      if (threads.length >= 8) break;
      if (r.lastMine || (!r.preview && !r.time) || isTypingPreview(r.preview)) continue;
      // Only today's chats (the list shows a clock time for those): older ones are the owner's to deal with.
      if (!/^\d{1,2}[:.]\d{2}/.test(String(r.time || ''))) continue;
      if (!isPersonRow(r, titleCount, byTitle)) continue;
      threads.push({ key: r.title, title: r.title, unread: r.unread, preview: r.preview, is_group: false, sig: rowThreadSig(r), ts_max: ACX.labelTimeMax(r.time, now) });
    }
    return { threads };
  }

  async function scan() {
    if (!Q('state.loggedIn')) return { threads: [] };
    await closeDialogs();
    await resetList();
    if (!q('chatList.grid')) return { threads: [] }; // reports the missing selector

    const { rows, titleCount, byTitle } = await listContext();

    const threads = [];
    const now = Date.now();
    const firstScan = !rowSeen.size;
    let earlyPicks = 0;
    for (const r of rows) {
      // A chat counts as new when it has an unread badge, OR when its last message changed since the
      // last look and is not ours: reading the message on the phone clears the badge everywhere.
      // A label that only ages ("23:50" to "Yesterday") or a "typing…" preview is not a new message.
      const prev = rowSeen.get(r.title);
      const typing = isTypingPreview(r.preview);
      const preview = typing && prev ? prev.preview : r.preview;
      const changed = prev
        ? prev.preview !== preview || ACX.timeMoved(prev.time, r.time)
        : firstScan && /^\d{1,2}:\d{2}/.test(String(r.time || '')) && earlyPicks++ < 5;
      const sig = rowThreadSig(r);
      rowSeen.set(r.title, { time: r.time, preview, stamp: ACX.stableTime(prev && prev.stamp, r.time) });
      if (r.lastMine || !(r.unread || changed)) continue; // nothing new from the customer
      if (!isPersonRow(r, titleCount, byTitle)) continue;
      threads.push({ key: r.title, title: r.title, unread: r.unread || 1, preview: r.preview, is_group: false, sig, ts_max: ACX.labelTimeMax(r.time, now) });
    }

    // The chat that is open right now never gets an unread badge: watch its last message instead.
    const cur = currentChat();
    if (cur && cur.title && !threads.some((t) => t.key === cur.title) && !(known[cur.title] && known[cur.title].is_group) && labelInfo(cur.label).kind !== 'group') {
      const last = lastMessageLight();
      if (last) {
        if (!(cur.title in lastSeen)) lastSeen[cur.title] = last.id; // first look: only what arrives from now on counts
        else if (last.direction === 'in' && last.id !== lastSeen[cur.title]) {
          threads.push({ key: cur.title, title: cur.title, unread: 1, preview: last.body.slice(0, 200), is_group: false, sig: `open|${last.id}` });
        }
      }
    }
    return { threads };
  }

  // ---- the open conversation ---------------------------------------------------------------------------------------

  /** What a composer label says: { kind: 'chat' | 'group' | null, name }. */
  function labelInfo(label) {
    const s = String(label || '').trim();
    for (const [kind, key] of [['group', 'text.composerLabelGroup'], ['chat', 'text.composerLabelChat']]) {
      const src = lookup(key);
      for (const p of Array.isArray(src) ? src : src ? [src] : []) {
        try {
          const m = new RegExp(p, 'i').exec(s);
          if (m) return { kind, name: (m[1] || '').trim() };
        } catch { /* bad pattern in a hot update */ }
      }
    }
    return { kind: null, name: '' };
  }

  /** The chat that is open, as the page shows it. */
  function currentChat() {
    if (!Q('conversation.main')) return null;
    const titleEl = Q('conversation.headerTitle');
    const composer = Q('composer.input');
    return {
      title: titleEl ? (titleEl.getAttribute('title') || textOf(titleEl)).trim() : '',
      composer,
      label: composer ? composer.getAttribute('aria-label') || '' : '',
    };
  }

  /** Message elements in the open chat, oldest first: [{ row, dataId, id }]. */
  function messageRows() {
    const panel = Q('conversation.messagesPanel');
    if (!panel) return [];
    const out = [];
    const seen = new Set();
    for (const row of qa('conversation.messageRow', panel)) {
      const carrier = row.hasAttribute('data-id') ? row : row.querySelector('[data-id]') || row.closest('[data-id]');
      const dataId = carrier ? carrier.getAttribute('data-id') : '';
      const id = parseDataId(dataId);
      if (!id || seen.has(dataId)) continue; // date dividers, system notices
      seen.add(dataId);
      out.push({ row, dataId, id });
    }
    return out;
  }

  /** Delivery state shown in a bubble. Only our own messages have one. */
  function ownStatus(row) {
    const meta = Q('conversation.msgMeta', row);
    if (!meta) return null;
    const labels = Array.from(meta.querySelectorAll('[aria-label], [title]')).map((e) => e.getAttribute('aria-label') || e.getAttribute('title') || '').join(' ');
    const icons = iconNames(meta);
    for (const [name, icon, text] of [['read', 'icons.read', 'text.statusRead'], ['delivered', 'icons.delivered', 'text.statusDelivered'], ['sent', 'icons.sent', 'text.statusSent'], ['pending', 'icons.pending', 'text.statusPending']]) {
      if (rx(icon).test(icons) || rx(text).test(labels)) return name;
    }
    return null;
  }

  function directionOf(m, model) {
    const { row, id, dataId } = m;
    if (sentIds.has(dataId)) return 'out';
    if (Q('conversation.tailOut', row)) return 'out';
    if (Q('conversation.tailIn', row)) return 'in';
    if (ownStatus(row)) return 'out';
    if (row.matches('.message-out') || Q('conversation.classOut', row)) return 'out';
    if (row.matches('.message-in') || Q('conversation.classIn', row)) return 'in';
    if (Q('conversation.youLabel', row)) return 'out';
    if (id.fromMe !== null) return id.fromMe ? 'out' : 'in';
    if (model) return model.from_me ? 'out' : 'in';
    return 'in'; // every outgoing bubble shows a delivery state, so a bubble without one is the customer's
  }

  /** The message's own text: not the quoted message it replies to; captions for media. */
  function bodyOf(row) {
    for (const e of ACX.chain('conversation.text')) {
      let els = [];
      try { els = Array.from(row.querySelectorAll(e.s)); } catch { continue; }
      const quoted = (ACX.chain('conversation.quoted')[0] || {}).s;
      const own = els.filter((el) => !(quoted && el.closest(quoted)));
      if (!own.length) continue;
      const texts = own.map((el) => textOf(el)).filter(Boolean).sort((a, b) => b.length - a.length);
      if (texts.length) return texts[0];
    }
    return textOf(Q('conversation.caption', row));
  }

  function kindOf(row) {
    const icons = iconNames(row);
    if (Q('conversation.kindSticker', row)) return 'sticker';
    if (Q('conversation.kindVoice', row) || rx('icons.voice').test(icons)) return 'voice';
    if (Q('conversation.kindDocument', row) || rx('icons.document').test(icons)) return 'document';
    if (Q('conversation.kindVideo', row)) return 'video';
    if (Q('conversation.kindImage', row)) return 'image';
    if (Q('conversation.kindAudio', row)) return 'voice';
    if (Q('conversation.kindOther', row)) return 'other';
    return 'text';
  }

  /** "[18:51, 14/11/2026] Jake: " -> { author, ts }. The date order follows the phone's language, so ts is a best effort. */
  function parsePre(pre) {
    const out = { author: '', ts: null };
    if (!pre) return out;
    const close = pre.indexOf('] ');
    if (close >= 0) out.author = pre.slice(close + 2).replace(/:\s*$/, '').trim();
    const m = /\[(\d{1,2}):(\d{2})(?:\s*([ap])\.?\s*m\.?)?,\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\]/i.exec(pre);
    if (!m) return out;
    let hour = Number(m[1]);
    if (m[3]) hour = (hour % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
    const year = Number(m[6]) < 100 ? 2000 + Number(m[6]) : Number(m[6]);
    const make = (day, month) => {
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const t = new Date(year, month - 1, day, hour, Number(m[2])).getTime();
      return Number.isFinite(t) && t < Date.now() + 36 * 3600_000 ? t : null;
    };
    out.ts = make(Number(m[4]), Number(m[5])) ?? make(Number(m[5]), Number(m[4])); // day first (UK), else month first
    return out;
  }

  /** Last message of the open chat without touching the bridge (used by scan). */
  function lastMessageLight() {
    const rows = messageRows();
    const m = rows[rows.length - 1];
    return m ? { id: m.dataId, direction: directionOf(m, null), body: bodyOf(m.row) } : null;
  }

  /** The last 40 messages of the open chat, oldest first. */
  async function collectMessages() {
    let rows = messageRows().slice(-40);
    // Long messages are cut behind a "Read more" button: open them so the full text is read.
    let expanded = 0;
    for (const m of rows) {
      const more = Q('conversation.readMore', m.row);
      if (more && expanded < 6) { ACX.click(more); expanded++; }
    }
    if (expanded) { await sleep(200); rows = messageRows().slice(-40); }

    const models = (await bridge('messages', rows.map((m) => m.id.msgId))) || {};
    const textTypes = lookup('bridge.msgTypesText') || ['chat'];
    const kinds = lookup('bridge.msgTypeKinds') || {};
    const out = [];
    for (const m of rows) {
      const model = models[m.id.msgId] || null;
      const pre = parsePre(val('conversation.prePlainText', m.row));
      let kind = kindOf(m.row);
      let body = bodyOf(m.row);
      if (model && model.type) {
        // The model has the full text even when the page shows a shortened or quoted one.
        kind = textTypes.includes(model.type) ? 'text' : kinds[model.type] || (kind === 'text' ? 'other' : kind);
        if (model.text) body = model.text;
        else if (kind !== 'text') body = '';
      }
      if (kind === 'text' && !body) continue; // nothing readable (system rows, deleted messages)
      out.push({
        external_id: m.dataId,
        direction: directionOf(m, model),
        body,
        kind,
        ts: model && model.t ? model.t * 1000 : pre.ts,
        author: pre.author,
        // The bubble, for copying the photo or one frame of the video (ACX.captureMedia), and for a video
        // what the bridge knows about it (findVideo). Voice notes are left alone.
        _media: kind === 'image' || kind === 'video'
          ? { el: m.row, kind, info: model ? { duration: model.duration || null, size: model.size || null, view_once: Boolean(model.view_once) } : {} }
          : null,
      });
    }
    return out;
  }

  /**
   * Who the open chat is. Sources, best first: the bridge, compound ids on the page, WhatsApp's own
   * IndexedDB, and last the title alone (a phone number title gives <digits>@c.us, a name gives a
   * low trust "name:<title>" id).
   */
  async function identify(cur, msgs) {
    const rows = messageRows();
    let jid = null;
    let isGroup = false;
    let phone = null;

    const active = await bridge('activeChat');
    if (active && active.jid && normTitle(active.title) === normTitle(cur.title)) { jid = active.jid; isGroup = Boolean(active.is_group); }

    if (!jid) {
      const counts = {};
      for (const m of rows) if (m.id.jid) counts[m.id.jid] = (counts[m.id.jid] || 0) + 1;
      jid = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
    }
    if (!jid) {
      for (const m of rows.slice(-3).reverse()) {
        const hit = await idbFind(m.id.msgId);
        if (hit) { jid = hit.jid; phone = hit.phone; break; }
      }
    }
    if (!jid) jid = isPhoneTitle(cur.title) ? `${digitsOf(cur.title)}@c.us` : `name:${normTitle(cur.title)}`;

    if (isGroupJid(jid) || labelInfo(cur.label).kind === 'group') isGroup = true;
    // More than two people writing (us included) means a group, whatever the label says.
    const authors = new Set((msgs || []).map((m) => m.author).filter(Boolean));
    if (authors.size > 2) isGroup = true;

    if (!isGroup) {
      if (serverOf(jid) === 'c.us') phone = digitsOf(jid.split('@')[0]);
      else if (serverOf(jid) === 'lid' && !phone) phone = await bridge('phoneOf', jid);
      if (!phone && isPhoneTitle(cur.title)) phone = digitsOf(cur.title);
    }
    known[cur.title] = { jid, is_group: isGroup };
    return { jid, is_group: isGroup, phone: phone ? `+${digitsOf(phone)}` : null };
  }

  // ---- opening a chat ------------------------------------------------------------------------------------------------

  /** Row for a wanted chat: by title, else by phone number title. Throws when two rows fit. */
  function findRow(want) {
    const titles = want.titles.map(normTitle).filter(Boolean);
    const hits = parsedRows().filter((r) => titles.includes(normTitle(r.title)) || (want.digits && isPhoneTitle(r.title) && digitsOf(r.title) === want.digits));
    if (hits.length > 1) throw new Fail('thread_not_found', `More than one chat is called "${hits[0].title}"`, false);
    return hits[0] || null;
  }

  const fits = (title, want) => {
    const nt = normTitle(title);
    return Boolean(nt) && (want.titles.map(normTitle).includes(nt) || Boolean(want.digits && isPhoneTitle(title) && nt === want.digits));
  };

  /** Put text in the chat list search box (a plain input on current builds, an editor on old ones). */
  async function setSearch(input, value) {
    input.focus();
    if (input.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, value); // React only notices a change made through the native setter
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      ACX.selectAllIn(input);
      await sleep(70);
      if (value) document.execCommand('insertText', false, value);
      else input.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
    }
  }

  /**
   * Open the wanted chat by clicking its row and wait until the header shows it.
   * want = { titles: [...], digits: '4477...' | '' }. Returns currentChat().
   */
  async function openThread(want) {
    let cur = currentChat();
    if (cur && fits(cur.title, want)) return cur;

    await resetList(true);
    let row = findRow(want);
    let searched = null;
    if (!row) {
      // Not among the rows on screen (the list only renders what is visible): use the search box.
      const input = Q('chatList.searchInput');
      const term = want.titles[0] || want.digits;
      if (input && term) {
        searched = input;
        await setSearch(input, term);
        row = await waitFor(() => findRow(want), { timeout: 4000, interval: 300 }).catch(() => null);
      }
    }
    try {
      if (!row) throw new Fail('thread_not_found', `Could not find the chat "${want.titles[0] || want.digits}"`, true);
      const targets = [Q('chatList.rowActivator', row.row), row.row.querySelector('[data-testid="cell-frame-container"]'), row.row].filter(Boolean);
      for (const el of targets) {
        try { el.scrollIntoView({ block: 'center' }); listMovedByUs = true; } catch { /* not scrollable */ }
        await sleep(rand(150, 400));
        ACX.click(el);
        cur = await waitFor(() => { const c = currentChat(); return c && fits(c.title, want) ? c : null; }, { timeout: 4000, interval: 250 });
        if (cur) break;
      }
      if (!cur) throw new Fail('thread_not_found', `The chat "${row.title}" did not open`, true);
    } finally {
      if (searched) { await setSearch(searched, ''); await sleep(200); }
    }
    // Let the messages render.
    await waitFor(() => messageRows().length > 0, { timeout: 1500, interval: 200 });
    return cur;
  }

  /** Stop when the composer label names a different chat or a group. */
  function checkLabel(cur) {
    const li = labelInfo(cur.label);
    if (li.kind === 'group') throw new Fail('thread_not_found', 'That chat is a group', false);
    if (li.kind === 'chat' && normTitle(li.name) !== normTitle(cur.title)) throw new Fail('thread_not_found', 'The message box belongs to a different chat', true);
  }

  // ---- the whole video, for the vision model ---------------------------------------------------------------------

  /** The open media viewer, when one shows. */
  const viewerOpen = () => { const v = Q('media.viewer'); return v && visible(v) ? v : null; };

  /** Close the media viewer the way a person would: Escape, then its close button. The chat stays as it was. */
  async function closeViewer(title) {
    for (let round = 0; round < 2 && viewerOpen(); round++) {
      ACX.key(document.activeElement || document.body, 'Escape', { keyCode: 27, which: 27 });
      if (await waitFor(() => !viewerOpen(), { timeout: 1200, interval: 150 })) break;
      const btn = Q('media.viewer_close', viewerOpen() || document);
      if (btn) ACX.click(btn);
      await waitFor(() => !viewerOpen(), { timeout: 1200, interval: 150 });
    }
    if (viewerOpen()) ACX.diag('note', { video_capture: ['viewer_still_open'] });
    const cur = currentChat();
    if (title && cur && normTitle(cur.title) !== normTitle(title)) ACX.diag('note', { video_capture: ['chat_changed'] });
  }

  /**
   * The file of a customer video. WhatsApp Web only loads it when it is opened, so: open it in the
   * media viewer, keep the player muted and paused, read the bytes behind its blob: address, and close
   * the viewer again (done). Never for a view once video. A video the bridge says is huge is not opened.
   */
  async function findVideo(m, deadline) {
    const left = () => deadline - Date.now();
    const info = (m._media && m._media.info) || {};
    const bubble = m._media.el;
    if (info.view_once || Q('media.view_once', bubble)) return { why: 'view_once' };
    if (info.size && info.size > 64 * 1024 * 1024) return { why: 'too_big_to_open', seconds: info.duration || null };
    const opener = Q('media.video_open', bubble);
    if (!opener) return { why: 'no_opener' };
    const title = currentChat()?.title || '';
    const done = () => closeViewer(title);
    if (viewerOpen()) await closeViewer(title); // left over from before: start clean
    ACX.click(opener);
    const viewer = await waitFor(() => viewerOpen(), { timeout: Math.max(300, Math.min(4000, left())), interval: 200 });
    if (!viewer) return { why: 'no_viewer', done };
    const quiet = (v) => { try { v.muted = true; if (!v.paused) v.pause(); } catch { /* ignore */ } return v; };
    const video = await waitFor(() => {
      const v = Q('media.viewer_video', viewerOpen() || viewer);
      if (v) quiet(v);
      return v && /^blob:/.test(v.currentSrc || v.src || '') ? v : null;
    }, { timeout: Math.max(300, Math.min(8000, left())), interval: 200 });
    if (!video) return { why: 'no_video_in_viewer', done };
    quiet(video);
    const seconds = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : info.duration || null;
    let blob = null;
    try {
      const res = await fetch(video.currentSrc || video.src, { signal: AbortSignal.timeout(Math.max(500, Math.min(5000, left()))) });
      if (res.ok) blob = await res.blob();
    } catch { blob = null; } // a streamed player has no file behind its address: frames only
    if (blob && blob.size > 0) return { blob, seconds, mime: blob.type || 'video/mp4', done };
    return { el: video, seconds, done };
  }

  async function read({ key }) {
    const title = String(key || '').trim();
    if (!title) throw new Fail('thread_not_found', 'No chat given', false);
    await closeDialogs();
    const cur = await openThread({ titles: [title], digits: '' });
    await sleep(rand(300, 700)); // a person looks before doing anything

    const messages = await collectMessages();
    const who = await identify(cur, messages);
    const thread = {
      external_id: who.jid,
      title: cur.title,
      is_group: who.is_group,
      subject: null,
      contact: { name: isPhoneTitle(cur.title) ? '' : cur.title.replace(/^~\s*/, ''), phone: who.phone, email: null, handle: null },
    };
    if (who.is_group) return { thread, messages: [] }; // remembered in `known`, so scan skips it from now on

    checkLabel(cur);
    if (messages.length) lastSeen[cur.title] = messages[messages.length - 1].external_id;
    // Photos and video previews of the newest customer messages ride along. Never throws, at most about 5 s.
    await ACX.captureMedia(messages);
    // The newest customer video itself, when Google AI Studio is connected. Never throws, at most about 15 s.
    await ACX.captureVideo(messages, findVideo);
    const out = messages.map(({ external_id, direction, body, kind, ts, media }) => (media ? { external_id, direction, body, kind, ts, media } : { external_id, direction, body, kind, ts }));
    // What the end of the chat looked like: send() refuses the reply if the customer wrote again since.
    return { thread, messages: out, tail: ACX.tailRef(out) };
  }

  // ---- typing and sending -----------------------------------------------------------------------------------------------

  const composerText = () => { const c = Q('composer.input'); return c ? squash(textOf(c)) : null; };

  /** Loose text comparison: WhatsApp renders *bold* and _italic_ without their marks. */
  const loose = (s) => squash(s).replace(/[*_~`]/g, '').toLowerCase();
  const sameText = (a, b) => { const x = loose(a); const y = loose(b); return Boolean(x) && (x === y || (y.length > 60 && x.startsWith(y.slice(0, 60)))); };

  /** Remove text we typed ourselves (and only that) so no half message is left as a draft. */
  async function clearOurs(text) {
    const c = Q('composer.input');
    if (c && squash(textOf(c)) && sameText(textOf(c), text)) await ACX.clearComposer(c);
  }

  /**
   * Put one message in the box and confirm the box holds exactly that text. With the old human pacing
   * (`pace.instant` false) there is a thinking pause before and a "typing..." pause after, scaled by
   * `pace.scale`; with typing_cps 0 the text goes in at once.
   * The message box is looked up again at every step: WhatsApp replaces the element when it goes
   * from empty to filled, so a reference kept across a pause may be dead.
   */
  async function typePart(text, pace, title) {
    const want = squash(text);
    const first = q('composer.input');
    if (!first) throw new Fail('composer_missing', 'Could not find the message box', true);
    const total = Math.min(12_000, Math.max(700, (text.length / Math.max(3, pace.cps)) * 1000));
    const there = squash(textOf(first));
    if (there && there !== want) throw new Fail('composer_busy', 'Someone is typing in this chat', true);

    if (!there) { // (when the box already holds exactly this text it is ours from an attempt that was cut short)
      first.focus();
      if (!pace.instant) await ACX.humanPause(total * rand(0.25, 0.4), pace.scale); // thinking pause before the text appears
      const el = Q('composer.input');
      if (!el) throw new Fail('composer_missing', 'The message box went away', true);
      if (squash(textOf(el))) throw new Fail('composer_busy', 'Someone started typing in this chat', true);
      try {
        await ACX.insertText(el, text);
      } catch (err) {
        if (composerText() !== want) {
          const c = Q('composer.input');
          if (c && squash(textOf(c))) await ACX.clearComposer(c); // the box was empty before us: what is there is our half insert
          throw err;
        }
      }
      if (!pace.instant) await ACX.humanPause(total * rand(0.2, 0.35), pace.scale); // the customer sees "typing..." meanwhile
    }
    // Read back. Anything else in the box (the owner typed, the chat changed) stops the send.
    const cur = currentChat();
    if (!cur || normTitle(cur.title) !== normTitle(title)) throw new Fail('composer_busy', 'The open chat changed while typing', true);
    if (composerText() !== want) throw new Fail('composer_busy', 'The message box changed while typing', true);
  }

  const idsInMain = () => new Set(messageRows().map((m) => m.dataId));

  /**
   * Click Send and wait for the new outgoing message. Returns its id. Never sends twice.
   * A delivery tick is waited for briefly (3 s, 5 s for the last part); after that the bubble on
   * the clock is enough, since WhatsApp holds it in its own queue. Only when no bubble shows at all
   * is the full 20 s waited before giving up.
   */
  async function sendTyped(text, { last = true } = {}) {
    const want = squash(text);
    const before = idsInMain();
    // The Send button only exists while the box has text (it swaps with the microphone).
    let btn = await waitFor(() => Q('composer.sendButton'), { timeout: 3000, interval: 200 });
    if (!btn) {
      q('composer.sendButton'); // report the miss
      await clearOurs(text);
      throw new Fail('composer_missing', 'Could not find the Send button', true);
    }
    const box = Q('composer.input');
    btn.click(); // a plain click is what is confirmed to send; synthetic Enter is ignored by WhatsApp

    const emptied = () => { const t = composerText(); return t === null || t === ''; };
    const newOwn = () => {
      let weak = null;
      for (const m of messageRows()) {
        if (before.has(m.dataId) || m.id.fromMe === false) continue;
        const body = bodyOf(m.row);
        if (body && !sameText(body, text)) continue; // someone else's new message
        const st = ownStatus(m.row);
        if (st && st !== 'pending') return { id: m.dataId, status: st };
        if (st || body) weak = { id: m.dataId, status: st || 'echo' };
      }
      return weak ? { ...weak, weak: true } : null;
    };

    let cleared = await waitFor(emptied, { timeout: 1500, interval: 100 });
    if (!cleared && box && box.isConnected && Q('composer.input') === box && squash(textOf(box)) === want && !newOwn()) {
      // The first click landed while the button was being swapped in: nothing left the box.
      btn = Q('composer.sendButton');
      if (btn) btn.click();
      cleared = await waitFor(emptied, { timeout: 2500, interval: 100 });
    }
    if (!cleared) {
      if (newOwn()) throw new Fail('send_not_confirmed', 'The message may have been sent but the box did not clear', false);
      await clearOurs(text); // nothing was sent: safe to try again later
      throw new Fail('send_not_confirmed', 'The Send button did not respond', true);
    }

    // Sent or better (one tick) is success. A message still on the clock is in WhatsApp's own queue.
    const strongWait = last ? 5000 : 3000;
    let res = await waitFor(() => { const n = newOwn(); return n && !n.weak ? n : null; }, { timeout: strongWait, interval: 300 });
    if (!res) res = newOwn();
    // A slow render (a hidden tab): keep waiting for the bubble itself before calling it unclear.
    if (!res) res = await waitFor(newOwn, { timeout: 20_000 - strongWait, interval: 400 });
    if (!res) throw new Fail('send_not_confirmed', 'The message left the box but did not show up in the chat', false);
    if (res.weak && res.status === 'echo') ACX.diag('note', { where: 'send', note: 'no delivery state on the sent bubble' });
    sentIds.add(res.id);
    return res.id;
  }

  /** How many leading parts of the job are already the last outgoing messages of the chat. */
  function alreadySent(msgs, parts) {
    const outs = [];
    for (let i = msgs.length - 1; i >= 0 && msgs[i].direction === 'out'; i--) outs.unshift(msgs[i]);
    for (let k = Math.min(parts.length, outs.length); k >= 1; k--) {
      const tail = outs.slice(-k);
      if (tail.every((m, j) => sameText(m.body, parts[j]))) return { k, ids: tail.map((m) => m.external_id) };
    }
    return { k: 0, ids: [] };
  }

  /** Titles and phone digits a job's target may appear under in the chat list. */
  async function wantFor(target) {
    const jid = target.thread_external_id || '';
    const titles = [];
    for (const [title, k] of Object.entries(known)) if (jid && k.jid === jid) titles.push(title);
    for (const c of (await bridgeChats()) || []) if (jid && c.jid === jid && c.title) titles.push(c.title);
    if (target.title) titles.push(target.title);
    const digits = digitsOf(target.phone) || (serverOf(jid) === 'c.us' ? digitsOf(jid.split('@')[0]) : '');
    return { titles: [...new Set(titles)], digits };
  }

  /** After the send?phone page load: wait for the chat or for WhatsApp's verdict on the number. */
  async function openNewChat(digits) {
    const end = Date.now() + 30_000;
    let cur = null;
    while (Date.now() < end && !cur) {
      const found = await waitFor(() => {
        const ds = dialogs().map((d) => ({ d, kind: dialogKind(d) })).filter((x) => x.kind !== 'other');
        if (ds.length) return { dialog: ds[0] };
        const c = currentChat();
        return c && c.composer ? { chat: c } : null;
      }, { timeout: Math.max(500, end - Date.now()), interval: 400 });
      if (!found) break;
      if (found.chat) { cur = found.chat; break; }
      const { d, kind } = found.dialog;
      if (kind === 'invalid') {
        const btn = Q('state.dialogButton', d);
        if (btn) ACX.click(btn);
        await setPending(null);
        throw new Fail('not_on_whatsapp', `+${digits} is not on WhatsApp`, false);
      }
      if (kind === 'restricted') { await setPending(null); throw new Fail('blocked', MSG.restricted, false); }
      await closeDialogs(); // "what's new" after the reload; throws blocked for anything else
    }
    await setPending(null);
    if (!cur) throw new Fail('timeout', 'The chat did not open after loading the page', true);
    // An unsaved number shows the number as the title: it must be the one we asked for.
    if (isPhoneTitle(cur.title) && digitsOf(cur.title) !== digits) throw new Fail('thread_not_found', 'WhatsApp opened a different number', false);
    return cur;
  }

  async function send({ job, navigated, newer_than: newerThan, budget_ms: budgetMs }) {
    if (!job || !Array.isArray(job.parts) || !job.parts.length) throw new Fail('unknown', 'Nothing to send', false);
    const target = job.target || {};
    const parts = job.parts.map((p) => String(p));
    // typing_cps 0: each part goes in whole with no pauses. A typing speed (older servers): the human
    // pauses, scaled down to short floor pauses when the worker says other customers are waiting.
    const rawCps = job.pacing ? job.pacing.typing_cps : undefined;
    const cps = ACX.cpsOf(rawCps);
    const nominal = 850 + parts.reduce((n, p) => n + Math.min(12_000, Math.max(700, (p.length / Math.max(3, cps)) * 1000)) * 0.6 + 1150, 0);
    const pace = { instant: ACX.instant(rawCps), cps, scale: ACX.pauseScale(budgetMs, nominal) };
    const want = await wantFor(target);

    let cur;
    if (job.kind === 'new_chat' && navigated) {
      cur = await openNewChat(want.digits);
    } else {
      await closeDialogs();
      if (!want.titles.length && !want.digits) throw new Fail('thread_not_found', 'The job does not say which chat', false);
      cur = await openThread(want);
    }
    await sleep(pace.instant ? rand(150, 300) : Math.max(300, rand(500, 1200) * pace.scale)); // let the chat settle on screen

    // Refuse to type anywhere but the chat the job names.
    checkLabel(cur);
    const msgs = await collectMessages();
    const who = await identify(cur, msgs);
    if (who.is_group) throw new Fail('thread_not_found', 'That chat is a group', false);
    const wantJid = job.kind === 'new_chat' ? (want.digits ? `${want.digits}@c.us` : '') : target.thread_external_id || '';
    if (isRealJid(wantJid) && isRealJid(who.jid) && wantJid !== who.jid) {
      // The same person can show up as a phone id here and a hidden id there: compare phones then.
      const a = serverOf(wantJid) === 'c.us' ? digitsOf(wantJid.split('@')[0]) : digitsOf(target.phone);
      const b = digitsOf(who.phone);
      const sameServer = serverOf(wantJid) === serverOf(who.jid);
      if (sameServer || (a && b && a !== b)) throw new Fail('thread_not_found', 'A different chat with the same name is open', false);
    }

    // Idempotent: parts this page already sent for the job, or that are already the last messages
    // we sent in the chat, are not typed again.
    const seen = alreadySent(msgs, parts);
    const mine = jobProgress.get(job.id) || [];
    const sent = mine.length >= seen.k ? [...mine] : [...seen.ids];
    const from = sent.length;
    // The customer wrote again after the read this reply was decided on: it is out of date. Nothing
    // was sent for it yet, so it is refused and the worker reads the chat again for one fresh answer.
    if (from === 0 && newerThan && ACX.newerInbound(msgs, newerThan)) {
      await clearOurs(parts[0]);
      throw new Fail('newer_message', 'The customer wrote again before this reply went out', false);
    }
    for (let i = from; i < parts.length; i++) {
      // About 0.4 s between parts (WhatsApp keeps their order); the old human gap with a speed.
      if (i > from) await sleep(pace.instant ? 400 : Math.max(400, rand(700, 1600) * pace.scale));
      await typePart(parts[i], pace, cur.title);
      sent.push(await sendTyped(parts[i], { last: i === parts.length - 1 }));
      jobProgress.set(job.id, [...sent]);
    }
    if (sent.length) lastSeen[cur.title] = sent[sent.length - 1];
    return { sent_external_ids: sent };
  }

  /** new_chat: open the number through the same link a person follows from wa.me (a full page load). */
  async function prepare({ job }) {
    if (!job || job.kind !== 'new_chat') return { ready: true };
    const digits = digitsOf(job.target && job.target.phone);
    if (digits.length < 7 || digits.length > 15) throw new Fail('invalid_number', 'That is not a full international phone number', false);
    // A chat with this number that is already in the list needs no reload.
    try {
      if (Q('state.loggedIn') && !dialogs().some((d) => dialogKind(d) !== 'other') && findRow(await wantFor(job.target))) return { ready: true };
    } catch { /* ambiguous rows: go through the link */ }
    const tpl = lookup('urls.sendToPhone') || 'https://web.whatsapp.com/send/?phone={digits}&text&type=phone_number&app_absent=0';
    await setPending({ job_id: job.id, digits, at: Date.now() });
    return { navigate: tpl.replace('{digits}', digits) };
  }

  // ---- self test ------------------------------------------------------------------------------------------------------------

  async function selftest() {
    const checks = [];
    const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: String(detail) });

    const p = await probe();
    add('page state', p.state === 'ready', p.detail || p.state);
    const ping = await bridge('ping');
    add('bridge (optional)', true, ping ? `on, WhatsApp ${ping.version || 'version unknown'}${ping.collections ? '' : ', collections missing'}` : 'off: using the page only');
    if (p.state !== 'ready') return { checks };

    add('chat list', q('chatList.grid'));
    const rows = chatRows();
    add('chat rows', rows.length > 0, `${rows.length} on screen`);
    const parsed = parsedRows();
    add('chat titles', parsed.length > 0, `${parsed.length} of ${rows.length} rows have a title`);
    if (rows[0]) add('row click target', Q('chatList.rowActivator', rows[0]));
    add('search box', q('chatList.searchInput'));
    add('unread badges', true, `${parsed.filter((r) => r.unread > 0).length} chats show one`);

    const cur = currentChat();
    if (!cur) {
      add('open chat', true, 'skipped: no chat is open. Open any chat and run the check again to test reading and typing');
      return { checks };
    }
    add('chat header title', cur.title, cur.title ? '' : 'title not found');
    const msgs = messageRows();
    add('messages', msgs.length > 0, `${msgs.length} on screen`);
    if (msgs.length) {
      const forms = new Set(msgs.map((m) => m.id.form));
      const read = await collectMessages();
      add('message ids', true, `${[...forms].join(' + ')} form`);
      add('message text', read.length > 0, `${read.length} readable, ${read.filter((m) => m.direction === 'out').length} ours`);
      const who = await identify(cur, read);
      add('chat identity', isRealJid(who.jid), isRealJid(who.jid) ? `${serverOf(who.jid)} id${who.is_group ? ' (group)' : ''}` : 'only the title is known on this build');
    }

    const box = q('composer.input');
    add('message box', box);
    if (!box) return { checks };
    if (squash(textOf(box))) { add('typing', true, 'skipped: there is a draft in the box'); return { checks }; }
    // Type, look, clear. Nothing is sent.
    const probeText = 'acx check';
    try {
      const how = await ACX.insertText(box, probeText);
      add('typing', composerText() === probeText, `method: ${how}`);
      add('send button', await waitFor(() => Q('composer.sendButton'), { timeout: 2000, interval: 200 }));
    } catch (err) {
      add('typing', false, err && err.message);
    }
    const c = Q('composer.input');
    if (c && squash(textOf(c))) await ACX.clearComposer(c);
    add('clearing', composerText() === '', composerText() ? 'the test text is still in the box: delete it by hand' : '');
    return { checks };
  }

  // ---- registration -------------------------------------------------------------------------------------------------------------

  /** Send the page shape with failures that a selector fix could solve. */
  function guarded(name, fn) {
    return async (args) => {
      try {
        return await fn(args);
      } catch (err) {
        const code = err instanceof Fail ? err.code : 'unknown';
        if (['thread_not_found', 'composer_missing', 'send_not_confirmed', 'timeout', 'unknown'].includes(code)) {
          const root = code === 'thread_not_found' ? Q('chatList.scroller') : Q('composer.footer') || Q('conversation.main');
          ACX.snapshot(`${name}:${code}`, root || document.body);
        }
        throw err;
      }
    };
  }

  ACX.register({
    probe,
    scan: guarded('scan', scan),
    sweep: guarded('sweep', sweep),
    read: guarded('read', read),
    send: guarded('send', send),
    prepare,
    selftest,
  });

  // New messages change the chat list: nudge the worker so it does not wait for its next poll.
  ACX.watch(() => Q('chatList.scroller'));
})();
