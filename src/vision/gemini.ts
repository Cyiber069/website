// Google AI Studio (Gemini API) over plain REST. The one place that talks to Google.
//
//   generateContent   POST /v1beta/models/{model}:generateContent           a photo or frames inline, or a video by file
//   uploadFile        POST /upload/v1beta/files (resumable: start, then upload + finalize)   video bytes, streamed
//   getFile           GET  /v1beta/files/{id}                                 PROCESSING until ACTIVE (or FAILED)
//   deleteFile        DELETE /v1beta/files/{id}
//
// Rules:
//   * The key only ever travels in the x-goog-api-key header, never in a URL (URLs end up in logs).
//   * Every call has a time limit. A call that runs out of time is a retryable `timeout`.
//   * Video bytes are streamed straight through (FixedLengthStream in the Worker, piped native to
//     native): never base64, never buffered, never a JavaScript callback per chunk, so a 20 MB video
//     costs the Worker almost no CPU.
//   * The upload address Google hands back must be on the same host as the API, so the key can never be
//     sent anywhere else.
//   * Errors become GeminiError with a stable `code` and a message fit to show the owner.

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

export interface GeminiConfig {
  apiKey: string;
  model: string;
  /** Only tests point this somewhere else (src/vision/index.ts allows it in test mode only). */
  base?: string;
  /** Tests pass a stand in. */
  fetch?: typeof fetch;
}

export type GeminiErrorCode =
  | 'no_key' | 'auth' | 'forbidden' | 'region' | 'not_found' | 'rate_limited' | 'bad_request' | 'too_large'
  | 'blocked' | 'timeout' | 'network' | 'server' | 'file_failed' | 'file_timeout' | 'bad_output'
  /** The model refused store: false, so it could keep customer media in Google's logs: nothing is sent to it. */
  | 'no_store'
  /** This invocation used up its calls to Google (the free plan allows 50 subrequests per invocation). */
  | 'budget';

export class GeminiError extends Error {
  constructor(
    public code: GeminiErrorCode,
    message: string,
    /** Worth trying again later without changing anything. */
    public retryable = false,
    public status = 0,
    /** How long Google asked us to wait (retry-after), if it said. */
    public retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType?: string; fileUri: string };
  /** Thinking models may send their thoughts as parts marked thought: true. They are never the answer. */
  thought?: boolean;
}

export interface GenerateBody {
  contents: { role?: 'user' | 'model'; parts: GeminiPart[] }[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: Record<string, unknown>;
  /** false: Google does not keep the request in the project's logs (paid projects store by default since October 2026). */
  store?: boolean;
}

export interface GenerateResult {
  text: string;
  finishReason: string;
  usage: { input_tokens: number; output_tokens: number; thoughts_tokens: number };
  /** The model version Google says answered, when it says. */
  modelVersion: string | null;
}

export interface GeminiFile {
  /** files/abc123 */
  name: string;
  uri: string;
  mimeType: string;
  state: 'PROCESSING' | 'ACTIVE' | 'FAILED' | string;
  sizeBytes: number;
  /** Seconds, from videoMetadata.videoDuration ("12.5s"), when Google says. */
  seconds: number | null;
}

const MODEL_RE = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const FILE_RE = /^files\/[a-z0-9_-]{1,80}$/i;

/** "models/gemini-3.8-flash" or " Gemini-3.8-Flash " -> "gemini-3.8-flash", or null when it is not a model id. */
export function cleanModel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().toLowerCase().replace(/^models\//, '');
  return MODEL_RE.test(m) && m.startsWith('gemini') ? m : null;
}

/** Gemini 3 and later (and the latest aliases) take thinkingLevel; older ones do not. */
export const takesThinkingLevel = (model: string): boolean => /^gemini-(?:[3-9]|\d{2,})|-latest$/.test(model);

const clipText = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** retry-after in ms (seconds or an HTTP date), capped at 2 minutes. */
function retryAfter(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? Math.min(120_000, Math.round(ms)) : null;
}

/** Google's error answer to a GeminiError with plain words for the owner. Exported for tests. */
export function mapError(status: number, body: unknown, model: string, after: number | null = null): GeminiError {
  const e = (body && typeof body === 'object' ? (body as { error?: Record<string, unknown> }).error : null) ?? {};
  const msg = clipText(e.message, 300);
  const st = String(e.status ?? '');
  const reasons = Array.isArray(e.details) ? (e.details as Record<string, unknown>[]).map((d) => String(d?.reason ?? '')).join(' ') : '';
  const said = msg ? ` Google said: ${msg.slice(0, 160)}` : '';
  if (/API_KEY_INVALID|API_KEY_EXPIRED/.test(reasons) || /api key (?:not valid|expired|invalid)/i.test(msg) || status === 401) {
    return new GeminiError('auth', 'Google says the key is not valid. Copy it again from Google AI Studio and save it.', false, status);
  }
  if (/location is not supported|not available in your (?:country|region)/i.test(msg) || (st === 'FAILED_PRECONDITION' && /billing|location|region/i.test(msg))) {
    return new GeminiError('region', 'Google will not serve this key yet. In Google AI Studio check that billing is set up for the key\'s project.', false, status);
  }
  if (status === 403) return new GeminiError('forbidden', `This key is not allowed to use the Gemini API. In Google AI Studio check the key's project.${said}`, false, status);
  if (status === 404) return new GeminiError('not_found', `Google does not know the model "${model}". Check the model name.`, false, status);
  if (status === 413) return new GeminiError('too_large', 'Google says the file is too big.', false, status);
  if (status === 429) return new GeminiError('rate_limited', 'Google says this key is over its limit right now. Check your plan in Google AI Studio or wait a little.', true, status, after);
  if (status >= 500) return new GeminiError('server', 'Google is having trouble right now.', true, status, after);
  if (status === 408) return new GeminiError('timeout', 'Google took too long to answer.', true, status);
  return new GeminiError('bad_request', `Google refused the request.${said}`, false, status);
}

interface CallOpts {
  timeoutMs: number;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  extra?: RequestInit;
}

/** One call to Google with the key in a header and a time limit. Resolves to the Response when it is 2xx. */
async function call(cfg: GeminiConfig, method: string, url: string, opts: CallOpts): Promise<Response> {
  if (!cfg.apiKey) throw new GeminiError('no_key', 'No Google AI Studio key is saved.');
  const f = cfg.fetch ?? fetch;
  const signal = AbortSignal.timeout(Math.max(1, Math.round(opts.timeoutMs)));
  let res: Response;
  try {
    res = await f(url, { method, headers: { 'x-goog-api-key': cfg.apiKey, ...(opts.headers ?? {}) }, body: opts.body ?? null, signal, ...(opts.extra ?? {}) });
  } catch (err) {
    if (err instanceof GeminiError) throw err; // our own call budget (src/vision countedFetch)
    const name = (err as Error)?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError' || signal.aborted) throw new GeminiError('timeout', 'Google took too long to answer.', true);
    throw new GeminiError('network', 'Could not reach Google.', true);
  }
  if (res.ok) return res;
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  throw mapError(res.status, body, cfg.model, retryAfter(res));
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const v = await res.json();
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    throw new GeminiError('bad_output', 'Google sent an answer that could not be read.', true, res.status);
  }
}

