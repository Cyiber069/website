// Endpoints used by the Chrome extension (bearer device token).
import gmailPack from '../../extension/selectors/gmail.json';
import tiktokPack from '../../extension/selectors/tiktok.json';
import whatsappPack from '../../extension/selectors/whatsapp.json';
import type { Channel, DeviceRow, Settings } from '../types';
import { CHANNELS } from '../types';
import { randomToken, sha256Hex } from '../lib/crypto';
import { all, one, parseJson, run, uid } from '../lib/db';
import { logEvent } from '../lib/events';
import { HttpError, json, ndjsonStream, oneOf, str, type Ctx, type Router } from '../lib/http';
import { getSettings, getState, setState } from '../lib/settings';
import { MIN } from '../lib/time';
import { handleInbound, parseInbound } from '../pipeline/inbound';
import { completeJob, leaseDue, releaseLeases, type JobResult } from '../pipeline/outbox';
import { VISION_SECRET, londonDayStart, receiveVideo } from '../vision';

const POLL_SECONDS = 20;
export const ONLINE_WINDOW_MS = 100_000;

export interface ChannelStatus {
  /** ready: logged in and usable. no_tab: site is not open. loading | logged_out | blocked | error */
  state: string;
  detail: string;
  unread: number;
  /** Reading or sending (older extensions), or reading only (newer ones, which report `sending` apart). */
  busy: boolean;
  /** Newer extensions: true only while a message is being typed and sent. null when the extension does not say. */
  sending: boolean | null;
  checked_at: number;
  /** Health reported by the extension (0 or '' when an older extension does not send them). */
  last_ok_at: number;    // ms of the last scan that read the page fine
  last_scan_at: number;  // ms of the last scan, good or bad
  last_error: string;    // short text of the last problem
  recoveries: number;    // self heal actions today
  version: string;       // extension or content script version for this channel
}

export interface DeviceStatus {
  channels: Partial<Record<Channel, ChannelStatus>>;
  paused_locally: boolean;
  reported_at: number;
}

/** Write the device row at least this often even when nothing changed (the online window is 100 s). */
const STATUS_WRITE_MS = 55_000;

type Pack = Record<string, unknown> & { version?: number };

function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  if (typeof over !== 'object' || over === null || Array.isArray(over)) return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out;
}

const BASE_PACK: Record<Channel, Pack> = { whatsapp: whatsappPack as Pack, gmail: gmailPack as Pack, tiktok: tiktokPack as Pack };
const BASE_VERSION = CHANNELS.map((c) => String(BASE_PACK[c].version ?? 0)).join('-');

/**
 * Selector packs shipped in the repo (extension/selectors/<channel>.json) with any fixes saved from
 * the dashboard layered on top. Shape: { whatsapp: {...}, gmail: {...}, tiktok: {...} }.
 */
export async function selectorPack(db: D1Database): Promise<{ version: string; pack: Pack }> {
  const override = await getState<{ rev: number; pack: Pack } | null>(db, 'selectors_override', null);
  const pack = (override ? deepMerge(BASE_PACK, override.pack) : BASE_PACK) as Pack;
  return { version: `${BASE_VERSION}.${override?.rev ?? 0}`, pack };
}

function clientConfig(settings: Settings, selectorsVersion: string, origin: string, vision: { active: boolean; whole_videos: boolean }) {
  return {
    // Google AI Studio reads photos and videos: the tabs only open and send videos while it does.
    vision,
    enabled: settings.agent.enabled,
    channels: settings.channels,
    pacing: { settle_seconds: settings.pacing.settle_seconds, typing_cps: settings.pacing.typing_cps },
    poll_seconds: POLL_SECONDS,
    selectors_version: selectorsVersion,
    dashboard_url: origin,
    gmail_account: settings.gmail.account.trim().toLowerCase(),
    gmail_ignore_senders: settings.gmail.ignore_senders,
  };
}

