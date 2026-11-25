import { describe, expect, it } from 'vitest';
import { api, cron, finish, inbound, sql, sync, unique } from '../helpers/client';

const wa = () => `${unique('4477')}@c.us`;
const msg = (id: string, body: string, direction: 'in' | 'out' = 'in') => ({ external_id: id, direction, body });

describe('auth', () => {
  it('reports setup and blocks signed out or cross-site callers', async () => {
    expect((await api('/api/session', { as: 'public' })).data).toEqual({ setup_done: true, signed_in: false });
    expect((await api('/api/session')).data.signed_in).toBe(true);
    expect((await api('/api/overview', { as: 'public' })).status).toBe(401);
    expect((await api('/api/login', { as: 'public', body: { password: 'nope nope nope' } })).status).toBe(401);
    const cross = await api('/api/agent-toggle', { body: { enabled: false }, headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    expect((await api('/api/setup', { as: 'public', body: { password: 'another password' } })).status).toBe(409);
  });

  it('rejects a wrong or reused pairing code and unknown device tokens', async () => {
    expect((await api('/api/agent/pair', { as: 'public', body: { code: 'AAAA-BBBB' } })).status).toBe(400);
    const { data } = await api('/api/devices/pair-code', { body: {} });
    const first = await api('/api/agent/pair', { as: 'public', body: { code: data.code, name: 'Second' } });
    expect(first.status).toBe(200);
    expect(first.data.token).toMatch(/^acxd_/);
    expect((await api('/api/agent/pair', { as: 'public', body: { code: data.code } })).status).toBe(400);
    const res = await fetch(`${process.env.ACX_TEST_URL}/api/agent/sync`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer acxd_nope' }, body: '{}' });
    expect(res.status).toBe(401);
    // Clean up so later tests have one device.
    await api(`/api/devices/${first.data.device_id}`, { method: 'DELETE' });
  });

  it('keeps test helpers out of reach of nothing but test mode', async () => {
    expect((await sql('SELECT 1 AS one')).data.results[0].one).toBe(1);
  });
});

describe('inbound to reply', () => {
  it('answers a customer, records the send, and never answers the same message twice', async () => {
    const t = wa();
    const first = await inbound('whatsapp', t, [msg('m1', 'yo how long is delivery')]);
    expect(first.action).toBe('reply');
    expect(first.new_inbound).toBe(1);
    expect(first.jobs).toHaveLength(1);
    const job = first.jobs[0]!;
    expect(job.kind).toBe('reply');
    expect(job.target.thread_external_id).toBe(t);
    expect(job.parts[0]).toContain('Mock reply to: yo how long is delivery');
    // As fast as possible: no extra wait by default, each part pasted whole.
    expect(job.pacing).toEqual({ delay_ms: 0, typing_cps: 0, typing_ms: 10_000, gap_ms: 10_000 });

    // Reporting the same thread again while the job is out does nothing.
    expect((await inbound('whatsapp', t, [msg('m1', 'yo how long is delivery')])).action).toBe('none');

    expect((await finish(job.id, { status: 'sent', sent_external_ids: ['out1'] })).data.status).toBe('sent');
    expect((await finish(job.id)).data.status).toBe('sent'); // idempotent

    const conv = await api(`/api/conversations/${first.conversation_id}`);
    expect(conv.data.messages.map((m: any) => [m.direction, m.author])).toEqual([['in', 'customer'], ['out', 'agent']]);

    // The page now shows our own message. It must not look like the owner typing, and must not trigger a reply.
    const again = await inbound('whatsapp', t, [msg('m1', 'yo how long is delivery'), msg('out1', job.parts[0]!, 'out')]);
    expect(again.action).toBe('none');
    const conv2 = await api(`/api/conversations/${first.conversation_id}`);
    expect(conv2.data.messages).toHaveLength(2);
    expect(conv2.data.conversation.paused_until).toBeNull();

    // A new customer message gets a new reply.
    const next = await inbound('whatsapp', t, [msg('m1', 'yo how long is delivery'), msg('out1', job.parts[0]!, 'out'), msg('m2', 'and to ireland')]);
    expect(next.action).toBe('reply');
    expect(next.jobs[0]!.parts[0]).toContain('and to ireland');
    await finish(next.jobs[0]!.id);
  });

  it('matches messages without platform ids by order, including repeats', async () => {
    await api('/api/settings/channels', { method: 'PUT', body: { tiktok: { mode: 'auto' } } });
    const t = unique('tt_');
    const a = await inbound('tiktok', t, [{ direction: 'in', body: 'ok' }]);
    expect(a.action).toBe('reply');
    await finish(a.jobs[0]!.id);
    const reply = a.jobs[0]!.parts[0]!;
    // Same view again: nothing new.
    expect((await inbound('tiktok', t, [{ direction: 'in', body: 'ok' }, { direction: 'out', body: reply }])).action).toBe('none');
    // The customer says the very same thing again: that is a new message.
    const b = await inbound('tiktok', t, [{ direction: 'in', body: 'ok' }, { direction: 'out', body: reply }, { direction: 'in', body: 'ok' }]);
    expect(b.action).toBe('reply');
    expect(b.new_inbound).toBe(1);
    await finish(b.jobs[0]!.id);
  });

  it('sends multi part replies in order and ignores group chats', async () => {
    const t = wa();
    const r = await inbound('whatsapp', t, [msg('m1', 'two-parts please')]);
    expect(r.jobs[0]!.parts).toEqual(['Hey', 'Mock second part']);
    await finish(r.jobs[0]!.id);
    const conv = await api(`/api/conversations/${r.conversation_id}`);
    expect(conv.data.messages.filter((m: any) => m.direction === 'out').map((m: any) => m.body)).toEqual(['Hey', 'Mock second part']);

    const g = await inbound('whatsapp', `${unique('group')}@g.us`, [msg('g1', 'hello all')], { is_group: true });
    expect(g.action).toBe('none');
    expect(g.reason).toBe('group_chat');
  });

  it('treats old history as context only on first sight of a thread', async () => {
    const t = wa();
    const r = await inbound('whatsapp', t, [msg('h1', 'old question'), msg('h2', 'old answer from the shop', 'out'), msg('n1', 'new question today')]);
    expect(r.action).toBe('reply');
    expect(r.new_inbound).toBe(1);
    const conv = await api(`/api/conversations/${r.conversation_id}`);
    expect(conv.data.messages.map((m: any) => m.status)).toEqual(['history', 'history', 'received']);
    expect(conv.data.conversation.paused_until).toBeNull();
    await finish(r.jobs[0]!.id);

    // A thread whose last message is ours needs nothing.
    const quiet = await inbound('whatsapp', wa(), [msg('q1', 'thanks'), msg('q2', 'no problem', 'out')]);
    expect(quiet.action).toBe('none');
  });
});

describe('owner in the loop', () => {
  it('escalates what it does not know, sends a holding line, then sends the owner answer', async () => {
    const t = wa();
    const r = await inbound('whatsapp', t, [msg('m1', 'unknown-question about the frame')]);
    expect(r.action).toBe('escalate');
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]!.source).toBe('holding');
    await finish(r.jobs[0]!.id);

    const list = await api('/api/urgent');
    const item = list.data.urgent.find((u: any) => u.conversation_id === r.conversation_id);
    expect(item).toBeTruthy();
    expect(item.question).toContain('unknown-question');
    expect(item.recent.length).toBeGreaterThan(0);

    // A follow up while waiting must not create a second card or a second holding line.
    const more = await inbound('whatsapp', t, [msg('m1', 'unknown-question about the frame'), msg('o1', r.jobs[0]!.parts[0]!, 'out'), msg('m2', 'unknown-question still')]);
    expect(more.action).toBe('escalate');
    expect(more.jobs).toHaveLength(0);
    const list2 = await api('/api/urgent');
    expect(list2.data.urgent.filter((u: any) => u.conversation_id === r.conversation_id)).toHaveLength(1);

    const answered = await api(`/api/urgent/${item.id}/answer`, { body: { answer: 'fits any 135mm dropout', learn: true } });
    expect(answered.status).toBe(200);
    expect(answered.data.parts[0]).toContain('fits any 135mm dropout');
    expect((await api(`/api/urgent/${item.id}/answer`, { body: { answer: 'again' } })).status).toBe(409);

    const s = await sync(['whatsapp']);
    const job = s.data.jobs.find((j) => j.source === 'urgent');
    expect(job).toBeTruthy();
    expect(job!.target.thread_external_id).toBe(t);
    await finish(job!.id);
    const done = await api('/api/urgent?status=done');
    expect(done.data.urgent.find((u: any) => u.id === item.id).status).toBe('sent');
  });

  it('parks low confidence replies with the draft for one tap approval', async () => {
    const t = wa();
    const r = await inbound('whatsapp', t, [msg('m1', 'lowconf how many days')]);
    expect(r.action).toBe('escalate');
    expect(r.jobs).toHaveLength(0);
    const item = (await api('/api/urgent')).data.urgent.find((u: any) => u.conversation_id === r.conversation_id);
    expect(item.draft).toContain('3 days');
    const sent = await api(`/api/urgent/${item.id}/send-draft`, { body: {} });
    expect(sent.status).toBe(200);
    const s = await sync(['whatsapp']);
    const job = s.data.jobs.find((j) => j.source === 'urgent')!;
    expect(job.parts[0]).toContain('3 days');
    await finish(job.id);
  });

  it('holds replies for approval on channels in review mode', async () => {
    const t = unique('thread');
    const r = await inbound('gmail', t, [msg('g1', 'Hello, what is the warranty period?')], { subject: 'Warranty', contact: { name: 'Pat', email: 'pat@example.com' } });
    expect(r.action).toBe('review');
    expect(r.jobs).toHaveLength(0);
    expect((await sync(['gmail'])).data.jobs).toHaveLength(0);

    const review = (await api('/api/urgent')).data.review.find((x: any) => x.conversation_id === r.conversation_id);
    expect(review.subject).toBe('Warranty');
    expect(review.customer_message).toContain('warranty period');
    await api(`/api/review/${review.id}/approve`, { body: { text: 'Hi Pat\nIt is 12 months' } });
    const s = await sync(['gmail']);
    expect(s.data.jobs[0]!.parts).toEqual(['Hi Pat', 'It is 12 months']);
    expect(s.data.jobs[0]!.target.email).toBe('pat@example.com');
    await finish(s.data.jobs[0]!.id);
  });

  it('steps back when the owner replies by hand, and resumes when told', async () => {
    const t = wa();
    const r = await inbound('whatsapp', t, [msg('m1', 'is the 2000w in stock')]);
    await finish(r.jobs[0]!.id, { status: 'sent', sent_external_ids: ['o1'] });
    const reply = r.jobs[0]!.parts[0]!;
    const hand = await inbound('whatsapp', t, [msg('m1', 'is the 2000w in stock'), msg('o1', reply, 'out'), msg('o2', 'bro call me on the shop phone', 'out')]);
    expect(hand.action).toBe('none');
    expect(hand.reason).toBe('human_takeover');
    const paused = await inbound('whatsapp', t, [msg('m1', 'is the 2000w in stock'), msg('o1', reply, 'out'), msg('o2', 'bro call me on the shop phone', 'out'), msg('m2', 'ok will do')]);
    expect(paused.action).toBe('none');
    expect(paused.reason).toBe('paused');
    const view = await api(`/api/conversations/${r.conversation_id}`);
    expect(view.data.conversation.paused_until).toBeGreaterThan(Date.now());
    expect(view.data.messages.find((m: any) => m.body.includes('shop phone')).author).toBe('owner');

    // Handing the chat back answers the customer who was left waiting, straight away.
    await api(`/api/conversations/${r.conversation_id}/pause`, { body: { minutes: 0 } });
    let handback: any = null;
    for (let i = 0; i < 20 && !handback; i++) {
      handback = (await sync(['whatsapp'])).data.jobs.find((j) => j.target.thread_external_id === t);
      if (!handback) await new Promise((res) => setTimeout(res, 250));
    }
    expect(handback.parts[0]).toContain('ok will do');
    await finish(handback.id);
    const resumed = await inbound('whatsapp', t, [msg('m2', 'ok will do'), msg('m3', 'one more thing')]);
    expect(resumed.action).toBe('reply');
    await finish(resumed.jobs[0]!.id);
  });

  it('honours opt outs for good', async () => {
    const t = wa();
    const r = await inbound('whatsapp', t, [msg('m1', 'STOP')]);
    expect(r.action).toBe('reply'); // one short confirmation
    await finish(r.jobs[0]!.id);
    const after = await inbound('whatsapp', t, [msg('m1', 'STOP'), msg('m2', 'actually hello')]);
    expect(after.action).toBe('none');
    expect(after.reason).toBe('contact_opted_out');
  });

  it('never sends a queued agent reply after the owner replied by hand', async () => {
    const t = wa();
    const r = await inbound('whatsapp', t, [msg('m1', 'do you have the 1000w kit')]);
    const job = r.jobs[0]!;
    // The owner was typing in that chat, so the box was busy and the reply waits to try again.
    expect((await finish(job.id, { status: 'failed', error_code: 'composer_busy', retryable: true })).data.status).toBe('pending');
    const hand = await inbound('whatsapp', t, [msg('m1', 'do you have the 1000w kit'), msg('o1', 'yes mate sending you a pic now', 'out')]);
    expect(hand.reason).toBe('human_takeover');
    await sql('UPDATE outbox SET not_before = 0 WHERE id = ?', [job.id]);
    expect((await sync(['whatsapp'])).data.jobs.find((j) => j.id === job.id)).toBeUndefined();
    expect((await sql('SELECT status FROM outbox WHERE id = ?', [job.id])).data.results[0].status).toBe('cancelled');
  });

  it('drops an agent reply the laptop could not send in time instead of sending it days late', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'whats the range on the 48v battery')]);
    const job = r.jobs[0]!;
    // The tab was logged out, so the reply waits. It must not go out whenever the tab comes back.
    expect((await finish(job.id, { status: 'failed', error_code: 'logged_out', retryable: true })).data.status).toBe('pending');
    const row = (await sql('SELECT expires_at, created_at FROM outbox WHERE id = ?', [job.id])).data.results[0];
    expect(Math.abs(row.expires_at - row.created_at - 24 * 3_600_000)).toBeLessThan(60_000);
    await sql('UPDATE outbox SET not_before = 0, expires_at = ? WHERE id = ?', [Date.now() - 1, job.id]);
    expect((await sync(['whatsapp'])).data.jobs.find((j) => j.id === job.id)).toBeUndefined();
    await cron();
    expect((await sql('SELECT status FROM outbox WHERE id = ?', [job.id])).data.results[0].status).toBe('expired');
  });

  it('never sends a queued agent reply after the owner paused the chat', async () => {
    const r = await inbound('whatsapp', wa(), [msg('m1', 'whats the price of the battery')]);
    const job = r.jobs[0]!;
    expect((await finish(job.id, { status: 'failed', error_code: 'timeout', retryable: true })).data.status).toBe('pending');
    await api(`/api/conversations/${r.conversation_id}/pause`, { body: { minutes: 60 } });
    await sql('UPDATE outbox SET not_before = 0 WHERE id = ?', [job.id]);
    expect((await sync(['whatsapp'])).data.jobs.find((j) => j.id === job.id)).toBeUndefined();
  });

  it('drops what is still queued for a customer who opts out', async () => {
    const t = wa();
    const r = await inbound('whatsapp', t, [msg('m1', 'how much is delivery')]);
    const old = r.jobs[0]!;
    await finish(old.id, { status: 'failed', error_code: 'timeout', retryable: true });
    const stop = await inbound('whatsapp', t, [msg('m1', 'how much is delivery'), msg('m2', 'stop messaging me')]);
    expect(stop.action).toBe('reply');
    expect((await sql('SELECT status FROM outbox WHERE id = ?', [old.id])).data.results[0].status).toBe('cancelled');
    for (const j of stop.jobs) await finish(j.id);

    // Marked do not contact from the dashboard: a draft waiting for approval is dropped too.
    const g = await inbound('gmail', unique('thr'), [msg('g1', 'Hi, can I pay in parts?')], { contact: { name: 'Lee', email: `${unique('lee')}@example.com` } });
    expect(g.action).toBe('review');
    const conv = await api(`/api/conversations/${g.conversation_id}`);
    expect(conv.data.pending).toHaveLength(1);
    expect((await api(`/api/contacts/${conv.data.conversation.contact_id}/opt-out`, { body: { opted_out: true } })).status).toBe(200);
    expect((await api(`/api/conversations/${g.conversation_id}`)).data.pending).toHaveLength(0);
  });

  it('keeps one review draft per chat: a newer customer message replaces the older draft', async () => {
    await api('/api/settings/channels', { method: 'PUT', body: { gmail: { mode: 'review' } } });
    const t = unique('thr');
    const contact = { name: 'Kim', email: `${unique('kim')}@example.com` };
    const a = await inbound('gmail', t, [msg('g1', 'Do you ship to France?')], { contact });
    expect(a.action).toBe('review');
    const b = await inbound('gmail', t, [msg('g1', 'Do you ship to France?'), msg('g2', 'Actually I meant Spain, sorry')], { contact });
    expect(b.action).toBe('review');
    const drafts = (await api('/api/urgent')).data.review.filter((x: any) => x.conversation_id === a.conversation_id);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].parts.join(' ')).toContain('Spain');
    await api(`/api/review/${drafts[0].id}/reject`, { body: {} });
  });

  it('lets the owner send a message from the dashboard', async () => {
    const t = wa();
    const r = await inbound('whatsapp', t, [msg('m1', 'ignore-me')]);
    expect(r.action).toBe('none');
    await api(`/api/conversations/${r.conversation_id}/send`, { body: { text: 'hey its the owner here' } });
    const s = await sync(['whatsapp']);
    const job = s.data.jobs.find((j) => j.source === 'manual')!;
    expect(job.parts).toEqual(['hey its the owner here']);
    await finish(job.id);
    const view = await api(`/api/conversations/${r.conversation_id}`);
    expect(view.data.messages.at(-1).author).toBe('owner');
  });
});

