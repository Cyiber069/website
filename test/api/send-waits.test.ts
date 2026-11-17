// What happens to a reply that cannot go out at once: the owner typing or a draft in the way, the owner
// answering by hand, a pause or an opt out while the laptop holds it, a code message the laptop keeps
// refusing, a deadline that passes, and the old 0.3.2 extension still on the laptop.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, cron, finish, inbound, sql, unique } from '../helpers/client';

const wa = () => `${unique('4472')}@c.us`;
const msg = (id: string, body: string, direction: 'in' | 'out' = 'in') => ({ external_id: id, direction, body, ts: null });
const MIN = 60_000;
const row = async (id: string) => (await sql('SELECT * FROM outbox WHERE id = ?', [id])).data.results[0];
const conv = async (id: string) => (await sql('SELECT * FROM conversations WHERE id = ?', [id])).data.results[0];
const events = async (type: string, outboxId: string) =>
  (await sql('SELECT level, message FROM events WHERE type = ? AND data LIKE ? ORDER BY id', [type, `%${outboxId}%`])).data.results as { level: string; message: string }[];

/** A sync as a given extension version would send it. `held`: the job ids its lanes hold. */
const syncAs = (version: string, held: string[] = [], channels = ['whatsapp']) =>
  api<{ jobs: any[]; config: any; cancelled: string[] }>('/api/agent/sync', {
    as: 'device',
    body: { version, status: { held, channels: Object.fromEntries(channels.map((c) => [c, { state: 'ready', unread: 0, busy: false, sending: false }])) } },
  });

/** Put a job back in the queue, due now, and lease it to the laptop again. */
async function lease(id: string, version = 'test') {
  await sql(`UPDATE outbox SET not_before = 0 WHERE id = ?`, [id]);
  const s = await syncAs(version);
  const job = s.data.jobs.find((j) => j.id === id);
  expect(job, `job ${id} offered again`).toBeTruthy();
  return job;
}

beforeAll(async () => {
  await api('/api/agent-toggle', { body: { enabled: true } });
  await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' } } });
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased')`);
});
afterAll(async () => {
  await syncAs('test'); // the device row goes back to the test version
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased', 'review')`);
  await sql('UPDATE conversations SET needs_reply_since = NULL, processing_until = NULL, paused_until = NULL');
});

describe('the old 0.3.2 extension keeps the pacing and settle it was made for', () => {
  it('0.3.2 gets settle 12 and pastes at 200 a second; 0.4.0 and up get settle 4 and paste at once', async () => {
    const old = await syncAs('0.3.2');
    expect(old.data.config.pacing.settle_seconds).toBe(12);
    const r = await inbound('whatsapp', wa(), [msg('m1', 'how heavy is the 1000w kit')]);
    // Never 0: 0.3.2 reads 0 as 3 a second on TikTok. At 200 it keeps only its floor pauses (about half a second a part).
    expect(r.jobs[0]!.pacing).toEqual({ delay_ms: 0, typing_cps: 200 });
    await api(`/api/conversations/${r.conversation_id}/send`, { body: { text: 'owner note for the old laptop' } });
    const manual = (await syncAs('0.3.2')).data.jobs.find((j) => j.source === 'manual')!;
    expect(manual.pacing.typing_cps).toBe(200); // never slower than the 30 it had before the speed change
    for (const version of ['0.4.0', '0.5.1']) {
      const s = await syncAs(version);
      expect(s.data.config.pacing.settle_seconds, version).toBe(4);
    }
    const n = await inbound('whatsapp', wa(), [msg('m1', 'how wide is the 1000w kit')]);
    expect(n.jobs[0]!.pacing).toEqual({ delay_ms: 0, typing_cps: 0 });
    // The laptop's queue order and the time left on the lease travel with every job.
    expect(n.jobs[0]).toMatchObject({ not_before: expect.any(Number), created_at: expect.any(Number) });
    expect((n.jobs[0] as any).lease_ms).toBeGreaterThan(2 * MIN);
    for (const j of [r.jobs[0]!, manual, n.jobs[0]!]) await finish(j.id);
    await syncAs('test');
  });
});