/** A time the extension sent: a finite ms number, never in the future, else 0. */
function msTime(v: unknown, now: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(Math.round(v), now);
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export function parseStatus(raw: unknown, now: number): DeviceStatus {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const chans = (src.channels && typeof src.channels === 'object' ? src.channels : {}) as Record<string, unknown>;
  const channels: DeviceStatus['channels'] = {};
  for (const ch of CHANNELS) {
    const c = chans[ch];
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    channels[ch] = {
      state: typeof o.state === 'string' ? o.state.slice(0, 30) : 'unknown',
      detail: typeof o.detail === 'string' ? o.detail.slice(0, 200) : '',
      unread: typeof o.unread === 'number' && Number.isFinite(o.unread) ? Math.min(9999, Math.max(0, Math.round(o.unread))) : 0,
      busy: o.busy === true,
      sending: typeof o.sending === 'boolean' ? o.sending : null,
      checked_at: now,
      last_ok_at: msTime(o.last_ok_at, now),
      last_scan_at: msTime(o.last_scan_at, now),
      last_error: text(o.last_error, 160),
      recoveries: typeof o.recoveries === 'number' && Number.isFinite(o.recoveries) ? Math.min(100_000, Math.max(0, Math.round(o.recoveries))) : 0,
      version: text(o.version, 20),
    };
  }
  return { channels, paused_locally: src.paused_locally === true, reported_at: now };
}

/** The parts of a status worth a database write when they change. Scan times alone are not. */
function statusSignature(s: DeviceStatus): string {
  // The stored row starts as '{}', so every part may be missing.
  return JSON.stringify([s?.paused_locally === true, CHANNELS.map((ch) => {
    const c = s?.channels?.[ch];
    // How fresh the last good read is, in 5 minute steps, so a stalled or recovered page is written at once.
    const fresh = c?.last_ok_at ? Math.min(3, Math.floor(Math.max(0, (s.reported_at || 0) - c.last_ok_at) / (5 * MIN))) : -1;
    return c ? [c.state, c.detail, c.unread, c.busy, c.last_error, c.recoveries, c.version, fresh] : null;
  })]);
}

/** Whether the vision model is on (a key and the switch), and whether whole videos may still go today. One small query. */
async function visionState(db: D1Database, settings: Settings, now: number): Promise<{ active: boolean; whole_videos: boolean }> {
  if (!settings.vision.enabled) return { active: false, whole_videos: false };
  const row = await one<{ k: number | null; n: number }>(db,
    'SELECT (SELECT 1 FROM secrets WHERE key = ?) AS k, (SELECT COUNT(*) FROM vision_files WHERE created_at >= ?) AS n', VISION_SECRET, londonDayStart(now));
  const active = Boolean(row?.k);
  return { active, whole_videos: active && Number(row?.n ?? 0) < settings.vision.video_daily_cap };
}

function requireDevice(c: Ctx): DeviceRow {
  if (!c.device) throw new HttpError(401, 'device_required');
  return c.device;
}

export function register(r: Router): void {
  // Exchange a one-time pairing code from the dashboard for a long lived device token.
  r.post('/api/agent/pair', 'public', async (c) => {
    const body = await c.body<{ code?: unknown; name?: unknown }>();
    const code = str(body.code, 'code', { max: 20 }).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const name = str(body.name, 'name', { max: 60, optional: true }) || 'Laptop';
    const now = c.now;

    const guard = await getState<{ n: number; since: number }>(c.db, 'pair_fail', { n: 0, since: now });
    if (now - guard.since < 10 * MIN && guard.n >= 15) throw new HttpError(429, 'too_many_attempts', 'Too many wrong codes. Wait ten minutes.');

    const formatted = `${code.slice(0, 4)}-${code.slice(4)}`;
    const hash = await sha256Hex(formatted);
    const used = await run(c.db, 'UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', now, hash, now);
    if (!used) {
      await setState(c.db, 'pair_fail', now - guard.since < 10 * MIN ? { n: guard.n + 1, since: guard.since } : { n: 1, since: now });
      throw new HttpError(400, 'bad_code', 'That code is wrong or has expired. Make a new one in the dashboard.');
    }
    const token = `acxd_${randomToken(32)}`;
    const id = uid('dev');
    await run(c.db, 'INSERT INTO devices (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', id, name, await sha256Hex(token), now, now);
    await logEvent(c.db, { level: 'good', type: 'device_paired', message: `${name} is connected.` });
    return json({ device_id: id, token, server_time: now });
  });

  // Heartbeat + job pickup. Called every poll_seconds and whenever the extension finishes something.
  r.post('/api/agent/sync', 'device', async (c) => {
    const device = requireDevice(c);
    const body = await c.body<{ version?: unknown; status?: unknown; selectors_version?: unknown }>(64_000);
    const status = parseStatus(body.status, c.now);
    const version = typeof body.version === 'string' ? body.version.slice(0, 20) : '';
    const wasOffline = !device.last_seen_at || c.now - device.last_seen_at > 3 * MIN;
    // One small UPDATE, and only when something the owner sees changed or a minute has passed:
    // this runs every 20 s and the free plan allows 100,000 rows written a day.
    const before = parseJson<DeviceStatus>(device.status, { channels: {}, paused_locally: false, reported_at: 0 });
    const changed = version !== device.version || statusSignature(before) !== statusSignature(status);
    if (changed || wasOffline || c.now - (device.last_seen_at ?? 0) >= STATUS_WRITE_MS) {
      await run(c.db, 'UPDATE devices SET last_seen_at = ?, status = ?, version = ? WHERE id = ?', c.now, JSON.stringify(status), version, device.id);
    }
    if (wasOffline) {
      await logEvent(c.db, { level: 'good', type: 'device_online', message: `${device.name} is back online.` });
      await setState(c.db, 'offline_alerted', false);
    }

    const settings = await getSettings(c.db);
    // A newer extension (it reports `sending`) queues jobs per tab, so it gets them while it reads.
    // An older one types the jobs of a sync straight away, so a channel it says is busy is left alone.
    const ready = CHANNELS.filter((ch) => {
      const st = status.channels[ch];
      return st?.state === 'ready' && (st.sending !== null || !st.busy);
    });
    const jobs = status.paused_locally ? [] : await leaseDue(c.db, device, settings, ready);
    const [sel, vision] = await Promise.all([selectorPack(c.db), visionState(c.db, settings, c.now)]);
    return json({
      server_time: c.now,
      config: clientConfig(settings, sel.version, c.url.origin, vision),
      jobs,
      selectors: body.selectors_version === sel.version ? null : sel,
    });
  });

  // The extension read a thread with new customer messages. Streams keep-alive lines while the brain works.
  r.post('/api/agent/inbound', 'device', async (c) => {
    const device = requireDevice(c);
    // Room for up to 3 photos of 260 KB of base64 each next to the messages.
    const payload = parseInbound(await c.body(1_200_000));
    return ndjsonStream(c.exec, async (send, isOpen) => {
      // Jobs are only handed over while the extension is still listening; otherwise they wait for its next sync.
      const live = () => isOpen() && !c.req.signal?.aborted;
      const outcome = await handleInbound(c.env, device, payload, (o) => { void send({ type: 'accepted', ...o }); }, { live, startedAt: c.now });
      const delivered = await Promise.race([send({ type: 'decision', ...outcome }), new Promise<boolean>((r) => setTimeout(() => r(true), 10_000))]);
      // The answer could not be written: the extension hung up just now. Its jobs go back to the queue
      // so the next sync hands them over, without counting a try.
      if (!delivered && outcome.jobs.length) await releaseLeases(c.db, device, outcome.jobs.map((j) => j.id));
    });
  });

  // One customer video, before the report that names it. The bytes go straight through to Google
  // (src/vision receiveVideo): nothing is stored here but a small row saying where it is.
  r.post('/api/agent/media/video', 'device', async (c) => {
    const device = requireDevice(c);
    return json(await receiveVideo(c.env, await getSettings(c.db), c.req, c.url, device.id));
  });

  r.post('/api/agent/jobs/:id/result', 'device', async (c) => {
    const device = requireDevice(c);
    const body = await c.body<Record<string, unknown>>(32_000);
    const result: JobResult = {
      status: oneOf(body.status, 'status', ['sent', 'failed'] as const),
      error_code: typeof body.error_code === 'string' ? body.error_code : undefined,
      error: typeof body.error === 'string' ? body.error.slice(0, 500) : undefined,
      retryable: typeof body.retryable === 'boolean' ? body.retryable : undefined,
      sent_external_ids: Array.isArray(body.sent_external_ids) ? body.sent_external_ids.filter((x): x is string => typeof x === 'string').slice(0, 5) : undefined,
    };
    return json(await completeJob(c.env, device, c.params.id!, result));
  });

  // Selector misses, DOM skeletons and errors, so problems can be fixed without touching the laptop.
  r.post('/api/agent/diagnostics', 'device', async (c) => {
    const device = requireDevice(c);
    const body = await c.body<Record<string, unknown>>(120_000);
    const kind = oneOf(body.kind, 'kind', ['selector_miss', 'dom_snapshot', 'error', 'note'] as const);
    const channel = CHANNELS.includes(body.channel as Channel) ? (body.channel as Channel) : null;
    const data = JSON.stringify(body.data ?? {}).slice(0, 100_000);
    await run(c.db, 'INSERT INTO diagnostics (ts, device_id, channel, kind, data) VALUES (?, ?, ?, ?, ?)', c.now, device.id, channel, kind, data);
    // Keep the table small: newest 400 rows.
    await run(c.db, 'DELETE FROM diagnostics WHERE id <= (SELECT id FROM diagnostics ORDER BY id DESC LIMIT 1 OFFSET 400)');
    return json({ ok: true });
  });

  r.get('/api/agent/selectors', 'device', async (c) => json(await selectorPack(c.db)));
}

/** Latest live device with its parsed status, for the dashboard. */
export async function currentDevice(db: D1Database, now: number) {
  const rows = await all<DeviceRow>(db, 'SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY COALESCE(last_seen_at, 0) DESC LIMIT 5');
  return rows.map((d) => ({
    id: d.id,
    name: d.name,
    version: d.version,
    last_seen_at: d.last_seen_at,
    online: d.last_seen_at !== null && now - d.last_seen_at < ONLINE_WINDOW_MS,
    status: parseJson<DeviceStatus>(d.status, { channels: {}, paused_locally: false, reported_at: 0 }),
  }));
}

export async function pairingCodeRow(db: D1Database, codeHash: string, now: number): Promise<void> {
  await run(db, 'DELETE FROM pairing_codes WHERE expires_at < ? OR used_at IS NOT NULL', now);
  await run(db, 'INSERT INTO pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)', codeHash, now, now + 15 * MIN);
}

