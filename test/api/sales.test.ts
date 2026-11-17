import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { londonDateTimeToTs, addDays, londonTime } from '../../src/lib/time';
import { BASE, api, finish, inbound, sql, unique } from '../helpers/client';

// All phone numbers are made up (UK 07700 900xxx is reserved for fiction).
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEBHOOK_SECRET = 'whsec_test_0123456789abcdef';
const LINK = 'https://acxebikes.com/products/acx-2000w-bundle';

const conv = async (id: string) => (await sql('SELECT * FROM conversations WHERE id = ?', [id])).data.results[0];
const followJobs = async (id: string) => (await sql(`SELECT * FROM outbox WHERE conversation_id = ? AND ref_id = 'followup'`, [id])).data.results;

async function tick(now: number): Promise<{ data: any; rows: number; queries: number }> {
  const res = await fetch(`${BASE()}/api/test/sales-tick`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now }) });
  return { data: await res.json(), rows: Number(res.headers.get('x-acx-d1-rows') ?? 0), queries: Number(res.headers.get('x-acx-d1-queries') ?? 0) };
}

async function hook(topic: string, payload: unknown): Promise<number> {
  const raw = JSON.stringify(payload);
  const res = await fetch(`${BASE()}/api/hooks/shopify`, {
    method: 'POST', body: raw,
    headers: { 'content-type': 'application/json', 'x-shopify-topic': topic, 'x-shopify-shop-domain': 'test.myshopify.com', 'x-shopify-hmac-sha256': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('base64') },
  });
  return res.status;
}

// Each test gets its own day far in the future, so the follow up windows of different tests never overlap.
let dayOffset = 40;
/** 14:00 UK time on a fresh day. */
function nextAfternoon(hour = 14): number {
  dayOffset += 4;
  return londonDateTimeToTs(addDays(londonTime(Date.now()).date, dayOffset), hour);
}

let phoneN = 300;
const newPhone = () => { const tail = String(phoneN++); return { national: `07700 900${tail}`, e164: `+447700900${tail}` }; };

/** A WhatsApp chat where the agent recommended the bundle with its link and the job was sent. */
async function recommended(trigger = 'shop-interested yo which kit for my mtb', phone = newPhone().e164) {
  const t = `${phone.slice(1)}@c.us`;
  const r = await inbound('whatsapp', t, [{ external_id: unique('m'), direction: 'in', body: trigger }], { contact: { name: 'Jake', phone } });
  expect(r.action).toBe('reply');
  expect(r.jobs).toHaveLength(1);
  expect(r.jobs[0]!.parts.join(' ')).toContain(LINK);
  await finish(r.jobs[0]!.id, { status: 'sent' });
  return { id: r.conversation_id!, thread: t, phone };
}

/** Make the chat look like the customer went quiet `quietHours` after our message, as seen at `now`. */
async function quiet(id: string, now: number, opts: { outAgo?: number; inAgo?: number } = {}) {
  await sql('UPDATE conversations SET last_outbound_at = ?, last_inbound_at = ?, last_direction = ? WHERE id = ?',
    [now - (opts.outAgo ?? 21) * HOUR, now - (opts.inAgo ?? 21.5) * HOUR, 'out', id]);
}

beforeAll(async () => {
  await api('/api/agent-toggle', { body: { enabled: true } });
  await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' } } });
  await api('/api/sales/settings', { method: 'PUT', body: { follow_ups: true, follow_up_hours: 20, style: 'friendly' } });
  await api('/api/connections/shopify', { method: 'PUT', body: { webhook_secret: WEBHOOK_SECRET } });
});

