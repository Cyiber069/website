// The rules that pick which laptop answers each lane (src/pipeline/leader.ts). Pure: no server needed.
// The owner's five points each have a block here ("point 1" to "point 5"), next to the older mechanics.
import { describe, expect, it } from 'vitest';
import {
  HANDBACK_READY_MS, HANDBACK_STUCK_MS, HANDBACK_WAIT_MS, LANE_LEASE_MS, LEASE_MARGIN_MS, NOT_READY_MS, RELEASE_WAIT_MS, STALL_MS, TAKEOVER_OFFLINE_MS,
  accountFit, canAnswerOnline, channelsView, cleanName, deviceLabel, elect, gmailFromDetail, inboundGate, leaseMs, mainLearns, maskAccount, normAccount, quietLaptop,
  releasePlan, showAccount, shownRole, staleLeader, teamView,
  type ElectInput, type LaneInfo, type LaneSelf, type LeaderView, type ListedDevice,
} from '../../src/pipeline/leader';
import { COMMAND_TTL_MS, commandId, parseCommandResults, planCommands, type DeviceCommand } from '../../src/pipeline/commands';
import { canStandBy } from '../../src/lib/version';
import type { LaneLeaderRow, Settings } from '../../src/types';

const CHANNEL_DOWN_MS = 10 * 60_000; // src/pipeline/monitor.ts

const NOW = 1_800_000_000_000;
const WA = '447700900123';
const WA2 = '447700900999';
const ready: LaneSelf = { state: 'ready', account: WA, paused: false, mode: 'auto', state_since: NOW - 3600_000 };
const row = (over: Partial<LaneLeaderRow> = {}): LaneLeaderRow => ({ lane: 'whatsapp:inbox', account: WA, device_id: 'dev_a', epoch: 3, since: NOW - 3600_000, reason: 'claim', prev_device: '', solo: 0, account_src: 'main', handover_at: 0, ...over });
const fine: LeaderView = { exists: true, revoked: false, last_seen_at: NOW - 20_000, paused: false, state: 'ready', state_since: NOW - 3600_000, account: WA, last_ok_at: NOW - 10_000, active_since: NOW - 3600_000 };
/** dev_b looks at a lane dev_a answers. dev_b is not the main laptop unless `main` says so. */
const input = (over: Partial<ElectInput> = {}): ElectInput => ({ now: NOW, me: 'dev_b', self: ready, main: false, shop: WA, row: row(), leader: fine, agentOn: true, ...over });

const settings = (over: { gmail?: string; modes?: Partial<Record<string, string>> } = {}) => ({
  gmail: { account: over.gmail ?? '' },
  channels: { whatsapp: { mode: over.modes?.whatsapp ?? 'auto' }, gmail: { mode: over.modes?.gmail ?? 'auto' }, tiktok: { mode: over.modes?.tiktok ?? 'auto' } },
  alerts: { offline_minutes: 5 },
}) as unknown as Settings;
type Ch = Partial<{ state: string; account: string; last_ok_at: number; detail: string; unread: number }>;
const laptop = (id: string, person: string, chans: Record<string, Ch>, over: Partial<ListedDevice> = {}): ListedDevice => ({
  id, name: `${person} MacBook`, person, version: '0.6.0', last_seen_at: NOW - 5000, online: true,
  status: { channels: Object.fromEntries(Object.entries(chans).map(([ch, c]) => [ch, { state: 'ready', detail: '', unread: 0, busy: false, sending: false, checked_at: NOW, last_ok_at: NOW - 5000, last_scan_at: NOW - 5000, last_error: '', recoveries: 0, version: '0.6.0', account: '', state_since: NOW - 3600_000, active_since: NOW - 3600_000, ...c }])), paused_locally: false, reported_at: NOW } as ListedDevice['status'],
  ...over,
});
const lanes = (leader: string, accounts: Partial<Record<string, string>> = {}): LaneLeaderRow[] => ['whatsapp', 'gmail', 'tiktok'].map((ch) => row({ lane: `${ch}:inbox`, device_id: leader, account: accounts[ch] ?? '' }));
const shopAccounts = { whatsapp: WA, gmail: 'shop@acx.example', tiktok: 'acx.ebikes' };
const samAll = { whatsapp: { account: WA }, gmail: { account: 'shop@acx.example' }, tiktok: { account: 'acx.ebikes' } };
const adrianOther = { whatsapp: { account: WA2 }, gmail: { state: 'blocked', account: 'adrian@home.example', detail: 'This tab shows adrian@home.example. Switch it to shop@acx.example' }, tiktok: { state: 'error', account: 'adrian.rides', last_ok_at: NOW - 3600_000 } };