describe('a code message the laptop keeps refusing', () => {
  it('is offered again once, then each refusal uses a try and it fails with a line the owner sees', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'ignore-me')]);
    const id = unique('ob_');
    const device = (await api('/api/devices')).data.devices[0].id;
    await sql(`INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, not_before, lease_until, lease_device, attempts, pacing, created_at)
      VALUES (?, 'whatsapp', 'reply', ?, '{"title":"Zed"}', '["Your discount code ZED20 is now live"]', 'leased', 'discount', 0, ?, ?, 1, '{}', ?)`, [id, r.conversation_id, Date.now() + MIN, device, Date.now()]);
    const refuse = () => finish(id, { status: 'failed', error_code: 'newer_message', error: 'The customer wrote again', retryable: false });
    expect((await refuse()).data.status).toBe('pending');
    expect((await row(id)).attempts).toBe(0);
    let status = '';
    for (let i = 0; i < 4 && status !== 'failed'; i++) {
      await lease(id);
      status = (await refuse()).data.status;
    }
    expect(status).toBe('failed');
    const ev = await events('send_failed', id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.message).toContain('Zed');
    expect(ev[0]!.message).not.toMatch(/[–—]/);
  });
});

describe('the owner in the way', () => {
  it('a draft in the chat makes the agent stand down: its reply is dropped, the chat paused and the owner told', async () => {
    const t = wa();
    const r = await inbound('whatsapp', t, [msg('m1', 'is the 500w legal on roads')]);
    const job = r.jobs[0]!;
    const res = await finish(job.id, { status: 'failed', error_code: 'draft_in_chat', error: 'There is an unsent message in this chat', retryable: true });
    expect(res.data.status).toBe('cancelled');
    expect((await row(job.id)).status).toBe('cancelled');
    const c = await conv(r.conversation_id!);
    expect(c.paused_until).toBeGreaterThan(Date.now() + 10 * MIN);
    expect(c.pause_reason).toBe('You were typing in that chat');
    expect(c.needs_reply_since).toBeNull(); // the sweeper never answers on top of the owner later
    const ev = await events('takeover', job.id);
    expect(ev[0]!.message).toContain('unsent message');
    expect((await sql(`SELECT value FROM settings WHERE key = 'state:alert_last:waiting'`)).data.results).toHaveLength(1);
    // Nothing of the agent's goes out for that chat meanwhile.
    expect((await syncAs('test')).data.jobs.filter((j) => j.target.thread_external_id === t)).toHaveLength(0);
  });

  it('0.3.2 says composer_busy for a draft: the agent reply stands down, the owner’s own words wait', async () => {
    await syncAs('0.3.2');
    const r = await inbound('whatsapp', wa(), [msg('m1', 'do you deliver on saturdays')]);
    const job = r.jobs[0]!;
    expect((await finish(job.id, { status: 'failed', error_code: 'composer_busy', error: 'Someone is typing in this chat', retryable: true })).data.status).toBe('cancelled');
    expect((await conv(r.conversation_id!)).pause_reason).toBe('You were typing in that chat');
    // A message the owner wrote on the dashboard is not dropped: it waits for the draft to go.
    const other = await inbound('whatsapp', wa(), [msg('m1', 'ignore-me')]);
    await api(`/api/conversations/${other.conversation_id}/send`, { body: { text: 'owner words' } });
    const manual = (await syncAs('0.3.2')).data.jobs.find((j) => j.source === 'manual')!;
    expect((await finish(manual.id, { status: 'failed', error_code: 'composer_busy', retryable: true })).data.status).toBe('pending');
    await finish((await lease(manual.id, '0.3.2')).id);
    // On Gmail 0.3.2 also says composer_busy for an email written anywhere in the tab: not this customer's, so it waits.
    const device = (await api('/api/devices')).data.devices[0].id;
    const gm = unique('ob_g');
    await sql(`INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, not_before, lease_until, lease_device, attempts, pacing, created_at)
      VALUES (?, 'gmail', 'reply', ?, '{"title":"Mail"}', '["hello"]', 'leased', 'auto', 0, ?, ?, 1, '{}', ?)`, [gm, other.conversation_id, Date.now() + MIN, device, Date.now()]);
    expect((await finish(gm, { status: 'failed', error_code: 'composer_busy', error: 'An email is being written in this tab', retryable: true })).data.status).toBe('pending');
    expect((await row(gm)).busy_since).toBeGreaterThan(0);
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE id = ?`, [gm]);
    await syncAs('test');
  });

  it('0.3.2 composer_busy that is not a draft (the box or the open chat changed while typing) waits instead of standing down', async () => {
    await syncAs('0.3.2');
    const device = (await api('/api/devices')).data.devices[0].id;
    for (const [channel, error] of [['tiktok', 'The TikTok message box changed while typing'], ['whatsapp', 'The open chat changed while typing'], ['whatsapp', 'The message box changed while typing']] as const) {
      const r = await inbound('whatsapp', wa(), [msg('m1', `ignore-me ${channel} ${error}`)]);
      await sql('UPDATE conversations SET needs_reply_since = ? WHERE id = ?', [Date.now(), r.conversation_id]);
      const id = unique('ob_c');
      await sql(`INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, not_before, lease_until, lease_device, attempts, pacing, created_at)
        VALUES (?, ?, 'reply', ?, '{"title":"Cal"}', '["the kit fits 26 inch wheels"]', 'leased', 'auto', 0, ?, ?, 1, '{}', ?)`, [id, channel, r.conversation_id, Date.now() + MIN, device, Date.now()]);
      const res = await finish(id, { status: 'failed', error_code: 'composer_busy', error, retryable: true });
      expect(res.data.status, error).toBe('pending');
      const o = await row(id);
      expect(o.attempts, error).toBe(0); // no try used
      expect(o.busy_since).toBeGreaterThan(0);
      expect(o.not_before - Date.now()).toBeLessThanOrEqual(20_500);
      const c = await conv(r.conversation_id!);
      expect(c.paused_until ?? 0, error).toBeLessThan(Date.now()); // no pause
      expect(c.needs_reply_since, error).toBeGreaterThan(0); // still waiting for an answer
      expect(await events('takeover', id), error).toHaveLength(0);
      await sql(`UPDATE outbox SET status = 'cancelled' WHERE id = ?`, [id]);
    }
    await syncAs('test');
  });

  it('a box that keeps changing while typing uses a try from the second time and fails with its own words', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'ignore-me')]);
    const id = unique('ob_k');
    const device = (await api('/api/devices')).data.devices[0].id;
    await sql(`INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, not_before, lease_until, lease_device, attempts, pacing, created_at)
      VALUES (?, 'whatsapp', 'reply', ?, '{"title":"Kim"}', '["yes we ship to jersey"]', 'leased', 'auto', 0, ?, ?, 1, '{}', ?)`, [id, r.conversation_id, Date.now() + MIN, device, Date.now()]);
    const changed = () => finish(id, { status: 'failed', error_code: 'composer_busy', error: 'The message box changed while typing', retryable: true });
    expect((await changed()).data.status).toBe('pending');
    expect((await row(id)).attempts).toBe(0);
    let status = '';
    let tries = 0;
    for (; tries < 6 && status !== 'failed'; tries++) {
      await lease(id);
      status = (await changed()).data.status;
    }
    expect(status).toBe('failed');
    expect(tries).toBe(3); // three counted tries, not 15 minutes
    const failed = await events('send_failed', id);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.message).toMatch(/kept changing/);
    expect(failed[0]!.message).not.toMatch(/draft|[–—]/);
  });

  it('0.3.2 Gmail with the owner’s saved draft in this email: the agent reply stands down; an email anywhere in the tab waits', async () => {
    await syncAs('0.3.2');
    const device = (await api('/api/devices')).data.devices[0].id;
    const r = await inbound('whatsapp', wa(), [msg('m1', 'ignore-me')]);
    const gm = unique('ob_gd');
    await sql(`INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, not_before, lease_until, lease_device, attempts, pacing, created_at)
      VALUES (?, 'gmail', 'reply', ?, '{"title":"Mail"}', '["hello"]', 'leased', 'auto', 0, ?, ?, 1, '{}', ?)`, [gm, r.conversation_id, Date.now() + MIN, device, Date.now()]);
    expect((await finish(gm, { status: 'failed', error_code: 'composer_busy', error: 'There is already a draft reply in this email', retryable: true })).data.status).toBe('cancelled');
    expect((await conv(r.conversation_id!)).pause_reason).toBe('You were typing in that chat');
    const ev = await events('takeover', gm);
    expect(ev[0]!.message).toMatch(/unsent message in your email/);
    for (const error of ['Someone is typing in this tab', 'An email is being written in this tab']) {
      const other = await inbound('whatsapp', wa(), [msg('m1', 'ignore-me')]);
      const id = unique('ob_gt');
      await sql(`INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, not_before, lease_until, lease_device, attempts, pacing, created_at)
        VALUES (?, 'gmail', 'reply', ?, '{"title":"Mail"}', '["hello"]', 'leased', 'auto', 0, ?, ?, 1, '{}', ?)`, [id, other.conversation_id, Date.now() + MIN, device, Date.now()]);
      expect((await finish(id, { status: 'failed', error_code: 'composer_busy', error, retryable: true })).data.status, error).toBe('pending');
      expect(await events('takeover', id)).toHaveLength(0);
      await sql(`UPDATE outbox SET status = 'cancelled' WHERE id = ?`, [id]);
    }
    await syncAs('test');
  });

  it('after a draft takeover the words never promise the agent will answer later', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'do you sell 48v batteries')]);
    const job = r.jobs[0]!;
    expect((await finish(job.id, { status: 'failed', error_code: 'draft_in_chat', error: 'There is an unsent message in this chat', retryable: true })).data.status).toBe('cancelled');
    const ev = await events('takeover', job.id);
    expect(ev[0]!.message).toMatch(/The agent did not send its reply\. Answer them yourself\./);
    expect(ev[0]!.message).not.toMatch(/staying out|[–—]/);
  });

  it('an old busy_since from a wait long ago starts a new wait instead of failing the job at once', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'how long is delivery to wales')]);
    let job = r.jobs[0]!;
    const busy = () => finish(job.id, { status: 'failed', error_code: 'owner_busy', error: 'Someone is typing in this tab', retryable: true });
    expect((await busy()).data.status).toBe('pending');
    // The lease of a later try was lost (the result never arrived) and the cron put it back: 40 min later it is busy again.
    await sql('UPDATE outbox SET busy_since = ?, busy_last = ?, busy_warned = 0 WHERE id = ?', [Date.now() - 40 * MIN, Date.now() - 39 * MIN, job.id]);
    job = await lease(job.id);
    expect((await busy()).data.status).toBe('pending');
    const o = await row(job.id);
    expect(o.busy_since).toBeGreaterThan(Date.now() - MIN); // a new wait
    expect(o.busy_warned).toBe(0);
    expect(await events('send_failed', job.id)).toHaveLength(0);
    expect((await events('send_waiting', job.id)).map((e) => e.level)).toEqual(['info', 'info']);
    // Inside one wait (busy results a minute apart) the start is kept, so it still gives up after 15 min.
    await sql('UPDATE outbox SET busy_since = ?, busy_last = ? WHERE id = ?', [Date.now() - 16 * MIN, Date.now() - MIN, job.id]);
    job = await lease(job.id);
    expect((await busy()).data.status).toBe('failed');
  });

  it('a 5 min warning held back by the push throttle is tried again, and the failure push still goes', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'can i collect from the shop')]);
    let job = r.jobs[0]!;
    const slot = async () => (await sql(`SELECT value FROM settings WHERE key = 'state:alert_last:waiting'`)).data.results[0]?.value ?? null;
    const busy = () => finish(job.id, { status: 'failed', error_code: 'draft_in_chat', error: 'There is an unsent message in this chat', retryable: true });
    // An Urgent answer (manual words) waits behind a draft: not an agent reply, so it does not stand down.
    await sql(`UPDATE outbox SET source = 'urgent' WHERE id = ?`, [job.id]);
    expect((await busy()).data.status).toBe('pending');
    // Another chat's push went out a moment ago: the throttle holds this one back.
    await sql(`INSERT INTO settings (key, value, updated_at) VALUES ('state:alert_last:waiting', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(Date.now()), Date.now()]);
    await sql('UPDATE outbox SET busy_since = ? WHERE id = ?', [Date.now() - 6 * MIN, job.id]);
    job = await lease(job.id);
    expect((await busy()).data.status).toBe('pending');
    expect((await row(job.id)).busy_warned).toBe(2); // the line is on Live, the push is still owed
    expect((await events('send_waiting', job.id)).map((e) => e.level)).toEqual(['info', 'warn']);
    // 15 min: it fails, and the owner gets the failure push since the warning never reached them.
    await sql(`DELETE FROM settings WHERE key = 'state:alert_last:waiting'`);
    await sql('UPDATE outbox SET busy_since = ? WHERE id = ?', [Date.now() - 16 * MIN, job.id]);
    job = await lease(job.id);
    expect((await busy()).data.status).toBe('failed');
    expect(await slot()).not.toBeNull();
    expect((await events('send_waiting', job.id)).map((e) => e.level)).toEqual(['info', 'warn']); // the warn line once
  });

  it('a held back warning goes on the next busy result once the throttle allows it', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'is the 36v kit in stock')]);
    let job = r.jobs[0]!;
    await sql(`UPDATE outbox SET source = 'manual' WHERE id = ?`, [job.id]);
    const busy = () => finish(job.id, { status: 'failed', error_code: 'owner_busy', error: 'Someone is typing in this tab', retryable: true });
    expect((await busy()).data.status).toBe('pending');
    await sql(`INSERT INTO settings (key, value, updated_at) VALUES ('state:alert_last:waiting', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(Date.now()), Date.now()]);
    await sql('UPDATE outbox SET busy_since = ? WHERE id = ?', [Date.now() - 6 * MIN, job.id]);
    job = await lease(job.id);
    await busy();
    expect((await row(job.id)).busy_warned).toBe(2);
    await sql(`DELETE FROM settings WHERE key = 'state:alert_last:waiting'`);
    job = await lease(job.id);
    await busy();
    expect((await row(job.id)).busy_warned).toBe(1);
    expect((await sql(`SELECT value FROM settings WHERE key = 'state:alert_last:waiting'`)).data.results).toHaveLength(1);
    expect((await events('send_waiting', job.id)).filter((e) => e.level === 'warn')).toHaveLength(1);
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE id = ?`, [job.id]);
  });

  it('the owner already replied by hand: the queued reply is dropped and the agent stays out', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'can i pay in two parts')]);
    const job = r.jobs[0]!;
    expect((await finish(job.id, { status: 'failed', error_code: 'owner_replied', error: 'You already replied in this chat', retryable: false })).data.status).toBe('cancelled');
    const c = await conv(r.conversation_id!);
    expect(c.pause_reason).toBe('You replied yourself');
    expect(c.needs_reply_since).toBeNull();
    expect((await events('takeover', job.id))[0]!.message).toContain('yourself');
    expect((await events('send_failed', job.id))).toHaveLength(0);
  });

  it('someone typing in the tab: waits without using a try, tells the owner after 5 min and gives up after 15 min', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'whats the warranty on batteries')]);
    let job = r.jobs[0]!;
    const busy = () => finish(job.id, { status: 'failed', error_code: 'owner_busy', error: 'An email is being written in this tab', retryable: true });
    expect((await busy()).data.status).toBe('pending');
    let o = await row(job.id);
    expect(o.attempts).toBe(0);
    expect(o.busy_since).toBeGreaterThan(Date.now() - MIN);
    expect(o.not_before - Date.now()).toBeLessThanOrEqual(20_500);
    expect((await events('send_waiting', job.id)).map((e) => e.level)).toEqual(['info']);
    // Still busy 6 minutes later: once a minute now, and the owner is told once.
    await sql(`DELETE FROM settings WHERE key = 'state:alert_last:waiting'`);
    await sql('UPDATE outbox SET busy_since = ? WHERE id = ?', [Date.now() - 6 * MIN, job.id]);
    job = await lease(job.id);
    expect((await busy()).data.status).toBe('pending');
    o = await row(job.id);
    expect(o.busy_warned).toBe(1);
    expect(o.not_before - Date.now()).toBeGreaterThan(50_000);
    const waiting = await events('send_waiting', job.id);
    expect(waiting.map((e) => e.level)).toEqual(['info', 'warn']);
    expect(waiting[1]!.message).toMatch(/draft/);
    expect((await sql(`SELECT value FROM settings WHERE key = 'state:alert_last:waiting'`)).data.results).toHaveLength(1);
    job = await lease(job.id);
    await busy();
    expect(await events('send_waiting', job.id)).toHaveLength(2); // told once
    // 15 minutes: it fails with a plain reason instead of waiting silently for a day.
    await sql('UPDATE outbox SET busy_since = ? WHERE id = ?', [Date.now() - 16 * MIN, job.id]);
    job = await lease(job.id);
    expect((await busy()).data.status).toBe('failed');
    const failed = await events('send_failed', job.id);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.message).toMatch(/draft/);
    expect(failed[0]!.message).not.toMatch(/[–—]/);
    // A failed busy reply is not answered again on top by the sweeper.
    expect((await conv(r.conversation_id!)).needs_reply_since).toBeNull();
  });
});

