// Owner facing API for the core screens: Live, Urgent, Inbox, Settings, Health.
import type { Channel, ContactRow, ConversationRow, Env, JobTarget, MessageRow, OutboxRow, Settings, UrgentRow } from '../types';
import { CHANNELS } from '../types';
import { pairingCode, sha256Hex } from '../lib/crypto';
import { all, clip, one, parseJson, run } from '../lib/db';
import { logEvent } from '../lib/events';
import { MEDIA_KEEP_DAYS, base64Bytes, type MediaRef } from '../lib/media';
import { HttpError, bad, bool, int, json, str, type Router } from '../lib/http';
import { getSettings, getState, isSettingsGroup, patchSettings, secretHints, setState } from '../lib/settings';
import { DAY, HOUR, MIN, londonTime, nextLondonHour } from '../lib/time';
import { cancelAgentJobs, cancelForOptOut, cancelJob, emptyTarget, enqueue } from '../pipeline/outbox';
import { processConversation } from '../pipeline/inbound';
import { answerUrgent, answerUrgentWithNote, dismissUrgent, sendUrgentDraft } from '../pipeline/urgent';
import { currentDevice, pairingCodeRow, selectorPack } from './agent';
import { checkDiscountPatch } from '../discounts/rules';
import { checkVisionPatch } from '../vision';
import { monitorRows } from '../pipeline/monitor';
import { usageToday } from '../lib/usage';
import { todayStats } from '../pipeline/today';
import { cachedAnswer, onReset } from '../lib/cache';
import { DASHBOARD_SECONDS, budget, type Budget, type BudgetLevel } from '../lib/budget';
import { kbTotals } from '../kb/cache';

const count = async (db: D1Database, sql: string, ...p: (string | number)[]) => (await one<{ n: number }>(db, sql, ...p))?.n ?? 0;

function startOfLondonDay(now: number): number {
  const lt = londonTime(now);
  return now - (lt.hour * HOUR + lt.minute * MIN) - (now % MIN);
}

/** Rows of `sql` for every id in `ids`, in one query whatever the count (D1 caps bound parameters at 100). */
const byIds = <T>(db: D1Database, sql: string, ids: string[]) => (ids.length ? all<T>(db, sql, JSON.stringify([...new Set(ids)])) : Promise.resolve([] as T[]));
const IDS = 'SELECT value FROM json_each(?)';

/**
 * The last `n` messages of each conversation, oldest first. One query for all of them, and it reads only
 * those messages (through the messages_conv index), not every message of the chats.
 */
async function recentMessages(db: D1Database, convIds: string[], n: number, direction?: 'in'): Promise<Map<string, MessageRow[]>> {
  const rows = await byIds<MessageRow>(
    db,
    `SELECT m.* FROM json_each(?) j JOIN messages m ON m.rowid IN (
       SELECT rowid FROM messages WHERE conversation_id = j.value${direction ? ` AND direction = '${direction}'` : ''} ORDER BY ts DESC, created_at DESC LIMIT ${n})
     ORDER BY m.ts ASC, m.created_at ASC`,
    convIds,
  );
  const out = new Map<string, MessageRow[]>();
  for (const m of rows) { const list = out.get(m.conversation_id) ?? []; list.push(m); out.set(m.conversation_id, list); }
  return out;
}

/**
 * How long a dashboard answer is kept in memory. Any D1 write in this isolate (an owner action, a new
 * message, a sync that changed something) drops them all at once (src/lib/cache.ts), so a screen is never
 * behind its own changes. Longer when the day's database use is high.
 */
const answerTtl = (level: BudgetLevel) => (level === 'normal' ? 20_000 : 60_000);
const budgetView = (b: Budget) => ({ level: b.level, poll_seconds: DASHBOARD_SECONDS[b.level], read_pct: b.read_pct, write_pct: b.write_pct });

/**
 * The picture a message came with, for a thumbnail: { id, kind } or null, plus description (what the
 * vision model saw, src/vision) once it has looked. Read from the message row, no extra query.
 */