describe('queue safety', () => {
  it('hands out up to three due jobs per ready channel, in order, and only to ready channels', async () => {
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased') AND channel = 'whatsapp'`);
    const convs: string[] = [];
    for (let i = 0; i < 4; i++) convs.push((await inbound('whatsapp', wa(), [msg('m1', 'ignore-me')])).conversation_id!);
    for (const [i, id] of convs.entries()) await api(`/api/conversations/${id}/send`, { body: { text: `message ${i}` } });
    expect((await sync(['gmail'])).data.jobs).toHaveLength(0);
    const first = await sync(['whatsapp']);
    expect(first.data.jobs.map((j) => j.parts[0])).toEqual(['message 0', 'message 1', 'message 2']);
    // The extension queues what it holds, so the next due job is not held back by them. Nothing is handed out twice.
    const second = await sync(['whatsapp']);
    expect(second.data.jobs.map((j) => j.parts[0])).toEqual(['message 3']);
    expect((await sync(['whatsapp'])).data.jobs).toHaveLength(0);
    for (const j of [...first.data.jobs, ...second.data.jobs]) await finish(j.id);
  });

  it('leaves a busy channel alone for an older extension, and leases while a newer one reads', async () => {
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased') AND channel = 'whatsapp'`);
    const a = await inbound('whatsapp', wa(), [msg('m1', 'ignore-me')]);
    await api(`/api/conversations/${a.conversation_id}/send`, { body: { text: 'while reading' } });
    const status = (wa: Record<string, unknown>) => api<{ jobs: any[] }>('/api/agent/sync', { as: 'device', body: { version: 'test', status: { channels: { whatsapp: { state: 'ready', unread: 0, ...wa } } } } });
    // An older extension says busy while it types a job: nothing more for that tab.
    expect((await status({ busy: true })).data.jobs).toHaveLength(0);
    // A newer one says busy while it reads and reports sending apart: it gets the job and queues it.
    const got = await status({ busy: true, sending: false });
    expect(got.data.jobs.map((j) => j.parts[0])).toEqual(['while reading']);
    await finish(got.data.jobs[0].id);
  });

  it('retries a failed send, then gives up, and returns stuck jobs to the queue', async () => {
    const a = await inbound('whatsapp', wa(), [msg('m1', 'ignore-me')]);
    await api(`/api/conversations/${a.conversation_id}/send`, { body: { text: 'will fail' } });
    const j1 = (await sync(['whatsapp'])).data.jobs[0]!;
    expect((await finish(j1.id, { status: 'failed', error_code: 'composer_missing', retryable: true })).data.status).toBe('pending');
    await sql('UPDATE outbox SET not_before = 0 WHERE id = ?', [j1.id]);
    const j2 = (await sync(['whatsapp'])).data.jobs[0]!;
    expect(j2.id).toBe(j1.id);
    expect((await finish(j2.id, { status: 'failed', error_code: 'not_on_whatsapp', retryable: false })).data.status).toBe('failed');

    await api(`/api/conversations/${a.conversation_id}/send`, { body: { text: 'gets stuck' } });
    const stuck = (await sync(['whatsapp'])).data.jobs[0]!;
    await sql('UPDATE outbox SET lease_until = 1 WHERE id = ?', [stuck.id]);
    await cron();
    const back = (await sync(['whatsapp'])).data.jobs[0]!;
    expect(back.id).toBe(stuck.id);
    await finish(back.id);
  });

  it('recovers a conversation whose live request died', async () => {
    const t = wa();
    const r = await inbound('whatsapp', t, [msg('m1', 'mock-error please')]);
    expect(r.reason).toBe('brain_error');
    await sql(`UPDATE messages SET body = 'working now' WHERE conversation_id = ?`, [r.conversation_id]);
    await sql('UPDATE conversations SET needs_reply_since = ? WHERE id = ?', [Date.now() - 5 * 60_000, r.conversation_id]);
    await cron();
    const s = await sync(['whatsapp']);
    const job = s.data.jobs.find((j) => j.target.thread_external_id === t)!;
    expect(job.parts[0]).toContain('working now');
    await finish(job.id);
  });

  it('stops everything on panic and starts again when switched on', async () => {
    const a = await inbound('whatsapp', wa(), [msg('m1', 'ignore-me')]);
    await api(`/api/conversations/${a.conversation_id}/send`, { body: { text: 'never sent' } });
    const p = await api('/api/panic', { body: {} });
    expect(p.data.cancelled).toBeGreaterThanOrEqual(1);
    expect((await sync(['whatsapp'])).data.jobs).toHaveLength(0);
    expect((await sync(['whatsapp'])).data.config.enabled).toBe(false);
    expect((await inbound('whatsapp', wa(), [msg('m1', 'hello')])).reason).toBe('agent_off');
    await api('/api/agent-toggle', { body: { enabled: true } });
    expect((await inbound('whatsapp', wa(), [msg('m1', 'hello')])).action).toBe('reply');
  });
});

