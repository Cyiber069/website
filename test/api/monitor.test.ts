// Monitoring: channel health from the extension, the every minute check that alerts the owner,
// the D1 usage meter and the AI failing alert.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, cron, inbound, sql, unique } from '../helpers/client';

const MIN = 60_000;
const CHANNELS = ['whatsapp', 'gmail', 'tiktok'];

/** Sync as the extension does, with per channel health fields. */
const syncWith = (per: Record<string, Record<string, unknown>> = {}) =>
  api('/api/agent/sync', {
    as: 'device',
    body: {
      version: 'test',
      status: { channels: Object.fromEntries(CHANNELS.map((c) => [c, { state: 'ready', unread: 0, busy: false, last_ok_at: Date.now(), last_scan_at: Date.now(), last_error: '', recoveries: 0, version: '0.3.0', ...(per[c] ?? {}) }])) },
    },
  });

const eventsOf = async (type: string) => (await sql('SELECT * FROM events WHERE type = ? ORDER BY id DESC', [type])).data.results;

// A local push service, so an alert that really went out can be counted by its topic (the alert kind).
const pushes: { topic: string }[] = [];
let server: ReturnType<typeof createServer>;
const pushed = (topic: string) => pushes.filter((p) => p.topic === topic).length;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    req.on('data', () => {});
    req.on('end', () => { pushes.push({ topic: String(req.headers.topic ?? '') }); res.statusCode = 201; res.end(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/push/monitor`;
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
  const auth = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  await sql('DELETE FROM push_subscriptions');
  expect((await api('/api/push/subscribe', { body: { endpoint, keys: { p256dh, auth } } })).status).toBe(200);
  await sql(`DELETE FROM settings WHERE key IN ('state:monitor', 'state:alert_last:channel', 'state:alert_last:ai', 'state:alert_last:stuck')`);
});

afterAll(async () => {
  await syncWith();
  await sql('DELETE FROM push_subscriptions');
  await sql(`DELETE FROM settings WHERE key IN ('state:monitor', 'state:d1_usage')`);
  await new Promise<void>((r) => server.close(() => r()));
});

describe('channel health from the extension', () => {
  it('keeps the new fields, clamped and clipped, and ignores junk', async () => {
    const future = Date.now() + 10 * 24 * 60 * MIN;
    const res = await syncWith({
      whatsapp: { last_ok_at: Date.now() - 2 * MIN, last_scan_at: future, last_error: `  Chat list\n not found ${'x'.repeat(400)}`, recoveries: 3.6, version: 'v'.repeat(50) },
      gmail: { last_ok_at: 'yesterday', last_scan_at: -5, last_error: 42, recoveries: -9, version: null },
      tiktok: { recoveries: 1e12, last_ok_at: Number.NaN },
    });
    expect(res.status).toBe(200);
    const ov = (await api('/api/overview')).data;
    const ch = ov.device.status.channels;
    expect(ch.whatsapp.last_ok_at).toBeGreaterThan(Date.now() - 3 * MIN);
    expect(ch.whatsapp.last_scan_at).toBeLessThanOrEqual(Date.now()); // a time in the future is clamped to now
    expect(ch.whatsapp.last_error.startsWith('Chat list not found')).toBe(true);
    expect(ch.whatsapp.last_error.length).toBe(160);
    expect(ch.whatsapp.recoveries).toBe(4);
    expect(ch.whatsapp.version).toHaveLength(20);
    expect(ch.gmail).toMatchObject({ last_ok_at: 0, last_scan_at: 0, last_error: '', recoveries: 0, version: '' });
    expect(ch.tiktok.recoveries).toBe(100_000);
    expect(ch.tiktok.last_ok_at).toBe(0);
    // Health has the same device status and the monitor's view.
    const health = (await api('/api/health')).data;
    expect(health.devices[0].status.channels.whatsapp.recoveries).toBe(4);
    expect(health.monitor).toMatchObject({ ai_failing: false });
  });

  it('writes the device row only when something changed, but at least once a minute', async () => {
    await syncWith();
    const before = (await sql('SELECT last_seen_at, status FROM devices WHERE revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 1')).data.results[0];
    await new Promise((r) => setTimeout(r, 30));
    await syncWith(); // only the scan times moved: no write
    const same = (await sql('SELECT last_seen_at FROM devices WHERE revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 1')).data.results[0];
    expect(same.last_seen_at).toBe(before.last_seen_at);
    await syncWith({ whatsapp: { unread: 2 } }); // something the owner sees changed: written
    const changed = (await sql('SELECT last_seen_at, status FROM devices WHERE revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 1')).data.results[0];
    expect(changed.last_seen_at).toBeGreaterThan(before.last_seen_at);
    expect(JSON.parse(changed.status).channels.whatsapp.unread).toBe(2);
    await sql('UPDATE devices SET last_seen_at = ? WHERE revoked_at IS NULL', [Date.now() - 56_000]);
    await syncWith({ whatsapp: { unread: 2 } }); // nothing changed, but a minute passed: written
    const later = (await sql('SELECT last_seen_at FROM devices WHERE revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 1')).data.results[0];
    expect(Date.now() - later.last_seen_at).toBeLessThan(10_000);
  });
});

describe('every minute check', () => {
  it('alerts once when a channel has not read its page for 10 minutes, then says back to normal', async () => {
    const pushesBefore = pushed('channel');
    await syncWith({ whatsapp: { last_ok_at: Date.now() - 12 * MIN, last_error: 'Chat list not found' } });
    await cron();
    const down = await eventsOf('channel_down');
    expect(down).toHaveLength(1);
    expect(down[0].channel).toBe('whatsapp');
    expect(down[0].message).toContain('Chat list not found');
    expect(down[0].message).not.toMatch(/[–—]/);
    expect(pushed('channel')).toBe(pushesBefore + 1);

    // The dashboard shows it, and the card goes red with the reason.
    const ov = (await api('/api/overview')).data;
    expect(ov.monitor.channels.whatsapp.reason).toContain('Chat list not found');
    expect(ov.monitor.channels.gmail).toBeUndefined();

    // Still broken a minute later: no second alert.
    await cron();
    expect(await eventsOf('channel_down')).toHaveLength(1);
    expect(pushed('channel')).toBe(pushesBefore + 1);

    // Fixed: one good line in the feed, and the problem is gone.
    await syncWith();
    await cron();
    const ok = await eventsOf('channel_ok');
    expect(ok).toHaveLength(1);
    expect(ok[0].message).toContain('back to normal');
    expect((await api('/api/overview')).data.monitor.channels.whatsapp).toBeUndefined();
  });

  it('alerts when a channel is signed out for 10 minutes, not at once', async () => {
    await sql(`DELETE FROM settings WHERE key = 'state:alert_last:channel'`);
    await syncWith({ gmail: { state: 'logged_out', last_ok_at: Date.now() - MIN } });
    await cron();
    expect((await eventsOf('channel_down')).filter((e: any) => e.channel === 'gmail')).toHaveLength(0);
    // Ten minutes later (the check remembers when it first saw it).
    const m = (await sql(`SELECT value FROM settings WHERE key = 'state:monitor'`)).data.results[0];
    const state = JSON.parse(m.value);
    state.channels.gmail.since = Date.now() - 11 * MIN;
    await sql(`UPDATE settings SET value = ? WHERE key = 'state:monitor'`, [JSON.stringify(state)]);
    await cron();
    const down = (await eventsOf('channel_down')).filter((e: any) => e.channel === 'gmail');
    expect(down).toHaveLength(1);
    expect(down[0].message).toContain('signed out');
    await syncWith();
    await cron();
    expect((await eventsOf('channel_ok')).filter((e: any) => e.channel === 'gmail')).toHaveLength(1);
  });

  it('ignores channels that are switched off', async () => {
    await api('/api/settings/channels', { method: 'PUT', body: { tiktok: { mode: 'off' } } });
    await syncWith({ tiktok: { last_ok_at: Date.now() - 30 * MIN } });
    await cron();
    expect((await eventsOf('channel_down')).filter((e: any) => e.channel === 'tiktok')).toHaveLength(0);
    await api('/api/settings/channels', { method: 'PUT', body: { tiktok: { mode: 'review' } } });
    await syncWith();
    await cron();
  });

  it('reports a customer waiting 15 minutes when the brain fails quietly', async () => {
    await syncWith();
    const out = await inbound('whatsapp', `${unique('4477')}@c.us`, [{ external_id: unique('m'), direction: 'in', body: 'mock-error please' }]);
    expect(out.action).toBe('none');
    const conv = out.conversation_id!;
    await sql('UPDATE conversations SET needs_reply_since = ?, processing_until = NULL WHERE id = ?', [Date.now() - 20 * MIN, conv]);
    await cron();
    const stuck = (await eventsOf('reply_stuck')).filter((e: any) => e.conversation_id === conv);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].message).toContain('no reply');
    expect((await api('/api/overview')).data.monitor.stuck.whatsapp).toBeGreaterThanOrEqual(1);
    expect(pushed('stuck')).toBeGreaterThanOrEqual(1);
    await cron(); // logged once per chat
    expect((await eventsOf('reply_stuck')).filter((e: any) => e.conversation_id === conv)).toHaveLength(1);
    await sql('UPDATE conversations SET needs_reply_since = NULL WHERE id = ?', [conv]);
    await cron();
    expect((await api('/api/overview')).data.monitor.stuck.whatsapp ?? 0).toBe(0);
  });

  it('alerts once when the AI fails 3 times in a row', async () => {
    const now = Date.now();
    const before = pushed('ai');
    for (let i = 0; i < 2; i++) await sql(`INSERT INTO llm_usage (ts, provider, model, purpose, ok) VALUES (?, 'anthropic', 'claude-test', 'decide', 0)`, [now - i * 1000]);
    await cron();
    expect(await eventsOf('ai_failing')).toHaveLength(0); // two is not enough
    await sql(`INSERT INTO llm_usage (ts, provider, model, purpose, ok) VALUES (?, 'anthropic', 'claude-test', 'decide', 0)`, [now + 1]);
    await cron();
    expect(await eventsOf('ai_failing')).toHaveLength(1);
    expect(pushed('ai')).toBe(before + 1);
    expect((await api('/api/overview')).data.monitor.ai_failing).toBe(true);
    await cron();
    expect(pushed('ai')).toBe(before + 1);
    await sql(`INSERT INTO llm_usage (ts, provider, model, purpose, ok) VALUES (?, 'anthropic', 'claude-test', 'decide', 1)`, [now + 2]);
    await cron();
    expect(await eventsOf('ai_ok')).toHaveLength(1);
    expect((await api('/api/overview')).data.monitor.ai_failing).toBe(false);
    await sql(`DELETE FROM llm_usage WHERE model = 'claude-test'`);
  });
});

describe('D1 usage meter', () => {
  it('counts rows read and written today and shows them on Health and Live', async () => {
    await sql(`DELETE FROM settings WHERE key = 'state:d1_usage'`);
    await syncWith({ whatsapp: { unread: 7 } }); // a write
    await api('/api/conversations');
    await cron(); // flushes the counter
    const u1 = (await api('/api/health')).data.d1_usage;
    expect(u1.day).toBe(new Date().toISOString().slice(0, 10));
    expect(u1.estimate).toBe(true);
    expect(u1.read_limit).toBe(5_000_000);
    expect(u1.write_limit).toBe(100_000);
    expect(u1.rows_read).toBeGreaterThan(0);
    expect(u1.rows_written).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) await api('/api/conversations');
    await cron();
    const u2 = (await api('/api/health')).data.d1_usage;
    expect(u2.rows_read).toBeGreaterThan(u1.rows_read);
    const ov = (await api('/api/overview')).data;
    expect(ov.usage.rows_read).toBeGreaterThanOrEqual(u2.rows_read);
  });

  it('alerts once a day at 70 percent', async () => {
    const before = pushed('usage');
    const day = new Date().toISOString().slice(0, 10);
    await sql(`INSERT INTO settings (key, value, updated_at) VALUES ('state:d1_usage', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify({ day, read: 3_600_000, written: 1000, updated_at: Date.now() }), Date.now()]);
    await cron();
    expect(pushed('usage')).toBe(before + 1);
    const ev = await eventsOf('usage_high');
    expect(ev).toHaveLength(1);
    expect(ev[0].message).toContain('estimate');
    expect((await api('/api/overview')).data.usage.read_pct).toBeGreaterThanOrEqual(72);
    await cron();
    expect(pushed('usage')).toBe(before + 1);
    await sql(`DELETE FROM settings WHERE key = 'state:d1_usage'`);
  });
});
