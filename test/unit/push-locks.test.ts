// The "Notify this device" switch and settings locks (public/js/push.js), with a stand in browser: when Phone
// notifications is locked (maybe on another device a moment ago) this browser's push subscription is left as it was,
// so the switch never disagrees with the server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS dashboard module
import { disablePush, enablePush } from '../../public/js/push.js';

interface Sub { endpoint: string; unsubscribe: ReturnType<typeof vi.fn>; toJSON: () => unknown }
let current: Sub | null;
let made: Sub[];
let locked: string[];
let refuse: string | null; // the API path answered 423
const calls: string[] = [];

const sub = (endpoint: string): Sub => {
  const s: Sub = {
    endpoint,
    unsubscribe: vi.fn(async () => { if (current === s) current = null; return true; }),
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
  };
  return s;
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  current = null; made = []; locked = []; refuse = null; calls.length = 0;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async () => { const s = sub(`https://push.example/${made.length}`); made.push(s); current = s; return s; }),
  };
  const reg = { pushManager };
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => reg, register: async () => reg, ready: Promise.resolve(reg) } });
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn(async () => 'granted') });
  vi.stubGlobal('window', { PushManager: function PushManager() {}, Notification: {} });
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: { method?: string } = {}) => {
    calls.push(`${init.method ?? 'GET'} ${path}`);
    if (path === '/api/locks') return reply(200, { pin_set: true, locked, sections: [] });
    if (path === refuse) return reply(423, { error: 'locked', message: 'This is locked. Unlock it with your PIN.', section: 'alerts', locks: { pin: true, locked: ['alerts'] } });
    return reply(200, { ok: true, subscriptions: 1 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the push switch and settings locks', () => {
  it('switching on while Phone notifications is locked asks nothing of the browser', async () => {
    locked = ['alerts'];
    await expect(enablePush('BPublicKey')).rejects.toMatchObject({ userMessage: 'This is locked. Unlock it with your PIN.' });
    expect(made).toHaveLength(0);
    expect((globalThis as unknown as { Notification: { requestPermission: ReturnType<typeof vi.fn> } }).Notification.requestPermission).not.toHaveBeenCalled();
    expect(calls).toEqual(['GET /api/locks']);
  });

  it('a subscription the server refuses (locked a moment ago) is undone, so the switch shows off', async () => {
    refuse = '/api/push/subscribe';
    await expect(enablePush('BPublicKey')).rejects.toMatchObject({ status: 423 });
    expect(made).toHaveLength(1);
    expect(made[0]!.unsubscribe).toHaveBeenCalledOnce();
    expect(current).toBeNull();
  });

  it('a subscription that was already there is kept when the server refuses', async () => {
    current = sub('https://push.example/old');
    refuse = '/api/push/subscribe';
    await expect(enablePush('BPublicKey')).rejects.toMatchObject({ status: 423 });
    expect(current?.unsubscribe).not.toHaveBeenCalled();
  });

  it('switching off asks the server first: refused (locked), this device keeps its alerts', async () => {
    const mine = sub('https://push.example/mine');
    current = mine;
    locked = ['alerts'];
    await expect(disablePush()).rejects.toMatchObject({ userMessage: 'This is locked. Unlock it with your PIN.' });
    expect(mine.unsubscribe).not.toHaveBeenCalled();
    locked = [];
    refuse = '/api/push/unsubscribe';
    await expect(disablePush()).rejects.toMatchObject({ status: 423 });
    expect(mine.unsubscribe).not.toHaveBeenCalled();
    expect(current).toBe(mine);
  });

  it('switches on and off as before when nothing is locked', async () => {
    await enablePush('BPublicKey');
    expect(calls).toEqual(['GET /api/locks', 'POST /api/push/subscribe']);
    const mine = current!;
    await disablePush();
    expect(calls.slice(2)).toEqual(['GET /api/locks', 'POST /api/push/unsubscribe']);
    expect(mine.unsubscribe).toHaveBeenCalledOnce();
    expect(current).toBeNull();
  });
});
