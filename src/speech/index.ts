// Customer voice notes written out by Cloudflare Workers AI speech to text (the free allowance), so the
// brain can answer them. Before this a voice note went to the owner in Urgent, unheard.
//
//   transcribeForBrain   the pipeline's step before decide: write out the voice notes of the unanswered
//                        messages that have no transcript yet, inside a time limit
//
// The extension sends a short voice note (WhatsApp: an Ogg Opus file behind a blob address) as a media
// item of kind voice with the report (src/lib/media.ts). The transcript is stored on the media row
// (description) and in the message meta (voice_text) for the owner's Inbox and Urgent cards, and the
// brain gets it labelled as the customer's voice note transcript: customer content, never instructions.
//
// Everything here fails soft. No allowance left, a note too long, the model failing or no time: the
// voice note stays as it was and the brain sees it exactly as before (it goes to the owner).
import type { Env, Settings } from '../types';
import { aiState, allowanceOf, countDay, neuronsStatement, noteNeuronsResult, routeClock } from '../brain/allowance';
import { isDailyLimit } from '../brain/llm';
import { allowanceLeft, speechNeurons } from '../brain/route';
import { clip, stmt } from '../lib/db';
import { VOICE_MAX_SECONDS } from '../lib/media';
import { getState } from '../lib/settings';

/** Workers AI speech to text. About 46.63 neurons per audio minute (src/brain/route.ts). */
export const SPEECH_MODEL = '@cf/openai/whisper-large-v3-turbo';
/** A voice note that failed this many times is left alone (the sweeper must not pay for it forever). */
const MAX_TRIES = 2;
// Time limits: the brain keeps at least 15 s to answer after the transcript.
const SPEECH_CAP_MS = 15_000;
const BRAIN_RESERVE_MS = 15_000;
const MIN_SPEECH_MS = 3_000;
/** Opus voice notes are about 2 to 4 KB a second. Without a length from the laptop, a cautious guess from the size. */
const BYTES_PER_SECOND_GUESS = 2_000;

/** What the media row remembers about its transcript (media.vision, small JSON). */
export interface VoiceMeta {
  model?: string;
  ms?: number;
  tries?: number;
  error?: string;
  seconds?: number | null;
  language?: string;
}

/** A voice note of the unanswered messages as the pipeline loads it (src/pipeline/inbound.ts). */
export interface BrainVoice {
  index: number;
  id: string;
  message_id: string;
  mime: string;
  /** base64 audio; empty once a transcript is stored (it is not read again). */
  data: string;
  meta: VoiceMeta;
  transcript: string | null;
}

export function parseVoiceMeta(raw: string | null | undefined): VoiceMeta {
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? (v as VoiceMeta) : {}; } catch { return {}; }
}

export class SpeechError extends Error {
  constructor(public code: 'allowance' | 'too_long' | 'empty' | 'timeout' | 'failed' | 'no_binding', message: string) { super(message); }
}

/** One line of plain text, no control characters, at most 1500 characters. */
export function cleanTranscript(text: unknown): string {
  return typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500) : '';
}

/** How long a voice note is: what the laptop measured, else a guess from its size. */
export const voiceSeconds = (v: Pick<BrainVoice, 'data' | 'meta'>): number => {
  const said = Number(v.meta.seconds);
  if (Number.isFinite(said) && said > 0) return said;
  return Math.max(1, Math.round(((v.data.length * 3) / 4) / BYTES_PER_SECOND_GUESS));
};

interface Heard { text: string; seconds: number | null; language: string | null }

/**
 * Where speech goes. Production: the Workers AI binding. Test mode only: a fake speech endpoint the tests
 * run (POST /api/test/speech-base, test/helpers/fake-speech.mjs), or nothing.
 */
