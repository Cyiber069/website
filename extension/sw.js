// ACX Agent service worker: pairs with the dashboard server, keeps the three tabs alive, asks each
// tab what is new, sends new customer messages to the server and types the replies it gets back.
import * as api from './lib/api.js';
import * as store from './lib/store.js';

const VERSION = chrome.runtime.getManifest().version;

const CHANNELS = {
  whatsapp: { match: ['https://web.whatsapp.com/*'], home: 'https://web.whatsapp.com/' },
  gmail: { match: ['https://mail.google.com/*'], home: 'https://mail.google.com/mail/u/0/#inbox' },
  // A logged out TikTok redirects /messages to /login: treat that tab as ours so no new tab is opened each cycle.
  tiktok: { match: ['https://www.tiktok.com/messages*', 'https://www.tiktok.com/login*'], home: 'https://www.tiktok.com/messages?lang=en' },
};
const NAMES = Object.keys(CHANNELS);

const TICK_ALARM = 'acx-tick';
const MAX_THREADS_PER_CYCLE = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tabs -------------------------------------------------------------------------------------------

/** The Gmail address the owner chose in the dashboard, or '' for Chrome's first account. */
async function gmailAccount() {
  const cfg = await store.get('config');
  return String(cfg?.gmail_account || '').trim().toLowerCase();
}

function homeUrl(channel, account) {
  // Gmail picks the signed-in account from ?authuser=<address> (a /u/<address>/ path gives a 404).
  if (channel === 'gmail' && account) return `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#inbox`;
  return CHANNELS[channel].home;
}

/** True for a page of the channel's own site that is not a sign in page. */
function isOwnSitePage(channel, url) {
  let u;
  try { u = new URL(url || ''); } catch { return false; }
  if (channel === 'tiktok') return u.hostname === 'www.tiktok.com' && !/^\/(login|signup)/.test(u.pathname);
  if (channel === 'whatsapp') return u.hostname === 'web.whatsapp.com';
  if (channel === 'gmail') return u.hostname === 'mail.google.com';
  return false;
}

async function findTab(channel) {
  const tabs = await chrome.tabs.query({ url: CHANNELS[channel].match });
  if (!tabs.length) return null;
  if (channel === 'gmail') {
    // Gmail puts the account address in the tab title: prefer the tab showing the chosen inbox.
    const account = await gmailAccount();
    const mine = account ? tabs.find((t) => (t.title || '').toLowerCase().includes(account)) : null;
    if (mine) return mine;
  }
  // Prefer a pinned tab, then the oldest: stable choice when the owner opened the site twice.
  tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.id - b.id);
  return tabs[0];
}

async function ensureTab(channel, autoOpen) {
  let tab = await findTab(channel);
  if (!tab) {
    // A tab we opened may have been redirected to a sign in page on another address. Do not open
    // another one every cycle: keep it, and report it as logged out.
    const opened = await store.sessionGet('opened_tabs', {});
    if (opened[channel]) {
      try {
        const away = await chrome.tabs.get(opened[channel]);
        // Signed in, but the site moved the tab to another of its own pages (TikTok goes to the
        // home feed after logging in): bring it back to the page the agent works on.
        // Only once every 10 minutes: if the site keeps moving it away, stop and say where it went
        // instead of reloading it forever.
        const tries = await store.sessionGet('return_tries', {});
        const last = tries[channel] || 0;
        if (isOwnSitePage(channel, away.url) && Date.now() - last > 10 * 60_000) {
          tries[channel] = Date.now();
          await store.sessionSet('return_tries', tries);
          await chrome.tabs.update(away.id, { url: homeUrl(channel, channel === 'gmail' ? await gmailAccount() : '') });
          return { ...away, status: 'loading' };
        }
        return { ...away, acxAway: true, acxOwnSite: isOwnSitePage(channel, away.url) };
      } catch { delete opened[channel]; await store.sessionSet('opened_tabs', opened); }
    }
    if (autoOpen) {
      try {
        tab = await chrome.tabs.create({ url: homeUrl(channel, channel === 'gmail' ? await gmailAccount() : ''), active: false, pinned: true });
        opened[channel] = tab.id;
        await store.sessionSet('opened_tabs', opened);
      } catch { tab = null; }
    }
  }
  if (tab && tab.autoDiscardable !== false) {
    // Stop Memory Saver from unloading the tab while the agent depends on it.
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch { /* tab closed */ }
  }
  return tab;
}


