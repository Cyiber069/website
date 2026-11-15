// The pure rules behind the agent making codes: no database, no network, no bundled files, so they
// can be tested on their own. Used by ./agent.ts, the pipeline and PUT /api/settings/discounts.
import type { DiscountRequest } from '../brain/discount';
import type { DiscountSettings, Settings } from '../types';
import { clip } from '../lib/db';
import { HttpError } from '../lib/http';

/** Below this the extractor's answer is not trusted to make a code alone. */
export const MIN_CONFIDENCE = 0.7;

/** Words that make a message worth one extractor call. Everything else never costs AI. */
const CODE_HINT = /\b(codes?|discount\w*|sponsor\w*|promo\w*|coupons?)\b/i;
export const mentionsCode = (text: string): boolean => CODE_HINT.test(text);

/** Note for the normal reply when the customer wants a code but did not say which. The mock brain keys on its start. */
export const ASK_FOR_CODE_NOTE =
  'The customer wants their own discount code for the creator offer but did not say what it should be. Ask them in one short line, in their tone, what they want their code to be (letters and numbers only). Do not say any code is made or live.';

export const HOLDING_CODE_LINE = 'nice one let me get that sorted for you';

// Checked as parts of the code, so a few harmless codes go to the owner too. That is the safe side.
const OFFENSIVE = [
  'FUCK', 'FUK', 'FCK', 'SHIT', 'CUNT', 'COCK', 'DICK', 'PUSSY', 'TWAT', 'WANK', 'BITCH', 'WHORE', 'SLUT', 'BASTARD', 'ARSE', 'ASSHOLE',
  'NIGG', 'NIGA', 'FAGG', 'FAG', 'RETARD', 'SPASTIC', 'PAKI', 'KIKE', 'CHINK', 'TRANNY', 'NAZI', 'HITLER', 'KKK', 'RAPE', 'PORN', 'SEX',
  'NONCE', 'PEDO', 'PAEDO', 'JIHAD', 'COCAINE', 'BOLLOCK', 'PISS', 'TITS', 'BOOB',
];

/** Names of the shop itself, letters and numbers only, upper case. */
export function brandWords(settings: Pick<Settings, 'voice' | 'store'>): string[] {
  const words = new Set<string>(['ACX', 'ACXEBIKE', 'ACXEBIKES']);
  for (const raw of [settings.voice.brand_name, settings.store.name, settings.store.domain.split('.')[0] ?? '']) {
    const w = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (w.length >= 2) { words.add(w); words.add(w.replace(/S$/, '')); }
  }
  return [...words];
}

/** Why a code should not be made without the owner, or null when it is fine. */
export function codeProblem(code: string, brands: string[]): string | null {
  if (OFFENSIVE.some((w) => code.includes(w))) return 'The code may contain a rude or offensive word';
  const letters = code.replace(/[0-9]+/g, '');
  if (!letters) return 'The code is only numbers';
  if (brands.includes(code) || brands.includes(letters)) return 'The code is just the shop name, so it could look like an official shop code';
  return null;
}

export interface CodeFacts {
  settings: DiscountSettings;
  request: DiscountRequest;
  /** Cleaned code, or null when none was named or it is not 3 to 30 letters and numbers. */
  code: string | null;
  /** What codeProblem said. */
  problem: string | null;
  /** A row with this code already exists here. */
  taken_here: boolean;
  /** A code this customer already has (any code that is not a draft), or null. */
  contact_code: string | null;
  /** Codes the agent made by itself today (London day). */
  made_today: number;
}

export type CodePlan =
  | { kind: 'none' }
  | { kind: 'ask_customer'; note: string }
  | { kind: 'create'; code: string }
  | { kind: 'park'; code: string | null; reason: string; draft: boolean };

/** The decision, with no database or network. Every doubt parks the request for the owner. */
export function planCodeRequest(f: CodeFacts): CodePlan {
  const s = f.settings;
  if (s.mode === 'off' || !f.request.wants_code) return { kind: 'none' };
  if (!f.request.code) return { kind: 'ask_customer', note: ASK_FOR_CODE_NOTE };
  if (!f.code) {
    return { kind: 'ask_customer', note: `${ASK_FOR_CODE_NOTE} What they asked for ("${clip(f.request.code, 40)}") cannot be used: a code is 3 to 30 letters or numbers with no spaces or symbols.` };
  }
  const park = (reason: string, draft = true): CodePlan => ({ kind: 'park', code: f.code, reason, draft });
  if (f.request.confidence < MIN_CONFIDENCE) return park('The agent was not sure this is a request for a code');
  if (f.problem) return park(f.problem);
  if (f.contact_code === f.code) return park(`They already have the code ${f.code}`, false);
  if (f.taken_here) return park(`The code ${f.code} is already used for someone else`, false);
  if (f.contact_code && s.one_per_customer) return park(`They already have the code ${f.contact_code} and it is one code per customer`);
  if (s.mode === 'ask') return park('You asked to check codes before they are made');
  if (f.made_today >= s.daily_cap) return park(`The agent already made ${f.made_today} codes today, the daily limit`);
  return { kind: 'create', code: f.code };
}


/** True when a reply says a code is ready. Only the template may say that, after the code exists. */
export function promisesLiveCode(text: string): boolean {
  const re = /\b(code|coupon)\b[^.!?\n]{0,40}?\b(is|are|now|has been|been)\s+(now\s+)?(live|active|ready|working|set up|created|made|sorted)\b/gi;
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index! - 25), m.index!).toLowerCase();
    if (!/\b(once|when|after|as soon as|until|before|if)\b[^.!?]*$/.test(before)) return true;
  }
  return false;
}

/** Settings sanity for PUT /api/settings/discounts. Returns the cleaned patch or throws 400. */
export function checkDiscountPatch(patch: Record<string, unknown>): Partial<DiscountSettings> {
  const out: Partial<DiscountSettings> = {};
  const fail = (field: string, message: string) => new HttpError(400, 'invalid_field', message, { field });
  if (patch.mode !== undefined) {
    if (!['auto', 'ask', 'off'].includes(patch.mode as string)) throw fail('mode', 'Pick Auto, Ask me first or Off.');
    out.mode = patch.mode as DiscountSettings['mode'];
  }
  if (patch.amount !== undefined) {
    const n = Number(patch.amount);
    if (!Number.isFinite(n) || n < 1 || n > 500) throw fail('amount', 'The amount should be between £1 and £500.');
    out.amount = Math.round(n * 100) / 100;
  }
  if (patch.daily_cap !== undefined) {
    const n = Number(patch.daily_cap);
    if (!Number.isInteger(n) || n < 0 || n > 200) throw fail('daily_cap', 'The daily limit should be a whole number from 0 to 200.');
    out.daily_cap = n;
  }
  if (patch.message !== undefined) {
    const m = typeof patch.message === 'string' ? patch.message.trim() : '';
    if (!m || m.length > 1000) throw fail('message', 'Write the message, up to 1000 characters.');
    if (!/\{CODE\}/i.test(m)) throw fail('message', 'Put {CODE} in the message so the customer sees their code.');
    out.message = m;
  }
  if (patch.applies_to !== undefined) {
    const a = typeof patch.applies_to === 'string' ? patch.applies_to.trim() : '';
    if (!a || a.length > 120) throw fail('applies_to', 'Say what the code works on, up to 120 characters.');
    out.applies_to = a;
  }
  if (patch.one_per_customer !== undefined) out.one_per_customer = patch.one_per_customer === true;
  return out;
}

