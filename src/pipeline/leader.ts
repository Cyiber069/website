// People and failover: which laptop answers each lane.
//
// A lane is one kind of work in one channel (today the inbox of each: whatsapp:inbox, gmail:inbox,
// tiktok:inbox, the same ids as LANE_DEFS in extension/sw.js). For each lane ONE laptop is active: it
// scans, reads and sends. Every other laptop signed in to the same account stands by: it only checks
// that its tab works (probe), never opens a chat (opening one marks it read for the whole account) and
// never gets a job. When the active laptop goes offline or its channel stops working, a standby takes
// over within about a minute and a half.
//
// The rules (`elect`, pure, test/unit/leader.test.ts):
//  * The shop has one account per lane: the Gmail address set in Connections, else the account of the
//    first laptop that answered the lane (lane_leaders.account). The owner can change it on the People
//    panel (PUT /api/lanes/:lane/account).
//  * A laptop on another account is never given that lane's jobs and never reads it: "Other account".
//    Its other lanes work on their own. An account the laptop cannot tell ('') counts as the shop's, so
//    two laptops can never both answer.
//  * Takeover is a compare and swap on (lane, device_id, epoch): D1 runs one write at a time, so two
//    standbys can never both win.
//  * The active laptop's lease (lease_ms in the sync answer) ends before anyone may take over: at most
//    its last stored check in + 80 s, and takeover for offline waits 90 s. So two laptops never work one
//    lane at once, even when the active one cannot reach the server. The one exception is a laptop told
//    it is the only one paired (solo): it keeps working while the server is away, as before, so a
//    takeover from it waits until the jobs it holds have run out.
//  * A page that reads nothing is only judged stalled once its lane has worked for STALL_MS (the
//    laptop says how long, active_ms): switching the agent or a channel on is never a stall.
//  * No fail back: a laptop that comes back stands by until the one answering stops.
//
// Cost (free plan): a sync reads the leader rows and counts the other laptops seen today in one query
// (a partial index, so only live rows), reads the other laptops' rows only while it could replace one,
// and writes only on a handover. An inbound report reads one leader row.
import type { Channel, DeviceRow, Env, LaneLeaderRow, Settings } from '../types';
import { CHANNELS } from '../types';
import { all, one, parseJson, stmt } from '../lib/db';
import { logEvent } from '../lib/events';
import { DAY, MIN } from '../lib/time';
import { canStandBy } from '../lib/version';
import type { ChannelStatus, DeviceStatus } from '../routes/agent';
import { alertOwner } from './alerts';

export const LANES = CHANNELS.map((ch) => `${ch}:inbox`);
export const laneOf = (ch: Channel): string => `${ch}:inbox`;
export const channelOf = (lane: string): Channel | null => {
  const ch = lane.split(':')[0] as Channel;
  return CHANNELS.includes(ch) && LANES.includes(lane) ? ch : null;
};
export const CHANNEL_NAME: Record<Channel, string> = { whatsapp: 'WhatsApp', gmail: 'Gmail', tiktok: 'TikTok' };

/** The active laptop has not checked in for this long: a standby takes over. */
export const TAKEOVER_OFFLINE_MS = 90_000;
/** The active laptop's lane is not ready (loading, an error) this long: a standby takes over. */
export const NOT_READY_MS = 45_000;
/** The active laptop has worked the lane this long and read nothing in that time: a standby takes over. */
export const STALL_MS = 3 * MIN;
/** Longest lease on a lane, measured on the laptop from the moment it asked. */
export const LANE_LEASE_MS = 60_000;
/** A lease always ends this long before a standby may take over for offline. */
export const LEASE_MARGIN_MS = 10_000;
/** Jobs a laptop that stood aside held go to the new one after this wait (a send it was typing has finished by then). */
export const RELEASE_WAIT_MS = 30_000;
/** Jobs of a laptop that may still send them (an older build, or one told it is the only one) move this long after their lease ends. */
export const LEASE_GRACE_MS = 5_000;
/** A laptop that checked in within this time counts as another laptop: this one is not alone. */
export const SOLO_WINDOW_MS = DAY;

/** States that need the person at the laptop: the active laptop gives the lane up at once. */
const GIVE_UP_STATES = new Set(['logged_out', 'blocked', 'no_tab']);

export type Role = 'active' | 'standby' | 'other_account' | 'off';
export type Reason = 'claim' | 'offline' | 'not_working' | 'stalled' | 'paused' | 'other_account' | 'removed' | 'logged_out' | 'blocked' | 'no_tab';

// ---- accounts ------------------------------------------------------------------------------------------

