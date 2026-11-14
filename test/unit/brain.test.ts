import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/lib/settings';
import { LlmError, callJson, chooseProvider, knowledgeBudget, parseLooseJson, readWorkersAiResponse, supportsFallbacks } from '../../src/brain/llm';
import { mockDecide } from '../../src/brain/mock';
import { validatePolish } from '../../src/brain/polish';
import {
  DECISION_SCHEMA, POLISH_SCHEMA, buildDecidePrompt, buildPolishPrompt, claimsHuman, decideInstructions, looksLikeBotQuestion, looksLikeOptOut, numbersIn, renderConversation,
  styleCard, unsupportedNumbers, validateDecision, type PromptKnowledge, type RawDecision,
} from '../../src/brain/prompt';
import { normalizePlaceholders, sanitizeTemplate } from '../../src/brain/recovery';
import { botLines, enforceDecision, holdingLine, knowledgeQuery, mediaHoldingLine, pendingInbound, promptToneNotes, protectedCodes, seriousTopic } from '../../src/brain/rules';
import { violations } from '../../src/brain/style';
import { analyzeTone, mirrorPlan } from '../../src/brain/tone';
import type { DecideInput, Env, HistoryMessage, PolishInput, Settings } from '../../src/types';

const NOW = 1_794_700_000_000;
const settings = (voice: Partial<Settings['voice']> = {}, brain: Partial<Settings['brain']> = {}): Settings =>
  ({ ...DEFAULT_SETTINGS, voice: { ...DEFAULT_SETTINGS.voice, ...voice }, brain: { ...DEFAULT_SETTINGS.brain, ...brain } });
const inMsg = (body: string, kind: HistoryMessage['kind'] = 'text', minsAgo = 0): HistoryMessage => ({ direction: 'in', author: 'customer', body, kind, ts: NOW - minsAgo * 60_000 });
const outMsg = (body: string, minsAgo = 0): HistoryMessage => ({ direction: 'out', author: 'agent', body, kind: 'text', ts: NOW - minsAgo * 60_000 });
const input = (history: HistoryMessage[], extra: Partial<DecideInput> = {}): DecideInput =>
  ({ channel: 'whatsapp', contact_name: 'Jake', subject: null, history, context_notes: [], now: NOW, mode: 'live', ...extra });

const knowledge: PromptKnowledge = {
  stable: '<doc id="seed_store-facts" title="Store facts">\nSupport hours: 9am to 8pm.\n</doc>',
  retrieved: '<excerpt doc="kb_ship" section="Shipping policy > UK">\nUK delivery takes 2 to 4 working days and is free.\n</excerpt>',
  docs: [{ id: 'seed_store-facts', title: 'Store facts' }, { id: 'kb_ship', title: 'Shipping policy' }],
};

function prompt(history: HistoryMessage[], s = settings(), k = knowledge, extra: Partial<DecideInput> = {}) {
  const inp = input(history, extra);
  const a = analyzeTone(history);
  return buildDecidePrompt({ settings: s, input: inp, tone: a.profile, plan: mirrorPlan(a.profile, s.voice), toneNotes: promptToneNotes(a.notes, a.profile), knowledge: k });
}

// ---- prompt building ----------------------------------------------------------------------------

