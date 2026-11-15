import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, finish, inbound, sql, sync, unique } from '../helpers/client';

// The test server has no Shopify app connected, so every code takes the honest fallback path.
const wa = () => `${unique('4477')}@c.us`;

/** A WhatsApp chat with one customer message. The mock brain's reply is sent so the tab is free again. */
async function chat(name = 'Jake'): Promise<{ id: string; thread: string }> {
  const thread = wa();
  const res = await inbound('whatsapp', thread, [{ external_id: unique('m'), direction: 'in', body: 'yo can i get a creator code' }], {
    title: name, contact: { name, handle: null },
  });
  for (const job of res.jobs) await finish(job.id, { status: 'sent' });
  expect(res.conversation_id).toBeTruthy();
  return { id: res.conversation_id!, thread };
}

const make = (body: Record<string, unknown>) => api('/api/discounts', { body });
const manualJobs = async (discountId: string) => (await sql(`SELECT * FROM outbox WHERE source = 'manual' AND ref_id = ?`, [discountId])).data.results;

beforeAll(async () => {
  await api('/api/agent-toggle', { body: { enabled: true } });
  await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' } } });
  // No Shopify app: only a webhook (or nothing) may be saved for these tests.
  await api('/api/connections/shopify', { method: 'PUT', body: { client_id: '', client_secret: '', admin_token: '' } });
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased', 'review')`);
});

afterAll(async () => {
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased', 'review')`);
  await sql('DELETE FROM discount_codes');
});

