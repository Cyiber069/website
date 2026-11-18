// Settings locks without a Worker: which change belongs to which box, what is never lockable, the PIN rules, and
// that the dashboard marks every box the server knows (and only those).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LOCK_RULES, LOCK_SECTIONS, MAX_PIN_FAILS, NEVER_LOCKED, PIN_BLOCK_MS, blockedMessage, claimOutcome, lockSectionFor,
  lockSummary, lockView, parseFails, parseLockState, pinValue, wrongOutcome, wrongPinMessage,
} from '../../src/lib/locks';
// @ts-expect-error plain JS dashboard module
import { LOCK_LABELS, PIN_RE as DASH_PIN_RE } from '../../public/js/locks.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** One real request per route each box covers (the API test sends these too). */
const COVERED: [string, string, string][] = [
  ['voice', 'PUT', '/api/settings/voice'],
  ['brain', 'PUT', '/api/connections/brain'], ['brain', 'PUT', '/api/settings/brain'],
  ['vision', 'PUT', '/api/connections/vision'], ['vision', 'PUT', '/api/settings/vision'],
  ['shopify', 'PUT', '/api/connections/shopify'], ['shopify', 'DELETE', '/api/connections/shopify'], ['shopify', 'PUT', '/api/settings/store'],
  ['alerts', 'PUT', '/api/settings/alerts'], ['alerts', 'POST', '/api/push/subscribe'], ['alerts', 'POST', '/api/push/unsubscribe'],
  ['channels', 'PUT', '/api/settings/channels'],
  ['gmail', 'PUT', '/api/settings/gmail'],
  ['pacing', 'PUT', '/api/settings/pacing'],
  ['laptops', 'POST', '/api/devices/pair-code'], ['laptops', 'DELETE', '/api/devices/dv_abc'],
  ['recovery_message', 'PUT', '/api/recovery/template'],
  ['recovery_settings', 'PUT', '/api/settings/recovery'],
  ['discounts', 'PUT', '/api/settings/discounts'],
  ['sales', 'PUT', '/api/sales/settings'], ['sales', 'PUT', '/api/settings/sales'],
  ['knowledge', 'POST', '/api/kb/upload'], ['knowledge', 'POST', '/api/kb/note'], ['knowledge', 'PATCH', '/api/kb/kb_1'], ['knowledge', 'DELETE', '/api/kb/kb_1'],
  ['knowledge', 'POST', '/api/kb/sync-store'], ['knowledge', 'POST', '/api/kb/gaps/answer'], ['knowledge', 'POST', '/api/kb/gaps/dismiss'],
];

/** Never refused, whatever is locked. */
const NEVER: [string, string][] = [
  ['POST', '/api/agent-toggle'], ['POST', '/api/panic'], ['PUT', '/api/settings/agent'],
  ['POST', '/api/urgent/ur_1/answer'], ['POST', '/api/urgent/ur_1/note'], ['POST', '/api/urgent/ur_1/send-draft'], ['POST', '/api/urgent/ur_1/dismiss'],
  ['POST', '/api/review/ob_1/approve'], ['POST', '/api/review/ob_1/reject'], ['POST', '/api/discounts/dc_1/approve'],
  ['POST', '/api/conversations/cv_1/send'], ['POST', '/api/conversations/cv_1/pause'], ['POST', '/api/contacts/ct_1/opt-out'],
  ['POST', '/api/support/link'], ['DELETE', '/api/support/link'],
  ['POST', '/api/setup'], ['POST', '/api/login'], ['POST', '/api/logout'], ['POST', '/api/password'],
  ['POST', '/api/locks/pin'], ['POST', '/api/locks/sections/voice'],
  ['POST', '/api/agent/sync'], ['POST', '/api/agent/inbound'], ['POST', '/api/agent/jobs/ob_1/result'], ['POST', '/api/agent/pair'], ['POST', '/api/hooks/shopify'],
  ['POST', '/api/connections/brain/test'], ['POST', '/api/connections/vision/test'], ['POST', '/api/connections/shopify/test'], ['POST', '/api/push/test'],
  ['POST', '/api/recovery/teach'], ['POST', '/api/recovery/run'], ['POST', '/api/recovery/refresh'], ['POST', '/api/recovery/checkouts/co_1/skip'],
  ['POST', '/api/discounts'], ['POST', '/api/discounts/dc_1/send'], ['DELETE', '/api/discounts/dc_1'], ['POST', '/api/playground'], ['PUT', '/api/selectors'],
];

