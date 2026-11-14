// The owner's rules applied in code to whatever the model (or the mock) decided, plus the small
// helpers decide() needs to read a conversation. Pure functions: no database, no network.
import type { DecideInput, HistoryMessage, Settings, ToneProfile } from '../types';
import { claimsHuman, languageName, looksLikeOptOut, renderConversation, unsupportedNumbers, wordsOf, type RawDecision } from './prompt';
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
/** What to say when the customer sent something that cannot be opened. Honest, and it often gets the question typed out. */
export function mediaHoldingLine(kinds: string[], language: string): string {
  if (language !== 'en') return holdingLine(language);
  if (kinds.every((k) => k === 'voice')) return "sorry I can't play voice notes on here. can you type it out for me?";
  return 'let me get someone to take a look at that for you';
}

export const holdingLine = (language: string): string => HOLDING[language] ?? HOLDING.en!;

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

export interface EnforceContext {
  settings: Settings;
  input: DecideInput;
  tone: ToneProfile;
  /** Everything the model was allowed to take facts from. */
  sources: string;
  /** Emoji the customer used, from the tone analysis. */
  customerEmojis?: string[];
}

/** Complaints, refunds, safety and the law: the reply stays plain whatever the customer's style. */
export function seriousTopic(history: HistoryMessage[]): boolean {
  return isSeriousTopic(history.filter((m) => m.direction === 'in' && m.kind === 'text').slice(-3).map((m) => m.body).join(' '));
}

/**
 * The owner's rules, applied in code to whatever the model (or the mock) decided. Returns the parts
 * already sanitized. Exported for tests.
 */
export function enforceDecision(d: RawDecision, ctx: EnforceContext): RawDecision {
  const { settings, input, tone } = ctx;
  const voice = settings.voice;
  const out: RawDecision = { ...d, parts: [...d.parts], flags: { ...d.flags }, escalate: d.escalate ? { ...d.escalate } : null };
  const pending = pendingInbound(input.history);
  const lastText = [...pending].reverse().find(hasWords)?.body ?? '';
  const escalate = (reason: string, category: string, question?: string) => {
    out.action = 'escalate';
    out.escalate = { question: question ?? out.escalate?.question ?? (lastText.slice(0, 1000) || 'The customer needs an answer from you'), reason, category };
  };

  // Opt out is too important to leave to the model alone.
  if (pending.some((m) => m.kind === 'text' && looksLikeOptOut(m.body))) out.flags.opt_out = true;

  // "Are you a bot" when the owner wants to handle that personally.
  if (out.flags.asked_if_bot && voice.bot_question_policy === 'escalate' && out.action !== 'escalate') {
    escalate('The customer asked whether they are talking to a bot', 'bot_question');
    out.parts = [];
  }

  // Never claim to be human, whatever the model wrote.
  if (out.parts.some(claimsHuman)) {
    out.parts = out.parts.filter((p) => !claimsHuman(p));
    out.note = `${out.note} (removed a line that claimed to be human)`.trim();
    if (!out.parts.length && out.action === 'reply') {
      if (out.flags.asked_if_bot && voice.bot_question_policy === 'honest_short' && tone.language === 'en') {
        out.parts = [`yeah this is the ${voice.brand_name} AI assistant`, 'the team can jump in whenever you want a person'];
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
  };
  const clean = sanitizeDetailed(out.parts, style);
  out.parts = [...new Set(clean.parts)];
  // The sanitizer has its own, wider check for text that claims a person is typing. It never rewrites
  // such text, it only reports it, so it must not be sent.
  if (clean.flags.blocked && out.parts.length) {
    out.parts = [];
    out.flags.needs_human = true;
    out.note = `${out.note} (draft withheld: ${clean.flags.blocked.replace(/_/g, ' ')})`.trim();
    if (out.action === 'reply') escalate('The draft claimed to be a person, which is not allowed', 'bot_question');
  }
  if (clean.flags.regen.length) out.note = `${out.note} (reads machine written: ${clean.flags.regen.join(', ').replace(/_/g, ' ')})`.trim();
  if (out.action === 'reply' && out.parts.length === 0) {
    out.flags.needs_human = true;
    escalate('The draft was empty after the style rules were applied', 'other');
  }
  return out;
}
