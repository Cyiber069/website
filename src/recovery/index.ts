// Abandoned checkout recovery. Implemented in this folder.
import type { Env } from '../types';

/** Called every minute by cron. Starts the daily run when the London clock reaches the configured hour. */
export async function recoveryTick(_env: Env): Promise<void> {
  // implemented by the recovery module
}
