import type { AgentJob, Channel, DeviceRow, Env, JobTarget, OutboxRow, Settings } from '../types';
import { all, clip, one, parseJson, run, stmt, uid } from '../lib/db';
import { logEvent } from '../lib/events';
import { HttpError } from '../lib/http';
import { getSettings } from '../lib/settings';
import { MIN } from '../lib/time';
import { isLegacyExtension } from '../lib/version';
import { alertOwner } from './alerts';

export const MAX_ATTEMPTS = 3;
const LEASE_MS = 3 * MIN;
/** Due jobs handed out per ready channel in one sync. The extension queues them and sends one at a time. */
export const JOBS_PER_SYNC = 3;
/** The owner was typing in that tab: offered again this soon, and not counted as a try. */
export const BUSY_RETRY_MS = 20_000;
/** Still busy after this long: offered again once a minute instead (fewer rows written). */
export const BUSY_SLOW_AFTER_MS = 2 * MIN;
/** Still busy after this long: the owner is told once (push, and a line on Live). */
export const BUSY_ALERT_MS = 5 * MIN;
/** Still busy after this long: the job fails with a plain reason, instead of waiting silently for a day. */
export const BUSY_GIVE_UP_MS = 15 * MIN;
/** Still busy, but long after the last busy result (a lost lease, the laptop away): a new wait starts. */
export const BUSY_EPISODE_GAP_MS = 5 * MIN;
/**
 * Failures that are over in seconds (a slow page, a reloading tab, TikTok not taking the pasted text):
 * an agent reply is tried again quickly.
 */
const QUICK_RETRY_CODES = new Set(['timeout', 'no_content_script', 'tab_missing', 'send_not_confirmed', 'thread_not_found', 'composer_missing', 'send_not_synced']);
/**
 * The owner is in the way, not the job: owner_busy (typing somewhere in the tab), composer_busy (the
 * message box or the open chat changed while typing; older builds also use it for a draft) and
 * draft_in_chat (newer builds: text that is not ours sits in this chat's message box).
 */
const BUSY_CODES = new Set(['owner_busy', 'composer_busy', 'draft_in_chat']);
/**
 * What builds before 0.4.0 say with composer_busy when text that is not theirs sits in this chat's
 * message box before they type: a draft. Matched on the start of the error text. Their other
 * composer_busy texts mean the box or the open chat changed while they typed (TikTok did not take the
 * text, the owner clicked another chat), which is not a draft.
 */
const LEGACY_DRAFT_ERRORS = [
  'Someone is typing in this chat', 'Someone started typing in this chat',
  'There is a half written message in the TikTok message box', 'There is already text in the message box (someone is typing)',
];
/** Gmail before 0.4.0: a saved draft in this customer's email. Its other composer_busy texts are about the whole tab. */
const LEGACY_GMAIL_DRAFT_ERRORS = ['There is already a draft reply in this email'];
/** Gmail before 0.4.0, composer_busy for the whole tab: someone is writing or typing there (newer builds say owner_busy). */
const LEGACY_GMAIL_TAB_ERRORS = ['An email is being written in this tab', 'Someone is typing in this tab', 'Gmail settings are open in this tab', 'The new email already has text in it'];
/** Typing speed for builds before 0.4.0: they read 0 as their slowest typing, and at 200 a second they only keep short floor pauses. */
export const LEGACY_FAST_CPS = 200;

const startsWithAny = (text: string, list: string[]) => { const t = text.trim(); return list.some((x) => t.startsWith(x)); };

/** A composer_busy from a build before 0.4.0 that means a draft of the owner's in this chat or email. */
export function legacyDraftError(channel: Channel, error: string): boolean {
  return startsWithAny(error, channel === 'gmail' ? LEGACY_GMAIL_DRAFT_ERRORS : LEGACY_DRAFT_ERRORS);
}

/**
 * What holds a busy job up, for the owner's words: text in the way (a draft, someone writing in the
 * tab) or the message box changing while the agent typed (composer_busy with any other text).
 */
function busyKind(code: string, error: string): 'draft' | 'changed' {
  if (code !== 'composer_busy') return 'draft';
  return startsWithAny(error, [...LEGACY_DRAFT_ERRORS, ...LEGACY_GMAIL_DRAFT_ERRORS, ...LEGACY_GMAIL_TAB_ERRORS]) ? 'draft' : 'changed';
}
/** The agent's own replies: they may carry an extra wait the owner set. */
const AGENT_SOURCES = new Set(['auto', 'holding', 'discount']);
/** Replies the agent wrote by itself: dropped when the owner takes the chat over. */
const TAKEOVER_SOURCES = new Set(['auto', 'holding']);

export interface EnqueueInput {
  channel: Channel;
  kind: 'reply' | 'new_chat';
  conversation_id?: string | null;
  target: JobTarget;
  parts: string[];
  source: 'auto' | 'holding' | 'urgent' | 'review' | 'recovery' | 'manual' | 'alert' | 'discount';
  ref_id?: string | null;
  status?: 'pending' | 'review';
  not_before?: number;
  expires_at?: number | null;
  dedupe_key?: string | null;
  pacing?: { delay_ms: number; typing_cps: number };
  /** Agent replies: the customer message answered and when it arrived (the brain's history and the reply time). */
  reply_to?: { id: string; ts: number } | null;
}