describe('point 1: a laptop on another account never answers, never leads, never makes the owner’s channel look broken', () => {
  it('never claims, never takes over, and gives the lane up at once if it held it', () => {
    const other = { ...ready, account: WA2 };
    expect(elect(input({ self: other, row: null, leader: null }))).toEqual({ role: 'other_account', action: null });
    expect(elect(input({ self: other, row: row({ device_id: '' }), leader: null }))).toEqual({ role: 'other_account', action: null });
    // The one answering is offline for ages: still never taken over from another account.
    expect(elect(input({ self: other, leader: { ...fine, last_seen_at: NOW - 3600_000 } }))).toEqual({ role: 'other_account', action: null });
    expect(elect(input({ me: 'dev_a', self: other, leader: null }))).toEqual({ role: 'other_account', action: { kind: 'vacate', reason: 'other_account' } });
    // Even the main laptop on another account than the one the owner set stays out.
    expect(elect(input({ main: true, self: other, row: null, leader: null }))).toEqual({ role: 'other_account', action: null });
  });

  it('its reports are never stored and it gets no replies, whoever answers', () => {
    const info = (o: Partial<LaneInfo> = {}): LaneInfo => ({ leader: 'dev_a', handover_at: 0, account: WA, main: 'dev_a', ...o });
    expect(inboundGate('dev_b', WA2, WA, info())).toEqual({ store: false, inline: false, reason: 'other_account' });
    expect(inboundGate('dev_b', WA2, WA, info({ leader: '' }))).toEqual({ store: false, inline: false, reason: 'other_account' });
    // An account it cannot tell, or a shop account not known yet: not stored either (unless it is the main laptop).
    expect(inboundGate('dev_b', '', WA, info({ leader: '' }))).toEqual({ store: false, inline: false, reason: 'unconfirmed' });
    expect(inboundGate('dev_b', WA2, '', info({ leader: '' }))).toMatchObject({ store: false, reason: 'unconfirmed' });
    expect(inboundGate('dev_a', '', '', info({ leader: '' }))).toEqual({ store: true, inline: true, reason: '' });
  });

  it('the health check never judges the shop’s channel by it', () => {
    // Sam answers everything and is fine. Adrian is online on other accounts, Gmail "blocked", TikTok broken.
    const sam = laptop('dev_a', 'Sam', samAll);
    const adrian = laptop('dev_b', 'Adrian', adrianOther);
    const view = channelsView([adrian, sam], lanes('dev_a', shopAccounts), 'dev_a', settings(), NOW);
    for (const ch of ['whatsapp', 'gmail', 'tiktok'] as const) expect(view.channels[ch]).toMatchObject({ state: 'ready', last_ok_at: NOW - 5000 });
    // Sam signed out of WhatsApp: that counts, not Adrian's ready tab on another number.
    const out = laptop('dev_a', 'Sam', { ...samAll, whatsapp: { state: 'logged_out', account: '' } });
    expect(channelsView([adrian, out], lanes('', shopAccounts), 'dev_a', settings(), NOW).channels.whatsapp?.state).toBe('logged_out');
  });
});

