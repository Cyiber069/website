import { changePassword, createOwner, endSession, hasOwnerSession, ownerExists, startSession, validatePassword, verifyPassword } from '../lib/auth';
import { HttpError, json, type Router } from '../lib/http';

export function register(r: Router): void {
  // What the app shell needs to decide which screen to show. Safe to call signed out.
  r.get('/api/session', 'public', async (c) => {
    const setup = await ownerExists(c.db);
    const signedIn = setup ? await hasOwnerSession(c.env, c.req) : false;
    return json({ setup_done: setup, signed_in: signedIn });
  });

  // First run only: whoever opens a fresh deployment sets the password.
  r.post('/api/setup', 'public', async (c) => {
    const body = await c.body<{ password?: unknown }>();
    await createOwner(c.db, validatePassword(body.password));
    return json({ ok: true }, 200, { 'set-cookie': await startSession(c.env, c.req) });
  });

  r.post('/api/login', 'public', async (c) => {
    const body = await c.body<{ password?: unknown }>();
    if (typeof body.password !== 'string' || !body.password) throw new HttpError(400, 'missing_field', 'Enter your password');
    if (!(await verifyPassword(c.db, body.password))) throw new HttpError(401, 'wrong_password', 'Wrong password');
    return json({ ok: true }, 200, { 'set-cookie': await startSession(c.env, c.req) });
  });

  r.post('/api/logout', 'public', async (c) => json({ ok: true }, 200, { 'set-cookie': await endSession(c.env, c.req) }));

  r.post('/api/password', 'owner', async (c) => {
    const body = await c.body<{ current?: unknown; next?: unknown }>();
    if (typeof body.current !== 'string' || !(await verifyPassword(c.db, body.current))) throw new HttpError(401, 'wrong_password', 'Current password is wrong');
    await changePassword(c.db, validatePassword(body.next));
    return json({ ok: true }, 200, { 'set-cookie': await startSession(c.env, c.req) });
  });
}