describe('decide prompt', () => {
  const a = prompt([inMsg('yoooo brooo'), inMsg('how long is delivery 🔥')]);
  const b = prompt([inMsg('Good afternoon, I would like to enquire about your returns policy. Kind regards, Margaret')], settings(), { ...knowledge, retrieved: '<excerpt doc="kb_ret">14 days</excerpt>' }, { channel: 'gmail', contact_name: 'Margaret Hughes', subject: 'Returns', now: NOW + 86_400_000 });

  it('keeps the cached prefix identical for different conversations, customers, channels and times', () => {
    const stable = (p: typeof a) => JSON.stringify(p.system);
    expect(stable(a)).toBe(stable(b));
    expect(a.user).not.toBe(b.user);
    // The breakpoint sits on the last system block, after the knowledge that is the same for everyone.
    expect(a.system.map((s) => !!s.cache)).toEqual([false, true]);
    expect(a.system[1]!.text).toContain('seed_store-facts');
  });

  it('keeps everything that varies out of the system blocks', () => {
    const sys = a.system.map((s) => s.text).join('\n') + b.system.map((s) => s.text).join('\n');
    for (const leak of ['how long is delivery', 'Margaret', 'Jake', 'kb_ship', 'kb_ret', '2026', 'hype', 'Returns\n']) expect(sys).not.toContain(leak);
    expect(a.user).toContain('kb_ship');
    expect(a.user).toContain('customer: yoooo brooo');
    expect(a.user).toContain('register: hype');
    expect(a.user).toContain('address term: you may say "bro" once');
    expect(b.user).toContain('channel: email');
    expect(b.user).toContain('subject: Returns');
    expect(b.user).toContain('register: formal');
    expect(b.user).toContain('address term: none');
  });

  it('caches the instructions alone when there is no shared knowledge', () => {
    const p = prompt([inMsg('hi')], settings(), { stable: '', retrieved: '', docs: [] });
    expect(p.system).toHaveLength(1);
    expect(p.system[0]!.cache).toBe(true);
    expect(p.user).toContain('The knowledge base is empty');
  });

  it('changes the prefix only when the owner changes a setting', () => {
    expect(decideInstructions(settings())).toBe(decideInstructions(settings()));
    expect(decideInstructions(settings({ max_chars: 120 }))).not.toBe(decideInstructions(settings()));
    expect(decideInstructions(settings({ extra_rules: 'Never mention competitors.' }))).toContain('Never mention competitors.');
  });

  it('turns the voice settings into rules', () => {
    const base = styleCard(settings());
    expect(base).toContain('at most 3 sentences and 260 characters');
    expect(base).toMatch(/No dashes of any kind/);
    expect(styleCard(settings({ max_sentences: 2, max_chars: 140 }))).toContain('at most 2 sentences and 140 characters');
    expect(styleCard(settings({ commas: 'none' }))).toContain('Do not use commas at all');
    expect(styleCard(settings({ emojis: 'never' }))).toContain('Never use emoji');
    expect(styleCard(settings({ mirror_level: 'off' }))).toContain('Do not imitate the customer');
    expect(styleCard(settings({ mirror_level: 'match' }))).toContain('one notch calmer');
    expect(styleCard(settings({ banned_phrases: ['no worries', 'awesome'] }))).toContain('"no worries", "awesome"');
    expect(decideInstructions(settings({ bot_question_policy: 'escalate' }))).toContain('leave it to the owner');
    expect(decideInstructions(settings({ bot_question_policy: 'honest_short' }))).toContain('answer honestly in one short line');
    expect(decideInstructions(settings())).toMatch(/Never say or imply that you are a human/);
    expect(decideInstructions(settings())).toMatch(/If it is not there, you do not know it: escalate/);
  });

  it('follows its own style rules: no long dashes anywhere in the instructions', () => {
    expect(decideInstructions(settings())).not.toMatch(/[‒-―]/);
    expect(buildPolishPrompt({ settings: settings(), input: polishInput(), tone: analyzeTone([]).profile, plan: mirrorPlan(analyzeTone([]).profile), toneNotes: [] }).system[0]!.text).not.toMatch(/[‒-―]/);
  });

  it('shows media as placeholders, marks who spoke and how long ago', () => {
    const text = renderConversation([inMsg('hi', 'text', 200), outMsg('hey', 190), inMsg('', 'voice', 3), inMsg('this one\nsecond line', 'image', 0)], NOW);
    expect(text.split('\n')).toEqual(['customer (3 h ago): hi', 'shop (3 h ago): hey', 'customer (3 min ago): [voice note]', 'customer: [photo] this one / second line']);
  });

  it('tells the model to answer in the language of the customer', () => {
    const history = [inMsg('hola buenas, cuanto cuesta el envio para España gracias')];
    const p = prompt(history);
    expect(p.user).toContain('language: Spanish');
    expect(p.user).toContain('reply in Spanish');
    expect(p.user).not.toContain('reply in simple English');
  });

  it('passes on context notes and searches knowledge with the last customer messages', () => {
    const history = [inMsg('how long is delivery'), outMsg('2 to 4 days'), inMsg('and to ireland')];
    const p = prompt(history, settings(), knowledge, { context_notes: ['A checkout reminder was sent yesterday.'] });
    expect(p.user).toContain('- A checkout reminder was sent yesterday.');
    expect(p.user).toContain('greeting: none, the conversation is already going');
    expect(knowledgeQuery(input(history, { subject: 'Order question' }))).toBe('Order question\nhow long is delivery\nand to ireland');
    expect(pendingInbound(history).map((m) => m.body)).toEqual(['and to ireland']);
  });

  it('uses schemas the structured output feature accepts', () => {
    for (const schema of [DECISION_SCHEMA, POLISH_SCHEMA] as any[]) {
      expect(schema.additionalProperties).toBe(false);
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
      expect(JSON.stringify(schema)).not.toMatch(/"(minimum|maximum|minLength|maxLength|pattern)"/);
    }
  });
});

// ---- output validation --------------------------------------------------------------------------

const good = {
  action: 'reply', parts: ['hey bro', 'delivery is 2 to 4 days'], confidence: 0.9, language: 'en', escalate_question: '', escalate_reason: '',
  escalate_category: 'unknown', opt_out: false, asked_if_bot: false, needs_human: false, kb_refs: ['kb_ship', 'kb_made_up', 'kb_ship'], note: 'answered from shipping policy',
};
const allowed = ['seed_store-facts', 'kb_ship'];

describe('validateDecision', () => {
  it('accepts a well formed reply and drops knowledge ids that were never shown', () => {
    const d = validateDecision(good, allowed, 'how long is delivery');
    expect(d).toMatchObject({ action: 'reply', parts: ['hey bro', 'delivery is 2 to 4 days'], confidence: 0.9, escalate: null, kb_refs: ['kb_ship'], note: 'answered from shipping policy' });
  });

  it('turns anything unusable into an escalation instead of throwing', () => {
    for (const raw of [null, undefined, 'hello', 42, [], {}, { action: 'dance' }, { action: 'reply', parts: [] }, { action: 'reply', parts: ['  ', 7, null] }]) {
      const d = validateDecision(raw, allowed, 'do you ship to mars');
      expect(d.action).toBe('escalate');
      expect(d.escalate!.question).toBe('do you ship to mars');
      expect(d.escalate!.reason.length).toBeGreaterThan(3);
      expect(d.confidence).toBeGreaterThanOrEqual(0);
    }
  });

  it('coerces sloppy fields', () => {
    const d = validateDecision({ ...good, parts: 'just one string', confidence: '85', kb_refs: 'kb_ship', opt_out: 'true' }, allowed, '');
    expect(d.parts).toEqual(['just one string']);
    expect(d.confidence).toBe(0.85);
    expect(d.kb_refs).toEqual([]);
    expect(d.flags.opt_out).toBe(true);
    expect(validateDecision({ ...good, confidence: 7000 }, allowed, '').confidence).toBe(1);
    expect(validateDecision({ ...good, confidence: -3 }, allowed, '').confidence).toBe(0);
    expect(validateDecision({ ...good, parts: ['a', 'b', 'c', 'd', 'e'] }, allowed, '').parts).toHaveLength(3);
  });

  it('keeps one holding line on an escalation and nothing on ignore', () => {
    const e = validateDecision({ ...good, action: 'escalate', parts: ['let me check', 'second line'], escalate_question: 'Does the 1000W kit fit a 20 inch wheel?', escalate_reason: 'Not in the knowledge', escalate_category: 'technical' }, allowed, 'x');
    expect(e.parts).toEqual(['let me check']);
    expect(e.escalate).toEqual({ question: 'Does the 1000W kit fit a 20 inch wheel?', reason: 'Not in the knowledge', category: 'technical' });
    expect(validateDecision({ ...good, action: 'escalate', escalate_category: 'nonsense' }, allowed, 'x').escalate!.category).toBe('unknown');
    expect(validateDecision({ ...good, action: 'ignore' }, allowed, 'x').parts).toEqual([]);
  });
});

