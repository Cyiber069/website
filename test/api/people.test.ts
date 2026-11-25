// Two laptops paired to one dashboard (src/pipeline/leader.ts): Sam's (the test run's own laptop, the main
// one) and Adrian's. One laptop answers each lane. A laptop on the shop's account that is not the main one
// stands by, takes over when the main one goes offline or stops working, and hands back when it is ready
// again. A laptop on another account stays out, and is never counted for the shop's channels. Jobs are
// leased only to the one that answers, and move to the next one only when the first cannot send them any
// more. Commands from the dashboard ride on the syncs until the laptop says it ran them.
// The owner's five points each have a block ("point 1" to "point 5").
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, api, sql, unique } from '../helpers/client';
import { OWNER_PASSWORD } from '../helpers/global-setup';

const WA = '447700900123';
const GMAIL = 'shop@acx-test.example';
const TIKTOK = 'acx.ebikes';
// Adrian's own accounts.
const WA2 = '447700900999';
const GMAIL2 = 'adrian@home-test.example';
const TIKTOK2 = 'adrian.rides';
const MIN = 60_000;

type Ch = { state?: string; account?: string; unread?: number; busy?: boolean; sending?: boolean; sending_id?: string | null; last_ok_at?: number; ok_age_ms?: number; active_ms?: number; detail?: string };
const ready = (account: string, over: Ch = {}): Ch => ({ state: 'ready', account, unread: 0, busy: false, sending: false, sending_id: null, last_ok_at: Date.now() - 1000, ok_age_ms: 1000, ...over });
const all3 = (over: Partial<Record<'whatsapp' | 'gmail' | 'tiktok', Ch>> = {}) => ({
  whatsapp: ready(WA), gmail: ready(GMAIL), tiktok: ready(TIKTOK), ...over,
});
/** Adrian's tabs on his own accounts. Gmail says "blocked" there (it is not the inbox chosen) and TikTok is broken. */
const other3 = (over: Partial<Record<'whatsapp' | 'gmail' | 'tiktok', Ch>> = {}) => ({
  whatsapp: ready(WA2),
  gmail: ready(GMAIL2, { state: 'blocked', detail: `This tab shows ${GMAIL2}. Switch it to ${GMAIL}` }),
  tiktok: ready(TIKTOK2, { state: 'error', last_ok_at: Date.now() - 3600_000, ok_age_ms: 3600_000 }),
  ...over,
});

const A = { token: '', id: '' }; // the test run's own laptop ("Sam"), the main laptop
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
async function inboundAs(dev: { token: string }, thread: string, messages: { external_id: string; direction: 'in' | 'out'; body: string }[], channel = 'whatsapp') {
  const res = await fetch(`${BASE()}/api/agent/inbound`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${dev.token}` },
    body: JSON.stringify({ channel, thread: { external_id: thread, title: 'Jake', contact: { name: 'Jake' } }, messages: messages.map((m) => ({ ...m, ts: null })) }),
  });
  const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ...lines.find((l) => l.type === 'decision'), rows: lines.find((l) => l.type === 'queries')?.rows };
}

const leaders = async () => Object.fromEntries((await sql('SELECT lane, device_id, account, account_src, reason, prev_device, solo, handover_at FROM lane_leaders')).data.results.map((r: any) => [r.lane, r]));
const roles = (res: { data: any }) => Object.fromEntries(Object.entries(res.data.lanes as Record<string, any>).map(([k, v]) => [k, v.role]));
const age = (id: string, ms: number) => sql('UPDATE devices SET last_seen_at = ? WHERE id = ?', [Date.now() - ms, id]);
/** A laptop's channels have been in their state this long (as if it had been checking in all along). */
const since = (id: string, ms: number) => sql(`UPDATE devices SET status = json_set(status, '$.channels.whatsapp.state_since', ?1, '$.channels.gmail.state_since', ?1, '$.channels.tiktok.state_since', ?1) WHERE id = ?2`, [Date.now() - ms, id]);
const wa = () => `${unique('4479')}@c.us`;
const jobsOf = (res: { data: any }) => (res.data.jobs as any[]).map((j) => j.id);
const job = async (id: string) => (await sql('SELECT status, lease_device, lease_until, not_before, attempts FROM outbox WHERE id = ?', [id])).data.results[0];
const lastWa = async () => (await sql(`SELECT id FROM conversations WHERE channel = 'whatsapp' ORDER BY created_at DESC LIMIT 1`)).data.results[0].id as string;
/** The owner writes to the newest WhatsApp chat: a job that waits in the queue for the laptop that answers WhatsApp. */
const ownerJob = async (text: string) => (await api(`/api/conversations/${await lastWa()}/send`, { body: { text } })).data.outbox_id as string;
const bust = () => api('/api/test/bust', { as: 'public', body: {} });
const people = async () => { await bust(); return (await api('/api/people')).data; };
const deviceOf = (p: any, name: string) => p.people.find((x: any) => x.name === name)?.devices?.[0];
/** Back to the start: Sam answers every lane on the shop's accounts, Adrian stands by on them. */
async function reset() {
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased')`);
  await sql('DELETE FROM lane_leaders');
  await age(A.id, 0);
  if (B.token) await age(B.id, 0);
  await syncAs(A, all3());
  if (B.token) await syncAs(B, all3());
}

beforeAll(async () => {
  modesBefore = (await api('/api/settings')).data.settings.channels;
  await api('/api/agent-toggle', { body: { enabled: true } });
  await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' }, gmail: { mode: 'auto' }, tiktok: { mode: 'auto' } } });
  await api('/api/settings/gmail', { method: 'PUT', body: { account: '' } });
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased')`);
  await sql('DELETE FROM lane_leaders');
  A.token = process.env.ACX_TEST_DEVICE!;
  A.id = (await syncAs(A, {})).data.me.device_id;
  // Only these two laptops: any other left by another test is removed, and Sam's is the main one.
  await sql('UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL AND id != ?', [Date.now(), A.id]);
  expect((await api('/api/people/main', { method: 'PUT', body: { device_id: A.id } })).status).toBe(200);
  await sql(`DELETE FROM settings WHERE key IN ('state:offline_alerted', 'state:monitor')`);
  await api(`/api/devices/${A.id}`, { method: 'PATCH', body: { person: 'Sam' } });
});

afterAll(async () => {
  if (B.id) await api(`/api/devices/${B.id}`, { method: 'DELETE' });
  await api('/api/agent-toggle', { body: { enabled: true } });
  await api('/api/settings/channels', { method: 'PUT', body: modesBefore });
  await api('/api/settings/gmail', { method: 'PUT', body: { account: '' } });
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased')`);
  await sql('DELETE FROM lane_leaders');
  await sql(`DELETE FROM settings WHERE key IN ('state:main_device', 'state:offline_alerted', 'state:monitor')`);
  await sql(`UPDATE devices SET person = '', commands = '[]', last_seen_at = ? WHERE id = ?`, [Date.now(), A.id]);
  await bust();
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

    const p = await people();
    const names = p.people.map((x: any) => x.name);
    expect(names).toEqual(expect.arrayContaining(['Sam', 'Adrian']));
    expect(names).not.toContain('Jo');
    // Sam's laptop is the main one; Adrian's is not.
    expect(p.main).toEqual({ device_id: A.id, label: 'Sam’s laptop' });
    expect(deviceOf(p, 'Sam').main).toBe(true);
    expect(deviceOf(p, 'Adrian').main).toBe(false);
    const ev = (await sql(`SELECT message FROM events WHERE type = 'device_paired' ORDER BY id DESC LIMIT 3`)).data.results.map((r: any) => r.message);
    expect(ev).toContain('Adrian’s laptop is connected.');
  });

  it('renames a laptop, and refuses an empty name', async () => {
    expect((await api(`/api/devices/${B.id}`, { method: 'PATCH', body: { name: 'Adrian MacBook' } })).data.device.name).toBe('Adrian MacBook');
    expect((await api(`/api/devices/${B.id}`, { method: 'PATCH', body: { name: '   ' } })).status).toBe(400);
    expect((await api('/api/devices/dev_nope', { method: 'PATCH', body: { person: 'X' } })).status).toBe(404);
  });
});

