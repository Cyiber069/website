// The D1 diet pieces that need no Worker: the settings cache, the budget levels, the brain backoff, the
// dashboard answer cache, and a check that no code reads the whole settings table.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_CACHE_MS, cachedState, getSettings, noteSettingsRev, patchSettings } from '../../src/lib/settings';
import { bumpDashboard, cachedAnswer, resetCaches } from '../../src/lib/cache';
import { budgetFrom, levelFor } from '../../src/lib/budget';
import { brainBackoffMs } from '../../src/pipeline/inbound';
// @ts-expect-error plain JS dashboard module
import { BLURRED_MS, FOCUSED_MS, IDLE_MS, nextRefreshIn, refreshOnWake } from '../../public/js/poll.js';

// The knowledge base bundles the seed documents (.md imports), which only the Worker build can load.
vi.mock('../../src/kb', () => ({
  PRODUCT_PICKER_ID: 'product_picker',
  buildKnowledgeContext: async () => ({ mode: 'empty', stable: '', retrieved: '', docs: [], tokens: 0 }),
  addLearnedFact: async () => null,
  syncStore: async () => ({}),
}));

/** A D1 stand in that keeps rows in a Map and counts the queries it is asked. */
function fakeDb(rows: Record<string, string> = {}) {
  const store = new Map(Object.entries(rows));
  const log: string[] = [];
  const statement = (sql: string, params: unknown[] = []) => ({
    sql, params,
    bind: (...p: unknown[]) => statement(sql, p),
    async all() {
      log.push(sql);
      if (/^SELECT key, value FROM settings WHERE key IN/.test(sql)) {
        return { results: (params as string[]).filter((k) => store.has(k)).map((k) => ({ key: k, value: store.get(k)! })), meta: { rows_read: params.length } };
      }
      return { results: [], meta: {} };
    },
    async run() {
      log.push(sql);
      if (/^INSERT INTO settings/.test(sql)) store.set(String(params[0]).startsWith('state:') ? String(params[0]) : String(params[0]), String(params[1]));
      return { meta: { changes: 1 } };
    },
  });
  const db = {
    prepare: (sql: string) => statement(sql),
    async batch(list: { sql: string; params: unknown[] }[]) {
      log.push('batch');
      for (const st of list) {
        if (/^INSERT INTO settings \(key, value, updated_at\) VALUES \('state:settings_rev'/.test(st.sql)) store.set('state:settings_rev', String(st.params[0]));
        else if (/^INSERT INTO settings/.test(st.sql)) store.set(String(st.params[0]), String(st.params[1]));
      }
      return list.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return { db: db as unknown as D1Database, log, store, reads: () => log.filter((l) => l.startsWith('SELECT key, value FROM settings')).length };
}

afterEach(() => { vi.restoreAllMocks(); resetCaches(); });

describe('settings cache', () => {
  it('reads the settings once per 30 s per isolate', async () => {
    const f = fakeDb({ agent: JSON.stringify({ enabled: false }) });
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    expect((await getSettings(f.db)).agent.enabled).toBe(false);
    await getSettings(f.db);
    now += SETTINGS_CACHE_MS - 1000;
    await getSettings(f.db);
    expect(f.reads()).toBe(1);
    now += 2000;
    await getSettings(f.db);
    expect(f.reads()).toBe(2);
  });

  it('a change made here is read again at once, and saves a new revision in the same round trip', async () => {
    const f = fakeDb();
    vi.spyOn(Date, 'now').mockImplementation(() => 1_800_000_000_000);
    await getSettings(f.db);
    await patchSettings(f.db, 'agent', { enabled: false });
    expect(f.log).toContain('batch');
    expect(f.store.get('state:settings_rev')).toBeDefined();
    const before = f.reads();
    expect((await getSettings(f.db)).agent.enabled).toBe(false);
    expect(f.reads()).toBe(before + 1);
  });

  it('a newer revision seen by a signed in request drops the cache (a change made in another isolate)', async () => {
    const f = fakeDb({ 'state:settings_rev': '100' });
    vi.spyOn(Date, 'now').mockImplementation(() => 1_800_000_000_000);
    await getSettings(f.db);
    noteSettingsRev('100'); // the same revision: still cached
    await getSettings(f.db);
    expect(f.reads()).toBe(1);
    f.store.set('agent', JSON.stringify({ enabled: false }));
    f.store.set('state:settings_rev', '200');
    noteSettingsRev('200');
    expect((await getSettings(f.db)).agent.enabled).toBe(false);
    expect(f.reads()).toBe(2);
  });

  it("brings today's database use and the knowledge version in the same query", async () => {
    const f = fakeDb({ 'state:d1_usage': JSON.stringify({ day: '2026-11-17', read: 10, written: 2, updated_at: 1 }), 'state:kb_version': '7' });
    vi.spyOn(Date, 'now').mockImplementation(() => 1_800_000_000_000);
    expect(await cachedState(f.db, 'kb_version', 0)).toBe(7);
    expect(await cachedState<{ read: number }>(f.db, 'd1_usage', { read: 0 })).toMatchObject({ read: 10 });
    await getSettings(f.db);
    expect(f.reads()).toBe(1);
  });
});

describe('no code reads the whole settings table', () => {
  it('every settings read names its keys', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(fileURLToPath(new URL('../../src', import.meta.url)));
    const bad: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/SELECT[^`'"]*?FROM settings\b([^`'"]{0,40})/gi)) {
        if (!/^\s*WHERE\s+key\b/i.test(m[1] ?? '')) bad.push(`${f}: ${m[0]}`);
      }
    }
    expect(files.length).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });
});

describe('budget levels', () => {
  it('normal below 70%, high from 70%, critical from 90%, by the larger of reads and writes', () => {
    expect(levelFor(69.9)).toBe('normal');
    expect(levelFor(70)).toBe('high');
    expect(levelFor(89.9)).toBe('high');
    expect(levelFor(90)).toBe('critical');
    const now = Date.UTC(2026, 10, 17, 12);
    expect(budgetFrom({ day: '2026-11-17', read: 3_600_000, written: 0, updated_at: now }, now).level).toBe('high');
    expect(budgetFrom({ day: '2026-11-17', read: 0, written: 95_000, updated_at: now }, now).level).toBe('critical');
    // Yesterday's count does not count: a new UTC day starts at normal.
    expect(budgetFrom({ day: '2026-11-16', read: 4_900_000, written: 0, updated_at: now }, now).level).toBe('normal');
  });
});

describe('brain backoff', () => {
  it("waits the model's time, then 30 s, 2 min and 5 min", () => {
    expect(brainBackoffMs(1, 8000)).toBe(8000);
    expect(brainBackoffMs(2, 8000)).toBe(30_000);
    expect(brainBackoffMs(3, 8000)).toBe(120_000);
    expect(brainBackoffMs(4, 8000)).toBe(300_000);
    expect(brainBackoffMs(9, 8000)).toBe(300_000);
    expect(brainBackoffMs(2, 60_000)).toBe(60_000); // never sooner than the model asked
  });
});

describe('dashboard answer cache', () => {
  it('answers from memory until it is old or anything was written', async () => {
    let loads = 0;
    const load = async () => ++loads;
    expect(await cachedAnswer('k', 20_000, 1000, load)).toBe(1);
    expect(await cachedAnswer('k', 20_000, 15_000, load)).toBe(1);
    expect(await cachedAnswer('k', 20_000, 21_001, load)).toBe(2);
    bumpDashboard();
    expect(await cachedAnswer('k', 20_000, 21_002, load)).toBe(3);
    // Two at once share one load.
    const [a, b] = await Promise.all([cachedAnswer('j', 20_000, 1, load), cachedAnswer('j', 20_000, 2, load)]);
    expect(a).toBe(b);
    // A failed load is not kept.
    await expect(cachedAnswer('x', 20_000, 1, async () => { throw new Error('d1 down'); })).rejects.toThrow('d1 down');
    expect(await cachedAnswer('x', 20_000, 2, async () => 'ok')).toBe('ok');
  });
});

describe('dashboard refresh cadence', () => {
  const base = { now: 1_000_000, lastTick: 1_000_000, lastActive: 1_000_000, hidden: false, focused: true, budgetSeconds: 30 };
  it('every 30 s while visible and focused, every 2 min behind another window', () => {
    expect(FOCUSED_MS).toBe(30_000);
    expect(BLURRED_MS).toBe(120_000);
    expect(nextRefreshIn(base)).toBe(30_000);
    expect(nextRefreshIn({ ...base, focused: false })).toBe(120_000);
    expect(nextRefreshIn({ ...base, now: base.now + 10_000 })).toBe(20_000);
  });
  it('stops while hidden and after 5 minutes with nobody using it', () => {
    expect(nextRefreshIn({ ...base, hidden: true })).toBeNull();
    expect(IDLE_MS).toBe(300_000);
    expect(nextRefreshIn({ ...base, now: base.now + IDLE_MS + 1 })).toBeNull();
    expect(nextRefreshIn({ ...base, now: base.now + IDLE_MS - 1000 })).toBe(1000);
  });
  it('every 2 min at least when the day is busy, and at once when someone comes back', () => {
    expect(nextRefreshIn({ ...base, budgetSeconds: 120 })).toBe(120_000);
    expect(refreshOnWake({ now: base.now + 60_000, lastTick: base.now, stopped: true })).toBe(true);
    expect(refreshOnWake({ now: base.now + 2000, lastTick: base.now, stopped: true })).toBe(false);
    expect(refreshOnWake({ now: base.now + 60_000, lastTick: base.now, stopped: false })).toBe(false);
  });
});
