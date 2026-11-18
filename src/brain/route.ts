// Which AI does what (the owner's split). Pure rules: no database, no network, so every case can be
// unit tested (test/unit/route.test.ts). src/brain/llm.ts chooseProvider feeds them the facts.
//
//   Claude              every customer reply, photos, discount checks, polishing the owner's answers.
//                       Model setting "Haiku with Sonnet for the chats that matter" (the default):
//                       claude-haiku-5-5 answers, claude-sonnet-5-5 at low effort answers a live sale (stage
//                       interested or ready, or a buying question) or a complaint, and gets one retry when
//                       Haiku would escalate or is unsure (decide.ts) before the chat goes to the owner.
//   Cloudflare Workers AI (free, 10,000 neurons a day, reset 00:00 UTC)
//                       voice notes (src/speech), TikTok comments later (src/brain/free.ts), and every
//                       call from 22:00 UTC while the free allowance lasts. Also the fallback when Claude
//                       fails for credit, billing or key reasons, and the only brain without a Claude key.
//   Google AI Studio    videos (src/vision) and finding sponsors later. Never customer replies or photos.
import type { BrainSettings, DecideInput, HistoryMessage, SalesStage, ToneProfile } from '../types';
import { MIX_MODEL } from '../lib/settings';

export { MIX_MODEL };
export const HAIKU_MODEL = 'claude-haiku-5-5';
export const SONNET_MODEL = 'claude-sonnet-5-5';

/** Models offered on Connections. Ids are exact API model ids, except the mix. */
export const CLAUDE_MODELS: { id: string; label: string; note: string }[] = [
  { id: MIX_MODEL, label: 'Haiku with Sonnet for the chats that matter', note: 'Recommended. Haiku answers most chats. Sonnet answers sales, complaints and anything Haiku is unsure about.' },
  { id: HAIKU_MODEL, label: 'Claude Haiku 5.5', note: 'Cheapest and quickest. Best kept for simple questions.' },
  { id: SONNET_MODEL, label: 'Claude Sonnet 5.5', note: 'Good for every chat. Costs more than the mix.' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Best judgement on tricky questions. Costs the most of these.' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', note: 'Most capable and most expensive. More than customer chat needs.' },
];

export const isModelSetting = (id: string): boolean => id === MIX_MODEL || /^claude-[a-z0-9.-]+$/.test(id);

// ---- the free Cloudflare allowance ------------------------------------------------------------------------

/** Free Workers AI neurons a day. The count starts again at 00:00 UTC. */
export const DAILY_NEURONS = 10_000;
/** From this hour (UTC) to midnight, Workers AI answers everything while the allowance lasts. */
export const FREE_WINDOW_START_UTC = 22;
/** Below this many neurons left the allowance counts as used up: about one reply, so a call never starts that would hit the limit. */
export const NEURON_RESERVE = 60;
/** After Claude failed for credit, billing or key reasons, it is tried again after this long. */
export const CLAUDE_RETRY_MS = 15 * 60_000;

/**
 * Neurons per million tokens (Cloudflare pricing). An unknown model is counted at the dearest rate here,
 * so the estimate errs on the side of "used up".
 */
const TEXT_RATES: { match: RegExp; input: number; output: number }[] = [
  { match: /gemma-4-26b-a4b/i, input: 9_091, output: 27_273 },
  { match: /llama-3\.3-70b/i, input: 26_668, output: 204_805 },
  { match: /llama-3\.1-8b/i, input: 25_608, output: 75_147 },
];
const UNKNOWN_RATE = { input: 26_668, output: 204_805 };
/** Speech to text: @cf/openai/whisper-large-v3-turbo, about 46.63 neurons per audio minute. */
export const SPEECH_NEURONS_PER_MINUTE = 46.63;

export function textNeurons(model: string, inputTokens: number, outputTokens: number): number {
  const rate = TEXT_RATES.find((r) => r.match.test(model)) ?? UNKNOWN_RATE;
  return (Math.max(0, inputTokens) * rate.input + Math.max(0, outputTokens) * rate.output) / 1_000_000;
}

export const speechNeurons = (seconds: number): number => (Math.max(0, seconds) / 60) * SPEECH_NEURONS_PER_MINUTE;

export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

/** The next 00:00 UTC after `now`. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** The last 2 hours before 00:00 UTC. */
export const inFreeWindow = (now: number): boolean => new Date(now).getUTCHours() >= FREE_WINDOW_START_UTC;

/** What the Worker knows about today's free allowance (src/brain/allowance.ts keeps it). */
export interface Allowance {
  day: string;
  /** Neurons used today, estimated from token counts and the rates above. */
  used: number;
  /** A daily limit error came back today: used up until 00:00 UTC, whatever the estimate says. */
  out: boolean;
}

