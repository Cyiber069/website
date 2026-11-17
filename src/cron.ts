// Runs every minute (see wrangler.jsonc). Each task is independent: one failing never blocks the rest.
import type { Env } from './types';
import { stmt } from './lib/db';
import { MEDIA_KEEP_DAYS } from './lib/media';
import { VISION_FILES_KEEP_MS, tidyVisionFiles } from './vision';
import { getSettings, getState, setState } from './lib/settings';
import { DAY } from './lib/time';
import { watchHealth } from './pipeline/monitor';
import { sweepConversations } from './pipeline/inbound';
import { sweepOutbox } from './pipeline/outbox';
import { syncStore } from './kb';
import { recoveryTick } from './recovery';
import { salesTick } from './sales';

async function safely(name: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (err) { console.error(`cron task ${name} failed`, err); }
}

async function cleanup(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  const last = await getState<number>(db, 'cleanup_at', 0);
  if (now - last < DAY) return;
  // One batch, with the day marked last: if it fails nothing is marked and the next minute tries again.
  await db.batch([
    stmt(db, 'DELETE FROM events WHERE ts < ?', now - 45 * DAY),
    stmt(db, 'DELETE FROM diagnostics WHERE ts < ?', now - 14 * DAY),
    // Customer photos are only needed while the chat is live.
    stmt(db, 'DELETE FROM media WHERE created_at < ?', now - MEDIA_KEEP_DAYS * DAY),
    // Where Google held a video (it deletes its copy after 48 hours). The day's count is the video cap.
    stmt(db, 'DELETE FROM vision_files WHERE created_at < ?', now - VISION_FILES_KEEP_MS),
    stmt(db, 'DELETE FROM llm_usage WHERE ts < ?', now - 90 * DAY),
    stmt(db, 'DELETE FROM sessions WHERE expires_at < ?', now),
    stmt(db, 'DELETE FROM pairing_codes WHERE expires_at < ?', now),
    stmt(db, `DELETE FROM outbox WHERE status IN ('sent', 'failed', 'cancelled', 'expired') AND created_at < ?`, now - 60 * DAY),
    stmt(db, `INSERT INTO settings (key, value, updated_at) VALUES ('state:cleanup_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, JSON.stringify(now), now),
  ]);
}

/** Refresh product and policy knowledge from the public store once a day. */
async function dailyStoreSync(env: Env): Promise<boolean> {
  const settings = await getSettings(env.DB);
  if (!settings.store.sync_public || env.ACX_TEST_MODE === '1') return false;
  const now = Date.now();
  if (now - (await getState<number>(env.DB, 'store_sync_at', 0)) < DAY) return false;
  await setState(env.DB, 'store_sync_at', now);
  await syncStore(env);
  return true;
}

export async function runCron(env: Env): Promise<void> {
  await safely('outbox', () => sweepOutbox(env.DB));
  // One cron run may make 50 D1 queries and fetches on the free plan. A brain call for a chat takes
  // about 20, so the sweeper answers one chat a minute, and none in the minute a daily job runs.
  let busy = false;
  await safely('recovery', async () => { busy = await recoveryTick(env); });
  if (!busy) await safely('store-sync', async () => { busy = await dailyStoreSync(env); });
  if (!busy) await safely('conversations', async () => { busy = (await sweepConversations(env, 1)) > 0; });
  // One follow up for warm leads, and the daily cleanup. Skipped in a minute the sweeper answered a
  // chat (that alone can be about 40 queries) or a recovery run or store sync started.
  if (!busy) await safely('sales', () => salesTick(env));
  // Customer videos Google still holds that nothing described: deleted a few at a time (a few fetches).
  if (!busy) await safely('vision-files', () => tidyVisionFiles(env));
  await safely('health', () => watchHealth(env));
  if (!busy) await safely('cleanup', () => cleanup(env));
}