// ---- the owner's rules, enforced in code ----------------------------------------------------------

const raw = (over: Partial<RawDecision> = {}): RawDecision => ({
  action: 'reply', parts: ['delivery is 2 to 4 days'], confidence: 0.9, escalate: null, language: 'en',
  flags: { opt_out: false, asked_if_bot: false, needs_human: false }, kb_refs: [], note: 'ok', ...over,
});
function enforce(d: RawDecision, history: HistoryMessage[], s = settings(), extra: Partial<DecideInput> = {}, sources = knowledge.retrieved) {
  const inp = input(history, extra);
  return enforceDecision(d, { settings: s, input: inp, tone: analyzeTone(history).profile, sources: `${sources}\n${renderConversation(history, NOW)}` });
}

describe('enforceDecision', () => {
  const ask = [inMsg('yo how long is delivery')];

  it('passes a grounded reply through the sanitizer', () => {
    const d = enforce(raw({ parts: ['Sure — delivery is 2-4 days, and it is free - no worries!'] }), ask);
    expect(d.action).toBe('reply');
    expect(d.parts).toHaveLength(1);
    expect(violations(d.parts[0]!)).toEqual([]);
    expect(d.parts[0]).toContain('2 to 4 days');
    expect(d.flags.needs_human).toBe(false);
    expect(d.confidence).toBe(0.9);
  });

  it('never lets an invented figure go out on its own', () => {
    const d = enforce(raw({ parts: ['its 48 hours bro and costs £15'] }), ask);
    expect(d.action).toBe('reply'); // kept as a draft
    expect(d.flags.needs_human).toBe(true);
    expect(d.confidence).toBeLessThan(DEFAULT_SETTINGS.brain.confidence_threshold);
    expect(d.note).toMatch(/figures not found in the knowledge: 48, 15/);
    // The same figures are fine when the knowledge or the customer supplied them.
    expect(enforce(raw({ parts: ['yeah 48 hours'] }), [inMsg('is it really 48 hours')]).flags.needs_human).toBe(false);
  });

  it('never claims to be human', () => {
    const asked = [inMsg('are you a bot or a real person')];
    const lied = enforce(raw({ parts: ["haha no I'm a real person", 'what do you need'], flags: { opt_out: false, asked_if_bot: true, needs_human: false } }), asked);
    expect(lied.parts.join(' ')).not.toMatch(/real person/i);
    // What was left did not answer the question honestly, so the fixed honest lines go out instead.
    expect(lied.parts).toEqual(['this is the ACX AI assistant', 'the team can jump in whenever you want a person']);
    const onlyLie = enforce(raw({ parts: ['I am not a bot mate'], flags: { opt_out: false, asked_if_bot: true, needs_human: false } }), asked);
    expect(onlyLie.action).toBe('reply');
    expect(onlyLie.parts).toEqual(['this is the ACX AI assistant', 'the team can jump in whenever you want a person']);
    const unprompted = enforce(raw({ parts: ["I'm a human and delivery is 2 to 4 days"] }), ask);
    expect(unprompted.action).toBe('escalate');
    expect(unprompted.flags.needs_human).toBe(true);
    for (const t of ["I'm a real person", 'im not a bot', 'you are talking to a real human', 'No bots here', 'I am a person']) expect(claimsHuman(t)).toBe(true);
    for (const t of ['this is the ACX assistant', 'a person from the team can jump in', 'the bot question', 'I am not sure']) expect(claimsHuman(t)).toBe(false);
  });

  it('spots the bot question in code and makes sure the answer is honest', () => {
    for (const t of ['u a bot?', 'wait is this a bot lol', 'Am I talking to a real person?', 'IS THIS A BOT?? get me a human', 'are you a robot', 'can i speak to a human',
      'May I ask whether I am speaking with a person or an automated system?', 'is this chatgpt']) expect(looksLikeBotQuestion(t)).toBe(true);
    for (const t of ['how long is delivery', 'is this the 72v battery', 'are you open today', 'can the bike carry a person and a child', 'whats the bottom bracket size']) expect(looksLikeBotQuestion(t)).toBe(false);

    // The model missed the question entirely: the flag is set and the honest lines replace the dodge.
    const missed = enforce(raw({ parts: ['haha anyway delivery is 2 to 4 days'] }), [inMsg('wait is this a bot lol')]);
    expect(missed.flags.asked_if_bot).toBe(true);
    expect(missed.parts.join(' ')).toMatch(/AI assistant/);
    // An honest answer in the model's own words is left alone.
    const honest = enforce(raw({ parts: ['yeah this is the ACX AI assistant', 'the team can jump in any time if you want a person. what did you need?'] }), [inMsg('wait is this a bot lol')]);
    expect(honest.parts).toEqual(['yeah this is the ACX AI assistant', 'the team can jump in any time if you want a person. what did you need?']);
    expect(honest.action).toBe('reply');

    const s = settings();
    expect(botLines(analyzeTone([inMsg('Good morning. May I ask whether I am speaking with a person? Kind regards, David')]).profile, s)).toEqual(['This is the ACX Ebikes AI assistant. A member of the team can take over whenever you prefer.']);
    expect(botLines(analyzeTone([inMsg('Am I talking to a real person?')]).profile, s)[0]).toBe("This is ACX's AI assistant");
    // Upset and asking for a human: the honest line goes out and the owner is called.
    const angry = enforce(raw({ parts: ['sorry about that'] }), [inMsg('IS THIS A BOT?? this is a joke, absolute scam, get me a human')]);
    expect(angry.action).toBe('escalate');
    expect(angry.escalate!.category).toBe('human_request');
    expect(angry.parts).toEqual(["Yes this is ACX's AI assistant. I've asked the team to take over this chat now"]);
  });

  it('asks for one rewrite on the first pass instead of patching, and patches on the final pass', () => {
    const history = [inMsg('wait is this a bot lol')];
    const inp = input(history);
    const ctx = { settings: settings(), input: inp, tone: analyzeTone(history).profile, sources: '' };
    const dodge = raw({ parts: ['haha what do you need'] });
    const first = enforceDecision(dodge, { ...ctx, final: false });
    expect(first.retry.join(' ')).toMatch(/asked if this is a bot/);
    expect(first.parts).toEqual(['haha what do you need']); // untouched, waiting for the rewrite
    expect(enforceDecision(dodge, ctx).retry).toEqual([]);

    const ask = [inMsg('hi is the 72v in stock')];
    const c2 = { settings: settings(), input: input(ask), tone: analyzeTone(ask).profile, sources: '72v' };
    const flowery = enforceDecision(raw({ parts: ["It's not just a battery, it's a complete transformation of your ride."] }), { ...c2, final: false });
    expect(flowery.retry).toEqual(['drop the "not just X, it is Y" sentence and state the fact']);
    const lie = enforceDecision(raw({ parts: ["I'm a real person and yes it is in stock"] }), { ...c2, final: false });
    expect(lie.retry.join(' ')).toMatch(/never say or imply that a person is typing/);
    const waffle = enforceDecision(raw({ parts: ['Great question!', 'I hope this helps!'] }), { ...c2, final: false });
    expect(waffle.retry.join(' ')).toMatch(/stock phrases/);
    const tooLong = enforceDecision(raw({ parts: ['Yes it is in stock today. It ships tomorrow morning from the UK. It arrives by the end of the week. It comes fully charged in the box. It has a full warranty included.'] }), { ...c2, final: false });
    expect(tooLong.retry.join(' ')).toMatch(/too long/);
    expect(enforceDecision(raw({ parts: ['yes the 72v is in stock'] }), { ...c2, final: false }).retry).toEqual([]);
  });

  it('gives the owner the reason when a draft is held back for an invented figure', () => {
    const d = enforce(raw({ parts: ['it does about 47mph'] }), [inMsg('how fast is the 3000w')]);
    expect(d.action).toBe('reply');
    expect(d.escalate).toMatchObject({ category: 'low_confidence', question: 'how fast is the 3000w' });
    expect(d.escalate!.reason).toMatch(/figure that is not in the knowledge \(47\)/);
  });

  it('keeps hyphenated part numbers that appear in the knowledge', () => {
    expect(protectedCodes('Mid drive kit bbs02-750 and ACX-72V. Fits 26-inch wheels, 2-4 days, plug-and-play.', ['you want the bbs02-750 for a 26-inch wheel'])).toEqual(['bbs02-750']);
    const d = enforce(raw({ parts: ['you want the bbs02-750 kit'] }), [inMsg('which mid drive')], settings(), {}, 'Mid drive kit bbs02-750');
    expect(d.parts).toEqual(['you want the bbs02-750 kit']);
    expect(enforce(raw({ parts: ['its a 26-inch plug-and-play kit'] }), [inMsg('which one')], settings(), {}, 'a 26-inch plug-and-play kit').parts).toEqual(['its a 26 inch plug and play kit']);
  });

  it('hands the bot question to the owner when the policy says so', () => {
    const d = enforce(raw({ parts: ['this is the ACX assistant'], flags: { opt_out: false, asked_if_bot: true, needs_human: false } }), [inMsg('is this a bot')], settings({ bot_question_policy: 'escalate' }));
    expect(d.action).toBe('escalate');
    expect(d.escalate!.category).toBe('bot_question');
    expect(d.parts).toEqual([]);
  });

  it('detects opt out requests even when the model misses them', () => {
    expect(enforce(raw({ parts: ['no worries'] }), [inMsg('STOP')]).flags.opt_out).toBe(true);
    expect(enforce(raw({ parts: ['no worries'] }), [inMsg('please stop messaging me')]).flags.opt_out).toBe(true);
    expect(enforce(raw(), [inMsg('does the motor stop when i brake')]).flags.opt_out).toBe(false);
    // Only the unanswered messages count.
    expect(enforce(raw(), [inMsg('stop'), outMsg('ok'), inMsg('actually how long is delivery')]).flags.opt_out).toBe(false);
    for (const t of ['stop', 'Stop.', 'unsubscribe', 'dont text me again', "don't message me", 'leave me alone', 'remove me from your list', 'stop texting me']) expect(looksLikeOptOut(t)).toBe(true);
    for (const t of ['can you stop the order', 'non stop power', 'i cant stop thinking about the 5000w', 'stop by the shop?']) expect(looksLikeOptOut(t)).toBe(false);
  });

  it('keeps holding lines short, factless and optional', () => {
    const esc = { question: 'q', reason: 'r', category: 'unknown' };
    const fine = enforce(raw({ action: 'escalate', escalate: esc, parts: ['good question let me check that for you'] }), ask);
    expect(fine.parts).toEqual(['let me check that for you']); // "good question" is a stock phrase and goes
    const sneaky = enforce(raw({ action: 'escalate', escalate: esc, parts: ['i think it is about 12 days but let me check'] }), ask);
    expect(sneaky.parts).toEqual([holdingLine('en')]);
    const off = enforce(raw({ action: 'escalate', escalate: esc, parts: ['let me check'] }), ask, settings({ holding_reply: false }));
    expect(off.parts).toEqual([]);
    expect(off.action).toBe('escalate');
  });

  it('honours length, emoji and banned phrase settings', () => {
    const long = raw({ parts: ['Delivery is 2 to 4 days. It is free in the UK. We ship every weekday. You get tracking by email. It comes in one box.'] });
    const d = enforce(long, ask, settings({ max_sentences: 2, max_chars: 80 }), {}, long.parts[0]!);
    expect(d.parts.join(' ').length).toBeLessThanOrEqual(80);
    expect(enforce(raw({ parts: ['2 to 4 days 🔥🔥🔥'] }), ask, settings({ emojis: 'never' })).parts[0]).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(enforce(raw({ parts: ['no worries delivery is 2 to 4 days'] }), ask, settings({ banned_phrases: ['no worries'] })).parts[0]).not.toMatch(/no worries/i);
  });

  it('sends one short email on gmail', () => {
    const d = enforce(raw({ parts: ['Hi Margaret,', 'Delivery takes 2 to 4 working days.', 'ACX Ebikes'] }), [inMsg('Dear team, how long is delivery? Regards, Margaret')], settings(), { channel: 'gmail' });
    expect(d.parts).toHaveLength(1);
    expect(d.parts[0]).toContain('2 to 4 working days');
    expect(violations(d.parts[0]!)).toEqual([]);
  });

  it('escalates when nothing sendable is left, and sends nothing on ignore', () => {
    const d = enforce(raw({ parts: ['I hope this helps!'] }), ask);
    expect(d.action).toBe('escalate');
    expect(d.parts).toEqual([]);
    expect(enforce(raw({ action: 'ignore', parts: ['x'] }), ask).parts).toEqual([]);
  });

  it('leaves the mock brain triggers intact', () => {
    const tone = analyzeTone(ask).profile;
    for (const [text, action] of [['unknown-question x', 'escalate'], ['ignore-me', 'ignore'], ['two-parts', 'reply'], ['are you a bot', 'reply'], ['stop', 'reply']] as const) {
      const history = [inMsg(text)];
      const m = mockDecide(input(history), tone);
      const d = enforce({ action: m.action, parts: m.parts, confidence: m.confidence, escalate: m.escalate, flags: m.flags, kb_refs: [], note: m.note, language: 'en' }, history, settings(), {}, m.parts.join('\n'));
      expect(d.action).toBe(action);
      expect(d.parts.length).toBe(m.parts.length);
    }
  });
});