export interface AllowanceView {
  day: string; used: number; limit: number; left: number; pct: number; out: boolean; resets_at: number;
}

/** Today's allowance from the stored count. A count from an earlier UTC day is zero. */
export function allowanceView(a: Partial<Allowance> | null | undefined, now: number): AllowanceView {
  const day = utcDay(now);
  const same = a?.day === day;
  const used = same ? Math.max(0, Number(a?.used) || 0) : 0;
  const out = same && a?.out === true;
  const left = out ? 0 : Math.max(0, DAILY_NEURONS - used);
  return { day, used: Math.round(used), limit: DAILY_NEURONS, left: Math.round(left), pct: Math.min(100, Math.round((used / DAILY_NEURONS) * 100)), out: out || left <= 0, resets_at: nextUtcMidnight(now) };
}

/** Enough left for one more call that costs about `need` neurons. */
export const allowanceLeft = (a: AllowanceView, need = NEURON_RESERVE): boolean => !a.out && a.left > Math.max(NEURON_RESERVE, need);

// ---- the chats that matter ----------------------------------------------------------------------------------

/** Why a chat gets the stronger model in the mix. */
export type MattersWhy = 'sale' | 'buying_question' | 'complaint';
export interface ChatSignals { matters: boolean; why: MattersWhy | null }

