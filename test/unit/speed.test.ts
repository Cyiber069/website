// Replying fast without losing anything: the time limits on model calls, the stream that knows when
// the extension hung up, queued replies in the brain's view, pacing and the reply time.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decide } from '../../src/brain/decide';
import { LlmError, callTimeout, callWithin, retryAfterMs } from '../../src/brain/llm';
import { ndjsonStream } from '../../src/lib/http';
import { DEFAULT_SETTINGS, PACING_SCHEMA, migratePacing } from '../../src/lib/settings';
import { arrivedAt, buildTimeline } from '../../src/pipeline/inbound';
import { jobPacing } from '../../src/pipeline/outbox';
import { summarise } from '../../src/pipeline/replytime';
import type { DecideInput, Env, HistoryMessage, MessageRow, Settings } from '../../src/types';

// The knowledge base bundles the seed documents (.md imports), which only the Worker build can load.
vi.mock('../../src/kb', () => ({
  PRODUCT_PICKER_ID: 'product_picker',
  buildKnowledgeContext: async () => ({ mode: 'empty', stable: '', retrieved: '', docs: [], tokens: 0 }),
  addLearnedFact: async () => null,
  syncStore: async () => ({}),
}));

/** A D1 stand in: default settings, a saved Claude key, no knowledge. */
function fakeDb(): D1Database {
  const prepare = (sql: string) => {
    const rows = () => (sql.includes('FROM secrets') ? [{ value: 'sk-ant-test' }] : []);
    const bound = () => ({ first: async () => rows()[0] ?? null, all: async () => ({ results: rows(), meta: {} }), run: async () => ({ meta: { changes: 1 } }), raw: async () => [] });
    return { bind: () => bound(), ...bound() };
  };
  return { prepare, batch: async () => [] } as unknown as D1Database;
}
const env = (): Env => ({ DB: fakeDb(), ASSETS: {} as Fetcher });
const choice = { provider: 'anthropic' as const, model: 'claude-opus-5-5', apiKey: 'sk-ant-test' };
const schema = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] };

function message(text: string) {
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
}
const overloaded = (after = '1') => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), {
  status: 529, headers: { 'content-type': 'application/json', 'retry-after': after, 'x-should-retry': 'true' },
});

/** Stub the network. Each answer is a Response, or 'hang' to wait until the SDK gives up on the call. */
function stubFetch(answers: (Response | 'hang')[]) {
  const calls: number[] = [];
  vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(Date.now());
    const next = answers.shift() ?? 'hang';
    if (next !== 'hang') return next;
    return new Promise<Response>((_res, rej) => {
      const signal = init?.signal;
      const stop = () => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop);
    });
  });
  return calls;
}

