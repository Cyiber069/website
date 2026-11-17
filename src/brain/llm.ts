// The one place that talks to a language model. Everything else in the brain builds a prompt and a
// JSON schema, calls callJson, and gets parsed JSON back plus what the call cost.
//
// Providers:
//   anthropic   Claude through the official SDK, when the owner has saved an API key.
//   workers_ai  Cloudflare Workers AI through the AI binding, the free fallback.
//   mock        Local development and tests (ACX_TEST_MODE=1). Never calls out.
import Anthropic from '@anthropic-ai/sdk';
import type { Env, LlmUsage, Settings } from '../types';
import { run } from '../lib/db';
import { getSecret, getSettings } from '../lib/settings';

export type ProviderName = 'anthropic' | 'workers_ai' | 'mock';

export interface ProviderChoice {
  provider: ProviderName;
  model: string;
  /** Only set for anthropic. */
  apiKey: string | null;
}

/** Thrown for every model failure. `code` is stable and safe to branch on, `message` is fit to show the owner. */
export class LlmError extends Error {
  constructor(
    public code: 'no_provider' | 'auth' | 'bad_request' | 'not_found' | 'rate_limited' | 'overloaded' | 'timeout' | 'network' | 'refusal' | 'truncated' | 'bad_output' | 'provider_error',
    message: string,
    /** Worth trying again later without changing anything. */
    public retryable = false,
    /** How long the provider asked us to wait before trying again (a retry-after header), if it said. */
    public retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** True for the error a call gets when the request it belongs to has no time left for it. */
export const isDeadline = (err: unknown): boolean => err instanceof LlmError && err.code === 'timeout';

/** One block of the system prompt. Blocks marked `cache` end a prefix that stays the same between calls. */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

/** A picture for the user turn, with the line of text that introduces it. */
export interface PromptImage {
  label: string;
  media_type: 'image/jpeg' | 'image/png' | 'image/webp';
  /** base64, no data: prefix. */
  data: string;
}

/**
 * Only Claude gets pictures. Workers AI answers from the text alone, including what the vision model
 * (Google AI Studio, src/vision) wrote about a photo. The mock stands in for Claude, or for Workers AI
 * when the test sets the provider to workers_ai (model "mock-text").
 */
export const canSeeImages = (choice: ProviderChoice): boolean => choice.provider === 'anthropic' || (choice.provider === 'mock' && choice.model !== MOCK_TEXT_MODEL);
export const MOCK_TEXT_MODEL = 'mock-text';

/**
 * The user turn for Claude: plain text when there are no pictures, otherwise each picture after its
 * label and the request text last. Pictures live in the user turn only, never in the cached system blocks.
 */
export function userContent(user: string, images: PromptImage[] = []): string | Anthropic.Beta.BetaContentBlockParam[] {
  if (!images.length) return user;
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const img of images) {
    blocks.push({ type: 'text', text: img.label });
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
  }
  blocks.push({ type: 'text', text: user });
  return blocks;
}

export interface CallJsonInput {
  /** What the call is for, stored in llm_usage: decide, polish, recovery_draft, recovery_personalize, test, playground. */
  purpose: string;
  /** Stable text first (instructions, knowledge), then anything that changes per call. */
  system: SystemBlock[];
  user: string;
  /** Photos from the customer, shown to Claude before the user text. Ignored by Workers AI. */
  images?: PromptImage[];
  /** JSON schema of the answer. Objects need additionalProperties false and every property listed in required. */
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** What to answer in mock mode. Without it a mock call fails, so tests never pass by accident. */
  mock?: () => unknown;
  /** Pass a choice made earlier to avoid reading settings twice. */
  choice?: ProviderChoice;
  /** Claude only: how long one attempt may take, and how many times the SDK tries again. Defaults 50 s and 1. */
  timeoutMs?: number;
  maxRetries?: number;
}

export interface CallJsonResult<T> {
  data: T;
  /** Null in mock mode. */
  usage: LlmUsage | null;
  provider: ProviderName;
  model: string;
}

const ANTHROPIC_TIMEOUT_MS = 50_000;
const ANTHROPIC_MAX_RETRIES = 1;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Which model answers. Claude when a key is saved, unless the owner forced Workers AI; Workers AI when
 * the binding exists; the mock in test mode.
 */
export async function chooseProvider(env: Env, settings: Settings): Promise<ProviderChoice> {
  // Tests: the mock, which can see pictures like Claude, or reads text only like Workers AI when that provider is chosen.
  if (env.ACX_TEST_MODE === '1') return { provider: 'mock', model: settings.brain.provider === 'workers_ai' ? MOCK_TEXT_MODEL : 'mock', apiKey: null };
  const brain = settings.brain;
  const key = ((await getSecret(env.DB, 'anthropic_api_key')) ?? env.ANTHROPIC_API_KEY ?? '').trim();
  const workers: ProviderChoice | null = env.AI ? { provider: 'workers_ai', model: brain.workers_ai_model, apiKey: null } : null;
  const claude: ProviderChoice | null = key ? { provider: 'anthropic', model: brain.model, apiKey: key } : null;

  if (brain.provider === 'workers_ai') {
    if (workers) return workers;
    throw new LlmError('no_provider', 'Workers AI is selected but this Worker has no AI binding');
  }
  if (brain.provider === 'anthropic') {
    if (claude) return claude;
    throw new LlmError('no_provider', 'Claude is selected but no API key is saved');
  }
  const pick = claude ?? workers;
  if (!pick) throw new LlmError('no_provider', 'No AI is connected yet. Save a Claude API key or enable Workers AI.');
  return pick;
}

/** The cheapest model of the same provider, for small jobs such as the sales follow up. */
export const CHEAP_CLAUDE_MODEL = 'claude-haiku-5-5';
export function cheapChoice(choice: ProviderChoice): ProviderChoice {
  if (choice.provider !== 'anthropic' || /haiku/i.test(choice.model)) return choice;
  return { ...choice, model: CHEAP_CLAUDE_MODEL };
}

/** How many tokens of knowledge a provider can take on top of instructions, conversation and answer. */
export function knowledgeBudget(choice: ProviderChoice): number {
  if (choice.provider !== 'workers_ai') return Number.MAX_SAFE_INTEGER;
  const window = /llama-3\.3-70b/.test(choice.model) ? 24_000 : /llama-3\.[12]|llama-3-8b|mistral|hermes/.test(choice.model) ? 7_000 : 120_000;
  return Math.max(1_500, Math.floor(window * 0.6) - 3_000);
}

// ---- tolerant JSON -------------------------------------------------------------------------------

/**
 * Parse model output that should be one JSON object but may be wrapped in a code fence or in prose.
 * Returns undefined when no object can be found.
 */
export function parseLooseJson(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return undefined;
  let text = raw.trim().replace(/^﻿/, '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1]!.trim();
  const tryParse = (s: string): unknown => {
    try {
      const v: unknown = JSON.parse(s);
      return v !== null && typeof v === 'object' ? v : undefined;
    } catch { return undefined; }
  };
  const direct = tryParse(text);
  if (direct !== undefined) return direct;
  // Take the first balanced {...}, minding strings.
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      const slice = text.slice(start, i + 1);
      // Trailing commas are the most common slip of small models.
      return tryParse(slice) ?? tryParse(slice.replace(/,\s*([}\]])/g, '$1'));
    }
  }
  return undefined;
}