describe('point 1: Adrian’s laptop on other accounts never takes jobs, never leads, never makes the owner’s channel look broken', () => {
  it('stays out of every lane, even with the main laptop offline and nobody answering, and none of its chats are stored', async () => {
    await reset();
    const a = await syncAs(A, all3());
    expect(roles(a)).toEqual({ 'whatsapp:inbox': 'active', 'gmail:inbox': 'active', 'tiktok:inbox': 'active' });
    const b = await syncAs(B, other3());
    expect(roles(b)).toEqual({ 'whatsapp:inbox': 'other_account', 'gmail:inbox': 'other_account', 'tiktok:inbox': 'other_account' });
    for (const g of Object.values(b.data.lanes as Record<string, any>)) expect(g.lease_ms).toBe(0);
    // A customer chat on Sam's WhatsApp, and a message from the owner waiting in the queue.
    const first = await inboundAs(A, wa(), [{ external_id: 'o1', direction: 'in', body: 'hello' }]);
    for (const j of first.jobs) await resultAs(A, j.id, { status: 'sent' });
    const sent = await ownerJob('only from the shop number');
    expect(jobsOf(await syncAs(B, other3()))).toEqual([]);
    // Sam's laptop goes offline for 5 minutes: Adrian's still never takes over.
    await age(A.id, 5 * MIN);
    const b2 = await syncAs(B, other3());
    expect(roles(b2)).toEqual({ 'whatsapp:inbox': 'other_account', 'gmail:inbox': 'other_account', 'tiktok:inbox': 'other_account' });
    expect(jobsOf(b2)).toEqual([]);
    const l = await leaders();
    for (const lane of ['whatsapp:inbox', 'gmail:inbox', 'tiktok:inbox']) expect(l[lane].device_id).toBe(A.id);
    // Nobody answers at all (Sam's laptop gave the lanes up): it still claims none.
    await sql(`UPDATE lane_leaders SET device_id = ''`);
    expect(roles(await syncAs(B, other3()))).toEqual({ 'whatsapp:inbox': 'other_account', 'gmail:inbox': 'other_account', 'tiktok:inbox': 'other_account' });
    expect(Object.values(await leaders()).every((r: any) => r.device_id === '')).toBe(true);
    // An older build on Adrian's laptop reads its own chats and reports them: nothing is stored, nothing is decided.
    const t = wa();
    const d = await inboundAs(B, t, [{ external_id: 'x1', direction: 'in', body: 'hi mate are we still on for later' }]);
    expect(d).toMatchObject({ conversation_id: null, action: 'none', reason: 'other_account', jobs: [], final: true });
    expect((await sql('SELECT COUNT(*) AS n FROM conversations WHERE external_thread_id = ?', [t])).data.results[0].n).toBe(0);
    // Its videos are not sent either.
    const v = await api(`/api/agent/media/video?channel=whatsapp&message=x1&thread=${encodeURIComponent(t)}`, { as: 'public', headers: { authorization: `Bearer ${B.token}` } });
    expect(v.data).toMatchObject({ upload: false, why: 'not_shop_account' });
    // Sam's laptop comes back: it answers again and gets the owner's message.
    await age(A.id, 0);
    const back = await syncAs(A, all3());
    expect(roles(back)['whatsapp:inbox']).toBe('active');
    expect(jobsOf(back)).toEqual([sent]);
    await resultAs(A, sent, { status: 'sent' });
  });

  it('Live and Health show Sam’s channels from Sam’s laptop, whatever Adrian’s tabs say', async () => {
    await syncAs(A, all3());
    await syncAs(B, other3());
    await bust();
    const ov = (await api('/api/overview')).data;
    expect(ov.device.id).toBe(A.id);
    for (const ch of ['whatsapp', 'gmail', 'tiktok']) {
      expect(ov.lanes[ch].device.id).toBe(A.id);
      expect(ov.lanes[ch].device.status.channels[ch].state).toBe('ready');
      expect(ov.lanes[ch].role).toBe('active');
    }
    const health = (await api('/api/health')).data;
    expect(health.device.id).toBe(A.id);
    for (const ch of ['whatsapp', 'gmail', 'tiktok']) expect(health.lanes[ch].device.id).toBe(A.id);
  });
});

describe('point 2: the owner’s name shows Connected, Adrian’s "Connected to another account", never counted', () => {
  it('the People panel: Sam answers each channel, Adrian is on another account there (not an error)', async () => {
    await syncAs(A, all3());
    await syncAs(B, other3());
    const p = await people();
    for (const ch of ['whatsapp', 'gmail', 'tiktok']) {
      expect(deviceOf(p, 'Sam').channels[ch]).toMatchObject({ role: 'active', state: 'ready' });
      expect(deviceOf(p, 'Adrian').channels[ch].role).toBe('other_account');
    }
    expect(deviceOf(p, 'Adrian').channels.whatsapp).toMatchObject({ account: WA2, account_shown: `+${WA2}` });
    // An older Gmail build sends no account: the address in its status words is read.
    const old = await syncAs(B, other3({ gmail: { state: 'blocked', detail: `This tab shows ${GMAIL2}. Switch it to ${GMAIL}` } }), { version: '0.5.2' });
    expect(roles(old)['gmail:inbox']).toBe('other_account');
    expect(deviceOf(await people(), 'Adrian').channels.gmail).toMatchObject({ role: 'other_account', account: GMAIL2 });
  });

  it('Adrian’s broken tabs are no channel problem and no alert; his laptop going offline is no alert', async () => {
    await sql(`DELETE FROM settings WHERE key IN ('state:monitor', 'state:offline_alerted', 'state:alert_last:channel', 'state:alert_last:offline')`);
    await sql(`DELETE FROM events WHERE type IN ('channel_down', 'device_offline')`);
    await syncAs(A, all3());
    // Adrian's TikTok has not read anything for an hour and his Gmail is blocked.
    await syncAs(B, other3());
    await api('/api/test/cron', { as: 'public', body: {} });
    const mon = JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'state:monitor'`)).data.results[0]?.value ?? '{}');
    expect(mon.channels ?? {}).toEqual({});
    // Adrian's laptop is quiet for half an hour: nobody is told.
    await age(B.id, 30 * MIN);
    await api('/api/test/cron', { as: 'public', body: {} });
    expect((await sql(`SELECT COUNT(*) AS n FROM events WHERE type IN ('device_offline', 'channel_down')`)).data.results[0].n).toBe(0);
    // Live's headline is about Sam's laptop: online, 3 channels connected.
    await bust();
    const ov = (await api('/api/overview')).data;
    expect(ov.device).toMatchObject({ id: A.id, online: true });
    await age(B.id, 0);
  });

  it('Sam’s laptop going quiet is told once, by name, even while Adrian’s is online, and ends only when Sam’s is back', async () => {
    await sql(`DELETE FROM settings WHERE key IN ('state:offline_alerted', 'state:alert_last:offline', 'state:monitor')`);
    await sql(`DELETE FROM events WHERE type IN ('device_offline', 'device_online', 'channel_down', 'channel_ok')`);
    // WhatsApp was already found down on Sam's laptop (and the owner told).
    await sql(`INSERT INTO settings (key, value, updated_at) VALUES ('state:monitor', ?, 0)`, [JSON.stringify({ channels: { whatsapp: { since: Date.now() - 20 * MIN, alerted: true, reason: 'The WhatsApp page could not be read.' } }, stuck: [], stuck_by_channel: {}, ai_failing: false, usage_alert_day: '' })]);
    await syncAs(B, other3());
    await age(A.id, 30 * MIN);
    await api('/api/test/cron', { as: 'public', body: {} });
    const ev = (await sql(`SELECT message FROM events WHERE type = 'device_offline'`)).data.results;
    expect(ev).toHaveLength(1);
    expect(ev[0].message).toBe('Sam’s laptop has gone quiet. Nothing can be sent until Chrome is open on it again.');
    const mon = JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'state:monitor'`)).data.results[0].value);
    expect(mon.channels.whatsapp).toMatchObject({ alerted: true });
    // One alert, as with one laptop: Adrian's laptop being online adds no "stopped working" for each channel,
    // and never says a channel is back to normal while nobody reads it.
    expect((await sql(`SELECT COUNT(*) AS n FROM events WHERE type IN ('channel_down', 'channel_ok')`)).data.results[0].n).toBe(0);
    // Live says the laptop is offline (not Adrian's online laptop), and so does Health.
    await bust();
    const ov = (await api('/api/overview')).data;
    expect(ov.device).toMatchObject({ id: A.id, online: false });
    for (const ch of ['whatsapp', 'gmail', 'tiktok']) expect(ov.lanes[ch].device.id).toBe(A.id);
    expect((await api('/api/health')).data.device).toMatchObject({ id: A.id, online: false });
    // Adrian's laptop checking in again (after a gap) does not end it; Sam's does.
    await age(B.id, 5 * MIN);
    await syncAs(B, other3());
    expect(JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'state:offline_alerted'`)).data.results[0].value)).toBe(A.id);
    await api('/api/test/cron', { as: 'public', body: {} });
    expect((await sql(`SELECT COUNT(*) AS n FROM events WHERE type = 'device_offline'`)).data.results[0].n).toBe(1);
    await age(A.id, 5 * MIN);
    await syncAs(A, all3());
    expect(JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'state:offline_alerted'`)).data.results[0].value)).toBe(false);
    // The seeded WhatsApp problem is not left for later tests (a later check would call it back to normal).
    await sql(`DELETE FROM settings WHERE key IN ('state:monitor', 'state:offline_alerted')`);
    await sql(`DELETE FROM events WHERE type IN ('device_offline', 'device_online', 'channel_down', 'channel_ok')`);
  });
});