describe('model calls inside a time limit', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sizes a call to the time left and starts none below the minimum', () => {
    const now = 1_000_000;
    expect(callTimeout({ deadlineAt: now + 45_000, capMs: 50_000, minMs: 8_000 }, now)).toBe(44_000);
    expect(callTimeout({ deadlineAt: now + 45_000, capMs: 30_000, minMs: 8_000 }, now)).toBe(30_000);
    expect(callTimeout({ deadlineAt: now + 8_500, capMs: 50_000, minMs: 8_000 }, now)).toBe(0);
    expect(callTimeout({ deadlineAt: now + 30_000, capMs: 8_000, minMs: 2_000, reserveMs: 20_000 }, now)).toBe(8_000);
    expect(callTimeout({ deadlineAt: now + 21_500, capMs: 8_000, minMs: 2_000, reserveMs: 20_000 }, now)).toBe(0);
  });

  it('a slow call ends at the deadline as a retryable timeout, after one attempt and no SDK retry', async () => {
    const calls = stubFetch(['hang', 'hang']);
    const started = Date.now();
    const run = callWithin(env(), { purpose: 'decide', system: [{ text: 'x' }], user: 'y', schema, choice }, { deadlineAt: Date.now() + 2_500, capMs: 50_000, minMs: 500, retryQuickFailure: true });
    await expect(run).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(Date.now() - started).toBeLessThan(3_500);
    expect(calls).toHaveLength(1);
  });

  it('a quick overload is tried once more, honouring retry-after, and never twice', async () => {
    const ok = stubFetch([overloaded('1'), message('{"ok":true}')]);
    const res = await callWithin(env(), { purpose: 'decide', system: [{ text: 'x' }], user: 'y', schema, choice }, { deadlineAt: Date.now() + 30_000, capMs: 20_000, minMs: 1_000, retryQuickFailure: true });
    expect(res.data).toEqual({ ok: true });
    expect(ok).toHaveLength(2);
    expect(ok[1]! - ok[0]!).toBeGreaterThanOrEqual(900);

    vi.unstubAllGlobals();
    const twice = stubFetch([overloaded('1'), overloaded('7')]);
    const err = await callWithin(env(), { purpose: 'decide', system: [{ text: 'x' }], user: 'y', schema, choice }, { deadlineAt: Date.now() + 30_000, capMs: 20_000, minMs: 1_000, retryQuickFailure: true }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ code: 'overloaded', retryable: true, retryAfterMs: 7_000 });
    expect(twice).toHaveLength(2);
  });

  it('no time left: no call at all', async () => {
    const calls = stubFetch([message('{"ok":true}')]);
    await expect(callWithin(env(), { purpose: 'decide', system: [{ text: 'x' }], user: 'y', schema, choice }, { deadlineAt: Date.now() + 500, capMs: 50_000, minMs: 8_000 }))
      .rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(calls).toHaveLength(0);
  });

  it('reads retry-after in seconds or as a date, capped at two minutes', () => {
    const h = (v: string) => new Headers({ 'retry-after': v });
    expect(retryAfterMs(h('3'))).toBe(3_000);
    expect(retryAfterMs(h('900'))).toBe(120_000);
    expect(retryAfterMs(h(new Date(Date.now() + 10_000).toUTCString()))).toBeGreaterThan(8_000);
    expect(retryAfterMs(new Headers())).toBeNull();
    expect(retryAfterMs(undefined)).toBeNull();
  });
});

describe('decide under a time limit', () => {
  afterEach(() => vi.unstubAllGlobals());
  const NOW = Date.now();
  const input = (body: string): DecideInput => ({
    channel: 'whatsapp', contact_name: 'Jake', subject: null, context_notes: [], now: NOW, mode: 'live',
    history: [{ direction: 'in', author: 'customer', body, kind: 'text', ts: NOW } as HistoryMessage],
  });
  // An answer that does not admit being the assistant when asked: the code asks for one rewrite.
  const NOT_HONEST = JSON.stringify({ note: 'n', kb_refs: [], action: 'reply', escalate: null, flags: { opt_out: false, asked_if_bot: false, needs_human: false }, parts: ['all good what can I help with'], confidence: 0.95, sales: null });

  it('skips the rewrite when there is no time for it, and the final pass still answers honestly', async () => {
    const calls = stubFetch([message(NOT_HONEST), message(NOT_HONEST)]);
    const d = await decide(env(), input('are you a bot'), { deadlineAt: Date.now() + 12_000 });
    expect(calls).toHaveLength(1);
    expect(d.action).toBe('reply');
    expect(d.parts.join(' ')).toMatch(/assistant/i);
  });

  it('rewrites once when there is time', async () => {
    // A "not just X, it's Y" sentence only the model can rewrite.
    const NOT_JUST = JSON.stringify({ note: 'n', kb_refs: [], action: 'reply', escalate: null, flags: { opt_out: false, asked_if_bot: false, needs_human: false }, parts: ["It's not just a kit, it's a whole new ride"], confidence: 0.95, sales: null });
    const calls = stubFetch([message(NOT_JUST), message(NOT_JUST)]);
    await decide(env(), input('what is it like'), { deadlineAt: Date.now() + 40_000 });
    expect(calls).toHaveLength(2);
  });

  it('fixes in code what code can fix, with no rewrite call', async () => {
    // No honest answer to "are you a bot": the fixed honest line goes first, the model's answer after it.
    const calls = stubFetch([message(NOT_HONEST), message(NOT_HONEST)]);
    const d = await decide(env(), input('are you a bot'), { deadlineAt: Date.now() + 40_000 });
    expect(calls).toHaveLength(1);
    expect(d.parts[0]).toMatch(/AI assistant/);
    expect(d.parts.join(' ')).toMatch(/what can I help with/i);
    expect(d.note).toMatch(/style fixed in code/);
  });

  it('a decide that cannot finish in time is a retryable timeout, not a wrong answer', async () => {
    stubFetch(['hang']);
    const started = Date.now();
    await expect(decide(env(), input('how long is delivery'), { deadlineAt: Date.now() + 10_000 })).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(Date.now() - started).toBeLessThan(10_500);
  });
});

