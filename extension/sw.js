// ACX Agent service worker: pairs with the dashboard server, keeps the agent's tabs alive, asks each
// tab what is new, sends new customer messages to the server and types the replies it gets back.
//
// How the work is organised: one LANE per (channel, tab role).
//  * LANE_DEFS below is the registry. Today: whatsapp:inbox, gmail:inbox, tiktok:inbox. A new role
//    (tiktok:comments, tiktok:outreach) is one more entry bound to its own pinned tab by URL path; the
//    lane engine does not change.
//  * Each lane runs on its own. It scans its tab, reads every chat that is due, posts each read to the
//    server WITHOUT waiting for the decision, and sends replies from its own queue as soon as they
//    arrive. A lane never waits for another lane, and a chat never waits for another chat's decision.
//  * syncTick runs every poll_seconds: it probes every tab, syncs with the server (jobs, config),
//    runs the watchdog and hands jobs to the lanes. It never waits for lane work.
//
// Reliability rules (the laptop runs unattended all day):
//  * every call into a tab and to the server has a time limit. A lane as a whole has none: a busy,
//    healthy lane is never abandoned by a timer
//  * one conversation has at most one inbound call or queued reply at a time. A reply that would go
//    out after the customer wrote again is refused (newer_message) and the chat is read again
//  * a watchdog per lane notices a tab that stopped giving good reads and heals it step by step: ask
//    again, reload, then replace the tab, with a gap and an hourly cap, and never while the lane has
//    work in hand (an operation, a queued reply or an inbound call)
//  * waking from sleep syncs at once, resets the server backoff and reloads tabs that do not answer
//  * while the server is unreachable the lanes keep scanning and reading; the server is retried after
//    5, 10, 20, 40 then 60 s
//  * a sweep every 10 minutes reports recent chats that end with a customer message, badge or not
//  * state that must survive the worker stopping lives in chrome.storage.session: seen threads (with
//    in flight flags that expire), queued replies and job results not yet delivered
//  * a customer video the tab found (Google AI Studio connected) is uploaded whole before its report,
//    inside the report's own async run (attachVideo), so it never holds up the lane
import * as api from './lib/api.js';
import * as core from './lib/lane-core.js';
import { fetchAudio, fetchMedia, fetchVideo } from './lib/media.js';
import * as store from './lib/store.js';

const VERSION = chrome.runtime.getManifest().version;

const parseUrl = (url) => { try { return new URL(url || ''); } catch { return null; } };
const TIKTOK_INBOX = 'https://www.tiktok.com/messages?lang=en';
const TIKTOK_INBOX_BUSINESS = 'https://www.tiktok.com/messages?allow_label=true&lang=en&scene=business';

/**
 * The lane registry. Per lane:
 *   match       tab URL patterns for chrome.tabs.query
 *   page(u)     true for a page of this role (the tab is this lane's)
 *   site(u)     true for any page of the site that is not a sign in page
 *   away(u)     a page of this role's tab that the lane sends back home (it cannot work there)
 *   home(ctx)   the address the lane opens; ctx = { account, business, pack }
 *   idleScanMs  how often an idle lane looks again without a nudge
 *   minScanGapMs the least time between two scans asked for by nudges
 *   crossChatGapMs the least time between sends to two different chats (TikTok rate limits)
 */
const LANE_DEFS = [
  {
    channel: 'whatsapp', role: 'inbox', label: 'WhatsApp',
    match: ['https://web.whatsapp.com/*'],
    page: (u) => u.hostname === 'web.whatsapp.com',
    site: (u) => u.hostname === 'web.whatsapp.com',
    away: () => false,
    home: () => 'https://web.whatsapp.com/',
    idleScanMs: 15_000, minScanGapMs: 1500, crossChatGapMs: 0,
  },
  {
    channel: 'gmail', role: 'inbox', label: 'Gmail',
    match: ['https://mail.google.com/*'],
    page: (u) => u.hostname === 'mail.google.com',
    site: (u) => u.hostname === 'mail.google.com',
    away: () => false,
    // Gmail picks the signed-in account from ?authuser=<address> (a /u/<address>/ path gives a 404).
    home: ({ account }) => (account ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(account)}#inbox` : 'https://mail.google.com/mail/u/0/#inbox'),
    // Every Gmail scan fetches the unread feed from the owner's Google session: look gently.
    idleScanMs: 25_000, minScanGapMs: 5000, crossChatGapMs: 0,
  },
  {
    channel: 'tiktok', role: 'inbox', label: 'TikTok',
    // A logged out TikTok redirects /messages to /login: treat that tab as ours so no new tab is opened
    // each time. Business accounts land in /business-suite/, a separate app with the chat in a frame
    // where the agent cannot work: that tab is sent back to the business view of /messages.
    match: ['https://www.tiktok.com/messages*', 'https://www.tiktok.com/login*', 'https://www.tiktok.com/business-suite/*'],
    page: (u) => u.hostname === 'www.tiktok.com' && /^\/(messages|login|business-suite\/)/.test(u.pathname),
    site: (u) => u.hostname === 'www.tiktok.com' && !/^\/(login|signup)/.test(u.pathname),
    away: (u) => /^\/business-suite\//.test(u.pathname),
    home: ({ business, pack }) => (business ? String(pack?.urls?.inbox_business || TIKTOK_INBOX_BUSINESS) : String(pack?.urls?.inbox || TIKTOK_INBOX)),
    // TikTok is strict about automation: at least 3 s between sends to different chats.
    idleScanMs: 12_000, minScanGapMs: 2000, crossChatGapMs: 3000,
  },
];
const NAMES = [...new Set(LANE_DEFS.map((d) => d.channel))]; // channels the server knows

const TICK_ALARM = 'acx-tick';
const PROBE_MS = 8000;
// Probe states that prove the page and its script are alive (the owner may need to act, a reload would not help).
const ALIVE_STATES = ['ready', 'logged_out', 'blocked'];
// An operation that holds a tab's queue this long means the page stopped running its timers.
const STUCK_OP_MS = 5 * 60_000;

/** Timers of the watchdog and sweep. Tests may shorten them through storage key `timing`. */
const TIMING = {
  stall_ms: 3 * 60_000, // no good read for this long: start healing the tab
  replace_after_ms: 5 * 60_000, // still dead this long after a reload: replace the tab
  recovery_gap_ms: 5 * 60_000, // at most one reload or replace per lane in this time
  max_recoveries_per_hour: 6,
  loading_ms: 10 * 60_000, // a page that says it is loading gets this long before it counts as stuck
  sweep_ms: 10 * 60_000,
  wake_gap_ms: 150_000, // alarms fire every 30 s: a longer gap means the laptop slept
  wake_probe_ms: 10_000,
};

