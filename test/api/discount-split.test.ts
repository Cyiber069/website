// A code request split over several messages ("hey can it be" then "acxjohn", or "I want a code"
// then later "make it JAKE20") is read from all the unanswered customer messages together plus the
// chat just before them. Things that only look like a request never make a code.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, finish, inbound, sql, unique } from '../helpers/client';
import { mockDiscountRequest } from '../../src/brain/discount';
import { DEFAULT_SETTINGS } from '../../src/lib/settings';
import { codeTrigger, codeTrouble, confirmRequest, inCustomerWords, planCodeRequest } from '../../src/discounts/rules';
import type { HistoryMessage } from '../../src/types';

const TEMPLATE = (code: string) => `Your discount code ${code} is now live!! It's £20 off all kits, bundles and batteries`;
const ASK = 'Nice one, what do you want your code to be?';
const NOW = Date.now();
const h = (direction: 'in' | 'out', body: string, extra: Partial<HistoryMessage> = {}): HistoryMessage =>
  ({ direction, author: direction === 'in' ? 'customer' : 'agent', body, kind: 'text', ts: NOW, ...extra });
const line = (direction: 'in' | 'out', body: string, ts = NOW) => ({ direction, body, ts });

describe('split code requests (no server)', () => {
  it('reads eight split shapes as one request with the right code', () => {
    const shapes: [string, HistoryMessage[], string][] = [
      ['"hey can it be" then "acxjohn" after we asked', [h('in', 'yo can i get a creator code'), h('out', ASK), h('in', 'hey can it be'), h('in', 'acxjohn')], 'acxjohn'],
      ['"I want a code", we asked, then "make it JAKE20"', [h('in', 'I want a code'), h('out', ASK), h('in', 'make it JAKE20')], 'JAKE20'],
      ['both halves unanswered at once', [h('in', 'can i get a discount code'), h('in', 'JAKE20')], 'JAKE20'],
      ['a lone handle right after we asked', [h('in', 'can i get my own code'), h('out', ASK), h('in', 'acxjohn')], 'acxjohn'],
      ['our question still queued, not sent yet', [h('in', 'yo can i get a creator code'), h('out', ASK, { pending: true }), h('in', 'acxjohn')], 'acxjohn'],
      ['the code first, the ask after', [h('in', 'JAKE20'), h('in', 'can that be my discount code')], 'JAKE20'],
      ['spread over three messages', [h('in', 'can i get a sponsor code'), h('out', ASK), h('in', 'my code'), h('in', 'should be'), h('in', 'jake_20')], 'jake_20'],
      ['a creator name with dots', [h('in', 'i need a code for my page'), h('out', ASK), h('in', 'can it be amzz.5kw')], 'amzz.5kw'],
    ];
    for (const [name, history, code] of shapes) {
      expect(mockDiscountRequest(history), name).toMatchObject({ wants_code: true, code });
      const pending = history.slice(history.map((m) => m.direction).lastIndexOf('out') + 1).map((m) => m.body).join('\n');
      const before = history.slice(0, history.length - pending.split('\n').length).map((m) => line(m.direction, m.body, m.ts));
      expect(codeTrigger(pending, before, NOW), name).not.toBeNull();
      expect(inCustomerWords(code, pending), name).toBe(true);
    }
  });

  it('never reads a request into a code that did not work, a question about codes or a username', () => {
    const fp: [string, HistoryMessage[]][] = [
      ['my code did not work', [h('in', "my code didn't work")]],
      ['asking if there is a code', [h('in', 'is there a discount code?')]],
      ['any promo codes on', [h('in', 'do you have any promo codes on at the moment')]],
      ['a used code', [h('in', 'I used code SUMMER10 at checkout and it failed')]],
      ['a username we asked for', [h('in', 'hi'), h('out', "What's your TikTok so we can tag you?"), h('in', 'acxjohn')]],
      ['the code they tried, after we asked which one', [h('in', "my code didn't work"), h('out', 'Which code did you use?'), h('in', 'acxjohn')]],
    ];
    for (const [name, history] of fp) expect(mockDiscountRequest(history).wants_code, name).toBe(false);
    // No code words anywhere near: not even worth a check.
    expect(codeTrigger('acxjohn', [line('in', 'hi'), line('out', "What's your TikTok so we can tag you?")], NOW)).toBeNull();
    // A long message needs a code word of its own, and an old request does not count.
    expect(codeTrigger('x'.repeat(200), [line('in', 'can i get a code')], NOW)).toBeNull();
    expect(codeTrigger('acxjohn', [line('in', 'can i get a code', NOW - 3 * 3_600_000)], NOW)).toBeNull();
    expect(codeTrigger('acxjohn', [line('in', 'can i get a code', NOW - 60_000)], NOW)).toEqual({ kind: 'context', since: NOW - 60_000 });
  });

  it('an answer to our own code question still counts hours later and when it says more', () => {
    const asked = NOW - 3 * 3_600_000;
    const before = [line('in', 'can i get my own code', asked - 60_000), line('out', ASK, asked)];
    // Creators often answer the next morning.
    expect(codeTrigger('JAKE20', before, NOW)).toEqual({ kind: 'context', since: asked });
    const long = 'yeah so I was thinking JAKE20 since thats my name and the year I started riding, my followers know me as jake on here and they all ride ebikes around town every weekend';
    expect(long.length).toBeGreaterThan(160);
    expect(codeTrigger(long, before, NOW)).toEqual({ kind: 'context', since: asked });
    // Too long ago: not read as a request, but the reply gets a note so it never promises a code.
    expect(codeTrigger('JAKE20', [line('out', ASK, NOW - 49 * 3_600_000)], NOW)).toBeNull();
  });

  it('only ever makes a code the customer typed, and parks anything doubtful', () => {
    const base = {
      settings: DEFAULT_SETTINGS.discounts, request: { wants_code: true, code: 'JAKE20', confidence: 0.95 }, code: 'JAKE20',
      problem: null, taken_here: false, contact_code: null, made_today: 0,
    };
    expect(planCodeRequest({ ...base, in_words: true, doubt: null })).toEqual({ kind: 'create', code: 'JAKE20' });
    expect(planCodeRequest({ ...base, in_words: false }).kind).toBe('ask_customer');
    expect(planCodeRequest({ ...base, in_words: true, doubt: codeTrouble('I used code JAKE20 at checkout') }).kind).toBe('park');
    expect(inCustomerWords('JAKE20', 'make it jake 20')).toBe(true);
    expect(inCustomerWords('JOHN20', 'make it my name with 20 on the end')).toBe(false);
    expect(codeTrouble('can my code be JAKE20')).toBeNull();
    for (const t of ["my code didn't work", 'SUMMER10 is not working', 'the code failed', 'it says expired', 'I already have a code']) expect(codeTrouble(t), t).not.toBeNull();
    // The quick check and the main model must agree before a code can be made.
    const quick = { wants_code: true, code: 'JAKE20', confidence: 0.95 };
    expect(confirmRequest(quick, { wants_code: true, code: 'jake20', confidence: 0.9 })).toEqual({ wants_code: true, code: 'jake20', confidence: 0.9 });
    expect(confirmRequest(quick, { wants_code: false, code: null, confidence: 0.9 }).wants_code).toBe(false);
    expect(confirmRequest(quick, { wants_code: true, code: null, confidence: 0.9 })).toMatchObject({ wants_code: true, code: null });
    const disagree = confirmRequest(quick, { wants_code: true, code: 'JAKE21', confidence: 0.99 });
    expect(planCodeRequest({ ...base, request: disagree, code: 'JAKE21', in_words: true }).kind).toBe('park');
  });
});

