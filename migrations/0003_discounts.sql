-- Discount codes the owner makes for creators and sponsorship requests, and the chat message that
-- tells the customer about it. One row per code. Status: draft (saved, not live yet) | live (made in
-- Shopify or confirmed by the owner) | sent (message delivered) | failed (message could not be sent).
-- shopify_status: not_connected | created | failed | owner_confirmed.
-- Keep each statement simple and ending with ";" at the end of a line (src/lib/schema.ts splits on it).

CREATE TABLE IF NOT EXISTS discount_codes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id TEXT,
  contact_name TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  applies_to TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  usage_limit INTEGER,
  shopify_id TEXT,
  shopify_status TEXT NOT NULL DEFAULT 'not_connected',
  message_text TEXT NOT NULL DEFAULT '',
  outbox_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS discount_codes_created ON discount_codes (created_at DESC);
