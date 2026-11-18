// Settings locks (src/lib/locks.ts): what is locked, lock or unlock a box with the PIN, set or change the PIN.
// These routes are never locked themselves.
import { logEvent } from '../lib/events';
import { HttpError, bad, json, type Router } from '../lib/http';
import { isLockSection, lockState, lockView, pinValue, sectionLabel, setLocked, setPin, verifyPin } from '../lib/locks';

export function register(r: Router): void {
  // Cheap: the lock row comes with the settings read (cached in the isolate, no extra query).
  r.get('/api/locks', 'owner', async (c) => json(lockView(await lockState(c.db))));

  // { pin, old_pin? }: the first PIN needs no old one; changing it does.
  r.post('/api/locks/pin', 'owner', async (c) => {
    const body = await c.body<{ pin?: unknown; old_pin?: unknown }>();
    const pin = pinValue(body.pin, 'pin');
    const old = body.old_pin === undefined || body.old_pin === null || body.old_pin === '' ? null : pinValue(body.old_pin, 'old_pin');
    const { state, changed } = await setPin(c.db, pin, old, c.now);
    await logEvent(c.db, { level: 'info', type: 'settings_pin', message: changed ? 'You changed the PIN for locked settings.' : 'You set a PIN for locking settings.' });
    return json({ ok: true, ...lockView(state) });
  });

  // { locked: true | false, pin }: the same on every device from the next refresh.
  r.post('/api/locks/sections/:id', 'owner', async (c) => {
    const id = c.params.id!;
    if (!isLockSection(id)) throw new HttpError(404, 'unknown_section', 'There is no such setting to lock.');
    const body = await c.body<{ locked?: unknown; pin?: unknown }>();
    if (typeof body.locked !== 'boolean') throw bad('invalid_field', 'locked must be true or false', { field: 'locked' });
    const pin = pinValue(body.pin, 'pin');
    await verifyPin(c.db, pin, c.now);
    const state = await setLocked(c.db, id, body.locked, c.now);
    await logEvent(c.db, {
      level: 'info', type: 'settings_lock', data: { section: id, locked: body.locked },
      message: body.locked ? `You locked ${sectionLabel(id)}. Nobody can change it until it is unlocked with the PIN.` : `You unlocked ${sectionLabel(id)}.`,
    });
    return json({ ok: true, ...lockView(state) });
  });
}
