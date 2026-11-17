-- Sends that wait on the owner (docs/ARCHITECTURE.md section 5, job results).
-- busy_since: when the laptop first said the owner was typing or a draft was in the way of this job
--   (owner_busy, composer_busy, draft_in_chat). The job waits a while without using a try, the owner is
--   told after a few minutes, and it gives up after 15 minutes. NULL again once it is not busy.
-- busy_warned: 1 once the owner was told about this job, so they are told once.
ALTER TABLE outbox ADD COLUMN busy_since INTEGER;
ALTER TABLE outbox ADD COLUMN busy_warned INTEGER NOT NULL DEFAULT 0;