describe('point 2: Connected for the owner, "Connected to another account" for Adrian, never counted', () => {
  it('the People panel roles: the owner answers, Adrian is on another account (not an error)', () => {
    const sam = laptop('dev_a', 'Sam', samAll);
    const adrian = laptop('dev_b', 'Adrian', adrianOther);
    const team = teamView([adrian, sam], lanes('dev_a', shopAccounts), 'dev_a', settings());
    const of = (name: string) => team.people.find((p) => p.name === name)!.devices[0]!;
    for (const ch of ['whatsapp', 'gmail', 'tiktok']) {
      expect(of('Sam').channels[ch]!.role).toBe('active');
      expect(of('Adrian').channels[ch]!.role).toBe('other_account');
    }
    expect(of('Sam').main).toBe(true);
    expect(of('Adrian').main).toBe(false);
    expect(team.main).toEqual({ device_id: 'dev_a', label: 'Sam’s laptop' });
  });

  it('Live and Health talk about the owner’s laptop, online or not, never Adrian’s', () => {
    const adrian = laptop('dev_b', 'Adrian', adrianOther);
    const sam = laptop('dev_a', 'Sam', samAll);
    const on = teamView([adrian, sam], lanes('dev_a', shopAccounts), 'dev_a', settings());
    expect(on.device?.id).toBe('dev_a');
    for (const ch of ['whatsapp', 'gmail', 'tiktok']) expect(on.lanes[ch]).toMatchObject({ device: { id: 'dev_a' }, role: 'active' });
    // Sam's laptop goes offline while Adrian's is online: Live says offline, it does not show Adrian's tabs.
    const gone = { ...sam, online: false, last_seen_at: NOW - 30 * 60_000 };
    const off = teamView([adrian, gone], lanes('dev_a', shopAccounts), 'dev_a', settings());
    expect(off.device?.id).toBe('dev_a');
    expect(off.device?.online).toBe(false);
    for (const ch of ['whatsapp', 'gmail', 'tiktok']) expect(off.lanes[ch]!.device?.id).toBe('dev_a');
    // Nobody answers yet (a fresh start): still the main laptop.
    expect(teamView([adrian, gone], lanes('', shopAccounts), 'dev_a', settings()).lanes.whatsapp!.device?.id).toBe('dev_a');
  });

  it('the offline alert names a laptop that answers, or the main laptop, never Adrian’s', () => {
    const quiet = 5 * 60_000;
    const sam = laptop('dev_a', 'Sam', samAll);
    const adrianGone = laptop('dev_b', 'Adrian', adrianOther, { online: false, last_seen_at: NOW - 60 * 60_000 });
    expect(quietLaptop([sam, adrianGone], lanes('dev_a', shopAccounts), 'dev_a', settings(), NOW, quiet)).toBeNull();
    const samGone = { ...sam, online: false, last_seen_at: NOW - 30 * 60_000 };
    const adrianOn = laptop('dev_b', 'Adrian', adrianOther);
    expect(quietLaptop([adrianOn, samGone], lanes('dev_a', shopAccounts), 'dev_a', settings(), NOW, quiet)?.id).toBe('dev_a');
    expect(quietLaptop([adrianOn, samGone], lanes('', shopAccounts), 'dev_a', settings(), NOW, quiet)?.id).toBe('dev_a');
    // Adrian answers WhatsApp (same number, took over) and goes quiet: that one is named.
    const rows = [row({ device_id: 'dev_b' }), ...lanes('dev_a', shopAccounts).slice(1)];
    expect(quietLaptop([sam, adrianGone], rows, 'dev_a', settings(), NOW, quiet)?.id).toBe('dev_b');
  });

  it('a channel down alert comes from the laptop that should answer, never from Adrian’s broken tabs', () => {
    const samGone = laptop('dev_a', 'Sam', { ...samAll, whatsapp: { account: WA, last_ok_at: NOW - CHANNEL_DOWN_MS - 1000 } }, { online: false, last_seen_at: NOW - 3 * 60_000 });
    // Adrian's laptop on other accounts is online: it changes nothing. Sam's is offline, and the offline
    // alert says so, as with one laptop: no channel is judged (Adrian's broken TikTok least of all), so no
    // problem is raised and none is wrongly cleared.
    const adrian = laptop('dev_b', 'Adrian', adrianOther);
    expect(canAnswerOnline([adrian, samGone], lanes('dev_a', shopAccounts), 'dev_a', settings())).toBe(false);
    expect(channelsView([adrian, samGone], lanes('dev_a', shopAccounts), 'dev_a', settings(), NOW).channels).toEqual({});
    expect(canAnswerOnline([adrian, { ...samGone, online: true }], lanes('dev_a', shopAccounts), 'dev_a', settings())).toBe(true);
    // Adrian's laptop is on the shop's accounts but its tabs are not ready, so it did not take over: the
    // channels count as not read since Sam's last good read.
    const standby = laptop('dev_b', 'Adrian', { whatsapp: { account: WA, state: 'loading' }, gmail: { account: 'shop@acx.example', state: 'loading' }, tiktok: { account: 'acx.ebikes', state: 'loading' } });
    const view = channelsView([standby, samGone], lanes('dev_a', shopAccounts), 'dev_a', settings(), NOW);
    expect(view.channels.whatsapp).toMatchObject({ state: 'error', last_ok_at: NOW - CHANNEL_DOWN_MS - 1000 });
    expect(view.channels.whatsapp?.last_error).toBe('No laptop is answering WhatsApp. Sam’s laptop is offline.');
    expect(view.channels.whatsapp?.last_error).not.toMatch(/[–—]/);
    // The same when nobody answers yet: the main laptop is the one that should.
    expect(channelsView([standby, samGone], lanes('', shopAccounts), 'dev_a', settings(), NOW).channels.gmail?.last_error).toBe('No laptop is answering Gmail. Sam’s laptop is offline.');
  });
});

describe('point 3: one login, and every person’s laptop is in the one view', () => {
  it('lists each person with their own laptop and channels', () => {
    const team = teamView([laptop('dev_b', 'Adrian', adrianOther), laptop('dev_a', 'Sam', samAll)], lanes('dev_a', shopAccounts), 'dev_a', settings());
    expect(team.people.map((p) => p.name).sort()).toEqual(['Adrian', 'Sam']);
    for (const p of team.people) {
      expect(p.devices).toHaveLength(1);
      expect(Object.keys(p.devices[0]!.channels)).toEqual(['whatsapp', 'gmail', 'tiktok']);
    }
    expect(team.people.find((p) => p.name === 'Adrian')!.devices[0]!.channels.whatsapp).toMatchObject({ account: WA2, account_shown: `+${WA2}` });
  });
});

