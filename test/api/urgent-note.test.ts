import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, finish, inbound, sql, sync, unique } from '../helpers/client';

// "Tell the agent what's going on": the owner explains, the agent writes and sends the reply.
const wa = () => `${unique('4479')}@c.us`;

/** A WhatsApp chat where the mock brain escalated, with its holding line already sent. */
async function escalated(text = 'unknown-question can I get a refund') {
  const thread = wa();
  const msgId = unique('m');
  const res = await inbound('whatsapp', thread, [{ external_id: msgId, direction: 'in', body: text }]);
  expect(res.action).toBe('escalate');
  const holding: string[] = [];
  for (const job of res.jobs) { holding.push(...job.parts); await finish(job.id, { status: 'sent' }); }
  const [u] = (await sql(`SELECT * FROM urgent WHERE conversation_id = ? AND status = 'open'`, [res.conversation_id])).data.results;
  expect(u).toBeTruthy();
  return { thread, msgId, convId: res.conversation_id!, urgentId: u.id as string, holding, text };
}
const urgentJobs = async (urgentId: string) => (await sql(`SELECT * FROM outbox WHERE source = 'urgent' AND ref_id = ?`, [urgentId])).data.results;
const learnedFor = async (urgentId: string) => (await sql(`SELECT * FROM kb_docs WHERE source = 'learned' AND source_ref = ?`, [urgentId])).data.results;

beforeAll(async () => {
  await api('/api/agent-toggle', { body: { enabled: true } });
  await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' } } });
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased', 'review')`);
});
afterAll(async () => {
  await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' } } });
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased', 'review')`);
});

describe('owner note on an Urgent item', () => {
  it('queues exactly one reply to the right thread, keeps the note on the chat and learns it', async () => {
    const c = await escalated();
    const note = 'the 72v batteries are back in stock on Friday';
    const res = await api(`/api/urgent/${c.urgentId}/note`, { body: { note } });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data).toMatchObject({ ok: true, queued_as: 'pending', learned: true, status: 'answered' });
    expect(res.data.parts[0]).toContain('mock reply following owner guidance');
    expect(res.data.parts.join(' ')).not.toContain(note);

    const jobs = await urgentJobs(c.urgentId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'pending', conversation_id: c.convId, id: res.data.outbox_id });
    expect(JSON.parse(jobs[0].target).thread_external_id).toBe(c.thread);
    const { data } = await sync(['whatsapp']);
    const job = data.jobs.find((j) => j.id === jobs[0].id);
    expect(job?.parts).toEqual(res.data.parts);

    const conv = (await sql('SELECT context_notes, status FROM conversations WHERE id = ?', [c.convId])).data.results[0];
    const notes = JSON.parse(conv.context_notes);
    expect(notes.some((n: string) => n.startsWith('Owner guidance') && n.includes(note))).toBe(true);
    expect(conv.status).toBe('open');
    const u = (await sql('SELECT * FROM urgent WHERE id = ?', [c.urgentId])).data.results[0];
    expect(u).toMatchObject({ status: 'answered', owner_note: note, outbox_id: res.data.outbox_id });

    const learned = await learnedFor(c.urgentId);
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({ category: 'learned', id: res.data.kb_doc_id });
    expect(learned[0].title).toContain('Owner note');
    // It shows on the Knowledge screen as a learned doc the owner can change or delete.
    expect((await api('/api/kb')).data.docs.find((d: any) => d.id === learned[0].id)).toMatchObject({ source: 'learned' });
    expect((await api(`/api/kb/${learned[0].id}`, { method: 'DELETE' })).status).toBe(200);

    // A later message in the same chat sees the note.
    await finish(job!.id, { status: 'sent', sent_external_ids: [unique('out')] });
    const later = await inbound('whatsapp', c.thread, [
      { external_id: c.msgId, direction: 'in', body: c.text },
      ...c.holding.map((b) => ({ direction: 'out' as const, body: b })),
      { direction: 'out', body: res.data.parts[0] },
      { external_id: unique('m'), direction: 'in', body: 'nice so can I order one now' },
    ]);
    expect(later.action).toBe('reply');
    expect(later.jobs[0]!.parts[0]).toContain('mock reply following owner guidance to: nice so can I order one now');
    await finish(later.jobs[0]!.id);

    // Done once means done.
    expect((await api(`/api/urgent/${c.urgentId}/note`, { body: { note } })).status).toBe(409);
    expect(await urgentJobs(c.urgentId)).toHaveLength(1);
  });

  it('remember off stores nothing in knowledge, and a note about one customer is kept on the chat only', async () => {
    const off = await escalated();
    const a = await api(`/api/urgent/${off.urgentId}/note`, { body: { note: 'free delivery on kits this week', remember: false } });
    expect(a.status).toBe(200);
    expect(a.data.learned).toBe(false);
    expect(await learnedFor(off.urgentId)).toHaveLength(0);
    expect(await urgentJobs(off.urgentId)).toHaveLength(1);

    const personal = await escalated();
    const b = await api(`/api/urgent/${personal.urgentId}/note`, { body: { note: 'this guy already got a refund last week, tell him politely we cannot do another one' } });
    expect(b.status).toBe(200);
    expect(b.data.learned).toBe(false);
    expect(await learnedFor(personal.urgentId)).toHaveLength(0);
    const notes = JSON.parse((await sql('SELECT context_notes FROM conversations WHERE id = ?', [personal.convId])).data.results[0].context_notes);
    expect(notes.join(' ')).toContain('already got a refund');
  });

  it('follows the channel mode and a note that says to wait', async () => {
    await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'review' } } });
    const r = await escalated();
    const res = await api(`/api/urgent/${r.urgentId}/note`, { body: { note: 'sizes run small so go one up' } });
    expect(res.data.queued_as).toBe('review');
    const jobs = await urgentJobs(r.urgentId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('review');
    await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' } } });

    const w = await escalated();
    const hold = await api(`/api/urgent/${w.urgentId}/note`, { body: { note: 'wait, I will call him tomorrow', remember: false } });
    expect(hold.status).toBe(200);
    expect(hold.data).toMatchObject({ parts: [], queued_as: 'none', status: 'answered' });
    expect(await urgentJobs(w.urgentId)).toHaveLength(0);

    expect((await api(`/api/urgent/${w.urgentId}/note`, { body: { note: '' } })).status).toBe(400);
  });
});