/**
 * The account a tab is signed in to, the same way for every laptop: a WhatsApp number as digits, a
 * Gmail address in lower case, a TikTok handle in lower case without @. '' when it cannot be told.
 * WhatsApp takes a bare number or a phone id (@c.us, @s.whatsapp.net). A hidden id (@lid) or anything
 * else is not a phone number: '' (not known, so it counts as the shop's and never splits one number in two).
 */
export function normAccount(channel: Channel, raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().replace(/^"+|"+$/g, '').trim().toLowerCase().slice(0, 160) : '';
  if (!s) return '';
  if (channel === 'whatsapp') {
    let user = s;
    if (s.includes('@')) {
      const [u, domain] = s.split('@');
      if (domain !== 'c.us' && domain !== 's.whatsapp.net') return '';
      user = (u ?? '').split(':')[0]!;
      if (!/^\d+$/.test(user)) return '';
    } else if (!/^\+?[\d\s().-]+$/.test(s)) return '';
    const digits = user.replace(/\D/g, '');
    return digits.length >= 6 && digits.length <= 16 ? digits : '';
  }
  if (channel === 'gmail') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
  const handle = s.replace(/^.*\/@/, '').replace(/^@/, '').split(/[/?#\s]/)[0]!;
  return /^[a-z0-9._]{2,40}$/.test(handle) ? handle : '';
}

/** How an account is shown to the owner: +447700900123, the address, @handle. */
export function showAccount(channel: Channel, account: string): string {
  if (!account) return '';
  if (channel === 'whatsapp') return `+${account}`;
  if (channel === 'tiktok') return `@${account}`;
  return account;
}

/** Part of an account, for the support report: enough to tell two apart, not enough to use. */
export function maskAccount(channel: Channel, account: string): string {
  if (!account) return '';
  if (channel === 'whatsapp') return `…${account.slice(-4)}`;
  if (channel === 'gmail') { const [user, domain] = account.split('@'); return `${(user ?? '').slice(0, 2)}…@${domain ?? ''}`; }
  return `@${account}`;
}

/** The shop's account for a lane: the Gmail address set in Connections wins, else what the lane learned. */
export function shopAccount(channel: Channel, settings: Settings, row: Pick<LaneLeaderRow, 'account'> | null | undefined): string {
  const set = channel === 'gmail' ? normAccount('gmail', settings.gmail.account) : '';
  return set || row?.account || '';
}

/** A person's or a laptop's name as typed: one line, no control characters, at most `max` long. */
export function cleanName(raw: unknown, max = 40): string {
  // eslint-disable-next-line no-control-regex
  return typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim() : '';
}

/** "Adrian's laptop", or the laptop's own name when nobody's name was given. */
export function deviceLabel(d: { person?: string | null; name?: string | null } | null | undefined): string {
  const p = String(d?.person ?? '').trim();
  if (p) return `${p}’s laptop`;
  return String(d?.name ?? '').trim() || 'A laptop';
}

export function parseLeaders(raw: unknown): LaneLeaderRow[] {
  const list = typeof raw === 'string' ? parseJson<unknown[]>(raw, []) : Array.isArray(raw) ? raw : [];
  const out: LaneLeaderRow[] = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.lane !== 'string') continue;
    out.push({
      lane: o.lane, account: String(o.account ?? ''), device_id: String(o.device_id ?? ''), epoch: Number(o.epoch) || 0,
      since: Number(o.since) || 0, reason: String(o.reason ?? ''), prev_device: String(o.prev_device ?? ''), solo: Number(o.solo) ? 1 : 0,
    });
  }
  return out;
}

/** What a sync needs to elect: who answers each lane, and how many other laptops checked in today. */
export interface LaneContext {
  leaders: LaneLeaderRow[];
  /** Other paired laptops seen in the last SOLO_WINDOW_MS. 0: this laptop is alone. */
  others: number;
}

/**
 * One query. The count reads only the laptops seen today through the partial index devices_live_seen
 * (migration 0013): a laptop paired long ago, or one paired again under a new name, stops counting a day
 * after it last checked in, and removed ones never count.
 */
export async function laneContext(db: D1Database, deviceId: string, now: number): Promise<LaneContext> {
  const row = await one<{ leaders: string | null; others: number | null }>(db,
    `SELECT (SELECT json_group_array(json_object('lane', lane, 'account', account, 'device_id', device_id, 'epoch', epoch, 'since', since,
         'reason', reason, 'prev_device', prev_device, 'solo', solo)) FROM lane_leaders) AS leaders,
       (SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL AND last_seen_at > ? AND id != ?) AS others`,
    now - SOLO_WINDOW_MS, deviceId);
  return { leaders: parseLeaders(row?.leaders ?? '[]'), others: Number(row?.others ?? 0) || 0 };
}

