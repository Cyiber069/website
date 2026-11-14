import { createHmac, webcrypto } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { violations } from '../../src/brain/style';
import { BASE, api, cron, finish, sql, sync, unique } from '../helpers/client';

// All phone numbers are made up (UK 07700 900xxx is reserved for fiction).
const HOUR = 3_600_000;
const WEBHOOK_SECRET = 'whsec_test_0123456789abcdef';
const TEMPLATE = 'Hey {first_name}, you left {product} in your basket at {shop}. Want me to hold it for you? Your link: {checkout_link}';

let n = 0;
/** A fresh fictional UK mobile, national format and E.164. */
function phone() {
  const tail = String(100 + (n++ % 900));
  return { national: `07700 900${tail}`, e164: `+447700900${tail}` };
}

interface Seed {
  id?: string; first_name?: string | null; phone_e164?: string | null; phone_raw?: string | null; country?: string | null;
  age_hours?: number; completed?: boolean; consent_sms?: boolean; status?: string; messaged_hours_ago?: number;
  recovery_url?: string | null; items?: { title: string; quantity: number }[]; total?: string;
}

async function seed(s: Seed = {}): Promise<string> {
  const id = s.id ?? unique('co');
  const now = Date.now();
  const created = now - (s.age_hours ?? 3) * HOUR;
  const p = s.phone_e164 === undefined ? phone().e164 : s.phone_e164;
  await sql(
    `INSERT INTO checkouts (id, token, name, first_name, phone_raw, phone_e164, country, total, currency, items, recovery_url,
       created_at_shop, updated_at_shop, completed_at, consent_sms, source, status, messaged_at, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'GBP', ?, ?, ?, ?, ?, ?, 'webhook', ?, ?, ?, ?)`,
    [
      id, id, `#${id}`, s.first_name === undefined ? 'Sam' : s.first_name, s.phone_raw === undefined ? p : s.phone_raw, p,
      s.country === undefined ? 'GB' : s.country, s.total ?? '499.00',
      JSON.stringify(s.items ?? [{ title: 'Trail Kit 72V', quantity: 1 }]),
      s.recovery_url === undefined ? `https://shop.example/1/checkouts/ac/${id}/recover?key=secret-${id}` : s.recovery_url,
      created, created, s.completed ? now - HOUR : null, s.consent_sms ? 1 : 0, s.status ?? 'new',
      s.messaged_hours_ago !== undefined ? now - s.messaged_hours_ago * HOUR : null, created, now,
    ],
  );
  return id;
}

const checkout = async (id: string) => (await sql('SELECT * FROM checkouts WHERE id = ?', [id])).data.results[0];
const recoveryJobs = async () => (await sql(`SELECT * FROM outbox WHERE source = 'recovery' ORDER BY not_before ASC`)).data.results;
const setRecovery = (patch: Record<string, unknown>) => api('/api/settings/recovery', { method: 'PUT', body: patch });
const saveTemplate = (body: Record<string, unknown>) => api('/api/recovery/template', { method: 'PUT', body });
const runNow = async (dry_run = false) => (await api('/api/recovery/run', { body: { dry_run } })).data.run;
const overview = async () => (await api('/api/recovery')).data;

/** Approved message, consent confirmed: tonight's run would send for real. */
async function goLive(text = TEMPLATE) {
  const res = await saveTemplate({ text, approved: true, consent_mode: 'all' });
  expect(res.status).toBe(200);
  expect(res.data.blocked_by).toBeNull();
}

/** Post to the webhook endpoint the way Shopify does: raw JSON signed with base64 HMAC-SHA256. */
async function hook(topic: string, payload: unknown, opts: { secret?: string | null; tamper?: boolean } = {}) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-shop-domain': 'test.myshopify.com' };
  const secret = opts.secret === undefined ? WEBHOOK_SECRET : opts.secret;
  if (secret !== null) headers['x-shopify-hmac-sha256'] = createHmac('sha256', secret).update(raw).digest('base64');
  const res = await fetch(`${BASE()}/api/hooks/shopify`, { method: 'POST', headers, body: opts.tamper ? raw.replace('Sam', 'Max') : raw });
  return res.status;
}

function checkoutPayload(token: string, over: Record<string, unknown> = {}) {
  return {
    token, cart_token: `cart${token}`, name: `#${token}`, email: `${token}@example.com`, total_price: '649.00', currency: 'GBP',
    created_at: new Date(Date.now() - 3 * HOUR).toISOString(), updated_at: new Date(Date.now() - 2 * HOUR).toISOString(), completed_at: null,
    abandoned_checkout_url: `https://shop.example/1/checkouts/ac/cart${token}/recover?key=k${token}`,
    buyer_accepts_marketing: false, buyer_accepts_sms_marketing: false,
    line_items: [{ title: 'Commuter Kit', quantity: 1 }],
    shipping_address: { first_name: 'Sam', phone: '07700 900777', country_code: 'GB' },
    ...over,
  };
}