describe('point 3: one shared dashboard login, anyone sees each person’s laptop and channels', () => {
  it('a second sign in with the same password sees both people, each with their own laptop and channels', async () => {
    // There is one owner password: setting up again is refused.
    expect((await api('/api/setup', { as: 'public', body: { password: 'another password here' } })).status).toBeGreaterThanOrEqual(400);
    const login = await fetch(`${BASE()}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE() }, body: JSON.stringify({ password: OWNER_PASSWORD }) });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(cookie).not.toBe(process.env.ACX_TEST_COOKIE);
    await bust();
    const res = await fetch(`${BASE()}/api/people`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const p = await res.json() as any;
    expect(p.people.map((x: any) => x.name).sort()).toEqual(['Adrian', 'Sam']);
    for (const name of ['Sam', 'Adrian']) {
      const d = deviceOf(p, name);
      expect(d.label).toBe(`${name}’s laptop`);
      expect(Object.keys(d.channels)).toEqual(['whatsapp', 'gmail', 'tiktok']);
    }
    // The overview carries the same people for the chips next to the logo.
    const ov = await (await fetch(`${BASE()}/api/overview`, { headers: { cookie } })).json() as any;
    expect(ov.people.map((x: any) => x.name).sort()).toEqual(['Adrian', 'Sam']);
    await fetch(`${BASE()}/api/logout`, { method: 'POST', headers: { cookie, origin: BASE() } });
  });
});

describe('point 4: the shop’s account per channel', () => {
  it('WhatsApp and TikTok are the main laptop’s accounts, and replace one learned from another laptop', async () => {
    await reset();
    let l = await leaders();
    expect(l['whatsapp:inbox']).toMatchObject({ account: WA, account_src: 'main', device_id: A.id });
    expect(l['tiktok:inbox']).toMatchObject({ account: TIKTOK, account_src: 'main' });
    // An account learned from Adrian's laptop before (Adrian answered on his own number): Sam's replaces it,
    // and Sam takes the lane from the laptop on the other number at once.
    await sql(`UPDATE lane_leaders SET device_id = ?, account = ?, account_src = '' WHERE lane = 'whatsapp:inbox'`, [B.id, WA2]);
    await syncAs(B, all3({ whatsapp: ready(WA2) }));
    const a = await syncAs(A, all3());
    expect(roles(a)['whatsapp:inbox']).toBe('active');
    l = await leaders();
    expect(l['whatsapp:inbox']).toMatchObject({ account: WA, account_src: 'main', device_id: A.id, reason: 'other_account' });
    expect(roles(await syncAs(B, all3({ whatsapp: ready(WA2) })))['whatsapp:inbox']).toBe('other_account');
  });

  it('Gmail is the inbox chosen in Connections; cleared, the main laptop’s is used', async () => {
    await api('/api/settings/gmail', { method: 'PUT', body: { account: GMAIL2 } });
    expect((await leaders())['gmail:inbox']).toMatchObject({ account: GMAIL2, account_src: 'owner' });
    expect(roles(await syncAs(A, all3()))['gmail:inbox']).toBe('other_account');
    // Adrian's laptop is on that inbox: it answers Gmail, though it is not the main laptop.
    expect(roles(await syncAs(B, all3({ gmail: ready(GMAIL2) })))['gmail:inbox']).toBe('active');
    expect((await leaders())['gmail:inbox']).toMatchObject({ device_id: B.id, account: GMAIL2 });
    // Cleared in Connections: the main laptop's inbox is the shop's again, and Sam takes Gmail back.
    await api('/api/settings/gmail', { method: 'PUT', body: { account: '' } });
    expect((await leaders())['gmail:inbox']).toMatchObject({ account: '', account_src: '' });
    expect(roles(await syncAs(A, all3()))['gmail:inbox']).toBe('active');
    expect((await leaders())['gmail:inbox']).toMatchObject({ device_id: A.id, account: GMAIL, account_src: 'main' });
    expect(roles(await syncAs(B, all3({ gmail: ready(GMAIL2) })))['gmail:inbox']).toBe('other_account');
  });

  it('the owner changes the shop account and the main laptop from the People panel; no laptop changes them back', async () => {
    // The shop uses Adrian's number now. Sam's laptop reports its own number: it never replaces the owner's choice.
    const put = await api('/api/lanes/whatsapp:inbox/account', { method: 'PUT', body: { account: `+${WA2}` } });
    expect(put.data).toMatchObject({ ok: true, account: WA2 });
    expect((await api('/api/lanes/whatsapp:inbox/account', { method: 'PUT', body: { account: 'nope' } })).status).toBe(400);
    expect((await api('/api/lanes/fax:inbox/account', { method: 'PUT', body: { account: '' } })).status).toBe(404);
    expect(roles(await syncAs(A, all3()))['whatsapp:inbox']).toBe('other_account');
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ account: WA2, account_src: 'owner' });
    const b = await syncAs(B, all3({ whatsapp: ready(WA2) }));
    expect(roles(b)['whatsapp:inbox']).toBe('active');
    const p = await people();
    expect(p.lanes.whatsapp).toMatchObject({ account: WA2, account_shown: `+${WA2}`, account_src: 'owner' });
    expect(deviceOf(p, 'Sam').channels.whatsapp.role).toBe('other_account');
    // "Use the main laptop's account": cleared, Sam's number is the shop's again and Sam answers at once.
    await api('/api/lanes/whatsapp:inbox/account', { method: 'PUT', body: { account: '' } });
    expect(roles(await syncAs(A, all3()))['whatsapp:inbox']).toBe('active');
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ account: WA, account_src: 'main', device_id: A.id });

    // Adrian's laptop becomes the main one: its number is the shop's now, and it answers WhatsApp.
    expect((await api('/api/people/main', { method: 'PUT', body: { device_id: 'dev_nope' } })).status).toBe(404);
    const made = await api('/api/people/main', { method: 'PUT', body: { device_id: B.id } });
    expect(made.data).toMatchObject({ ok: true, main: { device_id: B.id, label: 'Adrian’s laptop' } });
    expect((await people()).main.device_id).toBe(B.id);
    const b2 = await syncAs(B, all3({ whatsapp: ready(WA2) }));
    expect(roles(b2)['whatsapp:inbox']).toBe('active');
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ account: WA2, account_src: 'main', device_id: B.id });
    expect(roles(await syncAs(A, all3()))['whatsapp:inbox']).toBe('other_account');
    // And back: Sam's laptop is the main one again.
    await api('/api/people/main', { method: 'PUT', body: { device_id: A.id } });
    expect(roles(await syncAs(A, all3()))['whatsapp:inbox']).toBe('active');
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ account: WA, device_id: A.id });
    const ev = (await sql(`SELECT message FROM events WHERE type = 'main_laptop' ORDER BY id DESC LIMIT 1`)).data.results[0].message;
    expect(ev).toBe('Sam’s laptop is the main laptop now.');
  });

  it('an account the server cannot read stays out while the main laptop answers, and answers when nobody else does', async () => {
    await reset();
    // Adrian's laptop runs 0.5.2: it cannot say which WhatsApp number or TikTok account it is on.
    const unknown = all3({ whatsapp: ready(''), tiktok: ready('') });
    const b = await syncAs(B, unknown, { version: '0.5.2' });
    expect(roles(b)).toMatchObject({ 'whatsapp:inbox': 'unconfirmed', 'tiktok:inbox': 'unconfirmed', 'gmail:inbox': 'standby' });
    expect(deviceOf(await people(), 'Adrian').channels.whatsapp.role).toBe('unconfirmed');
    // Sam's laptop goes offline: nobody else answers WhatsApp or TikTok, so Adrian's laptop takes them over
    // rather than leave customers waiting (owner, 2026-11-25), and answers what it reads.
    await age(A.id, 5 * MIN);
    expect(roles(await syncAs(B, unknown, { version: '0.5.2' }))).toMatchObject({ 'whatsapp:inbox': 'active', 'tiktok:inbox': 'active', 'gmail:inbox': 'active' });
    expect((await leaders())['whatsapp:inbox'].device_id).toBe(B.id);
    const t = wa();
    const answered = await inboundAs(B, t, [{ external_id: 'u1', direction: 'in', body: 'hello?' }]);
    expect(answered).toMatchObject({ action: 'reply' });
    expect(answered.jobs).toHaveLength(1);
    for (const j of answered.jobs) await resultAs(B, j.id, { status: 'sent' });
    await reset();
  });
});

describe('point 5: a laptop on the shop’s account stands by, takes over only when needed, and hands back cleanly', () => {
  it('stands by and gets no jobs while the main laptop answers', async () => {
    await reset();
    const a = await syncAs(A, all3());
    expect(roles(a)).toEqual({ 'whatsapp:inbox': 'active', 'gmail:inbox': 'active', 'tiktok:inbox': 'active' });
    expect(a.data.lanes['whatsapp:inbox']).toMatchObject({ lease_ms: 60_000, solo: false, account: WA, leader: { device_id: A.id, person: 'Sam' } });
    // Adrian's laptop has been ready for a long time: it still only stands by.
    await since(B.id, 3600_000);
    const b = await syncAs(B, all3());
    expect(roles(b)).toEqual({ 'whatsapp:inbox': 'standby', 'gmail:inbox': 'standby', 'tiktok:inbox': 'standby' });
    expect(b.data.lanes['whatsapp:inbox']).toMatchObject({ lease_ms: 0, leader: { device_id: A.id, person: 'Sam' } });

    // A message the owner typed waits in the queue: only the laptop that answers WhatsApp gets it.
    const first = await inboundAs(A, wa(), [{ external_id: 'p1', direction: 'in', body: 'hello there' }]);
    expect(first.action).toBe('reply');
    expect(first.jobs).toHaveLength(1); // handed over inline: Sam's answers
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

  it('takes over within about a minute and a half when the main laptop goes offline', async () => {
    await sql(`DELETE FROM events WHERE type = 'failover'`);
    // Sam's laptop (0.6.0, not alone) holds a job when it goes quiet: it stops at the end of its lane lease,
    // so the job goes back to the queue for Adrian's after a short wait, no try used.
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
  });

  it('hands back once the main laptop has been ready 2 minutes: the other stands by at once, the main one answers 70 s later, never both', async () => {
    await sql(`DELETE FROM events WHERE type = 'failover'`);
    // Sam's laptop comes back. Just back, it stands by: it has to be ready for 2 minutes first.
    await age(A.id, 0);
    const a0 = await syncAs(A, all3());
    expect(roles(a0)).toEqual({ 'whatsapp:inbox': 'standby', 'gmail:inbox': 'standby', 'tiktok:inbox': 'standby' });
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ device_id: B.id, handover_at: 0 });
    // Adrian's laptop holds a job when the hand back starts.
    const held = await ownerJob('held while the lane goes back');
    expect(jobsOf(await syncAs(B, all3()))).toEqual([held]);
    // Ready for 2 minutes: Sam's laptop asks for its lanes back. It still waits, with no jobs.
    await since(A.id, 2 * MIN + 1000);
    const a1 = await syncAs(A, all3());
    expect(roles(a1)).toEqual({ 'whatsapp:inbox': 'standby', 'gmail:inbox': 'standby', 'tiktok:inbox': 'standby' });
    expect(jobsOf(a1)).toEqual([]);
    const asked = await leaders();
    for (const lane of ['whatsapp:inbox', 'gmail:inbox', 'tiktok:inbox']) {
      expect(asked[lane].device_id).toBe(B.id);
      expect(asked[lane].handover_at).toBeGreaterThan(Date.now() - 10_000);
    }
    expect(deviceOf(await people(), 'Adrian').channels.whatsapp.role).toBe('handing_back');
    // Adrian's laptop stands by the moment it hears it: no lease, no new jobs, and the grant names Sam's laptop.
    const later = await ownerJob('written during the hand back');
    const b1 = await syncAs(B, all3(), { results: [] });
    expect(roles(b1)).toEqual({ 'whatsapp:inbox': 'standby', 'gmail:inbox': 'standby', 'tiktok:inbox': 'standby' });
    for (const g of Object.values(b1.data.lanes as Record<string, any>)) expect(g.lease_ms).toBe(0);
    expect(b1.data.lanes['whatsapp:inbox'].leader).toMatchObject({ device_id: A.id, person: 'Sam' });
    expect(jobsOf(b1)).toEqual([]);
    // It hands back the job it held (0.6.0 does on standing by): nobody holds it, nobody gets it yet.
    expect((await resultAs(B, held, { status: 'failed', error_code: 'stood_down', error: 'Another laptop answers this channel now. Nothing was typed.', retryable: true })).data.status).toBe('pending');
    // A report Adrian's laptop posts meanwhile is kept, but no reply goes back with it.
    const t = wa();
    const d = await inboundAs(B, t, [{ external_id: 'h1', direction: 'in', body: 'still there?' }]);
    expect(d.conversation_id).toBeTruthy();
    expect(d.jobs).toEqual([]);
    // 30 s on: still nobody answers (the old lease may not be over).
    await sql(`UPDATE lane_leaders SET handover_at = ? WHERE handover_at > 0`, [Date.now() - 30_000]);
    expect(jobsOf(await syncAs(A, all3()))).toEqual([]);
    expect(jobsOf(await syncAs(B, all3()))).toEqual([]);
    const leasedNow = (await sql(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'leased'`)).data.results[0].n;
    expect(leasedNow).toBe(0);
    // 70 s on: Sam's laptop answers again and gets what waited.
    await sql(`UPDATE lane_leaders SET handover_at = ? WHERE handover_at > 0`, [Date.now() - 71_000]);
    const a2 = await syncAs(A, all3());
    expect(roles(a2)).toEqual({ 'whatsapp:inbox': 'active', 'gmail:inbox': 'active', 'tiktok:inbox': 'active' });
    expect(jobsOf(a2).sort()).toEqual(expect.arrayContaining([held, later]));
    const l = await leaders();
    expect(l['whatsapp:inbox']).toMatchObject({ device_id: A.id, reason: 'main_back', prev_device: B.id, handover_at: 0 });
    const ev = (await sql(`SELECT level, message FROM events WHERE type = 'failover' AND channel = 'whatsapp'`)).data.results;
    expect(ev).toEqual([{ level: 'good', message: 'Sam’s laptop took over WhatsApp. Adrian’s laptop handed it back.' }]);
    // Adrian's laptop is a standby again.
    const b2 = await syncAs(B, all3());
    expect(roles(b2)).toEqual({ 'whatsapp:inbox': 'standby', 'gmail:inbox': 'standby', 'tiktok:inbox': 'standby' });
    expect(b2.data.lanes['whatsapp:inbox'].leader).toMatchObject({ device_id: A.id });
    for (const j of a2.data.jobs) await resultAs(A, j.id, { status: 'sent' });
  });

  it('drops a hand back that is stuck, or one the main laptop cannot follow', async () => {
    // Adrian's laptop answers WhatsApp and was asked 5 minutes ago, but Sam's laptop never came for it.
    await sql(`UPDATE lane_leaders SET device_id = ?, handover_at = ? WHERE lane = 'whatsapp:inbox'`, [B.id, Date.now() - 5 * MIN]);
    expect(roles(await syncAs(B, all3()))['whatsapp:inbox']).toBe('active');
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ device_id: B.id, handover_at: 0 });
    // Sam's laptop asks again, then its WhatsApp starts loading: the ask is dropped and Adrian's carries on.
    await since(A.id, 3 * MIN);
    await syncAs(A, all3());
    expect((await leaders())['whatsapp:inbox'].handover_at).toBeGreaterThan(0);
    await syncAs(A, all3({ whatsapp: ready(WA, { state: 'loading' }) }));
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ device_id: B.id, handover_at: 0 });
    expect(roles(await syncAs(B, all3()))['whatsapp:inbox']).toBe('active');
    await reset();
  });

  it('the lease of the one that answers always ends before a standby may take over', async () => {
    // Sam's laptop answers. Its row was written 50 s ago and nothing changed: its lease ends 10 s before 90 s.
    await age(A.id, 50_000);
    const a = await syncAs(A, all3());
    const lease = a.data.lanes['whatsapp:inbox'].lease_ms;
    expect(lease).toBeGreaterThan(20_000);
    expect(lease).toBeLessThanOrEqual(30_000 + 1000);
  });

  it('takes over when the channel stops working on the main laptop, and at once when it is signed out', async () => {
    await sql(`DELETE FROM events WHERE type = 'failover'`);
    await age(A.id, 0);
    // Sam's WhatsApp starts loading: kept for now.
    await syncAs(A, all3({ whatsapp: ready(WA, { state: 'loading' }) }));
    expect(roles(await syncAs(B, all3()))['whatsapp:inbox']).toBe('standby');
    // Still not ready 45 s later: Adrian's laptop takes it.
    await sql(`UPDATE devices SET status = json_set(status, '$.channels.whatsapp.state_since', ?) WHERE id = ?`, [Date.now() - 50_000, A.id]);
    const b = await syncAs(B, all3());
    expect(roles(b)['whatsapp:inbox']).toBe('active');
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ device_id: B.id, reason: 'not_working' });
    expect((await sql(`SELECT message FROM events WHERE type = 'failover'`)).data.results[0].message).toBe('Adrian’s laptop took over WhatsApp. WhatsApp stopped working on Sam’s laptop.');

    // Gmail signed out on Sam's laptop (which still answers it): given up at once, and Adrian's answers it on its next sync.
    const a = await syncAs(A, all3({ whatsapp: ready(WA, { state: 'loading' }), gmail: { state: 'logged_out', account: '' } }));
    expect(roles(a)['gmail:inbox']).toBe('standby');
    expect((await leaders())['gmail:inbox']).toMatchObject({ device_id: '', reason: 'logged_out', prev_device: A.id });
    expect(roles(await syncAs(B, all3()))['gmail:inbox']).toBe('active');
    const msg = (await sql(`SELECT message FROM events WHERE type = 'failover' AND channel = 'gmail'`)).data.results[0].message;
    expect(msg).toBe('Adrian’s laptop took over Gmail. Gmail is signed out on Sam’s laptop.');
    await reset();
  });

  it('a paused laptop gives its lanes up, and the jobs it held go to the next one at once (not the one it is typing)', async () => {
    // Sam's laptop answers TikTok. A TikTok job waits for it: it is leased, then Sam's is paused on the laptop.
    expect((await leaders())['tiktok:inbox'].device_id).toBe(A.id);
    const now = Date.now();
    const ins = (id: string) => sql(`INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, not_before, attempts, pacing, created_at)
      VALUES (?, 'tiktok', 'reply', NULL, '{}', '["hi"]', 'pending', 'manual', 0, 0, '{}', ?)`, [id, now]);
    const [j1, j2] = [unique('ob_tt'), unique('ob_tt')];
    await ins(j1); await ins(j2);
    const got = jobsOf(await syncAs(A, all3()));
    expect(got.sort()).toEqual([j1, j2].sort());
    // Paused while it types j2: j2 stays with it (it finishes it), j1 goes back now, no try used.
    const a = await syncAs(A, all3({ tiktok: ready(TIKTOK, { sending: true, sending_id: j2 }) }), { paused: true });
    expect(roles(a)['tiktok:inbox']).toBe('standby');
    expect(await job(j1)).toMatchObject({ status: 'pending', lease_device: null, attempts: 0 });
    expect((await job(j1)).not_before).toBeLessThanOrEqual(Date.now());
    expect(await job(j2)).toMatchObject({ status: 'leased', lease_device: A.id });
    // Adrian's takes TikTok on its next sync. Two laptops never type in one channel at once, so j1 waits only
    // until Sam's has finished j2, not until its lease would have run out (3 minutes and more).
    const b = await syncAs(B, all3());
    expect(roles(b)['tiktok:inbox']).toBe('active');
    expect((await leaders())['tiktok:inbox'].device_id).toBe(B.id);
    expect(jobsOf(b)).toEqual([]);
    await resultAs(A, j2, { status: 'sent' });
    expect(jobsOf(await syncAs(B, all3()))).toEqual([j1]);
    await resultAs(B, j1, { status: 'sent' });
    await reset();
  });
});

