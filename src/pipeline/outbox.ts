import type { AgentJob, Channel, DeviceRow, Env, JobTarget, OutboxRow, Settings } from '../types';
import { all, clip, one, parseJson, run, uid } from '../lib/db';
import { logEvent } from '../lib/events';
import { HttpError } from '../lib/http';
import { MIN } from '../lib/time';

export const MAX_ATTEMPTS = 3;
const LEASE_MS = 3 * MIN;

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
}

export function emptyTarget(over: Partial<JobTarget> = {}): JobTarget {
  return { thread_external_id: null, title: null, phone: null, email: null, handle: null, subject: null, ...over };
}

/** Queue a message for the extension. Returns the id, or null when the dedupe key was already used. */
export async function enqueue(db: D1Database, input: EnqueueInput): Promise<string | null> {
  const parts = input.parts.map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new HttpError(400, 'empty_message', 'Nothing to send');
  const id = uid('ob');
  const now = Date.now();
  const changed = await run(
    db,
    `INSERT INTO outbox (id, channel, kind, conversation_id, target, parts, status, source, ref_id, not_before, expires_at, dedupe_key, pacing, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
    id, input.channel, input.kind, input.conversation_id ?? null, JSON.stringify(input.target), JSON.stringify(parts),
    input.status ?? 'pending', input.source, input.ref_id ?? null, input.not_before ?? now, input.expires_at ?? null,
    input.dedupe_key ?? null, JSON.stringify(input.pacing ?? {}), now,
  );
  return changed ? id : null;
}

export function toJob(row: OutboxRow, settings: Settings): AgentJob {
  const pacing = parseJson<{ delay_ms?: number; typing_cps?: number }>(row.pacing, {});
  return {
    id: row.id,
    channel: row.channel,
    kind: row.kind,
    source: row.source,
    target: parseJson<JobTarget>(row.target, emptyTarget()),
    parts: parseJson<string[]>(row.parts, []),
    pacing: { delay_ms: pacing.delay_ms ?? 0, typing_cps: pacing.typing_cps ?? settings.pacing.typing_cps },
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
 * Hand due jobs to the extension. At most one job per channel is out at a time so messages in a
 * tab are typed one after another, never interleaved.
 */
export async function leaseDue(db: D1Database, device: DeviceRow, settings: Settings, ready: Channel[]): Promise<AgentJob[]> {
  if (!settings.agent.enabled) return [];
  const now = Date.now();
  const jobs: AgentJob[] = [];
  for (const channel of ready) {
    if (settings.channels[channel].mode === 'off') continue;
    const busy = await one<{ id: string }>(db, `SELECT id FROM outbox WHERE channel = ? AND status = 'leased' AND lease_until > ? LIMIT 1`, channel, now);
    if (busy) continue;
    const next = await one<OutboxRow>(
      db,
      `SELECT * FROM outbox WHERE channel = ? AND status = 'pending' AND not_before <= ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY CASE source WHEN 'urgent' THEN 0 WHEN 'manual' THEN 0 WHEN 'auto' THEN 1 WHEN 'review' THEN 1 WHEN 'holding' THEN 1 ELSE 2 END, not_before, created_at LIMIT 1`,
      channel, now, now,
    );
    if (!next) continue;
    const job = await leaseById(db, device, next.id, settings);
    if (job) jobs.push(job);
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
  const retry = result.retryable !== false && row.attempts < MAX_ATTEMPTS;
  if (retry) {
    await run(
      db,
      `UPDATE outbox SET status = 'pending', lease_until = NULL, not_before = ?, last_error = ? WHERE id = ?`,
      now + row.attempts * MIN, `${code}: ${clip(result.error ?? '', 200)}`, id,
    );
    return { ok: true, status: 'pending' };
  }
  await run(db, `UPDATE outbox SET status = 'failed', lease_until = NULL, last_error = ? WHERE id = ?`, `${code}: ${clip(result.error ?? '', 200)}`, id);
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
