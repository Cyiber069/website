// Selling: lead stages, the one follow up, orders matched back to chats, and the Sales screen numbers.
//
//   recordSalesRead   after each decision: stage, product and the product link we sent (leads.ts)
//   salesTick(env)    every minute job: at most 3 follow ups per run, indexed reads only (this file)
//   recordConversions orders and completed checkouts matched to chats by phone or email (conversions.ts)
//   salesOverview     funnel, hot leads and follow up counts for GET /api/sales (this file)
//
// salesTick is not wired into cron.ts here: add `await salesTick(env)` to the every minute job.
import type { Channel, ContactRow, ConversationRow, Env, HistoryMessage, SalesSettings, Settings, ToneProfile } from '../types';
import { CHANNELS } from '../types';
import { writeFollowUp } from '../brain/followup';
import { all, clip, one, run } from '../lib/db';
import { logEvent } from '../lib/events';
import { getSettings } from '../lib/settings';
import { DAY, HOUR, MIN, londonTime } from '../lib/time';
import { emptyTarget, enqueue } from '../pipeline/outbox';

export { nextStage, recordSalesRead } from './leads';
export { CHAT_WINDOW_MS, orderFacts, recordConversions, type OrderFacts } from './conversions';

/** At most this many follow ups are written per run (one model call each). */
export const FOLLOW_UPS_PER_RUN = 3;
/** Follow ups go out only between these London hours (10:00 to 19:59). */
export const SEND_FROM_HOUR = 10;
export const SEND_UNTIL_HOUR = 20;
/** WhatsApp lets a business answer for 24 hours after the customer's last message. We stop at 23. */
export const WHATSAPP_WINDOW_MS = 23 * HOUR;
/** A recommendation older than the wait plus this is not followed up at all. */
const STALE_AFTER_MS = 2 * DAY;
const HISTORY_FOR_FOLLOW_UP = 12;

/** The sales settings, clamped, whatever was stored. */
export function salesSettings(settings: Pick<Settings, 'sales'>): SalesSettings {
  const s = settings.sales;
  const hours = Number(s?.follow_up_hours);
  return {
    follow_ups: s?.follow_ups !== false,
    follow_up_hours: Number.isFinite(hours) ? Math.min(72, Math.max(1, Math.round(hours))) : 20,
    style: s?.style === 'relaxed' || s?.style === 'keen' ? s.style : 'friendly',
  };
}

export function insideSendingHours(now: number): boolean {
  const h = londonTime(now).hour;
  return h >= SEND_FROM_HOUR && h < SEND_UNTIL_HOUR;
}

type Candidate = ConversationRow & {
  ct_opted_out: number; ct_name: string; ct_tone: string; ct_phone: string | null; ct_email: string | null; ct_handle: string | null;
};

export interface SalesTickResult {
  /** Why nothing was looked at, when that is the case. */
  idle?: 'agent_off' | 'follow_ups_off' | 'outside_hours' | 'no_channels';
  checked: number;
  queued: number;
  drafts: number;
  skipped: { id: string; reason: string }[];
}

const NEUTRAL_TONE: ToneProfile = {
  register: 'casual', mood: 'neutral', greeting: '', address_terms: [], elongation: 0, emoji_rate: 0, lowercase: false,
  punctuation: 'light', avg_chars: 60, language: 'en', slang: [],
};

/**
 * The follow up job. Sends ONE short follow up to a customer who was interested or ready, was sent a
 * product link by the agent and then went quiet for sales.follow_up_hours. Never a second one, never
 * outside 10:00 to 20:00 UK time, never to someone who opted out, bought, is paused or was taken over
 * by the owner, never on a channel that is off, and on WhatsApp only inside the 24 hour window.
 * Review mode makes it a draft. A chat that can never get one is marked so it is not read again.
 */
