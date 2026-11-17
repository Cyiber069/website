-- Photos and video frames a customer sent, captured by the extension as a small JPEG so the brain can
-- look at them and the owner sees a thumbnail. One row per message at most. Rows are deleted after
-- 14 days by the daily cleanup (src/cron.ts).
-- Never select `data` in a list query: it is up to 260 KB of base64 per row.
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_message ON media (message_id);
CREATE INDEX IF NOT EXISTS idx_media_created ON media (created_at);
