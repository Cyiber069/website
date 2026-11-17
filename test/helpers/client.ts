// Small typed client used by the API tests.
export const BASE = () => process.env.ACX_TEST_URL!;

type As = 'owner' | 'device' | 'public';

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; as?: As; headers?: Record<string, string> } = {}): Promise<{ status: number; data: T; queries: number; rows: number; written: number }> {
  const as = opts.as ?? 'owner';
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (as === 'owner') headers.cookie = process.env.ACX_TEST_COOKIE!;
  if (as === 'device') headers.authorization = `Bearer ${process.env.ACX_TEST_DEVICE!}`;
  const res = await fetch(`${BASE()}${path}`, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  // D1 queries the request made (test mode header). The free plan allows 50 per request. Rows read and
  // written too: the free plan allows 5 million and 100,000 a day.
  return {
    status: res.status, data, queries: Number(res.headers.get('x-acx-d1-queries') ?? 0),
    rows: Number(res.headers.get('x-acx-d1-rows') ?? 0), written: Number(res.headers.get('x-acx-d1-rows-written') ?? 0),
  };
}

export interface Job { id: string; channel: string; kind: string; source: string; parts: string[]; target: Record<string, string | null>; pacing: { delay_ms: number; typing_cps: number } }
export interface Outcome { type: 'decision'; conversation_id: string | null; action: string; reason: string; jobs: Job[]; new_inbound: number; queries?: number; fetches?: number; rows?: number; written?: number; final?: boolean; retry_after_ms?: number | null; jobs_pending?: boolean }

let seq = 0;
export const unique = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

export interface Msg { external_id?: string | null; direction: 'in' | 'out'; body: string; kind?: string; ts?: number | null }

/** Post what the extension saw in a thread and return the final decision line of the stream. */
export async function inbound(channel: string, threadId: string, messages: Msg[], extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Promise<Outcome> {
  const res = await fetch(`${BASE()}/api/agent/inbound`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.ACX_TEST_DEVICE!}` },
    body: JSON.stringify({
      channel,
      thread: { external_id: threadId, title: `Customer ${threadId.slice(0, 6)}`, contact: { name: `Customer ${threadId.slice(0, 6)}` }, ...extra },
      messages,
      ...top,
    }),
  });
  const lines = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const decision = lines.find((l) => l.type === 'decision');
  if (!decision) throw new Error(`no decision in stream: ${JSON.stringify(lines)}`);
  // D1 queries the whole request made (test mode adds this last line).
  // Calls to Google AI Studio it made (src/vision counts them: at most 20 of the 50 subrequests allowed).
  const tail = lines.find((l) => l.type === 'queries');
  return { ...decision, queries: tail?.n, fetches: tail?.fetches, rows: tail?.rows, written: tail?.written } as Outcome;
}

export const sync = (channels: string[] = ['whatsapp', 'gmail', 'tiktok']) =>
  api<{ jobs: Job[]; config: any; selectors: any }>('/api/agent/sync', {
    as: 'device',
    body: { version: 'test', status: { channels: Object.fromEntries(channels.map((c) => [c, { state: 'ready', unread: 0, busy: false }])) } },
  });

export const finish = (jobId: string, body: Record<string, unknown> = { status: 'sent' }) =>
  api(`/api/agent/jobs/${jobId}/result`, { as: 'device', body });

export const sql = (query: string, params: unknown[] = []) => api<{ results: any[]; changes: number }>('/api/test/sql', { as: 'public', body: { sql: query, params } });

export const cron = () => api('/api/test/cron', { as: 'public', body: {} });