describe('settings and health', () => {
  it('merges settings patches and ignores unknown keys', async () => {
    const res = await api('/api/settings/voice', { method: 'PUT', body: { max_chars: 200, nonsense: true } });
    expect(res.data.voice.max_chars).toBe(200);
    expect(res.data.voice.nonsense).toBeUndefined();
    expect((await api('/api/settings')).data.settings.voice.max_chars).toBe(200);
    expect((await api('/api/settings/nope', { method: 'PUT', body: {} })).status).toBe(404);
    await api('/api/settings/voice', { method: 'PUT', body: { max_chars: 260 } });
  });

  it('reads a stored "light" comma setting as normal, and "almost none" still strips commas', async () => {
    const stored = async () => JSON.parse((await sql("SELECT value FROM settings WHERE key = 'voice'")).data.results[0].value).commas;
    const reply = async (body: string) => {
      const r = await inbound('whatsapp', wa(), [msg('m1', body)]);
      await finish(r.jobs[0]!.id);
      return r.jobs[0]!.parts[0];
    };
    // A fresh install has normal commas.
    expect((await api('/api/settings')).data.settings.voice.commas).toBe('normal');

    // The live database still holds the old default. Put it there the way it is stored, without the API.
    await api('/api/settings/voice', { method: 'PUT', body: { max_chars: 260 } });
    await sql("UPDATE settings SET value = json_set(value, '$.commas', 'light') WHERE key = 'voice'");
    expect(await stored()).toBe('light');
    expect((await api('/api/settings')).data.settings.voice.commas).toBe('normal');
    expect(await reply('yo bro, delivery to leeds please')).toBe('Mock reply to: yo bro, delivery to leeds please');
    // An old dashboard tab that still sends "light" saves normal, and any save repairs the stored row.
    expect((await api('/api/settings/voice', { method: 'PUT', body: { commas: 'light' } })).data.voice.commas).toBe('normal');
    expect(await stored()).toBe('normal');

    await api('/api/settings/voice', { method: 'PUT', body: { commas: 'none' } });
    expect((await api('/api/settings')).data.settings.voice.commas).toBe('none');
    expect(await reply('yo bro, delivery to leeds please')).toBe('Mock reply to: yo bro delivery to leeds please');
    await api('/api/settings/voice', { method: 'PUT', body: { commas: 'normal' } });
    expect(await stored()).toBe('normal');
  });

  it('serves the overview, events, health and selector overrides', async () => {
    const o = await api('/api/overview');
    expect(o.data.device.online).toBe(true);
    expect(o.data.counts.sent_today).toBeGreaterThan(0);
    expect((await api('/api/events?limit=5')).data.events.length).toBeGreaterThan(0);
    expect((await api('/api/health')).data.devices.length).toBeGreaterThan(0);

    const before = (await api('/api/selectors')).data.version;
    const put = await api('/api/selectors', { method: 'PUT', body: { override: { whatsapp: { send_button: ['button[data-test="x"]'] } } } });
    expect(put.data.version).not.toBe(before);
    expect(put.data.pack.whatsapp.send_button).toEqual(['button[data-test="x"]']);
    const s = await sync(['whatsapp']);
    expect(s.data.selectors.version).toBe(put.data.version);
    await api('/api/selectors', { method: 'PUT', body: { override: {} } });
  });
});

