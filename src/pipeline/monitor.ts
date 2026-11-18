// Every minute: is the agent really working? Tells the owner once per problem, and writes a
// "back to normal" line in the activity feed when it is fixed. Built to be cheap on D1: a handful
// of rows read per run and a write only when something changed.
import type { Channel, DeviceRow, Env, Settings } from '../types';
import { CHANNELS } from '../types';
import { all, parseJson, run } from '../lib/db';
import { logEvent } from '../lib/events';
import { getSettings, setState } from '../lib/settings';
import { HOUR, MIN } from '../lib/time';
import { usageToday, type D1Usage } from '../lib/usage';
import { HIGH_PCT } from '../lib/budget';
import { ONLINE_WINDOW_MS, type ChannelStatus, type DeviceStatus } from '../routes/agent';
import { alertOwner } from './alerts';
import { channelsView, type WatchedDevice } from './leader';

/** A channel that has not read its page for this long, or is signed out or blocked this long, is down. */
export const CHANNEL_DOWN_MS = 10 * MIN;
/** A customer message nobody is working on after this long means the brain is failing quietly. */
export const STUCK_MS = 15 * MIN;

export interface ChannelProblem { since: number; alerted: boolean; reason: string }

export interface MonitorState {
  channels: Partial<Record<Channel, ChannelProblem>>;
  /** Conversations already reported as waiting too long. */
  stuck: string[];
  stuck_by_channel: Partial<Record<Channel, number>>;
  ai_failing: boolean;
  usage_alert_day: string;
}

export const EMPTY_MONITOR: MonitorState = { channels: {}, stuck: [], stuck_by_channel: {}, ai_failing: false, usage_alert_day: '' };

const NAME: Record<Channel, string> = { whatsapp: 'WhatsApp', gmail: 'Gmail', tiktok: 'TikTok' };

/** The state rows the monitor and the dashboard need, in one query. */
export async function monitorRows(db: D1Database): Promise<{ monitor: MonitorState; usage: D1Usage | null; offlineAlerted: boolean }> {
  const rows = await all<{ key: string; value: string }>(db, `SELECT key, value FROM settings WHERE key IN ('state:monitor', 'state:d1_usage', 'state:offline_alerted')`);
  const get = <T>(k: string, fb: T): T => parseJson<T>(rows.find((r) => r.key === `state:${k}`)?.value, fb);
  return { monitor: { ...EMPTY_MONITOR, ...get<Partial<MonitorState>>('monitor', {}) }, usage: get<D1Usage | null>('d1_usage', null), offlineAlerted: get('offline_alerted', false) };
}

/** Why a channel is not working, in plain words. */
function reasonFor(ch: Channel, st: ChannelStatus | undefined): string {
  if (!st) return `The ${NAME[ch]} tab is not open on the laptop.`;
  if (st.state === 'logged_out') return `${NAME[ch]} is signed out on the laptop.`;
  if (st.state === 'blocked') return st.detail ? `${NAME[ch]} is blocking the page: ${st.detail}` : `${NAME[ch]} is blocking the page.`;
  if (st.state === 'no_tab') return `The ${NAME[ch]} tab is not open on the laptop.`;
  if (st.last_error) return st.last_error;
  if (st.detail) return st.detail;
  return `The ${NAME[ch]} page could not be read.`;
}

/** Is this channel down right now, and since when (best guess)? */
function channelDown(st: ChannelStatus | undefined, now: number): { down: boolean; since: number } {
  if (st && (st.state === 'logged_out' || st.state === 'blocked')) return { down: true, since: now };
  // Older extensions do not send last_ok_at: nothing to judge by.
  if (!st?.last_ok_at) return { down: false, since: 0 };
  if (now - st.last_ok_at >= CHANNEL_DOWN_MS) return { down: true, since: st.last_ok_at };
  return { down: false, since: 0 };
}

