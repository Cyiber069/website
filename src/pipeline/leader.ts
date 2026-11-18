// People and failover: which laptop answers each lane.
//
// A lane is one kind of work in one channel (today the inbox of each: whatsapp:inbox, gmail:inbox,
// tiktok:inbox, the same ids as LANE_DEFS in extension/sw.js). For each lane ONE laptop is active: it
// scans, reads and sends. Every other laptop signed in to the shop's account stands by: it only checks
// that its tab works (probe), never opens a chat (opening one marks it read for the whole account) and
// never gets a job. When the laptop answering goes offline or its channel stops working, a standby takes
// over within about a minute and a half, and gives the lane back once the main laptop is ready again.
//
// The rules (`elect`, pure, test/unit/leader.test.ts):
//  * The main laptop is the one the owner chose on the People panel (state:main_device), else the oldest
//    paired laptop that checked in today, else the one that answers most lanes. A row nobody uses any
//    more (paired again, never disconnected) is never the main laptop. It is the shop's own laptop.
//  * The shop has one account per lane. Gmail: the inbox chosen in Connections. WhatsApp and TikTok (and
//    Gmail while Connections names none): the main laptop's account. A main laptop the owner chose
//    replaces one learned before; one that is main only because it is the oldest fills an empty one only,
//    so pairing order never changes the shop's accounts. One the owner set is never replaced
//    (lane_leaders.account_src).
//  * A laptop whose tab is on another account never answers that lane, never gets its jobs, its reports
//    are not stored and it never speaks for the channel on Live, Health or in alerts: "Connected to
//    another account". Its other lanes work on their own. The main laptop on another account, with no
//    laptop on the shop's account online, is the channel down: nobody answers it.
//  * An account the server cannot read: the main laptop may still answer (builds before 0.6.0 cannot read
//    the WhatsApp number or the TikTok handle). Any other laptop never claims the lane and never takes it
//    over ("Account not confirmed"), so it can never steal the lane from a laptop whose account matches.
//    Such a laptop on an older build still reads (it ignores lanes): its reports are kept while the shop's
//    account is not known or no laptop that answers is online, and the laptop that answers sends the replies.
//  * A laptop on the shop's account that is not the main one stands by. It takes over (a compare and swap
//    on the epoch, so two standbys never both win) only when the one answering is offline for 90 s, not
//    ready for 45 s, paused, removed, on another account, or has worked the lane for 3 min (active_ms)
//    without a good read. Signed out, blocked, no tab or paused: the one answering gives it up at once.
//  * Hand back: once the main laptop has been ready for 2 minutes while another one answers, it asks for
//    the lane back (handover_at). The one answering stands by at once (no lease, no jobs) and the main
//    laptop takes the lane 70 s later, when the last lease it handed out is over: never two at once. An
//    ask still open after 4 minutes is dropped, and so is one the main laptop cannot follow (not ready,
//    or offline for 90 s: the one answering then carries on).
//  * The active laptop's lease (lease_ms in the sync answer) ends before anyone may take over: at most
//    its last stored check in + 80 s, and takeover for offline waits 90 s. The one exception is a laptop
//    told it is the only one for the lane (solo: no other laptop seen today on the shop's account there,
//    or one it cannot tell): it keeps working while the server is away, as before, so a takeover from it
//    waits until the jobs it holds have run out.
//  * A page that reads nothing is only judged stalled once its lane has worked for STALL_MS (the
//    laptop says how long, active_ms): switching the agent or a channel on is never a stall.
//
// Cost (free plan): a sync reads the leader rows, the main laptop and the accounts of the other laptops
// seen today in one query (a partial index, so only live rows), reads the other laptops' rows only while
// it could replace one, and writes only on a handover. An inbound report reads one leader row, the main
// laptop and the laptops online now.
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
/** The main laptop has been ready this long while another one answers: it asks for the lane back. */
export const HANDBACK_READY_MS = 2 * MIN;
/** It takes the lane this long after asking: longer than any lease the other one may still hold. */
export const HANDBACK_WAIT_MS = 70_000;
/** An ask for the lane back still open after this long is dropped: the one answering carries on. */
export const HANDBACK_STUCK_MS = 4 * MIN;

/** States that need the person at the laptop: the active laptop gives the lane up at once. */
const GIVE_UP_STATES = new Set(['logged_out', 'blocked', 'no_tab']);

export type Role = 'active' | 'standby' | 'other_account' | 'unconfirmed' | 'off';
export type Reason = 'claim' | 'offline' | 'not_working' | 'stalled' | 'paused' | 'other_account' | 'unconfirmed' | 'removed'
  | 'logged_out' | 'blocked' | 'no_tab' | 'main_back';

// ---- accounts ------------------------------------------------------------------------------------------

/**
 * The account a tab is signed in to, the same way for every laptop: a WhatsApp number as digits, a
 * Gmail address in lower case, a TikTok handle in lower case without @. '' when it cannot be told.
 * WhatsApp takes a bare number or a phone id (@c.us, @s.whatsapp.net). A hidden id (@lid) or anything
 * else is not a phone number: '' (not known).
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

/**
 * The Gmail address a build before 0.6.0 shows in its status detail (it sends no account): the address
 * itself while the inbox is ready, maybe followed by more words ("x@y. 2 Gmail tabs are open. ..."), and
 * "This tab shows x@y. Switch it to ..." on another inbox.
 */
