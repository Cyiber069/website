// Rows read and written a day (the free plan allows 5 million and 100,000, reset at 00:00 UTC). Each part
// of the diet after the day the limit ran out, counted with the test mode headers, and the budget guard.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, api, cron, finish, inbound, sql, sync, unique } from '../helpers/client';
import { londonTime } from '../../src/lib/time';

const wa = () => `${unique('4472')}@c.us`;
const msg = (id: string, body: string, direction: 'in' | 'out' = 'in') => ({ external_id: id, direction, body, ts: null });
const conv = async (id: string) => (await sql('SELECT * FROM conversations WHERE id = ?', [id])).data.results[0];
const HOUR = 3_600_000, MIN = 60_000;

const diagnostic = (kind: string, data: Record<string, unknown> = { probe: true }) =>
  api('/api/agent/diagnostics', { as: 'device', body: { kind, channel: 'whatsapp', data } });
const cronAt = async (now: number) => {
  const res = await fetch(`${BASE()}/api/test/cron`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now }) });
  expect(res.status).toBe(200);
};
/** A minute that is (or is not) one of the every 5th minutes the background work runs in at a high level. */
const minuteAt = (fifth: boolean) => {
  const m = Math.floor(Date.now() / MIN);
  for (let k = m; ; k++) if ((k % 5 === 0) === fifth) return k * MIN + 1000;
};
const setUsage = (pct: number, day = new Date().toISOString().slice(0, 10)) =>
  sql(`INSERT INTO settings (key, value, updated_at) VALUES ('state:d1_usage', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify({ day, read: Math.round((pct / 100) * 5_000_000), written: 0, updated_at: Date.now() }), Date.now()]);
const clearUsage = () => sql(`DELETE FROM settings WHERE key IN ('state:d1_usage', 'state:monitor')`);

function londonDayStart(now: number): number {
  const lt = londonTime(now);
  return now - (lt.hour * HOUR + lt.minute * MIN) - (now % MIN);
}

beforeAll(async () => {
  await api('/api/agent-toggle', { body: { enabled: true } });
  await api('/api/settings/channels', { method: 'PUT', body: { whatsapp: { mode: 'auto' } } });
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased')`);
  await sql('UPDATE conversations SET needs_reply_since = NULL, processing_until = NULL, retry_at = NULL');
  await clearUsage();
});
afterAll(async () => {
  await clearUsage();
  await sync();
  await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'leased')`);
  await sql('UPDATE conversations SET needs_reply_since = NULL, processing_until = NULL, retry_at = NULL');
});

describe('diagnostics', () => {
  it('a post reads a few rows instead of the newest 400, and the table stays about 400 rows', async () => {
    await fetch(`${BASE()}/api/test/bust`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 450) INSERT INTO diagnostics (ts, device_id, channel, kind, data) SELECT ?, 'dev', 'whatsapp', 'note', '{}' FROM n`, [Date.now()]);
    const reads: number[] = [];
    for (let i = 0; i < 25; i++) {
      const res = await diagnostic(i % 2 ? 'error' : 'dom_snapshot');
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      reads.push(res.rows);
    }
    // The old trim read 400 rows on every post. Now a post reads the device row and its own insert; one
    // post in 20 also deletes the rows below the newest 400 (the first one here deletes the 70 extra).
    expect(reads.filter((r) => r <= 10).length).toBeGreaterThanOrEqual(22);
    expect(Math.max(...reads)).toBeLessThan(120);
    const n = (await sql('SELECT COUNT(*) AS n FROM diagnostics')).data.results[0].n;
    expect(n).toBeGreaterThanOrEqual(400);
    expect(n).toBeLessThanOrEqual(420);
  });

  it('keeps at most 30 of one kind from one laptop an hour, and answers ok either way', async () => {
    await fetch(`${BASE()}/api/test/bust`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const before = (await sql(`SELECT COUNT(*) AS n FROM diagnostics WHERE kind = 'selector_miss'`)).data.results[0].n;
    const kept: boolean[] = [];
    for (let i = 0; i < 34; i++) {
      const res = await diagnostic('selector_miss', { i });
      expect(res.status).toBe(200);
      expect(res.data.ok).toBe(true);
      kept.push(res.data.kept !== false);
    }
    expect(kept.filter(Boolean)).toHaveLength(30);
    expect(kept.slice(30)).toEqual([false, false, false, false]);
    expect((await sql(`SELECT COUNT(*) AS n FROM diagnostics WHERE kind = 'selector_miss'`)).data.results[0].n).toBe(before + 30);
    // Another kind still gets through.
    expect((await diagnostic('note')).data.kept).not.toBe(false);
  });
});

