// Owner facing API for the Sales screen: the funnel, hot leads, follow up counts and the sales settings.
import { HttpError, bad, json, type Router } from '../lib/http';
import { patchSettings } from '../lib/settings';
import { checkSalesPatch, salesOverview, salesSettings, salesTick } from '../sales';

export function register(r: Router): void {
  r.get('/api/sales', 'owner', async (c) => json(await salesOverview(c.env, c.now)));

  r.put('/api/sales/settings', 'owner', async (c) => {
    const body = await c.body<Record<string, unknown>>(4_000);
    let patch;
    try { patch = checkSalesPatch(body); } catch (err) { throw bad('invalid_field', (err as Error).message); }
    const next = await patchSettings(c.db, 'sales', patch);
    return json({ ok: true, settings: salesSettings({ sales: next }) });
  });

  // Test only: run the follow up job now, optionally at a given time. Refused unless ACX_TEST_MODE=1.
  r.post('/api/test/sales-tick', 'public', async (c) => {
    if (c.env.ACX_TEST_MODE !== '1') throw new HttpError(404, 'not_found', 'No such endpoint');
    const body = await c.body<{ now?: unknown }>();
    const now = typeof body.now === 'number' && Number.isFinite(body.now) ? body.now : Date.now();
    return json(await salesTick(c.env, now));
  });
}
