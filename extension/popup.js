// Popup: pair this laptop, see what each tab is doing, pause, run a check.
import { parsePairingString } from './lib/api.js';
import * as store from './lib/store.js';

const $ = (id) => document.getElementById(id);
const LABEL = { whatsapp: 'WhatsApp', gmail: 'Gmail', tiktok: 'TikTok' };
const STATE_TEXT = {
  ready: 'Working', no_tab: 'Tab is closed', loading: 'Loading', logged_out: 'Log in on that tab',
  blocked: 'Needs your attention', error: 'Problem on the page',
};

/** "just now", "1 min ago", "3 hours ago": plain words, no dashes. */
function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** Second line under a channel: when it last read the chats, and what went wrong last. */
function healthLine(ch, mode) {
  const bits = [];
  if (mode !== 'off' && ch.state !== 'no_tab') bits.push(ch.last_ok_at ? `Last read ${ago(ch.last_ok_at)}` : 'Not read yet');
  if (ch.last_error) bits.push(`Problem: ${ch.last_error}`);
  else if (ch.last_recovery && ch.last_recovery_at && Date.now() - ch.last_recovery_at < 3 * 3600_000) bits.push(`Fixed itself ${ago(ch.last_recovery_at)}`);
  if (ch.recoveries) bits.push(`${ch.recoveries} fix${ch.recoveries === 1 ? '' : 'es'} today`);
  return bits.join('. ').replace(/[\u2013\u2014]/g, ' ');
}

const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage({ acx: true, ...msg }, (res) => resolve(chrome.runtime.lastError ? null : res)));

async function render() {
  const st = await store.get(['auth', 'paused', 'config', 'status', 'trusted_input', 'auto_open_tabs', 'me', 'lanes']);
  const paired = Boolean(st.auth?.token);
  $('pair-view').hidden = paired;
  $('main-view').hidden = !paired;
  if (!paired) {
    document.body.dataset.state = 'off';
    $('pill').textContent = 'SET UP';
    $('sub').textContent = 'Not connected yet';
    return;
  }
  const serverOff = st.config && st.config.enabled === false;
  const err = st.status?.last_error || '';
  const state = err ? 'error' : st.paused || serverOff ? 'off' : 'on';
  document.body.dataset.state = state;
  $('pill').textContent = state === 'on' ? 'ON' : state === 'error' ? 'ERROR' : 'OFF';
  // Whose laptop it is (named at pairing, changed on the dashboard), then the server.
  const person = String(st.me?.person ?? st.auth?.person ?? '').trim();
  const who = person ? `${person}’s laptop. ` : '';
  $('sub').textContent = err ? err : st.paused ? 'Paused on this laptop' : serverOff ? 'Switched off in the dashboard' : `${who}${new URL(st.auth.server_url).host}`;
  $('server-error').hidden = !err;
  $('server-error').textContent = err;
  $('pause-btn').textContent = st.paused ? 'Resume' : 'Pause';
  $('trusted').checked = Boolean(st.trusted_input);
  $('auto-open').checked = Boolean(st.auto_open_tabs);

  const list = $('channels');
  list.textContent = '';
  for (const name of Object.keys(LABEL)) {
    const ch = st.status?.channels?.[name] || { state: 'no_tab', detail: '', unread: 0 };
    const mode = st.config?.channels?.[name]?.mode;
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `dot ${ch.state === 'ready' ? 'ready' : ch.state === 'loading' || ch.state === 'no_tab' ? 'warn' : 'bad'}`;
    const nm = document.createElement('span');
    nm.className = 'name';
    nm.textContent = LABEL[name];
    const detail = document.createElement('span');
    detail.className = 'detail';
    // Another laptop answers this channel (or this tab is on another account): this one only keeps an eye on it.
    const grant = st.lanes && st.lanes[`${name}:inbox`];
    const other = grant?.leader?.device_id && grant.leader.device_id !== st.auth?.device_id;
    const leader = grant?.leader?.person ? `${grant.leader.person}’s laptop` : 'Another laptop';
    const role = grant && grant.role === 'standby' && other ? `Ready. ${leader} answers it` : grant && grant.role === 'other_account' ? 'Ready. Signed in to another account, so it stays idle' : '';
    detail.textContent = mode === 'off' ? 'Switched off' : ch.state === 'ready' ? role || `${mode === 'review' ? 'Working, asks you first' : 'Working'}${name === 'gmail' && (ch.detail || '').includes('@') ? ` (${ch.detail})` : ''}` : (ch.detail || STATE_TEXT[ch.state] || ch.state);
    li.append(dot, nm, detail);
    const show = document.createElement('button');
    show.className = 'show';
    show.type = 'button';
    show.textContent = 'Show';
    show.title = `Go to the ${LABEL[name]} tab the agent uses`;
    show.addEventListener('click', () => send({ type: 'show_tab', channel: name }));
    li.append(show);
    if (ch.unread) {
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(ch.unread);
      count.title = 'Unread chats';
      li.append(count);
    }
    const line = healthLine(ch, mode);
    if (line) {
      const meta = document.createElement('small');
      meta.className = `meta${ch.last_error ? ' bad' : ''}`;
      meta.textContent = line;
      li.append(meta);
    }
    list.append(li);
  }
}

