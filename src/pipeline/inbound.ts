import { decide } from '../brain';
import type {
  AgentJob, Channel, ContactRow, ConversationRow, Decision, DeviceRow, Env, HistoryMessage, MessageKind, MessageRow, Settings, UrgentRow,
} from '../types';
import { CHANNELS } from '../types';
import { sha256Hex } from '../lib/crypto';
import { all, clip, one, parseJson, run, uid } from '../lib/db';
import { logEvent } from '../lib/events';
import { bad } from '../lib/http';
import { getSettings } from '../lib/settings';
import { HOUR, MIN } from '../lib/time';
import { handleCodeTurn } from '../discounts/agent';
import { promisesLiveCode } from '../discounts/rules';
import { alertOwner } from './alerts';
import { noReplyNeeded } from './noreply';
export { noReplyNeeded };
import { emptyTarget, enqueue, leaseById } from './outbox';

const KINDS: MessageKind[] = ['text', 'image', 'voice', 'video', 'sticker', 'document', 'other'];
const MAX_MESSAGES = 40;
const MAX_BODY = 4000;
const HISTORY_FOR_BRAIN = 30;

export interface InboundMessage {
  external_id: string | null;
  direction: 'in' | 'out';
  body: string;
  kind: MessageKind;
  ts: number | null;
}

export interface InboundPayload {
  channel: Channel;
  thread: {
    external_id: string;
    title: string;
    is_group: boolean;
    subject: string | null;
    /** The owner just accepted this TikTok message request: answer it even though nothing is new. */
    just_accepted: boolean;
    contact: { name: string; phone: string | null; email: string | null; handle: string | null };
  };
  /** The last messages visible in the thread, oldest first. */
  messages: InboundMessage[];
}

export interface Outcome {
  conversation_id: string | null;
  action: 'reply' | 'review' | 'escalate' | 'none';
  reason: string;
  jobs: AgentJob[];
  new_inbound: number;
}

const s = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const sn = (v: unknown, max: number): string | null => s(v, max) || null;

export function parseInbound(raw: Record<string, unknown>): InboundPayload {
  const channel = raw.channel as Channel;
  if (!CHANNELS.includes(channel)) throw bad('invalid_field', 'channel must be whatsapp, gmail or tiktok', { field: 'channel' });
  const t = (raw.thread ?? {}) as Record<string, unknown>;
  const external_id = s(t.external_id, 300);
  if (!external_id) throw bad('missing_field', 'thread.external_id is required', { field: 'thread.external_id' });
  const c = (t.contact ?? {}) as Record<string, unknown>;
  const list = Array.isArray(raw.messages) ? raw.messages.slice(-MAX_MESSAGES) : [];
  const messages: InboundMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const direction = m.direction === 'out' ? 'out' : m.direction === 'in' ? 'in' : null;
    if (!direction) continue;
    const kind = KINDS.includes(m.kind as MessageKind) ? (m.kind as MessageKind) : 'text';
    const body = s(m.body, MAX_BODY);
    if (!body && kind === 'text') continue;
    const ts = typeof m.ts === 'number' && Number.isFinite(m.ts) && m.ts > 1_000_000_000_000 ? Math.round(m.ts) : null;
    messages.push({ external_id: sn(m.external_id, 300), direction, body, kind, ts });
  }
  return {
    channel,
    thread: {
      external_id,
      title: s(t.title, 200),
      is_group: t.is_group === true,
      just_accepted: t.just_accepted === true,
      subject: sn(t.subject, 300),
      contact: { name: s(c.name, 200), phone: normalisePhone(sn(c.phone, 40)), email: sn(c.email, 200)?.toLowerCase() ?? null, handle: sn(c.handle, 100) },
    },
    messages,
  };
}

function normalisePhone(p: string | null): string | null {
  if (!p) return null;
  const d = p.replace(/\D/g, '');
  return d.length >= 7 && d.length <= 15 ? `+${d}` : null;
}

export const normBody = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

const placeholderFor = (kind: MessageKind): string => {
  switch (kind) {
    case 'image': return '[sent a photo]';
    case 'voice': return '[sent a voice note]';
    case 'video': return '[sent a video]';
    case 'sticker': return '[sent a sticker]';
    case 'document': return '[sent a file]';
    default: return '[sent something that is not text]';
  }
};

