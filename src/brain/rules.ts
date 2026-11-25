// The owner's rules applied in code to whatever the model (or the mock) decided, plus the small
// helpers decide() needs to read a conversation. Pure functions: no database, no network.
import type { DecideInput, HistoryMessage, Settings, ToneProfile } from '../types';
import {
  admitsAssistant, claimsHuman, languageName, looksLikeBotQuestion, looksLikeOptOut, renderConversation, unsupportedNumbers, wordsOf, type RawDecision,
} from './prompt';
import { sanitizeDetailed, type StyleContext } from './style';
import { isSeriousTopic } from './tone';

// Fallback lines for when the model's own wording cannot be used. Written properly, with a capital
// at the start. The sanitizer still takes care of the final full stop.
const HOLDING: Record<string, string> = {
  en: 'Let me check that for you',
  es: 'Déjame comprobarlo y te digo',
  fr: 'Je vérifie ça et je reviens vers vous',
  de: 'Ich kläre das kurz und melde mich',
  it: 'Controllo e ti faccio sapere',
  nl: 'Ik zoek het even voor je uit',
  pt: 'Vou verificar e já te digo',
  pl: 'Sprawdzę to i dam znać',
};
export const holdingLine = (language: string): string => HOLDING[language] ?? HOLDING.en!;

/** What to say when the customer sent something that cannot be opened. Honest, and it often gets the question typed out. */
export function mediaHoldingLine(kinds: string[], language: string): string {
  if (language !== 'en') return holdingLine(language);
  if (kinds.every((k) => k === 'voice')) return "Sorry, I can't play voice notes on here. Can you type it out for me?";
  return 'Let me get someone to take a look at that for you';
}

/** Notes for the prompt from the tone analysis. The reply language follows the customer here. */
export function promptToneNotes(notes: string[], tone: ToneProfile): string[] {
  const out = notes.filter((n) => !/^customer wrote in /.test(n));
  if (tone.language !== 'en') out.unshift(`the customer writes in ${languageName(tone.language)}: reply in ${languageName(tone.language)}, short plain sentences`);
  return out;
}

/** The customer messages that have not been answered yet: everything after the last message we sent. */
export function pendingInbound(history: HistoryMessage[]): HistoryMessage[] {
  let i = history.length;
  while (i > 0 && history[i - 1]!.direction === 'in') i--;
  return history.slice(i);
}

export const hasWords = (m: HistoryMessage): boolean => /[\p{L}\p{N}]{2,}/u.test(wordsOf(m));