/** Ask a tab's adapter to do something. Resolves to { ok, data } or { ok:false, error_code, error, retryable }. */
async function tabOp(channel, op, args, timeoutMs = 30_000) {
  const tab = await findTab(channel);
  if (!tab) return { ok: false, error_code: 'tab_missing', error: `No ${channel} tab is open`, retryable: true };
  const call = new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { acx: true, op, args }, (res) => {
      if (chrome.runtime.lastError || !res) {
        resolve({ ok: false, error_code: 'no_content_script', error: chrome.runtime.lastError?.message || 'The page did not answer', retryable: true });
      } else resolve(res);
    });
  });
  const timeout = sleep(timeoutMs).then(() => ({ ok: false, error_code: 'timeout', error: `${op} took longer than ${Math.round(timeoutMs / 1000)}s`, retryable: true }));
  const res = await Promise.race([call, timeout]);
  if (!res.ok && res.error_code === 'no_content_script' && tab.status === 'complete') {
    // The tab was open before the extension was installed or updated: reload it once so our script loads.
    // Remembered in session storage: this worker is stopped and started again every few seconds, so an
    // in-memory timestamp would let a page that never answers (offline error page) reload on every wake.
    const now = Date.now();
    const reloadedAt = await store.sessionGet('reloaded_at', {});
    if (now - (reloadedAt[channel] || 0) > 5 * 60_000) {
      reloadedAt[channel] = now;
      await store.sessionSet('reloaded_at', reloadedAt);
      try { await chrome.tabs.reload(tab.id); } catch { /* ignore */ }
    }
  }
  return res;
}

// ---- status -----------------------------------------------------------------------------------------

const busy = Object.fromEntries(NAMES.map((n) => [n, false]));

async function probeAll(autoOpen) {
  const out = {};
  await Promise.all(NAMES.map(async (channel) => {
    const tab = await ensureTab(channel, autoOpen);
    if (!tab) { out[channel] = { state: 'no_tab', detail: 'Tab is not open', unread: 0, busy: false }; return; }
    if (tab.acxAway) {
      let where = '';
      try { where = new URL(tab.url).pathname; } catch { /* no url */ }
      out[channel] = tab.acxOwnSite
        ? { state: 'error', detail: `The tab is on ${where}, not the messages page. Open the messages page in that tab`, unread: 0, busy: false }
        : { state: 'logged_out', detail: 'Log in on that tab', unread: 0, busy: false };
      return;
    }
    if (channel === 'tiktok' && /\/login/.test(new URL(tab.url || 'https://x/').pathname)) { out[channel] = { state: 'logged_out', detail: 'Log in to TikTok on that tab', unread: 0, busy: false }; return; }
    if (tab.status !== 'complete') { out[channel] = { state: 'loading', detail: 'Page is loading', unread: 0, busy: busy[channel] }; return; }
    const res = await tabOp(channel, 'probe', {}, 8000);
    if (res.ok && res.data) out[channel] = { state: res.data.state || 'error', detail: res.data.detail || '', unread: res.data.unread || 0, busy: busy[channel] };
    else out[channel] = { state: res.error_code === 'no_content_script' ? 'loading' : 'error', detail: res.error || '', unread: 0, busy: busy[channel] };
  }));
  return out;
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* action API unavailable */ }
}

// ---- jobs -------------------------------------------------------------------------------------------

async function waitForReady(channel, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(1500);
    const tab = await findTab(channel);
    if (!tab || tab.status !== 'complete') continue;
    const res = await tabOp(channel, 'probe', {}, 6000);
    if (res.ok && res.data?.state === 'ready') return true;
    if (res.ok && (res.data?.state === 'logged_out' || res.data?.state === 'blocked')) return false;
  }
  return false;
}

async function runJob(channel, job) {
  if (await store.isDone(job.id)) {
    // Already typed and sent, but the confirmation was lost. Confirm again, never send twice.
    await api.jobResult(job.id, { status: 'sent' }).catch(() => {});
    return;
  }
  busy[channel] = true;
  try {
    const delay = Math.min(Math.max(0, job.pacing?.delay_ms ?? 0), 25_000);
    if (delay) await sleep(delay);

    let prepared = { ready: true };
    if (job.kind === 'new_chat') {
      const prep = await tabOp(channel, 'prepare', { job }, 20_000);
      if (!prep.ok) { await report(job, prep); return; }
      prepared = prep.data || { ready: true };
      if (prepared.navigate) {
        const tab = await findTab(channel);
        if (!tab) { await report(job, { ok: false, error_code: 'tab_missing', error: 'Tab closed', retryable: true }); return; }
        await chrome.tabs.update(tab.id, { url: prepared.navigate });
        if (!(await waitForReady(channel, 75_000))) {
          await report(job, { ok: false, error_code: 'timeout', error: 'Page did not load after opening the chat', retryable: true });
          return;
        }
      }
    }
    const res = await tabOp(channel, 'send', { job, navigated: Boolean(prepared.navigate) }, 150_000);
    await report(job, res);
  } finally {
    busy[channel] = false;
  }
}

