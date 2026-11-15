// Turns Shopify's two shapes of a checkout (Admin API node, webhook payload) into one row shape and
// keeps the checkouts table up to date. Used by the webhook route and by the daily recovery run.
import type { CheckoutRow } from '../types';
import { all, one, stmt } from '../lib/db';
import type { AbandonedCheckoutNode } from './client';
import { toE164 } from './phone';

export interface NormalCheckout {
  id: string;
  token: string | null;
  name: string;
  first_name: string | null;
  email: string | null;
  phone_raw: string | null;
  phone_e164: string | null;
  country: string | null;
  total: string | null;
  currency: string | null;
  items: { title: string; quantity: number }[];
  recovery_url: string | null;
  created_at_shop: number | null;
  updated_at_shop: number | null;
  completed_at: number | null;
  consent_sms: boolean;
  consent_email: boolean;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const time = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const upper = (v: unknown): string | null => text(v)?.toUpperCase() ?? null;

/** "499.0" becomes "499.00". Anything that is not a number is passed through untouched. */
function money(v: unknown): string | null {
  const s = typeof v === 'number' ? String(v) : text(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n.toFixed(2) : s;
}

interface PhoneCandidate { raw: string | null; country: string | null }

/**
 * First number that normalises wins. Order: shipping address, billing address, then the contact or
 * customer number. Each is read with the country of the address it came from.
 */
function pickPhone(candidates: PhoneCandidate[], fallbackCountry: string | null, defaultCountry: string): { raw: string | null; e164: string | null; country: string | null } {
  let firstRaw: string | null = null;
  for (const c of candidates) {
    if (!c.raw) continue;
    firstRaw ??= c.raw;
    const e164 = toE164(c.raw, c.country ?? fallbackCountry, defaultCountry);
    if (e164) return { raw: c.raw, e164, country: c.country ?? fallbackCountry };
  }
  return { raw: firstRaw, e164: null, country: fallbackCountry };
}

/** Admin API node to row shape. The id is the numeric tail of the gid. */
export function fromApiNode(node: AbandonedCheckoutNode, defaultCountry: string): NormalCheckout {
  const ship = node.shippingAddress;
  const bill = node.billingAddress;
  const customer = node.customer;
  const addressCountry = upper(ship?.countryCodeV2) ?? upper(bill?.countryCodeV2);
  const phone = pickPhone(
    [
      { raw: text(ship?.phone), country: upper(ship?.countryCodeV2) },
      { raw: text(bill?.phone), country: upper(bill?.countryCodeV2) },
      { raw: text(customer?.defaultPhoneNumber?.phoneNumber), country: null },
    ],
    addressCountry, defaultCountry,
  );
  const price = node.totalPriceSet?.presentmentMoney ?? node.totalPriceSet?.shopMoney ?? null;
  const subscribed = (s: string | null | undefined) => s === 'SUBSCRIBED';
  return {
    id: node.id.split('/').pop() || node.id,
    token: null,
    name: text(node.name) ?? '',
    first_name: text(ship?.firstName) ?? text(bill?.firstName) ?? text(customer?.firstName),
    email: text(customer?.defaultEmailAddress?.emailAddress)?.toLowerCase() ?? null,
    phone_raw: phone.raw,
    phone_e164: phone.e164,
    country: addressCountry ?? phone.country,
    total: money(price?.amount),
    currency: upper(price?.currencyCode),
    items: (node.lineItems?.nodes ?? []).filter((i) => i?.title).map((i) => ({ title: i.title!.trim(), quantity: i.quantity || 1 })),
    recovery_url: text(node.abandonedCheckoutUrl),
    created_at_shop: time(node.createdAt),
    updated_at_shop: time(node.updatedAt) ?? time(node.createdAt),
    completed_at: time(node.completedAt),
    // A WhatsApp or SMS opt in recorded on the customer both count as "accepted marketing by phone".
    consent_sms: subscribed(customer?.defaultPhoneNumber?.smsMarketingConsent?.state) || subscribed(customer?.defaultPhoneNumber?.whatsAppMarketingConsent?.state),
    consent_email: subscribed(customer?.defaultEmailAddress?.marketingState),
  };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});

/** Webhook payload (checkouts/create, checkouts/update) to row shape. Null when it has no usable key. */
export function fromWebhook(payload: Obj, defaultCountry: string): NormalCheckout | null {
  // Since API version 2026-04 the payload has no id, only the token.
  const token = text(payload.token);
  const id = token ?? (payload.id !== undefined && payload.id !== null ? String(payload.id) : null);
  if (!id) return null;
  const ship = obj(payload.shipping_address);
  const bill = obj(payload.billing_address);
  const customer = obj(payload.customer);
  const customerAddress = obj(customer.default_address);
  const addressCountry = upper(ship.country_code) ?? upper(bill.country_code);
  const phone = pickPhone(
    [
      { raw: text(ship.phone), country: upper(ship.country_code) },
      { raw: text(bill.phone), country: upper(bill.country_code) },
      { raw: text(payload.phone), country: null },
      { raw: text(payload.sms_marketing_phone), country: null },
      { raw: text(customer.phone), country: null },
      { raw: text(customerAddress.phone), country: upper(customerAddress.country_code) },
    ],
    addressCountry, defaultCountry,
  );
  const lines = Array.isArray(payload.line_items) ? payload.line_items : [];
  return {
    id,
    token,
    name: text(payload.name) ?? '',
    first_name: text(ship.first_name) ?? text(bill.first_name) ?? text(customer.first_name),
    email: (text(payload.email) ?? text(customer.email))?.toLowerCase() ?? null,
    phone_raw: phone.raw,
    phone_e164: phone.e164,
    country: addressCountry ?? phone.country,
    total: money(payload.total_price),
    currency: upper(payload.presentment_currency) ?? upper(payload.currency),
    items: lines.map((l) => obj(l)).filter((l) => text(l.title)).map((l) => ({ title: text(l.title)!, quantity: Number(l.quantity) || 1 })),
    recovery_url: text(payload.abandoned_checkout_url),
    created_at_shop: time(payload.created_at),
    updated_at_shop: time(payload.updated_at) ?? time(payload.created_at),
    completed_at: time(payload.completed_at),
    consent_sms: payload.buyer_accepts_sms_marketing === true,
    consent_email: payload.buyer_accepts_marketing === true,
  };
}

/** The recovery link without its query string, which is how an API row and a webhook row of one checkout line up. */
function linkKey(url: string | null): string | null {
  if (!url) return null;
  const cut = url.split('?')[0]!;
  return cut.length > 12 ? cut : null;
}

/** The statements that mark a checkout bought: a waiting reminder is cancelled, the row becomes recovered. */
function completedStatements(db: D1Database, row: Pick<CheckoutRow, 'id' | 'status' | 'outbox_id'>, completedAt: number, now: number): D1PreparedStatement[] {
  const list: D1PreparedStatement[] = [];
  if (row.status === 'queued' && row.outbox_id) list.push(stmt(db, `UPDATE outbox SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'review')`, row.outbox_id));
  list.push(stmt(db, `UPDATE checkouts SET completed_at = COALESCE(completed_at, ?), status = 'recovered', updated_at = ? WHERE id = ?`, completedAt, now, row.id));
  return list;
}

/**
 * The customer finished buying. A waiting message is cancelled so they are never chased, and the
 * row becomes "recovered" (counted as a win only when we had already messaged them).
 */
export async function markCompleted(db: D1Database, row: Pick<CheckoutRow, 'id' | 'status' | 'outbox_id'>, completedAt: number): Promise<void> {
  await db.batch(completedStatements(db, row, completedAt, Date.now()));
}

/** The row this checkout already has here, by id, then token, then the recovery link (webhook token against API id). */
async function findExisting(db: D1Database, c: NormalCheckout): Promise<CheckoutRow | null> {
  let existing = await one<CheckoutRow>(db, 'SELECT * FROM checkouts WHERE id = ?', c.id);
  if (!existing && c.token) existing = await one<CheckoutRow>(db, 'SELECT * FROM checkouts WHERE token = ?', c.token);
  if (!existing) {
    const key = linkKey(c.recovery_url);
    // (Compared with substr, not LIKE: D1 refuses LIKE patterns longer than 50 bytes.)
    if (key) existing = await one<CheckoutRow>(db, `SELECT * FROM checkouts WHERE recovery_url = ? OR substr(recovery_url, 1, ?) = ? LIMIT 1`, key, key.length + 1, `${key}?`);
  }
  return existing;
}

/** What to write for one checkout, given the row it already has (or null). Nothing is run here. */
function upsertStatements(db: D1Database, c: NormalCheckout, source: 'api' | 'webhook', existing: CheckoutRow | null, now: number): { result: 'inserted' | 'updated' | 'stale'; statements: D1PreparedStatement[] } {
  if (!existing) {
    return {
      result: 'inserted',
      statements: [stmt(
        db,
        `INSERT INTO checkouts (id, token, name, first_name, email, phone_raw, phone_e164, country, total, currency, items, recovery_url,
           created_at_shop, updated_at_shop, completed_at, consent_sms, consent_email, source, status, first_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        c.id, c.token, c.name, c.first_name, c.email, c.phone_raw, c.phone_e164, c.country, c.total, c.currency, JSON.stringify(c.items),
        c.recovery_url, c.created_at_shop, c.updated_at_shop, c.completed_at, c.consent_sms ? 1 : 0, c.consent_email ? 1 : 0, source,
        c.completed_at ? 'recovered' : 'new', now, now,
      )],
    };
  }
  const statements: D1PreparedStatement[] = [];
  // Webhooks can arrive out of order: an older snapshot never overwrites a newer one.
  const stale = existing.updated_at_shop !== null && c.updated_at_shop !== null && c.updated_at_shop < existing.updated_at_shop;
  if (!stale) {
    statements.push(stmt(
      db,
      `UPDATE checkouts SET token = COALESCE(?, token), name = ?, first_name = COALESCE(?, first_name), email = COALESCE(?, email),
         phone_raw = COALESCE(?, phone_raw), phone_e164 = COALESCE(?, phone_e164), country = COALESCE(?, country),
         total = COALESCE(?, total), currency = COALESCE(?, currency), items = ?, recovery_url = COALESCE(?, recovery_url),
         created_at_shop = COALESCE(created_at_shop, ?), updated_at_shop = COALESCE(?, updated_at_shop),
         consent_sms = MAX(consent_sms, ?), consent_email = MAX(consent_email, ?), updated_at = ?
       WHERE id = ?`,
      c.token, c.name || existing.name, c.first_name, c.email, c.phone_raw, c.phone_e164, c.country, c.total, c.currency,
      c.items.length ? JSON.stringify(c.items) : existing.items, c.recovery_url, c.created_at_shop, c.updated_at_shop,
      c.consent_sms ? 1 : 0, c.consent_email ? 1 : 0, now, existing.id,
    ));
  }
  // Completion is a one way fact, so it is applied even from an out of order delivery.
  if (c.completed_at && !existing.completed_at) statements.push(...completedStatements(db, existing, c.completed_at, now));
  return { result: stale ? 'stale' : 'updated', statements };
}

/** Insert or refresh one checkout. Returns what happened so callers can count. */
export async function upsertCheckout(db: D1Database, c: NormalCheckout, source: 'api' | 'webhook'): Promise<'inserted' | 'updated' | 'stale'> {
  const plan = upsertStatements(db, c, source, await findExisting(db, c), Date.now());
  if (plan.statements.length) await db.batch(plan.statements);
  return plan.result;
}

/**
 * Insert or refresh many checkouts (the daily pull from the Admin API) in two D1 round trips: one
 * read of the rows they may already have, one batch of writes. The free plan allows 50 queries per run.
 */
export async function upsertCheckouts(db: D1Database, list: NormalCheckout[], source: 'api' | 'webhook', since: number): Promise<void> {
  if (!list.length) return;
  const keys = JSON.stringify([...new Set(list.flatMap((c) => [c.id, c.token]).filter((x): x is string => Boolean(x)))]);
  const rows = await all<CheckoutRow>(
    db,
    `SELECT * FROM checkouts WHERE id IN (SELECT value FROM json_each(?)) OR token IN (SELECT value FROM json_each(?))
       OR COALESCE(created_at_shop, first_seen_at) >= ?`,
    keys, keys, since,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byToken = new Map(rows.filter((r) => r.token).map((r) => [r.token!, r]));
  const byLink = new Map<string, CheckoutRow>();
  for (const r of rows) { const k = linkKey(r.recovery_url); if (k && !byLink.has(k)) byLink.set(k, r); }
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const c of list) {
    const key = linkKey(c.recovery_url);
    const existing = byId.get(c.id) ?? (c.token ? byToken.get(c.token) : undefined) ?? (key ? byLink.get(key) : undefined) ?? null;
    statements.push(...upsertStatements(db, c, source, existing, now).statements);
  }
  if (statements.length) await db.batch(statements);
}

/**
 * An order was placed (orders/create webhook). Find the checkout it came from: by checkout token,
 * then cart token inside the recovery link, then any open checkout from the same phone or email
 * (the customer may have started again from scratch). Returns how many rows were closed.
 */
export async function recordOrder(db: D1Database, order: Obj, defaultCountry: string): Promise<number> {
  const at = time(order.created_at) ?? Date.now();
  const open = `status IN ('new', 'queued', 'messaged', 'skipped', 'failed', 'expired') AND completed_at IS NULL`;
  const matched = new Map<string, Pick<CheckoutRow, 'id' | 'status' | 'outbox_id'>>();
  const add = (rows: Pick<CheckoutRow, 'id' | 'status' | 'outbox_id'>[]) => { for (const r of rows) matched.set(r.id, r); };
  const find = async (where: string, ...params: (string | number)[]) =>
    (await db.prepare(`SELECT id, status, outbox_id FROM checkouts WHERE ${open} AND (${where}) LIMIT 20`).bind(...params).all<Pick<CheckoutRow, 'id' | 'status' | 'outbox_id'>>()).results ?? [];

  const checkoutToken = text(order.checkout_token);
  if (checkoutToken) add(await find('token = ? OR id = ?', checkoutToken, checkoutToken));
  const cartToken = text(order.cart_token);
  if (cartToken && cartToken.length >= 8) add(await find('instr(recovery_url, ?) > 0', `/${cartToken}/`));

  const ship = obj(order.shipping_address);
  const bill = obj(order.billing_address);
  const country = upper(ship.country_code) ?? upper(bill.country_code);
  for (const raw of [text(order.phone), text(ship.phone), text(bill.phone)]) {
    const e164 = toE164(raw, country, defaultCountry);
    if (e164) add(await find('phone_e164 = ? AND COALESCE(created_at_shop, first_seen_at) <= ?', e164, at));
  }
  const email = (text(order.email) ?? text(order.contact_email))?.toLowerCase();
  if (email) add(await find('email = ? AND COALESCE(created_at_shop, first_seen_at) <= ?', email, at));

  for (const row of matched.values()) await markCompleted(db, row, at);
  return matched.size;
}