// Words that mean the customer is shopping: choosing, pricing or about to buy a kit, bundle, battery or extra.
const SHOPPING = /\b(?:buy|buying|purchase|order(?:ing)? (?:one|it|a|the)|how much|price|prices|cost|costs|cheap|cheapest|budget|afford|recommend|which (?:kit|bundle|battery|one)|best (?:kit|bundle|battery|one)|what (?:kit|bundle|battery|should i)|kit|kits|bundle|bundles|battery|batteries|conversion|convert|motor|watt|watts|\d{3,4}\s?w|\d{2}\s?v|mph|fast|faster|speed|power|range|road legal|off ?road|wheel size|\d{2}(?:\.5)? ?(?:inch|in|")|mountain bike|mtb|link|in stock|klarna|finance|instalments?)\b|\u00a3\s?\d/i;
// Someone with a problem is not shopping, even when they name a product.
const SUPPORT = /\b(?:refund|return|broken|faulty|not working|stopped working|doesn'?t work|won'?t (?:turn on|charge|work)|where(?:'s| is) my|tracking|late|still (?:no|not|waiting)|complain|complaint|damaged|wrong item|error code)\b/i;

/** The customer is choosing or buying something (and is not reporting a problem). */
export function isShopping(input: Pick<DecideInput, 'history' | 'subject'>): boolean {
  const recent = input.history.filter((m) => m.direction === 'in' && hasWords(m)).slice(-3).map((m) => wordsOf(m)).join(' ');
  const text = `${input.subject ?? ''} ${recent}`.replace(/\u2019/g, "'");
  return SHOPPING.test(text) && !SUPPORT.test(text);
}

/**
 * What to search the knowledge base for: the subject and the customer's last few messages. When the
 * customer is shopping, product words are added so the product entries (price and link) are found.
 */
export function knowledgeQuery(input: DecideInput): string {
  const recent = input.history.filter((m) => m.direction === 'in' && hasWords(m)).slice(-3).map((m) => wordsOf(m).slice(0, 600));
  const base = [input.subject ?? '', ...recent].join('\n').trim();
  return isShopping(input) ? `${base}\nbundle kit battery price` : base;
}

// ---- never sound unsure ---------------------------------------------------------------------------

// A customer must never read that the shop does not know. Apostrophes are optional, case is ignored.
const UNSURE = /\b(?:not (?:so |too |really |100% |entirely |totally |quite )?sure|unsure|(?:i |we )?(?:don'?t|do not|dunno|didn'?t) know|dunno|no idea|(?:can'?t|cannot|can not) say|not certain|uncertain|(?:i'?m|i am|we'?re|we are) not able to|(?:i |we )?(?:can'?t|cannot|can not) help|(?:i'?m|i am|we'?re|we are) unable|beyond my|(?:i |we )?(?:don'?t|do not) have (?:any |that |the |enough |much )?(?:info|information|details)|(?:don'?t|do not) have information)\b/i;

export const soundsUnsure = (text: string): boolean => UNSURE.test(text.replace(/[\u2018\u2019\u02bc]/g, "'"));

const CONFIDENT_HOLDING = ['Let me check that for you', 'Let me find out and come back to you', "Leave it with me, I'll check that now"];

/** A confident holding line, varied a little per conversation. Plain and calm for an upset customer. */
export function confidentHoldingLine(tone: ToneProfile, seed: string): string {
  if (tone.language !== 'en') return holdingLine(tone.language);
  if (tone.mood === 'angry' || tone.mood === 'frustrated' || tone.register === 'formal') return 'Let me find out and come back to you';
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return CONFIDENT_HOLDING[h % CONFIDENT_HOLDING.length]!;
}

// ---- links ----------------------------------------------------------------------------------------

const URL_RE = /\bhttps?:\/\/[^\s<>"']+|\b(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|co\.uk|uk|shop|store|me)\/[^\s<>"']*/gi;
const bareUrl = (u: string): string => u.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[.,!?)\]]+$/, '').replace(/\/+$/, '');

/** Links in a text, without the protocol, www and trailing punctuation. */
export function linksIn(text: string): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map(bareUrl).filter((u) => u.includes('/') || u.includes('.')))];
}

/** Links in `text` that appear nowhere in `sources`. A link the model made up is never sent. */
export function inventedLinks(text: string, sources: string): string[] {
  const known = new Set(linksIn(sources));
  return linksIn(text).filter((u) => !known.has(u));
}

/** The first product page link in a text, as written, for the follow up and the Sales screen. */
export function productLink(text: string): string | null {
  const m = /\bhttps?:\/\/[^\s<>"']+\/products\/[^\s<>"']+/i.exec(text);
  return m ? m[0].replace(/[.,!?)\]]+$/, '') : null;
}

/**
 * The honest answer to "are you a bot", for when the model's own wording cannot be used. One short
 * line in the customer's register plus the offer of a person (voice report, section G.3).
 */
export function botLines(tone: ToneProfile, settings: Settings): string[] {
  const brand = settings.voice.brand_name || settings.store.name;
  if (tone.mood === 'angry' || tone.mood === 'frustrated') return [`Yes, this is ${brand}'s AI assistant`, "I've asked the team to take over this chat now"];
  if (tone.register === 'formal') return [`This is the ${settings.store.name} AI assistant. A member of the team can take over whenever you prefer.`];
  if (tone.register === 'neutral') return [`This is ${brand}'s AI assistant`, "The team can take over any time if you'd rather talk to a person. What can I help with?"];
  return [`This is the ${brand} AI assistant`, 'The team can jump in whenever you want a person'];
}

/**
 * Hyphenated codes that appear in what the model was shown (a lower case SKU, a part number). The
 * sanitizer keeps these exact strings intact. Plain compounds such as "26-inch" are not codes.
 */
