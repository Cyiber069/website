// The report link the owner can share: owner only to make, public with the token for 24 hours,
// one link at a time, and no customer words, numbers or emails in it.
import { describe, expect, it } from 'vitest';
import { api, inbound, sql, unique } from '../helpers/client';

const tokenOf = (url: string) => url.split('/').pop()!;

describe('support report link', () => {
  it('needs the owner to make a link', async () => {
    expect((await api('/api/support/link', { method: 'POST', as: 'public', body: {} })).status).toBe(401);
  });

  it('serves a report without customer text, numbers or emails, and ends the old link when a new one is made', async () => {
    const secretWords = 'my secret question about the 2000w bundle';
    const thread = `447700${Math.floor(Math.random() * 900000 + 100000)}@c.us`;
    await inbound('whatsapp', thread, [{ direction: 'in', body: secretWords, external_id: unique('m') }], { title: 'Zebedee Customer', phone: '+447700900123', email: 'zeb@example.com' });

    await sql(`INSERT INTO diagnostics (ts, device_id, channel, kind, data) VALUES (?, NULL, 'whatsapp', 'selector_miss', ?)`, [Date.now(), JSON.stringify({ key: 'chatList.unreadBadge', jid: '447700900123@c.us', who: 'zeb@example.com' })]);
    const made = await api<{ url: string; expires_at: number }>('/api/support/link', { method: 'POST', body: {} });
    expect(made.status).toBe(200);
    expect(made.data.url).toMatch(/\/api\/support\/report\/[A-Za-z0-9_-]{20,}$/);
    expect(made.data.expires_at).toBeGreaterThan(Date.now() + 23 * 3600_000);

    const report = await api<Record<string, any>>(`/api/support/report/${tokenOf(made.data.url)}`, { as: 'public' });
    expect(report.status).toBe(200);
    const text = JSON.stringify(report.data);
    expect(text).not.toContain(secretWords);
    expect(text).not.toContain('Zebedee');
    expect(text).not.toContain('900123');
    expect(text).not.toContain('zeb@example.com');
    expect(text).toContain('chatList.unreadBadge');
    expect(report.data.settings.channels).toBeTruthy();
    expect(Array.isArray(report.data.message_counts)).toBe(true);
    expect(report.data.conversations.some((c: any) => c.title === 'Z…')).toBe(true);

    const state = await api<{ active: boolean }>('/api/support/link');
    expect(state.data.active).toBe(true);

    const again = await api<{ url: string }>('/api/support/link', { method: 'POST', body: {} });
    expect((await api(`/api/support/report/${tokenOf(made.data.url)}`, { as: 'public' })).status).toBe(404);
    expect((await api(`/api/support/report/${tokenOf(again.data.url)}`, { as: 'public' })).status).toBe(200);

    expect((await api('/api/support/link', { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/api/support/report/${tokenOf(again.data.url)}`, { as: 'public' })).status).toBe(404);
  });

  it('refuses an expired link and a wrong token', async () => {
    const made = await api<{ url: string }>('/api/support/link', { method: 'POST', body: {} });
    expect((await api('/api/support/report/not-the-right-token-at-all', { as: 'public' })).status).toBe(404);
    await sql(`UPDATE settings SET value = json_set(value, '$.expires_at', 1) WHERE key = 'state:support_link'`);
    expect((await api(`/api/support/report/${tokenOf(made.data.url)}`, { as: 'public' })).status).toBe(404);
  });
});