// ---- end to end, TikTok in auto, Shopify stood in by test_fake_shopify -----------------------------

const fakeShopify = (mode: 'created' | null) => mode
  ? sql(`INSERT INTO settings (key, value, updated_at) VALUES ('state:test_fake_shopify', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(mode), Date.now()])
  : sql(`DELETE FROM settings WHERE key = 'state:test_fake_shopify'`);
const codes = async (convId: string) => (await sql('SELECT code, status, made_by FROM discount_codes WHERE conversation_id = ?', [convId])).data.results;
const codeJobs = async (convId: string) => (await sql(`SELECT * FROM outbox WHERE conversation_id = ? AND source = 'discount'`, [convId])).data.results;
type M = { direction: 'in' | 'out'; body: string; external_id?: string };

/** One creator chat: each turn is what the page shows. The agent's own replies are sent and appear in the next view. */
async function chat() {
  const handle = unique('creator');
  const thread = unique('tt_');
  const seen: M[] = [];
  const say = async (...bodies: string[]) => {
    for (const b of bodies) seen.push({ external_id: unique('m'), direction: 'in', body: b });
    const res = await inbound('tiktok', thread, seen, { title: handle, contact: { name: handle, handle } });
    for (const j of res.jobs) {
      await finish(j.id, { status: 'sent' });
      for (const p of j.parts) seen.push({ direction: 'out', body: p });
    }
    return res;
  };
  return { say, seen };
}

describe('split code requests end to end', () => {
  beforeAll(async () => {
    await api('/api/settings/channels', { method: 'PUT', body: { tiktok: { mode: 'auto' } } });
    await api('/api/settings/discounts', { method: 'PUT', body: { mode: 'auto', daily_cap: 50, one_per_customer: true } });
    await fakeShopify('created');
  });
  afterAll(async () => {
    await fakeShopify(null);
    await api('/api/settings/discounts', { method: 'PUT', body: { mode: 'auto', daily_cap: 10, one_per_customer: true } });
    await api('/api/settings/channels', { method: 'PUT', body: { tiktok: { mode: 'review' } } });
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased', 'review')`);
  });

  it('"hey can it be" then the handle, after the agent asked what code they want', async () => {
    const c = await chat();
    const asked = await c.say('yo can i get a creator code');
    expect(asked.jobs[0]!.parts.join(' ')).toBe(ASK);
    const code = unique('acxjohn');
    const made = await c.say('hey can it be', code);
    expect(made.action).toBe('reply');
    expect(made.jobs[0]!.parts).toEqual([TEMPLATE(code)]);
    expect(await codes(made.conversation_id!)).toEqual([{ code, status: 'live', made_by: 'agent' }]);
    expect(made.queries).toBeLessThanOrEqual(45);
  });

  it('"I want a code", then later "make it JAKE20"', async () => {
    const c = await chat();
    expect((await c.say('I want a code')).jobs[0]!.parts.join(' ')).toBe(ASK);
    const code = unique('JAKE').toUpperCase();
    const made = await c.say(`make it ${code}`);
    expect(made.jobs[0]!.parts).toEqual([TEMPLATE(code)]);
    expect(await codeJobs(made.conversation_id!)).toHaveLength(1);
  });

  it('both halves in one go, and our question still queued when the answer arrives', async () => {
    const c = await chat();
    const code = unique('MIA').toUpperCase();
    const both = await c.say('can i get a discount code', code);
    expect(both.jobs[0]!.parts).toEqual([TEMPLATE(code)]);

    // Our question has not gone out yet when the customer answers it.
    const handle = unique('creator');
    const thread = unique('tt_');
    const first: M[] = [{ external_id: unique('m'), direction: 'in', body: 'yo can i get a creator code' }];
    const ask = await inbound('tiktok', thread, first, { title: handle, contact: { name: handle, handle } });
    expect(ask.jobs[0]!.parts.join(' ')).toBe(ASK);
    const lone = unique('kai');
    const made = await inbound('tiktok', thread, [...first, { external_id: unique('m'), direction: 'in', body: lone }], { title: handle, contact: { name: handle, handle } });
    expect(made.jobs[0]!.parts).toEqual([TEMPLATE(lone)]);
    for (const j of [...ask.jobs, ...made.jobs]) await finish(j.id);
  });

  it('our code question answered 3 hours later still makes the code', async () => {
    const c = await chat();
    const asked = await c.say('yo can i get a creator code');
    expect(asked.jobs[0]!.parts.join(' ')).toBe(ASK);
    await sql('UPDATE messages SET ts = ts - ?, created_at = created_at - ? WHERE conversation_id = ?', [3 * 3_600_000, 3 * 3_600_000, asked.conversation_id]);
    const code = unique('LATE').toUpperCase();
    const made = await c.say(code);
    expect(made.jobs[0]!.parts).toEqual([TEMPLATE(code)]);
    expect(await codes(made.conversation_id!)).toEqual([{ code, status: 'live', made_by: 'agent' }]);
  });

  it('a split request already dealt with is not done twice', async () => {
    const c = await chat();
    await c.say('can i get my own code');
    const code = unique('done');
    expect((await c.say(code)).jobs[0]!.parts).toEqual([TEMPLATE(code)]);
    const thanks = await c.say('cheers');
    expect(thanks.jobs.every((j) => j.source !== 'discount')).toBe(true);
    expect(await codes(thanks.conversation_id!)).toHaveLength(1);
  });

  it('never makes a code for a code that did not work, a question about codes or a username', async () => {
    const cases: string[][] = [
      ["my code didn't work"],
      ['is there a discount code?'],
      ['I used code SUMMER10 at checkout and it failed'],
    ];
    for (const words of cases) {
      const c = await chat();
      const r = await c.say(...words);
      expect(await codes(r.conversation_id!), words.join(' ')).toHaveLength(0);
      expect(r.jobs.every((j) => j.source !== 'discount' && !j.parts.join(' ').includes('what do you want your code')), words.join(' ')).toBe(true);
    }
    // A username we asked for, on a chat seen for the first time with our question in it.
    const handle = unique('creator');
    const name = unique('acxjohn');
    const r = await inbound('tiktok', unique('tt_'), [
      { direction: 'in', body: 'love the bikes' }, { direction: 'out', body: "What's your TikTok so we can tag you?" }, { direction: 'in', body: name },
    ], { title: handle, contact: { name: handle, handle } });
    expect(r.action).toBe('reply');
    expect(await codes(r.conversation_id!)).toHaveLength(0);
    for (const j of r.jobs) await finish(j.id);
    // The code they tried, after we asked which one.
    const c = await chat();
    await c.say("my code didn't work");
    const tried = await c.say(unique('acxjohn'));
    expect(await codes(tried.conversation_id!)).toHaveLength(0);
  });
});
