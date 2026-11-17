// Replying as fast as possible without duplicates or lost messages (docs/ARCHITECTURE.md section 6).
// One test per item of the speed contract on the server side.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, api, cron, finish, inbound, sql, sync, unique } from '../helpers/client';

const wa = () => `${unique('4471')}@c.us`;
const msg = (id: string, body: string, direction: 'in' | 'out' = 'in', ts: number | null = null) => ({ external_id: id, direction, body, ts });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LIMIT = 45;
const conv = async (id: string) => (await sql('SELECT * FROM conversations WHERE id = ?', [id])).data.results[0];
const jobsOf = async (id: string) => (await sql('SELECT * FROM outbox WHERE conversation_id = ? ORDER BY created_at', [id])).data.results;

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

beforeAll(async () => {
  await api('/api/agent-toggle', { body: { enabled: true } });
  await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' } } });
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased') AND channel = 'whatsapp'`);
});
afterAll(async () => {
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased')`);
  await sql('UPDATE conversations SET needs_reply_since = NULL, processing_until = NULL, retry_at = NULL');
});

describe('decision line: final and retry_after_ms', () => {
  it('a normal answer is final, with nothing left to fetch', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'how long is delivery to leeds')]);
    expect(r).toMatchObject({ action: 'reply', final: true, retry_after_ms: null, jobs_pending: false });
    await finish(r.jobs[0]!.id);
  });

  it('a brain error is not final: try again soon, the customer stays marked as waiting and the chat is free', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'mock-error what is the warranty')]);
    expect(r).toMatchObject({ action: 'none', reason: 'brain_error', final: false });
    expect(r.retry_after_ms).toBeGreaterThanOrEqual(8_000);
    expect(r.retry_after_ms).toBeLessThanOrEqual(10_000);
    const c = await conv(r.conversation_id!);
    expect(c.needs_reply_since).not.toBeNull();
    expect(c.processing_until).toBeNull();
    // Logged as a warning, not as an error, while it is still being tried.
    const ev = (await sql(`SELECT level FROM events WHERE type = 'brain_error' AND conversation_id = ? ORDER BY id DESC LIMIT 1`, [r.conversation_id])).data.results[0];
    expect(ev.level).toBe('warn');
    await sql('UPDATE conversations SET needs_reply_since = NULL WHERE id = ?', [r.conversation_id]);
  });

  it('the time limit passing is not final, and a retry-after from the model is passed on', async () => {
    const late = await inbound('whatsapp', wa(), [msg('m1', 'mock-timeout is the 2000w road legal')]);
    expect(late).toMatchObject({ reason: 'deadline', final: false });
    expect(late.retry_after_ms).toBeGreaterThanOrEqual(2_000);
    expect(late.retry_after_ms).toBeLessThanOrEqual(3_500);
    const busy = await inbound('whatsapp', wa(), [msg('m1', 'mock-overloaded is the 2000w road legal')]);
    expect(busy).toMatchObject({ reason: 'brain_error', final: false });
    expect(busy.retry_after_ms).toBeGreaterThanOrEqual(4_000);
    expect(busy.retry_after_ms).toBeLessThanOrEqual(5_500);
    await sql('UPDATE conversations SET needs_reply_since = NULL WHERE id IN (?, ?)', [late.conversation_id, busy.conversation_id]);
  });

  it('another run holding the chat is not final, with a retry soon; posting again then answers', async () => {
    const t = wa();
    const first = await inbound('whatsapp', t, [msg('m1', 'hi there')]);
    await finish(first.jobs[0]!.id, { status: 'sent', sent_external_ids: ['o1'] });
    await sql('UPDATE conversations SET processing_until = ? WHERE id = ?', [Date.now() + 6_000, first.conversation_id]);
    const held = await inbound('whatsapp', t, [msg('m1', 'hi there'), msg('o1', first.jobs[0]!.parts[0]!, 'out'), msg('m2', 'do you sell batteries')]);
    expect(held).toMatchObject({ reason: 'already_processing', final: false, new_inbound: 1 });
    expect(held.retry_after_ms).toBeGreaterThanOrEqual(2_000);
    expect(held.retry_after_ms).toBeLessThanOrEqual(11_500);
    await sql('UPDATE conversations SET processing_until = NULL WHERE id = ?', [first.conversation_id]);
    const again = await inbound('whatsapp', t, [msg('m1', 'hi there'), msg('o1', first.jobs[0]!.parts[0]!, 'out'), msg('m2', 'do you sell batteries')]);
    expect(again).toMatchObject({ action: 'reply', final: true });
    expect(again.jobs[0]!.parts[0]).toContain('do you sell batteries');
    await finish(again.jobs[0]!.id);
  });
});

