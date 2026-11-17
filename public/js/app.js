// App shell: sign in, navigation, the 5 second poll, and the bits every screen shares.
import { api, get, post, setSignedOutHandler } from './api.js';
import { $, $$, html, icon, raw, setHTML, toast, toastError, refreshTimes, confirmDialog, friendly } from './ui.js';
import authScreen from './screens/auth.js';
import live from './screens/live.js';
import urgent from './screens/urgent.js';
import inbox from './screens/inbox.js';
import knowledge from './screens/knowledge.js';
import voice from './screens/voice.js';
import recovery from './screens/recovery.js';
import discounts from './screens/discounts.js';
import sales from './screens/sales.js';
import connections from './screens/connections.js';
import health from './screens/health.js';
import more from './screens/more.js';

const SCREENS = { live, urgent, inbox, knowledge, voice, recovery, sales, discounts, connections, health, more };
const NAV = [
  ['live', 'Live', 'i-live'], ['urgent', 'Urgent', 'i-urgent'], ['inbox', 'Inbox', 'i-inbox'], ['knowledge', 'Knowledge', 'i-knowledge'],
  ['voice', 'Voice', 'i-voice'], ['recovery', 'Recovery', 'i-recovery'], ['sales', 'Sales', 'i-shop'], ['discounts', 'Discount codes', 'i-tag'], ['connections', 'Connections', 'i-plug'], ['health', 'Health', 'i-health'],
];
const TABS = [['live', 'Live', 'i-live'], ['inbox', 'Inbox', 'i-inbox'], ['urgent', 'Urgent', 'i-urgent'], ['recovery', 'Recovery', 'i-recovery'], ['more', 'More', 'i-more']];
const UNDER_MORE = ['knowledge', 'voice', 'sales', 'discounts', 'connections', 'health', 'more'];
// Refresh every 15 seconds while someone is using the page. Each refresh reads the database, and the
// free plan allows 5 million rows a day, so an open but idle page stops refreshing after 10 minutes.
const POLL_MS = 15000;
const IDLE_MS = 10 * 60 * 1000;

const root = $('#root');
const state = { overview: null, overviewError: null, signedIn: false, current: null, route: '', timer: null, shell: false };
const overviewListeners = new Set();

// ---- Shared context handed to every screen ----------------------------------------------------------
export const ctx = {
  get overview() { return state.overview; },
  get overviewError() { return state.overviewError; },
  refreshOverview,
  onOverview(fn) { overviewListeners.add(fn); return () => overviewListeners.delete(fn); },
  setAgent,
  panic,
  signOut,
  go(hash) { location.hash = hash; },
  setTitle(t) { state.title = t; paintTitle(); },
};

export function urgentCount(ov = state.overview) {
  return ov ? (ov.counts?.urgent_open || 0) + (ov.counts?.review_pending || 0) : 0;
}

export function agentStatus(ov = state.overview) {
  if (!ov) return { key: 'unknown', pill: 'pill--pause', dot: 'dot--pause', label: 'Checking', line: 'Checking on the agent', sub: '' };
  const device = ov.device;
  if (!ov.agent?.enabled) return { key: 'off', pill: 'pill--pause', dot: 'dot--pause', label: 'Agent off', line: 'Switched off.', sub: 'Nothing is being sent. Customers wait until you switch it back on.' };
  if (!device) return { key: 'unpaired', pill: 'pill--wait', dot: 'dot--wait', label: 'No laptop yet', line: 'Waiting for a laptop.', sub: 'Pair your laptop so the agent can read and send messages.' };
  if (!device.online) return { key: 'offline', pill: 'pill--down', dot: 'dot--down', label: 'Laptop offline', line: 'Laptop offline.', sub: 'Open the laptop and leave Chrome running. Replies wait until it is back.' };
  if (device.status?.paused_locally) return { key: 'paused', pill: 'pill--pause', dot: 'dot--pause', label: 'Paused on laptop', line: 'Paused on the laptop.', sub: 'Press resume in the extension on your laptop to carry on.' };
  return { key: 'live', pill: 'pill--live', dot: 'dot--live', label: 'Online', line: 'Online. Handling it.', sub: '' };
}

// ---- Boot ---------------------------------------------------------------------------------------------
setSignedOutHandler(() => { if (state.signedIn) { state.signedIn = false; showAuth('login', 'You were signed out. Sign in again to carry on.'); } });

async function boot() {
  let session;
  try {
    session = await api('/api/session', { quiet401: true });
  } catch (err) {
    setHTML(root, html`<main class="auth"><div class="card auth__card stack"><h1 class="title">Cannot reach ACX Agent</h1><p class="muted">${friendly(err, 'Check your internet connection and try again.')}</p><button class="btn btn--primary btn--block" type="button" id="boot-retry">Try again</button></div></main>`);
    $('#boot-retry').onclick = () => boot();
    return;
  }
  if (!session.setup_done) return showAuth('setup');
  if (!session.signed_in) return showAuth('login');
  startApp();
}

