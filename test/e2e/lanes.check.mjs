// Checks of the pure rules behind the lanes (no browser, no server):
//   node test/e2e/lanes.check.mjs       exit code 0 = everything passed
// extension/lib/lane-core.js is imported directly. The content script helpers in extension/content/core.js
// (tail reference, newer message check, time labels, pacing) are loaded with a tiny stand in for the
// browser. Also run at the start of test/e2e/lanes.e2e.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const core = await import(pathToFileURL(join(root, 'extension', 'lib', 'lane-core.js')).href);

/** core.js as a content script would see it on web.whatsapp.com, with chrome.* stubbed out. */
async function contentHelpers() {
  const saved = { location: globalThis.location, chrome: globalThis.chrome, window: globalThis.window };
  globalThis.location = { hostname: 'web.whatsapp.com', pathname: '/', href: 'https://web.whatsapp.com/' };
  const noop = () => {};
  globalThis.chrome = {
    runtime: { sendMessage: noop, onMessage: { addListener: noop }, lastError: null },
    storage: { local: { get: async () => ({}) }, onChanged: { addListener: noop } },
  };
  globalThis.window = globalThis;
  delete globalThis.ACX;
  await import(`${pathToFileURL(join(root, 'extension', 'content', 'core.js')).href}?check=${Date.now()}`);
  const ACX = globalThis.ACX;
  Object.assign(globalThis, saved);
  return ACX;
}

let n = 0;
const ok = (what) => { n++; console.log(`PASS ${what}`); };