// ---- storing -----------------------------------------------------------------------------------

interface Stored {
  conv: ConversationRow;
  contact: ContactRow;
  created: boolean;
  newInbound: number;
  takeover: boolean;
}

async function resolveConversation(db: D1Database, p: InboundPayload): Promise<{ conv: ConversationRow; contact: ContactRow; created: boolean }> {
  const now = Date.now();
  const { channel, thread } = p;
  let conv = await one<ConversationRow>(db, 'SELECT * FROM conversations WHERE channel = ? AND external_thread_id = ?', channel, thread.external_id);

  // A chat we opened by phone number is stored under the number; adopt the id the page reports.
  if (!conv && channel !== 'gmail' && thread.contact.phone) {
    conv = await one<ConversationRow>(
      db,
      `SELECT cv.* FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
       WHERE cv.channel = ? AND ct.phone = ? ORDER BY cv.updated_at DESC LIMIT 1`,
      channel, thread.contact.phone,
    );
    if (conv) {
      await run(db, 'UPDATE conversations SET external_thread_id = ? WHERE id = ?', thread.external_id, conv.id);
      conv.external_thread_id = thread.external_id;
    }
  }

  if (conv) {
    const contact = (await one<ContactRow>(db, 'SELECT * FROM contacts WHERE id = ?', conv.contact_id))!;
    const name = thread.contact.name || thread.title;
    if (name && name !== contact.display_name) {
      await run(db, 'UPDATE contacts SET display_name = ?, phone = COALESCE(?, phone), email = COALESCE(?, email), handle = COALESCE(?, handle), updated_at = ? WHERE id = ?',
        name, thread.contact.phone, thread.contact.email, thread.contact.handle, now, contact.id);
      contact.display_name = name;
    }
    if (thread.title && thread.title !== conv.title) await run(db, 'UPDATE conversations SET title = ? WHERE id = ?', thread.title, conv.id);
    return { conv, contact, created: false };
  }

  const contactKey =
    channel === 'gmail' ? (thread.contact.email ?? thread.external_id)
      : channel === 'whatsapp' ? (thread.contact.phone ? `${thread.contact.phone.slice(1)}@c.us` : thread.external_id)
        : (thread.contact.handle ?? thread.external_id).toLowerCase();
  const displayName = thread.contact.name || thread.title || thread.contact.email || thread.contact.phone || '';
  await run(
    db,
    `INSERT INTO contacts (id, channel, external_id, display_name, phone, email, handle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel, external_id) DO UPDATE SET display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE contacts.display_name END, updated_at = excluded.updated_at`,
    uid('ct'), channel, contactKey, displayName, thread.contact.phone, thread.contact.email, thread.contact.handle, now, now,
  );
  const contact = (await one<ContactRow>(db, 'SELECT * FROM contacts WHERE channel = ? AND external_id = ?', channel, contactKey))!;
  await run(
    db,
    `INSERT INTO conversations (id, channel, contact_id, external_thread_id, title, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel, external_thread_id) DO NOTHING`,
    uid('cv'), channel, contact.id, thread.external_id, thread.title || displayName, thread.subject, now, now,
  );
  conv = (await one<ConversationRow>(db, 'SELECT * FROM conversations WHERE channel = ? AND external_thread_id = ?', channel, thread.external_id))!;
  return { conv, contact, created: true };
}

/**
 * Save what the extension saw in a thread. Messages are matched to what we already hold by platform
 * id where there is one, otherwise by walking both lists in order, so nothing is stored or answered twice.
 */
