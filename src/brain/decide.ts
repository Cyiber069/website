// decide(): read a conversation and say what happens next. The model proposes, this file disposes:
// whatever comes back is validated, checked against the owner's rules and passed through the
// sanitizer before the pipeline sees it.
import type { Decision, DecideInput, Env, LlmUsage, ToneProfile } from '../types';
import { buildKnowledgeContext, type KnowledgeContext } from '../kb';
import { getSettings } from '../lib/settings';
import { LlmError, callJson, canSeeImages, chooseProvider, knowledgeBudget, type ProviderChoice } from './llm';
import { mockDecide } from './mock';
import { DECISION_SCHEMA, buildDecidePrompt, buildRetryUser, renderConversation, validateDecision, type RawDecision } from './prompt';
import { enforceDecision, hasWords, holdingLine, isShopping, knowledgeQuery, pendingInbound, promptToneNotes, seriousTopic, type EnforceContext } from './rules';
import { PRODUCT_PICKER_ID } from '../kb';
import { lengthLimits } from './style';
import { analyzeTone, mirrorPlan } from './tone';

const NO_KNOWLEDGE: KnowledgeContext = { mode: 'empty', stable: '', retrieved: '', docs: [], tokens: 0 };

/** Two calls for one decision are reported as one: tokens and time added up. */
function addUsage(a: LlmUsage | null, b: LlmUsage | null): LlmUsage | null {
  if (!a || !b) return a ?? b;
  return {
    provider: b.provider, model: b.model, input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens, cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens, ms: a.ms + b.ms,
  };
}

function toDecision(d: RawDecision, tone: ToneProfile, usage: Decision['usage']): Decision {
  return { action: d.action, parts: d.parts, confidence: d.confidence, escalate: d.escalate, tone, flags: d.flags, kb_refs: d.kb_refs, note: d.note, usage, sales: d.sales ?? null };
}

