// Brain helpers for abandoned checkout reminders, plus the connection test.
//   draftRecoveryTemplate  the owner's rough wording -> a short template with variables
//   personalizeRecovery    light rewording so no two reminders are word for word identical
//   testBrain              one tiny real call, for the Connections screen
import type { Env, Settings, ToneProfile } from '../types';
import { getSettings } from '../lib/settings';
import { LlmError, callJson, chooseProvider } from './llm';
import { numbersIn, ownerRules } from './prompt';
import { writingRules } from './static-prompt';
import { finalizeParts, sanitizeReply, type StyleContext } from './style';

export const RECOVERY_VARIABLES = ['{first_name}', '{product}', '{total}', '{checkout_link}', '{shop}'] as const;
const VARIABLE_RE = /\{[a-z_]+\}/g;

// A friendly, unremarkable texting voice for first contact: nothing to mirror yet.
const FIRST_CONTACT: ToneProfile = {
  register: 'casual', mood: 'neutral', greeting: '', address_terms: [], elongation: 0, emoji_rate: 1, lowercase: false,
  punctuation: 'light', avg_chars: 80, language: 'en', slang: [],
};

function recoveryStyle(settings: Settings): StyleContext {
  return { voice: { ...settings.voice, max_sentences: Math.max(settings.voice.max_sentences, 6), max_chars: Math.max(settings.voice.max_chars, 700) }, tone: FIRST_CONTACT, channel: 'whatsapp' };
}

// Other ways people (and models) write the same placeholders.
const ALIASES: Record<string, string> = {
  name: '{first_name}', 'first name': '{first_name}', firstname: '{first_name}', customer: '{first_name}', 'customer name': '{first_name}',
  product: '{product}', products: '{product}', item: '{product}', items: '{product}', basket: '{product}',
  total: '{total}', price: '{total}', amount: '{total}',
  link: '{checkout_link}', url: '{checkout_link}', checkout: '{checkout_link}', 'checkout link': '{checkout_link}', 'checkout url': '{checkout_link}',
  shop: '{shop}', store: '{shop}', 'shop name': '{shop}', 'store name': '{shop}',
};

/** "[name]", "{{ product }}" and "<link>" become {first_name}, {product} and {checkout_link}. Unknown placeholders are removed. */
export function normalizePlaceholders(text: string): string {
  const swap = (whole: string, inner: string): string => {
    const key = inner.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');
    const canonical = `{${key.replace(/ /g, '_')}}`;
    if ((RECOVERY_VARIABLES as readonly string[]).includes(canonical)) return canonical;
    return ALIASES[key] ?? (whole.startsWith('{') ? '' : whole);
  };
  return text
    .replace(/\{\{\s*([a-z_ ]{0,40}?)\s*\}\}/gi, swap)
    .replace(/\[\s*([a-z_ ]{1,40}?)\s*\]/gi, swap)
    .replace(/<\s*([a-z_ ]{1,40}?)\s*>/gi, swap)
    .replace(/\{\s*([a-z_ ]{0,40}?)\s*\}/gi, swap);
}

/** Run a template through the style rules without letting them touch the {variables}. */
export function sanitizeTemplate(textIn: string, style: StyleContext): string {
  const text = normalizePlaceholders(textIn);
  const held: string[] = [];
  // Stand in words made only of letters survive every style rule. They are swapped back afterwards.
  const masked = text.replace(VARIABLE_RE, (v) => {
    if (!(RECOVERY_VARIABLES as readonly string[]).includes(v)) return ' ';
    held.push(v);
    return `ZQVAR${'ABCDEFGHIJKLMNOP'[held.length - 1] ?? 'P'}QZ`;
  });
  const clean = finalizeParts([masked], style).join(' ');
  return clean.replace(/zqvar([a-p])qz/gi, (_m, ch: string) => held['abcdefghijklmnop'.indexOf(ch.toLowerCase())] ?? '').replace(/[ \t]{2,}/g, ' ').trim();
}

const variablesIn = (text: string): string[] => [...new Set(text.match(VARIABLE_RE) ?? [])].sort();
const linksIn = (text: string): string[] => [...new Set(text.match(/https?:\/\/\S+/g) ?? [])].map((u) => u.replace(/[.,!?)]+$/, '')).sort();
const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** The writing rules the brain follows everywhere, plus the owner's own. */
function houseStyle(settings: Settings): string {
  const rules = ownerRules(settings);
  return `${writingRules(settings.store.name, settings.voice.brand_name || settings.store.name)}${rules ? `\n\n${rules}` : ''}`;
}

