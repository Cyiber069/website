// Web Push to the owner's phone. Implemented later in this file; callers only use notifyOwner.
import type { Env } from '../types';

export interface OwnerNotification {
  title: string;
  body: string;
  /** Path inside the dashboard to open, for example /#/urgent */
  url: string;
  /** Notifications with the same tag replace each other. */
  tag: string;
}

/** Best effort: resolves to the number of devices reached and never throws. */
export async function notifyOwner(_env: Env, _n: OwnerNotification): Promise<number> {
  return 0;
}
