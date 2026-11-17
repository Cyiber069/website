// Today's numbers for Live and Health (London day): messages in, replies sent, chats, questions passed to
// the owner, and the reply times. Counting them from scratch read every row of the day on every refresh
// (about 1,600 rows on a busy evening, every 15 s). Here each isolate counts the day once, then only
// reads what is new since its last look, with a 2 minute overlap so a row written a little late is
// never missed. Rows are remembered by id, so the overlap never counts one twice. Every counted row
// stays in its set for the day: message status, a sent reply's sent_at and a chat's last_inbound_at
// only ever move forward.
import type { Channel } from '../types';
import { all } from '../lib/db';
import { onReset } from '../lib/cache';
import { MIN } from '../lib/time';
import { summarise, type ReplyTimes } from './replytime';

/** Rows stored up to this long after the time they carry are still counted. */
export const OVERLAP_MS = 2 * MIN;

interface SentRow { id: string; source: string; channel: Channel; conversation_id: string | null; sent_at: number; reply_to_ts: number | null; target: string }

interface Acc {
  day: number;
  /** When the last look started. */
  upTo: number;
  inbound: Set<string>;
  sent: Map<string, SentRow>;
  convs: Set<string>;
  urgent: Set<string>;
}

let acc: Acc | null = null;
let pending: Promise<void> | null = null;
onReset(() => { acc = null; pending = null; });

export interface TodayStats {
  inbound_today: number;
  sent_today: number;
  auto_today: number;
  conversations_today: number;
  escalated_today: number;
  reply_time: ReplyTimes;
}

async function refresh(db: D1Database, day: number, now: number): Promise<void> {
  if (!acc || acc.day !== day) acc = { day, upTo: day, inbound: new Set(), sent: new Map(), convs: new Set(), urgent: new Set() };
  const a = acc;
  const since = Math.max(day, a.upTo - OVERLAP_MS);
  const [msgs, sent, convs, urgent] = await Promise.all([
    all<{ id: string }>(db, `SELECT id FROM messages WHERE created_at >= ? AND direction = 'in' AND status = 'received'`, since),
    all<SentRow>(db, `SELECT id, source, channel, conversation_id, sent_at, reply_to_ts, target FROM outbox WHERE status = 'sent' AND sent_at >= ?`, since),
    all<{ id: string }>(db, 'SELECT id FROM conversations WHERE last_inbound_at >= ?', since),
    all<{ id: string }>(db, 'SELECT id FROM urgent WHERE created_at >= ?', since),
  ]);
  if (acc !== a) return; // reset meanwhile
  for (const m of msgs) a.inbound.add(m.id);
  for (const s of sent) a.sent.set(s.id, s);
  for (const c of convs) a.convs.add(c.id);
  for (const u of urgent) a.urgent.add(u.id);
  a.upTo = Math.max(a.upTo, now);
}

/** Today's numbers since `day` (the start of the London day). A few small queries, none on most refreshes of a quiet minute. */
export async function todayStats(db: D1Database, day: number, now = Date.now()): Promise<TodayStats> {
  // Two refreshes at once in one isolate share the reads.
  if (!pending) pending = refresh(db, day, now).finally(() => { pending = null; });
  await pending;
  if (!acc || acc.day !== day) await refresh(db, day, now);
  const a = acc!;
  let sentToday = 0, autoToday = 0;
  const replies: SentRow[] = [];
  for (const s of a.sent.values()) {
    if (s.source !== 'alert') sentToday++;
    if (s.source === 'auto') autoToday++;
    if (s.reply_to_ts !== null && s.reply_to_ts !== undefined && (s.source === 'auto' || s.source === 'holding' || s.source === 'discount')) replies.push(s);
  }
  // As the old query read them: newest first, at most 1000.
  replies.sort((x, y) => y.sent_at - x.sent_at);
  const reply_time = summarise(replies.slice(0, 1000).map((r) => ({ channel: r.channel, conversation_id: r.conversation_id, sent_at: r.sent_at, reply_to_ts: r.reply_to_ts!, target: r.target })));
  return {
    inbound_today: a.inbound.size, sent_today: sentToday, auto_today: autoToday,
    conversations_today: a.convs.size, escalated_today: a.urgent.size, reply_time,
  };
}
