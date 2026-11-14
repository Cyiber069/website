import { runCron } from './cron';
import { assertSameOrigin, deviceFromRequest, hasOwnerSession } from './lib/auth';
import { HttpError, json, readJson, type Ctx } from './lib/http';
import { ensureSchema } from './lib/schema';
import { buildRouter } from './routes';
import type { Env } from './types';

const router = buildRouter();

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
  } else {
    assertSameOrigin(req);
  }
  return route.handler(c);
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    let res: Response;
    try {
      await ensureSchema(env.DB);
      res = await handleApi(req, env, exec, url);
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
    return new Response(res.body, { status: res.status, headers });
  },

  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    exec.waitUntil(ensureSchema(env.DB).then(() => runCron(env)));
  },
} satisfies ExportedHandler<Env>;
