// Runs every minute (see wrangler.jsonc). Each task is independent: one failing never blocks the rest.
import type { Env } from './types';
import { all, run } from './lib/db';
import { logEvent } from './lib/events';
import { getSettings, getState, setState } from './lib/settings';
import { DAY, MIN } from './lib/time';
import { alertOwner } from './pipeline/alerts';
import { sweepConversations } from './pipeline/inbound';
import { sweepOutbox } from './pipeline/outbox';
import { syncStore } from './kb';
import { recoveryTick } from './recovery';
import { ONLINE_WINDOW_MS } from './routes/agent';

async function safely(name: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (err) { console.error(`cron task ${name} failed`, err); }
}

async function watchDevice(env: Env): Promise<void> {
  const db = env.DB;
  const settings = await getSettings(db);
  if (!settings.agent.enabled) return;
  const now = Date.now();
  const devices = await all<{ name: string; last_seen_at: number | null }>(db, 'SELECT name, last_seen_at FROM devices WHERE revoked_at IS NULL ORDER BY COALESCE(last_seen_at, 0) DESC LIMIT 1');
  const d = devices[0];
  if (!d?.last_seen_at) return;
  const silentFor = now - d.last_seen_at;
  if (silentFor < Math.max(ONLINE_WINDOW_MS, settings.alerts.offline_minutes * MIN)) return;
  if (await getState<boolean>(db, 'offline_alerted', false)) return;
  await setState(db, 'offline_alerted', true);
  await logEvent(db, { level: 'error', type: 'device_offline', message: `${d.name} has gone quiet. Nothing can be sent until Chrome is open on it again.` });
  await alertOwner(env, settings, { kind: 'offline', title: 'Your laptop agent is offline', body: `${d.name} stopped checking in. Customers are not being answered.`, path: '/#/health' });
}

async function cleanup(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  const last = await getState<number>(db, 'cleanup_at', 0);
  if (now - last < DAY) return;
  await setState(db, 'cleanup_at', now);
  await run(db, 'DELETE FROM events WHERE ts < ?', now - 45 * DAY);
  await run(db, 'DELETE FROM diagnostics WHERE ts < ?', now - 14 * DAY);
  await run(db, 'DELETE FROM llm_usage WHERE ts < ?', now - 90 * DAY);
  await run(db, 'DELETE FROM sessions WHERE expires_at < ?', now);
  await run(db, 'DELETE FROM pairing_codes WHERE expires_at < ?', now);
  await run(db, `DELETE FROM outbox WHERE status IN ('sent', 'failed', 'cancelled', 'expired') AND created_at < ?`, now - 60 * DAY);
}

/** Refresh product and policy knowledge from the public store once a day. */
async function dailyStoreSync(env: Env): Promise<void> {
  const settings = await getSettings(env.DB);
  if (!settings.store.sync_public || env.ACX_TEST_MODE === '1') return;
  const now = Date.now();
  if (now - (await getState<number>(env.DB, 'store_sync_at', 0)) < DAY) return;
  await setState(env.DB, 'store_sync_at', now);
  await syncStore(env);
}

export async function runCron(env: Env): Promise<void> {
  await safely('outbox', () => sweepOutbox(env.DB));
  await safely('conversations', () => sweepConversations(env));
  await safely('recovery', () => recoveryTick(env));
  await safely('device', () => watchDevice(env));
  await safely('store-sync', () => dailyStoreSync(env));
  await safely('cleanup', () => cleanup(env));
}
