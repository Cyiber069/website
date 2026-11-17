import type { Env, Settings } from '../types';
import { run } from '../lib/db';
import { notifyOwner } from '../lib/push';
import { MIN } from '../lib/time';
import { emptyTarget, enqueue } from './outbox';

export interface OwnerAlert {
  kind: 'urgent' | 'review' | 'offline' | 'recovery' | 'error' | 'discount' | 'channel' | 'stuck' | 'ai' | 'usage' | 'waiting';
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
  // A reply held up by a draft or by the owner typing in the agent's tab (src/pipeline/outbox.ts).
  waiting: 10 * MIN,
};

/**
 * Take the throttle slot `key` when the last one is at least `gap` old. One query (the free plan
 * allows 50 per request): the write only happens when the slot is free, and it says whether it did.
 */
async function claimSlot(db: D1Database, key: string, now: number, gap: number): Promise<boolean> {
  const changed = await run(
    db,
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE CAST(settings.value AS INTEGER) <= ?`,
    `state:${key}`, JSON.stringify(now), now, now - gap,
  );
  return changed > 0;
}

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
    if (gap && !(await claimSlot(db, `alert_last:${alert.kind}`, now, gap))) return false;
    if (settings.alerts.push) {
      await notifyOwner(env, { title: alert.title, body: alert.body, url: alert.path, tag: alert.kind });
    }
    const number = settings.alerts.whatsapp_number.trim();
    if (number && alert.kind === 'urgent') {
      // One WhatsApp ping per ten minutes at most, however many questions arrive.
      if (await claimSlot(db, 'alert_last:whatsapp', now, 10 * MIN)) {
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
