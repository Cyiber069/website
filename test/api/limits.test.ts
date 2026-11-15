// Cloudflare's free plan allows 50 D1 queries per request (and per cron run). These tests fill the
// database the way a busy week would and check the heavy request paths stay well under that.
import { describe, expect, it } from 'vitest';
import { api, cron, finish, inbound, sql, unique } from '../helpers/client';

const LIMIT = 45; // keep some room under 50

describe('D1 queries per request', () => {
  it('Urgent with many open questions and review drafts', async () => {
    await api('/api/settings/channels', { method: 'PUT', body: { gmail: { mode: 'review' }, whatsapp: { mode: 'auto' } } });
    for (let i = 0; i < 12; i++) {
      const out = await inbound('whatsapp', `${unique('4478')}@c.us`, [{ external_id: unique('m'), direction: 'in', body: 'unknown-question about frames' }]);
      expect(out.action).toBe('escalate');
      for (const j of out.jobs) await finish(j.id);
    }
    for (let i = 0; i < 12; i++) {
      const out = await inbound('gmail', unique('thr'), [{ external_id: unique('g'), direction: 'in', body: 'hello is the kit in stock' }], { contact: { name: 'Mail', email: `${unique('c')}@example.com` } });
      expect(out.action).toBe('review');
    }
    const res = await api('/api/urgent');
    expect(res.status).toBe(200);
    expect(res.data.urgent.length).toBeGreaterThanOrEqual(12);
    expect(res.data.review.length).toBeGreaterThanOrEqual(12);
    expect(res.queries).toBeGreaterThan(0);
    expect(res.queries).toBeLessThanOrEqual(LIMIT);
    // Still shaped as before: recent messages oldest first, the review card shows the customer's words.
    const u = res.data.urgent.find((x: any) => x.question.includes('unknown-question'));
    expect(u.recent.map((m: any) => m.body).join(' ')).toContain('unknown-question');
    expect(u.recent[0].ts).toBeLessThanOrEqual(u.recent.at(-1).ts);
    expect(res.data.review.find((x: any) => x.customer_message === 'hello is the kit in stock')).toBeTruthy();
  });

  it('Recovery screen and run with many saved checkouts', async () => {
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      const id = unique('co');
      await sql(
        `INSERT INTO checkouts (id, name, first_name, phone_raw, phone_e164, country, total, currency, items, created_at_shop, updated_at_shop, status, first_seen_at, updated_at)
         VALUES (?, 'Sam', 'Sam', ?, ?, 'GB', '100.00', 'GBP', '[{"title":"Kit","quantity":1}]', ?, ?, 'new', ?, ?)`,
        [id, `07700${String(900000 + i)}`, `+447700${String(900000 + i)}`, now - 3 * 3_600_000, now - 3 * 3_600_000, now, now],
      );
    }
    const screen = await api('/api/recovery');
    expect(screen.status).toBe(200);
    expect(screen.data.eligible.length + screen.data.skipped.length).toBeGreaterThanOrEqual(60);
    expect(screen.queries).toBeLessThanOrEqual(LIMIT);

    const dry = await api('/api/recovery/run', { body: { dry_run: true } });
    expect(dry.status).toBe(200);
    expect(dry.data.run.status).toBe('done');
    expect(dry.queries).toBeLessThanOrEqual(LIMIT);

    // A live run that queues the owner's daily limit, with the brain rewording each one.
    await api('/api/settings/recovery', { method: 'PUT', body: { enabled: true, daily_cap: 10, personalize: true, spacing_seconds: [1, 2] } });
    expect((await api('/api/recovery/template', { method: 'PUT', body: { text: 'Hi {first_name}, your {product} is still in your basket', approved: true, consent_mode: 'all' } })).status).toBe(200);
    const live = await api('/api/recovery/run', { body: { dry_run: false } });
    expect(live.status).toBe(200);
    expect(live.data.run.status).toBe('done');
    expect(live.data.run.queued).toBe(10);
    expect(live.queries).toBeLessThanOrEqual(LIMIT);

    await sql(`DELETE FROM outbox WHERE source = 'recovery'`);
    await sql('DELETE FROM checkouts');
    await sql('DELETE FROM recovery_runs');
    await api('/api/recovery/template', { method: 'PUT', body: { text: '', approved: false } });
    await api('/api/settings/recovery', { method: 'PUT', body: { daily_cap: 5, spacing_seconds: [180, 480] } });
  });

  it('Discount codes list after many messages changed state', async () => {
    const out = await inbound('whatsapp', `${unique('4479')}@c.us`, [{ external_id: unique('m'), direction: 'in', body: 'hi' }]);
    const conv = out.conversation_id!;
    for (const j of out.jobs) await finish(j.id);
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const made = await api('/api/discounts', { body: { conversation_id: conv, code: unique('LIM'), confirm_exists: true, send: true } });
      expect(made.status).toBe(201);
      ids.push(made.data.discount.outbox_id);
    }
    // All the messages went out since the screen was last opened.
    await sql(`UPDATE outbox SET status = 'sent', sent_at = ? WHERE id IN (SELECT outbox_id FROM discount_codes WHERE conversation_id = ?)`, [Date.now(), conv]);
    const res = await api('/api/discounts');
    expect(res.status).toBe(200);
    expect(res.data.discounts.filter((d: any) => d.conversation_id === conv && d.status === 'sent')).toHaveLength(40);
    expect(res.queries).toBeLessThanOrEqual(LIMIT);
    const again = await api('/api/discounts');
    expect(again.data.discounts.filter((d: any) => d.conversation_id === conv && d.status === 'sent')).toHaveLength(40);
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'review', 'leased')`);
  });

  it('a long chat seen for the first time, then answered', async () => {
    const t = `${unique('4475')}@c.us`;
    const history = Array.from({ length: 39 }, (_, i) => ({ external_id: `h${i}`, direction: (i % 2 ? 'out' : 'in') as 'in' | 'out', body: `older message number ${i}` }));
    const first = await inbound('whatsapp', t, [...history, { external_id: 'new1', direction: 'in', body: 'is the 3000w kit back in stock' }]);
    expect(first.action).toBe('reply');
    expect(first.queries).toBeLessThanOrEqual(LIMIT);
    for (const j of first.jobs) await finish(j.id);
    const conv = await api(`/api/conversations/${first.conversation_id}`);
    expect(conv.data.messages).toHaveLength(41);
    expect(conv.data.messages.filter((m: any) => m.status === 'history')).toHaveLength(38); // the trailing customer run is new
  });

  it('a cron run with chats waiting for the sweeper', async () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      const out = await inbound('whatsapp', `${unique('4476')}@c.us`, [{ external_id: unique('m'), direction: 'in', body: 'hi there' }]);
      for (const j of out.jobs) await finish(j.id);
      // A later message whose live request died before the brain answered.
      await sql(`INSERT INTO messages (id, conversation_id, direction, author, body, kind, status, ts, created_at) VALUES (?, ?, 'in', 'customer', 'and do you ship to wales', 'text', 'received', ?, ?)`,
        [unique('m'), out.conversation_id, Date.now() + 1000, Date.now()]);
      await sql('UPDATE conversations SET needs_reply_since = ? WHERE id = ?', [now - 5 * 60_000, out.conversation_id]);
    }
    // At 20:00 UK time the first tick starts the daily recovery run and leaves the sweep to the next
    // minute on purpose, so tick twice to make the test independent of the clock.
    const first = await cron();
    expect(first.queries).toBeLessThanOrEqual(LIMIT);
    const res = await cron();
    const queued = await sql(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending' AND parts LIKE '%wales%'`);
    expect(queued.data.results[0].n).toBeGreaterThanOrEqual(1);
    expect(res.status).toBe(200);
    expect(res.queries).toBeLessThanOrEqual(LIMIT);
    await sql(`UPDATE outbox SET status = 'cancelled' WHERE status IN ('pending', 'review', 'leased')`);
    await sql('UPDATE conversations SET needs_reply_since = NULL');
  });
});