/** The laptop that answers one lane ('' for nobody, null when the lane was never answered). One row. */
export async function laneLeader(db: D1Database, ch: Channel): Promise<string | null> {
  const row = await one<{ device_id: string }>(db, 'SELECT device_id FROM lane_leaders WHERE lane = ?', laneOf(ch));
  return row ? row.device_id : null;
}

// ---- the rules (pure) ----------------------------------------------------------------------------------

/** What this laptop says about one lane. */
export interface LaneSelf {
  state: string;
  account: string;
  paused: boolean;
  mode: 'auto' | 'review' | 'off';
}

/** What the server has stored about the laptop that answers the lane now (another one). */
export interface LeaderView {
  exists: boolean;
  revoked: boolean;
  last_seen_at: number | null;
  paused: boolean;
  state: string;
  /** Server time the lane went into `state`. */
  state_since: number;
  account: string;
  /** Last good read, server time (0 when the build does not say). */
  last_ok_at: number;
  /**
   * Server time the lane started working on that laptop (scanning, reading, sending), 0 while it does not
   * work or when the build does not say (before 0.6.0). Only a lane that works can stall.
   */
  active_since: number;
}

export interface ElectInput {
  now: number;
  me: string;
  self: LaneSelf;
  /** The shop's account for the lane ('' until known). */
  shop: string;
  row: LaneLeaderRow | null;
  /** Set when another laptop answers the lane. */
  leader: LeaderView | null;
  /** The agent is switched on: only then does a page that reads nothing count as stalled. */
  agentOn: boolean;
}

export type ElectAction =
  | { kind: 'claim'; reason: 'claim'; account: string }
  | { kind: 'takeover'; reason: Reason; account: string }
  | { kind: 'vacate'; reason: Reason }
  | { kind: 'learn'; account: string };

export interface ElectOutput { role: Role; action: ElectAction | null }

/** Same account, or one of the two is not known (then it must count as the same, so two can never answer). */
export const sameAccount = (a: string, b: string) => !a || !b || a === b;

/** May this laptop answer the lane right now? */
export function eligible(self: LaneSelf, shop: string): boolean {
  return self.mode !== 'off' && self.state === 'ready' && !self.paused && sameAccount(self.account, shop);
}

/** Why the laptop answering the lane should be replaced, or null while it is fine. */
export function staleLeader(l: LeaderView | null, row: Pick<LaneLeaderRow, 'since'>, shop: string, now: number, agentOn: boolean): Reason | null {
  if (!l || !l.exists || l.revoked) return 'removed';
  if (!l.last_seen_at || now - l.last_seen_at > TAKEOVER_OFFLINE_MS) return 'offline';
  if (l.paused) return 'paused';
  if (!sameAccount(l.account, shop)) return 'other_account';
  if (l.state !== 'ready') return now - (l.state_since || 0) >= NOT_READY_MS ? 'not_working' : null;
  // A tab that says it is fine but has read nothing for minutes while its lane works. Not while the agent
  // is off, and not until the lane has worked STALL_MS since it started (the agent or the channel was just
  // switched on) or since it was handed this lane: until then an old last good read means nothing.
  if (agentOn && l.active_since && l.last_ok_at && now - Math.max(l.last_ok_at, row.since || 0, l.active_since) > STALL_MS) return 'stalled';
  return null;
}

/** The role this laptop has on one lane, and the one write (if any) that makes it so. */
export function elect(i: ElectInput): ElectOutput {
  const { self, shop, row, me } = i;
  if (self.mode === 'off') return { role: 'off', action: null };
  const iLead = Boolean(row && row.device_id === me);
  if (!sameAccount(self.account, shop)) {
    return { role: 'other_account', action: iLead ? { kind: 'vacate', reason: 'other_account' } : null };
  }
  const ok = eligible(self, shop);
  if (iLead) {
    if (ok) return { role: 'active', action: !row!.account && self.account ? { kind: 'learn', account: self.account } : null };
    // Needs the person at the laptop (signed out, blocked, no tab, paused): give it up so a standby answers now.
    if (self.paused) return { role: 'standby', action: { kind: 'vacate', reason: 'paused' } };
    if (GIVE_UP_STATES.has(self.state)) return { role: 'standby', action: { kind: 'vacate', reason: self.state as Reason } };
    // Loading or a passing error: kept for now, with no lease (it cannot work). A standby takes over after NOT_READY_MS.
    return { role: 'active', action: null };
  }
  if (!ok) return { role: 'standby', action: null };
  if (!row || !row.device_id) return { role: 'active', action: { kind: 'claim', reason: 'claim', account: self.account } };
  const why = staleLeader(i.leader, row, shop, i.now, i.agentOn);
  if (why) return { role: 'active', action: { kind: 'takeover', reason: why, account: self.account } };
  return { role: 'standby', action: null };
}