describe('the answer stream knows when the extension hung up', () => {
  it('isOpen turns false and send says so once the reader cancels', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const seen: boolean[] = [];
    let delivered: boolean | null = null;
    let job: Promise<unknown> = Promise.resolve();
    const exec = { waitUntil: (p: Promise<unknown>) => { job = p; }, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const res = ndjsonStream(exec, async (send, isOpen) => {
      await send({ type: 'accepted' });
      seen.push(isOpen());
      await gate;
      seen.push(isOpen());
      delivered = await send({ type: 'decision' });
    }, 20);
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('accepted');
    await new Promise((r) => setTimeout(r, 5)); // let the work look while the reader is still there
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 60));
    release();
    await job;
    expect(seen).toEqual([true, false]);
    expect(delivered).toBe(false);
  });
});

const row = (id: string, direction: 'in' | 'out', ts: number, extra: Partial<MessageRow> = {}): MessageRow => ({
  id, conversation_id: 'cv', direction, author: direction === 'in' ? 'customer' : 'agent', external_id: null, body: `${id} body`, kind: 'text',
  status: 'received', outbox_id: null, meta: '{}', ts, created_at: ts, ...extra,
});
const job = (id: string, extra: Record<string, unknown>) => ({ id, source: 'auto', status: 'leased', parts: '["one","two"]', created_at: 0, ref_id: null, reply_to_id: null, dedupe_key: null, last_error: null, ...extra });

describe('queued replies in the brain view', () => {
  it('puts a reply that is not sent yet right after the message it answers, marked pending', () => {
    const rows = [row('m1', 'in', 1000), row('m2', 'in', 3000)];
    const lines = buildTimeline(rows, [job('ob1', { reply_to_id: 'm1', created_at: 4000 })]);
    expect(lines.map((l) => l.history.body)).toEqual(['m1 body', 'one', 'two', 'm2 body']);
    expect(lines.map((l) => Boolean(l.history.pending))).toEqual([false, true, true, false]);
    // The newer message is still the one to answer.
    expect(lines.at(-1)!.history.direction).toBe('in');
  });

  it('reads the answered message from an old dedupe key, else places it by time, and leaves out what will not be sent', () => {
    const rows = [row('m1', 'in', 1000), row('m2', 'out', 2000), row('m3', 'in', 3000)];
    const legacy = buildTimeline(rows, [job('ob1', { dedupe_key: 'auto:cv:m1', created_at: 9000 })]);
    expect(legacy.map((l) => l.history.body)).toEqual(['m1 body', 'one', 'two', 'm2 body', 'm3 body']);
    const byTime = buildTimeline(rows, [job('ob2', { source: 'urgent', status: 'pending', parts: '["owner answer"]', created_at: 2500 })]);
    expect(byTime.map((l) => l.history.body)).toEqual(['m1 body', 'm2 body', 'owner answer', 'm3 body']);
    const ignored = buildTimeline(rows, [
      job('a', { status: 'cancelled', reply_to_id: 'm1' }), job('b', { status: 'sent', reply_to_id: 'm1' }), job('c', { source: 'recovery', status: 'pending' }), job('d', { status: 'review', reply_to_id: 'm3' }),
    ]);
    expect(ignored).toHaveLength(3);
  });
});