export function gmailFromDetail(detail: unknown): string {
  const s = typeof detail === 'string' ? detail.trim() : '';
  const direct = normAccount('gmail', s);
  if (direct) return direct;
  const lead = /^(\S+@\S+?\.[a-z]{2,})(?:\.\s|$)/i.exec(s);
  const first = lead ? normAccount('gmail', lead[1]) : '';
  if (first) return first;
  const m = /^This tab shows (\S+@\S+?)\.(?:\s|$)/.exec(s);
  return m ? normAccount('gmail', m[1]) : '';
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

/** The shop's account for a lane: the Gmail address set in Connections wins, else the lane's (the main laptop's, or the owner's). */
export function shopAccount(channel: Channel, settings: Settings, row: Pick<LaneLeaderRow, 'account'> | null | undefined): string {
  const set = channel === 'gmail' ? normAccount('gmail', settings.gmail.account) : '';
  return set || row?.account || '';
}

/** A tab's account against the shop's: the same, another one, or not known (either side cannot be told). */
export type AccountFit = 'shop' | 'other' | 'unknown';
export function accountFit(account: string, shop: string): AccountFit {
  if (!account || !shop) return 'unknown';
  return account === shop ? 'shop' : 'other';
}

/** May a laptop answer a lane, by its account: on the shop's, or the main laptop when its account cannot be read. */
export const accountOk = (fit: AccountFit, main: boolean): boolean => fit === 'shop' || (main && fit === 'unknown');

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

// ---- reading the lane rows -----------------------------------------------------------------------------

/** The owner's choice of main laptop (state:main_device, a JSON string), as an SQL expression. */
const CHOSEN_SQL = `(SELECT trim(value, '"') FROM settings WHERE key = 'state:main_device')`;

/**
 * The main laptop's id, as one SQL expression: the one the owner chose while it is still paired, else
 * the oldest paired laptop that checked in within SOLO_WINDOW_MS (through devices_live_seen, so only the
 * live rows), else the paired laptop that answers most lanes. An old row left paired (the extension was
 * paired again without Disconnect) is never the main laptop: it would make the laptop that works
 * "Account not confirmed" on WhatsApp and TikTok. `now` is the server's time; it goes in as a number.
 */
export function mainSql(now: number): string {
  const cut = Math.floor(Number(now) - SOLO_WINDOW_MS);
  if (!Number.isFinite(cut)) throw new Error('mainSql needs a time');
  return `COALESCE(
  (SELECT id FROM devices WHERE id = ${CHOSEN_SQL} AND revoked_at IS NULL),
  (SELECT id FROM devices INDEXED BY devices_live_seen WHERE revoked_at IS NULL AND last_seen_at > ${cut} ORDER BY created_at ASC, id ASC LIMIT 1),
  (SELECT l.device_id FROM lane_leaders l JOIN devices d ON d.id = l.device_id WHERE d.revoked_at IS NULL
     GROUP BY l.device_id ORDER BY COUNT(*) DESC, MAX(d.last_seen_at) DESC LIMIT 1))`;
}

/** Every lane row as one JSON array, for a query that reads them along with something else. */
export const LEADERS_SQL = `(SELECT json_group_array(json_object('lane', lane, 'account', account, 'device_id', device_id, 'epoch', epoch,
  'since', since, 'reason', reason, 'prev_device', prev_device, 'solo', solo, 'account_src', account_src, 'handover_at', handover_at)) FROM lane_leaders)`;

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
      account_src: String(o.account_src ?? ''), handover_at: Number(o.handover_at) || 0,
    });
  }
  return out;
}

/**
 * The main laptop, as a sync needs it: its name for the grant while a lane goes back to it, whether the
 * owner chose it (only then does its account replace one the lane learned before), and when it last
 * checked in (a hand back it asked for is dropped once it has gone quiet).
 */
export interface MainLaptop { id: string; person: string; name: string; chosen: boolean; last_seen_at: number }

/** The accounts another laptop seen today showed in its last status, per channel ('' when it showed none). */
export type PeerAccounts = Partial<Record<Channel, string>>;

/** What a sync needs to elect: who answers each lane, the main laptop, and the other laptops that checked in today. */
export interface LaneContext {
  leaders: LaneLeaderRow[];
  /** Other paired laptops seen in the last SOLO_WINDOW_MS, with their accounts. None: this laptop is alone. */
  others: PeerAccounts[];
  main: MainLaptop | null;
}

/** At most this many other laptops are read for `solo`: with more, none of them could be told apart anyway. */
const OTHERS_MAX = 20;

/**
 * Alone on a lane: no other laptop seen today could stand in there, because each showed another account
 * than the shop's on that channel. One on the shop's account, or one whose account (or the shop's) is not
 * known, could: then this laptop is not alone. A laptop on Adrian's own accounts never counts.
 */
export function soloOn(ch: Channel, shop: string, others: PeerAccounts[]): boolean {
  if (others.length > OTHERS_MAX) return false;
  return others.every((o) => accountFit(o[ch] ?? '', shop) === 'other');
}

const PEER_ACCOUNTS_SQL = `CASE WHEN json_valid(status) THEN json_object(${CHANNELS.map((ch) => `'${ch}', COALESCE(json_extract(status, '$.channels.${ch}.account'), '')`).join(', ')}) ELSE json_object() END`;

/**
 * One query. The other laptops are read only from those seen today through the partial index
 * devices_live_seen (migration 0013): a laptop paired long ago, or one paired again under a new name,
 * stops counting a day after it last checked in, and removed ones never count. The main laptop is one or
 * two rows more.
 */
export async function laneContext(db: D1Database, deviceId: string, now: number): Promise<LaneContext> {
  const row = await one<{ leaders: string | null; others: string | null; main: string | null }>(db,
    `SELECT ${LEADERS_SQL} AS leaders,
       (SELECT json_group_array(json(a)) FROM (SELECT ${PEER_ACCOUNTS_SQL} AS a FROM devices INDEXED BY devices_live_seen
          WHERE revoked_at IS NULL AND last_seen_at > ? AND id != ? LIMIT ${OTHERS_MAX + 1})) AS others,
       (SELECT json_object('id', id, 'person', person, 'name', name, 'last_seen_at', last_seen_at, 'chosen', id = ${CHOSEN_SQL})
          FROM devices WHERE id = ${mainSql(now)}) AS main`,
    now - SOLO_WINDOW_MS, deviceId);
  const m = parseJson<Partial<Record<keyof MainLaptop, unknown>> | null>(row?.main ?? null, null);
  const others = parseJson<unknown[]>(row?.others ?? '[]', []).filter((o): o is PeerAccounts => Boolean(o) && typeof o === 'object');
  return {
    leaders: parseLeaders(row?.leaders ?? '[]'), others,
    main: m && typeof m.id === 'string' && m.id ? {
      id: m.id, person: String(m.person ?? ''), name: String(m.name ?? ''), chosen: Number(m.chosen) === 1 || m.chosen === true,
      last_seen_at: Number(m.last_seen_at) || 0,
    } : null,
  };
}