export function emptyTarget(over: Partial<JobTarget> = {}): JobTarget {
  return { thread_external_id: null, title: null, phone: null, email: null, handle: null, subject: null, ...over };
}

/** Queue a message for the extension. Returns the id, or null when the dedupe key was already used. */
export async function enqueue(db: D1Database, input: EnqueueInput): Promise<string | null> {
  const q = enqueueStatements(db, input);
  const results = await db.batch(q.statements);
  return (results[results.length - 1]?.meta?.changes ?? 0) > 0 ? q.id : null;
}

/**
 * The statements that queue a message, for callers that queue many at once in one batch (one D1
 * round trip). The insert is the last statement: its `meta.changes` is 0 when the dedupe key was used.
 */
export function enqueueStatements(db: D1Database, input: EnqueueInput): { id: string; statements: D1PreparedStatement[] } {
  const parts = input.parts.map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new HttpError(400, 'empty_message', 'Nothing to send');
  const id = uid('ob');
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (input.dedupe_key) {
    // A message that failed or was cancelled earlier must not block a fresh try with the same key.
    statements.push(stmt(db, `UPDATE outbox SET dedupe_key = NULL WHERE dedupe_key = ? AND status IN ('failed', 'cancelled', 'expired')`, input.dedupe_key));
  }
  statements.push(stmt(
    db,
    `INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, ref_id, not_before, expires_at, dedupe_key, pacing, created_at, reply_to_id, reply_to_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
    id, input.channel, input.kind, input.conversation_id ?? null, JSON.stringify(input.target), JSON.stringify(parts),
    input.status ?? 'pending', input.source, input.ref_id ?? null, input.not_before ?? now, input.expires_at ?? null,
    input.dedupe_key ?? null, JSON.stringify(input.pacing ?? {}), now, input.reply_to?.id ?? null, input.reply_to?.ts ?? null,
  ));
  return { id, statements };
}

/**
 * How the extension paces a job. Replies go out as fast as possible: no wait, and each part pasted
 * whole (typing_cps 0). The agent's own replies keep the extra wait the owner may set (none by
 * default, and never more than the current setting, so a job queued under the old slow pacing is not
 * slow). The checkout reminders and the owner alert keep their own pacing.
 * `legacy`: an extension before 0.4.0 (src/lib/version.ts). It reads typing_cps 0 as its slowest
 * typing (3 a second on TikTok), so it gets 200 a second: it pastes the part and keeps only its short
 * floor pauses (about half a second a part).
 */
export function jobPacing(row: Pick<OutboxRow, 'source' | 'pacing'>, settings: Settings, legacy = false): { delay_ms: number; typing_cps: number } {
  const stored = parseJson<{ delay_ms?: number; typing_cps?: number }>(row.pacing, {});
  if (row.source === 'recovery' || row.source === 'alert') return { delay_ms: stored.delay_ms ?? 0, typing_cps: stored.typing_cps ?? settings.pacing.typing_cps };
  const typing_cps = legacy ? LEGACY_FAST_CPS : 0;
  if (!AGENT_SOURCES.has(row.source)) return { delay_ms: 0, typing_cps };
  const max = Math.max(0, settings.pacing.max_reply_delay_s * 1000);
  return { delay_ms: Math.min(Math.max(0, stored.delay_ms ?? 0), max), typing_cps };
}

export function toJob(row: OutboxRow, settings: Settings, legacy = false, now = Date.now()): AgentJob {
  return {
    id: row.id,
    channel: row.channel,
    kind: row.kind,
    source: row.source,
    target: parseJson<JobTarget>(row.target, emptyTarget()),
    parts: parseJson<string[]>(row.parts, []),
    pacing: jobPacing(row, settings, legacy),
    lease_until: row.lease_until ?? 0,
    lease_ms: row.lease_until ? Math.max(0, row.lease_until - now) : 0,
    attempts: row.attempts,
    not_before: row.not_before,
    created_at: row.created_at,
  };
}

/** Lease one specific job to a device straight away (used when the extension is waiting on the reply). One query. */
export async function leaseById(db: D1Database, device: DeviceRow, id: string, settings: Settings, extraMs = 0): Promise<AgentJob | null> {
  const now = Date.now();
  const rows = await all<OutboxRow>(
    db,
    `UPDATE outbox SET status = 'leased', lease_until = ?, lease_device = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending' RETURNING *`,
    now + LEASE_MS + extraMs, device.id, id,
  );
  return rows[0] ? toJob(rows[0], settings, isLegacyExtension(device.version), now) : null;
}

/**
 * Hand this device's own leased jobs of one chat back to it (two queries at most). For a reply that was
 * leased inline while the answer that carried it was cut on the way: the extension posts the chat
 * again, gets "reply queued" and would otherwise wait out the whole lease. Newer extensions only: they
 * dedupe jobs by id and never type a job twice.
 */
export async function reofferOwn(db: D1Database, device: DeviceRow, conversationId: string, settings: Settings): Promise<AgentJob[]> {
  const now = Date.now();
  const rows = await all<OutboxRow>(
    db,
    `UPDATE outbox SET lease_until = MAX(lease_until, ?) WHERE id IN (
       SELECT id FROM outbox WHERE conversation_id = ? AND status = 'leased' AND lease_device = ? AND lease_until > ? ORDER BY created_at LIMIT 3)
     RETURNING *`,
    now + LEASE_MS, conversationId, device.id, now,
  );
  return rows.sort((a, b) => a.created_at - b.created_at).map((r) => toJob(r, settings, isLegacyExtension(device.version), now));
}

/**
 * The jobs a laptop says it holds that it must not send any more: the server cancelled them (a pause,
 * an opt out, a takeover) or gave up on them. One query by primary key, only when the laptop sends ids.
 */
export async function droppedJobs(db: D1Database, held: string[]): Promise<string[]> {
  if (!held.length) return [];
  const rows = await all<{ id: string }>(
    db, `SELECT id FROM outbox WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('cancelled', 'expired', 'failed')`, JSON.stringify(held.slice(0, 40)),
  );
  return rows.map((r) => r.id);
}

/**
 * Undo a lease that never reached the extension (the answer it was in could not be written). The job
 * goes back to the queue for the next sync and the lease does not count as a try.
 */
export async function releaseLeases(db: D1Database, device: DeviceRow, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  return run(
    db,
    `UPDATE outbox SET status = 'pending', lease_until = NULL, lease_device = NULL, attempts = MAX(0, attempts - 1)
     WHERE id IN (SELECT value FROM json_each(?)) AND status = 'leased' AND lease_device = ?`,
    JSON.stringify(ids), device.id,
  );
}

/**
 * Hand due jobs to the extension: up to JOBS_PER_SYNC per ready channel, most urgent first. The
 * extension queues them per tab and types one at a time, so jobs it already holds do not stop more
 * being handed out. A channel whose jobs another laptop holds is skipped, so two laptops never type
 * in the same channel at once.
 */
export async function leaseDue(db: D1Database, device: DeviceRow, settings: Settings, ready: Channel[]): Promise<AgentJob[]> {
  if (!settings.agent.enabled) return [];
  const now = Date.now();
  const jobs: AgentJob[] = [];
  for (const channel of ready) {
    if (settings.channels[channel].mode === 'off') continue;
    const other = await one<{ id: string }>(
      db, `SELECT id FROM outbox WHERE channel = ? AND status = 'leased' AND lease_until > ? AND COALESCE(lease_device, '') != ? LIMIT 1`, channel, now, device.id,
    );
    if (other) continue;
    // Never the agent's own words for a chat the owner paused or took over, and nothing but the owner's
    // own words for someone who opted out (checked per candidate row, by primary key: no extra query).
    const due = await all<OutboxRow>(
      db,
      `SELECT * FROM outbox WHERE channel = ? AND status = 'pending' AND not_before <= ? AND (expires_at IS NULL OR expires_at > ?)
         AND NOT (source IN ('auto', 'holding') AND EXISTS (SELECT 1 FROM conversations cv WHERE cv.id = outbox.conversation_id AND cv.paused_until > ?))
         AND NOT (source != 'manual' AND EXISTS (SELECT 1 FROM conversations cv JOIN contacts ct ON ct.id = cv.contact_id WHERE cv.id = outbox.conversation_id AND ct.opted_out = 1))
       ORDER BY CASE source WHEN 'urgent' THEN 0 WHEN 'manual' THEN 0 WHEN 'auto' THEN 1 WHEN 'review' THEN 1 WHEN 'holding' THEN 1 WHEN 'discount' THEN 1 ELSE 2 END, not_before, created_at LIMIT ?`,
      channel, now, now, now, JOBS_PER_SYNC,
    );
    for (const next of chatOrder(due)) {
      const job = await leaseById(db, device, next.id, settings);
      if (job) jobs.push(job);
    }
  }
  return jobs;
}

/**
 * The jobs of one chat go out oldest first (a holding line before the owner's answer), and each chat
 * keeps the place of its most urgent job. Older extensions type a sync's jobs in this order.
 */
export function chatOrder<T extends Pick<OutboxRow, 'conversation_id' | 'created_at' | 'id'>>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = r.conversation_id ?? `job:${r.id}`;
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  return [...groups.values()].flatMap((g) => [...g].sort((a, b) => a.created_at - b.created_at));
}

