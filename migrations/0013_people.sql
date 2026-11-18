-- People and laptops (src/pipeline/leader.ts, src/routes/people.ts).
-- The person a paired laptop belongs to, shown next to the logo on the dashboard.
ALTER TABLE devices ADD COLUMN person TEXT NOT NULL DEFAULT '';
-- Commands from the dashboard for this laptop (open a tab), handed over on its next syncs until the
-- laptop says it ran them. A JSON array, at most 5, each one lives 2 minutes.
ALTER TABLE devices ADD COLUMN commands TEXT NOT NULL DEFAULT '[]';
-- The name typed on the Connections screen when the pairing line was made.
ALTER TABLE pairing_codes ADD COLUMN person TEXT NOT NULL DEFAULT '';
-- One laptop answers each lane (whatsapp:inbox, gmail:inbox, tiktok:inbox). Other laptops signed in to
-- the same account stand by and take over when it stops. device_id '' means nobody right now.
-- account is the shop's account for the lane (a WhatsApp number, a Gmail address, a TikTok handle).
-- prev_device is the laptop that answered before, so a handover can be told to the owner.
-- solo is 1 while the laptop that answers was told it is the only one (it then keeps working while it
-- cannot reach the server), so a takeover from it waits for the jobs it holds to run out.
CREATE TABLE IF NOT EXISTS lane_leaders (
  lane TEXT PRIMARY KEY,
  account TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  epoch INTEGER NOT NULL DEFAULT 0,
  since INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  prev_device TEXT NOT NULL DEFAULT '',
  solo INTEGER NOT NULL DEFAULT 0
);
-- The laptops still paired, by when they last checked in. A sync counts the other laptops seen in the
-- last day (is this the only one?) and the health check lists the newest few: both read only those rows,
-- never every laptop ever paired.
CREATE INDEX IF NOT EXISTS devices_live_seen ON devices(last_seen_at) WHERE revoked_at IS NULL;
