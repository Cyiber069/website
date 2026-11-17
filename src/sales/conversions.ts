// Orders matched back to chats. An order (orders/create webhook) or a checkout Shopify marks as
// completed (daily pull, checkout webhooks) is matched to conversations by the buyer's phone (E.164)
// or email. Every matched chat is marked bought. One row per order goes into sales_conversions,
// counted as a sale from chat when the agent wrote in that chat in the 14 days before the order.
// A handful of queries for any number of orders: the free plan allows 50 per request.
import { all, clip, stmt, uid } from '../lib/db';
import { DAY, HOUR } from '../lib/time';
import { toE164 } from '../shopify/phone';

export interface OrderFacts {
  /** order:<id> or checkout:<id>. The same ref is never counted twice. */
  ref: string;
  at: number;
  total: number | null;
  currency: string | null;
  phones: string[];
  emails: string[];
}

export const CHAT_WINDOW_MS = 14 * DAY;
/** An order and a completed checkout of the same purchase arrive separately. Within this time of each other they are one sale. */
const SAME_SALE_MS = 6 * HOUR;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const amount = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/** The facts of an orders/create webhook payload. The shop currency amount is preferred (the funnel counts GBP). */
export function orderFacts(order: Obj, defaultCountry: string): OrderFacts | null {
  const id = order.id !== undefined && order.id !== null ? String(order.id) : text(order.name) ?? text(order.checkout_token);
  if (!id) return null;
  const ship = obj(order.shipping_address);
  const bill = obj(order.billing_address);
  const customer = obj(order.customer);
  const country = text(ship.country_code)?.toUpperCase() ?? text(bill.country_code)?.toUpperCase() ?? null;
  const shop = obj(obj(order.total_price_set).shop_money);
  const phones = [text(order.phone), text(ship.phone), text(bill.phone), text(customer.phone)]
    .map((p) => toE164(p, country, defaultCountry)).filter((p): p is string => Boolean(p));
  const emails = [text(order.email), text(order.contact_email), text(customer.email)].map((e) => e?.toLowerCase() ?? null).filter((e): e is string => Boolean(e));
  const at = Date.parse(text(order.created_at) ?? '');
  return {
    ref: `order:${id}`,
    at: Number.isFinite(at) ? at : Date.now(),
    total: amount(shop.amount) ?? amount(order.current_total_price) ?? amount(order.total_price),
    currency: (text(shop.currency_code) ?? text(order.currency))?.toUpperCase() ?? null,
    phones: [...new Set(phones)],
    emails: [...new Set(emails)],
  };
}

interface ContactHit { id: string; phone: string | null; email: string | null; display_name: string }
interface ConvHit { id: string; channel: string; contact_id: string; last_outbound_at: number | null }

/**
 * Match orders to chats and record them. Returns how many orders matched a chat. Never throws:
 * a failure here must not lose the order webhook.
 */
export async function recordConversions(db: D1Database, orders: OrderFacts[]): Promise<number> {
  try {
    return await record(db, orders.filter((o) => o.phones.length || o.emails.length).slice(0, 25));
  } catch (err) {
    console.error('recording a sale failed', err);
    return 0;
  }
}