describe('point 4: the shop’s account per channel', () => {
  it('WhatsApp and TikTok are the main laptop’s; Gmail is the inbox chosen in Connections; the owner’s choice is never replaced', () => {
    const s = settings();
    // The main laptop's account replaces one learned first from another laptop (or nothing yet).
    expect(mainLearns('whatsapp', WA, null, s)).toBe(WA);
    expect(mainLearns('whatsapp', WA, row({ account: WA2, account_src: '' }), s)).toBe(WA);
    expect(mainLearns('tiktok', 'acx.ebikes', row({ account: 'adrian.rides', account_src: 'main' }), s)).toBe('acx.ebikes');
    expect(mainLearns('whatsapp', WA, row({ account: WA }), s)).toBe('');
    // One the owner set: never.
    expect(mainLearns('whatsapp', WA, row({ account: WA2, account_src: 'owner' }), s)).toBe('');
    // An account it cannot read is no account.
    expect(mainLearns('whatsapp', '', row({ account: WA2, account_src: '' }), s)).toBe('');
    // Gmail: the inbox in Connections wins; with none chosen the main laptop's is used.
    expect(mainLearns('gmail', 'sam@acx.example', null, settings({ gmail: 'shop@acx.example' }))).toBe('');
    expect(mainLearns('gmail', 'sam@acx.example', null, s)).toBe('sam@acx.example');
  });

  it('an account the server cannot read never claims or takes a lane over, except the main laptop', () => {
    const unknown = { ...ready, account: '' };
    // Not the main laptop: never, whatever the one answering does.
    expect(elect(input({ self: unknown, row: null, leader: null }))).toEqual({ role: 'unconfirmed', action: null });
    expect(elect(input({ self: unknown, leader: { ...fine, last_seen_at: NOW - 3600_000 } }))).toEqual({ role: 'unconfirmed', action: null });
    expect(elect(input({ me: 'dev_a', self: unknown, leader: null }))).toEqual({ role: 'unconfirmed', action: { kind: 'vacate', reason: 'unconfirmed' } });
    // A readable account while the shop's is not known yet: not confirmed either.
    expect(elect(input({ shop: '', row: null, leader: null }))).toEqual({ role: 'unconfirmed', action: null });
    // The main laptop may answer with an account it cannot read (an older build).
    expect(elect(input({ main: true, self: unknown, row: null, leader: null }))).toMatchObject({ role: 'active', action: { kind: 'claim' } });
    expect(elect(input({ main: true, me: 'dev_a', self: unknown, leader: null }))).toEqual({ role: 'active', action: null });
    // A standby on the shop's account never replaces a main laptop whose account it cannot read.
    expect(elect(input({ leader: { ...fine, account: '' } }))).toEqual({ role: 'standby', action: null });
  });

  it('reads the Gmail address an older build shows in its status words', () => {
    expect(gmailFromDetail('Shop@acx.example')).toBe('shop@acx.example');
    expect(gmailFromDetail('This tab shows adrian@home.example. Switch it to shop@acx.example')).toBe('adrian@home.example');
    expect(gmailFromDetail('Writing a new email')).toBe('');
    expect(accountFit('', WA)).toBe('unknown');
    expect(accountFit(WA, '')).toBe('unknown');
    expect(accountFit(WA, WA)).toBe('shop');
    expect(accountFit(WA2, WA)).toBe('other');
  });

  it('the People panel says which laptop is main and which accounts are not confirmed', () => {
    const adrian = laptop('dev_b', 'Adrian', { whatsapp: { account: '' }, tiktok: { account: 'acx.ebikes' } }, { version: '0.5.2' });
    const sam = laptop('dev_a', 'Sam', { whatsapp: { account: '' }, tiktok: { account: '' } }, { version: '0.5.2' });
    const team = teamView([adrian, sam], lanes('dev_a'), 'dev_a', settings());
    const a = team.people.find((p) => p.name === 'Adrian')!.devices[0]!;
    const s = team.people.find((p) => p.name === 'Sam')!.devices[0]!;
    expect(a.channels.whatsapp!.role).toBe('unconfirmed');
    expect(a.channels.tiktok!.role).toBe('unconfirmed'); // the shop's TikTok is not known yet
    expect(s.channels.whatsapp!.role).toBe('active');
    expect(shownRole(sam, 'gmail', null, '', 'auto', true)).toBe('not_ready'); // no Gmail tab: just that
  });
});

