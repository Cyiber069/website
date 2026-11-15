import { describe, expect, it } from 'vitest';
import { chunkMarkdown, splitSections } from '../../src/kb/chunk';
import { htmlToText } from '../../src/kb/extract';
import { buildFtsQuery, searchTerms, titleSimilarity } from '../../src/kb/query';
import { violations } from '../../src/brain/style';
import { BASE, api, inbound, sql, unique } from '../helpers/client';

// ---- pure pieces -------------------------------------------------------------------------------

describe('kb chunking', () => {
  const doc = [
    '# Shipping policy', '', 'Intro line about shipping.', '',
    '## UK orders', '', 'UK orders arrive in 2 to 3 weeks.', '', '### Express', '', 'Express takes 3 working days.', '',
    '## International', '', ...Array.from({ length: 60 }, (_, i) => `Paragraph ${i} about customs and duties for international parcels that goes on for a while.\n`),
  ].join('\n');
  const chunks = chunkMarkdown('Shipping policy', doc);

  it('carries the heading path into every chunk and never repeats the title', () => {
    expect(chunks[0]!.heading).toBe('Shipping policy');
    expect(chunks.some((c) => c.heading === 'Shipping policy > UK orders')).toBe(true);
    expect(chunks.filter((c) => c.heading === 'Shipping policy > International').length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.heading.startsWith('Shipping policy')).toBe(true);
  });

  it('keeps chunks at or under about 400 tokens and does not cross a second level heading', () => {
    for (const c of chunks) {
      expect(c.token_estimate).toBeLessThanOrEqual(410);
      expect(c.content.trim().length).toBeGreaterThan(0);
    }
    const uk = chunks.find((c) => c.heading === 'Shipping policy > UK orders')!;
    expect(uk.content).toContain('2 to 3 weeks');
    expect(uk.content).not.toContain('customs');
    // The short "Express" subsection stays with its parent, with its heading kept as text.
    expect(uk.content).toContain('Express:');
    expect(uk.content).toContain('3 working days');
  });

  it('loses no text and splits one very long line', () => {
    const all = chunks.map((c) => c.content).join('\n');
    for (let i = 0; i < 60; i++) expect(all).toContain(`Paragraph ${i} about`);
    const long = chunkMarkdown('Long', `${'word '.repeat(2000)}`);
    expect(long.length).toBeGreaterThan(4);
    for (const c of long) expect(c.token_estimate).toBeLessThanOrEqual(410);
  });

  it('splits a seed file into one section per second level heading', () => {
    const { intro, sections } = splitSections('# File\n\nabout this file\n\n## One\n\ntext one\n\n### sub\n\nmore\n\n## Two\n\ntext two');
    expect(intro).toBe('about this file');
    expect(sections.map((s) => s.title)).toEqual(['One', 'Two']);
    expect(sections[0]!.content).toContain('### sub');
  });
});

describe('kb query building', () => {
  it('drops filler, keeps the topic and adds the shop words for it', () => {
    const terms = searchTerms('yo bro how long is delivery to leeds');
    expect(terms).toContain('delivery');
    expect(terms).toContain('shipping');
    expect(terms).toContain('leeds');
    expect(terms).not.toContain('yo');
    expect(terms).not.toContain('bro');
    expect(terms).not.toContain('is');
  });

  it('writes power and voltage the way the catalogue does', () => {
    expect(searchTerms('how much is the 2000 watt kit')).toEqual(expect.arrayContaining(['2000w', 'kit', 'price']));
    expect(searchTerms('72 v battery')).toContain('72v');
    expect(searchTerms('the 5000W one')).toContain('5000w');
  });

  it('is always a safe MATCH string', () => {
    const q = buildFtsQuery('"hello" AND (NEAR OR NOT) - col:umn * ^ it\'s {x}');
    expect(q).toMatch(/^"[\p{L}\p{N}]+"( OR "[\p{L}\p{N}]+")*$/u);
    expect(buildFtsQuery('???  !!! -- ""')).toBe('');
    expect(buildFtsQuery('')).toBe('');
  });

  it('spots near identical titles', () => {
    expect(titleSimilarity('Do you ship to Ireland?', 'do you ship to ireland')).toBe(1);
    expect(titleSimilarity('Do you ship to Ireland?', 'Ireland: do you ship to it')).toBeGreaterThanOrEqual(0.8);
    expect(titleSimilarity('Do you ship to Ireland?', 'What is the warranty on batteries')).toBeLessThan(0.3);
  });
});

