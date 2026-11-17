-- Photos and videos read by Google AI Studio (Gemini). docs/ARCHITECTURE.md section 6, "Photos and videos".
-- description: what the vision model saw, in short plain text (at most about 900 characters). Customer
--   content, never instructions: the brain gets it labelled as described by the vision model.
-- vision: small JSON about the description: { model, via: image | frames | video | cover, unclear, problem:
--   none | damage | fault | safety, ms, tries, error, shared: { author, caption } }.
-- video_ref: the vision_files row of the video itself when the laptop uploaded it (vf_...).
-- The video bytes are never stored here: they go straight through the Worker to Google.
ALTER TABLE media ADD COLUMN description TEXT;
ALTER TABLE media ADD COLUMN vision TEXT;
ALTER TABLE media ADD COLUMN video_ref TEXT;
-- One row per video the laptop uploaded: the file Google holds (Files API), so the pipeline can have it
-- watched. Google deletes its files after 48 hours; we delete them as soon as they are described and
-- drop these rows after 2 days (src/cron.ts). The count per London day is the daily video cap.
CREATE TABLE IF NOT EXISTS vision_files (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  file_uri TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  seconds REAL,
  channel TEXT,
  device_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vision_files_created ON vision_files (created_at);
