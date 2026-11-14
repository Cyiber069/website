// Mock of WhatsApp Web for the end to end tests of the extension's WhatsApp adapter.
//
// It reproduces the parts of the real page the adapter depends on, as documented in the research
// notes of November 2026: element ids (#app #side #pane-side #main), data-testid hooks, roles,
// the two data-id formats, the virtualised chat list (rows placed with translateY, DOM order is
// not visual order), the QR screen, blocking dialogs, the invalid number dialog of /send/?phone=,
// and a message box that is a REAL Lexical editor (the same editor WhatsApp uses), including the
// microphone / Send button swap and the composer element being replaced after a send.
//
// Source file. Bundle it with `node test/e2e/mocks/whatsapp/build.mjs` (output: app.bundle.js).
import { $createParagraphNode, $createTextNode, $getRoot, COMMAND_PRIORITY_HIGH, KEY_ENTER_COMMAND, createEditor } from 'lexical';
import { registerRichText } from '@lexical/rich-text';
import { createEmptyHistoryState, registerHistory } from '@lexical/history';

const STORE = 'wa-mock-state';
const MIN = 60_000;

// ---- state (kept in localStorage so it survives the page load of a new chat link) -----------------

function seed() {
  const now = Date.now();
  let n = 0;
  const id = () => `3EB0${(now + n++).toString(16).toUpperCase().padStart(12, '0')}A1B2`;
  const m = (fromMe, text, minsAgo, extra = {}) => ({ id: id(), fromMe, text, kind: 'text', t: now - minsAgo * MIN, ack: fromMe ? 3 : null, ...extra });
  return {
    mode: 'main',          // main | qr | conflict | loading
    idForm: 'compound',    // compound: "false_<jid>_<id>"   bare: "<id>" (and icons drawn as svg titles)
    bridge: false,         // expose WhatsApp's internal modules through window.require
    restricted: false,     // /send/?phone= shows a restriction notice instead of opening the chat
    dialog: null,          // whatsnew | restricted | unknown | invalid
    filter: 'all',
    openJid: null,
    continueClicked: 0,    // how often "Continue" on the what's new dialog was pressed (must stay 0)
    sent: [],
    chats: [
      { jid: '447700900123@c.us', title: 'Jake', avatar: 'photo', unread: 0, draft: '', messages: [
        m(false, 'hi is the x1 in stock', 600), m(true, 'yes mate plenty in stock', 590),
      ] },
      { jid: '120363041234567890@g.us', title: 'Riders Club', group: true, avatar: 'photo', unread: 2, draft: '', messages: [
        m(false, 'who is out this weekend', 50, { author: 'Sam', authorJid: '447700900111@c.us' }),
        m(false, 'me if it stays dry', 45, { author: 'Priya', authorJid: '447700900222@c.us' }),
        m(false, 'anyone riding sunday', 40, { author: 'Tom', authorJid: '447700900333@c.us' }),
      ] },
      { jid: '93497327620330@lid', title: 'Lena', phone: '447700900789', avatar: 'default', unread: 0, draft: '', messages: [
        m(false, 'hello', 3000), m(true, 'hi Lena how can we help', 2990),
      ] },
      { jid: '447700900456@c.us', title: '+44 7700 900456', avatar: 'default', unread: 0, draft: '', messages: [
        m(false, 'do you ship to wales', 5000), m(true, 'we do, 2 to 4 days', 4990),
      ] },
    ],
  };
}

let state;
try { state = JSON.parse(localStorage.getItem(STORE)) || seed(); } catch { state = seed(); }
// A message that was still on the clock when the page reloaded has been sent meanwhile.
for (const c of state.chats) for (const msg of c.messages) if (msg.fromMe && msg.ack === 0) msg.ack = 1;

function save() {
  localStorage.setItem(STORE, JSON.stringify(state));
  syncIdb();
}