// ---- polish ---------------------------------------------------------------------------------------

function polishInput(over: Partial<PolishInput> = {}): PolishInput {
  return { channel: 'whatsapp', contact_name: 'Jake', question: 'does the 1000w kit fit a 20 inch wheel', owner_answer: 'no smallest is 26 inch', history: [inMsg('yo does the 1000w kit fit a 20 inch wheel')], now: NOW, ...over };
}

describe('polish', () => {
  it('builds a prompt whose system block does not depend on the conversation', () => {
    const one = buildPolishPrompt({ settings: settings(), input: polishInput(), tone: analyzeTone(polishInput().history).profile, plan: mirrorPlan(analyzeTone(polishInput().history).profile), toneNotes: [] });
    const other = polishInput({ owner_answer: 'yes it ships tuesday', question: 'when does my order ship', contact_name: 'Sam' });
    const two = buildPolishPrompt({ settings: settings(), input: other, tone: analyzeTone(other.history).profile, plan: mirrorPlan(analyzeTone(other.history).profile), toneNotes: [] });
    expect(one.system).toEqual(two.system);
    expect(one.system[0]!.cache).toBe(true);
    expect(one.user).toContain('<owner_answer>\nno smallest is 26 inch\n</owner_answer>');
    expect(one.system[0]!.text).toMatch(/add none/);
  });

  it('accepts a faithful rewrite with a reusable fact', () => {
    const r = validatePolish({ parts: ['nah bro smallest wheel is 26 inch'], general: true, learned_title: 'Does the 1000W kit fit a 20 inch wheel?', learned_content: 'No. The smallest wheel size is 26 inch.' }, polishInput());
    expect(r).toEqual({ parts: ['nah bro smallest wheel is 26 inch'], learned: { title: 'Does the 1000W kit fit a 20 inch wheel?', content: 'No. The smallest wheel size is 26 inch.' } });
  });

  it('returns no fact for an answer about one customer', () => {
    const r = validatePolish({ parts: ['its going out tuesday'], general: false, learned_title: 'When does it ship', learned_content: 'Tuesday' }, polishInput({ owner_answer: 'going out tuesday' }));
    expect(r!.learned).toBeNull();
    expect(validatePolish({ parts: ['ok'], general: true, learned_title: '', learned_content: '' }, polishInput())!.learned).toBeNull();
  });

  it('rejects a rewrite that adds a figure, claims to be human or is empty', () => {
    expect(validatePolish({ parts: ['no smallest is 26 inch and it costs £499'], general: false, learned_title: '', learned_content: '' }, polishInput())).toBeNull();
    expect(validatePolish({ parts: ["I'm a real person and no it does not"], general: false, learned_title: '', learned_content: '' }, polishInput())).toBeNull();
    expect(validatePolish({ parts: [], general: false }, polishInput())).toBeNull();
    expect(validatePolish('garbage', polishInput())).toBeNull();
    // A fact with a figure the owner never gave is dropped, the reply itself is kept.
    const r = validatePolish({ parts: ['no smallest is 26 inch'], general: true, learned_title: 'Wheel sizes', learned_content: 'Smallest wheel is 26 inch, largest 29 inch, 3 year warranty.' }, polishInput());
    expect(r!.parts).toEqual(['no smallest is 26 inch']);
    expect(r!.learned).toBeNull();
  });
});

