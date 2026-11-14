// The checkout reminder text: filling in the owner's template and passing it through the same
// style rules as every other message the agent sends.
import type { CheckoutRow, Settings, ToneProfile } from '../types';
import { parseJson } from '../lib/db';
import { finalizeParts, type StyleContext } from '../brain/style';

export const TEMPLATE_VARIABLES = ['{first_name}', '{product}', '{total}', '{checkout_link}', '{shop}'] as const;

/** Plain language help for the Recovery screen. */
export const VARIABLE_NOTES: Record<string, string> = {
  '{first_name}': "The customer's first name. Left out cleanly when Shopify has no name.",
  '{product}': 'What they left in the basket.',
  '{total}': 'The basket total with its currency.',
  '{checkout_link}': 'Their personal link back to the checkout. Only used when "include link" is on.',
  '{shop}': 'Your shop name.',
};

/** Appended to the first message when recovery.opt_out_line is on. */
export const OPT_OUT_LINE = "Reply STOP if you'd rather not hear from us";

/** Shown in run summaries instead of the real link, which works for anyone who has it. */
export const LINK_PLACEHOLDER = '[checkout link]';

/**
 * A friendly, unremarkable texting voice: no slang to mirror, capitals kept, one emoji allowed if
 * the owner put one in the template.
 */
const NEUTRAL_CASUAL: ToneProfile = {
  register: 'casual', mood: 'neutral', greeting: '', address_terms: [], elongation: 0, emoji_rate: 1,
  lowercase: false, punctuation: 'light', avg_chars: 80, language: 'en', slang: [],
};

/**
 * Style rules for a reminder. Same rules as replies (no dashes, no lists, no markdown) but with
 * room for the owner's approved wording plus a link, which a 260 character reply limit would cut.
 */
export function recoveryStyle(settings: Settings): StyleContext {
  return {
    voice: { ...settings.voice, max_sentences: Math.max(settings.voice.max_sentences, 6), max_chars: Math.max(settings.voice.max_chars, 700) },
    tone: NEUTRAL_CASUAL,
    channel: 'whatsapp',
  };
}

/** Names of {variables} in a template that we do not know, for example {name}. */
export function unknownVariables(template: string): string[] {
  const known = new Set<string>(TEMPLATE_VARIABLES);
  return [...new Set(template.match(/\{[^{}\n]{0,40}\}/g) ?? [])].filter((v) => !known.has(v));
}