beforeAll(async () => {
  // The scheduled run must never fire by accident while these tests call cron: park it 12 hours away.
  const londonHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  await setRecovery({ send_hour_london: (londonHour + 12) % 24 });
  await api('/api/agent-toggle', { body: { enabled: true } });
  await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' } } });
  await api('/api/connections/shopify', { method: 'PUT', body: { webhook_secret: WEBHOOK_SECRET } });
});

beforeEach(async () => {
  // A clean slate for recovery, and no stray jobs that could hold the WhatsApp tab.
  await sql('DELETE FROM checkouts');
  await sql('DELETE FROM recovery_runs');
  await sql(`DELETE FROM outbox WHERE source = 'recovery'`);
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased', 'review')`);
  await sql(`UPDATE contacts SET opted_out = 0`);
  await setRecovery({
    enabled: true, daily_cap: 5, cooldown_days: 30, min_age_minutes: 60, max_age_hours: 48, countries: [], consent_mode: 'all',
    spacing_seconds: [120, 300], window_minutes: 90, personalize: false, include_link: false, opt_out_line: true,
  });
  await saveTemplate({ text: TEMPLATE, approved: false });
  await sql(`UPDATE settings SET value = json_set(value, '$.consent_confirmed', json('false')) WHERE key = 'recovery'`);
  await setRecovery({}); // drops the settings cache after the direct edit above
});

