import type { DeviceRow, Env } from '../types';
import { hashPassword, randomToken, sha256Hex, timingSafeEqual } from './crypto';
import { one, run } from './db';
import { HttpError } from './http';
import { getState, setState } from './settings';
import { DAY, MIN } from './time';

const COOKIE = 'acx_session';
const SESSION_DAYS = 60;
const MAX_FAILS = 6;
const LOCK_MS = 5 * MIN;

interface OwnerRow { password_hash: string; salt: string; iterations: number }

export async function ownerExists(db: D1Database): Promise<boolean> {
  return (await one<{ id: number }>(db, 'SELECT id FROM owner WHERE id = 1')) !== null;
}

export function validatePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 8) throw new HttpError(400, 'weak_password', 'Use at least 8 characters');
  if (password.length > 200) throw new HttpError(400, 'weak_password', 'Password is too long');
  return password;
}

export async function createOwner(db: D1Database, password: string): Promise<void> {
  const { hash, salt, iterations } = await hashPassword(password);
  const now = Date.now();
  // INSERT fails if an owner already exists, which is what makes first-run setup single use.
  const changed = await run(
    db,
    'INSERT INTO owner (id, password_hash, salt, iterations, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
    hash, salt, iterations, now, now,
  );
  if (!changed) throw new HttpError(409, 'already_setup', 'This dashboard already has an owner');
}

export async function changePassword(db: D1Database, password: string): Promise<void> {
  const { hash, salt, iterations } = await hashPassword(password);
  await run(db, 'UPDATE owner SET password_hash = ?, salt = ?, iterations = ?, updated_at = ? WHERE id = 1', hash, salt, iterations, Date.now());
  await run(db, 'DELETE FROM sessions');
}

export async function verifyPassword(db: D1Database, password: string): Promise<boolean> {
  const lock = await getState<{ fails: number; until: number }>(db, 'auth_lock', { fails: 0, until: 0 });
  const now = Date.now();
  if (lock.until > now) throw new HttpError(429, 'locked', 'Too many wrong passwords. Try again in a few minutes.');
  const owner = await one<OwnerRow>(db, 'SELECT password_hash, salt, iterations FROM owner WHERE id = 1');
  if (!owner) throw new HttpError(409, 'not_setup', 'Set a password first');
  const attempt = await hashPassword(password, owner.salt, owner.iterations);
  const ok = timingSafeEqual(attempt.hash, owner.password_hash);
  if (ok) {
    if (lock.fails) await setState(db, 'auth_lock', { fails: 0, until: 0 });
    return true;
  }
  const fails = lock.fails + 1;
  await setState(db, 'auth_lock', { fails: fails >= MAX_FAILS ? 0 : fails, until: fails >= MAX_FAILS ? now + LOCK_MS : 0 });
  return false;
}

function cookieHeader(env: Env, req: Request, value: string, maxAgeSeconds: number): string {
  // Secure cookies are fine on https and on localhost. Plain http on a LAN IP only happens in tests.
  const secure = new URL(req.url).protocol === 'https:' || env.ACX_TEST_MODE !== '1';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export async function startSession(env: Env, req: Request): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await run(
    env.DB,
    'INSERT INTO sessions (id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?)',
    await sha256Hex(token), now, now + SESSION_DAYS * DAY, now, (req.headers.get('user-agent') ?? '').slice(0, 200),
  );
  return cookieHeader(env, req, token, SESSION_DAYS * 86_400);
}

function readCookie(req: Request): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return rest.join('=') || null;
  }
  return null;
}

export async function endSession(env: Env, req: Request): Promise<string> {
  const token = readCookie(req);
  if (token) await run(env.DB, 'DELETE FROM sessions WHERE id = ?', await sha256Hex(token));
  return cookieHeader(env, req, '', 0);
}

export async function hasOwnerSession(env: Env, req: Request): Promise<boolean> {
  const token = readCookie(req);
  if (!token) return false;
  const id = await sha256Hex(token);
  const now = Date.now();
  const row = await one<{ expires_at: number; last_seen_at: number }>(env.DB, 'SELECT expires_at, last_seen_at FROM sessions WHERE id = ?', id);
  if (!row || row.expires_at < now) return false;
  if (now - row.last_seen_at > 10 * MIN) await run(env.DB, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', now, id);
  return true;
}

/**
 * Cross-site request protection for cookie authenticated routes: state changing requests must come
 * from our own origin. Browsers always send Origin on cross-origin POST/PUT/PATCH/DELETE.
 */
export function assertSameOrigin(req: Request): void {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.get('origin');
  if (!origin) return; // same-origin fetches from some browsers and non-browser clients
  if (origin !== new URL(req.url).origin) throw new HttpError(403, 'bad_origin', 'Cross-site request blocked');
}

export async function deviceFromRequest(env: Env, req: Request): Promise<DeviceRow | null> {
  const header = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m) return null;
  const row = await one<DeviceRow>(env.DB, 'SELECT * FROM devices WHERE token_hash = ?', await sha256Hex(m[1]!));
  if (!row || row.revoked_at) return null;
  return row;
}
