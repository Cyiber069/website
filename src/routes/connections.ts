// Owner facing API for the Connections screen: the brain (Claude key and model), Shopify, and
// push notifications to the owner's phone. Secret values go in and never come back out: every
// response carries only "saved" plus the last four characters as a hint.
import type { BrainSettings } from '../types';
import { run, uid } from '../lib/db';
import { logEvent } from '../lib/events';
import { bad, json, oneOf, str, type Ctx, type Router } from '../lib/http';
import { getVapidPublicKey, notifyOwner, pushSubscriptionCount, validPushEndpoint } from '../lib/push';
import { getSettings, getState, patchSettings, secretHints, setSecret } from '../lib/settings';
import { clearTokenCache, normaliseShopDomain, testConnection } from '../shopify/client';
import { VISION_MODELS, VISION_SECRET, checkVisionKey, checkVisionPatch, testVision, videosToday } from '../vision';
import { aiState, allowanceOf, clearClaudeDown, routeClock } from '../brain/allowance';
import { CLAUDE_MODELS, FREE_WINDOW_START_UTC, allowanceLeft, inFreeWindow, isModelSetting, modelSetting, storedModel } from '../brain/route';
import { SPEECH_MODEL } from '../speech';
import type { Env } from '../types';
import { EMPTY_WEBHOOK_STATE, WEBHOOK_STATE, type WebhookState } from './hooks';

/**
 * Which AI does what, in the owner's words (no dashes, few commas). Shown on Connections as it is.
 * `ai` is claude | cloudflare | google.
 */
export const AI_SPLIT: { ai: 'claude' | 'cloudflare' | 'google'; name: string; does: string }[] = [
  { ai: 'claude', name: 'Claude', does: 'Every customer reply, photos, discount codes and polishing your answers.' },
  { ai: 'cloudflare', name: 'Cloudflare AI (free)', does: `Voice notes and TikTok comments. From ${FREE_WINDOW_START_UTC}:00 UTC to midnight it answers customers too while the free allowance lasts. It also steps in if Claude stops working.` },
  { ai: 'google', name: 'Google AI Studio', does: 'Videos. Finding sponsors comes later.' },
];

/**
 * Today's free Workers AI allowance (an estimate the Worker keeps itself) and whether Claude is working.
 * `claude_down.covered`: the free Cloudflare AI is there with neurons left, so it answers while Claude is
 * down (the same test as llm.ts workersFallback). Without it customers are not getting answers.
 */
async function aiView(env: Env) {
  const s = await aiState(env);
  const now = routeClock(env, s);
  const a = allowanceOf(s, now);
  const covered = (env.ACX_TEST_MODE === '1' || Boolean(env.AI)) && allowanceLeft(a);
  return {
    allowance: { used: a.used, limit: a.limit, left: a.left, pct: a.pct, out: a.out, out_at: s.day === a.day ? s.out_at ?? null : null, resets_at: a.resets_at, estimate: true, window_from_utc: FREE_WINDOW_START_UTC, window_now: inFreeWindow(now) && !a.out },
    claude_down: s.claude_down ? { at: s.claude_down.at, last_at: s.claude_down.last_at ?? s.claude_down.at, code: s.claude_down.code, covered } : null,
  };
}

const SHOPIFY_SECRETS = ['shopify_client_id', 'shopify_client_secret', 'shopify_admin_token', 'shopify_webhook_secret'] as const;

const saved = (h: { hint: string } | undefined) => ({ saved: Boolean(h), hint: h ? `...${h.hint}` : '' });

async function view(c: Ctx) {
  const db = c.db;
  const [settings, hints, hook, publicKey, subscriptions, videos] = await Promise.all([
    getSettings(db, true), secretHints(db), getState<WebhookState>(db, WEBHOOK_STATE, EMPTY_WEBHOOK_STATE),
    getVapidPublicKey(c.env), pushSubscriptionCount(db), videosToday(db, c.now),
  ]);
  const ai = await aiView(c.env);
  const usesToken = Boolean(hints.shopify_admin_token);
  const usesApp = Boolean(hints.shopify_client_id && hints.shopify_client_secret);
  const api = usesToken || usesApp;
  const webhook = Boolean(hints.shopify_webhook_secret);
  return {
    brain: {
      provider: settings.brain.provider,
      // The model setting as the form shows it: the mix id, or the plain model. The stored row keeps a
      // real model id with mix true (an older Worker after a rollback still understands it).
      model: modelSetting(settings.brain),
      mix: settings.brain.mix,
      model_chosen: settings.brain.model_chosen,
      effort: settings.brain.effort,
      // A key set as a Worker variable also counts, but there is nothing of it to hint at.
      claude_key: hints.anthropic_api_key ? saved(hints.anthropic_api_key) : { saved: Boolean(c.env.ANTHROPIC_API_KEY), hint: '' },
      workers_ai: { available: Boolean(c.env.AI), model: settings.brain.workers_ai_model, speech_model: SPEECH_MODEL, ...ai },
      models: CLAUDE_MODELS,
      split: AI_SPLIT,
    },
    shopify: {
      mode: api ? 'api' : webhook ? 'webhook' : 'none',
      domain: settings.store.domain,
      myshopify_domain: settings.store.myshopify_domain,
      api: {
        ...saved(usesToken ? hints.shopify_admin_token : usesApp ? hints.shopify_client_secret : undefined),
        kind: usesToken ? 'admin_token' : usesApp ? 'app' : 'none',
        client_id_saved: Boolean(hints.shopify_client_id),
      },
      webhook: {
        url: `${c.url.origin}/api/hooks/shopify`,
        secret_saved: webhook,
        last_received_at: hook.last_received_at ?? null,
      },
    },
    // Google AI Studio reads photos and videos. The key is never sent back: only saved and its last 4 characters.
    vision: {
      key: saved(hints[VISION_SECRET]),
      enabled: settings.vision.enabled,
      active: Boolean(hints[VISION_SECRET]) && settings.vision.enabled,
      model: settings.vision.model,
      video_daily_cap: settings.vision.video_daily_cap,
      videos_today: videos,
      models: VISION_MODELS,
    },
    push: { public_key: publicKey, subscriptions },
    alerts: settings.alerts,
  };
}

