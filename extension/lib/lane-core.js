// Pure rules of the lane engine in sw.js: when a thread is due, how a decision line is read, which
// queued job goes next, how long to back off. No chrome.* calls here, so a plain Node script can test
// every rule (test/e2e/lanes.check.mjs).

/** A burst that keeps changing is read anyway this long after `settle_seconds` from first sight. */
export const SETTLE_CAP_EXTRA_MS = 8000;
/** A thread whose read failed 3 times is tried again this long after the last failure. */
export const TRIES_RESET_MS = 2 * 60_000;
export const MAX_READ_TRIES = 3;
/** Decisions with final=false are retried at most this many times, then the server sweeper owns the chat. */
export const MAX_NONFINAL_RETRIES = 3;
/** A read plus its inbound call never takes longer than this, even if the worker restarted half way. */
export const INFLIGHT_TTL_MS = 120_000;
/** A stream that ended without a decision line counts as final=false with this retry. */
export const STREAM_CUT_RETRY_MS = 5000;
/** Server unreachable: try again after these waits, quick at first (the first sync after a wake often fails). */
export const BACKOFF_MS = [5000, 10_000, 20_000, 40_000, 60_000];
/** A job result that could not be posted is tried again after these waits, then on every sync. */
export const RESULT_RETRY_MS = [2000, 5000, 10_000];
/** The longest pacing delay the extension honours (older servers send up to 20 s). */
export const MAX_DELAY_MS = 25_000;
/** At most this many reads run before a send that is ready gets its turn. */
export const MAX_READS_BETWEEN_SENDS = 2;
/** A queued job this close to the end of its lease goes before any read. */
export const LEASE_URGENT_MS = 60_000;
/** Inbound calls in flight per lane, and for the whole laptop (each one is a brain call on the server). */
export const INBOUND_CAP = 4;
export const INBOUND_CAP_ALL = 6;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function backoffMs(fails) {
  return BACKOFF_MS[Math.min(Math.max(1, fails || 1), BACKOFF_MS.length) - 1];
}

/**
 * typing_cps 0 (or a speed nobody types at) means: put each part in whole, no typing pauses.
 * A missing value is today's behaviour (11 characters a second), never instant.
 */
export function instantTyping(cps) {
  const n = num(cps);
  return n !== null && (n <= 0 || n >= 200);
}

// ---- threads seen by scans ------------------------------------------------------------------------

/**
 * Record what a scan says about one thread. `prev` is the stored entry (or undefined), `t` the thread
 * the adapter listed. A new signature restarts the quiet window (`since`); `first` only restarts when
 * the previous run of messages was already reported, so the hard cap counts from the first message of
 * a burst. `ts_max` is the latest the last message can have been written, when the page shows a time.
 */
export function noteThread(prev, t, now, src = 'scan') {
  const sig = String(t.sig ?? `${t.unread}|${t.preview}`);
  const lite = { key: t.key, title: t.title || '', accepted: Boolean(t.accepted) };
  const tsMax = num(t.ts_max) !== null && t.ts_max > 0 ? Math.min(t.ts_max, now) : null;
  if (!prev || prev.sig !== sig) {
    const freshRun = !prev || prev.reported === prev.sig || !prev.first;
    const busy = prev && (prev.inflight_until || 0) > now;
    return {
      sig,
      since: now,
      first: freshRun ? now : prev.first,
      ts_max: tsMax,
      reported: prev ? prev.reported ?? null : null,
      t: lite,
      tries: 0,
      failed_at: 0,
      src,
      thread: prev ? prev.thread ?? null : null,
      pos: num(t.pos),
      inflight_until: prev ? prev.inflight_until || 0 : 0,
      // A new message gets fresh chances, unless a call for this thread is still running.
      retry_at: busy ? prev.retry_at || 0 : 0,
      fails: busy ? prev.fails || 0 : 0,
      net_fails: prev ? prev.net_fails || 0 : 0,
    };
  }
  const next = { ...prev, pos: num(t.pos) ?? prev.pos ?? null };
  if (!prev.t || lite.accepted) next.t = { ...lite, accepted: lite.accepted || Boolean(prev.t && prev.t.accepted) };
  if (tsMax !== null && (prev.ts_max == null || tsMax < prev.ts_max)) next.ts_max = tsMax;
  return next;
}

/**
 * Reading order of due threads: what the last scan listed, then the longest waiting customer first.
 * Lists show the newest chat on top, so among threads seen in the same scan the lowest one goes first.
 */
export function readOrder(a, b) {
  return Number(Boolean(b.live)) - Number(Boolean(a.live)) || quietFrom(a.e) - quietFrom(b.e) || (b.e.pos ?? -1) - (a.e.pos ?? -1);
}

/** When the customer was last seen writing in this thread, at the latest. */
export function quietFrom(e) {
  const since = num(e.since) ?? 0;
  return e.ts_max != null && e.ts_max < since ? e.ts_max : since;
}