describe('the main laptop is one that checks in, and pairing order never moves the shop’s accounts', () => {
  const OLD = 'dev_old_row';
  const created = async (id: string) => (await sql('SELECT created_at FROM devices WHERE id = ?', [id])).data.results[0].created_at as number;

  it('an old row left paired (never disconnected, not seen for days) is never the main laptop', async () => {
    await reset();
    // Sam paired again without pressing Disconnect: the old row is still paired, older than both laptops, and
    // still named on WhatsApp and TikTok. Sam's laptop runs 0.5.2 (it reads no number or handle) and the owner
    // never chose a main laptop.
    await sql(`INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, person) VALUES (?, 'Old MacBook', ?, 1, ?, 'Sam')`, [OLD, unique('old_hash'), Date.now() - 3 * 24 * 3600_000]);
    await sql(`DELETE FROM settings WHERE key = 'state:main_device'`);
    await sql(`UPDATE lane_leaders SET device_id = ?, account = '', account_src = '' WHERE lane IN ('whatsapp:inbox', 'tiktok:inbox')`, [OLD]);
    await sql(`INSERT INTO settings (key, value, updated_at) VALUES ('state:offline_alerted', ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(OLD)]);
    await age(B.id, 2 * 24 * 3600_000);
    try {
      expect((await people()).main.device_id).toBe(A.id);
      const unknown = all3({ whatsapp: ready(''), tiktok: ready('') });
      const a = await syncAs(A, unknown, { version: '0.5.2' });
      expect(roles(a)).toEqual({ 'whatsapp:inbox': 'active', 'gmail:inbox': 'active', 'tiktok:inbox': 'active' });
      expect((await leaders())['whatsapp:inbox']).toMatchObject({ device_id: A.id, reason: 'offline', prev_device: OLD });
      // Its WhatsApp reports are stored and answered, as before the second laptop.
      const t = wa();
      const d = await inboundAs(A, t, [{ external_id: 'm1', direction: 'in', body: 'hi is this the ebike shop' }]);
      expect(d).toMatchObject({ action: 'reply', final: true });
      expect(d.jobs).toHaveLength(1);
      await resultAs(A, d.jobs[0].id, { status: 'sent' });
      // The offline alert about the old row is over: nobody waits on it.
      await api('/api/test/cron', { as: 'public', body: {} });
      expect(JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'state:offline_alerted'`)).data.results[0].value)).toBe(false);

      // The owner makes the old row the main laptop (it is offline). Sam's laptop cannot show its number, but
      // nobody else answers WhatsApp, so it keeps answering: customers are never left waiting (owner, 2026-11-25).
      await api('/api/people/main', { method: 'PUT', body: { device_id: OLD } });
      expect(roles(await syncAs(A, unknown, { version: '0.5.2' }))['whatsapp:inbox']).toBe('active');
      const t2 = wa();
      const kept = await inboundAs(A, t2, [{ external_id: 'm2', direction: 'in', body: 'hello? do you have the 750w in stock' }]);
      expect(kept).toMatchObject({ action: 'reply', final: true });
      expect(kept.jobs).toHaveLength(1);
      for (const j of kept.jobs) await resultAs(A, j.id, { status: 'sent' });
      await api('/api/people/main', { method: 'PUT', body: { device_id: A.id } });
    } finally {
      await sql('DELETE FROM devices WHERE id = ?', [OLD]);
      await api('/api/people/main', { method: 'PUT', body: { device_id: A.id } });
      await sql(`DELETE FROM settings WHERE key = 'state:offline_alerted'`);
    }
    await reset();
  });

  it('a laptop that is main only because it is the oldest one never replaces the shop’s number; the owner’s choice does', async () => {
    await reset();
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ account: WA, account_src: 'main' });
    // Sam pressed Disconnect and paired again: Sam's row is now newer than Adrian's, and the owner chose no main laptop.
    const samCreated = await created(A.id);
    await sql(`DELETE FROM settings WHERE key = 'state:main_device'`);
    await sql('UPDATE devices SET created_at = ? WHERE id = ?', [(await created(B.id)) + 1000, A.id]);
    try {
      expect((await people()).main.device_id).toBe(B.id);
      // Adrian's laptop on his own number and handle: they never become the shop's, and it stays out.
      const b = await syncAs(B, all3({ whatsapp: ready(WA2), tiktok: ready(TIKTOK2) }));
      expect(roles(b)).toMatchObject({ 'whatsapp:inbox': 'other_account', 'tiktok:inbox': 'other_account', 'gmail:inbox': 'standby' });
      const l = await leaders();
      expect(l['whatsapp:inbox']).toMatchObject({ account: WA, account_src: 'main', device_id: A.id });
      expect(l['tiktok:inbox']).toMatchObject({ account: TIKTOK, device_id: A.id });
      // Sam's laptop answers WhatsApp and TikTok. (Adrian's is on the shop's Gmail, so as the main laptop it asks for Gmail back.)
      expect(roles(await syncAs(A, all3()))).toMatchObject({ 'whatsapp:inbox': 'active', 'tiktok:inbox': 'active' });
      // A lane that knows no account yet takes the account of that laptop all the same (the first one known).
      await sql(`UPDATE lane_leaders SET account = '', account_src = '', device_id = '' WHERE lane = 'tiktok:inbox'`);
      await syncAs(B, all3({ whatsapp: ready(WA2), tiktok: ready(TIKTOK2) }));
      expect((await leaders())['tiktok:inbox']).toMatchObject({ account: TIKTOK2, account_src: 'main' });
      // The owner makes Adrian's laptop the main one: now its number is the shop's.
      await api('/api/people/main', { method: 'PUT', body: { device_id: B.id } });
      await syncAs(B, all3({ whatsapp: ready(WA2), tiktok: ready(TIKTOK2) }));
      expect((await leaders())['whatsapp:inbox']).toMatchObject({ account: WA2, account_src: 'main' });
    } finally {
      await sql('UPDATE devices SET created_at = ? WHERE id = ?', [samCreated, A.id]);
      await api('/api/people/main', { method: 'PUT', body: { device_id: A.id } });
      await sql('DELETE FROM lane_leaders');
    }
    await reset();
  });

  it('accounts learned before 0014 from whichever laptop answered are forgotten, the owner’s and the main laptop’s kept', async () => {
    // migrations/0015: run its statements on rows as 10837a0 left them.
    const text = readFileSync(new URL('../../migrations/0015_unvouched_accounts.sql', import.meta.url), 'utf8');
    const statements = text.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    const seed = async (rows: [string, string, string][]) => {
      await sql('DELETE FROM lane_leaders');
      for (const [lane, account, src] of rows) await sql(`INSERT INTO lane_leaders (lane, account, account_src, device_id, epoch, since, reason, prev_device) VALUES (?, ?, ?, '', 1, 0, 'claim', '')`, [lane, account, src]);
    };
    const run = async () => { for (const st of statements) await sql(st); };
    // Adrian's laptop took TikTok and WhatsApp over under 10837a0 and the lanes learned his accounts.
    await seed([['whatsapp:inbox', WA2, ''], ['tiktok:inbox', TIKTOK2, ''], ['gmail:inbox', GMAIL2, '']]);
    await run();
    let l = await leaders();
    for (const lane of ['whatsapp:inbox', 'tiktok:inbox', 'gmail:inbox']) expect(l[lane].account).toBe('');
    // What the main laptop reported, or the owner set, is kept. So is a Gmail row while Connections names an inbox.
    await seed([['whatsapp:inbox', WA, 'main'], ['tiktok:inbox', TIKTOK, 'owner'], ['gmail:inbox', GMAIL, '']]);
    await api('/api/settings/gmail', { method: 'PUT', body: { account: GMAIL } });
    await sql(`UPDATE lane_leaders SET account_src = '' WHERE lane = 'gmail:inbox'`);
    await run();
    l = await leaders();
    expect(l['whatsapp:inbox'].account).toBe(WA);
    expect(l['tiktok:inbox'].account).toBe(TIKTOK);
    expect(l['gmail:inbox'].account).toBe(GMAIL);
    await api('/api/settings/gmail', { method: 'PUT', body: { account: '' } });
    // The People panel offers "Use the main laptop's account" for any account the main laptop did not report.
    await sql(`UPDATE lane_leaders SET account = ?, account_src = '' WHERE lane = 'whatsapp:inbox'`, [WA2]);
    expect((await people()).lanes.whatsapp).toMatchObject({ account: WA2, account_src: '' });
    await api('/api/lanes/whatsapp:inbox/account', { method: 'PUT', body: { account: '' } });
    await syncAs(A, all3());
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ account: WA, account_src: 'main' });
    await reset();
  });
});