// ---- Claude --------------------------------------------------------------------------------------

/** Server side refusal fallbacks exist for Opus and Sonnet models, not for Haiku. */
export const supportsFallbacks = (model: string): boolean => /opus|sonnet|fable|mythos/i.test(model) && !/haiku/i.test(model);

/** The retry-after header of an API error in ms (seconds or an HTTP date), capped at 2 minutes. */
export function retryAfterMs(headers: unknown, now = Date.now()): number | null {
  const h = headers as { get?: (k: string) => string | null } | Record<string, string> | null | undefined;
  if (!h) return null;
  const raw = typeof (h as { get?: unknown }).get === 'function' ? (h as { get: (k: string) => string | null }).get('retry-after') : (h as Record<string, string>)['retry-after'];
  if (!raw) return null;
  const secs = Number(raw);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(120_000, Math.round(ms)) : null;
}

/** Map SDK errors to LlmError, most specific class first. */
function fromAnthropicError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const after = err instanceof Anthropic.APIError ? retryAfterMs(err.headers) : null;
  if (err instanceof Anthropic.AuthenticationError) return new LlmError('auth', 'The Claude API key was rejected. Check it on the Connections screen.');
  if (err instanceof Anthropic.PermissionDeniedError) return new LlmError('auth', 'The Claude API key is not allowed to use this model.');
  if (err instanceof Anthropic.NotFoundError) return new LlmError('not_found', 'Claude does not know that model name. Pick another model on the Connections screen.');
  if (err instanceof Anthropic.RateLimitError) return new LlmError('rate_limited', 'Claude is rate limiting this account right now.', true, after);
  if (err instanceof Anthropic.BadRequestError) return new LlmError('bad_request', `Claude rejected the request: ${err.message.slice(0, 200)}`);
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmError('timeout', 'Claude took too long to answer.', true);
  if (err instanceof Anthropic.APIConnectionError) return new LlmError('network', 'Could not reach Claude.', true);
  if (err instanceof Anthropic.InternalServerError) return new LlmError('overloaded', 'Claude is having trouble right now.', true, after);
  if (err instanceof Anthropic.APIError) return new LlmError('provider_error', `Claude error ${err.status ?? ''}: ${err.message.slice(0, 200)}`, (err.status ?? 0) >= 500, after);
  return new LlmError('provider_error', String((err as Error)?.message ?? err).slice(0, 200));
}