describe('dashboard answers from memory', () => {
  it('Live polled again reads nothing but the session row', async () => {
    await api('/api/overview');
    await api('/api/overview');
    const third = await api('/api/overview');
    expect(third.status).toBe(200);
    expect(third.queries).toBeLessThanOrEqual(2);
    expect(third.rows).toBeLessThanOrEqual(4);
    for (const path of ['/api/takeovers', '/api/events?limit=20', '/api/urgent', '/api/conversations', '/api/devices', '/api/health']) {
      await api(path);
      // (A write in between, such as the session's once in 10 minutes touch, starts the answer again.)
      const again = [await api(path), await api(path)];
      expect(again[0]!.status).toBe(200);
      expect(Math.min(...again.map((a) => a.queries)), path).toBeLessThanOrEqual(2);
    }
    expect(third.data.budget).toMatchObject({ level: 'normal', poll_seconds: 30 });
  });

  it('shows an owner change at once', async () => {
    await api('/api/overview');
    await api('/api/agent-toggle', { body: { enabled: false } });
    expect((await api('/api/overview')).data.agent.enabled).toBe(false);
    await api('/api/agent-toggle', { body: { enabled: true } });
    expect((await api('/api/overview')).data.agent.enabled).toBe(true);
    // A chat paused from the dashboard is on the Live card straight away.
    const r = await inbound('whatsapp', wa(), [msg('p1', 'hello there')]);
    for (const j of r.jobs) await finish(j.id);
    await api('/api/takeovers');
    await api(`/api/conversations/${r.conversation_id}/pause`, { body: { minutes: 30 } });
    expect((await api('/api/takeovers')).data.chats.some((c: any) => c.id === r.conversation_id)).toBe(true);
    await api(`/api/conversations/${r.conversation_id}/pause`, { body: { minutes: 0 } });
    expect((await api('/api/takeovers')).data.chats.some((c: any) => c.id === r.conversation_id)).toBe(false);
  });

  it("counts today's messages and replies exactly, once each, as they come", async () => {
    const start = (await api('/api/overview')).data.counts;
    const t = wa();
    const a = await inbound('whatsapp', t, [msg('c1', 'how long is delivery to york')]);
    expect(a.action).toBe('reply');
    const mid = (await api('/api/overview')).data.counts;
    expect(mid.inbound_today).toBe(start.inbound_today + 1);
    expect(mid.conversations_today).toBe(start.conversations_today + 1);
    await finish(a.jobs[0]!.id, { status: 'sent', sent_external_ids: ['c1out'] });
    const sent = (await api('/api/overview')).data.counts;
    expect(sent.sent_today).toBe(start.sent_today + a.jobs.length);
    expect(sent.auto_today).toBe(start.auto_today + 1);
    // Posted again and again: nothing counted twice, even inside the 2 minute overlap.
    for (let i = 0; i < 3; i++) await inbound('whatsapp', t, [msg('c1', 'how long is delivery to york'), msg('c1out', a.jobs[0]!.parts[0]!, 'out')]);
    const b = await inbound('whatsapp', t, [msg('c1', 'how long is delivery to york'), msg('c1out', a.jobs[0]!.parts[0]!, 'out'), msg('c2', 'and to leeds')]);
    for (const j of b.jobs) await finish(j.id);
    const end = (await api('/api/overview')).data.counts;
    expect(end.inbound_today).toBe(start.inbound_today + 2);
    expect(end.conversations_today).toBe(start.conversations_today + 1);
    // The same as counting everything again.
    const day = londonDayStart(Date.now());
    const full = (await sql(
      `SELECT (SELECT COUNT(*) FROM messages WHERE direction = 'in' AND status = 'received' AND created_at >= ?1) AS inbound,
              (SELECT COUNT(*) FROM outbox WHERE status = 'sent' AND source != 'alert' AND sent_at >= ?1) AS sent,
              (SELECT COUNT(*) FROM outbox WHERE status = 'sent' AND source = 'auto' AND sent_at >= ?1) AS auto,
              (SELECT COUNT(*) FROM conversations WHERE last_inbound_at >= ?1) AS convs,
              (SELECT COUNT(*) FROM urgent WHERE created_at >= ?1) AS escalated`, [day])).data.results[0];
    await fetch(`${BASE()}/api/test/bust`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const fresh = (await api('/api/overview')).data.counts; // counted again from scratch
    expect(fresh).toMatchObject({ inbound_today: full.inbound, sent_today: full.sent, auto_today: full.auto, conversations_today: full.convs, escalated_today: full.escalated });
    expect(end).toMatchObject({ inbound_today: full.inbound, sent_today: full.sent, auto_today: full.auto, conversations_today: full.convs, escalated_today: full.escalated });
  });

  it('takeovers always carry the clock of the request, also from memory', async () => {
    const one = await api('/api/takeovers');
    await new Promise((r) => setTimeout(r, 1100));
    const two = await api('/api/takeovers');
    expect(two.queries).toBeLessThanOrEqual(2);
    expect(two.data.now - one.data.now).toBeGreaterThanOrEqual(1000);
  });

  it('the Inbox list reads the newest 50 chats, only the columns it shows, through an index', async () => {
    const idx = (await sql(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('conversations_channel_updated', 'recovery_runs_started')`)).data.results.map((r: any) => r.name).sort();
    expect(idx).toEqual(['conversations_channel_updated', 'recovery_runs_started']);
    await fetch(`${BASE()}/api/test/bust`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'dashboard' }) });
    const list = await api('/api/conversations?channel=whatsapp');
    expect(list.status).toBe(200);
    expect(list.data.conversations.length).toBeLessThanOrEqual(50);
    expect(Object.keys(list.data.conversations[0]).sort()).toEqual(['channel', 'customer', 'id', 'last_direction', 'opted_out', 'paused', 'preview', 'status', 'subject', 'updated_at']);
    // One row for the chat and one for its contact, plus the session.
    expect(list.rows).toBeLessThanOrEqual(list.data.conversations.length * 2 + 25);
  });
});

describe('settings', () => {
  it('a change is used at once by the next request', async () => {
    await api('/api/settings/pacing', { method: 'PUT', body: { settle_seconds: 6 } });
    expect((await sync(['whatsapp'])).data.config.pacing.settle_seconds).toBe(6);
    await api('/api/settings/pacing', { method: 'PUT', body: { settle_seconds: 4 } });
    expect((await sync(['whatsapp'])).data.config.pacing.settle_seconds).toBe(4);
    // A change saves a new revision for the other isolates.
    expect(Number(JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'state:settings_rev'`)).data.results[0].value))).toBeGreaterThan(Date.now() - 60_000);
  });

  it('a sync does not read the settings again within 30 s', async () => {
    await sync(['whatsapp']);
    const again = await sync(['whatsapp']);
    // Device row, the two lease reads of the one ready channel, one per job handed out, the selectors and
    // the vision check: no settings read.
    const settingsReads = again.queries - (1 + 2 + again.data.jobs.length + 1 + 1);
    expect(settingsReads).toBeLessThanOrEqual(0);
    for (const j of again.data.jobs) await finish(j.id);
  });
});