describe('a newer message is never lost and nothing is said twice', () => {
  it('a message stored while the brain worked keeps the chat waiting, and the next decision answers only it', async () => {
    const t = wa();
    const slow = inbound('whatsapp', t, [msg('m1', 'mock-slow-3000 first question about the 1000w')]);
    await sleep(1_200);
    const during = await inbound('whatsapp', t, [msg('m1', 'mock-slow-3000 first question about the 1000w'), msg('m2', 'and a second one about the battery')]);
    expect(during).toMatchObject({ reason: 'already_processing', final: false, new_inbound: 1 });
    const first = await slow;
    expect(first.action).toBe('reply');
    expect(first.jobs[0]!.parts[0]).toContain('first question');
    // The clear after the first decision did not wipe the newer message.
    expect((await conv(first.conversation_id!)).needs_reply_since).not.toBeNull();
    // The extension posts again: one fresh decision for the new message, with the first reply still on its way.
    const again = await inbound('whatsapp', t, [msg('m1', 'mock-slow-3000 first question about the 1000w'), msg('m2', 'and a second one about the battery')]);
    expect(again.action).toBe('reply');
    expect(again.jobs[0]!.parts[0]).toContain('second one about the battery');
    expect((await jobsOf(first.conversation_id!)).map((j: any) => JSON.parse(j.parts)[0])).toHaveLength(2);
    for (const j of [...first.jobs, ...again.jobs]) await finish(j.id);
  });

  it('shows the brain the replies that are queued but not sent, in place, so they are not said again', async () => {
    const t = wa();
    const a = await inbound('whatsapp', t, [msg('m1', 'yo how long is delivery')]);
    expect(a.jobs).toHaveLength(1); // out with the laptop, not sent yet
    const b = await inbound('whatsapp', t, [msg('m1', 'yo how long is delivery'), msg('m2', 'show-queued and to ireland')]);
    expect(b.action).toBe('reply');
    expect(b.jobs[0]!.parts[0]).toContain('Mock saw 1 queued');
    expect(b.jobs[0]!.parts[0]).toContain('yo how long is delivery');
    expect(b.queries).toBeLessThanOrEqual(LIMIT);
    for (const j of [...a.jobs, ...b.jobs]) await finish(j.id);
  });

  it('a chat whose reply is already queued is not answered again by the sweeper', async () => {
    const t = wa();
    const a = await inbound('whatsapp', t, [msg('m1', 'whats the range on the 1000w')]);
    await sql('UPDATE conversations SET needs_reply_since = NULL WHERE id != ?', [a.conversation_id]);
    await sql('UPDATE conversations SET needs_reply_since = ?, processing_until = NULL WHERE id = ?', [Date.now() - 5 * 60_000, a.conversation_id]);
    await cron();
    await cron();
    expect(await jobsOf(a.conversation_id!)).toHaveLength(1);
    expect((await conv(a.conversation_id!)).needs_reply_since).toBeNull();
    await finish(a.jobs[0]!.id);
  });

  it('one failing chat does not hold up the sweeper for the others', async () => {
    await sql('UPDATE conversations SET needs_reply_since = NULL');
    const bad = await inbound('whatsapp', wa(), [msg('m1', 'mock-error will this fit my bike')]);
    const good = await inbound('whatsapp', wa(), [msg('m1', 'mock-error is it in stock')]);
    await sql(`UPDATE messages SET body = 'is it in stock' WHERE conversation_id = ?`, [good.conversation_id]);
    // The failing chat waited longest, so the sweeper takes it first.
    await sql('UPDATE conversations SET needs_reply_since = ? WHERE id = ?', [Date.now() - 9 * 60_000, bad.conversation_id]);
    await sql('UPDATE conversations SET needs_reply_since = ? WHERE id = ?', [Date.now() - 5 * 60_000, good.conversation_id]);
    // (At 20:00 UK time one tick starts the daily checkout run instead, so tick until the sweeper got to it.)
    await until('the failing chat to be tried', async () => { await cron(); return (await conv(bad.conversation_id!)).retry_at; }, 10_000);
    expect((await conv(bad.conversation_id!)).retry_at).toBeGreaterThan(Date.now() + 60_000);
    await cron();
    const queued = (await jobsOf(good.conversation_id!)).filter((j: any) => j.status === 'pending');
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0].parts)[0]).toContain('is it in stock');
    // The failing chat still counts as waiting for the health check.
    expect((await conv(bad.conversation_id!)).needs_reply_since).not.toBeNull();
    await sql('UPDATE conversations SET needs_reply_since = NULL, retry_at = NULL WHERE id = ?', [bad.conversation_id]);
  });
});