// ---- small helpers --------------------------------------------------------------------------------

describe('figures', () => {
  it('compares numbers without thousands separators', () => {
    expect(numbersIn('£1,299.00 for the 72v, 2 to 4 days.')).toEqual(['1299', '72', '2', '4']);
    expect(numbersIn('15.5mph, 0.5 kg, 1,000,000')).toEqual(['15.5', '0.5', '1000000']);
    expect(unsupportedNumbers('12 months and 30 days', 'a twelve month warranty, thirty day returns')).toEqual([]);
    expect(unsupportedNumbers('that is £1299 and 72v', 'ACX 72V pack £1,299')).toEqual([]);
    expect(unsupportedNumbers('about 35 mph', 'top speed is not stated')).toEqual(['35']);
    expect(unsupportedNumbers('3 days', '')).toEqual([]);
  });
});

describe('recovery template helpers', () => {
  const style = { voice: { ...DEFAULT_SETTINGS.voice, max_chars: 700, max_sentences: 6 }, tone: { ...analyzeTone([]).profile, register: 'casual' as const }, channel: 'whatsapp' as const };

  it('maps the ways people write placeholders onto the real variables', () => {
    expect(normalizePlaceholders('hey [name] you left {{ product }} ({Total}) <link> at {shop_name} {} {weird}')).toBe('hey {first_name} you left {product} ({total}) {checkout_link} at {shop}  ');
    expect(normalizePlaceholders('see [this] and 3 < 4 > 2')).toBe('see [this] and 3 < 4 > 2');
  });

  it('applies the style rules without touching the variables', () => {
    const out = sanitizeTemplate('Hey {first_name} — you left {product} behind - want it? {checkout_link}', style);
    expect(out).toContain('{first_name}');
    expect(out).toContain('{product}');
    expect(out).toContain('{checkout_link}');
    expect(out).not.toMatch(/[‒-―]| - /);
  });
});

