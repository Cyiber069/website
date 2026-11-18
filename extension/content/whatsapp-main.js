// WhatsApp Web bridge. Runs in the page's own JavaScript world (MAIN) so it can look things up in
// WhatsApp's module registry: chat ids, phone numbers behind hidden (LID) ids, full message text.
//
// Rules for this file:
//   * READ ONLY. It never sends, opens, marks as read, edits or deletes anything.
//   * It adds nothing to window and makes no network calls (the page's CSP applies here). Reading a
//     blob: address WhatsApp already made (a voice note it downloaded) stays inside the page.
//   * Everything is optional. A missing module or renamed field makes one call fail, and the
//     adapter in whatsapp.js then falls back to what it can see on the page.
//   * Module names are not hard coded: the adapter sends them with each request from the selector
//     pack (bridge.modules), so a rename is fixed from the dashboard.
(() => {
  const TAG = 'acx-wa-bridge';
  if (location.hostname !== 'web.whatsapp.com') return;

  let names = {};

  // Only require a module the registry lists: asking Meta's loader for an unknown name can raise
  // inside their guarded code and be reported.
  const has = (n) => {
    try { return Boolean(n) && Boolean(window.require('__debug').modulesMap[n]); } catch { return false; }
  };
  const mod = (key) => {
    const n = names[key];
    try { return has(n) ? window.require(n) : null; } catch { return null; }
  };

  // A WhatsApp id ("wid") as text. The serialized field was renamed from _serialized to $1 in 2026.
  const wstr = (w) => {
    if (!w) return '';
    if (typeof w === 'string') return w;
    return w._serialized || w.$1 || (typeof w.toString === 'function' ? String(w.toString()) : '');
  };
  const serverOf = (w) => (w && w.server) || wstr(w).split('@')[1] || '';
  const isGroupWid = (w) => {
    try { if (w && typeof w.isGroup === 'function') return Boolean(w.isGroup()); } catch { /* fall through */ }
    return serverOf(w) === 'g.us';
  };

  // Text of a message model: the body for plain text, the caption for media.
  const textOf = (m) => {
    if (m.type === 'chat') return String(m.body || '');
    if (m.type === 'document' && m.caption === m.filename) return '';
    return String(m.caption || '');
  };

  const chatInfo = (c) => ({
    jid: wstr(c.id),
    title: String(c.formattedTitle || ''),
    is_group: isGroupWid(c.id),
    server: serverOf(c.id),
    unread: Number(c.unreadCount) || (c.hasUnread ? 1 : 0),
    archived: Boolean(c.archive),
    muted: Boolean(c.mute && c.mute.expiration !== 0),
    t: Number(c.t) || 0,
  });

  const api = {
    ping() {
      return { require: typeof window.require === 'function', version: (window.Debug && window.Debug.VERSION) || null, collections: Boolean(mod('collections')) };
    },

    // Connection state, used to tell "logged out" and "open in another window" apart from loading.
    state() {
      const S = (mod('socket') || {}).Socket;
      const T = (mod('stream') || {}).Stream;
      return {
        socket: S ? S.state : null,
        synced: S ? Boolean(S.hasSynced) : null,
        mode: T ? T.mode : null,
        info: T ? T.info : null,
      };
    },

    // Every chat WhatsApp has loaded (no network): id, title, kind and unread count.
    chats() {
      return mod('collections').Chat.getModelsArray().map(chatInfo);
    },

    activeChat() {
      const c = mod('collections').Chat.findFirst((x) => x.active);
      return c ? chatInfo(c) : null;
    },

    // Message models for the ids found on the page (the part of data-id after the chat id).
    messages(ids) {
      const want = new Set(Array.isArray(ids) ? ids : []);
      const out = {};
      for (const m of mod('collections').Msg.getModelsArray()) {
        const k = m.id && m.id.id;
        if (!k || !want.has(k)) continue;
        out[k] = {
          type: String(m.type || ''), text: textOf(m), t: Number(m.t) || null, ack: typeof m.ack === 'number' ? m.ack : null,
          from_me: Boolean(m.id.fromMe), chat: wstr(m.id.remote) || null,
          // For a video: how long and how big, and whether it is view once (never opened by the agent).
          duration: Number(m.duration) || null, size: Number(m.size) || null, view_once: Boolean(m.isViewOnce),
        };
      }
      return out;
    },

    // A customer voice note (ptt) WhatsApp has already downloaded: its bytes, as the Blob WhatsApp holds
    // in memory. Never downloads, plays or marks anything: a note not loaded yet answers why: 'not_loaded'.
    // Field names are best effort (WhatsApp renames them): mediaData.mediaBlob (forceToBlob) or
    // mediaData.renderableUrl (a blob: address).
    async voice(msgId) {
      const m = mod('collections').Msg.getModelsArray().find((x) => x.id && x.id.id === msgId);
      if (!m) return null;
      const type = String(m.type || '');
      const out = { duration: Number(m.duration) || null, size: Number(m.size) || null, mime: String(m.mimetype || '').split(';')[0] || null };
      if (type !== 'ptt' && type !== 'audio') return { ...out, why: 'not_voice' };
      if (m.isViewOnce) return { ...out, why: 'view_once' };
      if (out.size && out.size > 200000) return { ...out, why: 'too_big' };
      const md = m.mediaData || {};
      const asBlob = async (o) => {
        if (!o) return null;
        if (o instanceof Blob) return o;
        try { if (typeof o.forceToBlob === 'function') { const b = await o.forceToBlob(); if (b instanceof Blob) return b; } } catch { /* not ready */ }
        try { if (o._blob instanceof Blob) return o._blob; } catch { /* renamed */ }
        return null;
      };
      let blob = await asBlob(md.mediaBlob);
      const url = typeof md.renderableUrl === 'string' ? md.renderableUrl : '';
      if (!blob && url.startsWith('blob:')) { try { blob = await (await fetch(url)).blob(); } catch { blob = null; } }
      return blob && blob.size ? { ...out, blob, mime: out.mime || blob.type || null } : { ...out, why: 'not_loaded' };
    },

    // Phone number (digits) for a chat id. Local lookups only; null when the person hides their number.
    phoneOf(jid) {
      const w = mod('widFactory').createWid(jid);
      if (serverOf(w) !== 'lid') return (w.user || String(jid).split('@')[0]) || null;
      const A = mod('contactApi');
      let p = A && typeof A.getPhoneNumber === 'function' ? A.getPhoneNumber(w) : null;
      if (!p) {
        const L = mod('lidUtils');
        p = L && typeof L.toPn === 'function' ? L.toPn(w) : null;
      }
      const digits = p ? wstr(p).split('@')[0].replace(/\D/g, '') : '';
      return digits || null;
    },
  };

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.tag !== TAG || d.dir !== 'req' || typeof d.fn !== 'string') return;
    const post = (reply) => { try { window.postMessage(reply, location.origin); } catch { /* result could not be cloned */ } };
    const fail = (err) => post({ tag: TAG, dir: 'res', id: d.id, ok: false, err: String((err && err.message) || err).slice(0, 200) });
    try {
      if (!Object.prototype.hasOwnProperty.call(api, d.fn)) throw new Error('unknown call');
      if (d.modules && typeof d.modules === 'object') names = d.modules;
      // Most calls answer at once; voice reads a Blob and answers when it has it (a Blob clones across).
      Promise.resolve(api[d.fn](...(Array.isArray(d.args) ? d.args : []))).then((res) => post({ tag: TAG, dir: 'res', id: d.id, ok: true, res }), fail);
    } catch (err) {
      fail(err);
    }
  });
})();
