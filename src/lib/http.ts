import type { DeviceRow, Env } from '../types';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra: Record<string, unknown> = {}) {
    super(message ?? code);
  }
}

export const bad = (code: string, message?: string, extra?: Record<string, unknown>) => new HttpError(400, code, message, extra);
export const notFound = (what = 'not_found') => new HttpError(404, what);

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export type AuthLevel = 'public' | 'owner' | 'device';

export interface Ctx {
  req: Request;
  env: Env;
  exec: ExecutionContext;
  db: D1Database;
  url: URL;
  params: Record<string, string>;
  now: number;
  /** Set when the route is 'device' and the bearer token is valid. */
  device: DeviceRow | null;
  /** Read and validate a JSON body (object). */
  body<T = Record<string, unknown>>(maxBytes?: number): Promise<T>;
}

export type Handler = (c: Ctx) => Promise<Response> | Response;

interface Route {
  method: string;
  parts: string[];
  auth: AuthLevel;
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, auth: AuthLevel, handler: Handler): this {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), auth, handler });
    return this;
  }
  get(path: string, auth: AuthLevel, handler: Handler) { return this.add('GET', path, auth, handler); }
  post(path: string, auth: AuthLevel, handler: Handler) { return this.add('POST', path, auth, handler); }
  put(path: string, auth: AuthLevel, handler: Handler) { return this.add('PUT', path, auth, handler); }
  patch(path: string, auth: AuthLevel, handler: Handler) { return this.add('PATCH', path, auth, handler); }
  delete(path: string, auth: AuthLevel, handler: Handler) { return this.add('DELETE', path, auth, handler); }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | 'method' | null {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const want = route.parts[i]!;
        const got = parts[i]!;
        if (want.startsWith(':')) {
          try { params[want.slice(1)] = decodeURIComponent(got); } catch { ok = false; break; }
        } else if (want !== got) { ok = false; break; }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export async function readJson<T>(req: Request, maxBytes = 512_000): Promise<T> {
  const type = req.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new HttpError(415, 'json_required', 'Send application/json');
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large', 'Request body is too large');
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw bad('invalid_json', 'Body is not valid JSON'); }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw bad('invalid_body', 'Body must be a JSON object');
  return data as T;
}

// ---- small validators -------------------------------------------------------------------------

export function str(v: unknown, field: string, opts: { max?: number; min?: number; optional?: boolean } = {}): string {
  if (v === undefined || v === null) {
    if (opts.optional) return '';
    throw bad('missing_field', `${field} is required`, { field });
  }
  if (typeof v !== 'string') throw bad('invalid_field', `${field} must be text`, { field });
  const s = v.trim();
  if (s.length < (opts.min ?? (opts.optional ? 0 : 1))) throw bad('invalid_field', `${field} is too short`, { field });
  if (s.length > (opts.max ?? 10_000)) throw bad('invalid_field', `${field} is too long`, { field });
  return s;
}

export function int(v: unknown, field: string, min: number, max: number, fallback?: number): number {
  if (v === undefined || v === null || v === '') {
    if (fallback !== undefined) return fallback;
    throw bad('missing_field', `${field} is required`, { field });
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw bad('invalid_field', `${field} must be a number`, { field });
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[], fallback?: T): T {
  if ((v === undefined || v === null) && fallback !== undefined) return fallback;
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw bad('invalid_field', `${field} must be one of ${allowed.join(', ')}`, { field });
  }
  return v as T;
}

export function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Stream newline delimited JSON while a slow job runs, so the caller (the extension service worker)
 * gets bytes straight away and the connection is not dropped while the brain thinks.
 *
 * `send` resolves true once the line is taken by the stream, false when the caller has gone.
 * `isOpen()` is true until a write fails or the stream closes (the caller hung up). Work that would
 * hand something to the caller checks it first, so nothing is handed to a caller that is not there.
 */
export function ndjsonStream(
  exec: ExecutionContext,
  work: (send: (obj: unknown) => Promise<boolean>, isOpen: () => boolean) => Promise<void>,
  pingMs = 4000,
): Response {
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let open = true;
  // The reader going away errors the stream: notice it without waiting for the next write.
  writer.closed.catch(() => { open = false; });
  const send = (obj: unknown): Promise<boolean> => {
    if (!open) return Promise.resolve(false);
    return writer.write(enc.encode(JSON.stringify(obj) + '\n')).then(() => true, () => { open = false; return false; });
  };
  const timer = setInterval(() => { void send({ type: 'ping' }); }, pingMs);
  const job = (async () => {
    try {
      await work(send, () => open);
    } catch (err) {
      const e = err instanceof HttpError ? err : null;
      send({ type: 'error', code: e?.code ?? 'internal', message: e?.message ?? 'Something went wrong' });
      if (!e) console.error('ndjson work failed', err);
    } finally {
      clearInterval(timer);
      open = false;
      try { await writer.close(); } catch { /* reader went away */ }
    }
  })();
  // Keep working even if the client disconnects: the result is also stored server side.
  exec.waitUntil(job);
  return new Response(readable, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' },
  });
}
