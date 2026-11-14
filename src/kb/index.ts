// Public surface of the knowledge base. Implemented in this folder; the rest of the backend imports only from here.
import type { Env } from '../types';
import { all, clip } from '../lib/db';
import { type KbDocRow, ingestDocument } from './docs';
import { ensureSeeded, getGaps, setGaps } from './seed';

export { chunkMarkdown, splitSections, type Chunk } from './chunk';
export {
  KB_CATEGORIES, KB_SOURCES, deleteDocument, docView, getDocument, ingestBulk, ingestDocument, listDocuments, updateDocument,
  type DocPatch, type IngestInput, type KbDocRow, type KbDocView,
} from './docs';
export { MAX_UPLOAD_BYTES, extractText, htmlToText, type UploadedFile } from './extract';
export { buildFtsQuery, searchTerms, titleSimilarity } from './query';
import { titleSimilarity } from './query';
export { buildKnowledgeContext, searchKb, type KbHit, type KnowledgeContext } from './search';
export { ensureSeeded, getGaps, setGaps, type KbGap } from './seed';
export { syncStore, type SyncResult } from './sync';

/**
 * Store a fact the owner taught the agent while answering an urgent question. Returns the kb_docs id.
 * A fact whose title is nearly the same as an earlier learned one replaces it: the newest answer wins.
 */
export async function addLearnedFact(env: Env, fact: { title: string; content: string; urgent_id: string }): Promise<string | null> {
  const title = clip(fact.title, 140);
  const content = fact.content.trim();
  if (!title || !content) return null;
  await ensureSeeded(env);
  const learned = await all<Pick<KbDocRow, 'id' | 'title'>>(env.DB, `SELECT id, title FROM kb_docs WHERE source = 'learned' ORDER BY updated_at DESC LIMIT 500`);
  const same = learned.find((d) => titleSimilarity(d.title, title) >= 0.8);
  const doc = await ingestDocument(env, {
    id: same?.id, title, content, category: 'learned', source: 'learned', source_ref: fact.urgent_id, enabled: true,
  });
  return doc.id;
}

/**
 * The owner answered one of the open questions about the store. Saves it as knowledge and takes the
 * question off the list. Returns null when that question is not on the list.
 */
export async function answerGap(env: Env, question: string, answer: string): Promise<KbDocRow | null> {
  await ensureSeeded(env);
  const gaps = await getGaps(env);
  const gap = gaps.find((g) => g.question === question);
  if (!gap) return null;
  const doc = await ingestDocument(env, {
    title: clip(gap.question, 140), content: `Question: ${gap.question}\n\nAnswer from the owner: ${answer.trim()}`,
    category: gap.category, source: 'learned', source_ref: 'gap',
  });
  await setGaps(env, gaps.filter((g) => g.question !== question));
  return doc;
}

export async function dismissGap(env: Env, question: string): Promise<boolean> {
  await ensureSeeded(env);
  const gaps = await getGaps(env);
  const left = gaps.filter((g) => g.question !== question);
  if (left.length === gaps.length) return false;
  await setGaps(env, left);
  return true;
}
