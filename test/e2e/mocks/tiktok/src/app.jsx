// Mock of the TikTok messages page for the extension end to end test.
//
// It copies the DOM of TikTok's "IM React SDK" direct message front end as documented in the research
// notes (data-e2e names, data-conv-id / data-conversation-id rows, data-index + more-action-icon-msg-<id>
// on messages, row-reverse for own messages, the Accept box for message requests) and uses the REAL
// Draft.js editor with the same wiring TikTok uses: the text that gets sent is React state filled only
// by Draft's onChange, the Send button renders only while that state has text, any Enter keydown sends.
// `mock.setVariant('legacy')` strips the ids the legacy front end does not have.
//
// Test hooks live on window.mock. State is kept in localStorage so a page reload keeps the chats,
// the way the real site would.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { ContentState, Editor, EditorState, Modifier, getDefaultKeyBinding } from 'draft-js';

const h = React.createElement;
const STORE_KEY = 'mock_tiktok_state_v1';
const ME = { uid: '7000000000000000001', uniqueId: 'acx.ebikes', nickname: 'ACX Ebikes' };
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const MAX_INPUT = 6000;

// ---- state -------------------------------------------------------------------------------------

let seq = 1;
const nextId = () => String(7400000000000000000n + BigInt(Date.now() % 1_000_000_000) * 1000n + BigInt(seq++ % 1000));
const clock = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function msg(mine, text, extra = {}) {
  return { clientId: nextId(), serverId: nextId(), mine, kind: 'text', text, failed: false, ...extra };
}

function seed() {
  const conv = (uid, uniqueId, nickname, messages, extra = {}) => ({
    id: `0:1:${uid}:${ME.uid}`, peer: { uid, uniqueId, nickname }, group: false, request: false, unread: 0, muted: false,
    draft: '', time: clock(), order: seq++, messages, ...extra,
  });
  return {
    variant: 'sdk',
    openId: null,
    view: 'main',
    rateLimited: false,
    captcha: false,
    toast: '',
    sent: [],
    failed: [],
    dropped: [],
    convs: [
      conv('6800000000000000011', 'jake.rides', 'Jake', [
        msg(false, 'hey do you ship to ireland'),
        msg(true, 'yes we do bro 2 to 4 days'),
      ]),
      conv('6800000000000000022', 'mia_b', 'Mia B', [
        msg(false, 'hi'),
        msg(true, 'hey how can we help'),
      ]),
      // Every kind of bubble the web app can render, for the read test.
      conv('6800000000000000033', 'leo.media', 'Leo', [
        msg(false, 'look at this [emoji:😂] lol'),
        msg(false, '', { kind: 'shared_video' }),
        msg(false, '', { kind: 'sticker' }),
        msg(false, '', { kind: 'image' }),
        msg(false, '', { kind: 'video' }),
        msg(false, "[This message type isn't supported]", { kind: 'unsupported' }),
        msg(false, '', { kind: 'system', text: 'Leo recalled a message' }),
        msg(true, 'nice one'),
        msg(true, 'this one never went out', { failed: true, notice: 'Only friends can send messages to each other' }),
        msg(false, 'line one\nline two'),
      ]),
      {
        id: '0:2:7300000000000000999', peer: { uid: '7300000000000000999', uniqueId: '', nickname: 'Ride crew' }, group: true, request: false,
        unread: 2, muted: false, draft: '', time: clock(), order: 0,
        messages: [msg(false, 'who is riding sunday', { author: 'jake.rides' }), msg(false, 'me', { author: 'mia_b' })],
      },
    ],
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const st = JSON.parse(raw);
      // A send that was still pending when the page went away has long been stored by the server.
      for (const c of st.convs) for (const m of c.messages) if (m.mine && !m.serverId && !m.failed) m.serverId = nextId();
      return st;
    }
  } catch { /* fresh start */ }
  return seed();
}

let state = load();
seq = Math.max(seq, ...state.convs.map((c) => c.order + 1));
const listeners = new Set();
let loadingId = null; // conversation whose messages are still "loading" (not persisted)

function commit() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
  listeners.forEach((fn) => fn());
}

const find = (who) => state.convs.find((c) => c.id === who || c.peer.uniqueId === who || c.peer.nickname === who);