// ---- provider layer -------------------------------------------------------------------------------

function fakeEnv(opts: { secret?: string; envKey?: string; ai?: boolean; test?: boolean }): Env {
  const db = { prepare: () => ({ bind: () => ({ first: async () => (opts.secret ? { value: opts.secret } : null) }) }) };
  return { DB: db as unknown as D1Database, ASSETS: {} as Fetcher, AI: opts.ai ? ({} as Ai) : undefined, ACX_TEST_MODE: opts.test ? '1' : undefined, ANTHROPIC_API_KEY: opts.envKey };
}

describe('chooseProvider', () => {
  it('uses the mock in test mode whatever is configured', async () => {
    expect((await chooseProvider(fakeEnv({ test: true, secret: 'sk-x', ai: true }), settings())).provider).toBe('mock');
  });

  it('prefers Claude when a key is saved, from the dashboard or the environment', async () => {
    expect(await chooseProvider(fakeEnv({ secret: 'sk-saved', ai: true }), settings())).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-saved' });
    expect((await chooseProvider(fakeEnv({ envKey: 'sk-env' }), settings())).apiKey).toBe('sk-env');
    expect((await chooseProvider(fakeEnv({ secret: 'sk-saved' }), settings({}, { model: 'claude-haiku-5-5' }))).model).toBe('claude-haiku-5-5');
  });

  it('falls back to Workers AI without a key, and honours a forced provider', async () => {
    expect(await chooseProvider(fakeEnv({ ai: true }), settings())).toEqual({ provider: 'workers_ai', model: DEFAULT_SETTINGS.brain.workers_ai_model, apiKey: null });
    expect((await chooseProvider(fakeEnv({ secret: 'sk-saved', ai: true }), settings({}, { provider: 'workers_ai' }))).provider).toBe('workers_ai');
    expect((await chooseProvider(fakeEnv({ secret: 'sk-saved', ai: true }), settings({}, { provider: 'anthropic' }))).provider).toBe('anthropic');
  });

  it('fails clearly when nothing is connected', async () => {
    await expect(chooseProvider(fakeEnv({}), settings())).rejects.toMatchObject({ code: 'no_provider' });
    await expect(chooseProvider(fakeEnv({ secret: 'sk' }), settings({}, { provider: 'workers_ai' }))).rejects.toBeInstanceOf(LlmError);
    await expect(chooseProvider(fakeEnv({ ai: true }), settings({}, { provider: 'anthropic' }))).rejects.toMatchObject({ code: 'no_provider' });
  });

  it('asks for refusal fallbacks on Opus and Sonnet but not Haiku', () => {
    expect(supportsFallbacks('claude-opus-5-5')).toBe(true);
    expect(supportsFallbacks('claude-sonnet-5-5')).toBe(true);
    expect(supportsFallbacks('claude-haiku-5-5')).toBe(false);
  });

  it('gives small Workers AI models a smaller share of knowledge', () => {
    expect(knowledgeBudget({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k' })).toBeGreaterThan(1_000_000);
    expect(knowledgeBudget({ provider: 'workers_ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', apiKey: null })).toBeLessThan(12_000);
    expect(knowledgeBudget({ provider: 'workers_ai', model: '@cf/google/gemma-4-26b-a4b-it', apiKey: null })).toBeGreaterThan(50_000);
  });
});

describe('Workers AI output handling', () => {
  it('reads both response shapes', () => {
    expect(readWorkersAiResponse({ choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } })).toEqual({ content: '{"a":1}', input_tokens: 10, output_tokens: 3 });
    expect(readWorkersAiResponse({ response: '{"a":1}' }).content).toBe('{"a":1}');
    expect(readWorkersAiResponse({ response: { a: 1 }, usage: { prompt_tokens: 5 } })).toEqual({ content: { a: 1 }, input_tokens: 5, output_tokens: 0 });
    expect(readWorkersAiResponse({ result: { response: 'x' } }).content).toBe('x');
    expect(readWorkersAiResponse(null).content).toBe('');
  });

  it('parses JSON tolerantly', () => {
    expect(parseLooseJson({ a: 1 })).toEqual({ a: 1 });
    expect(parseLooseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseLooseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseLooseJson('Sure! Here it is:\n{"a":{"b":"x } y"},"c":[1,2,],}\nHope that helps')).toEqual({ a: { b: 'x } y' }, c: [1, 2] });
    expect(parseLooseJson('no json here')).toBeUndefined();
    expect(parseLooseJson('"just a string"')).toBeUndefined();
    expect(parseLooseJson('{"a": ')).toBeUndefined();
    expect(parseLooseJson(undefined)).toBeUndefined();
  });
});

// ---- the Claude request itself (network stubbed) ---------------------------------------------------


/** A D1 stand in: no settings rows (defaults apply), one saved API key, and a log of every write. */
function fakeDb(writes: { sql: string; args: unknown[] }[]): D1Database {
  const prepare = (sql: string) => {
    const bound = (args: unknown[]) => ({
      first: async () => (sql.includes('FROM secrets') ? { value: 'sk-ant-test' } : null),
      all: async () => ({ results: [] }),
      run: async () => { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
    });
    return { bind: (...args: unknown[]) => bound(args), ...bound([]) };
  };
  return { prepare } as unknown as D1Database;
}

function claudeReply(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
}

const okMessage = (text: string, extra: Record<string, unknown> = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text }],
  usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }, ...extra,
});

