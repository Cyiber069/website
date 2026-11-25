// TikTok direct messages adapter (https://www.tiktok.com/messages). Runs after core.js in the isolated world.
//
// What makes TikTok different from the other two sites:
//  * Three front ends exist behind A/B flags. "sdk" (IM React SDK) puts conversation and message ids in
//    the DOM, "legacy" does not, "vmok" is a separate app whose DOM is unknown. Everything here works
//    from the selector pack and degrades: no message id means external_id null and the server matches
//    messages by order.
//  * The message box is Draft.js. Only a paste event goes through its own state, and the Send button
//    is rendered only once that state holds text, so "the button appeared" doubles as proof the text
//    really landed. execCommand destroys an empty Draft editor, which is why the pack says paste only.
//  * A message can only be read by opening its conversation. Direction comes from layout: the row that
//    holds avatar and bubble is flex-direction row-reverse for our own messages.
//  * Strangers land in "Message requests". Those are read like any chat, but TikTok shows an Accept box
//    instead of the message box, and the agent never presses Accept by itself.
//  * TikTok is the strictest of the three about automation, so a captcha or a "sending messages too
//    fast" notice stops the whole channel until the owner has looked.
//
// The content script is injected on all of www.tiktok.com (TikTok is a single page app), but it does
// nothing until the tab is on /messages.
(() => {
  const ACX = globalThis.ACX;
  if (!ACX || ACX.channel !== 'tiktok' || globalThis.__acxTikTok) return;
  globalThis.__acxTikTok = true;
  if (window !== window.top) return;

  const { Fail, q, qa, val, rx, squash, sleep, rand, waitFor, visible, textOf } = ACX;
  const QUIET = { quiet: true };
  const MAX_MESSAGES = 40;
  const BLOCK_KEY = 'tiktok_block';

  // ---- small helpers ----------------------------------------------------------------------------

  const onMessages = () => location.pathname.startsWith('/messages');

  function loggedOutPath() {
    try { return new RegExp(ACX.lookup('urls.logged_out_path') || '^/login').test(location.pathname); } catch { return location.pathname.startsWith('/login'); }
  }

  function requireMessages() {
    if (!onMessages()) throw new Fail('tab_missing', 'The TikTok tab is not on the messages page', true);
  }

  const limit = (name, fallback) => {
    const v = ACX.lookup(`limits.${name}`);
    return typeof v === 'number' && v >= 0 ? v : fallback;
  };

  /** "/@Jake.Rides?lang=en", "@Jake.Rides" or a profile URL -> "jake.rides". */
  const handleOf = (s) => String(s || '').trim().replace(/^.*\/@/, '').replace(/^@/, '').split(/[/?#\s]/)[0].toLowerCase();

  const same = (a, b) => squash(a) === squash(b);
  const sameName = (a, b) => squash(a).toLowerCase() === squash(b).toLowerCase();

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /** 1:1 conversation ids look like 0:1:<uid>:<uid>. Anything else with an id is treated as a group. */
  function isOneToOne(convId) {
    try { return new RegExp(ACX.lookup('urls.one_to_one_id') || '^0:1:\\d+:\\d+$').test(convId); } catch { return /^0:1:\d+:\d+$/.test(convId); }
  }

  // ---- who is logged in, which front end ----------------------------------------------------------

  let appCtx; // parsed once: the JSON is large
  /** TikTok's own page data: the logged in user and the A/B flags that pick the DM front end. */
  function appContext() {
    if (appCtx !== undefined) return appCtx;
    try {
      const el = q('page.app_data', document, QUIET);
      const scope = JSON.parse(el.textContent).__DEFAULT_SCOPE__;
      const ctx = scope['webapp.app-context'];
      const p = (ctx.abTestVersion && ctx.abTestVersion.parameters) || {};
      const pick = (k) => (p[k] && p[k].vid != null ? String(p[k].vid) : null);
      // Business accounts with the message permission get their inbox inside Business Suite. Only a
      // true is trusted: the page may fill the permission in later, after this data was written.
      const biz = scope['webapp.business'];
      const business = biz && biz.businessPermission && biz.businessPermission.message === true ? true : null;
      appCtx = {
        region: ctx.region || null,
        language: ctx.language || null,
        unique_id: ctx.user && ctx.user.uniqueId ? String(ctx.user.uniqueId).toLowerCase() : null,
        flags: { sdk: pick('web_dm_im_react_sdk'), vmok: pick('web_dm_messages_vmok'), drawer: pick('web_dm_flexible_drawer') },
        business,
      };
    } catch {
      if (document.readyState !== 'complete') return null; // try again once the page has loaded
      appCtx = null;
    }
    return appCtx;
  }

  const ownHandle = () => (appContext() && appContext().unique_id) || '';
  /** The header's link to the signed in profile, when the page data has no user (some pages lack it). Selector from the pack. */
  function headerHandle() {
    const sel = ACX.lookup('page.own_profile_link');
    if (!sel) return '';
    try {
      const a = document.querySelector(String(sel));
      const m = a && /\/@([A-Za-z0-9._]{2,40})/.exec(a.getAttribute('href') || '');
      return m ? m[1].toLowerCase() : '';
    } catch { return ''; }
  }

  let lastVariant = 'unknown';
  /** sdk | legacy | vmok | unknown. Decided from what is in the DOM, with the A/B flags as a hint. */
  function variant() {
    const list = q('conversation.list', document, QUIET);
    const items = list ? qa('conversation.item', list) : [];
    if (q('conversation.row', document, QUIET) || items.some((el) => el.hasAttribute('data-conv-id'))) lastVariant = 'sdk';
    else if (items.length) lastVariant = 'legacy';
    else if (q('page.loading', document, QUIET)) lastVariant = 'vmok';
    else if (lastVariant === 'unknown') {
      const flags = appContext() && appContext().flags;
      if (flags && flags.vmok === 'v1') return 'vmok';
    }
    return lastVariant;
  }

  // ---- things that stop the channel ------------------------------------------------------------------

  /**
   * Short texts of toasts, dialogs and anything TikTok hangs directly on <body> (where its pop ups
   * live). Never the conversation list or the chat: a customer writing "slow down" is not a notice.
   */
  function noticeTexts() {
    const app = [q('chat.box', document, QUIET), q('conversation.list', document, QUIET)].filter(Boolean);
    const els = new Set();
    for (const key of ['page.toast', 'page.dialog']) {
      for (const entry of ACX.chain(key)) {
        try { document.querySelectorAll(entry.s).forEach((el) => els.add(el)); } catch { /* bad selector in a hot update */ }
      }
    }
    const portals = new Set();
    for (const el of document.body ? document.body.children : []) {
      if (!app.some((a) => el.contains(a))) portals.add(el);
    }
    const out = [];
    for (const el of new Set([...els, ...portals])) {
      if (app.some((a) => a.contains(el)) || !visible(el)) continue;
      const text = squash(el.textContent);
      if (!text) continue;
      if (text.length > 600 && !els.has(el)) continue; // a page section, not a pop up
      out.push(text.slice(0, 600));
    }
    return out;
  }

  /** The reason the channel must stop right now, or null. */
  function blocker() {
    const captcha = q('page.captcha', document, QUIET);
    if (captcha && visible(captcha)) return { kind: 'captcha', detail: 'TikTok is asking for a captcha. Solve it on the TikTok tab' };
    for (const text of noticeTexts()) {
      if (rx('text.captcha').test(text)) return { kind: 'captcha', detail: 'TikTok is asking for a captcha. Solve it on the TikTok tab' };
      if (rx('text.too_fast').test(text)) return { kind: 'too_fast', detail: 'TikTok says messages are being sent too fast' };
      if (rx('text.dm_suspended').test(text)) return { kind: 'suspended', detail: 'TikTok has restricted direct messages on this account' };
      if (rx('text.logged_out').test(text)) return { kind: 'logged_out', detail: 'Log in to TikTok on that tab' };
    }
    return null;
  }

  // After a "too fast" notice the channel rests for a while even though the toast is gone.
  let rest = { until: 0, detail: '' };
  try {
    chrome.storage.local.get(BLOCK_KEY).then((raw) => {
      const saved = raw && raw[BLOCK_KEY];
      if (saved && saved.until > rest.until) rest = saved;
    }, () => {});
  } catch { /* storage unavailable */ }

  function startRest(detail) {
    const minutes = limit('too_fast_pause_minutes', 30);
    if (!minutes) return;
    const now = Date.now();
    const until = now + minutes * 60_000;
    if (until - rest.until < 60_000) return; // already resting: the notice is simply still on screen
    const fresh = rest.until < now;
    const at = new Date(until);
    rest = { until, detail: `${detail}. Resting until ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` };
    try { chrome.storage.local.set({ [BLOCK_KEY]: rest }).catch(() => {}); } catch { /* ignore */ }
    if (fresh) ACX.diag('note', { where: 'tiktok.rest', minutes });
  }

  /** Blocker including the rest period. Remembers a "too fast" notice. */
  function blockedNow() {
    const b = blocker();
    if (b && b.kind === 'too_fast') startRest(b.detail);
    if (b) return b;
    if (Date.now() < rest.until) return { kind: 'too_fast', detail: rest.detail };
    return null;
  }

  function assertNotBlocked() {
    const b = blockedNow();
    if (!b) return;
    if (b.kind === 'logged_out') throw new Fail('logged_out', b.detail, true);
    throw new Fail('blocked', b.detail, true); // nothing was typed yet, so trying again later is safe
  }

  // ---- conversation list -----------------------------------------------------------------------------

  /** The area that holds the list and, in the requests view, its Back button. */
  function listScope() {
    const list = q('conversation.list', document, QUIET);
    return (list && list.parentElement) || document;
  }

  /** True while the list shows "Message requests" instead of the normal conversations. */
  function inRequests() {
    const back = q('requests.back', listScope(), QUIET);
    return Boolean(back && visible(back) && !q('requests.entry', document, QUIET));
  }

  async function enterRequests() {
    if (inRequests()) return true;
    const entry = q('requests.entry', document, QUIET);
    if (!entry) return false;
    ACX.click(entry);
    return Boolean(await waitFor(inRequests, { timeout: 5000 }));
  }

  async function leaveRequests() {
    if (!inRequests()) return true;
    ACX.click(q('requests.back', listScope(), QUIET));
    return Boolean(await waitFor(() => !inRequests(), { timeout: 5000 }));
  }

  /**
   * Conversation id of a list item. Strategy, primary to fallback: data-conv-id (sdk), the item's
   * id="more-action-icon-<id>" (both in-bundle front ends), the virtual row's data-conversation-id.
   */
  function convIdOf(item) {
    const own = item.getAttribute('data-conv-id');
    if (own) return own;
    const id = item.id || '';
    if (id.startsWith('more-action-icon-') && !id.startsWith('more-action-icon-msg-')) return id.slice('more-action-icon-'.length);
    const row = item.closest('[data-conversation-id]');
    return (row && row.getAttribute('data-conversation-id')) || '';
  }

  const keyOf = (request, convId, nick) => `${request ? 'req' : 'dm'}|${convId ? `id|${convId}` : `nick|${nick}`}`;

  function parseKey(key) {
    const bits = String(key || '').split('|');
    if (bits.length < 3 || (bits[0] !== 'dm' && bits[0] !== 'req')) throw new Fail('thread_not_found', 'Unknown conversation key', false);
    const value = bits.slice(2).join('|');
    return { request: bits[0] === 'req', convId: bits[1] === 'id' ? value : '', nick: bits[1] === 'nick' ? value : '', handle: '' };
  }

  function rowInfo(el, request) {
    const nick = squash(val('conversation.nickname', el));
    const badge = q('conversation.unread', el, QUIET);
    const badgeText = badge && visible(badge) ? squash(badge.textContent) : null;
    // The badge reads "", "1".."99" or "99+". An empty badge is a dot: at least one unread message.
    const unread = badgeText === null ? 0 : parseInt(badgeText, 10) || 1;
    const lines = String(el.innerText || el.textContent || '').split('\n').map(squash).filter(Boolean)
      .filter((l) => l !== nick && l !== badgeText);
    const last = lines.length ? lines[lines.length - 1] : '';
    const time = rx('text.time').test(last) ? last : '';
    const preview = (time ? lines.slice(0, -1) : lines).join(' ').slice(0, 200);
    const convId = convIdOf(el);
    return {
      el, request, convId, nick, unread, preview, time,
      key: keyOf(request, convId, nick),
      selected: el.getAttribute('aria-selected') === 'true',
      has_selected_attr: el.hasAttribute('aria-selected'),
      is_group: convId ? !isOneToOne(convId) : false,
    };
  }

  /** Rows of whichever list is showing (the list is virtualised: only what is scrolled into view). */
  function visibleRows() {
    const list = q('conversation.list', document, QUIET);
    if (!list) return [];
    const request = inRequests();
    return qa('conversation.item', list).map((el) => rowInfo(el, request)).filter((r) => r.nick || r.convId);
  }

  function matchRow(rows, ref) {
    if (ref.convId) {
      const byId = rows.find((r) => r.convId === ref.convId);
      if (byId) return { row: byId, by: 'id' };
      if (rows.some((r) => r.convId)) return null; // this front end has ids and ours is not on screen
    }
    if (ref.nick) {
      const byName = rows.filter((r) => sameName(r.nick, ref.nick));
      if (byName.length === 1) return { row: byName[0], by: 'nick' }; // two people with one name: never guess
    }
    return null;
  }

  let scrolled = false;
  /** Find a conversation in the showing list, scrolling a screen at a time because rows are virtual. */
  async function findRow(ref) {
    let hit = matchRow(visibleRows(), ref);
    if (hit) return hit;
    const list = q('conversation.list', document, QUIET);
    if (!list || list.scrollHeight <= list.clientHeight + 4) return null;
    const steps = limit('list_scroll_steps', 12);
    for (let i = 0; i < steps; i++) {
      const before = list.scrollTop;
      list.scrollTop = before + Math.max(200, list.clientHeight * 0.8);
      scrolled = true;
      await sleep(350);
      hit = matchRow(visibleRows(), ref);
      if (hit) return hit;
      if (list.scrollTop === before) break; // reached the end
    }
    return null;
  }

  /** Put the list back the way scan() expects it: normal conversations, scrolled to the top. */
  async function tidy() {
    try {
      await leaveRequests();
      if (scrolled) {
        scrolled = false;
        const list = q('conversation.list', document, QUIET);
        if (list) list.scrollTop = 0;
      }
    } catch { /* best effort */ }
  }

  // ---- the open conversation -----------------------------------------------------------------------------

  /** Header of the conversation that is open on the right, or null. */
  function chatInfo() {
    const box = q('chat.box', document, QUIET);
    if (!box) return null;
    const nick = squash(val('chat.nickname', box));
    const handle = handleOf(val('chat.unique_id', box));
    if (!nick && !handle) return null;
    return { box, nick, handle };
  }

  // The conversation this adapter opened last: lets us recognise it later without a selected row
  // (legacy front end, or a request chat while the normal list is showing).
  let opened = null; // { key, convId, request, nick, handle }

  /** Which conversation is open, mapped to its list key when that can be worked out. */
  function currentOpen(rows) {
    const chat = chatInfo();
    if (!chat) return null;
    const list = rows || visibleRows();
    const selected = list.find((r) => r.selected && (!r.nick || !chat.nick || sameName(r.nick, chat.nick)));
    if (selected) return { ...chat, key: selected.key, convId: selected.convId, request: selected.request };
    if (opened && sameName(opened.nick, chat.nick) && opened.handle === chat.handle) {
      return { ...chat, key: opened.key, convId: opened.convId, request: opened.request };
    }
    if (!list.some((r) => r.has_selected_attr)) {
      const byName = list.filter((r) => sameName(r.nick, chat.nick));
      if (byName.length === 1) return { ...chat, key: byName[0].key, convId: byName[0].convId, request: byName[0].request };
    }
    return { ...chat, key: null, convId: '', request: false };
  }

  function sameConversation(ref, cur) {
    if (ref.convId && cur.convId) return ref.convId === cur.convId;
    if (ref.handle && cur.handle) return ref.handle === cur.handle;
    if (ref.convId && cur.handle && !ref.convId.includes(':')) return ref.convId === cur.handle;
    return Boolean(ref.nick) && !ref.convId && sameName(ref.nick, cur.nick);
  }

  /** Text of a bubble with TikTok's own emoji images turned back into characters. */
  function messageText(el) {
    const copy = el.cloneNode(true);
    for (const entry of ACX.chain('message.emoji')) {
      try { copy.querySelectorAll(entry.s).forEach((img) => img.setAttribute('alt', img.getAttribute('aria-label') || img.getAttribute('alt') || '')); } catch { /* ignore */ }
    }
    return textOf(copy);
  }

  /** One message bubble -> plain facts. `direction` is null when the layout does not tell. */
  function parseItem(el, list, chat) {
    // Direction 1: the row holding avatar and bubble is reversed for our own messages.
    let byLayout = null;
    const probe = q('message.direction', el, QUIET);
    if (probe) {
      const cs = getComputedStyle(probe);
      if (/flex/.test(cs.display)) byLayout = cs.flexDirection === 'row-reverse' ? 'out' : cs.flexDirection === 'row' ? 'in' : null;
    }
    // Direction 2: whose profile the avatar links to (links inside the text do not count).
    const textEl = q('message.text', el, QUIET);
    let author = '';
    for (const entry of ACX.chain('message.author')) {
      let links = [];
      try { links = Array.from(el.querySelectorAll(entry.s)); } catch { /* ignore */ }
      const link = links.find((a) => !(textEl && textEl.contains(a)));
      if (link) { author = handleOf(link.getAttribute(entry.attr || 'href')); break; }
    }
    const me = ownHandle();
    const byAuthor = !author ? null : me && author === me ? 'out' : chat.handle && author === chat.handle ? 'in' : null;

    let kind = 'other';
    let body = '';
    if (textEl) { kind = 'text'; body = messageText(textEl); }
    else if (q('message.shared_video', el, QUIET) || q('message.video', el, QUIET)) kind = 'video';
    else if (q('message.image', el, QUIET)) kind = 'image';
    else if (q('message.sticker', el, QUIET)) kind = 'sticker';
    else if (!q('message.shared_live', el, QUIET)) {
      const fallback = q('message.fallback_text', el, QUIET); // "[this message type is not supported]"
      if (fallback) body = messageText(fallback);
    }

    // Ids exist only in the sdk front end. The server id is not numeric while a send is pending.
    const rawId = val('message.server_id', el);
    const serverId = (/msg-(\d+)$/.exec(rawId) || [])[1] || '';
    let clientId = '';
    const rowSel = (ACX.chain('message.client_id_row')[0] || {}).s;
    if (rowSel) {
      try {
        const row = el.closest(rowSel);
        if (row && list.contains(row) && row !== list) clientId = row.getAttribute('data-index') || '';
      } catch { /* ignore */ }
    }
    return {
      el, kind, body, author, serverId, clientId,
      direction: byLayout || byAuthor,
      conflict: Boolean(byLayout && byAuthor && byLayout !== byAuthor),
      pending: Boolean(rawId) && !serverId,
      failed: Boolean(q('message.failed', el, QUIET)),
    };
  }

  /** Every message bubble of the open conversation, oldest first. null when there is no message list. */
  function readMessages(chat) {
    const list = q('message.list', chat.box, QUIET);
    if (!list) return null;
    return qa('message.item', list).map((el) => parseItem(el, list, chat));
  }

  /** Wait until the message list stops changing (messages load a moment after the header). */
  async function settle(needSome) {
    const end = Date.now() + 7000;
    let last = -2;
    let stable = 0;
    for (;;) {
      const chat = chatInfo();
      const list = chat ? q('message.list', chat.box, QUIET) : null;
      const n = list ? qa('message.item', list).length : -1;
      stable = n === last && n >= (needSome ? 1 : 0) ? stable + 1 : 0;
      last = n;
      if (stable >= 2 || Date.now() > end) return;
      await sleep(250);
    }
  }

  /** Signature of the end of the open conversation: changes with every new message. */
  function tailOf(chat) {
    const msgs = (readMessages(chat) || []).filter((m) => !(m.failed && m.direction !== 'in'));
    const last = msgs[msgs.length - 1];
    if (!last) return { last_in: false, sig: '0' };
    const tail = msgs.slice(-6).map((m) => `${m.direction}:${m.kind}:${m.body}`).join('\n');
    return { last_in: last.direction === 'in', sig: `${msgs.length}|${last.serverId || last.clientId}|${hash(tail)}`, preview: last.body };
  }

  /**
   * Make `ref` ({ request, convId, nick, handle }) the open conversation. `ref.request` true looks only
   * in Message requests, false only in the normal list, null tries the normal list first.
   * Returns { chat, by } where `by` says what the match was made on (id, handle, nick).
   */
  async function openConversation(ref) {
    const cur = currentOpen();
    if (cur && sameConversation(ref, cur)) {
      opened = { key: cur.key || keyOf(Boolean(ref.request), ref.convId || cur.convId, cur.nick), convId: ref.convId || cur.convId, request: cur.request || Boolean(ref.request), nick: cur.nick, handle: cur.handle };
      return { chat: cur, by: ref.convId && cur.convId ? 'id' : ref.handle && cur.handle ? 'handle' : 'nick' };
    }

    let hit = null;
    if (ref.request !== true) {
      await leaveRequests();
      hit = await findRow(ref);
    }
    if (!hit && ref.request !== false && (await enterRequests())) {
      await waitFor(() => visibleRows().length > 0, { timeout: 2500 });
      hit = await findRow(ref);
    }
    if (!hit) {
      ACX.snapshot('tiktok.open.not_in_list', listScope() === document ? null : listScope());
      throw new Fail('thread_not_found', 'Could not find that conversation in the TikTok list', true);
    }
    const { row, by } = hit;

    const isOpen = () => {
      const chat = chatInfo();
      if (!chat) return null;
      const now = visibleRows().find((r) => r.key === row.key);
      const nameOk = !row.nick || !chat.nick || sameName(row.nick, chat.nick);
      if (now && now.has_selected_attr) return now.selected && nameOk ? chat : null; // sdk: the row says so itself
      return row.nick && sameName(row.nick, chat.nick) ? chat : null; // legacy: the header carries the row's name
    };
    ACX.click(row.el);
    let chat = await waitFor(isOpen, { timeout: 6000 });
    if (!chat) {
      // Second way in: TikTok also opens a focused row on Enter.
      const again = visibleRows().find((r) => r.key === row.key);
      if (again) { try { again.el.focus(); } catch { /* ignore */ } ACX.key(again.el, 'Enter'); }
      chat = await waitFor(isOpen, { timeout: 4000 });
    }
    if (!chat) {
      ACX.snapshot('tiktok.open.no_chat');
      throw new Fail('thread_not_found', 'The TikTok conversation did not open', true);
    }
    opened = { key: row.key, convId: row.convId, request: row.request, nick: chat.nick, handle: chat.handle };
    return { chat, by };
  }

  // ---- probe ---------------------------------------------------------------------------------------------

  const firstSeenAt = Date.now();
  let lostReported = false;

  async function probe() {
    if (!onMessages()) {
      return loggedOutPath()
        ? { state: 'logged_out', detail: 'Log in to TikTok on that tab', unread: 0 }
        : { state: 'loading', detail: 'The tab is not on TikTok messages', unread: 0 };
    }
    const v = variant();
    const layout = `${v} layout`;
    const b = blockedNow();
    if (b && b.kind === 'logged_out') return { state: 'logged_out', detail: b.detail, unread: 0 };
    if (b) return { state: 'blocked', detail: `${b.detail} (${layout})`, unread: 0 };

    const list = q('conversation.list', document, QUIET);
    if (!list) {
      if (Date.now() - firstSeenAt < 60_000 || document.readyState !== 'complete') return { state: 'loading', detail: `Messages are loading (${layout})`, unread: 0 };
      if (!lostReported) { lostReported = true; ACX.snapshot('tiktok.probe.no_list'); }
      return { state: 'error', detail: `Cannot find the conversation list (${layout})`, unread: 0 };
    }
    lostReported = false;
    let unread = 0;
    if (!inRequests()) for (const r of visibleRows()) if (!r.is_group) unread += r.unread;
    const entry = q('requests.entry', document, QUIET);
    const entryBadge = entry ? q('conversation.unread', entry, QUIET) : null;
    if (entryBadge && visible(entryBadge)) unread += parseInt(squash(entryBadge.textContent), 10) || 1;
    // A business account: the worker then sends a tab that wandered into Business Suite back to the
    // business view of this page (scene=business), where this script works.
    const business = Boolean((appContext() && appContext().business) || /(^|&)scene=business(&|$)/.test(location.search.slice(1)));
    // The signed in handle (TikTok's own page data, else the profile link in the header): the dashboard
    // shows it, and a laptop on another account never answers the shop's messages.
    return { state: 'ready', detail: layout, unread, account: ownHandle() || headerHandle(), ...(business ? { business: true } : {}) };
  }

  // ---- scan ------------------------------------------------------------------------------------------------

  // `sig` has to change for every new customer message, also when the customer repeats the exact same
  // text. A list row only shows unread count, preview and time, so the signature also carries a
  // counter that moves on each time this conversation was dealt with (read or answered).
  const boot = Date.now().toString(36); // so signatures never repeat across page reloads
  const epoch = {}; // key -> counter
  const lastUnread = {}; // key -> unread count at the previous scan
  const bump = (key) => { if (key) epoch[key] = (epoch[key] || 0) + 1; };
  const stamp = (key) => `${boot}.${epoch[key] || 0}`;

  let requestCache = { sig: null, at: 0, rows: [] };
  let oddIdsReported = false;

  /** Open "Message requests", note what is there, come back. Only done when the entry row changed. */
  async function listRequests() {
    if (!(await enterRequests())) {
      ACX.snapshot('tiktok.requests.no_view', listScope() === document ? null : listScope());
      return null;
    }
    try {
      await waitFor(() => visibleRows().length > 0, { timeout: 2500 });
      await sleep(200);
      return visibleRows().map(({ el, ...row }) => row);
    } finally {
      await leaveRequests();
    }
  }

  /** True when a list time like "20:14" is today and no more than `mins` minutes ago. */
  function withinMinutes(time, mins) {
    const t = String(time || '').trim().toLowerCase();
    if (/^(now|just now)$/.test(t)) return true;
    const rel = /^(\d{1,3})\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/.exec(t);
    if (rel) return /^s/.test(rel[2]) || Number(rel[1]) <= mins;
    const m = /^(\d{1,2}):(\d{2})/.exec(t);
    if (!m) return false;
    const now = new Date();
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]));
    const ago = (now - at) / 60000;
    return ago >= -1 && ago <= mins;
  }

  // Last seen preview and time of each conversation row, to notice messages already read on the phone:
  // key -> { preview, time, tkey }. `tkey` is the last clock time the row showed: relative labels
  // ("1m", "2m") and dates only age, so they never change a signature by themselves.
  const rowSeen = new Map();

  async function scan() {
    requireMessages();
    if (blockedNow()) return { threads: [] };
    if (!q('conversation.list', document, QUIET)) return { threads: [] };
    await leaveRequests(); // someone left the requests view open

    const rows = visibleRows();
    const open = currentOpen(rows);
    const tail = open ? tailOf(open) : null;
    const threads = [];
    const now = Date.now();

    const firstScan = !rowSeen.size;
    let earlyPicks = 0;
    // One or two new rows is someone accepting a request. Many at once is the list being redrawn
    // (layout switch, scrolling): not accepted requests, so nothing is flagged.
    const newRows = firstScan ? 0 : rows.filter((r) => !rowSeen.has(r.key)).length;
    for (const row of rows) {
      // Unread went back to zero: the conversation was opened. Its next message starts a new signature.
      if ((lastUnread[row.key] || 0) > 0 && row.unread === 0) bump(row.key);
      lastUnread[row.key] = row.unread;
      const isOpen = Boolean(open && open.key === row.key);
      // Reading a message on the phone clears the badge everywhere, so a row whose preview changed, or
      // whose time label moved because of a new message ("3m" to "now", "20:14" to "20:31"), counts.
      // A label that only ages ("1m" to "2m") does not. The server works out what is unanswered.
      const prev = rowSeen.get(row.key);
      const tkey = ACX.stableTime(prev && prev.tkey, row.time);
      const moved = prev ? prev.preview !== row.preview || ACX.timeMoved(prev.time, row.time) : false;
      // A request the owner just accepted. TikTok labels these rows "Message request accepted"; that
      // label is trusted on its own, however many arrive at once. Without it, one or two rows that
      // were not in the list before also count. At startup only labels from the last 10 minutes count.
      const labelled = /message request accept/i.test(String(row.preview || ''));
      const unseen = !prev || moved;
      const accepted = labelled
        ? (firstScan ? withinMinutes(row.time, 10) : unseen)
        : !firstScan && newRows <= 2 && !prev;
      const changed = accepted || (prev ? moved : firstScan && withinMinutes(row.time, 10) && earlyPicks++ < 3);
      rowSeen.set(row.key, { preview: row.preview, time: row.time, tkey });
      if (changed && !row.unread && !isOpen) bump(row.key);
      // An open conversation gets no unread badge, so there the last bubble decides.
      if (!(row.unread > 0 || changed || (isOpen && tail.last_in))) continue;
      // The row only moved because of our own reply: nothing to read. For the open chat the last
      // bubble tells, for the others the preview (a text this page sent).
      if (!row.unread && !accepted && (isOpen ? !tail.last_in : endsWithOurs(row.preview))) continue;
      threads.push({
        key: row.key, title: row.nick, unread: row.unread, preview: row.preview, is_group: row.is_group, accepted,
        sig: isOpen ? `${stamp(row.key)}|o|${tail.sig}` : `${stamp(row.key)}|l|${row.unread}|${row.preview}|${tkey}`,
        ts_max: isOpen ? null : ACX.labelTimeMax(row.time, now),
      });
    }

    if (!oddIdsReported && rows.length >= 3 && rows.every((r) => r.convId && r.is_group)) {
      // Every conversation looks like a group: the id format changed and the agent would ignore everyone.
      oddIdsReported = true;
      ACX.diag('note', { where: 'tiktok.scan', note: 'no conversation id looks like a 1:1 chat', shape: rows[0].convId.replace(/\d/g, '9') });
    }

    // Message requests live behind their own row. Look inside only when that row changed.
    const entrySig = () => { const e = q('requests.entry', document, QUIET); return e ? squash(e.innerText || e.textContent) : null; };
    const sigNow = entrySig();
    if (sigNow === null) requestCache = { sig: null, at: 0, rows: [] };
    else if (requestCache.sig !== sigNow || Date.now() - requestCache.at > 10 * 60_000) {
      const found = await listRequests();
      if (found) requestCache = { sig: entrySig(), at: Date.now(), rows: found };
    }
    const withBadge = requestCache.rows.filter((r) => r.unread > 0);
    // Some layouts may not badge request rows at all: then the newest few are reported once each.
    const requests = requestCache.rows.some((r) => r.unread > 0) ? withBadge : requestCache.rows.slice(0, limit('request_rows_without_badges', 3));
    for (const row of requests) {
      if (open && open.key === row.key) continue; // handled below from the open chat
      threads.push({
        key: row.key, title: row.nick, unread: row.unread, preview: row.preview, is_group: row.is_group,
        sig: `${stamp(row.key)}|r|${row.unread}|${row.preview}|${ACX.stableTime('', row.time)}`,
      });
    }

    // The open conversation when its row is not on screen (a request chat, or scrolled away).
    if (open && open.key && tail.last_in && !threads.some((t) => t.key === open.key)) {
      threads.push({
        key: open.key, title: open.nick, unread: 0, preview: String(tail.preview || '').slice(0, 200),
        is_group: open.convId ? !isOneToOne(open.convId) : false, sig: `${stamp(open.key)}|o|${tail.sig}`,
      });
    }
    return { threads };
  }

  // ---- sweep ----------------------------------------------------------------------------------------------

  // Texts this page sent lately: a row whose preview is one of them ends with our own message.
  const sentTexts = [];
  const rememberSent = (text) => { sentTexts.push(squash(text)); if (sentTexts.length > 60) sentTexts.shift(); };
  function endsWithOurs(preview) {
    const p = squash(preview).replace(/(\.\.\.|\u2026)$/, '').trim();
    if (!p) return false;
    return sentTexts.some((t) => t === p || (p.length >= 12 && t.startsWith(p)));
  }

  /** True when a list time ("20:14", "now", "5m", "3h") is within the last day. */
  function recentTime(time) {
    const t = String(time || '').trim().toLowerCase();
    if (!t) return false;
    if (/^(now|just now)$/.test(t)) return true;
    if (/^\d{1,3}\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/.test(t)) return true;
    return /^\d{1,2}:\d{2}/.test(t) && withinMinutes(t, 24 * 60);
  }

  /**
   * Safety net, run every 10 minutes: the most recent 1:1 conversations that may end with a customer
   * message, badge or not. A list row does not say who wrote last, so the open chat is judged from its
   * last bubble and other rows from their preview (rows that show a text this page sent are left out).
   * The signature only moves with the preview, so each row is read at most once per new message.
   * Leaves the accepted request logic and the startup window of scan() alone.
   */
  async function sweep() {
    requireMessages();
    if (blockedNow()) return { threads: [] };
    if (!q('conversation.list', document, QUIET)) return { threads: [] };
    await leaveRequests();
    const rows = visibleRows();
    const open = currentOpen(rows);
    const tail = open ? tailOf(open) : null;
    const threads = [];
    for (const row of rows) {
      if (threads.length >= 8) break;
      if (row.is_group || row.request) continue;
      if (open && open.key === row.key) {
        // Same signature as scan() gives the open chat, so one already reported is not read again.
        if (tail && tail.last_in) threads.push({ key: row.key, title: row.nick, unread: row.unread, preview: row.preview, is_group: false, sig: `${stamp(row.key)}|o|${tail.sig}` });
        continue;
      }
      if (row.unread > 0) continue; // a badge is scan()'s job, every time
      if (!row.preview || endsWithOurs(row.preview)) continue;
      if (!recentTime(row.time)) continue; // older conversations are the owner's to deal with
      threads.push({ key: row.key, title: row.nick, unread: row.unread, preview: row.preview, is_group: false, sig: `sw|l|${row.preview}` });
    }
    return { threads };
  }

  // ---- read -----------------------------------------------------------------------------------------------

  /** Messages of the open chat once they are complete and consistent with the header. */
  async function stableMessages(needSome) {
    const end = Date.now() + 4000;
    for (;;) {
      await settle(needSome);
      const chat = chatInfo();
      const msgs = chat ? readMessages(chat) : null;
      if (msgs) {
        // Inbound bubbles must come from the person in the header; otherwise the previous
        // conversation's messages are still on screen.
        const me = ownHandle();
        const stale = chat.handle && msgs.some((m) => m.direction === 'in' && m.author && m.author !== chat.handle && m.author !== me);
        if (!stale && (!needSome || msgs.length)) return { chat, msgs };
      }
      if (Date.now() > end) return { chat, msgs };
      await sleep(300);
    }
  }

  async function read({ key }) {
    requireMessages();
    const ref = parseKey(key);
    try {
      await openConversation(ref);
      const { chat, msgs } = await stableMessages(true);
      if (!chat || !msgs || !msgs.length) {
        ACX.snapshot('tiktok.read.no_messages', chat ? chat.box : null);
        throw new Fail('thread_not_found', 'The TikTok conversation showed no messages', true);
      }
      const convId = ref.convId || (opened && opened.convId) || '';
      const is_group = convId ? !isOneToOne(convId) : false;
      const me = ownHandle();
      if (!is_group && chat.handle && msgs.some((m) => m.direction === 'in' && m.author && m.author !== chat.handle && m.author !== me)) {
        throw new Fail('thread_not_found', 'The messages on screen belong to another conversation', true);
      }
      // Our own bubbles that TikTok marked as failed never reached the customer: leave them out.
      const usable = msgs.filter((m) => !(m.failed && m.direction !== 'in'));
      if (usable.some((m) => !m.direction || m.conflict)) {
        // Never guess who said what: a wrong guess makes the agent answer itself.
        ACX.snapshot('tiktok.read.direction', chat.box);
        throw new Fail('unknown', 'Could not tell which TikTok messages are ours', true);
      }
      const external_id = convId || chat.handle;
      if (!external_id) throw new Fail('thread_not_found', 'TikTok shows no id for this conversation', false);
      const name = chat.nick || chat.handle;
      // Photos and video covers of the newest customer messages ride along. Never throws, at most about 5 s.
      const shown = usable.slice(-MAX_MESSAGES);
      for (const m of shown) m._media = m.kind === 'image' || m.kind === 'video' ? { el: m.el, kind: m.kind, shared: m.kind === 'video' && Boolean(q('media.shared_card', m.el, QUIET)) } : null;
      await ACX.captureMedia(shown);
      // A shared post is someone else's video: its cover goes with who posted it and its caption, never the clip.
      for (const m of shown) if (m.media && m._media && m._media.shared) m.media.shared = sharedPost(m.el);
      // A video the customer sent in the chat itself, when Google AI Studio is connected. At most about 8 s.
      const own = shown.map((m) => (m._media && m._media.shared ? { ...m, _media: null } : m));
      await ACX.captureVideo(own, dmVideo);
      own.forEach((m, i) => { if (m.media) shown[i].media = m.media; });
      const messages = shown.map((m) => ({ external_id: m.serverId || null, direction: m.direction, body: m.body, kind: m.kind, ts: null, ...(m.media ? { media: m.media } : {}) }));
      return {
        thread: { external_id, title: name, is_group, subject: null, contact: { name, phone: null, email: null, handle: chat.handle || null } },
        messages,
        tail: ACX.tailRef(messages), // send() refuses the reply if the customer wrote again since
      };
    } finally {
      await tidy();
    }
  }

  /** Who posted a shared video and its caption, as shown on the card. Customer content for the vision model. */
  function sharedPost(el) {
    const author = (val('media.shared_author', el) || '').replace(/^.*\/@/, '').replace(/[/?#].*$/, '').replace(/^@/, '').trim().slice(0, 60);
    const caption = squash(val('media.shared_caption', el) || '').slice(0, 300);
    return author || caption ? { author, caption } : null;
  }

  /** The file of a video sent in the chat: its https address for the service worker, or the bytes of a blob: one. */
  async function dmVideo(m) {
    const node = q('media.dm_video', m._media.el, QUIET);
    const src = node ? node.currentSrc || node.src || node.getAttribute('src') || '' : '';
    if (!src) return { why: 'no_src' };
    const video = node.tagName === 'VIDEO' ? node : node.closest('video');
    const seconds = video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    if (/^https:/i.test(src)) return { url: src, seconds };
    if (/^blob:/i.test(src)) {
      try {
        const res = await fetch(src, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return { blob: await res.blob(), seconds };
      } catch { /* a streamed player: frames only */ }
      return video ? { el: video, seconds } : { why: 'no_bytes' };
    }
    return { why: 'odd_src' };
  }

  // ---- send -----------------------------------------------------------------------------------------------

  const progress = new Map(); // job id -> { done, ids }: parts already confirmed, survives a second delivery

  /**
   * How many leading parts of the job already sit at the very end of the conversation. Only our
   * bubbles after the customer's last message count: the same reply text may legitimately have been
   * sent earlier in the chat.
   */
  function alreadySent(msgs, parts) {
    const run = [];
    for (let i = msgs.length - 1; i >= 0 && msgs[i].direction === 'out'; i--) if (!msgs[i].failed) run.unshift(msgs[i]);
    for (let k = Math.min(run.length, parts.length); k >= 1; k--) {
      const tail = run.slice(-k);
      if (tail.every((m, i) => m.kind === 'text' && same(m.body, parts[i]))) return { count: k, ids: tail.map((m) => m.serverId).filter(Boolean) };
    }
    return { count: 0, ids: [] };
  }

  /** The message box of the open chat, or a clear failure saying why there is none. */
  async function composerOf(chat) {
    const find = () => {
      const box = (chatInfo() || chat).box;
      if (q('requests.box', box, QUIET)) throw new Fail('blocked', 'Accept the message request in TikTok first', false);
      if (q('state.blocked_box', box, QUIET)) throw new Fail('blocked', 'This person is blocked on TikTok', false);
      if (q('state.peer_unavailable', box, QUIET)) throw new Fail('blocked', 'TikTok says this account cannot be messaged', false);
      const editor = q('composer.editor', box, QUIET);
      if (editor) return editor;
      const tip = q('state.request_pending', box, QUIET);
      // Live text (2026-11-17): "You can start chatting once this user has accepted your message request."
      const pending = ACX.lookup('text.request_pending') ? rx('text.request_pending') : /accept(s|ed) your message request|only send up to/i;
      if (tip && pending.test(textOf(tip))) throw new Fail('blocked', 'This person has not accepted your message request yet', false);
      return null;
    };
    let editor = find();
    for (let i = 0; !editor && i < 10; i++) { await sleep(400); editor = find(); }
    if (!editor) {
      q('composer.editor', (chatInfo() || chat).box); // counts as a selector miss
      ACX.snapshot('tiktok.send.no_composer', (chatInfo() || chat).box);
      throw new Fail('composer_missing', 'Could not find the TikTok message box', true);
    }
    return editor;
  }

  const sendButton = () => {
    const chat = chatInfo();
    const b = q('composer.send', chat ? chat.box : document, QUIET);
    return b && visible(b) ? b : null;
  };

  /** Paste one part, press Send, wait for the new bubble. Returns the message id or null. */
  async function sendPart(text, cps, scale = 1, holdMs = 0) {
    const chat = chatInfo();
    const editor = await composerOf(chat);
    const idOf = (m) => m.clientId || m.serverId;
    const before = readMessages(chat) || [];
    const beforeIds = new Set(before.map(idOf).filter(Boolean));
    const beforeNoId = before.filter((m) => m.direction === 'out' && !idOf(m) && same(m.body, text)).length;
    const editorText = () => squash(textOf(editor.isConnected ? editor : q('composer.editor', document, QUIET) || editor));

    await ACX.humanType(editor, text, cps, { scale }); // paste (pack typing.order); fails with composer_busy on a draft

    // The button only exists once TikTok's own state holds the text. No button: do not press Enter.
    const button = await waitFor(sendButton, { timeout: 2500, interval: 150 });
    if (!button || !same(editorText(), text)) {
      ACX.snapshot('tiktok.send.not_synced', q('chat.bottom', document, QUIET));
      // More than our text in the box: someone typed while we waited (the owner in the way). Anything
      // else is TikTok's editor not taking the text: a quick retry with a try used, never a 15 min wait.
      const typedMore = Boolean(button) && editorText().length > squash(text).length + 2;
      await ACX.clearComposer(editor);
      if (!button) throw new Fail('composer_missing', 'TikTok did not take the text (the Send button never appeared)', true);
      if (typedMore) throw new Fail('composer_busy', 'The TikTok message box changed while typing', true);
      throw new Fail('send_not_synced', 'TikTok did not take the text (the message box did not match it)', true);
    }
    await sleep(holdMs || rand(400, 1100)); // the human pace: the text sits in the box before Send

    /** The bubble this send produced, once TikTok has settled it. */
    const outcome = () => {
      const now = readMessages(chatInfo() || chat) || [];
      const mine = now.filter((m) => m.direction === 'out' && same(m.body, text));
      let fresh = mine.filter((m) => idOf(m) && !beforeIds.has(idOf(m))).pop();
      if (!fresh) {
        const noId = mine.filter((m) => !idOf(m));
        if (noId.length > beforeNoId) fresh = noId[noId.length - 1];
      }
      if (!fresh) return null;
      if (fresh.failed) return { state: 'failed', msg: fresh };
      if (fresh.pending) return null; // sdk front end: wait for the server id
      return { state: 'sent', id: fresh.serverId || null };
    };

    ACX.click(sendButton() || button);
    let res = await waitFor(() => outcome() || (editorText() ? null : 'emptied'), { timeout: 4000, interval: 300 });
    if (!res && same(editorText(), text)) {
      // The click did nothing. Draft.js sends on any Enter keydown (keydown only: keypress breaks it).
      const target = editor.isConnected ? editor : q('composer.editor', document, QUIET);
      if (target) target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
    }
    res = await waitFor(outcome, { timeout: 20_000, interval: 500 });

    if (res && res.state === 'sent') { rememberSent(text); return res.id; }

    if (res && res.state === 'failed') {
      const notice = q('message.notice', res.msg.el, QUIET);
      const why = squash(notice ? textOf(notice) : '');
      const b = blockedNow();
      ACX.snapshot('tiktok.send.failed_bubble', q('message.list', document, QUIET));
      if (b) throw new Fail('blocked', b.detail, false);
      if (rx('text.too_fast').test(why)) { startRest('TikTok says messages are being sent too fast'); throw new Fail('blocked', 'TikTok says messages are being sent too fast', false); }
      if (rx('text.privacy_blocked').test(why)) throw new Fail('blocked', 'This person only accepts messages from friends', false);
      if (rx('text.limit_reached').test(why)) throw new Fail('blocked', 'TikTok message limit reached for this person', false);
      if (rx('text.policy_violation').test(why)) throw new Fail('blocked', 'TikTok rejected the message (community guidelines)', false);
      throw new Fail('send_not_confirmed', 'TikTok marked the message as not delivered', false);
    }

    const b = blockedNow();
    if (same(editorText(), text)) {
      // Nothing left the message box, so nothing was sent. Do not leave our text behind as a draft.
      await ACX.clearComposer(editor.isConnected ? editor : q('composer.editor', document, QUIET) || editor);
      if (b) throw new Fail('blocked', b.detail, true);
      ACX.snapshot('tiktok.send.stuck', q('chat.bottom', document, QUIET));
      throw new Fail('send_not_confirmed', 'TikTok did not send the message', true);
    }
    // The box emptied but no finished bubble showed up: it may or may not have gone. Never resend blindly.
    ACX.snapshot('tiktok.send.unclear', q('message.list', document, QUIET));
    if (b) throw new Fail('blocked', b.detail, false);
    throw new Fail('send_not_confirmed', 'Could not confirm that TikTok sent the message', false);
  }

  async function send({ job, newer_than: newerThan, budget_ms: budgetMs }) {
    requireMessages();
    if (!job || job.kind !== 'reply') throw new Fail('unknown', 'TikTok can only reply inside an existing conversation', false);
    const parts = (Array.isArray(job.parts) ? job.parts : []).map((p) => String(p == null ? '' : p).trim()).filter(Boolean);
    if (!parts.length) throw new Fail('unknown', 'Nothing to send', false);
    if (parts.some((p) => p.length > limit('max_chars', 6000))) throw new Fail('unknown', 'The message is too long for TikTok', false);
    assertNotBlocked();

    const t = job.target || {};
    const threadId = String(t.thread_external_id || '');
    const ref = {
      request: null,
      convId: threadId.includes(':') ? threadId : '', // conversation ids contain ":", unique ids cannot
      handle: handleOf(t.handle || (threadId.includes(':') ? '' : threadId)),
      nick: squash(t.title),
    };
    if (!ref.convId && !ref.handle && !ref.nick) throw new Fail('thread_not_found', 'The job does not say which TikTok conversation', false);

    try {
      const { by } = await openConversation(ref);
      const { chat, msgs } = await stableMessages(false);
      if (!chat || !msgs) throw new Fail('thread_not_found', 'The TikTok conversation did not load', true);

      // Verify the peer. An id match is proof. Otherwise the unique id in the header must be the one
      // the server knows, and a name alone is only accepted when there is nothing better to compare.
      const peerOk = by === 'id' || (ref.handle && chat.handle ? ref.handle === chat.handle : !ref.handle && ref.nick && sameName(ref.nick, chat.nick));
      if (!peerOk) {
        ACX.snapshot('tiktok.send.wrong_peer', chat.box);
        throw new Fail('thread_not_found', 'TikTok opened a different conversation than the one to answer', false);
      }

      const editor = await composerOf(chat); // also where a message request fails with "blocked"

      // Idempotency: what this page already sent for the job, and what the conversation itself shows.
      const usable = msgs.filter((m) => !(m.failed && m.direction !== 'in'));
      if (usable.some((m) => !m.direction || m.conflict)) {
        ACX.snapshot('tiktok.send.direction', chat.box);
        throw new Fail('unknown', 'Could not tell which TikTok messages are ours', true);
      }
      const seen = alreadySent(usable, parts);
      const prog = progress.get(job.id) || { done: 0, ids: [] };
      if (seen.count > prog.done) { prog.done = seen.count; prog.ids = seen.ids; }
      if (prog.done >= parts.length) return { sent_external_ids: prog.ids.filter(Boolean) };

      // The customer wrote again after the read this reply was decided on: refuse it, nothing was sent.
      const shown = usable.slice(-MAX_MESSAGES).map((m) => ({ external_id: m.serverId || null, direction: m.direction, body: m.body, kind: m.kind }));
      if (prog.done === 0 && newerThan && ACX.newerInbound(shown, newerThan)) {
        throw new Fail('newer_message', 'The customer wrote again before this reply went out', false);
      }
      // The owner answered this person by hand after the read (from the phone, or in this tab).
      if (prog.done === 0 && newerThan && ACX.ownerReplied(shown, newerThan, parts, (m) => sentTexts.includes(squash(m.body)))) {
        throw new Fail('owner_replied', 'You already replied to this person yourself', false);
      }

      if (squash(textOf(editor))) throw new Fail('draft_in_chat', 'There is a half written message in the TikTok message box', true);

      // typing_cps 0: paste each part at once. A typing speed (older servers): the human pauses, kept
      // short when other customers are waiting. TikTok always gets at least 1.2 s between two parts.
      const rawCps = job.pacing ? job.pacing.typing_cps : undefined;
      const instant = ACX.instant(rawCps);
      const cps = ACX.cpsOf(rawCps);
      const nominal = parts.reduce((n, p) => n + Math.min(12_000, Math.max(700, (p.length / Math.max(3, cps)) * 1000)) * 0.6 + 3000, 0);
      const scale = instant ? 1 : ACX.pauseScale(budgetMs, nominal);
      let sentNow = 0;
      for (let i = prog.done; i < parts.length; i++) {
        // The human pace (0.6.4): gap_ms between two messages, and typing_ms with the text in the box before Send.
        const gapMs = Math.min(30_000, Math.max(0, Number(job.pacing && job.pacing.gap_ms) || 0));
        const typingMs = Math.min(30_000, Math.max(0, Number(job.pacing && job.pacing.typing_ms) || 0));
        if (sentNow) await sleep(gapMs ? Math.round(gapMs * rand(0.85, 1.1)) : instant ? rand(1200, 1600) : Math.max(1200, rand(2000, 4000) * scale)); // TikTok wants a gap between two messages
        assertNotBlocked();
        const id = await sendPart(parts[i], rawCps, scale, typingMs ? Math.round(typingMs * Math.min(1, Math.max(0.5, parts[i].length / 120)) * rand(0.85, 1)) : 0);
        ACX.noteSent(parts[i]);
        sentNow++;
        prog.done = i + 1;
        prog.ids.push(id);
        progress.set(job.id, prog);
        if (progress.size > 200) progress.delete(progress.keys().next().value);
        if (opened) bump(opened.key);
      }
      return { sent_external_ids: prog.ids.filter(Boolean) };
    } finally {
      await tidy();
    }
  }

  // ---- selftest ----------------------------------------------------------------------------------------------

  /** Number of elements for a pack key and which fallback matched (the audit from the research notes). */
  function census(key, root = document) {
    const entries = ACX.chain(key);
    for (let i = 0; i < entries.length; i++) {
      try {
        const n = root.querySelectorAll(entries[i].s).length;
        if (n) return { n, index: i };
      } catch { /* ignore */ }
    }
    return { n: 0, index: -1 };
  }

  async function selftest() {
    const checks = [];
    const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: String(detail) });
    if (!onMessages()) { add('On the TikTok messages page', false, location.pathname); return { checks }; }

    const ctx = appContext();
    const v = variant();
    const flags = ctx ? `flags sdk=${ctx.flags.sdk} vmok=${ctx.flags.vmok} drawer=${ctx.flags.drawer} region=${ctx.region}` : 'page data not readable';
    add('Layout', v === 'sdk' || v === 'legacy', `${v}; ${flags}`);
    add('Logged in account', Boolean(ctx && ctx.unique_id), ctx && ctx.unique_id ? `@${ctx.unique_id}` : 'unknown (direction falls back to layout only)');
    const b = blocker();
    add('No captcha or limit notice', !b, b ? b.detail : '');

    const audit = { variant: v, flags: ctx ? ctx.flags : null, region: ctx ? ctx.region : null, in_iframe: window !== window.top, keys: {} };
    const note = (key, root) => { const c = census(key, root); audit.keys[key] = c; return c; };

    const list = note('conversation.list');
    add('Conversation list', list.n > 0, list.n ? `selector ${list.index + 1}` : 'not found');
    const rows = inRequests() ? [] : visibleRows();
    const items = note('conversation.item');
    add('Conversations', items.n > 0, `${items.n} on screen, selector ${items.index + 1}`);
    const withId = rows.filter((r) => r.convId).length;
    add('Conversation ids', rows.length > 0 && withId === rows.length, `${withId} of ${rows.length} have an id, ${rows.filter((r) => r.convId && !r.is_group).length} look like 1:1 chats`);
    note('conversation.row'); note('conversation.unread'); note('requests.entry');

    const chat = chatInfo();
    if (!chat) {
      add('Open conversation', false, 'Open any conversation on the TikTok tab and run the check again');
    } else {
      add('Open conversation', true, chat.handle ? 'name and @id found' : 'name found, no @id');
      const msgs = readMessages(chat) || [];
      note('message.list'); note('message.item'); note('message.direction'); note('message.text'); note('message.server_id'); note('message.client_id_row', q('message.list', chat.box, QUIET) || chat.box);
      const told = msgs.filter((m) => m.direction && !m.conflict).length;
      add('Messages', msgs.length > 0, `${msgs.length} on screen`);
      add('Who said what', msgs.length > 0 && told === msgs.length, `${told} of ${msgs.length} clear`);
      add('Message ids', true, `${msgs.filter((m) => m.serverId).length} of ${msgs.length} (none is normal in the legacy layout)`);

      const box = chat.box;
      const editor = q('composer.editor', box, QUIET);
      note('composer.editor'); note('requests.box');
      if (q('requests.box', box, QUIET)) add('Message box', true, 'this chat is a message request waiting for Accept');
      else if (!editor) add('Message box', false, 'not found');
      else if (squash(textOf(editor))) add('Message box', true, 'holds a draft, typing test skipped');
      else {
        // Type, check TikTok took it (Send button appears), delete it again. Never sends.
        const probeText = 'acx check';
        let typed = false;
        let synced = false;
        let how = '';
        try {
          how = await ACX.insertText(editor, probeText);
          typed = true;
          synced = Boolean(await waitFor(sendButton, { timeout: 2500, interval: 150 }));
        } catch (err) { how = String((err && err.message) || err); }
        await ACX.clearComposer(editor);
        const cleared = Boolean(await waitFor(() => !squash(textOf(editor)) && !sendButton(), { timeout: 2500, interval: 150 }));
        add('Typing', typed, how);
        add('Send button appears after typing', synced, synced ? '' : 'TikTok did not take the text');
        add('Text cleared again', cleared, cleared ? '' : `Delete "${probeText}" from the TikTok message box by hand`);
      }
    }

    try { audit.e2e = Array.from(new Set(Array.from(document.querySelectorAll('[data-e2e]')).map((e) => e.getAttribute('data-e2e')))).sort().slice(0, 150); } catch { /* ignore */ }
    ACX.diag('note', { where: 'tiktok.selftest', audit }); // attribute names only, never message text
    return { checks };
  }

  // ---- start -----------------------------------------------------------------------------------------------

  const adapter = { probe, scan, sweep, read, send, selftest };

  let started = false;
  function start() {
    if (started || !onMessages()) return;
    started = true;
    ACX.register(adapter);
    // New messages change the conversation list (preview, badge) and the open chat.
    ACX.watch(() => (onMessages() ? q('conversation.list', document, QUIET) : null));
    ACX.watch(() => (onMessages() ? q('message.list', document, QUIET) : null));
    // Toasts are gone within seconds: catch a "too fast" notice the moment TikTok hangs it on <body>.
    try {
      let timer = null;
      new MutationObserver(() => {
        if (timer || !onMessages()) return;
        timer = setTimeout(() => { timer = null; try { if (blockedNow()) ACX.nudge(); } catch { /* ignore */ } }, 80);
      }).observe(document.body, { childList: true });
    } catch { /* no body yet */ }
  }
  start();
  // TikTok is a single page app: the owner may arrive on /messages without a page load.
  if (!started) {
    const poll = setInterval(() => { start(); if (started) clearInterval(poll); }, 2000);
  }
})();