describe('the main laptop on another account, with no laptop on the shop’s account online, is a channel down', () => {
  it('Gmail on a personal inbox is told to the owner after 10 minutes, and counts on Live and Health', async () => {
    await reset();
    await sql(`DELETE FROM settings WHERE key IN ('state:monitor', 'state:alert_last:channel')`);
    await sql(`DELETE FROM events WHERE type IN ('channel_down', 'channel_ok')`);
    await api('/api/settings/gmail', { method: 'PUT', body: { account: GMAIL } });
    try {
      // Sam's 0.5.2 Gmail tab is on a personal inbox (it says so in its status words). Adrian's is on his own too.
      const personal = { state: 'blocked', detail: `This tab shows ${GMAIL2}. Switch it to ${GMAIL}`, unread: 0, busy: false, sending: false, sending_id: null };
      const a = await syncAs(A, all3({ gmail: personal }), { version: '0.5.2' });
      expect(roles(a)['gmail:inbox']).toBe('other_account');
      await syncAs(B, other3());
      await api('/api/test/cron', { as: 'public', body: {} });
      const mon = () => sql(`SELECT value FROM settings WHERE key = 'state:monitor'`).then((r) => JSON.parse(r.data.results[0]?.value ?? '{}'));
      expect((await mon()).channels.gmail).toMatchObject({ alerted: false });
      expect((await mon()).channels.gmail.reason).toContain(`This tab shows ${GMAIL2}`);
      // 10 minutes on: the owner is told, as with a blocked tab before.
      const m = await mon();
      m.channels.gmail.since = Date.now() - 11 * MIN;
      await sql(`UPDATE settings SET value = ? WHERE key = 'state:monitor'`, [JSON.stringify(m)]);
      await api('/api/test/cron', { as: 'public', body: {} });
      const ev = (await sql(`SELECT message FROM events WHERE type = 'channel_down' AND channel = 'gmail'`)).data.results;
      expect(ev).toHaveLength(1);
      expect(ev[0].message).toMatch(/^Gmail stopped working\./);
      // Live and Health show it on Sam's laptop as a problem.
      await bust();
      const ov = (await api('/api/overview')).data;
      expect(ov.lanes.gmail).toMatchObject({ role: 'other_account', device: { id: A.id } });
      // Adrian's laptop on the shop's inbox comes online: it answers Gmail, and that is what counts.
      const b = await syncAs(B, other3({ gmail: ready(GMAIL) }));
      expect(roles(b)['gmail:inbox']).toBe('active');
      await api('/api/test/cron', { as: 'public', body: {} });
      expect((await mon()).channels.gmail).toBeUndefined();
    } finally {
      await api('/api/settings/gmail', { method: 'PUT', body: { account: '' } });
      await sql(`DELETE FROM settings WHERE key IN ('state:monitor', 'state:alert_last:channel')`);
      await sql(`DELETE FROM events WHERE type IN ('channel_down', 'channel_ok')`);
    }
    await reset();
  });
});