export interface JobResult {
  status: 'sent' | 'failed';
  /** Stable short code such as not_on_whatsapp, thread_not_found, composer_missing, logged_out. */
  error_code?: string;
  error?: string;
  /** True when trying again later could work. */
  retryable?: boolean;
  sent_external_ids?: string[];
}

const digits = (phone: string) => phone.replace(/\D/g, '');

/** A conversation to file an outbound first-contact message under, so the customer's reply threads in. */
async function conversationForNewChat(db: D1Database, row: OutboxRow, target: JobTarget): Promise<string | null> {
  const now = Date.now();
  let externalContact: string | null = null;
  let threadId: string | null = null;
  if (row.channel === 'whatsapp' && target.phone) {
    externalContact = `${digits(target.phone)}@c.us`;
    threadId = externalContact;
  } else if (row.channel === 'gmail' && target.email) {
    externalContact = target.email.toLowerCase();
    threadId = target.thread_external_id ?? `new:${row.id}`;
  } else if (target.handle) {
    externalContact = target.handle.toLowerCase();
    threadId = target.thread_external_id ?? externalContact;
  }
  if (!externalContact || !threadId) return null;

  const existing = await one<{ id: string }>(db, 'SELECT id FROM conversations WHERE channel = ? AND external_thread_id = ?', row.channel, threadId);
  if (existing) return existing.id;

  let contact = await one<{ id: string }>(db, 'SELECT id FROM contacts WHERE channel = ? AND external_id = ?', row.channel, externalContact);
  if (!contact) {
    contact = { id: uid('ct') };
    await run(
      db,
      `INSERT INTO contacts (id, channel, external_id, display_name, phone, email, handle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel, external_id) DO NOTHING`,
      contact.id, row.channel, externalContact, target.title ?? '', target.phone, target.email, target.handle, now, now,
    );
    contact = (await one<{ id: string }>(db, 'SELECT id FROM contacts WHERE channel = ? AND external_id = ?', row.channel, externalContact)) ?? contact;
  }
  const convId = uid('cv');
  await run(
    db,
    `INSERT INTO conversations (id, channel, contact_id, external_thread_id, title, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel, external_thread_id) DO NOTHING`,
    convId, row.channel, contact.id, threadId, target.title ?? target.phone ?? target.email ?? '', target.subject, now, now,
  );
  const conv = await one<{ id: string }>(db, 'SELECT id FROM conversations WHERE channel = ? AND external_thread_id = ?', row.channel, threadId);
  return conv?.id ?? null;
}