function openConv(id) {
  const c = find(id);
  if (!c) return;
  state.openId = c.id;
  c.unread = 0; // opening a conversation marks it read
  loadingId = c.id;
  commit();
  setTimeout(() => { if (loadingId === c.id) { loadingId = null; commit(); } }, 180);
}

function receive(who, text, opts = {}) {
  const c = find(who);
  if (!c) throw new Error(`mock: no conversation ${who}`);
  c.messages.push(msg(false, text, { kind: opts.kind || 'text' }));
  if (state.openId !== c.id) c.unread += 1; // the open chat is being looked at: no badge
  c.order = seq++;
  c.time = clock();
  commit();
  return c.id;
}

function receiveRequest({ handle, nickname, text }) {
  const uid = `69${String(Date.now()).padStart(17, '0')}`.slice(0, 19);
  const c = {
    id: `0:1:${uid}:${ME.uid}`, peer: { uid, uniqueId: handle, nickname }, group: false, request: true, unread: 1, muted: false,
    draft: '', time: clock(), order: seq++, messages: [msg(false, text)],
  };
  state.convs.push(c);
  commit();
  return c.id;
}

// Misbehaviour the test can switch on: { ignoreSendClick, dropNextSend, limitNextSend }.
const quirks = {};

/** What TikTok's onPost does: takes the text from React state, shows the bubble, then the server answers. */
function post(convId, text, via, trusted) {
  const c = find(convId);
  const m = { clientId: nextId(), serverId: null, mine: true, kind: 'text', text, failed: false };
  c.messages.push(m);
  c.order = seq++;
  c.time = clock();
  if (quirks.dropNextSend) {
    // The box empties but no bubble ever shows: the outcome nobody can be sure about.
    quirks.dropNextSend = false;
    c.messages.pop();
    state.dropped.push({ convId: c.id, text });
    commit();
    return;
  }
  if (quirks.limitNextSend) { quirks.limitNextSend = false; state.rateLimited = true; }
  if (state.rateLimited) {
    m.failed = true;
    state.failed.push({ convId: c.id, text });
    state.toast = 'You are sending messages too fast. Take a rest.';
    commit();
    return;
  }
  state.sent.push({ convId: c.id, handle: c.peer.uniqueId, text, via, trusted, at: Date.now() });
  commit();
  setTimeout(() => { m.serverId = nextId(); commit(); }, 350); // the id is not numeric while the send is pending
}

// The text React holds for the open composer (what would be sent), for assertions.
let composerText = '';

window.mock = {
  ready: false,
  me: ME,
  receive,
  receiveRequest,
  open: openConv,
  sent: () => JSON.parse(JSON.stringify(state.sent)),
  failed: () => JSON.parse(JSON.stringify(state.failed)),
  state: () => JSON.parse(JSON.stringify(state)),
  conv: (who) => JSON.parse(JSON.stringify(find(who) || null)),
  composerText: () => composerText,
  accept(who) { const c = find(who); c.request = false; c.order = seq++; if (!state.convs.some((x) => x.request)) state.view = 'main'; commit(); },
  setRateLimited(on) { state.rateLimited = Boolean(on); state.toast = on ? 'You are sending messages too fast. Take a rest.' : ''; commit(); },
  dropped: () => JSON.parse(JSON.stringify(state.dropped)),
  setQuirk(name, on = true) { quirks[name] = Boolean(on); },
  setCaptcha(on) { state.captcha = Boolean(on); commit(); },
  setVariant(v) { state.variant = v === 'legacy' ? 'legacy' : 'sdk'; commit(); },
  reset() { localStorage.removeItem(STORE_KEY); state = seed(); loadingId = null; commit(); },
};

function useStore() {
  const [, force] = React.useReducer((n) => n + 1, 0);
  React.useEffect(() => { listeners.add(force); return () => listeners.delete(force); }, []);
}

// Class names in TikTok's format: css-<hash>-<build>--<ComponentLabel>.
const cls = (label, extra = '') => `css-${label.length}x9k2-7937d88b--${label}${extra ? ` ${extra}` : ''}`;

// ---- conversation list ------------------------------------------------------------------------

