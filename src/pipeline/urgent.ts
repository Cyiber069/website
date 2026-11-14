import { polishOwnerAnswer } from '../brain';
import { addLearnedFact } from '../kb';
import type { ContactRow, ConversationRow, Env, HistoryMessage, MessageRow, UrgentRow } from '../types';
import { all, clip, one, run } from '../lib/db';
import { logEvent } from '../lib/events';
import { HttpError } from '../lib/http';
import { getSettings } from '../lib/settings';
import { DAY } from '../lib/time';
import { emptyTarget, enqueue } from './outbox';

async function loadContext(db: D1Database, urgentId: string) {
  const urgent = await one<UrgentRow>(db, 'SELECT * FROM urgent WHERE id = ?', urgentId);
  if (!urgent) throw new HttpError(404, 'urgent_not_found');
  const conv = await one<ConversationRow>(db, 'SELECT * FROM conversations WHERE id = ?', urgent.conversation_id);
  if (!conv) throw new HttpError(404, 'conversation_not_found');
  const contact = (await one<ContactRow>(db, 'SELECT * FROM contacts WHERE id = ?', conv.contact_id))!;
  return { urgent, conv, contact };
}

async function queueAnswer(db: D1Database, urgent: UrgentRow, conv: ConversationRow, contact: ContactRow, parts: string[]): Promise<string> {
  const settings = await getSettings(db);
  const id = await enqueue(db, {
    channel: conv.channel, kind: 'reply', conversation_id: conv.id, source: 'urgent', ref_id: urgent.id,
    target: emptyTarget({
      thread_external_id: conv.external_thread_id, title: conv.title || contact.display_name, phone: contact.phone,
      email: contact.email, handle: contact.handle, subject: conv.subject,
    }),
    parts,
    expires_at: Date.now() + 3 * DAY,
    pacing: { delay_ms: 1500, typing_cps: settings.pacing.typing_cps },
    dedupe_key: `urgent:${urgent.id}:${Date.now()}`,
  });
  if (!id) throw new HttpError(409, 'already_queued', 'That answer is already on its way');
  return id;
}

/**
 * The owner typed a rough answer. Turn it into a proper reply in the customer's tone, queue it for the
 * laptop to send, and remember the fact so the agent never has to ask again.
 */
export async function answerUrgent(env: Env, urgentId: string, ownerAnswer: string, learn: boolean): Promise<{ urgent: UrgentRow; parts: string[]; learned: boolean }> {
  const db = env.DB;
  const { urgent, conv, contact } = await loadContext(db, urgentId);
  if (urgent.status !== 'open') throw new HttpError(409, 'not_open', 'This question was already handled');
  const now = Date.now();

  const rows = await all<MessageRow>(
    db, 'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY ts DESC, created_at DESC LIMIT 20) ORDER BY ts ASC, created_at ASC', conv.id,
  );
  const history: HistoryMessage[] = rows.map((m) => ({ direction: m.direction, author: m.author, body: m.body, kind: m.kind, ts: m.ts }));
  const result = await polishOwnerAnswer(env, {
    channel: conv.channel, contact_name: contact.display_name || null, question: urgent.question, owner_answer: ownerAnswer, history, now,
  });
  if (!result.parts.length) throw new HttpError(502, 'polish_failed', 'Could not write the reply. Try again.');

  const outboxId = await queueAnswer(db, urgent, conv, contact, result.parts);
  let kbDocId: string | null = null;
  if (learn && result.learned) {
    kbDocId = await addLearnedFact(env, { ...result.learned, urgent_id: urgent.id }).catch(() => null);
  }
  await run(
    db,
    `UPDATE urgent SET status = 'answered', owner_answer = ?, polished_answer = ?, learn = ?, kb_doc_id = ?, outbox_id = ?, answered_at = ? WHERE id = ?`,
    ownerAnswer, result.parts.join('\n'), learn ? 1 : 0, kbDocId, outboxId, now, urgent.id,
  );
  await run(db, `UPDATE conversations SET status = 'open', paused_until = NULL, pause_reason = NULL, updated_at = ? WHERE id = ?`, now, conv.id);
  await logEvent(db, {
    level: 'good', type: 'urgent_answered', channel: conv.channel, conversation_id: conv.id,
    message: `You answered ${contact.display_name || 'a customer'}. Sending: ${clip(result.parts.join(' '), 160)}${kbDocId ? ' (saved to knowledge)' : ''}`,
    data: { urgent_id: urgent.id, outbox_id: outboxId },
  });
  const fresh = (await one<UrgentRow>(db, 'SELECT * FROM urgent WHERE id = ?', urgent.id))!;
  return { urgent: fresh, parts: result.parts, learned: kbDocId !== null };
}

/** Send the agent's own draft as it stands (used when it was parked only for low confidence). */
export async function sendUrgentDraft(env: Env, urgentId: string, editedText?: string): Promise<{ urgent: UrgentRow; parts: string[] }> {
  const db = env.DB;
  const { urgent, conv, contact } = await loadContext(db, urgentId);
  if (urgent.status !== 'open') throw new HttpError(409, 'not_open', 'This question was already handled');
  const text = (editedText ?? urgent.polished_answer ?? '').trim();
  if (!text) throw new HttpError(400, 'no_draft', 'There is no draft to send');
  const parts = text.split('\n').map((p) => p.trim()).filter(Boolean).slice(0, 3);
  const now = Date.now();
  const outboxId = await queueAnswer(db, urgent, conv, contact, parts);
  await run(db, `UPDATE urgent SET status = 'answered', polished_answer = ?, outbox_id = ?, answered_at = ? WHERE id = ?`, parts.join('\n'), outboxId, now, urgent.id);
  await run(db, `UPDATE conversations SET status = 'open', updated_at = ? WHERE id = ?`, now, conv.id);
  await logEvent(db, { level: 'good', type: 'urgent_answered', channel: conv.channel, conversation_id: conv.id, message: `You approved the draft for ${contact.display_name || 'a customer'}.`, data: { urgent_id: urgent.id } });
  return { urgent: (await one<UrgentRow>(db, 'SELECT * FROM urgent WHERE id = ?', urgent.id))!, parts };
}

export async function dismissUrgent(env: Env, urgentId: string): Promise<void> {
  const db = env.DB;
  const { urgent, conv } = await loadContext(db, urgentId);
  if (urgent.status !== 'open') return;
  await run(db, `UPDATE urgent SET status = 'dismissed', answered_at = ? WHERE id = ?`, Date.now(), urgent.id);
  const stillOpen = await one<{ id: string }>(db, `SELECT id FROM urgent WHERE conversation_id = ? AND status = 'open' LIMIT 1`, conv.id);
  if (!stillOpen) await run(db, `UPDATE conversations SET status = 'open' WHERE id = ?`, conv.id);
}