let timingCache = { at: 0, t: TIMING };
async function timing() {
  if (Date.now() - timingCache.at < 2000) return timingCache.t;
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
  timingCache = { at: Date.now(), t };
  return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** "40 s" or "3 min": how long something has lasted, in plain words. */
const howLong = (ms) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

// ---- lanes ----------------------------------------------------------------------------------------

function makeLane(def) {
  const id = `${def.channel}:${def.role}`;
  // The inbox lane keeps the channel's own storage names (health:whatsapp, seen:whatsapp).
  const name = def.role === 'inbox' ? def.channel : id;
  return {
    def, id, channel: def.channel, role: def.role, name,
    loaded: null, // promise: seen threads and queued jobs read back from session storage
    seen: {}, // thread key -> what the scans saw (lane-core noteThread)
    live: new Set(), // keys the last scan listed
    queue: [], // jobs waiting to be sent: { job, seq, arrived, readAt, sendAt, thread, key, tail, source, requeued }
    seq: 0,
    probe: { state: 'unknown', at: 0, st: null, info: {} },
    tabId: null,
    running: false, again: false, gen: 0,
    timer: null, timerAt: 0, nudgeTimer: null,
    op: null, // the tab operation in progress: { op, since }
    job: null, // the queued job being sent
    lastScanAt: 0, scanWanted: 0, opOkAt: 0, timeouts: 0,
    readsSinceSend: 0, lastSendAt: 0, lastSendThread: null,
    inflight: new Map(), // key -> { since } of reads whose inbound call has not answered yet
    threadCalls: new Map(), // conversation -> inbound calls in flight
    reads: new Map(), // conversation -> { tail, at, key } of the latest read, for newer_message
    saveChain: Promise.resolve(),
  };
}
const lanes = LANE_DEFS.map(makeLane);
const primaryLane = (channel) => lanes.find((l) => l.channel === channel && l.role === 'inbox') || null;
const laneForJob = (job) => lanes.find((l) => l.channel === job.channel && l.role === (job.role || 'inbox')) || primaryLane(job.channel);

const seenKey = (lane) => `seen:${lane.name}`;
const queueKey = (lane) => `queue:${lane.name}`;

function laneLoaded(lane) {
  if (!lane.loaded) {
    lane.loaded = (async () => {
      const seen = await store.sessionGet(seenKey(lane), {}).catch(() => ({}));
      lane.seen = seen && typeof seen === 'object' ? seen : {};
      const q = await store.sessionGet(queueKey(lane), []).catch(() => []);
      for (const it of Array.isArray(q) ? q : []) {
        if (it && it.job && it.job.id && !lane.queue.some((x) => x.job.id === it.job.id)) lane.queue.push(it);
      }
      lane.seq = lane.queue.reduce((n, it) => Math.max(n, it.seq || 0), 0);
    })();
  }
  return lane.loaded;
}

function saveSeen(lane) {
  lane.saveChain = lane.saveChain.then(() => store.sessionSet(seenKey(lane), lane.seen)).catch(() => {});
  return lane.saveChain;
}
function saveQueue(lane) {
  lane.saveChain = lane.saveChain.then(() => store.sessionSet(queueKey(lane), lane.queue)).catch(() => {});
  return lane.saveChain;
}

// What the worker knows from the last sync and from storage.
let config = null;
let paired = false;
let paused = false;
let business = false; // the TikTok account is a business account (seen in Business Suite or said by the page)

const settleMs = () => Math.max(0, Number(config?.pacing?.settle_seconds ?? 12) * 1000);

/** True when the lane may scan, read and send right now. */
function laneActive(lane) {
  if (!paired || paused || !config || config.enabled === false) return false;
  if (config.channels?.[lane.channel]?.mode === 'off') return false;
  return lane.probe.state === 'ready' && lane.tabId != null;
}
/** Stopped by the owner or the server (not by the page): queued replies must not go out later. */
const laneStopped = (lane) => paused || config?.enabled === false || config?.channels?.[lane.channel]?.mode === 'off';

/** One conversation gets one decision at a time: an inbound call or a queued or typing reply. */
function threadBusy(lane, thread, now = Date.now(), exceptKey = null) {
  if (!thread) return false;
  if ((lane.threadCalls.get(thread) || 0) > 0) return true;
  if (lane.job && lane.job.thread === thread) return true;
  if (lane.queue.some((it) => it.thread === thread)) return true;
  // A call that was in flight when the worker restarted still counts until its flag expires.
  for (const [k, e] of Object.entries(lane.seen)) {
    if (k !== exceptKey && e && e.thread === thread && (e.inflight_until || 0) > now) return true;
  }
  return false;
}

/** Threads that may be read now: listed by the last scan first, then the longest waiting. */
function dueReads(lane, now) {
  const settle = settleMs();
  const out = [];
  for (const [k, e] of Object.entries(lane.seen)) {
    if (lane.inflight.has(k)) continue;
    if (!core.isDue(e, now, settle, (t) => threadBusy(lane, t, now, k))) continue;
    if (!lane.live.has(k) && now - (e.since || 0) > 2 * 3600_000) continue; // not listed for hours: let it go
    out.push({ k, e, live: lane.live.has(k) });
  }
  return out.sort(core.readOrder);
}

/** Ask the lane to run now (or once more right after the step it is doing). */
function kick(lane) {
  if (lane.running) { lane.again = true; return; }
  runLane(lane);
}

/** Wake the lane at `at` (ms), unless an earlier wake is already planned. */
function wakeAt(lane, at) {
  if (!Number.isFinite(at)) return;
  if (lane.timer && lane.timerAt <= at) return;
  if (lane.timer) clearTimeout(lane.timer);
  lane.timerAt = at;
  lane.timer = setTimeout(() => { lane.timer = null; lane.timerAt = 0; kick(lane); }, Math.min(60_000, Math.max(0, at - Date.now())));
}

async function runLane(lane) {
  lane.running = true;
  const gen = ++lane.gen;
  try {
    await laneLoaded(lane);
    for (let steps = 0; steps < 400; steps++) {
      if (lane.gen !== gen) return;
      lane.again = false;
      if (!laneActive(lane)) {
        if (laneStopped(lane) && lane.queue.length) {
          // Paused, switched off, or the agent was stopped: these replies must not go out later.
          lane.queue = [];
          saveQueue(lane);
        } else {
          // The tab cannot run (loading, frozen, logged out): jobs whose lease ran out go back to the
          // server now, so they never pin the lane or come back after a restart.
          dropLeaseOver(lane, Date.now());
        }
        return; // the next probe or sync starts the lane again
      }
      const step = await laneStep(lane);
      if (step.idle && !lane.again) { wakeAt(lane, step.at); return; }
    }
    wakeAt(lane, Date.now() + 1000);
  } catch (err) {
    console.warn('[acx] lane failed', lane.id, err?.message || err);
    wakeAt(lane, Date.now() + 3000);
  } finally {
    if (lane.gen === gen) {
      lane.running = false;
      if (lane.again) setTimeout(() => kick(lane), 0);
    }
  }
}

/**
 * Jobs whose lease is over (measured on this laptop's clock from the time left the server gave, so a
 * clock that is off does not matter) are not ours to send any more. Each one is handed back to the
 * server (retryable, no try used) instead of disappearing without a word.
 */
function dropLeaseOver(lane, now) {
  const over = lane.queue.filter((it) => core.leaseOver(it, now));
  if (!over.length) return;
  lane.queue = lane.queue.filter((it) => !over.includes(it));
  saveQueue(lane);
  for (const it of over) {
    deliverResult(it.job.id, { status: 'failed', error_code: 'lease_expired_local', error: 'The job waited in the laptop queue until its lease ran out. Nothing was typed.', retryable: true });
  }
}

/** One step: a scan, a read (its inbound call runs on its own) or a send. Or nothing, and when to look again. */
async function laneStep(lane) {
  const now = Date.now();
  // A job whose lease is over may have been handed back or cancelled by the server: it is not ours.
  dropLeaseOver(lane, now);

  const due = dueReads(lane, now);
  const holdNewChat = due.length > 0 || lane.inflight.size > 0 || lane.queue.some((it) => it.job.kind !== 'new_chat');
  const next = core.nextJob(lane.queue, { now, lastSendAt: lane.lastSendAt, lastSendThread: lane.lastSendThread, crossChatGapMs: lane.def.crossChatGapMs, holdNewChat });

  const sinceScan = now - lane.lastScanAt;
  const scanDue = sinceScan >= lane.def.idleScanMs
    || (lane.scanWanted > 0 && sinceScan >= lane.def.minScanGapMs)
    // A thread became due since the last look: look once more first, the customer may still be writing.
    || (due.length > 0 && lane.lastScanAt < core.dueTime(due[0].e, settleMs()) && sinceScan >= 1000);

  const allInflight = lanes.reduce((n, l) => n + l.inflight.size, 0);
  const step = core.chooseStep({
    scanDue, readyJob: Boolean(next.item), jobUrgent: Boolean(next.item && core.leaseUrgent(next.item, now)),
    dueRead: due.length > 0, readsSinceSend: lane.readsSinceSend,
    inflight: allInflight >= core.INBOUND_CAP_ALL ? Infinity : lane.inflight.size,
  });
  if (step === 'send') { await sendJob(lane, next.item, due.length); return {}; }
  if (step === 'scan') { await scanLane(lane); return {}; }
  if (step === 'read') { await readThread(lane, due[0].k); return {}; }

  // Idle: wake for the next scan, the next due thread or the next job, whichever comes first.
  let at = lane.lastScanAt + lane.def.idleScanMs;
  if (lane.scanWanted > 0) at = Math.min(at, lane.lastScanAt + lane.def.minScanGapMs);
  at = Math.min(at, next.at);
  const settle = settleMs();
  for (const e of Object.values(lane.seen)) {
    if (!e || !e.t || e.reported === e.sig) continue;
    const d = core.dueTime(e, settle);
    if (d > now) at = Math.min(at, d);
  }
  return { idle: true, at: Math.max(at, now + 250) };
}

/** A tab operation of this lane. Keeps the lane's view of its tab up to date. */
async function laneOp(lane, op, args, timeoutMs) {
  lane.op = { op, since: Date.now() };
  try {
    const res = await tabOp(lane, op, args, timeoutMs, lane.tabId);
    if (res.ok) { lane.opOkAt = Date.now(); lane.timeouts = 0; }
    else if (res.error_code === 'timeout') lane.timeouts++;
    if (!res.ok && (res.error_code === 'tab_missing' || res.error_code === 'no_content_script')) {
      // The tab went away or is loading again: wait for the next probe to say it is ready.
      lane.probe = { ...lane.probe, state: 'unknown' };
      syncSoon(1500);
    }
    return res;
  } finally {
    lane.op = null;
  }
}

// ---- scanning and reading -------------------------------------------------------------------------

async function scanLane(lane) {
  const T = await timing();
  lane.scanWanted = 0;
  await patchHealth(lane, { last_scan_at: Date.now() });
  const scan = await laneOp(lane, 'scan', {}, 25_000);
  lane.lastScanAt = Date.now();
  if (!scan.ok || !Array.isArray(scan.data?.threads)) {
    await patchHealth(lane, { last_error: plainError(scan) });
    return;
  }
  await patchHealth(lane, { last_ok_at: Date.now(), last_error: '' });

  const now = Date.now();
  const live = new Set();
  scan.data.threads.forEach((t, pos) => {
    if (!t || !t.key || t.is_group) return;
    live.add(t.key);
    lane.seen[t.key] = core.noteThread(lane.seen[t.key], { ...t, pos }, now, 'scan');
  });

  // Safety sweep: recent chats that end with a customer message, whatever the badge says.
  const h = await getHealth(lane);
  if (!h.sweep_at) await patchHealth(lane, { sweep_at: now }); // the first one comes a full period after start
  else if (now - h.sweep_at >= T.sweep_ms) {
    await patchHealth(lane, { sweep_at: now });
    const sw = await laneOp(lane, 'sweep', {}, 40_000);
    if (sw.ok && Array.isArray(sw.data?.threads)) {
      for (const t of sw.data.threads) {
        if (!t || !t.key || t.is_group || live.has(t.key)) continue; // the scan already covers it
        live.add(t.key);
        if (lane.seen[t.key]?.reported === String(t.sig ?? '')) continue; // reported this session: cheap, skip
        lane.seen[t.key] = core.noteThread(lane.seen[t.key], t, Date.now(), 'sweep');
      }
    }
  }
  lane.live = live;
  for (const k of Object.keys(lane.seen)) {
    if (!live.has(k) && !lane.inflight.has(k) && now - (lane.seen[k]?.since || 0) > 6 * 3600_000) delete lane.seen[k];
  }
  for (const [conv, r] of lane.reads) if (now - r.at > 30 * 60_000) lane.reads.delete(conv);
  saveSeen(lane);
}

function readFailed(lane, k, res) {
  const e = lane.seen[k];
  if (e) { e.tries = (e.tries || 0) + 1; e.failed_at = Date.now(); }
  if (res && !res.ok) patchHealth(lane, { last_error: plainError(res) });
}

/** Read one thread, then post it to the server without waiting for the decision. */
async function readThread(lane, k) {
  const e = lane.seen[k];
  if (!e) return;
  const readAt = Date.now();
  const readSig = e.sig;
  e.inflight_until = readAt + core.INFLIGHT_TTL_MS;
  lane.inflight.set(k, { since: readAt });
  lane.readsSinceSend++;
  saveSeen(lane);
  let posted = false;
  try {
    // Videos already sent or described for this channel: the tab does not open them again.
    const read = await laneOp(lane, 'read', { key: k, videos_done: await videosDone(lane.channel).catch(() => []) }, 45_000);
    const cur = lane.seen[k];
    if (!read.ok || !read.data) { readFailed(lane, k, read); return; }
    if (read.data.skipped) { if (cur) cur.reported = readSig; return; } // automated mail, found when opened
    if (!read.data.thread) { readFailed(lane, k, read); return; }
    const thread = read.data.thread;
    const conv = thread.external_id ? String(thread.external_id) : null;
    if (cur) cur.thread = conv;
    // The same conversation is being decided or answered already (another key led to it): read it
    // again once that is finished, so the second decision sees the first reply.
    if (conv && threadBusy(lane, conv, Date.now(), k)) return;
    const tail = read.data.tail || null;
    if (conv) lane.reads.set(conv, { tail, at: readAt, key: k });
    const refused = conv ? refusedFor(conv) : [];
    postInbound(lane, k, readSig, {
      channel: lane.channel,
      thread: cur?.t?.accepted ? { ...thread, just_accepted: true } : thread,
      messages: read.data.messages || [],
      // Replies refused for this chat whose result the server may not have yet: dropped before it decides again.
      ...(refused.length ? { refused_job_ids: refused } : {}),
    }, { readAt, conv, tail, tabId: lane.tabId });
    posted = true;
  } finally {
    if (!posted) {
      const cur = lane.seen[k];
      if (cur) cur.inflight_until = 0;
      lane.inflight.delete(k);
      saveSeen(lane);
    }
  }
}

// The first inbound after a quiet spell goes alone for a moment, so the parallel ones find the
// server's prompt cache warm instead of each paying to write it.
let lastDecisionAt = 0;
let coldFirst = null;
async function coldGate() {
  if (Date.now() - lastDecisionAt < 5 * 60_000) return null;
  if (coldFirst) { await Promise.race([coldFirst.promise, sleep(3000)]); return null; }
  let resolve;
  coldFirst = { promise: new Promise((r) => { resolve = r; }) };
  coldFirst.resolve = resolve;
  return coldFirst;
}

/** Post a read to the server. Runs on its own; the lane goes on with other chats meanwhile. */
function postInbound(lane, k, readSig, payload, meta) {
  const conv = meta.conv;
  if (conv) lane.threadCalls.set(conv, (lane.threadCalls.get(conv) || 0) + 1);
  (async () => {
    // A customer video goes first, whole, so the report can name it. Time limited, never fails the report.
    await attachVideo(lane, payload, meta.tabId ?? null).catch((err) => console.warn('[acx] video upload failed', err?.message || err));
    const mine = await coldGate();
    let decision = null;
    let error = null;
    try {
      decision = await api.inbound(payload);
      lastDecisionAt = Date.now();
    } catch (err) {
      error = err;
    } finally {
      if (mine) { mine.resolve(); if (coldFirst === mine) coldFirst = null; }
    }
    const e = lane.seen[k];
    const now = Date.now();
    if (error) {
      const status = error.status || 0;
      if (!e) return;
      if (status === 0) {
        // No connection: the server never got it. Try again soon, without using up the chat's tries.
        e.net_fails = (e.net_fails || 0) + 1;
        e.retry_at = now + core.backoffMs(e.net_fails);
      } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        e.tries = (e.tries || 0) + 1; // the server refused this report: three tries, then a pause
        e.failed_at = now;
      } else {
        // A server error: like a decision that is not final.
        e.fails = (e.fails || 0) + 1;
        if (e.fails > core.MAX_NONFINAL_RETRIES) { e.reported = readSig; e.fails = 0; } // the server sweeper owns it now
        else e.retry_at = now + core.STREAM_CUT_RETRY_MS + Math.round(Math.random() * 3000);
      }
      console.warn('[acx] inbound failed', lane.id, error?.message || error);
      return;
    }
    const d = core.readDecision(decision);
    for (const job of d.jobs) enqueue(lane, job, { readAt: meta.readAt, conv: conv || job.target?.thread_external_id || null, key: k, tail: meta.tail, source: 'inline' });
    // Jobs were queued that did not come back in this answer, or the answer was cut: sync for them.
    if (d.jobsPending) syncSoon(0);
    else if (d.cut) syncSoon(core.STREAM_CUT_RETRY_MS);
    if (!e) return;
    e.net_fails = 0;
    if (d.final) {
      e.reported = readSig;
      e.fails = 0;
      e.retry_at = 0;
    } else {
      e.fails = (e.fails || 0) + 1;
      if (e.fails > core.MAX_NONFINAL_RETRIES) { e.reported = readSig; e.fails = 0; } // leave it to the server sweeper
      else e.retry_at = now + d.retryAfterMs + Math.round(Math.random() * 1000);
    }
  })().catch((err) => console.warn('[acx] inbound handling failed', err?.message || err)).finally(() => {
    if (conv) {
      const n = (lane.threadCalls.get(conv) || 1) - 1;
      if (n > 0) lane.threadCalls.set(conv, n); else lane.threadCalls.delete(conv);
    }
    const e = lane.seen[k];
    if (e) e.inflight_until = 0;
    lane.inflight.delete(k);
    saveSeen(lane);
    kick(lane);
    // Another lane may be waiting for a free slot under the laptop wide cap.
    for (const other of lanes) if (other !== lane && !other.running) kick(other);
  });
}

