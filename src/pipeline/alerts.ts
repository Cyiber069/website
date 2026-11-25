import type { Env, Settings } from '../types';
import { run } from '../lib/db';
import { notifyOwner } from '../lib/push';
import { MIN } from '../lib/time';
import { emptyTarget, enqueue } from './outbox';

export interface OwnerAlert {
  kind: 'urgent' | 'review' | 'offline' | 'recovery' | 'error' | 'discount' | 'channel' | 'stuck' | 'ai' | 'usage' | 'waiting' | 'claude' | 'failover';
  title: string;
  body: string;
  /** Dashboard path, for example /#/urgent */
  path: string;
  /** The alert is about WhatsApp itself not working, so a WhatsApp ping could not be sent: push only. */
  whatsapp_down?: boolean;
}

/** Alerts that also go to the owner's own WhatsApp number: questions for them, and anything that stops customers being answered. */
const PING_KINDS = new Set<OwnerAlert['kind']>(['urgent', 'channel', 'stuck', 'ai', 'claude', 'offline']);

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
  // Claude out of credit or its key refused (src/brain/allowance.ts): already once per outage, this stops a flapping key.
  claude: 60 * MIN,
  // Another laptop took over a channel (src/pipeline/leader.ts). A laptop going on and off sends one an hour at most.
  failover: 60 * MIN,
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
    if (number && PING_KINDS.has(alert.kind) && !alert.whatsapp_down) {
      // One WhatsApp ping per ten minutes at most for questions, however many arrive. A problem that stops
      // customers being answered has its own slot, so it is never held back by a question just before it.
      const urgent = alert.kind === 'urgent';
      if (await claimSlot(db, urgent ? 'alert_last:whatsapp' : 'alert_last:whatsapp_problem', now, urgent ? 10 * MIN : 5 * MIN)) {
        await enqueue(db, {
          channel: 'whatsapp', kind: 'new_chat', source: 'alert',
          target: emptyTarget({ phone: number, title: 'Owner alert' }),
          parts: [`${alert.title}\n${alert.body}`],
          // A problem ping that cannot go out soon is dropped: told late, it would say something that is no longer true.
          expires_at: now + (urgent ? 30 : 10) * MIN,
          pacing: { delay_ms: 0, typing_cps: 40 },
        });
      }
    }
  } catch (err) {
    console.error('alertOwner failed', err);
  }
  return true;
}
