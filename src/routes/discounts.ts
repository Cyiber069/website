// Owner facing API for the Discount codes screen: codes made for creators and sponsorship requests,
// made in Shopify when the API is connected, and a message to the customer in the same chat.
import type { Channel, ContactRow, ConversationRow } from '../types';
import { all, one, run, uid } from '../lib/db';
import { logEvent } from '../lib/events';
import { HttpError, bad, bool, json, notFound, str, type Ctx, type Router } from '../lib/http';
import { DAY, londonDateTimeToTs } from '../lib/time';
import { emptyTarget, enqueue } from '../pipeline/outbox';
import { hasApiCredentials } from '../shopify/client';
import { createShopifyDiscount, type DiscountResult } from '../shopify/discounts';

export const DEFAULT_AMOUNT = 20;
export const DEFAULT_APPLIES_TO = 'kits, bundles and batteries';
const MAX_MESSAGE_CHARS = 1000;

export interface DiscountRow {
  id: string; conversation_id: string | null; contact_id: string | null; contact_name: string; channel: Channel;
  code: string; amount: number; currency: string; applies_to: string; expires_at: number | null; usage_limit: number | null;
  shopify_id: string | null; shopify_status: string; message_text: string; outbox_id: string | null;
  status: 'draft' | 'live' | 'sent' | 'failed'; error: string | null; created_at: number; updated_at: number;
}

/** £20, or £12.50 when there are pence. */
export const pounds = (amount: number) => `£${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;

/** The message the owner sees first. Never contains a dash. */
export function defaultMessage(code: string, amount: number, appliesTo: string): string {
  return `Your discount code ${code} is now live!! It's ${pounds(amount)} off all ${appliesTo || DEFAULT_APPLIES_TO}`;
}

function codeOf(v: unknown): string {
  const code = str(v, 'code', { max: 60 }).toUpperCase();
  if (!/^[A-Z0-9]{3,30}$/.test(code)) throw bad('invalid_code', 'The code should be 3 to 30 letters or numbers, with no spaces or symbols.', { field: 'code' });
  return code;
}

function amountOf(v: unknown): number {
  const n = v === undefined || v === null || v === '' ? DEFAULT_AMOUNT : typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 500) throw bad('invalid_amount', 'The amount should be between £1 and £500.', { field: 'amount' });
  return Math.round(n * 100) / 100;
}

function expiryOf(v: unknown, now: number): number | null {
  if (v === undefined || v === null || v === '') return null;
  let ts: number;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ts = londonDateTimeToTs(v, 23, 59);
  else if (typeof v === 'number') ts = v;
  else throw bad('invalid_expiry', 'Pick the last day the code works.', { field: 'expires_at' });
  if (!Number.isFinite(ts) || ts <= now) throw bad('invalid_expiry', 'The last day should be in the future.', { field: 'expires_at' });
  return ts;
}

function usageOf(v: unknown): number | null {
  if (v === undefined || v === null || v === '' || v === 0) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 100000) throw bad('invalid_usage_limit', 'How many times it can be used should be a whole number from 1, or left empty for no limit.', { field: 'usage_limit' });
  return n;
}

const OUTBOX_DONE_BAD = ['failed', 'expired', 'cancelled'];