let seq = 0;
const newId = () => `3EB0${Date.now().toString(16).toUpperCase()}${(seq++).toString(16).toUpperCase().padStart(4, '0')}C3D4`;
const formatPhone = (d) => (d.startsWith('44') && d.length === 12 ? `+44 ${d.slice(2, 6)} ${d.slice(6)}` : `+${d}`);
const digits = (s) => String(s || '').replace(/\D/g, '');
const chatBy = (who) => state.chats.find((c) => c.jid === who || c.title === who || (digits(who).length >= 7 && c.jid === `${digits(who)}@c.us`)) || null;
const openChat = () => state.chats.find((c) => c.jid === state.openJid) || null;
const lastOf = (c) => c.messages[c.messages.length - 1] || null;
const compoundId = (c, msg) => `${msg.fromMe}_${c.jid}_${msg.id}${c.group && !msg.fromMe ? `_${msg.authorJid}` : ''}`;

// ---- WhatsApp's own IndexedDB (messages are stored under their compound id) --------------------------

let idb = null;
function syncIdb() {
  const put = (db) => {
    try {
      const tx = db.transaction(['message', 'contact'], 'readwrite');
      for (const c of state.chats) {
        for (const msg of c.messages) tx.objectStore('message').put({ id: compoundId(c, msg), t: Math.floor(msg.t / 1000) });
        if (c.phone) tx.objectStore('contact').put({ id: c.jid, phoneNumber: `${c.phone}@c.us` });
      }
    } catch { /* the test page is closing */ }
  };
  if (idb) return put(idb);
  const req = indexedDB.open('model-storage', 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('message', { keyPath: 'id' });
    req.result.createObjectStore('contact', { keyPath: 'id' });
  };
  req.onsuccess = () => { idb = req.result; put(idb); };
}

// ---- tiny DOM builder ---------------------------------------------------------------------------------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(5)) {
    if (kid === false || kid == null) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/** An icon: data-icon on old builds, an svg with a title on new ones. */
function icon(name, newName, extra = {}) {
  if (state.idForm === 'bare') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = newName || `ic-${name}`;
    svg.append(title);
    return h('span', { class: 'ico' }, svg);
  }
  return h('span', { 'data-icon': name, class: 'ico', ...extra });
}

const EMOJI = /(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)/u;
/** Text with emoji drawn as images, the way WhatsApp renders them. */
function rich(text) {
  return String(text).split(EMOJI).filter(Boolean).map((part) =>
    EMOJI.test(part) && part.match(EMOJI)[0] === part
      ? h('img', { class: 'emoji', alt: part, 'data-plain-text': part, src: 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=' })
      : part);
}

const two = (x) => String(x).padStart(2, '0');
const clock = (t) => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const prePlain = (t, author) => { const d = new Date(t); return `[${clock(t)}, ${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}] ${author}: `; };

const STATUS = [
  { icon: 'msg-time', next: 'ic-schedule', label: ' Pending ' },
  { icon: 'msg-check', next: 'ic-check', label: ' Sent ' },
  { icon: 'msg-dblcheck', next: 'ic-done-all', label: ' Delivered ' },
  { icon: 'msg-dblcheck-ack', next: 'ic-read', label: ' Read ' },
];
function statusIcon(ack) {
  const s = STATUS[Math.max(0, Math.min(3, ack ?? 0))];
  // Old builds label the tick; new builds only draw it.
  return state.idForm === 'bare' ? icon(s.icon, s.next) : icon(s.icon, s.next, { 'aria-label': s.label });
}

// ---- the Lexical message box ------------------------------------------------------------------------------

const editor = createEditor({ namespace: 'wa-mock', onError: (e) => { document.body.dataset.error = String((e && e.stack) || e); } });
registerRichText(editor);
registerHistory(editor, createEmptyHistoryState(), 300);

let modelText = '';
editor.registerUpdateListener(({ editorState }) => {
  editorState.read(() => { modelText = $getRoot().getTextContent(); });
  swapSendButton();
});
// WhatsApp ignores a synthetic Enter: only a real key press sends.
editor.registerCommand(KEY_ENTER_COMMAND, (event) => {
  if (event && event.shiftKey) return false;
  if (event) event.preventDefault();
  if (event && event.isTrusted) doSend(true);
  return true;
}, COMMAND_PRIORITY_HIGH);

function setEditorText(text) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const p = $createParagraphNode();
    if (text) p.append($createTextNode(text));
    root.append(p);
  }, { discrete: true });
}

