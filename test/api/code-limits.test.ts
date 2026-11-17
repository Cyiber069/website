// The free plan allows 50 D1 queries per request. A customer asking for their own code is the longest
// path there is (two model checks, two Shopify calls, an Urgent item, a push and a WhatsApp ping), so it
// is counted here the way production runs it, not the way the plain mock does:
//   * the brain is the claude-like mock (provider anthropic in test mode): it reads the key and writes
//     every call to llm_usage like Claude, and the quick check and the confirm are two calls;
//   * Shopify is the real client against a fake Shopify (test/helpers/fake-shopify.mjs), so every
//     secret and token read happens;
//   * a phone is subscribed to push and the owner gave a WhatsApp number for alerts.
// What the counter cannot see is added: OVERHEAD (the schema check on a fresh isolate and the usage flush).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, cron, sql, unique } from '../helpers/client';
// @ts-expect-error plain JS helper
import { startFakeShopify } from '../helpers/fake-shopify.mjs';

const LIMIT = 45; // keep room under 50
const OVERHEAD = 3;
// A valid P-256 public key and auth secret (RFC 8291 appendix A), so the push is really encrypted and sent.
const UA_PUBLIC = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const UA_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

let shop: { url: string; state: { requests: { op: string; code?: string }[]; taken: Set<string> }; stop: () => Promise<void> };

async function post(channel: string, thread: string, messages: unknown[], contact: Record<string, string>) {
  const res = await fetch(`${process.env.ACX_TEST_URL}/api/agent/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ACX_TEST_DEVICE!}` },
    body: JSON.stringify({ channel, thread: { external_id: thread, title: contact.name, contact }, messages }),
  });
  const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { decision: lines.find((l) => l.type === 'decision'), error: lines.find((l) => l.type === 'error'), queries: Number(lines.find((l) => l.type === 'queries')?.n ?? 999) };
}

const ops = () => shop.state.requests.map((r) => r.op);

beforeAll(async () => {
  shop = await startFakeShopify();
  await api('/api/test/shopify-base', { as: 'public', body: { url: shop.url } });
  await sql(`DELETE FROM settings WHERE key = 'state:test_fake_shopify'`);
  expect((await api('/api/connections/shopify', { method: 'PUT', body: { admin_token: 'shpat_test_token_0001' } })).status).toBe(200);
  expect((await api('/api/connections/brain', { method: 'PUT', body: { provider: 'anthropic' } })).status).toBe(200);
  await api('/api/settings/alerts', { method: 'PUT', body: { whatsapp_number: '+447700900999', push: true } });
  await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' }, tiktok: { mode: 'auto' } } });
  await api('/api/settings/discounts', { method: 'PUT', body: { mode: 'auto', daily_cap: 50, one_per_customer: true } });
  expect((await api('/api/push/subscribe', { body: { endpoint: `${shop.url}/push`, keys: { p256dh: UA_PUBLIC, auth: UA_AUTH } } })).status).toBe(200);
});

afterAll(async () => {
  await api('/api/connections/brain', { method: 'PUT', body: { provider: 'auto' } });
  await api('/api/connections/shopify', { method: 'PUT', body: { admin_token: '' } });
  await api('/api/test/shopify-base', { as: 'public', body: { url: null } });
  await api('/api/push/unsubscribe', { body: { endpoint: `${shop.url}/push` } });
  await api('/api/settings/alerts', { method: 'PUT', body: { whatsapp_number: '', push: true } });
  await api('/api/settings/discounts', { method: 'PUT', body: { mode: 'auto', daily_cap: 10, one_per_customer: true } });
  await api('/api/settings/channels', { method: 'PUT', body: { tiktok: { mode: 'review' } } });
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased', 'review')`);
  await sql('UPDATE conversations SET needs_reply_since = NULL, processing_until = NULL');
  await shop.stop();
});

