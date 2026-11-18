-- The main laptop and the hand back (src/pipeline/leader.ts).
-- Who set the lane's shop account: 'owner' (the People panel or Connections; a laptop never replaces it),
-- 'main' (the main laptop reported it) or '' (learned before this column; the main laptop replaces it).
ALTER TABLE lane_leaders ADD COLUMN account_src TEXT NOT NULL DEFAULT '';
-- When the main laptop, ready again, asked for its lane back (0 for none). The laptop answering stands by
-- at once, the main laptop takes the lane 70 s later, and an ask still open after 4 minutes is dropped.
ALTER TABLE lane_leaders ADD COLUMN handover_at INTEGER NOT NULL DEFAULT 0;
-- The main laptop when the owner chose none: the oldest laptop still paired, read through this index.
-- Partial, like devices_live_seen, so the queries that read the laptops seen lately keep using that one.
CREATE INDEX IF NOT EXISTS devices_paired_age ON devices(created_at) WHERE revoked_at IS NULL;
