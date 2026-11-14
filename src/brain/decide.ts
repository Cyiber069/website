// decide(): read a conversation and say what happens next. The model proposes, this file disposes:
// whatever comes back is validated, checked against the owner's rules and passed through the
// sanitizer before the pipeline sees it.
import type { Decision, DecideInput, Env, ToneProfile } from '../types';
import { buildKnowledgeContext, type KnowledgeContext } from '../kb';
import { getSettings } from '../lib/settings';
import { LlmError, callJson, chooseProvider, knowledgeBudget } from './llm';
import { mockDecide } from './mock';
import { DECISION_SCHEMA, buildDecidePrompt, renderConversation, validateDecision, type RawDecision } from './prompt';
import { enforceDecision, hasWords, holdingLine, knowledgeQuery, mediaHoldingLine, pendingInbound, promptToneNotes, seriousTopic, type EnforceContext } from './rules';
import { analyzeTone, mirrorPlan } from './tone';

const NO_KNOWLEDGE: KnowledgeContext = { mode: 'empty', stable: '', retrieved: '', docs: [], tokens: 0 };

function toDecision(d: RawDecision, tone: ToneProfile, usage: Decision['usage']): Decision {
  return { action: d.action, parts: d.parts, confidence: d.confidence, escalate: d.escalate, tone, flags: d.flags, kb_refs: d.kb_refs, note: d.note, usage };
}

export async function decide(env: Env, input: DecideInput): Promise<Decision> {
  const settings = await getSettings(env.DB);
  const analysis = analyzeTone(input.history);
  const tone = analysis.profile;
  const plan = mirrorPlan(tone, settings.voice);
  const pending = pendingInbound(input.history);
  const lastText = [...pending].reverse().find(hasWords)?.body ?? '';

  // A voice note or photo with no words around it: there is nothing to answer from. No model call needed.
  if (pending.length > 0 && !pending.some(hasWords)) {
    const kinds = [...new Set(pending.map((m) => (m.kind === 'voice' ? 'a voice note' : m.kind === 'image' ? 'a photo' : m.kind === 'video' ? 'a video' : m.kind === 'document' ? 'a file' : m.kind === 'sticker' ? 'a sticker' : 'a message with no text')))];
    const raw: RawDecision = {
      action: 'escalate', parts: [mediaHoldingLine(pending.map((m) => m.kind), tone.language)], confidence: 0.9, language: tone.language,
      escalate: { question: `The customer sent ${kinds.join(' and ')} that I cannot open. Please have a look and reply.`, reason: 'I cannot listen to voice notes or look at pictures', category: 'media' },
      flags: { opt_out: false, asked_if_bot: false, needs_human: true }, kb_refs: [], note: `Customer sent ${kinds.join(' and ')} with no text`,
    };
    return toDecision(enforceDecision(raw, { settings, input, tone, sources: '', customerEmojis: analysis.emojis }), tone, null);
  }

  const choice = await chooseProvider(env, settings);
  // The knowledge base failing must not stop a reply: without knowledge the model can only greet or escalate.
  const knowledge = await buildKnowledgeContext(env, knowledgeQuery(input), { budgetTokens: knowledgeBudget(choice) }).catch((err) => {
    console.error('knowledge lookup failed', err);
    return NO_KNOWLEDGE;
  });
  const sources = [knowledge.stable, knowledge.retrieved, input.context_notes.join('\n'), input.subject ?? '', renderConversation(input.history, input.now)].join('\n');
  const ctx: EnforceContext = { settings, input, tone, sources, customerEmojis: analysis.emojis };

  if (choice.provider === 'mock') {
    const m = mockDecide(input, tone);
    const raw: RawDecision = { action: m.action, parts: m.parts, confidence: m.confidence, escalate: m.escalate, flags: m.flags, kb_refs: [], note: m.note, language: tone.language };
    // The mock invents its wording, so the "figures must be in the knowledge" check cannot apply to it.
    const done = enforceDecision(raw, { ...ctx, sources: `${sources}\n${m.parts.join('\n')}` });
    // Report what the real brain would have been shown, so retrieval is exercised end to end in tests.
    if (done.action !== 'ignore') done.kb_refs = knowledge.docs.slice(0, 6).map((d) => d.id);
    return toDecision(done, tone, null);
  }

    const toneNotes = promptToneNotes(analysis.notes, tone);
  if (seriousTopic(input.history)) toneNotes.push('serious topic (money back, a complaint, safety or the law): plain and direct, normal capitals, no slang, no emoji, no stretched letters');
  const prompt = buildDecidePrompt({ settings, input, tone, plan, toneNotes, knowledge });
  let raw: RawDecision;
  let usage: Decision['usage'] = null;
  try {
    const res = await callJson(env, { purpose: input.mode === 'playground' ? 'playground' : 'decide', system: prompt.system, user: prompt.user, schema: DECISION_SCHEMA, choice });
    usage = res.usage;
    raw = validateDecision(res.data, knowledge.docs.map((d) => d.id), lastText);
  } catch (err) {
    // A safety refusal is not an outage: hand the conversation to the owner. Everything else is
    // thrown so the pipeline logs it and tries again later.
    if (!(err instanceof LlmError) || err.code !== 'refusal') throw err;
    raw = {
      action: 'escalate', parts: [holdingLine(tone.language)], confidence: 0.9, language: tone.language,
      escalate: { question: lastText.slice(0, 1000) || 'The customer needs an answer from you', reason: 'The AI declined to answer this message', category: 'other' },
      flags: { opt_out: false, asked_if_bot: false, needs_human: true }, kb_refs: [], note: 'The AI declined to answer, passed to the owner',
    };
  }
  return toDecision(enforceDecision(raw, ctx), tone, usage);
}
