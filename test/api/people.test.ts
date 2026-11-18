// Two laptops paired to one dashboard (src/pipeline/leader.ts): one answers each lane, the other stands
// by and takes over when the first goes offline or stops working. Laptops on another account stay out.
// Jobs are leased only to the one that answers, and move to the next one only when the first cannot send
// them any more. Commands from the dashboard ride on the syncs until the laptop says it ran them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, api, sql, unique } from '../helpers/client';

const WA = '447700900123';
const GMAIL = 'shop@acx-test.example';
const TIKTOK = 'acx.ebikes';
const MIN = 60_000;

type Ch = { state?: string; account?: string; unread?: number; busy?: boolean; sending?: boolean; sending_id?: string | null; last_ok_at?: number; ok_age_ms?: number; active_ms?: number; detail?: string };
const ready = (account: string, over: Ch = {}): Ch => ({ state: 'ready', account, unread: 0, busy: false, sending: false, sending_id: null, last_ok_at: Date.now() - 1000, ok_age_ms: 1000, ...over });
const all3 = (over: Partial<Record<'whatsapp' | 'gmail' | 'tiktok', Ch>> = {}) => ({
  whatsapp: ready(WA), gmail: ready(GMAIL), tiktok: ready(TIKTOK), ...over,
});

const A = { token: '', id: '' }; // the test run's own laptop ("Sam")
let modesBefore: Record<string, unknown> = {};
const B = { token: '', id: '' }; // a second laptop ("Adrian")

function syncAs(dev: { token: string }, channels: Record<string, Ch>, extra: { version?: string; paused?: boolean; results?: unknown[] } = {}) {
  return api<any>('/api/agent/sync', {
    as: 'public', headers: { authorization: `Bearer ${dev.token}` },
    body: { version: extra.version ?? '0.6.0', status: { channels, paused_locally: extra.paused ?? false, ...(extra.results ? { command_results: extra.results } : {}) } },
  });
}
const resultAs = (dev: { token: string }, id: string, body: Record<string, unknown>) =>
  api<any>(`/api/agent/jobs/${id}/result`, { as: 'public', headers: { authorization: `Bearer ${dev.token}` }, body });

/** Post a read as one laptop and return the decision line (with the rows it read). */
async function inboundAs(dev: { token: string }, thread: string, messages: { external_id: string; direction: 'in' | 'out'; body: string }[]) {
  const res = await fetch(`${BASE()}/api/agent/inbound`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${dev.token}` },
    body: JSON.stringify({ channel: 'whatsapp', thread: { external_id: thread, title: 'Jake', contact: { name: 'Jake' } }, messages: messages.map((m) => ({ ...m, ts: null })) }),
  });
  const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ...lines.find((l) => l.type === 'decision'), rows: lines.find((l) => l.type === 'queries')?.rows };
}

const leaders = async () => Object.fromEntries((await sql('SELECT lane, device_id, account, reason, prev_device, solo FROM lane_leaders')).data.results.map((r: any) => [r.lane, r]));
const roles = (res: { data: any }) => Object.fromEntries(Object.entries(res.data.lanes as Record<string, any>).map(([k, v]) => [k, v.role]));
const age = (id: string, ms: number) => sql('UPDATE devices SET last_seen_at = ? WHERE id = ?', [Date.now() - ms, id]);
const wa = () => `${unique('4479')}@c.us`;
const jobsOf = (res: { data: any }) => (res.data.jobs as any[]).map((j) => j.id);
const job = async (id: string) => (await sql('SELECT status, lease_device, lease_until, not_before, attempts FROM outbox WHERE id = ?', [id])).data.results[0];
const lastWa = async () => (await sql(`SELECT id FROM conversations WHERE channel = 'whatsapp' ORDER BY created_at DESC LIMIT 1`)).data.results[0].id as string;
/** The owner writes to the newest WhatsApp chat: a job that waits in the queue for the laptop that answers WhatsApp. */
const ownerJob = async (text: string) => (await api(`/api/conversations/${await lastWa()}/send`, { body: { text } })).data.outbox_id as string;

beforeAll(async () => {
  modesBefore = (await api('/api/settings')).data.settings.channels;
  await api('/api/agent-toggle', { body: { enabled: true } });
  await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' }, gmail: { mode: 'auto' }, tiktok: { mode: 'auto' } } });
  await api('/api/settings/gmail', { method: 'PUT', body: { account: '' } });
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased')`);
  await sql('DELETE FROM lane_leaders');
  A.token = process.env.ACX_TEST_DEVICE!;
  A.id = (await syncAs(A, {})).data.me.device_id;
  await api(`/api/devices/${A.id}`, { method: 'PATCH', body: { person: 'Sam' } });
});

