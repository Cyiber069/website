// Knowledge documents in D1: create, change, delete, list. Every write re-chunks the document and
// keeps the full text index (kb_fts, migration 0002) in step, all in one batch.
import type { Env } from '../types';
import { all, clip, estimateTokens, one, stmt, uid } from '../lib/db';
import { chunkMarkdown } from './chunk';

export const KB_CATEGORIES = ['products', 'policies', 'shipping', 'faq', 'learned', 'general'] as const;
export type KbCategory = (typeof KB_CATEGORIES)[number];
export const KB_SOURCES = ['upload', 'note', 'store', 'learned', 'seed'] as const;
export type KbSource = (typeof KB_SOURCES)[number];

export interface KbDocRow {
  id: string; title: string; category: string; source: string; source_ref: string | null; filename: string | null;
  mime: string | null; bytes: number; content: string; enabled: number; pinned: number; token_estimate: number;
  created_at: number; updated_at: number;
}

/** A document as the dashboard sees it. */
export interface KbDocView {
  id: string; title: string; category: string; source: string; filename: string | null; bytes: number;
  enabled: boolean; pinned: boolean; token_estimate: number; updated_at: number; preview: string;
}

export interface IngestInput {
  /** Give an id to replace that document, leave it out to create a new one. */
  id?: string;
  title: string;
  content: string;
  category?: string;
  source?: KbSource;
  source_ref?: string | null;
  filename?: string | null;
  mime?: string | null;
  bytes?: number;
  enabled?: boolean;
  pinned?: boolean;
}

export const MAX_DOC_CHARS = 1_500_000; // D1 rows are capped at 2 MB

export function docView(d: KbDocRow): KbDocView {
  return {
    id: d.id, title: d.title, category: d.category, source: d.source, filename: d.filename, bytes: d.bytes,
    enabled: d.enabled === 1, pinned: d.pinned === 1, token_estimate: d.token_estimate, updated_at: d.updated_at,
    preview: clip(d.content, 200),
  };
}

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** The form every document is stored in: unix newlines, no trailing spaces, no long runs of blank lines. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}

function validCategory(c: string | undefined): KbCategory {
  return (KB_CATEGORIES as readonly string[]).includes(c ?? '') ? (c as KbCategory) : 'general';
}

/** Statements that replace the chunks and index rows of one document. Run inside a batch after the doc row is written. */
function chunkStatements(db: D1Database, docId: string, title: string, content: string): D1PreparedStatement[] {
  const list: D1PreparedStatement[] = [
    stmt(db, 'DELETE FROM kb_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE doc_id = ?)', docId),
    stmt(db, 'DELETE FROM kb_chunks WHERE doc_id = ?', docId),
  ];
  const chunks = chunkMarkdown(title, content);
  // D1 allows 100 bound values per statement: 20 rows of 5.
  for (let i = 0; i < chunks.length; i += 20) {
    const rows = chunks.slice(i, i + 20);
    const params: (string | number)[] = [];
    rows.forEach((c, j) => params.push(docId, i + j, c.heading, c.content, c.token_estimate));
    list.push(stmt(db, `INSERT INTO kb_chunks (doc_id, ord, heading, content, token_estimate) VALUES ${rows.map(() => '(?, ?, ?, ?, ?)').join(', ')}`, ...params));
  }
  list.push(stmt(db, 'INSERT INTO kb_fts (rowid, title, heading, content) SELECT id, ?, heading, content FROM kb_chunks WHERE doc_id = ?', title, docId));
  return list;
}

function buildRow(input: IngestInput, existing: KbDocRow | null, now: number): KbDocRow {
  const content = cleanText(input.content).slice(0, MAX_DOC_CHARS);
  return {
    id: input.id ?? uid('kb'), title: clip(input.title || 'Untitled', 160), category: validCategory(input.category ?? existing?.category),
    source: input.source ?? (existing?.source as KbSource | undefined) ?? 'note',
    source_ref: input.source_ref !== undefined ? input.source_ref : existing?.source_ref ?? null,
    filename: input.filename !== undefined ? input.filename : existing?.filename ?? null,
    mime: input.mime !== undefined ? input.mime : existing?.mime ?? null,
    bytes: input.bytes ?? utf8Bytes(content), content,
    enabled: (input.enabled ?? (existing ? existing.enabled === 1 : true)) ? 1 : 0,
    pinned: (input.pinned ?? (existing ? existing.pinned === 1 : false)) ? 1 : 0,
    token_estimate: estimateTokens(content), created_at: existing?.created_at ?? now, updated_at: now,
  };
}

/** Everything needed to write one document with its chunks and index rows. */
function rowStatements(db: D1Database, row: KbDocRow): D1PreparedStatement[] {
  return [
    stmt(
      db,
      `INSERT INTO kb_docs (id, title, category, source, source_ref, filename, mime, bytes, content, enabled, pinned, token_estimate, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, category = excluded.category, source = excluded.source, source_ref = excluded.source_ref,
         filename = excluded.filename, mime = excluded.mime, bytes = excluded.bytes, content = excluded.content, enabled = excluded.enabled,
         pinned = excluded.pinned, token_estimate = excluded.token_estimate, updated_at = excluded.updated_at`,
      row.id, row.title, row.category, row.source, row.source_ref, row.filename, row.mime, row.bytes, row.content, row.enabled, row.pinned,
      row.token_estimate, row.created_at, row.updated_at,
    ),
    ...chunkStatements(db, row.id, row.title, row.content),
  ];
}

