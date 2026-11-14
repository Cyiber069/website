// The owner's writing rules, enforced in code. Every message that can reach a customer goes through
// finalizeParts (or sanitizeReply for a single text) on its way out, whoever wrote it: the model,
// the owner or a template.
//
// This file is the small adapter the rest of the backend uses: it turns "voice settings + how this
// customer writes + channel" into options for the sanitizer in sanitize.ts, where the rules live.
//
// Hard guarantees on everything returned from here:
//   no dashes of any kind outside protected tokens (links, emails, phone and order numbers, product codes, prices)
//   no markdown, bullets or numbered lists, no semicolons
//   at most voice.max_sentences sentences and voice.max_chars characters, in at most 3 chat messages
//   (email: one message, with room for a short letter)
import type { Channel, ToneProfile, VoiceSettings } from '../types';
import { type SanitizeOptions, type SanitizeResult, sanitizeParts, styleViolations } from './sanitize';

export interface StyleContext {
  voice: VoiceSettings;
  tone: ToneProfile;
  channel: Channel;
  /** The customer sincerely asked if they are talking to a bot: keeps the honest one line answer intact. */
  asked_if_bot?: boolean;
  /** Complaint, refund, safety or legal topic: the reply stays plain whatever the customer's style. */
  serious?: boolean;
  /** Emoji the customer used themselves. Only these (and a few safe ones) may be mirrored back. */
  customer_emojis?: string[];
  /** Exact strings that must survive untouched, for example an order name or a SKU from the knowledge base. */
  protect?: string[];
}

/** An email is a short letter, not a text: it gets more room than voice.max_chars and voice.max_sentences allow a chat reply. */
export function lengthLimits(voice: VoiceSettings, channel: Channel): { max_chars: number; max_sentences: number } {
  if (channel !== 'gmail') return { max_chars: voice.max_chars, max_sentences: voice.max_sentences };
  return { max_chars: Math.max(voice.max_chars, 600), max_sentences: Math.max(voice.max_sentences, 6) };
}

function options(ctx: StyleContext): SanitizeOptions {
  const { voice, tone, channel } = ctx;
  return {
    channel, ...lengthLimits(voice, channel), commas: voice.commas, emojis: voice.emojis, mirror_level: voice.mirror_level,
    banned_phrases: voice.banned_phrases, protect: ctx.protect ?? [], asked_if_bot: ctx.asked_if_bot === true, serious: ctx.serious === true,
    tone, customer_emojis: ctx.customer_emojis ?? [],
  };
}

/** Clean a whole reply and say what was done to it (cut for length, blocked for claiming to be human, ...). */
export function sanitizeDetailed(parts: string[], ctx: StyleContext): SanitizeResult {
  return sanitizeParts(parts, options(ctx));
}

/** Clean one message. Returns '' when nothing sendable is left. */
export function sanitizeReply(input: string, ctx: StyleContext): string {
  return sanitizeParts([String(input ?? '')], options(ctx)).parts.join(ctx.channel === 'gmail' ? '\n\n' : ' ');
}

/** Clean a whole reply: every part sanitized, empties and repeats dropped, at most three messages (one for email). */
export function finalizeParts(parts: string[], ctx: StyleContext): string[] {
  const out: string[] = [];
  for (const p of sanitizeParts(parts, options(ctx)).parts) if (p && !out.includes(p)) out.push(p);
  return out;
}

/**
 * Hard rules a text still breaks, [] when it is clean. Used by tests and as a last guard before sending.
 * Works on any final string (line breaks are allowed here, since an email has them).
 */
export function violations(text: string): string[] {
  return styleViolations([text], { channel: 'gmail' }).filter((v) => v !== 'claims_human').map((v) => v.replace(/^part\d+:/, ''));
}
