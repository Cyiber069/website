// The agent making creator codes by itself. Called by processConversation (src/pipeline/inbound.ts)
// after its gates, before the normal brain reply.
//
//   the unanswered customer messages mention a code, or finish a code request started just before
//   them ("hey can it be" then "acxjohn")?  (codeTrigger: no AI)
//     no  -> nothing to do here
//     yes -> quick check on the cheap model (extractDiscountRequest): wants_code, code, confidence
//            no request            -> normal reply
//            request, no code      -> normal reply, with a note to ask what they want it to be
//            request with a code   -> confirmed on the main model, then planCodeRequest: make it
//                                     now (auto) or park it for the owner
//
// A code is only ever made when it is in the customer's own unanswered words and every rule passes.
// Parking means: a draft in Discount codes plus an Urgent item with one tap approve. Everything that
// is not plainly safe parks: ask mode, low confidence, the two models disagreeing or the check
// failing, the customer talking about a code that already exists, a bad word or the brand name as
// the code, a code that exists already, a second code for the same person, the daily cap, Shopify
// not connected or saying no. When a code is made, the only message that goes out is the template.
import { cheapChoice, chooseProvider, extractDiscountRequest, type DiscountRequest } from '../brain';
import { pendingInbound } from '../brain/rules';
import type { CallBudget } from '../brain/llm';
import type { AgentJob, ContactRow, ConversationRow, DeviceRow, Env, HistoryMessage, JobTarget, MessageRow, Settings, UrgentRow } from '../types';
import { clip, one, run, uid } from '../lib/db';
import { logEvent } from '../lib/events';
import { HttpError } from '../lib/http';
import { HOUR, MIN, londonTime } from '../lib/time';
import { alertOwner } from '../pipeline/alerts';
import { enqueue, leaseById } from '../pipeline/outbox';
import type { DiscountResult } from '../shopify/discounts';
import { HOLDING_CODE_LINE, brandWords, codeProblem, codeTrigger, codeTrouble, confirmRequest, inCustomerWords, mentionsCode, planCodeRequest } from './rules';
import {
  type CreateFn, type DiscountRow, insertDiscount, liveThenSend, loadDiscount, makeLive, messageFor, normaliseCode, queueDiscountMessage,
} from './index';

function startOfLondonDay(now: number): number {
  const lt = londonTime(now);
  return now - (lt.hour * HOUR + lt.minute * MIN) - (now % MIN);
}

export interface CodeTurn {
  settings: Settings;
  conv: ConversationRow;
  contact: ContactRow;
  /** The chat as the brain sees it, oldest first, replies queued but not sent yet included. */
  history: HistoryMessage[];
  rows: MessageRow[];
  /** The customer messages nobody answered yet: after our last message, sent or queued. */
  unanswered: MessageRow[];
  /** The channel's mode: auto sends, review waits for the owner's OK. */
  channel_mode: 'auto' | 'review';
  device: DeviceRow | null;
  /** False once the extension that is waiting on this request has hung up: then nothing is leased to it. */
  live?: () => boolean;
  /** When the model calls of this request must be done (see processConversation). */
  deadlineAt?: number;
  /** The customer message a reply sent now answers, and when it arrived (for the reply time). */
  reply_to?: { id: string; ts: number } | null;
  target: JobTarget;
  pacing: { delay_ms: number; typing_cps: number };
  now: number;
  /** Tests only: what makes the code in Shopify. */
  create?: CreateFn;
}

export type CodeTurnResult =
  | { kind: 'none' }
  | { kind: 'note'; note: string }
  /** queued: jobs put in the outbox that were not handed over in `jobs` (the extension fetches them with a sync). */
  | { kind: 'done'; action: 'reply' | 'review' | 'escalate' | 'none'; reason: string; jobs: AgentJob[]; queued?: number };

/** The customer's unanswered words. */
function pendingWords(unanswered: MessageRow[]): { text: string; first: MessageRow | null } {
  const pending = unanswered.filter((m) => m.status !== 'history' && m.direction === 'in');
  return { text: pending.map((m) => m.body).join('\n'), first: pending[0] ?? null };
}