/** "SAM" and "sam jones" both become "Sam". Mixed case such as "McKay" is left alone. */
export function tidyFirstName(raw: string | null): string {
  const first = (raw ?? '').trim().split(/\s+/)[0] ?? '';
  if (!/^[\p{L}'’]{2,30}$/u.test(first)) return '';
  if (first === first.toUpperCase() || first === first.toLowerCase()) return first[0]!.toUpperCase() + first.slice(1).toLowerCase();
  return first;
}

export function productPhrase(row: Pick<CheckoutRow, 'items'>): string {
  const items = parseJson<{ title?: string; quantity?: number }[]>(row.items, []).filter((i) => i?.title);
  if (!items.length) return 'your items';
  const first = String(items[0]!.title).replace(/\s+/g, ' ').trim().slice(0, 70).trim();
  const others = items.length - 1;
  return others === 0 ? first : `${first} and ${others} other ${others === 1 ? 'item' : 'items'}`;
}

export function totalPhrase(row: Pick<CheckoutRow, 'total' | 'currency'>, fallbackCurrency: string): string {
  const n = Number(row.total);
  if (row.total === null || row.total === '' || !Number.isFinite(n)) return '';
  const currency = (row.currency || fallbackCurrency || 'GBP').toUpperCase();
  let out: string;
  try {
    out = new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(n);
  } catch {
    out = `${n.toFixed(2)} ${currency}`;
  }
  return out.replace(/\.00(?!\d)/, ''); // £499 reads better than £499.00
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;
/** What a sentence looks like when its only job was to introduce the link: "here's your link:", "finish here". */
const DANGLING = /(?::|\b(?:here|at|link|via|using|on|to|from|below|is|visit|tap|click|open|use|follow))\s*[.!]?$/i;

/** Take a variable out of the text without leaving a hole: the sentence goes too if it only existed for it. */
function dropVariable(text: string, variable: string): string {
  if (!text.includes(variable)) return text;
  // Paragraph by paragraph, so the blank lines that separate messages survive.
  return text.split(/\n{2,}/).map((p) => dropFromParagraph(p, variable)).filter(Boolean).join('\n\n');
}

function dropFromParagraph(text: string, variable: string): string {
  if (!text.includes(variable)) return text;
  const kept: string[] = [];
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    if (!sentence.includes(variable)) { kept.push(sentence); continue; }
    const rest = sentence.split(variable).join(' ').replace(/\s+/g, ' ').replace(/\s+([,.!?:])/g, '$1').trim();
    const words = rest.replace(/[^\p{L}\p{N}\s']/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (words.length < 4 || DANGLING.test(rest)) continue;
    kept.push(rest);
  }
  return kept.join(' ');
}

/** "Hey {first_name}, you left" with no name becomes "Hey, you left". */
function dropFirstName(text: string): string {
  let t = text.replace(/[ \t]*\{first_name\}/g, '');
  t = t.replace(/^[\s,.!:;]+/, '');
  return t.replace(/^\p{Ll}/u, (ch) => ch.toUpperCase());
}

export interface RenderOptions {
  include_link: boolean;
  opt_out_line: boolean;
}

export interface Rendered {
  /** One to three WhatsApp messages, already through the style rules. */
  parts: string[];
  /** True when the customer's personal link is in the text. */
  has_link: boolean;
}

/** Fill the variables only. Exposed for the personalise step, which works on text before styling. */
export function fillTemplate(template: string, row: CheckoutRow, settings: Settings, opts: RenderOptions): { text: string; has_link: boolean } {
  let text = template.replace(/\r\n?/g, '\n').trim();
  const link = opts.include_link ? (row.recovery_url ?? '').trim() : '';
  if (!link) text = dropVariable(text, '{checkout_link}');
  const firstName = tidyFirstName(row.first_name);
  if (!firstName) text = dropFirstName(text);
  const total = totalPhrase(row, settings.store.currency);
  if (!total) text = dropVariable(text, '{total}');
  text = text
    .split('{first_name}').join(firstName)
    .split('{product}').join(productPhrase(row))
    .split('{total}').join(total)
    .split('{shop}').join(settings.store.name || settings.voice.brand_name)
    .split('{checkout_link}').join(link);
  // Anything else in braces would reach the customer as raw template text.
  text = text.replace(/\{[^{}\n]{0,40}\}/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1');
  return { text: text.trim(), has_link: Boolean(link) && text.includes(link) };
}

/** Apply the style rules and the opt out line to already filled text. */
export function styleMessage(text: string, link: string | null, settings: Settings, opts: RenderOptions): Rendered {
  const ctx = recoveryStyle(settings);
  // A blank line in the template means "send as a separate message".
  let parts = finalizeParts(text.split(/\n{2,}/), ctx);
  if (link && !parts.some((p) => p.includes(link))) {
    // The cleaner must never damage the link. If it did, send the link untouched as its own message.
    parts = [...parts.map((p) => p.split(link).join('').trim()).filter(Boolean).slice(0, 2), link];
  }
  if (opts.opt_out_line && parts.length) {
    const optOut = finalizeParts([OPT_OUT_LINE], ctx)[0] ?? OPT_OUT_LINE;
    const last = parts.length - 1;
    const body = parts[last]!;
    // After a bare link the line goes in its own message so nothing is glued to the URL.
    if (link && body.endsWith(link)) {
      if (parts.length < 3) parts.push(optOut);
      else parts[last - 1] = `${parts[last - 1]!}${/[.!?]$/.test(parts[last - 1]!) ? '' : '.'} ${optOut}`;
    } else {
      parts[last] = `${body}${/[.!?]$/.test(body) ? '' : '.'} ${optOut}`;
    }
  }
  return { parts, has_link: Boolean(link) && parts.some((p) => p.includes(link!)) };
}

/** The whole job: owner template in, sendable messages out. */
export function renderMessage(template: string, row: CheckoutRow, settings: Settings, opts: RenderOptions): Rendered {
  const filled = fillTemplate(template, row, settings, opts);
  return styleMessage(filled.text, filled.has_link ? row.recovery_url!.trim() : null, settings, opts);
}

/** Tidy the owner's rough wording when the brain is not available to draft a proper version. */
export function basicTemplateCleanup(rough: string): string {
  let t = rough.replace(/\r\n?/g, '\n').trim();
  // Common ways people write placeholders.
  t = t.replace(/\{\{\s*([a-z_ ]+?)\s*\}\}/gi, '{$1}').replace(/\[\s*([a-z_ ]+?)\s*\]/gi, '{$1}').replace(/<\s*([a-z_ ]+?)\s*>/gi, '{$1}');
  const alias: Record<string, string> = {
    name: '{first_name}', 'first name': '{first_name}', firstname: '{first_name}', customer: '{first_name}', 'customer name': '{first_name}',
    product: '{product}', item: '{product}', items: '{product}', products: '{product}', bike: '{product}',
    total: '{total}', price: '{total}', amount: '{total}',
    link: '{checkout_link}', url: '{checkout_link}', 'checkout link': '{checkout_link}', checkout: '{checkout_link}',
    shop: '{shop}', store: '{shop}', 'shop name': '{shop}', 'store name': '{shop}',
  };
  t = t.replace(/\{([^{}\n]{1,40})\}/g, (m, inner: string) => {
    const key = inner.trim().toLowerCase().replace(/_/g, ' ');
    const canonical = `{${key.replace(/ /g, '_')}}`;
    if ((TEMPLATE_VARIABLES as readonly string[]).includes(canonical)) return canonical;
    return alias[key] ?? m;
  });
  // House style: no dashes as punctuation, no doubled spaces or shouting punctuation.
  t = t.replace(/\s*[‒-―]\s*|\s+-{1,2}\s+/g, ', ').replace(/!{2,}/g, '!').replace(/\?{2,}/g, '?');
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}
