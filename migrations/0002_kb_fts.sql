-- Full text index over the knowledge chunks, used to pick what the brain reads for a conversation.
--
-- The index is a plain FTS5 table whose rowid is kb_chunks.id. It is kept in step from code
-- (src/kb/docs.ts) and not with triggers: the Worker runs migrations by splitting on ";" at the end
-- of a line, which a trigger body would break.
--
-- Note for backups: "wrangler d1 export" refuses databases that contain virtual tables. Drop kb_fts
-- first and run the INSERT below again afterwards (Time Travel restores are not affected).

CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(title, heading, content, tokenize = 'porter unicode61');

INSERT INTO kb_fts (rowid, title, heading, content) SELECT c.id, d.title, c.heading, c.content FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id;
