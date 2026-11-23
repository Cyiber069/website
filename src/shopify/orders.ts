// "Where is my order?": the agent looks the customer's orders up in Shopify itself (owner rule, 2026-11-23).
// Orders are matched by the customer's own phone number or email, never by an order number alone, since
// numbers overlap across the owner's stores. The brain gets a note with what Shopify shows and what the
// owner's rules say to do with it. Nothing found, or any error, means the owner handles it.
import type { Env } from '../types';
import { adminGraphQL } from './client';

const DAY = 86_400_000;
export const TRACK_PAGE = 'https://acxebikes.com/apps/parcelpanel';

/** Does the customer's latest message ask about an order they already placed? */
const ASKS = /\b(where(?:'?s| is| are)? (?:my|the) (?:order|kit|bundle|parcel|package|battery|delivery)|track(?:ing)?(?: number| info| link)?\b|has (?:my|it) (?:been )?(?:shipped|dispatched|sent|posted)|(?:shipped|dispatched|sent|posted) (?:it|my order|yet)|when (?:will|is) (?:my|it|the) .{0,30}(?:arrive|come|deliver|ship|here)|order (?:status|update)|not (?:arrived|received|come)|still (?:waiting|not here|hasn'?t)|any (?:update|news) on (?:my|the) order|i (?:ordered|bought|paid)\b)/i;
export const asksAboutOrder = (text: string): boolean => ASKS.test(text.replace(/[’‘]/g, "'"));

interface OrderNode {
  name: string; createdAt: string; cancelledAt: string | null; email: string | null; phone: string | null;
  displayFulfillmentStatus: string;
  lineItems: { nodes: { title: string; variantTitle: string | null }[] };
  fulfillments: { createdAt: string; displayStatus: string | null; trackingInfo: { number: string | null; url: string | null; company: string | null }[] }[];
}

const QUERY = `query($q: String!) { orders(first: 3, sortKey: CREATED_AT, reverse: true, query: $q) { nodes {
  name createdAt cancelledAt email phone displayFulfillmentStatus
  lineItems(first: 5) { nodes { title variantTitle } }
  fulfillments(first: 5) { createdAt displayStatus trackingInfo(first: 3) { number url company } }
} } }`;

const digits = (s: string | null | undefined) => String(s ?? '').replace(/\D/g, '');

/** UK stock: the 2000W and 3000W on 27.5 or 29 inch wheels, about 3 working days. Everything else 2 to 3 weeks. */
export function ukStock(o: Pick<OrderNode, 'lineItems'>): boolean {
  const main = o.lineItems.nodes.filter((l) => /\b\d{3,4}\s?w\b/i.test(l.title));
  return main.length > 0 && main.every((l) => /\b(2000|3000)\s?w\b/i.test(l.title) && /\b(27\.5|29)\b/.test(l.variantTitle ?? ''));
}

/** Working days (Monday to Friday) from one time to another. */
export function workingDaysBetween(from: number, to: number): number {
  let n = 0;
  for (let t = from + DAY; t <= to; t += DAY) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) n++; }
  return n;
}

/** What the brain is told about one order, with the owner's rule for it already applied. */
export function describeOrder(o: OrderNode, now: number): string {
  const placed = Date.parse(o.createdAt);
  const items = o.lineItems.nodes.map((l) => `${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ''}`).join(', ');
  const head = `Order ${o.name}, placed ${o.createdAt.slice(0, 10)}: ${items}.`;
  if (o.cancelledAt) return `${head} Shopify shows it as cancelled. Hand this to the team (category order_status).`;
  const tracked = o.fulfillments.flatMap((f) => f.trackingInfo.map((t) => ({ ...t, status: f.displayStatus, at: Date.parse(f.createdAt) }))).filter((t) => t.number);
  if (tracked.length) {
    const t = tracked[0]!;
    const stuck = t.status !== 'DELIVERED' && now - t.at > 7 * DAY;
    const lines = tracked.map((x) => `tracking number ${x.number}${x.company ? ` with ${x.company}` : ''}${x.url ? ` (${x.url})` : ''}`).join('; ');
    if (t.status === 'DELIVERED') return `${head} It has shipped and the courier shows it as delivered: ${lines}. Tell them, and if they have not got it, hand it to the team.`;
    if (stuck) return `${head} It shipped on ${new Date(t.at).toISOString().slice(0, 10)} but the courier has not shown it as delivered after more than a week (${lines}). Give the tracking number and hand this to the team (category order_status), the tracking may be stuck.`;
    return `${head} It has shipped: ${lines}. Send the tracking number, name only the courier shown here, and give the Track Your Order page ${TRACK_PAGE}.`;
  }
  const uk = ukStock(o);
  const inside = uk ? workingDaysBetween(placed, now) <= 3 : now - placed <= 21 * DAY;
  const window = uk ? 'about 3 working days from UK stock' : 'about 2 to 3 weeks from our factory';
  if (inside) return `${head} It has not shipped yet and is still inside the usual window (${window}, we do not ship at weekends). Say it is being prepared, give that window, and say the tracking comes as soon as it ships. Do not hand this to the team.`;
  return `${head} It has not shipped yet and is past the usual window (${window}). Do not give a new date: say sorry, say you are checking with the team, and hand it to the team (category order_status).`;
}

/** The note for the brain, or '' when the latest message is not about an order or nothing can be matched. */
export async function orderLookupNote(env: Env, opts: { text: string; phone: string | null; email: string | null; now: number }): Promise<string> {
  if (!asksAboutOrder(opts.text)) return '';
  const phone = digits(opts.phone);
  const email = (opts.email ?? '').trim().toLowerCase();
  if (phone.length < 9 && !email.includes('@')) return '';
  const terms = [email.includes('@') ? `email:"${email}"` : '', phone.length >= 9 ? `phone:"+${phone}"` : ''].filter(Boolean);
  let nodes: OrderNode[] = [];
  try {
    const res = await adminGraphQL<{ orders: { nodes: OrderNode[] } }>(env, QUERY, { q: terms.join(' OR ') });
    // Shopify's search is loose: keep only orders whose own phone or email is the customer's.
    nodes = (res.orders?.nodes ?? []).filter((o) => (email && (o.email ?? '').toLowerCase() === email) || (phone.length >= 9 && digits(o.phone).slice(-9) === phone.slice(-9)));
  } catch (err) {
    console.error('order lookup failed', err);
    return 'Order lookup: Shopify could not be checked just now. If they ask about an order they placed, say sorry, say you are checking with the team, and hand it to the team (category order_status).';
  }
  if (!nodes.length) {
    return 'Order lookup: no order in Shopify matches this customer\'s phone number or email. If they say they ordered, ask for the email they used at checkout, and if they already gave it, hand it to the team (category order_status): it may be an order from another store. Never look an order up by its number alone.';
  }
  return `Order lookup (Shopify, matched by this customer's own ${email ? 'email' : 'phone number'}; never share it with anyone else): ${nodes.slice(0, 2).map((o) => describeOrder(o, opts.now)).join(' ')} Follow these instructions exactly and never promise a date.`;
}
