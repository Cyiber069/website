// Settings locks: the owner locks a settings box with a PIN so nobody can change it, on every device at once.
//
//   * Lock state is one settings row, `state:locks` ({ pin, sections: { <id>: locked_at } }), read with the settings
//     (BUNDLED_STATE in src/lib/settings.ts: no extra query). A lock change writes it and `state:settings_rev` in one
//     batch, so every other isolate drops its cached copy on its next signed in request (src/lib/auth.ts).
//   * The PIN (4 to 8 digits) is stored only as a PBKDF2 hash in `state:lock_pin`. Locking, unlocking and changing
//     the PIN all need it. Wrong PINs are counted in `state:lock_fails`: every check takes its slot first, in one
//     statement, so parallel guesses are counted too. After 5 wrong PINs every PIN check is refused for 15 minutes.
//   * Enforcement is one hook before the owner route handlers (src/index.ts): a change (POST, PUT, PATCH, DELETE)
//     whose path maps to a locked section is refused with 423. Reads are never refused. The agent switch, the
//     emergency stop, Urgent and Inbox replies, the support link, sign in and out and the lock routes are never
//     lockable, and nothing here touches the laptop's /api/agent/* routes or the agent's own work.
//   * Forgotten PIN: docs/SETUP.md has the SQL that deletes the three rows in the Cloudflare D1 console.
import { hashPassword, timingSafeEqual } from './crypto';
import { stmt } from './db';
import { HttpError, bad } from './http';
import { cachedState, invalidateSettings } from './settings';
import { MIN } from './time';

/** The settings boxes that can be locked, as the dashboard marks them (data-lock="<id>"). */
export const LOCK_SECTIONS = [
  { id: 'voice', label: 'Voice style', screen: 'Voice' },
  { id: 'brain', label: 'AI brain', screen: 'Connections' },
  { id: 'vision', label: 'Google AI Studio', screen: 'Connections' },
  { id: 'shopify', label: 'Shopify', screen: 'Connections' },
  { id: 'alerts', label: 'Phone notifications', screen: 'Connections' },
  { id: 'channels', label: 'Channel modes', screen: 'Connections' },
  { id: 'gmail', label: 'Gmail inbox', screen: 'Connections' },
  { id: 'pacing', label: 'Pacing', screen: 'Connections' },
  { id: 'laptops', label: 'Laptops', screen: 'Connections' },
  { id: 'recovery_message', label: 'Reminder message', screen: 'Recovery' },
  { id: 'recovery_settings', label: 'Reminder settings', screen: 'Recovery' },
  { id: 'discounts', label: 'Discount code settings', screen: 'Discount codes' },
  { id: 'sales', label: 'Sales settings', screen: 'Sales' },
  { id: 'knowledge', label: 'Knowledge', screen: 'Knowledge' },
] as const;

export type LockSectionId = (typeof LOCK_SECTIONS)[number]['id'];
const SECTION_IDS = new Set<string>(LOCK_SECTIONS.map((s) => s.id));
export const isLockSection = (id: unknown): id is LockSectionId => typeof id === 'string' && SECTION_IDS.has(id);
export const sectionLabel = (id: LockSectionId): string => LOCK_SECTIONS.find((s) => s.id === id)!.label;

// ---- which change belongs to which box ---------------------------------------------------------------
// A rule is "METHOD /path". METHOD * is any change (POST, PUT, PATCH, DELETE). A :name segment matches one
// segment, a last segment * matches one or more. Paths are compared the way the router reads them: empty
// segments dropped and every segment decoded, so /api/settings/voice/ and /api/settings/%76oice are the same box.