describe('point 5: a laptop on the shop’s account stands by, takes over only when needed, and hands back cleanly', () => {
  it('stands by while the main laptop answers and is fine, however long', () => {
    expect(elect(input())).toEqual({ role: 'standby', action: null });
    expect(elect(input({ self: { ...ready, state_since: NOW - 24 * 3600_000 } }))).toEqual({ role: 'standby', action: null });
  });

  it('takes over when the one answering goes offline or its channel stops working', () => {
    const takeover = (leader: LeaderView | null) => elect(input({ leader })).action;
    expect(takeover({ ...fine, last_seen_at: NOW - TAKEOVER_OFFLINE_MS - 1 })).toMatchObject({ kind: 'takeover', reason: 'offline' });
    expect(takeover({ ...fine, state: 'error', state_since: NOW - NOT_READY_MS })).toMatchObject({ reason: 'not_working' });
    expect(takeover({ ...fine, last_ok_at: NOW - STALL_MS - 1 })).toMatchObject({ reason: 'stalled' });
  });

  it('the main laptop asks for its lane back once it has been ready 2 minutes, and the one answering stands by at once', () => {
    const main = (o: Partial<ElectInput> = {}) => elect(input({ me: 'dev_a', main: true, row: row({ device_id: 'dev_b' }), ...o }));
    expect(main({ self: { ...ready, state_since: NOW - HANDBACK_READY_MS + 1000 } })).toEqual({ role: 'standby', action: null });
    expect(main({ self: { ...ready, state_since: NOW - HANDBACK_READY_MS } })).toEqual({ role: 'standby', action: { kind: 'handback' } });
    // Asked: the laptop answering now stands by (no lease, no jobs) the moment it hears it.
    const asked = row({ device_id: 'dev_b', handover_at: NOW - 5000 });
    expect(elect(input({ me: 'dev_b', row: asked, leader: null }))).toEqual({ role: 'standby', action: null });
    expect(leaseMs('standby', 'ready', NOW, NOW)).toBe(0);
    // The main laptop waits until any lease the other one held is over, then takes it.
    expect(HANDBACK_WAIT_MS).toBeGreaterThan(LANE_LEASE_MS);
    expect(main({ row: row({ device_id: 'dev_b', handover_at: NOW - HANDBACK_WAIT_MS + 1000 }) })).toEqual({ role: 'standby', action: null });
    expect(main({ row: row({ device_id: 'dev_b', handover_at: NOW - HANDBACK_WAIT_MS }) })).toEqual({ role: 'active', action: { kind: 'takeover', reason: 'main_back', account: WA } });
  });

  it('drops an ask that is stuck or that the main laptop cannot follow', () => {
    const stuck = row({ device_id: 'dev_b', handover_at: NOW - HANDBACK_STUCK_MS - 1 });
    expect(elect(input({ me: 'dev_b', row: stuck, leader: null }))).toEqual({ role: 'active', action: { kind: 'cancel_handback' } });
    // The main laptop's tab is not ready any more: the one answering carries on.
    const asked = row({ device_id: 'dev_b', handover_at: NOW - 10_000 });
    expect(elect(input({ me: 'dev_a', main: true, row: asked, self: { ...ready, state: 'loading' } }))).toEqual({ role: 'standby', action: { kind: 'cancel_handback' } });
    // The main laptop answers again: a leftover ask is cleared.
    expect(elect(input({ me: 'dev_a', main: true, row: row({ handover_at: NOW - 10_000 }), leader: null }))).toEqual({ role: 'active', action: { kind: 'cancel_handback' } });
  });

  it('a hand back moves the other laptop’s jobs only once it cannot send them', () => {
    const prev = { version: '0.6.0', solo: false, self: false, sendingKnown: false };
    expect(releasePlan('main_back', prev, NOW)).toBeNull(); // it handed them back when it stood by
    expect(releasePlan('main_back', { ...prev, solo: true }, NOW)).toEqual({ wait: NOW, afterLease: true });
    expect(releasePlan('main_back', { ...prev, version: '0.5.2' }, NOW)).toEqual({ wait: NOW, afterLease: true });
  });
});