afterAll(async () => {
  if (B.id) await api(`/api/devices/${B.id}`, { method: 'DELETE' });
  await api('/api/agent-toggle', { body: { enabled: true } });
  await api('/api/settings/channels', { method: 'PUT', body: modesBefore });
  await api('/api/settings/gmail', { method: 'PUT', body: { account: '' } });
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased')`);
  await sql('DELETE FROM lane_leaders');
  await sql(`UPDATE devices SET person = '', commands = '[]', last_seen_at = ? WHERE id = ?`, [Date.now(), A.id]);
  await api('/api/test/bust', { as: 'public', body: {} });
});

describe('pairing a second laptop', () => {
  it('asks whose laptop it is and shows both people', async () => {
    const code = await api('/api/devices/pair-code', { body: { person: '  Adrian ' } });
    expect(code.status).toBe(200);
    expect(code.data.person).toBe('Adrian');
    // An older extension sends no person: the name typed on the Connections screen is used.
    const paired = await api('/api/agent/pair', { as: 'public', body: { code: code.data.code, name: 'MacBook Air' } });
    expect(paired.status).toBe(200);
    expect(paired.data.person).toBe('Adrian');
    B.token = paired.data.token;
    B.id = paired.data.device_id;
    // The popup's own name wins when it sends one (0.6.0).
    const other = await api('/api/devices/pair-code', { body: { person: 'Nobody' } });
    const typed = await api('/api/agent/pair', { as: 'public', body: { code: other.data.code, name: 'Spare', person: 'Jo' } });
    expect(typed.data.person).toBe('Jo');
    await api(`/api/devices/${typed.data.device_id}`, { method: 'DELETE' });

    const people = await api('/api/people');
    expect(people.status).toBe(200);
    const names = people.data.people.map((p: any) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Sam', 'Adrian']));
    expect(names).not.toContain('Jo');
    const ev = (await sql(`SELECT message FROM events WHERE type = 'device_paired' ORDER BY id DESC LIMIT 3`)).data.results.map((r: any) => r.message);
    expect(ev).toContain('Adrian’s laptop is connected.');
  });

  it('renames a laptop, and refuses an empty name', async () => {
    expect((await api(`/api/devices/${B.id}`, { method: 'PATCH', body: { name: 'Adrian MacBook' } })).data.device.name).toBe('Adrian MacBook');
    expect((await api(`/api/devices/${B.id}`, { method: 'PATCH', body: { name: '   ' } })).status).toBe(400);
    expect((await api('/api/devices/dev_nope', { method: 'PATCH', body: { person: 'X' } })).status).toBe(404);
  });
});

describe('one laptop answers each lane', () => {
  it('the first ready laptop answers, the second stands by and gets no jobs', async () => {
    const a = await syncAs(A, all3());
    expect(roles(a)).toEqual({ 'whatsapp:inbox': 'active', 'gmail:inbox': 'active', 'tiktok:inbox': 'active' });
    expect(a.data.lanes['whatsapp:inbox']).toMatchObject({ lease_ms: 60_000, solo: false, account: WA, leader: { device_id: A.id, person: 'Sam' } });
    const b = await syncAs(B, all3());
    expect(roles(b)).toEqual({ 'whatsapp:inbox': 'standby', 'gmail:inbox': 'standby', 'tiktok:inbox': 'standby' });
    expect(b.data.lanes['whatsapp:inbox']).toMatchObject({ lease_ms: 0, leader: { device_id: A.id, person: 'Sam' } });
    const l = await leaders();
    expect(l['whatsapp:inbox']).toMatchObject({ device_id: A.id, account: WA, solo: 0 });
    expect(l['gmail:inbox']).toMatchObject({ device_id: A.id, account: GMAIL });
    expect(l['tiktok:inbox']).toMatchObject({ device_id: A.id, account: TIKTOK });

    // A message the owner typed waits in the queue: only the laptop that answers WhatsApp gets it.
    const first = await inboundAs(A, wa(), [{ external_id: 'p1', direction: 'in', body: 'hello there' }]);
    expect(first.action).toBe('reply');
    expect(first.jobs).toHaveLength(1); // handed over inline: A answers
    await resultAs(A, first.jobs[0].id, { status: 'sent' });
    const sent = await api(`/api/conversations/${first.conversation_id}/send`, { body: { text: 'owner here' } });
    expect(jobsOf(await syncAs(B, all3()))).toEqual([]);
    expect(jobsOf(await syncAs(A, all3()))).toEqual([sent.data.outbox_id]);
    await resultAs(A, sent.data.outbox_id, { status: 'sent' });
  });

  it('a report from the laptop that stands by is stored, but its replies wait for the one that answers', async () => {
    // An older build cannot stand by: it still reads, and its report must never send twice.
    const t = wa();
    const d = await inboundAs(B, t, [{ external_id: 'q1', direction: 'in', body: 'is the 1000w kit in stock' }]);
    expect(d.action).toBe('reply');
    expect(d.jobs).toEqual([]);
    expect(d.jobs_pending).toBe(true);
    expect(jobsOf(await syncAs(B, all3()))).toEqual([]);
    const a = await syncAs(A, all3());
    expect(a.data.jobs).toHaveLength(1);
    expect(a.data.jobs[0].target.thread_external_id).toBe(t);
    // The same chat posted by the laptop that answers: nothing is decided twice.
    const again = await inboundAs(A, t, [{ external_id: 'q1', direction: 'in', body: 'is the 1000w kit in stock' }]);
    expect(['reply_queued', 'nothing_new']).toContain(again.reason);
    const leased = (await sql(`SELECT lease_device, COUNT(*) AS n FROM outbox WHERE status = 'leased' GROUP BY lease_device`)).data.results;
    expect(leased.every((r: any) => r.lease_device === A.id)).toBe(true);
    for (const j of a.data.jobs) await resultAs(A, j.id, { status: 'sent' });
  });

  it('takes over within about a minute and a half when the one that answers goes offline, with no fail back', async () => {
    await sql(`DELETE FROM events WHERE type = 'failover'`);
    // A (0.6.0, not alone) holds a job when it goes quiet: it stops at the end of its lane lease, so the job
    // goes back to the queue for B after a short wait, no try used.
    const held = await ownerJob('held by the laptop that went away');
    expect(jobsOf(await syncAs(A, all3()))).toEqual([held]);
    const leaseUntil = (await job(held)).lease_until;
    // 80 s quiet: not yet (a laptop writes its row about once a minute).
    await age(A.id, 80_000);
    expect(roles(await syncAs(B, all3()))['whatsapp:inbox']).toBe('standby');
    await age(A.id, 95_000);
    const b = await syncAs(B, all3());
    expect(roles(b)).toEqual({ 'whatsapp:inbox': 'active', 'gmail:inbox': 'active', 'tiktok:inbox': 'active' });
    expect(b.data.lanes['whatsapp:inbox'].lease_ms).toBeLessThanOrEqual(60_000);
    expect(b.data.lanes['whatsapp:inbox'].leader).toMatchObject({ device_id: B.id, person: 'Adrian' });
    const l = await leaders();
    expect(l['whatsapp:inbox']).toMatchObject({ device_id: B.id, reason: 'offline', prev_device: A.id, account: WA });
    const ev = (await sql(`SELECT channel, message FROM events WHERE type = 'failover' ORDER BY id`)).data.results;
    expect(ev.map((e: any) => e.channel).sort()).toEqual(['gmail', 'tiktok', 'whatsapp']);
    expect(ev.find((e: any) => e.channel === 'whatsapp').message).toBe('Adrian’s laptop took over WhatsApp. Sam’s laptop is offline.');
    for (const e of ev) expect(e.message).not.toMatch(/[–—]/);
    const back = await job(held);
    expect(back).toMatchObject({ status: 'pending', lease_device: null, attempts: 0 });
    expect(back.not_before).toBeGreaterThan(Date.now() + 20_000);
    expect(back.not_before).toBeLessThan(leaseUntil);
    expect(jobsOf(await syncAs(B, all3()))).not.toContain(held);
    await sql('UPDATE outbox SET not_before = ? WHERE id = ?', [Date.now() - 1, held]);
    expect(jobsOf(await syncAs(B, all3()))).toEqual([held]);
    await resultAs(B, held, { status: 'sent' });

    // The first laptop comes back: it stands by (no fail back), gets no jobs and holds no lease.
    const a = await syncAs(A, all3());
    expect(roles(a)['whatsapp:inbox']).toBe('standby');
    expect(a.data.lanes['whatsapp:inbox'].lease_ms).toBe(0);
    const sent = await ownerJob('second owner message');
    expect(jobsOf(a)).toEqual([]);
    expect(jobsOf(await syncAs(A, all3()))).toEqual([]);
    expect(jobsOf(await syncAs(B, all3()))).toEqual([sent]);
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE id = ?`, [sent]);
  });

  it('the lease of the one that answers always ends before a standby may take over', async () => {
    // B answers. Its row was written 50 s ago and nothing changed: its lease ends 10 s before 90 s.
    await age(B.id, 50_000);
    const b = await syncAs(B, all3());
    const lease = b.data.lanes['whatsapp:inbox'].lease_ms;
    expect(lease).toBeGreaterThan(20_000);
    expect(lease).toBeLessThanOrEqual(30_000 + 1000);
  });

  it('takes over when the channel stops working there, and at once when it is signed out', async () => {
    await sql(`DELETE FROM events WHERE type = 'failover'`);
    // B's WhatsApp starts loading: kept for now.
    await syncAs(B, all3({ whatsapp: ready(WA, { state: 'loading' }) }));
    expect(roles(await syncAs(A, all3()))['whatsapp:inbox']).toBe('standby');
    // Still not ready 45 s later: A takes it.
    await sql(`UPDATE devices SET status = json_set(status, '$.channels.whatsapp.state_since', ?) WHERE id = ?`, [Date.now() - 50_000, B.id]);
    const a = await syncAs(A, all3());
    expect(roles(a)['whatsapp:inbox']).toBe('active');
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ device_id: A.id, reason: 'not_working' });
    expect((await sql(`SELECT message FROM events WHERE type = 'failover'`)).data.results[0].message).toBe('Sam’s laptop took over WhatsApp. WhatsApp stopped working on Adrian’s laptop.');

    // Gmail signed out on B (which still answers it): given up at once, and A answers it on its next sync.
    const b = await syncAs(B, all3({ whatsapp: ready(WA), gmail: { state: 'logged_out', account: '' } }));
    expect(roles(b)['gmail:inbox']).toBe('standby');
    expect((await leaders())['gmail:inbox']).toMatchObject({ device_id: '', reason: 'logged_out', prev_device: B.id });
    expect(roles(await syncAs(A, all3()))['gmail:inbox']).toBe('active');
    const msg = (await sql(`SELECT message FROM events WHERE type = 'failover' AND channel = 'gmail'`)).data.results[0].message;
    expect(msg).toBe('Sam’s laptop took over Gmail. Gmail is signed out on Adrian’s laptop.');
  });

  it('a paused laptop gives its lanes up, and the jobs it held go to the next one at once (not the one it is typing)', async () => {
    // B answers TikTok. A TikTok job waits for it: it is leased to B, then B is paused on the laptop.
    expect((await leaders())['tiktok:inbox'].device_id).toBe(B.id);
    const now = Date.now();
    const ins = (id: string) => sql(`INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, not_before, attempts, pacing, created_at)
      VALUES (?, 'tiktok', 'reply', NULL, '{}', '["hi"]', 'pending', 'manual', 0, 0, '{}', ?)`, [id, now]);
    const [j1, j2] = [unique('ob_tt'), unique('ob_tt')];
    await ins(j1); await ins(j2);
    const got = jobsOf(await syncAs(B, all3()));
    expect(got.sort()).toEqual([j1, j2].sort());
    // Paused while it types j2: j2 stays with it (it finishes it), j1 goes back now, no try used.
    const b = await syncAs(B, all3({ tiktok: ready(TIKTOK, { sending: true, sending_id: j2 }) }), { paused: true });
    expect(roles(b)['tiktok:inbox']).toBe('standby');
    expect(await job(j1)).toMatchObject({ status: 'pending', lease_device: null, attempts: 0 });
    expect((await job(j1)).not_before).toBeLessThanOrEqual(Date.now());
    expect(await job(j2)).toMatchObject({ status: 'leased', lease_device: B.id });
    // A takes TikTok on its next sync. Two laptops never type in one channel at once, so j1 waits only
    // until B has finished j2, not until B's lease would have run out (3 minutes and more).
    const a = await syncAs(A, all3());
    expect(roles(a)['tiktok:inbox']).toBe('active');
    expect((await leaders())['tiktok:inbox'].device_id).toBe(A.id);
    expect(jobsOf(a)).toEqual([]);
    await resultAs(B, j2, { status: 'sent' });
    expect(jobsOf(await syncAs(A, all3()))).toEqual([j1]);
    await resultAs(A, j1, { status: 'sent' });
    await syncAs(B, all3());
  });
});

describe('switching the agent on is not a stall', () => {
  it('a laptop whose page read nothing while the agent was off keeps its lanes when it is switched on', async () => {
    await sql(`DELETE FROM events WHERE type = 'failover'`);
    expect((await leaders())['whatsapp:inbox'].device_id).toBe(A.id);
    await api('/api/agent-toggle', { body: { enabled: false } });
    // Off for an hour: A's tabs are fine but nothing was read, and its lanes do not work (no active_ms).
    const old = { last_ok_at: Date.now() - 3600_000, ok_age_ms: 3600_000 };
    await syncAs(A, all3({ whatsapp: ready(WA, old), gmail: ready(GMAIL, old), tiktok: ready(TIKTOK, old) }));
    await sql('UPDATE lane_leaders SET since = ?', [Date.now() - 2 * 3600_000]);
    await api('/api/agent-toggle', { body: { enabled: true } });
    // B syncs first, before A had a chance to read: no takeover, no alert.
    expect(roles(await syncAs(B, all3()))).toEqual({ 'whatsapp:inbox': 'standby', 'gmail:inbox': 'standby', 'tiktok:inbox': 'standby' });
    // A's lanes start (it says for how long); its first scan is still to come. Still no takeover.
    await syncAs(A, all3({ whatsapp: ready(WA, { ...old, active_ms: 2000 }), gmail: ready(GMAIL, { ...old, active_ms: 2000 }), tiktok: ready(TIKTOK, { ...old, active_ms: 2000 }) }));
    expect(roles(await syncAs(B, all3()))['whatsapp:inbox']).toBe('standby');
    expect((await sql(`SELECT COUNT(*) AS n FROM events WHERE type = 'failover'`)).data.results[0].n).toBe(0);
    // Working for 4 minutes and still nothing read: that is a stall, and B takes WhatsApp over.
    await sql(`UPDATE devices SET status = json_set(status, '$.channels.whatsapp.active_since', ?) WHERE id = ?`, [Date.now() - 4 * MIN, A.id]);
    expect(roles(await syncAs(B, all3()))['whatsapp:inbox']).toBe('active');
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ device_id: B.id, reason: 'stalled' });
    // Back to A for the rest of the tests.
    await sql(`UPDATE lane_leaders SET device_id = ?, reason = 'claim' WHERE lane = 'whatsapp:inbox'`, [A.id]);
    await syncAs(A, all3());
  });
});

describe('the jobs a laptop held move only when it cannot send them', () => {
  it('an older build that went offline keeps its jobs until their lease is over; a 0.6.0 laptop answers', async () => {
    // A runs 0.5.2 and answers WhatsApp. It holds a job, then goes quiet (it may still be typing it).
    await syncAs(A, all3(), { version: '0.5.2' });
    const j = await ownerJob('old build holds this');
    expect(jobsOf(await syncAs(A, all3(), { version: '0.5.2' }))).toEqual([j]);
    const leaseUntil = (await job(j)).lease_until;
    await age(A.id, 95_000);
    expect(roles(await syncAs(B, all3()))['whatsapp:inbox']).toBe('active');
    const back = await job(j);
    expect(back).toMatchObject({ status: 'pending', lease_device: null });
    // Not before its own lease has run out: until then the old laptop may still send it.
    expect(back.not_before).toBeGreaterThanOrEqual(leaseUntil + 5000);
    expect(jobsOf(await syncAs(B, all3()))).not.toContain(j);

    // Once it may go, B gets it and types it. The old laptop comes back and hands it back late: B keeps it.
    await sql('UPDATE outbox SET not_before = ? WHERE id = ?', [Date.now() - 1, j]);
    expect(jobsOf(await syncAs(B, all3()))).toEqual([j]);
    expect((await resultAs(A, j, { status: 'failed', error_code: 'stood_down', error: 'Nothing was typed', retryable: true })).data.status).toBe('leased');
    expect((await resultAs(A, j, { status: 'failed', error_code: 'timeout', error: 'slow', retryable: true })).data.status).toBe('leased');
    expect(await job(j)).toMatchObject({ status: 'leased', lease_device: B.id });
    expect(jobsOf(await syncAs(B, all3()))).toEqual([]); // not offered to B a second time
    await resultAs(B, j, { status: 'sent' });
    await age(A.id, 0);
    await syncAs(A, all3());
  });

  it('a laptop told it was the only one keeps its jobs until their lease is over too', async () => {
    // B answers WhatsApp now. A has not been seen for two days: B is alone, and the lane row says so.
    await age(A.id, 2 * 24 * 3600_000);
    const b = await syncAs(B, all3());
    expect(b.data.lanes['whatsapp:inbox'].solo).toBe(true);
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ device_id: B.id, solo: 1 });
    const j = await ownerJob('held by a laptop that thinks it is alone');
    expect(jobsOf(await syncAs(B, all3()))).toEqual([j]);
    const leaseUntil = (await job(j)).lease_until;
    // A comes back while B cannot reach the server (B keeps working, as the only laptop does).
    await age(A.id, 0);
    await age(B.id, 95_000);
    expect(roles(await syncAs(A, all3()))['whatsapp:inbox']).toBe('active');
    expect((await job(j)).not_before).toBeGreaterThanOrEqual(leaseUntil + 5000);
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE id = ?`, [j]);
    await age(B.id, 0);
    const b2 = await syncAs(B, all3());
    expect(b2.data.lanes['whatsapp:inbox'].solo).toBe(false);
  });

  it('an older build that stops working gives its jobs up once their lease is over, not a minute later', async () => {
    // A runs 0.5.2 and answers WhatsApp with a job leased. Its WhatsApp then breaks for over 45 s.
    expect((await leaders())['whatsapp:inbox'].device_id).toBe(A.id);
    const j = await ownerJob('old build, broken page');
    expect(jobsOf(await syncAs(A, all3(), { version: '0.5.2' }))).toEqual([j]);
    const leaseUntil = (await job(j)).lease_until;
    await syncAs(A, all3({ whatsapp: ready(WA, { state: 'error' }) }), { version: '0.5.2' });
    await sql(`UPDATE devices SET status = json_set(status, '$.channels.whatsapp.state_since', ?) WHERE id = ?`, [Date.now() - 50_000, A.id]);
    expect(roles(await syncAs(B, all3()))['whatsapp:inbox']).toBe('active');
    const back = await job(j);
    expect(back).toMatchObject({ status: 'pending', lease_device: null, attempts: 0 });
    expect(back.not_before).toBeGreaterThanOrEqual(leaseUntil + 5000);
    // Nothing else of WhatsApp is held up meanwhile: a new job goes to B at once.
    const next = await ownerJob('new job for the laptop that answers now');
    expect(jobsOf(await syncAs(B, all3()))).toEqual([next]);
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE id IN (?, ?)`, [j, next]);
    await syncAs(A, all3());
    await sql(`UPDATE lane_leaders SET device_id = ?, reason = 'claim' WHERE lane = 'whatsapp:inbox'`, [A.id]);
    await syncAs(A, all3());
  });
});

describe('accounts', () => {
  it('a laptop on another account never answers that lane, even when the other laptop is offline', async () => {
    // A answers WhatsApp for the shop's number. B is signed in to another number.
    expect((await leaders())['whatsapp:inbox'].device_id).toBe(A.id);
    const other = '447700900999';
    expect(roles(await syncAs(B, all3({ whatsapp: ready(other) })))['whatsapp:inbox']).toBe('other_account');
    await age(A.id, 5 * MIN);
    const b = await syncAs(B, all3({ whatsapp: ready(other) }));
    expect(roles(b)['whatsapp:inbox']).toBe('other_account');
    expect((await leaders())['whatsapp:inbox'].device_id).toBe(A.id);
    // Its other lanes still work on their own: it took Gmail and TikTok over from the offline laptop.
    expect(roles(b)['gmail:inbox']).toBe('active');
    expect(roles(b)['tiktok:inbox']).toBe('active');
    // A WhatsApp job waits for a laptop on the shop's number.
    const sent = await ownerJob('only from the shop number');
    expect(jobsOf(await syncAs(B, all3({ whatsapp: ready(other) })))).not.toContain(sent);
    const people = (await api('/api/people')).data;
    const adrian = people.people.find((p: any) => p.name === 'Adrian').devices[0];
    expect(adrian.channels.whatsapp).toMatchObject({ role: 'other_account', account: other, account_shown: `+${other}` });
    expect(people.lanes.whatsapp).toMatchObject({ account: WA, account_shown: `+${WA}` });

    // The owner says the shop uses B's number now: B answers, A (on the old number) stays out.
    const put = await api('/api/lanes/whatsapp:inbox/account', { method: 'PUT', body: { account: `+${other}` } });
    expect(put.data).toMatchObject({ ok: true, account: other });
    expect((await api('/api/lanes/whatsapp:inbox/account', { method: 'PUT', body: { account: 'nope' } })).status).toBe(400);
    expect((await api('/api/lanes/fax:inbox/account', { method: 'PUT', body: { account: '' } })).status).toBe(404);
    await age(A.id, 0);
    expect(roles(await syncAs(A, all3()))['whatsapp:inbox']).toBe('other_account');
    const b2 = await syncAs(B, all3({ whatsapp: ready(other) }));
    expect(roles(b2)['whatsapp:inbox']).toBe('active');
    expect(jobsOf(b2)).toContain(sent);
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE id = ?`, [sent]);
    // Back to the first number for the rest of the tests.
    await api('/api/lanes/whatsapp:inbox/account', { method: 'PUT', body: { account: WA } });
    await syncAs(B, all3());
  });

  it('the Gmail inbox chosen in Connections is the shop account, and clearing it lets the lane learn a new one', async () => {
    await api('/api/settings/gmail', { method: 'PUT', body: { account: 'other@acx-test.example' } });
    const a = await syncAs(A, all3());
    expect(roles(a)['gmail:inbox']).toBe('other_account');
    expect((await leaders())['gmail:inbox'].account).toBe('other@acx-test.example');
    // Cleared on the People panel: the lane forgets the address, so a laptop on a new address is not kept out.
    const NEW = 'new@acx-test.example';
    const cleared = await api('/api/lanes/gmail:inbox/account', { method: 'PUT', body: { account: '' } });
    expect(cleared.data).toMatchObject({ ok: true, account: '' });
    expect((await leaders())['gmail:inbox'].account).toBe('');
    const who = (await leaders())['gmail:inbox'].device_id;
    const leader = who === A.id ? A : B;
    const g = await syncAs(leader, all3({ gmail: ready(NEW) }));
    expect(roles(g)['gmail:inbox']).toBe('active');
    expect((await leaders())['gmail:inbox'].account).toBe(NEW);
    // Cleared in Connections works the same way.
    await api('/api/settings/gmail', { method: 'PUT', body: { account: '' } });
    expect((await leaders())['gmail:inbox'].account).toBe('');
    await syncAs(leader, all3());
    expect((await leaders())['gmail:inbox'].account).toBe(GMAIL);
    await syncAs(leader === A ? B : A, all3());
  });
});