/** Changes that are never refused, whatever is locked. Checked first, so a wide rule below can never catch them. */
export const NEVER_LOCKED: readonly string[] = [
  // The agent switch and the emergency stop.
  'POST /api/agent-toggle', 'POST /api/panic', '* /api/settings/agent',
  // Answering Urgent, approving and sending replies (Urgent and Inbox), an Urgent "Approve code".
  '* /api/urgent/*', '* /api/review/*', '* /api/conversations/*', '* /api/contacts/*', 'POST /api/discounts/:id/approve',
  // The support report link, sign in and out, the password, and the locks themselves.
  '* /api/support/*', 'POST /api/setup', 'POST /api/login', 'POST /api/logout', 'POST /api/password', '* /api/locks', '* /api/locks/*',
  // The laptop's own routes, Shopify's webhooks and the tests' helpers (not owner routes either).
  '* /api/agent/*', '* /api/hooks/*', '* /api/test/*',
  // Checks that change nothing: the Test buttons, and a suggested reminder that is not saved.
  'POST /api/connections/brain/test', 'POST /api/connections/vision/test', 'POST /api/connections/shopify/test', 'POST /api/push/test', 'POST /api/recovery/teach',
];

/** Every change a box covers. Add a new owner route here when it changes something a box shows. */
export const LOCK_RULES: Readonly<Record<LockSectionId, readonly string[]>> = {
  voice: ['PUT /api/settings/voice'],
  brain: ['PUT /api/settings/brain', '* /api/connections/brain', '* /api/connections/brain/*'],
  vision: ['PUT /api/settings/vision', '* /api/connections/vision', '* /api/connections/vision/*'],
  shopify: ['PUT /api/settings/store', '* /api/connections/shopify', '* /api/connections/shopify/*'],
  alerts: ['PUT /api/settings/alerts', 'POST /api/push/subscribe', 'POST /api/push/unsubscribe'],
  channels: ['PUT /api/settings/channels'],
  gmail: ['PUT /api/settings/gmail'],
  pacing: ['PUT /api/settings/pacing'],
  laptops: ['* /api/devices', '* /api/devices/*'],
  recovery_message: ['PUT /api/recovery/template'],
  recovery_settings: ['PUT /api/settings/recovery'],
  discounts: ['PUT /api/settings/discounts'],
  sales: ['PUT /api/settings/sales', 'PUT /api/sales/settings'],
  knowledge: ['* /api/kb', '* /api/kb/*'],
};

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface Rule { method: string; parts: string[] }
const parseRule = (rule: string): Rule => {
  const [method, path] = rule.split(' ');
  return { method: method!, parts: path!.split('/').filter(Boolean) };
};
const NEVER = NEVER_LOCKED.map(parseRule);
const RULES = (Object.entries(LOCK_RULES) as [LockSectionId, readonly string[]][]).map(([id, list]) => ({ id, rules: list.map(parseRule) }));

function segments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
}

function matches(rule: Rule, method: string, segs: string[]): boolean {
  if (rule.method !== '*' && rule.method !== method) return false;
  const { parts } = rule;
  const rest = parts[parts.length - 1] === '*';
  if (rest ? segs.length < parts.length : segs.length !== parts.length) return false;
  for (let i = 0; i < parts.length; i++) {
    const want = parts[i]!;
    if (want === '*' && i === parts.length - 1) return true;
    if (want.startsWith(':')) continue;
    if (want !== segs[i]) return false;
  }
  return true;
}

/** The box a request would change, or null: reads, never lockable routes and anything no box shows. */
export function lockSectionFor(method: string, pathname: string): LockSectionId | null {
  const m = method.toUpperCase();
  if (!WRITES.has(m)) return null;
  const segs = segments(pathname);
  if (NEVER.some((r) => matches(r, m, segs))) return null;
  for (const { id, rules } of RULES) if (rules.some((r) => matches(r, m, segs))) return id;
  return null;
}

// ---- the lock state ----------------------------------------------------------------------------------

export const LOCKS_KEY = 'state:locks';
export const PIN_KEY = 'state:lock_pin';
export const FAILS_KEY = 'state:lock_fails';

export interface LockState { pin: boolean; sections: Partial<Record<LockSectionId, number>> }

/** A stored row read defensively: unknown sections and bad values are dropped. */
export function parseLockState(raw: unknown): LockState {
  const obj = typeof raw === 'object' && raw !== null ? (raw as { pin?: unknown; sections?: unknown }) : {};
  const sections: LockState['sections'] = {};
  if (typeof obj.sections === 'object' && obj.sections !== null) {
    for (const [k, v] of Object.entries(obj.sections as Record<string, unknown>)) {
      if (isLockSection(k) && typeof v === 'number' && v > 0) sections[k] = v;
    }
  }
  return { pin: obj.pin === true || obj.pin === 1, sections };
}