function composerEl(chat) {
  return h('div', {
    contenteditable: 'true', role: 'textbox', spellcheck: 'true', 'data-lexical-editor': 'true', 'data-tab': '10',
    'aria-label': chat.group ? `Type a message to group ${chat.title}` : `Type a message to ${chat.title}`,
    'aria-owns': 'emoji-suggestion', class: 'composer',
  });
}

/** The microphone and the Send button swap places depending on whether there is text. */
function swapSendButton() {
  const slot = document.querySelector('#main footer .send-slot');
  if (!slot) return;
  const has = modelText.trim() !== '';
  if (has === (slot.dataset.kind === 'send')) return;
  slot.dataset.kind = has ? 'send' : 'mic';
  slot.replaceChildren(has
    ? h('button', { 'aria-label': 'Send', onclick: (e) => doSend(e.isTrusted) }, icon('wds-ic-send-filled', 'wds-ic-send-filled'))
    : h('button', { 'aria-label': 'Voice message' }, icon('mic-outlined', 'ic-mic')));
}

function doSend(trusted) {
  const chat = openChat();
  const text = modelText.replace(/\n{2,}/g, '\n').trim();
  if (!chat || !text || state.dialog) return;
  const msg = { id: newId(), fromMe: true, text, kind: 'text', t: Date.now(), ack: 0 };
  chat.messages.push(msg);
  chat.draft = '';
  state.sent.push({ jid: chat.jid, title: chat.title, text, id: msg.id, at: msg.t, trusted });
  setEditorText('');
  // The real footer re-renders after a send and can hand out a brand new composer element.
  const old = document.querySelector('#main footer .composer');
  if (old) { const fresh = composerEl(chat); old.replaceWith(fresh); editor.setRootElement(fresh); }
  save();
  renderMessages();
  renderList();
  // Clock, then one tick, then two.
  setTimeout(() => { msg.ack = 1; save(); renderMessages(); renderList(); }, 350);
  setTimeout(() => { msg.ack = 2; save(); renderMessages(); renderList(); }, 900);
}

// ---- rendering -------------------------------------------------------------------------------------------------

const app = document.getElementById('app');

function messageEl(chat, msg, prev) {
  const dataId = state.idForm === 'bare' ? msg.id : compoundId(chat, msg);
  const leader = !prev || prev.fromMe !== msg.fromMe || (chat.group && prev.authorJid !== msg.authorJid);
  const author = msg.fromMe ? 'ACX Ebikes' : chat.group ? msg.author : chat.title;
  const long = msg.text && msg.text.length > 320 && !msg.expanded;
  const shown = long ? `${msg.text.slice(0, 300)}…` : msg.text;
  const textBlock = (testid) => msg.text ? h('div', { class: 'copyable-text', 'data-pre-plain-text': prePlain(msg.t, author), 'data-testid': testid || null },
    h('span', { 'data-testid': 'selectable-text', class: 'selectable-text copyable-text', dir: 'ltr' }, h('span', {}, rich(shown))),
    long && h('span', { role: 'button', 'data-testid': 'caption-read-more-button', onclick: () => { msg.expanded = true; renderMessages(); } }, 'Read more')) : null;

  let media = null;
  if (msg.kind === 'image') media = h('div', { role: 'button', 'aria-label': 'Open picture', class: 'media' }, h('img', { alt: '', src: 'blob:https://web.whatsapp.com/5f0c1c7e-mock' }));
  if (msg.kind === 'voice') {
    media = h('div', { class: 'media' }, h('button', { 'aria-label': 'Play voice message' }, icon('audio-play', 'ic-play-arrow')),
      h('span', { 'data-testid': 'ptt-status' }, icon('ptt-status', 'ic-keyboard-voice-filled')), h('div', { role: 'slider', 'aria-valuetext': '0:00/0:07' }));
  }

  return h('div', { role: 'row' },
    h('div', { 'data-testid': `conv-msg-AC${msg.id.slice(-6)}`, 'data-id': dataId, class: 'focusable-list-item', tabindex: '-1' },
      h('div', { 'data-testid': 'msg-container', class: `bubble ${msg.fromMe ? 'me' : 'them'}` },
        leader && h('span', { 'data-testid': msg.fromMe ? 'tail-out' : 'tail-in', class: 'tail' }),
        chat.group && !msg.fromMe && leader && h('span', { 'aria-label': `${msg.author}:`, class: 'author' }, msg.author),
        msg.quoted && h('div', { 'data-testid': 'quoted-message', 'aria-label': 'Quoted message', class: 'quoted' },
          h('span', { 'data-testid': 'selectable-text', class: 'selectable-text copyable-text', dir: 'ltr' }, msg.quoted)),
        media,
        msg.kind === 'image' ? textBlock('image-caption') : textBlock(),
        h('div', { 'data-testid': 'msg-meta', class: 'meta' },
          h('span', { 'data-testid': 'msg-time' }, clock(msg.t)),
          msg.fromMe && statusIcon(msg.ack)))));
}