function templateInstructions(settings: Settings): string {
  return `You help the owner of ${settings.store.name}, a small UK online shop for ebike conversion kits, write the WhatsApp message sent to people who started a checkout and did not finish. It is the first message they get from the shop, so it should read like a quick friendly text from a person at the shop and not like marketing. There is no customer to mirror yet: write casual, warm and plain, with normal capitals.

Two or three short sentences, under 300 characters. No pressure, no made up urgency and no discount unless the owner's wording offers one. Keep every fact and figure the owner gave and add none.

${houseStyle(settings)}`;
}

const DRAFT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { template: { type: 'string', description: 'The message template.' } },
  required: ['template'],
};

/**
 * Turn the owner's rough wording into a short reminder template that uses the variables
 * {first_name} {product} {total} {checkout_link} {shop}. Throws LlmError when no model can be reached.
 */
export async function draftRecoveryTemplate(env: Env, roughIn: string | { rough: string }): Promise<string> {
  const rough = (typeof roughIn === 'string' ? roughIn : roughIn?.rough ?? '').trim().slice(0, 2000);
  if (!rough) return '';
  const settings = await getSettings(env.DB);
  const style = recoveryStyle(settings);
  const res = await callJson<{ template?: unknown }>(env, {
    purpose: 'recovery_draft',
    system: [{ text: templateInstructions(settings), cache: true }],
    user: `<owner_wording>\n${rough}\n</owner_wording>\n\nWrite the template. Use these placeholders exactly where they belong, each at most once, and no others: {first_name} (the customer's first name), {product} (what they left in the basket), {total} (the basket total with currency), {checkout_link} (their link back to the checkout), {shop} (the shop name). Use {first_name} and {product}. Use {checkout_link} unless the owner's wording says not to send a link. The others are optional.`,
    schema: DRAFT_SCHEMA,
    maxTokens: 2000,
    // Deterministic stand in for tests: the owner's words with the usual variables around them.
    mock: () => {
      let t = normalizePlaceholders(rough).replace(/\s+/g, ' ').trim();
      if (!t.includes('{first_name}')) t = `Hey {first_name} ${t}`;
      if (!t.includes('{checkout_link}')) t = `${t} {checkout_link}`;
      return { template: t };
    },
  });
  const template = typeof res.data?.template === 'string' ? res.data.template : '';
  const clean = sanitizeTemplate(template, style);
  if (!clean) throw new LlmError('bad_output', 'The AI did not return a usable template.', true);
  // Figures the owner did not give (a made up discount, say) are not allowed into a template.
  const allowed = new Set(numbersIn(rough));
  if (numbersIn(clean).some((n) => !allowed.has(n))) return sanitizeTemplate(rough, style);
  return clean;
}

export type RecoveryPerson = Partial<Record<'first_name' | 'product' | 'total' | 'checkout_link' | 'shop', string | null>>;

function fill(template: string, person: RecoveryPerson): string {
  return template.replace(VARIABLE_RE, (v) => {
    const value = person[v.slice(1, -1) as keyof RecoveryPerson];
    return typeof value === 'string' && value ? value : v;
  });
}

const GREETINGS = ['Hey', 'Hi', 'Hello', 'Hiya'];

/** Deterministic variation used in mock mode: rotate the greeting word. */
function mockVariant(text: string, i: number): string {
  if (i === 0) return text;
  const m = /^(hey|hi|hello|hiya)\b/i.exec(text);
  if (!m) return `${GREETINGS[i % GREETINGS.length]} ${text}`;
  const word = m[1]!;
  const next = GREETINGS[(GREETINGS.findIndex((g) => g.toLowerCase() === word.toLowerCase()) + i) % GREETINGS.length]!;
  return (word[0] === word[0]!.toUpperCase() ? next : next.toLowerCase()) + text.slice(word.length);
}

const VARIANTS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { variants: { type: 'array', items: { type: 'string' }, description: 'One reworded message per requested variant, in order.' } },
  required: ['variants'],
};

/** A reworded text is only used when it kept every variable, link and figure of the original and stayed about the same size. */
function acceptable(original: string, reworded: string): boolean {
  if (!reworded.trim() || reworded.length > original.length * 1.6 + 40 || reworded.length < original.length * 0.4) return false;
  if (!same(variablesIn(original), variablesIn(reworded)) || !same(linksIn(original), linksIn(reworded))) return false;
  const a = numbersIn(original.replace(/https?:\/\/\S+/g, ' ')).sort();
  const b = numbersIn(reworded.replace(/https?:\/\/\S+/g, ' ')).sort();
  return same(a, b);
}

