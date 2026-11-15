-- Discount codes the agent makes by itself when a customer asks for one, and owner notes on Urgent items.
-- made_by: owner (Discount codes screen) | agent (from a chat). An Urgent item for a code request
-- points at its draft through urgent.discount_id.
-- Keep each statement simple and ending with ";" at the end of a line (src/lib/schema.ts splits on it).

ALTER TABLE discount_codes ADD COLUMN made_by TEXT NOT NULL DEFAULT 'owner';

ALTER TABLE urgent ADD COLUMN discount_id TEXT;

CREATE INDEX IF NOT EXISTS discount_codes_contact ON discount_codes (contact_id);

-- The owner's note on an Urgent item ("Tell the agent what's going on"): the agent wrote the reply from it.
ALTER TABLE urgent ADD COLUMN owner_note TEXT;