function renderMessages() {
  const panel = document.querySelector('#main [data-testid="conversation-panel-messages"]');
  const chat = openChat();
  if (!panel || !chat) return;
  const rows = [h('div', { role: 'row', class: 'divider' }, h('span', { dir: 'auto' }, 'TODAY')),
    h('div', { role: 'row', class: 'divider' }, icon('lock-small', 'ic-lock'), 'Messages and calls are end-to-end encrypted.')];
  chat.messages.forEach((msg, i) => rows.push(messageEl(chat, msg, chat.messages[i - 1])));
  panel.replaceChildren(...rows);
  panel.scrollTop = panel.scrollHeight;
}

function renderMain() {
  const old = document.getElementById('main') || document.querySelector('[data-testid="intro-panel"]');
  const chat = openChat();
  let next;
  if (!chat) {
    editor.setRootElement(null);
    next = h('section', { 'data-testid': 'intro-panel', class: 'intro' }, h('h1', {}, 'WhatsApp Web'), 'Send and receive messages without keeping your phone online.');
  } else {
    const composer = composerEl(chat);
    next = h('div', { id: 'main' },
      h('header', { 'data-testid': 'conversation-header' },
        h('div', { role: 'button', title: 'Profile details', class: 'avatar' }),
        h('div', { role: 'button', class: 'who' }, h('span', { dir: 'auto', 'data-testid': 'conversation-info-header-chat-title' }, chat.title),
          h('span', { class: 'sub' }, chat.group ? 'Sam, Priya, Tom, You' : 'click here for contact info'))),
      h('div', { 'data-testid': 'conversation-panel-messages', role: 'application', class: 'messages' }),
      h('footer', {},
        h('button', { 'aria-label': 'Attach' }, icon('plus-rounded', 'ic-add')),
        h('div', { class: 'lexical-rich-text-input' }, composer),
        h('span', { class: 'send-slot', 'data-kind': '' })));
    editor.setRootElement(composer);
  }
  if (old) old.replaceWith(next); else app.append(next);
  if (chat) { setEditorText(chat.draft || ''); document.querySelector('#main .send-slot').dataset.kind = ''; swapSendButton(); renderMessages(); }
}

function visibleChats() {
  const term = (document.querySelector('#side input[role="textbox"]')?.value || '').trim().toLowerCase();
  return state.chats
    .filter((c) => (state.filter === 'unread' ? c.unread > 0 : state.filter === 'groups' ? c.group : true))
    .filter((c) => !term || c.title.toLowerCase().includes(term) || (digits(term).length >= 4 && digits(c.title + c.jid).includes(digits(term))))
    .sort((a, b) => (lastOf(b)?.t || 0) - (lastOf(a)?.t || 0));
}

