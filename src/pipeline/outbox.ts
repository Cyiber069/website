import type { AgentJob, Channel, DeviceRow, Env, JobTarget, OutboxRow, Settings } from '../types';
import { all, clip, one, parseJson, run, stmt, uid } from '../lib/db';
import { logEvent } from '../lib/events';
import { HttpError } from '../lib/http';
import { MIN } from '../lib/time';

export const MAX_ATTEMPTS = 3;
const LEASE_MS = 3 * MIN;
/** Due jobs handed out per ready channel in one sync. The extension queues them and sends one at a time. */
export const JOBS_PER_SYNC = 3;
/** The owner was typing in that tab: offered again this soon, and not counted as a try. */
export const BUSY_RETRY_MS = 20_000;
/** Failures that are over in seconds (a slow page, a reloading tab): an agent reply is tried again quickly. */
const QUICK_RETRY_CODES = new Set(['timeout', 'no_content_script', 'tab_missing', 'send_not_confirmed', 'thread_not_found', 'composer_missing']);
const BUSY_CODES = new Set(['owner_busy', 'composer_busy']);
/** The agent's own replies: they may carry an extra wait the owner set. */
const AGENT_SOURCES = new Set(['auto', 'holding', 'discount']);

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
 */
export function jobPacing(row: Pick<OutboxRow, 'source' | 'pacing'>, settings: Settings): { delay_ms: number; typing_cps: number } {
  const stored = parseJson<{ delay_ms?: number; typing_cps?: number }>(row.pacing, {});
  if (row.source === 'recovery' || row.source === 'alert') return { delay_ms: stored.delay_ms ?? 0, typing_cps: stored.typing_cps ?? settings.pacing.typing_cps };
  if (!AGENT_SOURCES.has(row.source)) return { delay_ms: 0, typing_cps: 0 };
  const max = Math.max(0, settings.pacing.max_reply_delay_s * 1000);
  return { delay_ms: Math.min(Math.max(0, stored.delay_ms ?? 0), max), typing_cps: 0 };
}

export function toJob(row: OutboxRow, settings: Settings): AgentJob {
  return {
    id: row.id,
    channel: row.channel,
    kind: row.kind,
    source: row.source,
    target: parseJson<JobTarget>(row.target, emptyTarget()),
    parts: parseJson<string[]>(row.parts, []),
    pacing: jobPacing(row, settings),
    lease_until: row.lease_until ?? 0,
    attempts: row.attempts,
  };
}

/** Lease one specific job to a device straight away (used when the extension is waiting on the reply). */
export async function leaseById(db: D1Database, device: DeviceRow, id: string, settings: Settings, extraMs = 0): Promise<AgentJob | null> {
  const now = Date.now();
  const changed = await run(
    db,
    `UPDATE outbox SET status = 'leased', lease_until = ?, lease_device = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'`,
    now + LEASE_MS + extraMs, device.id, id,
  );
  if (!changed) return null;
  const row = await one<OutboxRow>(db, 'SELECT * FROM outbox WHERE id = ?', id);
  return row ? toJob(row, settings) : null;
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
    const due = await all<OutboxRow>(
      db,
      `SELECT * FROM outbox WHERE channel = ? AND status = 'pending' AND not_before <= ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY CASE source WHEN 'urgent' THEN 0 WHEN 'manual' THEN 0 WHEN 'auto' THEN 1 WHEN 'review' THEN 1 WHEN 'holding' THEN 1 WHEN 'discount' THEN 1 ELSE 2 END, not_before, created_at LIMIT ?`,
      channel, now, now, JOBS_PER_SYNC,
    );
    for (const next of due) {
      const job = await leaseById(db, device, next.id, settings);
      if (job) jobs.push(job);
    }
  }
  return jobs;
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