async function watchChannels(env: Env, settings: Settings, status: DeviceStatus, m: MonitorState, now: number): Promise<void> {
  const fresh: { ch: Channel; reason: string }[] = [];
  for (const ch of CHANNELS) {
    const prev = m.channels[ch];
    const off = settings.channels[ch].mode === 'off';
    const st = status.channels?.[ch];
    const { down, since } = off || status.paused_locally ? { down: false, since: 0 } : channelDown(st, now);
    if (!down) {
      if (prev) {
        delete m.channels[ch];
        if (prev.alerted) await logEvent(env.DB, { level: 'good', type: 'channel_ok', channel: ch, message: `${NAME[ch]} is back to normal. The agent is reading it again.` });
      }
      continue;
    }
    const p: ChannelProblem = prev ?? { since: Math.min(since, now), alerted: false, reason: '' };
    p.reason = reasonFor(ch, st);
    m.channels[ch] = p;
    // Signed out or blocked counts from when this job first saw it; a silent page from its last good read.
    if (!p.alerted && now - p.since >= CHANNEL_DOWN_MS) fresh.push({ ch, reason: p.reason });
  }
  if (!fresh.length) return;
  const names = fresh.map((f) => NAME[f.ch]).join(' and ');
  const mins = Math.round((now - Math.min(...fresh.map((f) => m.channels[f.ch]!.since))) / MIN);
  const sent = await alertOwner(env, settings, {
    kind: 'channel',
    title: `${names} stopped working`,
    body: `${fresh.map((f) => f.reason).join(' ')} Customers there are not being answered. Nothing good was read for ${mins} min.`,
    path: '/#/health',
  });
  if (!sent) return; // throttled: try again next minute
  for (const f of fresh) {
    m.channels[f.ch]!.alerted = true;
    await logEvent(env.DB, { level: 'error', type: 'channel_down', channel: f.ch, message: `${NAME[f.ch]} stopped working. ${f.reason}` });
  }
}

/** Customers waiting over 15 minutes with nothing working on their chat. */
async function watchStuck(env: Env, settings: Settings, m: MonitorState, now: number): Promise<void> {
  // Uses the needs_reply_since index: reads only the chats that are waiting, normally none.
  const rows = await all<{ id: string; channel: Channel; needs_reply_since: number; title: string }>(
    env.DB,
    `SELECT id, channel, needs_reply_since, title FROM conversations WHERE needs_reply_since IS NOT NULL AND needs_reply_since < ? AND needs_reply_since > ?
       AND (processing_until IS NULL OR processing_until < ?) AND (paused_until IS NULL OR paused_until < ?) ORDER BY needs_reply_since ASC LIMIT 20`,
    now - STUCK_MS, now - 6 * HOUR, now, now,
  );
  const live = rows.filter((r) => settings.channels[r.channel]?.mode !== 'off');
  const by: Partial<Record<Channel, number>> = {};
  for (const r of live) by[r.channel] = (by[r.channel] ?? 0) + 1;
  m.stuck_by_channel = by;
  const fresh = live.filter((r) => !m.stuck.includes(r.id));
  m.stuck = live.map((r) => r.id);
  if (!fresh.length) return;
  for (const r of fresh) {
    await logEvent(env.DB, {
      level: 'warn', type: 'reply_stuck', channel: r.channel, conversation_id: r.id,
      message: `${r.title || 'A customer'} on ${NAME[r.channel]} has waited ${Math.round((now - r.needs_reply_since) / MIN)} min with no reply. The agent keeps trying.`,
    });
  }
  await alertOwner(env, settings, {
    kind: 'stuck',
    title: 'A customer is waiting with no reply',
    body: `${live.length === 1 ? 'One chat has' : `${live.length} chats have`} waited over 15 min and the agent has not answered. The AI may be failing. Open Health to see why.`,
    path: '/#/health',
  });
}

/** Three brain calls in a row that failed: the key is wrong or the free daily limit ran out. Photo reading (gemini) is not the brain. */
async function watchAi(env: Env, settings: Settings, m: MonitorState, now: number): Promise<void> {
  const rows = await all<{ ok: number }>(env.DB, `SELECT ok FROM llm_usage WHERE ts > ? AND provider != 'gemini' AND purpose != 'voice_note' ORDER BY ts DESC LIMIT 3`, now - 6 * HOUR);
  const failing = rows.length === 3 && rows.every((r) => !r.ok);
  if (failing && !m.ai_failing) {
    const sent = await alertOwner(env, settings, { kind: 'ai', title: 'The AI is failing', body: 'The AI is failing: check the key or the free daily limit. Customers are not getting answers.', path: '/#/connections' });
    if (!sent) return;
    m.ai_failing = true;
    await logEvent(env.DB, { level: 'error', type: 'ai_failing', message: 'The AI failed 3 times in a row. Check the key or the free daily limit in Connections.' });
  } else if (!failing && m.ai_failing && rows[0]?.ok) {
    m.ai_failing = false;
    await logEvent(env.DB, { level: 'good', type: 'ai_ok', message: 'The AI is answering again. Back to normal.' });
  }
}