const BUYING = /\b(?:buy|buying|purchase|order(?:ing)? (?:one|it|a|the|now)|how much|price|prices|cost|costs|afford|in stock|checkout|check out|klarna|finance|pay (?:in|monthly)|instal?ments?|send (?:me )?(?:the )?link|where (?:can|do) i (?:buy|order|get)|i'?ll take|take (?:one|it)|want (?:one|it|to buy|to order)|deal)\b|\u00a3\s?\d/i;
const COMPLAINT = /\b(?:refund|money back|complain(?:t|ts|ing)?|not happy|unhappy|disappointed|broken|faulty|not working|stopped working|doesn'?t work|does not work|won'?t (?:turn on|charge|work)|damaged|wrong item|missing|where(?:'s| is) my|still (?:no|not|waiting)|never (?:arrived|came)|hasn'?t arrived|(?:is|was|so|very|too|really|days|weeks) late|trading standards|charge ?back|dispute|scam|rubbish|terrible|awful|worst|joke|ripped off)\b/i;

const plainText = (m: HistoryMessage): string => (m.voice_text ?? (m.kind === 'text' ? m.body : m.body.replace(/^\[sent [^\]]*\]$/i, ''))).replace(/\u2019/g, "'");

/** The customer messages after our last one, with what speech models heard in voice notes. */
function unanswered(history: HistoryMessage[]): string {
  let i = history.length;
  while (i > 0 && history[i - 1]!.direction === 'in') i--;
  return history.slice(i).map(plainText).join('\n');
}

export const isBuyingQuestion = (text: string): boolean => BUYING.test(text);
export const isComplaint = (text: string): boolean => COMPLAINT.test(text);

/**
 * A live sale (sales stage interested or ready, or a buying question), or a complaint (complaint words or
 * an upset customer). These get Sonnet in the mix. Exported for tests.
 */
export function chatSignals(input: Pick<DecideInput, 'history'> & { sales_stage?: SalesStage | null }, tone?: Pick<ToneProfile, 'mood'> | null): ChatSignals {
  const text = unanswered(input.history);
  if (tone && (tone.mood === 'angry' || tone.mood === 'frustrated')) return { matters: true, why: 'complaint' };
  if (isComplaint(text)) return { matters: true, why: 'complaint' };
  if (input.sales_stage === 'interested' || input.sales_stage === 'ready') return { matters: true, why: 'sale' };
  if (isBuyingQuestion(text)) return { matters: true, why: 'buying_question' };
  return { matters: false, why: null };
}

// ---- the rules ----------------------------------------------------------------------------------------------

/** main: the reply model. cheap: small checks and follow ups. strong: a second read that must be right (a code request). */
export type Tier = 'main' | 'cheap' | 'strong';
export type Effort = BrainSettings['effort'];

export type RouteWhy =
  | 'forced_workers'   // the owner set the provider to Workers AI
  | 'no_key'           // no Claude key: Workers AI as before
  | 'free_window'      // 22:00 to 00:00 UTC with free neurons left
  | 'claude_down'      // Claude failed for credit, billing or key reasons a short while ago
  | 'claude'           // the model setting
  | 'chat_matters';    // the mix picked Sonnet for this chat

export interface RouteFacts {
  brain: BrainSettings;
  claudeKey: boolean;
  workersAi: boolean;
  now: number;
  allowance: AllowanceView;
  /** When Claude last failed for an account reason (credit, billing, key), if it is not known to work again. */
  claudeDownAt: number | null;
  /** Test mode without a test clock: the free window never applies, so tests do not depend on the hour. */
  windowClock?: number | null;
}

export interface RouteOptions {
  tier?: Tier;
  chat?: ChatSignals | null;
  /** The request carries pictures nobody described yet: only Claude can look at them, so the free window leaves it alone. */
  images?: boolean;
  /** Workers AI just failed in the free window: Claude answers this one. */
  avoidWorkers?: boolean;
}

export interface Route {
  provider: 'anthropic' | 'workers_ai';
  /** The API model id (Workers AI: the configured Workers AI model). */
  model: string;
  /** Claude only: the effort for this call. */
  effort: Effort | null;
  why: RouteWhy;
  /** The owner's model setting is the mix. */
  mix: boolean;
  /** haiku or sonnet inside the mix, set for a plain model setting, workers for Workers AI. */
  tier: 'haiku' | 'sonnet' | 'set' | 'workers';
}

const workersRoute = (b: BrainSettings, why: RouteWhy): Route => ({ provider: 'workers_ai', model: b.workers_ai_model, effort: null, why, mix: b.model === MIX_MODEL, tier: 'workers' });

/** The Claude model for a tier. In the mix Sonnet always runs at low effort. */
export function claudeRoute(b: BrainSettings, opts: RouteOptions = {}): Route {
  const tier = opts.tier ?? 'main';
  if (b.model === MIX_MODEL) {
    const strong = tier === 'strong' || (tier === 'main' && opts.chat?.matters === true);
    return strong
      ? { provider: 'anthropic', model: SONNET_MODEL, effort: 'low', why: tier === 'main' ? 'chat_matters' : 'claude', mix: true, tier: 'sonnet' }
      : { provider: 'anthropic', model: HAIKU_MODEL, effort: b.effort, why: 'claude', mix: true, tier: 'haiku' };
  }
  const model = tier === 'cheap' && !/haiku/i.test(b.model) ? HAIKU_MODEL : b.model;
  return { provider: 'anthropic', model, effort: b.effort, why: 'claude', mix: false, tier: 'set' };
}

/**
 * Who answers. Null when nothing can (the caller says why to the owner).
 *   1. Provider set to Workers AI: Workers AI.
 *   2. No Claude key: Workers AI, as before (null when Claude was forced).
 *   3. 22:00 to 00:00 UTC with free neurons left: Workers AI, unless the request has pictures only Claude can see.
 *   4. Claude failed for credit, billing or key reasons in the last 15 minutes and free neurons are left: Workers AI.
 *   5. Otherwise Claude, by the model setting (the mix picks Haiku or Sonnet).
 */
export function pickRoute(f: RouteFacts, opts: RouteOptions = {}): Route | null {
  const b = f.brain;
  if (b.provider === 'workers_ai') return f.workersAi ? workersRoute(b, 'forced_workers') : null;
  if (!f.claudeKey) {
    if (b.provider === 'anthropic') return null;
    return f.workersAi ? workersRoute(b, 'no_key') : null;
  }
  const free = f.workersAi && allowanceLeft(f.allowance) && !opts.avoidWorkers;
  const clock = f.windowClock === undefined ? f.now : f.windowClock;
  if (free && clock !== null && inFreeWindow(clock) && !opts.images) return workersRoute(b, 'free_window');
  if (free && f.claudeDownAt !== null && f.now - f.claudeDownAt < CLAUDE_RETRY_MS) return workersRoute(b, 'claude_down');
  return claudeRoute(b, opts);
}

/** Escalation categories that always need the owner: a second model cannot answer them either. */
const OWNER_ONLY = ['human_request', 'bot_question', 'order_status', 'refund_return', 'complaint', 'legal', 'safety', 'discount_price', 'media'];

/**
 * Haiku would escalate or is unsure: worth one more try on Sonnet before the chat goes to the owner.
 * `threshold` is brain.confidence_threshold (below it the pipeline parks a reply for the owner).
 */
export function wantsSecondOpinion(d: { action: string; confidence: number; flags: { needs_human: boolean; opt_out: boolean }; escalate: { category: string } | null }, threshold: number): boolean {
  if (d.flags.opt_out || d.action === 'ignore') return false;
  if (d.action === 'escalate') return !OWNER_ONLY.includes(d.escalate?.category ?? '');
  if (d.action === 'reply') return d.confidence < threshold || d.flags.needs_human;
  return false;
}
