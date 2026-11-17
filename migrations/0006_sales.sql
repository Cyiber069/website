-- Selling: where each conversation stands as a sale, the one follow up after a recommendation,
-- and orders matched back to the chat they came from. Read by src/sales and the Sales screen.
-- browsing | interested | ready | bought | support | none
ALTER TABLE conversations ADD COLUMN sales_stage TEXT;
-- product title the agent recommended or the customer is after
ALTER TABLE conversations ADD COLUMN sales_product TEXT;
-- product link the agent sent (always from the knowledge)
ALTER TABLE conversations ADD COLUMN sales_link TEXT;
-- when that reply was queued
ALTER TABLE conversations ADD COLUMN sales_link_at INTEGER;
-- when the stage was last set
ALTER TABLE conversations ADD COLUMN sales_stage_at INTEGER;
-- first time interested or ready
ALTER TABLE conversations ADD COLUMN interested_at INTEGER;
-- first time ready
ALTER TABLE conversations ADD COLUMN ready_at INTEGER;
-- order matched to this chat
ALTER TABLE conversations ADD COLUMN bought_at INTEGER;
ALTER TABLE conversations ADD COLUMN order_total REAL;
ALTER TABLE conversations ADD COLUMN order_currency TEXT;
-- when the one follow up was queued or skipped for good
ALTER TABLE conversations ADD COLUMN followup_at INTEGER;
-- queued | draft | skipped_<reason>; NULL means not done yet
ALTER TABLE conversations ADD COLUMN followup_status TEXT;
ALTER TABLE conversations ADD COLUMN followup_outbox_id TEXT;

-- The every minute follow up job reads only chats that could still get one (partial index).
CREATE INDEX IF NOT EXISTS conversations_followup_due ON conversations (last_outbound_at) WHERE followup_status IS NULL AND sales_link IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_followup_at ON conversations (followup_at);
CREATE INDEX IF NOT EXISTS conversations_stage_at ON conversations (sales_stage_at);
CREATE INDEX IF NOT EXISTS conversations_interested ON conversations (interested_at);
CREATE INDEX IF NOT EXISTS conversations_ready ON conversations (ready_at);
CREATE INDEX IF NOT EXISTS conversations_contact ON conversations (contact_id);
CREATE INDEX IF NOT EXISTS contacts_email ON contacts (email);

-- One row per order matched to a chat. from_chat = 1 when the agent wrote in that chat in the 14 days before the order.
CREATE TABLE IF NOT EXISTS sales_conversions (
  id TEXT PRIMARY KEY,
  order_ref TEXT NOT NULL UNIQUE,                 -- order:<id> or checkout:<id>
  conversation_id TEXT NOT NULL,
  contact_id TEXT,
  channel TEXT NOT NULL,
  total REAL,
  currency TEXT,
  ordered_at INTEGER NOT NULL,
  from_chat INTEGER NOT NULL DEFAULT 0,
  matched_by TEXT NOT NULL,                       -- phone | email
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sales_conversions_at ON sales_conversions (ordered_at);
CREATE INDEX IF NOT EXISTS sales_conversions_conv ON sales_conversions (conversation_id, ordered_at);