function rowEl(chat, index) {
  const last = lastOf(chat);
  const open = chat.jid === state.openJid;
  const preview = last ? (last.text || (last.kind === 'voice' ? 'Voice message' : 'Photo')) : '';
  return h('div', { role: 'row', style: `transform: translateY(${index * 72}px)` },
    h('div', { role: 'gridcell', 'aria-colindex': '1' },
      h('div', { tabindex: '-1', 'aria-selected': open ? 'true' : 'false', class: 'activator', onmousedown: () => selectChat(chat.jid) },
        h('div', { 'data-testid': 'cell-frame-container', class: 'cell' },
          chat.avatar === 'default' ? icon(chat.group ? 'default-group-refreshed' : 'default-user-refreshed', chat.group ? 'default-group-refreshed' : 'default-user-refreshed') : h('span', { class: 'avatar' }),
          h('div', { 'data-testid': 'cell-frame-title', class: 'title' }, h('span', { dir: 'auto', title: chat.title }, chat.title)),
          h('div', { 'data-testid': 'cell-frame-primary-detail', class: 'time' }, last ? clock(last.t) : ''),
          h('div', { 'data-testid': 'cell-frame-secondary', class: 'preview' },
            last && last.fromMe && h('span', { 'data-testid': 'last-msg-status' }, statusIcon(last.ack)),
            chat.group && last && !last.fromMe && [h('span', {}, last.author), h('span', {}, ': ')],
            chat.draft && !open ? [h('span', { class: 'draft' }, 'Draft: '), chat.draft] : h('span', { dir: 'ltr', title: preview }, rich(preview))),
          chat.unread > 0 && h('span', { 'aria-label': `${chat.unread} unread message${chat.unread > 1 ? 's' : ''}`, class: 'badge' }, String(chat.unread))))));
}

