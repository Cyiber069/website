import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkFollowUp, fallbackFollowUp } from '../../src/brain/followup';
import { cheapChoice } from '../../src/brain/llm';
import { MOCK_PRODUCT, mockDecide } from '../../src/brain/mock';
import { DECISION_SCHEMA, decideInstructions, ownerRules, renderConversation, validateDecision, validateSales, type RawDecision } from '../../src/brain/prompt';
import { confidentHoldingLine, enforceDecision, inventedLinks, isShopping, knowledgeQuery, productLink, soundsUnsure } from '../../src/brain/rules';
import { analyzeTone } from '../../src/brain/tone';
import { buildProductPicker } from '../../src/kb/picker';
import { DEFAULT_SETTINGS } from '../../src/lib/settings';
import { londonDateTimeToTs } from '../../src/lib/time';
import { orderFacts } from '../../src/sales/conversions';
import { checkSalesPatch, insideSendingHours, salesSettings } from '../../src/sales';
import { nextStage } from '../../src/sales/leads';
import type { DecideInput, HistoryMessage, Settings } from '../../src/types';

const NOW = 1_794_700_000_000;
const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });
const inMsg = (body: string): HistoryMessage => ({ direction: 'in', author: 'customer', body, kind: 'text', ts: NOW });
const outMsg = (body: string): HistoryMessage => ({ direction: 'out', author: 'agent', body, kind: 'text', ts: NOW - 60_000 });
const input = (history: HistoryMessage[], extra: Partial<DecideInput> = {}): DecideInput =>
  ({ channel: 'whatsapp', contact_name: 'Jake', subject: null, history, context_notes: [], now: NOW, mode: 'live', ...extra });
const raw = (over: Partial<RawDecision> = {}): RawDecision => ({
  action: 'reply', parts: ['delivery is 2 to 4 days'], confidence: 0.9, escalate: null,
  flags: { opt_out: false, asked_if_bot: false, needs_human: false }, kb_refs: [], note: 'ok', ...over,
});
const KNOWLEDGE = 'ACX 2000w bundle: £595.00 to £729.00. Link: https://acxebikes.com/products/acx-2000w-bundle\nUK delivery takes 2 to 4 days.';
function enforce(d: RawDecision, history: HistoryMessage[], sources = KNOWLEDGE, s = settings()) {
  return enforceDecision(d, { settings: s, input: input(history), tone: analyzeTone(history).profile, sources: `${sources}\n${renderConversation(history, NOW)}` });
}