export async function storeInbound(env: Env, p: InboundPayload, settings: Settings): Promise<Stored> {
  const db = env.DB;
  const now = Date.now();
  const { conv, contact, created } = await resolveConversation(db, p);

  const storedSeq = (await all<MessageRow>(
    db, 'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY ts DESC, created_at DESC LIMIT 120) ORDER BY ts ASC, created_at ASC', conv.id,
  ));
  const byExt = new Map<string, number>();
  storedSeq.forEach((m, i) => { if (m.external_id) byExt.set(m.external_id, i); });

  // Bodies the agent itself has queued or sent recently, to tell our own messages from the owner typing by hand.
  const ours = new Set<string>();
  const recentJobs = await all<{ parts: string }>(
    db, `SELECT parts FROM outbox WHERE conversation_id = ? AND status IN ('pending', 'leased', 'sent') AND source != 'manual' AND created_at > ?`, conv.id, now - 2 * HOUR,
  );
  for (const j of recentJobs) for (const part of parseJson<string[]>(j.parts, [])) ours.add(normBody(part));

  // On first sight of a thread, everything before the trailing run of customer messages is history.
  let tailStart = p.messages.length;
  while (tailStart > 0 && p.messages[tailStart - 1]!.direction === 'in') tailStart--;
  const tooOld = now - settings.pacing.ignore_older_than_hours * HOUR;

  let pointer = 0;
  let newInbound = 0;
  let takeover = false;
  let lastTs = storedSeq.length ? storedSeq[storedSeq.length - 1]!.ts : 0;
  let lastInboundAt: number | null = null;

  for (let i = 0; i < p.messages.length; i++) {
    const m = p.messages[i]!;
    const body = m.body || placeholderFor(m.kind);
    const key = normBody(body);

    if (m.external_id && byExt.has(m.external_id)) {
      pointer = Math.max(pointer, byExt.get(m.external_id)! + 1);
      continue;
    }
    let matched = -1;
    for (let j = pointer; j < storedSeq.length; j++) {
      const st = storedSeq[j]!;
      if (st.direction !== m.direction || normBody(st.body) !== key) continue;
      if (st.external_id && m.external_id) continue; // both have ids and they differ: different messages
      matched = j;
      break;
    }
    if (matched >= 0) {
      const st = storedSeq[matched]!;
      if (!st.external_id && m.external_id) {
        await run(db, 'UPDATE messages SET external_id = ? WHERE id = ? AND external_id IS NULL', m.external_id, st.id).catch(() => 0);
        st.external_id = m.external_id;
      }
      pointer = matched + 1;
      continue;
    }

    // New message.
    const ts = Math.max(m.ts ?? now, lastTs + 1);
    lastTs = ts;
    let author: MessageRow['author'] = 'customer';
    let status = 'received';
    if (m.direction === 'out') {
      author = ours.has(key) ? 'agent' : 'owner';
      status = 'sent';
      if (author === 'owner' && !created && (m.ts === null || m.ts > now - settings.pacing.human_takeover_minutes * MIN)) takeover = true;
    } else {
      const isHistory = (created && i < tailStart) || (m.ts !== null && m.ts < tooOld);
      if (isHistory) status = 'history';
      else { newInbound++; lastInboundAt = ts; }
    }
    if (created && m.direction === 'out') status = 'history';
    await run(
      db,
      `INSERT INTO messages (id, conversation_id, direction, author, external_id, body, kind, status, ts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      uid('m'), conv.id, m.direction, author, m.external_id, body, m.kind, status, ts, now,
    );
  }

  const last = p.messages[p.messages.length - 1];
  if (last) {
    const preview = clip(last.body || placeholderFor(last.kind), 140);
    await run(
      db,
      `UPDATE conversations SET last_preview = ?, last_direction = ?, last_inbound_at = COALESCE(?, last_inbound_at), updated_at = ?,
         needs_reply_since = CASE WHEN ? > 0 THEN COALESCE(needs_reply_since, ?) ELSE needs_reply_since END
       WHERE id = ?`,
      preview, last.direction, lastInboundAt, newInbound > 0 || takeover ? now : conv.updated_at, newInbound, now, conv.id,
    );
  }
  if (takeover) {
    const until = now + settings.pacing.human_takeover_minutes * MIN;
    // If the customer wrote again after you, keep them marked as waiting so the agent answers when the timer ends.
    const lastSeen = p.messages[p.messages.length - 1];
    const waiting = lastSeen?.direction === 'in' ? now : null;
    await run(db, `UPDATE conversations SET paused_until = ?, pause_reason = 'You replied yourself', needs_reply_since = ? WHERE id = ?`, until, waiting, conv.id);
    await logEvent(db, { type: 'takeover', channel: p.channel, conversation_id: conv.id, message: `You replied to ${contact.display_name || 'a customer'} yourself. Agent is staying out of that chat for ${settings.pacing.human_takeover_minutes} min.` });
  }
  if (newInbound > 0 && last) {
    await logEvent(db, {
      type: 'inbound', channel: p.channel, conversation_id: conv.id,
      message: `${contact.display_name || p.thread.title || 'Customer'}: ${clip(last.body || placeholderFor(last.kind), 200)}`,
    });
  }
  const fresh = (await one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', conv.id))!;
  return { conv: fresh, contact, created, newInbound, takeover };
}

// ---- deciding ------------------------------------------------------------------------------------

function pacingFor(settings: Settings, customerChars: number): { delay_ms: number; typing_cps: number } {
  const min = settings.pacing.min_reply_delay_s * 1000;
  const max = Math.max(min, settings.pacing.max_reply_delay_s * 1000);
  const reading = Math.min(1, customerChars / 220);
  const delay = min + (max - min) * (0.55 * reading + 0.45 * Math.random());
  return { delay_ms: Math.round(delay), typing_cps: settings.pacing.typing_cps };
}

async function loadHistory(db: D1Database, convId: string): Promise<{ rows: MessageRow[]; history: HistoryMessage[] }> {
  const rows = await all<MessageRow>(
    db, 'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY ts DESC, created_at DESC LIMIT ?) ORDER BY ts ASC, created_at ASC', convId, HISTORY_FOR_BRAIN,
  );
  return { rows, history: rows.map((m) => ({ direction: m.direction, author: m.author, body: m.body, kind: m.kind, ts: m.ts })) };
}

const none = (conversation_id: string | null, reason: string, new_inbound = 0): Outcome => ({ conversation_id, action: 'none', reason, jobs: [], new_inbound });

/**
 * Decide what to do about a conversation that has unanswered customer messages and queue the result.
 * Safe to call twice: a short lock and the outbox dedupe key stop double replies.
 */
export async function processConversation(env: Env, convId: string, device: DeviceRow | null, newInbound = 0): Promise<Outcome> {
  const db = env.DB;
  const settings = await getSettings(db);
  const now = Date.now();
  const conv = await one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', convId);
  if (!conv) return none(null, 'conversation_missing');
  const contact = (await one<ContactRow>(db, 'SELECT * FROM contacts WHERE id = ?', conv.contact_id))!;
  const clear = () => run(db, 'UPDATE conversations SET needs_reply_since = NULL, processing_until = NULL WHERE id = ?', convId);

  if (!settings.agent.enabled) return none(convId, 'agent_off', newInbound);
  const mode = settings.channels[conv.channel].mode;
  if (mode === 'off') { await clear(); return none(convId, 'channel_off', newInbound); }
  if (contact.opted_out) { await clear(); return none(convId, 'contact_opted_out', newInbound); }
  if (conv.channel === 'gmail' && isIgnoredSender(contact.email, settings.gmail.ignore_senders)) {
    await clear();
    return none(convId, 'not_a_customer', newInbound);
  }
  if (conv.paused_until && conv.paused_until > now) return none(convId, 'paused', newInbound);

  const { rows, history } = await loadHistory(db, convId);
  const lastMsg = rows[rows.length - 1];
  if (!lastMsg || lastMsg.direction !== 'in' || lastMsg.status === 'history') { await clear(); return none(convId, 'nothing_to_answer', newInbound); }

  // Messages that need no answer at all (day 12 streaks, a lone thumbs up) are skipped without using the AI.
  const unanswered = rows.slice(rows.map((m) => m.direction).lastIndexOf('out') + 1).filter((m) => m.direction === 'in');
  const skip = unanswered.length > 0 && unanswered.every((m) => noReplyNeeded(m.body, m.kind));
  if (skip) {
    await clear();
    await logEvent(db, { type: 'skipped', channel: conv.channel, conversation_id: convId, message: `No reply needed for ${contact.display_name || 'a customer'}: "${clip(lastMsg.body, 80)}"` });
    return none(convId, 'no_reply_needed', newInbound);
  }

  // Runaway guard: two bots talking, or someone hammering the chat.
  const sentLastHour = (await one<{ n: number }>(
    db, `SELECT COUNT(*) AS n FROM outbox WHERE conversation_id = ? AND source IN ('auto', 'holding') AND status IN ('sent', 'leased', 'pending') AND created_at > ?`, convId, now - HOUR,
  ))?.n ?? 0;
  if (sentLastHour >= settings.pacing.max_auto_replies_per_thread_per_hour) {
    await clear();
    await run(db, `UPDATE conversations SET paused_until = ?, pause_reason = 'Very busy chat, paused for an hour' WHERE id = ?`, now + HOUR, convId);
    await logEvent(db, { level: 'warn', type: 'rate_cap', channel: conv.channel, conversation_id: convId, message: `Paused the chat with ${contact.display_name || 'a customer'} for an hour: too many automatic replies in a row.` });
    return none(convId, 'rate_cap', newInbound);
  }

  // Lock so the cron sweeper and a live request never answer the same message together.
  const locked = await run(db, 'UPDATE conversations SET processing_until = ? WHERE id = ? AND (processing_until IS NULL OR processing_until < ?)', now + 2 * MIN, convId, now);
  if (!locked) return none(convId, 'already_processing', newInbound);

  const openUrgent = await one<UrgentRow>(db, `SELECT * FROM urgent WHERE conversation_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`, convId);
  const notes = parseJson<string[]>(conv.context_notes, []);
  if (rows.some((m) => m.direction === 'in' && m.status !== 'history' && m.kind !== 'text' && m.kind !== 'sticker')) {
    notes.push('The customer sent a photo, video, voice note or file you cannot see or hear. Never say you cannot open, see, play or view it. If your answer depends on what is in it, escalate, and keep any holding line about checking with the team without mentioning the photo or video.');
  }
  notes.push('Read the whole conversation above before you write. Reply to what the customer means given everything said earlier in this chat, do not repeat something already answered, and do not answer an older message again.');
  notes.push('If the latest message needs no reply, choose action ignore. Examples: counting days or streaks (day 12, day 13) to win a free kit, chain or spam messages, a lone ok, thanks or emoji when the chat is already finished.');
  if (conv.channel === 'gmail') {
    notes.push('Only answer customers or people asking about buying, orders, products, delivery, returns or sponsorship. If this email is from a supplier, courier, payment company, platform, marketing sender, job or service pitch, or is an automatic notification, receipt or verification code, choose action ignore and write no reply.');
  }
  if (openUrgent) notes.push(`The customer is already waiting on an answer from the owner about: "${openUrgent.question}". They have been told someone is checking. Do not send another holding line for the same thing.`);

  const customerChars = rows.filter((m) => m.direction === 'in').slice(-3).reduce((n, m) => n + m.body.length, 0);
  const pacing = pacingFor(settings, customerChars);
  const target = emptyTarget({
    thread_external_id: conv.external_thread_id, title: conv.title || contact.display_name, phone: contact.phone,
    email: contact.email, handle: contact.handle, subject: conv.subject,
  });

  // A customer asking for their own creator code: made here, or parked for the owner, instead of a
  // normal reply. A request with no code only adds a note so the reply asks what they want.
  if (settings.discounts.mode !== 'off') {
    let turn: Awaited<ReturnType<typeof handleCodeTurn>> = { kind: 'none' };
    try {
      turn = await handleCodeTurn(env, { settings, conv, contact, history, rows, channel_mode: mode, device, target, pacing, now });
    } catch (err) {
      console.error('discount code turn failed', err);
      await logEvent(db, { level: 'error', type: 'discount_error', channel: conv.channel, conversation_id: convId, message: `Could not handle a discount code request from ${contact.display_name || 'a customer'}: ${clip(String((err as Error)?.message ?? err), 200)}` });
    }
    if (turn.kind === 'done') {
      await clear();
      return { conversation_id: convId, action: turn.action, reason: turn.reason, jobs: turn.jobs, new_inbound: newInbound };
    }
    if (turn.kind === 'note') notes.push(turn.note);
  }

  let decision: Decision;
  try {
    decision = await decide(env, {
      channel: conv.channel, contact_name: contact.display_name || null, subject: conv.subject,
      history, context_notes: notes, now, mode: 'live',
    });
  } catch (err) {
    await run(db, 'UPDATE conversations SET processing_until = NULL WHERE id = ?', convId); // keep needs_reply_since so the sweeper retries
    await logEvent(db, { level: 'error', type: 'brain_error', channel: conv.channel, conversation_id: convId, message: `Could not work out a reply for ${contact.display_name || 'a customer'}: ${clip(String((err as Error)?.message ?? err), 200)}` });
    return none(convId, 'brain_error', newInbound);
  }

  await run(db, 'UPDATE contacts SET tone_profile = ?, updated_at = ? WHERE id = ?', JSON.stringify(decision.tone), now, contact.id);
  const who = contact.display_name || conv.title || 'customer';
  const jobs: AgentJob[] = [];
  let action: Outcome['action'] = 'none';
  let reason = decision.note || decision.action;

  if (decision.flags.opt_out) {
    await run(db, 'UPDATE contacts SET opted_out = 1, updated_at = ? WHERE id = ?', now, contact.id);
    await logEvent(db, { level: 'warn', type: 'opt_out', channel: conv.channel, conversation_id: convId, message: `${who} asked not to be messaged. They will not be contacted again.` });
  }

  let act = decision.action;
  let draft: string | null = null;
  // Only the code template may tell a customer a code is live, and only after the code exists.
  const promisesCode = act === 'reply' && promisesLiveCode(decision.parts.join(' '));
  if (act === 'reply' && (decision.confidence < settings.brain.confidence_threshold || decision.flags.needs_human || promisesCode)) {
    // Not sure enough to speak for the business: park it with the draft so the owner can approve in one tap.
    draft = decision.parts.join('\n');
    act = 'escalate';
    decision.escalate = decision.escalate ?? {
      question: clip(lastMsg.body, 300),
      reason: promisesCode ? 'The reply says a discount code is ready, but no code was made' : decision.flags.needs_human ? 'Looks like this one needs a person' : 'Not confident enough to answer alone',
      category: 'low_confidence',
    };
    decision.parts = [];
  }

  if (act === 'reply' && decision.parts.length) {
    const id = await enqueue(db, {
      channel: conv.channel, kind: 'reply', conversation_id: convId, target, parts: decision.parts,
      source: 'auto', status: mode === 'review' ? 'review' : 'pending', pacing,
      dedupe_key: `auto:${convId}:${lastMsg.id}`,
    });
    if (id && mode === 'review') {
      action = 'review';
      await logEvent(db, { type: 'draft', channel: conv.channel, conversation_id: convId, message: `Draft ready for ${who}: ${clip(decision.parts.join(' '), 160)}`, data: { outbox_id: id } });
      await alertOwner(env, settings, { kind: 'review', title: 'Reply waiting for your OK', body: `${who}: ${clip(lastMsg.body, 90)}`, path: '/#/urgent' });
    } else if (id) {
      action = 'reply';
      if (device) {
        const job = await leaseById(db, device, id, settings, pacing.delay_ms);
        if (job) jobs.push(job);
      }
    } else {
      reason = 'duplicate';
    }
  } else if (act === 'escalate') {
    action = 'escalate';
    const esc = decision.escalate ?? { question: clip(lastMsg.body, 300), reason: 'Needs the owner', category: 'unknown' };
    const customerWords = rows.filter((m) => m.direction === 'in' && m.status !== 'history').slice(-3).map((m) => m.body).join('\n');
    if (openUrgent) {
      await run(db, 'UPDATE urgent SET question = ?, customer_message = ?, reason = ?, polished_answer = COALESCE(?, polished_answer) WHERE id = ?',
        clip(esc.question, 500), clip(customerWords, 1500), clip(esc.reason, 300), draft, openUrgent.id);
    } else {
      const urgentId = uid('u');
      await run(
        db,
        `INSERT INTO urgent (id, conversation_id, channel, question, customer_message, reason, category, status, polished_answer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        urgentId, convId, conv.channel, clip(esc.question, 500), clip(customerWords, 1500), clip(esc.reason, 300), clip(esc.category, 40), draft, now,
      );
      await run(db, `UPDATE conversations SET status = 'waiting_owner' WHERE id = ?`, convId);
      await logEvent(db, { level: 'warn', type: 'escalated', channel: conv.channel, conversation_id: convId, message: `Needs you: ${who} asked "${clip(esc.question, 160)}"`, data: { urgent_id: urgentId } });
      if (decision.parts.length && settings.voice.holding_reply && mode === 'auto') {
        const hid = await enqueue(db, {
          channel: conv.channel, kind: 'reply', conversation_id: convId, target, parts: decision.parts.slice(0, 1),
          source: 'holding', ref_id: urgentId, pacing, dedupe_key: `holding:${urgentId}`,
        });
        if (hid && device) {
          const job = await leaseById(db, device, hid, settings, pacing.delay_ms);
          if (job) jobs.push(job);
        }
      }
      await alertOwner(env, settings, { kind: 'urgent', title: 'A customer question needs you', body: `${who}: ${clip(esc.question, 120)}`, path: '/#/urgent' });
    }
  } else {
    reason = decision.note || 'no_reply_needed';
  }

  await clear();
  return { conversation_id: convId, action, reason, jobs, new_inbound: newInbound };
}

