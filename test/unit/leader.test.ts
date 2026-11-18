// The rules that pick which laptop answers each lane (src/pipeline/leader.ts). Pure: no server needed.
import { describe, expect, it } from 'vitest';
import {
  LANE_LEASE_MS, LEASE_MARGIN_MS, NOT_READY_MS, RELEASE_WAIT_MS, STALL_MS, TAKEOVER_OFFLINE_MS,
  cleanName, deviceLabel, elect, inlineAllowed, leaseMs, maskAccount, normAccount, releasePlan, sameAccount, showAccount, staleLeader,
  type ElectInput, type LeaderView, type LaneSelf,
} from '../../src/pipeline/leader';
import { COMMAND_TTL_MS, commandId, parseCommandResults, planCommands, type DeviceCommand } from '../../src/pipeline/commands';
import { channelsView } from '../../src/pipeline/leader';
import { canStandBy } from '../../src/lib/version';
import type { LaneLeaderRow, Settings } from '../../src/types';

const CHANNEL_DOWN_MS = 10 * 60_000; // src/pipeline/monitor.ts
const ONLINE_MS = 100_000; // src/routes/agent.ts ONLINE_WINDOW_MS

const NOW = 1_800_000_000_000;
const ready: LaneSelf = { state: 'ready', account: '447700900123', paused: false, mode: 'auto' };
const row = (over: Partial<LaneLeaderRow> = {}): LaneLeaderRow => ({ lane: 'whatsapp:inbox', account: '447700900123', device_id: 'dev_a', epoch: 3, since: NOW - 3600_000, reason: 'claim', prev_device: '', solo: 0, ...over });
const fine: LeaderView = { exists: true, revoked: false, last_seen_at: NOW - 20_000, paused: false, state: 'ready', state_since: NOW - 3600_000, account: '447700900123', last_ok_at: NOW - 10_000, active_since: NOW - 3600_000 };
const input = (over: Partial<ElectInput> = {}): ElectInput => ({ now: NOW, me: 'dev_b', self: ready, shop: '447700900123', row: row(), leader: fine, agentOn: true, ...over });

