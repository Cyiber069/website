// A rough count of the D1 rows this Worker reads and writes each UTC day, for the Health screen.
// Cloudflare's free plan allows 5 million rows read and 100,000 rows written a day.
//
// How it counts: env.DB is wrapped so every all(), run() and batch() adds its meta.rows_read and
// meta.rows_written to a counter in this isolate. first() hides meta, so reads made with first()
// are NOT counted (the one() helper in db.ts uses all() so most single row reads still are).
// The counter is flushed into the settings row state:d1_usage at most once every 5 minutes per
// isolate, as one atomic UPDATE, so several isolates add up instead of overwriting each other.
// Counts held by an isolate that Cloudflare stops before it flushes are lost: it is an estimate.
import { getState } from './settings';

export const READ_LIMIT = 5_000_000;
export const WRITE_LIMIT = 100_000;
const FLUSH_MS = 5 * 60_000;

export interface D1Usage { day: string; read: number; written: number; updated_at: number }

const pending = { day: '', read: 0, written: 0 };
let lastFlush = 0;

export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

function add(meta: { rows_read?: number; rows_written?: number } | undefined, now = Date.now()): void {
  if (!meta) return;
  const day = utcDay(now);
  if (pending.day !== day) { pending.day = day; pending.read = 0; pending.written = 0; }
  pending.read += Number(meta.rows_read) || 0;
  pending.written += Number(meta.rows_written) || 0;
}

const wrote = (meta: { rows_written?: number; changes?: number } | undefined) => Boolean(meta && ((Number(meta.rows_written) || 0) > 0 || (Number(meta.changes) || 0) > 0));

/**
 * env.DB with a light counter on it. No logging, almost no cost. `onWrite` runs after every statement
 * that wrote a row: the dashboard answers cached in this isolate (src/lib/cache.ts) are then out of date.
 */
export function meteredDb(db: D1Database, onWrite?: () => void): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (st: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(st, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === 'all' || key === 'run') {
          return async (...args: unknown[]) => {
            const out = await (target[key] as (...a: unknown[]) => Promise<D1Result>).apply(target, args);
            add(out?.meta);
            if (onWrite && wrote(out?.meta)) onWrite();
            return out;
          };
        }
        // first() and raw() do not return meta: not counted.
        const v = Reflect.get(target, key, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    real.set(proxy, st);
    return proxy;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (key === 'batch') return async (list: D1PreparedStatement[]) => {
        const rs = await target.batch(list.map((s) => real.get(s) ?? s));
        for (const r of rs) add(r?.meta);
        if (onWrite && rs.some((r) => wrote(r?.meta))) onWrite();
        return rs;
      };
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/**
 * Add this isolate's counts to the stored total. Skips unless 5 minutes passed since the last
 * flush (force skips the wait). Pass the raw, unwrapped binding. Never throws.
 */
export async function flushUsage(db: D1Database, force = false, now = Date.now()): Promise<void> {
  if (!pending.read && !pending.written) return;
  if (!force && now - lastFlush < FLUSH_MS) return;
  if (pending.day !== utcDay(now)) { pending.read = 0; pending.written = 0; pending.day = utcDay(now); return; }
  lastFlush = now;
  const { day, read, written } = pending;
  pending.read = 0; pending.written = 0;
  try {
    // The flush itself is one row read and one written. A new UTC day starts again from zero.
    await db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('state:d1_usage', json_object('day', ?1, 'read', ?2, 'written', ?3, 'updated_at', ?4), ?4)
       ON CONFLICT(key) DO UPDATE SET updated_at = ?4, value = CASE WHEN json_extract(settings.value, '$.day') = ?1
         THEN json_object('day', ?1, 'read', json_extract(settings.value, '$.read') + ?2, 'written', json_extract(settings.value, '$.written') + ?3, 'updated_at', ?4)
         ELSE excluded.value END`,
    ).bind(day, read, written, now).run();
  } catch (err) {
    pending.read += read; pending.written += written; // try again next time
    console.error('usage flush failed', err);
  }
}

/** Today's estimate: the stored total plus what this isolate has not flushed yet. */
export function usageToday(stored: D1Usage | null, now = Date.now()) {
  const day = utcDay(now);
  const base = stored && stored.day === day ? stored : { day, read: 0, written: 0, updated_at: 0 };
  const extra = pending.day === day ? pending : { read: 0, written: 0 };
  const read = base.read + extra.read, written = base.written + extra.written;
  return {
    day, rows_read: read, rows_written: written, read_limit: READ_LIMIT, write_limit: WRITE_LIMIT,
    read_pct: Math.round((read / READ_LIMIT) * 1000) / 10, write_pct: Math.round((written / WRITE_LIMIT) * 1000) / 10,
    updated_at: base.updated_at, estimate: true,
  };
}

export const getUsage = (db: D1Database) => getState<D1Usage | null>(db, 'd1_usage', null);