describe('connections', () => {
  it('shows what is saved without ever returning a secret', async () => {
    await api('/api/connections/shopify', { method: 'PUT', body: { myshopify_domain: 'https://Test-Store.myshopify.com/admin', client_id: 'cid_1234567890', client_secret: 'shpss_supersecretvalue' } });
    const { status, data } = await api('/api/connections');
    expect(status).toBe(200);
    expect(data.shopify).toMatchObject({ mode: 'api', myshopify_domain: 'test-store.myshopify.com', api: { saved: true, hint: '...alue' } });
    expect(data.shopify.webhook).toMatchObject({ secret_saved: true, url: `${BASE()}/api/hooks/shopify` });
    expect(data.brain.models.map((m: any) => m.id)).toContain(data.brain.model);
    expect(data.brain.claude_key).toHaveProperty('saved');
    expect(data.push.public_key).toMatch(/^B[A-Za-z0-9_-]{86}$/); // 65 byte uncompressed P-256 point
    expect(data.alerts).toHaveProperty('push');
    const text = JSON.stringify(data);
    for (const secret of ['shpss_supersecretvalue', 'cid_1234567890', WEBHOOK_SECRET]) expect(text).not.toContain(secret);

    // The VAPID key is made once and stays the same.
    expect((await api('/api/connections')).data.push.public_key).toBe(data.push.public_key);
    const hints = await sql(`SELECT key FROM secrets WHERE key = 'vapid_private_jwk'`);
    expect(hints.data.results).toHaveLength(1);

    expect((await api('/api/connections/shopify', { method: 'PUT', body: { myshopify_domain: 'acxebikes.com' } })).status).toBe(400);
    expect((await api('/api/connections/brain', { method: 'PUT', body: { anthropic_api_key: 'not a key' } })).status).toBe(400);
    expect((await api('/api/connections', { as: 'public' })).status).toBe(401);

    // Removing the app details leaves webhook mode.
    await api('/api/connections/shopify', { method: 'PUT', body: { client_id: '', client_secret: '' } });
    const after = (await api('/api/connections')).data;
    expect(after.shopify.mode).toBe('webhook');
    expect(after.shopify.api.saved).toBe(false);
    await api('/api/connections/shopify', { method: 'PUT', body: { myshopify_domain: 'udh158-w3.myshopify.com' } });
  });

  it('saves brain choices and answers a brain test either way', async () => {
    const before = (await api('/api/connections')).data.brain;
    const put = await api('/api/connections/brain', { method: 'PUT', body: { effort: 'medium', model: 'claude-sonnet-5-5' } });
    expect(put.data.brain).toMatchObject({ effort: 'medium', model: 'claude-sonnet-5-5' });
    expect((await api('/api/connections/brain', { method: 'PUT', body: { effort: 'extreme' } })).status).toBe(400);
    const test = await api('/api/connections/brain/test', { body: {} });
    expect(test.status).toBe(200);
    expect(typeof test.data.ok).toBe('boolean');
    expect(test.data).toHaveProperty('provider');
    if (!test.data.ok) expect(typeof test.data.error).toBe('string');
    await api('/api/connections/brain', { method: 'PUT', body: { effort: before.effort, model: before.model } });
  });

  it('delivers an encrypted push to a subscribed phone and forgets one that has gone', async () => {
    await sql('DELETE FROM push_subscriptions');
    const seen: { req: IncomingMessage; body: Buffer }[] = [];
    let answer = 201;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { seen.push({ req, body: Buffer.concat(chunks) }); res.statusCode = answer; res.end(); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/push/abc`;
      const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const p256dh = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
      const auth = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');

      expect((await api('/api/push/test', { body: {} })).data).toMatchObject({ ok: false, sent: 0 });
      expect((await api('/api/push/subscribe', { body: { endpoint: 'ftp://nope', keys: { p256dh, auth } } })).status).toBe(400);
      expect((await api('/api/push/subscribe', { body: { endpoint, keys: { p256dh: 'short', auth } } })).status).toBe(400);
      const sub = await api('/api/push/subscribe', { body: { endpoint, keys: { p256dh, auth } } });
      expect(sub.data).toMatchObject({ ok: true, subscriptions: 1 });
      // Subscribing again from the same browser replaces, never duplicates.
      expect((await api('/api/push/subscribe', { body: { endpoint, keys: { p256dh, auth } } })).data.subscriptions).toBe(1);

      const sent = await api('/api/push/test', { body: {} });
      expect(sent.data).toMatchObject({ ok: true, sent: 1 });
      expect(seen).toHaveLength(1);
      const { req, body } = seen[0]!;
      expect(req.method).toBe('POST');
      expect(req.headers['content-encoding']).toBe('aes128gcm');
      expect(Number(req.headers.ttl)).toBeGreaterThan(0);
      expect(body.readUInt32BE(16)).toBe(4096);
      expect(body[20]).toBe(65);
      expect(body.toString('latin1')).not.toContain('Notifications are working');

      // The VAPID header carries our public key and a token signed by it for this push service.
      const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(String(req.headers.authorization));
      expect(m).not.toBeNull();
      const [, token, k] = m as unknown as [string, string, string];
      expect(k).toBe((await api('/api/connections')).data.push.public_key);
      const [head, claims, sig] = token.split('.') as [string, string, string];
      expect(JSON.parse(Buffer.from(claims, 'base64url').toString()).aud).toBe(new URL(endpoint).origin);
      const key = await webcrypto.subtle.importKey('raw', Buffer.from(k, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      expect(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(sig, 'base64url'), Buffer.from(`${head}.${claims}`))).toBe(true);

      // 410 Gone: the browser dropped the subscription, so we drop it too.
      answer = 410;
      expect((await api('/api/push/test', { body: {} })).data).toMatchObject({ ok: false, sent: 0 });
      expect((await api('/api/connections')).data.push.subscriptions).toBe(0);

      await api('/api/push/subscribe', { body: { endpoint, keys: { p256dh, auth } } });
      expect((await api('/api/push/unsubscribe', { body: { endpoint } })).data.subscriptions).toBe(0);
    } finally {
      server.close();
    }
  });
});

describe('shopify webhooks', () => {
  it('rejects a missing, wrong or mismatched signature and stores nothing', async () => {
    const token = unique('tk');
    expect(await hook('checkouts/create', checkoutPayload(token), { secret: null })).toBe(401);
    expect(await hook('checkouts/create', checkoutPayload(token), { secret: 'some other secret' })).toBe(401);
    expect(await hook('checkouts/create', checkoutPayload(token), { tamper: true })).toBe(401);
    expect(await checkout(token)).toBeUndefined();
  });

  it('stores a checkout, keeps the newest version, and records that Shopify reached us', async () => {
    const token = unique('tk');
    const before = Date.now();
    expect(await hook('checkouts/create', checkoutPayload(token))).toBe(200);
    let row = await checkout(token);
    expect(row).toMatchObject({
      id: token, token, first_name: 'Sam', phone_raw: '07700 900777', phone_e164: '+447700900777', country: 'GB',
      total: '649.00', currency: 'GBP', status: 'new', source: 'webhook', consent_sms: 0, completed_at: null,
    });
    expect(JSON.parse(row.items)).toEqual([{ title: 'Commuter Kit', quantity: 1 }]);

    // A later update changes the basket and adds consent.
    const newer = new Date(Date.now() - HOUR).toISOString();
    expect(await hook('checkouts/update', checkoutPayload(token, { updated_at: newer, total_price: '700.00', buyer_accepts_sms_marketing: true }))).toBe(200);
    // An older snapshot delivered late must not undo it.
    expect(await hook('checkouts/update', checkoutPayload(token, { updated_at: new Date(Date.now() - 2.5 * HOUR).toISOString(), total_price: '1.00' }))).toBe(200);
    row = await checkout(token);
    expect(row).toMatchObject({ total: '700.00', consent_sms: 1, status: 'new' });
    expect((await sql('SELECT COUNT(*) AS n FROM checkouts')).data.results[0].n).toBe(1);

    const conn = (await api('/api/connections')).data.shopify.webhook;
    expect(conn.last_received_at).toBeGreaterThanOrEqual(before);
    expect((await api('/api/connections/shopify/test', { body: {} })).data.ok).toBe(true);

    // Unknown topics and odd bodies are acknowledged, never retried.
    expect(await hook('products/update', { id: 1 })).toBe(200);
    expect(await hook('checkouts/create', ['not', 'an', 'object'])).toBe(200);
  });

  it('marks a checkout recovered when it completes or its order arrives, and cancels a waiting reminder', async () => {
    // Completed through checkouts/update.
    const a = unique('tk');
    await hook('checkouts/create', checkoutPayload(a));
    await hook('checkouts/update', checkoutPayload(a, { updated_at: new Date().toISOString(), completed_at: new Date().toISOString() }));
    expect(await checkout(a)).toMatchObject({ status: 'recovered' });
    expect((await checkout(a)).completed_at).toBeGreaterThan(0);

    // Order matched by checkout token while a reminder is queued.
    await goLive();
    const b = unique('tk');
    await hook('checkouts/create', checkoutPayload(b, { shipping_address: { first_name: 'Bea', phone: '07700 900778', country_code: 'GB' } }));
    const run = await runNow();
    expect(run.queued).toBe(1);
    const queued = await checkout(b);
    expect(queued.status).toBe('queued');
    expect(await hook('orders/create', { id: 5001, name: '#5001', checkout_token: b, created_at: new Date().toISOString() })).toBe(200);
    expect(await checkout(b)).toMatchObject({ status: 'recovered' });
    expect((await sql('SELECT status FROM outbox WHERE id = ?', [queued.outbox_id])).data.results[0].status).toBe('cancelled');
    expect((await sync(['whatsapp'])).data.jobs).toHaveLength(0);

    // Order matched only by phone: they started again from scratch and bought.
    const c = await seed({ phone_e164: '+447700900779' });
    await hook('orders/create', { id: 5002, checkout_token: 'something-else', created_at: new Date().toISOString(), shipping_address: { phone: '07700 900779', country_code: 'GB' } });
    expect(await checkout(c)).toMatchObject({ status: 'recovered' });
  });
});

describe('who gets a reminder', () => {
  it('applies every eligibility rule and explains each skip', async () => {
    const ok = await seed({ first_name: 'Asha' });
    const completed = await seed({ completed: true });
    const noPhone = await seed({ phone_e164: null, phone_raw: null });
    const badPhone = await seed({ phone_e164: null, phone_raw: '12345' });
    const tooRecent = await seed({ age_hours: 0.5 });
    const tooOld = await seed({ age_hours: 60 });
    const dupPhone = phone().e164;
    const dupNew = await seed({ phone_e164: dupPhone, age_hours: 2 });
    const dupOld = await seed({ phone_e164: dupPhone, age_hours: 5 });

    const view = await overview();
    const codes = Object.fromEntries(view.skipped.map((s: any) => [s.id, s.code]));
    expect(view.eligible.map((e: any) => e.id).sort()).toEqual([ok, dupNew].sort());
    expect(codes).toMatchObject({
      [completed]: 'completed', [noPhone]: 'no_phone', [badPhone]: 'invalid_phone', [tooRecent]: 'too_recent', [tooOld]: 'too_old', [dupOld]: 'duplicate_number',
    });
    for (const s of view.skipped) expect(s.reason).toMatch(/\w+ \w+/); // plain words, not a code

    // Phones are masked everywhere in the API: only the last three digits survive.
    const first = view.eligible.find((e: any) => e.id === ok);
    const full = (await checkout(ok)).phone_e164 as string;
    expect(first.phone_masked.endsWith(full.slice(-3))).toBe(true);
    expect(JSON.stringify(view)).not.toContain(full);
    expect(JSON.stringify(view)).not.toContain(full.slice(1, 10));
    expect(first).toMatchObject({ first_name: 'Asha', country: 'GB', total: '499.00', currency: 'GBP', items: [{ title: 'Trail Kit 72V', quantity: 1 }] });
    expect(first.age_hours).toBeCloseTo(3, 0);
    expect(first.preview_text).toContain('Hey Asha');
    expect(view.variables).toEqual(['{first_name}', '{product}', '{total}', '{checkout_link}', '{shop}']);
    expect(view.shopify).toMatchObject({ connected: true, mode: 'webhook' });
    expect(view.next_run_at).toBeGreaterThan(Date.now());
    expect(view.stats).toEqual({ messaged_30d: 0, replied_30d: 0, recovered_30d: 0 });
  });

  it('honours the country filter and the opted in only mode', async () => {
    const gb = await seed({ country: 'GB' });
    const de = await seed({ country: 'DE', phone_e164: '+4915112345678' });
    const consented = await seed({ consent_sms: true });
    await setRecovery({ countries: ['gb'] });
    let view = await overview();
    expect(view.eligible.map((e: any) => e.id).sort()).toEqual([gb, consented].sort());
    expect(view.skipped.find((s: any) => s.id === de).code).toBe('country');

    await setRecovery({ countries: [], consent_mode: 'opted_in' });
    view = await overview();
    expect(view.eligible.map((e: any) => e.id)).toEqual([consented]);
    expect(view.skipped.filter((s: any) => s.code === 'no_consent').map((s: any) => s.id).sort()).toEqual([gb, de].sort());
  });

  it('never messages a number inside its cooldown, or one that opted out', async () => {
    const again = phone().e164;
    await seed({ phone_e164: again, status: 'messaged', messaged_hours_ago: 24 * 10 });
    const cooling = await seed({ phone_e164: again });
    const longAgo = phone().e164;
    await seed({ phone_e164: longAgo, status: 'messaged', messaged_hours_ago: 24 * 45, age_hours: 24 * 46 });
    const fine = await seed({ phone_e164: longAgo });

    const stopped = phone().e164;
    const optedOut = await seed({ phone_e164: stopped });
    const ct = unique('ct');
    await sql(`INSERT INTO contacts (id, channel, external_id, display_name, phone, opted_out, created_at, updated_at) VALUES (?, 'whatsapp', ?, 'Stopped', ?, 1, ?, ?)`,
      [ct, `${stopped.slice(1)}@c.us`, stopped, Date.now(), Date.now()]);

    await goLive();
    const run = await runNow();
    expect(run.summary.mode).toBe('live');
    expect(run.summary.messages.map((m: any) => m.checkout_id)).toEqual([fine]);
    const codes = Object.fromEntries(run.summary.skipped.map((s: any) => [s.checkout_id, s.code]));
    expect(codes).toMatchObject({ [cooling]: 'cooldown', [optedOut]: 'opted_out' });
    expect((await checkout(cooling)).status).toBe('new');
    expect((await checkout(optedOut)).status).toBe('new');

    // Opting back in through the dashboard makes them eligible again.
    await api(`/api/contacts/${ct}/opt-out`, { body: { opted_out: false } });
    expect((await overview()).eligible.map((e: any) => e.id)).toContain(optedOut);
  });

  it('lets the owner skip one checkout', async () => {
    const id = await seed();
    expect((await api(`/api/recovery/checkouts/${id}/skip`, { body: {} })).data.ok).toBe(true);
    const view = await overview();
    expect(view.eligible).toHaveLength(0);
    expect(view.skipped.find((s: any) => s.id === id)).toMatchObject({ code: 'owner' });
    expect((await api('/api/recovery/checkouts/nope/skip', { body: {} })).status).toBe(404);
  });
});

describe('the message', () => {
  it('validates and saves the template, and approval needs a consent choice to go live', async () => {
    expect((await saveTemplate({ text: 'Hi {name}', approved: false })).data.error).toBe('unknown_variable');
    expect((await saveTemplate({ text: '', approved: true })).data.error).toBe('empty_template');
    expect((await saveTemplate({ text: TEMPLATE, approved: true, consent_mode: 'everyone' })).status).toBe(400);

    // Approved, but the owner has not said who may be messaged: still blocked.
    const half = await saveTemplate({ text: TEMPLATE, approved: true });
    expect(half.data.template).toMatchObject({ text: TEMPLATE, approved: true });
    expect(half.data.blocked_by).toMatch(/confirmed/);
    const full = await saveTemplate({ text: TEMPLATE, approved: true, consent_mode: 'opted_in' });
    expect(full.data.blocked_by).toBeNull();
    expect(full.data.settings).toMatchObject({ consent_mode: 'opted_in', consent_confirmed: true });

    // The general settings route cannot approve a message or confirm consent by the back door.
    await saveTemplate({ text: TEMPLATE, approved: false });
    await setRecovery({ template: { text: 'sneaky', approved: true, updated_at: 1 } });
    expect((await overview()).template).toMatchObject({ text: TEMPLATE, approved: false });
  });

  it('fills variables, drops the link when links are off, copes without a name, and obeys the style rules', async () => {
    const named = await seed({ first_name: 'JAKE', items: [{ title: 'Road-Legal Kit — 250W', quantity: 1 }, { title: 'Charger', quantity: 1 }] });
    const nameless = await seed({ first_name: null });
    let view = await overview();
    const text = (id: string) => view.eligible.find((e: any) => e.id === id).preview_text as string;

    expect(text(named)).toMatch(/^Hey Jake you left Road Legal Kit/);
    expect(text(named)).toContain('and 1 other item in your basket at ACX Ebikes');
    expect(text(named)).toContain('Want me to hold it for you?');
    expect(text(named)).toMatch(/Reply STOP if you'd rather not hear from us$/);
    expect(text(nameless)).toMatch(/^Hey you left Trail Kit 72V/);
    for (const id of [named, nameless]) {
      expect(text(id)).not.toMatch(/link|https?:|\{|\}/i);
      expect(violations(text(id))).toEqual([]);
      expect(text(id)).not.toMatch(/[‒-―]| - /);
    }

    // Links on: the personal link arrives intact, the opt out line still follows.
    await setRecovery({ include_link: true, opt_out_line: false });
    view = await overview();
    const url = (await checkout(named)).recovery_url as string;
    expect(text(named)).toContain(`Your link: ${url}`);
    expect(text(named)).not.toContain('STOP');

    // A template with a total and a second paragraph becomes two messages.
    await saveTemplate({ text: 'Hi {first_name}! Your {product} ({total}) is still saved.\n\nShall I keep it for you?', approved: false });
    view = await overview();
    expect(text(nameless).split('\n')).toEqual(['Hi! Your Trail Kit 72V (£499) is still saved', 'Shall I keep it for you?']);
  });

  it('suggests a tidy template from rough words without saving it', async () => {
    const res = await api('/api/recovery/teach', { body: { rough: 'hey [name]  —  saw you left {{ product }} behind!!  want it?' } });
    expect(res.status).toBe(200);
    expect(typeof res.data.suggestion).toBe('string');
    expect(res.data.suggestion.length).toBeGreaterThan(10);
    expect(res.data.suggestion).not.toMatch(/\[name\]|\{\{|[‒-―]/);
    if (res.data.source === 'basic') expect(res.data.suggestion).toBe('hey {first_name}, saw you left {product} behind! want it?');
    expect((await overview()).template.text).toBe(TEMPLATE);
    expect((await api('/api/recovery/teach', { body: {} })).status).toBe(400);
  });
});

describe('the run', () => {
  it('only records a dry run while the message is not approved', async () => {
    const a = await seed({ first_name: 'Ana' });
    const b = await seed({ first_name: 'Ben', recovery_url: 'https://shop.example/1/checkouts/ac/xyz/recover?key=topsecret' });
    await setRecovery({ include_link: true });

    const run = await runNow(false); // asked to send for real
    expect(run).toMatchObject({ trigger: 'manual', status: 'done', found: 2, queued: 0 });
    expect(run.summary.mode).toBe('dry_run');
    expect(run.summary.dry_reason).toMatch(/not approved/);
    expect(run.summary.line).toMatch(/^Dry run: 2 reminders would have gone out/);
    expect(run.summary.messages.map((m: any) => m.checkout_id).sort()).toEqual([a, b].sort());
    const ben = run.summary.messages.find((m: any) => m.checkout_id === b);
    expect(ben.text).toContain('Hey Ben');
    // The personal link opens the basket for anyone, so it is not written into the run log.
    expect(ben.text).toContain('[checkout link]');
    expect(JSON.stringify(run)).not.toContain('topsecret');
    expect(ben.phone_masked).toMatch(/^\+•+\d{3}$/);

    expect(await recoveryJobs()).toHaveLength(0);
    expect((await checkout(a)).status).toBe('new');
    expect((await sync(['whatsapp'])).data.jobs).toHaveLength(0);

    // Approved but explicitly a test: still nothing sent.
    await goLive();
    const test = await runNow(true);
    expect(test).toMatchObject({ trigger: 'dry_run', queued: 0 });
    expect(test.summary.mode).toBe('dry_run');
    expect(await recoveryJobs()).toHaveLength(0);

    // Switched off, agent off: both keep a real run dry.
    await setRecovery({ enabled: false });
    expect((await runNow()).summary.dry_reason).toMatch(/switched off/);
    await setRecovery({ enabled: true });
    await api('/api/agent-toggle', { body: { enabled: false } });
    expect((await runNow()).summary.dry_reason).toMatch(/agent is switched off/);
    await api('/api/agent-toggle', { body: { enabled: true } });
    expect(await recoveryJobs()).toHaveLength(0);

    const runs = (await overview()).runs;
    expect(runs).toHaveLength(4);
    expect(runs[0].summary.mode).toBe('dry_run');
  });

  it('queues staggered first messages that the laptop sends one at a time', async () => {
    const ids = [await seed({ first_name: 'Ana', age_hours: 2 }), await seed({ first_name: 'Ben', age_hours: 3 }), await seed({ first_name: 'Cal', age_hours: 4 })];
    await goLive();
    const started = Date.now();
    const run = await runNow();
    expect(run).toMatchObject({ trigger: 'manual', status: 'done', found: 3, queued: 3, skipped: 0 });
    expect(run.summary.mode).toBe('live');
    expect(run.summary.line).toMatch(/^Queued 3 checkout reminders/);

    const jobs = await recoveryJobs();
    expect(jobs).toHaveLength(3);
    // Newest checkout first, then two to five minutes between each.
    expect(jobs.map((j: any) => j.ref_id)).toEqual(ids);
    for (const [i, j] of jobs.entries()) {
      expect(j).toMatchObject({ channel: 'whatsapp', kind: 'new_chat', status: 'pending', source: 'recovery', dedupe_key: `recovery:${ids[i]}`, conversation_id: null });
      expect(j.expires_at).toBeGreaterThanOrEqual(started + 90 * 60_000 - 5000);
      expect(j.expires_at).toBeLessThanOrEqual(Date.now() + 90 * 60_000);
      if (i > 0) {
        const gap = j.not_before - jobs[i - 1].not_before;
        expect(gap).toBeGreaterThanOrEqual(120_000);
        expect(gap).toBeLessThanOrEqual(300_000);
      }
    }
    expect(jobs[0].not_before).toBeLessThanOrEqual(Date.now());
    for (const id of ids) expect(await checkout(id)).toMatchObject({ status: 'queued', run_id: run.id });

    // The laptop gets the first one now, as a new chat to the phone number.
    const first = (await sync(['whatsapp'])).data.jobs;
    expect(first).toHaveLength(1);
    const job = first[0]!;
    const row = await checkout(ids[0]!);
    expect(job).toMatchObject({ id: row.outbox_id, channel: 'whatsapp', kind: 'new_chat', source: 'recovery' });
    expect(job.target).toMatchObject({ phone: row.phone_e164, title: 'Ana', thread_external_id: null });
    expect(job.parts).toHaveLength(1);
    expect(job.parts[0]).toBe(row.message_text);
    expect(job.parts[0]).toMatch(/^Hey Ana you left Trail Kit 72V in your basket at ACX Ebikes\. Want me to hold it for you\? Reply STOP/);
    expect(violations(job.parts[0]!)).toEqual([]);
    expect(job.pacing.delay_ms).toBeGreaterThan(0);

    // While it is being typed, and until the spacing has passed, nothing else is handed out.
    expect((await sync(['whatsapp'])).data.jobs).toHaveLength(0);
    expect((await finish(job.id, { status: 'sent', sent_external_ids: ['wa-out-1'] })).data.status).toBe('sent');
    expect((await sync(['whatsapp'])).data.jobs).toHaveLength(0);

    const sent = await checkout(ids[0]!);
    expect(sent.status).toBe('messaged');
    expect(sent.messaged_at).toBeGreaterThan(0);
    // The send opened a conversation that carries the checkout context for when they reply.
    const conv = (await sql('SELECT c.* FROM conversations c JOIN outbox o ON o.conversation_id = c.id WHERE o.id = ?', [job.id])).data.results[0];
    expect(conv.external_thread_id).toBe(`${row.phone_e164.slice(1)}@c.us`);
    expect(conv.context_notes).toContain('checkout they did not finish');

    // When its time comes the second one goes out.
    await sql('UPDATE outbox SET not_before = ? WHERE id = ?', [Date.now() - 1000, jobs[1].id]);
    const second = (await sync(['whatsapp'])).data.jobs;
    expect(second.map((j) => j.id)).toEqual([jobs[1].id]);
    expect(second[0]!.target.title).toBe('Ben');
    // WhatsApp says the number is not on WhatsApp: no retry, checkout marked failed.
    await finish(second[0]!.id, { status: 'failed', error_code: 'not_on_whatsapp', retryable: false });
    expect(await checkout(ids[1]!)).toMatchObject({ status: 'failed', skip_reason: 'not_on_whatsapp' });

    // Running again the same day queues nothing twice.
    const again = await runNow();
    expect(again.queued).toBe(0);
    expect(await recoveryJobs()).toHaveLength(3);

    const stats = (await overview()).stats;
    expect(stats).toMatchObject({ messaged_30d: 1, replied_30d: 0, recovered_30d: 0 });
    // They buy after the reminder: that is a recovery.
    await hook('orders/create', { id: 7001, checkout_token: ids[0], created_at: new Date().toISOString() });
    expect((await overview()).stats).toMatchObject({ messaged_30d: 1, recovered_30d: 1 });
  });

  it('stops at the daily cap, across runs on the same day', async () => {
    await setRecovery({ daily_cap: 2 });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await seed({ age_hours: 2 + i }));
    await goLive();

    const view = await overview();
    expect(view.eligible).toHaveLength(2);
    expect(view.skipped.filter((s: any) => s.code === 'daily_cap')).toHaveLength(2);

    const run = await runNow();
    expect(run).toMatchObject({ found: 4, queued: 2, skipped: 2 });
    expect(run.summary.messages.map((m: any) => m.checkout_id)).toEqual(ids.slice(0, 2));
    expect(run.summary.skipped.map((s: any) => s.code)).toEqual(['daily_cap', 'daily_cap']);
    expect(run.summary.line).toMatch(/2 more wait for the next run/);
    expect((await checkout(ids[2]!)).status).toBe('new');

    // Today's allowance is used up: a second run sends nothing more.
    const second = await runNow();
    expect(second.queued).toBe(0);
    expect(await recoveryJobs()).toHaveLength(2);
    // Tomorrow (yesterday's sends no longer count) the rest go out.
    await sql(`UPDATE outbox SET created_at = created_at - ? WHERE source = 'recovery'`, [26 * HOUR]);
    const third = await runNow();
    expect(third.summary.messages.map((m: any) => m.checkout_id)).toEqual(ids.slice(2));
  });

  it('returns unsent checkouts to new when the window closes, ready for the next run', async () => {
    const a = await seed({ first_name: 'Ana', age_hours: 2 });
    const b = await seed({ first_name: 'Ben', age_hours: 3 });
    await goLive();
    expect((await runNow()).queued).toBe(2);
    const [first, second] = await recoveryJobs();

    // The laptop was closed all evening: the window passes with both still waiting.
    await sql(`UPDATE outbox SET expires_at = ? WHERE source = 'recovery'`, [Date.now() - 1000]);
    expect((await sync(['whatsapp'])).data.jobs).toHaveLength(0); // an expired job is never handed out
    await cron();
    expect((await sql('SELECT status FROM outbox WHERE id IN (?, ?)', [first.id, second.id])).data.results.map((r: any) => r.status)).toEqual(['expired', 'expired']);
    for (const id of [a, b]) expect(await checkout(id)).toMatchObject({ status: 'new', outbox_id: null });

    // Expired attempts do not count against the cap or block a fresh message for the same checkout.
    const next = await runNow();
    expect(next.queued).toBe(2);
    const live = (await recoveryJobs()).filter((j: any) => j.status === 'pending');
    expect(live.map((j: any) => j.ref_id).sort()).toEqual([a, b].sort());
    expect((await checkout(a)).status).toBe('queued');

    // Emergency stop also hands them back.
    await api('/api/panic', { body: {} });
    expect((await checkout(a)).status).toBe('new');
    await api('/api/agent-toggle', { body: { enabled: true } });
  });

  it('retires checkouts that are too old and holds back what does not fit in the window', async () => {
    const old = await seed({ age_hours: 50 });
    const ids = [await seed({ age_hours: 2 }), await seed({ age_hours: 3 }), await seed({ age_hours: 4 })];
    // A ten minute window with four to five minutes between messages has room for three starts at most.
    await setRecovery({ window_minutes: 10, spacing_seconds: [280, 300] });
    await goLive();
    const run = await runNow();
    expect(run.queued).toBe(2);
    expect(run.summary.skipped).toEqual([expect.objectContaining({ checkout_id: ids[2], code: 'window_full' })]);
    expect((await checkout(ids[2]!)).status).toBe('new');
    expect(await checkout(old)).toMatchObject({ status: 'expired', skip_reason: 'too_old' });
    for (const j of await recoveryJobs()) expect(j.not_before).toBeLessThan(j.expires_at);
  });

  it('leaves the daily schedule alone outside the send hour', async () => {
    await seed();
    await goLive();
    await cron();
    expect((await sql(`SELECT COUNT(*) AS n FROM recovery_runs WHERE trigger = 'schedule'`)).data.results[0].n).toBe(0);
    expect(await recoveryJobs()).toHaveLength(0);
  });
});