function showAuth(mode, note) {
  stopPolling();
  if (state.current?.destroy) state.current.destroy();
  state.current = null; state.shell = false; state.overview = null;
  document.title = 'ACX Agent';
  authScreen.mount(root, { mode, note, onDone: startApp });
}

function startApp() {
  state.signedIn = true;
  renderShell();
  route();
  refreshOverview();
  startPolling();
}

// ---- Shell --------------------------------------------------------------------------------------------
function renderShell() {
  state.shell = true;
  setHTML(root, html`<div class="app">
    <a class="skip" href="#main">Skip to content</a>
    <aside class="side" aria-label="Main">
      <a class="brand" href="#/live"><img class="brand__logo" src="/img/logo.png" alt="ACX Ebikes" width="142" height="36"><span class="brand__tag">Agent</span></a>
      <nav class="nav" aria-label="Screens">
        ${NAV.map(([id, label, ic]) => html`<a class="nav__item" href="#/${id}" data-nav="${id}">${icon(ic, 'nav__icon')}<span class="nav__label">${label}</span>${id === 'urgent' ? raw('<span class="count count--urgent nav__count" data-urgent-count hidden>0</span>') : ''}</a>`)}
      </nav>
      <div class="side__foot">
        <label class="switch"><input type="checkbox" role="switch" id="side-agent" aria-label="Agent on"><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span><span class="switch__label"><span data-agent-label>Agent</span><span class="switch__hint" data-agent-hint>Checking</span></span></label>
      </div>
    </aside>
    <header class="top">
      <h1 class="title" id="screen-title" tabindex="-1">ACX Agent</h1>
      <div class="top__spacer"></div>
      <span class="sr-only" role="status" aria-live="polite" id="urgent-announce"></span>
      <a class="pill pill--pause top__status" href="#/live" id="top-status"><span class="dot dot--pause" aria-hidden="true"></span><span>Checking</span></a>
    </header>
    <main class="main" id="main"><div id="view"></div></main>
    <nav class="tabs" aria-label="Screens">
      ${TABS.map(([id, label, ic]) => html`<a class="tab ${id === 'urgent' ? 'tab--urgent' : ''}" href="#/${id}" data-tab="${id}">${icon(ic, 'tab__icon')}<span>${label}</span>${id === 'urgent' ? raw('<span class="count count--urgent" data-urgent-count hidden>0</span>') : ''}</a>`)}
    </nav>
  </div>`);
  $('#side-agent').addEventListener('change', (e) => setAgent(e.target.checked));
}

function paintTitle() {
  const n = urgentCount();
  const t = state.title || 'ACX Agent';
  const h = $('#screen-title');
  if (h && h.textContent !== t) h.textContent = t;
  document.title = `${n ? `(${n}) ` : ''}${t} · ACX Agent`;
}

function paintShell() {
  if (!state.shell) return;
  const ov = state.overview;
  const n = urgentCount();
  for (const b of $$('[data-urgent-count]')) { b.textContent = n > 99 ? '99+' : String(n); b.hidden = n === 0; b.setAttribute('aria-label', `${n} waiting on you`); }
  for (const t of $$('.tab--urgent')) t.classList.toggle('has-urgent', n > 0);
  const announce = $('#urgent-announce');
  if (announce && announce.dataset.n !== String(n)) {
    if (announce.dataset.n !== undefined && n > Number(announce.dataset.n)) announce.textContent = `${n} waiting on you in Urgent`;
    announce.dataset.n = String(n);
  }
  if ('setAppBadge' in navigator) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  const s = agentStatus(ov);
  const pill = $('#top-status');
  if (pill) {
    pill.className = `pill ${s.pill} top__status`;
    pill.firstElementChild.className = `dot ${s.dot}`;
    pill.lastElementChild.textContent = state.overviewError && !ov ? 'No connection' : s.label;
  }
  const sw = $('#side-agent');
  if (sw && ov) {
    if (document.activeElement !== sw || sw.checked === ov.agent.enabled) sw.checked = Boolean(ov.agent.enabled);
    $('[data-agent-label]').textContent = ov.agent.enabled ? 'Agent on' : 'Agent off';
    $('[data-agent-hint]').textContent = ov.agent.enabled ? 'Replies on its own' : 'Nothing is sent';
  }
  paintTitle();
}

// ---- Overview (shared by the badge, the status pill and the Live screen) ----------------------------------
let overviewInFlight = null;
export function refreshOverview() {
  if (overviewInFlight) return overviewInFlight;
  overviewInFlight = get('/api/overview').then((ov) => {
    state.overview = ov; state.overviewError = null;
  }).catch((err) => {
    if (err.name !== 'AuthError') state.overviewError = err;
  }).finally(() => {
    overviewInFlight = null;
    paintShell();
    for (const fn of overviewListeners) { try { fn(state.overview, state.overviewError); } catch (e) { console.error(e); } }
  });
  return overviewInFlight;
}