/** A pasted secret: trimmed, one line, sensible length. Empty text means "remove it". */
function secretValue(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = str(v, field, { max: 400, optional: true });
  if (/\s/.test(s)) throw bad('invalid_field', `${field} should be one line with no spaces`, { field });
  return s;
}

export function register(r: Router): void {
  r.get('/api/connections', 'owner', async (c) => json(await view(c)));

  // ---- brain ---------------------------------------------------------------------------------------
  r.put('/api/connections/brain', 'owner', async (c) => {
    const body = await c.body<{ anthropic_api_key?: unknown; provider?: unknown; model?: unknown; effort?: unknown }>();
    const key = secretValue(body.anthropic_api_key, 'anthropic_api_key');
    if (key !== undefined) {
      if (key && !key.startsWith('sk-ant-')) throw bad('invalid_field', 'That does not look like a Claude API key. They start with sk-ant-', { field: 'anthropic_api_key' });
      await setSecret(c.db, 'anthropic_api_key', key);
      // A new key: Claude is tried again at once instead of waiting out the outage.
      if (key) await clearClaudeDown(c.env, { why: 'new_key' });
    }
    const patch: Partial<BrainSettings> = {};
    if (body.provider !== undefined) patch.provider = oneOf(body.provider, 'provider', ['auto', 'anthropic', 'workers_ai'] as const);
    if (body.effort !== undefined) patch.effort = oneOf(body.effort, 'effort', ['low', 'medium', 'high'] as const);
    if (body.model !== undefined) {
      const model = str(body.model, 'model', { max: 80 });
      if (!isModelSetting(model)) throw bad('invalid_field', 'Pick one of the listed Claude models', { field: 'model' });
      // A model the owner picks is kept from now on (a default they never chose is moved to the mix).
      const current = (await getSettings(c.db, true)).brain;
      if (model !== modelSetting(current) || current.model_chosen) Object.assign(patch, storedModel(model), { model_chosen: true });
    }
    if (Object.keys(patch).length) await patchSettings(c.db, 'brain', patch);
    return json({ ok: true, ...(await view(c)) });
  });

  r.post('/api/connections/brain/test', 'owner', async (c) => {
    const settings = await getSettings(c.db, true);
    const started = Date.now();
    const base = { provider: settings.brain.provider as string, model: settings.brain.model, ms: 0, sample: '' };
    try {
      const brain = (await import('../brain/index')) as Record<string, unknown>;
      if (typeof brain.testBrain !== 'function') {
        return json({ ok: false, ...base, error: 'The brain test is not available in this version.' });
      }
      const result = (await (brain.testBrain as (env: typeof c.env) => Promise<Record<string, unknown>>)(c.env)) ?? {};
      return json({
        ok: result.ok === true,
        provider: typeof result.provider === 'string' ? result.provider : base.provider,
        model: typeof result.model === 'string' ? result.model : base.model,
        ms: typeof result.ms === 'number' ? result.ms : Date.now() - started,
        sample: typeof result.sample === 'string' ? result.sample : '',
        ...(typeof result.error === 'string' && result.error ? { error: result.error } : {}),
      });
    } catch (err) {
      console.error('brain test failed', err);
      return json({ ok: false, ...base, ms: Date.now() - started, error: 'The brain did not answer. Check the API key and try again.' });
    }
  });

  // ---- Google AI Studio (photos and videos) ----------------------------------------------------------
  r.put('/api/connections/vision', 'owner', async (c) => {
    const body = await c.body<Record<string, unknown>>();
    const key = checkVisionKey(body.gemini_api_key);
    const patch = checkVisionPatch(body);
    if (key !== undefined) await setSecret(c.db, VISION_SECRET, key);
    if (Object.keys(patch).length) await patchSettings(c.db, 'vision', patch);
    if (key === '') await logEvent(c.db, { level: 'warn', type: 'vision_removed', message: 'Google AI Studio key removed. Photos and videos go to you again.' });
    return json({ ok: true, ...(await view(c)) });
  });

  r.post('/api/connections/vision/test', 'owner', async (c) => json(await testVision(c.env, await getSettings(c.db, true))));

  // ---- Shopify ---------------------------------------------------------------------------------------
  r.put('/api/connections/shopify', 'owner', async (c) => {
    const body = await c.body<{ myshopify_domain?: unknown; client_id?: unknown; client_secret?: unknown; admin_token?: unknown; webhook_secret?: unknown }>();
    if (body.myshopify_domain !== undefined && body.myshopify_domain !== null) {
      const domain = normaliseShopDomain(str(body.myshopify_domain, 'myshopify_domain', { max: 200 }));
      if (!domain) throw bad('invalid_field', 'The store address should look like your-store.myshopify.com', { field: 'myshopify_domain' });
      await patchSettings(c.db, 'store', { myshopify_domain: domain });
    }
    const incoming: [string, string | undefined][] = [
      ['shopify_client_id', secretValue(body.client_id, 'client_id')],
      ['shopify_client_secret', secretValue(body.client_secret, 'client_secret')],
      ['shopify_admin_token', secretValue(body.admin_token, 'admin_token')],
      ['shopify_webhook_secret', secretValue(body.webhook_secret, 'webhook_secret')],
    ];
    for (const [key, value] of incoming) if (value !== undefined) await setSecret(c.db, key, value);
    // Any change here can make a cached token wrong (different app, different store).
    await clearTokenCache(c.db);
    return json({ ok: true, ...(await view(c)) });
  });

  r.post('/api/connections/shopify/test', 'owner', async (c) => {
    const hints = await secretHints(c.db);
    const api = Boolean(hints.shopify_admin_token || (hints.shopify_client_id && hints.shopify_client_secret));
    // A fresh token, so permissions the owner just added to the app count at once (a cached one keeps the old scopes).
    if (api) { await clearTokenCache(c.db); return json(await testConnection(c.env)); }
    // Webhook only: there is nothing to call, so "working" means Shopify has reached us at least once.
    if (hints.shopify_webhook_secret) {
      const hook = await getState<WebhookState>(c.db, WEBHOOK_STATE, EMPTY_WEBHOOK_STATE);
      if (hook.last_received_at) return json({ ok: true, last_received_at: hook.last_received_at });
      return json({ ok: false, error: 'No webhook has arrived yet. In Shopify open the webhook menu and choose Send test.' });
    }
    return json({ ok: false, error: 'Shopify is not connected yet.' });
  });

  r.delete('/api/connections/shopify', 'owner', async (c) => {
    for (const key of SHOPIFY_SECRETS) await setSecret(c.db, key, '');
    await clearTokenCache(c.db);
    await logEvent(c.db, { level: 'warn', type: 'shopify_disconnected', message: 'Shopify disconnected. Checkout reminders have nothing new to work from.' });
    return json({ ok: true, ...(await view(c)) });
  });

  // ---- push --------------------------------------------------------------------------------------------
  r.post('/api/push/subscribe', 'owner', async (c) => {
    const body = await c.body<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }>();
    const endpoint = str(body.endpoint, 'endpoint', { max: 1000 });
    const p256dh = str(body.keys?.p256dh, 'keys.p256dh', { max: 200 });
    const auth = str(body.keys?.auth, 'keys.auth', { max: 100 });
    if (!validPushEndpoint(c.env, endpoint)) throw bad('invalid_field', 'That is not a push address', { field: 'endpoint' });
    if (!/^[A-Za-z0-9_-]{86,88}=?$/.test(p256dh) || !/^[A-Za-z0-9_-]{21,24}={0,2}$/.test(auth)) {
      throw bad('invalid_field', 'The subscription keys are not valid', { field: 'keys' });
    }
    await run(
      c.db,
      `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, fail_count = 0`,
      uid('ps'), endpoint, p256dh.replace(/=+$/, ''), auth.replace(/=+$/, ''), (c.req.headers.get('user-agent') ?? '').slice(0, 200), c.now,
    );
    return json({ ok: true, subscriptions: await pushSubscriptionCount(c.db) });
  });

  r.post('/api/push/unsubscribe', 'owner', async (c) => {
    const body = await c.body<{ endpoint?: unknown }>();
    await run(c.db, 'DELETE FROM push_subscriptions WHERE endpoint = ?', str(body.endpoint, 'endpoint', { max: 1000 }));
    return json({ ok: true, subscriptions: await pushSubscriptionCount(c.db) });
  });

  r.post('/api/push/test', 'owner', async (c) => {
    const subscriptions = await pushSubscriptionCount(c.db);
    if (!subscriptions) return json({ ok: false, sent: 0, error: 'No phone is subscribed yet. Turn on notifications first.' });
    const sent = await notifyOwner(c.env, { title: 'ACX Agent', body: 'Notifications are working.', url: '/#/live', tag: 'test' });
    return json({ ok: sent > 0, sent, ...(sent ? {} : { error: 'The notification could not be delivered. Turn notifications off and on again on your phone.' }) });
  });
}