/** What is locked, from the settings read (cached, no extra query). */
export async function lockState(db: D1Database): Promise<LockState> {
  return parseLockState(await cachedState<unknown>(db, 'locks', null));
}

export const lockedIds = (s: LockState): LockSectionId[] => LOCK_SECTIONS.map((x) => x.id).filter((id) => Boolean(s.sections[id]));

/** The small form the dashboard gets on every owner answer (x-acx-locks) and in a 423. */
export const lockSummary = (s: LockState) => ({ pin: s.pin, locked: lockedIds(s) });

/** GET /api/locks and the lock routes' answers. */
export function lockView(s: LockState) {
  return {
    pin_set: s.pin,
    locked: lockedIds(s),
    sections: LOCK_SECTIONS.map((x) => ({ id: x.id, label: x.label, screen: x.screen, locked: Boolean(s.sections[x.id]), locked_at: s.sections[x.id] ?? null })),
  };
}

export const LOCKED_MESSAGE = 'This is locked. Unlock it with your PIN.';

/** The hook before every owner handler: refuses a change to a locked box with 423. */
export async function assertUnlocked(db: D1Database, method: string, pathname: string): Promise<void> {
  const section = lockSectionFor(method, pathname);
  if (!section) return;
  const s = await lockState(db);
  if (s.sections[section]) throw new HttpError(423, 'locked', LOCKED_MESSAGE, { section, locks: lockSummary(s) });
}

/**
 * An Urgent answer or note is never refused, but with "Remember this" it would also write to Knowledge. While
 * Knowledge is locked the reply still goes out and nothing is learned; `knowledge_locked` tells the owner why.
 */
export async function learnUnlessLocked(db: D1Database, want: boolean): Promise<{ learn: boolean; knowledge_locked: boolean }> {
  if (!want) return { learn: false, knowledge_locked: false };
  const locked = Boolean((await lockState(db)).sections.knowledge);
  return { learn: !locked, knowledge_locked: locked };
}

/** Every owner answer says what is locked, so a lock made on another device shows at the next refresh. */
export async function withLockHeader(db: D1Database, res: Response): Promise<Response> {
  let value: string;
  try { value = JSON.stringify(lockSummary(await lockState(db))); } catch { return res; }
  try {
    res.headers.set('x-acx-locks', value);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    copy.headers.set('x-acx-locks', value);
    return copy;
  }
}

/** Written with every lock change: other isolates drop their cached settings (and so the locks) on their next signed in request. */
const revBump = (db: D1Database, now: number) => stmt(db,
  `INSERT INTO settings (key, value, updated_at) VALUES ('state:settings_rev', ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(COALESCE(CAST(settings.value AS INTEGER), 0) + 1, CAST(excluded.value AS INTEGER)) AS TEXT), updated_at = excluded.updated_at`,
  JSON.stringify(now), now);

const VALID_LOCKS = `CASE WHEN json_valid(settings.value) THEN settings.value ELSE '{"pin":1,"sections":{}}' END`;

/** Lock or unlock one box (the PIN was checked). One batch: the row, the settings revision. */
export async function setLocked(db: D1Database, id: LockSectionId, locked: boolean, now: number): Promise<LockState> {
  const path = `$.sections.${id}`;
  const write = locked
    ? stmt(db, `INSERT INTO settings (key, value, updated_at) VALUES (?1, json_set('{"pin":1,"sections":{}}', ?2, ?3), ?3)
        ON CONFLICT(key) DO UPDATE SET value = json_set(${VALID_LOCKS}, '$.pin', 1, ?2, COALESCE(json_extract(${VALID_LOCKS}, ?2), ?3)), updated_at = ?3
        RETURNING value`, LOCKS_KEY, path, now)
    : stmt(db, `INSERT INTO settings (key, value, updated_at) VALUES (?1, '{"pin":1,"sections":{}}', ?3)
        ON CONFLICT(key) DO UPDATE SET value = json_remove(json_set(${VALID_LOCKS}, '$.pin', 1), ?2), updated_at = ?3
        RETURNING value`, LOCKS_KEY, path, now);
  const [res] = await db.batch<{ value: string }>([write, revBump(db, now)]);
  invalidateSettings();
  const value = res?.results?.[0]?.value;
  try { return parseLockState(value ? JSON.parse(value) : null); } catch { return { pin: true, sections: {} }; }
}

