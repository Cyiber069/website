import { runCron } from './cron';
import { assertSameOrigin, deviceFromRequest, hasOwnerSession } from './lib/auth';
import { HttpError, json, readJson, type Ctx } from './lib/http';
import { ensureSchema } from './lib/schema';
import { buildRouter } from './routes';
import type { Env } from './types';
import { flushUsage, meteredDb } from './lib/usage';

const router = buildRouter();

/**
 * Test mode only: a D1 binding that counts the queries one request makes, reported in the
 * x-acx-d1-queries header so tests can hold request paths under the free plan's 50 queries.
 * A batch is one round trip and counts once.
 */
function countingDb(db: D1Database, counter: { n: number; rows: number; written: number }): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const note = (sql: string, rows: number, written = 0) => {
    counter.rows += rows;
    counter.written += written;
    // Show the queries that read a lot, so the free plan's daily rows cap can be protected.
    if (rows > 150) console.log(`HEAVY_QUERY ${rows} ${sql.replace(/\s+/g, ' ').slice(0, 180)}`);
  };
  const wrap = (st: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(st, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (key === 'first') {
          // first() hides rows_read, so run all() and hand back its first row.
          return async (col?: string) => {
            counter.n++;
            const r = await target.all<Record<string, unknown>>();
            note(sql, r.meta?.rows_read ?? 0);
            const row = r.results?.[0] ?? null;
            return col ? (row ? row[col] : null) : row;
          };
        }
        if (key === 'all' || key === 'run' || key === 'raw') {
          return (...args: unknown[]) => {
            counter.n++;
            const out = (target[key] as (...a: unknown[]) => unknown).apply(target, args);
            if (out instanceof Promise) out.then((r) => { const m = (r as { meta?: { rows_read?: number; rows_written?: number } })?.meta; note(sql, m?.rows_read ?? 0, m?.rows_written ?? 0); }).catch(() => {});
            return out;
          };
        }
        const v = Reflect.get(target, key, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    real.set(proxy, st);
    return proxy;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === 'batch') return (list: D1PreparedStatement[]) => {
        counter.n++;
        const p = target.batch(list.map((s) => real.get(s) ?? s));
        p.then((rs) => { for (const r of rs) note('batch', r.meta?.rows_read ?? 0, r.meta?.rows_written ?? 0); }).catch(() => {});
        return p;
      };
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

async function handleApi(req: Request, env: Env, exec: ExecutionContext, url: URL): Promise<Response> {
  const found = router.match(req.method, url.pathname);
  if (found === null) throw new HttpError(404, 'not_found', 'No such endpoint');
  if (found === 'method') throw new HttpError(405, 'method_not_allowed');
  const { route, params } = found;

  const c: Ctx = {
    req, env, exec, db: env.DB, url, params, now: Date.now(), device: null,
    body: (maxBytes?: number) => readJson(req, maxBytes),
  };
  if (route.auth === 'owner') {
    assertSameOrigin(req);
    if (!(await hasOwnerSession(env, req))) throw new HttpError(401, 'signed_out', 'Sign in again');
  } else if (route.auth === 'device') {
    c.device = await deviceFromRequest(env, req);
    if (!c.device) throw new HttpError(401, 'bad_device_token', 'This laptop is not paired any more');
  } else if (!url.pathname.startsWith('/api/agent/') && !url.pathname.startsWith('/api/hooks/')) {
    // Public browser routes (sign in, first run). The extension and Shopify call from other origins.
    assertSameOrigin(req);
  }
  return route.handler(c);
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    let res: Response;
    const queries = { n: 0, rows: 0, written: 0 };
    const counters = { fetches: 0, videos: 0 };
    try {
      await ensureSchema(env.DB);
      // Every request counts the D1 rows it uses for the Health screen's estimate (src/lib/usage.ts).
      const metered = meteredDb(env.DB);
      const e: Env = { ...env, DB: env.ACX_TEST_MODE === '1' ? countingDb(metered, queries) : metered, counters, waitUntil: (p) => exec.waitUntil(p.catch(() => undefined)) };
      res = await handleApi(req, e, exec, url);
      exec.waitUntil(flushUsage(env.DB));
    } catch (err) {
      if (err instanceof HttpError) {
        res = json({ error: err.code, message: err.message, ...err.extra }, err.status);
      } else {
        console.error('unhandled', req.method, url.pathname, err);
        res = json({ error: 'internal', message: 'Something went wrong on our side' }, 500);
      }
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    if (env.ACX_TEST_MODE === '1') {
      headers.set('x-acx-d1-queries', String(queries.n));
      headers.set('x-acx-d1-rows', String(queries.rows));
      headers.set('x-acx-d1-rows-written', String(queries.written));
      headers.set('x-acx-fetches', String(counters.fetches));
      // A streamed answer is still working when the headers go: its count is the stream's last line.
      if (res.body && (res.headers.get('content-type') ?? '').includes('ndjson')) {
        const tail = new TransformStream<Uint8Array, Uint8Array>({
          flush(ctl) { ctl.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'queries', n: queries.n, rows: queries.rows, written: queries.written, fetches: counters.fetches }) + '\n')); },
        });
        return new Response(res.body.pipeThrough(tail), { status: res.status, headers });
      }
    }
    return new Response(res.body, { status: res.status, headers });
  },

  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    const e: Env = { ...env, DB: meteredDb(env.DB), counters: { fetches: 0, videos: 0 }, waitUntil: (p) => exec.waitUntil(p.catch(() => undefined)) };
    exec.waitUntil(ensureSchema(env.DB).then(() => runCron(e)).finally(() => flushUsage(env.DB)));
  },
} satisfies ExportedHandler<Env>;
