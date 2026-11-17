import type { Env, Settings } from '../types';
import { notifyOwner } from '../lib/push';
import { getState, setState } from '../lib/settings';
import { MIN } from '../lib/time';
import { emptyTarget, enqueue } from './outbox';

export interface OwnerAlert {
  kind: 'urgent' | 'review' | 'offline' | 'recovery' | 'error' | 'discount' | 'channel' | 'stuck' | 'ai' | 'usage';
  title: string;
  body: string;
  /** Dashboard path, for example /#/urgent */
  path: string;
}

const THROTTLE_MS: Record<OwnerAlert['kind'], number> = {
  urgent: 0,
  review: 10 * MIN,
  offline: 60 * MIN,
  recovery: 0,
  error: 30 * MIN,
  discount: 0,
  // The monitor (src/pipeline/monitor.ts) already sends one per problem; these stop a flapping page spamming.
  channel: 5 * MIN,
  stuck: 30 * MIN,
  ai: 60 * MIN,
  usage: 0,
};

/**
 * Tell the owner something needs them: a push notification to their phone and, when they gave a
 * second number, a WhatsApp ping sent by the laptop. Best effort, never throws.
 * Resolves false when the alert was held back by the throttle for its kind.
 */
export async function alertOwner(env: Env, settings: Settings, alert: OwnerAlert): Promise<boolean> {
  try {
    const db = env.DB;
    const now = Date.now();
    const gap = THROTTLE_MS[alert.kind];
    if (gap) {
      const last = await getState<number>(db, `alert_last:${alert.kind}`, 0);
      if (now - last < gap) return false;
      await setState(db, `alert_last:${alert.kind}`, now);
    }
    if (settings.alerts.push) {
      await notifyOwner(env, { title: alert.title, body: alert.body, url: alert.path, tag: alert.kind });
    }
    const number = settings.alerts.whatsapp_number.trim();
    if (number && alert.kind === 'urgent') {
      // One WhatsApp ping per ten minutes at most, however many questions arrive.
      const lastWa = await getState<number>(db, 'alert_last:whatsapp', 0);
      if (now - lastWa >= 10 * MIN) {
        await setState(db, 'alert_last:whatsapp', now);
        await enqueue(db, {
          channel: 'whatsapp', kind: 'new_chat', source: 'alert',
          target: emptyTarget({ phone: number, title: 'Owner alert' }),
          parts: [`${alert.title}\n${alert.body}`],
          expires_at: now + 30 * MIN,
          pacing: { delay_ms: 0, typing_cps: 40 },
        });
      }
    }
  } catch (err) {
    console.error('alertOwner failed', err);
  }
  return true;
}