/** Owner copy for the budget guard (src/lib/budget.ts): it starts at the same 70%. */
export const USAGE_ALERT_BODY = 'The agent is slowing down background work so it keeps replying.';

async function watchUsage(env: Env, settings: Settings, stored: D1Usage | null, m: MonitorState, now: number): Promise<void> {
  const u = usageToday(stored, now);
  if (m.usage_alert_day === u.day) return;
  const pct = Math.max(u.read_pct, u.write_pct);
  if (pct < HIGH_PCT) return;
  const what = u.read_pct >= u.write_pct ? 'reads' : 'writes';
  const sent = await alertOwner(env, settings, {
    kind: 'usage',
    title: 'Database use is high today',
    body: USAGE_ALERT_BODY,
    path: '/#/health',
  });
  if (!sent) return;
  m.usage_alert_day = u.day;
  await logEvent(env.DB, { level: 'warn', type: 'usage_high', message: `Database use is high today. About ${Math.round(pct)}% of the free daily ${what} are used. This is an estimate. ${USAGE_ALERT_BODY}` });
}

/** Only the database use alert: the minutes the rest of the health check waits for (src/cron.ts). A few rows. */
export async function watchUsageOnly(env: Env, now = Date.now()): Promise<void> {
  const settings = await getSettings(env.DB);
  const { monitor, usage } = await monitorRows(env.DB);
  const m: MonitorState = JSON.parse(JSON.stringify(monitor));
  const before = JSON.stringify(m);
  await watchUsage(env, settings, usage, m, now);
  if (JSON.stringify(m) !== before) await setState(env.DB, 'monitor', m);
}

async function watchOffline(env: Env, settings: Settings, d: Pick<DeviceRow, 'name' | 'last_seen_at'>, alerted: boolean, now: number): Promise<void> {
  if (!d.last_seen_at || alerted) return;
  if (now - d.last_seen_at < Math.max(ONLINE_WINDOW_MS, settings.alerts.offline_minutes * MIN)) return;
  await setState(env.DB, 'offline_alerted', true);
  await logEvent(env.DB, { level: 'error', type: 'device_offline', message: `${d.name} has gone quiet. Nothing can be sent until Chrome is open on it again.` });
  await alertOwner(env, settings, { kind: 'offline', title: 'Your laptop agent is offline', body: `${d.name} stopped checking in. Customers are not being answered.`, path: '/#/health' });
}

/** The every minute health check. */
export async function watchHealth(env: Env, now = Date.now()): Promise<void> {
  const db = env.DB;
  const settings = await getSettings(db);
  // The newest laptops, with who answers each lane (src/pipeline/leader.ts) in the same query.
  const [{ monitor, usage, offlineAlerted }, devices] = await Promise.all([
    monitorRows(db),
    // Through the partial index devices_live_seen (migration 0013): the newest five rows, never every laptop ever paired.
    all<WatchedDevice>(db,
      `SELECT id, name, person, last_seen_at, status,
         (SELECT json_group_array(json_object('lane', lane, 'account', account, 'device_id', device_id)) FROM lane_leaders) AS leaders
       FROM devices WHERE revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 5`),
  ]);
  const m: MonitorState = JSON.parse(JSON.stringify(monitor));
  const before = JSON.stringify(m);

  // Database use is watched even with the agent off: the dashboard alone uses rows too.
  await watchUsage(env, settings, usage, m, now);
  if (settings.agent.enabled) {
    // The newest laptop: when it is offline, every laptop is.
    const d = devices[0];
    if (d) {
      await watchOffline(env, settings, d, offlineAlerted, now);
      const online = d.last_seen_at !== null && now - d.last_seen_at < ONLINE_WINDOW_MS;
      // Offline has its own alert. Channel problems are judged only while a laptop is checking in, each
      // from the laptop that answers it (or the best one online while nobody does).
      if (online) await watchChannels(env, settings, channelsView(devices, settings, now, ONLINE_WINDOW_MS), m, now);
    }
    await watchStuck(env, settings, m, now);
    await watchAi(env, settings, m, now);
  }
  if (JSON.stringify(m) !== before) await setState(db, 'monitor', m);
}