// ---- whole customer videos, for the vision model ----------------------------------------------------
// The tab keeps the bytes of the newest customer video (WhatsApp) or names its https address (Gmail,
// TikTok). Here they are pulled or fetched and sent to the server, which streams them to Google AI
// Studio and answers a ref; the report then carries media.video_ref next to the video's cover. Any
// failure (a cap, the switch off, no connection, too slow) is a diagnostic note: the frames and the
// cover still go.
// A video never holds the reply up for long: pulling and uploading it has VIDEO_WAIT_MS in all (the
// customer's typed question waits in the same report), and a video this laptop's upload speed cannot
// send in that time is not tried. The server is asked first, so a video already described, or still
// held by Google from an earlier read, is never pulled, sent or counted twice. What was sent or found
// described is remembered in chrome.storage.session for VIDEO_REMEMBER_MS (it survives the worker
// stopping), and the read op is told those message ids so the tab does not open the video again.

const VIDEO_WAIT_MS = 15_000;
const VIDEO_CHUNK = 1024 * 1024;
const VIDEO_REMEMBER_MS = 6 * 3600_000;
const VIDEO_REFS_KEY = 'video_refs';
const VIDEO_UPLINK_KEY = 'video_uplink';
let videoRefs = null; // `${channel}:${message id}` -> { ref?, described?, at }, loaded from session storage once
let videoPauseUntil = 0; // after a daily cap or "switched off" answer: no pulling 20 MB for nothing

async function loadVideoRefs() {
  if (videoRefs) return videoRefs;
  let saved = {};
  try { saved = (await store.sessionGet(VIDEO_REFS_KEY, {})) || {}; } catch { saved = {}; }
  const now = Date.now();
  videoRefs = new Map(Object.entries(saved).filter(([, e]) => e && now - (e.at || 0) < VIDEO_REMEMBER_MS));
  return videoRefs;
}

async function rememberVideo(key, entry) {
  const refs = await loadVideoRefs();
  refs.set(key, { ...entry, at: Date.now() });
  const now = Date.now();
  for (const [k, e] of refs) if (now - (e.at || 0) > VIDEO_REMEMBER_MS) refs.delete(k);
  while (refs.size > 300) refs.delete(refs.keys().next().value);
  try { await store.sessionSet(VIDEO_REFS_KEY, Object.fromEntries(refs)); } catch { /* memory copy still works */ }
}

/** Message ids of this channel's videos that are sent or described already: the tab leaves them shut. */
async function videosDone(channel) {
  const refs = await loadVideoRefs();
  const out = [];
  for (const k of refs.keys()) if (k.startsWith(`${channel}:`)) out.push(k.slice(channel.length + 1));
  return out.slice(-100);
}

/** Bytes a second this laptop last managed to upload a video at (null before the first one). */
async function uplinkBps() {
  try {
    const u = (await chrome.storage.local.get(VIDEO_UPLINK_KEY))[VIDEO_UPLINK_KEY];
    return u && Number.isFinite(u.bps) && u.bps > 0 && Date.now() - (u.at || 0) < 7 * 86400_000 ? u.bps : null;
  } catch { return null; }
}
async function noteUplink(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return;
  try { await chrome.storage.local.set({ [VIDEO_UPLINK_KEY]: { bps: Math.round(bps), at: Date.now() } }); } catch { /* ignore */ }
}