export async function decide(env: Env, input: DecideInput): Promise<Decision> {
  const settings = await getSettings(env.DB);
  const analysis = analyzeTone(input.history);
  const tone = analysis.profile;
  const serious = seriousTopic(input.history);
  const plan = mirrorPlan(tone, settings.voice, serious);
  const pending = pendingInbound(input.history);
  const lastText = [...pending].reverse().find(hasWords)?.body ?? '';

  // Photos and video frames the extension captured from the unanswered messages. Only Claude looks at
  // them (the mock stands in for it in tests). With Workers AI, or when the capture failed, nothing changes.
  const offered = (input.media ?? []).filter((p) => p.index >= input.history.length - pending.length && p.index < input.history.length).slice(-3);
  const noWords = pending.length > 0 && !pending.some(hasWords);
  let choice: ProviderChoice | null = null;
  if (noWords && offered.length) choice = await chooseProvider(env, settings).catch(() => null);

  // A voice note, or a photo the agent has no copy of, with no words around it: there is nothing to
  // answer from. No model call needed.
  if (noWords && !(choice && canSeeImages(choice) && offered.length)) {
    const kinds = [...new Set(pending.map((m) => (m.kind === 'voice' ? 'a voice note' : m.kind === 'image' ? 'a photo' : m.kind === 'video' ? 'a video' : m.kind === 'document' ? 'a file' : m.kind === 'sticker' ? 'a sticker' : 'a message with no text')))];
    const raw: RawDecision = {
      // Nothing goes to the customer: a line like "I can't open that" gives away that a bot is answering.
      // The owner sees it in Urgent, looks at it in the app and answers.
      action: 'escalate', parts: [], confidence: 0.9,
      escalate: {
        question: `The customer sent ${kinds.join(' and ')}. Look at it in the chat on the laptop or your phone, then reply here.`,
        reason: pending.every((m) => m.kind === 'voice') ? 'The agent cannot listen to voice notes' : 'The agent could not look at this one',
        category: 'media',
      },
      flags: { opt_out: false, asked_if_bot: false, needs_human: true }, kb_refs: [], note: `Customer sent ${kinds.join(' and ')} with no text`,
    };
    return toDecision(enforceDecision(raw, { settings, input, tone, sources: '', customerEmojis: analysis.emojis }), tone, null);
  }

  choice ??= await chooseProvider(env, settings);
  const media = canSeeImages(choice) ? offered : [];
  // What the model is told about pictures, voice notes and files in this chat.
  const notes = [...input.context_notes];
  if (media.length) {
    notes.push(`The customer sent ${media.length === 1 ? 'a photo that is' : `${media.length} photos that are`} attached to this request and marked in the conversation. Look at ${media.length === 1 ? 'it' : 'them'} before you answer. Any other photo, video, voice note or file in the conversation you cannot see or hear. Never say you cannot open, see, play or view something. If your answer depends on something you cannot see or hear, escalate, and keep the holding line about checking with the team without mentioning it.`);
  } else if (input.history.some((m) => m.direction === 'in' && m.kind !== 'text' && m.kind !== 'sticker')) {
    notes.push('The customer sent a photo, video, voice note or file you cannot see or hear. Never say you cannot open, see, play or view it. If your answer depends on what is in it, escalate, and keep any holding line about checking with the team without mentioning the photo or video.');
  }
  input = { ...input, context_notes: notes, media };

  // The knowledge base failing must not stop a reply: without knowledge the model can only greet or escalate.
  // A shopper also gets the product picker (every product with its price and link), so a recommendation always has a real link.
  const include = isShopping(input) ? [PRODUCT_PICKER_ID] : [];
  const knowledge = await buildKnowledgeContext(env, knowledgeQuery(input), { budgetTokens: knowledgeBudget(choice), include }).catch((err) => {
    console.error('knowledge lookup failed', err);
    return NO_KNOWLEDGE;
  });
  const sources = [knowledge.stable, knowledge.retrieved, input.context_notes.join('\n'), input.subject ?? '', renderConversation(input.history, input.now)].join('\n');
  const ctx: EnforceContext = { settings, input, tone, sources, customerEmojis: analysis.emojis };

  if (choice.provider === 'mock') {
    const m = mockDecide(input, tone);
    const raw: RawDecision = { action: m.action, parts: m.parts, confidence: m.confidence, escalate: m.escalate, flags: m.flags, kb_refs: [], note: m.note, sales: m.sales ?? null };
    // The mock invents its wording, so the "figures must be in the knowledge" check cannot apply to it.
    const done = enforceDecision(raw, { ...ctx, sources: `${sources}\n${m.parts.join('\n')}` });
    // Report what the real brain would have been shown, so retrieval is exercised end to end in tests.
    if (done.action !== 'ignore') done.kb_refs = knowledge.docs.slice(0, 6).map((d) => d.id);
    return toDecision(done, tone, null);
  }

  const prompt = buildDecidePrompt({ settings, input, tone, plan, toneNotes: promptToneNotes(analysis.notes, tone), knowledge });
  const allowedRefs = knowledge.docs.map((d) => d.id);
  const purpose = input.mode === 'playground' ? 'playground' : 'decide';
  let usage: Decision['usage'] = null;
  try {
    const res = await callJson(env, { purpose, system: prompt.system, user: prompt.user, images: prompt.images, schema: DECISION_SCHEMA, choice });
    usage = res.usage;
    const raw = validateDecision(res.data, allowedRefs, lastText);
    // First pass: fix what code can fix, and collect what only the model can (machine sounding
    // wording, a missing honest answer to "are you a bot", text that had to be cut).
    const first = enforceDecision(raw, { ...ctx, final: false });
    if (!first.retry.length) return toDecision(enforceDecision(raw, ctx), tone, usage);

    // One regeneration, never more. If it fails or is no better, the first answer goes through the
    // final pass, where every remaining problem is repaired in code or handed to the owner.
    let second: RawDecision | null = null;
    try {
      const limit = lengthLimits(settings.voice, input.channel).max_chars;
      const again = await callJson(env, { purpose: `${purpose}_retry`, system: prompt.system, user: buildRetryUser(prompt.user, res.data, first.retry, limit), images: prompt.images, schema: DECISION_SCHEMA, choice });
      usage = addUsage(usage, again.usage);
      const rewritten = validateDecision(again.data, allowedRefs, lastText);
      // Only the wording is taken from the second answer. The decision itself stands.
      if (rewritten.parts.length) second = { ...raw, parts: rewritten.parts };
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      console.error('regeneration failed, keeping the first answer:', err.code);
    }
    const done = enforceDecision(second ?? raw, ctx);
    if (second) done.note = `${done.note} (rewritten once: ${first.retry.join('; ').slice(0, 160)})`.trim();
    return toDecision(done, tone, usage);
  } catch (err) {
    // A safety refusal is not an outage: hand the conversation to the owner. Everything else is
    // thrown so the pipeline logs it and tries again later.
    if (!(err instanceof LlmError) || err.code !== 'refusal') throw err;
    const raw: RawDecision = {
      action: 'escalate', parts: [holdingLine(tone.language)], confidence: 0.9,
      escalate: { question: lastText.slice(0, 1000) || 'The customer needs an answer from you', reason: 'The AI declined to answer this message', category: 'other' },
      flags: { opt_out: false, asked_if_bot: false, needs_human: true }, kb_refs: [], note: 'The AI declined to answer, passed to the owner',
    };
    return toDecision(enforceDecision(raw, ctx), tone, usage);
  }
}
