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
//   send({ job })      -> { sent_external_ids: [] }         types job.parts in order into job.target and sends them
//   prepare({ job })   -> { navigate: url } | { ready: true }   optional, for new_chat jobs that need a page load first
//   selftest()         -> { checks: [{ name, ok, detail }] }    optional
//   sweep()            -> { threads: [...] } like scan, optional: the most recent 1:1 chats whose last
//                         message is from the customer, whatever their unread badge says. Run every
//                         10 minutes as a safety net for messages the normal scan missed.
//
// Throw new ACX.Fail(code, message, retryable) for expected failures. Codes the server understands:
// thread_not_found, composer_missing, composer_busy, send_not_confirmed, not_on_whatsapp, invalid_number,
// logged_out, blocked, timeout, unknown.
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

  /**
   * Type like a person: a pause that scales with length (so the other side sees "typing..."),
   * then the text. `cps` is characters per second from the job's pacing.
   */
  async function humanType(el, text, cps = 11) {
    const total = Math.min(12_000, Math.max(700, (text.length / Math.max(3, cps)) * 1000));
    el.focus();
    await sleep(total * rand(0.25, 0.4));
    const how = await insertText(el, text);
    await sleep(total * rand(0.2, 0.35));
    return how;
  }

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
  let nudgeAt = 0;
  function nudge() {
    const now = Date.now();
    if (now - nudgeAt < 2500) return;
    nudgeAt = now;
    toWorker({ type: 'activity' });
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
      default: throw new Fail('unknown', `Unknown operation ${op}`, false);
    }
  }

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
      if (!msg || msg.acx !== true || !msg.op) return false;
      // probe and health may run while a long send is in progress; everything else waits its turn.
      const job = () => handle(msg.op, msg.args);
      const run = msg.op === 'probe' || msg.op === 'health' ? job() : serial(msg.op, job);
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
    // typing
    insertText, humanType, clearComposer,
    // diagnostics + activity
    diag, snapshot, skeleton, watch, nudge, toWorker,
    // photos
    captureMedia, hasMedia,
    get alive() { return alive; },
  };
})();