/** Who a job was for, in plain words for the owner. */
const whoOf = (t: JobTarget) => t.title ?? t.phone ?? t.email ?? t.handle ?? 'a customer';

/** A failure code in plain words for the owner's activity feed. */
function failWords(code: string): string {
  switch (code) {
    case 'newer_message': return 'the laptop kept refusing it because the customer wrote again';
    case 'owner_busy': case 'draft_in_chat': return 'a draft or a half written message in the agent’s tab was in the way';
    case 'composer_busy': return 'the message box was in use or kept changing while the agent typed';
    case 'send_not_synced': return 'TikTok did not take the text';
    default: return code.replace(/_/g, ' ');
  }
}

/**
 * The owner took the chat: they replied by hand (owner_replied), or text that is not ours sits in that
 * chat's message box (draft_in_chat, and the draft texts of composer_busy from builds before 0.4.0).
 * The agent's own unsent words for the chat are dropped, it stays out of the chat for
 * pacing.human_takeover_minutes, and nothing is answered later from the stored messages (the owner may
 * have answered already). A draft also tells the owner that the customer was not answered, so a draft
 * that was left behind does not leave them waiting.
 */
async function ownerTookChat(env: Env, row: OutboxRow, target: JobTarget, why: 'replied' | 'draft', error: string): Promise<{ ok: true; status: string }> {
  const db = env.DB;
  const now = Date.now();
  const settings = await getSettings(db);
  const minutes = settings.pacing.human_takeover_minutes;
  const until = now + minutes * MIN;
  const reason = why === 'replied' ? 'You replied yourself' : 'You were typing in that chat';
  const code = why === 'replied' ? 'owner_replied' : 'draft_in_chat';
  const statements = [
    stmt(db, `UPDATE outbox SET status = 'cancelled', lease_until = NULL, busy_since = NULL, last_error = ? WHERE id = ?`, `takeover: ${code}: ${clip(error, 160)}`, row.id),
  ];
  if (row.conversation_id) {
    statements.push(
      stmt(db, `UPDATE outbox SET status = 'cancelled', last_error = ? WHERE conversation_id = ? AND status IN ('pending', 'leased', 'review') AND source IN ('auto', 'holding') AND id != ?`,
        `takeover: ${reason.toLowerCase()}`, row.conversation_id, row.id),
      // A longer pause the owner set from the dashboard is kept.
      stmt(db, `UPDATE conversations SET paused_until = CASE WHEN paused_until > ? THEN paused_until ELSE ? END,
          pause_reason = CASE WHEN paused_until > ? THEN pause_reason ELSE ? END, needs_reply_since = NULL WHERE id = ?`,
        until, until, until, reason, row.conversation_id),
    );
  }
  await db.batch(statements);
  const who = whoOf(target);
  const place = row.channel === 'gmail' ? 'email' : 'chat';
  // A draft: the agent will not answer later on its own (the message was marked as dealt with), so
  // the words never promise that it will once the draft is gone or the pause ends.
  await logEvent(db, {
    level: why === 'draft' ? 'warn' : 'info', type: 'takeover', channel: row.channel, conversation_id: row.conversation_id,
    message: why === 'replied'
      ? `You replied to ${who} yourself. The agent did not send its reply and is staying out of that chat for ${minutes} min.`
      : `There is an unsent message in your ${place} with ${who}. The agent did not send its reply. Answer them yourself.`,
    data: { outbox_id: row.id, source: row.source, code },
  });
  if (why === 'draft') {
    await alertOwner(env, settings, {
      kind: 'waiting', title: `A draft is in a customer ${place}`,
      body: `${who}: you have an unsent message in that ${place}. The agent did not answer. Send your message or answer from Inbox.`, path: '/#/live',
    });
  }
  return { ok: true, status: 'cancelled' };
}