export async function salesTick(env: Env, now = Date.now()): Promise<SalesTickResult> {
  const db = env.DB;
  const result: SalesTickResult = { checked: 0, queued: 0, drafts: 0, skipped: [] };
  const settings = await getSettings(db);
  const sales = salesSettings(settings);
  if (!settings.agent.enabled) return { ...result, idle: 'agent_off' };
  if (!sales.follow_ups) return { ...result, idle: 'follow_ups_off' };
  // Checked before any read: outside the hours nothing is due, so nothing is read.
  if (!insideSendingHours(now)) return { ...result, idle: 'outside_hours' };
  const channels = CHANNELS.filter((c) => settings.channels[c].mode !== 'off');
  if (!channels.length) return { ...result, idle: 'no_channels' };

  const wait = sales.follow_up_hours * HOUR;
  // Reads only the partial index conversations_followup_due: chats with a link we sent and no follow up yet.
  const due = await all<Candidate>(
    db,
    `SELECT cv.*, ct.opted_out AS ct_opted_out, ct.display_name AS ct_name, ct.tone_profile AS ct_tone, ct.phone AS ct_phone, ct.email AS ct_email, ct.handle AS ct_handle
     FROM conversations cv INDEXED BY conversations_followup_due JOIN contacts ct ON ct.id = cv.contact_id
     WHERE cv.followup_status IS NULL AND cv.sales_link IS NOT NULL
       AND cv.last_outbound_at <= ? AND cv.last_outbound_at > ?
       AND cv.last_direction = 'out' AND cv.sales_stage IN ('interested', 'ready') AND cv.bought_at IS NULL
       AND (cv.paused_until IS NULL OR cv.paused_until < ?)
       AND cv.channel IN (SELECT value FROM json_each(?))
     ORDER BY cv.last_outbound_at ASC LIMIT ?`,
    now - wait, now - wait - STALE_AFTER_MS, now, JSON.stringify(channels), FOLLOW_UPS_PER_RUN,
  );
  for (const cv of due) {
    result.checked++;
    const outcome = await followUpOne(env, settings, cv, now);
    if (outcome === 'queued') result.queued++;
    else if (outcome === 'draft') result.drafts++;
    else if (outcome) result.skipped.push({ id: cv.id, reason: outcome });
  }
  return result;
}

/** Mark a chat so the job never reads it again. */
const markSkipped = (db: D1Database, id: string, reason: string, now: number) =>
  run(db, `UPDATE conversations SET followup_status = ?, followup_at = ? WHERE id = ? AND followup_status IS NULL`, `skipped_${reason}`, now, id);