function bytesOf(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The bytes the tab holds under `token`, piece by piece, as a Blob. */
async function pullVideo(lane, tabId, token, deadline) {
  const parts = [];
  let offset = 0;
  let mime = '';
  for (let n = 0; n < 40; n++) {
    const left = deadline - Date.now();
    if (left < 500) throw new Error('timeout');
    const res = await tabOp(lane, 'video_chunk', { token, offset, size: VIDEO_CHUNK }, Math.min(10_000, left), tabId);
    if (!res.ok || !res.data || typeof res.data.data !== 'string') throw new Error(res.error_code || 'no_chunk');
    const piece = bytesOf(res.data.data);
    parts.push(piece);
    offset += piece.length;
    mime = res.data.mime || mime;
    if (res.data.done || offset >= (res.data.total || 0) || !piece.length) break;
  }
  return new Blob(parts, { type: mime || 'video/mp4' });
}

/** Upload the newest customer video of a report (at most one) and put its ref on the media. Never throws. */
async function attachVideo(lane, payload, tabId) {
  const msgs = Array.isArray(payload?.messages) ? payload.messages : [];
  const refs = await loadVideoRefs();
  // A video sent on an earlier read that the tab left shut this time: its ref still goes with its cover.
  for (const m of msgs) {
    if (!m || m.direction !== 'in' || !m.media || m.media.video || m.media.video_ref || !m.external_id) continue;
    const had = refs.get(`${lane.channel}:${m.external_id}`);
    if (had && had.ref) m.media.video_ref = had.ref;
  }
  const target = [...msgs].reverse().find((m) => m && m.direction === 'in' && m.media && m.media.video);
  if (!target) return;
  const v = target.media.video;
  const started = Date.now();
  const deadline = started + VIDEO_WAIT_MS;
  const message = target.external_id ? String(target.external_id) : '';
  const thread = payload?.thread?.external_id ? String(payload.thread.external_id) : '';
  const key = `${lane.channel}:${message || v.url || v.token}`;
  const known = refs.get(key);
  if (known) { if (known.ref) target.media.video_ref = known.ref; return; }
  if (Date.now() < videoPauseUntil || config?.vision?.whole_videos === false) return;
  let step = 'check';
  try {
    // Needed at all? One small call, before 20 MB are pulled out of the tab.
    if (message) {
      const chk = await api.checkVideo({ channel: lane.channel, message, thread }).catch(() => null);
      if (chk && chk.ref) { target.media.video_ref = chk.ref; await rememberVideo(key, { ref: chk.ref }); return; }
      if (chk && chk.described) { await rememberVideo(key, { described: true }); return; }
      if (chk && chk.upload === false) {
        if (chk.why === 'daily_cap' || chk.why === 'vision_off') videoPauseUntil = Date.now() + (chk.why === 'daily_cap' ? 3600_000 : 600_000);
        throw Object.assign(new Error(chk.why || 'not_needed'), { code: chk.why || 'not_needed' });
      }
    }
    // This laptop's upload speed says it cannot be sent in time: the frames and the cover go instead.
    const bps = await uplinkBps();
    const size = Number(v.bytes) || 0;
    if (bps && size && (size / bps) * 1000 > deadline - Date.now() - 1000) throw Object.assign(new Error('too_slow'), { code: 'too_slow' });
    step = 'bytes';
    let blob = null;
    if (v.token && tabId != null) blob = await pullVideo(lane, tabId, v.token, deadline);
    else if (v.url) {
      const got = await fetchVideo(lane.channel, v.url, Math.max(1000, deadline - Date.now()));
      if (!got.ok) throw new Error(got.error);
      blob = got.blob;
    }
    if (!blob || !blob.size) throw new Error('no_bytes');
    const left = deadline - Date.now();
    if (bps && (blob.size / bps) * 1000 > left - 500) throw Object.assign(new Error('too_slow'), { code: 'too_slow' });
    if (left < 1500) throw Object.assign(new Error('timeout'), { code: 'timeout' });
    step = 'upload';
    const upAt = Date.now();
    let res;
    try {
      res = await api.uploadVideo(blob, { mime: v.mime || blob.type, seconds: v.seconds ?? target.media.seconds, channel: lane.channel, message, thread, timeoutMs: left });
    } catch (err) {
      // Cut off at the time limit: this laptop sends slower than that, so a video this big is not tried again soon.
      if (err?.code === 'timeout') await noteUplink((blob.size / Math.max(1, Date.now() - upAt)) * 1000 * 0.9);
      throw err;
    }
    // A small clip says more about the delay than the speed: only a bigger one updates the estimate.
    if (!res?.reused && blob.size >= 1024 * 1024) await noteUplink((blob.size / Math.max(1, Date.now() - upAt)) * 1000);
    if (res && typeof res.ref === 'string') {
      target.media.video_ref = res.ref;
      await rememberVideo(key, { ref: res.ref });
    }
  } catch (err) {
    const code = String(err?.code || err?.message || 'failed').slice(0, 60);
    if (code === 'daily_cap' || code === 'vision_off') videoPauseUntil = Date.now() + (code === 'daily_cap' ? 3600_000 : 600_000);
    if (code === 'already_described') { await rememberVideo(key, { described: true }); return; }
    api.diagnostics(lane.channel, 'note', { video_upload: code, step, bytes: v.bytes || null, ms: Date.now() - started }).catch(() => {});
  }
}

// ---- the send queue -------------------------------------------------------------------------------

/**
 * Replies the agent wrote by itself for a chat as it was read. Only these are checked against the read
 * before sending (newer_message, owner_replied) and dropped for good when refused: the server cancels
 * them. A code message, the owner's words and anything else the server offers again still fit whatever
 * came after them, so they never carry a tail and are never refused for a newer message.
 */
const TAIL_SOURCES = new Set(['auto', 'holding']);

/** When the lease of a job ends on this laptop's clock: from the time left the server gave, else its end time and the clock offset. */
function leaseAtFor(job, now) {
  if (Number.isFinite(job.lease_ms) && job.lease_ms > 0) return now + job.lease_ms - 2000;
  if (Number.isFinite(job.lease_until) && job.lease_until > 0) return job.lease_until + clockOffset;
  return 0;
}

/** Put a job in its lane's queue, once (jobs are deduped by id). */
function enqueue(lane, job, meta) {
  if (!job || !job.id) return;
  if (droppedJobs.has(job.id)) return; // the server cancelled it after handing it out
  const now = Date.now();
  const existing = lane.queue.find((it) => it.job.id === job.id);
  if (existing) {
    // The same job again (a sync after an inline answer): keep the newer lease.
    const at = leaseAtFor(job, now);
    if (at > (existing.leaseAt || 0)) {
      existing.leaseAt = at;
      existing.job = { ...existing.job, lease_until: job.lease_until, lease_ms: job.lease_ms };
      saveQueue(lane);
    }
    return;
  }
  if (lane.job && lane.job.job.id === job.id) return; // being typed right now
  const conv = meta.conv ?? job.target?.thread_external_id ?? null;
  let tail = TAIL_SOURCES.has(job.source) ? meta.tail ?? null : null;
  if (!tail && conv && TAIL_SOURCES.has(job.source)) {
    // A reply the agent wrote by itself that came through the sync: check it against the latest read.
    const r = lane.reads.get(conv);
    if (r && now - r.at < 15 * 60_000) tail = r.tail;
  }
  lane.queue.push({
    job, seq: ++lane.seq, arrived: now, readAt: meta.readAt ?? null, leaseAt: leaseAtFor(job, now),
    sendAt: core.sendAtFor(job, meta.readAt ?? null, now), thread: conv, key: meta.key ?? null, tail, source: meta.source, requeued: 0,
  });
  saveQueue(lane);
  kick(lane);
}

// Agent replies refused because the customer wrote again: never sent later, even if offered once more.
const NEWER_KEY = 'newer_jobs';
async function newerJobs() { const l = await store.sessionGet(NEWER_KEY, []).catch(() => []); return Array.isArray(l) ? l : []; }
async function rememberNewer(id) { const l = await newerJobs(); if (!l.includes(id)) { l.push(id); await store.sessionSet(NEWER_KEY, l.slice(-200)).catch(() => {}); } }

// Refused agent replies whose result the server may not have yet, by job id: the next read of that chat
// names them (refused_job_ids) so the server drops them before it decides again. Gone once the result is in.
const refusedJobs = new Map(); // job id -> { conv, at }
function refusedFor(conv) {
  const now = Date.now();
  const out = [];
  for (const [id, r] of refusedJobs) {
    if (now - r.at > 10 * 60_000) refusedJobs.delete(id);
    else if (r.conv === conv) out.push(id);
  }
  return out.slice(-5);
}

// Jobs the server cancelled after handing them out (a pause, an opt out, a takeover): never sent.
const droppedJobs = new Set();
/** The sync named jobs this laptop holds that must not go out any more: take them out of the queues. */
function dropCancelled(ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  for (const id of ids) { if (typeof id === 'string') droppedJobs.add(id); }
  if (droppedJobs.size > 400) droppedJobs.delete(droppedJobs.values().next().value);
  for (const lane of lanes) {
    const n = lane.queue.length;
    lane.queue = lane.queue.filter((it) => !droppedJobs.has(it.job.id));
    if (lane.queue.length !== n) saveQueue(lane);
  }
}
/** The job ids every lane holds (queued or being typed), sent with each sync. */
const heldJobs = () => lanes.flatMap((l) => [...l.queue.map((it) => it.job.id), ...(l.job ? [l.job.job.id] : [])]).slice(0, 40);
// This laptop's clock minus the server's (from the last sync), for old servers that send no lease_ms.
let clockOffset = 0;

// ---- send in progress (memory for speed, session storage so a restarted worker still knows) -----------

const jobBusyKey = (lane) => `job_busy:${lane.name}`;
async function setJobBusy(lane, on) {
  try { await store.sessionSet(jobBusyKey(lane), on ? Date.now() + 6 * 60_000 : 0); } catch { /* ignore */ }
}
async function jobBusy(lane) {
  if (lane.job || lane.op) return true;
  try { return (await store.sessionGet(jobBusyKey(lane), 0)) > Date.now(); } catch { return false; }
}

async function waitForReady(lane, timeoutMs, tabId) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(1500);
    const tab = await tabById(lane, tabId);
    if (!tab || tab.status !== 'complete') continue;
    const res = await tabOp(lane, 'probe', {}, 6000, tabId);
    if (res.ok && res.data?.state === 'ready') return true;
    if (res.ok && (res.data?.state === 'logged_out' || res.data?.state === 'blocked')) return false;
  }
  return false;
}

/** Send one queued job in the lane's tab and report how it went. */
async function sendJob(lane, item, dueCount = 0) {
  lane.queue = lane.queue.filter((it) => it !== item);
  lane.job = item;
  lane.readsSinceSend = 0;
  const job = item.job;
  await setJobBusy(lane, true);
  try {
    if (await store.isDone(job.id)) {
      // Already typed and sent, but the confirmation was lost. Confirm again, never send twice.
      await deliverResult(job.id, { status: 'sent' });
      return;
    }
    if (droppedJobs.has(job.id)) return; // cancelled by the server meanwhile: nothing to send or report
    if (TAIL_SOURCES.has(job.source) && (await newerJobs()).includes(job.id)) {
      await deliverResult(job.id, { status: 'failed', error_code: 'newer_message', error: 'The customer wrote again before this reply went out', retryable: false });
      return;
    }
    const tabId = lane.tabId;
    if (tabId == null) { await requeueOrFail(lane, item, { ok: false, error_code: 'tab_missing', error: 'Tab closed', retryable: true }); return; }

    let prepared = { ready: true };
    if (job.kind === 'new_chat') {
      const prep = await laneOp(lane, 'prepare', { job }, 20_000);
      if (!prep.ok) { await finishJob(lane, item, prep); return; }
      prepared = prep.data || { ready: true };
      if (prepared.navigate) {
        try { await chrome.tabs.update(tabId, { url: prepared.navigate }); } catch {
          await finishJob(lane, item, { ok: false, error_code: 'tab_missing', error: 'Tab closed', retryable: true });
          return;
        }
        if (!(await waitForReady(lane, 75_000, tabId))) {
          await finishJob(lane, item, { ok: false, error_code: 'timeout', error: 'Page did not load after opening the chat', retryable: true });
          return;
        }
        lane.probe = { ...lane.probe, state: 'ready', at: Date.now() };
      }
    }
    // Other customers waiting in this lane: the old human pauses (typing_cps 1 to 199) shrink to floors.
    const other = lane.queue.length + lane.inflight.size + dueCount;
    const res = await laneOp(lane, 'send', {
      job, navigated: Boolean(prepared.navigate), newer_than: TAIL_SOURCES.has(job.source) ? item.tail || null : null, budget_ms: core.sendBudget(other),
    }, 150_000);
    await finishJob(lane, item, res);
  } finally {
    lane.job = null;
    lane.lastSendAt = Date.now();
    lane.lastSendThread = item.thread || `job:${job.id}`;
    await setJobBusy(lane, false);
    saveQueue(lane);
  }
}