/**
 * One lane, as an inbound report needs it: who answers, whether it is going back, its account, the main
 * laptop, and whether a laptop other than the one reporting that could answer the channel is online.
 */
export interface LaneInfo { leader: string; handover_at: number; account: string; main: string; answer_online: boolean }

/**
 * One query: the lane's row, the main laptop's id, and whether another laptop that could answer the
 * channel is online (checked in since `onlineSince`, not paused, and the main laptop not on another
 * account, or one on the shop's account). Only the laptops online now are read (devices_live_seen).
 * `gmailSet`: the inbox chosen in Connections, which is the shop's Gmail account when set.
 */
export async function laneInfo(db: D1Database, ch: Channel, deviceId: string, gmailSet: string, now: number, onlineSince: number): Promise<LaneInfo> {
  const row = await one<{ leader: string | null; handover_at: number | null; account: string | null; main: string | null; answer_online: number | null }>(db,
    `WITH l AS (SELECT device_id, handover_at, account FROM lane_leaders WHERE lane = ?1),
       m AS (SELECT ${mainSql(now)} AS id),
       s AS (SELECT CASE WHEN ?2 != '' THEN ?2 ELSE COALESCE((SELECT account FROM l), '') END AS shop)
     SELECT (SELECT device_id FROM l) AS leader, (SELECT handover_at FROM l) AS handover_at, (SELECT account FROM l) AS account, (SELECT id FROM m) AS main,
       EXISTS (SELECT 1 FROM devices d INDEXED BY devices_live_seen, m, s WHERE d.revoked_at IS NULL AND d.last_seen_at > ?3 AND d.id != ?4 AND json_valid(d.status)
         AND COALESCE(json_extract(d.status, '$.paused_locally'), 0) != 1
         AND ((d.id = m.id AND (s.shop = '' OR COALESCE(json_extract(d.status, ?5), '') IN ('', s.shop)))
           OR (s.shop != '' AND json_extract(d.status, ?5) = s.shop))) AS answer_online`,
    laneOf(ch), ch === 'gmail' ? normAccount('gmail', gmailSet) : '', onlineSince, deviceId, `$.channels.${ch}.account`);
  return {
    leader: row?.leader ?? '', handover_at: Number(row?.handover_at ?? 0) || 0, account: row?.account ?? '', main: row?.main ?? '',
    answer_online: Number(row?.answer_online ?? 0) === 1,
  };
}

/** Whether a report is stored, and whether its replies may go back in the answer. */
export interface InboundGate { store: boolean; inline: boolean; reason: '' | 'other_account' | 'unconfirmed' }

/**
 * A laptop's report of a chat. Stored from a laptop on the shop's account (or the main laptop when its
 * account cannot be read): a tab on another account is never a shop chat. Stored from such a laptop even
 * while another one answers (builds before 0.6.0 read every lane and mark a chat reported after any final
 * answer, so a message read in a failover or hand back window would be lost); its replies then wait in
 * the queue for the laptop answering. Replies go back in the answer only to the laptop answering (not
 * while it hands the lane back), or to anyone on the shop's account while nobody does.
 * A laptop the server cannot confirm (its account or the shop's is not known) never answers, so it never
 * gets replies back. A build that follows lanes (`followsLanes`, 0.6.0) never reads such a lane, so a
 * report from it is refused. An older build reads it all the same: its report is kept while the shop's
 * account is not known or no other laptop that could answer is online, or the message would be lost; the
 * replies wait for the laptop that answers.
 * `account`: the account this laptop's tab reported for the channel. `shop`: the shop's account.
 */
export function inboundGate(deviceId: string, account: string, shop: string, info: LaneInfo, followsLanes = true): InboundGate {
  const fit = accountFit(account, shop);
  if (fit === 'other') return { store: false, inline: false, reason: 'other_account' };
  if (fit === 'unknown' && info.main !== deviceId) {
    if (!followsLanes && (!shop || !info.answer_online)) return { store: true, inline: false, reason: '' };
    return { store: false, inline: false, reason: 'unconfirmed' };
  }
  return { store: true, inline: !info.leader || (info.leader === deviceId && !info.handover_at), reason: '' };
}

// ---- the rules (pure) ----------------------------------------------------------------------------------

/** What this laptop says about one lane. */
export interface LaneSelf {
  state: string;
  account: string;
  paused: boolean;
  mode: 'auto' | 'review' | 'off';
  /** Server time the lane went into `state` (it starts again after the laptop was offline). */
  state_since: number;
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
  /** This laptop is the main one. */
  main: boolean;
  /** The shop's account for the lane ('' until known). */
  shop: string;
  row: LaneLeaderRow | null;
  /** Set when another laptop answers the lane. */
  leader: LeaderView | null;
  /** The agent is switched on: only then does a page that reads nothing count as stalled. */
  agentOn: boolean;
  /**
   * When the main laptop last checked in (its stored row), 0 with no main laptop. Left out: not known.
   * A hand back it asked for is dropped once it has been quiet for TAKEOVER_OFFLINE_MS.
   */
  mainSeenAt?: number;
}

export type ElectAction =
  | { kind: 'claim'; reason: 'claim'; account: string }
  | { kind: 'takeover'; reason: Reason; account: string }
  | { kind: 'vacate'; reason: Reason }
  /** The main laptop asks for the lane back. */
  | { kind: 'handback' }
  /** An ask for the lane back is dropped. */
  | { kind: 'cancel_handback' };

export interface ElectOutput { role: Role; action: ElectAction | null }

