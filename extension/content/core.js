// Shared runtime for the site adapters (WhatsApp, Gmail, TikTok). Runs in the isolated world.
//
// An adapter is a plain object registered with ACX.register({ ... }):
//
//   probe()            -> { state, detail, unread }        state: ready | loading | logged_out | blocked | error
//   scan()             -> { threads: [{ key, title, unread, preview, is_group, sig }] }
//                         threads that have customer messages the agent may need to answer.
//                         `key` is whatever the adapter needs to open the thread again.
//                         `sig` changes whenever the thread gets a new message (used to wait for the
//                         customer to stop typing bursts before answering).
//   read({ key })      -> { thread: { external_id, title, is_group, subject, contact: { name, phone, email, handle } },
//                           messages: [{ external_id, direction: 'in'|'out', body, kind, ts, media? }] }   oldest first, max 40
//                         `media` is { kind: 'image' | 'video_frame', mime: 'image/jpeg', data: <base64> } when
//                         ACX.captureMedia could copy the photo (or one frame of the video) out of the bubble.
//                         For the newest customer video ACX.captureVideo may add `video` ({ token, bytes, mime,
//                         seconds } held in this page, or { url, mime }), `frames` (small JPEGs) and `seconds`.
//                         `shared` ({ author, caption }) marks a shared post (TikTok). The worker uploads
//                         `video` first and replaces it with `video_ref` (see sw.js attachVideo).
//   send({ job })      -> { sent_external_ids: [] }         types job.parts in order into job.target and sends them
//   prepare({ job })   -> { navigate: url } | { ready: true }   optional, for new_chat jobs that need a page load first
//   selftest()         -> { checks: [{ name, ok, detail }] }    optional
//   sweep()            -> { threads: [...] } like scan, optional: the most recent 1:1 chats whose last
//                         message is from the customer, whatever their unread badge says. Run every
//                         10 minutes as a safety net for messages the normal scan missed.
//
//   read() may also return `tail` (ACX.tailRef(messages)): the service worker hands it back to send()
//   as `newer_than`, and send() refuses with newer_message when the customer wrote again meanwhile.
//   send() args: { job, navigated, newer_than?, budget_ms? }. typing_cps 0 in job.pacing means no
//   typing pauses at all (each part goes in whole).
//
// Throw new ACX.Fail(code, message, retryable) for expected failures. Codes the server understands:
// thread_not_found, composer_missing, composer_busy (the box changed while typing), draft_in_chat (text that is not ours in this chat's box), owner_busy (the owner is using the tab), owner_replied (the owner answered by hand after the read), send_not_confirmed, not_on_whatsapp, invalid_number,
// logged_out, blocked, timeout, newer_message, unknown.
//
// Everything site specific (selectors, text patterns) comes from the selector pack: ACX.q('group.name').
(() => {
  if (globalThis.ACX) return;
  const host = location.hostname;
  const CHANNEL = host === 'web.whatsapp.com' ? 'whatsapp' : host === 'mail.google.com' ? 'gmail' : host.endsWith('tiktok.com') ? 'tiktok' : null;
  if (!CHANNEL) return;

  class Fail extends Error {
    constructor(code, message, retryable = true) {
      super(message || code);
      this.code = code;
      this.retryable = retryable;
    }
  }

  let alive = true; // false once the extension was reloaded and this script is orphaned

  // ---- talking to the service worker ---------------------------------------------------------
  function toWorker(msg) {
    if (!alive) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ acx: true, channel: CHANNEL, ...msg }, (res) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(res ?? null);
        });
      } catch {
        alive = false; // "Extension context invalidated"
        resolve(null);
      }
    });
  }

  // ---- time -------------------------------------------------------------------------------------
  const rand = (a, b) => a + Math.random() * (b - a);

  /**
   * Sleep that still works in a background tab. Chrome slows page timers in hidden tabs to once a
   * second and later once a minute, so longer waits are done by the service worker instead.
   */
  async function sleep(ms) {
    ms = Math.max(0, Math.round(ms));
    if (ms === 0) return;
    const local = new Promise((r) => setTimeout(r, ms));
    if (!document.hidden && ms < 1500) return local;
    const viaWorker = toWorker({ type: 'sleep', ms }).then((res) => (res ? true : local));
    // Safety net: if the worker went away the (possibly throttled) local timer still ends the wait.
    await Promise.race([viaWorker, new Promise((r) => setTimeout(r, ms + 90_000))]);
  }

  /** Poll `fn` until it returns something truthy. Wakes on DOM changes, so it is quick even when hidden. */
  function waitFor(fn, { timeout = 10_000, interval = 300, root = document.documentElement } = {}) {
    return new Promise((resolve) => {
      const started = Date.now();
      let done = false;
      let obs = null;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (obs) obs.disconnect();
        resolve(v);
      };
      const check = () => {
        if (done) return;
        let v = null;
        try { v = fn(); } catch { v = null; }
        if (v) finish(v);
        else if (Date.now() - started >= timeout) finish(null);
      };
      try {
        obs = new MutationObserver(check);
        obs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
      } catch { /* root gone */ }
      (async () => {
        while (!done) {
          check();
          if (done) break;
          await sleep(interval);
        }
      })();
    });
  }

  // ---- selector pack ------------------------------------------------------------------------------
  let pack = {};
  const hits = {}; // key -> index of the selector that matched last (-1 = nothing matched)
  const missAt = {};

  function setPack(all) {
    const mine = all && all.pack ? all.pack[CHANNEL] : null;
    if (mine && typeof mine === 'object') pack = mine;
  }

  async function loadPack() {
    try {
      const raw = await chrome.storage.local.get('selectors');
      if (raw.selectors) setPack(raw.selectors);
    } catch { /* storage unavailable */ }
    if (!Object.keys(pack).length) {
      const res = await toWorker({ type: 'get_selectors' });
      if (res && res.selectors) setPack(res.selectors);
    }
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.selectors && changes.selectors.newValue) setPack(changes.selectors.newValue);
    });
  } catch { /* ignore */ }

  function lookup(key) {
    let node = pack;
    for (const part of key.split('.')) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return node;
  }

  /** Ordered fallback entries for a pack key, each { s, attr, closest }. */
  function chain(key) {
    const v = lookup(key);
    if (v == null) return [];
    const list = Array.isArray(v) ? v : [v];
    return list
      .map((e) => (typeof e === 'string' ? { s: e } : e))
      .filter((e) => e && typeof e.s === 'string' && e.s);
  }

  function noteMiss(key) {
    hits[key] = -1;
    const now = Date.now();
    if (now - (missAt[key] || 0) < 10 * 60_000) return;
    missAt[key] = now;
    diag('selector_miss', { key, path: location.pathname, tried: chain(key).length });
  }

  /** First element matching the pack key, trying each fallback in order. `quiet` skips miss reports. */
  function q(key, root = document, { quiet = false } = {}) {
    const entries = chain(key);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      try {
        let el = root.querySelector(e.s);
        if (el && e.closest) el = el.closest(e.closest);
        if (el) { hits[key] = i; return el; }
      } catch { /* a bad selector in a hot update must not break the rest */ }
    }
    if (!quiet && entries.length) noteMiss(key);
    return null;
  }

  /** All elements for the first fallback that matches anything. */
  function qa(key, root = document) {
    const entries = chain(key);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      try {
        let els = Array.from(root.querySelectorAll(e.s));
        if (e.closest) els = els.map((el) => el.closest(e.closest)).filter(Boolean);
        if (els.length) { hits[key] = i; return els; }
      } catch { /* ignore */ }
    }
    return [];
  }

  /** Attribute (when the entry names one) or text of the first match. */
  function val(key, root = document) {
    const entries = chain(key);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      try {
        const el = root.querySelector(e.s);
        if (!el) continue;
        hits[key] = i;
        const v = e.attr ? el.getAttribute(e.attr) : textOf(el);
        if (v) return v;
      } catch { /* ignore */ }
    }
    return '';
  }

  const rxCache = new Map();
  /** Case-insensitive RegExp built from a text pattern (or list of patterns) in the pack. Never matches when absent. */
  function rx(key) {
    const src = lookup(key);
    const sig = JSON.stringify(src ?? null);
    const cached = rxCache.get(key);
    if (cached && cached.sig === sig) return cached.re;
    let re = /$^/;
    try {
      if (typeof src === 'string' && src) re = new RegExp(src, 'i');
      else if (Array.isArray(src) && src.length) re = new RegExp(src.map((p) => `(?:${p})`).join('|'), 'i');
    } catch { re = /$^/; }
    rxCache.set(key, { sig, re });
    return re;
  }

  // ---- DOM helpers ------------------------------------------------------------------------------------
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;

  /** Text as a person reads it. Emoji rendered as <img alt="..."> are included. */
  function textOf(el) {
    if (!el) return '';
    let out = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue;
      else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (tag === 'IMG') out += node.getAttribute('alt') || '';
        else if (tag === 'BR') out += '\n';
        else if (tag === 'SCRIPT' || tag === 'STYLE') return;
        else {
          const block = tag === 'DIV' || tag === 'P' || tag === 'LI';
          if (block && out && !out.endsWith('\n')) out += '\n';
          node.childNodes.forEach(walk);
          if (block && out && !out.endsWith('\n')) out += '\n';
        }
      }
    };
    walk(el);
    return out.replace(/\u200B|\uFEFF/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /** A full pointer + mouse click sequence at the element's centre. Many web apps ignore a bare click(). */
  function click(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mouseup', base));
      el.dispatchEvent(new MouseEvent('click', base));
      return true;
    } catch {
      try { el.click(); return true; } catch { return false; }
    }
  }

  function key(el, name, opts = {}) {
    const init = { key: name, code: opts.code || (name.length === 1 ? `Key${name.toUpperCase()}` : name), bubbles: true, cancelable: true, composed: true, ...opts };
    if (name === 'Enter') { init.keyCode = 13; init.which = 13; }
    for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, init));
  }

  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  // ---- typing -----------------------------------------------------------------------------------------
  function placeCaretAtEnd(el) {
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const strategies = {
    // What Lexical and Draft.js handle best: a paste event carrying plain text.
    paste(el, text) {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    // Classic rich text insertion. Line breaks go in as Shift+Enter style breaks.
    exec(el, text) {
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (i > 0) document.execCommand('insertLineBreak');
        if (line) document.execCommand('insertText', false, line);
      });
    },
    beforeinput(el, text) {
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true, composed: true }));
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true, composed: true }));
    },
  };

  /**
   * Put `text` into a contenteditable composer and confirm it arrived. Tries the pack's
   * `typing.order` (default paste, exec, beforeinput) and finally trusted input through the
   * service worker when the owner switched that on. Returns the name of the method that worked.
   */
  async function insertText(el, text, { append = false } = {}) {
    if (!el) throw new Fail('composer_missing', 'Could not find the message box');
    const want = squash(text);
    const before = squash(textOf(el));
    if (before && !append) throw new Fail('composer_busy', 'There is already text in the message box (someone is typing)');
    const expect = squash(`${before} ${want}`);
    const landed = () => {
      const now = squash(textOf(el));
      return now === expect || (now.length >= expect.length - 2 && now.includes(want));
    };
    const order = Array.isArray(lookup('typing.order')) ? lookup('typing.order') : ['paste', 'exec', 'beforeinput'];
    for (const name of order) {
      const fn = strategies[name];
      if (!fn) continue;
      try {
        placeCaretAtEnd(el);
        await sleep(70); // editors such as Lexical drop text inserted before they see the new selection
        fn(el, text);
      } catch { /* try the next one */ }
      if (await waitFor(landed, { timeout: 1800, interval: 150, root: el })) return name;
      // Half inserted text would be sent as garbage by the next attempt: clear what this try left.
      if (squash(textOf(el)) !== before) await clearComposer(el, before);
    }
    const res = await toWorker({ type: 'trusted_type', text });
    if (res && res.ok && (await waitFor(landed, { timeout: 2500, interval: 150, root: el }))) return 'trusted';
    diag('error', { where: 'insertText', note: 'no typing method worked', tried: order, trusted: !!(res && res.ok) });
    throw new Fail('composer_missing', 'Could not type into the message box');
  }

  /** Select everything inside an editor through the DOM Selection (editors ignore execCommand('selectAll')). */
  function selectAllIn(el) {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** Empty a composer the way a person would: select all, delete. `keep` is put back afterwards. */
  async function clearComposer(el, keep = '') {
    try {
      if (squash(textOf(el))) {
        selectAllIn(el);
        el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true, composed: true }));
        await sleep(80);
        if (squash(textOf(el))) { selectAllIn(el); document.execCommand('delete'); }
      }
      if (keep) { placeCaretAtEnd(el); document.execCommand('insertText', false, keep); }
    } catch { /* ignore */ }
    await sleep(120);
  }

  // ---- pacing of a send ----------------------------------------------------------------------------
  // The server sends typing_cps 0 for "as fast as possible": each part goes in whole, no pauses.
  // Older servers send a typing speed (11): then the old human pauses stay, shrunk to short floor
  // pauses when the service worker says other customers are waiting (`budget_ms`).

  /** True for typing_cps 0 or a speed nobody types at. A missing value is the old default (11), not instant. */
  const instant = (cps) => typeof cps === 'number' && Number.isFinite(cps) && (cps <= 0 || cps >= 200);
  /** The typing speed to use for the old human pacing: the job's, else 11. */
  const cpsOf = (cps) => (typeof cps === 'number' && Number.isFinite(cps) && cps > 0 ? cps : 11);
  /** Factor for the human pauses of one send: 1 normally, down to 0.15 when the budget is tight. */
  function pauseScale(budgetMs, nominalMs) {
    if (!(budgetMs > 0) || !(nominalMs > 0)) return 1;
    return Math.min(1, Math.max(0.15, budgetMs / nominalMs));
  }
  /** One human pause, scaled, never below the 0.3 s floor (so "typing..." still shows). */
  const humanPause = (ms, scale = 1) => sleep(Math.max(300, ms * scale));

  /**
   * Type like a person: a pause that scales with length (so the other side sees "typing..."),
   * then the text. `cps` is characters per second from the job's pacing; 0 puts the text in at once.
   */
  async function humanType(el, text, cps = 11, { scale = 1 } = {}) {
    el.focus();
    if (instant(cps)) return insertText(el, text);
    const total = Math.min(12_000, Math.max(700, (text.length / Math.max(3, cpsOf(cps))) * 1000));
    await humanPause(total * rand(0.25, 0.4), scale);
    const how = await insertText(el, text);
    await humanPause(total * rand(0.2, 0.35), scale);
    return how;
  }

  // ---- what the end of a thread looked like when it was read ------------------------------------------
  // A reply is decided on the messages a read saw. If the customer writes again before it is sent,
  // the reply is out of date: send() refuses it (newer_message) and the worker reads the chat again,
  // so one fresh decision covers everything.
  const normBody = (s) => squash(s).toLowerCase().slice(0, 200);
  const usableMsgs = (messages) => (Array.isArray(messages) ? messages : []).filter((m) => m && (m.direction === 'in' || m.direction === 'out'));

  /**
   * { last_in_id, last_in_body, same, outs_after }: the last customer message, how many with the same
   * words, and how many of our messages (the agent's or the owner's) came after it when the chat was read.
   */
  function tailRef(messages) {
    const list = usableMsgs(messages);
    let at = -1;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].direction === 'in') { at = i; break; }
    if (at < 0) return { last_in_id: null, last_in_body: null, same: 0, outs_after: 0 };
    const body = normBody(list[at].body);
    return {
      last_in_id: list[at].external_id ? String(list[at].external_id) : null,
      last_in_body: body,
      same: list.filter((m) => m.direction === 'in' && normBody(m.body) === body).length,
      outs_after: list.length - 1 - at,
    };
  }

  /** Where the message `ref` describes is in `list` (by id, else by its words), or -1. */
  function tailIndex(list, ref) {
    if (!ref || (ref.last_in_id == null && ref.last_in_body == null)) return -1;
    if (ref.last_in_id) {
      for (let i = list.length - 1; i >= 0; i--) if (String(list[i].external_id || '') === ref.last_in_id) return i;
    }
    if (ref.last_in_body == null) return -1;
    let at = -1;
    list.forEach((m, i) => { if (m.direction === 'in' && normBody(m.body) === ref.last_in_body) at = i; });
    return at;
  }

  // What this page sent for the agent lately (words, when), so the owner's own messages can be told apart.
  const ownSent = new Map();
  /** Call after each part the agent sent. */
  function noteSent(text) {
    const now = Date.now();
    ownSent.set(normBody(text), now);
    for (const [k, at] of ownSent) if (now - at > 2 * 3600_000) ownSent.delete(k);
  }

  /**
   * True when the owner answered the customer by hand after the read `ref` describes: an outgoing
   * message came after the read that is not one of `parts` (this job) and not something the agent sent
   * from this page (`ownIds`, `noteSent`). Needs a reference from a newer build (outs_after). When the
   * reference cannot be found the answer is false: nothing is refused on a guess.
   */
  function ownerReplied(messages, ref, parts = [], isOurs = null) {
    if (!ref || typeof ref.outs_after !== 'number') return false;
    const list = usableMsgs(messages);
    const at = tailIndex(list, ref);
    if (at < 0) return false;
    const mine = [...(Array.isArray(parts) ? parts : []).map(normBody), ...ownSent.keys()].filter(Boolean);
    // An email shows our text with a signature after it: our words at the start count as ours.
    const ours = (body) => mine.some((x) => body === x || (x.length >= 8 && body.startsWith(x)));
    const outs = list.slice(at + 1).filter((m) => m.direction === 'out');
    // The first `outs_after` were there when the chat was read; the rest came after it.
    return outs.slice(ref.outs_after).some((m) => !ours(normBody(m.body)) && !(isOurs && isOurs(m)));
  }

  /**
   * True when `messages` (collected right before sending) hold a customer message newer than the one
   * `ref` describes. Found by message id, else by its words (a repeat of the same words counts as new).
   * When the reference cannot be found at all the answer is false: nothing is refused on a guess.
   */
  function newerInbound(messages, ref) {
    if (!ref || (ref.last_in_id == null && ref.last_in_body == null)) return false;
    const list = usableMsgs(messages);
    let at = -1;
    if (ref.last_in_id) {
      for (let i = list.length - 1; i >= 0; i--) if (String(list[i].external_id || '') === ref.last_in_id) { at = i; break; }
    }
    if (at < 0) {
      if (ref.last_in_body == null) return false;
      const hits = [];
      list.forEach((m, i) => { if (m.direction === 'in' && normBody(m.body) === ref.last_in_body) hits.push(i); });
      if (!hits.length) return false;
      if (hits.length > Math.max(1, ref.same || 1)) return true; // the same words came again
      at = hits[hits.length - 1];
    }
    return list.slice(at + 1).some((m) => m.direction === 'in');
  }

  // ---- time labels in chat lists ("20:14", "Yesterday", "5m", "just now") -----------------------------------
  const CLOCK = /^(\d{1,2})[:.](\d{2})(?:\s*([ap])\.?\s*m\.?)?$/i;
  const RELATIVE = /^(\d{1,3})\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks)\b(?:\s*ago)?$/i;
  const UNIT = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000, w: 7 * 86_400_000 };

  /** True for a clock time label: the list shows those for today's messages. */
  const isClock = (label) => CLOCK.test(String(label || '').trim());

  /** Age a relative label says ("5m" = 5 minutes, "just now" = 0), else null. */
  function labelAge(label) {
    const t = String(label || '').trim().toLowerCase();
    if (/^(now|just now)$/.test(t)) return 0;
    const m = RELATIVE.exec(t);
    if (!m) return null;
    const unit = m[2].startsWith('mi') || m[2] === 'm' ? 'm' : m[2][0];
    return Number(m[1]) * (UNIT[unit] || 0);
  }

  /**
   * The latest time (ms) the last message of a list row can have been written, from its label, or
   * null when the label does not say. A clock label has minute steps, so a minute is added.
   */
  function labelTimeMax(label, now = Date.now()) {
    const t = String(label || '').trim();
    const age = labelAge(t);
    if (age !== null) return age > 0 ? now - age : null;
    const m = CLOCK.exec(t);
    if (!m) return null;
    let hour = Number(m[1]);
    if (m[3]) hour = (hour % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
    const d = new Date(now);
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, Number(m[2])).getTime() + 60_000;
    return at <= now + 60_000 ? Math.min(at, now) : null; // a clock time later than now is yesterday's
  }

  /**
   * Did a row's time label move because of a new message? A clock label that changed, or a relative
   * age that went down ("3m" to "now"), or a relative label replacing a clock or date. Labels only
   * ageing ("1m" to "2m", "23:50" to "Yesterday") are not new messages.
   */
  function timeMoved(prev, cur) {
    const a = String(prev || '').trim();
    const b = String(cur || '').trim();
    if (!b || a === b) return false;
    const ageB = labelAge(b);
    if (ageB !== null) {
      const ageA = labelAge(a);
      return ageA === null ? true : ageB < ageA; // a fresh relative label after a clock or date is new
    }
    if (isClock(b)) return labelAge(a) === null; // clock to another clock, or a date to today's clock
    return false;
  }

  /** A time key for a row signature that never churns while the label only ages. */
  const stableTime = (prevKey, label) => (isClock(label) ? String(label).trim() : prevKey || (label ? 'd' : ''));

  // ---- photos and video frames ------------------------------------------------------------------------------
  // The newest customer messages of a thread may hold a photo or a video. captureMedia copies each one
  // into a small JPEG so the server can show it to the brain and to the owner. For a video it takes one
  // frame: the poster or preview picture in the bubble, or the frame the player shows right now.
  // It never throws and never takes longer than the budget: a photo that cannot be copied is reported
  // without data, exactly as before, and a note goes to diagnostics.
  const MEDIA = { max_items: 3, budget_ms: 5000, max_base64: 250_000, default_min_side: 48, max_fetch_bytes: 15_000_000 };
  // Longest side and JPEG quality, tried in order until the result fits max_base64.
  const MEDIA_STEPS = [[1024, 0.7], [896, 0.6], [768, 0.5], [640, 0.45], [512, 0.4], [384, 0.35]];

  /** Draw a picture source (img, video, ImageBitmap) into a JPEG no bigger than the cap. Throws SecurityError when the source taints the canvas. */
  function encodeJpeg(source, w, h) {
    if (!w || !h) return null;
    for (const [side, quality] of MEDIA_STEPS) {
      const scale = Math.min(1, side / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#fff'; // JPEG has no transparency
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', quality);
      const data = url.slice(url.indexOf(',') + 1);
      if (url.startsWith('data:image/jpeg') && data.length > 100 && data.length <= MEDIA.max_base64) return data;
    }
    return null;
  }

  /** Every element under `root` (and `root` itself) that matches any selector of a pack key, in pack order. */
  function mediaMatches(key, root) {
    const out = [];
    for (const e of chain(key)) {
      try {
        if (root.matches && root.matches(e.s)) out.push({ el: root, attr: e.attr });
        for (const el of root.querySelectorAll(e.s)) out.push({ el, attr: e.attr });
      } catch { /* bad selector */ }
    }
    return out;
  }

  const mediaSkipped = (el) => chain('media.skip').some((e) => { try { return !!el.closest(e.s); } catch { return false; } });

  function bigEnough(el) {
    const min = Number(lookup('media.min_side')) || MEDIA.default_min_side;
    const r = el.getBoundingClientRect();
    const w = Math.max(r.width, el.naturalWidth || el.videoWidth || 0);
    const h = Math.max(r.height, el.naturalHeight || el.videoHeight || 0);
    return w >= min && h >= min;
  }

  const area = (el) => { const r = el.getBoundingClientRect(); return Math.max(r.width * r.height, (el.naturalWidth || 0) * (el.naturalHeight || 0)); };

  /** Gmail style "image/jpeg:name.jpg:https://..." attribute, a CSS url("...") or a plain address -> absolute URL or ''. */
  function mediaUrl(raw) {
    let v = String(raw || '').trim();
    const dl = /^[\w.+-]+\/[\w.+-]+:[^:]*:(https?:.+)$/.exec(v);
    if (dl) v = dl[1];
    const css = /url\((['"]?)(.*?)\1\)/.exec(v);
    if (css) v = css[2];
    if (!v || v === 'none') return '';
    try { return new URL(v, location.href).href; } catch { return ''; }
  }

  /** What to copy for one bubble: { el } to draw, and or { url } to fetch. null when the bubble shows no picture. */
  function pickMedia(root, kind) {
    const usable = (m) => m.el.isConnected && !mediaSkipped(m.el);
    if (kind === 'video') {
      const video = mediaMatches('media.video', root).filter(usable).map((m) => m.el).find((el) => el.tagName === 'VIDEO');
      if (video) {
        const poster = mediaUrl(video.getAttribute('poster'));
        if (video.readyState >= 2 && video.videoWidth) return { el: video, url: poster };
        if (poster) return { url: poster };
      }
    }
    // An address in an attribute (Gmail attachment cards: the full picture, not the small card).
    const byAttr = () => {
      for (const m of mediaMatches('media.url', root).filter(usable)) {
        const url = mediaUrl(m.attr ? m.el.getAttribute(m.attr) : '');
        if (url) return { url };
      }
      return null;
    };
    if (lookup('media.prefer_url')) { const hit = byAttr(); if (hit) return hit; }
    const keys = kind === 'video' ? ['media.poster', 'media.image'] : ['media.image'];
    for (const key of keys) {
      const imgs = mediaMatches(key, root).filter((m) => usable(m) && m.el.tagName === 'IMG' && bigEnough(m.el)).map((m) => m.el);
      if (imgs.length) {
        const el = imgs.sort((a, b) => area(b) - area(a))[0];
        return { el, url: mediaUrl(el.currentSrc || el.getAttribute('src')) };
      }
    }
    const hit = byAttr();
    if (hit) return hit;
    // A background picture (video covers).
    for (const m of mediaMatches('media.background', root).filter(usable)) {
      let bg = '';
      try { bg = getComputedStyle(m.el).backgroundImage; } catch { /* ignore */ }
      const url = mediaUrl(bg);
      if (url && bigEnough(m.el)) return { url };
    }
    return null;
  }

  /** True when the bubble shows a photo or video this script could try to copy. */
  const hasMedia = (root, kind = 'image') => { try { return !!pickMedia(root, kind); } catch { return false; } };

  const errName = (err) => String((err && (err.name || err.message)) || err || 'error').slice(0, 40);

  /** One bubble -> { data, via } or { fail }. Order: draw the element, fetch its address here, ask the worker to fetch it. */
  async function captureOne(root, kind, deadline) {
    const left = () => deadline - Date.now();
    const target = pickMedia(root, kind);
    if (!target) return { fail: 'no_element' };
    const tried = [];
    const el = target.el;
    if (el) {
      if (el.tagName === 'IMG' && !el.complete) await waitFor(() => el.complete, { timeout: Math.min(1500, Math.max(0, left())), interval: 150 });
      try {
        const data = el.tagName === 'VIDEO' ? encodeJpeg(el, el.videoWidth, el.videoHeight) : encodeJpeg(el, el.naturalWidth, el.naturalHeight);
        if (data) return { data, via: 'canvas' };
        tried.push('canvas:empty');
      } catch (err) { tried.push(`canvas:${errName(err)}`); } // SecurityError: a cross origin picture taints the canvas
    }
    const url = target.url;
    if (!url || left() < 200) return { fail: [...tried, url ? 'timeout' : 'no_url'].join(' ') };
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(200, left())) });
      if (!res.ok) throw new Error(`http_${res.status}`);
      const blob = await res.blob();
      if (blob.size > MEDIA.max_fetch_bytes) throw new Error('too_big');
      const bmp = await createImageBitmap(blob);
      try {
        const data = encodeJpeg(bmp, bmp.width, bmp.height);
        if (data) return { data, via: 'fetch' };
        tried.push('fetch:empty');
      } finally { try { bmp.close(); } catch { /* ignore */ } }
    } catch (err) { tried.push(`fetch:${errName(err)}`); } // usually CORS on a CDN address
    if (/^https:/i.test(url) && left() > 300) {
      const res = await toWorker({ type: 'fetch_media', url, timeout_ms: Math.max(300, left() - 100) });
      if (res && res.ok && typeof res.data === 'string' && res.data.length <= MEDIA.max_base64) return { data: res.data, via: 'worker' };
      tried.push(`worker:${String((res && res.error) || 'no_answer').slice(0, 40)}`);
    }
    return { fail: tried.join(' ') };
  }

  /**
   * `messages` is the thread, oldest first. A message that shows a photo or video carries
   * `_media: { el: <its bubble>, kind: 'image' | 'video' }`. The newest unanswered customer messages
   * (after our last message), at most 3, newest first, get `media` set when the copy worked.
   * Voice notes are never captured. Resolves with the number captured. Never rejects.
   */
  async function captureMedia(messages) {
    const started = Date.now();
    const failures = [];
    let captured = 0;
    try {
      const picks = [];
      for (let i = messages.length - 1; i >= 0 && picks.length < MEDIA.max_items; i--) {
        const m = messages[i];
        if (!m || m.direction !== 'in') break;
        if (m._media && m._media.el) picks.push(m);
      }
      if (!picks.length) return 0;
      const deadline = started + MEDIA.budget_ms;
      let open = true;
      const work = (async () => {
        for (const m of picks) {
          if (Date.now() >= deadline - 200) { failures.push('timeout'); break; }
          let res;
          try { res = await captureOne(m._media.el, m._media.kind === 'video' ? 'video' : 'image', deadline); } catch (err) { res = { fail: `error:${errName(err)}` }; }
          if (!open) return; // the read moved on without this one
          if (res.data) { m.media = { kind: m._media.kind === 'video' ? 'video_frame' : 'image', mime: 'image/jpeg', data: res.data }; captured++; } else failures.push(res.fail || 'unknown');
        }
      })();
      const late = Symbol('late');
      if ((await Promise.race([work, sleep(MEDIA.budget_ms + 150).then(() => late)])) === late) failures.push('timeout');
      open = false;
    } catch (err) { failures.push(`error:${errName(err)}`); }
    if (failures.length) diag('note', { media_capture: failures.slice(0, 3), captured, ms: Date.now() - started, path: location.pathname.slice(0, 60) });
    return captured;
  }


  // ---- whole videos, for the vision model ----------------------------------------------------------------------
  // When Google AI Studio is connected (config.vision from the server), the newest unanswered customer video
  // of a read can go to the server whole: the adapter finds the file, this part checks the caps (20 MB,
  // about 2 minutes), keeps the bytes in this page until the service worker pulls them (op video_chunk),
  // and samples a few small frames as the fallback. A video too big or too long, or one whose bytes cannot
  // be had, gets the frames (or only its cover, as before). Never throws, never runs past its time limit.
  const VIDEO = { max_bytes: 20 * 1024 * 1024, max_seconds: 130, budget_ms: 15_000, frames: 4, frame_max_base64: 80_000, keep_ms: 5 * 60_000, chunk_max: 2 * 1024 * 1024 };
  const FRAME_STEPS = [[512, 0.55], [448, 0.5], [384, 0.45], [320, 0.4]];
  const heldVideos = new Map(); // token -> { blob, at }
  const capturedVideos = new Map(); // message id -> { at, video, frames, seconds } of a video already captured

  /** Keep a video's bytes in this page for a few minutes and return the token the worker asks for. */
  function holdVideo(blob) {
    const now = Date.now();
    for (const [k, v] of heldVideos) if (now - v.at > VIDEO.keep_ms) heldVideos.delete(k);
    while (heldVideos.size >= 3) heldVideos.delete(heldVideos.keys().next().value);
    const token = `v${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    heldVideos.set(token, { blob, at: now });
    return token;
  }

  const blobBase64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = () => reject(r.error || new Error('read_failed'));
    r.readAsDataURL(blob);
  });

  /** One piece of a held video for the worker: { data (base64), offset, total, done, mime }. */
  async function videoChunk({ token, offset = 0, size = 1024 * 1024 } = {}) {
    const held = heldVideos.get(String(token || ''));
    if (!held) throw new Fail('unknown', 'That video is no longer here', false);
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const end = Math.min(held.blob.size, start + Math.min(VIDEO.chunk_max, Math.max(64 * 1024, Math.floor(Number(size) || 0))));
    const data = await blobBase64(held.blob.slice(start, end));
    const done = end >= held.blob.size;
    if (done) heldVideos.delete(String(token)); // pulled once: free the memory
    return { data, offset: start, total: held.blob.size, done, mime: held.blob.type || '' };
  }

  /** A small JPEG of the frame a video element shows now, or null (nothing decoded, or a cross origin video). */
  function frameJpeg(video) {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h || video.readyState < 2) return null;
    try {
      for (const [side, quality] of FRAME_STEPS) {
        const scale = Math.min(1, side / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/jpeg', quality);
        const data = url.slice(url.indexOf(',') + 1);
        if (url.startsWith('data:image/jpeg') && data.length > 100 && data.length <= VIDEO.frame_max_base64) return data;
      }
    } catch { /* a tainted canvas: frames of this video cannot be read here */ }
    return null;
  }

  /** Resolve with the first of `events` the element fires, or 'timeout'. */
  function once(el, events, ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; clearTimeout(t); for (const e of events) el.removeEventListener(e, on); resolve(v); };
      const on = (e) => finish(e.type);
      for (const e of events) el.addEventListener(e, on);
      const t = setTimeout(() => finish('timeout'), Math.max(0, ms));
    });
  }

  /**
   * Up to `n` frames spread over the clip. Seeks when the length is known; a recording with no index
   * (no length yet) is played muted and fast instead and a frame is taken now and then.
   */
  async function sampleFrames(video, n, deadline) {
    const frames = [];
    const left = () => deadline - Date.now();
    try {
      video.muted = true;
      if (video.readyState < 1) await once(video, ['loadedmetadata', 'error'], Math.min(3000, left()));
      const dur = video.duration;
      if (Number.isFinite(dur) && dur > 0) {
        for (let i = 0; i < n && left() > 300; i++) {
          const at = dur * (0.1 + (0.8 * i) / Math.max(1, n - 1));
          try { video.currentTime = Math.max(0, Math.min(dur - 0.05, at)); } catch { break; }
          await once(video, ['seeked', 'error'], Math.min(1500, left()));
          if (video.readyState < 2) await once(video, ['loadeddata', 'canplay'], Math.min(800, left()));
          const f = frameJpeg(video);
          if (f) frames.push(f);
        }
      } else if (left() > 600) {
        video.playbackRate = 2;
        try { await Promise.race([video.play(), new Promise((r) => setTimeout(r, 800))]); } catch { /* cannot play here */ }
        let last = -1;
        while (frames.length < n && left() > 300 && !video.ended && !video.error) {
          await new Promise((r) => setTimeout(r, 150));
          if (last < 0 || video.currentTime - last >= 0.25) {
            const f = frameJpeg(video);
            if (f) { frames.push(f); last = video.currentTime; }
          }
        }
        try { video.pause(); } catch { /* ignore */ }
      }
    } catch { /* frames are a bonus */ }
    return frames;
  }

  const withLimit = (p, ms) => Promise.race([Promise.resolve(p).catch(() => null), new Promise((r) => setTimeout(() => r(null), Math.max(0, ms)))]);

  /**
   * What to send for one video, from what the adapter found:
   *   { blob, seconds?, mime? }        the file itself (kept here until the worker pulls it)
   *   { url, mime?, seconds?, el? }    an https address the worker may fetch (Gmail, TikTok CDN)
   *   { el, seconds? }                 a video element that plays here: frames only
   * Resolves to { video?, frames?, seconds?, fail? }.
   */
  async function videoPayload(found, deadline) {
    const out = {};
    const left = () => deadline - Date.now();
    let seconds = Number.isFinite(found.seconds) && found.seconds > 0 ? found.seconds : null;
    if (found.blob) {
      const blob = found.blob;
      let el = null;
      let url = '';
      try { url = URL.createObjectURL(blob); el = document.createElement('video'); el.muted = true; el.preload = 'auto'; el.src = url; } catch { el = null; }
      if (el && seconds === null) {
        await once(el, ['loadedmetadata', 'error'], Math.min(2000, left()));
        if (Number.isFinite(el.duration) && el.duration > 0) seconds = el.duration;
      }
      if (blob.size > VIDEO.max_bytes) out.fail = 'too_big';
      else if (seconds !== null && seconds > VIDEO.max_seconds) out.fail = 'too_long';
      else out.video = { token: holdVideo(blob), bytes: blob.size, mime: (blob.type || found.mime || 'video/mp4').split(';')[0], seconds };
      if (el && left() > 800) out.frames = await sampleFrames(el, VIDEO.frames, deadline);
      try { el && el.removeAttribute('src'); el && el.load(); } catch { /* ignore */ }
      if (url) URL.revokeObjectURL(url);
    } else if (found.url) {
      out.video = { url: found.url, mime: found.mime || '', seconds };
      // Frames from a copy of the player (a CDN video without CORS taints the canvas: then there are none).
      if (left() > 1200) {
        try {
          const el = document.createElement('video');
          el.muted = true; el.preload = 'auto'; el.crossOrigin = 'anonymous'; el.src = found.url;
          out.frames = await sampleFrames(el, VIDEO.frames, deadline);
          el.removeAttribute('src'); el.load();
        } catch { /* no frames */ }
      }
    } else if (found.el) {
      if (seconds === null && Number.isFinite(found.el.duration) && found.el.duration > 0) seconds = found.el.duration;
      out.fail = 'no_bytes';
      out.frames = await sampleFrames(found.el, VIDEO.frames, deadline);
    }
    if (out.frames && !out.frames.length) delete out.frames;
    if (seconds !== null) out.seconds = Math.round(seconds * 10) / 10;
    return out;
  }

  let visionCache = { at: 0, v: null };
  /** What the server said about Google AI Studio on the last sync: { active, whole_videos }. */
  async function visionConfig() {
    if (Date.now() - visionCache.at < 10_000) return visionCache.v;
    let v = null;
    try { v = (await chrome.storage.local.get('config')).config?.vision || null; } catch { v = null; }
    visionCache = { at: Date.now(), v };
    return v;
  }

  /**
   * For the newest unanswered customer video of a read (one per read): ask the adapter for the file
   * (`find(m, deadline)` resolves to what videoPayload takes, optionally with `done()` to tidy up, or
   * null) and add the result to that message's media: media.video, media.frames, media.seconds. A video
   * whose cover could not be copied gets its first frame as the cover. Only when the vision model is
   * connected. Never throws; about VIDEO.budget_ms at most.
   */
  async function captureVideo(messages, find) {
    const started = Date.now();
    const fails = [];
    let pick = null;
    try {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m || m.direction !== 'in') break;
        if (m._media && m._media.kind === 'video') { pick = m; break; }
      }
      if (!pick) return false;
      const vision = await visionConfig();
      if (!vision || !vision.active) return false;
      // Read again before it was answered (a retry): the same video is not opened twice. The worker
      // remembers the upload by message id, so a token already pulled does not matter.
      const id = pick.external_id ? String(pick.external_id) : '';
      for (const [k, v] of capturedVideos) if (Date.now() - v.at > VIDEO.keep_ms * 2) capturedVideos.delete(k);
      const again = id ? capturedVideos.get(id) : null;
      if (again) {
        if (!pick.media && again.frames && again.frames.length) pick.media = { kind: 'video_frame', mime: 'image/jpeg', data: again.frames[0] };
        if (pick.media) Object.assign(pick.media, again.video && vision.whole_videos !== false ? { video: again.video } : {}, again.frames ? { frames: again.frames } : {}, again.seconds ? { seconds: again.seconds } : {});
        return Boolean(pick.media);
      }
      const deadline = started + VIDEO.budget_ms;
      let found = null;
      try { found = await withLimit(find(pick, deadline), deadline - Date.now() + 500); } catch (err) { fails.push(`find:${errName(err)}`); }
      try {
        if (!found || (!found.blob && !found.url && !found.el)) fails.push(found && found.why ? found.why : 'no_file');
        else {
          const p = (await withLimit(videoPayload(found, deadline), deadline - Date.now() + 1500)) || { fail: 'timeout' };
          if (p.fail) fails.push(p.fail);
          if (!pick.media && p.frames && p.frames.length) pick.media = { kind: 'video_frame', mime: 'image/jpeg', data: p.frames[0] };
          if (pick.media) {
            if (p.video && vision.whole_videos !== false) pick.media.video = p.video;
            if (p.frames && p.frames.length) pick.media.frames = p.frames.slice(0, VIDEO.frames);
            if (p.seconds) pick.media.seconds = p.seconds;
          } else if (p.video) fails.push('no_cover');
          if (id && (p.video || (p.frames && p.frames.length))) capturedVideos.set(id, { at: Date.now(), video: p.video || null, frames: p.frames ? p.frames.slice(0, VIDEO.frames) : null, seconds: p.seconds || null });
        }
      } finally {
        // Close what the adapter opened (a media viewer), whatever happened.
        if (found && typeof found.done === 'function') { try { await withLimit(found.done(), 3000); } catch { /* ignore */ } }
      }
    } catch (err) { fails.push(`error:${errName(err)}`); }
    if (fails.length) diag('note', { video_capture: fails.slice(0, 4), ms: Date.now() - started, path: location.pathname.slice(0, 60) });
    return Boolean(pick && pick.media && (pick.media.video || pick.media.frames));
  }

  // ---- diagnostics ---------------------------------------------------------------------------------------
  let diagCount = 0;
  let diagWindow = Date.now();
  function diag(kind, data) {
    const now = Date.now();
    if (now - diagWindow > 10 * 60_000) { diagWindow = now; diagCount = 0; }
    if (++diagCount > 12) return; // never flood the server
    toWorker({ type: 'diag', kind, data });
  }

  const KEEP_ATTRS = ['data-testid', 'data-e2e', 'role', 'data-tab', 'data-icon', 'aria-selected', 'aria-modal', 'contenteditable', 'data-lexical-editor', 'type', 'name', 'gh', 'act', 'g_editable', 'data-legacy-thread-id', 'data-legacy-message-id'];
  /**
   * Shape of the page without its content: tags and stable attributes only, never message text.
   * Sent with a failure so selectors can be repaired remotely.
   */
  function skeleton(root = document.body, { depth = 7, max = 350 } = {}) {
    let count = 0;
    const walk = (el, d) => {
      if (!el || count >= max || d > depth) return null;
      count++;
      const node = { t: el.tagName.toLowerCase() };
      const a = {};
      for (const name of KEEP_ATTRS) {
        const v = el.getAttribute && el.getAttribute(name);
        if (v != null && v !== '') a[name] = String(v).slice(0, 60);
      }
      if (el.id && !/^:|\d{3,}/.test(el.id)) a.id = el.id.slice(0, 40);
      if (el.hasAttribute && el.hasAttribute('aria-label')) a['aria-label-len'] = String(el.getAttribute('aria-label').length);
      const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter((c) => /^[a-z][a-z0-9-]{1,}$/i.test(c)).slice(0, 3) : [];
      if (cls.length) a.class = cls.join(' ');
      if (Object.keys(a).length) node.a = a;
      const kids = [];
      for (const child of el.children) {
        const k = walk(child, d + 1);
        if (k) kids.push(k);
        if (kids.length >= 12) break;
      }
      if (kids.length) node.c = kids;
      return node;
    };
    return walk(root, 0);
  }

  /** Report a failure with the page shape around `root` so it can be fixed from the dashboard. */
  function snapshot(where, root) {
    diag('dom_snapshot', { where, path: location.pathname, hits: { ...hits }, dom: skeleton(root || document.body) });
  }

  // ---- activity nudges --------------------------------------------------------------------------------------
  // At most one nudge every 2.5 s, and a change inside that window is never dropped: it sends one more
  // nudge at the end of the window, so the last message of a burst is always announced.
  let nudgeAt = 0;
  let nudgeTimer = null;
  function nudge() {
    const wait = nudgeAt + 2500 - Date.now();
    if (wait <= 0) {
      nudgeAt = Date.now();
      toWorker({ type: 'activity' });
      return;
    }
    if (nudgeTimer) return; // one trailing nudge is already planned
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      nudgeAt = Date.now();
      toWorker({ type: 'activity' });
    }, wait);
  }

  /** Tell the service worker when something changes under the element returned by `getRoot`. */
  function watch(getRoot) {
    let current = null;
    let obs = null;
    const attach = () => {
      if (!alive) return;
      let root = null;
      try { root = getRoot(); } catch { root = null; }
      if (root === current) return;
      if (obs) obs.disconnect();
      current = root;
      if (!root) return;
      obs = new MutationObserver(nudge);
      obs.observe(root, { childList: true, subtree: true, characterData: true });
    };
    attach();
    setInterval(attach, 5000); // re-attach after the app re-renders; throttling here is harmless
  }

  // ---- adapter plumbing ---------------------------------------------------------------------------------------
  let adapter = null;
  let chainTail = Promise.resolve();
  let current = null; // { op, since } of the operation the queue is running now

  // The longest an operation may hold the queue. A step that never finishes (a promise the page never
  // resolves) would otherwise block every later scan in this tab for good. Longer than the service
  // worker's own limits, so the worker always gives up first.
  const OP_LIMIT_MS = { scan: 60_000, sweep: 60_000, read: 90_000, prepare: 60_000, send: 240_000, selftest: 120_000 };

  /** Run operations strictly one after another: a tab can only do one thing at a time. */
  function serial(op, fn) {
    const limited = () => {
      current = { op, since: Date.now() };
      let timer;
      const cap = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Fail('timeout', `${op} did not finish in this tab`, true)), OP_LIMIT_MS[op] || 90_000);
      });
      return Promise.race([Promise.resolve().then(fn), cap]).finally(() => { clearTimeout(timer); current = null; });
    };
    const run = chainTail.then(limited, limited);
    chainTail = run.then(() => undefined, () => undefined);
    return run;
  }

  // A page holding a Web Lock is not frozen by Chrome's Energy Saver (a frozen tab never answers the
  // agent). The name is neutral and unique per page, so a second tab of the same site holds its own.
  try {
    if (navigator.locks && window === window.top) {
      navigator.locks.request(`tab-lease-${Math.random().toString(36).slice(2, 10)}`, () => new Promise(() => {})).catch(() => {});
    }
  } catch { /* locks unavailable */ }

  async function handle(op, args) {
    if (!adapter) throw new Fail('unknown', 'Adapter not ready', true);
    if (!Object.keys(pack).length) await loadPack();
    switch (op) {
      case 'probe': {
        const res = await adapter.probe(args || {});
        // How long the queue has been busy with one operation: lets the worker see a stuck tab.
        return res && typeof res === 'object' ? { ...res, busy_op: current ? current.op : null, busy_ms: current ? Date.now() - current.since : 0 } : res;
      }
      case 'scan': return adapter.scan(args || {});
      case 'sweep': return adapter.sweep ? adapter.sweep(args || {}) : { threads: [] };
      case 'read': return adapter.read(args || {});
      case 'send': return adapter.send(args || {});
      case 'prepare': return adapter.prepare ? adapter.prepare(args || {}) : { ready: true };
      case 'selftest': return adapter.selftest ? adapter.selftest(args || {}) : { checks: [] };
      case 'health': return { hits: { ...hits }, pack_keys: Object.keys(pack).length };
      case 'video_chunk': return videoChunk(args || {});
      default: throw new Fail('unknown', `Unknown operation ${op}`, false);
    }
  }

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      if (!msg || msg.acx !== true || !msg.op) return false;
      // probe, health and video_chunk (the worker pulling a held video) may run while a long send is in
      // progress; everything else waits its turn.
      const job = () => handle(msg.op, msg.args);
      const run = msg.op === 'probe' || msg.op === 'health' || msg.op === 'video_chunk' ? job() : serial(msg.op, job);
      Promise.resolve(run).then(
        (data) => respond({ ok: true, data: data ?? null }),
        (err) => {
          const code = err instanceof Fail ? err.code : 'unknown';
          if (!(err instanceof Fail)) diag('error', { op: msg.op, message: String(err && err.message ? err.message : err).slice(0, 300) });
          respond({ ok: false, error_code: code, error: String(err && err.message ? err.message : err).slice(0, 300), retryable: err instanceof Fail ? err.retryable : true });
        },
      );
      return true; // async response
    });
  } catch { alive = false; }

  function register(a) {
    adapter = a;
    loadPack().then(() => toWorker({ type: 'activity' }));
  }

  globalThis.ACX = {
    channel: CHANNEL,
    Fail,
    register,
    // selectors
    q, qa, val, rx, chain, lookup,
    // dom
    visible, textOf, click, key, squash, placeCaretAtEnd, selectAllIn,
    // time
    sleep, rand, waitFor,
    // typing and pacing
    insertText, humanType, clearComposer, instant, cpsOf, pauseScale, humanPause,
    // the end of a thread, and list time labels
    tailRef, newerInbound, ownerReplied, noteSent, isClock, labelAge, labelTimeMax, timeMoved, stableTime,
    // diagnostics + activity
    diag, snapshot, skeleton, watch, nudge, toWorker,
    // photos, and whole videos for the vision model
    captureMedia, hasMedia, captureVideo, videoPayload, sampleFrames, frameJpeg, holdVideo,
    get alive() { return alive; },
  };
})();