export function protectedCodes(sources: string, parts: string[]): string[] {
  const text = parts.join('\n').toLowerCase();
  if (!text.includes('-')) return [];
  const found = new Set<string>();
  for (const m of sources.match(/(?<![\w-])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+(?![\w-])/g) ?? []) {
    if (m.length > 40 || !m.split('-').some((seg) => /[A-Za-z]/.test(seg) && /\d/.test(seg))) continue;
    if (text.includes(m.toLowerCase())) found.add(m);
    if (found.size >= 30) break;
  }
  return [...found];
}

export interface EnforceContext {
  settings: Settings;
  input: DecideInput;
  tone: ToneProfile;
  /** Everything the model was allowed to take facts from. */
  sources: string;
  /** Today's exchange rates from pounds (src/brain/currency.ts): a converted price of a real £ figure is not invented. */
  fxRates?: Record<string, number> | null;
  /** Emoji the customer used, from the tone analysis. */
  customerEmojis?: string[];
  /**
   * false on the first pass with a real model: problems the model could fix itself are returned in
   * `retry` and the reply is left for one regeneration. true (the default): fix or escalate now.
   */
  final?: boolean;
}

/** A checked decision. `retry` lists, in plain words, what one regeneration should fix (empty on the final pass). */
export type Enforced = RawDecision & { retry: string[] };

// What to tell the model for each thing the sanitizer flags but cannot repair.
export const REGEN_HINTS: Record<string, string> = {
  not_just_x_but_y: 'drop the "not just X, it is Y" sentence and state the fact',
  ai_vocabulary: 'use plain shop words',
  address_term_not_mirrored: 'do not call the customer bro or mate, they did not',
  marked_slang: 'no dialect slang',
  laughing_at_upset_customer: 'no haha or lol, the customer is upset',
};

/** Complaints, refunds, safety and the law: the reply stays plain whatever the customer's style. */
export function seriousTopic(history: HistoryMessage[]): boolean {
  return isSeriousTopic(history.filter((m) => m.direction === 'in' && m.kind === 'text').slice(-3).map((m) => m.body).join(' '));
}

/**
 * The owner's rules, applied in code to whatever the model (or the mock) decided. Returns the parts
 * already sanitized. Exported for tests.
 */
