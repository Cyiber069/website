-- Shop accounts nobody vouched for (src/pipeline/leader.ts). Before 0014 a lane learned its account from
-- whichever laptop claimed or took it over first, even one on Adrian's own accounts; 0014 left those with
-- account_src ''. Forgotten here, so the main laptop's account (or the owner's) is the shop's again.
-- Gmail too while Connections names no inbox (when it names one, that inbox is the shop's anyway).
UPDATE lane_leaders SET account = '' WHERE account_src = '' AND account != ''
  AND (lane != 'gmail:inbox' OR COALESCE((SELECT json_extract(value, '$.account') FROM settings WHERE key = 'gmail' AND json_valid(value)), '') = '');
-- devices_paired_age (0014) is no longer read: the main laptop is the oldest one seen today (devices_live_seen).
-- It stays, because a Worker still running the code before this one may read it while the new one rolls out.