export async function completeJob(env: Env, device: DeviceRow, id: string, result: JobResult): Promise<{ ok: true; status: string }> {
  const db = env.DB;
  const row = await one<OutboxRow>(db, 'SELECT * FROM outbox WHERE id = ?', id);
  if (!row) throw new HttpError(404, 'job_not_found');
  if (row.status === 'sent') return { ok: true, status: 'sent' }; // idempotent re-report
  if (row.status !== 'leased' && row.status !== 'pending') return { ok: true, status: row.status };
  const now = Date.now();
  const target = parseJson<JobTarget>(row.target, emptyTarget());
  const parts = parseJson<string[]>(row.parts, []);

  if (result.status === 'sent') {
    await run(db, `UPDATE outbox SET status = 'sent', sent_at = ?, lease_until = NULL, last_error = NULL WHERE id = ?`, now, id);
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
        message: `Sent to ${target.title ?? target.phone ?? target.email ?? target.handle ?? 'customer'}: ${clip(parts.join(' '), 160)}`,
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
  // message, or what the owner wrote, still fits whatever came after it, so it is offered again.
  if (code === 'newer_message') {
    if (row.source === 'auto' || row.source === 'holding') {
      await db.batch([
        stmt(db, `UPDATE outbox SET status = 'cancelled', lease_until = NULL, last_error = ? WHERE id = ?`, why, id),
        stmt(db, 'UPDATE conversations SET needs_reply_since = COALESCE(needs_reply_since, ?) WHERE id = ?', now, row.conversation_id ?? ''),
      ]);
      return { ok: true, status: 'cancelled' };
    }
    await run(db, `UPDATE outbox SET status = 'pending', lease_until = NULL, not_before = ?, attempts = MAX(0, attempts - 1), last_error = ? WHERE id = ?`, now, why, id);
    return { ok: true, status: 'pending' };
  }

  // The owner is typing in that tab: not the job's fault. Offered again soon without using a try,
  // until it expires as usual.
  if (BUSY_CODES.has(code) && result.retryable !== false) {
    await run(db, `UPDATE outbox SET status = 'pending', lease_until = NULL, not_before = ?, attempts = MAX(0, attempts - 1), last_error = ? WHERE id = ?`, now + BUSY_RETRY_MS, why, id);
    return { ok: true, status: 'pending' };
  }

  const retry = result.retryable !== false && row.attempts < MAX_ATTEMPTS;
  if (retry) {
    // A quick failure of the agent's own reply is tried again in seconds: the customer is waiting.
    const step = AGENT_SOURCES.has(row.source) && QUICK_RETRY_CODES.has(code) ? 15_000 : MIN;
    await run(
      db,
      `UPDATE outbox SET status = 'pending', lease_until = NULL, not_before = ?, last_error = ? WHERE id = ?`,
      now + row.attempts * step, why, id,
    );
    return { ok: true, status: 'pending' };
  }
  await run(db, `UPDATE outbox SET status = 'failed', lease_until = NULL, last_error = ? WHERE id = ?`, why, id);
  if (row.source === 'recovery' && row.ref_id) {
    await run(db, `UPDATE checkouts SET status = 'failed', skip_reason = ?, updated_at = ? WHERE id = ?`, code, now, row.ref_id);
  }
  if (row.source !== 'alert') {
    await logEvent(db, {
      level: code === 'not_on_whatsapp' ? 'warn' : 'error', type: 'send_failed', channel: row.channel, conversation_id: row.conversation_id,
      message: `Could not send to ${target.title ?? target.phone ?? target.email ?? 'customer'} (${code.replace(/_/g, ' ')})`,
      data: { outbox_id: id, source: row.source, error: result.error ?? '' },
    });
  }
  return { ok: true, status: 'failed' };
}

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
  const expired = await all<{ id: string; source: string; ref_id: string | null }>(
    db, `SELECT id, source, ref_id FROM outbox WHERE status IN ('pending', 'review') AND expires_at IS NOT NULL AND expires_at < ?`, now,
  );
  for (const e of expired) {
    await run(db, `UPDATE outbox SET status = 'expired' WHERE id = ?`, e.id);
    if (e.source === 'recovery' && e.ref_id) {
      // Back to new so tomorrow's run can pick it up again if it is still fresh enough.
      await run(db, `UPDATE checkouts SET status = 'new', outbox_id = NULL, updated_at = ? WHERE id = ? AND status = 'queued'`, now, e.ref_id);
    }
  }
}

export async function cancelJob(db: D1Database, id: string): Promise<boolean> {
  return (await run(db, `UPDATE outbox SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'review')`, id)) > 0;
}

/**
 * Throw away what the agent queued by itself in one chat (replies, holding lines, review drafts) that
 * has not gone out yet. Used when the owner takes the chat over: those words no longer fit it.
 */
export async function cancelAgentJobs(db: D1Database, conversationId: string, reason: string, exceptId: string | null = null): Promise<number> {
  return run(
    db,
    `UPDATE outbox SET status = 'cancelled', last_error = ? WHERE conversation_id = ? AND status IN ('pending', 'review') AND source IN ('auto', 'holding') AND id != ?`,
    reason, conversationId, exceptId ?? '',
  );
}

/**
 * The contact asked not to be messaged: nothing the agent queued for them goes out any more, in any
 * of their chats, recovery reminders to their number included. Messages the owner typed are kept.
 */
export async function cancelForOptOut(db: D1Database, contactId: string, phone: string | null): Promise<number> {
  return run(
    db,
    `UPDATE outbox SET status = 'cancelled', last_error = 'opted_out: they asked not to be messaged'
     WHERE status IN ('pending', 'review') AND source != 'manual' AND (
       conversation_id IN (SELECT id FROM conversations WHERE contact_id = ?)
       OR (source = 'recovery' AND ? IS NOT NULL AND ref_id IN (SELECT id FROM checkouts WHERE phone_e164 = ?)))`,
    contactId, phone, phone,
  );
}