async function report(job, res) {
  if (res.ok) {
    await store.rememberDone(job.id);
    await api.jobResult(job.id, { status: 'sent', sent_external_ids: res.data?.sent_external_ids || [] }).catch(() => {});
  } else {
    await api.jobResult(job.id, { status: 'failed', error_code: res.error_code || 'unknown', error: res.error || '', retryable: res.retryable !== false }).catch(() => {});
  }
}

// ---- reading threads --------------------------------------------------------------------------------

/**
 * Work for one channel in one cycle: send what the server handed us, then look for threads with new
 * customer messages. A thread is only read once it has been quiet for `settle_seconds`, because
 * people often send three short messages in a row.
 */
async function channelWork(channel, jobs, config) {
  for (const job of jobs) await runJob(channel, job);
  if (config.channels?.[channel]?.mode === 'off') return;

  const scan = await tabOp(channel, 'scan', {}, 25_000);
  if (!scan.ok || !Array.isArray(scan.data?.threads)) return;
  const seenKey = `seen:${channel}`;
  const seen = await store.sessionGet(seenKey, {});
  const now = Date.now();
  const settleMs = (config.pacing?.settle_seconds ?? 12) * 1000;
  const live = new Set();
  const due = [];

  for (const t of scan.data.threads) {
    if (!t || !t.key || t.is_group) continue;
    live.add(t.key);
    const sig = String(t.sig ?? `${t.unread}|${t.preview}`);
    const prev = seen[t.key];
    if (!prev || prev.sig !== sig) seen[t.key] = { sig, since: now, reported: prev?.reported ?? null };
    const cur = seen[t.key];
    if (cur.reported !== sig && now - cur.since >= settleMs) due.push(t);
  }
  for (const k of Object.keys(seen)) if (!live.has(k) && now - (seen[k].since || 0) > 6 * 3600_000) delete seen[k];
  await store.sessionSet(seenKey, seen);

  let handled = 0;
  for (const t of due) {
    if (handled >= MAX_THREADS_PER_CYCLE) break;
    handled++;
    busy[channel] = true;
    try {
      const read = await tabOp(channel, 'read', { key: t.key }, 45_000);
      if (!read.ok || !read.data?.thread) continue;
      const thread = t.accepted ? { ...read.data.thread, just_accepted: true } : read.data.thread;
      const decision = await api.inbound({ channel, thread, messages: read.data.messages || [] });
      seen[t.key].reported = seen[t.key].sig;
      await store.sessionSet(seenKey, seen);
      busy[channel] = false;
      for (const job of decision.jobs || []) await runJob(channel, job);
    } catch (err) {
      console.warn('[acx] thread failed', channel, err?.message || err);
    } finally {
      busy[channel] = false;
    }
  }
}

// ---- the cycle ----------------------------------------------------------------------------------------

let running = false;
let again = false;

async function cycle() {
  const st = await store.get(['auth', 'paused', 'selectors', 'auto_open_tabs']);
  if (!st.auth?.token) { await setBadge('SET', '#8a8f98'); return; }

  const channels = await probeAll(st.auto_open_tabs && !st.paused);
  let res;
  try {
    res = await api.sync({ channels, paused_locally: st.paused }, st.selectors?.version ?? null, VERSION);
  } catch (err) {
    if (err.status === 401) {
      // The owner removed this laptop in the dashboard: forget the token so the popup asks to pair again.
      await store.set({ auth: null, status: { channels, last_sync_at: Date.now(), last_error: 'Not paired any more', server_ok: false } });
      await setBadge('SET', '#8a8f98');
      return;
    }
    await store.set({ status: { channels, last_sync_at: Date.now(), last_error: err.message || 'Cannot reach the server', server_ok: false } });
    await setBadge('!', '#e5484d');
    return;
  }

  const patch = { config: res.config, status: { channels, last_sync_at: Date.now(), last_error: '', server_ok: true } };
  if (res.selectors) patch.selectors = res.selectors;
  await store.set(patch);

  if (st.paused || !res.config?.enabled) { await setBadge('OFF', '#8a8f98'); return; }

  const jobsBy = Object.fromEntries(NAMES.map((n) => [n, []]));
  for (const job of res.jobs || []) if (jobsBy[job.channel]) jobsBy[job.channel].push(job);
  await Promise.all(NAMES.map(async (channel) => {
    if (channels[channel].state !== 'ready') return;
    try { await channelWork(channel, jobsBy[channel], res.config); } catch (err) { console.warn('[acx] channel failed', channel, err?.message || err); }
  }));

  const ready = NAMES.filter((n) => channels[n].state === 'ready').length;
  await setBadge(ready ? 'ON' : '!', ready ? '#30a46c' : '#f5a524');
}

