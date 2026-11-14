// Deterministic stand-in for the LLM, used only when ACX_TEST_MODE=1 (local dev and automated tests).
// Tests rely on these exact triggers, so change them together with test/.
import type { Decision, DecideInput, PolishInput, PolishResult, ToneProfile } from '../types';

export function mockDecide(input: DecideInput, tone: ToneProfile): Decision {
  const last = [...input.history].reverse().find((m) => m.direction === 'in');
  const text = (last?.body ?? '').toLowerCase();
  const base: Decision = {
    action: 'reply', parts: [], confidence: 0.92, escalate: null, tone,
    flags: { opt_out: false, asked_if_bot: false, needs_human: false }, kb_refs: [], note: 'mock', usage: null,
  };
  if (text.includes('mock-error')) throw new Error('mock brain failure');
  if (text.includes('warranty on the moon') || text.includes('unknown-question')) {
    return {
      ...base, action: 'escalate', confidence: 0.2, parts: ['good question let me check that for you'],
      escalate: { question: last?.body ?? '', reason: 'Not in the knowledge base (mock)', category: 'unknown' },
    };
  }
  if (/^\s*stop\s*$/.test(text) || text.includes('stop messaging')) {
    return { ...base, parts: ['no worries you will not hear from us again'], flags: { ...base.flags, opt_out: true } };
  }
  if (text.includes('are you a bot')) {
    return { ...base, parts: ['this is the ACX assistant. the team can jump in whenever you want'], flags: { ...base.flags, asked_if_bot: true } };
  }
  if (text.includes('lowconf')) return { ...base, confidence: 0.3, parts: ['i think it is about 3 days but not sure'] };
  if (text.includes('ignore-me')) return { ...base, action: 'ignore', note: 'mock ignore' };
  if (text.includes('two-parts')) return { ...base, parts: ['hey', 'mock second part'] };
  if (text.includes('dashes')) return { ...base, parts: ['Sure \u2014 delivery is 2-4 days, and it is free - no worries!'] };
  return { ...base, parts: [`mock reply to: ${(last?.body ?? '').slice(0, 60)}`] };
}

export function mockPolish(input: PolishInput): PolishResult {
  return {
    parts: [`polished: ${input.owner_answer}`],
    learned: { title: input.question.slice(0, 80), content: `Q: ${input.question}\nA: ${input.owner_answer}` },
    usage: null,
  };
}