// ---- the PIN -----------------------------------------------------------------------------------------

export const PIN_RE = /^\d{4,8}$/;
export const MAX_PIN_FAILS = 5;
export const PIN_BLOCK_MS = 15 * MIN;
/**
 * PBKDF2 rounds for a new PIN hash. Changing the PIN checks the old one and hashes the new one in one request, and
 * the free plan allows about 10 ms of CPU: 40,000 rounds twice is over it. A PIN of 4 to 8 digits is guarded by the
 * 5 try limit, not by the rounds. A stored hash is always checked with its own count, so older hashes keep working.
 */
export const PIN_ITERATIONS = 10_000;

/** A PIN from a request: text of 4 to 8 digits, nothing else. */
export function pinValue(v: unknown, field = 'pin'): string {
  if (typeof v !== 'string' || !PIN_RE.test(v)) throw bad('invalid_pin', 'Use 4 to 8 numbers for the PIN.', { field });
  return v;
}

export const wrongPinMessage = (left: number) => `Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`;
export function blockedMessage(until: number, now: number): string {
  const mins = Math.max(1, Math.ceil((until - now) / MIN));
  return `Too many wrong PINs. Try again in ${mins} ${mins === 1 ? 'minute' : 'minutes'}.`;
}

export interface FailState { fails: number; until: number }
export function parseFails(raw: unknown): FailState {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return { fails: n(o.fails), until: n(o.until) };
}

/**
 * Every check takes a try first (atomic, so parallel guesses all count): a block that is still on is kept, a block
 * that ran out starts the count again at 1, otherwise the count goes up by one. A right PIN sets it back to 0.
 */
const CLAIM_SQL = `INSERT INTO settings (key, value, updated_at) VALUES (?1, '{"fails":1,"until":0}', ?2)
  ON CONFLICT(key) DO UPDATE SET value = CASE
    WHEN NOT json_valid(settings.value) THEN '{"fails":1,"until":0}'
    WHEN COALESCE(json_extract(settings.value, '$.until'), 0) > ?2 THEN settings.value
    WHEN COALESCE(json_extract(settings.value, '$.until'), 0) > 0 THEN '{"fails":1,"until":0}'
    ELSE json_object('fails', COALESCE(json_extract(settings.value, '$.fails'), 0) + 1, 'until', 0) END,
  updated_at = ?2
  RETURNING value`;

/** What the claimed try allows: blocked (a block is on), over (this try is past the limit: start a block), or check. */
export function claimOutcome(claim: FailState, now: number): 'blocked' | 'over' | 'check' {
  if (claim.until > now) return 'blocked';
  if (claim.fails > MAX_PIN_FAILS) return 'over';
  return 'check';
}

/** After a wrong PIN on try number `fails`: the error to answer, and a block to save on the last try. */
export function wrongOutcome(fails: number, now: number): { block_until: number | null; error: HttpError } {
  const left = MAX_PIN_FAILS - fails;
  if (left <= 0) {
    const until = now + PIN_BLOCK_MS;
    return { block_until: until, error: new HttpError(429, 'pin_blocked', blockedMessage(until, now), { retry_at: until }) };
  }
  return { block_until: null, error: new HttpError(403, 'wrong_pin', wrongPinMessage(left), { tries_left: left }) };
}

interface PinRecord { hash: string; salt: string; iterations: number; set_at: number }
const parsePin = (raw: string | undefined): PinRecord | null => {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<PinRecord>;
    return typeof p.hash === 'string' && typeof p.salt === 'string' && typeof p.iterations === 'number' ? (p as PinRecord) : null;
  } catch { return null; }
};

