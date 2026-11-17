import { REPLY_NOW_NOTE, decide, learnFromOwnerNote, noteSaysWait, ownerGuidance, polishOwnerAnswer } from '../brain';
import { promisesLiveCode } from '../discounts/rules';
import { addLearnedFact } from '../kb';
import type { ContactRow, ConversationRow, Env, HistoryMessage, MessageRow, UrgentRow } from '../types';
import { all, clip, one, parseJson, run } from '../lib/db';
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

async function queueAnswer(db: D1Database, urgent: UrgentRow, conv: ConversationRow, contact: ContactRow, parts: string[], status: 'pending' | 'review' = 'pending'): Promise<string> {
  const settings = await getSettings(db);
  const id = await enqueue(db, {
    channel: conv.channel, kind: 'reply', conversation_id: conv.id, source: 'urgent', ref_id: urgent.id, status,
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

/** Owner guidance notes kept on one conversation: newest last, a handful at most. */
const MAX_GUIDANCE_NOTES = 6;

/**
 * The owner told the agent what is going on instead of typing the reply. The agent writes the reply
 * itself from the note (normal style and safety rules), queues it (a review draft when the channel
 * asks first), keeps the note on the conversation for later messages, and with remember on stores a
 * reusable version in the knowledge base when there is one. A note that says to wait sends nothing.
 */
export async function answerUrgentWithNote(env: Env, urgentId: string, note: string, remember: boolean): Promise<{
  urgent: UrgentRow; parts: string[]; status: 'pending' | 'review' | 'none'; outbox_id: string | null; learned: boolean; kb_doc_id: string | null;
}> {
  const db = env.DB;
  const { urgent, conv, contact } = await loadContext(db, urgentId);
  if (urgent.status !== 'open') throw new HttpError(409, 'not_open', 'This question was already handled');
  const settings = await getSettings(db);
  const now = Date.now();
  const guidance = ownerGuidance(note, now);
  const kept = parseJson<string[]>(conv.context_notes, []);
  const wait = noteSaysWait(note);

  let parts: string[] = [];
  if (!wait) {
    const rows = await all<MessageRow>(
      db, 'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY ts DESC, created_at DESC LIMIT 30) ORDER BY ts ASC, created_at ASC', conv.id,
    );
    const history: HistoryMessage[] = rows.map((m) => ({ direction: m.direction, author: m.author, body: m.body, kind: m.kind, ts: m.ts }));
    if (!history.some((m) => m.direction === 'in')) throw new HttpError(409, 'nothing_to_answer', 'There is no customer message in this chat to answer.');
    const decision = await decide(env, {
      channel: conv.channel, contact_name: contact.display_name || null, subject: conv.subject,
      history, context_notes: [...kept, guidance, REPLY_NOW_NOTE], now, mode: 'live',
    });
    // The owner already looked at this, so confidence does not hold it back. Anything that is not a
    // usable reply, or that says a discount code is ready, goes back to the owner instead.
    if (decision.action === 'reply' && decision.parts.length && !promisesLiveCode(decision.parts.join(' '))) parts = decision.parts;
    if (!parts.length) {
      throw new HttpError(422, 'no_reply', 'The agent could not write a reply from that note. Add a bit more detail, or write the reply yourself.');
    }
  }

  // The note stays with this chat so later messages follow it too.
  const notes = [...kept.filter((n) => n !== guidance), guidance].slice(-MAX_GUIDANCE_NOTES);
  await run(db, 'UPDATE conversations SET context_notes = ? WHERE id = ?', JSON.stringify(notes), conv.id);

  const mode = settings.channels[conv.channel].mode;
  const status: 'pending' | 'review' | 'none' = parts.length ? (mode === 'review' ? 'review' : 'pending') : 'none';
  const outboxId = parts.length ? await queueAnswer(db, urgent, conv, contact, parts, status === 'review' ? 'review' : 'pending') : null;

  let kbDocId: string | null = null;
  if (remember) {
    const fact = await learnFromOwnerNote(env, { note, question: urgent.question });
    if (fact) kbDocId = await addLearnedFact(env, { ...fact, urgent_id: urgent.id }).catch(() => null);
  }
  await run(
    db,
    `UPDATE urgent SET status = 'answered', owner_note = ?, polished_answer = ?, learn = ?, kb_doc_id = ?, outbox_id = ?, answered_at = ? WHERE id = ?`,
    note, parts.join('\n') || null, remember ? 1 : 0, kbDocId, outboxId, now, urgent.id,
  );
  const stillOpen = await one<{ id: string }>(db, `SELECT id FROM urgent WHERE conversation_id = ? AND status = 'open' LIMIT 1`, conv.id);
  await run(db, `UPDATE conversations SET status = ?, paused_until = NULL, pause_reason = NULL, needs_reply_since = NULL, updated_at = ? WHERE id = ?`, stillOpen ? 'waiting_owner' : 'open', now, conv.id);
  const who = contact.display_name || 'a customer';
  await logEvent(db, {
    level: 'good', type: 'urgent_answered', channel: conv.channel, conversation_id: conv.id,
    message: parts.length
      ? `You told the agent what is going on with ${who}. ${status === 'review' ? 'Draft waiting for your OK' : 'Sending'}: ${clip(parts.join(' '), 140)}${kbDocId ? ' (saved to knowledge)' : ''}`
      : `You told the agent to wait with ${who}. Nothing was sent.${kbDocId ? ' (saved to knowledge)' : ''}`,
    data: { urgent_id: urgent.id, outbox_id: outboxId },
  });
  const fresh = (await one<UrgentRow>(db, 'SELECT * FROM urgent WHERE id = ?', urgent.id))!;
  return { urgent: fresh, parts, status, outbox_id: outboxId, learned: kbDocId !== null, kb_doc_id: kbDocId };
}
