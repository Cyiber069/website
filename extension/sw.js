// ACX Agent service worker: pairs with the dashboard server, keeps the three tabs alive, asks each
// tab what is new, sends new customer messages to the server and types the replies it gets back.
//
// Reliability rules (the laptop runs unattended all day):
//  * every call into a tab and to the server has a time limit, and a whole cycle has one too
//  * a watchdog per channel notices a tab that stopped giving good reads and heals it step by step:
//    ask again, reload, then replace the tab, with a gap and an hourly cap, never during a send
//  * waking from sleep (idle state or a long gap between alarms) runs a cycle at once and reloads
//    tabs that do not answer
//  * a sweep every 10 minutes reports recent chats that end with a customer message, badge or not
//  * state that must survive the worker stopping lives in chrome.storage.session, not in memory
import * as api from './lib/api.js';
import { fetchMedia } from './lib/media.js';
import * as store from './lib/store.js';

const VERSION = chrome.runtime.getManifest().version;

const CHANNELS = {
  whatsapp: { label: 'WhatsApp', match: ['https://web.whatsapp.com/*'], home: 'https://web.whatsapp.com/' },
  gmail: { label: 'Gmail', match: ['https://mail.google.com/*'], home: 'https://mail.google.com/mail/u/0/#inbox' },
  // A logged out TikTok redirects /messages to /login: treat that tab as ours so no new tab is opened each cycle.
  tiktok: { label: 'TikTok', match: ['https://www.tiktok.com/messages*', 'https://www.tiktok.com/login*'], home: 'https://www.tiktok.com/messages?lang=en' },
};
const NAMES = Object.keys(CHANNELS);

const TICK_ALARM = 'acx-tick';
const MAX_THREADS_PER_CYCLE = 2;
const PROBE_MS = 8000;
// Probe states that prove the page and its script are alive (the owner may need to act, a reload would not help).
const ALIVE_STATES = ['ready', 'logged_out', 'blocked'];
// An operation that holds a tab's queue this long means the page stopped running its timers.
const STUCK_OP_MS = 5 * 60_000;
// The server is unreachable: wait this long before the next try, step by step.
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];

/** Timers of the watchdog, sweep and cycle. Tests may shorten them through storage key `timing`. */
const TIMING = {
  stall_ms: 3 * 60_000, // no good read for this long: start healing the tab
  replace_after_ms: 5 * 60_000, // still dead this long after a reload: replace the tab
  recovery_gap_ms: 5 * 60_000, // at most one reload or replace per channel in this time
  max_recoveries_per_hour: 6,
  loading_ms: 10 * 60_000, // a page that says it is loading gets this long before it counts as stuck
  sweep_ms: 10 * 60_000,
  cycle_timeout_ms: 4 * 60_000,
  wake_gap_ms: 150_000, // alarms fire every 30 s: a longer gap means the laptop slept
  wake_probe_ms: 10_000,
};

