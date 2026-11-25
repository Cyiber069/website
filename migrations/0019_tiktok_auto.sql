-- The owner wants TikTok customers answered on their own (2026-11-25): a saved "review" becomes "auto".
UPDATE settings SET value = json_set(value, '$.tiktok.mode', 'auto') WHERE key = 'channels' AND json_valid(value) AND json_extract(value, '$.tiktok.mode') = 'review';