describe('a hand back the main laptop cannot finish', () => {
  it('the main laptop asks, then its lid is closed: the one answering carries on 90 s later, not 4 minutes', async () => {
    await reset();
    await age(A.id, 95_000);
    expect(roles(await syncAs(B, all3()))['whatsapp:inbox']).toBe('active');
    // Sam's laptop is back and ready for 2 minutes: it asks for its lanes back, and Adrian's stands by.
    await age(A.id, 0);
    await syncAs(A, all3());
    await since(A.id, 3 * MIN);
    await syncAs(A, all3());
    expect((await leaders())['whatsapp:inbox'].handover_at).toBeGreaterThan(0);
    expect(roles(await syncAs(B, all3()))['whatsapp:inbox']).toBe('standby');
    // Then Sam's laptop goes quiet before it takes them. 60 s: Adrian's still waits.
    await age(A.id, 60_000);
    expect(roles(await syncAs(B, all3()))['whatsapp:inbox']).toBe('standby');
    // 95 s: the ask is dropped and Adrian's answers again, with a lease.
    await age(A.id, 95_000);
    const b = await syncAs(B, all3());
    expect(roles(b)).toEqual({ 'whatsapp:inbox': 'active', 'gmail:inbox': 'active', 'tiktok:inbox': 'active' });
    expect(b.data.lanes['whatsapp:inbox'].lease_ms).toBeGreaterThan(0);
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ device_id: B.id, handover_at: 0 });
    // Sam's laptop is back: just back, it waits its 2 minutes again, and never answers alongside Adrian's.
    await age(A.id, 0);
    expect(roles(await syncAs(A, all3()))['whatsapp:inbox']).toBe('standby');
    await reset();
  });
});