async function timing() {
  const t = { ...TIMING };
  try {
    const o = await store.get('timing');
    if (o && typeof o === 'object') {
      for (const k of Object.keys(t)) {
        const min = k === 'max_recoveries_per_hour' ? 1 : 1000;
        if (typeof o[k] === 'number' && Number.isFinite(o[k]) && o[k] >= min) t[k] = o[k];
      }
    }
  } catch { /* defaults */ }
  return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** "40 s" or "3 min": how long something has lasted, in plain words. */
const howLong = (ms) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

// ---- per channel health (chrome.storage.session, one key per channel so channels never clobber each other)

const healthKey = (ch) => `health:${ch}`;
async function getHealth(ch) {
  try {
    const h = await store.sessionGet(healthKey(ch), null);
    return h && typeof h === 'object' ? h : {};
  } catch { return {}; }
}
const saveHealth = (ch, h) => store.sessionSet(healthKey(ch), h).catch(() => {});
async function patchHealth(ch, patch) {
  const h = await getHealth(ch);
  Object.assign(h, patch);
  await saveHealth(ch, h);
  return h;
}
const today = () => new Date().toDateString();
const recoveriesToday = (h) => (h.rec_day === today() ? h.rec_today || 0 : 0);

/** The fields the server stores per channel next to state and detail. */
function healthFields(h) {
  return {
    last_ok_at: h.last_ok_at || null,
    last_scan_at: h.last_scan_at || null,
    last_error: h.last_error || '',
    recoveries: recoveriesToday(h),
    last_recovery: h.last_recovery || '',
    last_recovery_at: h.last_recovery_at || null,
    version: VERSION,
  };
}

/** A failed tab call in plain words for the owner. */
function plainError(res) {
  switch (res?.error_code) {
    case 'timeout': return 'The page stopped answering';
    case 'no_content_script': return 'The page is still loading';
    case 'tab_missing': return 'The tab was closed';
    default: return String(res?.error || 'Something went wrong on the page').slice(0, 140);
  }
}

// ---- send in progress (memory for speed, session storage so a restarted worker still knows) -----------

const busy = Object.fromEntries(NAMES.map((n) => [n, false]));
async function setJobBusy(ch, on) {
  try { await store.sessionSet(`job_busy:${ch}`, on ? Date.now() + 6 * 60_000 : 0); } catch { /* ignore */ }
}
async function jobBusy(ch) {
  if (busy[ch]) return true;
  try { return (await store.sessionGet(`job_busy:${ch}`, 0)) > Date.now(); } catch { return false; }
}

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

/** True when `url` is one of the pages the channel works on (same patterns as CHANNELS[].match). */
function onChannelPage(channel, url) {
  let u;
  try { u = new URL(url || ''); } catch { return false; }
  if (channel === 'tiktok') return u.hostname === 'www.tiktok.com' && /^\/(messages|login)/.test(u.pathname);
  if (channel === 'whatsapp') return u.hostname === 'web.whatsapp.com';
  if (channel === 'gmail') return u.hostname === 'mail.google.com';
  return false;
}

/**
 * The one tab the agent works in for a channel. When the site is open more than once it keeps the
 * tab it used before, else the chosen Gmail account, else the pinned one, else the oldest. The others
 * are never read or typed into. `acxCount` says how many tabs of the site are open.
 */
async function findTab(channel) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: CHANNELS[channel].match }); } catch { tabs = []; }
  if (!tabs.length) return null;
  let pick = null;
  if (channel === 'gmail') {
    // Gmail puts the account address in the tab title: prefer the tab showing the chosen inbox.
    const account = await gmailAccount();
    pick = account ? tabs.find((t) => (t.title || '').toLowerCase().includes(account)) || null : null;
  }
  const sticky = await store.sessionGet(`tab:${channel}`, 0).catch(() => 0);
  if (!pick && sticky) pick = tabs.find((t) => t.id === sticky) || null;
  if (!pick) pick = [...tabs].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.id - b.id)[0];
  if (pick.id !== sticky) await store.sessionSet(`tab:${channel}`, pick.id).catch(() => {});
  return Object.assign(pick, { acxCount: tabs.length });
}

/** The tab with this id, when it still shows the channel's page. */
async function tabById(channel, tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab && onChannelPage(channel, tab.url || tab.pendingUrl) ? tab : null;
  } catch { return null; }
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
          return { ...away, status: 'loading', acxCount: 1 };
        }
        return { ...away, acxAway: true, acxOwnSite: isOwnSitePage(channel, away.url), acxCount: 1 };
      } catch { delete opened[channel]; await store.sessionSet('opened_tabs', opened); }
    }
    if (autoOpen) {
      try {
        tab = await chrome.tabs.create({ url: homeUrl(channel, channel === 'gmail' ? await gmailAccount() : ''), active: false, pinned: true });
        opened[channel] = tab.id;
        await store.sessionSet('opened_tabs', opened);
        await store.sessionSet(`tab:${channel}`, tab.id);
        tab.acxCount = 1;
      } catch { tab = null; }
    }
  }
  if (tab && tab.autoDiscardable !== false) {
    // Stop Memory Saver from unloading the tab while the agent depends on it.
    try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch { /* tab closed */ }
  }
  return tab;
}

/**
 * Ask a tab's adapter to do something. Resolves to { ok, data } or { ok:false, error_code, error, retryable }.
 * With `tabId` the call goes to that tab only (or fails with tab_missing): a job or a read never moves
 * to another tab halfway through.
 */
async function tabOp(channel, op, args, timeoutMs = 30_000, tabId = null) {
  const tab = tabId != null ? await tabById(channel, tabId) : await findTab(channel);
  if (!tab) return { ok: false, error_code: 'tab_missing', error: `No ${channel} tab is open`, retryable: true };
  const call = new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tab.id, { acx: true, op, args }, (res) => {
        if (chrome.runtime.lastError || !res) {
          resolve({ ok: false, error_code: 'no_content_script', error: chrome.runtime.lastError?.message || 'The page did not answer', retryable: true });
        } else resolve(res);
      });
    } catch (err) {
      resolve({ ok: false, error_code: 'no_content_script', error: String(err?.message || err), retryable: true });
    }
  });
  // A frozen tab never answers at all: the time limit is what ends the wait.
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r({ ok: false, error_code: 'timeout', error: `${op} took longer than ${Math.round(timeoutMs / 1000)}s`, retryable: true }), timeoutMs); });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- healing tabs -------------------------------------------------------------------------------------