/** The tab went away or reloaded before anything was typed: keep the job for when it is ready again. */
async function requeueOrFail(lane, item, res) {
  if ((item.requeued || 0) < 3) {
    lane.queue.push({ ...item, requeued: (item.requeued || 0) + 1 });
    saveQueue(lane);
    return;
  }
  await deliverResult(item.job.id, { status: 'failed', error_code: res.error_code || 'tab_missing', error: res.error || '', retryable: true });
}

/**
 * A message went out in a chat after it was read: the read's picture of the chat (its tail) now has
 * that many more of our messages at the end, so a later reply checked against the same read never
 * takes them for the owner's (even after the page reloaded and forgot what it sent).
 */
function bumpTails(lane, thread, n) {
  if (!thread || !n) return;
  const bump = (t) => (t && typeof t.outs_after === 'number' ? { ...t, outs_after: t.outs_after + n } : t);
  const r = lane.reads.get(thread);
  if (r) r.tail = bump(r.tail);
  let changed = false;
  for (const it of lane.queue) if (it.thread === thread && it.tail) { it.tail = bump(it.tail); changed = true; }
  if (changed) saveQueue(lane);
}

async function finishJob(lane, item, res) {
  const job = item.job;
  if (res.ok) {
    await store.rememberDone(job.id);
    await deliverResult(job.id, { status: 'sent', sent_external_ids: res.data?.sent_external_ids || [] });
    // Gmail sends a job's parts as one email.
    if (!res.data?.already_sent) bumpTails(lane, item.thread, lane.channel === 'gmail' ? 1 : (job.parts || []).length);
    if (item.source === 'sync') syncSoon(1500); // the server may hold more for this channel
    return;
  }
  if (res.error_code === 'newer_message') {
    if (!TAIL_SOURCES.has(job.source)) {
      // A code message or the owner's words: the server offers it again and it goes out as it is.
      await deliverResult(job.id, { status: 'failed', error_code: 'newer_message', error: res.error || 'The customer wrote again', retryable: true });
      return;
    }
    // The reply is out of date. The server drops it (cancelled; older servers mark it failed), and
    // the chat is read again so one fresh decision covers every message.
    await rememberNewer(job.id);
    if (item.thread) refusedJobs.set(job.id, { conv: item.thread, at: Date.now() });
    await deliverResult(job.id, { status: 'failed', error_code: 'newer_message', error: res.error || 'The customer wrote again', retryable: false });
    for (const [k, e] of Object.entries(lane.seen)) {
      if (e && (k === item.key || (item.thread && e.thread === item.thread))) { e.reported = null; e.fails = 0; e.retry_at = 0; }
    }
    saveSeen(lane);
    return;
  }
  if (res.error_code === 'owner_replied') {
    // The owner answered this customer by hand after the read: the server drops the reply and the
    // agent stays out of the chat. Nothing to read again.
    await rememberNewer(job.id);
    await deliverResult(job.id, { status: 'failed', error_code: 'owner_replied', error: res.error || 'You already replied in this chat', retryable: false });
    return;
  }
  if (res.error_code === 'no_content_script' || res.error_code === 'tab_missing') {
    // Nothing reached the page: safe to try again once the tab is back.
    await requeueOrFail(lane, item, res);
    return;
  }
  await deliverResult(job.id, { status: 'failed', error_code: res.error_code || 'unknown', error: res.error || '', retryable: res.retryable !== false });
  if (res.error_code === 'blocked' || res.error_code === 'logged_out') {
    // A captcha, a "too fast" notice or a sign out stops the whole lane until a probe says it is ready.
    lane.probe = { ...lane.probe, state: res.error_code === 'blocked' ? 'blocked' : 'logged_out' };
    syncSoon(1000);
  }
}

// ---- job results (kept until the server has them) -------------------------------------------------------

const RESULTS_KEY = 'results_pending';
let resultsChain = Promise.resolve();
const resultsBusy = new Set();
function withResults(fn) {
  resultsChain = resultsChain.then(async () => {
    const list = await store.sessionGet(RESULTS_KEY, []).catch(() => []);
    const out = await fn(Array.isArray(list) ? list : []);
    if (out) await store.sessionSet(RESULTS_KEY, out).catch(() => {});
  }).catch(() => {});
  return resultsChain;
}

/**
 * Report a job's outcome. It is kept in session storage first, then posted without holding the lane;
 * a failed post is tried again after 2, 5 and 10 s, then on every sync, until the server has it.
 */
async function deliverResult(jobId, result) {
  await withResults((list) => [...list.filter((r) => r.id !== jobId), { id: jobId, result, tries: 0, at: Date.now() }]);
  postResult(jobId).catch(() => {});
}

async function postResult(jobId) {
  if (resultsBusy.has(jobId)) return;
  let entry = null;
  await withResults((list) => { entry = list.find((r) => r.id === jobId) || null; return null; });
  if (!entry) return;
  resultsBusy.add(jobId);
  let done = false;
  try {
    await api.jobResult(jobId, entry.result);
    done = true;
  } catch (err) {
    const s = err?.status || 0;
    if (s >= 400 && s < 500 && s !== 408 && s !== 429) done = true; // the server will never take it (unknown job)
  } finally {
    resultsBusy.delete(jobId);
  }
  if (done) { refusedJobs.delete(jobId); await withResults((list) => list.filter((r) => r.id !== jobId)); return; }
  let tries = 0;
  await withResults((list) => list.map((r) => (r.id === jobId ? { ...r, tries: (tries = (r.tries || 0) + 1) } : r)));
  if (tries <= core.RESULT_RETRY_MS.length) setTimeout(() => { postResult(jobId); }, core.RESULT_RETRY_MS[tries - 1]);
}

/** Results still waiting from earlier (the server was away): try them again. Dropped after a day. */
async function flushResults() {
  let ids = [];
  await withResults((list) => {
    const keep = list.filter((r) => Date.now() - (r.at || 0) < 24 * 3600_000);
    ids = keep.map((r) => r.id);
    return keep.length !== list.length ? keep : null;
  });
  for (const id of ids) postResult(id);
}

// ---- per lane health (chrome.storage.session, one key per lane so lanes never clobber each other)

const healthKey = (lane) => `health:${lane.name}`;
async function getHealth(lane) {
  try {
    const h = await store.sessionGet(healthKey(lane), null);
    return h && typeof h === 'object' ? h : {};
  } catch { return {}; }
}
const saveHealth = (lane, h) => store.sessionSet(healthKey(lane), h).catch(() => {});
const healthChains = new Map();
function patchHealth(lane, patch) {
  // Serialised per lane: a scan, a read and the watchdog may all write at once. `patch` is the keys to
  // set, or a function that edits the fresh record in place.
  const prev = healthChains.get(lane.id) || Promise.resolve();
  const next = prev.then(async () => {
    const h = await getHealth(lane);
    if (typeof patch === 'function') patch(h); else Object.assign(h, patch);
    await saveHealth(lane, h);
    return h;
  }).catch(() => ({}));
  healthChains.set(lane.id, next);
  return next;
}
/** The health keys the watchdog and the tab healing own. They never write back a whole old record. */
const WATCHDOG_KEYS = ['stage', 'stage_at', 'alive_at', 'watch_from', 'loading_since', 'tab_id', 'rec_times', 'rec_at', 'rec_day', 'rec_today', 'last_recovery', 'last_recovery_at'];
/** Save what the watchdog changed in its copy `h` (taken at `before`), leaving the lane's own writes made meanwhile alone. */
function saveOwn(lane, before, h) {
  const patch = {};
  for (const k of WATCHDOG_KEYS) if (h[k] !== undefined) patch[k] = h[k];
  if (h.last_error !== before.last_error) patch.last_error = h.last_error;
  return patchHealth(lane, patch);
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

// ---- tabs -------------------------------------------------------------------------------------------

/** The Gmail address the owner chose in the dashboard, or '' for Chrome's first account. */
async function gmailAccount() {
  const cfg = await store.get('config');
  return String(cfg?.gmail_account || '').trim().toLowerCase();
}

async function homeUrl(lane) {
  const sel = await store.get('selectors').catch(() => null);
  return lane.def.home({
    account: lane.channel === 'gmail' ? await gmailAccount() : '',
    business,
    pack: sel?.pack?.[lane.channel] || null,
  });
}

const onLanePage = (lane, url) => { const u = parseUrl(url); return Boolean(u && lane.def.page(u)); };
const onAwayPage = (lane, url) => { const u = parseUrl(url); return Boolean(u && lane.def.page(u) && lane.def.away(u)); };
const onOwnSite = (lane, url) => { const u = parseUrl(url); return Boolean(u && lane.def.site(u)); };

/**
 * The one tab the lane works in. When the page is open more than once it keeps the tab it used
 * before, else the chosen Gmail account, else the pinned one, else the oldest; a tab on a page the
 * lane can work in beats one it would have to send home. A tab another lane holds is never taken.
 * The others are never read or typed into. `acxCount` says how many tabs of the page are open.
 */
async function findTab(lane) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: lane.def.match }); } catch { tabs = []; }
  const taken = new Set(lanes.filter((l) => l !== lane && l.tabId != null).map((l) => l.tabId));
  const sticky = await store.sessionGet(`tab:${lane.id}`, 0).catch(() => 0);
  const opened = await store.sessionGet('opened_tabs', {}).catch(() => ({}));
  // A tab on a page the lane would have to send home (TikTok Business Suite) is only taken when it is
  // the agent's own: the one it used, one it opened, or a pinned one (the agent pins its tabs). The
  // owner's own Business Suite tab is never moved: a pinned messages tab is opened instead.
  const ours = (t) => t.id === sticky || t.id === opened[lane.id] || Boolean(t.pinned);
  tabs = tabs.filter((t) => onLanePage(lane, t.url || t.pendingUrl) && !taken.has(t.id) && (!onAwayPage(lane, t.url || t.pendingUrl) || ours(t)));
  if (!tabs.length) return null;
  const working = tabs.filter((t) => !onAwayPage(lane, t.url || t.pendingUrl));
  const pool = working.length ? working : tabs;
  let pick = null;
  if (lane.channel === 'gmail') {
    // Gmail puts the account address in the tab title: prefer the tab showing the chosen inbox.
    const account = await gmailAccount();
    pick = account ? pool.find((t) => (t.title || '').toLowerCase().includes(account)) || null : null;
  }
  if (!pick && sticky) pick = pool.find((t) => t.id === sticky) || null;
  if (!pick) pick = [...pool].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.id - b.id)[0];
  if (pick.id !== sticky) await store.sessionSet(`tab:${lane.id}`, pick.id).catch(() => {});
  return Object.assign(pick, { acxCount: tabs.length });
}

