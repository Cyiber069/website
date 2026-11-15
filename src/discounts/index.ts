// Discount codes: the one code path that saves a code, makes it in Shopify and queues the message in
// the customer's chat. Used by the Discount codes screen (src/routes/discounts.ts), by the Urgent
// "Approve code" button and by the agent itself when a customer asks for a code (./agent.ts).
import type { Channel, ContactRow, ConversationRow, DiscountSettings, Env } from '../types';
import { all, one, run, uid } from '../lib/db';
import { HttpError, bad } from '../lib/http';
import { getState } from '../lib/settings';
import { DAY } from '../lib/time';
import { emptyTarget, enqueue, type EnqueueInput } from '../pipeline/outbox';
import { createShopifyDiscount, type DiscountInput, type DiscountResult } from '../shopify/discounts';

export const DEFAULT_AMOUNT = 20;
export const DEFAULT_APPLIES_TO = 'kits, bundles and batteries';

export interface DiscountRow {
  id: string; conversation_id: string | null; contact_id: string | null; contact_name: string; channel: Channel;
  code: string; amount: number; currency: string; applies_to: string; expires_at: number | null; usage_limit: number | null;
  shopify_id: string | null; shopify_status: string; message_text: string; outbox_id: string | null;
  status: 'draft' | 'live' | 'sent' | 'failed'; error: string | null; created_at: number; updated_at: number;
  made_by: 'owner' | 'agent';
}

/** £20, or £12.50 when there are pence. */
export const pounds = (amount: number) => `£${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;

/** The message the owner sees first when the wording is not the saved template. Never contains a dash. */
export function defaultMessage(code: string, amount: number, appliesTo: string): string {
  return `Your discount code ${code} is now live!! It's ${pounds(amount)} off all ${appliesTo || DEFAULT_APPLIES_TO}`;
}

/** Fill in the owner's template. {CODE} and {AMOUNT} (the number only, the template has the £). */
export function renderTemplate(template: string, code: string, amount: number): string {
  const n = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return template.replace(/\{CODE\}/gi, code).replace(/\{AMOUNT\}/gi, n).trim();
}

/** The message for a code: the saved template when the code is the standard offer, else the plain default. */
export function messageFor(s: DiscountSettings, code: string, amount: number, appliesTo: string): string {
  const template = s.message.trim();
  if (template && appliesTo.trim().toLowerCase() === s.applies_to.trim().toLowerCase()) return renderTemplate(template, code, amount);
  return defaultMessage(code, amount, appliesTo);
}

/**
 * The code exactly as the customer wrote it (creators use codes like User_1.5kw or amzz.5kw), with
 * quotes and spaces removed. Letters, numbers, dot, underscore and dash, 3 to 30 long. Null otherwise.
 */
export function normaliseCode(raw: string | null | undefined): string | null {
  const code = String(raw ?? '').trim().replace(/^["'“‘`]+|["'”’`.,!?]+$/g, '').replace(/\s+/g, '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{1,28}[A-Za-z0-9]$/.test(code) ? code : null;
}

export const isLive = (row: Pick<DiscountRow, 'shopify_status'>) => row.shopify_status === 'created' || row.shopify_status === 'owner_confirmed';
export const OUTBOX_DONE_BAD = ['failed', 'expired', 'cancelled'];

export async function loadDiscount(db: D1Database, id: string): Promise<DiscountRow> {
  const row = await one<DiscountRow>(db, 'SELECT * FROM discount_codes WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'discount_not_found');
  return row;
}

/** The row as the screen sees it, with the message status read from the outbox. Saves a change of status. */
export async function viewDiscounts(db: D1Database, rows: DiscountRow[]) {
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
      status = isLive(r) ? 'live' : 'draft';
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
      status, error, made_by: r.made_by ?? 'owner', created_at: r.created_at, updated_at: r.updated_at,
    });
  }
  return out;
}

// ---- Shopify -------------------------------------------------------------------------------------

export type CreateFn = (env: Env, input: DiscountInput) => Promise<DiscountResult>;

/**
 * What makes codes in Shopify. In test mode only (ACX_TEST_MODE=1) the state key test_fake_shopify
 * can stand in for a connected store: "created" makes every code, "taken" says it exists already.
 */
