import type { Channel } from '../types';
import { clip, run } from './db';

export type EventLevel = 'info' | 'good' | 'warn' | 'error';

export interface EventInput {
  level?: EventLevel;
  type: string;
  channel?: Channel | null;
  conversation_id?: string | null;
  message: string;
  data?: Record<string, unknown>;
}

/** Append to the activity feed shown on the dashboard. Never throws: logging must not break a request. */
export async function logEvent(db: D1Database, e: EventInput): Promise<void> {
  try {
    await run(
      db,
      'INSERT INTO events (ts, level, type, channel, conversation_id, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      Date.now(), e.level ?? 'info', e.type, e.channel ?? null, e.conversation_id ?? null,
      clip(e.message, 400), JSON.stringify(e.data ?? {}),
    );
  } catch (err) {
    console.error('logEvent failed', err);
  }
}