function renderList() {
  const grid = document.querySelector('#pane-side [role="grid"]');
  if (!grid) return;
  const chats = visibleChats();
  const searching = Boolean((document.querySelector('#side input[role="textbox"]')?.value || '').trim());
  grid.setAttribute('aria-label', searching ? 'Search results.' : 'Chat list');
  grid.setAttribute('aria-rowcount', String(chats.length));
  grid.style.height = `${chats.length * 72}px`;
  // Virtualised list: the DOM order has nothing to do with the order on screen.
  grid.replaceChildren(...chats.map((c, i) => rowEl(c, i)).reverse());
  for (const b of document.querySelectorAll('#side button[role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.filter === state.filter));
}

function selectChat(jid) {
  if (state.dialog) return; // a modal dialog swallows every click behind it
  const prev = openChat();
  if (prev) prev.draft = modelText.trim();
  state.openJid = jid;
  const chat = openChat();
  if (chat) chat.unread = 0;
  save();
  renderMain();
  renderList();
}

function dialogEl() {
  const close = () => { state.dialog = null; save(); renderDialog(); };
  switch (state.dialog) {
    case 'whatsnew':
      return h('div', { role: 'dialog', 'aria-modal': 'true', class: 'dialog' }, h('h1', {}, "What's new in WhatsApp Web"),
        h('p', {}, 'A fresh look and new ways to stay in touch.'),
        h('button', { 'aria-label': 'Close', onclick: close }, icon('x', 'ic-close')),
        h('button', { onclick: () => { state.continueClicked++; close(); } }, 'Continue'));
    case 'restricted':
      return h('div', { role: 'dialog', 'aria-modal': 'true', class: 'dialog' },
        h('p', {}, "Your account is restricted right now. You can't start new chats for a while."), h('button', { onclick: close }, 'OK'));
    case 'unknown':
      return h('div', { role: 'dialog', 'aria-modal': 'true', class: 'dialog' }, h('p', {}, 'Confirm your linked devices to continue.'), h('button', { onclick: close }, 'Review'));
    case 'invalid':
      return h('div', { role: 'dialog', 'aria-modal': 'true', 'data-animate-modal-popup': 'true', class: 'dialog' },
        h('div', { 'data-animate-modal-body': 'true' }, 'Phone number shared via url is invalid.'),
        h('button', { 'data-testid': 'popup-controls-ok', onclick: close }, 'OK'));
    default:
      return null;
  }
}

function renderDialog() {
  document.querySelector('.dialog-layer')?.remove();
  const d = dialogEl();
  if (d) document.body.append(h('div', { class: 'dialog-layer' }, d));
}

function render() {
  app.replaceChildren();
  editor.setRootElement(null);
  document.querySelector('.dialog-layer')?.remove();
  if (state.mode === 'loading') {
    app.append(h('div', { 'data-testid': 'wa-web-loading-screen', class: 'landing' }, h('progress', {}), 'Loading your chats'));
    return;
  }
  if (state.mode === 'qr') {
    app.append(h('div', { class: 'landing' }, h('h1', {}, 'Steps to log in'),
      h('div', { 'data-testid': 'link-device-qr-code' }, h('canvas', { 'aria-label': 'Scan this QR code to link a device!', role: 'img', width: '228', height: '228' }))));
    return;
  }
  if (state.mode === 'conflict') {
    app.append(h('div', { class: 'landing' }, h('p', {}, 'WhatsApp is open in another window. Click "Use here" to use WhatsApp in this window.'),
      h('button', {}, 'Close'), h('button', { onclick: () => api.set({ mode: 'main' }) }, 'Use here')));
    return;
  }
  const tab = (id, label, filter) => h('button', { role: 'tab', id, 'data-filter': filter, 'aria-selected': 'false', onclick: () => { state.filter = filter; save(); renderList(); } }, label);
  app.append(h('div', { id: 'side' },
    h('header', {}, h('h1', {}, 'Chats'), h('button', { 'aria-label': 'New chat' }, icon('new-chat-outline', 'ic-new-chat'))),
    h('div', { 'data-testid': 'chat-list-search-container' }, h('input', { type: 'text', role: 'textbox', 'aria-label': 'Search or start a new chat', oninput: renderList })),
    h('div', { role: 'tablist', class: 'filters' }, tab('all-filter', 'All', 'all'), tab('unread-filter', 'Unread', 'unread'), tab('favorites-filter', 'Favourites', 'favorites'), tab('group-filter', 'Groups', 'groups')),
    h('div', { id: 'pane-side' },
      h('button', { class: 'archived' }, icon('archive', 'ic-archive'), 'Archived', h('span', {}, '3')),
      h('div', { role: 'grid', 'data-testid': 'chat-list', 'aria-label': 'Chat list' }))));
  renderMain();
  renderList();
  renderDialog();
}

// ---- WhatsApp's internal modules, as far as the extension's read only bridge uses them -------------------------------

function wid(jid) {
  const [user, server] = String(jid).split('@');
  return { user, server, $1: `${user}@${server}`, toString: () => `${user}@${server}`, isGroup: () => server === 'g.us', isUser: () => server === 'c.us' || server === 'lid' };
}
const modules = {
  WAWebCollections: {
    Chat: {
      getModelsArray: () => state.chats.map((c) => ({
        id: wid(c.jid), formattedTitle: c.title, unreadCount: c.unread, hasUnread: c.unread > 0, archive: false,
        mute: { expiration: 0 }, active: c.jid === state.openJid, t: Math.floor((lastOf(c)?.t || 0) / 1000),
      })),
      findFirst(fn) { return this.getModelsArray().find(fn); },
    },
    Msg: {
      getModelsArray: () => state.chats.flatMap((c) => c.messages.map((msg) => ({
        id: { id: msg.id, fromMe: msg.fromMe, remote: wid(c.jid), $1: compoundId(c, msg) },
        type: msg.kind === 'text' ? 'chat' : msg.kind === 'voice' ? 'ptt' : msg.kind,
        body: msg.kind === 'text' ? msg.text : '', caption: msg.kind === 'text' ? undefined : msg.text || undefined,
        t: Math.floor(msg.t / 1000), ack: msg.ack ?? 0,
      }))),
    },
  },
  WAWebWidFactory: { createWid: wid },
  WAWebApiContact: { getPhoneNumber: (w) => { const c = chatBy(w.$1); return c && c.phone ? wid(`${c.phone}@c.us`) : null; } },
  WAWebSocketModel: { get Socket() { return { state: state.mode === 'qr' ? 'UNPAIRED' : state.mode === 'conflict' ? 'CONFLICT' : 'CONNECTED', hasSynced: state.mode === 'main' }; } },
  WAWebStreamModel: { get Stream() { return { mode: state.mode === 'qr' ? 'QR' : state.mode === 'conflict' ? 'CONFLICT' : 'MAIN', info: 'NORMAL' }; } },
};
window.Debug = { VERSION: '2.3000.1099999999-mock' };
window.require = (name) => {
  if (name === '__debug') return { modulesMap: state.bridge ? modules : {} };
  if (!state.bridge || !modules[name]) throw new Error(`Requiring unknown module "${name}"`);
  return modules[name];
};

// ---- helpers for the tests -----------------------------------------------------------------------------------------

const api = {
  state: () => JSON.parse(JSON.stringify(state)),
  /** What was sent from this page: [{ jid, title, text, id, at, trusted }]. */
  sent: () => JSON.parse(JSON.stringify(state.sent)),
  chats: () => state.chats.map((c) => ({ jid: c.jid, title: c.title, unread: c.unread, draft: c.jid === state.openJid ? modelText.trim() : c.draft, open: c.jid === state.openJid, messages: c.messages.length })),
  /**
   * A customer message arrives. `who` is a chat title, a chat id or a phone number (an unknown
   * number creates a chat titled with the number, like an unsaved contact). Returns the message id.
   */
  receive(who, text, opts = {}) {
    let chat = chatBy(who);
    if (!chat) {
      const d = digits(who);
      const jid = String(who).includes('@') ? String(who) : `${d}@c.us`;
      chat = { jid, title: opts.title || formatPhone(d), phone: opts.phone || undefined, avatar: 'default', unread: 0, draft: '', messages: [] };
      state.chats.push(chat);
    }
    const msg = { id: newId(), fromMe: false, text: text || '', kind: opts.kind || 'text', t: Date.now(), ack: null, quoted: opts.quoted, author: opts.author || (chat.group ? 'Sam' : undefined), authorJid: opts.authorJid || (chat.group ? '447700900111@c.us' : undefined) };
    chat.messages.push(msg);
    if (chat.jid !== state.openJid || state.dialog) chat.unread += 1; // an open chat is read straight away
    save();
    if (state.mode === 'main') { renderList(); renderMessages(); }
    return msg.id;
  },
  /** Change mode, idForm, bridge, restricted... and draw the page again. */
  set(patch) { Object.assign(state, patch); save(); render(); return api.state(); },
  showDialog(kind) { state.dialog = kind; save(); renderDialog(); },
  /** Put a half typed message in a chat's message box, as the owner would. */
  setDraft(who, text) {
    const chat = chatBy(who);
    if (!chat) return false;
    chat.draft = text;
    if (chat.jid === state.openJid) setEditorText(text);
    save();
    renderList();
    return true;
  },
  open(who) { const c = chatBy(who); if (c) selectChat(c.jid); return Boolean(c); },
  reset() { localStorage.removeItem(STORE); location.href = '/'; },
};
window.mock = api;

// ---- start up ------------------------------------------------------------------------------------------------------

function boot() {
  const url = new URL(location.href);
  const phone = digits(url.searchParams.get('phone'));
  if (state.mode === 'main' && url.pathname.startsWith('/send') && phone) {
    // The link a person follows from wa.me. Numbers ending in 000000 stand for "not on WhatsApp".
    state.openJid = null;
    if (state.restricted) state.dialog = 'restricted';
    else if (phone.endsWith('000000') || phone.length < 8) state.dialog = 'invalid';
    else {
      let chat = chatBy(`${phone}@c.us`);
      if (!chat) { chat = { jid: `${phone}@c.us`, title: formatPhone(phone), avatar: 'default', unread: 0, draft: '', messages: [] }; state.chats.push(chat); }
      state.openJid = chat.jid;
    }
    history.replaceState(null, '', '/');
  }
  save();
  render();
  document.body.dataset.mockReady = '1';
}

// Every load starts on the loading screen, like the real app.
app.append(h('div', { 'data-testid': 'wa-web-loading-screen', class: 'landing' }, h('progress', {}), 'Loading your chats'));
setTimeout(boot, 400);