async function record(db: D1Database, orders: OrderFacts[]): Promise<number> {
  if (!orders.length) return 0;
  const phones = [...new Set(orders.flatMap((o) => o.phones))];
  const emails = [...new Set(orders.flatMap((o) => o.emails))];
  const contacts = await all<ContactHit>(
    db,
    `SELECT id, phone, email, display_name FROM contacts WHERE phone IN (SELECT value FROM json_each(?)) OR email IN (SELECT value FROM json_each(?)) LIMIT 50`,
    JSON.stringify(phones), JSON.stringify(emails),
  );
  if (!contacts.length) return 0;
  const convs = await all<ConvHit>(
    db, `SELECT id, channel, contact_id, last_outbound_at FROM conversations WHERE contact_id IN (SELECT value FROM json_each(?)) LIMIT 50`,
    JSON.stringify(contacts.map((c) => c.id)),
  );
  if (!convs.length) return 0;
  const minAt = Math.min(...orders.map((o) => o.at));
  const maxAt = Math.max(...orders.map((o) => o.at));
  const convIds = JSON.stringify(convs.map((c) => c.id));
  // When the agent last wrote in each chat, inside the window that matters for these orders.
  const agentMsgs = await all<{ conversation_id: string; ts: number }>(
    db,
    `SELECT conversation_id, ts FROM messages WHERE conversation_id IN (SELECT value FROM json_each(?)) AND direction = 'out' AND author = 'agent' AND ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT 200`,
    convIds, minAt - CHAT_WINDOW_MS, maxAt,
  );
  const known = await all<{ order_ref: string; conversation_id: string; ordered_at: number }>(
    db,
    `SELECT order_ref, conversation_id, ordered_at FROM sales_conversions WHERE order_ref IN (SELECT value FROM json_each(?))
       OR (conversation_id IN (SELECT value FROM json_each(?)) AND ordered_at >= ? AND ordered_at <= ?)`,
    JSON.stringify(orders.map((o) => o.ref)), convIds, minAt - SAME_SALE_MS, maxAt + SAME_SALE_MS,
  );

  const now = Date.now();
  const writes: D1PreparedStatement[] = [];
  let matched = 0;
  for (const o of orders) {
    const who = contacts.filter((c) => (c.phone && o.phones.includes(c.phone)) || (c.email && o.emails.includes(c.email)));
    const chats = convs.filter((cv) => who.some((c) => c.id === cv.contact_id));
    if (!chats.length) continue;
    matched++;
    const lastAgent = (convId: string) => agentMsgs.find((m) => m.conversation_id === convId && m.ts <= o.at && m.ts >= o.at - CHAT_WINDOW_MS)?.ts ?? 0;
    // The chat that sold it: the one the agent wrote in most recently before the order.
    const best = [...chats].sort((a, b) => lastAgent(b.id) - lastAgent(a.id) || (b.last_outbound_at ?? 0) - (a.last_outbound_at ?? 0))[0]!;
    const fromChat = lastAgent(best.id) > 0 ? 1 : 0;
    const contact = who.find((c) => c.id === best.contact_id) ?? who[0]!;
    const matchedBy = contact.phone && o.phones.includes(contact.phone) ? 'phone' : 'email';
    const duplicate = known.some((k) => k.order_ref === o.ref || (chats.some((c) => c.id === k.conversation_id) && Math.abs(k.ordered_at - o.at) <= SAME_SALE_MS));
    if (!duplicate) {
      writes.push(stmt(
        db,
        `INSERT INTO sales_conversions (id, order_ref, conversation_id, contact_id, channel, total, currency, ordered_at, from_chat, matched_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(order_ref) DO NOTHING`,
        uid('sc'), o.ref, best.id, contact.id, best.channel, o.total, o.currency, o.at, fromChat, matchedBy, now,
      ));
      known.push({ order_ref: o.ref, conversation_id: best.id, ordered_at: o.at });
    }
    const ids = JSON.stringify(chats.map((c) => c.id));
    writes.push(stmt(
      db,
      `UPDATE conversations SET sales_stage = 'bought', sales_stage_at = ?, bought_at = MAX(COALESCE(bought_at, 0), ?),
         order_total = COALESCE(?, order_total), order_currency = COALESCE(?, order_currency), followup_status = COALESCE(followup_status, 'skipped_bought')
       WHERE id IN (SELECT value FROM json_each(?))`,
      o.at, o.at, o.total, o.currency, ids,
    ));
    // Never chase someone who just bought.
    writes.push(stmt(db, `UPDATE outbox SET status = 'cancelled', last_error = 'they bought' WHERE conversation_id IN (SELECT value FROM json_each(?)) AND ref_id = 'followup' AND status IN ('pending', 'review')`, ids));
    if (!duplicate) {
      const money = o.total !== null ? ` for ${o.currency === 'GBP' || !o.currency ? '£' : `${o.currency} `}${o.total.toFixed(2)}` : '';
      writes.push(stmt(
        db, 'INSERT INTO events (ts, level, type, channel, conversation_id, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
        now, 'good', 'sale', best.channel, best.id,
        clip(`${contact.display_name || 'A customer'} bought${money}${fromChat ? ' after chatting with the agent' : ''}`, 400), JSON.stringify({ order_ref: o.ref, from_chat: fromChat }),
      ));
    }
  }
  if (writes.length) await db.batch(writes);
  return matched;
}

