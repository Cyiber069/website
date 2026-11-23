-- The owner wants the agent to make creator codes itself again (2026-11-23): "ask" back to "auto".
UPDATE settings SET value = json_set(value, '$.mode', 'auto') WHERE key = 'discounts' AND json_valid(value) AND json_extract(value, '$.mode') = 'ask';
