// Workers AI calls are bound by the time left in the request like Claude calls, so the processing
// lock (the time limit plus 20 s) never runs out while a run still waits on the model.
import { describe, expect, it } from 'vitest';
import { callWorkersAi, type CallJsonInput, type ProviderChoice } from '../../src/brain/llm';
import type { Env } from '../../src/types';

const choice: ProviderChoice = { provider: 'workers_ai', model: '@cf/google/gemma-4-26b-a4b-it', apiKey: null };
const input = (timeoutMs?: number): CallJsonInput => ({ purpose: 'test', system: [{ text: 'sys' }], user: 'hi', schema: { type: 'object' }, timeoutMs });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeAi(steps: (() => Promise<unknown>)[]) {
  let calls = 0;
  const env = { AI: { run: async () => { const step = steps[Math.min(calls, steps.length - 1)]!; calls++; return step(); } } } as unknown as Env;
  return { env, calls: () => calls };
}

describe('Workers AI inside a time limit', () => {
  it('stops waiting when the time is up', async () => {
    const ai = fakeAi([async () => { await sleep(3000); return { response: '{"ok":true}' }; }]);
    const t0 = Date.now();
    await expect(callWorkersAi(ai.env, choice, input(300))).rejects.toMatchObject({ code: 'timeout', retryable: true });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('skips the plain mode retry and the repair when too little time is left', async () => {
    const plain = fakeAi([async () => { throw new Error("JSON Mode couldn't be met"); }, async () => ({ response: '{"ok":true}' })]);
    await expect(callWorkersAi(plain.env, choice, input(2000))).rejects.toMatchObject({ code: 'timeout' });
    expect(plain.calls()).toBe(1);
    const repair = fakeAi([async () => ({ response: 'not json at all' }), async () => ({ response: '{"ok":true}' })]);
    await expect(callWorkersAi(repair.env, choice, input(2000))).rejects.toMatchObject({ code: 'timeout' });
    expect(repair.calls()).toBe(1);
  });

  it('with time left it retries as before, and without a limit it waits as before', async () => {
    const plain = fakeAi([async () => { throw new Error("JSON Mode couldn't be met"); }, async () => ({ response: '{"ok":true}' })]);
    expect((await callWorkersAi(plain.env, choice, input(30_000))).data).toEqual({ ok: true });
    expect(plain.calls()).toBe(2);
    const slow = fakeAi([async () => { await sleep(400); return { response: '{"ok":1}' }; }]);
    expect((await callWorkersAi(slow.env, choice, input(undefined))).data).toEqual({ ok: 1 });
  });
});