const base = (cfg: GeminiConfig) => (cfg.base ?? GEMINI_BASE).replace(/\/+$/, '');

const BLOCKED = /^(?:SAFETY|PROHIBITED_CONTENT|BLOCKLIST|IMAGE_SAFETY|RECITATION|SPII)$/;

/** Ask the model once. Throws GeminiError (blocked when Google's safety filters stopped it). */
export async function generateContent(cfg: GeminiConfig, body: GenerateBody, timeoutMs: number): Promise<GenerateResult> {
  const model = cleanModel(cfg.model);
  if (!model) throw new GeminiError('not_found', `"${String(cfg.model).slice(0, 60)}" is not a Gemini model name.`);
  const res = await call({ ...cfg, model }, 'POST', `${base(cfg)}/v1beta/models/${model}:generateContent`, {
    timeoutMs, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const out = await readJson(res);
  const feedback = (out.promptFeedback ?? {}) as Record<string, unknown>;
  if (feedback.blockReason) throw new GeminiError('blocked', 'Google would not look at this one.', false, 200);
  const cand = (Array.isArray(out.candidates) ? out.candidates[0] : null) as Record<string, any> | null;
  const finishReason = String(cand?.finishReason ?? '');
  const parts: GeminiPart[] = Array.isArray(cand?.content?.parts) ? cand!.content.parts : [];
  const text = parts.filter((p) => p && !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
  if (BLOCKED.test(finishReason) && !text) throw new GeminiError('blocked', 'Google would not look at this one.', false, 200);
  const u = (out.usageMetadata ?? {}) as Record<string, unknown>;
  return {
    text, finishReason,
    usage: { input_tokens: Number(u.promptTokenCount) || 0, output_tokens: Number(u.candidatesTokenCount) || 0, thoughts_tokens: Number(u.thoughtsTokenCount) || 0 },
    modelVersion: typeof out.modelVersion === 'string' ? out.modelVersion : null,
  };
}

function readFile(raw: unknown): GeminiFile {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const name = String(f.name ?? '');
  if (!FILE_RE.test(name) || typeof f.uri !== 'string' || !f.uri) throw new GeminiError('bad_output', 'Google did not say where the file is.', true);
  const dur = /^([\d.]+)s$/.exec(String(f.videoMetadata?.videoDuration ?? ''));
  return {
    name, uri: f.uri, mimeType: String(f.mimeType ?? ''), state: String(f.state ?? 'PROCESSING'),
    sizeBytes: Number(f.sizeBytes) || 0, seconds: dur ? Number(dur[1]) : null,
  };
}

/**
 * A body of known length for fetch: streamed as is in the Worker (FixedLengthStream), else as given.
 * `sized`: the stream already is a FixedLengthStream's readable side (src/vision checkedVideoBody).
 */
function sizedBody(body: ReadableStream<Uint8Array> | Blob | ArrayBuffer | Uint8Array, bytes: number, sized = false): { body: BodyInit; extra: RequestInit } {
  if (!(body instanceof ReadableStream)) return { body: body as BodyInit, extra: {} };
  if (sized) return { body, extra: {} };
  const Fixed = (globalThis as unknown as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  if (typeof Fixed === 'function') {
    const fixed = new Fixed(bytes);
    // A body shorter or longer than it said errors the stream, and with it the upload.
    body.pipeTo(fixed.writable).catch(() => {});
    return { body: fixed.readable, extra: {} };
  }
  return { body, extra: { duplex: 'half' } as RequestInit };
}

export interface UploadInput {
  body: ReadableStream<Uint8Array> | Blob | ArrayBuffer | Uint8Array;
  bytes: number;
  mime: string;
  displayName: string;
  /** For the two calls together. */
  timeoutMs: number;
  /** The body is a FixedLengthStream's readable side already: passed to fetch as it is. */
  sized?: boolean;
}

/**
 * Upload a file with the resumable protocol: one call to start (it says how big and what type), one
 * to send the bytes and finalize. Resolves to the file as Google holds it, usually still PROCESSING.
 */
export async function uploadFile(cfg: GeminiConfig, input: UploadInput): Promise<GeminiFile> {
  const until = Date.now() + input.timeoutMs;
  const left = () => Math.max(1, until - Date.now());
  const start = await call(cfg, 'POST', `${base(cfg)}/upload/v1beta/files`, {
    timeoutMs: Math.min(15_000, left()),
    headers: {
      'content-type': 'application/json',
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(input.bytes),
      'x-goog-upload-header-content-type': input.mime,
    },
    body: JSON.stringify({ file: { display_name: clipText(input.displayName, 80) || 'customer video' } }),
  });
  const uploadUrl = start.headers.get('x-goog-upload-url') ?? '';
  let target: URL | null = null;
  try { target = new URL(uploadUrl); } catch { target = null; }
  // Never follow an upload address to another host: the key goes with it.
  if (!target || target.origin !== new URL(base(cfg)).origin) throw new GeminiError('bad_output', 'Google did not give a usable upload address.', true);
  try { await start.body?.cancel(); } catch { /* nothing to read */ }
  const sized = sizedBody(input.body, input.bytes, input.sized === true);
  const res = await call(cfg, 'POST', target.toString(), {
    timeoutMs: left(),
    headers: { 'x-goog-upload-command': 'upload, finalize', 'x-goog-upload-offset': '0', 'content-type': input.mime },
    body: sized.body, extra: sized.extra,
  });
  const out = await readJson(res);
  return readFile(out.file ?? out);
}

export async function getFile(cfg: GeminiConfig, name: string, timeoutMs: number): Promise<GeminiFile> {
  if (!FILE_RE.test(name)) throw new GeminiError('bad_request', 'That is not a Google file name.');
  const res = await call(cfg, 'GET', `${base(cfg)}/v1beta/${name}`, { timeoutMs });
  return readFile(await readJson(res));
}

/** Delete a file Google holds for us. Never throws: Google deletes it after 48 hours anyway. */
export async function deleteFile(cfg: GeminiConfig, name: string, timeoutMs = 8000): Promise<boolean> {
  if (!FILE_RE.test(name)) return false;
  try {
    const res = await call(cfg, 'DELETE', `${base(cfg)}/v1beta/${name}`, { timeoutMs });
    try { await res.body?.cancel(); } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WaitOptions {
  /** When the waiting must be over. */
  deadlineAt: number;
  intervalMs?: number;
  /** Each poll is one subrequest: the free plan allows 50 per request. */
  maxPolls?: number;
  /** Tests pass a fake clock. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Wait until Google has processed a file (ACTIVE). FAILED is a `file_failed` error; running out of
 * time or polls is a retryable `file_timeout`.
 */
export async function waitActive(cfg: GeminiConfig, file: GeminiFile, opts: WaitOptions): Promise<GeminiFile> {
  const interval = Math.max(200, opts.intervalMs ?? 2000);
  const maxPolls = Math.max(1, opts.maxPolls ?? 15);
  const wait = opts.wait ?? sleep;
  let cur = file;
  for (let polls = 0; ; ) {
    if (cur.state === 'ACTIVE') return cur;
    if (cur.state === 'FAILED') throw new GeminiError('file_failed', 'Google could not read this video.', false);
    const timedOut = () => new GeminiError('file_timeout', 'Google was still getting the video ready.', true);
    if (polls >= maxPolls) throw timedOut();
    // The first look is straight away: a video uploaded a moment ago is often ready already.
    if (polls > 0) {
      if (opts.deadlineAt - Date.now() < interval + 500) throw timedOut();
      await wait(interval);
    } else if (opts.deadlineAt - Date.now() < 500) throw timedOut();
    polls++;
    cur = await getFile(cfg, cur.name, Math.min(8000, Math.max(1000, opts.deadlineAt - Date.now())));
  }
}