describe('gmail customers only', () => {
  it('never answers senders on the ignore list, but still answers customers', async () => {
    const promo = await inbound('gmail', unique('pin'), [msg('p1', 'Fortnite Zeus skins for Acx')], { subject: 'Ideas', contact: { name: 'Pinterest', email: 'ideas@inspire.pinterest.com' } });
    expect(promo.action).toBe('none');
    expect(promo.reason).toBe('not_a_customer');
    await api('/api/settings/gmail', { method: 'PUT', body: { ignore_senders: ['supplier@example.com'] } });
    const sup = await inbound('gmail', unique('sup'), [msg('s1', 'Your invoice')], { contact: { name: 'Supplier', email: 'supplier@example.com' } });
    expect(sup.reason).toBe('not_a_customer');
    const cust = await inbound('gmail', unique('cus'), [msg('c1', 'how fast does the 2000w bundle go')], { contact: { name: 'Kgosi', email: 'customer@example.com' } });
    expect(cust.action).toBe('review');
  });
});

describe('tiktok message requests', () => {
  it('answers a request the owner just accepted, after the first reply could not be sent', async () => {
    await api('/api/settings/channels', { method: 'PUT', body: { tiktok: { mode: 'auto' } } });
    const t = unique('req_');
    const first = await inbound('tiktok', t, [{ direction: 'in', body: 'is the 3000w in stock' }]);
    expect(first.action).toBe('reply');
    await finish(first.jobs[0]!.id, { status: 'failed', error_code: 'blocked', error: 'Accept the message request in TikTok first', retryable: false });
    // Seen again without accepting: nothing new, nothing sent.
    expect((await inbound('tiktok', t, [{ direction: 'in', body: 'is the 3000w in stock' }])).action).toBe('none');
    // The owner accepted it: the extension reports the chat as just accepted.
    const again = await inbound('tiktok', t, [{ direction: 'in', body: 'is the 3000w in stock' }], { just_accepted: true });
    expect(again.action).toBe('reply');
    expect(again.jobs[0]!.parts[0]).toContain('is the 3000w in stock');
    await finish(again.jobs[0]!.id);
    // Already answered: a later just accepted report does nothing.
    const done = await inbound('tiktok', t, [{ direction: 'in', body: 'is the 3000w in stock' }, { direction: 'out', body: again.jobs[0]!.parts[0]! }], { just_accepted: true });
    expect(done.action).toBe('none');
  });
});

describe('tiktok accepted requests seen earlier', () => {
  it('answers an accepted request that was seen before but never answered', async () => {
    await api('/api/settings/channels', { method: 'PUT', body: { tiktok: { mode: 'auto' } } });
    const t = unique('req2_');
    // First seen while still a request: the agent's reply was dropped (here: ignored by the brain).
    expect((await inbound('tiktok', t, [{ direction: 'in', body: 'ignore-me price of the 2000w' }])).action).toBe('none');
    await sql(`UPDATE messages SET body = 'price of the 2000w' WHERE body LIKE 'ignore-me%'`);
    const r = await inbound('tiktok', t, [{ direction: 'in', body: 'price of the 2000w' }], { just_accepted: true });
    expect(r.action).toBe('reply');
    await finish(r.jobs[0]!.id);
  });
});