describe('which change belongs to which box', () => {
  it('maps every change a box covers to that box', () => {
    for (const [id, method, path] of COVERED) expect(lockSectionFor(method, path), `${method} ${path}`).toBe(id);
    // Every box has at least one route here, so none of them is a button that guards nothing.
    expect(new Set(COVERED.map(([id]) => id))).toEqual(new Set(LOCK_SECTIONS.map((s) => s.id)));
  });

  it('never refuses a read', () => {
    for (const [, , path] of COVERED) for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(lockSectionFor(m, path)).toBeNull();
  });

  it('never locks the agent switch, the emergency stop, replies, the support link, sign in, the locks or the laptop', () => {
    for (const [method, path] of NEVER) expect(lockSectionFor(method, path), `${method} ${path}`).toBeNull();
  });

  it('reads the path the way the router does, so a trailing slash, an empty segment or an escaped letter is the same box', () => {
    expect(lockSectionFor('PUT', '/api/settings/voice/')).toBe('voice');
    expect(lockSectionFor('PUT', '/api//settings/voice')).toBe('voice');
    expect(lockSectionFor('PUT', '/api/settings/%76oice')).toBe('voice');
    expect(lockSectionFor('put', '/api/settings/pacing')).toBe('pacing');
    expect(lockSectionFor('PUT', '/api/settings/%E0%A4%A')).toBeNull(); // bad escape: left as it is, matches nothing
    expect(lockSectionFor('PUT', '/api/settings/voices')).toBeNull();
    expect(lockSectionFor('PUT', '/api/settings')).toBeNull();
  });

  it('covers new routes under a box that owns a whole path (laptops, knowledge, the connection cards)', () => {
    expect(lockSectionFor('POST', '/api/devices/dv_1/primary')).toBe('laptops');
    expect(lockSectionFor('PUT', '/api/connections/brain/routing')).toBe('brain');
    expect(lockSectionFor('POST', '/api/kb/kb_1/something')).toBe('knowledge');
  });

  it('every rule names a known box and every never rule is well formed', () => {
    const ids = new Set(LOCK_SECTIONS.map((s) => s.id));
    for (const id of Object.keys(LOCK_RULES)) expect(ids.has(id as never)).toBe(true);
    for (const rule of [...NEVER_LOCKED, ...Object.values(LOCK_RULES).flat()]) expect(rule).toMatch(/^(\*|POST|PUT|PATCH|DELETE) \/api(\/[^\s/]+)*$/);
  });
});

describe('the lock row', () => {
  it('drops unknown boxes and bad values', () => {
    const s = parseLockState({ pin: 1, sections: { voice: 123, nope: 5, pacing: 'x', brain: 0 } });
    expect(s).toEqual({ pin: true, sections: { voice: 123 } });
    expect(parseLockState(null)).toEqual({ pin: false, sections: {} });
    expect(parseLockState('junk')).toEqual({ pin: false, sections: {} });
  });

  it('says what is locked in the order of the boxes, small for the header and full for the screen', () => {
    const s = parseLockState({ pin: true, sections: { knowledge: 2, voice: 1 } });
    expect(lockSummary(s)).toEqual({ pin: true, locked: ['voice', 'knowledge'] });
    const v = lockView(s);
    expect(v.pin_set).toBe(true);
    expect(v.sections).toHaveLength(LOCK_SECTIONS.length);
    expect(v.sections.find((x) => x.id === 'voice')).toMatchObject({ locked: true, locked_at: 1 });
    expect(v.sections.find((x) => x.id === 'pacing')).toMatchObject({ locked: false, locked_at: null });
  });
});