export async function completeJob(env: Env, device: DeviceRow, id: string, result: JobResult): Promise<{ ok: true; status: string }> {
  const db = env.DB;
  const row = await one<OutboxRow>(db, 'SELECT * FROM outbox WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'job_not_found');
  if (row.status === 'sent') return { ok: true, status: 'sent' }; // idempotent re-report
  // A message that really went out is recorded whatever happened to the row meanwhile (cancelled by a
  // pause or an opt out while the laptop held it, or given up): the next read must know it is ours.
  if (row.status !== 'leased' && row.status !== 'pending' && result.status !== 'sent') return { ok: true, status: row.status };
  // A failure from a laptop that no longer holds the job (another laptop answers the channel now and was
  // handed it, src/pipeline/leader.ts) says nothing about it: the one that holds it reports for itself.
  if (result.status !== 'sent' && row.status === 'leased' && row.lease_device && row.lease_device !== device.id) return { ok: true, status: row.status };
  const now = Date.now();
  const target = parseJson<JobTarget>(row.target, emptyTarget());
  const parts = parseJson<string[]>(row.parts, []);

  if (result.status === 'sent') {
    await run(db, `UPDATE outbox SET status = 'sent', sent_at = ?, lease_until = NULL, last_error = NULL, busy_since = NULL, busy_last = NULL, busy_warned = 0 WHERE id = ?`, now, id);
    let convId = row.conversation_id;
    if (!convId && row.source !== 'alert') {
      convId = await conversationForNewChat(db, row, target);
      if (convId) await run(db, 'UPDATE outbox SET conversation_id = ? WHERE id = ?', convId, id);
    }
    if (convId) {
      const author = row.source === 'manual' ? 'owner' : 'agent';
      for (let i = 0; i < parts.length; i++) {
        await run(
          db,
          `INSERT INTO messages (id, conversation_id, direction, author, external_id, body, kind, status, outbox_id, ts, created_at)
           VALUES (?, ?, 'out', ?, ?, ?, 'text', 'sent', ?, ?, ?) ON CONFLICT DO NOTHING`,
          uid('m'), convId, author, result.sent_external_ids?.[i] ?? null, parts[i]!, id, now + i, now + i,
        );
      }
      await run(
        db,
        `UPDATE conversations SET last_outbound_at = ?, last_preview = ?, last_direction = 'out', updated_at = ? WHERE id = ?`,
        now, clip(parts[parts.length - 1] ?? '', 140), now, convId,
      );
      if (row.source === 'recovery' && row.ref_id) {
        const co = await one<{ items: string; recovery_url: string | null }>(db, 'SELECT items, recovery_url FROM checkouts WHERE id = ?', row.ref_id);
        const items = parseJson<{ title: string }[]>(co?.items ?? '[]', []).map((i) => i.title).join(', ');
        const note = `We messaged this customer first about a checkout they did not finish (${items || 'their basket'}). Their checkout link: ${co?.recovery_url ?? 'unknown'}.`;
        await run(db, 'UPDATE conversations SET context_notes = ? WHERE id = ?', JSON.stringify([note]), convId);
      }
    }
    if (row.source === 'urgent' && row.ref_id) {
      await run(db, `UPDATE urgent SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'answered'`, now, row.ref_id);
    }
    if (row.source === 'recovery' && row.ref_id) {
      await run(db, `UPDATE checkouts SET status = 'messaged', messaged_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`, now, now, row.ref_id);
    }
    if (row.source !== 'alert') {
      await logEvent(db, {
        level: 'good', type: 'sent', channel: row.channel, conversation_id: convId,
        message: `Sent to ${whoOf(target)}: ${clip(parts.join(' '), 160)}`,
        data: { outbox_id: id, source: row.source, device: device.name },
      });
    }
    return { ok: true, status: 'sent' };
  }

  const code = (result.error_code ?? 'failed').slice(0, 60);
  const why = `${code}: ${clip(result.error ?? '', 200)}`;

  // The customer wrote again after the extension read the chat. An agent reply written before that may
  // no longer fit, so it is dropped quietly (no alert, no try used) and the customer is marked as
  // waiting: the extension reads the chat again and one fresh decision answers everything. A code
  // message, or what the owner wrote, still fits whatever came after it, so it is offered again, once
  // without using a try. Refused again (a laptop that keeps refusing it): it counts as a try, so it
  // fails after 3 and the owner sees why instead of it going round for a day.
  if (code === 'newer_message') {
    if (TAKEOVER_SOURCES.has(row.source)) {
      await db.batch([
        stmt(db, `UPDATE outbox SET status = 'cancelled', lease_until = NULL, last_error = ? WHERE id = ?`, why, id),
        stmt(db, 'UPDATE conversations SET needs_reply_since = COALESCE(needs_reply_since, ?) WHERE id = ?', now, row.conversation_id ?? ''),
      ]);
      return { ok: true, status: 'cancelled' };
    }
    if (!(row.last_error ?? '').startsWith('newer_message')) {
      await run(db, `UPDATE outbox SET status = 'pending', lease_until = NULL, not_before = ?, attempts = MAX(0, attempts - 1), last_error = ? WHERE id = ?`, now, why, id);
      return { ok: true, status: 'pending' };
    }
    // Fall through: a normal failure that uses a try.
  }

  // The owner already answered this customer by hand (newer extensions see their message after the read).
  if (code === 'owner_replied') return ownerTookChat(env, row, target, 'replied', result.error ?? '');
  // Text that is not ours in this chat's message box: the owner is writing to this customer. The
  // agent's own reply stands down at once. Builds before 0.4.0 say composer_busy for that, but only
  // the texts they throw before typing mean a draft (on Gmail: a saved draft in this email). Their
  // other composer_busy texts (the box or the open chat changed while typing, an email written
  // anywhere in the tab) wait like any busy result below, so a passing glitch still gets through.
  const legacyDraft = code === 'composer_busy' && isLegacyExtension(device.version) && legacyDraftError(row.channel, result.error ?? '');
  if (TAKEOVER_SOURCES.has(row.source) && (code === 'draft_in_chat' || legacyDraft)) {
    return ownerTookChat(env, row, target, 'draft', result.error ?? '');
  }

  // WhatsApp: the chat is pinned, so it is the owner's own and the agent never answers it by itself.
  // Dropped quietly with a line on Live; the sweeper does not try it again from the stored messages.
  if (code === 'pinned_chat') {
    await db.batch([
      stmt(db, `UPDATE outbox SET status = 'cancelled', lease_until = NULL, last_error = ? WHERE id = ?`, why, id),
      stmt(db, 'UPDATE conversations SET needs_reply_since = NULL WHERE id = ?', row.conversation_id ?? ''),
    ]);
    await logEvent(db, {
      level: 'info', type: 'skipped', channel: row.channel, conversation_id: row.conversation_id,
      message: `Did not answer ${whoOf(target)}: that chat is pinned, so it is yours.`, data: { outbox_id: id, source: row.source },
    });
    return { ok: true, status: 'cancelled' };
  }

  // The laptop's own copy of the lease ran out before it could send (a long queue): nothing was typed.
  // Offered again at once, no try used.
  // stood_down (0.6.0 and up): another laptop answers this channel now (src/pipeline/leader.ts), so this one
  // handed the job back unsent. The same: offered again at once (to the one that answers), no try used.
  // Only while this laptop still holds it (or held it last, when the sweeper already put it back): one
  // handed to another laptop since, or moved back by a takeover, is left as it is, so it is never offered twice.
  if (code === 'lease_expired_local' || code === 'stood_down') {
    const moved = await run(db,
      `UPDATE outbox SET status = 'pending', lease_until = NULL, not_before = ?, attempts = MAX(0, attempts - 1), last_error = ?
       WHERE id = ? AND status IN ('leased', 'pending') AND lease_device = ?`, now, why, id, device.id);
    if (moved) return { ok: true, status: 'pending' };
    return { ok: true, status: (await one<{ status: string }>(db, 'SELECT status FROM outbox WHERE id = ?', id))?.status ?? row.status };
  }

  // The owner is typing in that tab or a draft is in the way: not the job's fault. Offered again soon
  // without using a try, then less often; the owner is told after a few minutes, and after 15 minutes
  // it fails with a plain reason instead of waiting silently until it expires. A busy result long after
  // the last one (a lost lease, the laptop away) starts a new wait: an old busy_since never fails a job
  // at once. The message box changing while the agent typed, twice in a row, is not the owner waiting
  // to send: from the second time it uses a try like any quick failure, so it fails in minutes.
  const kind = busyKind(code, result.error ?? '');
  const lastKind = (row.last_error ?? '').startsWith('composer_busy:') ? busyKind('composer_busy', (row.last_error ?? '').slice('composer_busy:'.length)) : null;
  const repeatChanged = kind === 'changed' && lastKind === 'changed';
  const busy = BUSY_CODES.has(code) && result.retryable !== false && !repeatChanged;
  const lastBusy = row.busy_last ?? row.busy_since ?? null;
  const freshWait = row.busy_since == null || lastBusy == null || now - lastBusy > BUSY_EPISODE_GAP_MS;
  const busySince = freshWait ? now : row.busy_since!;
  const warned = freshWait ? 0 : row.busy_warned ?? 0;
  const who = whoOf(target);
  if (busy && now - busySince < BUSY_GIVE_UP_MS) {
    const elapsed = now - busySince;
    const delay = elapsed < BUSY_SLOW_AFTER_MS ? BUSY_RETRY_MS : MIN;
    if (freshWait) {
      await logEvent(db, {
        level: 'info', type: 'send_waiting', channel: row.channel, conversation_id: row.conversation_id,
        message: `Waiting to send to ${who}: ${clip(result.error || 'someone is typing in the agent’s tab', 160)}.`,
        data: { outbox_id: id, source: row.source, code },
      });
    }
    // 1: the owner got the push. 2: the line is on Live but the throttle held the push back (it was
    // used for another chat a moment ago), so it is tried again and the failure push still goes.
    let nextWarned = warned;
    if (elapsed >= BUSY_ALERT_MS && warned !== 1) {
      if (warned === 0) {
        await logEvent(db, {
          level: 'warn', type: 'send_waiting', channel: row.channel, conversation_id: row.conversation_id,
          message: kind === 'draft'
            ? `A reply to ${who} has waited ${Math.round(elapsed / MIN)} min. There is a draft or a half written message in the agent’s tab. Send it or delete it.`
            : `A reply to ${who} has waited ${Math.round(elapsed / MIN)} min. The message box kept changing while the agent typed. Check the agent’s tab.`,
          data: { outbox_id: id, source: row.source, code },
        });
      }
      const pushed = await alertOwner(env, await getSettings(db), {
        kind: 'waiting', title: 'A reply is waiting to send',
        body: kind === 'draft' ? `${who}: a draft in the agent’s tab is in the way. Send it or delete it.` : `${who}: the message box in the agent’s tab kept changing. Check the tab.`,
        path: '/#/live',
      });
      nextWarned = pushed ? 1 : 2;
    }
    await run(
      db,
      `UPDATE outbox SET status = 'pending', lease_until = NULL, not_before = ?, attempts = MAX(0, attempts - 1), last_error = ?, busy_since = ?, busy_last = ?, busy_warned = ? WHERE id = ?`,
      now + delay, why, busySince, now, nextWarned, id,
    );
    return { ok: true, status: 'pending' };
  }

  const retry = !busy && result.retryable !== false && row.attempts < MAX_ATTEMPTS;
  if (retry) {
    // A quick failure of the agent's own reply is tried again in seconds: the customer is waiting.
    const quick = QUICK_RETRY_CODES.has(code) || repeatChanged;
    const step = AGENT_SOURCES.has(row.source) && quick ? 15_000 : MIN;
    await run(
      db,
      `UPDATE outbox SET status = 'pending', lease_until = NULL, not_before = ?, last_error = ?, busy_since = NULL, busy_last = NULL WHERE id = ?`,
      now + row.attempts * step, why, id,
    );
    return { ok: true, status: 'pending' };
  }
  await run(db, `UPDATE outbox SET status = 'failed', lease_until = NULL, last_error = ? WHERE id = ?`, why, id);
  if (row.source === 'recovery' && row.ref_id) {
    await run(db, `UPDATE checkouts SET status = 'failed', skip_reason = ?, updated_at = ? WHERE id = ?`, code, now, row.ref_id);
  }
  if (row.source !== 'alert') {
    const mins = Math.round((now - busySince) / MIN);
    await logEvent(db, {
      level: code === 'not_on_whatsapp' ? 'warn' : 'error', type: 'send_failed', channel: row.channel, conversation_id: row.conversation_id,
      message: !busy
        ? `Could not send to ${target.title ?? target.phone ?? target.email ?? 'customer'} (${failWords(code)})`
        : kind === 'draft'
          ? `Could not send to ${who}. A draft in the agent’s tab was in the way for ${mins} min. Send or delete it, then answer from Inbox.`
          : `Could not send to ${who}. The message box in the agent’s tab kept changing for ${mins} min. Answer from Inbox.`,
      data: { outbox_id: id, source: row.source, error: result.error ?? '' },
    });
    // Unless the owner already got the push about this wait (busy_warned 1), they get this one.
    if (busy && warned !== 1) {
      await alertOwner(env, await getSettings(db), {
        kind: 'waiting', title: 'A reply could not be sent',
        body: kind === 'draft' ? `${who}: a draft in the agent’s tab was in the way. Answer from Inbox.` : `${who}: the message box in the agent’s tab kept changing. Answer from Inbox.`,
        path: '/#/live',
      });
    }
  }
  return { ok: true, status: 'failed' };
}

/** The deadline passed with nothing sent: one line per job on Live (in one batch), so nothing disappears unseen. */
const EXPIRY_EVENTS = 10;

/** Housekeeping run by cron: return expired leases to the queue and drop jobs past their deadline. */
export async function sweepOutbox(db: D1Database): Promise<void> {
  const now = Date.now();
  await run(
    db,
    `UPDATE outbox SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
       last_error = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'lease_expired: the laptop took the job but never confirmed it' ELSE last_error END,
       lease_until = NULL
     WHERE status = 'leased' AND lease_until < ?`,
    now,
  );
  // The agent's own words for a chat the owner paused or took over meanwhile (a decision that was
  // still working, or a lease that came back) never go out later. Pending rows only, by primary key.
  await run(
    db,
    `UPDATE outbox SET status = 'cancelled', last_error = 'paused: the chat was paused before it went out'
     WHERE status = 'pending' AND source IN ('auto', 'holding')
       AND EXISTS (SELECT 1 FROM conversations cv WHERE cv.id = outbox.conversation_id AND cv.paused_until > ?)`,
    now,
  );
  const expired = await all<{ id: string; status: string; source: string; ref_id: string | null; channel: Channel; conversation_id: string | null; target: string; last_error: string | null }>(
    db, `SELECT id, status, source, ref_id, channel, conversation_id, target, last_error FROM outbox WHERE status IN ('pending', 'review') AND expires_at IS NOT NULL AND expires_at < ? LIMIT 100`, now,
  );
  if (!expired.length) return;
  const writes: D1PreparedStatement[] = [
    stmt(db, `UPDATE outbox SET status = 'expired' WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(expired.map((e) => e.id))),
  ];
  for (const e of expired) {
    if (e.source === 'recovery' && e.ref_id) {
      // Back to new so tomorrow's run can pick it up again if it is still fresh enough.
      writes.push(stmt(db, `UPDATE checkouts SET status = 'new', outbox_id = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`, now, e.ref_id));
    }
  }
  const told = expired.filter((e) => e.source !== 'alert' && e.source !== 'recovery');
  const event = (level: string, channel: Channel | null, conv: string | null, message: string, data: Record<string, unknown>) =>
    stmt(db, 'INSERT INTO events (ts, level, type, channel, conversation_id, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)', now, level, 'send_expired', channel, conv, clip(message, 400), JSON.stringify(data));
  for (const e of told.slice(0, EXPIRY_EVENTS)) {
    const who = whoOf(parseJson<JobTarget>(e.target, emptyTarget()));
    const reason = (e.last_error ?? '').split(':')[0] ?? '';
    writes.push(event(e.status === 'review' ? 'warn' : 'error', e.channel, e.conversation_id,
      e.status === 'review'
        ? `The draft for ${who} waited too long for your OK and was dropped.`
        : `Not sent to ${who} in time${reason ? ` (${failWords(reason)})` : ' (the laptop did not send it)'}.`,
      { outbox_id: e.id, source: e.source }));
  }
  if (told.length > EXPIRY_EVENTS) writes.push(event('error', null, null, `${told.length - EXPIRY_EVENTS} more replies were not sent in time.`, {}));
  const reminders = expired.filter((e) => e.source === 'recovery').length;
  if (reminders) writes.push(event('warn', 'whatsapp', null, `${reminders} checkout ${reminders === 1 ? 'reminder was' : 'reminders were'} not sent in time. ${reminders === 1 ? 'It' : 'They'} can go in the next daily run.`, {}));
  await db.batch(writes);
}

export async function cancelJob(db: D1Database, id: string): Promise<boolean> {
  return (await run(db, `UPDATE outbox SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'review')`, id)) > 0;
}

/**
 * Throw away what the agent queued by itself in one chat (replies, holding lines, review drafts) that
 * has not gone out yet, also when the laptop holds it already (leased): newer extensions drop it on
 * the next sync, and a send that still happens is recorded as ours. Used when the owner takes the
 * chat over or pauses it: those words no longer fit it.
 */
export async function cancelAgentJobs(db: D1Database, conversationId: string, reason: string, exceptId: string | null = null): Promise<number> {
  return run(
    db,
    `UPDATE outbox SET status = 'cancelled', last_error = ? WHERE conversation_id = ? AND status IN ('pending', 'leased', 'review') AND source IN ('auto', 'holding') AND id != ?`,
    reason, conversationId, exceptId ?? '',
  );
}

/**
 * The contact asked not to be messaged: nothing the agent queued for them goes out any more, in any
 * of their chats, recovery reminders to their number included, also when the laptop holds it already.
 * Messages the owner typed are kept.
 */
export async function cancelForOptOut(db: D1Database, contactId: string, phone: string | null): Promise<number> {
  return run(
    db,
    `UPDATE outbox SET status = 'cancelled', last_error = 'opted_out: they asked not to be messaged'
     WHERE status IN ('pending', 'leased', 'review') AND source != 'manual' AND (
       conversation_id IN (SELECT id FROM conversations WHERE contact_id = ?)
       OR (source = 'recovery' AND ? IS NOT NULL AND ref_id IN (SELECT id FROM checkouts WHERE phone_e164 = ?)))`,
    contactId, phone, phone,
  );
}