describe('alone on a lane', () => {
  it('Adrian’s laptop on his own accounts does not stop Sam’s from working while the server is away', async () => {
    await reset();
    await syncAs(B, other3());
    const a = await syncAs(A, all3());
    for (const lane of ['whatsapp:inbox', 'gmail:inbox', 'tiktok:inbox']) expect(a.data.lanes[lane].solo).toBe(true);
    expect(Object.values(await leaders()).every((r: any) => r.solo === 1)).toBe(true);
    // Adrian's laptop on the shop's WhatsApp could stand in there: not alone on WhatsApp, still alone on the others.
    await syncAs(B, other3({ whatsapp: ready(WA) }));
    const a2 = await syncAs(A, all3());
    expect(a2.data.lanes['whatsapp:inbox'].solo).toBe(false);
    expect(a2.data.lanes['tiktok:inbox'].solo).toBe(true);
    await reset();
    expect((await syncAs(A, all3())).data.lanes['whatsapp:inbox'].solo).toBe(false);
  });
});

describe('an older Gmail build that says more than its address', () => {
  it('two Gmail tabs open: its inbox is still read, so it stands by on the shop’s Gmail', async () => {
    await reset();
    const two = { state: 'ready', detail: `${GMAIL}. 2 Gmail tabs are open. The agent only uses the first one`, unread: 0, busy: false, sending: false, sending_id: null };
    const b = await syncAs(B, all3({ gmail: two }), { version: '0.5.2' });
    expect(roles(b)['gmail:inbox']).toBe('standby');
    expect(deviceOf(await people(), 'Adrian').channels.gmail).toMatchObject({ account: GMAIL, role: 'standby' });
    await reset();
  });
});

describe('switching the agent on is not a stall', () => {
  it('a laptop whose page read nothing while the agent was off keeps its lanes when it is switched on', async () => {
    await sql(`DELETE FROM events WHERE type = 'failover'`);
    expect((await leaders())['whatsapp:inbox'].device_id).toBe(A.id);
    await api('/api/agent-toggle', { body: { enabled: false } });
    // Off for an hour: Sam's tabs are fine but nothing was read, and its lanes do not work (no active_ms).
    const old = { last_ok_at: Date.now() - 3600_000, ok_age_ms: 3600_000 };
    await syncAs(A, all3({ whatsapp: ready(WA, old), gmail: ready(GMAIL, old), tiktok: ready(TIKTOK, old) }));
    await sql('UPDATE lane_leaders SET since = ?', [Date.now() - 2 * 3600_000]);
    await api('/api/agent-toggle', { body: { enabled: true } });
    // Adrian's syncs first, before Sam's had a chance to read: no takeover, no alert.
    expect(roles(await syncAs(B, all3()))).toEqual({ 'whatsapp:inbox': 'standby', 'gmail:inbox': 'standby', 'tiktok:inbox': 'standby' });
    // Sam's lanes start (it says for how long); its first scan is still to come. Still no takeover.
    await syncAs(A, all3({ whatsapp: ready(WA, { ...old, active_ms: 2000 }), gmail: ready(GMAIL, { ...old, active_ms: 2000 }), tiktok: ready(TIKTOK, { ...old, active_ms: 2000 }) }));
    expect(roles(await syncAs(B, all3()))['whatsapp:inbox']).toBe('standby');
    expect((await sql(`SELECT COUNT(*) AS n FROM events WHERE type = 'failover'`)).data.results[0].n).toBe(0);
    // Working for 4 minutes and still nothing read: that is a stall, and Adrian's takes WhatsApp over.
    await sql(`UPDATE devices SET status = json_set(status, '$.channels.whatsapp.active_since', ?) WHERE id = ?`, [Date.now() - 4 * MIN, A.id]);
    expect(roles(await syncAs(B, all3()))['whatsapp:inbox']).toBe('active');
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ device_id: B.id, reason: 'stalled' });
    await reset();
  });
});