async function followUpOne(env: Env, settings: Settings, cv: Candidate, now: number): Promise<'queued' | 'draft' | string | null> {
  const db = env.DB;
  const channel = cv.channel as Channel;
  const mode = settings.channels[channel].mode;
  if (cv.ct_opted_out) { await markSkipped(db, cv.id, 'opted_out', now); return 'opted_out'; }
  // WhatsApp: only inside the service window the customer opened. Past it, never.
  if (channel === 'whatsapp' && (!cv.last_inbound_at || now - cv.last_inbound_at > WHATSAPP_WINDOW_MS)) {
    await markSkipped(db, cv.id, 'whatsapp_window', now);
    return 'whatsapp_window';
  }

  const rows = await all<{ direction: 'in' | 'out'; author: HistoryMessage['author']; body: string; kind: HistoryMessage['kind']; ts: number; outbox_id: string | null }>(
    db,
    'SELECT * FROM (SELECT direction, author, body, kind, ts, outbox_id FROM messages WHERE conversation_id = ? ORDER BY ts DESC, created_at DESC LIMIT ?) ORDER BY ts ASC',
    cv.id, HISTORY_FOR_FOLLOW_UP,
  );
  const last = rows[rows.length - 1];
  if (!last) { await markSkipped(db, cv.id, 'no_messages', now); return 'no_messages'; }
  // The owner wrote last (took the chat over): it is theirs now.
  if (last.direction === 'out' && last.author === 'owner') { await markSkipped(db, cv.id, 'owner_took_over', now); return 'owner_took_over'; }
  // The customer wrote last after all (columns not caught up yet): not quiet, try again later.
  if (last.direction === 'in') return 'customer_wrote';
  // Only after a link from the agent: the link must be in what we sent.
  if (!rows.some((m) => m.direction === 'out' && m.author === 'agent' && cv.sales_link && m.body.includes(cv.sales_link))) {
    await markSkipped(db, cv.id, 'link_not_sent', now);
    return 'link_not_sent';
  }

  // Claim it first: two runs at once must never both send.
  const claimed = await run(db, `UPDATE conversations SET followup_status = 'writing', followup_at = ? WHERE id = ? AND followup_status IS NULL`, now, cv.id);
  if (!claimed) return null;

  let tone: ToneProfile = NEUTRAL_TONE;
  try { tone = { ...NEUTRAL_TONE, ...(JSON.parse(cv.ct_tone || '{}') as Partial<ToneProfile>) }; } catch { /* neutral */ }
  const written = await writeFollowUp(env, {
    channel, contact_name: cv.ct_name || null, history: rows.map((m) => ({ direction: m.direction, author: m.author, body: m.body, kind: m.kind, ts: m.ts })),
    product: cv.sales_product ?? null, link: cv.sales_link!, tone,
  });

  const review = mode === 'review';
  // Not sent in time (laptop off): it expires instead of arriving late, and never after the WhatsApp window.
  const windowEnd = channel === 'whatsapp' && cv.last_inbound_at ? cv.last_inbound_at + 24 * HOUR - 15 * MIN : Infinity;
  const expires = Math.min(review ? now + 12 * HOUR : now + 3 * HOUR, windowEnd);
  const contact: Pick<ContactRow, 'phone' | 'email' | 'handle'> = { phone: cv.ct_phone, email: cv.ct_email, handle: cv.ct_handle };
  const id = await enqueue(db, {
    channel, kind: 'reply', conversation_id: cv.id,
    target: emptyTarget({ thread_external_id: cv.external_thread_id, title: cv.title || cv.ct_name, phone: contact.phone, email: contact.email, handle: contact.handle, subject: cv.subject }),
    parts: written.parts,
    // Source auto: an owner takeover, an opt out or a newer draft cancels it like any agent reply.
    source: 'auto', ref_id: 'followup', status: review ? 'review' : 'pending',
    pacing: { delay_ms: 0, typing_cps: 0 },
    expires_at: Number.isFinite(expires) ? expires : now + 3 * HOUR,
    dedupe_key: `followup:${cv.id}`,
  });
  const status = review ? 'draft' : 'queued';
  await run(db, `UPDATE conversations SET followup_status = ?, followup_outbox_id = ? WHERE id = ?`, id ? status : 'skipped_duplicate', id, cv.id);
  if (!id) return 'duplicate';
  await logEvent(db, {
    type: 'followup', channel, conversation_id: cv.id,
    message: `${review ? 'Follow up draft ready for' : 'Following up with'} ${cv.ct_name || cv.title || 'a customer'} about ${cv.sales_product || 'the product they looked at'}: ${clip(written.parts.join(' '), 140)}`,
    data: { outbox_id: id, source: written.source },
  });
  return status;
}

// ---- the Sales screen ---------------------------------------------------------------------------------

export interface FunnelWindow { days: number; chats: number; interested: number; ready: number; bought: number; revenue: number }
export interface HotLead {
  conversation_id: string; channel: Channel; customer: string; stage: 'interested' | 'ready'; product: string | null; link: string | null;
  last_message: string; last_direction: string; stage_at: number; followup_status: string | null;
}
export interface FollowUpWindow { days: number; sent: number; waiting: number; replies: number }
export interface SalesOverview { funnel: FunnelWindow[]; leads: HotLead[]; followups: FollowUpWindow[]; settings: SalesSettings }