function previewOf(c) {
  const last = c.messages[c.messages.length - 1];
  if (!last) return '';
  if (last.kind === 'text') return last.text.replace(/\[emoji:(.+?)\]/g, '$1').replace(/\n/g, ' ');
  if (last.kind === 'shared_video') return 'Shared a video';
  if (last.kind === 'system') return last.text;
  return `Sent a ${last.kind}`;
}

function Badge({ n }) {
  return h('span', { 'data-e2e': 'dm-new-conversation-unread', className: cls('SpanNewMessage', 'badge') }, n > 99 ? '99+' : String(n));
}

function ConversationRow({ c, index }) {
  const sdk = state.variant === 'sdk';
  const item = h('div', {
    id: `more-action-icon-${c.id}`,
    'data-e2e': 'dm-new-conversation-item',
    className: cls('DivItemWrapper', `item${state.openId === c.id ? ' selected' : ''}`),
    tabIndex: 0,
    onClick: () => openConv(c.id),
    onKeyDown: (e) => { if (e.key === 'Enter') openConv(c.id); },
    ...(sdk ? { 'data-conv-id': c.id, 'aria-selected': state.openId === c.id ? 'true' : 'false' } : {}),
  },
  h('div', { 'data-e2e': 'dm-new-conversation-avatar', className: 'avatar' }, h('img', { src: PIXEL, alt: '' })),
  h('div', { className: cls('DivItemInfo', 'info') },
    h('p', { 'data-e2e': 'dm-new-conversation-nickname', className: cls('PInfoNickname') }, c.peer.nickname),
    h('p', { className: cls('PInfoExtractTime', 'extract') },
      h('span', { className: 'preview' }, previewOf(c)),
      h('span', { className: 'time' }, c.time))),
  c.muted ? h('span', { 'data-e2e': 'dm-new-conversation-mute-icon' }, '🔕') : c.unread > 0 ? h(Badge, { n: c.unread }) : null);
  // The SDK list is virtual: absolutely positioned rows that carry the conversation id.
  if (!sdk) return h('div', { className: 'row-legacy' }, item);
  return h('div', { 'data-index': index, 'data-conversation-id': c.id, style: { position: 'absolute', top: index * 72, left: 0, right: 0, height: 72 } }, item);
}

function ConversationList() {
  const sdk = state.variant === 'sdk';
  const requests = state.convs.filter((c) => c.request);
  const inRequests = state.view === 'requests';
  const shown = state.convs.filter((c) => c.request === inRequests).sort((a, b) => b.order - a.order);
  const requestUnread = requests.reduce((n, c) => n + c.unread, 0);
  return h('div', { className: cls('DivConversationListWrapper', 'left') },
    inRequests
      ? h('div', { className: cls('DivConversationRequestHeader', 'list-header') },
        h('div', { role: 'button', 'aria-label': 'Back', tabIndex: 0, onClick: () => { state.view = 'main'; commit(); } }, '‹'),
        h('span', null, 'Message requests'))
      : h('div', { 'data-e2e': 'dm-new-conversation-header', className: 'list-header' }, 'Messages'),
    h('div', { 'data-e2e': 'dm-new-conversation-list', className: cls('DivConversationListContainer', 'list') },
      !inRequests && requests.length
        ? h('div', {
          role: 'button', 'aria-label': 'Message requests', tabIndex: 0, className: cls('DivRequestGroup', 'requests-entry'),
          onClick: () => { state.view = 'requests'; commit(); },
          ...(sdk ? { 'data-stranger-entry': 'true' } : {}),
        }, h('span', null, 'Message requests'), requestUnread ? h(Badge, { n: requestUnread }) : null)
        : null,
      h('div', { style: { position: 'relative', height: sdk ? shown.length * 72 : 'auto' } },
        shown.map((c, i) => h(ConversationRow, { key: c.id, c, index: i })))));
}

// ---- messages -----------------------------------------------------------------------------------

function textWithEmoji(text) {
  const out = [];
  text.split(/(\[emoji:.+?\])/).forEach((bit, i) => {
    const m = /^\[emoji:(.+?)\]$/.exec(bit);
    if (m) out.push(h('img', { key: i, src: PIXEL, 'data-official-emoji': 'true', 'aria-label': m[1], width: 18, height: 18 }));
    else if (bit) out.push(bit);
  });
  return out;
}