export function enforceDecision(d: RawDecision, ctx: EnforceContext): Enforced {
  const { settings, input, tone } = ctx;
  const voice = settings.voice;
  const final = ctx.final !== false;
  const out: Enforced = { ...d, parts: [...d.parts], flags: { ...d.flags }, escalate: d.escalate ? { ...d.escalate } : null, retry: [] };
  const pending = pendingInbound(input.history);
  const lastText = [...pending].reverse().find(hasWords)?.body ?? '';
  const escalate = (reason: string, category: string, question?: string) => {
    out.action = 'escalate';
    out.escalate = { question: question ?? out.escalate?.question ?? (lastText.slice(0, 1000) || 'The customer needs an answer from you'), reason, category };
  };

  // The fixed honest answer. An upset customer who asks for a person gets one: the line goes out and the owner is called.
  const useBotLines = () => {
    out.parts = botLines(tone, settings);
    if (tone.mood === 'angry' || tone.mood === 'frustrated') {
      out.parts = [out.parts.join('. ')];
      out.flags.needs_human = true;
      escalate('The customer is upset and asked for a person', 'human_request');
    }
  };

  // Opt out is too important to leave to the model alone (guard G3). One line back, nothing more.
  if (pending.some((m) => m.kind === 'text' && looksLikeOptOut(m.body))) {
    out.flags.opt_out = true;
    if (out.action === 'reply') out.parts = out.parts.slice(0, 1);
  }

  // "Are you a bot" (guard G2): spotted in code as well, so an honest answer never depends on the model noticing.
  if (pending.some((m) => m.kind === 'text' && looksLikeBotQuestion(m.body))) out.flags.asked_if_bot = true;
  if (out.flags.asked_if_bot && voice.bot_question_policy === 'escalate' && out.action !== 'escalate') {
    escalate('The customer asked whether they are talking to a bot', 'bot_question');
    out.parts = [];
  }
  if (out.flags.asked_if_bot && voice.bot_question_policy === 'honest_short' && out.action === 'reply' && !admitsAssistant(out.parts.join(' '))) {
    if (!final) out.retry.push(`the customer asked if this is a bot: say honestly in one short line that this is the ${voice.brand_name} AI assistant and that the team can step in, then carry on`);
    else if (tone.language === 'en') useBotLines();
    else { out.flags.needs_human = true; escalate('The customer asked whether they are talking to a bot', 'bot_question'); out.parts = []; }
  }

  // Never claim to be human, whatever the model wrote.
  if (out.parts.some(claimsHuman)) {
    out.parts = out.parts.filter((p) => !claimsHuman(p));
    out.note = `${out.note} (removed a line that claimed to be human)`.trim();
    if (!out.parts.length && out.action === 'reply') {
      if (!final) {
        out.retry.push('never say or imply that a person is typing, and never deny being automated');
      } else if (out.flags.asked_if_bot && voice.bot_question_policy === 'honest_short' && tone.language === 'en') {
        useBotLines();
      } else {
        out.flags.needs_human = true;
        escalate('The draft claimed to be a person, which is not allowed', 'bot_question');
      }
    }
  }

  // Never say that sponsors or creators get discount codes (owner rule). The sentence is taken out on
  // the last pass, and the model is asked to rewrite on the first.
  // A creator asking for their own code or to be sponsored is the code flow: the agent may talk about their code then.
  const creatorAsked = /\b(sponsor|creator|affiliate|influencer|ambassador|my (own )?code|code for my|partner(ship)?)\b/i.test(lastText);
  if (!creatorAsked && out.action !== 'ignore' && out.parts.some((x) => sponsorCodeClaim(x))) {
    if (!final) out.retry.push('never say that sponsors, riders or creators get discount codes, and never mention a sponsorship offer');
    out.parts = out.parts.map(withoutSponsorCodeClaim).filter((x) => x.trim());
    out.note = `${out.note} (removed a line saying sponsors get discount codes)`.trim();
    if (!out.parts.length && out.action === 'reply' && final) escalate('The draft said sponsors get discount codes, which the owner does not allow', 'discount_price');
  }

  // Never promise a refund or a return (owner rule): the sentence comes out and the chat goes to the owner.
  if (out.action !== 'ignore' && out.parts.some((x) => promisesRefund(x))) {
    if (!final) out.retry.push('never promise a refund, a return or a replacement: say you are passing it to the team');
    out.parts = out.parts.map(withoutRefundPromise).filter((x) => x.trim());
    out.note = `${out.note} (removed a line that promised a refund or a return)`.trim();
    if (final && out.action === 'reply') escalate('The draft promised a refund or a return, which only the owner may do', 'refund_return');
  }

  // Never sound unsure (owner rule). A reply that says "not sure" or "no idea" becomes a question for
  // the owner with a confident holding line, and the answer is learned through the Urgent flow.
  if (out.action === 'reply' && out.parts.some(soundsUnsure)) {
    out.note = `${out.note} (the draft said it was not sure, so it went to the owner)`.trim();
    out.action = 'escalate';
    out.confidence = Math.max(out.confidence, 0.9);
    out.escalate = {
      question: out.escalate?.question || lastText.slice(0, 1000) || 'The customer needs an answer from you',
      reason: 'The agent did not know this one. Your answer is saved so it knows next time.',
      category: out.escalate?.category && out.escalate.category !== 'low_confidence' ? out.escalate.category : 'unknown_fact',
    };
    out.parts = [confidentHoldingLine(tone, lastText)];
  }

  // Links come from the knowledge or the chat only. A made up link is parked for the owner like a made up figure.
  if (out.action === 'reply') {
    const madeUp = inventedLinks(out.parts.join(' '), ctx.sources);
    if (madeUp.length) {
      out.flags.needs_human = true;
      out.confidence = Math.min(out.confidence, 0.3);
      out.note = `${out.note} (link not found in the knowledge: ${madeUp.slice(0, 3).join(', ')})`.trim();
      out.escalate = {
        question: lastText.slice(0, 1000) || 'Please check this draft', category: 'low_confidence',
        reason: `The draft has a link that is not in the knowledge (${madeUp.slice(0, 3).join(', ')}). Check it before it goes out.`,
      };
    }
  }

  // Never invent facts: a figure that appears in the reply but nowhere in the knowledge, the notes or
  // the conversation was made up. The draft is kept for the owner to check instead of being sent.
  if (out.action === 'reply') {
    const invented = withoutConversions(unsupportedNumbers(out.parts.join(' '), ctx.sources), out.parts.join(' '), ctx.sources, ctx.fxRates);
    if (invented.length) {
      out.flags.needs_human = true;
      out.confidence = Math.min(out.confidence, 0.3);
      out.note = `${out.note} (figures not found in the knowledge: ${invented.slice(0, 5).join(', ')})`.trim();
      // The action stays "reply" so the pipeline parks the draft for the owner, with this as the reason on the card.
      out.escalate = {
        question: lastText.slice(0, 1000) || 'Please check this draft', category: 'low_confidence',
        reason: `The draft contains a figure that is not in the knowledge (${invented.slice(0, 5).join(', ')}). Check it before it goes out.`,
      };
    }
  }

  if (out.action === 'escalate') {
    // parts is the holding line, or the part of the answer the knowledge covers followed by the holding line.
    const list = out.parts.filter((p) => p.trim());
    let line = list.length ? list[list.length - 1]! : '';
    let known = list.length > 1 ? list[0]! : '';
    // A holding line may not smuggle in an answer. Anything long or with figures is replaced.
    if (line && (line.length > 140 || unsupportedNumbers(line, renderConversation(input.history, input.now)).length > 0)) line = holdingLine(tone.language);
    // Nor may it sound unsure.
    if (line && soundsUnsure(line)) line = confidentHoldingLine(tone, lastText);
    // The known part must pass every check a reply passes: figures and links from the knowledge, sure of itself.
    if (known && (out.confidence < 0.7 || soundsUnsure(known) || claimsHuman(known)
      || withoutConversions(unsupportedNumbers(known, ctx.sources), known, ctx.sources, ctx.fxRates).length > 0 || inventedLinks(known, ctx.sources).length > 0)) known = '';
    out.parts = [known, line].filter(Boolean);
    if (!voice.holding_reply) out.parts = [];
  }
  if (out.action === 'ignore') out.parts = [];

  const style: StyleContext = {
    voice, tone, channel: input.channel, asked_if_bot: out.flags.asked_if_bot, serious: seriousTopic(input.history), customer_emojis: ctx.customerEmojis,
    protect: protectedCodes(ctx.sources, out.parts),
  };
  const hadText = out.parts.some((p) => p.trim());
  const clean = sanitizeDetailed(out.parts, style);
  out.parts = [...new Set(clean.parts)];
  if (!final && out.action === 'reply') {
    for (const flag of clean.flags.regen) out.retry.push(REGEN_HINTS[flag] ?? flag.replace(/_/g, ' '));
    if (clean.flags.overflow && clean.flags.dropped.length) out.retry.push(`too long, this had to be cut: "${clean.flags.dropped.join(' ').slice(0, 300)}"`);
    if (clean.flags.blocked) out.retry.push('never say or imply that a person is typing, and never deny being automated');
    if (hadText && !out.parts.length) out.retry.push('the whole reply was stock phrases with no content: answer the question itself');
  }
  // The sanitizer has its own, wider check for text that claims a person is typing. It never rewrites
  // such text, it only reports it, so it must not be sent.
  // The same goes for a broken hard rule, which should be impossible and is treated as a bug: never queue it.
  const withheld = clean.flags.blocked ?? (clean.violations.length ? `style check failed: ${clean.violations.join(', ')}` : null);
  if (withheld && out.parts.length) {
    out.parts = [];
    out.flags.needs_human = true;
    out.note = `${out.note} (draft withheld: ${withheld.replace(/_/g, ' ')})`.trim();
    if (out.action === 'reply') escalate(clean.flags.blocked ? 'The draft claimed to be a person, which is not allowed' : 'The draft broke a writing rule that code could not repair', clean.flags.blocked ? 'bot_question' : 'other');
  }
  if (clean.flags.regen.length) out.note = `${out.note} (reads machine written: ${clean.flags.regen.join(', ').replace(/_/g, ' ')})`.trim();
  if (out.action === 'reply' && out.parts.length === 0) {
    out.flags.needs_human = true;
    escalate('The draft was empty after the style rules were applied', 'other');
  }
  out.sales = checkSales(out, tone);
  return out;
}

