// Commands from the dashboard for one laptop (today: open and pin a tab). They wait on the laptop's own
// device row (devices.commands, migration 0013) and go out with its syncs, so delivering them costs no
// extra read: the sync reads that row anyway to check the token.
//
// A command stays on the row until the laptop says it ran it (its status lists the results, newest
// last) or until it is 2 minutes old: an answer that never reached the laptop (a dropped connection) is
// simply sent again on the next sync, and the laptop skips the ids it already ran. The first hand over
// marks it sent, and the confirmation takes it off: both ride on the sync's own status write when there
// is one, else one small write each.
import type { Channel, DeviceRow } from '../types';
import { CHANNELS } from '../types';
import { HttpError } from '../lib/http';
import { one, parseJson, run } from '../lib/db';
import { MIN } from '../lib/time';
import { canStandBy } from '../lib/version';
import type { DeviceStatus } from '../routes/agent';
import { channelOf, laneOf } from './leader';

/** A command not run by then is dropped: the owner asked for something a while ago, not now. */
export const COMMAND_TTL_MS = 2 * MIN;
export const MAX_COMMANDS = 5;
/** Results the laptop keeps sending back, newest last. */
export const MAX_RESULTS = 10;

export interface DeviceCommand {
  id: string;
  type: 'open_tab';
  lane: string;
  channel: Channel;
  at: number;
  /** When a sync first handed it over (the dashboard says "sent"). */
  sent_at?: number;
}

export interface CommandResult { id: string; ok: boolean; at: number; error: string }

/** cmd_<time in base 36>_<random>: the time tells an old id from a new one after it left the row. */
export function commandId(now: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = '';
  for (const b of bytes) s += (b % 36).toString(36);
  return `cmd_${now.toString(36)}_${s}`;
}
const idTime = (id: string): number => { const m = /^cmd_([0-9a-z]+)_/.exec(id); return m ? parseInt(m[1]!, 36) || 0 : 0; };

const fresh = (list: DeviceCommand[], now: number) => list.filter((c) => c && typeof c.id === 'string' && now - (c.at || 0) < COMMAND_TTL_MS);

/** The command results a laptop sent (a list, or one `last_command` from an early build), tidied. */
export function parseCommandResults(list: unknown, single: unknown, now: number): CommandResult[] {
  const raw = [...(Array.isArray(list) ? list : []), ...(single && typeof single === 'object' ? [single] : [])];
  const out: CommandResult[] = [];
  for (const r of raw.slice(-MAX_RESULTS * 2)) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id) continue;
    const at = typeof o.at === 'number' && Number.isFinite(o.at) && o.at > 0 ? Math.min(Math.round(o.at), now) : 0;
    const error = typeof o.error === 'string' ? o.error.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    const item = { id: o.id.slice(0, 40), ok: o.ok === true, at, error };
    const i = out.findIndex((x) => x.id === item.id);
    if (i >= 0) out.splice(i, 1);
    out.push(item);
  }
  return out.slice(-MAX_RESULTS);
}

/** The lane of an open_tab command, from a lane id or a channel name. */
export function laneFor(raw: unknown): { lane: string; channel: Channel } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const ch = (CHANNELS as string[]).includes(s) ? (s as Channel) : channelOf(s);
  if (!ch) throw new HttpError(400, 'invalid_field', 'Pick WhatsApp, Gmail or TikTok');
  return { lane: laneOf(ch), channel: ch };
}

/** Queue a command for a laptop. 409 for a build too old to run it, 404 for a laptop that is gone. */
export async function addCommand(db: D1Database, deviceId: string, input: { type: 'open_tab'; lane: string; channel: Channel }, now: number): Promise<DeviceCommand> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await one<Pick<DeviceRow, 'id' | 'version' | 'revoked_at' | 'commands'>>(db, 'SELECT id, version, revoked_at, commands FROM devices WHERE id = ?', deviceId);
    if (!row || row.revoked_at) throw new HttpError(404, 'not_found', 'That laptop is not paired any more');
    if (!canStandBy(row.version)) throw new HttpError(409, 'old_extension', 'That laptop has an older extension. Update it to 0.6.0 to open tabs from here');
    const before = row.commands ?? '[]';
    const cmd: DeviceCommand = { id: commandId(now), type: input.type, lane: input.lane, channel: input.channel, at: now };
    const list = [...fresh(parseJson<DeviceCommand[]>(before, []), now).filter((c) => !(c.type === cmd.type && c.lane === cmd.lane)), cmd].slice(-MAX_COMMANDS);
    // Only when nobody changed the list meanwhile (a sync marked it, or another tap): else read it again.
    if (await run(db, 'UPDATE devices SET commands = ? WHERE id = ? AND commands = ?', JSON.stringify(list), deviceId, before)) return cmd;
  }
  throw new HttpError(409, 'busy', 'Try again in a moment');
}

/**
 * What this sync hands the laptop, and the new value of its row's command list (null: unchanged).
 * Commands the laptop's status says it ran, and old ones, come off; the rest go out (again) and are
 * marked sent. A build that cannot run them gets none. The caller writes `next` only if the row still
 * holds `before` (a command added meanwhile waits for the next sync).
 */
export function planCommands(device: Pick<DeviceRow, 'commands'>, status: Pick<DeviceStatus, 'command_results'>, version: string, now: number): { send: DeviceCommand[]; before: string; next: string | null } {
  const before = device.commands ?? '[]';
  if (!before || before === '[]') return { send: [], before, next: null };
  const done = new Set((status.command_results ?? []).map((r) => r.id));
  const keep = fresh(parseJson<DeviceCommand[]>(before, []), now).filter((c) => !done.has(c.id));
  const send = canStandBy(version) ? keep.map((c) => (c.sent_at ? c : { ...c, sent_at: now })) : [];
  const after = JSON.stringify(canStandBy(version) ? send : keep);
  return { send, before, next: after === before ? null : after };
}

export type CommandState = 'waiting' | 'sent' | 'done' | 'failed' | 'expired';

/** Where a command is: still waiting for the laptop, handed over, done or failed (the laptop said so), or too old. */
export async function commandState(db: D1Database, deviceId: string, commandId: string, now: number): Promise<{ state: CommandState; error: string }> {
  const row = await one<Pick<DeviceRow, 'commands' | 'status'>>(db, 'SELECT commands, status FROM devices WHERE id = ?', deviceId);
  if (!row) throw new HttpError(404, 'not_found');
  const st = parseJson<DeviceStatus>(row.status, { channels: {}, paused_locally: false, reported_at: 0 });
  const result = (st.command_results ?? []).find((r) => r.id === commandId);
  if (result) return { state: result.ok ? 'done' : 'failed', error: result.error || '' };
  const waiting = parseJson<DeviceCommand[]>(row.commands ?? '[]', []).find((c) => c.id === commandId);
  if (waiting) return { state: now - waiting.at >= COMMAND_TTL_MS ? 'expired' : waiting.sent_at ? 'sent' : 'waiting', error: '' };
  // Not on the row and no result: dropped as too old (or its result has long been replaced by newer ones).
  const at = idTime(commandId);
  return { state: at && now - at < COMMAND_TTL_MS ? 'sent' : 'expired', error: '' };
}
