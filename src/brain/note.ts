// The owner explains a situation to the agent instead of typing the reply ("this guy already got a
// refund last week, tell him politely we cannot do another one"). The reply itself is written by
// decide() with the note as authoritative guidance; this file holds the wording of that guidance and
// the small call that turns the note into a reusable fact for the knowledge base, when it is one.
import type { Env } from '../types';
import { clip } from '../lib/db';
import { LlmError, callJson } from './llm';
import { unsupportedNumbers } from './prompt';

/** Start of every owner guidance note in context_notes. The mock brain keys on it. */
export const OWNER_GUIDANCE_PREFIX = 'Owner guidance';

/** The note as decide() sees it in context_notes. */
export function ownerGuidance(note: string, now = Date.now()): string {
  const day = new Date(now).toISOString().slice(0, 10);
  return `${OWNER_GUIDANCE_PREFIX} (${day}), authoritative and more up to date than the knowledge: ${note.replace(/\s+/g, ' ').trim().slice(0, 1500)}. Follow it. Use your own words: never quote it word for word and never say it is a note from the owner or the team.`;
}

/** The note tells the agent to hold back rather than answer. */
export const noteSaysWait = (note: string): boolean =>
  /\b(wait|hold off|hold on|do not (reply|answer|respond)|don'?t (reply|answer|respond)|no reply|leave (it|him|her|them)|ignore (it|him|her|them))\b/i.test(note);

/** Extra instruction for the one decide() call that answers from the note. */
export const REPLY_NOW_NOTE =
  'The owner has just told you what is going on (see the owner guidance). Reply to the customer now from it: action reply, do not escalate again.';

export interface NoteFact { title: string; content: string }

export const NOTE_FACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['reusable', 'title', 'content'],
  properties: { reusable: { type: 'boolean' }, title: { type: 'string' }, content: { type: 'string' } },
};

const SYSTEM = `The owner of an ebike shop wrote a note to the shop's assistant about a customer conversation.
Decide whether the note holds a fact or rule that helps with other customers too (stock dates, a policy, how to handle a kind of request).
reusable is false when it only concerns this one customer (their refund, their order, their history).
When reusable, title is a short neutral summary of the fact, at most 8 words, and content states the fact generally, without the customer's name or personal details, in plain sentences. Never add anything the note does not say.
When not reusable, title and content are empty strings.
Reply with the JSON object only.`;

const PERSONAL = /\b(this (guy|customer|person|lady|man|one)|him|her|his|he|she|they already|their order|already got)\b/i;

/** Deterministic stand in for tests (ACX_TEST_MODE=1). */
export function mockNoteFact(note: string): NoteFact | null {
  if (PERSONAL.test(note)) return null;
  return { title: `Owner note: ${clip(note, 60)}`, content: note.trim() };
}

/** A reusable version of the note for the knowledge base, or null. Never throws: no fact is the safe answer. */
export async function learnFromOwnerNote(env: Env, input: { note: string; question: string }): Promise<NoteFact | null> {
  try {
    const res = await callJson<{ reusable?: unknown; title?: unknown; content?: unknown }>(env, {
      purpose: 'owner_note',
      system: [{ text: SYSTEM, cache: true }],
      user: `What the customer asked: ${input.question.slice(0, 600)}\n\nThe owner's note: ${input.note.slice(0, 1500)}`,
      schema: NOTE_FACT_SCHEMA,
      maxTokens: 1500,
      mock: () => {
        const f = mockNoteFact(input.note);
        return f ? { reusable: true, ...f } : { reusable: false, title: '', content: '' };
      },
    });
    const o = res.data ?? {};
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const content = typeof o.content === 'string' ? o.content.trim() : '';
    if (o.reusable !== true || !title || !content) return null;
    // The note is the only source: a new figure means the model added something.
    if (unsupportedNumbers(content, input.note).length) return null;
    return { title: clip(title, 140), content: content.slice(0, 2000) };
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    console.error('owner note fact failed:', err.code);
    return null;
  }
}