describe('older builds', () => {
  it('a 0.5.2 laptop gets jobs only for the lanes it answers, and no commands', async () => {
    const b = await syncAs(B, all3(), { version: '0.5.2' });
    const l = await leaders();
    for (const [lane, g] of Object.entries(b.data.lanes as Record<string, any>)) {
      expect(g.role === 'active').toBe(l[lane].device_id === B.id);
    }
    const cmd = await api(`/api/devices/${B.id}/commands`, { body: { type: 'open_tab', lane: 'whatsapp:inbox' } });
    expect(cmd.status).toBe(409);
    expect(cmd.data.error).toBe('old_extension');
    await syncAs(B, all3());
  });
});

describe('open a tab on another laptop', () => {
  it('waits on the laptop row, goes out with each sync until the laptop says it ran it, and says when it is done', async () => {
    const made = await api(`/api/devices/${A.id}/commands`, { body: { type: 'open_tab', lane: 'whatsapp:inbox' } });
    expect(made.status).toBe(200);
    const id = made.data.command.id;
    expect(made.data.command).toMatchObject({ type: 'open_tab', lane: 'whatsapp:inbox', channel: 'whatsapp' });
    expect((await api(`/api/devices/${A.id}/commands/${id}`)).data.state).toBe('waiting');
    // A channel name works too, and the same tab asked twice is one command (the newer one).
    await api(`/api/devices/${A.id}/commands`, { body: { channel: 'gmail' } });
    const again = await api(`/api/devices/${A.id}/commands`, { body: { lane: 'whatsapp:inbox' } });
    const gmailId = (JSON.parse((await sql('SELECT commands FROM devices WHERE id = ?', [A.id])).data.results[0].commands) as any[]).find((c) => c.lane === 'gmail:inbox').id;
    expect((await api(`/api/devices/${A.id}/commands`, { body: { lane: 'fax' } })).status).toBe(400);
    expect((await api(`/api/devices/${A.id}/commands`, { body: { type: 'reboot', lane: 'gmail' } })).status).toBe(400);
    expect((await api(`/api/devices/${A.id}/commands/${again.data.command.id}`)).data.state).toBe('waiting');

    expect((await syncAs(B, all3())).data.commands).toEqual([]);
    const a = await syncAs(A, all3());
    expect(a.data.commands.map((c: any) => c.lane).sort()).toEqual(['gmail:inbox', 'whatsapp:inbox']);
    expect((await api(`/api/devices/${A.id}/commands/${again.data.command.id}`)).data.state).toBe('sent');
    // That answer never reached the laptop: the next sync hands both over again (the laptop skips ids it ran).
    const a2 = await syncAs(A, all3());
    expect(a2.data.commands.map((c: any) => c.id).sort()).toEqual([again.data.command.id, gmailId].sort());
    // The laptop ran both, one worked and one failed: they come off the row and the dashboard can say so.
    const done = await syncAs(A, all3(), { results: [{ id: gmailId, ok: false, at: Date.now(), error: 'tab_missing' }, { id: again.data.command.id, ok: true, at: Date.now() }] });
    expect(done.status).toBe(200);
    expect(done.data.commands).toEqual([]);
    expect((await sql('SELECT commands FROM devices WHERE id = ?', [A.id])).data.results[0].commands).toBe('[]');
    expect((await api(`/api/devices/${A.id}/commands/${again.data.command.id}`)).data.state).toBe('done');
    expect((await api(`/api/devices/${A.id}/commands/${gmailId}`)).data).toEqual({ state: 'failed', error: 'tab_missing' });
    expect((await syncAs(A, all3(), { results: [{ id: gmailId, ok: false, at: Date.now(), error: 'tab_missing' }, { id: again.data.command.id, ok: true, at: Date.now() }] })).data.commands).toEqual([]);
  });

  it('drops a command nobody ran within 2 minutes, and says it expired', async () => {
    const old = JSON.stringify([{ id: 'cmd_old_1', type: 'open_tab', lane: 'tiktok:inbox', channel: 'tiktok', at: Date.now() - 3 * MIN, sent_at: Date.now() - 3 * MIN }]);
    await sql('UPDATE devices SET commands = ? WHERE id = ?', [old, A.id]);
    expect((await api(`/api/devices/${A.id}/commands/cmd_old_1`)).data.state).toBe('expired');
    expect((await syncAs(A, all3())).data.commands).toEqual([]);
    expect((await sql('SELECT commands FROM devices WHERE id = ?', [A.id])).data.results[0].commands).toBe('[]');
    // Gone from the row with no result: still expired, never "sent" forever.
    expect((await api(`/api/devices/${A.id}/commands/cmd_old_1`)).data.state).toBe('expired');
    expect((await api(`/api/devices/${A.id}/commands/cmd_${(Date.now() - 5 * MIN).toString(36)}_abc`)).data.state).toBe('expired');
  });
});