/** Create a document, or replace the one with the given id. The text is chunked and indexed for search. */
export async function ingestDocument(env: Env, input: IngestInput): Promise<KbDocRow> {
  const db = env.DB;
  const existing = input.id ? await one<KbDocRow>(db, 'SELECT * FROM kb_docs WHERE id = ?', input.id) : null;
  const row = buildRow(input, existing, Date.now());
  await db.batch(rowStatements(db, row));
  return row;
}

/**
 * Write many documents with as few database round trips as possible. The free plan allows 50 D1
 * queries per request and a batch counts as one, so seeding and store sync go through here.
 * Pass the current row as `existing` when replacing a document (nothing is looked up).
 */
export async function ingestBulk(env: Env, items: { input: IngestInput; existing?: KbDocRow | null }[]): Promise<KbDocRow[]> {
  const db = env.DB;
  const now = Date.now();
  const rows = items.map((it) => buildRow(it.input, it.existing ?? null, now));
  let batch: D1PreparedStatement[] = [];
  let size = 0;
  for (const row of rows) {
    const list = rowStatements(db, row);
    // Keep each batch modest: a document's statements stay together, about 400 KB of text at most.
    if (batch.length && (batch.length + list.length > 60 || size + row.content.length * 2 > 400_000)) {
      await db.batch(batch);
      batch = [];
      size = 0;
    }
    batch.push(...list);
    size += row.content.length * 2;
  }
  if (batch.length) await db.batch(batch);
  return rows;
}

export interface DocPatch { title?: string; content?: string; category?: string; enabled?: boolean; pinned?: boolean }

/** Change parts of a document. Chunks are rebuilt only when the title or the text changed. Null when the id is unknown. */
export async function updateDocument(env: Env, id: string, patch: DocPatch): Promise<KbDocRow | null> {
  const db = env.DB;
  const existing = await one<KbDocRow>(db, 'SELECT * FROM kb_docs WHERE id = ?', id);
  if (!existing) return null;
  const textChanged = (patch.title !== undefined && patch.title !== existing.title) || (patch.content !== undefined && patch.content !== existing.content);
  if (textChanged) {
    return ingestDocument(env, {
      id, title: patch.title ?? existing.title, content: patch.content ?? existing.content, category: patch.category,
      enabled: patch.enabled, pinned: patch.pinned,
      // An edited upload keeps its file name but its size is now the size of the text.
      bytes: patch.content !== undefined ? utf8Bytes(patch.content) : existing.bytes,
    });
  }
  const next = {
    category: patch.category !== undefined ? validCategory(patch.category) : existing.category,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
    pinned: patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : existing.pinned,
  };
  const now = Date.now();
  await stmt(db, 'UPDATE kb_docs SET category = ?, enabled = ?, pinned = ?, updated_at = ? WHERE id = ?', next.category, next.enabled, next.pinned, now, id).run();
  return { ...existing, ...next, updated_at: now };
}

export async function deleteDocument(env: Env, id: string): Promise<boolean> {
  const db = env.DB;
  const res = await db.batch([
    stmt(db, 'DELETE FROM kb_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE doc_id = ?)', id),
    stmt(db, 'DELETE FROM kb_chunks WHERE doc_id = ?', id),
    stmt(db, 'DELETE FROM kb_docs WHERE id = ?', id),
  ]);
  return (res[2]?.meta?.changes ?? 0) > 0;
}

export function getDocument(env: Env, id: string): Promise<KbDocRow | null> {
  return one<KbDocRow>(env.DB, 'SELECT * FROM kb_docs WHERE id = ?', id);
}

/**
 * Every document, pinned first, then by category and title. The same order is used when the whole
 * knowledge base is given to the brain, so that text stays identical from one call to the next.
 * `contentChars` limits how much of each text is read (the list screen only needs a preview).
 */
export function listDocuments(env: Env, opts: { onlyEnabled?: boolean; onlyPinned?: boolean; contentChars?: number } = {}): Promise<KbDocRow[]> {
  const where = [opts.onlyEnabled ? 'enabled = 1' : '', opts.onlyPinned ? 'pinned = 1' : ''].filter(Boolean).join(' AND ');
  const content = opts.contentChars !== undefined ? `substr(content, 1, ${Math.max(0, Math.floor(opts.contentChars))}) AS content` : 'content';
  return all<KbDocRow>(
    env.DB,
    `SELECT id, title, category, source, source_ref, filename, mime, bytes, ${content}, enabled, pinned, token_estimate, created_at, updated_at
     FROM kb_docs ${where ? `WHERE ${where}` : ''} ORDER BY pinned DESC, category ASC, title ASC, id ASC`,
  );
}