describe('elect: one laptop answers each lane', () => {
  it('claims a lane nobody answers, and keeps it while it works', () => {
    expect(elect(input({ row: null, leader: null, shop: '' }))).toEqual({ role: 'active', action: { kind: 'claim', reason: 'claim', account: '447700900123' } });
    expect(elect(input({ row: row({ device_id: '' }), leader: null }))).toMatchObject({ role: 'active', action: { kind: 'claim' } });
    // The laptop that answers keeps it with no write.
    expect(elect(input({ me: 'dev_a', leader: null }))).toEqual({ role: 'active', action: null });
    // It learns the shop's account when the lane did not know it yet.
    expect(elect(input({ me: 'dev_a', row: row({ account: '' }), shop: '', leader: null }))).toEqual({ role: 'active', action: { kind: 'learn', account: '447700900123' } });
  });

  it('stands by while the laptop that answers is fine', () => {
    expect(elect(input())).toEqual({ role: 'standby', action: null });
    // A standby that is not ready itself never takes over, whatever the other one does.
    expect(elect(input({ self: { ...ready, state: 'loading' }, leader: { ...fine, last_seen_at: NOW - 10 * 60_000 } }))).toEqual({ role: 'standby', action: null });
    expect(elect(input({ self: { ...ready, paused: true }, leader: null, row: null }))).toEqual({ role: 'standby', action: null });
  });

  it('takes over when the one that answers goes offline, stops working, stalls, pauses or is removed', () => {
    const takeover = (leader: LeaderView | null) => elect(input({ leader })).action;
    expect(takeover({ ...fine, last_seen_at: NOW - TAKEOVER_OFFLINE_MS - 1 })).toMatchObject({ kind: 'takeover', reason: 'offline' });
    expect(takeover({ ...fine, last_seen_at: NOW - TAKEOVER_OFFLINE_MS + 1000 })).toBeNull();
    expect(takeover({ ...fine, state: 'error', state_since: NOW - NOT_READY_MS })).toMatchObject({ reason: 'not_working' });
    expect(takeover({ ...fine, state: 'loading', state_since: NOW - NOT_READY_MS + 1000 })).toBeNull(); // a reload is not a failure yet
    expect(takeover({ ...fine, last_ok_at: NOW - STALL_MS - 1 })).toMatchObject({ reason: 'stalled' });
    expect(takeover({ ...fine, paused: true })).toMatchObject({ reason: 'paused' });
    expect(takeover({ ...fine, revoked: true })).toMatchObject({ reason: 'removed' });
    expect(takeover(null)).toMatchObject({ reason: 'removed' });
    expect(takeover({ ...fine, account: '447700900999' })).toMatchObject({ reason: 'other_account' });
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

  it('keeps laptops on another account out, and counts an account it cannot tell as the same', () => {
    expect(elect(input({ self: { ...ready, account: '447700900999' }, row: null, leader: null }))).toEqual({ role: 'other_account', action: null });
    expect(elect(input({ me: 'dev_a', self: { ...ready, account: '447700900999' }, leader: null }))).toEqual({ role: 'other_account', action: { kind: 'vacate', reason: 'other_account' } });
    // Not known on either side: the same account, so it stands by instead of answering too.
    expect(elect(input({ self: { ...ready, account: '' } }))).toEqual({ role: 'standby', action: null });
    expect(elect(input({ self: { ...ready, account: '' }, leader: { ...fine, last_seen_at: NOW - 5 * 60_000 } }))).toMatchObject({ action: { kind: 'takeover', reason: 'offline' } });
    expect(sameAccount('', 'x')).toBe(true);
    expect(sameAccount('a', 'b')).toBe(false);
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
  it('hands jobs over to the leader, or to anyone while nobody answers', () => {
    expect(inlineAllowed('dev_a', 'dev_a')).toBe(true);
    expect(inlineAllowed('dev_b', 'dev_a')).toBe(false);
    expect(inlineAllowed('dev_b', '')).toBe(true);
    expect(inlineAllowed('dev_b', null)).toBe(true);
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
    for (const r of ['not_working', 'stalled', 'other_account', 'logged_out', 'blocked', 'no_tab'] as const) {
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
  const settings = { gmail: { account: '' } } as unknown as Settings;
  const status = (ch: Record<string, unknown>) => JSON.stringify({ channels: { whatsapp: { state: 'ready', last_ok_at: NOW - 5000, account: '447700900123', ...ch } }, paused_locally: false, reported_at: NOW });
  const leaders = (deviceId: string) => JSON.stringify([{ lane: 'whatsapp:inbox', account: '447700900123', device_id: deviceId }]);
  it('a laptop on another number never makes the shop’s WhatsApp look fine', () => {
    const view = channelsView([
      { id: 'dev_b', name: 'B', person: 'Adrian', last_seen_at: NOW - 5000, status: status({ account: '447700900999' }), leaders: leaders('') },
      { id: 'dev_a', name: 'A', person: 'Sam', last_seen_at: NOW - 8000, status: status({ state: 'logged_out', last_ok_at: NOW - 20 * 60_000 }) },
    ], settings, NOW, ONLINE_MS);
    expect(view.channels.whatsapp?.state).toBe('logged_out');
  });
  it('the laptop that answers is offline and nobody took over: down from its last good read', () => {
    const view = channelsView([
      { id: 'dev_b', name: 'B', person: 'Adrian', last_seen_at: NOW - 5000, status: status({ account: '447700900999' }), leaders: leaders('dev_a') },
      { id: 'dev_a', name: 'A', person: 'Sam', last_seen_at: NOW - 3 * 60_000, status: status({ last_ok_at: NOW - CHANNEL_DOWN_MS - 1000 }) },
    ], settings, NOW, ONLINE_MS);
    expect(view.channels.whatsapp).toMatchObject({ state: 'error', last_ok_at: NOW - CHANNEL_DOWN_MS - 1000 });
    expect(view.channels.whatsapp?.last_error).toBe('No laptop is answering WhatsApp. Sam’s laptop is offline.');
    expect(view.channels.whatsapp?.last_error).not.toMatch(/[–—]/);
  });
  it('the laptop that answers is online: its view counts', () => {
    const view = channelsView([
      { id: 'dev_a', name: 'A', person: 'Sam', last_seen_at: NOW - 5000, status: status({}), leaders: leaders('dev_a') },
    ], settings, NOW, ONLINE_MS);
    expect(view.channels.whatsapp).toMatchObject({ state: 'ready', last_ok_at: NOW - 5000 });
  });
});

describe('accounts and names', () => {
  it('reads the same account the same way on every laptop', () => {
    expect(normAccount('whatsapp', '447700900123:12@c.us')).toBe('447700900123');
    expect(normAccount('whatsapp', '+44 7700 900123')).toBe('447700900123');
    expect(normAccount('whatsapp', '12')).toBe('');
    expect(normAccount('whatsapp', '447700900123@s.whatsapp.net')).toBe('447700900123');
    expect(normAccount('whatsapp', '"447700900123:3@c.us"')).toBe('447700900123');
    // A hidden id (LID) is not a phone number: not known, so it never splits one number into two accounts.
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
