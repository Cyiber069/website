// polishOwnerAnswer(): the owner typed a rough answer on their phone. Turn it into the message the
// customer gets, in the customer's tone, without adding a single fact, and pull out a reusable fact
// for the knowledge base when the answer holds for everyone.
import type { Env, PolishInput, PolishResult } from '../types';
import { clip } from '../lib/db';
import { getSettings } from '../lib/settings';
import { LlmError, callJson, chooseProvider } from './llm';
import { mockPolish } from './mock';
import { POLISH_SCHEMA, buildPolishPrompt, claimsHuman, renderConversation, unsupportedNumbers } from './prompt';
import { promptToneNotes, seriousTopic } from './rules';
import { finalizeParts, type StyleContext } from './style';
import { analyzeTone, mirrorPlan } from './tone';

interface PolishOutput { parts?: unknown; general?: unknown; learned_title?: unknown; learned_content?: unknown }

/** Check the model's answer. Returns null when it cannot be used and the owner's own words should go out instead. */
export function validatePolish(raw: unknown, input: PolishInput): { parts: string[]; learned: PolishResult['learned'] } | null {
  const o = (raw !== null && typeof raw === 'object' ? raw : {}) as PolishOutput;
  const parts = (Array.isArray(o.parts) ? o.parts : typeof o.parts === 'string' ? [o.parts] : [])
    .filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean).slice(0, 3);
  if (!parts.length) return null;
  // The owner's answer is the only source of facts. A new figure means the model added something.
  const sources = [input.owner_answer, input.question, renderConversation(input.history, input.now)].join('\n');
  if (unsupportedNumbers(parts.join(' '), sources).length) return null;
  if (parts.some(claimsHuman) && !claimsHuman(input.owner_answer)) return null;

  let learned: PolishResult['learned'] = null;
  const title = typeof o.learned_title === 'string' ? o.learned_title.trim() : '';
  const content = typeof o.learned_content === 'string' ? o.learned_content.trim() : '';
  if (o.general === true && title && content && !unsupportedNumbers(content, sources).length) {
    learned = { title: clip(title, 140), content: content.slice(0, 2000) };
  }
  return { parts, learned };
}

export async function polishOwnerAnswer(env: Env, input: PolishInput): Promise<PolishResult> {
  const settings = await getSettings(env.DB);
  const analysis = analyzeTone(input.history);
  const tone = analysis.profile;
  const style: StyleContext = { voice: settings.voice, tone, channel: input.channel, serious: seriousTopic(input.history), customer_emojis: analysis.emojis };
  // If anything goes wrong the customer still gets the owner's answer, tidied by the style rules only.
  const asWritten = (): PolishResult => ({
    parts: finalizeParts([input.owner_answer], style),
    learned: { title: clip(input.question, 140), content: `Q: ${input.question.trim()}\nA: ${input.owner_answer.trim()}` },
    usage: null,
  });

  const choice = await chooseProvider(env, settings).catch(() => null);
  if (!choice) return asWritten();
  if (choice.provider === 'mock') {
    const r = mockPolish(input);
    r.parts = finalizeParts(r.parts, style);
    return r;
  }

  const prompt = buildPolishPrompt({ settings, input, tone, plan: mirrorPlan(tone, settings.voice, seriousTopic(input.history)), toneNotes: promptToneNotes(analysis.notes, tone) });
  try {
    const res = await callJson(env, { purpose: 'polish', system: prompt.system, user: prompt.user, schema: POLISH_SCHEMA, choice });
    const checked = validatePolish(res.data, input);
    if (!checked) return { ...asWritten(), usage: res.usage };
    const parts = finalizeParts(checked.parts, style);
    if (!parts.length) return { ...asWritten(), usage: res.usage };
    return { parts, learned: checked.learned, usage: res.usage };
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    console.error('polish failed, sending the owner answer as written:', err.code, err.message);
    return asWritten();
  }
}
