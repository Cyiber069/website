-- Replying fast (docs/ARCHITECTURE.md section 6).
-- reply_to_id: the customer message an agent reply answers. The brain sees replies that are queued
--   but not sent yet right after that message, so a second decision never repeats them.
-- reply_to_ts: when that customer message arrived, as best known (the page time, else when it was
--   first seen). Reply time = sent_at - reply_to_ts, shown on Live and Health. Read through the
--   existing outbox_status_sent index.
ALTER TABLE outbox ADD COLUMN reply_to_id TEXT;
ALTER TABLE outbox ADD COLUMN reply_to_ts INTEGER;
-- When the cron sweeper may try a chat again after its brain call failed, so one failing chat never
-- holds up the others. Not a lock: the health check still counts the chat as waiting.
ALTER TABLE conversations ADD COLUMN retry_at INTEGER;