export async function shopifyCreator(env: Env): Promise<CreateFn> {
  if (env.ACX_TEST_MODE === '1') {
    const fake = await getState<string | null>(env.DB, 'test_fake_shopify', null);
    if (fake === 'created') return async (_e, input) => ({ ok: true, shopify_status: 'created', shopify_id: `gid://shopify/DiscountCodeNode/test_${input.code}`, discount_status: 'ACTIVE' });
    if (fake === 'taken') return async (_e, input) => ({ ok: false, shopify_status: 'failed', error_code: 'code_taken', message: `The code ${input.code} already exists in Shopify. If it is the right one, press Send message. If not, pick another code.` });
  }
  return createShopifyDiscount;
}

export function shopifyLine(res: DiscountResult | null) {
  return res ? { ok: res.ok, status: res.shopify_status, error_code: res.error_code ?? null, message: res.message ?? null, discount_status: res.discount_status ?? null } : null;
}

// ---- saving ---------------------------------------------------------------------------------------

export interface NewDiscount {
  conv: ConversationRow;
  contact: ContactRow | null;
  code: string;
  amount: number;
  applies_to: string;
  expires_at: number | null;
  usage_limit: number | null;
  message_text: string;
  made_by: 'owner' | 'agent';
  now: number;
}

/** Save a draft row. Throws 409 code_taken when the code is already here. */
export async function insertDiscount(db: D1Database, d: NewDiscount): Promise<DiscountRow> {
  if (await one(db, 'SELECT id FROM discount_codes WHERE code = ? COLLATE NOCASE', d.code)) {
    throw new HttpError(409, 'code_taken', `You already made the code ${d.code}. Pick another one.`, { field: 'code' });
  }
  const id = uid('dc');
  const name = d.contact?.display_name || d.conv.title || 'Customer';
  const changed = await run(
    db,
    `INSERT INTO discount_codes (id, conversation_id, contact_id, contact_name, channel, code, amount, currency, applies_to, expires_at, usage_limit,
       shopify_status, message_text, status, made_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'GBP', ?, ?, ?, 'not_connected', ?, 'draft', ?, ?, ?) ON CONFLICT(code) DO NOTHING`,
    id, d.conv.id, d.contact?.id ?? null, name, d.conv.channel, d.code, d.amount, d.applies_to, d.expires_at, d.usage_limit, d.message_text, d.made_by, d.now, d.now,
  );
  if (!changed) throw new HttpError(409, 'code_taken', `You already made the code ${d.code}. Pick another one.`, { field: 'code' });
  return loadDiscount(db, id);
}

/**
 * Make the code in Shopify (or take the owner's word that it exists there). Saves the outcome on the
 * row and returns the fresh row. Never throws for a Shopify problem: the result says what happened.
 */
export async function makeLive(env: Env, row: DiscountRow, opts: { confirmExists?: boolean; now: number; create?: CreateFn }): Promise<{ row: DiscountRow; shopify: DiscountResult | null }> {
  if (isLive(row)) return { row, shopify: null };
  const create = opts.create ?? (await shopifyCreator(env));
  const shopify = await create(env, {
    code: row.code, amount: row.amount, title: `${row.code} for ${row.contact_name || 'Customer'}`.slice(0, 250),
    starts_at: opts.now, expires_at: row.expires_at && row.expires_at > opts.now ? row.expires_at : null, usage_limit: row.usage_limit,
  });
  const confirmed = !shopify.ok && Boolean(opts.confirmExists);
  const shopifyStatus = shopify.ok ? 'created' : confirmed ? 'owner_confirmed' : shopify.shopify_status;
  const live = shopify.ok || confirmed;
  await run(
    env.DB, 'UPDATE discount_codes SET shopify_id = COALESCE(?, shopify_id), shopify_status = ?, status = ?, error = ?, updated_at = ? WHERE id = ?',
    shopify.shopify_id ?? null, shopifyStatus, live ? 'live' : 'draft', live ? null : shopify.message ?? null, opts.now, row.id,
  );
  return { row: await loadDiscount(env.DB, row.id), shopify };
}

