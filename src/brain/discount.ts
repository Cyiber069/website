// extractDiscountRequest(): one small model call that reads the end of a chat and says whether the
// customer is asking for their own discount or sponsorship code, and which code they want.
// The pipeline only calls it when the unanswered messages, or the chat just before them, talk about a
// code (see src/discounts/agent.ts), and only acts on what it returns after its own checks: the code
// must be in the customer's own words and pass the rules in src/discounts/rules.ts.
import type { Env, HistoryMessage } from '../types';
import { callJson, callWithin, type CallBudget, type ProviderChoice } from './llm';
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
Decide one thing: in their unanswered messages, is the customer asking the shop to make them their own personal discount code, creator code or sponsorship code (for example a creator who wants a code for their followers)?
Read all the unanswered customer messages together as one request, with the chat before them for context. People split a request over several short messages, and the shop may already have asked them what they want their code to be. For example "hey can it be" then "acxjohn" is a request for the code acxjohn, and "I want a code" earlier, then the shop asking what it should be, then "make it JAKE20" is a request for JAKE20.
wants_code is true only for that. It is false when they ask whether a sale is on or whether there is a discount code, ask for a generic discount for themselves, ask about or report a problem with a code that already exists (for example "my code didn't work" or "I used code SUMMER10"), tell the shop their username or handle for another reason, or just mention a code.
code is the exact code they want, copied exactly as they typed it, keeping upper and lower case, dots, underscores and dashes (for example "User_1.5kw" stays "User_1.5kw"), when they name one (for example "I would like to make my discount code MACCA5" gives "MACCA5"). Only ever copy a code the customer typed themselves. Use null when they did not name one, or when it is unclear which word is the code.
confidence is how sure you are of both answers, from 0 to 1.
Reply with the JSON object only.`;

const STOP = new Set(['UK', 'USA', 'OK', 'LOL', 'PLS', 'PLZ', 'THX', 'ACX', 'EBIKE', 'EBIKES', 'TIKTOK', 'DM', 'DMS', 'BIO', 'GBP', 'IM', 'HI', 'HEY', 'YO']);

// Mock wording only (test mode). The real model reads the chat itself.
const MOCK_REQUEST = /\b(discount|creator|sponsor(ship)?|promo|affiliate)\s+code\b|\bcoupon\b|\bmy own code\b|\bmake (me )?a code\b|\b(want|get|need|like)( me)? (a|my( own)?) (personal |own )?code\b/;
const MOCK_NOT_A_REQUEST = /\b(didn'?t|doesn'?t|does not|did not|won'?t|not) work|\bnot working\b|\bfailed\b|\binvalid\b|\bexpired\b|\bused (the |my |a |code )|\bat checkout\b|\b(is|are) there (a |any )?(discount|promo|coupon)|\b(do|have) you (have |got )?(any|a) (discount|promo|coupon)|\bany (discount|promo|coupon)/;
const MOCK_SHOP_ASKS = /\b(what|which)\b[^?]{0,30}\b(want|like|should)\b[^?]{0,30}\bcode\b|\bcode to be\b|\bwhat should (it|your code) be\b/;
const MOCK_PICK = /\b(?:code (?:is|be|as)|make it|call it|can it be|it'?s|its|should be|i want|i'?d like)\s+["'“‘]?([A-Za-z0-9][A-Za-z0-9._-]{1,28}[A-Za-z0-9])/i;

/** Deterministic stand in for tests (ACX_TEST_MODE=1). Tests rely on these triggers. */
export function mockDiscountRequest(history: HistoryMessage[]): DiscountRequest {
  const pending = pendingInbound(history).filter((m) => m.kind === 'text');
  const text = pending.map((m) => m.body).join('\n');
  const lower = text.toLowerCase();
  if (MOCK_NOT_A_REQUEST.test(lower)) return { wants_code: false, code: null, confidence: 0.9 };
  // The request may have started before the unanswered messages: the customer asked, or the shop asked what code they want.
  const before = history.slice(Math.max(0, history.length - pending.length - 6), history.length - pending.length);
  const askedBefore = before.some((m) => (m.direction === 'in' ? MOCK_REQUEST.test(m.body.toLowerCase()) && !MOCK_NOT_A_REQUEST.test(m.body.toLowerCase()) : MOCK_SHOP_ASKS.test(m.body.toLowerCase())));
  const now = MOCK_REQUEST.test(lower);
  const quoted = /["'“‘]([A-Za-z0-9][A-Za-z0-9._-]{1,28}[A-Za-z0-9])["'”’]/.exec(text)?.[1] ?? null;
  const upper = (text.match(/\b[A-Z][A-Z0-9]{2,29}\b/g) ?? []).filter((t) => !STOP.has(t));
  const picked = MOCK_PICK.exec(text)?.[1] ?? null;
  // A message that is one word on its own, right after the request ("acxjohn").
  const lone = [...pending].reverse().map((m) => m.body.trim()).find((b) => /^[A-Za-z0-9][A-Za-z0-9._-]{1,28}[A-Za-z0-9]$/.test(b)) ?? null;
  if (!now && !askedBefore) return { wants_code: false, code: null, confidence: 0.9 };
  const code = quoted ?? upper.find((t) => /\d/.test(t)) ?? upper[0] ?? (picked && !/^(a|my|the|code|one)$/i.test(picked) ? picked : null) ?? (askedBefore ? lone : null);
  if (!now && !code) return { wants_code: false, code: null, confidence: 0.8 };
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

export interface ExtractOptions {
  /** Which model reads it (the cheap one for the quick check, the main one to confirm). Default: the configured brain. */
  choice?: ProviderChoice;
  /** The request's time limit. Without it the plain limits apply. */
  budget?: CallBudget;
  /** Stored in llm_usage, so the quick check and the confirmation can be told apart. */
  purpose?: string;
}

/** The chat for the extractor: the recent conversation, then the unanswered customer messages read together. */
export function discountUser(history: HistoryMessage[], now = Date.now()): string {
  const recent = history.slice(-10);
  const pending = pendingInbound(history).filter((m) => m.kind === 'text').map((m) => m.body.trim()).filter(Boolean);
  return [
    `The chat, oldest first:\n${renderConversation(recent, now)}`,
    pending.length ? `The customer's unanswered messages, read together:\n${JSON.stringify(pending.join(' / '))}` : '',
  ].filter(Boolean).join('\n\n');
}

export async function extractDiscountRequest(env: Env, history: HistoryMessage[], opts: ExtractOptions = {}): Promise<DiscountRequest> {
  const input = {
    purpose: opts.purpose ?? 'discount_request',
    system: [{ text: SYSTEM, cache: true }],
    user: discountUser(history),
    schema: DISCOUNT_REQUEST_SCHEMA,
    maxTokens: 1500,
    mock: () => mockDiscountRequest(history),
    ...(opts.choice ? { choice: opts.choice } : {}),
  };
  const res = opts.budget ? await callWithin(env, input, opts.budget) : await callJson(env, input);
  return validateDiscountRequest(res.data);
}