async function speechRunner(env: Env): Promise<((audio: string, ms: number) => Promise<unknown>) | null> {
  if (env.ACX_TEST_MODE === '1') {
    const base = await getState<string | null>(env.DB, 'test_speech_base', null);
    if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) return null;
    return async (audio, ms) => {
      const res = await fetch(`${base}/ai/run/${SPEECH_MODEL}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audio }), signal: AbortSignal.timeout(ms) });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
      return JSON.parse(text);
    };
  }
  const ai = env.AI as unknown as { run(model: string, body: unknown): Promise<unknown> } | undefined;
  if (!ai) return null;
  return async (audio, ms) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        ai.run(SPEECH_MODEL, { audio, task: 'transcribe', vad_filter: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SpeechError('timeout', 'The speech model took too long.')), Math.max(0, ms)); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
}

/** Read Workers AI's answer: { text, transcription_info: { duration, language } }. */
export function readSpeech(out: unknown): Heard {
  const o = (out ?? {}) as Record<string, any>;
  const r = (o.result && typeof o.result === 'object' ? o.result : o) as Record<string, any>;
  const info = (r.transcription_info ?? {}) as Record<string, any>;
  const seconds = Number(info.duration);
  return { text: cleanTranscript(r.text), seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null, language: typeof info.language === 'string' ? info.language.slice(0, 12) : null };
}

/**
 * Write out the voice notes that have no transcript yet, all at once, inside the time limit, and store
 * what came back (one batch: the media rows, the message meta, llm_usage and the free allowance). Never
 * throws. Returns how many were written out; each one's `transcript` is set on the item.
 */
export async function transcribeForBrain(env: Env, settings: Settings, items: BrainVoice[], opts: { deadlineAt: number; channel: string; conversationId: string }): Promise<number> {
  void settings;
  const todo = items.filter((v) => !v.transcript && v.data && (v.meta.tries ?? 0) < MAX_TRIES);
  if (!todo.length) return 0;
  try {
    const db = env.DB;
    const writes: D1PreparedStatement[] = [];
    // Too long: never sent (keep today's behaviour), remembered so it is not looked at again.
    const ready: BrainVoice[] = [];
    for (const v of todo) {
      if (voiceSeconds(v) > VOICE_MAX_SECONDS) {
        v.meta = { ...v.meta, tries: MAX_TRIES, error: 'too_long' };
        writes.push(stmt(db, 'UPDATE media SET vision = ? WHERE id = ?', JSON.stringify(v.meta), v.id));
      } else ready.push(v);
    }
    const run = ready.length ? await speechRunner(env) : null;
    const state = await aiState(env);
    const allowance = allowanceOf(state, routeClock(env, state));
    const need = ready.reduce((n, v) => n + speechNeurons(voiceSeconds(v)), 0);
    const now = Date.now();
    const until = Math.min(opts.deadlineAt - BRAIN_RESERVE_MS, now + SPEECH_CAP_MS);
    // No speech model, no free neurons left today or no time: the voice note goes to the owner as before.
    if (!run || !allowanceLeft(allowance, need) || until - now < MIN_SPEECH_MS) {
      if (writes.length) await db.batch(writes);
      return 0;
    }
    const results = await Promise.all(ready.map(async (v) => {
      const started = Date.now();
      try {
        const heard = readSpeech(await run(v.data, until - Date.now()));
        if (!heard.text) throw new SpeechError('empty', 'Nothing could be heard in the voice note.');
        return { v, ok: true as const, heard, ms: Date.now() - started };
      } catch (err) {
        const text = String((err as Error)?.message ?? err);
        const code: SpeechError['code'] = err instanceof SpeechError ? err.code : isDailyLimit(text) ? 'allowance' : /timeout|timed out|abort/i.test(text) ? 'timeout' : 'failed';
        return { v, ok: false as const, code, message: text.slice(0, 160), ms: Date.now() - started };
      }
    }));
    let heardCount = 0;
    let neurons = 0;
    let out = false;
    for (const r of results) {
      const tries = (r.v.meta.tries ?? 0) + 1;
      if (r.ok) {
        const seconds = r.heard.seconds ?? voiceSeconds(r.v);
        neurons += speechNeurons(seconds);
        r.v.meta = { ...r.v.meta, model: SPEECH_MODEL, ms: r.ms, tries, error: undefined, seconds, ...(r.heard.language ? { language: r.heard.language } : {}) };
        r.v.transcript = r.heard.text;
        heardCount++;
        writes.push(stmt(db, 'UPDATE media SET description = ?, vision = ? WHERE id = ?', r.heard.text, JSON.stringify(r.v.meta), r.v.id));
        // The owner sees it under the message in Inbox and on the Urgent card, with no extra query.
        writes.push(stmt(db, `UPDATE messages SET meta = json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END, '$.voice_text', ?) WHERE id = ?`, clip(r.heard.text, 600), r.v.message_id));
        writes.push(stmt(db, 'INSERT INTO llm_usage (ts, provider, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ms, ok) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, 1)',
          Date.now(), 'workers_ai', SPEECH_MODEL, 'voice_note', r.ms));
      } else {
        // The allowance ran out: out until 00:00 UTC, and it is not this voice note's fault (no try used).
        if (r.code === 'allowance') out = true;
        r.v.meta = { ...r.v.meta, tries: r.code === 'allowance' ? (r.v.meta.tries ?? 0) : tries, error: r.code };
        writes.push(stmt(db, 'UPDATE media SET vision = ? WHERE id = ?', JSON.stringify(r.v.meta), r.v.id));
        writes.push(stmt(db, 'INSERT INTO diagnostics (ts, device_id, channel, kind, data) VALUES (?, ?, ?, ?, ?)', Date.now(), null, opts.channel, 'note',
          JSON.stringify({ voice_error: r.code, message: r.message, media: r.v.id })));
      }
    }
    const count = neurons > 0 || out;
    if (count) writes.push(neuronsStatement(db, await countDay(env), neurons, out));
    const res = await db.batch(writes);
    if (count) noteNeuronsResult(res[res.length - 1]);
    return heardCount;
  } catch (err) {
    console.error('writing out voice notes failed', err);
    return 0;
  }
}
