// How fast the agent answers: for each agent reply sent, the time from the newest customer message it
// answers (outbox.reply_to_ts: the page time, else when it was first seen) to when the laptop said it
// was sent. Shown on Live and Health as "Average reply time today" with the slowest one, so the owner
// can see the agent working. Only the agent's own replies count (auto, holding line, code message):
// drafts the owner approved, answers the owner wrote and follow ups wait on purpose.
import type { Channel, JobTarget } from '../types';
import { CHANNELS } from '../types';
import { all, parseJson } from '../lib/db';

export interface ReplyTimes {
  count: number;
  avg_ms: number | null;
  max_ms: number | null;
  slowest: { conversation_id: string | null; channel: Channel; customer: string; sent_at: number; ms: number } | null;
  by_channel: Partial<Record<Channel, { count: number; avg_ms: number }>>;
}

export const EMPTY_REPLY_TIMES: ReplyTimes = { count: 0, avg_ms: null, max_ms: null, slowest: null, by_channel: {} };

/** Reply times of agent replies sent since `since`. One query on the outbox_status_sent index. */
export async function replyTimes(db: D1Database, since: number): Promise<ReplyTimes> {
  const rows = await all<{ channel: Channel; conversation_id: string | null; sent_at: number; reply_to_ts: number; target: string }>(
    db,
    `SELECT channel, conversation_id, sent_at, reply_to_ts, target FROM outbox
     WHERE status = 'sent' AND sent_at >= ? AND reply_to_ts IS NOT NULL AND source IN ('auto', 'holding', 'discount')
     ORDER BY sent_at DESC LIMIT 1000`,
    since,
  );
  return summarise(rows);
}

/** Exported for tests. */
export function summarise(rows: { channel: Channel; conversation_id: string | null; sent_at: number; reply_to_ts: number; target: string }[]): ReplyTimes {
  if (!rows.length) return { ...EMPTY_REPLY_TIMES, by_channel: {} };
  let total = 0;
  let worst = rows[0]!;
  let worstMs = -1;
  const per: Partial<Record<Channel, { count: number; total: number }>> = {};
  for (const r of rows) {
    const ms = Math.max(0, r.sent_at - r.reply_to_ts);
    total += ms;
    if (ms > worstMs) { worstMs = ms; worst = r; }
    const c = (per[r.channel] ??= { count: 0, total: 0 });
    c.count++;
    c.total += ms;
  }
  const by_channel: ReplyTimes['by_channel'] = {};
  for (const ch of CHANNELS) { const c = per[ch]; if (c) by_channel[ch] = { count: c.count, avg_ms: Math.round(c.total / c.count) }; }
  const target = parseJson<Partial<JobTarget>>(worst.target, {});
  return {
    count: rows.length,
    avg_ms: Math.round(total / rows.length),
    max_ms: worstMs,
    slowest: {
      conversation_id: worst.conversation_id, channel: worst.channel, sent_at: worst.sent_at, ms: worstMs,
      customer: target.title || target.handle || 'Customer',
    },
    by_channel,
  };
}