describe('elect: one laptop answers each lane', () => {
  it('claims a lane nobody answers, and keeps it while it works', () => {
    expect(elect(input({ row: null, leader: null }))).toEqual({ role: 'active', action: { kind: 'claim', reason: 'claim', account: WA } });
    expect(elect(input({ row: row({ device_id: '' }), leader: null }))).toMatchObject({ role: 'active', action: { kind: 'claim' } });
    // The main laptop claims before the shop's account is known (its account becomes the shop's); another laptop does not.
    expect(elect(input({ main: true, row: null, leader: null, shop: '' }))).toEqual({ role: 'active', action: { kind: 'claim', reason: 'claim', account: WA } });
    expect(elect(input({ row: null, leader: null, shop: '' }))).toEqual({ role: 'unconfirmed', action: null });
    // The laptop that answers keeps it with no write.
    expect(elect(input({ me: 'dev_a', leader: null }))).toEqual({ role: 'active', action: null });
  });

  it('a standby that is not ready itself never takes over, whatever the other one does', () => {
    expect(elect(input({ self: { ...ready, state: 'loading' }, leader: { ...fine, last_seen_at: NOW - 10 * 60_000 } }))).toEqual({ role: 'standby', action: null });
    expect(elect(input({ self: { ...ready, paused: true }, leader: null, row: null }))).toEqual({ role: 'standby', action: null });
  });

  it('takes over when the one that answers pauses, is removed or is on another account', () => {
    const takeover = (leader: LeaderView | null) => elect(input({ leader })).action;
    expect(takeover({ ...fine, last_seen_at: NOW - TAKEOVER_OFFLINE_MS + 1000 })).toBeNull();
    expect(takeover({ ...fine, state: 'loading', state_since: NOW - NOT_READY_MS + 1000 })).toBeNull(); // a reload is not a failure yet
    expect(takeover({ ...fine, paused: true })).toMatchObject({ reason: 'paused' });
    expect(takeover({ ...fine, revoked: true })).toMatchObject({ reason: 'removed' });
    expect(takeover(null)).toMatchObject({ reason: 'removed' });
    expect(takeover({ ...fine, account: WA2 })).toMatchObject({ reason: 'other_account' });
  });

  it('does not call a quiet page stalled while the agent is off, or right after a handover', () => {
    expect(staleLeader({ ...fine, last_ok_at: NOW - STALL_MS - 1 }, { since: 0 }, '', NOW, false)).toBeNull();
    expect(staleLeader({ ...fine, last_ok_at: NOW - 30 * 60_000 }, { since: NOW - 60_000 }, '', NOW, true)).toBeNull();
    // An older build that sends no last good read is judged by its state and check ins only.
    expect(staleLeader({ ...fine, last_ok_at: 0 }, { since: 0 }, '', NOW, true)).toBeNull();
  });

  it('never calls a page stalled just because the agent or the channel was switched on', () => {
    // The agent was off for hours: nobody read, so the last good read is old, and the lane did not work.
    const off = { ...fine, last_ok_at: NOW - 5 * 3600_000, active_since: 0 };
    expect(staleLeader(off, { since: NOW - 6 * 3600_000 }, '', NOW, true)).toBeNull();
    // Switched on a moment ago: its lane works again, but not for STALL_MS yet.
    expect(staleLeader({ ...off, active_since: NOW - 20_000 }, { since: NOW - 6 * 3600_000 }, '', NOW, true)).toBeNull();
    expect(staleLeader({ ...off, active_since: NOW - STALL_MS + 1000 }, { since: 0 }, '', NOW, true)).toBeNull();
    // Working for longer than that and still nothing read: now it is stalled.
    expect(staleLeader({ ...off, active_since: NOW - STALL_MS - 1000 }, { since: 0 }, '', NOW, true)).toBe('stalled');
    // An older build says nothing about it: never judged stalled (offline and not working still count).
    expect(staleLeader({ ...off, active_since: 0 }, { since: 0 }, '', NOW, true)).toBeNull();
    expect(elect(input({ leader: off }))).toEqual({ role: 'standby', action: null });
  });

  it('gives a lane up at once when the person at the laptop must act, but keeps it through a reload', () => {
    const mine = (self: Partial<LaneSelf>) => elect(input({ me: 'dev_a', self: { ...ready, ...self }, leader: null }));
    expect(mine({ state: 'logged_out' })).toEqual({ role: 'standby', action: { kind: 'vacate', reason: 'logged_out' } });
    expect(mine({ state: 'blocked' })).toMatchObject({ action: { kind: 'vacate', reason: 'blocked' } });
    expect(mine({ state: 'no_tab' })).toMatchObject({ action: { kind: 'vacate', reason: 'no_tab' } });
    expect(mine({ paused: true })).toMatchObject({ action: { kind: 'vacate', reason: 'paused' } });
    expect(mine({ state: 'loading' })).toEqual({ role: 'active', action: null });
    expect(mine({ state: 'error' })).toEqual({ role: 'active', action: null });
  });

  it('switched off: nobody answers it and nothing is written', () => {
    expect(elect(input({ self: { ...ready, mode: 'off' }, row: null, leader: null }))).toEqual({ role: 'off', action: null });
    expect(elect(input({ me: 'dev_a', self: { ...ready, mode: 'off' }, leader: null }))).toEqual({ role: 'off', action: null });
  });
});

describe('leases end before anyone may take over', () => {
  it('lasts at most a minute, and never past the last stored check in plus the takeover wait', () => {
    expect(leaseMs('active', 'ready', NOW, NOW)).toBe(LANE_LEASE_MS);
    // The row was written 50 s ago and is not written this time: 30 s left, so it ends 10 s before a takeover.
    expect(leaseMs('active', 'ready', NOW - 50_000, NOW)).toBe(TAKEOVER_OFFLINE_MS - LEASE_MARGIN_MS - 50_000);
    expect(NOW - 50_000 + TAKEOVER_OFFLINE_MS).toBeGreaterThan(NOW + leaseMs('active', 'ready', NOW - 50_000, NOW));
    expect(leaseMs('active', 'ready', NOW - 5 * 60_000, NOW)).toBe(0);
    expect(leaseMs('active', 'loading', NOW, NOW)).toBe(0);
    expect(leaseMs('standby', 'ready', NOW, NOW)).toBe(0);
  });
});