describe('inline jobs only while the extension listens', () => {
  it('a request whose extension hung up leaves the reply for the next sync', async () => {
    const t = wa();
    const ctl = new AbortController();
    const res = await fetch(`${BASE()}/api/agent/inbound`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ACX_TEST_DEVICE!}` },
      body: JSON.stringify({ channel: 'whatsapp', thread: { external_id: t, title: 'Hung', contact: { name: 'Hung' } }, messages: [msg('m1', 'mock-slow-9000 how much is the 2000w kit')] }),
    });
    const reader = res.body!.getReader();
    let text = '';
    while (!text.includes('accepted')) text += new TextDecoder().decode((await reader.read()).value);
    const convId = JSON.parse(text.split('\n')[0]!).conversation_id as string;
    await reader.cancel().catch(() => {});
    ctl.abort();
    // Wait until the server is done with the chat (the lock is cleared after the reply is queued and handed over or not).
    await until('the reply to be queued', async () => (await jobsOf(convId)).length > 0 && (await conv(convId)).processing_until === null, 25_000);
    await sleep(1_500);
    const row = (await jobsOf(convId))[0];
    expect(row.status).toBe('pending');
    expect(row.lease_device).toBeNull();
    const s = await sync(['whatsapp']);
    const job = s.data.jobs.find((j) => j.target.thread_external_id === t);
    expect(job?.id).toBe(row.id);
    await finish(job!.id);
  }, 40_000);

  it('says jobs_pending when a reply for the chat is waiting in the queue', async () => {
    const t = wa();
    const a = await inbound('whatsapp', t, [msg('m1', 'whats the price of the 3000w')]);
    const job = a.jobs[0]!;
    expect((await finish(job.id, { status: 'failed', error_code: 'timeout', retryable: true })).data.status).toBe('pending');
    // An agent reply that failed quickly is tried again in seconds, not minutes.
    const nb = (await sql('SELECT not_before FROM outbox WHERE id = ?', [job.id])).data.results[0].not_before - Date.now();
    expect(nb).toBeGreaterThan(10_000);
    expect(nb).toBeLessThanOrEqual(15_500);
    await sql('UPDATE outbox SET not_before = 0 WHERE id = ?', [job.id]);
    const again = await inbound('whatsapp', t, [msg('m1', 'whats the price of the 3000w')]);
    expect(again).toMatchObject({ reason: 'nothing_new', final: true, jobs_pending: true, jobs: [] });
    const s = await sync(['whatsapp']);
    expect(s.data.jobs.find((j) => j.id === job.id)).toBeTruthy();
    await finish(job.id);
  });
});

describe('job results', () => {
  it('newer_message drops the reply quietly, uses no try, and one fresh decision answers everything', async () => {
    const t = wa();
    const a = await inbound('whatsapp', t, [msg('m1', 'do you ship to france')]);
    const job = a.jobs[0]!;
    const res = await finish(job.id, { status: 'failed', error_code: 'newer_message', error: 'The customer wrote again', retryable: true });
    expect(res.data.status).toBe('cancelled');
    const row = (await sql('SELECT status, attempts FROM outbox WHERE id = ?', [job.id])).data.results[0];
    expect(row).toMatchObject({ status: 'cancelled', attempts: 1 });
    expect((await sql(`SELECT COUNT(*) AS n FROM events WHERE type = 'send_failed' AND data LIKE ?`, [`%${job.id}%`])).data.results[0].n).toBe(0);
    expect((await conv(a.conversation_id!)).needs_reply_since).not.toBeNull();
    // The extension reads the chat again: the dropped reply is not shown to the brain as on its way.
    const b = await inbound('whatsapp', t, [msg('m1', 'do you ship to france'), msg('m2', 'show-queued or spain')]);
    expect(b.action).toBe('reply');
    expect(b.jobs[0]!.parts[0]).toContain('Mock saw 0 queued');
    await finish(b.jobs[0]!.id);
  });

  it('newer_message on a code message or an owner answer offers it again instead', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'ignore-me')]);
    const devices = (await api('/api/devices')).data.devices;
    for (const source of ['discount', 'urgent', 'manual']) {
      const id = unique('ob_');
      await sql(`INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, not_before, lease_until, lease_device, attempts, pacing, created_at)
        VALUES (?, 'whatsapp', 'reply', ?, '{}', '["Your code is live"]', 'leased', ?, 0, ?, ?, 1, '{}', ?)`, [id, r.conversation_id, source, Date.now() + 60_000, devices[0].id, Date.now()]);
      expect((await finish(id, { status: 'failed', error_code: 'newer_message', retryable: true })).data.status).toBe('pending');
      expect((await sql('SELECT attempts FROM outbox WHERE id = ?', [id])).data.results[0].attempts).toBe(0);
      await sql(`UPDATE outbox SET status = 'cancelled' WHERE id = ?`, [id]);
    }
  });

  it('the owner typing in the tab never uses up the tries: offered again after 20 s until it is sent', async () => {
    const t = wa();
    const a = await inbound('whatsapp', t, [msg('m1', 'is the 1500w in stock')]);
    let job = a.jobs[0]!;
    for (let i = 0; i < 4; i++) {
      expect((await finish(job.id, { status: 'failed', error_code: i % 2 ? 'composer_busy' : 'owner_busy', retryable: true })).data.status).toBe('pending');
      const row = (await sql('SELECT not_before, attempts, status FROM outbox WHERE id = ?', [job.id])).data.results[0];
      expect(row.attempts).toBe(0);
      expect(row.not_before - Date.now()).toBeGreaterThan(15_000);
      expect(row.not_before - Date.now()).toBeLessThanOrEqual(20_500);
      await sql('UPDATE outbox SET not_before = 0 WHERE id = ?', [job.id]);
      job = (await sync(['whatsapp'])).data.jobs.find((j) => j.id === job.id)!;
      expect(job).toBeTruthy();
    }
    expect((await finish(job.id)).data.status).toBe('sent');
  });
});

describe('sync leasing and limits', () => {
  it('three jobs on each of three channels in one sync stays under the query limit', async () => {
    await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' }, gmail: { mode: 'review' }, tiktok: { mode: 'review' } } });
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased')`);
    const convs = [
      (await inbound('whatsapp', wa(), [msg('m1', 'ignore-me')])).conversation_id!,
      (await inbound('gmail', unique('thr'), [msg('g1', 'ignore-me')], { contact: { name: 'Mail', email: `${unique('m')}@example.com` } })).conversation_id!,
      (await inbound('tiktok', unique('tt_'), [msg('t1', 'ignore-me')])).conversation_id!,
    ];
    for (const id of convs) for (let i = 0; i < 3; i++) await api(`/api/conversations/${id}/send`, { body: { text: `note ${i}` } });
    const s = await sync();
    expect(s.data.jobs).toHaveLength(9);
    expect(s.queries).toBeLessThanOrEqual(LIMIT);
    for (const j of s.data.jobs) { expect(j.pacing).toEqual({ delay_ms: 0, typing_cps: 0 }); await finish(j.id); }
  });
});