describe('cheap on the free plan', () => {
  it('a sync with nothing new reads a few rows and writes none, for the one that answers and for the standby', async () => {
    await syncAs(A, all3());
    await syncAs(B, all3());
    const a = await syncAs(A, all3());
    const b = await syncAs(B, all3());
    for (const r of [a, b]) {
      expect(r.status).toBe(200);
      expect(r.written).toBe(0);
      expect(r.queries).toBeLessThanOrEqual(13);
      expect(r.rows).toBeLessThan(60);
    }
    console.log(`sync rows: answering ${a.rows} (${a.queries} queries), standby ${b.rows} (${b.queries} queries)`);
  });

  it('old and removed laptops cost nothing: a sync, a report and a diagnostic read only live rows', async () => {
    const before = await syncAs(A, all3());
    // 300 laptops removed long ago and 60 never seen for days (paired again under a new name, say).
    await sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 300)
      INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, revoked_at) SELECT 'dev_gone_' || i, 'Gone', 'gone_' || i, 1, ?, ? FROM n`, [Date.now() - 9 * 24 * 3600_000, Date.now() - 8 * 24 * 3600_000]);
    await sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 60)
      INSERT INTO devices (id, name, token_hash, created_at, last_seen_at) SELECT 'dev_old_' || i, 'Old', 'old_' || i, 1, ? FROM n`, [Date.now() - 3 * 24 * 3600_000]);
    try {
      const a = await syncAs(A, all3());
      expect(a.status).toBe(200);
      expect(a.rows).toBeLessThanOrEqual(before.rows + 2);
      // Laptops not seen for a day do not count: with B gone quiet too, A is the only one and keeps working offline.
      expect(a.data.lanes['whatsapp:inbox'].solo).toBe(false);
      await age(B.id, 2 * 24 * 3600_000);
      expect((await syncAs(A, all3())).data.lanes['whatsapp:inbox'].solo).toBe(true);
      await age(B.id, 0);
      const d = await api('/api/agent/diagnostics', { as: 'public', headers: { authorization: `Bearer ${A.token}` }, body: { kind: 'note', channel: 'whatsapp', data: { x: 1 } } });
      expect(d.status).toBe(200);
      expect(d.rows).toBeLessThanOrEqual(10);
      // A report reads one leader row more than before, never the laptop list.
      const r = await inboundAs(A, wa(), [{ external_id: 'c1', direction: 'in', body: 'ignore-me' }]);
      expect(r.rows).toBeLessThan(80);
      const cronRes = await api('/api/test/cron', { as: 'public', body: {} });
      expect(cronRes.status).toBe(200);
    } finally {
      await sql(`DELETE FROM devices WHERE id LIKE 'dev_gone_%' OR id LIKE 'dev_old_%'`);
    }
    await syncAs(A, all3());
  });

  it('the support report shows the people and who answers each lane, with accounts masked', async () => {
    const link = await api('/api/support/link', { body: {} });
    const token = String(link.data.url).split('/').pop();
    const report = await api(`/api/support/report/${token}`, { as: 'public' });
    expect(report.status).toBe(200);
    const text = JSON.stringify(report.data);
    expect(text).not.toContain(WA);
    expect(text).not.toContain(GMAIL);
    expect(report.data.lane_leaders.map((l: any) => l.lane)).toEqual(['whatsapp:inbox', 'gmail:inbox', 'tiktok:inbox']);
    expect(report.data.lane_leaders[0].account).toBe('…0123');
    const people = report.data.people.map((p: any) => p.person);
    expect(people).toEqual(expect.arrayContaining(['Sam', 'Adrian']));
    expect(report.data.people.find((p: any) => p.person === 'Adrian').lanes['whatsapp:inbox'].account).toBe('…0123');
    await api('/api/support/link', { method: 'DELETE' });
  });
});

