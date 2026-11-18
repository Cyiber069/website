// The owner's AI split against the running Worker with the mock brain. The provider is set to anthropic,
// so the routing rules run for real in test mode (src/brain/llm.ts chooseProvider): the mock stands in
// for the model the rules picked, and llm_usage records that model, so every test can see who answered.
// Workers AI counts as there; the free window applies only with a test clock (state:ai_state test_now).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, inbound, sql, unique } from '../helpers/client';

const LIMIT = 45; // the free plan allows 50 D1 queries per request; keep room
const today = () => new Date().toISOString().slice(0, 10);
/** 22:30 UTC (in the free window) or 21:30 UTC (just before it) of today. */
const clock = (h: number, m = 30) => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m); };

async function setAi(state: Record<string, unknown> | null): Promise<void> {
  if (!state) { await sql(`DELETE FROM settings WHERE key = 'state:ai_state'`); return; }
  await sql(`INSERT INTO settings (key, value, updated_at) VALUES ('state:ai_state', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [JSON.stringify(state), Date.now()]);
}
const aiRow = async () => JSON.parse(((await sql(`SELECT value FROM settings WHERE key = 'state:ai_state'`)).data.results[0]?.value) ?? '{}');
const lastUsageId = async () => Number((await sql('SELECT MAX(id) AS id FROM llm_usage')).data.results[0]?.id ?? 0);
/** The decide calls since `after`, oldest first: which model answered and whether it worked. */
const decides = async (after: number) => (await sql(`SELECT model, purpose, ok FROM llm_usage WHERE id > ? AND purpose LIKE 'decide%' ORDER BY id`, [after])).data.results as { model: string; purpose: string; ok: number }[];
/** Every model call since `after` that is not a decide call: purpose and model, oldest first. */
const others = async (after: number) => (await sql(`SELECT purpose, model FROM llm_usage WHERE id > ? AND purpose NOT LIKE 'decide%' ORDER BY id`, [after])).data.results as { purpose: string; model: string }[];
const say = (text: string, thread = unique('ai')) => inbound('whatsapp', thread, [{ external_id: unique('m'), direction: 'in', body: text, ts: Date.now() }]);
const WORKERS = '@cf/google/gemma-4-26b-a4b-it';

let firstUsage = 0;
beforeAll(async () => {
  firstUsage = await lastUsageId();
  expect((await api('/api/connections/brain', { method: 'PUT', body: { provider: 'anthropic' } })).status).toBe(200);
  await setAi(null);
});
afterAll(async () => {
  await api('/api/connections/brain', { method: 'PUT', body: { provider: 'auto', anthropic_api_key: '' } });
  await setAi(null);
  // The failed calls made on purpose here must not count as the AI failing in later tests (the monitor reads the last 3).
  await sql('DELETE FROM llm_usage WHERE id > ?', [firstUsage]);
});

describe('Claude: Haiku with Sonnet for the chats that matter', () => {
  it('answers a plain chat with Haiku', async () => {
    const before = await lastUsageId();
    const r = await say('what time do you open on saturday');
    expect(r.action).toBe('reply');
    expect(await decides(before)).toEqual([{ model: 'claude-haiku-5-5', purpose: 'decide', ok: 1 }]);
    expect(r.queries!).toBeLessThanOrEqual(LIMIT);
  });

  it('answers a buying question, a complaint and a live sale with Sonnet', async () => {
    let before = await lastUsageId();
    await say('how much is the 2000w bundle');
    expect((await decides(before)).map((d) => d.model)).toEqual(['claude-sonnet-5-5']);

    before = await lastUsageId();
    await say('my kit arrived broken and the display is cracked');
    expect((await decides(before)).map((d) => d.model)).toEqual(['claude-sonnet-5-5']);

    // A chat the brain already read as interested: even a plain message there gets Sonnet.
    const thread = unique('sale');
    await say('hello there', thread);
    await sql(`UPDATE conversations SET sales_stage = 'interested' WHERE external_thread_id = ?`, [thread]);
    before = await lastUsageId();
    await inbound('whatsapp', thread, [{ external_id: unique('m'), direction: 'in', body: 'ok cool and does it come in black', ts: Date.now() }]);
    expect((await decides(before)).map((d) => d.model)).toEqual(['claude-sonnet-5-5']);
  });

  it('gives Sonnet one try when Haiku is unsure, before the chat goes to the owner', async () => {
    const before = await lastUsageId();
    const r = await say('haiku-stumped what tyre size fits the rear hub');
    expect(r.action).toBe('reply');
    expect(r.jobs[0]?.parts.join(' ')).toMatch(/^Mock Sonnet answer to: haiku.stumped/);
    expect((await decides(before)).map((d) => d.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    expect(r.queries!).toBeLessThanOrEqual(LIMIT);
  });

  it('still asks the owner when Sonnet cannot answer either, and never retries what needs the owner', async () => {
    let before = await lastUsageId();
    const r = await say('unknown-question about the moon warranty');
    expect(r.action).toBe('escalate');
    expect((await decides(before)).map((d) => d.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5']);
    // An opt out is never tried again on Sonnet.
    before = await lastUsageId();
    const p = await say('stop messaging me');
    expect((await decides(before)).length).toBe(1);
    expect(p.queries!).toBeLessThanOrEqual(LIMIT);
  });
});

describe('the last 2 hours before 00:00 UTC', () => {
  it('lets the free Cloudflare AI answer customers while neurons are left, and counts them', async () => {
    await setAi({ day: today(), used: 1000, test_now: clock(22) });
    const before = await lastUsageId();
    const r = await say('hello is the shop open');
    expect(r.action).toBe('reply');
    expect(await decides(before)).toEqual([{ model: WORKERS, purpose: 'decide', ok: 1 }]);
    // 3000 input and 200 output tokens of the mock at the gemma rates: about 32.7 neurons.
    const row = await aiRow();
    expect(row.day).toBe(today());
    expect(row.used).toBeGreaterThan(1032);
    expect(row.used).toBeLessThan(1034);
    expect(r.queries!).toBeLessThanOrEqual(LIMIT);
  });

  it('changes nothing when the allowance ran out earlier, or before 22:00', async () => {
    await setAi({ day: today(), used: 9_990, test_now: clock(22) });
    let before = await lastUsageId();
    await say('hello again from the window');
    expect((await decides(before)).map((d) => d.model)).toEqual(['claude-haiku-5-5']);

    await setAi({ day: today(), used: 100, out_at: Date.now(), test_now: clock(23) });
    before = await lastUsageId();
    await say('hello once more from the window');
    expect((await decides(before)).map((d) => d.model)).toEqual(['claude-haiku-5-5']);

    await setAi({ day: today(), used: 100, test_now: clock(21) });
    before = await lastUsageId();
    await say('hello before the window');
    expect((await decides(before)).map((d) => d.model)).toEqual(['claude-haiku-5-5']);
  });

  it('treats a daily limit error as out until 00:00 UTC and lets Claude answer at once', async () => {
    await setAi({ day: today(), used: 5000, test_now: clock(22) });
    const before = await lastUsageId();
    const r = await say('mock-workers-limit hello late night');
    expect(r.action).toBe('reply');
    expect(await decides(before)).toEqual([{ model: WORKERS, purpose: 'decide', ok: 0 }, { model: 'claude-haiku-5-5', purpose: 'decide', ok: 1 }]);
    expect((await aiRow()).out_at).toBeGreaterThan(0);
    // The rest of the window goes to Claude.
    const after = await lastUsageId();
    await say('and another late message');
    expect((await decides(after)).map((d) => d.model)).toEqual(['claude-haiku-5-5']);
    expect(r.queries!).toBeLessThanOrEqual(LIMIT);
    await setAi(null);
  });

  it('answers with Claude in the same request when Workers AI hangs, then leaves the window to Claude for a few minutes', async () => {
    await setAi({ day: today(), used: 1000, test_now: clock(22) });
    let before = await lastUsageId();
    const started = Date.now();
    // The mock waits out all the time the Workers AI call was given (a hang), then times out.
    const r = await say('mock-workers-hang hello is anyone there tonight');
    const took = Date.now() - started;
    expect(r.action).toBe('reply');
    expect(r.jobs[0]?.parts.join(' ')).toMatch(/^Mock reply to: mock.workers.hang/);
    expect(await decides(before)).toEqual([{ model: WORKERS, purpose: 'decide', ok: 0 }, { model: 'claude-haiku-5-5', purpose: 'decide', ok: 1 }]);
    // Workers AI got 20 s of the 45 s the laptop waits, so Claude still had time.
    expect(took).toBeGreaterThanOrEqual(19_000);
    expect(took).toBeLessThan(32_000);
    expect(r.queries!).toBeLessThanOrEqual(LIMIT);
    const row = await aiRow();
    expect(row.workers_failing_until).toBe(clock(22) + 5 * 60_000);

    // The next chats in the window go straight to Claude: nobody waits on Workers AI again.
    before = await lastUsageId();
    const next = await say('another late message after the hang');
    expect(next.action).toBe('reply');
    expect((await decides(before)).map((d) => d.model)).toEqual(['claude-haiku-5-5']);

    // A few minutes later Workers AI answers the window again.
    await setAi({ ...(await aiRow()), test_now: clock(22, 40) });
    before = await lastUsageId();
    await say('later in the window');
    expect((await decides(before)).map((d) => d.model)).toEqual([WORKERS]);
    await setAi(null);
  }, 70_000);

  it('answers with Claude when Workers AI fails in the window for a reason a retry would not fix', async () => {
    await setAi({ day: today(), used: 1000, test_now: clock(23) });
    const before = await lastUsageId();
    const r = await say('mock-workers-nomodel hello late night');
    expect(r.action).toBe('reply');
    expect(await decides(before)).toEqual([{ model: WORKERS, purpose: 'decide', ok: 0 }, { model: 'claude-haiku-5-5', purpose: 'decide', ok: 1 }]);
    expect((await aiRow()).workers_failing_until).toBe(clock(23) + 5 * 60_000);
    expect(r.queries!).toBeLessThanOrEqual(LIMIT);
    await setAi(null);
  });

  it('keeps Claude\'s own jobs on Claude in the window: the code check, polishing answers and the key test', async () => {
    await setAi({ day: today(), used: 1000, test_now: clock(22) });
    // A creator code request: checked by Haiku and confirmed by Sonnet, never by Workers AI alone.
    let before = await lastUsageId();
    const code = await say(`can i get my own discount code "WIN${String(Date.now()).slice(-5)}" please`);
    expect(code.reason).not.toBe('brain_error');
    expect((await others(before)).filter((u) => u.purpose.startsWith('discount'))).toEqual([
      { purpose: 'discount_check', model: 'claude-haiku-5-5' }, { purpose: 'discount_request', model: 'claude-sonnet-5-5' },
    ]);
    expect(code.queries!).toBeLessThanOrEqual(LIMIT);

    // The owner's answer to an Urgent card is polished by Claude.
    const ask = await say('unknown-question about the moon warranty late at night');
    expect(ask.action).toBe('escalate');
    const item = (await api('/api/urgent')).data.urgent.find((u: any) => u.conversation_id === ask.conversation_id);
    before = await lastUsageId();
    const answered = await api(`/api/urgent/${item.id}/answer`, { body: { answer: 'no warranty on the moon sorry' } });
    expect(answered.status).toBe(200);
    expect((await others(before)).filter((u) => u.purpose === 'polish')).toEqual([{ purpose: 'polish', model: 'claude-haiku-5-5' }]);
    expect(answered.queries).toBeLessThanOrEqual(LIMIT);

    // Test it on Connections tests Claude, in the window and while Claude is marked down.
    before = await lastUsageId();
    expect((await api('/api/connections/brain/test', { body: {} })).data.ok).toBe(true);
    await setAi({ ...(await aiRow()), claude_down: { at: Date.now() - 60_000, last_at: Date.now() - 60_000, code: 'billing', message: 'mock' } });
    expect((await api('/api/connections/brain/test', { body: {} })).data.ok).toBe(true);
    expect((await others(before)).filter((u) => u.purpose === 'test')).toEqual([{ purpose: 'test', model: 'claude-haiku-5-5' }, { purpose: 'test', model: 'claude-haiku-5-5' }]);
    await setAi(null);
  });
});

describe('Claude failing for credit, billing or key reasons', () => {
  it('falls back to the free Cloudflare AI and tells the owner once', async () => {
    await setAi(null);
    const events = async () => Number((await sql(`SELECT COUNT(*) AS n FROM events WHERE type = 'claude_down'`)).data.results[0].n);
    const alertsBefore = await events();
    let before = await lastUsageId();
    const r = await say('mock-billing hello is anyone there');
    expect(r.action).toBe('reply');
    expect(await decides(before)).toEqual([{ model: 'claude-haiku-5-5', purpose: 'decide', ok: 0 }, { model: WORKERS, purpose: 'decide', ok: 1 }]);
    expect(await events()).toBe(alertsBefore + 1);
    const msg = (await sql(`SELECT message FROM events WHERE type = 'claude_down' ORDER BY id DESC LIMIT 1`)).data.results[0].message as string;
    expect(msg).toMatch(/no credit left/);
    expect(msg).not.toMatch(/[\u2013\u2014]/); // owner copy: no em or en dashes
    expect(r.queries!).toBeLessThanOrEqual(LIMIT);

    // The next chats go straight to the free AI: Claude is not asked while it is down.
    before = await lastUsageId();
    await say('a second customer while claude is down');
    expect((await decides(before)).map((d) => d.model)).toEqual([WORKERS]);

    // Connections says so, and that the free AI answers meanwhile.
    const conn = (await api('/api/connections')).data;
    expect(conn.brain.workers_ai.claude_down).toMatchObject({ code: 'billing', covered: true });
    expect(msg).toMatch(/The free Cloudflare AI is answering for now/);

    // 15 minutes later Claude is tried again: it fails again, but the owner is not told twice.
    const row = await aiRow();
    await setAi({ ...row, claude_down: { ...row.claude_down, at: Date.now() - 20 * 60_000, last_at: Date.now() - 20 * 60_000 } });
    before = await lastUsageId();
    await say('mock-billing hello from another customer');
    expect((await decides(before)).map((d) => [d.model, d.ok])).toEqual([['claude-haiku-5-5', 0], [WORKERS, 1]]);
    expect(await events()).toBe(alertsBefore + 1);

    // A new key: Claude at once.
    expect((await api('/api/connections/brain', { method: 'PUT', body: { anthropic_api_key: 'sk-ant-test-new-key-0000' } })).status).toBe(200);
    expect((await api('/api/connections')).data.brain.workers_ai.claude_down).toBeNull();
    before = await lastUsageId();
    await say('back to normal now');
    expect((await decides(before)).map((d) => d.model)).toEqual(['claude-haiku-5-5']);
  });

  it('has no fallback when the free allowance is used up: the chat waits for a retry, and the owner is told so', async () => {
    await setAi({ day: today(), used: 10_000, out_at: Date.now() });
    const before = await lastUsageId();
    const r = await say('mock-billing hello there');
    expect(r.action).toBe('none');
    expect(r.reason).toBe('brain_error');
    expect((await decides(before)).map((d) => [d.model, d.ok])).toEqual([['claude-haiku-5-5', 0]]);
    // The alert never says customers are covered when nothing can answer them.
    const msg = (await sql(`SELECT message FROM events WHERE type = 'claude_down' ORDER BY id DESC LIMIT 1`)).data.results[0].message as string;
    expect(msg).toMatch(/no credit left\. Customers are not getting answers until you add credit at console\.anthropic\.com\./);
    expect(msg).not.toMatch(/answering for now|[\u2013\u2014]/);
    expect((await api('/api/connections')).data.brain.workers_ai.claude_down).toMatchObject({ code: 'billing', covered: false });
    await setAi(null);
  });
});

describe('Connections: the split, the model choice and the free allowance', () => {
  it('shows which AI does what, the mix first, and today\'s allowance', async () => {
    await setAi({ day: today(), used: 2500 });
    const { status, data, queries } = await api('/api/connections');
    expect(status).toBe(200);
    expect(data.brain.model).toBe('mix-haiku-sonnet');
    expect(data.brain.models[0]).toMatchObject({ id: 'mix-haiku-sonnet', label: 'Haiku with Sonnet for the chats that matter' });
    expect(data.brain.models.map((m: any) => m.id)).toEqual(expect.arrayContaining(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']));
    expect(data.brain.split.map((s: any) => s.ai)).toEqual(['claude', 'cloudflare', 'google']);
    for (const s of data.brain.split) expect(`${s.name} ${s.does}`).not.toMatch(/[\u2013\u2014]/);
    expect(data.brain.workers_ai.allowance).toMatchObject({ used: 2500, limit: 10_000, pct: 25, out: false, estimate: true, window_from_utc: 22 });
    expect(queries).toBeLessThanOrEqual(LIMIT);
    await setAi(null);
  });

  it('moves a default Opus the owner never chose to the mix, and keeps a model they pick', async () => {
    await sql(`UPDATE settings SET value = ? WHERE key = 'brain'`, [JSON.stringify({ provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low' })]);
    let conn = (await api('/api/connections')).data;
    expect(conn.brain).toMatchObject({ model: 'mix-haiku-sonnet', mix: true, model_chosen: false });
    // Stored as a real model id with the mix flag: an older Worker after a rollback still sends a model Claude knows.
    const stored = async () => JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'brain'`)).data.results[0].value);
    expect(await stored()).toMatchObject({ model: 'claude-haiku-5-5', mix: true, schema: 2 });

    // A Sonnet saved before the move was the owner's own pick.
    await sql(`UPDATE settings SET value = ? WHERE key = 'brain'`, [JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' })]);
    conn = (await api('/api/connections')).data;
    expect(conn.brain).toMatchObject({ model: 'claude-sonnet-5-5', model_chosen: true });

    // Picking Opus on purpose keeps it.
    expect((await api('/api/connections/brain', { method: 'PUT', body: { model: 'claude-opus-5-5' } })).data.brain).toMatchObject({ model: 'claude-opus-5-5', model_chosen: true });
    expect((await api('/api/connections')).data.brain).toMatchObject({ model: 'claude-opus-5-5', model_chosen: true });
    // Saving only the effort (the form sends the model only when it changed) does not touch the choice.
    await api('/api/connections/brain', { method: 'PUT', body: { effort: 'medium' } });
    expect((await api('/api/connections')).data.brain).toMatchObject({ model: 'claude-opus-5-5', model_chosen: true, effort: 'medium' });
    expect(await stored()).toMatchObject({ model: 'claude-opus-5-5', mix: false });
    // The plain settings route stores a model the same way.
    expect((await api('/api/settings/brain', { method: 'PUT', body: { model: 'claude-sonnet-5-5' } })).data.brain).toMatchObject({ model: 'claude-sonnet-5-5', mix: false });
    expect((await api('/api/settings/brain', { method: 'PUT', body: { model: 'mix-haiku-sonnet' } })).data.brain).toMatchObject({ model: 'claude-haiku-5-5', mix: true });
    // Back to the mix for the other tests.
    expect((await api('/api/connections/brain', { method: 'PUT', body: { model: 'mix-haiku-sonnet', effort: 'low', provider: 'anthropic' } })).data.brain).toMatchObject({ model: 'mix-haiku-sonnet', mix: true });
    expect(await stored()).toMatchObject({ model: 'claude-haiku-5-5', mix: true });
    expect((await api('/api/connections/brain', { method: 'PUT', body: { model: 'gpt-5' } })).status).toBe(400);
  });
});
