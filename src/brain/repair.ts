// Style problems fixed in code, so the one rewrite call (decide.ts) runs less often. The sanitizer
// (sanitize.ts) only reports these; a rewrite costs a second model call. What is safe to fix without
// changing any fact is fixed here:
//   an address term the customer never used ("bro", "mate")   dropped
//   laughing at an upset customer ("haha", "lol")             dropped
//   AI sounding words ("seamless", "leverage")                 swapped for plain ones
//   no honest answer to "are you a bot"                         the fixed honest line goes first
// Anything else (a "not just X, it's Y" sentence, dialect slang, text that had to be cut, stock phrases
// only, a claim to be human) still needs the model: repairStyle returns null and the rewrite runs.
import type { Settings, ToneProfile } from '../types';
import type { RawDecision } from './prompt';
import { REGEN_HINTS, botLines } from './rules';
import { CLEAR_ADDR } from './sanitize';

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Plain words for the ones that read machine written. Only swaps that keep the meaning. */
const SWAPS: [RegExp, string][] = [
  [/\bseamless(ly)?\b/gi, 'smooth$1'],
  [/\bleverag(e|es|ed|ing)\b/gi, 'us$1'],
  [/\brobust\b/gi, 'strong'],
  [/\bcrucial\b/gi, 'key'],
  [/\bpivotal\b/gi, 'key'],
  [/\bmeticulous(ly)?\b/gi, 'careful$1'],
  [/\bholistic\b/gi, 'whole'],
  [/\bshowcas(e|es|ed|ing)\b/gi, 'show$1'],
  [/\bembark(s|ed|ing)? on\b/gi, 'start$1'],
  [/\bdelv(e|es|ed|ing) into\b/gi, 'look$1 at'],
  [/\belevat(e|es|ed|ing)\b/gi, 'improv$1'],
  [/\bunderscor(e|es|ed|ing)\b/gi, 'show$1'],
  [/\bfoster(s|ed|ing)?\b/gi, 'build$1'],
  [/\bwhen it comes to\b/gi, 'for'],
];
// Endings that need fixing after a stem swap ("us" + "e" -> "use", "show" + "e" -> "show").
const TIDY: [RegExp, string][] = [[/\bshowe\b/gi, 'show'], [/\bshowes\b/gi, 'shows'], [/\blooke\b/gi, 'look'], [/\blookes\b/gi, 'looks'], [/\bbuilded\b/gi, 'built']];

const matchCase = (from: string, to: string): string => (from[0] && from[0] === from[0].toUpperCase() ? to.charAt(0).toUpperCase() + to.slice(1) : to);

function plainWords(text: string): string {
  let t = text;
  for (const [re, to] of SWAPS) t = t.replace(re, (m: string, g1?: unknown) => matchCase(m, to.replace('$1', typeof g1 === 'string' ? g1 : '')));
  for (const [re, to] of TIDY) t = t.replace(re, (m) => matchCase(m, to));
  return t;
}

function dropAddress(text: string, used: Set<string>): string {
  let t = text;
  for (const a of CLEAR_ADDR) {
    if (used.has(a)) continue;
    const term = a === 'bro' ? 'broo*' : esc(a);
    t = t.replace(new RegExp(`^\\s*${term}[,!]?\\s+`, 'iu'), '')
      .replace(new RegExp(`,?\\s+${term}(?=[\\s,.!?]|$)`, 'giu'), '');
  }
  return t;
}

const dropLaughs = (text: string): string => text.replace(/(?<![\p{L}])(?:haha+|lol|lmao)(?![\p{L}])[,!.]?\s*/giu, '').replace(/\s{2,}/g, ' ').trim();

export interface RepairContext {
  tone: ToneProfile;
  settings: Settings;
}

/**
 * The same decision with the fixable style problems fixed, or null when something only a rewrite can
 * fix is left. `retry` is what the first pass of enforceDecision asked the rewrite to fix.
 */
export function repairStyle(d: RawDecision, retry: string[], ctx: RepairContext): RawDecision | null {
  if (!retry.length || d.action !== 'reply') return null;
  const fixable = new Map<string, (parts: string[]) => string[]>([
    [REGEN_HINTS.address_term_not_mirrored!, (p) => { const used = new Set(ctx.tone.address_terms.map((a) => a.toLowerCase())); return p.map((x) => dropAddress(x, used)); }],
    [REGEN_HINTS.laughing_at_upset_customer!, (p) => p.map(dropLaughs)],
    [REGEN_HINTS.ai_vocabulary!, (p) => p.map(plainWords)],
  ]);
  let parts = [...d.parts];
  for (const item of retry) {
    const fix = fixable.get(item);
    if (fix) { parts = fix(parts); continue; }
    // No honest answer to "are you a bot": the fixed honest line first, then what the model wrote.
    if (item.startsWith('the customer asked if this is a bot') && ctx.tone.language === 'en') {
      parts = [botLines(ctx.tone, ctx.settings)[0]!, ...parts].slice(0, 3);
      continue;
    }
    return null;
  }
  parts = parts.map((p) => p.trim()).filter(Boolean);
  return parts.length ? { ...d, parts } : null;
}