async function setAgent(enabled) {
  const ov = state.overview;
  const before = ov?.agent?.enabled;
  if (ov) { ov.agent.enabled = enabled; paintShell(); for (const fn of overviewListeners) fn(ov, null); }   // optimistic
  try {
    await post('/api/agent-toggle', { enabled });
    toast(enabled ? 'Agent is on. It replies on its own again.' : 'Agent is off. Nothing will be sent.', { type: enabled ? 'ok' : 'warn' });
  } catch (err) {
    if (ov) { ov.agent.enabled = before; paintShell(); for (const fn of overviewListeners) fn(ov, null); }
    toastError(err, 'Could not change the switch. Check your connection and try again.');
  }
  refreshOverview();
}

async function panic() {
  const yes = await confirmDialog({
    title: 'Stop everything now?',
    text: 'The agent switches off and every message that is waiting to send is thrown away. Customers get no reply until you switch it back on.',
    confirm: 'Stop everything', cancel: 'Keep going', danger: true,
  });
  if (!yes) return;
  try {
    const res = await post('/api/panic');
    toast(`Stopped. Agent is off and ${res.cancelled || 0} waiting ${res.cancelled === 1 ? 'message was' : 'messages were'} cancelled.`, { type: 'warn', ms: 7000 });
  } catch (err) { toastError(err, 'Could not stop it. Check your connection and try again straight away.'); }
  refreshOverview();
}

async function signOut() {
  try { await post('/api/logout'); } catch { /* signing out locally anyway */ }
  state.signedIn = false;
  showAuth('login', 'You are signed out.');
}

// ---- Router ---------------------------------------------------------------------------------------------
function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  return { name: SCREENS[parts[0]] ? parts[0] : 'live', params: parts.slice(1) };
}

function route() {
  if (!state.shell) return;
  const { name, params } = parseHash();
  const key = `${name}/${params.join('/')}`;
  const screen = SCREENS[name];
  // Same screen, new params: let the screen handle it without a full remount when it can.
  if (state.current && state.route.split('/')[0] === name && state.current.update) {
    state.route = key;
    state.current.update(params);
    markNav(name);
    return;
  }
  if (state.current?.destroy) { try { state.current.destroy(); } catch (e) { console.error(e); } }
  overviewListeners.clear();
  state.route = key;
  const view = document.createElement('div');
  view.className = `main__inner ${screen.focus ? 'main__inner--focus' : ''} view view--${name}`;
  $('#view').replaceWith(view); view.id = 'view';
  state.title = screen.title;
  markNav(name);
  paintTitle();
  window.scrollTo(0, 0);
  try {
    state.current = screen.mount(view, ctx, params) || {};
  } catch (err) {
    console.error(err);
    state.current = {};
    setHTML(view, html`<div class="card notice"><p>This screen hit a problem. Reload the page to try again.</p><button class="btn btn--ghost" type="button" onclick="location.reload()">Reload</button></div>`);
  }
}

function markNav(name) {
  for (const a of $$('[data-nav]')) a.dataset.nav === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  for (const a of $$('[data-tab]')) {
    const on = a.dataset.tab === name || (a.dataset.tab === 'more' && UNDER_MORE.includes(name));
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  }
}

window.addEventListener('hashchange', route);

// ---- Polling: every 15 seconds, only while the tab is visible and in use -----------------------------------
let lastActive = Date.now();
let idlePaused = false;
for (const ev of ['pointerdown', 'keydown', 'scroll', 'touchstart', 'focus']) {
  window.addEventListener(ev, () => {
    lastActive = Date.now();
    if (idlePaused && !document.hidden && state.signedIn) { idlePaused = false; tick(); }
  }, { passive: true, capture: true });
}
async function tick() {
  if (document.hidden || !state.signedIn) return;
  if (Date.now() - lastActive > IDLE_MS) { idlePaused = true; return; }
  refreshOverview();
  try { await state.current?.tick?.(); } catch (err) { if (err?.name !== 'AuthError') console.warn('refresh failed', err?.message); }
  refreshTimes();
}
function startPolling() { stopPolling(); state.timer = setInterval(tick, POLL_MS); }
function stopPolling() { if (state.timer) clearInterval(state.timer); state.timer = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.signedIn) { lastActive = Date.now(); idlePaused = false; tick(); } });

// Keyboard height, so sticky bars sit above the phone keyboard.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const sync = () => {
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb', kb + 'px');
    document.documentElement.classList.toggle('has-kb', kb > 120);
  };
  vv.addEventListener('resize', sync); vv.addEventListener('scroll', sync);
}

// Cmd or Ctrl + Enter sends from any form that asks for it.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    const form = e.target.closest && e.target.closest('form[data-quick-send]');
    if (form) { e.preventDefault(); form.requestSubmit(); }
  }
});
// Remember that the owner has typed in a box, so background refreshes leave it alone.
document.addEventListener('input', (e) => { if (e.target.matches && e.target.matches('textarea, input[type="text"]')) e.target.dataset.dirty = e.target.value ? '1' : '0'; });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'navigate' && typeof e.data.url === 'string') { const u = new URL(e.data.url, location.origin); if (u.hash) location.hash = u.hash; } });
}

boot();