function mediaOf(m: MessageRow, now: number): { id: string; kind: string; description?: string } | null {
  const ref = parseJson<MediaRef>(m.meta, {});
  // Pictures are deleted after 14 days (src/cron.ts): do not point at one that is gone.
  if (typeof ref.media !== 'string' || m.created_at < now - MEDIA_KEEP_DAYS * DAY) return null;
  const kind = ref.media_kind === 'video_frame' ? 'video_frame' : 'image';
  return typeof ref.media_desc === 'string' && ref.media_desc ? { id: ref.media, kind, description: ref.media_desc } : { id: ref.media, kind };
}

async function conversationsById(db: D1Database, ids: string[]): Promise<Map<string, ConversationRow & { display_name: string | null }>> {
  const rows = await byIds<ConversationRow & { display_name: string | null }>(
    db, `SELECT cv.*, ct.display_name FROM conversations cv LEFT JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id IN (${IDS})`, ids,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function urgentView(db: D1Database, rows: UrgentRow[], now: number) {
  // A few queries for the whole list, not four per card: the free plan allows 50 per request.
  const convIds = rows.map((u) => u.conversation_id);
  const discountIds = rows.map((u) => u.discount_id).filter((x): x is string => Boolean(x));
  const [convs, recentBy, discounts] = await Promise.all([
    conversationsById(db, convIds),
    recentMessages(db, convIds, 8),
    byIds<{ id: string; code: string; amount: number; status: string; shopify_status: string; error: string | null; message_text: string }>(
      db, `SELECT id, code, amount, status, shopify_status, error, message_text FROM discount_codes WHERE id IN (${IDS})`, discountIds),
  ]);
  const dcById = new Map(discounts.map((d) => [d.id, d]));
  const out = [];
  for (const u of rows) {
    const conv = convs.get(u.conversation_id) ?? null;
    const recent = recentBy.get(u.conversation_id) ?? [];
    const dc = u.discount_id ? dcById.get(u.discount_id) ?? null : null;
    out.push({
      id: u.id, channel: u.channel, status: u.status, question: u.question, customer_message: u.customer_message,
      reason: u.reason, category: u.category, draft: u.status === 'open' ? u.polished_answer : null,
      owner_answer: u.owner_answer, owner_note: u.owner_note, sent_text: u.status !== 'open' ? u.polished_answer : null,
      created_at: u.created_at, answered_at: u.answered_at, sent_at: u.sent_at,
      conversation_id: u.conversation_id, customer: conv?.display_name || conv?.title || 'Customer',
      recent: recent.map((m) => ({ direction: m.direction, author: m.author, body: m.body, kind: m.kind, ts: m.ts, media: mediaOf(m, now) })),
      discount: dc ? { id: dc.id, code: dc.code, amount: dc.amount, status: dc.status, shopify_status: dc.shopify_status, error: dc.error, message_text: dc.message_text } : null,
    });
  }
  return out;
}

function reviewView(row: OutboxRow, conv: ConversationRow | null, lastInbound: string) {
  const target = parseJson<JobTarget>(row.target, emptyTarget());
  return {
    id: row.id, channel: row.channel, parts: parseJson<string[]>(row.parts, []), created_at: row.created_at,
    conversation_id: row.conversation_id, customer: conv?.title || target.title || target.email || target.phone || 'Customer',
    subject: conv?.subject ?? target.subject, customer_message: lastInbound,
  };
}

/** What Live shows. Today's numbers come from the running count (src/pipeline/today.ts), not a full count each time. */
async function overview(env: Env, db: D1Database, now: number) {
  const settings = await getSettings(db);
  const day = startOfLondonDay(now);
  const [devices, hints, mon, today, kb] = await Promise.all([currentDevice(db, now), secretHints(db), monitorRows(db), todayStats(db, day, now), kbTotals(env)]);
  const device = devices[0] ?? null;
  const [urgentOpen, reviewPending, queued] = await Promise.all([
    count(db, `SELECT COUNT(*) AS n FROM urgent WHERE status = 'open'`),
    count(db, `SELECT COUNT(*) AS n FROM outbox WHERE status = 'review'`),
    count(db, `SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending', 'leased')`),
  ]);
  const lastRun = await one<Record<string, unknown>>(db, `SELECT * FROM recovery_runs WHERE trigger != 'dry_run' ORDER BY started_at DESC LIMIT 1`);
  const hasClaude = Boolean(hints.anthropic_api_key || env.ANTHROPIC_API_KEY);
  const shopifyApi = Boolean(hints.shopify_client_secret || hints.shopify_admin_token);
  const shopifyHook = Boolean(hints.shopify_webhook_secret);
  const brainProvider = settings.brain.provider === 'workers_ai' ? 'workers_ai' : hasClaude ? 'anthropic' : env.AI ? 'workers_ai' : 'none';
  const pushCount = await count(db, 'SELECT COUNT(*) AS n FROM push_subscriptions');
  return {
    now,
    agent: { enabled: settings.agent.enabled },
    device,
    channels: settings.channels,
    // Channel problems, chats waiting with no reply and AI failures found by the every minute check.
    monitor: { channels: mon.monitor.channels, stuck: mon.monitor.stuck_by_channel, ai_failing: mon.monitor.ai_failing },
    usage: usageToday(mon.usage, now),
    // How fast the agent answered today: average and slowest, from the customer's message to sent.
    reply_time: today.reply_time,
    counts: {
      urgent_open: urgentOpen, review_pending: reviewPending, inbound_today: today.inbound_today, sent_today: today.sent_today,
      queued, conversations_today: today.conversations_today, auto_today: today.auto_today, escalated_today: today.escalated_today,
    },
    brain: { provider: brainProvider, model: brainProvider === 'anthropic' ? settings.brain.model : settings.brain.workers_ai_model, claude_key: hasClaude },
    shopify: { connected: shopifyApi || shopifyHook, mode: shopifyApi ? 'api' : shopifyHook ? 'webhook' : 'none' },
    kb: { docs: kb.docs, tokens: kb.tokens },
    recovery: {
      enabled: settings.recovery.enabled,
      template_ready: settings.recovery.template.approved && settings.recovery.template.text.trim().length > 0 && settings.recovery.consent_confirmed,
      next_run_at: nextLondonHour(now, settings.recovery.send_hour_london),
      last_run: lastRun,
    },
    setup: {
      device_paired: devices.length > 0,
      brain_ready: brainProvider !== 'none',
      knowledge_added: kb.docs > 0,
      shopify_connected: shopifyApi || shopifyHook,
      recovery_taught: settings.recovery.template.approved,
      push_enabled: pushCount > 0,
    },
  };
}

/** The Urgent screen: open questions with their chats, and the drafts waiting for an OK. A few queries for the whole list. */
async function urgentList(db: D1Database, status: 'open' | 'done', now: number) {
  const rows = status === 'open'
    ? await all<UrgentRow>(db, `SELECT * FROM urgent WHERE status = 'open' ORDER BY created_at ASC LIMIT 100`)
    : await all<UrgentRow>(db, `SELECT * FROM urgent WHERE status != 'open' ORDER BY COALESCE(answered_at, created_at) DESC LIMIT 50`);
  const reviewOut = [];
  if (status === 'open') {
    const review = await all<OutboxRow>(db, `SELECT * FROM outbox WHERE status = 'review' ORDER BY created_at ASC LIMIT 100`);
    const convIds = review.map((r) => r.conversation_id).filter((x): x is string => Boolean(x));
    const [convs, lastIn] = await Promise.all([conversationsById(db, convIds), recentMessages(db, convIds, 1, 'in')]);
    for (const row of review) {
      const conv = row.conversation_id ? convs.get(row.conversation_id) ?? null : null;
      reviewOut.push(reviewView(row, conv, (row.conversation_id && lastIn.get(row.conversation_id)?.[0]?.body) || ''));
    }
  }
  return { urgent: await urgentView(db, rows, now), review: reviewOut };
}

/** One chat for the Inbox thread view: the newest 120 messages and what is waiting to send. Null when there is no such chat. */
async function conversationView(db: D1Database, id: string, now: number) {
  const conv = await one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', id);
  if (!conv) return null;
  const contact = (await one<ContactRow>(db, 'SELECT * FROM contacts WHERE id = ?', conv.contact_id))!;
  const [messages, pending] = await Promise.all([
    all<MessageRow>(db, 'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY ts DESC, created_at DESC LIMIT 120) ORDER BY ts ASC, created_at ASC', conv.id),
    // What waits to send is few rows: read through the status index, not every job the chat ever had.
    all<OutboxRow>(db, `SELECT * FROM outbox INDEXED BY outbox_due WHERE status IN ('pending', 'leased', 'review') AND conversation_id = ? ORDER BY created_at ASC`, conv.id),
  ]);
  return {
    conversation: {
      id: conv.id, contact_id: contact.id, channel: conv.channel, customer: contact.display_name || conv.title || 'Customer', subject: conv.subject,
      status: conv.status, paused_until: conv.paused_until && conv.paused_until > now ? conv.paused_until : null, pause_reason: conv.pause_reason,
      phone: contact.phone, email: contact.email, handle: contact.handle, opted_out: Boolean(contact.opted_out),
      tone: parseJson(contact.tone_profile, {}),
    },
    messages: messages.map((m) => ({ id: m.id, direction: m.direction, author: m.author, body: m.body, kind: m.kind, status: m.status, ts: m.ts, media: mediaOf(m, now) })),
    pending: pending.map((p) => ({ id: p.id, status: p.status, source: p.source, parts: parseJson<string[]>(p.parts, []) })),
  };
}

/** Rows in the Inbox list. */
const CONVERSATION_LIST_LIMIT = 50;

/**
 * AI calls of the last 24 hours by model, for Health. It reads every call of the day (about 600 rows on a
 * busy day), so it is kept for 5 minutes whatever else changes: Health may stay open for a long time.
 */
const LLM_USAGE_MS = 5 * MIN;
let llmUsage: { at: number; rows: Promise<unknown[]> } | null = null;
onReset(() => { llmUsage = null; });
function llmUsageDay(db: D1Database, now: number): Promise<unknown[]> {
  if (llmUsage && now - llmUsage.at < LLM_USAGE_MS && now >= llmUsage.at) return llmUsage.rows;
  const rows = all(db, `SELECT provider, model, COUNT(*) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens, AVG(ms) AS avg_ms, SUM(ok) AS ok FROM llm_usage WHERE ts > ? GROUP BY provider, model`, now - DAY);
  llmUsage = { at: now, rows };
  rows.catch(() => { if (llmUsage?.rows === rows) llmUsage = null; });
  return rows;
}

/** The Health screen: the last day of problems, the laptop, the monitor and today's reply times. */
async function healthView(db: D1Database, now: number) {
  const since = now - DAY;
  const [devices, misses, failed, errors, usage, sel, mon, today] = await Promise.all([
    currentDevice(db, now),
    all(db, `SELECT id, ts, channel, kind, data FROM diagnostics WHERE ts > ? ORDER BY id DESC LIMIT 60`, since),
    all<OutboxRow>(db, `SELECT * FROM outbox WHERE status IN ('failed', 'expired') AND created_at > ? ORDER BY created_at DESC LIMIT 30`, since),
    all(db, `SELECT id, ts, type, channel, message FROM events WHERE level = 'error' AND ts > ? ORDER BY id DESC LIMIT 30`, since),
    llmUsageDay(db, now),
    selectorPack(db),
    monitorRows(db),
    todayStats(db, startOfLondonDay(now), now),
  ]);
  return {
    now,
    devices,
    monitor: { channels: mon.monitor.channels, stuck: mon.monitor.stuck_by_channel, ai_failing: mon.monitor.ai_failing },
    // Rows this Worker used today, counted in the Worker itself. An estimate: see src/lib/usage.ts.
    d1_usage: usageToday(mon.usage, now),
    // Agent replies sent today (London day): average and slowest time from the customer's message to sent.
    reply_time: today.reply_time,
    diagnostics: misses.map((m) => ({ ...(m as object), data: parseJson((m as { data: string }).data, {}) })),
    failed_jobs: failed.map((f) => ({ id: f.id, channel: f.channel, source: f.source, status: f.status, error: f.status === 'expired' ? `expired: not sent in time${f.last_error ? ` (${f.last_error})` : ''}` : f.last_error, created_at: f.created_at, target: parseJson<JobTarget>(f.target, emptyTarget()).title })),
    errors,
    llm_usage: usage,
    selectors_version: sel.version,
  };
}

export function register(r: Router): void {
  // ---- Live ------------------------------------------------------------------------------------
  r.get('/api/overview', 'owner', async (c) => {
    const guard = await budget(c.db, c.now);
    // Polled by every open dashboard: kept in memory for a short while (see answerTtl).
    const data = await cachedAnswer('overview', answerTtl(guard.level), c.now, () => overview(c.env, c.db, c.now));
    return json({ ...data, budget: budgetView(guard) });
  });

  r.get('/api/events', 'owner', async (c) => {
    const after = int(c.url.searchParams.get('after'), 'after', 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = int(c.url.searchParams.get('limit'), 'limit', 1, 200, 60);
    const level = (await budget(c.db, c.now)).level;
    const rows = await cachedAnswer(`events:${after}:${limit}`, answerTtl(level), c.now, () => after
      ? all(c.db, 'SELECT * FROM (SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?) ORDER BY id DESC', after, limit)
      : all(c.db, 'SELECT * FROM events ORDER BY id DESC LIMIT ?', limit));
    return json({ events: rows });
  });

  r.post('/api/agent-toggle', 'owner', async (c) => {
    const body = await c.body<{ enabled?: unknown }>();
    const enabled = bool(body.enabled, true);
    await patchSettings(c.db, 'agent', { enabled });
    await logEvent(c.db, { level: enabled ? 'good' : 'warn', type: 'agent_toggle', message: enabled ? 'Agent switched on.' : 'Agent switched off. Nothing will be sent.' });
    return json({ enabled });
  });

  // Stop everything now: switch off and throw away whatever is still waiting to be sent.
  r.post('/api/panic', 'owner', async (c) => {
    await patchSettings(c.db, 'agent', { enabled: false });
    const cancelled = await run(c.db, `UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'review', 'leased')`);
    await run(c.db, `UPDATE checkouts SET status = 'new', outbox_id = NULL WHERE status = 'queued'`);
    await logEvent(c.db, { level: 'warn', type: 'panic', message: `Emergency stop. Agent is off and ${cancelled} waiting message${cancelled === 1 ? ' was' : 's were'} cancelled.` });
    return json({ ok: true, cancelled });
  });

  // ---- Urgent -------------------------------------------------------------------------------------
  r.get('/api/urgent', 'owner', async (c) => {
    const status = c.url.searchParams.get('status') === 'done' ? 'done' : 'open';
    const level = (await budget(c.db, c.now)).level;
    return json(await cachedAnswer(`urgent:${status}`, answerTtl(level), c.now, () => urgentList(c.db, status, c.now)));
  });

  r.post('/api/urgent/:id/answer', 'owner', async (c) => {
    const body = await c.body<{ answer?: unknown; learn?: unknown }>();
    const answer = str(body.answer, 'answer', { max: 2000 });
    const res = await answerUrgent(c.env, c.params.id!, answer, bool(body.learn, true));
    return json({ ok: true, parts: res.parts, learned: res.learned, status: res.urgent.status });
  });

  // "Tell the agent what's going on": the agent writes and sends the reply itself from the owner's note.
  r.post('/api/urgent/:id/note', 'owner', async (c) => {
    const body = await c.body<{ note?: unknown; remember?: unknown }>();
    const note = str(body.note, 'note', { max: 2000 });
    const res = await answerUrgentWithNote(c.env, c.params.id!, note, bool(body.remember, true));
    return json({ ok: true, parts: res.parts, queued_as: res.status, outbox_id: res.outbox_id, learned: res.learned, kb_doc_id: res.kb_doc_id, status: res.urgent.status });
  });

  r.post('/api/urgent/:id/send-draft', 'owner', async (c) => {
    const body = await c.body<{ text?: unknown }>();
    const text = typeof body.text === 'string' ? str(body.text, 'text', { max: 2000 }) : undefined;
    const res = await sendUrgentDraft(c.env, c.params.id!, text);
    return json({ ok: true, parts: res.parts });
  });

  r.post('/api/urgent/:id/dismiss', 'owner', async (c) => {
    await dismissUrgent(c.env, c.params.id!);
    return json({ ok: true });
  });

  // ---- Review queue (channels set to "ask me first") -------------------------------------------------
  r.post('/api/review/:id/approve', 'owner', async (c) => {
    const body = await c.body<{ text?: unknown }>();
    const row = await one<OutboxRow>(c.db, `SELECT * FROM outbox WHERE id = ? AND status = 'review'`, c.params.id!);
    if (!row) throw new HttpError(404, 'not_found', 'That draft is gone');
    let parts = parseJson<string[]>(row.parts, []);
    if (typeof body.text === 'string' && body.text.trim()) parts = body.text.split('\n').map((p) => p.trim()).filter(Boolean).slice(0, 3);
    if (!parts.length) throw bad('empty_message', 'Nothing to send');
    // Like a message typed on the dashboard: if the laptop cannot send it within a day it is dropped, not sent late.
    await run(c.db, `UPDATE outbox SET status = 'pending', source = 'review', parts = ?, not_before = ?, pacing = ?, expires_at = ? WHERE id = ? AND status = 'review'`,
      JSON.stringify(parts), c.now, JSON.stringify({ delay_ms: 0, typing_cps: 0 }), c.now + DAY, row.id);
    await logEvent(c.db, { level: 'good', type: 'approved', channel: row.channel, conversation_id: row.conversation_id, message: `You approved a reply: ${clip(parts.join(' '), 160)}` });
    return json({ ok: true });
  });

  r.post('/api/review/:id/reject', 'owner', async (c) => json({ ok: await cancelJob(c.db, c.params.id!) }));

  // ---- Inbox ---------------------------------------------------------------------------------------
  r.get('/api/conversations', 'owner', async (c) => {
    const channel = c.url.searchParams.get('channel');
    const q = (c.url.searchParams.get('q') ?? '').trim().slice(0, 80);
    const ch = channel && CHANNELS.includes(channel as Channel) ? channel : '';
    const level = (await budget(c.db, c.now)).level;
    const conversations = await cachedAnswer(`conversations:${ch}:${q}`, answerTtl(level), c.now, async () => {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (ch) { where.push('cv.channel = ?'); params.push(ch); }
      if (q) { where.push('(cv.title LIKE ? OR cv.last_preview LIKE ? OR ct.display_name LIKE ?)'); const like = `%${q.replace(/[%_]/g, '')}%`; params.push(like, like, like); }
      // Only the columns the list shows, the newest 50 (conversations_updated, or conversations_channel_updated for one channel).
      const rows = await all<Pick<ConversationRow, 'id' | 'channel' | 'title' | 'subject' | 'status' | 'last_preview' | 'last_direction' | 'updated_at' | 'paused_until'> & { display_name: string; opted_out: number }>(
        c.db,
        `SELECT cv.id, cv.channel, cv.title, cv.subject, cv.status, cv.last_preview, cv.last_direction, cv.updated_at, cv.paused_until, ct.display_name, ct.opted_out
         FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY cv.updated_at DESC LIMIT ${CONVERSATION_LIST_LIMIT}`,
        ...params,
      );
      return rows.map((cv) => ({
        id: cv.id, channel: cv.channel, customer: cv.display_name || cv.title || 'Customer', subject: cv.subject, status: cv.status,
        preview: cv.last_preview, last_direction: cv.last_direction, updated_at: cv.updated_at,
        paused_until: cv.paused_until, opted_out: Boolean(cv.opted_out),
      }));
    });
    // Paused is worked out now, not when the list was read.
    return json({ conversations: conversations.map(({ paused_until, ...cv }) => ({ ...cv, paused: Boolean(paused_until && paused_until > c.now) })) });
  });

  r.get('/api/conversations/:id', 'owner', async (c) => {
    const level = (await budget(c.db, c.now)).level;
    const res = await cachedAnswer(`conversation:${c.params.id!}`, answerTtl(level), c.now, () => conversationView(c.db, c.params.id!, c.now));
    if (!res) throw new HttpError(404, 'not_found');
    return json(res);
  });

  // A photo or video frame a customer sent, for the thumbnails on the Urgent card and in the chat view.
  // Owner only. The bytes never change, so the browser may keep them, but nothing shared may.
  r.get('/api/media/:id', 'owner', async (c) => {
    const row = await one<{ mime: string; data: string }>(c.db, 'SELECT mime, data FROM media WHERE id = ?', c.params.id!);
    if (!row) throw new HttpError(404, 'not_found');
    const mime = ['image/jpeg', 'image/png', 'image/webp'].includes(row.mime) ? row.mime : 'application/octet-stream';
    return new Response(base64Bytes(row.data), {
      headers: { 'content-type': mime, 'cache-control': 'private, max-age=86400, immutable', 'content-disposition': 'inline', 'content-security-policy': "default-src 'none'; sandbox" },
    });
  });

  r.post('/api/conversations/:id/pause', 'owner', async (c) => {
    const body = await c.body<{ minutes?: unknown }>();
    const minutes = int(body.minutes, 'minutes', 0, 60 * 24 * 365, 60 * 24 * 365);
    const until = minutes ? c.now + minutes * MIN : null;
    const changed = await run(c.db, 'UPDATE conversations SET paused_until = ?, pause_reason = ?, needs_reply_since = NULL WHERE id = ?', until, until ? 'Paused by you' : null, c.params.id!);
    if (!changed) throw new HttpError(404, 'not_found');
    // Paused: what the agent queued for this chat and has not sent yet stays unsent.
    if (until) await cancelAgentJobs(c.db, c.params.id!, 'paused by you');
    if (!until) {
      // Handed back: if the customer is still waiting, the agent answers now instead of at their next message.
      const last = await one<{ direction: string; status: string }>(c.db, 'SELECT direction, status FROM messages WHERE conversation_id = ? ORDER BY ts DESC, created_at DESC LIMIT 1', c.params.id!);
      if (last?.direction === 'in' && last.status !== 'history') {
        await run(c.db, 'UPDATE conversations SET needs_reply_since = ? WHERE id = ?', c.now, c.params.id!);
        c.exec.waitUntil(processConversation(c.env, c.params.id!, null).catch((err) => console.error('resume failed', err)));
      }
    }
    return json({ ok: true, paused_until: until });
  });

  // Chats the agent is staying out of: taken over by the owner or paused, with when it may reply again.
  r.get('/api/takeovers', 'owner', async (c) => {
    const level = (await budget(c.db, c.now)).level;
    const chats = await cachedAnswer('takeovers', answerTtl(level), c.now, async () => {
      // Only the columns the card shows (conversations_paused index).
      const rows = await all<Pick<ConversationRow, 'id' | 'channel' | 'title' | 'last_preview' | 'paused_until' | 'pause_reason'> & { display_name: string; last_in: string | null }>(
        c.db,
        `SELECT cv.id, cv.channel, cv.title, cv.last_preview, cv.paused_until, cv.pause_reason, ct.display_name,
           (SELECT direction FROM messages m WHERE m.conversation_id = cv.id ORDER BY ts DESC, created_at DESC LIMIT 1) AS last_in
         FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id
         WHERE cv.paused_until IS NOT NULL AND cv.paused_until > ? ORDER BY cv.paused_until ASC LIMIT 50`,
        c.now,
      );
      return rows.map((cv) => ({
        id: cv.id, channel: cv.channel, customer: cv.display_name || cv.title || 'Customer', preview: cv.last_preview,
        paused_until: cv.paused_until, reason: cv.pause_reason || '', customer_waiting: cv.last_in === 'in',
      }));
    });
    // The time and what has ended are worked out now: the countdown on Live uses this clock.
    return json({
      now: c.now,
      chats: chats.filter((cv) => (cv.paused_until ?? 0) > c.now).map((cv) => ({ ...cv, until_unpaused: (cv.paused_until ?? 0) - c.now > 30 * DAY })),
    });
  });

  // Send a message you typed yourself from the dashboard through the laptop.
  r.post('/api/conversations/:id/send', 'owner', async (c) => {
    const body = await c.body<{ text?: unknown }>();
    const text = str(body.text, 'text', { max: 3000 });
    const conv = await one<ConversationRow>(c.db, 'SELECT * FROM conversations WHERE id = ?', c.params.id!);
    if (!conv) throw new HttpError(404, 'not_found');
    const contact = (await one<ContactRow>(c.db, 'SELECT * FROM contacts WHERE id = ?', conv.contact_id))!;
    const id = await enqueue(c.db, {
      channel: conv.channel, kind: 'reply', conversation_id: conv.id, source: 'manual',
      target: emptyTarget({ thread_external_id: conv.external_thread_id, title: conv.title || contact.display_name, phone: contact.phone, email: contact.email, handle: contact.handle, subject: conv.subject }),
      parts: [text], expires_at: c.now + DAY, pacing: { delay_ms: 0, typing_cps: 0 },
    });
    return json({ ok: true, outbox_id: id });
  });

  r.post('/api/contacts/:id/opt-out', 'owner', async (c) => {
    const body = await c.body<{ opted_out?: unknown }>();
    const optedOut = bool(body.opted_out, true);
    const changed = await run(c.db, 'UPDATE contacts SET opted_out = ?, updated_at = ? WHERE id = ?', optedOut ? 1 : 0, c.now, c.params.id!);
    if (!changed) throw new HttpError(404, 'not_found');
    if (optedOut) {
      const contact = await one<ContactRow>(c.db, 'SELECT * FROM contacts WHERE id = ?', c.params.id!);
      await cancelForOptOut(c.db, c.params.id!, contact?.phone ?? null);
    }
    return json({ ok: true });
  });

  // ---- Settings ---------------------------------------------------------------------------------------
  r.get('/api/settings', 'owner', async (c) => json({ settings: await getSettings(c.db, true) }));

  r.put('/api/settings/:group', 'owner', async (c) => {
    const group = c.params.group!;
    if (!isSettingsGroup(group)) throw new HttpError(404, 'unknown_group');
    const patch = await c.body<Record<string, unknown>>(64_000);
    // The recovery message is changed through /api/recovery so approval is always deliberate.
    if (group === 'recovery') { delete patch.template; delete patch.consent_confirmed; }
    const clean = group === 'discounts' ? checkDiscountPatch(patch) : group === 'vision' ? checkVisionPatch(patch) : patch;
    const next = await patchSettings(c.db, group, clean as Partial<Settings[typeof group]>);
    return json({ ok: true, [group]: next });
  });

  // ---- Devices -----------------------------------------------------------------------------------------
  r.get('/api/devices', 'owner', async (c) => {
    const level = (await budget(c.db, c.now)).level;
    return json({ devices: await cachedAnswer('devices', answerTtl(level), c.now, () => currentDevice(c.db, c.now)) });
  });

  r.post('/api/devices/pair-code', 'owner', async (c) => {
    const code = pairingCode();
    await pairingCodeRow(c.db, await sha256Hex(code), c.now);
    return json({ code, server_url: c.url.origin, pairing_string: `${c.url.origin}#${code}`, expires_at: c.now + 15 * MIN });
  });

  r.delete('/api/devices/:id', 'owner', async (c) => {
    await run(c.db, 'UPDATE devices SET revoked_at = ? WHERE id = ?', c.now, c.params.id!);
    return json({ ok: true });
  });

  // ---- Health -------------------------------------------------------------------------------------------
  r.get('/api/health', 'owner', async (c) => {
    const guard = await budget(c.db, c.now);
    const data = await cachedAnswer('health', answerTtl(guard.level), c.now, () => healthView(c.db, c.now));
    return json({ ...data, budget: budgetView(guard) });
  });

  // Selector fixes saved here reach the laptop on its next sync, no reinstall needed.
  r.get('/api/selectors', 'owner', async (c) => {
    const override = await getState<{ rev: number; pack: Record<string, unknown> } | null>(c.db, 'selectors_override', null);
    return json({ ...(await selectorPack(c.db)), override: override?.pack ?? {} });
  });

  r.put('/api/selectors', 'owner', async (c) => {
    const body = await c.body<{ override?: unknown }>(200_000);
    if (typeof body.override !== 'object' || body.override === null || Array.isArray(body.override)) throw bad('invalid_field', 'override must be an object');
    const prev = await getState<{ rev: number } | null>(c.db, 'selectors_override', null);
    await setState(c.db, 'selectors_override', { rev: (prev?.rev ?? 0) + 1, pack: body.override });
    return json({ ok: true, ...(await selectorPack(c.db)) });
  });
}