describe('the laptop holds a reply that must not go out any more', () => {
  it('a pause cancels a leased reply, the sync names it, and a send that still happened is recorded as ours', async () => {
    const t = wa();
    const r = await inbound('whatsapp', t, [msg('m1', 'whats the top speed')]);
    const job = r.jobs[0]!;
    expect((await row(job.id)).status).toBe('leased');
    await api(`/api/conversations/${r.conversation_id}/pause`, { body: { minutes: 60 } });
    expect((await row(job.id)).status).toBe('cancelled');
    expect((await syncAs('test', [job.id, 'ob_unknown'])).data.cancelled).toEqual([job.id]);
    // It went out anyway (it was being typed): recorded as the agent's, so the next read is not a takeover.
    expect((await finish(job.id, { status: 'sent', sent_external_ids: ['o_sent'] })).data.status).toBe('sent');
    const out = (await sql(`SELECT author, outbox_id FROM messages WHERE conversation_id = ? AND direction = 'out'`, [r.conversation_id])).data.results;
    expect(out).toEqual([{ author: 'agent', outbox_id: job.id }]);
    const again = await inbound('whatsapp', t, [msg('m1', 'whats the top speed'), msg('o_sent', job.parts[0]!, 'out')]);
    expect(again.reason).not.toBe('human_takeover');
    expect((await conv(r.conversation_id!)).pause_reason).not.toBe('You replied yourself');
  });

  it('an opt out cancels a leased reply too', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'how long does charging take')]);
    const job = r.jobs[0]!;
    const contact = (await conv(r.conversation_id!)).contact_id;
    await api(`/api/contacts/${contact}/opt-out`, { body: { opted_out: true } });
    expect((await row(job.id)).status).toBe('cancelled');
    expect((await syncAs('test', [job.id])).data.cancelled).toEqual([job.id]);
  });

  it('a paused chat’s agent reply that came back to the queue is never handed out, and the sweep drops it', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'is there a kickstand')]);
    const job = r.jobs[0]!;
    // The lease ran out with the laptop away, and the owner paused the chat meanwhile.
    await sql(`UPDATE outbox SET status = 'pending', lease_until = NULL, not_before = 0 WHERE id = ?`, [job.id]);
    await sql('UPDATE conversations SET paused_until = ? WHERE id = ?', [Date.now() + 30 * MIN, r.conversation_id]);
    expect((await syncAs('test')).data.jobs.find((j) => j.id === job.id)).toBeUndefined();
    await cron();
    expect((await row(job.id)).status).toBe('cancelled');
  });

  it('an agent reply for a pinned WhatsApp chat is dropped quietly, and the sweeper leaves the chat alone', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'can you call me back')]);
    const job = r.jobs[0]!;
    await sql('UPDATE conversations SET needs_reply_since = ? WHERE id = ?', [Date.now(), r.conversation_id]);
    expect((await finish(job.id, { status: 'failed', error_code: 'pinned_chat', error: 'This chat is pinned, so the agent leaves it to you', retryable: false })).data.status).toBe('cancelled');
    expect((await conv(r.conversation_id!)).needs_reply_since).toBeNull();
    expect((await events('skipped', job.id))[0]!.message).toMatch(/pinned/);
    expect(await events('send_failed', job.id)).toHaveLength(0);
  });

  it('a laptop whose own copy of the lease ran out hands the job back without using a try', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'are pedals included')]);
    const job = r.jobs[0]!;
    expect((await finish(job.id, { status: 'failed', error_code: 'lease_expired_local', error: 'The lease ran out before it could be sent', retryable: true })).data.status).toBe('pending');
    expect((await row(job.id)).attempts).toBe(0);
    await finish((await lease(job.id)).id);
  });
});