describe('callJson with Claude', () => {
  afterEach(() => vi.unstubAllGlobals());

  const call = async (reply: () => Response, model = 'claude-opus-5-5') => {
    const writes: { sql: string; args: unknown[] }[] = [];
    const requests: { url: string; headers: Headers; body: any }[] = [];
    vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
      // The SDK may hand over a ready made Request or a url plus init.
      const req = new Request(url as RequestInfo, init);
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse((await req.text()) || '{}') });
      return reply();
    });
    const env: Env = { DB: fakeDb(writes), ASSETS: {} as Fetcher };
    const run = callJson<{ ok: boolean }>(env, {
      purpose: 'decide', schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      system: [{ text: 'instructions' }, { text: 'knowledge', cache: true }, { text: '   ' }], user: 'conversation',
      choice: { provider: 'anthropic', model, apiKey: 'sk-ant-test' },
    });
    return { run, writes, requests };
  };

  it('sends structured output, effort, a cache breakpoint and refusal fallbacks, and never a temperature', async () => {
    const { run, writes, requests } = await call(() => claudeReply(okMessage('{"ok":true}')));
    const res = await run;
    expect(res.data).toEqual({ ok: true });
    expect(res.usage).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', input_tokens: 1200, output_tokens: 80, cache_read_tokens: 900, cache_write_tokens: 0 });

    expect(requests).toHaveLength(1);
    const { body, headers, url } = requests[0]!;
    expect(url).toContain('/v1/messages');
    expect(headers.get('authorization')).toBe('Bearer sk-ant-test');
    expect(Number(headers.get('x-stainless-timeout'))).toBeLessThanOrEqual(60); // seconds: never the 10 minute default
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.fallbacks).toBe('default');
    expect(body.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: expect.objectContaining({ additionalProperties: false }) } });
    expect(body.system).toEqual([{ type: 'text', text: 'instructions' }, { type: 'text', text: 'knowledge', cache_control: { type: 'ephemeral' } }]);
    expect(body.messages).toEqual([{ role: 'user', content: 'conversation' }]);
    for (const banned of ['temperature', 'top_p', 'top_k', 'thinking', 'betas']) expect(body).not.toHaveProperty(banned);

    const usage = writes.find((w) => w.sql.includes('llm_usage'))!;
    expect(usage.args.slice(1, 4)).toEqual(['anthropic', 'claude-opus-5-5', 'decide']);
    expect(usage.args[usage.args.length - 1]).toBe(1);
  });

  it('does not ask for fallbacks on Haiku', async () => {
    const { run, requests } = await call(() => claudeReply(okMessage('{"ok":true}', { model: 'claude-haiku-5-5' })), 'claude-haiku-5-5');
    await run;
    expect(requests[0]!.body).not.toHaveProperty('fallbacks');
    expect(requests[0]!.headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
    expect(requests[0]!.body.output_config.format.type).toBe('json_schema');
  });

  it('treats a refusal as its own error and records the failed call', async () => {
    const { run, writes } = await call(() => claudeReply(okMessage('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' }, content: [] })));
    await expect(run).rejects.toMatchObject({ code: 'refusal', retryable: false });
    const usage = writes.find((w) => w.sql.includes('llm_usage'))!;
    expect(usage.args[usage.args.length - 1]).toBe(0);
  });

  it('maps API errors to stable codes', async () => {
    const err = (status: number, type: string) => () => claudeReply({ type: 'error', error: { type, message: 'nope' } }, status);
    await expect((await call(err(401, 'authentication_error'))).run).rejects.toMatchObject({ code: 'auth', retryable: false });
    await expect((await call(err(404, 'not_found_error'))).run).rejects.toMatchObject({ code: 'not_found' });
    await expect((await call(err(400, 'invalid_request_error'))).run).rejects.toMatchObject({ code: 'bad_request' });
    await expect((await call(() => claudeReply(okMessage('{"ok":', { stop_reason: 'max_tokens' })))).run).rejects.toMatchObject({ code: 'truncated' });
    await expect((await call(() => claudeReply(okMessage('not json at all')))).run).rejects.toMatchObject({ code: 'bad_output' });
  });

  it('retries a rate limit once and then reports it as retryable', async () => {
    const { run, requests } = await call(() => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } }));
    await expect(run).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
    expect(requests).toHaveLength(2); // maxRetries is 1
  });
});