/**
 * Reload or replace a channel's tab, within the limits: never while a message is being sent, at most
 * one action per `recovery_gap_ms` and `max_recoveries_per_hour` per channel. Mutates `h` (the
 * channel's health record); the caller saves it. Returns true when something was done.
 */
async function recover(channel, tabId, kind, why, h, T) {
  const now = Date.now();
  if (await jobBusy(channel)) return false;
  h.rec_times = (Array.isArray(h.rec_times) ? h.rec_times : []).filter((t) => now - t < 3600_000);
  if (h.rec_times.length >= T.max_recoveries_per_hour) {
    h.last_error = `${why}. Stopped fixing it for now after ${h.rec_times.length} tries this hour`;
    return false;
  }
  if (now - (h.rec_at || 0) < T.recovery_gap_ms) return false;
  let done = '';
  try {
    if (kind === 'reload') {
      await chrome.tabs.reload(tabId);
      done = 'Reloaded the tab';
    } else {
      // Open the fresh tab first (in the same window), so closing the old one never closes the window.
      let windowId;
      try { windowId = (await chrome.tabs.get(tabId)).windowId; } catch { windowId = undefined; }
      const url = homeUrl(channel, channel === 'gmail' ? await gmailAccount() : '');
      const fresh = await chrome.tabs.create({ url, active: false, pinned: true, ...(windowId != null ? { windowId } : {}) });
      try { await chrome.tabs.update(fresh.id, { autoDiscardable: false }); } catch { /* ignore */ }
      try { await chrome.tabs.remove(tabId); } catch { /* already gone */ }
      await store.sessionSet(`tab:${channel}`, fresh.id);
      const opened = await store.sessionGet('opened_tabs', {});
      opened[channel] = fresh.id;
      await store.sessionSet('opened_tabs', opened);
      h.tab_id = fresh.id; // the same healing goes on in the new tab
      done = 'Opened a fresh tab';
    }
  } catch (err) {
    h.last_error = `${why}. Could not fix the tab (${String(err?.message || err).slice(0, 80)})`;
    return false;
  }
  h.rec_times.push(now);
  h.rec_at = now;
  if (h.rec_day !== today()) { h.rec_day = today(); h.rec_today = 0; }
  h.rec_today = (h.rec_today || 0) + 1;
  h.last_recovery = `${done}: ${why}`;
  h.last_recovery_at = now;
  h.last_error = why;
  console.warn('[acx] self heal', channel, done, why);
  api.diagnostics(channel, 'note', { where: 'watchdog', action: kind, why, recoveries_today: h.rec_today }).catch(() => {});
  return true;
}

/**
 * Called once per cycle per channel with what the cycle saw. `info.alive` is true when the tab
 * proved it works: a good scan when one was due, else a probe that answered with a settled state.
 */
async function watchdog(channel, info, T) {
  const now = Date.now();
  const h = await getHealth(channel);
  if (!info.tabId || info.away) {
    // No tab, or a tab the loop guards already handle (redirected, logged out): nothing to heal.
    h.stage = 0; h.tab_id = info.tabId || null; h.watch_from = now; h.loading_since = 0;
    await saveHealth(channel, h);
    return;
  }
  if (h.tab_id !== info.tabId) { h.tab_id = info.tabId; h.watch_from = now; h.stage = 0; } // a new tab gets a fresh start
  if (!h.watch_from) h.watch_from = now;
  // A page that answers "loading" is given longer: WhatsApp can take minutes to sync after a night off.
  if (info.answeredLoading) h.loading_since = h.loading_since || now;
  else h.loading_since = 0;
  const alive = info.alive || (info.answeredLoading && now - h.loading_since < T.loading_ms);
  if (alive) {
    h.alive_at = now;
    h.stage = 0;
    await saveHealth(channel, h);
    return;
  }
  const since = Math.max(h.alive_at || 0, h.watch_from || 0);
  const deadFor = now - since;
  if (deadFor < T.stall_ms || (await jobBusy(channel))) { await saveHealth(channel, h); return; }

  const why = info.scanExpected ? `No good read for ${howLong(deadFor)}` : `The page has not answered for ${howLong(deadFor)}`;
  if (!h.stage) {
    // Step 1: ask once more, with more patience. Enough when only the probe was missing.
    const again = await tabOp(channel, 'probe', {}, T.wake_probe_ms, info.tabId);
    const answered = again.ok && again.data && ALIVE_STATES.includes(again.data.state) && !((again.data.busy_ms || 0) > STUCK_OP_MS);
    if (answered && !info.scanExpected) { h.alive_at = Date.now(); await saveHealth(channel, h); return; }
    // Step 2: reload.
    if (await recover(channel, info.tabId, 'reload', why, h, T)) { h.stage = 1; h.stage_at = Date.now(); }
  } else if (now - (h.stage_at || 0) >= T.replace_after_ms) {
    // Step 3: still dead after the reload: replace the tab. After that, reload and replace take turns
    // (always inside the gap and the hourly cap).
    const kind = h.stage === 1 ? 'replace' : 'reload';
    if (await recover(channel, info.tabId, kind, `${why} after a reload`, h, T)) { h.stage = kind === 'replace' ? 2 : 1; h.stage_at = Date.now(); }
  }
  await saveHealth(channel, h);
}

