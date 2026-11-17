// A read only report the owner can share with whoever set the agent up, through a link that lasts
// 24 hours. It holds what is needed to find a fault (laptop and channel health, page notes, errors,
// job outcomes, AI timings) and leaves out what customers wrote: no message text, no previews, no
// phone numbers or email addresses of customers. One link at a time; making a new one ends the old.
import { all } from '../lib/db';
import { randomToken, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { HttpError, json, type Router } from '../lib/http';
import { getSettings, getState, setState } from '../lib/settings';

const HOUR = 3_600_000;
const LINK_HOURS = 24;
const ONLINE_MS = 2 * 60_000;

interface SupportLink { hash: string; created_at: number; expires_at: number }

const cut = (v: unknown, n: number): string => {
  const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const parse = (s: unknown): unknown => { try { return JSON.parse(String(s ?? '')); } catch { return s ?? null; } };
/** Long digit runs (phone numbers, chat ids) and email addresses are masked wherever they appear. */
const scrub = (s: string): string => s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]').replace(/\+?\d[\d\s-]{5,}\d/g, (m) => `#${m.replace(/\D/g, '').slice(-2)}`);
/** Events tied to a chat quote the customer, so only the failures keep their wording (after the name). */
const ERROR_EVENTS = new Set(['brain_error', 'discount_error']);
function eventMessage(e: Record<string, unknown>): string {
  const msg = String(e.message ?? '');
  if (!e.conversation_id) return scrub(cut(msg, 300));
  if (ERROR_EVENTS.has(String(e.type))) return scrub(cut(msg.slice(msg.indexOf(': ') + 2), 300));
  return '';
}
/** Customer names become "J…" so the report shows which chat without saying who. */
const initial = (s: unknown): string => { const t = String(s ?? '').trim(); return t ? `${[...t][0]}…` : ''; };

export async function buildReport(db: D1Database, now: number): Promise<Record<string, unknown>> {
  const since = now - 24 * HOUR;
  const settings = await getSettings(db);
  const [devices, diagnostics, events, jobs, jobCounts, conversations, messageCounts, urgent, llm, override] = await Promise.all([
    all<Record<string, unknown>>(db, 'SELECT id, name, created_at, last_seen_at, status, version, revoked_at FROM devices ORDER BY last_seen_at DESC LIMIT 10'),
    all<Record<string, unknown>>(db, 'SELECT ts, device_id, channel, kind, data FROM diagnostics WHERE ts >= ? ORDER BY ts DESC LIMIT 80', since),
    all<Record<string, unknown>>(db, 'SELECT ts, level, type, channel, conversation_id, message, data FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT 80', since),
    all<Record<string, unknown>>(db, `SELECT id, channel, kind, conversation_id, status, source, attempts, last_error, not_before, lease_until, lease_device,
      created_at, sent_at, json_array_length(parts) AS parts FROM outbox WHERE created_at >= ? ORDER BY created_at DESC LIMIT 60`, since),
    all<Record<string, unknown>>(db, 'SELECT channel, status, source, COUNT(*) AS n FROM outbox WHERE created_at >= ? GROUP BY channel, status, source', since),
    all<Record<string, unknown>>(db, `SELECT id, channel, title, status, paused_until, pause_reason, needs_reply_since, processing_until, last_inbound_at,
      last_outbound_at, last_direction, updated_at FROM conversations WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 40`, since),
    all<Record<string, unknown>>(db, `SELECT c.channel AS channel, m.direction AS direction, m.author AS author, m.kind AS kind, COUNT(*) AS n
      FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.created_at >= ? GROUP BY c.channel, m.direction, m.author, m.kind`, since),
    all<Record<string, unknown>>(db, 'SELECT id, channel, category, reason, status, created_at FROM urgent WHERE created_at >= ? ORDER BY created_at DESC LIMIT 30', since),
    all<Record<string, unknown>>(db, `SELECT provider, model, purpose, COUNT(*) AS calls, SUM(ok) AS ok, CAST(AVG(ms) AS INTEGER) AS avg_ms, MAX(ms) AS max_ms
      FROM llm_usage WHERE ts >= ? GROUP BY provider, model, purpose`, since),
    getState<{ rev?: number } | null>(db, 'selectors_override', null),
  ]);
  return {
    generated_at: now,
    note: 'Last 24 hours. Customer message text, previews, phone numbers and email addresses are left out.',
    settings: {
      channels: settings.channels,
      brain: { provider: settings.brain.provider, model: settings.brain.model, effort: settings.brain.effort },
      pacing: settings.pacing,
      voice: { commas: settings.voice.commas, mirror_level: settings.voice.mirror_level },
      selectors_override_rev: override?.rev ?? null,
    },
    devices: devices.map((d) => ({
      id: d.id, name: d.name, version: d.version, created_at: d.created_at, last_seen_at: d.last_seen_at, revoked: Boolean(d.revoked_at),
      online: typeof d.last_seen_at === 'number' && now - d.last_seen_at < ONLINE_MS, status: parse(d.status),
    })),
    // Page snapshots are tag and attribute skeletons with no text; the newest few are kept whole for fixing selectors.
    diagnostics: diagnostics.map((d, i) => ({ ...d, data: scrub(cut(d.data, d.kind === 'dom_snapshot' && i < 40 ? 40_000 : 2_000)) })),
    events: events.map((e) => ({ ts: e.ts, level: e.level, type: e.type, channel: e.channel, conversation_id: e.conversation_id, message: eventMessage(e) })),
    jobs: jobs.map((j) => ({ ...j, last_error: scrub(cut(j.last_error, 300)) })),
    job_counts: jobCounts,
    conversations: conversations.map((c) => ({ ...c, title: initial(c.title), pause_reason: cut(c.pause_reason, 120) })),
    message_counts: messageCounts,
    urgent: urgent.map((u) => ({ ...u, reason: scrub(cut(u.reason, 200)) })),
    llm_usage: llm,
  };
}

async function currentLink(db: D1Database, now: number): Promise<SupportLink | null> {
  const link = await getState<SupportLink | null>(db, 'support_link', null);
  return link && typeof link.hash === 'string' && link.expires_at > now ? link : null;
}

export function register(r: Router): void {
  r.get('/api/support/link', 'owner', async (c) => {
    const link = await currentLink(c.db, c.now);
    return json({ active: Boolean(link), expires_at: link?.expires_at ?? null });
  });

  // A new link ends the previous one. The token is shown once and only its hash is kept.
  r.post('/api/support/link', 'owner', async (c) => {
    const token = randomToken(24);
    const link: SupportLink = { hash: await sha256Hex(token), created_at: c.now, expires_at: c.now + LINK_HOURS * HOUR };
    await setState(c.db, 'support_link', link);
    return json({ url: `${c.url.origin}/api/support/report/${token}`, expires_at: link.expires_at });
  });

  r.delete('/api/support/link', 'owner', async (c) => {
    await setState(c.db, 'support_link', null);
    return json({ ok: true });
  });

  r.get('/api/support/report/:token', 'public', async (c) => {
    const link = await currentLink(c.db, c.now);
    const token = c.params.token ?? '';
    if (!link || !token || !timingSafeEqual(await sha256Hex(token), link.hash)) throw new HttpError(404, 'not_found', 'This link has ended. Make a new one on the Health screen.');
    return json(await buildReport(c.db, c.now), 200, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
  });
}