describe('discount codes', () => {
  it('lists defaults and says Shopify is not connected', async () => {
    const { status, data } = await api('/api/discounts');
    expect(status).toBe(200);
    expect(data.shopify.connected).toBe(false);
    expect(data.defaults).toMatchObject({ amount: 20, currency: 'GBP', applies_to: 'kits, bundles and batteries' });
    expect(data.defaults.message).toBe("Your discount code {CODE} is now live!! It's £20 off all kits, bundles and batteries");
    expect(data.defaults.message).not.toMatch(/[–—-]/);
  });

  it('without Shopify saves a draft, says so plainly and sends nothing until the owner confirms', async () => {
    const c = await chat('Jake');
    const code = unique('JAKE').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 30);
    const res = await make({ conversation_id: c.id, code, amount: 20, send: true });
    expect(res.status).toBe(201);
    expect(res.data.shopify).toMatchObject({ ok: false, status: 'not_connected', error_code: 'not_connected' });
    expect(res.data.shopify.message).toContain('Shopify is not connected');
    expect(res.data.needs_confirm).toBe(true);
    expect(res.data.queued).toBe(false);
    expect(res.data.discount).toMatchObject({ code, amount: 20, currency: 'GBP', status: 'draft', shopify_status: 'not_connected', channel: 'whatsapp', customer: 'Jake', outbox_id: null });
    expect(res.data.discount.message_text).toBe(`Your discount code ${code} is now live!! It's £20 off all kits, bundles and batteries`);
    expect(await manualJobs(res.data.discount.id)).toHaveLength(0);

    // Sending without confirming asks again, with the same honest reason.
    const refused = await api(`/api/discounts/${res.data.discount.id}/send`, { body: {} });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toBe('needs_confirm');
    expect(refused.data.message).toContain('Shopify is not connected');
    expect(await manualJobs(res.data.discount.id)).toHaveLength(0);
  });

  it('once confirmed queues exactly one manual message in the same chat, and a second send does not duplicate', async () => {
    const c = await chat('Mia');
    const code = 'MIA' + Date.now().toString(36).toUpperCase().slice(-6);
    const created = (await make({ conversation_id: c.id, code, amount: 35, applies_to: 'kits and batteries' })).data.discount;
    expect(created.status).toBe('draft');
    // Edited text goes out exactly as typed, no style clean up (the dash stays).
    const text = `Your code ${code} is live!! £35 off kits and batteries - enjoy`;
    const sent = await api(`/api/discounts/${created.id}/send`, { body: { confirm_exists: true, message_text: text } });
    expect(sent.status).toBe(200);
    expect(sent.data.already_queued).toBe(false);
    expect(sent.data.discount).toMatchObject({ status: 'live', shopify_status: 'owner_confirmed', message_status: 'pending' });

    const again = await api(`/api/discounts/${created.id}/send`, { body: { confirm_exists: true, message_text: 'something else' } });
    expect(again.status).toBe(200);
    expect(again.data.already_queued).toBe(true);
    const jobs = await manualJobs(created.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].dedupe_key).toBe(`discount:${created.id}`);
    expect(jobs[0].conversation_id).toBe(c.id);

    // The laptop picks it up for the right thread with the right words.
    const { data } = await sync(['whatsapp']);
    const job = data.jobs.find((j) => j.id === jobs[0].id);
    expect(job).toBeTruthy();
    expect(job!).toMatchObject({ kind: 'reply', source: 'manual', channel: 'whatsapp', parts: [text] });
    expect(job!.target.thread_external_id).toBe(c.thread);

    // Status follows the outbox.
    await finish(job!.id, { status: 'sent', sent_external_ids: [unique('out')] });
    const list = (await api('/api/discounts')).data.discounts;
    expect(list.find((d: any) => d.id === created.id)).toMatchObject({ status: 'sent', message_status: 'sent' });
    expect((await sql('SELECT status FROM discount_codes WHERE id = ?', [created.id])).data.results[0].status).toBe('sent');

    // Sent once means sent once.
    const third = await api(`/api/discounts/${created.id}/send`, { body: { confirm_exists: true } });
    expect(third.data.already_queued).toBe(true);
    expect(await manualJobs(created.id)).toHaveLength(1);

    // A sent code cannot be removed.
    expect((await api(`/api/discounts/${created.id}`, { method: 'DELETE' })).status).toBe(409);
  });

  it('a failed message shows as failed and can be sent again', async () => {
    const c = await chat('Leo');
    const code = 'LEO' + Date.now().toString(36).toUpperCase().slice(-6);
    const res = await make({ conversation_id: c.id, code, send: true, confirm_exists: true });
    expect(res.data.queued).toBe(true);
    const id = res.data.discount.id;
    const [first] = await manualJobs(id);
    const { data } = await sync(['whatsapp']);
    expect(data.jobs.map((j) => j.id)).toContain(first.id);
    await finish(first.id, { status: 'failed', error_code: 'thread_not_found', retryable: false });
    const failed = (await api('/api/discounts')).data.discounts.find((d: any) => d.id === id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('thread not found');

    const retry = await api(`/api/discounts/${id}/send`, { body: {} });
    expect(retry.data.already_queued).toBe(false);
    expect(retry.data.discount.status).toBe('live');
    const jobs = await manualJobs(id);
    expect(jobs).toHaveLength(2);
    expect(jobs.filter((j: any) => j.dedupe_key === `discount:${id}`)).toHaveLength(1);
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE ref_id = ? AND status = 'pending'`, [id]);
  });

  it('removes drafts only', async () => {
    const c = await chat('Ava');
    const code = 'AVA' + Date.now().toString(36).toUpperCase().slice(-6);
    const draft = (await make({ conversation_id: c.id, code })).data.discount;
    expect((await api(`/api/discounts/${draft.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await sql('SELECT COUNT(*) AS n FROM discount_codes WHERE id = ?', [draft.id])).data.results[0].n).toBe(0);
    expect((await api('/api/discounts/dc_nope', { method: 'DELETE' })).status).toBe(404);
  });

  it('checks what the owner typed', async () => {
    const c = await chat('Zed');
    const bad = async (body: Record<string, unknown>, error: string) => {
      const res = await make({ conversation_id: c.id, code: 'ZEDCODE1', ...body });
      expect(res.status, JSON.stringify(res.data)).toBeGreaterThanOrEqual(400);
      expect(res.data.error).toBe(error);
      expect(res.data.message).not.toMatch(/[–—]/);
    };
    await bad({ code: 'AB' }, 'invalid_code');
    await bad({ code: 'A'.repeat(31) }, 'invalid_code');
    await bad({ code: 'JAKE 20' }, 'invalid_code');
    await bad({ code: 'JAKE20!' }, 'invalid_code');
    await bad({ code: '.JAKE' }, 'invalid_code');
    await bad({ amount: 0 }, 'invalid_amount');
    await bad({ amount: 501 }, 'invalid_amount');
    await bad({ amount: 'lots' }, 'invalid_amount');
    await bad({ expires_at: '2001-01-01' }, 'invalid_expiry');
    await bad({ usage_limit: -2 }, 'invalid_usage_limit');
    await bad({ conversation_id: 'cv_nope' }, 'conversation_not_found');
    await bad({ code: undefined }, 'missing_field');

    // The code is saved exactly as typed; the same code twice (in any case) is refused.
    const ok = await make({ conversation_id: c.id, code: 'zedcode1', amount: '12.5', usage_limit: 1, expires_at: '2099-06-30' });
    expect(ok.status).toBe(201);
    expect(ok.data.discount).toMatchObject({ code: 'zedcode1', amount: 12.5, usage_limit: 1 });
    expect(ok.data.discount.message_text).toContain('£12.50 off');
    expect(ok.data.discount.expires_at).toBeGreaterThan(Date.now());
    await bad({}, 'code_taken');
  });
});