/**
 * Queue the message in the customer's own chat. Exactly one live job per discount: a second call
 * returns the job already waiting, and a job that failed gives up its key so a new one can be queued.
 * The text goes out as written (no style sanitizer).
 */
export async function queueDiscountMessage(
  env: Env, row: DiscountRow, text: string,
  opts: { now: number; source?: EnqueueInput['source']; status?: 'pending' | 'review'; pacing?: { delay_ms: number; typing_cps: number } },
): Promise<{ outbox_id: string; already: boolean }> {
  const db = env.DB;
  if (!row.conversation_id) throw bad('no_conversation', 'This code is not linked to a chat any more, so there is nowhere to send the message.');
  const conv = await one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', row.conversation_id);
  if (!conv) throw bad('no_conversation', 'The chat for this code is not here any more, so there is nowhere to send the message.');
  const contact = await one<ContactRow>(db, 'SELECT * FROM contacts WHERE id = ?', conv.contact_id);
  const dedupe = `discount:${row.id}`;
  const existing = await one<{ id: string; status: string }>(db, 'SELECT id, status FROM outbox WHERE dedupe_key = ?', dedupe);
  if (existing && !OUTBOX_DONE_BAD.includes(existing.status)) return { outbox_id: existing.id, already: true };
  if (existing) await run(db, 'UPDATE outbox SET dedupe_key = NULL WHERE id = ?', existing.id);
  const id = await enqueue(db, {
    channel: conv.channel, kind: 'reply', conversation_id: conv.id, source: opts.source ?? 'manual', ref_id: row.id, dedupe_key: dedupe,
    status: opts.status ?? 'pending',
    target: emptyTarget({
      thread_external_id: conv.external_thread_id, title: conv.title || contact?.display_name || null,
      phone: contact?.phone ?? null, email: contact?.email ?? null, handle: contact?.handle ?? null, subject: conv.subject,
    }),
    parts: [text], expires_at: opts.now + DAY, pacing: opts.pacing ?? { delay_ms: 500, typing_cps: 30 },
  });
  if (!id) {
    const again = await one<{ id: string }>(db, 'SELECT id FROM outbox WHERE dedupe_key = ?', dedupe);
    if (again) return { outbox_id: again.id, already: true };
    throw new HttpError(409, 'not_queued', 'The message was not queued. Try again.');
  }
  await run(db, 'UPDATE discount_codes SET outbox_id = ?, message_text = ?, updated_at = ? WHERE id = ?', id, text, opts.now, row.id);
  return { outbox_id: id, already: false };
}

/**
 * Make the code live if it is not yet, then queue the message. Used by "Send message" on the
 * Discount codes screen and by "Approve code" on Urgent. Not live and Shopify said no: 409 needs_confirm.
 */
export async function liveThenSend(
  env: Env, row: DiscountRow,
  opts: { text?: string; confirmExists?: boolean; now: number; source?: EnqueueInput['source']; create?: CreateFn },
): Promise<{ row: DiscountRow; shopify: DiscountResult | null; queued: { outbox_id: string; already: boolean } }> {
  const text = opts.text?.trim() || row.message_text || defaultMessage(row.code, row.amount, row.applies_to);
  let shopify: DiscountResult | null = null;
  if (!isLive(row)) {
    if (opts.confirmExists) {
      await run(env.DB, `UPDATE discount_codes SET shopify_status = 'owner_confirmed', status = 'live', error = NULL, updated_at = ? WHERE id = ?`, opts.now, row.id);
    } else {
      const made = await makeLive(env, row, { now: opts.now, create: opts.create });
      shopify = made.shopify;
      if (!isLive(made.row)) {
        throw new HttpError(409, 'needs_confirm', shopify?.message ?? 'The code is not in Shopify yet. Make it there, then confirm it exists.', { shopify: shopifyLine(shopify) });
      }
    }
    row = await loadDiscount(env.DB, row.id);
  }
  const queued = await queueDiscountMessage(env, row, text, { now: opts.now, source: opts.source });
  return { row: await loadDiscount(env.DB, row.id), shopify, queued };
}