describe('callJson with Workers AI', () => {
  const schema = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  const run = async (model: string, replies: unknown[]) => {
    const calls: { model: string; body: any }[] = [];
    const writes: { sql: string; args: unknown[] }[] = [];
    const ai = { run: async (m: string, body: unknown) => { calls.push({ model: m, body }); const r = replies.shift(); if (r instanceof Error) throw r; return r; } };
    const env: Env = { DB: fakeDb(writes), ASSETS: {} as Fetcher, AI: ai as unknown as Ai };
    const result = callJson<{ ok: boolean }>(env, { purpose: 'decide', schema, system: [{ text: 'instructions' }], user: 'conversation', choice: { provider: 'workers_ai', model, apiKey: null } });
    return { result, calls, writes };
  };

  it('speaks the legacy shape to older models and reads `response`', async () => {
    const { result, calls } = await run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', [{ response: { ok: true }, usage: { prompt_tokens: 50, completion_tokens: 5 } }]);
    expect((await result).data).toEqual({ ok: true });
    expect(calls[0]!.body.max_tokens).toBeGreaterThan(0);
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_schema', json_schema: schema });
    expect(calls[0]!.body.messages[0].content).toContain('Reply with one JSON object');
  });

  it('speaks the chat completions shape to newer models and reads `choices`', async () => {
    const { result, calls } = await run('@cf/google/gemma-4-26b-a4b-it', [{ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }], usage: { prompt_tokens: 50, completion_tokens: 5 } }]);
    const res = await result;
    expect(res.data).toEqual({ ok: true });
    expect(res.usage).toMatchObject({ provider: 'workers_ai', input_tokens: 50, output_tokens: 5 });
    expect(calls[0]!.body.max_completion_tokens).toBeGreaterThan(0);
    expect(calls[0]!.body.response_format.json_schema).toEqual({ name: 'answer', strict: true, schema });
    expect(calls[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('asks once more when the answer is not JSON, then gives up', async () => {
    const fixed = await run('@cf/google/gemma-4-26b-a4b-it', [{ choices: [{ message: { content: 'Sure thing!' } }] }, { choices: [{ message: { content: '{"ok":false}' } }] }]);
    expect((await fixed.result).data).toEqual({ ok: false });
    expect(fixed.calls).toHaveLength(2);
    expect(fixed.calls[1]!.body.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);

    const broken = await run('@cf/google/gemma-4-26b-a4b-it', [{ choices: [{ message: { content: 'nope' } }] }, { choices: [{ message: { content: 'still nope' } }] }]);
    await expect(broken.result).rejects.toMatchObject({ code: 'bad_output' });
    expect(broken.calls).toHaveLength(2);
    expect(broken.writes.find((w) => w.sql.includes('llm_usage'))!.args.at(-1)).toBe(0);
  });

  it('falls back to plain mode when JSON mode cannot be met', async () => {
    const { result, calls } = await run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', [new Error("JSON Mode couldn't be met"), { response: '{"ok":true}' }]);
    expect((await result).data).toEqual({ ok: true });
    expect(calls[1]!.body.response_format).toBeUndefined();
  });
});

describe('media and serious topics', () => {
  it('has an honest line for things it cannot open', () => {
    expect(mediaHoldingLine(['voice'], 'en')).toMatch(/can't play voice notes/);
    expect(mediaHoldingLine(['image'], 'en')).toMatch(/take a look/);
    expect(mediaHoldingLine(['voice', 'image'], 'en')).toMatch(/take a look/);
    expect(mediaHoldingLine(['voice'], 'fr')).toBe(holdingLine('fr'));
    expect(holdingLine('xx')).toBe(holdingLine('en'));
  });

  it('stops mirroring on refunds, complaints and safety', () => {
    expect(seriousTopic([inMsg('yo bro can i get a refund on the battery')])).toBe(true);
    expect(seriousTopic([inMsg('yo bro how fast is the 5000w')])).toBe(false);
    const history = [inMsg('yooo brooo i want my money back')];
    const d = enforce(raw({ parts: ['Yeah no problem. You have 14 days.'] }), history, settings(), {}, '14 days');
    expect(d.parts[0]).toMatch(/^Yeah/); // capitals kept although the customer writes lower case
  });
});

describe('stored placeholders for media', () => {
  it('are not mistaken for something the customer wrote', () => {
    const voice = inMsg('[sent a voice note]', 'voice');
    const photo = inMsg('will it fit this', 'image');
    expect(pendingInbound([voice]).some((m) => knowledgeQuery(input([m])) !== '')).toBe(false);
    expect(knowledgeQuery(input([voice, photo]))).toBe('will it fit this');
    expect(renderConversation([voice, photo], NOW)).toBe('customer: [voice note]\ncustomer: [photo] will it fit this');
    // Typed text that merely looks like the placeholder is still text.
    expect(knowledgeQuery(input([inMsg('[sent a voice note]')]))).toBe('[sent a voice note]');
  });
});