const setFails = (db: D1Database, f: FailState, now: number) =>
  stmt(db, 'UPDATE settings SET value = ?, updated_at = ? WHERE key = ?', JSON.stringify(f), now, FAILS_KEY).run();

/** Check the PIN, counted on the server. Throws 409 no_pin, 403 wrong_pin or 429 pin_blocked. */
export async function verifyPin(db: D1Database, pin: string, now: number): Promise<void> {
  const [claimRes, pinRes] = await db.batch<{ value: string }>([
    stmt(db, CLAIM_SQL, FAILS_KEY, now),
    stmt(db, 'SELECT value FROM settings WHERE key = ?', PIN_KEY),
  ]);
  let claim: FailState;
  try { claim = parseFails(JSON.parse(claimRes?.results?.[0]?.value ?? '{}')); } catch { claim = { fails: 1, until: 0 }; }
  const outcome = claimOutcome(claim, now);
  if (outcome === 'blocked') throw new HttpError(429, 'pin_blocked', blockedMessage(claim.until, now), { retry_at: claim.until });
  if (outcome === 'over') {
    // Guesses sent all at once: the ones past the limit are never checked, and they start the block.
    const until = now + PIN_BLOCK_MS;
    await setFails(db, { fails: 0, until }, now);
    throw new HttpError(429, 'pin_blocked', blockedMessage(until, now), { retry_at: until });
  }
  const rec = parsePin(pinRes?.results?.[0]?.value);
  if (!rec) {
    await setFails(db, { fails: 0, until: 0 }, now); // nothing was checked: not a wrong PIN
    throw new HttpError(409, 'no_pin', 'Set a PIN first.');
  }
  const attempt = await hashPassword(pin, rec.salt, rec.iterations);
  if (timingSafeEqual(attempt.hash, rec.hash)) {
    await setFails(db, { fails: 0, until: 0 }, now);
    return;
  }
  const wrong = wrongOutcome(claim.fails, now);
  if (wrong.block_until) await setFails(db, { fails: 0, until: wrong.block_until }, now);
  throw wrong.error;
}

/**
 * Set the PIN the first time (no old PIN), or change it (the old PIN is checked like any other). Only the hash is
 * kept. The lock row says a PIN is set, so the dashboard asks for it.
 */
export async function setPin(db: D1Database, pin: string, oldPin: string | null, now: number): Promise<{ state: LockState; changed: boolean }> {
  const existing = parsePin((await db.prepare('SELECT value FROM settings WHERE key = ?').bind(PIN_KEY).all<{ value: string }>()).results?.[0]?.value);
  const flag = stmt(db, `INSERT INTO settings (key, value, updated_at) VALUES (?1, '{"pin":1,"sections":{}}', ?2)
    ON CONFLICT(key) DO UPDATE SET value = json_set(${VALID_LOCKS}, '$.pin', 1), updated_at = ?2`, LOCKS_KEY, now);
  if (existing && !oldPin) {
    // The dashboard thought there was no PIN (the lock row was cleared by hand): put the flag back so it asks for it.
    await db.batch([flag, revBump(db, now)]);
    invalidateSettings();
    throw new HttpError(409, 'pin_exists', 'A PIN is already set. Enter it to change it.', { locks: lockSummary(await lockState(db)) });
  }
  if (existing) await verifyPin(db, oldPin!, now);
  const { hash, salt, iterations } = await hashPassword(pin, undefined, PIN_ITERATIONS);
  const record = JSON.stringify({ hash, salt, iterations, set_at: now });
  const write = existing
    ? stmt(db, 'UPDATE settings SET value = ?, updated_at = ? WHERE key = ?', record, now, PIN_KEY)
    // First time: two devices setting a PIN at the same moment cannot both win.
    : stmt(db, 'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING', PIN_KEY, record, now);
  const [res] = await db.batch([write, flag, revBump(db, now), stmt(db, 'DELETE FROM settings WHERE key = ?', FAILS_KEY)]);
  invalidateSettings();
  if (!existing && !res?.meta?.changes) throw new HttpError(409, 'pin_exists', 'A PIN is already set. Enter it to change it.', { locks: lockSummary(await lockState(db)) });
  return { state: await lockState(db), changed: Boolean(existing) };
}