/** May this laptop answer the lane right now? */
export function eligible(self: LaneSelf, shop: string, main: boolean): boolean {
  return self.mode !== 'off' && self.state === 'ready' && !self.paused && accountOk(accountFit(self.account, shop), main);
}

/** Why the laptop that answers the lane should be replaced, or null while it is fine. */
export function staleLeader(l: LeaderView | null, row: Pick<LaneLeaderRow, 'since'>, shop: string, now: number, agentOn: boolean): Reason | null {
  if (!l || !l.exists || l.revoked) return 'removed';
  if (!l.last_seen_at || now - l.last_seen_at > TAKEOVER_OFFLINE_MS) return 'offline';
  if (l.paused) return 'paused';
  if (accountFit(l.account, shop) === 'other') return 'other_account';
  if (l.state !== 'ready') return now - (l.state_since || 0) >= NOT_READY_MS ? 'not_working' : null;
  // A tab that says it is fine but has read nothing for minutes while its lane works. Not while the agent
  // is off, and not until the lane has worked STALL_MS since it started (the agent or the channel was just
  // switched on) or since it was handed this lane: until then an old last good read means nothing.
  if (agentOn && l.active_since && l.last_ok_at && now - Math.max(l.last_ok_at, row.since || 0, l.active_since) > STALL_MS) return 'stalled';
  return null;
}

/** The role this laptop has on one lane, and the one write (if any) that makes it so. */
export function elect(i: ElectInput): ElectOutput {
  const { self, shop, row, me, now } = i;
  if (self.mode === 'off') return { role: 'off', action: null };
  const iLead = Boolean(row && row.device_id === me);
  const fit = accountFit(self.account, shop);
  if (fit === 'other') return { role: 'other_account', action: iLead ? { kind: 'vacate', reason: 'other_account' } : null };
  // Not the main laptop, and its account (or the shop's) cannot be told: it never answers.
  if (fit === 'unknown' && !i.main) return { role: 'unconfirmed', action: iLead ? { kind: 'vacate', reason: 'unconfirmed' } : null };
  const ok = self.state === 'ready' && !self.paused;
  const asked = row?.handover_at || 0;
  if (iLead) {
    if (ok) {
      // The main laptop answers: an ask still on the row is over.
      if (i.main) return { role: 'active', action: asked ? { kind: 'cancel_handback' } : null };
      if (!asked) return { role: 'active', action: null };
      // The main laptop wants the lane back: stand by at once, so the two never answer together. An ask
      // it did not follow up for minutes is dropped and this laptop carries on, and so is one from a main
      // laptop that went quiet after asking (the lid was closed): nobody would answer until it is back.
      const mainGone = i.mainSeenAt !== undefined && (!i.mainSeenAt || now - i.mainSeenAt > TAKEOVER_OFFLINE_MS);
      if (now - asked > HANDBACK_STUCK_MS || mainGone) return { role: 'active', action: { kind: 'cancel_handback' } };
      return { role: 'standby', action: null };
    }
    // Needs the person at the laptop (signed out, blocked, no tab, paused): give it up so a standby answers now.
    if (self.paused) return { role: 'standby', action: { kind: 'vacate', reason: 'paused' } };
    if (GIVE_UP_STATES.has(self.state)) return { role: 'standby', action: { kind: 'vacate', reason: self.state as Reason } };
    // Loading or a passing error: kept for now, with no lease (it cannot work). A standby takes over after NOT_READY_MS.
    return { role: asked && !i.main ? 'standby' : 'active', action: null };
  }
  if (!ok) {
    // The main laptop asked for its lane back but cannot take it now: the ask is dropped.
    if (i.main && asked) return { role: 'standby', action: { kind: 'cancel_handback' } };
    return { role: 'standby', action: null };
  }
  if (!row || !row.device_id) return { role: 'active', action: { kind: 'claim', reason: 'claim', account: self.account } };
  const why = staleLeader(i.leader, row, shop, now, i.agentOn);
  if (why) return { role: 'active', action: { kind: 'takeover', reason: why, account: self.account } };
  if (!i.main) return { role: 'standby', action: null };
  // Another laptop answers and is fine. The main laptop asks for the lane once it has been ready for a
  // while, and takes it when the other one has had time to stop.
  if (!asked) return { role: 'standby', action: now - (self.state_since || now) >= HANDBACK_READY_MS ? { kind: 'handback' } : null };
  if (now - asked >= HANDBACK_WAIT_MS) return { role: 'active', action: { kind: 'takeover', reason: 'main_back', account: self.account } };
  return { role: 'standby', action: null };
}