/** Full inbound path used by the extension endpoint. */
export async function handleInbound(env: Env, device: DeviceRow, payload: InboundPayload, onStored?: (o: { conversation_id: string; new_inbound: number }) => void): Promise<Outcome> {
  if (payload.thread.is_group) return none(null, 'group_chat');
  const settings = await getSettings(env.DB);
  const stored = await storeInbound(env, payload, settings);
  onStored?.({ conversation_id: stored.conv.id, new_inbound: stored.newInbound });
  if (stored.takeover) return none(stored.conv.id, 'human_takeover', stored.newInbound);
  if (!stored.newInbound && !stored.conv.needs_reply_since) {
    // A message request the owner just accepted: the earlier reply could not be sent while it was a
    // request, so answer it now if the customer is still the last to speak.
    if (payload.thread.just_accepted) return processConversation(env, stored.conv.id, device, 0);
    return none(stored.conv.id, 'nothing_new');
  }
  return processConversation(env, stored.conv.id, device, stored.newInbound);
}

/** Cron safety net: answer conversations whose live request died before the brain finished. */
export async function sweepConversations(env: Env, limit = 2): Promise<number> {
  const now = Date.now();
  const due = await all<{ id: string }>(
    env.DB,
    `SELECT id FROM conversations WHERE needs_reply_since IS NOT NULL AND needs_reply_since < ? AND needs_reply_since > ?
       AND (processing_until IS NULL OR processing_until < ?) AND (paused_until IS NULL OR paused_until < ?)
     ORDER BY needs_reply_since ASC LIMIT ?`,
    now - 2 * MIN, now - 6 * HOUR, now, now, limit,
  );
  for (const row of due) await processConversation(env, row.id, null);
  // Give up on very old ones so they do not sit in the queue forever.
  await run(env.DB, 'UPDATE conversations SET needs_reply_since = NULL WHERE needs_reply_since IS NOT NULL AND needs_reply_since <= ?', now - 6 * HOUR);
  return due.length;
}

/** Stable id for a message when the platform gives none. Exposed for the extension contract tests. */
export async function contentId(direction: string, body: string, occurrence: number): Promise<string> {
  return `x:${direction}:${(await sha256Hex(normBody(body))).slice(0, 16)}:${occurrence}`;
}

/** True when the email address matches an address or domain on the owner's never-answer list. */
export function isIgnoredSender(email: string | null, list: string[]): boolean {
  if (!email) return false;
  const addr = email.trim().toLowerCase();
  const domain = addr.split('@')[1] ?? '';
  return list.some((raw) => {
    const item = raw.trim().toLowerCase().replace(/^@/, '');
    if (!item) return false;
    if (item.includes('@')) return addr === item;
    return domain === item || domain.endsWith(`.${item}`);
  });
}