/** How long the active laptop may work the lane from now: never past the point a standby may take over. */
export function leaseMs(role: Role, state: string, storedSeen: number, now: number): number {
  if (role !== 'active' || state !== 'ready') return 0;
  return Math.max(0, Math.min(LANE_LEASE_MS, storedSeen + TAKEOVER_OFFLINE_MS - LEASE_MARGIN_MS - now));
}

/**
 * Jobs decided from an inbound report are handed over in the answer only to the laptop that answers
 * the lane (or to anyone while nobody does). Another laptop's report is still stored and decided: an
 * older build that cannot stand by may post one, and its replies wait in the queue for the active laptop.
 * `leader`: lane_leaders.device_id for the lane, '' for nobody, null for a lane never answered.
 */
export function inlineAllowed(deviceId: string, leader: string | null): boolean {
  return !leader || leader === deviceId;
}

/**
 * How the jobs a laptop holds on a lane move to the next one when it stops answering it, or null to
 * leave them where they are. `wait`: the soonest they may go out again. `afterLease`: not before the old
 * lease has run out either (the old laptop may still send them meanwhile).
 *  * It stood aside itself because it was paused: it drops its queue without a word, so its jobs go
 *    back now (a 0.6.0 build says which one it is typing; that one stays), or after a short wait.
 *  * It went offline or was removed: a 0.6.0 build that was not alone stops at the end of its lane
 *    lease (before the takeover), so a short wait covers a send it was typing. Any other build, or one
 *    told it was alone, may keep sending what it holds until its job leases end.
 *  * Any other reason: a 0.6.0 build is told on its next sync and hands its jobs back (stood_down). An
 *    older build never does, so its jobs move once their lease is over (not a minute later at the
 *    sweeper, with a try used).
 */
export function releasePlan(reason: Reason, prev: { version: string | null; solo: boolean; self: boolean; sendingKnown: boolean }, now: number): { wait: number; afterLease: boolean } | null {
  const standsBy = prev.version !== null && canStandBy(prev.version);
  if (prev.self && reason === 'paused') return { wait: standsBy && prev.sendingKnown ? now : now + RELEASE_WAIT_MS, afterLease: false };
  if (reason === 'offline' || reason === 'removed') return { wait: now + RELEASE_WAIT_MS, afterLease: !standsBy || prev.solo };
  if (standsBy) return null;
  return { wait: now, afterLease: true };
}

// ---- in the sync ---------------------------------------------------------------------------------------

export interface LaneGrant {
  role: Role;
  /** How long this laptop may work the lane, from the moment it sent the sync. 0 when it may not. */
  lease_ms: number;
  epoch: number;
  /** The shop's account for the lane ('' until known). */
  account: string;
  /** The only laptop paired: it keeps working while the server cannot be reached. */
  solo: boolean;
  leader: { device_id: string; person: string; name: string } | null;
}

export interface Elected {
  grants: Record<string, LaneGrant>;
  /** Channels this laptop answers right now: the only ones it is given jobs for. */
  active: Channel[];
}

type PeerRow = Pick<DeviceRow, 'id' | 'name' | 'person' | 'last_seen_at' | 'status' | 'revoked_at' | 'version'>;

/** The stored view of another laptop on one channel. */
export function leaderView(d: PeerRow | null | undefined, ch: Channel): LeaderView {
  if (!d) return { exists: false, revoked: false, last_seen_at: null, paused: false, state: 'no_tab', state_since: 0, account: '', last_ok_at: 0, active_since: 0 };
  const st = parseJson<DeviceStatus>(d.status, { channels: {}, paused_locally: false, reported_at: 0 });
  const c = st.channels?.[ch] as ChannelStatus | undefined;
  return {
    exists: true, revoked: Boolean(d.revoked_at), last_seen_at: d.last_seen_at, paused: st.paused_locally === true,
    state: c?.state ?? 'no_tab', state_since: c?.state_since || st.reported_at || 0, account: c?.account ?? '', last_ok_at: c?.last_ok_at ?? 0,
    active_since: c?.active_since ?? 0,
  };
}

const TAKEOVER_WORDS: Record<string, (ch: string, prev: string) => string> = {
  offline: (_ch, prev) => `${prev} is offline.`,
  not_working: (ch, prev) => `${ch} stopped working on ${prev}.`,
  stalled: (_ch, prev) => `${prev} stopped reading it.`,
  paused: (_ch, prev) => `${prev} is paused.`,
  other_account: (_ch, prev) => `${prev} is on another account.`,
  removed: (_ch, prev) => `${prev} was removed.`,
  logged_out: (ch, prev) => `${ch} is signed out on ${prev}.`,
  blocked: (ch, prev) => `${ch} is blocked on ${prev}.`,
  no_tab: (ch, prev) => `${prev} has no ${ch} tab open.`,
};