/** The time the thread may be read: quiet for `settleMs`, or the hard cap from first sight. */
export function dueTime(e, settleMs) {
  const quiet = quietFrom(e) + settleMs;
  const cap = (num(e.first) ?? num(e.since) ?? 0) + settleMs + SETTLE_CAP_EXTRA_MS;
  let at = Math.min(quiet, cap);
  if ((e.retry_at || 0) > at) at = e.retry_at;
  if ((e.inflight_until || 0) > at) at = e.inflight_until;
  if ((e.tries || 0) >= MAX_READ_TRIES) at = Math.max(at, (e.failed_at || 0) + TRIES_RESET_MS);
  return at;
}

/** True when the thread has unreported customer messages and may be read now. */
export function isDue(e, now, settleMs, threadBusy = () => false) {
  if (!e || !e.t || e.reported === e.sig) return false;
  if (e.thread && threadBusy(e.thread)) return false; // one decision per conversation at a time
  return now >= dueTime(e, settleMs);
}

// ---- decision lines --------------------------------------------------------------------------------

/**
 * What a decision line asks for. Old servers send neither `final` nor `retry_after_ms`: a missing
 * `final` is true (today's behaviour). A stream that ended with no decision (`cut`) is final=false
 * with a 5 s retry, whatever server it is.
 */
export function readDecision(decision) {
  const d = decision && typeof decision === 'object' ? decision : { cut: true };
  const cut = d.cut === true;
  const final = cut ? false : d.final !== false;
  const after = num(d.retry_after_ms);
  return {
    final,
    cut,
    retryAfterMs: final ? 0 : Math.min(120_000, Math.max(1000, after ?? STREAM_CUT_RETRY_MS)),
    jobs: Array.isArray(d.jobs) ? d.jobs.filter((j) => j && typeof j === 'object' && j.id) : [],
    jobsPending: d.jobs_pending === true,
    reason: typeof d.reason === 'string' ? d.reason : '',
  };
}

// ---- the send queue ---------------------------------------------------------------------------------

/** Queue order: not_before, then created_at (arrival when the server sends neither), then arrival. */
export function sortQueue(items) {
  const key = (it) => [num(it.job && it.job.not_before) ?? it.arrived, num(it.job && it.job.created_at) ?? it.arrived, it.seq || 0];
  return [...items].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
}

/**
 * The queued job to send now, or when the next one becomes possible.
 *   - Within one conversation jobs go strictly in queue order (a holding line before the answer).
 *   - A job waits for its own time (`sendAt`: read time plus the pacing delay).
 *   - On TikTok two sends to different chats are at least `crossChatGapMs` apart.
 *   - A new chat job (it may reload the tab) waits while customer replies are pending.
 * Returns { item, at }: item is null when nothing can go now, `at` the earliest time something can.
 */
export function nextJob(items, { now, lastSendAt = 0, lastSendThread = null, crossChatGapMs = 0, holdNewChat = false }) {
  const order = sortQueue(items);
  const seenThreads = new Set();
  let at = Infinity;
  for (const it of order) {
    const thread = it.thread || `job:${it.job.id}`;
    if (seenThreads.has(thread)) continue; // an earlier job of this chat goes first
    seenThreads.add(thread);
    if (it.job.kind === 'new_chat' && holdNewChat) continue;
    let when = it.sendAt || 0;
    if (crossChatGapMs && lastSendAt && thread !== lastSendThread) when = Math.max(when, lastSendAt + crossChatGapMs);
    if (when <= now) return { item: it, at: now };
    at = Math.min(at, when);
  }
  return { item: null, at };
}

/** True when a queued job must go before reads: its lease ends soon. */
export function leaseUrgent(it, now) {
  const lease = num(it && it.job && it.job.lease_until);
  return Boolean(lease && lease - now < LEASE_URGENT_MS);
}

/** A job whose lease is over may have been handed back, cancelled or re-leased: it is not ours to send. */
export function leaseOver(it, now) {
  const lease = num(it && it.job && it.job.lease_until);
  return Boolean(lease && lease < now);
}

/** When to send a job: read time (or arrival) plus the pacing delay, capped. Never holds the tab. */
export function sendAtFor(job, readAt, arrived) {
  const delay = Math.min(Math.max(0, num(job && job.pacing && job.pacing.delay_ms) ?? 0), MAX_DELAY_MS);
  return (readAt ?? arrived) + delay;
}

/**
 * What the lane does next. Inputs are plain facts about the lane right now.
 *   scanDue      a scan is wanted (nudge, idle period, a thread became due since the last scan)
 *   readyJob     a queued job can be sent now
 *   jobUrgent    that job's lease ends soon
 *   dueRead      a thread is due to be read
 *   readsSinceSend, inflight, cap
 */
export function chooseStep({ scanDue, readyJob, jobUrgent, dueRead, readsSinceSend = 0, inflight = 0, cap = INBOUND_CAP }) {
  if (readyJob && jobUrgent) return 'send';
  if (scanDue) return 'scan';
  const canRead = dueRead && inflight < cap;
  if (canRead && !(readyJob && readsSinceSend >= MAX_READS_BETWEEN_SENDS)) return 'read';
  if (readyJob) return 'send';
  return 'idle';
}

/**
 * The pause budget for a send. Only matters for the old human pacing (typing_cps 1 to 199): when the
 * lane has other work waiting, the adapter keeps only short floor pauses.
 */
export function sendBudget(otherWork) {
  return otherWork > 0 ? 6000 : null;
}