// ---- status -----------------------------------------------------------------------------------------

function duplicateNote(channel, tab) {
  if (!tab || !(tab.acxCount > 1)) return '';
  return `${tab.acxCount} ${CHANNELS[channel].label} tabs are open. The agent only uses the ${tab.pinned ? 'pinned' : 'first'} one`;
}
const joinDetail = (...parts) => parts.filter(Boolean).join('. ');

/** Probe one channel. Returns { st: status for the server, info: what the watchdog needs }. */
async function probeChannel(channel, autoOpen, probeMs) {
  const tab = await ensureTab(channel, autoOpen);
  if (!tab) return { st: { state: 'no_tab', detail: 'Tab is not open', unread: 0, busy: false }, info: { tabId: null } };
  const tabs = tab.acxCount || 1;
  if (tab.acxAway) {
    let where = '';
    try { where = new URL(tab.url).pathname; } catch { /* no url */ }
    const st = tab.acxOwnSite
      ? { state: 'error', detail: `The tab is on ${where}, not the messages page. Open the messages page in that tab`, unread: 0, busy: false }
      : { state: 'logged_out', detail: 'Log in on that tab', unread: 0, busy: false };
    return { st: { ...st, tabs }, info: { tabId: tab.id, away: true } };
  }
  let path = '';
  try { path = new URL(tab.url || 'https://x/').pathname; } catch { /* no url */ }
  if (channel === 'tiktok' && /\/login/.test(path)) {
    return { st: { state: 'logged_out', detail: 'Log in to TikTok on that tab', unread: 0, busy: false, tabs }, info: { tabId: tab.id, away: true } };
  }
  const dup = duplicateNote(channel, tab);
  if (tab.discarded || tab.status === 'unloaded') {
    // Chrome unloaded the tab to save memory: bring it back now.
    const T = await timing();
    const h = await getHealth(channel);
    if (await recover(channel, tab.id, 'reload', 'Chrome had unloaded the tab', h, T)) await saveHealth(channel, h);
    return { st: { state: 'loading', detail: joinDetail('Page is loading', dup), unread: 0, busy: busy[channel], tabs }, info: { tabId: tab.id } };
  }
  if (tab.status !== 'complete') return { st: { state: 'loading', detail: joinDetail('Page is loading', dup), unread: 0, busy: busy[channel], tabs }, info: { tabId: tab.id } };
  const res = await tabOp(channel, 'probe', {}, probeMs, tab.id);
  if (res.ok && res.data) {
    const d = res.data;
    const state = d.state || 'error';
    const stuck = (d.busy_ms || 0) > STUCK_OP_MS;
    return {
      st: { state, detail: joinDetail(stuck ? 'The page is stuck' : d.detail || '', dup), unread: d.unread || 0, busy: busy[channel], tabs },
      info: { tabId: tab.id, answered: !stuck, probeOk: ALIVE_STATES.includes(state) && !stuck, answeredLoading: state === 'loading' && !stuck },
    };
  }
  if (res.error_code === 'no_content_script') {
    // The tab was open before the extension was installed or updated: reload it so our script loads.
    // Inside the same limits as the watchdog (gap and hourly cap in session storage).
    const T = await timing();
    const h = await getHealth(channel);
    if (await recover(channel, tab.id, 'reload', 'The page had no agent script', h, T)) await saveHealth(channel, h);
  }
  return {
    st: { state: res.error_code === 'no_content_script' ? 'loading' : 'error', detail: joinDetail(plainError(res), dup), unread: 0, busy: busy[channel], tabs },
    info: { tabId: tab.id, answered: false },
  };
}

async function probeAll(autoOpen, probeMs = PROBE_MS) {
  const channels = {};
  const info = {};
  await Promise.all(NAMES.map(async (channel) => {
    try {
      const r = await probeChannel(channel, autoOpen, probeMs);
      channels[channel] = r.st;
      info[channel] = r.info;
    } catch (err) {
      channels[channel] = { state: 'error', detail: String(err?.message || err).slice(0, 140), unread: 0, busy: busy[channel] };
      info[channel] = { tabId: null };
    }
  }));
  return { channels, info };
}

/** Status per channel with the health fields added (what the server and the popup show). */
async function withHealth(channels) {
  const out = {};
  for (const ch of NAMES) out[ch] = { ...(channels[ch] || { state: 'no_tab', detail: '', unread: 0, busy: false }), ...healthFields(await getHealth(ch)) };
  return out;
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* action API unavailable */ }
}

