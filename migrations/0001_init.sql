-- ACX Agent schema. All timestamps are unix milliseconds unless noted.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,              -- JSON
  updated_at INTEGER NOT NULL
);

-- Write only from the API: values are never returned to any client.
CREATE TABLE secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',    -- last 4 characters, safe to show
  updated_at INTEGER NOT NULL
);

CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- sha256 of the session token
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,  -- sha256 of the device token
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  status TEXT NOT NULL DEFAULT '{}',-- JSON reported by the extension on each sync
  version TEXT NOT NULL DEFAULT '',
  revoked_at INTEGER
);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0
);

-- Knowledge base ------------------------------------------------------------

CREATE TABLE kb_docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general', -- products | policies | shipping | faq | learned | general
  source TEXT NOT NULL DEFAULT 'upload',    -- upload | note | store | learned | seed
  source_ref TEXT,                           -- url, filename or urgent id
  filename TEXT,
  mime TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,         -- pinned docs are always given to the brain
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX kb_docs_source ON kb_docs (source, source_ref);

CREATE TABLE kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  heading TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX kb_chunks_doc ON kb_chunks (doc_id, ord);

-- Conversations ---------------------------------------------------------------

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,                     -- whatsapp | gmail | tiktok
  external_id TEXT NOT NULL,                 -- jid, email address or tiktok unique id
  display_name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  email TEXT,
  handle TEXT,
  tone_profile TEXT NOT NULL DEFAULT '{}',   -- JSON, last computed tone profile
  notes TEXT NOT NULL DEFAULT '',
  opted_out INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (channel, external_id)
);
CREATE INDEX contacts_phone ON contacts (phone);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  external_thread_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'open',       -- open | waiting_owner | closed
  paused_until INTEGER,                      -- agent will not auto reply before this time
  pause_reason TEXT,
  needs_reply_since INTEGER,                 -- set when inbound stored, cleared when the brain decided
  processing_until INTEGER,                  -- brain lock
  context_notes TEXT NOT NULL DEFAULT '[]',  -- JSON array of short facts for the brain
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  last_preview TEXT NOT NULL DEFAULT '',
  last_direction TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (channel, external_thread_id)
);
CREATE INDEX conversations_updated ON conversations (updated_at DESC);
CREATE INDEX conversations_needs_reply ON conversations (needs_reply_since);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,                   -- in | out
  author TEXT NOT NULL,                      -- customer | agent | owner
  external_id TEXT,                          -- id from the platform when known
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',         -- text | image | voice | video | sticker | document | other
  status TEXT NOT NULL DEFAULT 'received',   -- received | sent | history
  outbox_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  ts INTEGER NOT NULL,                       -- platform time when known, else first seen
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX messages_external ON messages (conversation_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX messages_conv ON messages (conversation_id, ts, created_at);

-- Questions the agent could not answer -----------------------------------------

CREATE TABLE urgent (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  question TEXT NOT NULL,                    -- what the customer needs, in plain words
  customer_message TEXT NOT NULL DEFAULT '', -- the customer's own words
  reason TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'open',       -- open | answered | sent | dismissed
  owner_answer TEXT,
  polished_answer TEXT,
  learn INTEGER NOT NULL DEFAULT 1,
  kb_doc_id TEXT,
  outbox_id TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  sent_at INTEGER
);
CREATE INDEX urgent_status ON urgent (status, created_at DESC);

-- Messages the extension must send --------------------------------------------------

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- reply | new_chat
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  target TEXT NOT NULL,                      -- JSON {thread_external_id,title,phone,email,handle,subject}
  parts TEXT NOT NULL,                       -- JSON array of message texts sent in order
  status TEXT NOT NULL DEFAULT 'pending',    -- review | pending | leased | sent | failed | cancelled | expired
  source TEXT NOT NULL,                      -- auto | holding | urgent | review | recovery | manual | alert
  ref_id TEXT,                               -- urgent id or checkout id
  not_before INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  lease_until INTEGER,
  lease_device TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dedupe_key TEXT UNIQUE,
  pacing TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX outbox_due ON outbox (status, not_before);
CREATE INDEX outbox_conv ON outbox (conversation_id, created_at DESC);

-- Abandoned checkout recovery -----------------------------------------------------------

CREATE TABLE checkouts (
  id TEXT PRIMARY KEY,                       -- shopify checkout id (numeric part) or token
  token TEXT,
  name TEXT NOT NULL DEFAULT '',
  first_name TEXT,
  email TEXT,
  phone_raw TEXT,
  phone_e164 TEXT,
  country TEXT,
  total TEXT,
  currency TEXT,
  items TEXT NOT NULL DEFAULT '[]',          -- JSON [{title, quantity}]
  recovery_url TEXT,
  created_at_shop INTEGER,
  updated_at_shop INTEGER,
  completed_at INTEGER,
  consent_sms INTEGER NOT NULL DEFAULT 0,
  consent_email INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'api',        -- api | webhook
  status TEXT NOT NULL DEFAULT 'new',        -- new | queued | messaged | recovered | skipped | failed | expired
  skip_reason TEXT,
  message_text TEXT,
  messaged_at INTEGER,
  outbox_id TEXT,
  run_id TEXT,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX checkouts_status ON checkouts (status, created_at_shop DESC);
CREATE INDEX checkouts_phone ON checkouts (phone_e164);

CREATE TABLE recovery_runs (
  id TEXT PRIMARY KEY,
  run_date TEXT NOT NULL,                    -- YYYY-MM-DD in Europe/London
  trigger TEXT NOT NULL DEFAULT 'schedule',  -- schedule | manual | dry_run
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',    -- running | done | error | skipped
  found INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX recovery_runs_date ON recovery_runs (run_date, trigger);

-- Activity, diagnostics, usage -------------------------------------------------------------

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',        -- info | good | warn | error
  type TEXT NOT NULL,
  channel TEXT,
  conversation_id TEXT,
  message TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX events_ts ON events (ts DESC);

CREATE TABLE diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  device_id TEXT,
  channel TEXT,
  kind TEXT NOT NULL,                        -- selector_miss | dom_snapshot | error | note
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX diagnostics_ts ON diagnostics (ts DESC);

CREATE TABLE llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX llm_usage_ts ON llm_usage (ts DESC);
