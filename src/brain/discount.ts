// extractDiscountRequest(): one small model call that reads the end of a chat and says whether the
// customer is asking for their own discount or sponsorship code, and which code they want.
// The pipeline only calls it when the new messages mention a code at all (see src/discounts/agent.ts),
// and only acts on what it returns after its own checks.
import type { Env, HistoryMessage } from '../types';
import { callJson } from './llm';
import { renderConversation } from './prompt';
import { pendingInbound } from './rules';

export interface DiscountRequest {
  wants_code: boolean;
  /** The code exactly as the customer asked for it, or null when they did not say. Not cleaned yet. */
  code: string | null;
  /** 0 to 1: how sure the model is about both answers. */
  confidence: number;
}

export const DISCOUNT_REQUEST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['wants_code', 'code', 'confidence'],
  properties: {
    wants_code: { type: 'boolean' },
    code: { anyOf: [{ type: 'null' }, { type: 'string' }] },
    confidence: { type: 'number' },
  },
};

const SYSTEM = `You read the end of a chat between an ebike shop and one of its customers.
Decide one thing: in their newest messages, is the customer asking the shop to make them their own personal discount code, creator code or sponsorship code (for example a creator who wants a code for their followers)?
wants_code is true only for that. It is false when they ask whether a sale is on, ask for a generic discount for themselves, ask about a code that already exists, or just mention a code.
code is the exact code they want, copied exactly as they typed it, keeping upper and lower case, dots, underscores and dashes (for example "User_1.5kw" stays "User_1.5kw"), when they name one (for example "I would like to make my discount code MACCA5" gives "MACCA5"). Use null when they did not name one, or when it is unclear which word is the code.
confidence is how sure you are of both answers, from 0 to 1.
Reply with the JSON object only.`;

const STOP = new Set(['UK', 'USA', 'OK', 'LOL', 'PLS', 'PLZ', 'THX', 'ACX', 'EBIKE', 'EBIKES', 'TIKTOK', 'DM', 'DMS', 'BIO', 'GBP', 'IM', 'HI', 'HEY', 'YO']);

/** Deterministic stand in for tests (ACX_TEST_MODE=1). Tests rely on these triggers. */
export function mockDiscountRequest(history: HistoryMessage[]): DiscountRequest {
  const pending = pendingInbound(history).filter((m) => m.kind === 'text');
  const text = pending.map((m) => m.body).join('\n');
  const lower = text.toLowerCase();
  const wants = /\b(discount|creator|sponsor(ship)?|promo|affiliate)\s+code\b|\bcoupon\b|\bmy own code\b|\bmake (me )?a code\b/.test(lower);
  if (!wants) return { wants_code: false, code: null, confidence: 0.9 };
  const quoted = /["'“‘]([A-Za-z0-9][A-Za-z0-9._-]{1,28}[A-Za-z0-9])["'”’]/.exec(text)?.[1] ?? null;
  const upper = (text.match(/\b[A-Z][A-Z0-9]{2,29}\b/g) ?? []).filter((t) => !STOP.has(t));
  const code = quoted ?? upper.find((t) => /\d/.test(t)) ?? upper[0] ?? null;
  return { wants_code: true, code, confidence: lower.includes('lowconf') ? 0.4 : 0.95 };
}

/** Never throws for bad output: anything unusable reads as "no request". Model errors are thrown. */
export function validateDiscountRequest(raw: unknown): DiscountRequest {
  const o = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const wants = o.wants_code === true;
  const code = typeof o.code === 'string' && o.code.trim() ? o.code.trim().slice(0, 60) : null;
  const c = typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? Math.min(1, Math.max(0, o.confidence)) : 0;
  return { wants_code: wants, code: wants ? code : null, confidence: c };
}

export async function extractDiscountRequest(env: Env, history: HistoryMessage[]): Promise<DiscountRequest> {
  const recent = history.slice(-8);
  const res = await callJson(env, {
    purpose: 'discount_request',
    system: [{ text: SYSTEM, cache: true }],
    user: `The chat, oldest first:\n${renderConversation(recent, Date.now())}`,
    schema: DISCOUNT_REQUEST_SCHEMA,
    maxTokens: 1500,
    mock: () => mockDiscountRequest(history),
  });
  return validateDiscountRequest(res.data);
}