describe('sales playbook in the prompt', () => {
  const text = decideInstructions(settings());
  it('teaches the whole playbook and keeps the old rules', () => {
    expect(text).toContain('<selling>');
    expect(text).toMatch(/ask one short question at a time/);
    expect(text).toMatch(/wheel size/);
    expect(text).toMatch(/road legal or off road, their budget/);
    expect(text).toMatch(/Recommend one product/);
    expect(text).toMatch(/Never write a link that is not in the knowledge/);
    expect(text).toMatch(/This is the one, you can grab it here/);
    expect(text).toMatch(/Never more than one extra/);
    expect(text).toMatch(/No made up urgency, no stock levels/);
    expect(text).toMatch(/If the customer is angry, complaining or has a problem with an order, do not sell at all/);
    expect(text).toMatch(/asks about a sponsorship, working with us or their own creator code gets the sponsorship offer/);
    // The rules that were there before are all still there.
    expect(text).toMatch(/You are not a person and you never say or suggest that you are/);
    expect(text).toMatch(/Escalating is a normal and correct result/);
    expect(text).toMatch(/Never use a dash of any kind/);
    expect(text).toMatch(/Match the customer, one notch calmer/);
    expect(text).not.toMatch(/[‐-―]/);
  });

  it('tells the model to sound confident and to treat parts of a kit they own as product support', () => {
    expect(text).toMatch(/It sounds confident and helpful, never unsure/);
    expect(text).toMatch(/Never write "I'm not sure about that one"/);
    expect(text).toMatch(/When the knowledge answers part of it, answer that part/);
    expect(text).toMatch(/escalate with category product_support and put the customer's own description of the part/);
  });

  it('has selling examples whose links are examples, and a sales field in every example answer', () => {
    const answers = [...text.matchAll(/<output>\n(\{.*\})\n<\/output>/g)].map((m) => JSON.parse(m[1]!));
    expect(answers).toHaveLength(14);
    for (const a of answers) {
      expect(Object.keys(a)).toEqual(Object.keys((DECISION_SCHEMA as any).properties));
      expect(validateSales(a.sales)).not.toBeNull();
    }
    expect(answers.filter((a) => a.parts.some((p: string) => /https:\/\/shop\.example\/products\//.test(p)))).toHaveLength(2);
    expect(answers.some((a) => a.escalate?.category === 'product_support')).toBe(true);
  });

  it('adds the owner chosen sales style to the owner rules only when it is not the default', () => {
    expect(ownerRules(settings())).toBe('');
    expect(ownerRules(settings({ sales: { ...DEFAULT_SETTINGS.sales, style: 'relaxed' } }))).toMatch(/Sales style relaxed/);
    expect(ownerRules(settings({ sales: { ...DEFAULT_SETTINGS.sales, style: 'keen' } }))).toMatch(/always end with the product link/);
    // The cached first block never changes with the style.
    expect(decideInstructions(settings({ sales: { ...DEFAULT_SETTINGS.sales, style: 'keen' } }))).toBe(decideInstructions(settings()));
  });
});

describe('sales read validation', () => {
  const good = { note: 'n', kb_refs: [], action: 'reply', escalate: null, flags: { opt_out: false, asked_if_bot: false, needs_human: false }, parts: ['hi'], confidence: 0.9 };
  it('reads a valid sales object', () => {
    expect(validateDecision({ ...good, sales: { stage: 'ready', product: 'ACX 2000w bundle' } }, [], 'x').sales).toEqual({ stage: 'ready', product: 'ACX 2000w bundle' });
    expect(validateDecision({ ...good, sales: { stage: 'Interested', product: null } }, [], 'x').sales).toEqual({ stage: 'interested', product: null });
  });
  it('is optional and never breaks a decision', () => {
    expect(validateDecision(good, [], 'x').sales).toBeNull();
    expect(validateDecision({ ...good, sales: 'ready' }, [], 'x').sales).toBeNull();
    expect(validateDecision({ ...good, sales: { stage: 'hot', product: 'x' } }, [], 'x').sales).toBeNull();
    expect(validateDecision({ ...good, sales: { stage: 'browsing', product: 'none' } }, [], 'x').sales).toEqual({ stage: 'browsing', product: null });
    expect(validateDecision({ ...good, sales_stage: 'support' }, [], 'x').sales).toEqual({ stage: 'support', product: null });
    expect(validateDecision({ ...good, sales: { stage: 'ready', product: 'x'.repeat(500) } }, [], 'x').sales!.product).toHaveLength(120);
    expect(validateDecision({ ...good, sales: { stage: 'ready' } }, [], 'x').action).toBe('reply');
  });
  it('lists the stages in the schema', () => {
    expect((DECISION_SCHEMA as any).properties.sales.properties.stage.enum).toEqual(['browsing', 'interested', 'ready', 'bought', 'support', 'none']);
  });
});

describe('never sounding unsure', () => {
  const PHRASES = [
    "I'm not sure about that one", 'not sure tbh', 'im unsure', 'I don’t know', 'dont know sorry', 'no idea mate', "can't say for certain", 'I cannot say',
    "I'm not certain", "I'm not able to check that", "I can't help with that", "I'm unable to see orders", "that's beyond my knowledge",
    "I don't have that info", "we don't have information on that", 'NOT SURE', 'Im not able to',
  ];
  it('spots every phrase, any case and apostrophe', () => {
    for (const p of PHRASES) expect(soundsUnsure(p), p).toBe(true);
    for (const p of ['let me check that for you', 'sure thing', 'make sure the battery is off', 'you know what i mean', 'I can help with that']) expect(soundsUnsure(p), p).toBe(false);
  });

  it('turns an unsure reply into a question for the owner with a confident holding line', () => {
    const h = [inMsg('Nah I already have a kit but there is another box under the controller and I think its a cable / Management box')];
    for (const phrase of PHRASES) {
      const d = enforce(raw({ parts: [phrase] }), h);
      expect(d.action, phrase).toBe('escalate');
      expect(d.escalate!.category).toBe('unknown_fact');
      expect(d.escalate!.question).toContain('another box under the controller');
      expect(d.parts).toHaveLength(1);
      expect(soundsUnsure(d.parts[0]!)).toBe(false);
      expect(d.parts[0]).toMatch(/check|find out/i);
    }
  });

  it('replaces an unsure holding line and drops an unsure known part', () => {
    const h = [inMsg('what is the little box near the motor')];
    const esc = { question: 'q', reason: 'r', category: 'unknown_fact' };
    for (const phrase of PHRASES) {
      const d = enforce(raw({ action: 'escalate', escalate: esc, parts: [phrase] }), h);
      expect(d.parts).toHaveLength(1);
      expect(soundsUnsure(d.parts[0]!), phrase).toBe(false);
    }
    const two = enforce(raw({ action: 'escalate', escalate: esc, parts: ['no idea on that one', 'let me check'] }), h);
    expect(two.parts).toEqual(['Let me check']);
  });

  it('varies the confident line a little and stays plain for upset customers', () => {
    const tone = analyzeTone([inMsg('yo')]).profile;
    const lines = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((s) => confidentHoldingLine(tone, s)));
    expect(lines.size).toBeGreaterThan(1);
    for (const l of lines) expect(l).not.toMatch(/team is (not sure|unsure)|minutes|hours|today/);
    expect(confidentHoldingLine({ ...tone, mood: 'angry' }, 'x')).toMatch(/^I'm passing this to the team now/);
  });
});

describe('selling rules in code', () => {
  it('keeps the known part of an answer next to the holding line', () => {
    const h = [inMsg('how much is the 2000w bundle and what is the box with 3 wires under my controller')];
    const esc = { question: 'q', reason: 'r', category: 'product_support' };
    const d = enforce(raw({ action: 'escalate', escalate: esc, parts: ['the 2000w bundle is from £595 https://acxebikes.com/products/acx-2000w-bundle', 'leave it with me on the box'] }), h);
    expect(d.parts).toHaveLength(2);
    expect(d.parts[0]).toContain('https://acxebikes.com/products/acx-2000w-bundle');
    // A made up figure in the known part drops it, the holding line stays.
    const bad = enforce(raw({ action: 'escalate', escalate: esc, parts: ['the 2000w bundle is £499', 'leave it with me on the box'] }), h);
    expect(bad.parts).toHaveLength(1);
    expect(bad.parts[0]).toMatch(/^Leave it with me/);
  });

  it('never sends a link that is not in the knowledge', () => {
    const h = [inMsg('which kit for my mountain bike')];
    const made = enforce(raw({ parts: ['this one https://acxebikes.com/products/acx-mega-monster'] }), h);
    expect(made.flags.needs_human).toBe(true);
    expect(made.confidence).toBeLessThanOrEqual(0.3);
    expect(made.escalate!.reason).toMatch(/link that is not in the knowledge/);
    const real = enforce(raw({ parts: ['this is the one you can grab it here https://acxebikes.com/products/acx-2000w-bundle'] }), h);
    expect(real.flags.needs_human).toBe(false);
    expect(real.parts.join(' ')).toContain('https://acxebikes.com/products/acx-2000w-bundle');
    expect(inventedLinks('see acxebikes.com/products/acx-2000w-bundle.', KNOWLEDGE)).toEqual([]);
    expect(productLink('grab it here https://acxebikes.com/products/acx-2000w-bundle.')).toBe('https://acxebikes.com/products/acx-2000w-bundle');
  });

  it('never treats an upset customer as a lead', () => {
    const h = [inMsg('this is a joke my kit STILL has not come I want a refund')];
    const d = enforce(raw({ action: 'escalate', escalate: { question: 'q', reason: 'r', category: 'complaint' }, parts: ['sorry about that'], sales: { stage: 'ready', product: 'x' } }), h);
    expect(d.sales!.stage).toBe('support');
    const shop = enforce(raw({ parts: ['the bundle fits https://acxebikes.com/products/acx-2000w-bundle'], sales: { stage: 'browsing', product: null } }), [inMsg('what kit for my bike')]);
    expect(shop.sales!.stage).toBe('interested');
  });

  it('knows when the customer is shopping and searches the product entries then', () => {
    expect(isShopping(input([inMsg('how much is the 2000w')]))).toBe(true);
    expect(isShopping(input([inMsg('which kit for a 26 inch mountain bike')]))).toBe(true);
    expect(isShopping(input([inMsg('my kit is broken i want a refund')]))).toBe(false);
    expect(isShopping(input([inMsg('hi')]))).toBe(false);
    expect(knowledgeQuery(input([inMsg('want something fast for the woods')]))).toMatch(/bundle kit battery price$/);
    expect(knowledgeQuery(input([inMsg('hello there')]))).toBe('hello there');
  });

  it('moves stages forward and never wipes a live lead with small talk', () => {
    expect(nextStage(null, 'interested')).toBe('interested');
    expect(nextStage('interested', 'none')).toBeNull();
    expect(nextStage('ready', 'browsing')).toBeNull();
    expect(nextStage('interested', 'ready')).toBe('ready');
    expect(nextStage('ready', 'support')).toBe('support');
    expect(nextStage('browsing', 'none')).toBeNull();
    expect(nextStage(null, null)).toBeNull();
  });
});

describe('mock brain sales values', () => {
  const tone = analyzeTone([inMsg('yo')]).profile;
  it('gives deterministic stages for the tests', () => {
    expect(mockDecide(input([inMsg('shop-ready')]), tone).sales).toEqual({ stage: 'ready', product: MOCK_PRODUCT.title });
    expect(mockDecide(input([inMsg('shop-interested')]), tone).parts[0]).toContain(MOCK_PRODUCT.link);
    expect(mockDecide(input([inMsg('shop-browse')]), tone).sales!.stage).toBe('browsing');
    expect(mockDecide(input([inMsg('my kit is broken')]), tone).sales!.stage).toBe('support');
    expect(mockDecide(input([inMsg('just ordered it')]), tone).sales!.stage).toBe('bought');
    expect(mockDecide(input([inMsg('yo how long is delivery')]), tone).sales!.stage).toBe('none');
    expect(mockDecide(input([inMsg('unsure-reply')]), tone).parts).toEqual(["I'm not sure about that one"]);
  });
});

describe('product picker', () => {
  const productsMd = readFileSync(new URL('../../seed/knowledge/products.md', import.meta.url), 'utf8');
  const picker = buildProductPicker(productsMd);
  const lines = picker.split('\n').filter((l) => l.includes('Link: '));
  it('lists every product with its real price and link', () => {
    expect(lines).toHaveLength(35);
    expect(picker).toContain('ACX 2000w bundle: £595.00 to £729.00. in Bundles.');
    expect(picker).toContain('Link: https://acxebikes.com/products/acx-2000w-bundle');
    expect(picker).toContain('battery bag: £45.00. in Accessories. options size: small, large. Link: https://acxebikes.com/products/battery-bag');
    for (const l of lines) expect(l).toMatch(/Link: https:\/\/acxebikes\.com\/products\/[a-z0-9-]+$/);
    // Every link is in the catalogue itself.
    for (const l of lines) expect(productsMd).toContain(l.split('Link: ')[1]!);
  });
});

describe('follow up text', () => {
  const tone = analyzeTone([inMsg('yo which kit')]).profile;
  const fu = { channel: 'whatsapp' as const, contact_name: 'Jake', history: [inMsg('yo which kit'), outMsg(`grab it here ${MOCK_PRODUCT.link}`)], product: MOCK_PRODUCT.title, link: MOCK_PRODUCT.link, tone };
  it('has a fallback that passes its own checks', () => {
    const line = fallbackFollowUp(fu);
    expect(line).toContain(MOCK_PRODUCT.link);
    const parts = checkFollowUp(line, fu, settings());
    expect(parts).not.toBeNull();
    expect(parts!.join(' ')).toContain(MOCK_PRODUCT.link);
    expect(parts!.join(' ')).not.toMatch(/[–—]/);
  });
  it('refuses text with a made up figure, a made up link, doubt or pressure words dressed as facts', () => {
    expect(checkFollowUp('only 2 left at £499 grab it now', fu, settings())).toBeNull();
    expect(checkFollowUp('have a look https://acxebikes.com/products/other-thing', fu, settings())).toBeNull();
    expect(checkFollowUp("not sure if you're still keen", fu, settings())).toBeNull();
    expect(checkFollowUp("I'm a real person just checking in", fu, settings())).toBeNull();
    expect(checkFollowUp('hey still thinking about the 2000w bundle? any questions just ask', fu, settings())).not.toBeNull();
  });
  it('uses the cheapest Claude model for it', () => {
    expect(cheapChoice({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'k' }).model).toMatch(/haiku/);
    expect(cheapChoice({ provider: 'workers_ai', model: '@cf/x', apiKey: null }).model).toBe('@cf/x');
  });
});

describe('sales settings and timing', () => {
  it('clamps settings and checks patches', () => {
    expect(salesSettings(settings())).toEqual({ follow_ups: true, follow_up_hours: 20, style: 'friendly' });
    expect(salesSettings({ sales: { follow_ups: true, follow_up_hours: 500, style: 'pushy' as any } })).toEqual({ follow_ups: true, follow_up_hours: 72, style: 'friendly' });
    expect(checkSalesPatch({ follow_ups: false, follow_up_hours: 24, style: 'keen', other: 1 })).toEqual({ follow_ups: false, follow_up_hours: 24, style: 'keen' });
    expect(() => checkSalesPatch({ follow_up_hours: 0 })).toThrow();
    expect(() => checkSalesPatch({ style: 'pushy' })).toThrow();
  });
  it('only sends between 10:00 and 20:00 UK time, summer and winter', () => {
    expect(insideSendingHours(londonDateTimeToTs('2026-07-01', 9, 59))).toBe(false);
    expect(insideSendingHours(londonDateTimeToTs('2026-07-01', 10, 0))).toBe(true);
    expect(insideSendingHours(londonDateTimeToTs('2026-12-01', 19, 59))).toBe(true);
    expect(insideSendingHours(londonDateTimeToTs('2026-12-01', 20, 0))).toBe(false);
  });
  it('reads an order webhook into phones, emails and the shop currency total', () => {
    const f = orderFacts({ id: 42, created_at: '2026-11-17T12:00:00Z', email: 'Jo@Example.com', phone: '07700 900123', shipping_address: { country_code: 'GB' },
      total_price: '650.00', currency: 'EUR', total_price_set: { shop_money: { amount: '595.00', currency_code: 'GBP' } } }, 'GB')!;
    expect(f).toEqual({ ref: 'order:42', at: Date.parse('2026-11-17T12:00:00Z'), total: 595, currency: 'GBP', phones: ['+447700900123'], emails: ['jo@example.com'] });
    expect(orderFacts({}, 'GB')).toBeNull();
  });
});