async function callAnthropic(choice: ProviderChoice, settings: Settings, input: CallJsonInput, baseURL?: string): Promise<{ data: unknown; usage: Omit<LlmUsage, 'ms'> }> {
  // The key comes from D1, so the client is made per call. Timeout and retries are set on purpose:
  // the SDK defaults (10 minutes, 2 retries) would outlive the request that is waiting for us.
  // A live request passes its own limits (see callWithin): one attempt that fits the time it has left.
  const client = new Anthropic({
    apiKey: choice.apiKey ?? '', timeout: input.timeoutMs ?? ANTHROPIC_TIMEOUT_MS, maxRetries: input.maxRetries ?? ANTHROPIC_MAX_RETRIES,
    ...(baseURL ? { baseURL } : {}),
  });
  const fallback = supportsFallbacks(choice.model);
  // Haiku 4.5 is the one current model that rejects the effort setting.
  const effort = /haiku-4-5/.test(choice.model) ? undefined : settings.brain.effort;
  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await client.beta.messages.create({
      model: choice.model,
      max_tokens: input.maxTokens ?? 8000,
      // No temperature or other sampling settings: current models reject them. Thinking is left to
      // the model (adaptive) and steered with effort.
      system: input.system.filter((b) => b.text.trim()).map((b) => ({
        type: 'text' as const, text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
      })),
      messages: [{ role: 'user', content: userContent(input.user, input.images) }],
      output_config: { ...(effort ? { effort } : {}), format: { type: 'json_schema', schema: input.schema } },
      // If the model declines for safety reasons the API retries on a fallback model inside the same call.
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    });
  } catch (err) {
    throw fromAnthropicError(err);
  }
  const usage = {
    provider: 'anthropic', model: message.model || choice.model,
    input_tokens: message.usage?.input_tokens ?? 0, output_tokens: message.usage?.output_tokens ?? 0,
    cache_read_tokens: message.usage?.cache_read_input_tokens ?? 0, cache_write_tokens: message.usage?.cache_creation_input_tokens ?? 0,
  };
  // Always look at stop_reason before the content: a refusal has no usable answer.
  if (message.stop_reason === 'refusal') {
    throw Object.assign(new LlmError('refusal', `Claude declined to answer${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}.`), { usage });
  }
  if (message.stop_reason === 'max_tokens') throw Object.assign(new LlmError('truncated', 'The answer was cut off before it finished.', true), { usage });
  const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const data = parseLooseJson(text);
  if (data === undefined) throw Object.assign(new LlmError('bad_output', 'Claude did not return valid JSON.', true), { usage });
  return { data, usage };
}

// ---- Workers AI ----------------------------------------------------------------------------------

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Older models take { max_tokens, json_schema: <schema> } and answer in `response`. Newer ones speak the OpenAI chat format. */
const isLegacyWorkersModel = (model: string): boolean => /llama-[23]|mistral|hermes|deepseek-coder|deepseek-r1|qwen1|gemma-[27]b|gemma-3/i.test(model);

/** Text (or an already parsed object) and token counts from either Workers AI response shape. */
export function readWorkersAiResponse(out: unknown): { content: unknown; input_tokens: number; output_tokens: number } {
  const o = (out ?? {}) as Record<string, any>;
  const usage = (o.usage ?? {}) as Record<string, any>;
  const choiceMsg = Array.isArray(o.choices) ? o.choices[0]?.message : undefined;
  let content: unknown;
  if (choiceMsg) content = choiceMsg.content ?? choiceMsg.reasoning_content ?? '';
  else if (o.response !== undefined && o.response !== null) content = o.response; // string, or the parsed object in JSON mode
  else if (typeof o.result === 'object' && o.result) return readWorkersAiResponse(o.result);
  else content = typeof out === 'string' ? out : '';
  return {
    content,
    input_tokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
    output_tokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
  };
}