export async function runChecks() {
  n = 0;
  const S = 4000;
  const t0 = 1_800_000_000_000;

  // ---- settle: quiet window, hard cap, message times -------------------------------------------------
  let e = core.noteThread(undefined, { key: 'a', sig: 's1', title: 'A' }, t0);
  assert.equal(core.isDue(e, t0 + S - 1, S), false);
  assert.equal(core.isDue(e, t0 + S, S), true);
  e = core.noteThread(e, { key: 'a', sig: 's2' }, t0 + 3000); // a second message 3 s later
  assert.equal(e.first, t0, 'the burst keeps its first sight');
  assert.equal(core.isDue(e, t0 + 6000, S), false);
  assert.equal(core.isDue(e, t0 + 7000, S), true, 'quiet for settle after the last change');
  for (let t = 1000; t <= 20_000; t += 1000) e = core.noteThread(e, { key: 'a', sig: `x${t}` }, t0 + t); // never quiet
  assert.equal(core.dueTime(e, S), t0 + S + core.SETTLE_CAP_EXTRA_MS, 'hard cap: settle + 8 s from first sight');
  e.reported = e.sig;
  const fresh = core.noteThread(e, { key: 'a', sig: 'new' }, t0 + 60_000);
  assert.equal(fresh.first, t0 + 60_000, 'a new run after a report starts its own cap');
  // A time on the page says the message is older than the first sight (agent was asleep): due at once.
  const old = core.noteThread(undefined, { key: 'b', sig: 'b1', ts_max: t0 - 5 * 60_000 }, t0);
  assert.equal(core.isDue(old, t0, S), true);
  // A time in the future of the scan is clamped and never makes a thread due early.
  const soon = core.noteThread(undefined, { key: 'c', sig: 'c1', ts_max: t0 + 60_000 }, t0);
  assert.equal(core.isDue(soon, t0 + 1000, S), false);
  ok('settle: quiet window from the last change, hard cap settle + 8 s, page times used when older');

  // ---- per conversation: in flight, retries, tries ---------------------------------------------------------
  const busy = { ...core.noteThread(undefined, { key: 'd', sig: 'd1' }, t0), thread: 'T1' };
  assert.equal(core.isDue(busy, t0 + 10_000, S, (t) => t === 'T1'), false, 'one decision per conversation');
  assert.equal(core.isDue({ ...busy, inflight_until: t0 + 20_000 }, t0 + 10_000, S), false, 'in flight flag');
  assert.equal(core.isDue({ ...busy, inflight_until: t0 + 20_000 }, t0 + 20_000, S), true, 'the flag expires (worker restart)');
  assert.equal(core.isDue({ ...busy, retry_at: t0 + 15_000 }, t0 + 10_000, S), false);
  assert.equal(core.isDue({ ...busy, tries: 3, failed_at: t0 }, t0 + 60_000, S), false);
  assert.equal(core.isDue({ ...busy, tries: 3, failed_at: t0 }, t0 + core.TRIES_RESET_MS, S), true, 'tries reset after 2 min');
  ok('a conversation is never read twice at once; retries and failed reads wait, then come back');

  // ---- decision lines, old and new servers ---------------------------------------------------------------
  assert.deepEqual(core.readDecision({ type: 'decision', action: 'reply', jobs: [{ id: 'ob_1' }] }), { final: true, cut: false, retryAfterMs: 0, jobs: [{ id: 'ob_1' }], jobsPending: false, reason: '' });
  const lock = core.readDecision({ action: 'none', reason: 'already_processing', final: false, retry_after_ms: 8000, jobs: [] });
  assert.equal(lock.final, false);
  assert.equal(lock.retryAfterMs, 8000);
  assert.equal(core.readDecision({ action: 'none', reason: 'brain_error', jobs: [] }).final, true, 'an old server without final is final (today)');
  const cut = core.readDecision({ action: 'none', reason: 'stream_cut', jobs: [], cut: true });
  assert.deepEqual([cut.final, cut.retryAfterMs], [false, 5000], 'a cut stream retries in 5 s');
  assert.equal(core.readDecision({ action: 'reply', jobs: [], jobs_pending: true }).jobsPending, true);
  assert.equal(core.readDecision({ final: false, retry_after_ms: null }).retryAfterMs, 5000);
  ok('decision lines: missing final is true, final=false and cut streams retry, jobs_pending seen');

  // ---- the send queue ----------------------------------------------------------------------------------------
  const job = (id, thread, extra = {}) => ({ job: { id, kind: 'reply', lease_until: t0 + 180_000, ...extra.job }, thread, arrived: extra.arrived ?? t0, sendAt: extra.sendAt ?? t0, seq: extra.seq ?? 0 });
  const q = [job('j2', 'B', { arrived: t0 + 2, seq: 2 }), job('j1', 'A', { arrived: t0 + 1, seq: 1 }), job('j3', 'A', { arrived: t0 + 3, seq: 3 })];
  assert.equal(core.nextJob(q, { now: t0 }).item.job.id, 'j1', 'oldest first');
  assert.equal(core.nextJob(q.filter((x) => x.job.id !== 'j1').concat([job('j0', 'A', { sendAt: t0 + 9000, seq: 0 })]), { now: t0 }).item.job.id, 'j2', 'a chat waits for its own earlier job, others go');
  const nb = [job('x', 'A', { job: { not_before: t0 + 50 }, seq: 1 }), job('y', 'B', { job: { not_before: t0 + 10 }, seq: 2 })];
  assert.equal(core.nextJob(nb, { now: t0 + 100 }).item.job.id, 'y', 'not_before first, then created_at');
  const gap = core.nextJob([job('k', 'B')], { now: t0 + 1000, lastSendAt: t0, lastSendThread: 'A', crossChatGapMs: 3000 });
  assert.deepEqual([gap.item, gap.at], [null, t0 + 3000], 'TikTok: 3 s between sends to different chats');
  assert.equal(core.nextJob([job('k', 'A')], { now: t0 + 1000, lastSendAt: t0, lastSendThread: 'A', crossChatGapMs: 3000 }).item.job.id, 'k', 'the same chat needs no cross chat gap');
  const nc = [job('n', null, { job: { kind: 'new_chat' } })];
  assert.equal(core.nextJob(nc, { now: t0, holdNewChat: true }).item, null, 'a new chat waits behind customer replies');
  assert.equal(core.sendAtFor({ pacing: { delay_ms: 7000 } }, t0, t0 + 5000), t0 + 7000, 'the delay counts from the read');
  assert.equal(core.sendAtFor({ pacing: { delay_ms: 0 } }, null, t0), t0);
  assert.equal(core.sendAtFor({ pacing: { delay_ms: 90_000 } }, t0, t0), t0 + core.MAX_DELAY_MS);
  assert.equal(core.leaseUrgent(job('u', 'A', { job: { lease_until: t0 + 30_000 } }), t0), true);
  assert.equal(core.leaseOver(job('u', 'A', { job: { lease_until: t0 - 1 } }), t0), true);
  ok('queue: FIFO per chat, not_before then created_at, delay from the read, TikTok gap, new chats wait');

  // Due threads: listed ones first, then the longest waiting; in one scan the lowest row (oldest) first.
  const at = (pos, since, live = true) => ({ live, e: { since, pos } });
  const order = [at(0, t0), at(4, t0), at(2, t0), at(1, t0 - 5000), at(3, t0 - 9000, false)].sort(core.readOrder).map((x) => x.e.pos);
  assert.deepEqual(order, [1, 4, 2, 0, 3]);
  assert.equal(core.chooseStep({ scanDue: true, readyJob: true, jobUrgent: true }), 'send');
  assert.equal(core.chooseStep({ scanDue: true, readyJob: true }), 'scan');
  assert.equal(core.chooseStep({ dueRead: true, readyJob: true, readsSinceSend: 0 }), 'read');
  assert.equal(core.chooseStep({ dueRead: true, readyJob: true, readsSinceSend: 2 }), 'send', 'at most 2 reads between sends');
  assert.equal(core.chooseStep({ dueRead: true, inflight: core.INBOUND_CAP }), 'idle', 'inbound calls are capped');
  assert.equal(core.chooseStep({ dueRead: true, readyJob: true, inflight: core.INBOUND_CAP }), 'send');
  assert.deepEqual(core.BACKOFF_MS.map((_, i) => core.backoffMs(i + 1)), [5000, 10_000, 20_000, 40_000, 60_000]);
  assert.equal(core.backoffMs(99), 60_000);
  assert.deepEqual([core.instantTyping(0), core.instantTyping(400), core.instantTyping(11), core.instantTyping(undefined)], [true, true, false, false]);
  ok('steps: urgent lease, scan, reads then sends (2 reads at most), inbound cap; backoff 5 to 60 s; typing_cps 0 is instant');

  // ---- content script helpers ---------------------------------------------------------------------------
  const ACX = await contentHelpers();
  const read = [
    { external_id: 'm1', direction: 'in', body: 'hi' },
    { external_id: 'm2', direction: 'out', body: 'hey' },
    { external_id: 'm3', direction: 'in', body: 'how much' },
  ];
  const ref = ACX.tailRef(read);
  assert.deepEqual(ref, { last_in_id: 'm3', last_in_body: 'how much', same: 1 });
  assert.equal(ACX.newerInbound(read, ref), false);
  assert.equal(ACX.newerInbound([...read, { external_id: 'm4', direction: 'in', body: 'for 26 inch' }], ref), true);
  assert.equal(ACX.newerInbound([...read, { external_id: 'm4', direction: 'out', body: 'our part one' }], ref), false, 'our own messages are not newer');
  // TikTok legacy: no ids at all. Words, and a repeat of the same words, still tell.
  const noIds = read.map((m) => ({ ...m, external_id: null }));
  const r2 = ACX.tailRef(noIds);
  assert.equal(ACX.newerInbound([...noIds, { external_id: null, direction: 'in', body: 'ok' }], r2), true);
  assert.equal(ACX.newerInbound([...noIds, { external_id: null, direction: 'in', body: 'How much' }], r2), true, 'the same words again count as new');
  assert.equal(ACX.newerInbound(noIds, r2), false);
  assert.equal(ACX.newerInbound([{ external_id: null, direction: 'in', body: 'something else' }], r2), false, 'reference not found: never refuse on a guess');
  assert.equal(ACX.newerInbound(read, null), false);
  ok('newer message check: by id, by words, repeats count, our own messages and unknown references do not');

  const now = new Date(2026, 10, 17, 15, 30, 20).getTime();
  assert.equal(ACX.labelTimeMax('15:29', now), new Date(2026, 10, 17, 15, 30, 0).getTime(), 'a clock label plus its minute');
  assert.equal(ACX.labelTimeMax('3:29 pm', now), new Date(2026, 10, 17, 15, 30, 0).getTime());
  assert.equal(ACX.labelTimeMax('5m', now), now - 5 * 60_000);
  assert.equal(ACX.labelTimeMax('just now', now), null);
  assert.equal(ACX.labelTimeMax('Yesterday', now), null);
  assert.equal(ACX.labelTimeMax('23:50', now), null, 'a clock later than now is yesterday: no help');
  assert.equal(ACX.timeMoved('1m', '2m'), false, 'TikTok: a label that only ages is not a message');
  assert.equal(ACX.timeMoved('59m', '1h'), false);
  assert.equal(ACX.timeMoved('3m', 'now'), true, 'the age went down: a new message');
  assert.equal(ACX.timeMoved('20:14', 'now'), true);
  assert.equal(ACX.timeMoved('20:14', '20:31'), true);
  assert.equal(ACX.timeMoved('23:50', 'Yesterday'), false, 'WhatsApp at midnight');
  assert.equal(ACX.timeMoved('Yesterday', 'Monday'), false);
  assert.equal(ACX.timeMoved('Yesterday', '09:05'), true);
  assert.equal(ACX.stableTime('23:50', 'Yesterday'), '23:50', 'the signature keeps the last clock time');
  assert.equal(ACX.stableTime('', '2m'), 'd');
  assert.equal(ACX.stableTime('d', '10:00'), '10:00');
  ok('time labels: ageing labels never change a signature, new messages do; page times give an upper bound');

  assert.deepEqual([ACX.instant(0), ACX.instant(250), ACX.instant(11), ACX.instant(undefined)], [true, true, false, false]);
  assert.equal(ACX.cpsOf(undefined), 11);
  assert.equal(ACX.pauseScale(null, 20_000), 1, 'no budget: the old pauses');
  assert.equal(ACX.pauseScale(6000, 20_000), 0.3);
  assert.equal(ACX.pauseScale(6000, 1_000_000), 0.15);
  ok('pacing: typing_cps 0 or 200+ pastes at once, a missing speed keeps the old 11, busy lanes shrink pauses');

  // ---- TikTok pack: the live "request pending" text ----------------------------------------------------------
  const tiktok = JSON.parse(readFileSync(join(root, 'extension', 'selectors', 'tiktok.json'), 'utf8'));
  const pending = new RegExp(tiktok.text.request_pending.map((p) => `(?:${p})`).join('|'), 'i');
  assert.ok(pending.test('You can start chatting once this user has accepted your message request.'), 'live text (2026-11-17)');
  assert.ok(pending.test('You can send more messages after this user accepts your message request.'));
  assert.ok(!pending.test('hey do you ship to ireland'));
  assert.match(tiktok.urls.inbox_business, /^https:\/\/www\.tiktok\.com\/messages\?.*scene=business/);
  ok('TikTok pack: request pending text matches the live wording; business inbox address is the messages page');

  return n;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const count = await runChecks();
    console.log(`ALL ${count} CHECK GROUPS PASSED`);
  } catch (err) {
    console.error('FAIL', err);
    process.exit(1);
  }
}