/** The tab with this id, when it still shows the lane's page. */
async function tabById(lane, tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab && onLanePage(lane, tab.url || tab.pendingUrl) ? tab : null;
  } catch { return null; }
}

/**
 * Send a tab back to the lane's home page, at most once every 10 minutes per lane: if the site keeps
 * moving it away, stop and say where it went instead of reloading it forever.
 */
async function sendHome(lane, tabId, { away = false } = {}) {
  const tries = await store.sessionGet('return_tries', {}).catch(() => ({}));
  if (Date.now() - (tries[lane.id] || 0) <= 10 * 60_000) return false;
  // The site keeps moving the tab back (TikTok sends business accounts to Business Suite): after a few
  // trips, stop moving it and say so, instead of sending it back and forth every 10 minutes all day.
  const trips = (tries[`${lane.id}:away`] || 0) + (away ? 1 : 0);
  if (away && trips > AWAY_TRIPS_MAX) return false;
  tries[lane.id] = Date.now();
  tries[`${lane.id}:away`] = trips;
  await store.sessionSet('return_tries', tries).catch(() => {});
  try { await chrome.tabs.update(tabId, { url: await homeUrl(lane) }); return true; } catch { return false; }
}
const AWAY_TRIPS_MAX = 3;
/** The tab is working on its own page again: the next trip away starts a fresh count. */
async function homeReached(lane) {
  const tries = await store.sessionGet('return_tries', {}).catch(() => ({}));
  if (!tries[`${lane.id}:away`]) return;
  tries[`${lane.id}:away`] = 0;
  await store.sessionSet('return_tries', tries).catch(() => {});
}