async function callWorkersAi(env: Env, choice: ProviderChoice, input: CallJsonInput): Promise<{ data: unknown; usage: Omit<LlmUsage, 'ms'> }> {
  const ai = env.AI;
  if (!ai) throw new LlmError('no_provider', 'This Worker has no AI binding');
  const legacy = isLegacyWorkersModel(choice.model);
  // JSON mode is not enforced on every model, so the schema is also spelled out in the prompt.
  const system = [
    ...input.system.map((b) => b.text.trim()).filter(Boolean),
    `Reply with one JSON object and nothing else: no code fence, no text before or after. It must match this JSON schema:\n${JSON.stringify(input.schema)}`,
  ].join('\n\n');
  const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content: input.user }];
  const maxTokens = Math.min(input.maxTokens ?? 1200, 2000);
  const usage = { provider: 'workers_ai', model: choice.model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };

  const once = async (msgs: ChatMessage[], jsonMode: boolean): Promise<unknown> => {
    const body: Record<string, unknown> = legacy
      ? { messages: msgs, max_tokens: maxTokens, temperature: 0.3, ...(jsonMode ? { response_format: { type: 'json_schema', json_schema: input.schema } } : {}) }
      : {
          messages: msgs, max_completion_tokens: maxTokens, temperature: 0.3,
          ...(/gemma-4|qwen3/i.test(choice.model) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
          ...(jsonMode ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: input.schema } } } : {}),
        };
    // The binding is typed per model; the model id here is a setting, so it is called untyped.
    const out = await (ai as unknown as { run(model: string, body: unknown): Promise<unknown> }).run(choice.model, body);
    const read = readWorkersAiResponse(out);
    usage.input_tokens += read.input_tokens;
    usage.output_tokens += read.output_tokens;
    return read.content;
  };

  let content: unknown;
  let jsonMode = true;
  try {
    content = await once(messages, true);
  } catch (err) {
    const text = String((err as Error)?.message ?? err);
    // "JSON Mode couldn't be met" and models without response_format: ask again in plain mode.
    if (!/json mode|response_format|json_schema|guided/i.test(text)) throw workersError(text);
    jsonMode = false;
    try { content = await once(messages, false); } catch (err2) { throw workersError(String((err2 as Error)?.message ?? err2)); }
  }
  let data = parseLooseJson(content);
  if (data === undefined) {
    // One repair attempt: show the model what it wrote and ask for the object alone.
    const bad = typeof content === 'string' ? content.slice(0, 4000) : JSON.stringify(content ?? '').slice(0, 4000);
    try {
      content = await once([...messages, { role: 'assistant', content: bad || '(empty)' }, { role: 'user', content: 'That was not a valid JSON object. Send only the JSON object that matches the schema, starting with { and ending with }.' }], jsonMode);
    } catch (err) {
      throw Object.assign(workersError(String((err as Error)?.message ?? err)), { usage });
    }
    data = parseLooseJson(content);
  }
  if (data === undefined) throw Object.assign(new LlmError('bad_output', 'The Workers AI model did not return valid JSON.', true), { usage });
  return { data, usage };
}

function workersError(text: string): LlmError {
  if (/needs to be run remotely/i.test(text)) return new LlmError('no_provider', 'Workers AI is not available in local development');
  if (/neurons|quota|capacity|rate limit|429|3040/i.test(text)) return new LlmError('rate_limited', 'Workers AI daily allowance or rate limit reached.', true);
  if (/no such model|5007|not found/i.test(text)) return new LlmError('not_found', 'Workers AI does not know that model name.');
  if (/timeout|timed out/i.test(text)) return new LlmError('timeout', 'Workers AI took too long to answer.', true);
  return new LlmError('provider_error', `Workers AI error: ${text.slice(0, 200)}`, true);
}

// ---- the one entry point -------------------------------------------------------------------------