describe('order, refusals and lost answers', () => {
  it('two jobs of one chat in one sync: the older holding line goes first, then the owner’s answer', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'ignore-me')]);
    const now = Date.now();
    const ins = (id: string, source: string, created: number) => sql(`INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, not_before, attempts, pacing, created_at)
      VALUES (?, 'whatsapp', 'reply', ?, '{}', ?, 'pending', ?, 0, 0, '{}', ?)`, [id, r.conversation_id, JSON.stringify([`${source} words`]), source, created]);
    const h = unique('ob_h');
    const u = unique('ob_u');
    await ins(h, 'holding', now - 5000);
    await ins(u, 'urgent', now);
    const ids = (await syncAs('test')).data.jobs.filter((j) => [h, u].includes(j.id)).map((j) => j.id);
    expect(ids).toEqual([h, u]);
    for (const id of ids) await finish(id);
  });

  it('answering on Urgent drops a one part holding line that has not gone out yet', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'unknown-question do you fit kits in birmingham')]);
    expect(r.action).toBe('escalate');
    const holding = r.jobs.find((j) => j.source === 'holding')!;
    await sql(`UPDATE outbox SET status = 'pending', lease_until = NULL WHERE id = ?`, [holding.id]); // the laptop never got it
    const urgent = (await sql(`SELECT id FROM urgent WHERE conversation_id = ? AND status = 'open'`, [r.conversation_id])).data.results[0];
    expect((await api(`/api/urgent/${urgent.id}/answer`, { body: { answer: 'yes we fit kits in birmingham', learn: false } })).status).toBe(200);
    expect((await row(holding.id)).status).toBe('cancelled');
    const answer = (await syncAs('test')).data.jobs.find((j) => j.source === 'urgent' && j.target.thread_external_id === r.jobs[0]!.target.thread_external_id);
    if (answer) await finish(answer.id);
  });

  it('a reply the laptop refused is dropped before the chat is decided again, whatever happened to its result', async () => {
    const t = wa();
    const a = await inbound('whatsapp', t, [msg('m1', 'do you ship to jersey')]);
    const r1 = a.jobs[0]!;
    // The newer_message result is still on its way: the read says which job it refused.
    const b = await inbound('whatsapp', t, [msg('m1', 'do you ship to jersey'), msg('m2', 'show-queued or guernsey')], {}, { refused_job_ids: [r1.id] });
    expect((await row(r1.id)).status).toBe('cancelled');
    expect(b.jobs[0]!.parts[0]).toContain('Mock saw 0 queued');
    await finish(b.jobs[0]!.id);
  });

  it('a reply leased inline whose answer never arrived is handed back when the chat is posted again', async () => {
    const t = wa();
    const a = await inbound('whatsapp', t, [msg('m1', 'what size battery for 40 miles')]);
    const r1 = a.jobs[0]!;
    const again = await inbound('whatsapp', t, [msg('m1', 'what size battery for 40 miles')]);
    expect(['reply_queued', 'nothing_new']).toContain(again.reason);
    expect(again.jobs.map((j) => j.id)).toEqual([r1.id]);
    // The old extension types inline jobs at once without checking ids: it never gets one twice.
    await syncAs('0.3.2');
    const old = await inbound('whatsapp', t, [msg('m1', 'what size battery for 40 miles')]);
    expect(old.jobs).toHaveLength(0);
    await syncAs('test');
    await finish(r1.id);
  });
});