/** The row as the screen sees it, with the message status read from the outbox. Saves a change of status. */
async function view(db: D1Database, rows: DiscountRow[]) {
  const ids = rows.map((r) => r.outbox_id).filter((x): x is string => Boolean(x));
  const outbox = new Map<string, { status: string; last_error: string | null; sent_at: number | null }>();
  if (ids.length) {
    const found = await all<{ id: string; status: string; last_error: string | null; sent_at: number | null }>(
      db, `SELECT id, status, last_error, sent_at FROM outbox WHERE id IN (${ids.map(() => '?').join(', ')})`, ...ids,
    );
    for (const o of found) outbox.set(o.id, o);
  }
  const now = Date.now();
  const out = [];
  for (const r of rows) {
    const o = r.outbox_id ? outbox.get(r.outbox_id) : undefined;
    let status = r.status;
    let error = r.error;
    if (o?.status === 'sent') status = 'sent';
    else if (o && OUTBOX_DONE_BAD.includes(o.status)) {
      status = 'failed';
      error = o.status === 'expired' ? 'The laptop did not send it within a day.' : o.status === 'cancelled' ? 'The message was cancelled.' : `The laptop could not send it${o.last_error ? ` (${o.last_error.split(':')[0]!.replace(/_/g, ' ')})` : ''}.`;
    } else if (o && status === 'failed') {
      status = r.shopify_status === 'created' || r.shopify_status === 'owner_confirmed' ? 'live' : 'draft';
      error = null;
    }
    if (status !== r.status || error !== r.error) {
      await run(db, 'UPDATE discount_codes SET status = ?, error = ?, updated_at = ? WHERE id = ?', status, error, now, r.id);
    }
    out.push({
      id: r.id, conversation_id: r.conversation_id, contact_id: r.contact_id, customer: r.contact_name || 'Customer', channel: r.channel,
      code: r.code, amount: r.amount, currency: r.currency, applies_to: r.applies_to, expires_at: r.expires_at, usage_limit: r.usage_limit,
      shopify_id: r.shopify_id, shopify_status: r.shopify_status, message_text: r.message_text, outbox_id: r.outbox_id,
      message_status: o?.status ?? null, sent_at: o?.sent_at ?? null,
      status, error, created_at: r.created_at, updated_at: r.updated_at,
    });
  }
  return out;
}

async function load(db: D1Database, id: string): Promise<DiscountRow> {
  const row = await one<DiscountRow>(db, 'SELECT * FROM discount_codes WHERE id = ?', id);
  if (!row) throw notFound('discount_not_found');
  return row;
}

const isLive = (row: DiscountRow) => row.shopify_status === 'created' || row.shopify_status === 'owner_confirmed';

/** Queue the message in the customer's own chat. Exactly one live job per discount. */
async function sendMessage(c: Ctx, row: DiscountRow, text: string): Promise<{ outbox_id: string; already: boolean }> {
  const db = c.db;
  if (!row.conversation_id) throw bad('no_conversation', 'This code is not linked to a chat any more, so there is nowhere to send the message.');
  const conv = await one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', row.conversation_id);
  if (!conv) throw bad('no_conversation', 'The chat for this code is not here any more, so there is nowhere to send the message.');
  const contact = await one<ContactRow>(db, 'SELECT * FROM contacts WHERE id = ?', conv.contact_id);
  const dedupe = `discount:${row.id}`;
  const existing = await one<{ id: string; status: string }>(db, 'SELECT id, status FROM outbox WHERE dedupe_key = ?', dedupe);
  if (existing && !OUTBOX_DONE_BAD.includes(existing.status)) return { outbox_id: existing.id, already: true };
  // A message that failed may be sent again: the old job gives up its key so the new one can take it.
  if (existing) await run(db, 'UPDATE outbox SET dedupe_key = NULL WHERE id = ?', existing.id);
  const id = await enqueue(db, {
    channel: conv.channel, kind: 'reply', conversation_id: conv.id, source: 'manual', ref_id: row.id, dedupe_key: dedupe,
    target: emptyTarget({
      thread_external_id: conv.external_thread_id, title: conv.title || contact?.display_name || null,
      phone: contact?.phone ?? null, email: contact?.email ?? null, handle: contact?.handle ?? null, subject: conv.subject,
    }),
    // The owner's own words, sent as written. Not run through the style sanitizer.
    parts: [text], expires_at: c.now + DAY, pacing: { delay_ms: 500, typing_cps: 30 },
  });
  if (!id) {
    const again = await one<{ id: string }>(db, 'SELECT id FROM outbox WHERE dedupe_key = ?', dedupe);
    if (again) return { outbox_id: again.id, already: true };
    throw new HttpError(409, 'not_queued', 'The message was not queued. Try again.');
  }
  return { outbox_id: id, already: false };
}