// ---- the agent making codes by itself -------------------------------------------------------------

const TEMPLATE = (code: string) => `Your discount code ${code} is now live!! It's £20 off all kits, bundles and batteries`;
const fakeShopify = (v: 'created' | 'taken' | null) => v
  ? sql(`INSERT INTO settings (key, value, updated_at) VALUES ('state:test_fake_shopify', ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(v)])
  : sql(`DELETE FROM settings WHERE key = 'state:test_fake_shopify'`);
const setDiscounts = (patch: Record<string, unknown>) => api('/api/settings/discounts', { method: 'PUT', body: patch });
const newCode = (prefix: string) => (prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
const codeJobs = async (convId: string) => (await sql(`SELECT * FROM outbox WHERE conversation_id = ? AND source = 'discount'`, [convId])).data.results;
const rowsFor = async (convId: string) => (await sql('SELECT * FROM discount_codes WHERE conversation_id = ? ORDER BY created_at', [convId])).data.results;
const urgentFor = async (convId: string) => (await sql(`SELECT * FROM urgent WHERE conversation_id = ? ORDER BY created_at`, [convId])).data.results;

/** A creator writes on TikTok (auto for these tests) asking for a code. */
async function ask(text: string, handle = unique('creator'), thread = unique('tt_'), before: { direction: 'in' | 'out'; body: string; external_id?: string }[] = []) {
  const msgId = unique('m');
  const res = await inbound('tiktok', thread, [...before, { external_id: msgId, direction: 'in', body: text }], {
    title: handle, contact: { name: handle, handle },
  });
  return { res, thread, handle, msgId };
}

describe('agent makes discount codes', () => {
  beforeAll(async () => {
    await api('/api/settings/channels', { method: 'PUT', body: { tiktok: { mode: 'auto' } } });
    await setDiscounts({ mode: 'auto', daily_cap: 10, one_per_customer: true });
    await fakeShopify(null);
  });
  afterAll(async () => {
    await fakeShopify(null);
    await setDiscounts({ mode: 'auto', daily_cap: 10, one_per_customer: true, amount: 20 });
    await api('/api/settings/channels', { method: 'PUT', body: { tiktok: { mode: 'review' } } });
  });

  it('has the discounts settings group with the owner defaults', async () => {
    const { data } = await api('/api/settings');
    expect(data.settings.discounts).toMatchObject({
      mode: 'auto', amount: 20, currency: 'GBP', applies_to: 'kits, bundles and batteries', daily_cap: 10, one_per_customer: true,
      message: "Your discount code {CODE} is now live!! It's £{AMOUNT} off all kits, bundles and batteries",
    });
    expect(data.settings.discounts.message).not.toMatch(/[–—-]/);
    expect((await setDiscounts({ mode: 'sometimes' })).status).toBe(400);
    expect((await setDiscounts({ message: 'Your code is live' })).data.error).toBe('invalid_field');
    expect((await setDiscounts({ daily_cap: -1 })).status).toBe(400);
  });

  it('auto without Shopify saves a draft and an Urgent card, and sends no code message', async () => {
    const code = newCode('MACCA');
    const { res, handle } = await ask(`I would like to make my discount code ${code}`, 'inmaccawetrust' + Date.now().toString(36));
    expect(res.action).toBe('escalate');
    // Only the holding line goes out, and it never mentions the code.
    for (const job of res.jobs) {
      expect(job.source).toBe('holding');
      expect(job.parts.join(' ')).not.toContain(code);
      expect(job.parts.join(' ')).not.toMatch(/live/i);
      await finish(job.id);
    }
    const convId = res.conversation_id!;
    expect(await codeJobs(convId)).toHaveLength(0);
    const [row] = await rowsFor(convId);
    expect(row).toMatchObject({ code, made_by: 'agent', status: 'draft', shopify_status: 'not_connected', message_text: TEMPLATE(code) });
    const [u] = await urgentFor(convId);
    expect(u).toMatchObject({ status: 'open', category: 'discount_code', discount_id: row.id, question: `${handle} wants discount code ${code}` });
    expect(u.reason).toContain('Shopify is not connected');

    // The Urgent screen gets the code card.
    const card = (await api('/api/urgent')).data.urgent.find((x: any) => x.id === u.id);
    expect(card.discount).toMatchObject({ id: row.id, code, message_text: TEMPLATE(code) });
    // The list marks it as the agent's.
    expect((await api('/api/discounts')).data.discounts.find((d: any) => d.id === row.id).made_by).toBe('agent');

    // Approve without Shopify asks the owner to confirm, then one tap with confirm sends the template once.
    const refused = await api(`/api/discounts/${row.id}/approve`, { body: {} });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toBe('needs_confirm');
    expect(await codeJobs(convId)).toHaveLength(0);

    await fakeShopify('created');
    const ok = await api(`/api/discounts/${row.id}/approve`, { body: {} });
    expect(ok.status).toBe(200);
    expect(ok.data.discount).toMatchObject({ status: 'live', shopify_status: 'created' });
    expect(ok.data.parts).toEqual([TEMPLATE(code)]);
    const again = await api(`/api/discounts/${row.id}/approve`, { body: {} });
    expect(again.data.already_queued).toBe(true);
    const jobs = await codeJobs(convId);
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].parts)).toEqual([TEMPLATE(code)]);
    expect((await urgentFor(convId))[0].status).toBe('answered');
    await fakeShopify(null);
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE conversation_id = ? AND status IN ('pending', 'leased')`, [convId]);
  });

  it('auto with Shopify makes the code and queues exactly one message, the template', async () => {
    await fakeShopify('created');
    const code = newCode('MACCA');
    const handle = 'inmaccawetrust' + Date.now().toString(36);
    const { res } = await ask(`yo bro I would like to make my discount code ${code}`, handle);
    expect(res.action).toBe('reply');
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0]).toMatchObject({ source: 'discount', parts: [TEMPLATE(code)] });
    const convId = res.conversation_id!;
    const all = (await sql(`SELECT * FROM outbox WHERE conversation_id = ?`, [convId])).data.results;
    expect(all).toHaveLength(1);
    const [row] = await rowsFor(convId);
    expect(row).toMatchObject({ code, made_by: 'agent', status: 'live', shopify_status: 'created', outbox_id: all[0].id });
    expect(await urgentFor(convId)).toHaveLength(0);
    const events = (await api('/api/events?limit=30')).data.events;
    expect(events.some((e: any) => e.message === `Made discount code ${code} for ${handle}`)).toBe(true);

    // Sent, then the same chat shows our own message: no takeover, nothing new.
    await finish(res.jobs[0]!.id, { status: 'sent', sent_external_ids: [unique('out')] });
    expect((await api('/api/discounts')).data.discounts.find((d: any) => d.id === row.id).status).toBe('sent');
  });

  it('one code per customer: a second code for the same person goes to the owner', async () => {
    await fakeShopify('created');
    const first = newCode('ONE');
    const { res, thread, handle, msgId } = await ask(`can i get a discount code ${first}`);
    expect(res.action).toBe('reply');
    await finish(res.jobs[0]!.id, { status: 'sent' });
    const second = newCode('TWO');
    const before = [
      { external_id: msgId, direction: 'in' as const, body: `can i get a discount code ${first}` },
      { direction: 'out' as const, body: TEMPLATE(first) },
    ];
    const next = await ask(`actually can my discount code be ${second}`, handle, thread, before);
    expect(next.res.action).toBe('escalate');
    const convId = res.conversation_id!;
    expect(await codeJobs(convId)).toHaveLength(1);
    const rows = await rowsFor(convId);
    const [u] = await urgentFor(convId);
    expect(u?.reason, JSON.stringify(next.res)).toContain(`already have the code ${first}`);
    expect(rows.map((r: any) => [r.code, r.status])).toEqual([[first, 'live'], [second, 'draft']]);
    expect(u.reason).toContain(`already have the code ${first}`);
    for (const job of next.res.jobs) await finish(job.id);
  });

  it('the daily cap sends the rest to the owner', async () => {
    await fakeShopify('created');
    await setDiscounts({ daily_cap: 0 });
    const code = newCode('CAP');
    const { res } = await ask(`hey I want my discount code to be ${code}`);
    expect(res.action).toBe('escalate');
    expect(await codeJobs(res.conversation_id!)).toHaveLength(0);
    expect((await rowsFor(res.conversation_id!))[0]).toMatchObject({ code, status: 'draft', made_by: 'agent' });
    expect((await urgentFor(res.conversation_id!))[0].reason).toContain('daily limit');
    for (const job of res.jobs) await finish(job.id);
    await setDiscounts({ daily_cap: 10 });
  });

  it('ask mode, low confidence, the shop name and a taken code all park instead of making', async () => {
    await fakeShopify('created');
    await setDiscounts({ mode: 'ask' });
    const a = await ask(`discount code ${newCode('ASK')} please`);
    expect(a.res.action).toBe('escalate');
    expect((await urgentFor(a.res.conversation_id!))[0].reason).toContain('You asked to check codes');
    await setDiscounts({ mode: 'auto' });

    const low = await ask(`lowconf discount code ${newCode('LOW')}`);
    expect(low.res.action).toBe('escalate');
    const brand = await ask('my discount code ACXEBIKES');
    expect(brand.res.action).toBe('escalate');
    expect((await urgentFor(brand.res.conversation_id!))[0].reason).toContain('shop name');

    await fakeShopify('taken');
    const taken = await ask(`discount code ${newCode('TAKEN')}`);
    expect(taken.res.action).toBe('escalate');
    expect((await urgentFor(taken.res.conversation_id!))[0].reason).toContain('already exists in Shopify');
    for (const r of [a, low, brand, taken]) {
      expect(await codeJobs(r.res.conversation_id!)).toHaveLength(0);
      for (const job of r.res.jobs) await finish(job.id);
    }
  });

  it('mode off leaves normal replies alone', async () => {
    await fakeShopify('created');
    await setDiscounts({ mode: 'off' });
    const code = newCode('OFF');
    const { res } = await ask(`I would like to make my discount code ${code}`);
    expect(res.action).toBe('reply');
    expect(res.jobs[0]!.parts[0]).toContain('mock reply to');
    expect(await rowsFor(res.conversation_id!)).toHaveLength(0);
    expect(await urgentFor(res.conversation_id!)).toHaveLength(0);
    await finish(res.jobs[0]!.id);
    await setDiscounts({ mode: 'auto' });
  });

  it('a code request without a code makes the reply ask for one', async () => {
    await fakeShopify('created');
    const { res } = await ask('hey can I get a discount code for my page');
    expect(res.action).toBe('reply');
    expect(res.jobs[0]!.parts.join(' ').toLowerCase()).toContain('what do you want your code to be');
    expect(await rowsFor(res.conversation_id!)).toHaveLength(0);
    await finish(res.jobs[0]!.id);
  });

  it('knows the creator offer from a seed note', async () => {
    const doc = (await api('/api/kb')).data.docs.find((d: any) => d.title === 'Creator sponsorship and discount codes');
    expect(doc).toMatchObject({ source: 'seed', category: 'faq', enabled: true });
    const full = (await api(`/api/kb/${doc.id}`)).data.doc.content;
    expect(full).toContain('£20 off all kits, bundles and batteries');
    expect(full).toContain('5% commission');
    expect(full).not.toMatch(/[–—]/);
  });

  it('a message with no code words never calls the code check', async () => {
    const { res } = await ask('how long is delivery to leeds');
    expect(res.action).toBe('reply');
    expect(res.jobs[0]!.parts[0]).toContain('mock reply to');
    await finish(res.jobs[0]!.id);
  });
});