function MessageContent({ m }) {
  switch (m.kind) {
    case 'text': return h('div', { className: cls('DivTextContainer', 'bubble') }, h('p', { 'data-e2e': 'dm-new-message-text', className: cls('PText') }, textWithEmoji(m.text)));
    case 'shared_video': return h('div', { 'data-e2e': 'dm-new-shared-video', className: 'card', style: { backgroundImage: `url(${PIXEL})` } });
    case 'image': return h('div', { 'data-e2e': 'dm-new-image-card', className: 'card' }, h('img', { src: PIXEL, alt: '' }));
    case 'video': return h('div', { 'data-e2e': 'dm-new-video-card', className: 'card' });
    case 'sticker': return h('div', { className: cls('DivStickerContainer') }, h('img', { className: cls('StickerImage'), src: PIXEL, alt: '' }));
    default: return h('div', { className: cls('DivTextContainer', 'bubble') }, m.text);
  }
}

function Message({ m, conv }) {
  const sdk = state.variant === 'sdk';
  if (m.kind === 'system') return h('div', { 'data-e2e': 'chat-item', className: cls('DivChatItemWrapper', 'system') }, m.text);
  const author = m.mine ? ME.uniqueId : m.author || conv.peer.uniqueId;
  const item = h('div', { 'data-e2e': 'dm-new-chat-item', className: cls('DivChatItemWrapper') },
    h('div', { 'data-area': 'Actions', className: cls('DivMessageHorizontalContainer', m.mine ? 'h mine' : 'h') },
      h('a', { href: `/@${author}`, onClick: (e) => e.preventDefault() }, h('img', { 'data-e2e': 'chat-avatar', src: PIXEL, alt: '' })),
      h('div', null, h(MessageContent, { m })),
      h('div', { 'data-e2e': 'dm-warning' }, m.failed ? h('svg', { className: cls('StyledIconFail'), width: 14, height: 14 }) : null),
      h('div', { className: cls('DivActions') },
        h('div', { 'data-e2e': 'dm-new-more-btn', role: 'button', ...(sdk ? { id: `more-action-icon-msg-${m.serverId || `pending-${m.clientId}`}` } : {}) }, '⋯'))),
    m.notice ? h('div', { 'data-e2e': 'dm-message-notification', className: cls('DivErrorTip') }, m.notice) : null);
  return sdk ? h('div', { 'data-index': m.clientId }, item) : item;
}

// ---- composer (real Draft.js) --------------------------------------------------------------------

function Composer({ conv }) {
  const [editorState, setEditorState] = React.useState(() => (conv.draft
    ? EditorState.createWithContent(ContentState.createFromText(conv.draft))
    : EditorState.createEmpty()));
  // The parent component's state in the real app: filled ONLY through Draft's onChange, and it is
  // this text that gets sent. DOM writes that bypass Draft never reach it.
  const [text, setText] = React.useState(conv.draft || '');
  const textRef = React.useRef(text);
  textRef.current = text;
  composerText = text;

  const onChange = (next) => {
    setEditorState(next);
    const plain = next.getCurrentContent().getPlainText();
    setText(plain);
    if (plain !== conv.draft) { conv.draft = plain; try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ } }
  };
  const onPost = (via, trusted) => {
    const value = textRef.current.trim();
    if (!value) return;
    onChange(EditorState.createEmpty());
    post(conv.id, value, via, trusted);
  };
  // Any Enter keydown sends, Shift+Enter included (verbatim behaviour of the live build).
  const lastEnterTrusted = React.useRef(null);
  const keyBindingFn = (e) => {
    if (e.keyCode === 13) { lastEnterTrusted.current = e.nativeEvent ? e.nativeEvent.isTrusted : null; return 'custom-enter'; }
    return getDefaultKeyBinding(e);
  };
  const handleKeyCommand = (cmd) => {
    if (cmd !== 'custom-enter') return 'not-handled';
    setTimeout(() => onPost('enter', lastEnterTrusted.current), 0);
    return 'handled';
  };
  const handlePastedText = (pasted, _html, es) => {
    const room = MAX_INPUT - es.getCurrentContent().getPlainText().length;
    if (pasted.length <= room) return 'not-handled'; // Draft inserts it itself, newlines kept
    const content = Modifier.replaceText(es.getCurrentContent(), es.getSelection(), pasted.slice(0, Math.max(0, room)));
    onChange(EditorState.push(es, content, 'insert-characters'));
    return 'handled';
  };

  return h('div', { className: cls('DivMessageInputAndSendButton', 'composer') },
    h('div', { 'data-e2e': 'message-input-area', className: 'input-area' },
      h('div', { 'data-e2e': 'dm-new-input-editor', className: 'editor' },
        h(Editor, {
          editorState, onChange, keyBindingFn, handleKeyCommand, handlePastedText,
          stripPastedStyles: true, placeholder: 'Send a message...', ariaLabel: 'Send a message...', role: 'textbox',
        })),
      h('div', { 'data-e2e': 'dm-new-emoji-btn', role: 'button' }, '☺')),
    text.trim() !== ''
      ? h('div', {
        'data-e2e': 'dm-new-send-btn', role: 'button', 'aria-label': 'Send', tabIndex: 0, className: cls('StyledSendButton', 'send'),
        onClick: (e) => { if (!quirks.ignoreSendClick) onPost('click', e.nativeEvent.isTrusted); },
      }, '➤')
      : null);
}

