// A fake Cloudflare Workers AI speech to text endpoint for the API and end to end tests. The Worker is
// pointed at it in test mode only (POST /api/test/speech-base), never in production, where src/speech
// calls the AI binding with @cf/openai/whisper-large-v3-turbo.
//
//   POST /ai/run/@cf/openai/whisper-large-v3-turbo  { audio: <base64> }
//     -> { text, word_count, transcription_info: { language, duration } }
//
// What it hears is written inside the fake audio: makeVoiceNote(text) builds a small Ogg file whose bytes
// carry "SAY:<text>". The text steers it:
//   FAIL   a 500 answer             LIMIT  the daily free allocation error (3036)
//   SLOW   waits `slowMs` first     SILENT an empty transcript
// Every request is recorded (path, audio size, the words found) so tests can check what "Cloudflare" got.
import { createServer } from 'node:http';

/** A small fake voice note: an Ogg header, some padding, then the words the fake will "hear". */
export function makeVoiceNote(text, { padBytes = 600 } = {}) {
  const head = Buffer.from('OggS\u0000\u0002', 'binary');
  const pad = Buffer.alloc(padBytes, 7);
  return Buffer.concat([head, pad, Buffer.from(`SAY:${text}`, 'utf8')]).toString('base64');
}

export async function startFakeSpeech() {
  const state = { requests: [], slowMs: 20_000, durationSeconds: 4.2 };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
    const audio = typeof body?.audio === 'string' ? Buffer.from(body.audio, 'base64') : Buffer.alloc(0);
    const said = /SAY:(.*)$/s.exec(audio.toString('utf8'))?.[1] ?? '';
    state.requests.push({ path: req.url, bytes: audio.length, head: audio.subarray(0, 4).toString('binary'), said, at: Date.now() });
    const send = (status, out) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); };
    if (!req.url.startsWith('/ai/run/@cf/openai/whisper-large-v3-turbo')) return send(404, { errors: [{ code: 5007, message: 'No such model' }] });
    if (/FAIL/.test(said)) return send(500, { errors: [{ code: 3000, message: 'Unknown internal error' }] });
    if (/LIMIT/.test(said)) return send(429, { errors: [{ code: 3036, message: "3036: You have used up your daily free allocation of 10,000 neurons. Please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage." }] });
    if (/SLOW/.test(said)) await new Promise((r) => setTimeout(r, state.slowMs));
    const text = /SILENT/.test(said) ? '' : said.trim();
    return send(200, { text, word_count: text ? text.split(/\s+/).length : 0, transcription_info: { language: 'en', duration: state.durationSeconds } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    get requests() { return state.requests; },
    stop: () => new Promise((r) => server.close(() => r())),
  };
}
