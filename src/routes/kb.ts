// Owner facing API for the Knowledge screen: documents, uploads, store sync and open questions.
import { one } from '../lib/db';
import { logEvent } from '../lib/events';
import { HttpError, bad, bool, json, notFound, oneOf, str, type Router } from '../lib/http';
import {
  KB_CATEGORIES, MAX_UPLOAD_BYTES, answerGap, deleteDocument, dismissGap, docView, ensureSeeded, extractText, getDocument, getGaps,
  ingestDocument, listDocuments, searchKb, syncStore, updateDocument, type KbDocRow,
} from '../kb';

const MAX_TEXT = 1_000_000;

function fullDoc(d: KbDocRow) {
  return { ...docView(d), content: d.content, source_ref: d.source_ref, mime: d.mime, created_at: d.created_at };
}

export function register(r: Router): void {
  r.get('/api/kb', 'owner', async (c) => {
    await ensureSeeded(c.env);
    // Only the start of each text is read: the list can hold hundreds of long documents.
    const rows = await listDocuments(c.env, { contentChars: 400 });
    const totals = await one<{ docs: number; tokens: number }>(c.db, 'SELECT COUNT(*) AS docs, COALESCE(SUM(token_estimate), 0) AS tokens FROM kb_docs WHERE enabled = 1');
    return json({ docs: rows.map(docView), totals: { docs: totals?.docs ?? 0, tokens: totals?.tokens ?? 0 }, gaps: await getGaps(c.env) });
  });

  // Not in the dashboard contract: lets the owner (and the tests) see what the brain would be shown for a question.
  r.get('/api/kb/search', 'owner', async (c) => {
    const q = (c.url.searchParams.get('q') ?? '').slice(0, 500);
    const hits = await searchKb(c.env, q, { limit: 10 });
    return json({ results: hits.map((h) => ({ doc_id: h.doc_id, title: h.title, heading: h.heading, category: h.category, source: h.source, score: Math.round(h.score * 100) / 100, snippet: h.content.slice(0, 400) })) });
  });

  r.get('/api/kb/:id', 'owner', async (c) => {
    const doc = await getDocument(c.env, c.params.id!);
    if (!doc) throw notFound('doc_not_found');
    return json({ doc: fullDoc(doc) });
  });

  r.post('/api/kb/upload', 'owner', async (c) => {
    const declared = Number(c.req.headers.get('content-length') ?? '0');
    if (declared > MAX_UPLOAD_BYTES + 100_000) throw new HttpError(413, 'too_large', 'That file is larger than 10 MB');
    if (!(c.req.headers.get('content-type') ?? '').includes('multipart/form-data')) throw new HttpError(415, 'multipart_required', 'Send the file as a multipart form');
    let form: FormData;
    try { form = await c.req.formData(); } catch { throw bad('invalid_body', 'Could not read the upload'); }
    const file = form.get('file');
    if (!file || typeof file === 'string') throw bad('missing_field', 'file is required', { field: 'file' });
    if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'too_large', 'That file is larger than 10 MB');
    const categoryRaw = form.get('category');
    const category = oneOf(typeof categoryRaw === 'string' && categoryRaw ? categoryRaw : undefined, 'category', KB_CATEGORIES, 'general');
    const name = (file.name || 'upload').replace(/[\\/]/g, ' ').slice(0, 200);

    const { text, mime } = await extractText(c.env, { name, type: file.type, bytes: await file.arrayBuffer() });
    const doc = await ingestDocument(c.env, {
      title: name.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[_-]+/g, ' ').trim() || name, content: text, category,
      source: 'upload', source_ref: name, filename: name, mime, bytes: file.size,
    });
    await logEvent(c.db, { type: 'kb_added', message: `Added "${doc.title}" to knowledge (${doc.token_estimate} tokens)` });
    return json({ doc: docView(doc) });
  });

  r.post('/api/kb/note', 'owner', async (c) => {
    const body = await c.body(MAX_TEXT + 10_000);
    const doc = await ingestDocument(c.env, {
      title: str(body.title, 'title', { max: 160 }), content: str(body.content, 'content', { max: MAX_TEXT }),
      category: oneOf(body.category, 'category', KB_CATEGORIES, 'general'), source: 'note', pinned: bool(body.pinned, false),
    });
    return json({ doc: docView(doc) });
  });

  r.post('/api/kb/sync-store', 'owner', async (c) => {
    const result = await syncStore(c.env);
    if (!result.ok) throw new HttpError(502, 'sync_failed', result.error ?? 'Could not read the store');
    if (result.added || result.updated) await logEvent(c.db, { type: 'kb_sync', message: `Store sync: ${result.added} added, ${result.updated} updated` });
    return json(result);
  });

  r.post('/api/kb/gaps/answer', 'owner', async (c) => {
    const body = await c.body();
    const doc = await answerGap(c.env, str(body.question, 'question', { max: 2000 }), str(body.answer, 'answer', { max: 10_000 }));
    if (!doc) throw notFound('gap_not_found');
    return json({ doc: docView(doc) });
  });

  r.post('/api/kb/gaps/dismiss', 'owner', async (c) => {
    const body = await c.body();
    if (!(await dismissGap(c.env, str(body.question, 'question', { max: 2000 })))) throw notFound('gap_not_found');
    return json({ ok: true });
  });

  r.patch('/api/kb/:id', 'owner', async (c) => {
    const body = await c.body(MAX_TEXT + 10_000);
    const doc = await updateDocument(c.env, c.params.id!, {
      title: body.title === undefined ? undefined : str(body.title, 'title', { max: 160 }),
      content: body.content === undefined ? undefined : str(body.content, 'content', { max: MAX_TEXT }),
      category: body.category === undefined ? undefined : oneOf(body.category, 'category', KB_CATEGORIES),
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      pinned: typeof body.pinned === 'boolean' ? body.pinned : undefined,
    });
    if (!doc) throw notFound('doc_not_found');
    return json({ doc: docView(doc) });
  });

  r.delete('/api/kb/:id', 'owner', async (c) => {
    if (!(await deleteDocument(c.env, c.params.id!))) throw notFound('doc_not_found');
    return json({ ok: true });
  });
}
