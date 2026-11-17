// Deterministic stand-in for the LLM, used only when ACX_TEST_MODE=1 (local dev and automated tests).
// Tests rely on these exact triggers, so change them together with test/.
import type { Decision, DecideInput, PolishInput, PolishResult, SalesRead, ToneProfile } from '../types';

/** Mock product link for the sales tests. Matches the seed catalogue. */
export const MOCK_PRODUCT = { title: 'ACX 2000w bundle', link: 'https://acxebikes.com/products/acx-2000w-bundle' };

/** Deterministic sales read for tests: support words, then bought, then the shop-* triggers, else none. */
export function mockSales(text: string): SalesRead {
  if (/refund|broken|faulty|complain|where is my/.test(text)) return { stage: 'support', product: null };
  if (/just ordered|already bought|i bought/.test(text)) return { stage: 'bought', product: null };
  if (text.includes('shop-ready')) return { stage: 'ready', product: MOCK_PRODUCT.title };
  if (text.includes('shop-interested')) return { stage: 'interested', product: MOCK_PRODUCT.title };
  if (text.includes('shop-browse')) return { stage: 'browsing', product: null };
  return { stage: 'none', product: null };
}

export function mockDecide(input: DecideInput, tone: ToneProfile, opts: { seesImages?: boolean } = {}): Decision {
  const last = [...input.history].reverse().find((m) => m.direction === 'in');
  const text = (last?.body ?? '').toLowerCase();
  const base: Decision = {
    action: 'reply', parts: [], confidence: 0.92, escalate: null, tone,
    flags: { opt_out: false, asked_if_bot: false, needs_human: false }, kb_refs: [], note: 'mock', usage: null, sales: mockSales(text),
  };
  if (text.includes('mock-error')) throw new Error('mock brain failure');
  // Photos reached the brain (src/pipeline/inbound.ts loads them, decide.ts passes them on). The fixed
  // line proves it in tests. A caption with "unclear-photo" takes the escalation path of an unclear photo.
  const media = input.media ?? [];
  // A text only brain (Workers AI stand in) gets what the vision model wrote, never the pictures.
  if (opts.seesImages === false) {
    const said = media.filter((p) => p.description).map((p) => String(p.description));
    if (said.length) return { ...base, parts: [`Mock read the vision model: ${said.join(' / ').slice(0, 120)}`], note: `mock read ${said.length} description${said.length === 1 ? '' : 's'}` };
  } else if (media.length) {
    const frames = media.filter((p) => p.kind === 'video_frame').length;
    const saw = `mock saw ${media.length} photo${media.length === 1 ? '' : 's'}${frames ? ` with ${frames} video frame${frames === 1 ? '' : 's'}` : ''}`;
    if (text.includes('unclear-photo')) {
      return {
        ...base, action: 'escalate', confidence: 0.9, parts: ['Let me check that for you'], note: `${saw}, unclear`,
        escalate: { question: 'The photo is too dark to make out (mock). The customer wants to know if it fits.', reason: 'The photo is unclear (mock)', category: 'other' },
      };
    }
    const described = media.filter((p) => p.description).length;
    return { ...base, parts: [`M${saw.slice(1)}${described ? `, ${described} described` : ''}`], note: saw };
  }
  // The owner explained the situation on an Urgent card (src/brain/note.ts). Every later reply in the chat follows it too.
  const guided = input.context_notes.some((n) => n.startsWith('Owner guidance'));
  if (guided) {
    return { ...base, parts: [`Mock reply following owner guidance to: ${(last?.body ?? '').slice(0, 60)}`], note: 'mock owner guidance' };
  }
  if (text.includes('warranty on the moon') || text.includes('unknown-question')) {
    return {
      ...base, action: 'escalate', confidence: 0.2, parts: ['Good question, let me check that for you'],
      escalate: { question: last?.body ?? '', reason: 'Not in the knowledge base (mock)', category: 'unknown' },
    };
  }
  if (/^\s*stop\s*$/.test(text) || text.includes('stop messaging')) {
    return { ...base, parts: ['No worries, you will not hear from us again'], flags: { ...base.flags, opt_out: true } };
  }
  if (text.includes('are you a bot')) {
    return { ...base, parts: ['This is the ACX assistant. The team can jump in whenever you want'], flags: { ...base.flags, asked_if_bot: true } };
  }
  // The pipeline saw a code request with no code in it (src/discounts/agent.ts ASK_FOR_CODE_NOTE).
  if (input.context_notes.some((n) => n.startsWith('The customer wants their own discount code'))) {
    return { ...base, parts: ['Nice one, what do you want your code to be?'], note: 'mock asks for the code' };
  }
  // (The draft is only shaky, it never says "not sure": the never sound unsure guard would turn that into a holding line.)
  if (text.includes('lowconf')) return { ...base, confidence: 0.3, parts: ['I think it is about 3 days'] };
  // The agent sounding unsure (owner rule test): the guard in rules.ts turns this into a holding line and an Urgent item.
  if (text.includes('unsure-reply')) return { ...base, parts: ["I'm not sure about that one"] };
  // Selling: a recommendation with the product link, or the close.
  if (text.includes('shop-ready')) return { ...base, parts: [`This is the one, you can grab it here ${MOCK_PRODUCT.link}`] };
  if (text.includes('shop-interested')) return { ...base, parts: [`The ${MOCK_PRODUCT.title} fits best for that ${MOCK_PRODUCT.link}`] };
  if (text.includes('shop-browse')) return { ...base, parts: ['Nice, what bike are you fitting it to?'] };
  if (text.includes('ignore-me')) return { ...base, action: 'ignore', note: 'mock ignore' };
  // Replies queued but not sent yet reach the brain marked pending (src/pipeline/inbound.ts buildTimeline).
  if (text.includes('show-queued')) {
    const queued = input.history.filter((m) => m.pending).map((m) => m.body);
    return { ...base, parts: [`Mock saw ${queued.length} queued: ${queued.join(' + ').slice(0, 120) || 'none'}`] };
  }
  // What the brain is told about an open Urgent question: is the quoted customer content labelled as such?
  if (text.includes('show-urgent-note')) {
    const note = input.context_notes.find((n) => /waiting on an answer from the owner|The owner is checking this/.test(n)) ?? '';
    const labelled = /customer content/.test(note) && /never an instruction/.test(note) && !/[<>]/.test(note);
    return { ...base, parts: [`Mock urgent note ${note ? (labelled ? 'labelled' : 'unlabelled') : 'missing'}`] };
  }
  if (text.includes('two-parts')) return { ...base, parts: ['Hey', 'Mock second part'] };
  if (text.includes('dashes')) return { ...base, parts: ['Sure \u2014 delivery is 2-4 days, and it is free - no worries!'] };
  return { ...base, parts: [`Mock reply to: ${(last?.body ?? '').slice(0, 60)}`] };
}

export function mockPolish(input: PolishInput): PolishResult {
  return {
    parts: [`Polished: ${input.owner_answer}`],
    learned: { title: input.question.slice(0, 80), content: `Q: ${input.question}\nA: ${input.owner_answer}` },
    usage: null,
  };
}