describe('html to text', () => {
  it('keeps headings, lists and entities, drops scripts and tags', () => {
    const text = htmlToText('<html><head><title>x</title><style>p{}</style></head><body><h2>Returns &amp; refunds</h2><p>You have <b>14&nbsp;days</b>.</p><ul><li>Unused</li><li>Boxed</li></ul><script>alert(1)</script><p>Costs &pound;25 &#8211; ok</p></body></html>');
    expect(text).toContain('## Returns & refunds');
    expect(text).toContain('You have 14 days.');
    expect(text).toContain('- Unused\n- Boxed');
    expect(text).toContain('Costs £25');
    expect(text).not.toMatch(/alert|<|p\{\}/);
  });
});

// ---- API ----------------------------------------------------------------------------------------

const search = async (q: string) => (await api(`/api/kb/search?q=${encodeURIComponent(q)}`)).data.results as { doc_id: string; title: string; heading: string; snippet: string; source: string }[];

async function upload(name: string, content: string | Uint8Array, type: string, category?: string) {
  const form = new FormData();
  form.set('file', new File([content], name, { type }));
  if (category) form.set('category', category);
  const res = await fetch(`${BASE()}/api/kb/upload`, { method: 'POST', headers: { cookie: process.env.ACX_TEST_COOKIE! }, body: form });
  return { status: res.status, data: (await res.json()) as any };
}