/** The sales read, kept honest: an upset customer or a complaint is never a lead, and a reply with a product link is at least interested. */
function checkSales(d: RawDecision, tone: ToneProfile): RawDecision['sales'] {
  const read = d.sales ?? null;
  const upset = tone.mood === 'angry' || tone.mood === 'frustrated';
  const complaint = d.action === 'escalate' && ['complaint', 'refund_return', 'order_status', 'technical_fault', 'safety', 'legal', 'product_support'].includes(d.escalate?.category ?? '');
  if (upset || (complaint && read?.stage !== 'ready')) return { stage: 'support', product: read?.product ?? null };
  if (!read) return null;
  if (read.stage === 'browsing' && productLink(d.parts.join(' '))) return { ...read, stage: 'interested' };
  return read;
}


// "Codes are only for our sponsored riders", "creators get a discount code" and the like.
const SPONSOR = String.raw`(?:sponsor(?:ed|s|ship)?|creators?|riders?|affiliates?|influencers?|ambassadors?)`;
const CODE = String.raw`(?:discount|promo|coupon|creator|affiliate)?\s*codes?|discounts?|% off|£\d+ off`;
const SPONSOR_CODE = new RegExp(String.raw`\b${SPONSOR}\b[^.!?\n]{0,60}\b(?:${CODE})|\b(?:${CODE})\b[^.!?\n]{0,60}\b${SPONSOR}\b`, 'i');
export const sponsorCodeClaim = (text: string): boolean => SPONSOR_CODE.test(text);
export function withoutSponsorCodeClaim(text: string): string {
  return text.split(/(?<=[.!?])\s+/).filter((x) => !sponsorCodeClaim(x)).join(' ').trim();
}