function StrangerBox({ conv }) {
  const sdk = state.variant === 'sdk';
  return h('div', { className: cls('DivStrangerBox', 'stranger'), ...(sdk ? { 'data-e2e': 'dm-new-stranger-accept' } : {}) },
    h('p', null, `${conv.peer.nickname} wants to send you a message`),
    h('p', null, 'Accepting this request will let you reply to this chat immediately. This account can send you up to 1 message before you accept.'),
    h('div', { className: 'buttons' },
      h('div', { role: 'button', ...(sdk ? { 'data-e2e': 'dm-new-stranger-block' } : {}) }, 'Block'),
      h('div', { role: 'button' }, 'Delete'),
      h('div', { role: 'button', onClick: () => window.mock.accept(conv.id) }, 'Accept')));
}

function ChatBox() {
  const conv = state.convs.find((c) => c.id === state.openId);
  if (!conv) return h('div', { className: 'empty' }, 'Select a conversation');
  const sdk = state.variant === 'sdk';
  const loading = loadingId === conv.id;
  return h('div', { 'data-e2e': 'dm-new-chatbox', className: cls('DivChatBox', 'chat') },
    h('header', { className: cls('DivChatHeader') },
      conv.group ? null : h('a', { href: `/@${conv.peer.uniqueId}`, onClick: (e) => e.preventDefault() }, h('img', { 'data-e2e': 'top-chat-avatar', src: PIXEL, alt: '' })),
      h('p', { 'data-e2e': 'dm-new-chat-nickname', className: cls('PNickname') }, conv.peer.nickname),
      conv.group ? null : h('p', { 'data-e2e': 'chat-uniqueid', className: cls('PUniqueId') }, `@${conv.peer.uniqueId}`)),
    h('div', { 'data-e2e': 'dm-new-message-list', role: 'log', 'aria-live': 'polite', className: 'messages' },
      loading ? null : h('div', { className: cls('DivTimeContainer', 'separator'), ...(sdk ? { 'data-e2e': 'dm-new-time-separator' } : {}) }, h('span', null, '10:42 AM')),
      loading ? null : conv.messages.map((m) => h(Message, { key: m.clientId, m, conv }))),
    h('div', { 'data-e2e': 'dm-new-chat-bottom', className: cls('DivChatBottom') },
      conv.request ? h(StrangerBox, { conv }) : h(Composer, { key: conv.id, conv })));
}

function Overlays() {
  return createPortal(h(React.Fragment, null,
    state.toast ? h('div', { role: 'alert', className: cls('DivToastContainer', 'toast') }, state.toast) : null,
    state.captcha ? h('div', { id: 'captcha-verify-container', className: 'captcha' }, 'Verify to continue: drag the slider to fit the puzzle') : null),
  document.getElementById('portal'));
}

function App() {
  useStore();
  return h(React.Fragment, null,
    h('div', { className: 'layout' }, h(ConversationList), h(ChatBox)),
    h(Overlays));
}

createRoot(document.getElementById('app')).render(h(App));
window.mock.ready = true;