// ---- jobs -------------------------------------------------------------------------------------------

async function waitForReady(channel, timeoutMs, tabId) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(1500);
    const tab = await tabById(channel, tabId);
    if (!tab || tab.status !== 'complete') continue;
    const res = await tabOp(channel, 'probe', {}, 6000, tabId);
    if (res.ok && res.data?.state === 'ready') return true;
    if (res.ok && (res.data?.state === 'logged_out' || res.data?.state === 'blocked')) return false;
  }
  return false;
}

async function runJob(channel, job, tabId) {
  if (await store.isDone(job.id)) {
    // Already typed and sent, but the confirmation was lost. Confirm again, never send twice.
    await api.jobResult(job.id, { status: 'sent' }).catch(() => {});
    return;
  }
  busy[channel] = true;
  await setJobBusy(channel, true);
  try {
    // The whole job happens in one tab: the one chosen now.
    if (tabId == null) tabId = (await findTab(channel))?.id ?? null;
    if (tabId == null) { await report(job, { ok: false, error_code: 'tab_missing', error: 'Tab closed', retryable: true }); return; }
    const delay = Math.min(Math.max(0, job.pacing?.delay_ms ?? 0), 25_000);
    if (delay) await sleep(delay);

    let prepared = { ready: true };
    if (job.kind === 'new_chat') {
      const prep = await tabOp(channel, 'prepare', { job }, 20_000, tabId);
      if (!prep.ok) { await report(job, prep); return; }
      prepared = prep.data || { ready: true };
      if (prepared.navigate) {
        try { await chrome.tabs.update(tabId, { url: prepared.navigate }); } catch {
          await report(job, { ok: false, error_code: 'tab_missing', error: 'Tab closed', retryable: true });
          return;
        }
        if (!(await waitForReady(channel, 75_000, tabId))) {
          await report(job, { ok: false, error_code: 'timeout', error: 'Page did not load after opening the chat', retryable: true });
          return;
        }
      }
    }
    const res = await tabOp(channel, 'send', { job, navigated: Boolean(prepared.navigate) }, 150_000, tabId);
    await report(job, res);
  } finally {
    busy[channel] = false;
    await setJobBusy(channel, false);
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
 *
 * A thread the adapter reported is remembered (session storage) until it was read and sent to the
 * server, so a failed read or an unreachable server never loses it, even when the next scan no longer
 * lists it (the badge went away). Returns true when the scan worked, false when it failed, null when
 * no scan was due (channel switched off, cycle abandoned).
 */
async function channelWork(channel, jobs, config, ctx) {
  for (const job of jobs) {
    if (ctx.stale()) return null;
    await runJob(channel, job, ctx.tabId);
  }
  if (config.channels?.[channel]?.mode === 'off' || ctx.stale()) return null;

  await patchHealth(channel, { last_scan_at: Date.now() });
  const scan = await tabOp(channel, 'scan', {}, 25_000, ctx.tabId);
  if (!scan.ok || !Array.isArray(scan.data?.threads)) {
    await patchHealth(channel, { last_error: plainError(scan) });
    return false;
  }
  await patchHealth(channel, { last_ok_at: Date.now(), last_error: '' });

  const seenKey = `seen:${channel}`;
  const seen = await store.sessionGet(seenKey, {});
  const now = Date.now();
  const settleMs = (config.pacing?.settle_seconds ?? 12) * 1000;
  const live = new Set();

  const note = (t, src) => {
    const sig = String(t.sig ?? `${t.unread}|${t.preview}`);
    const prev = seen[t.key];
    const lite = { key: t.key, title: t.title || '', accepted: Boolean(t.accepted) };
    if (!prev || prev.sig !== sig) seen[t.key] = { sig, since: now, reported: prev?.reported ?? null, t: lite, tries: 0, src };
    else if (!prev.t || lite.accepted) prev.t = { ...lite, accepted: lite.accepted || Boolean(prev.t?.accepted) };
  };
  for (const t of scan.data.threads) {
    if (!t || !t.key || t.is_group) continue;
    live.add(t.key);
    note(t, 'scan');
  }

  // Safety sweep: recent chats that end with a customer message, whatever the badge says.
  const h = await getHealth(channel);
  if (!h.sweep_at) await patchHealth(channel, { sweep_at: now }); // the first one comes a full period after start
  else if (now - h.sweep_at >= ctx.T.sweep_ms && !ctx.stale()) {
    await patchHealth(channel, { sweep_at: now });
    const sw = await tabOp(channel, 'sweep', {}, 40_000, ctx.tabId);
    if (sw.ok && Array.isArray(sw.data?.threads)) {
      for (const t of sw.data.threads) {
        if (!t || !t.key || t.is_group || live.has(t.key)) continue; // the scan already covers it
        live.add(t.key);
        const sig = String(t.sig ?? '');
        if (seen[t.key]?.reported === sig) continue; // reported this session: cheap, skip
        note(t, 'sweep');
      }
    }
  }

  for (const k of Object.keys(seen)) if (!live.has(k) && now - (seen[k]?.since || 0) > 6 * 3600_000) delete seen[k];
  await store.sessionSet(seenKey, seen);

  const due = [];
  for (const [k, e] of Object.entries(seen)) {
    if (!e || !e.t || e.reported === e.sig) continue;
    if (now - e.since < settleMs || (e.tries || 0) >= 3) continue;
    if (!live.has(k) && now - e.since > 2 * 3600_000) continue; // not listed for hours: let it go
    due.push({ k, e });
  }
  // What this scan listed first (in its order), then what is still waiting from earlier.
  due.sort((a, b) => Number(live.has(b.k)) - Number(live.has(a.k)) || a.e.since - b.e.since);

  let handled = 0;
  for (const { k, e } of due) {
    if (handled >= MAX_THREADS_PER_CYCLE || ctx.stale() || Date.now() > ctx.deadline) break;
    handled++;
    busy[channel] = true;
    try {
      const read = await tabOp(channel, 'read', { key: k }, 45_000, ctx.tabId);
      if (!read.ok || !read.data?.thread) {
        seen[k].tries = (seen[k].tries || 0) + 1;
        await store.sessionSet(seenKey, seen);
        if (!read.ok) await patchHealth(channel, { last_error: plainError(read) });
        continue;
      }
      if (ctx.stale()) break;
      const thread = e.t.accepted ? { ...read.data.thread, just_accepted: true } : read.data.thread;
      const decision = await api.inbound({ channel, thread, messages: read.data.messages || [] });
      seen[k].reported = e.sig;
      await store.sessionSet(seenKey, seen);
      busy[channel] = false;
      for (const job of decision.jobs || []) {
        if (ctx.stale()) break;
        await runJob(channel, job, ctx.tabId);
      }
    } catch (err) {
      if (seen[k]) seen[k].tries = (seen[k].tries || 0) + 1;
      await store.sessionSet(seenKey, seen).catch(() => {});
      console.warn('[acx] thread failed', channel, err?.message || err);
    } finally {
      busy[channel] = false;
    }
  }
  return true;
}

// ---- the cycle ----------------------------------------------------------------------------------------

let running = false;
let runningSince = 0;
let again = false;
let gen = 0; // bumped when a cycle is abandoned, so its leftovers stop at the next step
let keepAlive = null;

async function serverBackoff() {
  return store.sessionGet('server_backoff', { fails: 0, next_at: 0 }).catch(() => ({ fails: 0, next_at: 0 }));
}

/** Keep the laptop awake while paired and not paused. Cheap, so it is repeated every cycle. */
function keepAwake(on) {
  try {
    if (on) chrome.power.requestKeepAwake('system');
    else chrome.power.releaseKeepAwake();
  } catch { /* power API unavailable */ }
}

async function cycle(myGen) {
  const T = await timing();
  const started = Date.now();
  const ctxBase = { T, stale: () => gen !== myGen, deadline: started + T.cycle_timeout_ms * 0.6 };
  const st = await store.get(['auth', 'paused', 'selectors', 'auto_open_tabs']);
  if (!st.auth?.token) { await setBadge('SET', '#8a8f98'); return; }
  keepAwake(!st.paused);

  // Woke up from sleep: probe with more patience and reload tabs that do not answer.
  const wake = await store.sessionGet('wake_pending', null).catch(() => null);
  if (wake) await store.sessionSet('wake_pending', null).catch(() => {});

  const probed = await probeAll(st.auto_open_tabs && !st.paused, wake ? T.wake_probe_ms : PROBE_MS);
  const { info } = probed;
  if (wake) {
    for (const ch of NAMES) {
      const i = info[ch];
      if (i?.tabId && !i.away && !i.answered && !i.answeredLoading && probed.channels[ch]?.state !== 'loading') {
        const h = await getHealth(ch);
        if (await recover(ch, i.tabId, 'reload', 'No answer after the laptop woke up', h, T)) await saveHealth(ch, h);
      }
      await patchHealth(ch, { sweep_at: 1 }); // look over recent chats once now (1, not 0: 0 means "never")
    }
  }
  const finish = async (scanOk) => {
    for (const ch of NAMES) {
      const i = info[ch] || {};
      const scanExpected = scanOk[ch] !== undefined && scanOk[ch] !== null;
      await watchdog(ch, { ...i, scanExpected, alive: scanExpected ? scanOk[ch] : Boolean(i.probeOk) }, T).catch((err) => console.warn('[acx] watchdog failed', ch, err?.message || err));
    }
  };

  const channels = await withHealth(probed.channels);
  const bo = await serverBackoff();
  if (Date.now() < bo.next_at) {
    // The server failed a moment ago: keep the tabs healthy, try the server again later.
    await finish({});
    const wait = Math.ceil((bo.next_at - Date.now()) / 1000);
    await store.set({ status: { channels: await withHealth(probed.channels), last_sync_at: Date.now(), last_error: `Cannot reach the server. Trying again in ${wait} s`, server_ok: false } });
    await setBadge('!', '#e5484d');
    return;
  }

  let res;
  try {
    res = await api.sync({ channels, paused_locally: st.paused, version: VERSION }, st.selectors?.version ?? null, VERSION);
    if (!res || typeof res !== 'object') throw new api.ApiError(0, 'bad_response', 'The server sent an empty answer');
  } catch (err) {
    if (err.status === 401) {
      // The owner removed this laptop in the dashboard: forget the token so the popup asks to pair again.
      await store.set({ auth: null, status: { channels, last_sync_at: Date.now(), last_error: 'Not paired any more', server_ok: false } });
      await setBadge('SET', '#8a8f98');
      keepAwake(false);
      return;
    }
    const fails = (bo.fails || 0) + 1;
    await store.sessionSet('server_backoff', { fails, next_at: Date.now() + BACKOFF_MS[Math.min(fails, BACKOFF_MS.length) - 1] }).catch(() => {});
    await finish({});
    await store.set({ status: { channels, last_sync_at: Date.now(), last_error: err.message || 'Cannot reach the server', server_ok: false } });
    await setBadge('!', '#e5484d');
    return;
  }
  if (bo.fails) await store.sessionSet('server_backoff', { fails: 0, next_at: 0 }).catch(() => {});

  const patch = { config: res.config, status: { channels, last_sync_at: Date.now(), last_error: '', server_ok: true } };
  if (res.selectors) patch.selectors = res.selectors;
  await store.set(patch);

  if (st.paused || !res.config?.enabled) {
    await finish({});
    await setBadge('OFF', '#8a8f98');
    return;
  }

  const jobsBy = Object.fromEntries(NAMES.map((n) => [n, []]));
  for (const job of res.jobs || []) if (jobsBy[job.channel]) jobsBy[job.channel].push(job);
  const scanOk = {};
  await Promise.all(NAMES.map(async (channel) => {
    if (channels[channel].state !== 'ready') return;
    try {
      scanOk[channel] = await channelWork(channel, jobsBy[channel], res.config, { ...ctxBase, tabId: info[channel]?.tabId ?? null });
    } catch (err) {
      scanOk[channel] = false;
      await patchHealth(channel, { last_error: String(err?.message || err).slice(0, 140) });
      console.warn('[acx] channel failed', channel, err?.message || err);
    }
  }));
  if (ctxBase.stale()) return;
  await finish(scanOk);

  // Keep what the popup shows up to date with this cycle's reads.
  const latest = await store.get('status');
  await store.set({ status: { ...latest, channels: await withHealth(probed.channels) } });

  const ready = NAMES.filter((n) => channels[n].state === 'ready').length;
  await setBadge(ready ? 'ON' : '!', ready ? '#2563eb' : '#f5a524');
}

/**
 * Run a cycle now. Calls that arrive while one is running collapse into a single follow up run.
 * A cycle that runs past `cycle_timeout_ms` (or is still running when the laptop wakes) is abandoned
 * so the agent never stalls behind one stuck step.
 */
async function tick() {
  let T = TIMING;
  try {
    T = await timing();
    const now = Date.now();
    const last = await store.sessionGet('last_tick_at', 0);
    if (last && now - last > T.wake_gap_ms) await store.sessionSet('wake_pending', 'gap');
    await store.sessionSet('last_tick_at', now);
    if (running) {
      const age = now - runningSince;
      const woke = await store.sessionGet('wake_pending', null);
      if (age > T.cycle_timeout_ms || (woke && age > 20_000)) abandon('A round of work got stuck and was restarted');
      else { again = true; return; }
    }
  } catch {
    if (running) { again = true; return; }
  }

  running = true;
  runningSince = Date.now();
  const myGen = ++gen;
  if (keepAlive) clearInterval(keepAlive);
  // Extension API calls keep the worker awake during long sends (typing can take over 30 s).
  keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); }, 20_000);
  let timer;
  let timedOut = false;
  try {
    await Promise.race([
      cycle(myGen),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          if (gen === myGen) timedOut = true; // not when another tick already took over
          reject(new Error('cycle_timeout'));
        }, T.cycle_timeout_ms);
      }),
    ]);
  } catch (err) {
    console.warn('[acx] cycle failed', err?.message || err);
  } finally {
    clearTimeout(timer);
    if (timedOut) {
      gen++; // the abandoned cycle stops at its next step
      store.set({ status: { ...(await store.get('status').catch(() => ({}))), last_error: 'A round of work took too long and was restarted' } }).catch(() => {});
    }
    if (timedOut || gen === myGen) {
      if (keepAlive) clearInterval(keepAlive);
      keepAlive = null;
      running = false;
      if (again) { again = false; setTimeout(() => { tick(); }, 1500); }
      else scheduleSoon().catch(() => {});
    }
  }
}

