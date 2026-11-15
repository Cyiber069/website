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
    await bad({ code: 'JAKE-20' }, 'invalid_code');
    await bad({ amount: 0 }, 'invalid_amount');
    await bad({ amount: 501 }, 'invalid_amount');
    await bad({ amount: 'lots' }, 'invalid_amount');
    await bad({ expires_at: '2001-01-01' }, 'invalid_expiry');
    await bad({ usage_limit: -2 }, 'invalid_usage_limit');
    await bad({ conversation_id: 'cv_nope' }, 'conversation_not_found');
    await bad({ code: undefined }, 'missing_field');

    // Lower case is fine and saved upper case; the same code twice is refused.
    const ok = await make({ conversation_id: c.id, code: 'zedcode1', amount: '12.5', usage_limit: 1, expires_at: '2099-06-30' });
    expect(ok.status).toBe(201);
    expect(ok.data.discount).toMatchObject({ code: 'ZEDCODE1', amount: 12.5, usage_limit: 1 });
    expect(ok.data.discount.message_text).toContain('£12.50 off');
    expect(ok.data.discount.expires_at).toBeGreaterThan(Date.now());
    await bad({}, 'code_taken');
  });
});