/** Run a cycle now. Calls that arrive while one is running collapse into a single follow up run. */
async function tick() {
  if (running) { again = true; return; }
  running = true;
  // Extension API calls keep the worker awake during long sends (typing can take over 30 s).
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); }, 20_000);
  try {
    await cycle();
  } catch (err) {
    console.warn('[acx] cycle failed', err?.message || err);
  } finally {
    clearInterval(keepAlive);
    running = false;
    if (again) { again = false; setTimeout(tick, 1500); }
    else scheduleSoon();
  }
}

let soonTimer = null;
/** Between alarms (30 s minimum) keep a faster beat while the worker is awake. */
async function scheduleSoon() {
  if (soonTimer) clearTimeout(soonTimer);
  const cfg = await store.get('config');
  const seconds = Math.min(60, Math.max(8, cfg?.poll_seconds ?? 20));
  soonTimer = setTimeout(tick, seconds * 1000);
}

async function boot() {
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  if (!(await store.get('selectors'))) {
    // First run: use the packs bundled with the extension until the server sends its own.
    try {
      const pack = {};
      for (const name of NAMES) pack[name] = await (await fetch(chrome.runtime.getURL(`selectors/${name}.json`))).json();
      await store.set({ selectors: { version: 'bundled', pack } });
    } catch { /* the server sends a pack on first sync */ }
  }
  const st = await store.get(['auth', 'paused']);
  try {
    if (st.auth?.token && !st.paused) chrome.power.requestKeepAwake('system');
    else chrome.power.releaseKeepAwake();
  } catch { /* power API unavailable */ }
  tick();
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === TICK_ALARM) tick(); });

// ---- messages from pages and the popup ------------------------------------------------------------------

let nudgeTimer = null;
const diagSent = { at: 0, n: 0 };

async function trustedType(tabId, text) {
  if (!(await store.get('trusted_input'))) return { ok: false, error: 'trusted input is off' };
  const has = await chrome.permissions.contains({ permissions: ['debugger'] });
  if (!has) return { ok: false, error: 'debugger permission not granted' };
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
    // Without focus emulation a hidden tab silently drops the input.
    await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await chrome.debugger.sendCommand(target, 'Input.insertText', { text });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    try { await chrome.debugger.detach(target); } catch { /* not attached */ }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.acx !== true || !msg.type) return false;
  switch (msg.type) {
    case 'sleep':
      setTimeout(() => respond({ ok: true }), Math.min(Math.max(0, Number(msg.ms) || 0), 120_000));
      return true;
    case 'activity':
      if (nudgeTimer) clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(tick, 3000);
      respond({ ok: true });
      return false;
    case 'get_selectors':
      store.get('selectors').then((selectors) => respond({ selectors }));
      return true;
    case 'diag': {
      const now = Date.now();
      if (now - diagSent.at > 10 * 60_000) { diagSent.at = now; diagSent.n = 0; }
      if (++diagSent.n <= 20) api.diagnostics(msg.channel || null, msg.kind || 'note', msg.data || {}).catch(() => {});
      respond({ ok: true });
      return false;
    }
    case 'trusted_type':
      if (!sender.tab?.id) { respond({ ok: false }); return false; }
      trustedType(sender.tab.id, String(msg.text || '')).then(respond);
      return true;
    // ---- popup ----
    case 'pair':
      api.pair(msg.pairing_string, msg.name || 'Laptop').then(
        async (auth) => { await boot(); respond({ ok: true, server_url: auth.server_url }); },
        (err) => respond({ ok: false, error: err.message || 'Pairing failed' }),
      );
      return true;
    case 'unpair':
      store.set({ auth: null, config: null }).then(async () => { await setBadge('SET', '#8a8f98'); respond({ ok: true }); });
      return true;
    case 'pause':
      store.set({ paused: Boolean(msg.paused) }).then(async () => { await boot(); respond({ ok: true }); });
      return true;
    case 'tick':
      tick();
      respond({ ok: true });
      return false;
    case 'selftest':
      Promise.all(NAMES.map(async (channel) => [channel, await tabOp(channel, 'selftest', {}, 60_000)])).then((rows) => respond({ ok: true, results: Object.fromEntries(rows) }));
      return true;
    default:
      return false;
  }
});