function abandon(why) {
  console.warn('[acx] abandon cycle:', why);
  gen++;
  running = false;
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
}

let soonTimer = null;
/** Between alarms (30 s minimum) keep a faster beat while the worker is awake. */
async function scheduleSoon() {
  if (soonTimer) clearTimeout(soonTimer);
  const cfg = await store.get('config');
  const seconds = Math.min(60, Math.max(8, cfg?.poll_seconds ?? 20));
  soonTimer = setTimeout(() => { tick(); }, seconds * 1000);
}

async function ensureAlarm() {
  const a = await chrome.alarms.get(TICK_ALARM);
  if (!a) await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
}

async function boot() {
  try {
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
    keepAwake(Boolean(st.auth?.token && !st.paused));
  } catch (err) {
    console.warn('[acx] boot failed', err?.message || err);
  }
  tick();
}

/** The laptop came back (screen unlocked, input after idle, or a long gap between alarms). */
async function wake(why) {
  try {
    await store.sessionSet('wake_pending', why);
    await ensureAlarm();
  } catch { /* ignore */ }
  tick();
}

chrome.runtime.onInstalled.addListener(() => { boot(); });
chrome.runtime.onStartup.addListener(() => { boot(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === TICK_ALARM) tick(); });
try {
  chrome.idle.setDetectionInterval(60);
  chrome.idle.onStateChanged.addListener((state) => { if (state === 'active') wake('idle'); });
} catch { /* idle API unavailable */ }
// Every worker start (not only browser start): make sure the heartbeat alarm exists.
ensureAlarm().catch(() => {});

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
      nudgeTimer = setTimeout(() => { tick(); }, 3000);
      respond({ ok: true });
      return false;
    case 'get_selectors':
      store.get('selectors').then((selectors) => respond({ selectors }), () => respond({ selectors: null }));
      return true;
    case 'diag': {
      const now = Date.now();
      if (now - diagSent.at > 10 * 60_000) { diagSent.at = now; diagSent.n = 0; }
      if (++diagSent.n <= 20) api.diagnostics(msg.channel || null, msg.kind || 'note', msg.data || {}).catch(() => {});
      respond({ ok: true });
      return false;
    }
    // A tab could not copy a customer's photo itself (cross origin CDN picture). Only our three tabs
    // may ask, and only for the hosts listed in lib/media.js.
    case 'fetch_media':
      if (!sender.tab?.id || !NAMES.includes(msg.channel)) { respond({ ok: false, error: 'not_a_channel_tab' }); return false; }
      fetchMedia(msg.channel, String(msg.url || ''), Number(msg.timeout_ms) || 4000).then(respond, () => respond({ ok: false, error: 'failed' }));
      return true;
    case 'trusted_type':
      if (!sender.tab?.id) { respond({ ok: false }); return false; }
      trustedType(sender.tab.id, String(msg.text || '')).then(respond, (err) => respond({ ok: false, error: String(err?.message || err) }));
      return true;
    // ---- popup ----
    case 'pair':
      api.pair(msg.pairing_string, msg.name || 'Laptop').then(
        async (auth) => { await boot(); respond({ ok: true, server_url: auth.server_url }); },
        (err) => respond({ ok: false, error: err.message || 'Pairing failed' }),
      );
      return true;
    case 'unpair':
      store.set({ auth: null, config: null }).then(async () => { await setBadge('SET', '#8a8f98'); keepAwake(false); respond({ ok: true }); }, () => respond({ ok: false }));
      return true;
    case 'pause':
      store.set({ paused: Boolean(msg.paused) }).then(async () => { await boot(); respond({ ok: true }); }, () => respond({ ok: false }));
      return true;
    case 'tick':
      tick();
      respond({ ok: true });
      return false;
    case 'selftest':
      Promise.all(NAMES.map(async (channel) => [channel, await tabOp(channel, 'selftest', {}, 60_000)]))
        .then((rows) => respond({ ok: true, results: Object.fromEntries(rows) }), () => respond({ ok: false }));
      return true;
    default:
      return false;
  }
});
