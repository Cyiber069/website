-- Sends that wait on the owner, and customer videos held by Google (docs/ARCHITECTURE.md sections 5 and 6).
-- outbox.busy_last: when the laptop last said this job was held up (owner_busy, composer_busy, draft_in_chat).
--   A busy result long after the last one starts a new wait, so an old busy_since never fails a job at once.
-- outbox.busy_warned: 0 not told, 1 the owner got the push, 2 the line is on Live but the push was held back
--   by the throttle (it is tried again, and the failure push still goes).
ALTER TABLE outbox ADD COLUMN busy_last INTEGER;
-- vision_files.video_key: channel and message id of the customer video (whatsapp:3EB0...), so the same
--   video is never uploaded or counted twice.
-- vision_files.gone_at: when the file was deleted from Google (or found gone). Cron deletes what is left
--   after a few hours, before it drops the rows.
ALTER TABLE vision_files ADD COLUMN video_key TEXT;
ALTER TABLE vision_files ADD COLUMN gone_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_vision_files_key ON vision_files (video_key);
