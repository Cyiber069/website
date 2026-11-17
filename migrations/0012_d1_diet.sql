-- Fewer rows read a day (the free plan allows 5 million).
-- The Inbox list for one channel reads only that channel's newest chats.
CREATE INDEX IF NOT EXISTS conversations_channel_updated ON conversations (channel, updated_at DESC);
-- Live reads the last checkout reminder run: one row, not every run there ever was.
CREATE INDEX IF NOT EXISTS recovery_runs_started ON recovery_runs (started_at DESC);
-- Brain calls that failed in a row for a chat: the next try waits longer each time (8 s, 30 s, 2 min, 5 min).
ALTER TABLE conversations ADD COLUMN brain_fails INTEGER NOT NULL DEFAULT 0;
-- A short hash of the message ids of the last report stored for the chat. The same report again is
-- answered from the chat row alone (src/pipeline/inbound.ts quickRepeat).
ALTER TABLE conversations ADD COLUMN report_key TEXT;