describe('knowledge: starter content', () => {
  it('needs the owner', async () => {
    expect((await api('/api/kb', { as: 'public' })).status).toBe(401);
    expect((await api('/api/kb/note', { as: 'public', body: { title: 'x', content: 'y' } })).status).toBe(401);
  });

  it('loads the bundled store export once, with the open questions', async () => {
    const { status, data } = await api('/api/kb');
    expect(status).toBe(200);
    const seed = data.docs.filter((d: any) => d.source === 'seed');
    expect(seed.length).toBeGreaterThan(50);
    expect(data.totals.tokens).toBeGreaterThan(40_000);
    expect(data.gaps.length).toBeGreaterThan(30);
    expect(data.gaps[0]).toEqual({ question: expect.any(String), why_it_matters: expect.any(String), category: expect.any(String) });
    const facts = data.docs.find((d: any) => d.id === 'seed_store-facts');
    expect(facts).toMatchObject({ pinned: true, enabled: true, category: 'general' });
    expect(facts.preview.length).toBeGreaterThan(20);
    expect(facts.content).toBeUndefined();
    const one = await api('/api/kb/seed_store-facts');
    expect(one.data.doc.content).toContain('ACX Ebikes');
    // Asking again does not load it twice.
    const again = await api('/api/kb');
    expect(again.data.docs.filter((d: any) => d.source === 'seed')).toHaveLength(seed.length);
    const index = await sql('SELECT (SELECT COUNT(*) FROM kb_chunks) AS chunks, (SELECT COUNT(*) FROM kb_fts) AS indexed');
    expect(index.data.results[0].indexed).toBe(index.data.results[0].chunks);
  });

  it('finds the right part of 55k tokens of store text', async () => {
    const delivery = await search('yo how long is delivery');
    expect(delivery.length).toBeGreaterThan(3);
    expect(delivery.slice(0, 3).some((h) => /shipping|delivery/i.test(h.title))).toBe(true);
    expect(delivery.slice(0, 5).map((h) => h.snippet + h.heading).join(' ')).toMatch(/days|weeks/);

    const returns = await search('can i send it back if i dont like it');
    expect(returns[0]!.title).toBe('Refund policy');

    const price = await search('how much is the 2000w bundle 29 inch');
    expect(price[0]!.title).toBe('ACX 2000w bundle');
    expect(price.slice(0, 5).map((h) => h.snippet).join(' ')).toContain('£');

    const legal = await search('is the 1000 watt kit road legal in the uk??');
    expect(legal.slice(0, 4).some((h) => /road legal/i.test(h.title))).toBe(true);

    expect((await search('wheres my order'))[0]!.title).toMatch(/track/i);
    expect((await search('can i pay with klarna'))[0]!.title).toMatch(/klarna/i);
  });

  it('survives hostile search text', async () => {
    for (const q of ['"', 'AND OR NOT', 'a:b (c) -d *', "'; DROP TABLE kb_docs; --", '']) {
      const res = await api(`/api/kb/search?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.results)).toBe(true);
    }
    expect((await api('/api/kb')).data.docs.length).toBeGreaterThan(50);
  });
});

describe('knowledge: notes, edits and uploads', () => {
  it('adds a note, finds it, edits it, switches it off and deletes it', async () => {
    const word = unique('zorbflux');
    const bad = await api('/api/kb/note', { body: { title: '', content: 'x' } });
    expect(bad.status).toBe(400);
    expect((await api('/api/kb/note', { body: { title: 'x', content: 'y', category: 'nonsense' } })).status).toBe(400);

    const made = await api('/api/kb/note', { body: { title: 'Bank holiday dispatch', content: `We do not dispatch on bank holidays. Code word ${word}.`, category: 'shipping' } });
    expect(made.status).toBe(200);
    const id = made.data.doc.id as string;
    expect(made.data.doc).toMatchObject({ source: 'note', category: 'shipping', enabled: true, pinned: false, title: 'Bank holiday dispatch' });
    expect(made.data.doc.token_estimate).toBeGreaterThan(5);

    expect((await search(word))[0]!.doc_id).toBe(id);
    // What the owner wrote outranks store text on the same topic.
    expect((await search('do you dispatch on bank holidays'))[0]!.doc_id).toBe(id);

    const word2 = unique('quibblevex');
    const edited = await api(`/api/kb/${id}`, { method: 'PATCH', body: { content: `Orders placed on a bank holiday go out the next working day. ${word2}`, title: 'Bank holidays', pinned: true } });
    expect(edited.data.doc).toMatchObject({ title: 'Bank holidays', pinned: true });
    expect(await search(word)).toHaveLength(0);
    const hit = (await search(word2))[0]!;
    expect(hit.doc_id).toBe(id);
    expect(hit.heading).toBe('Bank holidays');
    expect((await api(`/api/kb/${id}`)).data.doc.content).toContain(word2);

    const off = await api(`/api/kb/${id}`, { method: 'PATCH', body: { enabled: false } });
    expect(off.data.doc.enabled).toBe(false);
    expect(await search(word2)).toHaveLength(0);
    await api(`/api/kb/${id}`, { method: 'PATCH', body: { enabled: true, category: 'faq' } });
    expect(await search(word2)).toHaveLength(1);

    expect((await api(`/api/kb/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/api/kb/${id}`)).status).toBe(404);
    expect((await api(`/api/kb/${id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await api(`/api/kb/${id}`, { method: 'PATCH', body: { enabled: true } })).status).toBe(404);
    expect(await search(word2)).toHaveLength(0);
    const left = await sql('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?', [id]);
    expect(left.data.results[0].n).toBe(0);
    const index = await sql('SELECT (SELECT COUNT(*) FROM kb_chunks) AS chunks, (SELECT COUNT(*) FROM kb_fts) AS indexed');
    expect(index.data.results[0].indexed).toBe(index.data.results[0].chunks);
  });

  it('reads uploaded text, markdown and html files', async () => {
    const word = unique('plimsollgrid');
    const md = await upload('fitting_guide-v2.md', `# Fitting guide\n\n## Tools\n\nYou need a ${word} spanner.\n\n## Time\n\nAbout 90 minutes.`, 'text/markdown', 'faq');
    expect(md.status).toBe(200);
    expect(md.data.doc).toMatchObject({ title: 'fitting guide v2', filename: 'fitting_guide-v2.md', source: 'upload', category: 'faq' });
    expect(md.data.doc.bytes).toBeGreaterThan(50);
    const hit = (await search(word))[0]!;
    expect(hit.doc_id).toBe(md.data.doc.id);
    expect(hit.heading).toBe('fitting guide v2 > Fitting guide > Tools');

    const html = await upload('page.html', '<html><body><h1>Sizing</h1><p>Rear dropout is <b>135mm</b>.</p><script>var x = 1;</script></body></html>', 'text/html');
    expect(html.status).toBe(200);
    const stored = (await api(`/api/kb/${html.data.doc.id}`)).data.doc.content as string;
    expect(stored).toContain('Rear dropout is 135mm.');
    expect(stored).not.toMatch(/<|var x/);

    await api(`/api/kb/${md.data.doc.id}`, { method: 'DELETE' });
    await api(`/api/kb/${html.data.doc.id}`, { method: 'DELETE' });
  });

  it('refuses files it cannot read, with the documented error codes', async () => {
    const exe = await upload('setup.exe', 'MZ....', 'application/octet-stream');
    expect([exe.status, exe.data.error]).toEqual([400, 'unsupported_type']);
    // PDF needs Workers AI, which the test Worker does not have: a clear message, not a crash.
    const pdf = await upload('manual.pdf', '%PDF-1.4 fake', 'application/pdf');
    expect([pdf.status, pdf.data.error]).toEqual([400, 'unsupported_type']);
    expect(pdf.data.message).toMatch(/Workers AI/);
    const empty = await upload('empty.txt', '  \n ', 'text/plain');
    expect([empty.status, empty.data.error]).toEqual([400, 'empty_text']);
    const big = await upload('big.txt', new Uint8Array(10 * 1024 * 1024 + 2048).fill(97), 'text/plain');
    expect([big.status, big.data.error]).toEqual([413, 'too_large']);
    const none = await fetch(`${BASE()}/api/kb/upload`, { method: 'POST', headers: { cookie: process.env.ACX_TEST_COOKIE! }, body: new FormData() });
    expect(none.status).toBe(400);
  });
});

describe('knowledge: open questions', () => {
  it('saves an answer as knowledge and takes the question off the list', async () => {
    const before = (await api('/api/kb')).data.gaps as { question: string; category: string }[];
    const gap = before[0]!;
    const word = unique('fourteenish');
    const res = await api('/api/kb/gaps/answer', { body: { question: gap.question, answer: `14 days from delivery, unused and boxed. ${word}` } });
    expect(res.status).toBe(200);
    expect(res.data.doc).toMatchObject({ source: 'learned', category: gap.category, enabled: true });
    const after = (await api('/api/kb')).data.gaps as { question: string }[];
    expect(after).toHaveLength(before.length - 1);
    expect(after.some((g) => g.question === gap.question)).toBe(false);
    expect((await search(word))[0]!.doc_id).toBe(res.data.doc.id);
    expect((await api('/api/kb/gaps/answer', { body: { question: gap.question, answer: 'again' } })).status).toBe(404);
    expect((await api('/api/kb/gaps/answer', { body: { question: before[1]!.question } })).status).toBe(400);

    const gone = await api('/api/kb/gaps/dismiss', { body: { question: before[1]!.question } });
    expect(gone.status).toBe(200);
    expect((await api('/api/kb')).data.gaps).toHaveLength(before.length - 2);
    expect((await api('/api/kb/gaps/dismiss', { body: { question: before[1]!.question } })).status).toBe(404);
    await api(`/api/kb/${res.data.doc.id}`, { method: 'DELETE' });
  });
});

describe('knowledge: store sync', () => {
  it('adds what the public catalogue shows and leaves unchanged documents alone', async () => {
    const first = await api('/api/kb/sync-store', { body: {} });
    expect(first.status).toBe(200);
    // Two fixture products. The fixture refund policy is skipped: the starter knowledge already has that page.
    expect(first.data).toEqual({ ok: true, added: 2, updated: 0 });
    const docs = (await api('/api/kb')).data.docs.filter((d: any) => d.source === 'store');
    expect(docs.map((d: any) => d.title).sort()).toEqual(['Test Battery 48V', 'Test Kit 1000W']);
    const kit = (await api(`/api/kb/${docs.find((d: any) => d.title === 'Test Kit 1000W').id}`)).data.doc;
    expect(kit.category).toBe('products');
    expect(kit.content).toContain('- Price: £300.00 to £320.00');
    expect(kit.content).toContain('29 | £320.00 | none | no (sold out)');
    expect(kit.content).toContain('A test kit.');
    expect(await api('/api/kb/sync-store', { body: {} }).then((r) => r.data)).toEqual({ ok: true, added: 0, updated: 0 });
    expect((await api('/api/settings')).data.settings.store.last_sync_at).toBeGreaterThan(0);
    for (const d of docs) await api(`/api/kb/${d.id}`, { method: 'DELETE' });
  });
});

describe('voice playground', () => {
  it('returns a sanitized decision and stores nothing', async () => {
    const count = async () => (await sql('SELECT (SELECT COUNT(*) FROM conversations) AS c, (SELECT COUNT(*) FROM messages) AS m, (SELECT COUNT(*) FROM outbox) AS o')).data.results[0];
    const before = await count();
    const res = await api('/api/playground', { body: { messages: [{ direction: 'in', body: 'yooo bro' }, { direction: 'in', body: 'dashes please how long is delivery' }] } });
    expect(res.status).toBe(200);
    const d = res.data.decision;
    expect(d.action).toBe('reply');
    expect(d.parts.length).toBeGreaterThan(0);
    // The mock answers with em dashes, hyphens and an Oxford comma. None may survive.
    for (const p of d.parts) {
      expect(violations(p)).toEqual([]);
      expect(p).not.toMatch(/[‒-―]/);
      expect(p).toContain('2 to 4 days');
    }
    expect(['hype', 'casual']).toContain(d.tone.register);
    expect(d.tone.address_terms).toContain('bro');
    expect(d.flags).toEqual({ opt_out: false, asked_if_bot: false, needs_human: false });
    expect(typeof d.confidence).toBe('number');
    expect(res.data.provider).toBe('mock');
    expect(typeof res.data.ms).toBe('number');
    // The knowledge shown to the brain comes back as ids with titles.
    expect(res.data.kb_refs.length).toBeGreaterThan(0);
    expect(res.data.kb_refs[0]).toEqual({ id: expect.any(String), title: expect.any(String) });
    expect(res.data.kb_refs.some((r: any) => /shipping|delivery/i.test(r.title))).toBe(true);
    expect(await count()).toEqual(before);
  });

  it('shows an escalation with its holding line, and validates input', async () => {
    const res = await api('/api/playground', { body: { channel: 'tiktok', messages: [{ direction: 'out', body: 'hey' }, { direction: 'in', body: 'unknown-question about gearing' }] } });
    expect(res.data.decision.action).toBe('escalate');
    expect(res.data.decision.escalate.question).toContain('unknown-question');
    expect(res.data.decision.parts).toHaveLength(1);
    expect((await api('/api/playground', { body: { messages: [] } })).status).toBe(400);
    expect((await api('/api/playground', { body: { messages: [{ direction: 'out', body: 'hi' }] } })).status).toBe(400);
    expect((await api('/api/playground', { body: { messages: [{ direction: 'in', body: 'hi' }], channel: 'fax' } })).status).toBe(400);
    expect((await api('/api/playground', { as: 'public', body: { messages: [{ direction: 'in', body: 'hi' }] } })).status).toBe(401);
  });
});

describe('learning from the owner', () => {
  it('saves an urgent answer as a knowledge document and reuses it for the same question', async () => {
    const question = `unknown-question does the ${unique('gizmo')} fit a brompton`;
    const ask = async () => {
      const r = await inbound('whatsapp', `${unique('4478')}@c.us`, [{ external_id: 'q1', direction: 'in', body: question }]);
      expect(r.action).toBe('escalate');
      const item = (await api('/api/urgent')).data.urgent.find((u: any) => u.conversation_id === r.conversation_id);
      return item.id as string;
    };
    const first = await ask();
    const answered = await api(`/api/urgent/${first}/answer`, { body: { answer: 'no the dropout is too narrow', learn: true } });
    expect(answered.status).toBe(200);
    const row = (await sql('SELECT kb_doc_id FROM urgent WHERE id = ?', [first])).data.results[0];
    expect(row.kb_doc_id).toBeTruthy();
    const doc = (await api(`/api/kb/${row.kb_doc_id}`)).data.doc;
    expect(doc).toMatchObject({ source: 'learned', category: 'learned', enabled: true, source_ref: first });
    expect(doc.content).toContain('no the dropout is too narrow');
    expect((await search(question))[0]!.doc_id).toBe(doc.id);

    // The same question answered again updates that document instead of adding a twin.
    const second = await ask();
    await api(`/api/urgent/${second}/answer`, { body: { answer: 'actually yes with the 100mm adapter', learn: true } });
    const row2 = (await sql('SELECT kb_doc_id FROM urgent WHERE id = ?', [second])).data.results[0];
    expect(row2.kb_doc_id).toBe(doc.id);
    expect((await api(`/api/kb/${doc.id}`)).data.doc.content).toContain('100mm adapter');
    const twins = await sql(`SELECT COUNT(*) AS n FROM kb_docs WHERE source = 'learned' AND title = ?`, [doc.title]);
    expect(twins.data.results[0].n).toBe(1);

    // learn: false stores nothing.
    const third = await ask();
    await api(`/api/urgent/${third}/answer`, { body: { answer: 'one off answer', learn: false } });
    expect((await sql('SELECT kb_doc_id FROM urgent WHERE id = ?', [third])).data.results[0].kb_doc_id).toBeNull();
    await api(`/api/kb/${doc.id}`, { method: 'DELETE' });
  });
});

describe('messages the agent cannot open', () => {
  it('passes a lone voice note to the owner silently, so the customer never sees a bot style line', async () => {
    const r = await inbound('whatsapp', `${unique('4479')}@c.us`, [{ external_id: 'v1', direction: 'in', body: '', kind: 'voice' }]);
    expect(r.action).toBe('escalate');
    expect(r.jobs).toHaveLength(0);
    const item = (await api('/api/urgent')).data.urgent.find((u: any) => u.conversation_id === r.conversation_id);
    expect(item.question).toMatch(/voice note/);
    expect(item.category).toBe('media');
    await api(`/api/urgent/${item.id}/dismiss`, { body: {} });
  });

  it('still answers when there are words next to the photo', async () => {
    const r = await inbound('whatsapp', `${unique('4479')}@c.us`, [{ external_id: 'p1', direction: 'in', body: '', kind: 'image' }, { external_id: 'p2', direction: 'in', body: 'will the kit fit this bike' }]);
    expect(r.action).toBe('reply');
    expect(r.jobs[0]!.parts[0]).toContain('will the kit fit this bike');
  });
});
