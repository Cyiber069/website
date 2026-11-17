// The daily database budget guard. Cloudflare's free plan stops every D1 query for the rest of the UTC
// day once 5 million rows are read or 100,000 written. The Worker's own estimate (src/lib/usage.ts) says
// how much of that is used, and the agent slows down what can wait so customer replies keep going:
//   normal    below 70%: everything as usual.
//   high      from 70%: the laptop syncs every 60 s, the dashboard refreshes every 2 min, background
//             cron work (sales follow ups, store sync, cleanup, health checks, old videos) runs every
//             5th minute, and the owner is told once.
//   critical  from 90%: only customer replies and sends keep running.
// The count starts again at 00:00 UTC, and so does the level.
import { cachedState } from './settings';
import { usageToday, type D1Usage } from './usage';

export type BudgetLevel = 'normal' | 'high' | 'critical';

export const HIGH_PCT = 70;
export const CRITICAL_PCT = 90;
/** How often the laptop syncs (seconds), by level. The extension accepts 8 to 60. */
export const SYNC_SECONDS: Record<BudgetLevel, number> = { normal: 20, high: 60, critical: 60 };
/** How often an open dashboard refreshes at most (seconds), by level. */
export const DASHBOARD_SECONDS: Record<BudgetLevel, number> = { normal: 30, high: 120, critical: 120 };
/** Background cron work runs only in minutes divisible by this when the level is high. */
export const SLOW_CRON_EVERY_MIN = 5;

export interface Budget {
  level: BudgetLevel;
  /** The larger of the read and the write share used today, in percent (an estimate). */
  pct: number;
  read_pct: number;
  write_pct: number;
}

export function levelFor(pct: number): BudgetLevel {
  return pct >= CRITICAL_PCT ? 'critical' : pct >= HIGH_PCT ? 'high' : 'normal';
}

export function budgetFrom(stored: D1Usage | null, now = Date.now()): Budget {
  const u = usageToday(stored, now);
  const pct = Math.max(u.read_pct, u.write_pct);
  return { level: levelFor(pct), pct, read_pct: u.read_pct, write_pct: u.write_pct };
}

/**
 * Today's level. The stored count comes with the settings read (same query, cached about 30 s), so
 * asking costs no extra D1 query; this isolate's own uncounted rows are added on top.
 */
export async function budget(db: D1Database, now = Date.now()): Promise<Budget> {
  return budgetFrom(await cachedState<D1Usage | null>(db, 'd1_usage', null), now);
}