describe('PIN rules', () => {
  it('takes 4 to 8 digits as text, nothing else', () => {
    for (const ok of ['0000', '1234', '12345678', '00001111']) expect(pinValue(ok)).toBe(ok);
    for (const bad of ['123', '123456789', '12a4', ' 1234', '1234 ', '', '12.4', '١٢٣٤', 1234, null, undefined, ['1234']]) {
      expect(() => pinValue(bad), String(bad)).toThrowError(/4 to 8 numbers/);
    }
    // The dashboard checks the same before it asks the server.
    for (const v of ['1234', '12345678']) expect(DASH_PIN_RE.test(v)).toBe(true);
    for (const v of ['123', '123456789', 'abcd']) expect(DASH_PIN_RE.test(v)).toBe(false);
  });

  it('allows 5 wrong PINs, then refuses every check for 15 minutes', () => {
    expect(MAX_PIN_FAILS).toBe(5);
    expect(PIN_BLOCK_MS).toBe(15 * 60_000);
    const now = 1_800_000_000_000;
    for (let n = 1; n < 5; n++) {
      const w = wrongOutcome(n, now);
      expect(w.block_until).toBeNull();
      expect(w.error.status).toBe(403);
      expect(w.error.extra).toEqual({ tries_left: 5 - n });
    }
    const last = wrongOutcome(5, now);
    expect(last.block_until).toBe(now + 15 * 60_000);
    expect(last.error.status).toBe(429);
    expect(last.error.code).toBe('pin_blocked');
  });

  it('a claimed try is checked, refused while a block is on, and past the limit it starts a block', () => {
    const now = 1_800_000_000_000;
    expect(claimOutcome({ fails: 1, until: 0 }, now)).toBe('check');
    expect(claimOutcome({ fails: 5, until: 0 }, now)).toBe('check');
    expect(claimOutcome({ fails: 6, until: 0 }, now)).toBe('over');
    expect(claimOutcome({ fails: 0, until: now + 1000 }, now)).toBe('blocked');
    expect(claimOutcome({ fails: 1, until: now - 1000 }, now)).toBe('check');
    expect(parseFails({ fails: 'x', until: 5 })).toEqual({ fails: 0, until: 5 });
  });

  it('says it plainly', () => {
    const now = 1_800_000_000_000;
    expect(wrongPinMessage(4)).toBe('Wrong PIN. 4 tries left.');
    expect(wrongPinMessage(1)).toBe('Wrong PIN. 1 try left.');
    expect(blockedMessage(now + 15 * 60_000, now)).toBe('Too many wrong PINs. Try again in 15 minutes.');
    expect(blockedMessage(now + 10_000, now)).toBe('Too many wrong PINs. Try again in 1 minute.');
    // Owner copy: no em or en dashes anywhere the owner reads.
    const src = readFileSync(join(root, 'src/lib/locks.ts'), 'utf8') + readFileSync(join(root, 'src/routes/locks.ts'), 'utf8') + readFileSync(join(root, 'public/js/locks.js'), 'utf8');
    expect(src).not.toMatch(/[–—]/);
  });
});

describe('the dashboard marks the same boxes', () => {
  it('has the same names as the server', () => {
    expect(LOCK_LABELS).toEqual(Object.fromEntries(LOCK_SECTIONS.map((s) => [s.id, s.label])));
  });

  it('every box the server knows has a lock button on a screen, and every mark names a known box', () => {
    const dir = join(root, 'public/js/screens');
    const marks = new Set<string>();
    const parts = new Set<string>();
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), 'utf8');
      for (const m of text.matchAll(/data-lock="([a-z_]+)"/g)) marks.add(m[1]!);
      for (const m of text.matchAll(/data-lock-part="([a-z_]+)"/g)) parts.add(m[1]!);
    }
    const ids = LOCK_SECTIONS.map((s) => s.id);
    expect([...marks].sort()).toEqual([...ids].sort());
    for (const p of parts) expect(ids).toContain(p);
  });
});