describe('code request paths stay under the query limit with a real brain and Shopify', () => {
  it('first contact on WhatsApp, Shopify makes the code', async () => {
    const code = unique('BOB').toUpperCase();
    shop.state.requests.length = 0;
    const r = await post('whatsapp', `${unique('4477')}@c.us`, [{ external_id: unique('m'), direction: 'in', body: `can i get my own discount code "${code}" please` }], { name: 'Bob', phone: `+4477009${String(Date.now()).slice(-5)}` });
    expect(r.error).toBeUndefined();
    expect(r.decision).toMatchObject({ action: 'reply', final: true });
    expect(r.decision.jobs[0].source).toBe('discount');
    expect(ops()).toEqual(expect.arrayContaining(['collections', 'create', 'push']));
    // Both model checks ran and were written down like real calls.
    const usage = (await sql(`SELECT purpose FROM llm_usage WHERE provider = 'mock' AND ts > ? ORDER BY id`, [Date.now() - 30_000])).data.results.map((u: any) => u.purpose);
    expect(usage).toEqual(expect.arrayContaining(['discount_check', 'discount_request']));
    expect(r.queries + OVERHEAD).toBeLessThanOrEqual(LIMIT);
  });

  it('first contact on WhatsApp, Shopify says the code exists: parked with an Urgent item, a push and a WhatsApp ping', async () => {
    const code = unique('CAT').toUpperCase();
    shop.state.taken.add(code);
    shop.state.requests.length = 0;
    await sql(`DELETE FROM settings WHERE key = 'state:alert_last:whatsapp'`);
    const r = await post('whatsapp', `${unique('4477')}@c.us`, [{ external_id: unique('m'), direction: 'in', body: `can i get my own discount code "${code}" please` }], { name: 'Cat', phone: `+4477008${String(Date.now()).slice(-5)}` });
    expect(r.error).toBeUndefined();
    expect(r.decision).toMatchObject({ action: 'escalate', final: true });
    expect(r.decision.jobs).toHaveLength(1); // the holding line, handed over inline
    const convId = r.decision.conversation_id;
    expect((await sql(`SELECT category FROM urgent WHERE conversation_id = ? AND status = 'open'`, [convId])).data.results).toEqual([{ category: 'discount_code' }]);
    expect((await sql(`SELECT COUNT(*) AS n FROM outbox WHERE source = 'alert' AND status = 'pending' AND created_at > ?`, [Date.now() - 30_000])).data.results[0].n).toBe(1);
    expect(ops()).toEqual(expect.arrayContaining(['collections', 'create', 'push']));
    // The chat is free again: nothing ran out of queries half way.
    expect((await sql('SELECT processing_until FROM conversations WHERE id = ?', [convId])).data.results[0].processing_until).toBeNull();
    expect(r.queries + OVERHEAD).toBeLessThanOrEqual(LIMIT);
  });

  it('an existing TikTok chat, Shopify makes the code', async () => {
    const thread = unique('tt_');
    const handle = unique('una');
    const first = await post('tiktok', thread, [{ external_id: 'u1', direction: 'in', body: 'hi is the 1000w kit in stock' }], { name: handle, handle });
    const sent = first.decision.jobs.flatMap((j: any) => j.parts.map((p: string) => ({ direction: 'out', body: p })));
    for (const j of first.decision.jobs) await api(`/api/agent/jobs/${j.id}/result`, { as: 'device', body: { status: 'sent' } });
    const code = unique('UNA').toUpperCase();
    const r = await post('tiktok', thread, [{ external_id: 'u1', direction: 'in', body: 'hi is the 1000w kit in stock' }, ...sent, { external_id: 'u2', direction: 'in', body: `also can i get my own discount code "${code}"` }], { name: handle, handle });
    expect(r.error).toBeUndefined();
    expect(r.decision.jobs[0]?.source).toBe('discount');
    expect(r.queries + OVERHEAD).toBeLessThanOrEqual(LIMIT);
  });

  it('the cron sweeper making a code for a chat whose live request died, on the day the cleanup is due', async () => {
    const t = `${unique('4477')}@c.us`;
    const warm = await post('whatsapp', t, [{ external_id: 'w1', direction: 'in', body: 'hello' }], { name: 'Dee', phone: `+4477007${String(Date.now()).slice(-5)}` });
    const convId = warm.decision.conversation_id;
    for (const j of warm.decision.jobs) await api(`/api/agent/jobs/${j.id}/result`, { as: 'device', body: { status: 'sent' } });
    const code = unique('DEE').toUpperCase();
    await sql(`INSERT INTO messages (id, conversation_id, direction, author, body, kind, status, ts, created_at) VALUES (?, ?, 'in', 'customer', ?, 'text', 'received', ?, ?)`,
      [unique('m'), convId, `can i get my own discount code "${code}" please`, Date.now() + 1000, Date.now()]);
    await sql('UPDATE conversations SET needs_reply_since = NULL');
    await sql('UPDATE conversations SET needs_reply_since = ?, processing_until = NULL, retry_at = NULL WHERE id = ?', [Date.now() - 5 * 60_000, convId]);
    await sql(`UPDATE settings SET value = '0' WHERE key = 'state:cleanup_at'`);
    // At 20:00 UK time the first tick starts the daily checkout run instead: tick until the sweeper got to it.
    let res = await cron();
    for (let i = 0; i < 2 && !(await sql(`SELECT id FROM outbox WHERE conversation_id = ? AND source = 'discount'`, [convId])).data.results.length; i++) res = await cron();
    expect((await sql(`SELECT status FROM outbox WHERE conversation_id = ? AND source = 'discount'`, [convId])).data.results).toEqual([{ status: 'pending' }]);
    expect(res.status).toBe(200);
    expect(res.queries + OVERHEAD).toBeLessThanOrEqual(LIMIT);
    // The cleanup waited for a quieter minute instead of running out of queries half way.
    const next = await cron();
    expect(next.queries + OVERHEAD).toBeLessThanOrEqual(LIMIT);
    expect(Number((await sql(`SELECT value FROM settings WHERE key = 'state:cleanup_at'`)).data.results[0].value)).toBeGreaterThan(Date.now() - 60_000);
  });
});