describe('two runs that overlap', () => {
  it('never open a second Urgent item or send a second holding line', async () => {
    const t = wa();
    const first = await inbound('whatsapp', t, [msg('m1', 'ignore-me')]);
    const convId = first.conversation_id!;
    const slow = inbound('whatsapp', t, [msg('m1', 'ignore-me'), msg('m2', 'mock-slow-2500 unknown-question do you fit kits in leeds')]);
    await new Promise((r) => setTimeout(r, 900));
    // Another run (a slow model past the lock) opened the question meanwhile.
    await sql(`INSERT INTO urgent (id, conversation_id, channel, question, customer_message, reason, category, status, created_at) VALUES (?, ?, 'whatsapp', 'q', 'c', 'r', 'unknown', 'open', ?)`, [unique('u'), convId, Date.now()]);
    const r = await slow;
    expect(r.action).toBe('escalate');
    expect((await sql(`SELECT COUNT(*) AS n FROM urgent WHERE conversation_id = ? AND status = 'open'`, [convId])).data.results[0].n).toBe(1);
    expect((await sql(`SELECT COUNT(*) AS n FROM outbox WHERE conversation_id = ? AND source = 'holding'`, [convId])).data.results[0].n).toBe(0);
  });
});

describe('nothing disappears unseen', () => {
  it('an agent reply that expires unsent is on Live and in Health', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'ignore-me')]);
    const id = unique('ob_x');
    await sql(`INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, not_before, expires_at, attempts, pacing, created_at, last_error)
      VALUES (?, 'whatsapp', 'reply', ?, '{"title":"Yan"}', '["hello"]', 'pending', 'auto', ?, ?, 0, '{}', ?, 'composer_busy: Someone is typing')`, [id, r.conversation_id, Date.now() + 60 * MIN, Date.now() - 1000, Date.now() - 2000]);
    await cron();
    expect((await row(id)).status).toBe('expired');
    const ev = await events('send_expired', id);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.message).toMatch(/^Not sent to Yan in time/);
    const health = (await api('/api/health')).data;
    expect(health.failed_jobs.find((f: any) => f.id === id)).toMatchObject({ status: 'expired' });
  });
});
