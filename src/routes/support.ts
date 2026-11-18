// A read only report the owner can share with whoever set the agent up, through a link that lasts
// 24 hours. It holds what is needed to find a fault (laptop and channel health, page notes, errors,
// job outcomes, AI timings) and leaves out what customers wrote: no message text, no previews, no
// phone numbers or email addresses of customers. One link at a time; making a new one ends the old.
import { all, one } from '../lib/db';
import { randomToken, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { HttpError, json, type Router } from '../lib/http';
import { getSettings, getState, setState } from '../lib/settings';
import { replyTimes } from '../pipeline/replytime';
import { LANES, channelOf, deviceLabel, mainSql, maskAccount } from '../pipeline/leader';
import type { LaneLeaderRow } from '../types';

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
/**
 * A laptop's stored status with each channel's account masked (src/pipeline/leader.ts maskAccount), and
 * any address or number in its words scrubbed (an older Gmail build names the inbox in its detail).
 */
function maskStatus(st: unknown): unknown {
  if (!st || typeof st !== 'object') return st;
  const s = st as { channels?: Record<string, Record<string, unknown>> };
  if (!s.channels) return st;
  const channels: Record<string, Record<string, unknown>> = {};
  for (const [ch, c] of Object.entries(s.channels)) {
    if (!c || typeof c !== 'object') { channels[ch] = c; continue; }
    const lane = channelOf(`${ch}:inbox`);
    const out: Record<string, unknown> = { ...c };
    if (typeof c.account === 'string' && lane) out.account = maskAccount(lane, c.account);
    for (const k of ['detail', 'last_error']) if (typeof c[k] === 'string') out[k] = scrub(c[k] as string);
    channels[ch] = out;
  }
  return { ...s, channels };
}

/** Customer names become "J…" so the report shows which chat without saying who. */
const initial = (s: unknown): string => { const t = String(s ?? '').trim(); return t ? `${[...t][0]}…` : ''; };

export async function buildReport(db: D1Database, now: number): Promise<Record<string, unknown>> {
  const since = now - 24 * HOUR;
  const settings = await getSettings(db);
  const [devices, diagnostics, events, jobs, jobCounts, conversations, messageCounts, urgent, llm, override, replies, leaders, mainRow] = await Promise.all([
    all<Record<string, unknown>>(db, 'SELECT id, name, person, created_at, last_seen_at, status, version, revoked_at FROM devices ORDER BY last_seen_at DESC LIMIT 10'),
    all<Record<string, unknown>>(db, 'SELECT ts, device_id, channel, kind, data FROM diagnostics WHERE ts >= ? ORDER BY ts DESC LIMIT 80', since),
    all<Record<string, unknown>>(db, 'SELECT ts, level, type, channel, conversation_id, message, data FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT 80', since),
    all<Record<string, unknown>>(db, `SELECT id, channel, kind, conversation_id, status, source, attempts, last_error, not_before, lease_until, lease_device,
      created_at, sent_at, reply_to_ts, json_array_length(parts) AS parts FROM outbox WHERE created_at >= ? ORDER BY created_at DESC LIMIT 60`, since),
    all<Record<string, unknown>>(db, 'SELECT channel, status, source, COUNT(*) AS n FROM outbox WHERE created_at >= ? GROUP BY channel, status, source', since),
    all<Record<string, unknown>>(db, `SELECT id, channel, title, status, paused_until, pause_reason, needs_reply_since, processing_until, last_inbound_at,
      last_outbound_at, last_direction, updated_at FROM conversations WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 40`, since),
    all<Record<string, unknown>>(db, `SELECT c.channel AS channel, m.direction AS direction, m.author AS author, m.kind AS kind, COUNT(*) AS n
      FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.created_at >= ? GROUP BY c.channel, m.direction, m.author, m.kind`, since),
    all<Record<string, unknown>>(db, 'SELECT id, channel, category, reason, status, created_at FROM urgent WHERE created_at >= ? ORDER BY created_at DESC LIMIT 30', since),
    all<Record<string, unknown>>(db, `SELECT provider, model, purpose, COUNT(*) AS calls, SUM(ok) AS ok, CAST(AVG(ms) AS INTEGER) AS avg_ms, MAX(ms) AS max_ms
      FROM llm_usage WHERE ts >= ? GROUP BY provider, model, purpose`, since),
    getState<{ rev?: number } | null>(db, 'selectors_override', null),
    replyTimes(db, since),
    all<LaneLeaderRow>(db, 'SELECT * FROM lane_leaders'),
    one<{ main: string | null }>(db, `SELECT ${mainSql(now)} AS main`),
  ]);
  const mainId = String(mainRow?.main ?? '');
  // Who answers each lane and each laptop's account there, masked (enough to tell two apart).
  const byId = new Map(devices.map((d) => [String(d.id), d]));
  const laneLeaders = LANES.map((lane) => {
    const ch = channelOf(lane)!;
    const row = leaders.find((l) => l.lane === lane);
    const d = row?.device_id ? byId.get(row.device_id) : undefined;
    return {
      lane, account: maskAccount(ch, row?.account ?? ''), device_id: row?.device_id || null,
      leader: d ? deviceLabel({ person: String(d.person ?? ''), name: String(d.name ?? '') }) : null,
      epoch: row?.epoch ?? 0, since: row?.since ?? null, reason: row?.reason ?? '', prev_device: row?.prev_device || null,
      account_src: row?.account_src ?? '', handover_at: row?.handover_at || null,
    };
  });
  const people = devices.filter((d) => !d.revoked_at).map((d) => {
    const st = (parse(d.status) ?? {}) as { channels?: Record<string, { state?: string; account?: string }>; paused_locally?: boolean };
    const lanes: Record<string, { state: string; account: string; answers: boolean }> = {};
    for (const lane of LANES) {
      const ch = channelOf(lane)!;
      const c = st.channels?.[ch];
      lanes[lane] = { state: c?.state ?? 'no_tab', account: maskAccount(ch, c?.account ?? ''), answers: laneLeaders.some((l) => l.lane === lane && l.device_id === d.id) };
    }
    return {
      device_id: d.id, person: d.person || null, name: d.name, version: d.version, main: d.id === mainId,
      online: typeof d.last_seen_at === 'number' && now - d.last_seen_at < ONLINE_MS, paused: st.paused_locally === true, lanes,
    };
  });
  return {
    generated_at: now,
    note: 'Last 24 hours. Customer message text, previews, phone numbers and email addresses are left out.',
    settings: {
      channels: settings.channels,
      brain: { provider: settings.brain.provider, model: settings.brain.model, mix: settings.brain.mix, effort: settings.brain.effort },
      pacing: settings.pacing,
      voice: { commas: settings.voice.commas, mirror_level: settings.voice.mirror_level },
      selectors_override_rev: override?.rev ?? null,
    },
    // Each laptop's person, what it does on each lane, and the laptop answering each lane.
    people,
    lane_leaders: laneLeaders,
    devices: devices.map((d) => ({
      id: d.id, name: d.name, person: d.person || null, version: d.version, created_at: d.created_at, last_seen_at: d.last_seen_at, revoked: Boolean(d.revoked_at),
      online: typeof d.last_seen_at === 'number' && now - d.last_seen_at < ONLINE_MS, status: maskStatus(parse(d.status)),
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
    // Agent replies in the last 24 hours: time from the customer's message to sent, in ms.
    reply_times: { ...replies, slowest: replies.slowest ? { ...replies.slowest, customer: initial(replies.slowest.customer) } : null },
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

