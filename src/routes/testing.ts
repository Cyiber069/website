// Test-only helpers. Every handler refuses to run unless ACX_TEST_MODE=1, which is set only in
// wrangler.test.jsonc (local development and automated tests). Never set it in production.
import { HttpError, json, type Ctx, type Router } from '../lib/http';
import { runCron } from '../cron';

function guard(c: Ctx): void {
  if (c.env.ACX_TEST_MODE !== '1') throw new HttpError(404, 'not_found', 'No such endpoint');
}

export function register(r: Router): void {
  r.post('/api/test/sql', 'public', async (c) => {
    guard(c);
    const body = await c.body<{ sql?: unknown; params?: unknown }>();
    if (typeof body.sql !== 'string') throw new HttpError(400, 'missing_field');
    const params = Array.isArray(body.params) ? body.params : [];
    const res = await c.db.prepare(body.sql).bind(...params).all();
    return json({ results: res.results ?? [], changes: res.meta?.changes ?? 0 });
  });

  r.post('/api/test/cron', 'public', async (c) => {
    guard(c);
    await runCron(c.env);
    return json({ ok: true });
  });
}