describe('the jobs a laptop held move only when it cannot send them', () => {
  it('an older build that went offline keeps its jobs until their lease is over; a 0.6.0 laptop answers', async () => {
    // Sam's runs 0.5.2 and answers WhatsApp. It holds a job, then goes quiet (it may still be typing it).
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

    // Once it may go, Adrian's gets it and types it. The old laptop comes back and hands it back late: Adrian's keeps it.
    await sql('UPDATE outbox SET not_before = ? WHERE id = ?', [Date.now() - 1, j]);
    expect(jobsOf(await syncAs(B, all3()))).toEqual([j]);
    expect((await resultAs(A, j, { status: 'failed', error_code: 'stood_down', error: 'Nothing was typed', retryable: true })).data.status).toBe('leased');
    expect((await resultAs(A, j, { status: 'failed', error_code: 'timeout', error: 'slow', retryable: true })).data.status).toBe('leased');
    expect(await job(j)).toMatchObject({ status: 'leased', lease_device: B.id });
    expect(jobsOf(await syncAs(B, all3()))).toEqual([]); // not offered to Adrian's a second time
    await resultAs(B, j, { status: 'sent' });
    await age(A.id, 0);
    await syncAs(A, all3());
  });

  it('a laptop told it was the only one keeps its jobs until their lease is over too', async () => {
    // Adrian's answers WhatsApp now. Sam's has not been seen for two days: Adrian's is alone, and the lane row says so.
    await age(A.id, 2 * 24 * 3600_000);
    const b = await syncAs(B, all3());
    expect(b.data.lanes['whatsapp:inbox'].solo).toBe(true);
    expect((await leaders())['whatsapp:inbox']).toMatchObject({ device_id: B.id, solo: 1 });
    const j = await ownerJob('held by a laptop that thinks it is alone');
    expect(jobsOf(await syncAs(B, all3()))).toEqual([j]);
    const leaseUntil = (await job(j)).lease_until;
    // Sam's comes back while Adrian's cannot reach the server (Adrian's keeps working, as the only laptop does).
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
    // Sam's runs 0.5.2 and answers WhatsApp with a job leased. Its WhatsApp then breaks for over 45 s.
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
    // Nothing else of WhatsApp is held up meanwhile: a new job goes to Adrian's at once.
    const next = await ownerJob('new job for the laptop that answers now');
    expect(jobsOf(await syncAs(B, all3()))).toEqual([next]);
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE id IN (?, ?)`, [j, next]);
    await reset();
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

  it('old and removed laptops cost nothing: a sync, a report, a diagnostic and the dashboard read only live rows', async () => {
    const before = await syncAs(A, all3());
    // A report first, so the knowledge is loaded as in a live isolate (a health check run by an earlier test may have changed it).
    await inboundAs(A, wa(), [{ external_id: 'c0', direction: 'in', body: 'ignore-me' }]);
    // Only the dashboard answers are dropped (the knowledge stays loaded, as in a live isolate).
    const dashOnly = () => api('/api/test/bust', { as: 'public', body: { scope: 'dashboard' } });
    await dashOnly();
    const ovBefore = await api('/api/overview');
    // 300 laptops removed long ago and 60 never seen for days (paired again under a new name, say).
    await sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 300)
      INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, revoked_at) SELECT 'dev_gone_' || i, 'Gone', 'gone_' || i, 1, ?, ? FROM n`, [Date.now() - 9 * 24 * 3600_000, Date.now() - 8 * 24 * 3600_000]);
    await sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 60)
      INSERT INTO devices (id, name, token_hash, created_at, last_seen_at) SELECT 'dev_old_' || i, 'Old', 'old_' || i, 1, ? FROM n`, [Date.now() - 3 * 24 * 3600_000]);
    try {
      const a = await syncAs(A, all3());
      expect(a.status).toBe(200);
      expect(a.rows).toBeLessThanOrEqual(before.rows + 2);
      // Laptops not seen for a day do not count: with Adrian's gone quiet too, Sam's is the only one and keeps working offline.
      expect(a.data.lanes['whatsapp:inbox'].solo).toBe(false);
      await age(B.id, 2 * 24 * 3600_000);
      expect((await syncAs(A, all3())).data.lanes['whatsapp:inbox'].solo).toBe(true);
      await age(B.id, 0);
      const d = await api('/api/agent/diagnostics', { as: 'public', headers: { authorization: `Bearer ${A.token}` }, body: { kind: 'note', channel: 'whatsapp', data: { x: 1 } } });
      expect(d.status).toBe(200);
      expect(d.rows).toBeLessThanOrEqual(10);
      // A report reads one leader row and the main laptop more than before, never the laptop list.
      const r = await inboundAs(A, wa(), [{ external_id: 'c1', direction: 'in', body: 'ignore-me' }]);
      expect(r.rows).toBeLessThan(80);
      // Live lists the newest laptops and the main one, never every laptop ever paired.
      await dashOnly();
      const ov = await api('/api/overview');
      // (five laptops instead of two, and the new chat in today's numbers: a few rows, not the 360 laptops)
      expect(ov.rows).toBeLessThanOrEqual(ovBefore.rows + 40);
      const cronRes = await api('/api/test/cron', { as: 'public', body: {} });
      expect(cronRes.status).toBe(200);
    } finally {
      await sql(`DELETE FROM devices WHERE id LIKE 'dev_gone_%' OR id LIKE 'dev_old_%'`);
    }
    await syncAs(A, all3());
  });

  it('the support report shows the people, the main laptop and who answers each lane, with accounts masked', async () => {
    // An older Gmail build on Adrian's laptop names its inbox in its status words: masked too.
    await syncAs(B, all3({ gmail: { state: 'blocked', detail: `This tab shows ${GMAIL2}. Switch it to ${GMAIL}` } }), { version: '0.5.2' });
    const link = await api('/api/support/link', { body: {} });
    const token = String(link.data.url).split('/').pop();
    const report = await api(`/api/support/report/${token}`, { as: 'public' });
    expect(report.status).toBe(200);
    const text = JSON.stringify(report.data);
    expect(text).not.toContain(WA);
    expect(text).not.toContain(GMAIL);
    expect(text).not.toContain(GMAIL2);
    expect(report.data.lane_leaders.map((l: any) => l.lane)).toEqual(['whatsapp:inbox', 'gmail:inbox', 'tiktok:inbox']);
    expect(report.data.lane_leaders[0]).toMatchObject({ account: '…0123', account_src: 'main' });
    const p = report.data.people.map((x: any) => x.person);
    expect(p).toEqual(expect.arrayContaining(['Sam', 'Adrian']));
    expect(report.data.people.find((x: any) => x.person === 'Sam').main).toBe(true);
    expect(report.data.people.find((x: any) => x.person === 'Adrian').lanes['whatsapp:inbox'].account).toBe('…0123');
    await api('/api/support/link', { method: 'DELETE' });
    await syncAs(B, all3());
  });
});

describe('disconnecting a laptop', () => {
  it('removes it at once: its lanes are free, its jobs go to the next laptop, and its token stops working', async () => {
    // Adrian's answers TikTok and holds a job there.
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
    // Sam's claims TikTok on its next sync, and the owner is told why.
    expect(roles(await syncAs(A, all3()))['tiktok:inbox']).toBe('active');
    const msg = (await sql(`SELECT message FROM events WHERE type = 'failover' AND channel = 'tiktok' ORDER BY id DESC LIMIT 1`)).data.results[0].message;
    expect(msg).toBe('Sam’s laptop took over TikTok. Adrian’s laptop was removed.');
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE id = ?`, [j]);
    expect((await people()).people.map((x: any) => x.name)).not.toContain('Adrian');
  });
});