async function variants(env: Env, text: string, n: number): Promise<string[]> {
  const settings = await getSettings(env.DB);
  const style = recoveryStyle(settings);
  const res = await callJson<{ variants?: unknown }>(env, {
    purpose: 'recovery_personalize',
    system: [{
      text: `${templateInstructions(settings)}\n\nYou are given a message the owner approved. Write slightly different wordings of it so that no two customers get an identical text. Change only small things: the greeting word, word order, a synonym here and there. Keep the meaning, the tone, the length, every figure, every link and every {placeholder} exactly. Do not add or remove information, offers or questions.`,
      cache: true,
    }],
    user: `<approved_message>\n${text}\n</approved_message>\n\nWrite ${n} different variants.`,
    schema: VARIANTS_SCHEMA,
    maxTokens: Math.min(6000, 1500 + n * 250),
    mock: () => ({ variants: Array.from({ length: n }, (_, i) => mockVariant(text, i)) }),
  });
  const list = Array.isArray(res.data?.variants) ? res.data.variants : [];
  return Array.from({ length: n }, (_, i) => {
    const raw = typeof list[i] === 'string' ? (list[i] as string) : '';
    const clean = raw ? sanitizeTemplate(raw, style) : '';
    return clean && acceptable(text, clean) ? clean : text;
  });
}

/**
 * Light rewording so no two reminders are identical. Same facts, one model call for the whole batch.
 * Two call shapes are supported:
 *   personalizeRecovery(env, template, people)  -> one message per person, variables filled in from each person
 *   personalizeRecovery(env, { text, ... })     -> one reworded message (text is already filled in)
 * Never throws: on any failure the template comes back as written.
 */
export async function personalizeRecovery(env: Env, template: string, people: RecoveryPerson[]): Promise<string[]>;
export async function personalizeRecovery(env: Env, input: { text: string; [key: string]: unknown }): Promise<string>;
export async function personalizeRecovery(env: Env, a: string | { text: string; [key: string]: unknown }, people?: RecoveryPerson[]): Promise<string[] | string> {
  if (typeof a !== 'string') {
    const text = String(a?.text ?? '');
    if (!text.trim()) return text;
    try {
      // Ask for a few and pick by the checkout id, so the same checkout always gets the same wording.
      const options = await variants(env, text, 3);
      const key = String(a.checkout_id ?? a.first_name ?? text);
      let h = 0;
      for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
      return options[h % options.length] ?? text;
    } catch (err) {
      console.error('personalizeRecovery failed, using the message as written', err);
      return text;
    }
  }
  const list = people ?? [];
  if (!list.length) return [];
  let texts: string[];
  try {
    texts = await variants(env, a, list.length);
  } catch (err) {
    console.error('personalizeRecovery failed, using the template as written', err);
    texts = list.map(() => a);
  }
  return list.map((person, i) => fill(texts[i] ?? a, person));
}

export interface BrainTestResult { ok: boolean; provider: string; model: string; ms: number; sample: string; error?: string }

/** One small real call to the configured model, so the owner can see the connection works and what it sounds like. */
export async function testBrain(env: Env): Promise<BrainTestResult> {
  const started = Date.now();
  const settings = await getSettings(env.DB, true);
  let provider: string = settings.brain.provider;
  let model = settings.brain.model;
  try {
    const choice = await chooseProvider(env, settings);
    provider = choice.provider;
    model = choice.model;
    const res = await callJson<{ reply?: unknown }>(env, {
      purpose: 'test', choice,
      system: [{ text: `You text customers for ${settings.store.name}, a small UK online shop for ebike conversion kits. Answer with one JSON object.\n\n${houseStyle(settings)}` }],
      user: 'A customer just wrote: "yo is anyone there". Reply with one short friendly line that says you are here and asks what they need. State no facts about products or delivery.',
      schema: { type: 'object', additionalProperties: false, properties: { reply: { type: 'string' } }, required: ['reply'] },
      maxTokens: 1500,
      mock: () => ({ reply: 'Yo, yeah we are here. What do you need?' }),
    });
    // The pretend customer greets with yo and uses no emoji. The sample still starts with a capital, like every reply.
    const tone: ToneProfile = { ...FIRST_CONTACT, punctuation: 'none', greeting: 'yo', emoji_rate: 0 };
    const sample = sanitizeReply(typeof res.data?.reply === 'string' ? res.data.reply : '', { voice: settings.voice, tone, channel: 'whatsapp' });
    if (!sample) return { ok: false, provider, model: res.usage?.model ?? model, ms: Date.now() - started, sample: '', error: 'The model answered but the reply was empty.' };
    return { ok: true, provider, model: res.usage?.model ?? model, ms: Date.now() - started, sample };
  } catch (err) {
    const message = err instanceof LlmError ? err.message : String((err as Error)?.message ?? err).slice(0, 200);
    return { ok: false, provider, model, ms: Date.now() - started, sample: '', error: message };
  }
}