describe('a chat posted again with nothing new', () => {
  it('is answered nothing_new from one query, before the history or the knowledge', async () => {
    const t = wa();
    const first = await inbound('whatsapp', t, [msg('n1', 'hi do you ship to scotland')]);
    expect(first.action).toBe('reply');
    await finish(first.jobs[0]!.id, { status: 'sent', sent_external_ids: ['n1out'] });
    const seen = [msg('n1', 'hi do you ship to scotland'), msg('n1out', first.jobs[0]!.parts[0]!, 'out')];
    const again = await inbound('whatsapp', t, seen);
    expect(again).toMatchObject({ reason: 'nothing_new', action: 'none', final: true });
    // The device row, then the one query (the settings come from memory).
    expect(again.queries).toBeLessThanOrEqual(3);
    expect(again.written).toBe(0);
    expect(again.rows).toBeLessThan(20);
  });

  it('the same report as the last one stored needs no message lookups', async () => {
    const t = wa();
    const seen = Array.from({ length: 30 }, (_, i) => msg(`s${i}`, i % 2 ? `older reply ${i}` : `older question ${i}`, i % 2 ? 'out' : 'in'));
    seen.push(msg('s30', 'ignore-me thanks'));
    const first = await inbound('whatsapp', t, seen);
    expect(first.new_inbound).toBe(1);
    const same = await inbound('whatsapp', t, seen);
    expect(same.reason).toBe('nothing_new');
    expect(same.queries).toBeLessThanOrEqual(3);
    // About two rows per message without the report key: 60 here.
    expect(same.rows).toBeLessThan(20);
  });

  it('takes the full path when something did change', async () => {
    const t = wa();
    const first = await inbound('whatsapp', t, [msg('f1', 'hello')]);
    for (const j of first.jobs) await finish(j.id, { status: 'sent', sent_external_ids: ['f1out'] });
    const seen = [msg('f1', 'hello'), msg('f1out', first.jobs[0]!.parts[0]!, 'out')];
    // A new name on the chat is stored.
    const renamed = await inbound('whatsapp', t, seen, { title: 'New Name', contact: { name: 'New Name' } });
    expect(renamed.reason).toBe('nothing_new');
    expect((await conv(first.conversation_id!)).title).toBe('New Name');
    // A message without an id, or a new message, goes the full way.
    const noId = await inbound('whatsapp', t, [...seen, { external_id: null, direction: 'in', body: 'are you there' }], { title: 'New Name', contact: { name: 'New Name' } });
    expect(noId.new_inbound).toBe(1);
    for (const j of noId.jobs) await finish(j.id);
  });

  it('still says a reply is waiting in the queue', async () => {
    const t = wa();
    const first = await inbound('whatsapp', t, [msg('q1', 'hey')]);
    for (const j of first.jobs) await finish(j.id, { status: 'sent', sent_external_ids: ['q1out'] });
    await api(`/api/conversations/${first.conversation_id}/send`, { body: { text: 'owner here' } });
    const again = await inbound('whatsapp', t, [msg('q1', 'hey'), msg('q1out', first.jobs[0]!.parts[0]!, 'out')]);
    expect(again).toMatchObject({ reason: 'nothing_new', jobs_pending: true });
    expect(again.queries).toBeLessThanOrEqual(3);
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE conversation_id = ? AND status = 'pending'`, [first.conversation_id]);
  });
});

describe('a chat whose brain keeps failing', () => {
  it('waits longer after each failure and answers the posts in between from one query', async () => {
    const t = wa();
    const words = [msg('b1', 'mock-overloaded is the 1000w kit in stock')];
    const first = await inbound('whatsapp', t, words);
    expect(first).toMatchObject({ reason: 'brain_error', final: false });
    expect(first.retry_after_ms).toBeLessThan(10_000); // the model's own retry time, as before
    expect((await conv(first.conversation_id!)).brain_fails).toBe(1);
    // The laptop posts it again: the second failure in a row waits 30 s.
    const second = await inbound('whatsapp', t, words);
    expect(second).toMatchObject({ reason: 'brain_error', final: false });
    expect(second.retry_after_ms).toBeGreaterThanOrEqual(30_000);
    const row = await conv(first.conversation_id!);
    expect(row.brain_fails).toBe(2);
    expect(row.retry_at).toBeGreaterThan(Date.now() + 25_000);
    expect(row.needs_reply_since).not.toBeNull(); // still a customer waiting
    // Posted again before that: no history, no knowledge, no model call.
    const early = await inbound('whatsapp', t, words);
    expect(early).toMatchObject({ reason: 'brain_error', final: false });
    expect(early.retry_after_ms).toBeGreaterThan(20_000);
    expect(early.queries).toBeLessThanOrEqual(3);
    expect(early.written).toBe(0);
    expect((await conv(first.conversation_id!)).brain_fails).toBe(2);
    // A new message from the customer is tried at once, and an answer starts the count again.
    const fresh = await inbound('whatsapp', t, [...words, msg('b2', 'or the 2000w one')]);
    expect(fresh.action).toBe('reply');
    for (const j of fresh.jobs) await finish(j.id);
    const after = await conv(first.conversation_id!);
    expect(after.brain_fails).toBe(0);
    expect(after.retry_at).toBeNull();
  });
});

describe('knowledge in memory', () => {
  it('the same search twice reads the index once, and a change is seen at once', async () => {
    const q = `/api/kb/search?q=${encodeURIComponent('how long is delivery to wales for the 2000w kit')}`;
    await api(q);
    const again = await api(q);
    expect(again.status).toBe(200);
    expect(again.data.results.length).toBeGreaterThan(0);
    expect(again.queries).toBeLessThanOrEqual(2);
    const word = unique('zorblax');
    const version = async () => Number(JSON.parse((await sql(`SELECT value FROM settings WHERE key = 'state:kb_version'`)).data.results[0]?.value ?? '0'));
    const v0 = await version();
    const note = await api('/api/kb/note', { body: { title: `Note ${word}`, content: `The ${word} rack fits every frame.` } });
    expect(note.status).toBe(200);
    expect(await version()).toBe(v0 + 1);
    const found = await api(`/api/kb/search?q=${word}`);
    expect(found.data.results.map((r: any) => r.doc_id)).toContain(note.data.doc.id);
    await api(`/api/kb/${note.data.doc.id}`, { method: 'PATCH', body: { enabled: false } });
    expect((await api(`/api/kb/search?q=${word}`)).data.results.map((r: any) => r.doc_id)).not.toContain(note.data.doc.id);
    expect((await api('/api/kb')).data.docs.find((d: any) => d.id === note.data.doc.id).enabled).toBe(false);
    await api(`/api/kb/${note.data.doc.id}`, { method: 'DELETE' });
    expect((await api('/api/kb')).data.docs.some((d: any) => d.id === note.data.doc.id)).toBe(false);
    expect(await version()).toBe(v0 + 3);
  });

  it('ranks with the index alone exactly as the full query did', async () => {
    const match = '"delivery" OR "wales" OR "2000w" OR "kit" OR "shipping" OR "courier" OR "battery"';
    const old = (await sql(
      `SELECT c.id FROM kb_fts JOIN kb_chunks c ON c.id = kb_fts.rowid JOIN kb_docs d ON d.id = c.doc_id
       WHERE kb_fts MATCH ? AND d.enabled = 1 AND d.pinned = 0 ORDER BY bm25(kb_fts, 6.0, 3.0, 1.0) LIMIT 60`, [match])).data.results.map((r: any) => r.id);
    const skipped = (await sql(`SELECT COUNT(*) AS n FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE d.enabled != 1 OR d.pinned = 1`)).data.results[0].n;
    const ranked = (await sql(`SELECT rowid FROM kb_fts WHERE kb_fts MATCH ? AND rank MATCH 'bm25(6.0, 3.0, 1.0)' ORDER BY rank LIMIT ?`, [match, 60 + skipped + 5])).data.results.map((r: any) => r.rowid);
    const allowed = new Set((await sql(`SELECT c.id FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE d.enabled = 1 AND d.pinned = 0`)).data.results.map((r: any) => r.id));
    expect(old.length).toBeGreaterThan(5);
    expect(ranked.filter((id: number) => allowed.has(id)).slice(0, 60)).toEqual(old);
  });

  it('a second decision on the same words does not search again', async () => {
    const words = 'what is the range of the 1000w kit on hills';
    const a = await inbound('whatsapp', wa(), [msg('k1', words)]);
    for (const j of a.jobs) await finish(j.id);
    const b = await inbound('whatsapp', wa(), [msg('k1', words)]);
    for (const j of b.jobs) await finish(j.id);
    expect(b.action).toBe('reply');
    // A whole new chat with a decision: well under the 1,300 rows a decision read before.
    expect(b.rows).toBeLessThan(150);
  });
});

describe('budget guard', () => {
  afterAll(async () => { await clearUsage(); await sql(`DELETE FROM events WHERE type = 'usage_high'`); });

  it('below 70%: everything as usual', async () => {
    await clearUsage();
    expect((await sync(['whatsapp'])).data.config.poll_seconds).toBe(20);
    expect((await api('/api/overview')).data.budget).toMatchObject({ level: 'normal', poll_seconds: 30 });
  });

  it('from 70%: the laptop syncs every 60 s, the dashboard every 2 min, and the owner is told once', async () => {
    await clearUsage();
    await setUsage(72);
    const s = await sync(['whatsapp']);
    expect(s.data.config.poll_seconds).toBe(60);
    // The old build (0.3.2) reads the same field.
    const old = await api('/api/agent/sync', { as: 'device', body: { version: '0.3.2', status: { channels: { whatsapp: { state: 'ready', unread: 0, busy: false } } } } });
    expect(old.data.config.poll_seconds).toBe(60);
    expect((await api('/api/overview')).data.budget).toMatchObject({ level: 'high', poll_seconds: 120 });
    expect((await api('/api/health')).data.budget.level).toBe('high');
    await cronAt(minuteAt(false));
    const ev = (await sql(`SELECT * FROM events WHERE type = 'usage_high' ORDER BY id DESC`)).data.results;
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev[0].message).toContain('Database use is high today.');
    expect(ev[0].message).toContain('The agent is slowing down background work so it keeps replying.');
    expect(ev[0].message).not.toMatch(/[–—]/);
    const count = ev.length;
    await cronAt(minuteAt(true));
    await cronAt(minuteAt(false));
    expect((await sql(`SELECT COUNT(*) AS n FROM events WHERE type = 'usage_high'`)).data.results[0].n).toBe(count);
  });

  it('from 70%: background work waits for every 5th minute', async () => {
    await setUsage(75);
    await sql('UPDATE conversations SET needs_reply_since = NULL');
    await sql(`DELETE FROM settings WHERE key = 'state:cleanup_at'`);
    await cronAt(minuteAt(false));
    expect((await sql(`SELECT value FROM settings WHERE key = 'state:cleanup_at'`)).data.results).toHaveLength(0);
    // In a 5th minute it runs (unless the 20:00 checkout run took that minute: then the next one).
    for (let i = 0; i < 3; i++) {
      await cronAt(minuteAt(true));
      if ((await sql(`SELECT value FROM settings WHERE key = 'state:cleanup_at'`)).data.results.length) break;
    }
    expect((await sql(`SELECT value FROM settings WHERE key = 'state:cleanup_at'`)).data.results).toHaveLength(1);
  });

  it('from 90%: only customer replies and sends keep running', async () => {
    await setUsage(92);
    expect((await api('/api/overview')).data.budget.level).toBe('critical');
    // Diagnostics are answered but not kept.
    const before = (await sql('SELECT COUNT(*) AS n FROM diagnostics')).data.results[0].n;
    expect((await diagnostic('error')).data).toMatchObject({ ok: true, kept: false });
    expect((await sql('SELECT COUNT(*) AS n FROM diagnostics')).data.results[0].n).toBe(before);
    // Background work does not run, even in a 5th minute.
    await sql(`DELETE FROM settings WHERE key = 'state:cleanup_at'`);
    await cronAt(minuteAt(true));
    expect((await sql(`SELECT value FROM settings WHERE key = 'state:cleanup_at'`)).data.results).toHaveLength(0);
    // A customer still gets an answer from the sweeper, and a live message still gets its reply.
    const r = await inbound('whatsapp', wa(), [msg('g1', 'hi')]);
    expect(r.action).toBe('reply');
    for (const j of r.jobs) await finish(j.id);
    await sql(`INSERT INTO messages (id, conversation_id, direction, author, body, kind, status, ts, created_at) VALUES (?, ?, 'in', 'customer', 'and do you deliver to bath', 'text', 'received', ?, ?)`,
      [unique('m'), r.conversation_id, Date.now() + 1000, Date.now()]);
    await sql('UPDATE conversations SET needs_reply_since = ? WHERE id = ?', [Date.now() - 5 * MIN, r.conversation_id]);
    await cronAt(minuteAt(true));
    const queued = (await sql(`SELECT parts FROM outbox WHERE conversation_id = ? AND status = 'pending'`, [r.conversation_id])).data.results;
    expect(queued.map((q: any) => q.parts).join(' ')).toContain('bath');
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE conversation_id = ? AND status = 'pending'`, [r.conversation_id]);
    expect((await sync(['whatsapp'])).data.config.poll_seconds).toBe(60);
  });

  it('starts again at 00:00 UTC', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await setUsage(95, yesterday);
    expect((await sync(['whatsapp'])).data.config.poll_seconds).toBe(20);
    expect((await api('/api/overview')).data.budget.level).toBe('normal');
    await clearUsage();
  });
});