/**
 * Numbers that are only a currency conversion of a £ price in the same reply which the sources do hold
 * ("£719 (about €856)"): not invented. Within 2% of the price times today's rate for any currency.
 */
export function withoutConversions(invented: string[], text: string, sources: string, rates?: Record<string, number> | null): string[] {
  if (!invented.length || !rates) return invented;
  const pounds = [...text.matchAll(/£\s?(\d[\d,]*(?:\.\d+)?)/g)].map((m) => m[1]!.replace(/,/g, '')).filter((n) => new RegExp(`£\\s?${n.replace('.', '\\.')}\\b`).test(sources.replace(/,(?=\d{3})/g, '')));
  if (!pounds.length) return invented;
  const values = pounds.flatMap((p) => Object.values(rates).filter((r) => typeof r === 'number' && r > 0).map((r) => Number(p) * r));
  return invented.filter((n) => { const v = Number(n); return !(v > 0 && values.some((x) => Math.abs(v - x) <= x * 0.02 + 1)); });
}


// "We'll refund you", "your refund has been approved", "yes, you can return it" and the like.
const REFUND_PROMISE = /\b(?:we(?:'ll| will| can| have)|i(?:'ll| will| can| have)|you(?:'ll| will))\s+(?:\w+\s+){0,3}?(?:refund|issue (?:a|your) refund|get (?:a|your)(?: full)? refund|receive (?:a|your)(?: full)? refund|accept (?:the|your) return|take (?:it|them|the \w+) back|send (?:you )?a replacement|replace (?:it|them))\b|\byour (?:refund|return) (?:is|has been|will be|was)\b|\b(?:refund|return) (?:is|has been) (?:approved|accepted|confirmed|processed|sorted)\b|\byes,? you can (?:return|get a refund|send it back)\b/i;
export const promisesRefund = (text: string): boolean => REFUND_PROMISE.test(text.replace(/[’‘]/g, "'"));
export function withoutRefundPromise(text: string): string {
  return text.split(/(?<=[.!?])\s+/).filter((x) => !promisesRefund(x)).join(' ').trim();
}