describe('pacing', () => {
  it('moves stored slow pacing to the fast defaults once, and keeps what the owner saves later', async () => {
    const old = { settle_seconds: 12, min_reply_delay_s: 5, max_reply_delay_s: 20, typing_cps: 11, max_auto_replies_per_thread_per_hour: 10, human_takeover_minutes: 20, ignore_older_than_hours: 24 };
    await sql(`INSERT INTO settings (key, value, updated_at) VALUES ('pacing', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(old), Date.now()]);
    const p = (await api('/api/settings')).data.settings.pacing;
    expect(p).toMatchObject({ schema: 2, settle_seconds: 4, min_reply_delay_s: 0, max_reply_delay_s: 0, typing_cps: 11, max_auto_replies_per_thread_per_hour: 30, human_takeover_minutes: 20 });
    const stored = JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'pacing'`)).data.results[0].value);
    expect(stored).toMatchObject({ schema: 2, settle_seconds: 4, min_reply_delay_s: 0, max_reply_delay_s: 0 });
    expect((await sync(['whatsapp'])).data.config.pacing.settle_seconds).toBe(4);

    await api('/api/settings/pacing', { method: 'PUT', body: { settle_seconds: 8, max_reply_delay_s: 3 } });
    expect((await api('/api/settings')).data.settings.pacing).toMatchObject({ schema: 2, settle_seconds: 8, max_reply_delay_s: 3 });
    expect((await sync(['whatsapp'])).data.config.pacing.settle_seconds).toBe(8);
    // The owner's extra wait applies to agent replies, never more than they set, and parts are still pasted whole.
    const r = await inbound('whatsapp', wa(), [msg('m1', 'hows the 1000w on hills')]);
    expect(r.jobs[0]!.pacing.delay_ms).toBeLessThanOrEqual(3_000);
    expect(r.jobs[0]!.pacing.typing_cps).toBe(0);
    await finish(r.jobs[0]!.id);
    await api('/api/settings/pacing', { method: 'PUT', body: { settle_seconds: 4, min_reply_delay_s: 0, max_reply_delay_s: 0, human_takeover_minutes: 15, max_auto_replies_per_thread_per_hour: 30 } });
  });
});