async function funnel(db: D1Database, since: number, days: number): Promise<FunnelWindow> {
  // Each count reads one index range (conversations_last_inbound, _interested, _ready, sales_conversions_at).
  const chats = (await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM conversations WHERE last_inbound_at >= ?', since))?.n ?? 0;
  const interested = (await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM conversations WHERE interested_at >= ?', since))?.n ?? 0;
  const ready = (await one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM conversations WHERE ready_at >= ?', since))?.n ?? 0;
  const sold = await one<{ n: number; revenue: number | null }>(
    db, `SELECT COUNT(*) AS n, SUM(CASE WHEN currency IS NULL OR currency = 'GBP' THEN total ELSE 0 END) AS revenue FROM sales_conversions WHERE ordered_at >= ? AND from_chat = 1`, since,
  );
  return { days, chats, interested, ready, bought: sold?.n ?? 0, revenue: Math.round((sold?.revenue ?? 0) * 100) / 100 };
}

export async function salesOverview(env: Env, now = Date.now()): Promise<SalesOverview> {
  const db = env.DB;
  const settings = await getSettings(db);
  const leads = await all<{
    id: string; channel: Channel; title: string; display_name: string | null; sales_stage: 'interested' | 'ready'; sales_product: string | null;
    sales_link: string | null; last_preview: string; last_direction: string; sales_stage_at: number; followup_status: string | null;
  }>(
    db,
    `SELECT cv.id, cv.channel, cv.title, ct.display_name, cv.sales_stage, cv.sales_product, cv.sales_link, cv.last_preview, cv.last_direction, cv.sales_stage_at, cv.followup_status
     FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
     WHERE cv.sales_stage_at >= ? AND cv.sales_stage IN ('ready', 'interested')
     ORDER BY CASE cv.sales_stage WHEN 'ready' THEN 0 ELSE 1 END, cv.sales_stage_at DESC LIMIT 30`,
    now - 3 * DAY,
  );
  const fu = await all<{ followup_at: number; job_status: string | null; replied: number }>(
    db,
    `SELECT cv.followup_at, o.status AS job_status, CASE WHEN cv.last_inbound_at > cv.followup_at THEN 1 ELSE 0 END AS replied
     FROM conversations cv LEFT JOIN outbox o ON o.id = cv.followup_outbox_id
     WHERE cv.followup_at >= ? AND cv.followup_status IN ('queued', 'draft') LIMIT 1000`,
    now - 30 * DAY,
  );
  const followups = [7, 30].map((days): FollowUpWindow => {
    const rows = fu.filter((r) => r.followup_at >= now - days * DAY);
    return {
      days,
      sent: rows.filter((r) => r.job_status === 'sent').length,
      waiting: rows.filter((r) => r.job_status === 'pending' || r.job_status === 'leased' || r.job_status === 'review').length,
      replies: rows.filter((r) => r.job_status === 'sent' && r.replied).length,
    };
  });
  return {
    funnel: [await funnel(db, now - 7 * DAY, 7), await funnel(db, now - 30 * DAY, 30)],
    leads: leads.map((l) => ({
      conversation_id: l.id, channel: l.channel, customer: l.display_name || l.title || 'Customer', stage: l.sales_stage, product: l.sales_product,
      link: l.sales_link, last_message: l.last_preview, last_direction: l.last_direction, stage_at: l.sales_stage_at, followup_status: l.followup_status,
    })),
    followups,
    settings: salesSettings(settings),
  };
}

/** Check a PUT /api/sales/settings body. Unknown keys are dropped. Throws a message for the owner on a bad value. */
export function checkSalesPatch(body: Record<string, unknown>): Partial<SalesSettings> {
  const out: Partial<SalesSettings> = {};
  if ('follow_ups' in body) {
    if (typeof body.follow_ups !== 'boolean') throw new Error('follow_ups must be true or false');
    out.follow_ups = body.follow_ups;
  }
  if ('follow_up_hours' in body) {
    const h = Number(body.follow_up_hours);
    if (!Number.isInteger(h) || h < 1 || h > 72) throw new Error('Pick a wait between 1 and 72 hours');
    out.follow_up_hours = h;
  }
  if ('style' in body) {
    if (body.style !== 'friendly' && body.style !== 'relaxed' && body.style !== 'keen') throw new Error('Pick friendly, relaxed or keen');
    out.style = body.style;
  }
  return out;
}