afterAll(async () => {
  // Nothing left waiting that could hold the WhatsApp tab in another test file.
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE ref_id = 'followup' AND status IN ('pending', 'review', 'leased')`);
  await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' } } });
});

describe('lead stage tracking', () => {
  it('stores the stage, the product and the link we sent on the conversation', async () => {
    const { id } = await recommended();
    const c = await conv(id);
    expect(c.sales_stage).toBe('interested');
    expect(c.sales_product).toBe('ACX 2000w bundle');
    expect(c.sales_link).toBe(LINK);
    expect(c.interested_at).toBeGreaterThan(0);
    expect(c.ready_at).toBeNull();
    expect(c.followup_status).toBeNull();
  });

  it('moves to ready, and small talk afterwards does not wipe the lead', async () => {
    const phone = newPhone().e164;
    const t = `${phone.slice(1)}@c.us`;
    const a = await inbound('whatsapp', t, [{ external_id: 'r1', direction: 'in', body: 'shop-ready ok how do i order' }], { contact: { name: 'Mo', phone } });
    await finish(a.jobs[0]!.id, { status: 'sent', sent_external_ids: ['r1out'] });
    const c = await conv(a.conversation_id!);
    expect(c.sales_stage).toBe('ready');
    expect(c.ready_at).toBeGreaterThan(0);
    expect(c.interested_at).toBeGreaterThan(0);
    const b = await inbound('whatsapp', t, [
      { external_id: 'r1', direction: 'in', body: 'shop-ready ok how do i order' }, { external_id: 'r1out', direction: 'out', body: a.jobs[0]!.parts[0]! },
      { external_id: 'r2', direction: 'in', body: 'what time do you close' },
    ], { contact: { name: 'Mo', phone } });
    expect(b.action).toBe('reply');
    expect((await conv(a.conversation_id!)).sales_stage).toBe('ready');
  });

  it('marks a complaint as support', async () => {
    const r = await inbound('whatsapp', `${newPhone().e164.slice(1)}@c.us`, [{ external_id: 's1', direction: 'in', body: 'my kit is broken' }]);
    expect((await conv(r.conversation_id!)).sales_stage).toBe('support');
  });
});

describe('never sounding unsure', () => {
  it('turns "I\'m not sure about that one" into a confident holding line and an Urgent item', async () => {
    const r = await inbound('whatsapp', `${newPhone().e164.slice(1)}@c.us`, [{ external_id: 'u1', direction: 'in', body: 'unsure-reply I already have a kit but there is another box under the controller, a cable or management box?' }]);
    expect(r.action).toBe('escalate');
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]!.source).toBe('holding');
    const text = r.jobs[0]!.parts.join(' ');
    expect(text).not.toMatch(/not sure|unsure|don.?t know|no idea/i);
    expect(text).toMatch(/check|find out/i);
    const item = (await api('/api/urgent')).data.urgent.find((u: any) => u.conversation_id === r.conversation_id);
    expect(item).toBeTruthy();
    expect(item.category).toBe('unknown_fact');
    expect(item.question).toContain('box under the controller');
    await finish(r.jobs[0]!.id, { status: 'sent' });
  });
});

describe('the one follow up', () => {
  it('sends one short follow up with the product link, once, inside the hours', async () => {
    const { id } = await recommended();
    const now = nextAfternoon();
    await quiet(id, now);
    const first = await tick(now);
    expect(first.data.queued).toBe(1);
    expect(first.rows).toBeLessThan(40); // a few dozen rows a run, whatever the size of the database
    const jobs = await followJobs(id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].source).toBe('auto');
    const parts = JSON.parse(jobs[0].parts) as string[];
    expect(parts.join(' ')).toContain(LINK);
    expect(parts.join(' ')).not.toMatch(/[–—]/);
    expect(jobs[0].expires_at).toBeLessThanOrEqual(now - 21.5 * HOUR + 24 * HOUR);
    expect((await conv(id)).followup_status).toBe('queued');

    // Never a second one, even after it was sent and the chat went quiet again.
    await finish(jobs[0].id, { status: 'sent' });
    await quiet(id, now + HOUR);
    const again = await tick(now + HOUR);
    expect(again.data.queued).toBe(0);
    expect(await followJobs(id)).toHaveLength(1);
  });

  it('waits outside 10:00 to 20:00 UK time without reading anything', async () => {
    const { id } = await recommended();
    const late = nextAfternoon(21);
    await quiet(id, late);
    const night = await tick(late);
    expect(night.data.idle).toBe('outside_hours');
    expect(night.rows).toBeLessThan(10);
    expect(await followJobs(id)).toHaveLength(0);
    expect((await conv(id)).followup_status).toBeNull();
    const early = londonDateTimeToTs(londonTime(late).date, 9, 30);
    await quiet(id, early);
    expect((await tick(early)).data.idle).toBe('outside_hours');
    expect(await followJobs(id)).toHaveLength(0);
  });

  it('waits the full follow up time', async () => {
    const { id } = await recommended();
    const now = nextAfternoon();
    await quiet(id, now, { outAgo: 5, inAgo: 5.5 });
    await tick(now);
    expect(await followJobs(id)).toHaveLength(0);
    expect((await conv(id)).followup_status).toBeNull();
  });

  it('skips a paused chat', async () => {
    const { id } = await recommended();
    const now = nextAfternoon();
    await quiet(id, now);
    await sql('UPDATE conversations SET paused_until = ? WHERE id = ?', [now + HOUR, id]);
    await tick(now);
    expect(await followJobs(id)).toHaveLength(0);
  });

  it('skips someone who opted out, for good', async () => {
    const { id } = await recommended();
    const now = nextAfternoon();
    await quiet(id, now);
    const c = await conv(id);
    await sql('UPDATE contacts SET opted_out = 1 WHERE id = ?', [c.contact_id]);
    const res = await tick(now);
    expect(res.data.skipped).toContainEqual({ id, reason: 'opted_out' });
    expect(await followJobs(id)).toHaveLength(0);
    expect((await conv(id)).followup_status).toBe('skipped_opted_out');
  });

  it('never messages outside the WhatsApp 24 hour window', async () => {
    const { id } = await recommended();
    const now = nextAfternoon();
    await quiet(id, now, { outAgo: 22, inAgo: 23.5 });
    const res = await tick(now);
    expect(res.data.skipped).toContainEqual({ id, reason: 'whatsapp_window' });
    expect(await followJobs(id)).toHaveLength(0);
    expect((await conv(id)).followup_status).toBe('skipped_whatsapp_window');
  });

  it('skips a chat the owner took over', async () => {
    const { id } = await recommended();
    const now = nextAfternoon();
    await sql(`INSERT INTO messages (id, conversation_id, direction, author, body, kind, status, ts, created_at) VALUES (?, ?, 'out', 'owner', 'ill sort it mate', 'text', 'sent', ?, ?)`,
      [unique('m'), id, Date.now() + 1000, Date.now() + 1000]);
    await quiet(id, now);
    const res = await tick(now);
    expect(res.data.skipped).toContainEqual({ id, reason: 'owner_took_over' });
    expect(await followJobs(id)).toHaveLength(0);
  });

  it('makes a draft when the channel asks first, and nothing when it is off', async () => {
    const a = await recommended();
    const b = await recommended();
    const now = nextAfternoon();
    await quiet(a.id, now);
    await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'off' } } });
    try {
      // WhatsApp off: its chats are not even read (Gmail and TikTok are still on).
      expect((await tick(now)).data.checked).toBe(0);
      expect(await followJobs(a.id)).toHaveLength(0);
      await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'review' } } });
      const res = await tick(now);
      expect(res.data.drafts).toBe(1);
      const jobs = await followJobs(a.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('review');
      expect((await conv(a.id)).followup_status).toBe('draft');
    } finally {
      await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' } } });
    }
    // Follow ups switched off: nothing at all.
    await quiet(b.id, now + 4 * DAY);
    await api('/api/sales/settings', { method: 'PUT', body: { follow_ups: false } });
    try {
      expect((await tick(now + 4 * DAY)).data.idle).toBe('follow_ups_off');
    } finally {
      await api('/api/sales/settings', { method: 'PUT', body: { follow_ups: true } });
    }
  });

  it('cancels a waiting follow up when the customer writes again', async () => {
    const { id, thread, phone } = await recommended();
    const now = nextAfternoon();
    await quiet(id, now);
    await tick(now);
    const [job] = await followJobs(id);
    expect(job.status).toBe('pending');
    const msgs = (await sql('SELECT external_id, direction, body FROM messages WHERE conversation_id = ? ORDER BY ts', [id])).data.results;
    await inbound('whatsapp', thread, [...msgs.map((m: any) => ({ external_id: m.external_id, direction: m.direction, body: m.body })), { external_id: unique('m'), direction: 'in', body: 'is the battery included' }], { contact: { name: 'Jake', phone } });
    expect((await followJobs(id))[0].status).toBe('cancelled');
  });
});

describe('orders matched to chats', () => {
  it('matches an order by phone, marks the chat bought and counts it as a sale from chat', async () => {
    const p = newPhone();
    const { id } = await recommended('shop-ready how do i order', p.e164);
    const orderId = Date.now();
    expect(await hook('orders/create', {
      id: orderId, created_at: new Date().toISOString(), shipping_address: { phone: p.national, country_code: 'GB' },
      total_price: '595.00', currency: 'GBP', total_price_set: { shop_money: { amount: '595.00', currency_code: 'GBP' } },
    })).toBe(200);
    const c = await conv(id);
    expect(c.sales_stage).toBe('bought');
    expect(c.bought_at).toBeGreaterThan(0);
    expect(c.order_total).toBe(595);
    expect(c.followup_status).toBe('skipped_bought');
    const sale = (await sql('SELECT * FROM sales_conversions WHERE order_ref = ?', [`order:${orderId}`])).data.results[0];
    expect(sale).toMatchObject({ conversation_id: id, from_chat: 1, matched_by: 'phone', total: 595, currency: 'GBP' });

    // The same purchase arriving again (redelivery, or the completed checkout from the daily pull) is not counted twice.
    await hook('orders/create', { id: orderId, created_at: new Date().toISOString(), phone: p.e164 });
    await hook('checkouts/update', { token: unique('tok'), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), completed_at: new Date().toISOString(),
      total_price: '595.00', currency: 'GBP', shipping_address: { phone: p.national, country_code: 'GB' } });
    expect((await sql('SELECT COUNT(*) AS n FROM sales_conversions WHERE conversation_id = ?', [id])).data.results[0].n).toBe(1);

    // A bought customer never gets the follow up.
    const now = nextAfternoon();
    await quiet(id, now);
    await tick(now);
    expect(await followJobs(id)).toHaveLength(0);
  });

  it('matches by email, and does not count it from chat when the agent last wrote more than 14 days before', async () => {
    const email = `${unique('buyer')}@example.com`;
    const r = await inbound('gmail', unique('thread'), [{ external_id: 'g1', direction: 'in', body: 'Hello, which kit fits a 29 inch wheel?' }], { subject: 'Kit', contact: { name: 'Pat', email } });
    expect(r.action).toBe('review');
    const draft = (await api('/api/urgent')).data.review.find((x: any) => x.conversation_id === r.conversation_id);
    await api(`/api/review/${draft.id}/approve`, { body: {} });
    await sql(`INSERT INTO messages (id, conversation_id, direction, author, body, kind, status, ts, created_at) VALUES (?, ?, 'out', 'agent', 'Hi Pat', 'text', 'sent', ?, ?)`,
      [unique('m'), r.conversation_id, Date.now() - 20 * DAY, Date.now() - 20 * DAY]);
    await sql(`DELETE FROM messages WHERE conversation_id = ? AND author = 'agent' AND ts > ?`, [r.conversation_id, Date.now() - 15 * DAY]);
    const orderId = Date.now() + 7;
    await hook('orders/create', { id: orderId, created_at: new Date().toISOString(), email: email.toUpperCase(), total_price: '250.00', currency: 'GBP' });
    const sale = (await sql('SELECT * FROM sales_conversions WHERE order_ref = ?', [`order:${orderId}`])).data.results[0];
    expect(sale).toMatchObject({ conversation_id: r.conversation_id, matched_by: 'email', from_chat: 0 });
    expect((await conv(r.conversation_id!)).sales_stage).toBe('bought');
  });

  it('ignores an order from someone who never chatted', async () => {
    const orderId = Date.now() + 11;
    expect(await hook('orders/create', { id: orderId, created_at: new Date().toISOString(), email: `${unique('nobody')}@example.com`, phone: newPhone().e164 })).toBe(200);
    expect((await sql('SELECT COUNT(*) AS n FROM sales_conversions WHERE order_ref = ?', [`order:${orderId}`])).data.results[0].n).toBe(0);
  });
});

describe('sales endpoint', () => {
  it('returns the funnel, hot leads, follow ups and settings', async () => {
    const { id } = await recommended('shop-ready ok im in');
    const res = await api('/api/sales');
    expect(res.status).toBe(200);
    const [d7, d30] = res.data.funnel;
    expect(d7.days).toBe(7);
    expect(d30.days).toBe(30);
    for (const k of ['chats', 'interested', 'ready', 'bought', 'revenue']) expect(typeof d7[k]).toBe('number');
    expect(d7.chats).toBeGreaterThan(0);
    expect(d7.interested).toBeGreaterThanOrEqual(d7.ready);
    expect(d7.ready).toBeGreaterThan(0);
    expect(d7.bought).toBeGreaterThan(0);
    expect(d30.revenue).toBeGreaterThanOrEqual(595);
    const lead = res.data.leads.find((l: any) => l.conversation_id === id);
    expect(lead).toMatchObject({ stage: 'ready', product: 'ACX 2000w bundle', link: LINK, channel: 'whatsapp' });
    expect(res.data.leads[0].stage).toBe('ready');
    expect(res.data.followups.map((f: any) => f.days)).toEqual([7, 30]);
    expect(res.data.settings).toEqual({ follow_ups: true, follow_up_hours: 20, style: 'friendly' });
    expect(res.queries).toBeLessThan(20);
  });

  it('saves and checks the sales settings', async () => {
    expect((await api('/api/sales/settings', { method: 'PUT', body: { follow_up_hours: 24, style: 'keen' } })).data.settings).toEqual({ follow_ups: true, follow_up_hours: 24, style: 'keen' });
    expect((await api('/api/sales/settings', { method: 'PUT', body: { follow_up_hours: 0 } })).status).toBe(400);
    expect((await api('/api/sales/settings', { method: 'PUT', body: { style: 'pushy' } })).status).toBe(400);
    expect((await api('/api/sales', { as: 'public' })).status).toBe(401);
    await api('/api/sales/settings', { method: 'PUT', body: { follow_up_hours: 20, style: 'friendly' } });
  });
});