/** How long the active laptop may work the lane from now: never past the point a standby may take over. */
export function leaseMs(role: Role, state: string, storedSeen: number, now: number): number {
  if (role !== 'active' || state !== 'ready') return 0;
  return Math.max(0, Math.min(LANE_LEASE_MS, storedSeen + TAKEOVER_OFFLINE_MS - LEASE_MARGIN_MS - now));
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
 *  * Any other reason (a hand back too): a 0.6.0 build that was not alone is told on its next sync and
 *    hands its jobs back (stood_down). Any other build never does, so its jobs move once their lease is
 *    over (not a minute later at the sweeper, with a try used).
 */
export function releasePlan(reason: Reason, prev: { version: string | null; solo: boolean; self: boolean; sendingKnown: boolean }, now: number): { wait: number; afterLease: boolean } | null {
  const standsBy = prev.version !== null && canStandBy(prev.version);
  if (prev.self && reason === 'paused') return { wait: standsBy && prev.sendingKnown ? now : now + RELEASE_WAIT_MS, afterLease: false };
  if (reason === 'offline' || reason === 'removed') return { wait: now + RELEASE_WAIT_MS, afterLease: !standsBy || prev.solo };
  if (standsBy && !(reason === 'main_back' && prev.solo)) return null;
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
  /**
   * No other laptop seen today could stand in on this lane (each is on another account there): it keeps
   * working while the server cannot be reached.
   */
  solo: boolean;
  /** The laptop answering the lane (while this one hands it back: the main laptop it goes to). */
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
  unconfirmed: (_ch, prev) => `The account on ${prev} could not be confirmed.`,
  removed: (_ch, prev) => `${prev} was removed.`,
  logged_out: (ch, prev) => `${ch} is signed out on ${prev}.`,
  blocked: (ch, prev) => `${ch} is blocked on ${prev}.`,
  no_tab: (ch, prev) => `${prev} has no ${ch} tab open.`,
  main_back: (_ch, prev) => `${prev} handed it back.`,
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
 * The account the main laptop makes the shop's on this lane, or '' for none: its own, when it can be read,
 * differs from the lane's and the owner did not set one. Gmail only while Connections names no inbox.
 * `chosen`: the owner made it the main laptop on the People panel. Only then does its account replace one
 * the lane already has. A laptop that is main only because it is the oldest one checking in fills an
 * empty account, nothing more: which laptop was paired first never changes the shop's accounts.
 */
export function mainLearns(ch: Channel, account: string, row: Pick<LaneLeaderRow, 'account' | 'account_src'> | null, settings: Settings, chosen: boolean): string {
  if (!account) return '';
  if (ch === 'gmail' && normAccount('gmail', settings.gmail.account)) return '';
  if (row?.account_src === 'owner') return '';
  if (row?.account === account) return '';
  return chosen || !row?.account ? account : '';
}

/**
 * Elect this laptop's role on every lane, write the handovers (one batch, only when something changes)
 * and tell the owner about a takeover. `storedSeen` is the device row's last_seen_at after this sync's
 * own write: the lease is measured from it. `device.version` is the version this sync reported.
 */
export async function electLanes(env: Env, device: DeviceRow, status: DeviceStatus, settings: Settings, now: number, storedSeen: number, ctx: LaneContext): Promise<Elected> {
  const db = env.DB;
  const rows = new Map(ctx.leaders.map((r) => [r.lane, r]));
  const isMain = ctx.main?.id === device.id;
  const chosen = isMain && Boolean(ctx.main?.chosen);
  // When the main laptop last checked in, as stored: this laptop's own sync for itself.
  const mainSeenAt = !ctx.main ? 0 : isMain ? storedSeen : ctx.main.last_seen_at;
  const selfOf = (ch: Channel): LaneSelf => {
    const st = status.channels[ch];
    return { state: st?.state ?? 'no_tab', account: st?.account ?? '', paused: status.paused_locally, mode: settings.channels[ch].mode, state_since: st?.state_since || now };
  };

  type Write = { lane: string; ch: Channel; action: ElectAction | { kind: 'keep' } | { kind: 'learn' }; st: D1PreparedStatement };
  const writes: Write[] = [];
  // The main laptop's account becomes the shop's (written first, so the election below already uses it).
  for (const ch of CHANNELS) {
    const lane = laneOf(ch);
    const row = rows.get(lane) ?? null;
    const learn = isMain ? mainLearns(ch, status.channels[ch]?.account ?? '', row, settings, chosen) : '';
    if (!learn) continue;
    rows.set(lane, row ? { ...row, account: learn, account_src: 'main' }
      : { lane, account: learn, device_id: '', epoch: 0, since: now, reason: 'account', prev_device: '', solo: 0, account_src: 'main', handover_at: 0 });
    // A main laptop the owner did not choose only fills an empty account (checked again here, in case another laptop wrote one meanwhile).
    writes.push({ lane, ch, action: { kind: 'learn' }, st: stmt(db,
      `INSERT INTO lane_leaders (lane, account, account_src, device_id, epoch, since, reason, prev_device) VALUES (?, ?, 'main', '', 0, ?, 'account', '')
       ON CONFLICT(lane) DO UPDATE SET account = excluded.account, account_src = 'main' WHERE lane_leaders.account_src != 'owner' AND (? = 1 OR lane_leaders.account = '')`,
      lane, learn, now, chosen ? 1 : 0) });
  }

  // The other laptops this one may have to replace: read only when it could take over (one query).
  const peerIds = new Set<string>();
  for (const ch of CHANNELS) {
    const row = rows.get(laneOf(ch));
    if (row?.device_id && row.device_id !== device.id && eligible(selfOf(ch), shopAccount(ch, settings, row), isMain)) peerIds.add(row.device_id);
  }
  const peers = new Map<string, PeerRow>();
  if (peerIds.size) {
    const list = await all<PeerRow>(db, `SELECT id, name, person, last_seen_at, status, revoked_at, version FROM devices WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify([...peerIds]));
    for (const p of list) peers.set(p.id, p);
  }

  const out: Record<string, { ch: Channel; res: ElectOutput; row: LaneLeaderRow | null; shop: string; solo: boolean }> = {};
  for (const ch of CHANNELS) {
    const lane = laneOf(ch);
    const row = rows.get(lane) ?? null;
    const shop = shopAccount(ch, settings, row);
    // Alone on this lane: no other laptop seen today could stand in here (one on another account never could).
    const solo = soloOn(ch, shop, ctx.others);
    const leader = row?.device_id && row.device_id !== device.id ? leaderView(peers.get(row.device_id), ch) : null;
    const res = elect({ now, me: device.id, self: selfOf(ch), main: isMain, shop, row, leader, agentOn: settings.agent.enabled, mainSeenAt });
    out[lane] = { ch, res, row, shop, solo };
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
        `INSERT INTO lane_leaders (lane, account, account_src, device_id, epoch, since, reason, prev_device, solo) VALUES (?, ?, ?, ?, 1, ?, 'claim', '', ?)
         ON CONFLICT(lane) DO UPDATE SET device_id = excluded.device_id, epoch = lane_leaders.epoch + 1, since = excluded.since, reason = 'claim', solo = excluded.solo,
           handover_at = 0, account = CASE WHEN lane_leaders.account = '' THEN excluded.account ELSE lane_leaders.account END
         WHERE lane_leaders.device_id = '' RETURNING *`,
        lane, a.account, isMain && a.account ? 'main' : '', device.id, now, solo ? 1 : 0) });
    } else if (a.kind === 'takeover') {
      // Taking the lane back after asking: only while the ask still stands. The one answering may have
      // dropped it just now (this laptop was quiet) and carry on with a lease: then this one waits.
      const back = a.reason === 'main_back';
      writes.push({ lane, ch, action: a, st: stmt(db,
        `UPDATE lane_leaders SET device_id = ?, epoch = epoch + 1, since = ?, reason = ?, prev_device = device_id, solo = ?, handover_at = 0,
           account = CASE WHEN account = '' THEN ? ELSE account END
         WHERE lane = ? AND device_id = ? AND epoch = ? AND (? = 0 OR handover_at = ?) RETURNING *`,
        device.id, now, a.reason, solo ? 1 : 0, a.account, lane, row!.device_id, row!.epoch, back ? 1 : 0, back ? row!.handover_at : 0) });
    } else if (a.kind === 'vacate') {
      writes.push({ lane, ch, action: a, st: stmt(db,
        `UPDATE lane_leaders SET device_id = '', epoch = epoch + 1, since = ?, reason = ?, prev_device = device_id, solo = 0, handover_at = 0 WHERE lane = ? AND device_id = ? RETURNING *`,
        now, a.reason, lane, device.id) });
    } else if (a.kind === 'handback') {
      writes.push({ lane, ch, action: a, st: stmt(db,
        `UPDATE lane_leaders SET handover_at = ? WHERE lane = ? AND device_id = ? AND epoch = ? AND handover_at = 0 RETURNING *`,
        now, lane, row!.device_id, row!.epoch) });
    } else {
      // The ask is dropped. When this laptop answers and carries on, the row says again whether it is alone.
      writes.push({ lane, ch, action: a, st: stmt(db,
        `UPDATE lane_leaders SET handover_at = 0, solo = CASE WHEN device_id = ? AND ? = 1 THEN ? ELSE solo END WHERE lane = ? AND epoch = ? AND handover_at = ? RETURNING *`,
        device.id, res.role === 'active' ? 1 : 0, solo ? 1 : 0, lane, row!.epoch, row!.handover_at) });
    }
  }

  if (writes.length) {
    const results = await db.batch(writes.map((w) => w.st));
    const release: D1PreparedStatement[] = [];
    for (let i = 0; i < writes.length; i++) {
      const w = writes[i]!;
      if (w.action.kind === 'learn') continue;
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
      } else if (w.action.kind === 'cancel_handback') {
        if (fresh) o.row = fresh;
        // The lane moved meanwhile (the main laptop took it): this laptop no longer answers it.
        else if (o.res.role === 'active' && before?.device_id === device.id && !isMain) o.res = { role: 'standby', action: null };
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
    // While this laptop hands the lane back it stands by for the main laptop: the grant names that one.
    const goingBack = leaderId === device.id && role === 'standby' && Boolean(o.row?.handover_at) && ctx.main && ctx.main.id !== device.id;
    grants[lane] = {
      role,
      lease_ms: leaseMs(role, st?.state ?? 'no_tab', storedSeen, now),
      epoch: o.row?.epoch ?? 0,
      account: o.row?.account || o.shop,
      solo: o.solo,
      leader: goingBack ? { device_id: ctx.main!.id, person: ctx.main!.person, name: ctx.main!.name }
        : leaderId ? { device_id: leaderId, person: leaderRow?.person ?? '', name: leaderRow?.name ?? '' } : null,
    };
    if (role === 'active') active.push(o.ch);
  }
  return { grants, active };
}

/** A line on Live and a push when a lane moved to this laptop from another one. A hand back is a line only. */
async function announce(env: Env, settings: Settings, ch: Channel, device: DeviceRow, prevId: string, reason: string, peers: Map<string, PeerRow>): Promise<void> {
  let prev = peers.get(prevId) ?? null;
  if (!prev) prev = (await all<PeerRow>(env.DB, 'SELECT id, name, person, last_seen_at, status, revoked_at, version FROM devices WHERE id = ?', prevId))[0] ?? null;
  const name = CHANNEL_NAME[ch];
  const me = deviceLabel(device);
  const was = deviceLabel(prev);
  const why = (TAKEOVER_WORDS[reason] ?? TAKEOVER_WORDS.offline!)(name, was);
  const message = `${me} took over ${name}. ${why}`;
  const back = reason === 'main_back';
  await logEvent(env.DB, { level: back ? 'good' : 'warn', type: 'failover', channel: ch, message, data: { lane: laneOf(ch), device: device.id, from: prevId, reason } });
  if (!back) await alertOwner(env, settings, { kind: 'failover', title: `${me} took over ${name}`, body: why, path: '/#/live' });
}

/**
 * A laptop leaves (its extension was disconnected): it is removed, its lanes are free at once and the
 * jobs it held go back to the queue after a short wait (a send it was typing has finished by then).
 */
export async function leaveDevice(db: D1Database, deviceId: string, now: number): Promise<void> {
  await db.batch([
    stmt(db, 'UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now, deviceId),
    stmt(db, `UPDATE lane_leaders SET device_id = '', epoch = epoch + 1, since = ?, reason = 'removed', prev_device = device_id, solo = 0, handover_at = 0 WHERE device_id = ?`, now, deviceId),
    stmt(db, `UPDATE outbox SET status = 'pending', lease_until = NULL, lease_device = NULL, attempts = MAX(0, attempts - 1), not_before = MAX(not_before, ?)
      WHERE status = 'leased' AND lease_device = ?`, now + RELEASE_WAIT_MS, deviceId),
  ]);
}

// ---- for the dashboard and the health check (pure) -----------------------------------------------------

/** A laptop as listDevices (src/routes/agent.ts) lists it. */
export interface ListedDevice {
  id: string; name: string; person: string; version: string; last_seen_at: number | null; online: boolean; status: DeviceStatus;
}

export type ShownRole = 'active' | 'handing_back' | 'standby' | 'other_account' | 'unconfirmed' | 'off' | 'not_ready';

/** What a laptop is doing on a lane, for the People panel. */
export function shownRole(d: ListedDevice, ch: Channel, row: LaneLeaderRow | null, shop: string, mode: string, isMain: boolean): ShownRole {
  if (mode === 'off') return 'off';
  const st = d.status?.channels?.[ch];
  const leads = row?.device_id === d.id;
  // No tab, or a page that is not signed in: its account cannot be read yet, and that is all it says.
  if (!st || (!st.account && st.state !== 'ready')) return leads ? 'active' : 'not_ready';
  const fit = accountFit(st.account ?? '', shop);
  if (fit === 'other') return 'other_account';
  if (fit === 'unknown' && !isMain) return 'unconfirmed';
  if (leads) return row!.handover_at && !isMain ? 'handing_back' : 'active';
  if (d.online && st.state === 'ready' && !d.status?.paused_locally) return 'standby';
  return 'not_ready';
}

/** The laptops each channel is judged by: answering it, else the main laptop, never a laptop on another account. */
interface LanePick<T> { leader: T | null; main: T | null; mainOk: boolean }
function lanePick<T extends { id: string }>(byId: Map<string, T>, row: LaneLeaderRow | null, main: string, fitOf: (d: T) => AccountFit): LanePick<T> {
  const leader = row?.device_id ? byId.get(row.device_id) ?? null : null;
  const m = main ? byId.get(main) ?? null : null;
  return { leader, main: m, mainOk: Boolean(m) && fitOf(m!) !== 'other' };
}

export interface TeamView {
  people: {
    key: string; name: string; online: boolean;
    devices: {
      id: string; name: string; person: string; label: string; version: string; online: boolean; last_seen_at: number | null;
      paused: boolean; can_stand_by: boolean; main: boolean;
      channels: Record<string, { state: string; detail: string; unread: number; account: string; account_shown: string; role: ShownRole; last_ok_at: number }>;
    }[];
  }[];
  lanes: Record<string, {
    lane: string; account: string; account_shown: string; account_src: string; since: number; reason: string;
    /** The main laptop asked for the lane back and the one answering stands by for it. */
    handing_back: boolean;
    leader: { device_id: string; label: string; online: boolean } | null;
    /**
     * The laptop whose tab Live and Health show for this channel: the one answering while it is online,
     * else the main laptop (unless it is on another account), else the one answering, else one online
     * and ready on the shop's account. Never a laptop on another account while one of those exists.
     */
    device: ListedDevice | null;
    /** What `device` does on this channel. */
    role: ShownRole | null;
  }>;
  /** The laptop the hero and the top pill talk about: one online that answers a lane, else the main laptop. */
  device: ListedDevice | null;
  main: { device_id: string; label: string } | null;
}

/** People, their laptops and who answers each lane. Pure: the laptop list, the lane rows and the main laptop's id. */
export function teamView(devices: ListedDevice[], leaders: LaneLeaderRow[], main: string, settings: Settings): TeamView {
  const rows = new Map(leaders.map((r) => [r.lane, r]));
  const byId = new Map(devices.map((d) => [d.id, d]));
  const lanes: TeamView['lanes'] = {};
  const leads = new Map<string, number>();
  for (const ch of CHANNELS) {
    const row = rows.get(laneOf(ch)) ?? null;
    const shop = shopAccount(ch, settings, row);
    const mode = settings.channels[ch].mode;
    const fitOf = (d: ListedDevice) => accountFit(d.status?.channels?.[ch]?.account ?? '', shop);
    const p = lanePick(byId, row, main, fitOf);
    if (p.leader?.online) leads.set(p.leader.id, (leads.get(p.leader.id) ?? 0) + 1);
    const device = (p.leader?.online ? p.leader : null)
      ?? (p.mainOk && (p.main!.online || !p.leader) ? p.main : null)
      ?? p.leader
      ?? devices.find((d) => d.online && fitOf(d) === 'shop' && d.status?.channels?.[ch]?.state === 'ready' && !d.status?.paused_locally)
      ?? devices.find((d) => d.online && fitOf(d) === 'shop' && !d.status?.paused_locally)
      ?? p.main
      ?? null;
    lanes[ch] = {
      lane: laneOf(ch), account: shop, account_shown: showAccount(ch, shop),
      account_src: ch === 'gmail' && normAccount('gmail', settings.gmail.account) ? 'owner' : row?.account_src ?? '',
      since: row?.since ?? 0, reason: row?.reason ?? '', handing_back: Boolean(row?.device_id && row.handover_at),
      leader: p.leader ? { device_id: p.leader.id, label: deviceLabel(p.leader), online: p.leader.online } : null,
      device, role: device ? shownRole(device, ch, row, shop, mode, device.id === main) : null,
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
        account_shown: showAccount(ch, st?.account ?? ''), role: shownRole(d, ch, row, shop, settings.channels[ch].mode, d.id === main), last_ok_at: st?.last_ok_at ?? 0,
      };
    }
    g.devices.push({
      id: d.id, name: d.name, person: d.person ?? '', label: deviceLabel(d), version: d.version, online: d.online, last_seen_at: d.last_seen_at,
      paused: d.status?.paused_locally === true, can_stand_by: canStandBy(d.version), main: d.id === main, channels,
    });
    groups.set(key, g);
  }
  // Online first, then the order the laptops checked in.
  const people = [...groups.values()].sort((a, b) => Number(b.online) - Number(a.online));
  const mainD = byId.get(main) ?? null;
  const answering = devices.filter((d) => d.online && (leads.get(d.id) ?? 0) > 0).sort((a, b) => (leads.get(b.id) ?? 0) - (leads.get(a.id) ?? 0))[0];
  return { people, lanes, device: answering ?? mainD ?? devices[0] ?? null, main: mainD ? { device_id: mainD.id, label: deviceLabel(mainD) } : null };
}

/**
 * The main laptop's tab is on another account and no laptop on the shop's account is online: nobody
 * answers the channel. Its page counts as down (`other_account`, src/pipeline/monitor.ts), unless it
 * already says why (signed out, or blocked: an older Gmail build on another inbox says "This tab shows ...").
 */
function onAnotherAccount(ch: Channel, st: ChannelStatus, d: ListedDevice): ChannelStatus {
  if (st.state === 'logged_out' || st.state === 'blocked') return st;
  return { ...st, state: 'other_account', last_error: `${CHANNEL_NAME[ch]} is on another account on ${deviceLabel(d)}. Sign in to the shop’s account there.` };
}

/**
 * One status for the channel checks: each channel as the laptop that answers it sees it while that one
 * is online, else as the main laptop sees it, else as a laptop online on the shop's account does (ready
 * first). A laptop that is not the main one and is signed in to another account never speaks for the
 * shop's channel. When the laptop that should answer (the one named, else the main laptop) is offline and
 * a laptop that could take over is online but did not, the channel counts as not read since that laptop's
 * last good read: the health check (src/pipeline/monitor.ts) calls it down after 10 minutes. With no such
 * laptop online the channel is not judged: the offline alert says it all, as with one laptop (one on
 * another account changes nothing). When nobody answers, the main laptop is online on another account and
 * no laptop on the shop's account is online, the channel is down: judged from the main laptop's tab
 * (`onAnotherAccount`), so the owner is told after 10 minutes. A channel whose laptop is paused is left out.
 */
export function channelsView(devices: ListedDevice[], leaders: LaneLeaderRow[], main: string, settings: Settings, now: number): DeviceStatus {
  const rows = new Map(leaders.map((r) => [r.lane, r]));
  const byId = new Map(devices.map((d) => [d.id, d]));
  const online = devices.filter((d) => d.online);
  const out: DeviceStatus = { channels: {}, paused_locally: false, reported_at: now };
  for (const ch of CHANNELS) {
    const row = rows.get(laneOf(ch)) ?? null;
    const shop = shopAccount(ch, settings, row);
    const fitOf = (d: ListedDevice) => accountFit(d.status?.channels?.[ch]?.account ?? '', shop);
    const p = lanePick(byId, row, main, fitOf);
    let pick: ListedDevice | undefined;
    let quiet: ListedDevice | null = null;
    if (p.leader?.online) pick = p.leader;
    else if (p.mainOk) { if (p.main!.online) pick = p.main!; else quiet = p.leader ?? p.main; }
    else if (p.leader) quiet = p.leader;
    else {
      // Nobody answers and the main laptop is on another account (or there is none).
      const shopOnline = online.filter((d) => fitOf(d) === 'shop' && !d.status?.paused_locally);
      pick = shopOnline.find((d) => d.status?.channels?.[ch]?.state === 'ready') ?? shopOnline[0];
      if (!pick && p.main?.online && !p.main.status?.paused_locally && !online.some((d) => fitOf(d) === 'shop')) {
        const st = p.main.status?.channels?.[ch];
        if (st) out.channels[ch] = onAnotherAccount(ch, st, p.main);
        continue;
      }
    }
    if (quiet) {
      // Offline for longer than a standby needs to take over (the online window is longer), and nobody
      // took over though a laptop that could is online. Judged from its last good read, so the alert comes on time.
      if (!online.some((d) => accountOk(fitOf(d), d.id === main))) continue;
      const was = quiet.status?.channels?.[ch];
      const seen = quiet.last_seen_at || 0;
      out.channels[ch] = {
        state: 'error', detail: '', unread: 0, busy: false, sending: null, checked_at: now,
        last_ok_at: Math.max(1, Math.min(was?.last_ok_at || seen, seen || now)), last_scan_at: was?.last_scan_at ?? 0,
        last_error: `No laptop is answering ${CHANNEL_NAME[ch]}. ${deviceLabel(quiet)} is offline.`,
        recoveries: 0, version: was?.version ?? '', account: shop, state_since: now, active_since: 0,
      };
      continue;
    }
    if (!pick || pick.status?.paused_locally) continue;
    const st = pick.status?.channels?.[ch];
    if (st) out.channels[ch] = st;
  }
  // Every laptop online is paused: nothing is judged, as before.
  if (online.length && online.every((d) => d.status?.paused_locally)) out.paused_locally = true;
  return out;
}

/**
 * Is a laptop online that could answer some channel: the main laptop, or one on the shop's account
 * there? Only then are channels judged (src/pipeline/monitor.ts): with none, the offline alert says it
 * all, and a laptop on another account being online neither raises nor clears a channel problem.
 */
export function canAnswerOnline(devices: ListedDevice[], leaders: LaneLeaderRow[], main: string, settings: Settings): boolean {
  const rows = new Map(leaders.map((r) => [r.lane, r]));
  return devices.some((d) => d.online && (d.id === main || CHANNELS.some((ch) =>
    accountFit(d.status?.channels?.[ch]?.account ?? '', shopAccount(ch, settings, rows.get(laneOf(ch)) ?? null)) === 'shop')));
}

/**
 * The laptop the owner is told about when it goes quiet: one that answers a lane, or the main laptop for
 * a lane nobody answers (with every channel switched off: the main laptop). A laptop that answers nothing
 * (one on another account, a standby) going quiet is no alert. `quietMs`: how long counts as gone.
 */
export function quietLaptop(devices: ListedDevice[], leaders: LaneLeaderRow[], main: string, settings: Settings, now: number, quietMs: number): ListedDevice | null {
  const rows = new Map(leaders.map((r) => [r.lane, r]));
  const byId = new Map(devices.map((d) => [d.id, d]));
  const ids: string[] = [];
  for (const ch of CHANNELS) {
    if (settings.channels[ch].mode === 'off') continue;
    const id = rows.get(laneOf(ch))?.device_id || main;
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length && main) ids.push(main);
  for (const id of ids) {
    const d = byId.get(id);
    if (d?.last_seen_at && now - d.last_seen_at >= quietMs) return d;
  }
  return null;
}
