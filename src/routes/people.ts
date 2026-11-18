// People and their laptops (owner): the chips next to the logo, the People panel, renaming, the open tab
// command for a laptop elsewhere and the shop's account per lane. The rules are in src/pipeline/leader.ts.
import type { Channel } from '../types';
import { HttpError, bad, json, type Router } from '../lib/http';
import { one, run } from '../lib/db';
import { logEvent } from '../lib/events';
import { getSettings, patchSettings } from '../lib/settings';
import { cachedAnswer } from '../lib/cache';
import { budget } from '../lib/budget';
import { CHANNEL_NAME, channelOf, cleanName, leaveDevice, normAccount, showAccount, teamView } from '../pipeline/leader';
import { addCommand, commandState, laneFor } from '../pipeline/commands';
import { currentDevice } from './agent';

export function register(r: Router): void {
  // The extension on a laptop was disconnected (the popup): that laptop is removed, so it no longer counts
  // as another laptop, its lanes are free at once and its jobs go to the next one.
  r.post('/api/agent/leave', 'device', async (c) => {
    if (!c.device) throw new HttpError(401, 'device_required');
    await leaveDevice(c.db, c.device.id, c.now);
    await logEvent(c.db, { level: 'info', type: 'device_left', message: `${c.device.person ? `${c.device.person}’s laptop` : c.device.name} was disconnected.` });
    return json({ ok: true });
  });

  // Everyone's laptops, what each channel does on them and who answers it. The same as Live has in the overview.
  r.get('/api/people', 'owner', async (c) => {
    const level = (await budget(c.db, c.now)).level;
    const team = await cachedAnswer('people', level === 'normal' ? 20_000 : 60_000, c.now, async () => {
      const devices = await currentDevice(c.db, c.now);
      return teamView(c.db, devices, await getSettings(c.db));
    });
    return json({ now: c.now, people: team.people, lanes: team.lanes });
  });

  // Rename a laptop or say whose it is. The People panel and Connections.
  r.patch('/api/devices/:id', 'owner', async (c) => {
    const body = await c.body<{ person?: unknown; name?: unknown }>();
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (body.person !== undefined) { sets.push('person = ?'); params.push(cleanName(body.person)); }
    if (body.name !== undefined) {
      const name = cleanName(body.name, 60);
      if (!name) throw bad('invalid_field', 'Give the laptop a name', { field: 'name' });
      sets.push('name = ?'); params.push(name);
    }
    if (!sets.length) throw bad('missing_field', 'Nothing to change');
    const changed = await run(c.db, `UPDATE devices SET ${sets.join(', ')} WHERE id = ? AND revoked_at IS NULL`, ...params, c.params.id!);
    if (!changed) throw new HttpError(404, 'not_found', 'That laptop is not paired any more');
    const row = await one<{ id: string; name: string; person: string }>(c.db, 'SELECT id, name, person FROM devices WHERE id = ?', c.params.id!);
    return json({ ok: true, device: row });
  });

  // Open and pin a tab on a laptop that is not this browser (the phone, another laptop). It goes out with
  // that laptop's next sync, so within about 20 seconds.
  r.post('/api/devices/:id/commands', 'owner', async (c) => {
    const body = await c.body<{ type?: unknown; lane?: unknown; channel?: unknown }>();
    if (body.type !== undefined && body.type !== 'open_tab') throw bad('invalid_field', 'Unknown command', { field: 'type' });
    const { lane, channel } = laneFor(body.lane ?? body.channel);
    const command = await addCommand(c.db, c.params.id!, { type: 'open_tab', lane, channel }, c.now);
    return json({ ok: true, command });
  });

  // Asked a few times after a command: waiting, sent (the laptop has it), done or failed (it said so).
  r.get('/api/devices/:id/commands/:cid', 'owner', async (c) => json(await commandState(c.db, c.params.id!, c.params.cid!, c.now)));

  // The shop's account for a lane: a laptop on any other account stays out of it. Empty forgets it, and the
  // next laptop that answers the lane sets it again. For Gmail it is the inbox chosen in Connections.
  r.put('/api/lanes/:lane/account', 'owner', async (c) => {
    const ch: Channel | null = channelOf(c.params.lane!);
    if (!ch) throw new HttpError(404, 'not_found', 'No such lane');
    const body = await c.body<{ account?: unknown }>();
    const raw = typeof body.account === 'string' ? body.account : '';
    const account = normAccount(ch, raw);
    if (raw.trim() && !account) throw bad('invalid_field', `That does not look like a ${CHANNEL_NAME[ch]} account`, { field: 'account' });
    // For Gmail it is also the inbox chosen in Connections (the tabs open it). The lane row is set the same
    // way for every channel: an empty value forgets what the lane learned, so the next laptop's account counts.
    if (ch === 'gmail') await patchSettings(c.db, 'gmail', { account });
    await run(c.db, `INSERT INTO lane_leaders (lane, account, device_id, epoch, since, reason, prev_device) VALUES (?, ?, '', 0, ?, 'account', '')
      ON CONFLICT(lane) DO UPDATE SET account = excluded.account`, c.params.lane!, account, c.now);
    await logEvent(c.db, {
      level: 'info', type: 'shop_account', channel: ch,
      message: account ? `The agent now uses ${showAccount(ch, account)} on ${CHANNEL_NAME[ch]}.` : `The agent will use the ${CHANNEL_NAME[ch]} account of the next laptop that answers it.`,
    });
    return json({ ok: true, lane: c.params.lane, account, account_shown: showAccount(ch, account) });
  });
}