describe('reply time', () => {
  it('measures from the customer message to sent, and shows the average and the slowest on Live and Health', async () => {
    const ts = Date.now() - 10 * 60_000 - 1_234;
    const r = await inbound('whatsapp', wa(), [msg('m1', 'is the 750w kit any good', 'in', ts)]);
    expect((await sql('SELECT reply_to_ts FROM outbox WHERE id = ?', [r.jobs[0]!.id])).data.results[0].reply_to_ts).toBe(ts);
    await finish(r.jobs[0]!.id);
    for (const path of ['/api/overview', '/api/health']) {
      const rt = (await api(path)).data.reply_time;
      expect(rt.count).toBeGreaterThanOrEqual(1);
      expect(rt.max_ms).toBeGreaterThanOrEqual(10 * 60_000);
      expect(rt.avg_ms).toBeLessThanOrEqual(rt.max_ms);
      expect(rt.slowest).toMatchObject({ conversation_id: r.conversation_id, channel: 'whatsapp' });
      expect(rt.by_channel.whatsapp.count).toBeGreaterThanOrEqual(1);
    }
    // Answers the owner wrote do not count: they wait for the owner on purpose.
    const before = (await api('/api/overview')).data.reply_time.count;
    await api(`/api/conversations/${r.conversation_id}/send`, { body: { text: 'owner here' } });
    const j = (await sync(['whatsapp'])).data.jobs.find((x) => x.source === 'manual')!;
    await finish(j.id);
    expect((await api('/api/overview')).data.reply_time.count).toBe(before);
  });
});