describe('inline jobs go only to the laptop that answers', () => {
  it('hands jobs over to the leader (not while it hands the lane back), or to anyone on the shop’s account while nobody answers', () => {
    const info = (o: Partial<LaneInfo> = {}): LaneInfo => ({ leader: 'dev_a', handover_at: 0, account: WA, main: 'dev_a', ...o });
    expect(inboundGate('dev_a', WA, WA, info())).toEqual({ store: true, inline: true, reason: '' });
    // A standby on the shop's account: its report is kept (an older build read it), its replies wait for the leader.
    expect(inboundGate('dev_b', WA, WA, info())).toEqual({ store: true, inline: false, reason: '' });
    expect(inboundGate('dev_b', WA, WA, info({ leader: '' }))).toEqual({ store: true, inline: true, reason: '' });
    // Handing the lane back: stored, but no replies in the answer for either laptop.
    expect(inboundGate('dev_b', WA, WA, info({ leader: 'dev_b', handover_at: NOW }))).toEqual({ store: true, inline: false, reason: '' });
    expect(inboundGate('dev_a', '', WA, info({ leader: 'dev_b', handover_at: NOW }))).toEqual({ store: true, inline: false, reason: '' });
  });
});

describe('the jobs of a laptop that stops answering', () => {
  const prev = (over: Partial<Parameters<typeof releasePlan>[1]> = {}) => ({ version: '0.6.0', solo: false, self: false, sendingKnown: false, ...over });
  it('a paused laptop hands its jobs back now (all but the one it is typing), an older build after a short wait', () => {
    expect(releasePlan('paused', prev({ self: true, sendingKnown: true }), NOW)).toEqual({ wait: NOW, afterLease: false });
    expect(releasePlan('paused', prev({ self: true, version: '0.5.2' }), NOW)).toEqual({ wait: NOW + RELEASE_WAIT_MS, afterLease: false });
  });
  it('offline: a short wait for a 0.6.0 laptop that was not alone, else until its job leases run out', () => {
    expect(releasePlan('offline', prev(), NOW)).toEqual({ wait: NOW + RELEASE_WAIT_MS, afterLease: false });
    expect(releasePlan('offline', prev({ solo: true }), NOW)).toEqual({ wait: NOW + RELEASE_WAIT_MS, afterLease: true });
    expect(releasePlan('offline', prev({ version: '0.5.2' }), NOW)).toEqual({ wait: NOW + RELEASE_WAIT_MS, afterLease: true });
    expect(releasePlan('offline', prev({ version: '0.3.2' }), NOW)?.afterLease).toBe(true);
    expect(releasePlan('removed', prev({ version: null }), NOW)?.afterLease).toBe(true);
  });
  it('any other reason: a 0.6.0 laptop hands them back itself, an older one gives them up when its leases end', () => {
    for (const r of ['not_working', 'stalled', 'other_account', 'unconfirmed', 'logged_out', 'blocked', 'no_tab'] as const) {
      expect(releasePlan(r, prev(), NOW)).toBeNull();
      expect(releasePlan(r, prev({ version: '0.5.2' }), NOW)).toEqual({ wait: NOW, afterLease: true });
    }
  });
});

describe('commands from the dashboard', () => {
  const cmd = (over: Partial<DeviceCommand> = {}): DeviceCommand => ({ id: commandId(NOW - 10_000), type: 'open_tab', lane: 'whatsapp:inbox', channel: 'whatsapp', at: NOW - 10_000, ...over });
  it('stay on the row until the laptop says it ran them, and are marked sent once', () => {
    const c = cmd();
    const first = planCommands({ commands: JSON.stringify([c]) }, {}, '0.6.0', NOW);
    expect(first.send.map((x) => x.id)).toEqual([c.id]);
    expect(JSON.parse(first.next!)[0].sent_at).toBe(NOW);
    // The answer was lost: the next sync hands it over again, with nothing to write.
    const again = planCommands({ commands: first.next! }, {}, '0.6.0', NOW + 20_000);
    expect(again.send.map((x) => x.id)).toEqual([c.id]);
    expect(again.next).toBeNull();
    // The laptop says it ran it: off the row.
    const done = planCommands({ commands: first.next! }, { command_results: [{ id: c.id, ok: true, at: NOW, error: '' }] }, '0.6.0', NOW + 40_000);
    expect(done).toMatchObject({ send: [], next: '[]' });
  });
  it('drops old ones and gives an older build none', () => {
    const old = cmd({ at: NOW - COMMAND_TTL_MS - 1 });
    expect(planCommands({ commands: JSON.stringify([old]) }, {}, '0.6.0', NOW)).toMatchObject({ send: [], next: '[]' });
    expect(planCommands({ commands: JSON.stringify([cmd()]) }, {}, '0.5.2', NOW).send).toEqual([]);
    expect(planCommands({ commands: '[]' }, {}, '0.6.0', NOW)).toMatchObject({ send: [], next: null });
  });
  it('reads the results a laptop sends, the newest last, one per id', () => {
    const r = parseCommandResults([{ id: 'a', ok: true, at: NOW }, { id: 'b', ok: false, error: ' tab   missing ' }, { id: 'a', ok: false, at: NOW + 99_999 }, 'junk'], null, NOW);
    expect(r).toEqual([{ id: 'b', ok: false, at: 0, error: 'tab missing' }, { id: 'a', ok: false, at: NOW, error: '' }]);
    expect(parseCommandResults(undefined, { id: 'c', ok: true, at: NOW - 5 }, NOW)).toEqual([{ id: 'c', ok: true, at: NOW - 5, error: '' }]);
  });
});

