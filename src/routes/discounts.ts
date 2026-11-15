// Owner facing API for the Discount codes screen: codes made for creators and sponsorship requests,
// made in Shopify when the API is connected, and a message to the customer in the same chat.
import type { ContactRow, ConversationRow } from '../types';
import { all, one, run } from '../lib/db';
import { logEvent } from '../lib/events';
import { HttpError, bad, bool, json, str, type Router } from '../lib/http';
import { getSettings } from '../lib/settings';
import { londonDateTimeToTs } from '../lib/time';
import { hasApiCredentials } from '../shopify/client';
import {
  type DiscountRow, insertDiscount, isLive, liveThenSend, loadDiscount, makeLive, messageFor, queueDiscountMessage, shopifyLine, viewDiscounts,
} from '../discounts';
import { approveCodeRequest } from '../discounts/agent';

const MAX_MESSAGE_CHARS = 1000;

function codeOf(v: unknown): string {
  const code = str(v, 'code', { max: 60 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,28}[A-Za-z0-9]$/.test(code)) throw bad('invalid_code', 'The code should be 3 to 30 letters or numbers. Dots, underscores and dashes are fine in the middle, spaces are not.', { field: 'code' });
  return code;
}

function amountOf(v: unknown, fallback: number): number {
  const n = v === undefined || v === null || v === '' ? fallback : typeof v === 'number' ? v : Number(v);
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

export function register(r: Router): void {
  r.get('/api/discounts', 'owner', async (c) => {
    const rows = await all<DiscountRow>(c.db, 'SELECT * FROM discount_codes ORDER BY created_at DESC LIMIT 200');
    const s = (await getSettings(c.db)).discounts;
    return json({
      discounts: await viewDiscounts(c.db, rows),
      shopify: { connected: await hasApiCredentials(c.db) },
      defaults: { amount: s.amount, currency: s.currency, applies_to: s.applies_to, message: messageFor(s, '{CODE}', s.amount, s.applies_to) },
      settings: s,
    });
  });

  // Make a code. With send: true the message goes too, but only once the code is live
  // (made in Shopify, or confirm_exists: true when the owner made it in Shopify by hand).
  r.post('/api/discounts', 'owner', async (c) => {
    const body = await c.body<Record<string, unknown>>();
    const s = (await getSettings(c.db)).discounts;
    const conversationId = str(body.conversation_id, 'conversation_id', { max: 80 });
    const code = codeOf(body.code);
    const amount = amountOf(body.amount, s.amount);
    const appliesTo = str(body.applies_to, 'applies_to', { max: 120, optional: true }) || s.applies_to;
    const expiresAt = expiryOf(body.expires_at, c.now);
    const usageLimit = usageOf(body.usage_limit);
    const text = str(body.message_text, 'message_text', { max: MAX_MESSAGE_CHARS, optional: true }) || messageFor(s, code, amount, appliesTo);
    const send = bool(body.send, false);
    const confirmExists = bool(body.confirm_exists, false);

    const conv = await one<ConversationRow>(c.db, 'SELECT * FROM conversations WHERE id = ?', conversationId);
    if (!conv) throw bad('conversation_not_found', 'Pick the customer from one of your chats.', { field: 'conversation_id' });
    const contact = await one<ContactRow>(c.db, 'SELECT * FROM contacts WHERE id = ?', conv.contact_id);

    const draft = await insertDiscount(c.db, {
      conv, contact, code, amount, applies_to: appliesTo, expires_at: expiresAt, usage_limit: usageLimit, message_text: text, made_by: 'owner', now: c.now,
    });
    const { row, shopify } = await makeLive(c.env, draft, { confirmExists, now: c.now });
    const name = row.contact_name || 'Customer';
    await logEvent(c.db, {
      level: shopify?.ok ? 'good' : 'info', type: 'discount', channel: conv.channel, conversation_id: conv.id,
      message: shopify?.ok ? `Discount code ${code} made in Shopify for ${name}.` : `Discount code ${code} saved for ${name}. Not made in Shopify: ${shopify?.message ?? 'unknown reason'}`,
    });

    let queued: { outbox_id: string; already: boolean } | null = null;
    if (send && isLive(row)) queued = await queueDiscountMessage(c.env, row, text, { now: c.now });
    const [discount] = await viewDiscounts(c.db, [await loadDiscount(c.db, row.id)]);
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
    const row = await loadDiscount(c.db, c.params.id!);
    const text = str(body.message_text, 'message_text', { max: MAX_MESSAGE_CHARS, optional: true });
    const res = await liveThenSend(c.env, row, { text, confirmExists: bool(body.confirm_exists, false), now: c.now });
    const [discount] = await viewDiscounts(c.db, [res.row]);
    return json({ ok: true, discount, already_queued: res.queued.already, shopify: shopifyLine(res.shopify) });
  });

  // A code the agent parked for the owner (Urgent card, or the list): make it and send the message,
  // then close the Urgent item. Same rules as send.
  r.post('/api/discounts/:id/approve', 'owner', async (c) => {
    const body = await c.body<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const text = str(body.message_text, 'message_text', { max: MAX_MESSAGE_CHARS, optional: true });
    const res = await approveCodeRequest(c.env, c.params.id!, { text, confirmExists: bool(body.confirm_exists, false), now: c.now });
    const [discount] = await viewDiscounts(c.db, [res.row]);
    return json({ ok: true, discount, already_queued: res.queued.already, shopify: shopifyLine(res.shopify), parts: [res.text] });
  });

  // Only drafts go: a live code may already be in a customer's hands.
  r.delete('/api/discounts/:id', 'owner', async (c) => {
    const row = await loadDiscount(c.db, c.params.id!);
    if (row.status !== 'draft' || row.outbox_id) {
      throw new HttpError(409, 'not_a_draft', 'Only drafts can be removed here. A live code is turned off in Shopify under Discounts.');
    }
    await run(c.db, 'DELETE FROM discount_codes WHERE id = ?', row.id);
    // A code request waiting on Urgent for this draft has nothing left to approve.
    await run(c.db, `UPDATE urgent SET discount_id = NULL WHERE discount_id = ?`, row.id);
    return json({ ok: true });
  });
}