async function recordUsage(env: Env, purpose: string, usage: LlmUsage, ok: boolean): Promise<void> {
  try {
    await run(
      env.DB,
      'INSERT INTO llm_usage (ts, provider, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      Date.now(), usage.provider, usage.model, purpose.slice(0, 40), usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens, usage.ms, ok ? 1 : 0,
    );
  } catch (err) {
    console.error('llm_usage insert failed', err); // bookkeeping must never break a reply
  }
}

/**
 * Ask the configured model for one JSON object. Throws LlmError on any failure (including a refusal,
 * code "refusal"). Every real call is written to llm_usage, failed ones with ok = 0.
 */
export async function callJson<T = unknown>(env: Env, input: CallJsonInput): Promise<CallJsonResult<T>> {
  const settings = await getSettings(env.DB);
  const choice = input.choice ?? (await chooseProvider(env, settings));
  if (choice.provider === 'mock') {
    if (!input.mock) throw new LlmError('no_provider', `No mock answer is defined for "${input.purpose}"`);
    return { data: input.mock() as T, usage: null, provider: 'mock', model: 'mock' };
  }
  const started = Date.now();
  try {
    // Optional: send Claude calls through a proxy such as Cloudflare AI Gateway by setting the
    // ANTHROPIC_BASE_URL variable on the Worker. Not set means the Anthropic API directly.
    const baseURL = (env as Env & { ANTHROPIC_BASE_URL?: string }).ANTHROPIC_BASE_URL?.trim() || undefined;
    const { data, usage } = choice.provider === 'anthropic' ? await callAnthropic(choice, settings, input, baseURL) : await callWorkersAi(env, choice, input);
    const full: LlmUsage = { ...usage, ms: Date.now() - started };
    await recordUsage(env, input.purpose, full, true);
    return { data: data as T, usage: full, provider: choice.provider, model: choice.model };
  } catch (err) {
    const e = err instanceof LlmError ? err : new LlmError('provider_error', String((err as Error)?.message ?? err).slice(0, 200), true);
    const partial = (e as LlmError & { usage?: Omit<LlmUsage, 'ms'> }).usage;
    await recordUsage(env, input.purpose, {
      provider: choice.provider, model: choice.model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, ...partial, ms: Date.now() - started,
    }, false);
    throw e;
  }
}

// ---- calls inside a time limit -------------------------------------------------------------------

/**
 * How much of a request's time one model call may use. `deadlineAt` is when every model call of the
 * request must be done. The call gets min(capMs, time left - reserveMs), and none at all below minMs.
 */
export interface CallBudget {
  deadlineAt: number;
  capMs: number;
  /** Below this, do not start the call: it could not finish in time. */
  minMs: number;
  /** Time kept back for the work after the call (queueing the reply). Default 1 s. */
  reserveMs?: number;
  /** Try once more after a quick failure (rate limit, overload, network), never after a slow one. */
  retryQuickFailure?: boolean;
}

/** Time this call may take, or 0 when it should not start. Exported for tests. */
export function callTimeout(b: CallBudget, now = Date.now()): number {
  const left = b.deadlineAt - now - (b.reserveMs ?? 1000);
  return left < b.minMs ? 0 : Math.min(b.capMs, left);
}

/** Thrown when a request has no time left for a model call. Retryable: a fresh request has a fresh budget. */
export const deadlineError = () => new LlmError('timeout', 'There was no time left to wait for the AI in this request.', true);

const QUICK_FAILURE_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * callJson inside a request's time limit. One attempt sized to the time left, with no SDK retry, so a
 * slow but valid answer gets all the time there is and is never cut short to be asked again. A quick
 * failure may be tried once more when there is time; a slow one is handed back (the caller retries
 * later with a fresh budget).
 */
export async function callWithin<T = unknown>(env: Env, input: CallJsonInput, budget: CallBudget): Promise<CallJsonResult<T>> {
  const attempt = () => {
    const timeoutMs = callTimeout(budget);
    if (!timeoutMs) throw deadlineError();
    return callJson<T>(env, { ...input, timeoutMs, maxRetries: 0 });
  };
  const started = Date.now();
  try {
    return await attempt();
  } catch (err) {
    if (!budget.retryQuickFailure || !(err instanceof LlmError) || !err.retryable || err.code === 'timeout') throw err;
    if (Date.now() - started > QUICK_FAILURE_MS) throw err;
    const wait = err.retryAfterMs ?? 1000;
    if (wait > 3000 || callTimeout(budget, Date.now() + wait) === 0) throw err;
    await sleep(wait);
    return attempt();
  }
}