// The quick check runs on the cheap model and keeps most of the request's time for the reply.
const CHECK_CAP_MS = 8_000;
const CHECK_RESERVE_MS = 20_000;
const CONFIRM_CAP_MS = 15_000;
const budget = (deadlineAt: number | undefined, capMs: number, reserveMs: number): CallBudget | undefined =>
  deadlineAt ? { deadlineAt, capMs, minMs: 2_000, reserveMs } : undefined;

export async function handleCodeTurn(env: Env, t: CodeTurn): Promise<CodeTurnResult> {
  const s = t.settings.discounts;
  if (s.mode === 'off') return { kind: 'none' };
  const { text, first } = pendingWords(t.unanswered);
  if (!first) return { kind: 'none' };
  const before = t.history.slice(0, t.history.length - pendingInbound(t.history).length);
  const trigger = codeTrigger(text, before, t.now);
  if (!trigger) return { kind: 'none' };
  const db = env.DB;

  // This run already dealt with these messages (a retry, or the chat handed back): do not do it twice.
  const handled = await one<{ id: string }>(
    db, `SELECT id FROM discount_codes WHERE conversation_id = ? AND made_by = 'agent' AND created_at >= ? LIMIT 1`, t.conv.id, trigger.since ?? first.created_at,
  );
  if (handled) {
    // A request split over messages that was already dealt with: anything after it gets a normal reply.
    if (trigger.kind === 'context') return { kind: 'none' };
    // Something new and unrelated since then gets a normal reply. More about the code waits for the owner or the template.
    const last = t.rows[t.rows.length - 1];
    if (last && last.id !== first.id && !mentionsCode(last.body)) return { kind: 'none' };
    return { kind: 'done', action: 'none', reason: 'code_request_already_handled', jobs: [] };
  }

  // Quick yes or no on the cheap model. A no, or the check failing, is a normal reply: no code is made.
  let request: DiscountRequest;
  try {
    const main = await chooseProvider(env, t.settings);
    const cheap = cheapChoice(main);
    const split = cheap.model !== main.model;
    request = await extractDiscountRequest(env, t.history, {
      choice: cheap, budget: budget(t.deadlineAt, CHECK_CAP_MS, CHECK_RESERVE_MS), purpose: split ? 'discount_check' : 'discount_request',
    });
    // Before a code can be made, the main model reads it too. Any doubt parks it for the owner.
    if (request.wants_code && request.code && split) {
      try {
        const confirm = await extractDiscountRequest(env, t.history, { choice: main, budget: budget(t.deadlineAt, CONFIRM_CAP_MS, 1_000), purpose: 'discount_request' });
        request = confirmRequest(request, confirm);
      } catch (err) {
        console.error('discount request confirm failed', err);
        request = { ...request, confidence: 0 };
      }
    }
  } catch (err) {
    console.error('discount request check failed', err);
    return { kind: 'none' };
  }
  if (!request.wants_code) return { kind: 'none' };

  const code = normaliseCode(request.code);
  const inWords = code ? inCustomerWords(code, text) : true;
  const [taken, contactCode, today] = code && inWords
    ? await Promise.all([
        one<{ id: string }>(db, 'SELECT id FROM discount_codes WHERE code = ? COLLATE NOCASE', code),
        one<{ code: string }>(db, `SELECT code FROM discount_codes WHERE contact_id = ? AND status != 'draft' ORDER BY created_at DESC LIMIT 1`, t.contact.id),
        one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM discount_codes WHERE made_by = 'agent' AND shopify_status = 'created' AND created_at >= ?`, startOfLondonDay(t.now)),
      ])
    : [null, null, null];
  const plan = planCodeRequest({
    settings: s, request, code, problem: code ? codeProblem(code, brandWords(t.settings)) : null,
    taken_here: Boolean(taken), contact_code: contactCode?.code ?? null, made_today: today?.n ?? 0,
    in_words: inWords, doubt: codeTrouble(text),
  });

  if (plan.kind === 'none') return { kind: 'none' };
  if (plan.kind === 'ask_customer') return { kind: 'note', note: plan.note };
  const who = t.contact.display_name || t.conv.title || 'A customer';

  if (plan.kind === 'park') return parkCodeRequest(env, t, { code: plan.code, reason: plan.reason, withDraft: plan.draft, draft: null, shopify: null });

  // Make it.
  let draft: DiscountRow;
  try {
    draft = await insertDiscount(db, {
      conv: t.conv, contact: t.contact, code: plan.code, amount: s.amount, applies_to: s.applies_to, expires_at: null, usage_limit: null,
      message_text: messageFor(s, plan.code, s.amount, s.applies_to), made_by: 'agent', now: t.now,
    });
  } catch (err) {
    if (err instanceof HttpError && err.code === 'code_taken') return parkCodeRequest(env, t, { code: plan.code, reason: `The code ${plan.code} is already used for someone else`, withDraft: false, draft: null, shopify: null });
    throw err;
  }
  const { row, shopify } = await makeLive(env, draft, { now: t.now, create: t.create });
  if (row.shopify_status !== 'created') {
    const why = shopify?.error_code === 'not_connected' ? 'Shopify is not connected, so the agent could not make the code'
      : shopify?.error_code === 'code_taken' ? `The code ${plan.code} already exists in Shopify`
        : `Shopify did not make the code: ${shopify?.message ?? 'no reason given'}`;
    return parkCodeRequest(env, t, { code: plan.code, reason: why, withDraft: true, draft: row, shopify });
  }

  const status = t.channel_mode === 'review' ? 'review' : 'pending';
  const queued = await queueDiscountMessage(env, row, row.message_text, { now: t.now, source: 'discount', status, pacing: t.pacing, reply_to: t.reply_to });
  const jobs: AgentJob[] = [];
  // Handed over in this answer only while the extension is still listening. Otherwise it waits for the next sync.
  if (status === 'pending' && t.device && (t.live?.() ?? true)) {
    const job = await leaseById(db, t.device, queued.outbox_id, t.settings, t.pacing.delay_ms);
    if (job) jobs.push(job);
  }
  await logEvent(db, {
    level: 'good', type: 'discount', channel: t.conv.channel, conversation_id: t.conv.id,
    message: `Made discount code ${plan.code} for ${who}${status === 'review' ? '. The message waits for your OK.' : ''}`,
    data: { discount_id: row.id, outbox_id: queued.outbox_id },
  });
  await alertOwner(env, t.settings, {
    kind: 'discount', title: `Made discount code ${plan.code}`,
    body: `For ${who}. ${status === 'review' ? 'The message waits for your OK.' : 'The message is on its way.'}`, path: '/#/discounts',
  });
  return { kind: 'done', action: status === 'review' ? 'review' : 'reply', reason: `made discount code ${plan.code}`, jobs, queued: status === 'pending' && !jobs.length ? 1 : 0 };
}

/** Draft in Discount codes plus an Urgent item the owner approves with one tap. */
async function parkCodeRequest(
  env: Env, t: CodeTurn,
  p: { code: string | null; reason: string; withDraft: boolean; draft: DiscountRow | null; shopify: DiscountResult | null },
): Promise<CodeTurnResult> {
  const db = env.DB;
  const s = t.settings.discounts;
  const who = t.contact.display_name || t.conv.title || 'A customer';
  const open = await one<UrgentRow>(db, `SELECT * FROM urgent WHERE conversation_id = ? AND status = 'open' AND category = 'discount_code' ORDER BY created_at DESC LIMIT 1`, t.conv.id);

  let draft = p.draft;
  if (!draft && p.withDraft && p.code) {
    // Asked again with a different code while the first is still waiting: change the waiting draft.
    const waiting = open?.discount_id ? await one<DiscountRow>(db, `SELECT * FROM discount_codes WHERE id = ? AND status = 'draft'`, open.discount_id) : null;
    if (waiting && waiting.code !== p.code) {
      const changed = await run(db, `UPDATE discount_codes SET code = ?, message_text = ?, updated_at = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM discount_codes WHERE code = ? COLLATE NOCASE)`,
        p.code, messageFor(s, p.code, waiting.amount, waiting.applies_to), t.now, waiting.id, p.code).catch(() => 0);
      if (changed) draft = await loadDiscount(db, waiting.id);
    } else if (waiting) {
      draft = waiting;
    }
    if (!draft) {
      try {
        draft = await insertDiscount(db, {
          conv: t.conv, contact: t.contact, code: p.code, amount: s.amount, applies_to: s.applies_to, expires_at: null, usage_limit: null,
          message_text: messageFor(s, p.code, s.amount, s.applies_to), made_by: 'agent', now: t.now,
        });
      } catch (err) {
        if (!(err instanceof HttpError && err.code === 'code_taken')) throw err;
      }
    }
  }

  const question = p.code ? `${who} wants discount code ${p.code}` : `${who} wants a discount code`;
  const customerWords = pendingWords(t.unanswered).text;
  const jobs: AgentJob[] = [];
  let queued = 0;
  let urgentId: string;
  if (open) {
    urgentId = open.id;
    await run(db, 'UPDATE urgent SET question = ?, customer_message = ?, reason = ?, discount_id = COALESCE(?, discount_id) WHERE id = ?',
      clip(question, 500), clip(customerWords, 1500), clip(p.reason, 300), draft?.id ?? null, open.id);
  } else {
    urgentId = uid('u');
    await run(
      db,
      `INSERT INTO urgent (id, conversation_id, channel, question, customer_message, reason, category, status, discount_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'discount_code', 'open', ?, ?)`,
      urgentId, t.conv.id, t.conv.channel, clip(question, 500), clip(customerWords, 1500), clip(p.reason, 300), draft?.id ?? null, t.now,
    );
    await run(db, `UPDATE conversations SET status = 'waiting_owner' WHERE id = ?`, t.conv.id);
    // A short line so they are not left hanging. It never says the code exists.
    if (t.settings.voice.holding_reply && t.channel_mode === 'auto') {
      const hid = await enqueue(db, {
        channel: t.conv.channel, kind: 'reply', conversation_id: t.conv.id, target: t.target, parts: [HOLDING_CODE_LINE],
        source: 'holding', ref_id: urgentId, pacing: t.pacing, dedupe_key: `holding:${urgentId}`, expires_at: t.now + t.settings.pacing.ignore_older_than_hours * HOUR,
        reply_to: t.reply_to,
      });
      if (hid && t.device && (t.live?.() ?? true)) {
        const job = await leaseById(db, t.device, hid, t.settings, t.pacing.delay_ms);
        if (job) jobs.push(job);
      }
      if (hid && !jobs.length) queued = 1;
    }
  }
  await logEvent(db, {
    level: 'warn', type: 'discount_request', channel: t.conv.channel, conversation_id: t.conv.id,
    message: `${question}. Waiting for you: ${p.reason}.`, data: { urgent_id: urgentId, discount_id: draft?.id ?? null },
  });
  await alertOwner(env, t.settings, { kind: 'urgent', title: 'Discount code request', body: clip(question, 120), path: '/#/urgent' });
  return { kind: 'done', action: 'escalate', reason: `code request parked: ${p.reason}`, jobs, queued };
}

/**
 * The owner tapped Approve code. Make it (Shopify, or their word that it is there), send the template
 * in the chat, and close the Urgent item that asked for it.
 */
export async function approveCodeRequest(env: Env, discountId: string, opts: { text?: string; confirmExists?: boolean; now: number; create?: CreateFn }) {
  const db = env.DB;
  const row = await loadDiscount(db, discountId);
  const res = await liveThenSend(env, row, { text: opts.text, confirmExists: opts.confirmExists, now: opts.now, source: 'discount', create: opts.create });
  const text = res.row.message_text;
  const urgent = await one<UrgentRow>(db, `SELECT * FROM urgent WHERE discount_id = ? AND status = 'open' LIMIT 1`, row.id);
  if (urgent) {
    await run(db, `UPDATE urgent SET status = 'answered', polished_answer = ?, outbox_id = ?, answered_at = ? WHERE id = ?`, text, res.queued.outbox_id, opts.now, urgent.id);
    const stillOpen = await one(db, `SELECT id FROM urgent WHERE conversation_id = ? AND status = 'open' LIMIT 1`, urgent.conversation_id);
    if (!stillOpen) await run(db, `UPDATE conversations SET status = 'open', updated_at = ? WHERE id = ?`, opts.now, urgent.conversation_id);
  }
  if (!res.queued.already) {
    await logEvent(db, {
      level: 'good', type: 'discount', channel: row.channel, conversation_id: row.conversation_id,
      message: `You approved discount code ${row.code} for ${row.contact_name || 'a customer'}.${res.shopify?.ok ? ' Made in Shopify.' : ''}`,
      data: { discount_id: row.id, outbox_id: res.queued.outbox_id },
    });
  }
  return { ...res, text };
}