async function ensureTab(lane, autoOpen) {
  let tab = await findTab(lane);
  if (!tab) {
    // A tab we opened may have been redirected to a sign in page on another address. Do not open
    // another one every time: keep it, and report it as logged out.
    const opened = await store.sessionGet('opened_tabs', {}).catch(() => ({}));
    if (opened[lane.id]) {
      try {
        const away = await chrome.tabs.get(opened[lane.id]);
        // Signed in, but the site moved the tab to another of its own pages (TikTok goes to the
        // home feed after logging in): bring it back to the page the agent works on.
        if (onOwnSite(lane, away.url) && (await sendHome(lane, away.id))) return { ...away, status: 'loading', acxCount: 1 };
        return { ...away, acxAway: true, acxOwnSite: onOwnSite(lane, away.url), acxCount: 1 };
      } catch { delete opened[lane.id]; await store.sessionSet('opened_tabs', opened).catch(() => {}); }
    }
    if (autoOpen) {
      try {
        tab = await chrome.tabs.create({ url: await homeUrl(lane), active: false, pinned: true });
        opened[lane.id] = tab.id;
        await store.sessionSet('opened_tabs', opened);
        await store.sessionSet(`tab:${lane.id}`, tab.id);
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
async function tabOp(lane, op, args, timeoutMs = 30_000, tabId = null) {
  const tab = tabId != null ? await tabById(lane, tabId) : await findTab(lane);
  if (!tab) return { ok: false, error_code: 'tab_missing', error: `No ${lane.def.label} tab is open`, retryable: true };
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
 * Reload or replace a lane's tab, within the limits: never while the lane has work in hand (a tab
 * operation, a reply being sent, a queued reply or an inbound call), at most one action per
 * `recovery_gap_ms` and `max_recoveries_per_hour` per lane. `force` is only for a tab that cannot
 * run anything at all (Chrome unloaded it, or it has no agent script): its queued replies wait in
 * the lane and go out once it is ready. Mutates `h` (the lane's health record); the caller saves it.
 * Returns true when something was done.
 */
async function recover(lane, tabId, kind, why, h, T, { force = false } = {}) {
  const now = Date.now();
  if (await jobBusy(lane)) return false;
  // Queued replies, reads waiting on the server and inbound calls live here, not in the page: a reload
  // loses none of them. They only hold off a reload while the lane can actually work.
  if (!force && laneActive(lane) && (lane.queue.length || lane.inflight.size || lane.threadCalls.size)) return false;
  // A tab that just did something right is not reloaded on an old verdict.
  if (!force && laneActive(lane) && now - (lane.opOkAt || 0) < aliveWindow(lane)) return false;
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
      const fresh = await chrome.tabs.create({ url: await homeUrl(lane), active: false, pinned: true, ...(windowId != null ? { windowId } : {}) });
      try { await chrome.tabs.update(fresh.id, { autoDiscardable: false }); } catch { /* ignore */ }
      try { await chrome.tabs.remove(tabId); } catch { /* already gone */ }
      await store.sessionSet(`tab:${lane.id}`, fresh.id);
      const opened = await store.sessionGet('opened_tabs', {});
      opened[lane.id] = fresh.id;
      await store.sessionSet('opened_tabs', opened);
      h.tab_id = fresh.id; // the same healing goes on in the new tab
      done = 'Opened a fresh tab';
    }
  } catch (err) {
    h.last_error = `${why}. Could not fix the tab (${String(err?.message || err).slice(0, 80)})`;
    return false;
  }
  lane.probe = { ...lane.probe, state: 'loading' };
  h.rec_times.push(now);
  h.rec_at = now;
  if (h.rec_day !== today()) { h.rec_day = today(); h.rec_today = 0; }
  h.rec_today = (h.rec_today || 0) + 1;
  h.last_recovery = `${done}: ${why}`;
  h.last_recovery_at = now;
  h.last_error = why;
  console.warn('[acx] self heal', lane.id, done, why);
  api.diagnostics(lane.channel, 'note', { where: 'watchdog', lane: lane.id, action: kind, why, recoveries_today: h.rec_today }).catch(() => {});
  return true;
}

/**
 * Called on each sync per lane. A lane that is working is alive when any tab operation (scan, read
 * or send) worked in the last minute; one that is not working (switched off, page not ready) is
 * alive when its probe answered with a settled state.
 */
const aliveWindow = (lane) => Math.max(60_000, 3 * lane.def.idleScanMs);

async function watchdog(lane, info, T) {
  const now = Date.now();
  const h = await getHealth(lane);
  const before = { ...h };
  const saveHealth = (l) => saveOwn(l, before, h); // only the watchdog's own keys: the lane keeps writing meanwhile
  if (!info.tabId || info.away) {
    // No tab, or a tab the loop guards already handle (redirected, logged out): nothing to heal.
    h.stage = 0; h.tab_id = info.tabId || null; h.watch_from = now; h.loading_since = 0;
    await saveHealth(lane, h);
    return;
  }
  if (h.tab_id !== info.tabId) { h.tab_id = info.tabId; h.watch_from = now; h.stage = 0; } // a new tab gets a fresh start
  if (!h.watch_from) h.watch_from = now;
  // A page that answers "loading" is given longer: WhatsApp can take minutes to sync after a night off.
  if (info.answeredLoading) h.loading_since = h.loading_since || now;
  else h.loading_since = 0;
  const scanExpected = laneActive(lane);
  const lastGood = Math.max(lane.opOkAt || 0, h.last_ok_at || 0);
  const aliveNow = scanExpected ? now - lastGood < aliveWindow(lane) : Boolean(info.probeOk);
  const alive = aliveNow || (info.answeredLoading && now - h.loading_since < T.loading_ms);
  if (alive) {
    h.alive_at = now;
    h.stage = 0;
    await saveHealth(lane, h);
    return;
  }
  const since = Math.max(h.alive_at || 0, h.watch_from || 0);
  const deadFor = now - since;
  // Reads keep timing out while chats wait: start healing sooner (still inside the gap and the cap).
  const stall = lane.timeouts >= 2 && dueReads(lane, now).length ? Math.min(T.stall_ms, 45_000) : T.stall_ms;
  if (deadFor < stall || (await jobBusy(lane))) { await saveHealth(lane, h); return; }

  const why = scanExpected ? `No good read for ${howLong(deadFor)}` : `The page has not answered for ${howLong(deadFor)}`;
  if (!h.stage) {
    // Step 1: ask once more, with more patience. Enough when only the probe was missing.
    const again = await tabOp(lane, 'probe', {}, T.wake_probe_ms, info.tabId);
    const answered = again.ok && again.data && ALIVE_STATES.includes(again.data.state) && !((again.data.busy_ms || 0) > STUCK_OP_MS);
    if (answered && !scanExpected) { h.alive_at = Date.now(); await saveHealth(lane, h); return; }
    // The lane did a good scan, read or send while this probe waited: it recovered by itself.
    if (scanExpected && Date.now() - (lane.opOkAt || 0) < aliveWindow(lane)) { h.alive_at = Date.now(); h.stage = 0; await saveHealth(lane, h); return; }
    // Step 2: reload.
    if (await recover(lane, info.tabId, 'reload', why, h, T)) { h.stage = 1; h.stage_at = Date.now(); }
  } else if (now - (h.stage_at || 0) >= T.replace_after_ms) {
    // Step 3: still dead after the reload: replace the tab. After that, reload and replace take turns
    // (always inside the gap and the hourly cap).
    const kind = h.stage === 1 ? 'replace' : 'reload';
    if (await recover(lane, info.tabId, kind, `${why} after a reload`, h, T)) { h.stage = kind === 'replace' ? 2 : 1; h.stage_at = Date.now(); }
  }
  await saveHealth(lane, h);
}

// ---- probes and status -------------------------------------------------------------------------------

function duplicateNote(lane, tab) {
  if (!tab || !(tab.acxCount > 1)) return '';
  return `${tab.acxCount} ${lane.def.label} tabs are open. The agent only uses the ${tab.pinned ? 'pinned' : 'first'} one`;
}
const joinDetail = (...parts) => parts.filter(Boolean).join('. ');

/** Probe one lane's tab. Returns { st: status for the server, info: what the watchdog needs }. */
async function probeLane(lane, autoOpen, probeMs) {
  const busyNow = Boolean(lane.job);
  const tab = await ensureTab(lane, autoOpen);
  if (!tab) return { st: { state: 'no_tab', detail: 'Tab is not open', unread: 0, busy: false }, info: { tabId: null } };
  const tabs = tab.acxCount || 1;
  if (tab.acxAway) {
    const where = parseUrl(tab.url)?.pathname || '';
    const st = tab.acxOwnSite
      ? { state: 'error', detail: `The tab is on ${where}, not the messages page. Open the messages page in that tab`, unread: 0, busy: false }
      : { state: 'logged_out', detail: 'Log in on that tab', unread: 0, busy: false };
    return { st: { ...st, tabs }, info: { tabId: tab.id, away: true } };
  }
  const url = tab.url || tab.pendingUrl || '';
  const path = parseUrl(url || 'https://x/')?.pathname || '';
  if (lane.channel === 'tiktok' && /\/login/.test(path)) {
    return { st: { state: 'logged_out', detail: 'Log in to TikTok on that tab', unread: 0, busy: false, tabs }, info: { tabId: tab.id, away: true } };
  }
  if (onAwayPage(lane, url)) {
    // TikTok Business Suite: the chat there sits in a frame the agent cannot work in. Being there
    // proves a business account, so the business view of the messages page is the way back.
    if (lane.channel === 'tiktok' && !business) { business = true; await store.set({ tiktok_business: true }).catch(() => {}); }
    if (!(await jobBusy(lane)) && (await sendHome(lane, tab.id, { away: true }))) {
      return { st: { state: 'loading', detail: 'Bringing the tab back to the messages page', unread: 0, busy: false, tabs }, info: { tabId: tab.id, answeredLoading: true } };
    }
    const tries = await store.sessionGet('return_tries', {}).catch(() => ({}));
    const stuck = (tries[`${lane.id}:away`] || 0) >= AWAY_TRIPS_MAX;
    const detail = stuck && lane.channel === 'tiktok'
      ? 'TikTok keeps opening Business Suite. Open tiktok.com/messages in a pinned tab'
      : `The tab is on ${path}, not the messages page. Open the messages page in that tab`;
    return { st: { state: 'error', detail, unread: 0, busy: false, tabs }, info: { tabId: tab.id, away: true } };
  }
  const dup = duplicateNote(lane, tab);
  if (tab.discarded || tab.status === 'unloaded') {
    // Chrome unloaded the tab to save memory: bring it back now.
    const T = await timing();
    const h = await getHealth(lane);
    const before = { ...h };
    if (await recover(lane, tab.id, 'reload', 'Chrome had unloaded the tab', h, T, { force: true })) await saveOwn(lane, before, h);
    return { st: { state: 'loading', detail: joinDetail('Page is loading', dup), unread: 0, busy: busyNow, tabs }, info: { tabId: tab.id } };
  }
  if (tab.status !== 'complete') return { st: { state: 'loading', detail: joinDetail('Page is loading', dup), unread: 0, busy: busyNow, tabs }, info: { tabId: tab.id } };
  const res = await tabOp(lane, 'probe', {}, probeMs, tab.id);
  if (res.ok && res.data) {
    const d = res.data;
    const state = d.state || 'error';
    if (state === 'ready') await homeReached(lane);
    const stuck = (d.busy_ms || 0) > STUCK_OP_MS;
    if (lane.channel === 'tiktok' && d.business === true && !business) { business = true; await store.set({ tiktok_business: true }).catch(() => {}); }
    return {
      st: { state, detail: joinDetail(stuck ? 'The page is stuck' : d.detail || '', dup), unread: d.unread || 0, busy: busyNow, tabs },
      info: { tabId: tab.id, answered: !stuck, probeOk: ALIVE_STATES.includes(state) && !stuck, answeredLoading: state === 'loading' && !stuck },
    };
  }
  if (res.error_code === 'no_content_script') {
    // The tab was open before the extension was installed or updated: reload it so our script loads.
    // Inside the same limits as the watchdog (gap and hourly cap in session storage).
    const T = await timing();
    const h = await getHealth(lane);
    const before = { ...h };
    if (await recover(lane, tab.id, 'reload', 'The page had no agent script', h, T, { force: true })) await saveOwn(lane, before, h);
  }
  return {
    st: { state: res.error_code === 'no_content_script' ? 'loading' : 'error', detail: joinDetail(plainError(res), dup), unread: 0, busy: busyNow, tabs },
    info: { tabId: tab.id, answered: false },
  };
}

async function probeAll(autoOpen, probeMs = PROBE_MS) {
  const out = {};
  await Promise.all(lanes.map(async (lane) => {
    try {
      out[lane.id] = await probeLane(lane, autoOpen, probeMs);
    } catch (err) {
      out[lane.id] = { st: { state: 'error', detail: String(err?.message || err).slice(0, 140), unread: 0, busy: false }, info: { tabId: null } };
    }
    const r = out[lane.id];
    lane.probe = { state: r.st.state, at: Date.now(), st: r.st, info: r.info };
    lane.tabId = r.info.tabId ?? null;
  }));
  return out;
}

/** Status per channel (its inbox lane) with the health fields added: what the server and the popup show. */
async function channelStatus() {
  const out = {};
  for (const ch of NAMES) {
    const lane = primaryLane(ch);
    const st = lane?.probe?.st || { state: 'no_tab', detail: '', unread: 0, busy: false };
    // `busy` and `sending` are true only while a reply is being typed (older servers lease nothing
    // to a busy channel; reads no longer hold the channel).
    const sending = Boolean(lane?.job);
    out[ch] = { ...st, busy: sending, sending, queued: lane ? lane.queue.length : 0, inbound: lane ? lane.inflight.size : 0, ...healthFields(lane ? await getHealth(lane) : {}) };
  }
  return out;
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* action API unavailable */ }
}

// ---- the sync tick -----------------------------------------------------------------------------------

let keepAlive = null;
/** Extension API calls keep the worker awake, so the lanes' timers keep running between alarms. */
function startKeepAlive() {
  if (!keepAlive) keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); }, 20_000);
}
function stopKeepAlive() {
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
}

/** Keep the laptop awake while paired and not paused. Cheap, so it is repeated every sync. */
function keepAwake(on) {
  try {
    if (on) chrome.power.requestKeepAwake('system');
    else chrome.power.releaseKeepAwake();
  } catch { /* power API unavailable */ }
}

async function serverBackoff() {
  return store.sessionGet('server_backoff', { fails: 0, next_at: 0 }).catch(() => ({ fails: 0, next_at: 0 }));
}

let syncing = false;
let syncAgain = false;
let syncTimer = null;
let syncTimerAt = 0;

/** Run a sync in `ms` (or sooner if one is already planned). */
function syncSoon(ms = 0) {
  const at = Date.now() + ms;
  if (syncTimer && syncTimerAt <= at) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimerAt = at;
  syncTimer = setTimeout(() => { syncTimer = null; syncTimerAt = 0; syncTick(); }, Math.max(0, ms));
}

/** Sync now. Calls that arrive while one runs collapse into one follow up run. */
async function syncTick() {
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    await syncOnce();
  } catch (err) {
    console.warn('[acx] sync tick failed', err?.message || err);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; syncSoon(500); }
    else if (paired) syncSoon(Math.min(60, Math.max(8, config?.poll_seconds ?? 20)) * 1000);
  }
}

