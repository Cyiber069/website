// Deterministic clean up applied to every message before it can be sent. The model is asked to
// follow the same rules, but nothing leaves without passing through here, so the owner's rules hold
// even when the model slips: no dashes, few commas, no markdown, no stock assistant phrases, short.
import type { Channel, ToneProfile, VoiceSettings } from '../types';

const OPEN = '\uE000';
const CLOSE = '\uE001';

// Things whose inner punctuation must never be touched.
const PROTECT: RegExp[] = [
  /\bhttps?:\/\/[^\s<>()]*[^\s<>().,!?;:'"]/gi, // links
  /\bwww\.[^\s<>()]*[^\s<>().,!?;:'"]/gi,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // emails
  /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|co\.uk|org\.uk|uk|net|org|io|shop|store|bike)(?:\/[^\s<>()]*[^\s<>().,!?;:'"])?/gi, // bare domains
  /\b\d{4}-\d{2}-\d{2}\b/g, // ISO dates
  /(?<![\w-])#?[A-Z0-9]*[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+(?![\w-])/g, // codes with a capital letter: ACX-2000, SKU-A1
  /(?<![\w-])#\d+(?:-\d+)+(?![\w-])/g, // order numbers: #1042-2
  /(?<!\w)\+?\d[\d ().-]{6,}\d(?!\w)/g, // phone numbers (checked for digit count below)
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, // 1,299.00
];

interface Shielded { text: string; tokens: string[] }

function shield(input: string): Shielded {
  const tokens: string[] = [];
  let text = input;
  PROTECT.forEach((re, idx) => {
    text = text.replace(re, (m) => {
      if (m.includes(OPEN) || m.includes(CLOSE)) return m;
      // The phone pattern also matches ranges like "2 - 4" or "10-12": only shield real numbers.
      if (idx === 7 && (m.match(/\d/g) ?? []).length < 8) return m;
      tokens.push(m);
      return `${OPEN}${tokens.length - 1}${CLOSE}`;
    });
  });
  return { text, tokens };
}

function unshield(text: string, tokens: string[]): string {
  return text.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_m, i) => tokens[Number(i)] ?? '');
}

const JOINED: Record<string, string> = {
  'e-bike': 'ebike', 'e-bikes': 'ebikes', 'e-mail': 'email', 'e-mails': 'emails', 'wi-fi': 'wifi', 't-shirt': 'tshirt', 'x-ray': 'xray',
};

// Whole sentences that add nothing and mark the text as machine written.
const DROP_SENTENCE: RegExp[] = [
  /\b(i )?hope (this|that|it) helps\b/i,
  /\bfeel free to (reach out|ask|contact|get in touch|message)\b/i,
  /\b(do not|don'?t) hesitate to\b/i,
  /\blet me know if (you have|there'?s|there is) any(thing)? (other|further|more|else)\b/i,
  /\bis there anything else (i|we) can\b/i,
  /\bi'?m here to help\b/i,
  /\bhappy to (help|assist)( you)?( with (that|this|anything))?[.!]*$/i,
  /\bthank(s| you) for (reaching out|contacting us|getting in touch|your (message|patience|inquiry|enquiry|understanding))\b/i,
  /\bi (completely |totally |fully )?understand (your|how) (frustrat|concern|this (can|must) be)/i,
  /\b(we|i) apologi[sz]e for any inconvenience\b/i,
  /\bas an ai\b/i,
  /\bhave a (great|wonderful|lovely|nice) (day|evening|weekend|one)\b/i,
];

// Openers and filler removed in place.
const STRIP_PHRASE: RegExp[] = [
  /^\s*(certainly|absolutely|of course|great question|excellent question|good news|i'?d be happy to help|i would be happy to help)\s*[!.,:]+\s*/i,
  /^\s*(certainly|absolutely)\s+(?=[a-z])/i,
  /\b(please note that|kindly note that|rest assured( that)?|i'?d be (more than )?happy to (help|assist)( you)?( with (that|this))?[,.!]?)\s*/gi,
  /\bkindly\s+/gi,
];

const OPENERS = 'hey+|hi+|hiya|heya|hello+|yo+|yeah|yea|yep|yup|nah|no|ok|okay|sure|alright|aight|cool|nice|sorry|thanks|thank you|cheers|right|so|well|oh|ah|haha|lol|safe|sound|sweet|perfect|great|morning|evening|afternoon';
const VOCATIVES = 'bro+|bruv|bruh|mate|man|fam|boss|pal|buddy|bud|dude|lad|chief|g|sir|madam';

const EMOJI_G = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;

const splitSentences = (text: string): string[] => text.split(/(?<=[.!?])[ \t]+/).map((s) => s.trim()).filter(Boolean);

function capFirst(s: string): string {
  return s.replace(/^(\s*)(\p{Ll})/u, (_m, sp: string, ch: string) => sp + ch.toUpperCase());
}

export interface StyleContext {
  voice: VoiceSettings;
  tone: ToneProfile;
  channel: Channel;
}

function stripMarkdown(text: string): string {
  let t = text;
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2'); // [text](url)
  t = t.replace(/```[a-z]*\n?/gi, '').replace(/`/g, '');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/(\*\*|__)(?=\S)([^\n]+?)(?<=\S)\1/g, '$2');
  t = t.replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1');
  t = t.replace(/(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])/g, '$1');
  // Bullet and numbered lists become plain sentences.
  const lines = t.split('\n');
  const bullet = /^\s*(?:[-*•·▪◦]|\d{1,2}[.)])\s+/;
  if (lines.some((l) => bullet.test(l))) {
    const out: string[] = [];
    for (const raw of lines) {
      const line = raw.replace(bullet, '').trim();
      if (!line) continue;
      out.push(/[.!?:]$/.test(line) ? line.replace(/:$/, '.') : `${line}.`);
    }
    t = out.join(' ');
  }
  return t;
}

function fixDashes(text: string, casual: boolean): string {
  let t = text;
  // Ranges: 2-4 days, £500–£600.
  t = t.replace(/(\d)\s?[-\u2010-\u2015\u2212]\s?([£$€]?\d)/g, '$1 to $2');
  // Known words that read better joined.
  t = t.replace(/\b(e-bikes?|e-mails?|wi-fi|t-shirt|x-ray)\b/gi, (m) => {
    const joined = JOINED[m.toLowerCase()] ?? m.replace('-', '');
    return m[0] === m[0]!.toUpperCase() ? joined[0]!.toUpperCase() + joined.slice(1) : joined;
  });
  // Dashes used as punctuation: long dashes anywhere, double hyphens, and hyphens with a space on either side.
  // Casual texters just run on. Otherwise a comma reads most naturally where the dash was.
  const asBreak = casual ? ' ' : ', ';
  t = t.replace(/\s*(?:[\u2012-\u2015\u2212]|-{2,})\s*|\s+-\s+|\s+-(?=\S)|(?<=\S)-\s+/g, asBreak);
  // Hyphens inside words: road-legal, 72-volt, plug-and-play.
  t = t.replace(/(?<=[\p{L}\p{N}])-(?=[\p{L}\p{N}])/gu, ' ');
  // Anything left over.
  t = t.replace(/[-\u2010-\u2015\u2212]/g, ' ');
  return t.replace(/([.!?])\s*,\s*/g, '$1 ').replace(/^\s*,\s*/, '');
}

function fixCommas(text: string, mode: VoiceSettings['commas'], casual: boolean): string {
  if (mode === 'normal') return text;
  let t = text;
  if (mode === 'none') return t.replace(/\s*,\s*/g, ' ');
  t = t.replace(new RegExp(`(^|[.!?]\\s+|\\n\\s*)((?:${OPENERS})(?:\\s+[\\p{L}]+)?)\\s*,[ \\t]*`, 'giu'), '$1$2 ');
  t = t.replace(new RegExp(`\\s*,\\s+(${VOCATIVES})\\b`, 'gi'), ' $1');
  t = t.replace(new RegExp(`\\b(${VOCATIVES})\\s*,\\s+`, 'gi'), '$1 ');
  t = t.replace(/\s*,\s+(and|but|so|or|then|because|cos|cuz|which|if|when|though|while|plus|as)\b/gi, ' $1');
  t = t.replace(/\s*,\s*(?=[.!?]|$)/gm, '');
  if (casual) {
    // In casual texting a lone comma is dropped. Two or more in one sentence is a real list and stays.
    t = t.split(/(?<=[.!?\n])/).map((s) => ((s.match(/,/g) ?? []).length === 1 ? s.replace(/\s*,\s*/, ' ') : s)).join('');
  }
  return t;
}

function removeStock(text: string, banned: string[]): string {
  let t = text;
  for (const re of STRIP_PHRASE) t = t.replace(re, '');
  const kept = splitSentences(t.replace(/\n/g, ' \n ')).filter((s) => !DROP_SENTENCE.some((re) => re.test(s)));
  t = kept.join(' ').replace(/ ?\n ?/g, '\n');
  for (const phrase of banned) {
    const p = phrase.trim();
    if (p.length < 2) continue;
    t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])[,!]?\\s*`, 'giu'), '');
  }
  return t;
}

function limitEmoji(text: string, ctx: StyleContext): string {
  const { voice, tone } = ctx;
  const allow = voice.emojis === 'never' ? 0 : voice.emojis === 'mirror' ? (tone.emoji_rate > 0 ? (tone.emoji_rate >= 1.5 ? 2 : 1) : 0) : 1;
  let seen = 0;
  return text.replace(EMOJI_G, (m) => (++seen <= allow ? m : ''));
}

function limitLength(text: string, maxSentences: number, maxChars: number): string {
  let sentences = splitSentences(text);
  if (sentences.length > maxSentences) sentences = sentences.slice(0, maxSentences);
  while (sentences.length > 1 && sentences.join(' ').length > maxChars) sentences.pop();
  let out = sentences.join(' ');
  if (out.length > maxChars) {
    let cut = out.lastIndexOf(' ', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    // Never cut through a shielded token.
    const open = out.lastIndexOf(OPEN, cut);
    const close = out.lastIndexOf(CLOSE, cut);
    if (open > close) cut = open;
    out = out.slice(0, cut).replace(/[\s,;:]+$/, '');
  }
  return out;
}

/** Clean one message. Returns '' when nothing sendable is left. */
export function sanitizeReply(input: string, ctx: StyleContext): string {
  const { voice, tone, channel } = ctx;
  const email = channel === 'gmail';
  const mirror = voice.mirror_level !== 'off';
  const casual = mirror && (tone.register === 'casual' || tone.register === 'hype');

  let t = String(input ?? '').replace(/\r\n?/g, '\n').replace(/[\u200B\uFEFF]/g, '');
  t = t.replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\u2026/g, '...').replace(/\u00A0/g, ' ');
  t = stripMarkdown(t);

  const shielded = shield(t);
  t = shielded.text;

  t = removeStock(t, voice.banned_phrases);
  t = fixDashes(t, casual);
  t = t.replace(/\s*;\s*/g, casual ? ' ' : '. ');
  t = fixCommas(t, voice.commas, casual);

  // One exclamation mark is plenty (two for a customer who is clearly hyped).
  const bangs = tone.register === 'hype' && mirror ? 2 : 1;
  let seenBang = 0;
  t = t.replace(/!+/g, () => (++seenBang <= bangs ? '!' : '.'));
  t = t.replace(/\?{2,}/g, '?');

  // Stretched letters: mirror a notch calmer, or not at all.
  const keep = voice.mirror_level === 'match' ? 3 : voice.mirror_level === 'light' ? 2 : 1;
  t = t.replace(/(\p{L})\1{2,}/giu, (m, ch: string) => (m.length > keep ? ch.repeat(keep) : m));

  t = limitEmoji(t, ctx);

  // Tidy spacing and doubled punctuation left behind by the edits above.
  t = t.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
  t = t.replace(/\s+([,.!?])/g, '$1').replace(/([.!?]){2,}(?!\.)/g, '$1').replace(/\.{4,}/g, '...').replace(/,{2,}/g, ',').replace(/([.!?]),/g, '$1');
  t = t.replace(/^[\s,.;:]+/, '').trim();

  const maxSentences = email ? Math.max(voice.max_sentences * 2, 6) : voice.max_sentences;
  const maxChars = email ? Math.max(voice.max_chars * 3, 700) : voice.max_chars;
  t = email
    ? t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).join('\n\n').slice(0, maxChars * 2)
    : limitLength(t.replace(/\n+/g, ' '), maxSentences, maxChars);
  if (email) t = limitLength(t.replace(/\n\n/g, ' \uE002 '), maxSentences, maxChars).replace(/ ?\uE002 ?/g, '\n\n');

  // Mirror capitalisation and the missing full stop of someone who texts in lower case.
  if (casual && tone.lowercase) {
    t = t.replace(/(^|[.!?]\s+|\n)(\p{Lu})(?=\p{Ll}|\s|'|$)/gu, (m, lead: string, ch: string, offset: number, whole: string) => {
      const rest = whole.slice(offset + lead.length);
      if (/^I(\s|'|$)/.test(rest)) return m; // keep the pronoun
      return lead + ch.toLowerCase();
    });
  } else if (!casual) {
    t = capFirst(t).replace(/([.!?]\s+)(\p{Ll})/gu, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
  }
  if (!email && (casual || tone.punctuation === 'none')) t = t.replace(/(?<!\.)\.$/, '');

  t = unshield(t, shielded.tokens).replace(/[ \t]{2,}/g, ' ').trim();
  return t;
}

/** Clean a whole reply: every part sanitized, empties and repeats dropped, at most three messages. */
export function finalizeParts(parts: string[], ctx: StyleContext): string[] {
  const out: string[] = [];
  for (const raw of parts) {
    const clean = sanitizeReply(raw, ctx);
    if (clean && !out.includes(clean)) out.push(clean);
  }
  if (ctx.channel === 'gmail') return out.length ? [out.join('\n\n')] : [];
  return out.slice(0, 3);
}

/** True when a text still breaks a hard rule. Used by tests and as a last guard before sending. */
export function violations(text: string): string[] {
  const { text: bare } = shield(text);
  const found: string[] = [];
  if (/[\u2010-\u2015\u2212]/.test(bare)) found.push('long dash');
  if (/-/.test(bare)) found.push('hyphen');
  if (/(^|\n)\s*(?:[*•]|\d{1,2}[.)])\s+\S/.test(bare)) found.push('list');
  if (/\*\*|__|`|^#{1,6}\s/m.test(bare)) found.push('markdown');
  return found;
}