describe('code request rules (no server)', async () => {
  const { planCodeRequest, codeProblem, brandWords, promisesLiveCode, mentionsCode } = await import('../../src/discounts/rules');
  const { mockDiscountRequest } = await import('../../src/brain/discount');
  const { DEFAULT_SETTINGS } = await import('../../src/lib/settings');
  const base = {
    settings: DEFAULT_SETTINGS.discounts, request: { wants_code: true, code: 'MACCA5', confidence: 0.95 }, code: 'MACCA5',
    problem: null, taken_here: false, contact_code: null, made_today: 0,
  };

  it('makes the code only when every check passes', () => {
    expect(planCodeRequest(base)).toEqual({ kind: 'create', code: 'MACCA5' });
    expect(planCodeRequest({ ...base, settings: { ...base.settings, mode: 'ask' } }).kind).toBe('park');
    expect(planCodeRequest({ ...base, settings: { ...base.settings, mode: 'off' } }).kind).toBe('none');
    expect(planCodeRequest({ ...base, request: { ...base.request, confidence: 0.5 } }).kind).toBe('park');
    expect(planCodeRequest({ ...base, taken_here: true }).kind).toBe('park');
    expect(planCodeRequest({ ...base, contact_code: 'OLD1' }).kind).toBe('park');
    expect(planCodeRequest({ ...base, contact_code: 'OLD1', settings: { ...base.settings, one_per_customer: false } }).kind).toBe('create');
    expect(planCodeRequest({ ...base, made_today: 10 }).kind).toBe('park');
    expect(planCodeRequest({ ...base, problem: 'rude' }).kind).toBe('park');
    expect(planCodeRequest({ ...base, request: { ...base.request, code: null }, code: null }).kind).toBe('ask_customer');
    expect(planCodeRequest({ ...base, request: { ...base.request, code: 'X' }, code: null }).kind).toBe('ask_customer');
    expect(planCodeRequest({ ...base, request: { wants_code: false, code: null, confidence: 0.9 } }).kind).toBe('none');
  });

  it('spots rude codes and the shop name alone', () => {
    const brands = brandWords(DEFAULT_SETTINGS);
    expect(codeProblem('MACCA5', brands)).toBeNull();
    expect(codeProblem('ACX', brands)).toContain('shop name');
    expect(codeProblem('ACX20', brands)).toContain('shop name');
    expect(codeProblem('ACXEBIKES', brands)).toContain('shop name');
    expect(codeProblem('FUCKOFF1', brands)).toContain('offensive');
    expect(codeProblem('12345', brands)).toContain('numbers');
  });

  it('reads code requests in test mode and filters cheaply first', () => {
    const h = (body: string) => [{ direction: 'in' as const, author: 'customer' as const, body, kind: 'text' as const, ts: 1 }];
    expect(mockDiscountRequest(h('I would like to make my discount code MACCA5'))).toMatchObject({ wants_code: true, code: 'MACCA5' });
    expect(mockDiscountRequest(h('can my discount code be "jakey"'))).toMatchObject({ wants_code: true, code: 'jakey' });
    expect(mockDiscountRequest(h('can i get a discount code'))).toMatchObject({ wants_code: true, code: null });
    expect(mockDiscountRequest(h('how long is delivery')).wants_code).toBe(false);
    expect(mentionsCode('whats the promo')).toBe(true);
    expect(mentionsCode('how long is delivery')).toBe(false);
  });

  it('catches a reply that says a code is live', () => {
    expect(promisesLiveCode('your code MACCA5 is now live bro')).toBe(true);
    expect(promisesLiveCode('your discount code is ready')).toBe(true);
    expect(promisesLiveCode('once your code is live put it in your bio')).toBe(false);
    expect(promisesLiveCode('delivery is 2 to 4 days')).toBe(false);
  });
});

describe('creator style codes', () => {
  it('keeps the code exactly as the customer wrote it', async () => {
    const { normaliseCode } = await import('../../src/discounts/index');
    expect(normaliseCode('User_1.5kw')).toBe('User_1.5kw');
    expect(normaliseCode('"amzz.5kw"')).toBe('amzz.5kw');
    expect(normaliseCode('5kwkilla')).toBe('5kwkilla');
    expect(normaliseCode('CarlitoACX')).toBe('CarlitoACX');
    expect(normaliseCode('MACCA5.')).toBe('MACCA5');
    expect(normaliseCode('ab')).toBeNull();
    expect(normaliseCode('bad code')).toBe('badcode');
  });
});
