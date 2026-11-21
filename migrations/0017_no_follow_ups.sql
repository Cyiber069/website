-- The owner felt the next day "just checking in" message annoys customers (2026-11-21): follow ups off.
-- The owner can switch them back on from the Sales screen.
INSERT INTO settings (key, value, updated_at) VALUES ('sales', '{"follow_ups":false,"follow_up_hours":20,"style":"friendly"}', CAST(strftime('%s','now') AS INTEGER) * 1000)
  ON CONFLICT(key) DO UPDATE SET value = json_set(CASE WHEN json_valid(value) THEN value ELSE '{}' END, '$.follow_ups', json('false'));