/** The statement that moves one laptop's leased jobs of one channel back to the queue (no try used). */
function releaseStatement(db: D1Database, deviceId: string, ch: Channel, plan: { wait: number; afterLease: boolean }, exceptId: string): D1PreparedStatement {
  return stmt(db,
    `UPDATE outbox SET status = 'pending', lease_until = NULL, lease_device = NULL, attempts = MAX(0, attempts - 1),
       not_before = MAX(not_before, ?, CASE WHEN ? = 1 THEN COALESCE(lease_until, 0) + ? ELSE 0 END)
     WHERE status = 'leased' AND lease_device = ? AND channel = ? AND id != ?`,
    plan.wait, plan.afterLease ? 1 : 0, LEASE_GRACE_MS, deviceId, ch, exceptId);
}

/**
 * Elect this laptop's role on every lane, write the handovers (one batch, only when something changes)
 * and tell the owner about a takeover. `storedSeen` is the device row's last_seen_at after this sync's
 * own write: the lease is measured from it. `device.version` is the version this sync reported.
 */
export async function electLanes(env: Env, device: DeviceRow, status: DeviceStatus, settings: Settings, now: number, storedSeen: number, ctx: LaneContext): Promise<Elected> {
  const db = env.DB;
  const rows = new Map(ctx.leaders.map((r) => [r.lane, r]));
  const solo = ctx.others === 0;
  const selfOf = (ch: Channel): LaneSelf => {
    const st = status.channels[ch];
    return { state: st?.state ?? 'no_tab', account: st?.account ?? '', paused: status.paused_locally, mode: settings.channels[ch].mode };
  };
  // The other laptops this one may have to replace: read only when it could take over (one query).
  const peerIds = new Set<string>();
  for (const ch of CHANNELS) {
    const row = rows.get(laneOf(ch));
    if (row?.device_id && row.device_id !== device.id && eligible(selfOf(ch), shopAccount(ch, settings, row))) peerIds.add(row.device_id);
  }
  const peers = new Map<string, PeerRow>();
  if (peerIds.size) {
    const list = await all<PeerRow>(db, `SELECT id, name, person, last_seen_at, status, revoked_at, version FROM devices WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify([...peerIds]));
    for (const p of list) peers.set(p.id, p);
  }

  const out: Record<string, { ch: Channel; res: ElectOutput; row: LaneLeaderRow | null; shop: string }> = {};
  type Write = { lane: string; ch: Channel; action: ElectAction | { kind: 'keep' }; st: D1PreparedStatement };
  const writes: Write[] = [];
  for (const ch of CHANNELS) {
    const lane = laneOf(ch);
    const row = rows.get(lane) ?? null;
    const shop = shopAccount(ch, settings, row);
    const leader = row?.device_id && row.device_id !== device.id ? leaderView(peers.get(row.device_id), ch) : null;
    const res = elect({ now, me: device.id, self: selfOf(ch), shop, row, leader, agentOn: settings.agent.enabled });
    out[lane] = { ch, res, row, shop };
    const a = res.action;
    const iLead = row?.device_id === device.id;
    if (!a) {
      // Still answering: the row says whether this laptop is the only one (a takeover from it then waits for its jobs).
      if (iLead && res.role === 'active' && Boolean(row!.solo) !== solo) {
        writes.push({ lane, ch, action: { kind: 'keep' }, st: stmt(db, `UPDATE lane_leaders SET solo = ? WHERE lane = ? AND device_id = ? RETURNING *`, solo ? 1 : 0, lane, device.id) });
      }
      continue;
    }
    if (a.kind === 'claim') {
      writes.push({ lane, ch, action: a, st: stmt(db,
        `INSERT INTO lane_leaders (lane, account, device_id, epoch, since, reason, prev_device, solo) VALUES (?, ?, ?, 1, ?, 'claim', '', ?)
         ON CONFLICT(lane) DO UPDATE SET device_id = excluded.device_id, epoch = lane_leaders.epoch + 1, since = excluded.since, reason = 'claim', solo = excluded.solo,
           account = CASE WHEN lane_leaders.account = '' THEN excluded.account ELSE lane_leaders.account END
         WHERE lane_leaders.device_id = '' RETURNING *`,
        lane, a.account, device.id, now, solo ? 1 : 0) });
    } else if (a.kind === 'takeover') {
      writes.push({ lane, ch, action: a, st: stmt(db,
        `UPDATE lane_leaders SET device_id = ?, epoch = epoch + 1, since = ?, reason = ?, prev_device = device_id, solo = ?,
           account = CASE WHEN account = '' THEN ? ELSE account END
         WHERE lane = ? AND device_id = ? AND epoch = ? RETURNING *`,
        device.id, now, a.reason, solo ? 1 : 0, a.account, lane, row!.device_id, row!.epoch) });
    } else if (a.kind === 'vacate') {
      writes.push({ lane, ch, action: a, st: stmt(db,
        `UPDATE lane_leaders SET device_id = '', epoch = epoch + 1, since = ?, reason = ?, prev_device = device_id, solo = 0 WHERE lane = ? AND device_id = ? RETURNING *`,
        now, a.reason, lane, device.id) });
    } else {
      writes.push({ lane, ch, action: a, st: stmt(db,
        `UPDATE lane_leaders SET account = CASE WHEN account = '' THEN ? ELSE account END, solo = ? WHERE lane = ? AND device_id = ? RETURNING *`,
        a.account, solo ? 1 : 0, lane, device.id) });
    }
  }

  if (writes.length) {
    const results = await db.batch(writes.map((w) => w.st));
    const release: D1PreparedStatement[] = [];
    for (let i = 0; i < writes.length; i++) {
      const w = writes[i]!;
      const fresh = (results[i]?.results?.[0] ?? null) as LaneLeaderRow | null;
      const o = out[w.lane]!;
      const before = o.row;
      if (w.action.kind === 'claim' || w.action.kind === 'takeover') {
        if (!fresh) { o.res = { role: 'standby', action: null }; continue; } // another laptop got there first
        o.row = fresh;
        // The laptop that answered before still holds jobs on this channel: they move to this one, no try
        // used, as soon as it is safe (releasePlan). A 0.6.0 laptop that is online hands its own back.
        if (w.action.kind === 'takeover' && before?.device_id) {
          const prev = peers.get(before.device_id);
          const plan = releasePlan(w.action.reason, { version: prev?.version ?? null, solo: Boolean(before.solo), self: false, sendingKnown: false }, now);
          if (plan) release.push(releaseStatement(db, before.device_id, w.ch, plan, ''));
        }
        // Tell the owner when the lane moved from another laptop (not on the first claim, nor back to the same laptop).
        const prevId = w.action.kind === 'takeover' ? before?.device_id ?? '' : before?.prev_device ?? '';
        if (prevId && prevId !== device.id) await announce(env, settings, w.ch, device, prevId, w.action.kind === 'takeover' ? w.action.reason : (before?.reason as Reason) || 'claim', peers);
      } else if (fresh) {
        o.row = fresh;
        if (w.action.kind === 'vacate') {
          // This laptop stood aside. Paused: it dropped its queue, so its jobs go back for the next laptop
          // now. An older build never hands its jobs back: they move once their lease is over.
          const st = status.channels[w.ch];
          const sendingId = typeof st?.sending_id === 'string' ? st.sending_id : '';
          const plan = releasePlan(w.action.reason, { version: device.version, solo: false, self: true, sendingKnown: st?.sending_id !== undefined }, now);
          if (plan) release.push(releaseStatement(db, device.id, w.ch, plan, sendingId));
        }
      }
    }
    if (release.length) await db.batch(release);
  }

  const grants: Record<string, LaneGrant> = {};
  const active: Channel[] = [];
  for (const lane of LANES) {
    const o = out[lane]!;
    const role = o.res.role;
    const st = status.channels[o.ch];
    const leaderId = o.row?.device_id ?? '';
    const leaderRow = leaderId === device.id ? device : peers.get(leaderId);
    grants[lane] = {
      role,
      lease_ms: leaseMs(role, st?.state ?? 'no_tab', storedSeen, now),
      epoch: o.row?.epoch ?? 0,
      account: o.row?.account || o.shop,
      solo,
      leader: leaderId ? { device_id: leaderId, person: leaderRow?.person ?? '', name: leaderRow?.name ?? '' } : null,
    };
    if (role === 'active') active.push(o.ch);
  }
  return { grants, active };
}

/** A line on Live and a push when a lane moved to this laptop from another one. */
async function announce(env: Env, settings: Settings, ch: Channel, device: DeviceRow, prevId: string, reason: string, peers: Map<string, PeerRow>): Promise<void> {
  let prev = peers.get(prevId) ?? null;
  if (!prev) prev = (await all<PeerRow>(env.DB, 'SELECT id, name, person, last_seen_at, status, revoked_at, version FROM devices WHERE id = ?', prevId))[0] ?? null;
  const name = CHANNEL_NAME[ch];
  const me = deviceLabel(device);
  const was = deviceLabel(prev);
  const why = (TAKEOVER_WORDS[reason] ?? TAKEOVER_WORDS.offline!)(name, was);
  const message = `${me} took over ${name}. ${why}`;
  await logEvent(env.DB, { level: 'warn', type: 'failover', channel: ch, message, data: { lane: laneOf(ch), device: device.id, from: prevId, reason } });
  await alertOwner(env, settings, { kind: 'failover', title: `${me} took over ${name}`, body: why, path: '/#/live' });
}

/**
 * A laptop leaves (its extension was disconnected): it is removed, its lanes are free at once and the
 * jobs it held go back to the queue after a short wait (a send it was typing has finished by then).
 */
export async function leaveDevice(db: D1Database, deviceId: string, now: number): Promise<void> {
  await db.batch([
    stmt(db, 'UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now, deviceId),
    stmt(db, `UPDATE lane_leaders SET device_id = '', epoch = epoch + 1, since = ?, reason = 'removed', prev_device = device_id, solo = 0 WHERE device_id = ?`, now, deviceId),
    stmt(db, `UPDATE outbox SET status = 'pending', lease_until = NULL, lease_device = NULL, attempts = MAX(0, attempts - 1), not_before = MAX(not_before, ?)
      WHERE status = 'leased' AND lease_device = ?`, now + RELEASE_WAIT_MS, deviceId),
  ]);
}

// ---- for the health check ------------------------------------------------------------------------------

export type WatchedDevice = Pick<DeviceRow, 'id' | 'name' | 'person' | 'last_seen_at' | 'status'> & { leaders?: string | null };

/**
 * One status for the channel checks out of every laptop online: each channel as the laptop that answers
 * it sees it, else the first laptop online on the shop's account where it is ready, else any laptop on
 * the shop's account. A laptop signed in to another account never speaks for the shop's channel. When
 * the laptop that answers is offline and nobody took over, the channel counts as not read since that
 * laptop's last good read: the health check (src/pipeline/monitor.ts) calls it down after 10 minutes. A channel
 * whose laptop is paused is left out (not judged).
 */
export function channelsView(devices: WatchedDevice[], settings: Settings, now: number, onlineMs: number): DeviceStatus {
  const leaders = parseLeaders(devices[0]?.leaders ?? '[]');
  const list = devices.map((d) => ({
    d, online: d.last_seen_at !== null && now - d.last_seen_at < onlineMs,
    st: parseJson<DeviceStatus>(d.status, { channels: {}, paused_locally: false, reported_at: 0 }),
  }));
  const online = list.filter((x) => x.online);
  const out: DeviceStatus = { channels: {}, paused_locally: false, reported_at: now };
  for (const ch of CHANNELS) {
    const row = leaders.find((l) => l.lane === laneOf(ch)) ?? null;
    const shop = shopAccount(ch, settings, row);
    const shops = (x: (typeof list)[number]) => sameAccount(x.st.channels?.[ch]?.account ?? '', shop);
    const leader = row?.device_id ? list.find((x) => x.d.id === row.device_id) : undefined;
    if (leader && !leader.online) {
      // Offline for longer than a standby needs to take over (the online window is longer), and still
      // named: nobody took over. Judged from its last good read, so the alert comes on time.
      const was = leader.st.channels?.[ch];
      const seen = leader.d.last_seen_at || 0;
      out.channels[ch] = {
        state: 'error', detail: '', unread: 0, busy: false, sending: null, checked_at: now,
        last_ok_at: Math.max(1, Math.min(was?.last_ok_at || seen, seen || now)), last_scan_at: was?.last_scan_at ?? 0,
        last_error: `No laptop is answering ${CHANNEL_NAME[ch]}. ${deviceLabel(leader.d)} is offline.`,
        recoveries: 0, version: was?.version ?? '', account: shop, state_since: now, active_since: 0,
      };
      continue;
    }
    const pick = (leader?.online ? leader : undefined)
      ?? online.find((x) => shops(x) && x.st.channels?.[ch]?.state === 'ready' && !x.st.paused_locally)
      ?? online.find(shops);
    if (!pick) continue;
    if (pick.st.paused_locally) continue;
    const st = pick.st.channels?.[ch];
    if (st) out.channels[ch] = st;
  }
  // Every laptop online is paused: nothing is judged, as before.
  if (online.length && online.every((x) => x.st.paused_locally)) out.paused_locally = true;
  return out;
}

// ---- for the dashboard ---------------------------------------------------------------------------------

/** A laptop as currentDevice (src/routes/agent.ts) lists it. */
export interface ListedDevice {
  id: string; name: string; person: string; version: string; last_seen_at: number | null; online: boolean; status: DeviceStatus;
}

export type ShownRole = 'active' | 'standby' | 'other_account' | 'off' | 'not_ready';

/** What a laptop is doing on a lane, for the People panel. */
export function shownRole(d: ListedDevice, ch: Channel, row: LaneLeaderRow | null, shop: string, mode: string): ShownRole {
  if (mode === 'off') return 'off';
  const st = d.status?.channels?.[ch];
  if (!sameAccount(st?.account ?? '', shop)) return 'other_account';
  if (row?.device_id === d.id) return 'active';
  if (d.online && st?.state === 'ready' && !d.status?.paused_locally) return 'standby';
  return 'not_ready';
}

export interface TeamView {
  people: {
    key: string; name: string; online: boolean;
    devices: {
      id: string; name: string; person: string; label: string; version: string; online: boolean; last_seen_at: number | null;
      paused: boolean; can_stand_by: boolean;
      channels: Record<string, { state: string; detail: string; unread: number; account: string; account_shown: string; role: ShownRole; last_ok_at: number }>;
    }[];
  }[];
  lanes: Record<string, {
    lane: string; account: string; account_shown: string; since: number; reason: string;
    leader: { device_id: string; label: string; online: boolean } | null;
    /** The laptop whose tab Live shows for this channel: the one answering, else the best one online. */
    device: ListedDevice | null;
  }>;
  /** The laptop the hero and the top pill talk about: one online that answers a lane, else the newest. */
  device: ListedDevice | null;
}

/** People, their laptops and who answers each lane. One query (the leader rows) on top of the laptop list. */
export async function teamView(db: D1Database, devices: ListedDevice[], settings: Settings): Promise<TeamView> {
  const rows = new Map((await all<LaneLeaderRow>(db, 'SELECT * FROM lane_leaders')).map((r) => [r.lane, r]));
  const byId = new Map(devices.map((d) => [d.id, d]));
  const lanes: TeamView['lanes'] = {};
  const leads = new Map<string, number>();
  for (const ch of CHANNELS) {
    const row = rows.get(laneOf(ch)) ?? null;
    const shop = shopAccount(ch, settings, row);
    const leader = row?.device_id ? byId.get(row.device_id) ?? null : null;
    if (leader?.online) leads.set(leader.id, (leads.get(leader.id) ?? 0) + 1);
    const sameShop = (d: ListedDevice) => sameAccount(d.status?.channels?.[ch]?.account ?? '', shop);
    const readyOnline = devices.find((d) => d.online && d.status?.channels?.[ch]?.state === 'ready' && sameShop(d));
    lanes[ch] = {
      lane: laneOf(ch), account: shop, account_shown: showAccount(ch, shop), since: row?.since ?? 0, reason: row?.reason ?? '',
      leader: leader ? { device_id: leader.id, label: deviceLabel(leader), online: leader.online } : null,
      device: (leader?.online ? leader : null) ?? readyOnline ?? leader ?? devices.find((d) => d.online && sameShop(d)) ?? devices.find(sameShop) ?? devices[0] ?? null,
    };
  }
  const groups = new Map<string, TeamView['people'][number]>();
  for (const d of devices) {
    const name = d.person?.trim() || d.name || 'Laptop';
    const key = name.toLowerCase();
    const g = groups.get(key) ?? { key, name, online: false, devices: [] };
    g.online = g.online || d.online;
    const channels: TeamView['people'][number]['devices'][number]['channels'] = {};
    for (const ch of CHANNELS) {
      const st = d.status?.channels?.[ch];
      const row = rows.get(laneOf(ch)) ?? null;
      const shop = shopAccount(ch, settings, row);
      channels[ch] = {
        state: st?.state ?? 'no_tab', detail: st?.detail ?? '', unread: st?.unread ?? 0, account: st?.account ?? '',
        account_shown: showAccount(ch, st?.account ?? ''), role: shownRole(d, ch, row, shop, settings.channels[ch].mode), last_ok_at: st?.last_ok_at ?? 0,
      };
    }
    g.devices.push({
      id: d.id, name: d.name, person: d.person ?? '', label: deviceLabel(d), version: d.version, online: d.online, last_seen_at: d.last_seen_at,
      paused: d.status?.paused_locally === true, can_stand_by: canStandBy(d.version), channels,
    });
    groups.set(key, g);
  }
  // Online first, then the order the laptops checked in.
  const people = [...groups.values()].sort((a, b) => Number(b.online) - Number(a.online));
  const main = [...devices].filter((d) => d.online).sort((a, b) => (leads.get(b.id) ?? 0) - (leads.get(a.id) ?? 0))[0] ?? devices[0] ?? null;
  return { people, lanes, device: main };
}