describe('disconnecting a laptop', () => {
  it('removes it at once: its lanes are free, its jobs go to the next laptop, and its token stops working', async () => {
    // B answers TikTok and holds a job there.
    await sql(`UPDATE lane_leaders SET device_id = ? WHERE lane = 'tiktok:inbox'`, [B.id]);
    const j = unique('ob_tt');
    await sql(`INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, not_before, attempts, pacing, created_at)
      VALUES (?, 'tiktok', 'reply', NULL, '{}', '["hi"]', 'pending', 'manual', 0, 0, '{}', ?)`, [j, Date.now()]);
    expect(jobsOf(await syncAs(B, all3()))).toEqual([j]);
    const left = await api('/api/agent/leave', { as: 'public', headers: { authorization: `Bearer ${B.token}` }, body: {} });
    expect(left.status).toBe(200);
    expect((await leaders())['tiktok:inbox']).toMatchObject({ device_id: '', reason: 'removed', prev_device: B.id });
    expect(await job(j)).toMatchObject({ status: 'pending', lease_device: null, attempts: 0 });
    expect((await syncAs(B, all3())).status).toBe(401);
    // A claims TikTok on its next sync, and the owner is told why.
    expect(roles(await syncAs(A, all3()))['tiktok:inbox']).toBe('active');
    const msg = (await sql(`SELECT message FROM events WHERE type = 'failover' AND channel = 'tiktok' ORDER BY id DESC LIMIT 1`)).data.results[0].message;
    expect(msg).toBe('Sam’s laptop took over TikTok. Adrian’s laptop was removed.');
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE id = ?`, [j]);
    expect((await api('/api/people')).data.people.map((p: any) => p.name)).not.toContain('Adrian');
  });
});