function shopifyLine(res: DiscountResult | null) {
  return res ? { ok: res.ok, status: res.shopify_status, error_code: res.error_code ?? null, message: res.message ?? null, discount_status: res.discount_status ?? null } : null;
}

export function register(r: Router): void {
  r.get('/api/discounts', 'owner', async (c) => {
    const rows = await all<DiscountRow>(c.db, 'SELECT * FROM discount_codes ORDER BY created_at DESC LIMIT 200');
    return json({
      discounts: await view(c.db, rows),
      shopify: { connected: await hasApiCredentials(c.db) },
      defaults: { amount: DEFAULT_AMOUNT, currency: 'GBP', applies_to: DEFAULT_APPLIES_TO, message: defaultMessage('{CODE}', DEFAULT_AMOUNT, DEFAULT_APPLIES_TO) },
    });
  });

  // Make a code. With send: true the message goes too, but only once the code is live
  // (made in Shopify, or confirm_exists: true when the owner made it in Shopify by hand).
  r.post('/api/discounts', 'owner', async (c) => {
    const body = await c.body<Record<string, unknown>>();
    const conversationId = str(body.conversation_id, 'conversation_id', { max: 80 });
    const code = codeOf(body.code);
    const amount = amountOf(body.amount);
    const appliesTo = str(body.applies_to, 'applies_to', { max: 120, optional: true }) || DEFAULT_APPLIES_TO;
    const expiresAt = expiryOf(body.expires_at, c.now);
    const usageLimit = usageOf(body.usage_limit);
    const text = str(body.message_text, 'message_text', { max: MAX_MESSAGE_CHARS, optional: true }) || defaultMessage(code, amount, appliesTo);
    const send = bool(body.send, false);
    const confirmExists = bool(body.confirm_exists, false);

    const conv = await one<ConversationRow>(c.db, 'SELECT * FROM conversations WHERE id = ?', conversationId);
    if (!conv) throw bad('conversation_not_found', 'Pick the customer from one of your chats.', { field: 'conversation_id' });
    const contact = await one<ContactRow>(c.db, 'SELECT * FROM contacts WHERE id = ?', conv.contact_id);
    if (await one(c.db, 'SELECT id FROM discount_codes WHERE code = ?', code)) {
      throw new HttpError(409, 'code_taken', `You already made the code ${code}. Pick another one.`, { field: 'code' });
    }

    const id = uid('dc');
    const name = contact?.display_name || conv.title || 'Customer';
    await run(
      c.db,
      `INSERT INTO discount_codes (id, conversation_id, contact_id, contact_name, channel, code, amount, currency, applies_to, expires_at, usage_limit,
         shopify_status, message_text, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'GBP', ?, ?, ?, 'not_connected', ?, 'draft', ?, ?)`,
      id, conv.id, contact?.id ?? null, name, conv.channel, code, amount, appliesTo, expiresAt, usageLimit, text, c.now, c.now,
    );

    const shopify = await createShopifyDiscount(c.env, { code, amount, title: `${code} for ${name}`.slice(0, 250), starts_at: c.now, expires_at: expiresAt, usage_limit: usageLimit });
    const shopifyStatus = shopify.ok ? 'created' : confirmExists ? 'owner_confirmed' : shopify.shopify_status;
    const status = shopify.ok || confirmExists ? 'live' : 'draft';
    await run(
      c.db, 'UPDATE discount_codes SET shopify_id = ?, shopify_status = ?, status = ?, error = ?, updated_at = ? WHERE id = ?',
      shopify.shopify_id ?? null, shopifyStatus, status, shopify.ok || confirmExists ? null : shopify.message ?? null, c.now, id,
    );
    await logEvent(c.db, {
      level: shopify.ok ? 'good' : 'info', type: 'discount', channel: conv.channel, conversation_id: conv.id,
      message: shopify.ok ? `Discount code ${code} made in Shopify for ${name}.` : `Discount code ${code} saved for ${name}. Not made in Shopify: ${shopify.message ?? 'unknown reason'}`,
    });

    let queued: { outbox_id: string; already: boolean } | null = null;
    const row = await load(c.db, id);
    if (send && isLive(row)) {
      queued = await sendMessage(c, row, text);
      await run(c.db, 'UPDATE discount_codes SET outbox_id = ?, updated_at = ? WHERE id = ?', queued.outbox_id, c.now, id);
    }
    const [discount] = await view(c.db, [await load(c.db, id)]);
    return json({
      discount, shopify: shopifyLine(shopify), queued: Boolean(queued),
      // True when the message is waiting for the owner to say the code exists in Shopify.
      needs_confirm: !isLive(row),
    }, 201);
  });

  // Send (or send again after a failure). When the code is not live yet the owner must confirm it
  // exists in Shopify, or Shopify is tried again first.
  r.post('/api/discounts/:id/send', 'owner', async (c) => {
    const body = await c.body<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    let row = await load(c.db, c.params.id!);
    const text = str(body.message_text, 'message_text', { max: MAX_MESSAGE_CHARS, optional: true }) || row.message_text || defaultMessage(row.code, row.amount, row.applies_to);
    const confirmExists = bool(body.confirm_exists, false);
    let shopify: DiscountResult | null = null;
    if (!isLive(row)) {
      if (confirmExists) {
        await run(c.db, `UPDATE discount_codes SET shopify_status = 'owner_confirmed', status = 'live', error = NULL, updated_at = ? WHERE id = ?`, c.now, row.id);
      } else {
        shopify = await createShopifyDiscount(c.env, {
          code: row.code, amount: row.amount, title: `${row.code} for ${row.contact_name || 'Customer'}`.slice(0, 250),
          starts_at: c.now, expires_at: row.expires_at && row.expires_at > c.now ? row.expires_at : null, usage_limit: row.usage_limit,
        });
        if (!shopify.ok) {
          await run(c.db, 'UPDATE discount_codes SET shopify_status = ?, error = ?, updated_at = ? WHERE id = ?', shopify.shopify_status, shopify.message ?? null, c.now, row.id);
          throw new HttpError(409, 'needs_confirm', shopify.message ?? 'The code is not in Shopify yet. Make it there, then confirm it exists.', { shopify: shopifyLine(shopify) });
        }
        await run(c.db, `UPDATE discount_codes SET shopify_id = ?, shopify_status = 'created', status = 'live', error = NULL, updated_at = ? WHERE id = ?`, shopify.shopify_id ?? null, c.now, row.id);
      }
      row = await load(c.db, row.id);
    }
    const queued = await sendMessage(c, row, text);
    await run(c.db, 'UPDATE discount_codes SET outbox_id = ?, message_text = ?, updated_at = ? WHERE id = ?', queued.outbox_id, queued.already ? row.message_text : text, c.now, row.id);
    const [discount] = await view(c.db, [await load(c.db, row.id)]);
    return json({ ok: true, discount, already_queued: queued.already, shopify: shopifyLine(shopify) });
  });

  // Only drafts go: a live code may already be in a customer's hands.
  r.delete('/api/discounts/:id', 'owner', async (c) => {
    const row = await load(c.db, c.params.id!);
    if (row.status !== 'draft' || row.outbox_id) {
      throw new HttpError(409, 'not_a_draft', 'Only drafts can be removed here. A live code is turned off in Shopify under Discounts.');
    }
    await run(c.db, 'DELETE FROM discount_codes WHERE id = ?', row.id);
    return json({ ok: true });
  });
}
