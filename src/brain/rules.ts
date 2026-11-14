// The owner's rules applied in code to whatever the model (or the mock) decided, plus the small
// helpers decide() needs to read a conversation. Pure functions: no database, no network.
import type { DecideInput, HistoryMessage, Settings, ToneProfile } from '../types';
import {
  admitsAssistant, claimsHuman, languageName, looksLikeBotQuestion, looksLikeOptOut, renderConversation, unsupportedNumbers, wordsOf, type RawDecision,
} from './prompt';
import { sanitizeDetailed, type StyleContext } from './style';
import { isSeriousTopic } from './tone';

// Fallback lines for when the model's own wording cannot be used. The sanitizer still adapts
// capitals and the final full stop to the customer.
const HOLDING: Record<string, string> = {
  en: 'let me check that for you',
  es: 'déjame comprobarlo y te digo',
  fr: 'je vérifie ça et je reviens vers vous',
  de: 'ich kläre das kurz und melde mich',
  it: 'controllo e ti faccio sapere',
  nl: 'ik zoek het even voor je uit',
  pt: 'vou verificar e já te digo',
  pl: 'sprawdzę to i dam znać',
};
export const holdingLine = (language: string): string => HOLDING[language] ?? HOLDING.en!;

/** What to say when the customer sent something that cannot be opened. Honest, and it often gets the question typed out. */
export function mediaHoldingLine(kinds: string[], language: string): string {
  if (language !== 'en') return holdingLine(language);
  if (kinds.every((k) => k === 'voice')) return "sorry I can't play voice notes on here. can you type it out for me?";
  return 'let me get someone to take a look at that for you';
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

/** What to search the knowledge base for: the subject and the customer's last few messages. */
export function knowledgeQuery(input: DecideInput): string {
  const recent = input.history.filter((m) => m.direction === 'in' && hasWords(m)).slice(-3).map((m) => wordsOf(m).slice(0, 600));
  return [input.subject ?? '', ...recent].join('\n').trim();
}

/**
 * The honest answer to "are you a bot", for when the model's own wording cannot be used. One short
 * line in the customer's register plus the offer of a person (voice report, section G.3).
 */
export function botLines(tone: ToneProfile, settings: Settings): string[] {
  const brand = settings.voice.brand_name || settings.store.name;
  if (tone.mood === 'angry' || tone.mood === 'frustrated') return [`Yes this is ${brand}'s AI assistant`, "I've asked the team to take over this chat now"];
  if (tone.register === 'formal') return [`This is the ${settings.store.name} AI assistant. A member of the team can take over whenever you prefer.`];
  if (tone.register === 'neutral') return [`This is ${brand}'s AI assistant`, "The team can take over any time if you'd rather talk to a person. What can I help with?"];
  return [`this is the ${brand} AI assistant`, 'the team can jump in whenever you want a person'];
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
const REGEN_HINTS: Record<string, string> = {
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

  // Never invent facts: a figure that appears in the reply but nowhere in the knowledge, the notes or
  // the conversation was made up. The draft is kept for the owner to check instead of being sent.
  if (out.action === 'reply') {
    const invented = unsupportedNumbers(out.parts.join(' '), ctx.sources);
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
    const line = out.parts[0] ?? '';
    // A holding line may not smuggle in an answer. Anything long or with figures is replaced.
    if (line && (line.length > 140 || unsupportedNumbers(line, renderConversation(input.history, input.now)).length > 0)) out.parts = [holdingLine(tone.language)];
    if (!voice.holding_reply) out.parts = [];
    out.parts = out.parts.slice(0, 1);
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
  return out;
}
