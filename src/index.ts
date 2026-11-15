import { runCron } from './cron';
import { assertSameOrigin, deviceFromRequest, hasOwnerSession } from './lib/auth';
import { HttpError, json, readJson, type Ctx } from './lib/http';
import { ensureSchema } from './lib/schema';
import { buildRouter } from './routes';
import type { Env } from './types';

const router = buildRouter();

/**
 * Test mode only: a D1 binding that counts the queries one request makes, reported in the
 * x-acx-d1-queries header so tests can hold request paths under the free plan's 50 queries.
 * A batch is one round trip and counts once.
 */
function countingDb(db: D1Database, counter: { n: number }): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (st: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(st, {
      get(target, key) {
        if (key === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === 'first' || key === 'all' || key === 'run' || key === 'raw') {
          return (...args: unknown[]) => { counter.n++; return (target[key] as (...a: unknown[]) => unknown).apply(target, args); };
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
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (key === 'batch') return (list: D1PreparedStatement[]) => { counter.n++; return target.batch(list.map((s) => real.get(s) ?? s)); };
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
    const queries = { n: 0 };
    try {
      await ensureSchema(env.DB);
      const e = env.ACX_TEST_MODE === '1' ? { ...env, DB: countingDb(env.DB, queries) } : env;
      res = await handleApi(req, e, exec, url);
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
      // A streamed answer is still working when the headers go: its count is the stream's last line.
      if (res.body && (res.headers.get('content-type') ?? '').includes('ndjson')) {
        const tail = new TransformStream<Uint8Array, Uint8Array>({
          flush(ctl) { ctl.enqueue(new TextEncoder().encode(JSON.stringify({ type: 'queries', n: queries.n }) + '\n')); },
        });
        return new Response(res.body.pipeThrough(tail), { status: res.status, headers });
      }
    }
    return new Response(res.body, { status: res.status, headers });
  },

  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    exec.waitUntil(ensureSchema(env.DB).then(() => runCron(env)));
  },
} satisfies ExportedHandler<Env>;