$('pair-btn').addEventListener('click', async () => {
  const errEl = $('pair-error');
  errEl.hidden = true;
  const line = $('pairing').value;
  let parsed;
  try { parsed = parsePairingString(line); } catch (e) { errEl.textContent = e.message; errEl.hidden = false; return; }
  // Chrome only lets an extension talk to servers it has permission for. Ask while we are still
  // inside the click (the request must come from a user action).
  const origin = `${parsed.server_url}/*`;
  let allowed = await chrome.permissions.contains({ origins: [origin] });
  if (!allowed) {
    try { allowed = await chrome.permissions.request({ origins: [origin] }); } catch { allowed = false; }
  }
  if (!allowed) { errEl.textContent = 'Chrome needs your permission to talk to that address. Press Connect again and allow it.'; errEl.hidden = false; return; }
  $('pair-btn').disabled = true;
  $('pair-btn').textContent = 'Connecting';
  const res = await send({ type: 'pair', pairing_string: line, name: $('device-name').value.trim() || 'My laptop', person: $('person').value.trim() });
  $('pair-btn').disabled = false;
  $('pair-btn').textContent = 'Connect';
  if (!res?.ok) { errEl.textContent = res?.error || 'Could not connect. Check the pairing line and try again.'; errEl.hidden = false; return; }
  render();
});

$('pause-btn').addEventListener('click', async () => {
  const paused = await store.get('paused');
  await send({ type: 'pause', paused: !paused });
  render();
});

$('dash-btn').addEventListener('click', async () => {
  const auth = await store.get('auth');
  if (auth?.server_url) chrome.tabs.create({ url: auth.server_url });
});

$('auto-open').addEventListener('change', (e) => store.set({ auto_open_tabs: e.target.checked }));

$('trusted').addEventListener('change', async (e) => {
  if (e.target.checked) {
    let ok = false;
    try { ok = await chrome.permissions.request({ permissions: ['debugger'] }); } catch { ok = false; }
    if (!ok) { e.target.checked = false; return; }
  }
  await store.set({ trusted_input: e.target.checked });
});

$('test-btn').addEventListener('click', async () => {
  const out = $('test-out');
  out.hidden = false;
  out.textContent = 'Checking each tab...';
  const res = await send({ type: 'selftest' });
  if (!res?.ok) { out.textContent = 'Could not run the check.'; return; }
  const lines = [];
  for (const [name, r] of Object.entries(res.results)) {
    lines.push(`${LABEL[name] || name}`);
    if (!r.ok) { lines.push(`  ${r.error || r.error_code}`); continue; }
    for (const c of r.data?.checks || []) lines.push(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
    if (!(r.data?.checks || []).length) lines.push('  nothing to check');
  }
  out.textContent = lines.join('\n');
});

$('unpair-btn').addEventListener('click', async () => {
  await send({ type: 'unpair' });
  render();
});

chrome.storage.onChanged.addListener(render);
setInterval(render, 30_000); // keeps "Last read 2 min ago" current while the popup is open
send({ type: 'tick' });
render();
