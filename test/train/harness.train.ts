// TRAIN_MODE=dump   writes system.txt (instructions and knowledge, as Claude gets them) and requests.json
//                   (one request per chat in scenarios.json) to TRAIN_DIR.
// TRAIN_MODE=check  reads TRAIN_DIR/answers-<TRAIN_MODEL>.json ({ id: decision JSON }) and writes
//                   TRAIN_DIR/final-<TRAIN_MODEL>.json: what the customer would get after the agent's checks.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import type { DecideInput, HistoryMessage } from '../../src/types';
import { DEFAULT_SETTINGS } from '../../src/lib/settings';
import { analyzeTone, mirrorPlan } from '../../src/brain/tone';
import { buildDecidePrompt, renderConversation, type RawDecision } from '../../src/brain/prompt';
import { enforceDecision, promptToneNotes, seriousTopic } from '../../src/brain/rules';
import { lengthLimits } from '../../src/brain/style';
import { currencyNote, playbookPrices, type FxRates } from '../../src/brain/currency';
import { splitSections } from '../../src/kb/chunk';
import { PRODUCT_PICKER_ID, PRODUCT_PICKER_TITLE, buildProductPicker } from '../../src/kb/picker';

const seedDir = new URL('../../seed/knowledge/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, seedDir), 'utf8');
const here = new URL('.', import.meta.url);
const DIR = process.env.TRAIN_DIR || '/tmp/acx-train';
const NOW = Date.parse('2026-11-26T14:00:00Z');
const FX: FxRates = { date: '2026-11-25', fetched_at: NOW, rates: { EUR: 1.19, USD: 1.27, CHF: 1.1 } };

interface Scenario { id: string; channel: 'whatsapp' | 'tiktok' | 'gmail'; phone?: string; name?: string; turns: [string, string][]; notes?: string[]; expect: string }

/** The knowledge as the live agent holds it: store pages, product picker, playbook, owner rules, creator note. */
function knowledge(): string {
  const entry = (id: string, title: string, source: string, content: string) => `<entry id="${id}" title="${title.replace(/"/g, "'")}" source="${source}" updated="2026-11-25">\n${content.trim()}\n</entry>`;
  const out: string[] = [];
  const body = (f: string) => read(f).replace(/^# .*\n+/, '').trim();
  out.push(entry('seed_owner_rules', 'Owner rules and corrections', 'note', body('owner-rules.md')));
  out.push(entry('seed_reply_playbook', 'Reply playbook (from the owner)', 'seed', body('reply-playbook.md')));
  const creator = /const CREATOR_NOTE = `([\s\S]*?)`;/.exec(readFileSync(new URL('../../src/kb/seed.ts', import.meta.url), 'utf8'))?.[1] ?? '';
  out.push(entry('seed_creator_sponsorship', 'Creator sponsorship and discount codes', 'note', creator));
  out.push(entry(PRODUCT_PICKER_ID, PRODUCT_PICKER_TITLE, 'seed', buildProductPicker(read('products.md'))));
  for (const e of JSON.parse(read('index.json')) as { id: string; title: string; file: string; pinned: boolean }[]) {
    if (e.file === 'creator-sponsorship.md') continue;
    const text = read(e.file);
    if (e.pinned) { out.push(entry(`seed_${e.id}`, e.title, 'seed', text)); continue; }
    const { intro, sections } = splitSections(text);
    if (intro) out.push(entry(`seed_${e.id}_notes`, `${e.title}: notes`, 'seed', intro));
    for (const s of sections) out.push(entry(`seed_${e.id}_${s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`, s.title, 'seed', s.content));
  }
  return out.join('\n\n');
}

function build(s: Scenario, stable: string) {
  const history: HistoryMessage[] = s.turns.map(([who, body], i) => ({ direction: who === 'customer' ? 'in' : 'out', author: who === 'customer' ? 'customer' : who === 'owner' ? 'owner' : 'agent', body, kind: 'text', ts: NOW - (s.turns.length - i) * 60_000 } as HistoryMessage));
  // The notes every live request carries (src/pipeline/inbound.ts), the currency table (src/brain/decide.ts), and the scenario's own.
  const notes = [
    'Read the whole conversation above before you write. Reply to what the customer means given everything said earlier in this chat, do not repeat something already answered, and do not answer an older message again.',
    'If the latest message needs no reply, choose action ignore. Examples: counting days or streaks (day 12, day 13) to win a free kit, chain or spam messages, a lone ok, thanks or emoji when the chat is already finished.',
    ...(s.notes ?? []),
  ];
  const fx = currencyNote(s.phone ?? null, FX, playbookPrices(stable));
  if (fx) notes.push(fx);
  const input: DecideInput = { channel: s.channel, contact_name: s.name ?? null, contact_phone: s.phone ?? null, subject: null, history, context_notes: notes, now: NOW, mode: 'playground' };
  const analysis = analyzeTone(history);
  const tone = analysis.profile;
  const base = mirrorPlan(tone, DEFAULT_SETTINGS.voice, seriousTopic(history));
  const plan = { ...base, address: '', char_budget: Math.max(base.char_budget, Math.min(450, lengthLimits(DEFAULT_SETTINGS.voice, s.channel).max_chars)) };
  const prompt = buildDecidePrompt({ settings: DEFAULT_SETTINGS, input, tone, plan, toneNotes: promptToneNotes(analysis.notes, tone), knowledge: { stable, retrieved: '', docs: [] } });
  const sources = [stable, notes.join('\n'), renderConversation(history, NOW)].join('\n');
  return { prompt, input, tone, sources, emojis: analysis.emojis };
}

it('reply trainer', () => {
  const scenarios = JSON.parse(readFileSync(new URL('scenarios.json', here), 'utf8')) as Scenario[];
  const stable = knowledge();
  mkdirSync(DIR, { recursive: true });
  if ((process.env.TRAIN_MODE || 'dump') === 'dump') {
    const first = build(scenarios[0]!, stable).prompt;
    writeFileSync(`${DIR}/system.txt`, first.system.map((b) => b.text).join('\n\n'));
    writeFileSync(`${DIR}/requests.json`, JSON.stringify(scenarios.map((s) => ({ id: s.id, request: build(s, stable).prompt.user })), null, 1));
    console.log(`dumped ${scenarios.length} requests, system ${Math.round(first.system.map((b) => b.text).join('').length / 3.6)} tokens (estimate)`);
    return;
  }
  const model = process.env.TRAIN_MODEL || 'haiku';
  const answers = JSON.parse(readFileSync(`${DIR}/answers-${model}.json`, 'utf8')) as Record<string, RawDecision>;
  const final = scenarios.map((s) => {
    const raw = answers[s.id];
    if (!raw) return { id: s.id, missing: true };
    const b = build(s, stable);
    const first = enforceDecision(raw, { settings: DEFAULT_SETTINGS, input: b.input, tone: b.tone, sources: b.sources, customerEmojis: b.emojis, fxRates: FX.rates, final: false });
    const done = enforceDecision(raw, { settings: DEFAULT_SETTINGS, input: b.input, tone: b.tone, sources: b.sources, customerEmojis: b.emojis, fxRates: FX.rates });
    return {
      id: s.id, expect: s.expect, customer: s.turns.filter(([w]) => w === 'customer').slice(-2).map(([, t]) => t),
      model_action: raw.action, model_parts: raw.parts, would_ask_rewrite: first.retry,
      sent_action: done.action, sent: done.parts, urgent: done.action === 'escalate' ? done.escalate : null, note: done.note,
      changed_by_checks: JSON.stringify(raw.parts) !== JSON.stringify(done.parts) || raw.action !== done.action,
    };
  });
  writeFileSync(`${DIR}/final-${model}.json`, JSON.stringify(final, null, 1));
  console.log(`checked ${final.length} answers for ${model}`);
});