async function syncOnce() {
  const T = await timing();
  const now = Date.now();
  const last = await store.sessionGet('last_tick_at', 0).catch(() => 0);
  if (last && now - last > T.wake_gap_ms) await store.sessionSet('wake_pending', 'gap').catch(() => {});
  await store.sessionSet('last_tick_at', now).catch(() => {});

  const st = await store.get(['auth', 'paused', 'selectors', 'auto_open_tabs', 'config', 'tiktok_business']);
  paired = Boolean(st.auth?.token);
  paused = Boolean(st.paused);
  if (st.config) config = st.config;
  if (st.tiktok_business === true) business = true;
  if (!paired) { await setBadge('SET', '#8a8f98'); stopKeepAlive(); return; }
  keepAwake(!paused);
  if (paused) stopKeepAlive(); else startKeepAlive();

  // Woke up from sleep: probe with more patience, try the server at once, reload tabs that do not answer.
  const wake = await store.sessionGet('wake_pending', null).catch(() => null);
  if (wake) {
    await store.sessionSet('wake_pending', null).catch(() => {});
    await store.sessionSet('server_backoff', { fails: 0, next_at: 0 }).catch(() => {});
  }

  const probed = await probeAll(st.auto_open_tabs && !paused, wake ? T.wake_probe_ms : PROBE_MS);
  if (wake) {
    for (const lane of lanes) {
      const i = probed[lane.id]?.info;
      if (i?.tabId && !i.away && !i.answered && !i.answeredLoading && probed[lane.id]?.st?.state !== 'loading') {
        const h = await getHealth(lane);
        const before = { ...h };
        if (await recover(lane, i.tabId, 'reload', 'No answer after the laptop woke up', h, T)) await saveOwn(lane, before, h);
      }
      await patchHealth(lane, { sweep_at: 1 }); // look over recent chats once now (1, not 0: 0 means "never")
    }
  }
  // Lanes start as soon as their tab says ready, with the config they have: they never wait for the server.
  for (const lane of lanes) kick(lane);

  const channels = await channelStatus();
  const bo = await serverBackoff();
  let res = null;
  let lastError = '';
  if (Date.now() < bo.next_at) {
    lastError = `Cannot reach the server. Trying again in ${Math.ceil((bo.next_at - Date.now()) / 1000)} s`;
  } else {
    try {
      const sentAt = Date.now();
      res = await api.sync({ channels, paused_locally: paused, version: VERSION, held: heldJobs() }, st.selectors?.version ?? null, VERSION);
      if (res && Number.isFinite(res.server_time)) {
        // This laptop's clock against the server's, measured at the middle of the call, smoothed.
        const offset = Math.round((sentAt + Date.now()) / 2) - res.server_time;
        clockOffset = clockOffset ? Math.round(clockOffset * 0.7 + offset * 0.3) : offset;
      }
      if (!res || typeof res !== 'object') throw new api.ApiError(0, 'bad_response', 'The server sent an empty answer');
    } catch (err) {
      res = null;
      if (err.status === 401) {
        // The owner removed this laptop in the dashboard: forget the token so the popup asks to pair again.
        paired = false;
        await store.set({ auth: null, status: { channels, last_sync_at: Date.now(), last_error: 'Not paired any more', server_ok: false } });
        await setBadge('SET', '#8a8f98');
        keepAwake(false);
        stopKeepAlive();
        return;
      }
      const fails = (bo.fails || 0) + 1;
      await store.sessionSet('server_backoff', { fails, next_at: Date.now() + core.backoffMs(fails) }).catch(() => {});
      lastError = err.message || 'Cannot reach the server';
    }
  }

  if (res) {
    if (bo.fails) await store.sessionSet('server_backoff', { fails: 0, next_at: 0 }).catch(() => {});
    config = res.config || config;
    const patch = { config: res.config, status: { channels, last_sync_at: Date.now(), last_error: '', server_ok: true } };
    if (res.selectors) patch.selectors = res.selectors;
    await store.set(patch);
    dropCancelled(res.cancelled);
    if (!paused && config?.enabled !== false) {
      for (const job of Array.isArray(res.jobs) ? res.jobs : []) {
        const lane = job && laneForJob(job);
        if (lane) { await laneLoaded(lane); enqueue(lane, job, { source: 'sync' }); }
      }
    }
    flushResults();
  } else {
    await store.set({ status: { channels, last_sync_at: Date.now(), last_error: lastError, server_ok: false } });
  }

  for (const lane of lanes) {
    await watchdog(lane, probed[lane.id]?.info || {}, T).catch((err) => console.warn('[acx] watchdog failed', lane.id, err?.message || err));
    kick(lane);
  }

  if (!res) { await setBadge('!', '#e5484d'); return; }
  if (paused || !config?.enabled) { await setBadge('OFF', '#8a8f98'); return; }
  const ready = NAMES.filter((n) => primaryLane(n)?.probe?.state === 'ready').length;
  await setBadge(ready ? 'ON' : '!', ready ? '#2563eb' : '#f5a524');
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
  syncSoon(0);
}

/** The laptop came back (screen unlocked, input after idle, or a long gap between alarms). */
async function wake(why) {
  try {
    await store.sessionSet('wake_pending', why);
    await ensureAlarm();
  } catch { /* ignore */ }
  syncSoon(0);
}

chrome.runtime.onInstalled.addListener(() => { boot(); });
chrome.runtime.onStartup.addListener(() => { boot(); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === TICK_ALARM) syncTick(); });
try {
  chrome.idle.setDetectionInterval(60);
  chrome.idle.onStateChanged.addListener((state) => { if (state === 'active') wake('idle'); });
} catch { /* idle API unavailable */ }
// Pause, unpair or a new config take effect at once, not at the next sync.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.paused) paused = Boolean(changes.paused.newValue);
  if (changes.auth) paired = Boolean(changes.auth.newValue?.token);
  if (changes.config && changes.config.newValue) config = changes.config.newValue;
  if (changes.paused || changes.auth) { for (const lane of lanes) kick(lane); syncSoon(0); }
});
// Every worker start (not only browser start): make sure the heartbeat alarm exists, and get going.
ensureAlarm().catch(() => {});
syncSoon(300);

// ---- messages from pages and the popup ------------------------------------------------------------------

const diagSent = { at: 0, n: 0 };
let nudgeSyncAt = 0;

/** The lane a page belongs to: its own tab first, else by address. A second tab of a page is ignored. */
function laneForTab(tab) {
  if (!tab) return null;
  const byId = lanes.find((l) => l.tabId != null && l.tabId === tab.id);
  if (byId) return byId;
  return lanes.find((l) => l.tabId == null && onLanePage(l, tab.url)) || null;
}

/**
 * A page saw something change. Kick that lane: one scan 0.7 s later, however many nudges come
 * meanwhile (they never push it back). A lane that is not running yet gets a probe soon instead.
 */
function nudgeLane(lane) {
  if (!laneActive(lane)) {
    if (Date.now() - nudgeSyncAt > 5000) { nudgeSyncAt = Date.now(); syncSoon(1000); }
    return;
  }
  if (lane.nudgeTimer) return;
  lane.nudgeTimer = setTimeout(() => {
    lane.nudgeTimer = null;
    lane.scanWanted = Date.now();
    kick(lane);
  }, 700);
}

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

/**
 * The owner pressed Show in the popup: bring the channel's tab to the front, in whatever window it
 * is in. A missing tab is opened, and a tab that wandered off its page goes back.
 */
async function showTab(channel) {
  const lane = primaryLane(channel);
  let tab = await findTab(lane);
  const opened = await store.sessionGet('opened_tabs', {}).catch(() => ({}));
  if (!tab && opened[lane.id]) { try { tab = await chrome.tabs.get(opened[lane.id]); } catch { tab = null; } }
  if (!tab) {
    tab = await chrome.tabs.create({ url: await homeUrl(lane), active: true, pinned: true });
    opened[lane.id] = tab.id;
    await store.sessionSet('opened_tabs', opened);
    await store.sessionSet(`tab:${lane.id}`, tab.id);
  } else if (channel === 'tiktok' && (!onLanePage(lane, tab.url || tab.pendingUrl) || onAwayPage(lane, tab.url || tab.pendingUrl))) {
    await chrome.tabs.update(tab.id, { url: await homeUrl(lane) });
  }
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.acx !== true || !msg.type) return false;
  switch (msg.type) {
    case 'sleep':
      setTimeout(() => respond({ ok: true }), Math.min(Math.max(0, Number(msg.ms) || 0), 120_000));
      return true;
    case 'activity': {
      const lane = laneForTab(sender.tab);
      if (lane) nudgeLane(lane);
      respond({ ok: true });
      return false;
    }
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
    // A tab could not copy a customer's photo itself (cross origin CDN picture). Only our tabs
    // may ask, and only for the hosts listed in lib/media.js.
    case 'fetch_media':
      if (!sender.tab?.id || !NAMES.includes(msg.channel)) { respond({ ok: false, error: 'not_a_channel_tab' }); return false; }
      fetchMedia(msg.channel, String(msg.url || ''), Number(msg.timeout_ms) || 4000).then(respond, () => respond({ ok: false, error: 'failed' }));
      return true;
    // A tab could not read a customer's audio attachment itself (a Gmail voice note). Same rules as photos.
    case 'fetch_audio':
      if (!sender.tab?.id || !NAMES.includes(msg.channel)) { respond({ ok: false, error: 'not_a_channel_tab' }); return false; }
      fetchAudio(msg.channel, String(msg.url || ''), Number(msg.timeout_ms) || 4000).then(respond, () => respond({ ok: false, error: 'failed' }));
      return true;
    case 'trusted_type':
      if (!sender.tab?.id) { respond({ ok: false }); return false; }
      trustedType(sender.tab.id, String(msg.text || '')).then(respond, (err) => respond({ ok: false, error: String(err?.message || err) }));
      return true;
    // ---- popup ----
    case 'pair':
      api.pair(msg.pairing_string, msg.name || 'Laptop').then(
        async (auth) => { paired = true; await boot(); respond({ ok: true, server_url: auth.server_url }); },
        (err) => respond({ ok: false, error: err.message || 'Pairing failed' }),
      );
      return true;
    case 'unpair':
      store.set({ auth: null, config: null }).then(async () => { paired = false; await setBadge('SET', '#8a8f98'); keepAwake(false); stopKeepAlive(); respond({ ok: true }); }, () => respond({ ok: false }));
      return true;
    case 'pause':
      store.set({ paused: Boolean(msg.paused) }).then(async () => { paused = Boolean(msg.paused); await boot(); respond({ ok: true }); }, () => respond({ ok: false }));
      return true;
    case 'tick':
      // The popup opened (or a test): sync now and have every lane look at its tab.
      for (const lane of lanes) { lane.scanWanted = Date.now(); kick(lane); }
      syncSoon(0);
      respond({ ok: true });
      return false;
    case 'show_tab':
      if (!NAMES.includes(msg.channel)) { respond({ ok: false }); return false; }
      showTab(msg.channel).then(respond, (err) => respond({ ok: false, error: String(err?.message || err) }));
      return true;
    case 'selftest':
      Promise.all(NAMES.map(async (channel) => [channel, await tabOp(primaryLane(channel), 'selftest', {}, 60_000)]))
        .then((rows) => respond({ ok: true, results: Object.fromEntries(rows) }), () => respond({ ok: false }));
      return true;
    case 'lanes':
      // What each lane is doing right now (for the e2e tests and for debugging from the console).
      respond({ ok: true, lanes: lanes.map((l) => ({ id: l.id, state: l.probe.state, tab: l.tabId, queued: l.queue.length, queue_ids: l.queue.map((it) => it.job.id), inbound: l.inflight.size, sending: Boolean(l.job), op: l.op?.op || null, running: l.running })) });
      return false;
    default:
      return false;
  }
});
