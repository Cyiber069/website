// The starter knowledge exported from the store (seed/knowledge) is bundled into the Worker and
// loaded into D1 the first time the knowledge base is used. After that the owner's copy in D1 is
// the truth: editing or deleting a seeded document is never undone by a deploy.
import type { Env } from '../types';
import { one, run } from '../lib/db';
import { getState, setState } from '../lib/settings';
import gapsJson from '../../seed/knowledge/gaps.json';
import indexJson from '../../seed/knowledge/index.json';
import pagesMd from '../../seed/knowledge/pages.md';
import policiesMd from '../../seed/knowledge/policies.md';
import productsMd from '../../seed/knowledge/products.md';
import storeFactsMd from '../../seed/knowledge/store-facts.md';
import playbookMd from '../../seed/knowledge/reply-playbook.md';
import ownerRulesMd from '../../seed/knowledge/owner-rules.md';
import { splitSections } from './chunk';
import { PRODUCT_PICKER_ID, PRODUCT_PICKER_TITLE, buildProductPicker } from './picker';
import { type IngestInput, ingestBulk } from './docs';

export interface KbGap { question: string; why_it_matters: string; category: string }

interface SeedEntry { id: string; title: string; file: string; category: string; source_url: string; pinned: boolean }

const FILES: Record<string, string> = {
  'store-facts.md': storeFactsMd, 'products.md': productsMd, 'policies.md': policiesMd, 'pages.md': pagesMd,
};

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export async function getGaps(env: Env): Promise<KbGap[]> {
  return getState<KbGap[]>(env.DB, 'kb_gaps', []);
}

export async function setGaps(env: Env, gaps: KbGap[]): Promise<void> {
  await setState(env.DB, 'kb_gaps', gaps);
}

async function seed(env: Env): Promise<void> {
  const docs: IngestInput[] = [];
  for (const entry of indexJson as SeedEntry[]) {
    const text = FILES[entry.file];
    if (!text) continue;
    if (entry.pinned) {
      // Short, always needed facts stay one document so they can be given to the brain in full.
      docs.push({ id: `seed_${entry.id}`, title: entry.title, content: text, category: entry.category, source: 'seed', source_ref: entry.source_url, pinned: true });
      continue;
    }
    // The big files hold one "## " section per product, policy or page. Each becomes its own
    // document so the owner can read, correct or switch off one product without touching the rest.
    const { intro, sections } = splitSections(text);
    if (intro) docs.push({ id: `seed_${entry.id}_notes`, title: `${entry.title}: notes`, content: intro, category: entry.category, source: 'seed', source_ref: entry.source_url });
    const used = new Set<string>();
    for (const section of sections) {
      let id = `seed_${entry.id}_${slug(section.title)}`;
      while (used.has(id)) id += '_2';
      used.add(id);
      const url = /^- URL: (https?:\/\/\S+)/m.exec(section.content)?.[1] ?? `${entry.source_url}#${slug(section.title)}`;
      docs.push({ id, title: section.title, content: section.content, category: entry.category, source: 'seed', source_ref: url });
    }
  }
  // A handful of batches in total: the free plan allows 50 database queries per request.
  await ingestBulk(env, docs.map((input) => ({ input })));
  await setGaps(env, gapsJson as KbGap[]);
}

// Seed notes added after the first release. Each is inserted once, also into a knowledge base that
// was seeded before it existed, unless a document with the same title is already there. A state
// flag per note means a note the owner deleted is never put back.
// Replaces the old creator note, which explained creator codes as if the agent could tell customers about them.
const CREATOR_NOTE = `For the team only, never told to customers: the owner makes creator codes by hand.
Never tell a customer that sponsors, creators, riders or affiliates get discount codes, and never mention codes, commission or money when someone asks to be sponsored.
When someone asks to be sponsored or for their own code, ask for their TikTok or Instagram and say you will pass it to the team. The shop's code rules hand the request to the owner.
Never tell anyone a code is live: the owner sends that message.`;

const LATER_NOTES: (IngestInput & { id: string; flag: string; replace?: boolean })[] = [
  {
    // The owner's rules and the settled contradictions between the playbook and the store. Pinned, source note: wins over everything.
    id: 'seed_owner_rules', flag: 'kb_seed_owner_rules_v5', replace: true, title: 'Owner rules and corrections',
    content: ownerRulesMd.replace(/^# .*\n+/, '').trim(), category: 'faq', source: 'note', source_ref: 'https://acxebikes.com/', pinned: true,
  },
  {
    // The owner's reply playbook: speeds, ranges, fitting, delivery, discounts and what to hand over. Pinned: always given in full.
    id: 'seed_reply_playbook', flag: 'kb_seed_reply_playbook_v4', replace: true, title: 'Reply playbook (from the owner)',
    content: playbookMd.replace(/^# .*\n+/, '').trim(), category: 'faq', source: 'seed', source_ref: 'https://acxebikes.com/', pinned: true,
  },
  {
    id: 'seed_creator_sponsorship', flag: 'kb_seed_creator_sponsorship_v2', replace: true, title: 'Creator sponsorship and discount codes',
    content: CREATOR_NOTE, category: 'faq', source: 'note', source_ref: 'https://acxebikes.com/',
  },
  {
    // Given in full to the brain when a customer is shopping (src/brain/decide.ts), so recommendations carry real links.
    id: PRODUCT_PICKER_ID, flag: 'kb_seed_product_picker', title: PRODUCT_PICKER_TITLE,
    content: buildProductPicker(productsMd), category: 'products', source: 'seed', source_ref: 'https://acxebikes.com/collections/all',
  },
];

async function addLaterNotes(env: Env): Promise<void> {
  const db = env.DB;
  for (const note of LATER_NOTES) {
    const claimed = await run(db, `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`, `state:${note.flag}`, JSON.stringify({ at: Date.now() }), Date.now());
    if (!claimed) continue;
    // A note marked replace overwrites its earlier version (same id) once per new flag: a corrected playbook.
    if (!note.replace && await one<{ id: string }>(db, 'SELECT id FROM kb_docs WHERE id = ? OR lower(title) = lower(?) LIMIT 1', note.id, note.title)) continue;
    const { flag: _flag, replace: _replace, ...input } = note;
    try {
      await ingestBulk(env, [{ input }]);
    } catch (err) {
      await run(db, 'DELETE FROM settings WHERE key = ?', `state:${note.flag}`);
      throw err;
    }
  }
}

let seeded: Promise<void> | null = null;

async function seedOnce(env: Env): Promise<void> {
  const db = env.DB;
  if (await one<{ key: string }>(db, `SELECT key FROM settings WHERE key = 'state:kb_seeded'`)) return;
  // Claim the flag first: two requests arriving together must not both load the files.
  const claimed = await run(db, `INSERT INTO settings (key, value, updated_at) VALUES ('state:kb_seeded', ?, ?) ON CONFLICT(key) DO NOTHING`, JSON.stringify({ at: Date.now() }), Date.now());
  if (!claimed) return;
  const has = await one<{ id: string }>(db, 'SELECT id FROM kb_docs LIMIT 1');
  if (has) return; // the owner already added knowledge by hand: leave it alone
  try {
    await seed(env);
  } catch (err) {
    await run(db, `DELETE FROM settings WHERE key = 'state:kb_seeded'`);
    throw err;
  }
}

/** Load the bundled starter knowledge if this database has never had any. Cheap to call on every request. */
export function ensureSeeded(env: Env): Promise<void> {
  if (!seeded) seeded = seedOnce(env).then(() => addLaterNotes(env)).catch((err) => { seeded = null; throw err; });
  return seeded;
}
