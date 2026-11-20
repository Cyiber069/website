-- The owner makes every discount code by hand (2026-11-20): a saved "auto" becomes "ask", so the agent
-- saves a draft and asks on Urgent, and never makes a code itself. Number 0015 is kept for the people fixes.
UPDATE settings SET value = json_set(value, '$.mode', 'ask') WHERE key = 'discounts' AND json_valid(value) AND json_extract(value, '$.mode') = 'auto';