describe('reply time', () => {
  it('reads a time shown to the minute as half way through it, and never later than first seen', () => {
    expect(arrivedAt({ ts: 1_794_695_160_000, created_at: 1_794_695_200_000 })).toBe(1_794_695_190_000);
    expect(arrivedAt({ ts: 1_794_695_160_000, created_at: 1_794_695_170_000 })).toBe(1_794_695_170_000);
    expect(arrivedAt({ ts: 1_794_695_171_234, created_at: 1_794_695_180_000 })).toBe(1_794_695_171_234);
    expect(arrivedAt({ ts: 1_794_695_199_000, created_at: 1_794_695_180_000 })).toBe(1_794_695_180_000);
  });

  it('averages, finds the slowest and splits by channel', () => {
    const r = summarise([
      { channel: 'whatsapp', conversation_id: 'a', sent_at: 100_000, reply_to_ts: 70_000, target: '{"title":"Jake"}' },
      { channel: 'whatsapp', conversation_id: 'b', sent_at: 200_000, reply_to_ts: 190_000, target: '{"title":"Mia"}' },
      { channel: 'tiktok', conversation_id: 'c', sent_at: 300_000, reply_to_ts: 280_000, target: '{"handle":"kai"}' },
    ]);
    expect(r).toMatchObject({ count: 3, avg_ms: 20_000, max_ms: 30_000, slowest: { conversation_id: 'a', customer: 'Jake', ms: 30_000 } });
    expect(r.by_channel).toEqual({ whatsapp: { count: 2, avg_ms: 20_000 }, tiktok: { count: 1, avg_ms: 20_000 } });
    expect(summarise([])).toMatchObject({ count: 0, avg_ms: null, slowest: null });
  });
});

describe('pacing', () => {
  const settings = (pacing: Partial<Settings['pacing']> = {}): Settings => ({ ...DEFAULT_SETTINGS, pacing: { ...DEFAULT_SETTINGS.pacing, ...pacing } });

  it('defaults to a short quiet wait and no extra delay', () => {
    expect(DEFAULT_SETTINGS.pacing).toMatchObject({ schema: PACING_SCHEMA, settle_seconds: 4, min_reply_delay_s: 0, max_reply_delay_s: 0 });
  });

  it('sends replies with no wait, pasted whole, and keeps the checkout reminders and owner alert as they are', () => {
    const p = (source: string, pacing: unknown, s = settings()) => jobPacing({ source, pacing: JSON.stringify(pacing) }, s);
    for (const source of ['auto', 'holding', 'urgent', 'manual', 'review', 'discount']) expect(p(source, { delay_ms: 12_000, typing_cps: 11 })).toEqual({ delay_ms: 0, typing_cps: 0 });
    // The owner may still ask for an extra wait on the agent's own replies, never more than the setting.
    expect(p('auto', { delay_ms: 12_000, typing_cps: 11 }, settings({ max_reply_delay_s: 5 }))).toEqual({ delay_ms: 5_000, typing_cps: 0 });
    expect(p('urgent', { delay_ms: 1_500 }, settings({ max_reply_delay_s: 5 }))).toEqual({ delay_ms: 0, typing_cps: 0 });
    expect(p('recovery', { delay_ms: 4_000, typing_cps: 11 })).toEqual({ delay_ms: 4_000, typing_cps: 11 });
    expect(p('alert', { delay_ms: 0, typing_cps: 40 })).toEqual({ delay_ms: 0, typing_cps: 40 });
  });

  it('moves stored slow pacing to the fast defaults once, and keeps what the owner saved after', () => {
    const value = () => ({ ...DEFAULT_SETTINGS.pacing, settle_seconds: 12, min_reply_delay_s: 5, max_reply_delay_s: 20, max_auto_replies_per_thread_per_hour: 10, human_takeover_minutes: 20 });
    const old = { settle_seconds: 12, min_reply_delay_s: 5, max_reply_delay_s: 20, typing_cps: 11, max_auto_replies_per_thread_per_hour: 10, human_takeover_minutes: 20 };
    const v = value();
    expect(migratePacing(old, v)).toBe(true);
    expect(v).toMatchObject({ schema: 2, settle_seconds: 4, min_reply_delay_s: 0, max_reply_delay_s: 0, max_auto_replies_per_thread_per_hour: 30, human_takeover_minutes: 20, typing_cps: 11 });
    const owner = value();
    expect(migratePacing({ ...old, schema: 2 }, owner)).toBe(false);
    expect(owner.settle_seconds).toBe(12);
    const own = value();
    own.max_auto_replies_per_thread_per_hour = 25;
    expect(migratePacing({ ...old, max_auto_replies_per_thread_per_hour: 25 }, own)).toBe(true);
    expect(own.max_auto_replies_per_thread_per_hour).toBe(25);
    expect(migratePacing(undefined, value())).toBe(false);
  });
});
