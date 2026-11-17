-- Indexes for the counts and lists the dashboard and the every-minute job read all day.
-- Without them each read scans whole tables, which used up the free plan's 5 million rows a day.
CREATE INDEX IF NOT EXISTS messages_created ON messages (created_at);
CREATE INDEX IF NOT EXISTS outbox_status_sent ON outbox (status, sent_at);
CREATE INDEX IF NOT EXISTS outbox_source_created ON outbox (source, created_at);
CREATE INDEX IF NOT EXISTS conversations_last_inbound ON conversations (last_inbound_at);
CREATE INDEX IF NOT EXISTS conversations_paused ON conversations (paused_until);
CREATE INDEX IF NOT EXISTS events_level_ts ON events (level, ts);
CREATE INDEX IF NOT EXISTS checkouts_messaged ON checkouts (messaged_at);
CREATE INDEX IF NOT EXISTS checkouts_status_updated ON checkouts (status, updated_at);
CREATE INDEX IF NOT EXISTS contacts_opted_out ON contacts (opted_out);
CREATE INDEX IF NOT EXISTS urgent_created ON urgent (created_at);