describe('the health check speaks for the shop’s accounts only', () => {
  it('the laptop that answers is online: its view counts', () => {
    const view = channelsView([laptop('dev_a', 'Sam', samAll)], lanes('dev_a', shopAccounts), 'dev_a', settings(), NOW);
    expect(view.channels.whatsapp).toMatchObject({ state: 'ready', last_ok_at: NOW - 5000 });
  });
  it('the one answering is offline but the main laptop is online: the main laptop counts (it takes over at once)', () => {
    const adrianGone = laptop('dev_b', 'Adrian', samAll, { online: false, last_seen_at: NOW - 3 * 60_000 });
    const sam = laptop('dev_a', 'Sam', { ...samAll, whatsapp: { account: WA, state: 'loading' } });
    expect(channelsView([sam, adrianGone], lanes('dev_b', shopAccounts), 'dev_a', settings(), NOW).channels.whatsapp?.state).toBe('loading');
  });
  it('a paused laptop is not judged', () => {
    const sam = laptop('dev_a', 'Sam', samAll);
    sam.status.paused_locally = true;
    expect(channelsView([sam], lanes('dev_a', shopAccounts), 'dev_a', settings(), NOW)).toMatchObject({ channels: {}, paused_locally: true });
  });
});

describe('accounts and names', () => {
  it('reads the same account the same way on every laptop', () => {
    expect(normAccount('whatsapp', '447700900123:12@c.us')).toBe('447700900123');
    expect(normAccount('whatsapp', '+44 7700 900123')).toBe('447700900123');
    expect(normAccount('whatsapp', '12')).toBe('');
    expect(normAccount('whatsapp', '447700900123@s.whatsapp.net')).toBe('447700900123');
    expect(normAccount('whatsapp', '"447700900123:3@c.us"')).toBe('447700900123');
    // A hidden id (LID) is not a phone number: not known.
    expect(normAccount('whatsapp', '123456789012345@lid')).toBe('');
    expect(normAccount('whatsapp', '447700900123@g.us')).toBe('');
    expect(normAccount('whatsapp', 'shop number')).toBe('');
    expect(normAccount('gmail', ' Shop@Gmail.com ')).toBe('shop@gmail.com');
    expect(normAccount('gmail', 'not an email')).toBe('');
    expect(normAccount('tiktok', '@ACX.Ebikes')).toBe('acx.ebikes');
    expect(normAccount('tiktok', 'https://www.tiktok.com/@acx.ebikes?lang=en')).toBe('acx.ebikes');
    expect(normAccount('tiktok', 42)).toBe('');
    expect(showAccount('whatsapp', '447700900123')).toBe('+447700900123');
    expect(showAccount('tiktok', 'acx.ebikes')).toBe('@acx.ebikes');
    expect(maskAccount('whatsapp', '447700900123')).toBe('…0123');
    expect(maskAccount('gmail', 'shop@gmail.com')).toBe('sh…@gmail.com');
  });

  it('names a laptop by its person in plain words', () => {
    expect(deviceLabel({ person: 'Adrian', name: 'MacBook' })).toBe('Adrian’s laptop');
    expect(deviceLabel({ person: '', name: 'Shop laptop' })).toBe('Shop laptop');
    expect(deviceLabel(null)).toBe('A laptop');
    expect(cleanName('  Sam\n\tJones  ')).toBe('Sam Jones');
    expect(cleanName('x'.repeat(80))).toHaveLength(40);
    for (const s of [deviceLabel({ person: 'Adrian' })]) expect(s).not.toMatch(/[–—]/);
  });

  it('knows which builds can stand by', () => {
    expect(canStandBy('0.6.0')).toBe(true);
    expect(canStandBy('1.0')).toBe(true);
    expect(canStandBy('test')).toBe(true);
    expect(canStandBy('0.5.2')).toBe(false);
    expect(canStandBy('0.3.2')).toBe(false);
  });
});
