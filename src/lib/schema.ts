// The Worker creates and upgrades its own tables, so deploying is only ever "wrangler deploy".
// Add a new numbered file in migrations/ and list it here; applied ones are never edited.
import m0001 from '../../migrations/0001_init.sql';
import m0002 from '../../migrations/0002_kb_fts.sql';
import m0003 from '../../migrations/0003_discounts.sql';
import m0004 from '../../migrations/0004_agent_discounts.sql';
import m0005 from '../../migrations/0005_read_indexes.sql';
import m0006 from '../../migrations/0006_sales.sql';
import m0007 from '../../migrations/0007_media.sql';
import m0008 from '../../migrations/0008_reply_speed.sql';
import m0009 from '../../migrations/0009_vision.sql';
import m0010 from '../../migrations/0010_send_waits.sql';
import m0011 from '../../migrations/0011_waits_and_videos.sql';
import m0012 from '../../migrations/0012_d1_diet.sql';
import m0013 from '../../migrations/0013_people.sql';
import m0014 from '../../migrations/0014_main_laptop.sql';
import m0016 from '../../migrations/0016_discounts_by_hand.sql';
import m0017 from '../../migrations/0017_no_follow_ups.sql';

const MIGRATIONS: [string, string][] = [['0001_init', m0001], ['0002_kb_fts', m0002], ['0003_discounts', m0003], ['0004_agent_discounts', m0004], ['0005_read_indexes', m0005], ['0006_sales', m0006], ['0007_media', m0007], ['0008_reply_speed', m0008], ['0009_vision', m0009], ['0010_send_waits', m0010], ['0011_waits_and_videos', m0011], ['0012_d1_diet', m0012], ['0013_people', m0013], ['0014_main_laptop', m0014], ['0016_discounts_by_hand', m0016], ['0017_no_follow_ups', m0017]];

let ready: Promise<void> | null = null;

function statements(sql: string): string[] {
  return sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

async function migrate(db: D1Database): Promise<void> {
  await db.prepare('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)').run();
  const done = new Set(((await db.prepare('SELECT name FROM schema_migrations').all<{ name: string }>()).results ?? []).map((r) => r.name));
  // Databases set up with "wrangler d1 migrations apply" already have the tables.
  if (!done.has('0001_init')) {
    const has = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").first();
    if (has) { await db.prepare('INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)').bind('0001_init', Date.now()).run(); done.add('0001_init'); }
  }
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    const list = statements(sql).map((s) => db.prepare(s));
    list.push(db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').bind(name, Date.now()));
    await db.batch(list);
  }
}

export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) ready = migrate(db).catch((err) => { ready = null; throw err; });
  return ready;
}
