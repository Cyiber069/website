// Test-only helpers. Every handler refuses to run unless ACX_TEST_MODE=1, which is set only in
// wrangler.test.jsonc (local development and automated tests). Never set it in production.
import { HttpError, json, type Ctx, type Router } from '../lib/http';
import { runCron } from '../cron';
import { flushUsage } from '../lib/usage';
import { setState } from '../lib/settings';

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

  // Point the Gemini client at a fake Google run by the tests (src/vision visionBase reads it in test mode only).
  r.post('/api/test/vision-base', 'public', async (c) => {
    guard(c);
    const body = await c.body<{ url?: unknown }>();
    await setState(c.db, 'test_gemini_base', typeof body.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+$/.test(body.url) ? body.url : null);
    return json({ ok: true });
  });

  r.post('/api/test/cron', 'public', async (c) => {
    guard(c);
    await runCron(c.env);
    await flushUsage(c.env.DB, true); // tests read the usage meter right after
    return json({ ok: true });
  });
}
