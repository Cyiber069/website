// Shared types for the ACX Agent backend. This file is the contract between modules.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI?: Ai;
  /** "1" in local tests: enables the deterministic mock brain and relaxed cookies. Never set in production. */
  ACX_TEST_MODE?: string;
  /** Optional overrides, normally configured from the dashboard and stored in D1. */
  ANTHROPIC_API_KEY?: string;
}

export type Channel = 'whatsapp' | 'gmail' | 'tiktok';
export const CHANNELS: Channel[] = ['whatsapp', 'gmail', 'tiktok'];

export type ChannelMode = 'auto' | 'review' | 'off';
export type MessageKind = 'text' | 'image' | 'voice' | 'video' | 'sticker' | 'document' | 'other';

// ---- Settings ---------------------------------------------------------------------------

export interface VoiceSettings {
  brand_name: string;
  /** How strongly replies copy the customer's register. */
  mirror_level: 'match' | 'light' | 'off';
  max_chars: number;
  max_sentences: number;
  /** none: strip nearly all commas. normal: leave as written. (An old stored 'light' is read as normal, see lib/settings.ts.) */
  commas: 'none' | 'normal';
  emojis: 'mirror' | 'never' | 'sometimes';
  /** Owner written rules appended to the style card, plain text. */
  extra_rules: string;
  banned_phrases: string[];
  /** What to do when a customer sincerely asks if they are talking to a bot. */
  bot_question_policy: 'honest_short' | 'escalate';
  /** Send a short "let me check" line while a question waits in Urgent. */
  holding_reply: boolean;
}

export interface BrainSettings {
  /** auto: Claude when an API key is saved, else Workers AI. */
  provider: 'auto' | 'anthropic' | 'workers_ai';
  model: string;
  effort: 'low' | 'medium' | 'high';
  workers_ai_model: string;
  /** Below this confidence a reply is escalated instead of sent. */
  confidence_threshold: number;
  /** If the whole enabled knowledge base fits in this many tokens it is sent in full, else top matches. */
  kb_full_tokens: number;
  kb_top_chunks: number;
}

export interface PacingSettings {
  /**
   * Version of the stored pacing values. Rows saved before version 2 held the old slow defaults and are
   * moved once to the fast ones (src/lib/settings.ts). Not shown to the owner.
   */
  schema: number;
  /** Seconds of quiet from the customer before the agent reads the thread (people send bursts). Short. */
  settle_seconds: number;
  /** An extra wait before an agent reply, picked between these two. 0 by default: reply as fast as possible. */
  min_reply_delay_s: number;
  max_reply_delay_s: number;
  /** Typing speed for the checkout reminders only. Replies are pasted whole (typing_cps 0 in the job). */
  typing_cps: number;
  max_auto_replies_per_thread_per_hour: number;
  /** After the owner types in a thread themselves the agent stays out of it for this long. */
  human_takeover_minutes: number;
  /** Unread messages older than this are stored but never auto answered. */
  ignore_older_than_hours: number;
}

export interface RecoverySettings {
  enabled: boolean;
  send_hour_london: number;
  /** Nothing is sent later than this many minutes after the start hour (Europe/London). */
  window_minutes: number;
  min_age_minutes: number;
  max_age_hours: number;
  /** First-contact messages are what gets WhatsApp numbers restricted, so this stays small. */
  daily_cap: number;
  /** Never message the same number again within this many days. */
  cooldown_days: number;
  /** all: everyone who left a phone number. opted_in: only people who accepted marketing at checkout. */
  consent_mode: 'all' | 'opted_in';
  /** The owner has explicitly chosen consent_mode. The live run does not send until this is true. */
  consent_confirmed: boolean;
  /** ISO country codes. Empty means every country. */
  countries: string[];
  spacing_seconds: [number, number];
  /** Reword each message slightly so no two are identical. */
  personalize: boolean;
  /** false: the first message has no link, the checkout link goes out when they reply. */
  include_link: boolean;
  /** Append a short "reply stop" line to every first message. */
  opt_out_line: boolean;
  template: { text: string; approved: boolean; updated_at: number | null };
}

export interface AlertSettings {
  push: boolean;
  /** Optional second WhatsApp number (the owner's personal phone) to ping about urgent questions. */
  whatsapp_number: string;
  offline_minutes: number;
}

export interface StoreSettings {
  name: string;
  domain: string;
  myshopify_domain: string;
  currency: string;
  default_country: string;
  /** Keep the knowledge base in sync with the public catalogue and policies. */
  sync_public: boolean;
  last_sync_at: number | null;
}

export interface DiscountSettings {
  /** auto: the agent makes the code in Shopify and sends it. ask: draft plus an Urgent card. off: no code handling. */
  mode: 'auto' | 'ask' | 'off';
  /** Pounds off, fixed amount. */
  amount: number;
  currency: string;
  /** Wording for the message and the knowledge note. In Shopify the code always covers Kits, Bundles and Batteries. */
  applies_to: string;
  /** What the customer gets once the code is live. {CODE} and {AMOUNT} are filled in. */
  message: string;
  /** At most this many codes made by the agent on its own per London day. More go to the owner. */
  daily_cap: number;
  /** A customer who already has a code goes to the owner instead of getting a second one. */
  one_per_customer: boolean;
}

/** Selling: the one follow up after a product recommendation, and how hard the agent sells. */
export interface SalesSettings {
  /** Send one short follow up when a customer who was shown a product goes quiet. */
  follow_ups: boolean;
  /** Hours of silence after our recommendation before the follow up. Only sent 10:00 to 20:00 UK time. */
  follow_up_hours: number;
  /** friendly: warm and helpful (default). relaxed: answer first, sell only when asked. keen: always end with a clear next step. */
  style: 'friendly' | 'relaxed' | 'keen';
}

export interface Settings {
  agent: { enabled: boolean };
  channels: Record<Channel, { mode: ChannelMode }>;
  voice: VoiceSettings;
  brain: BrainSettings;
  pacing: PacingSettings;
  recovery: RecoverySettings;
  alerts: AlertSettings;
  store: StoreSettings;
  /** Which Gmail inbox the agent works in. Empty means the first account signed in to Chrome. */
  /** ignore_senders: addresses or domains the agent never answers (suppliers, platforms, couriers). */
  gmail: { account: string; ignore_senders: string[] };
  /** Creator codes the agent makes when a customer asks for one. */
  discounts: DiscountSettings;
  /** Selling style and the follow up after a recommendation (src/sales). */
  sales: SalesSettings;
}

// ---- Tone and brain --------------------------------------------------------------------------

export interface ToneProfile {
  register: 'hype' | 'casual' | 'neutral' | 'formal';
  mood: 'positive' | 'neutral' | 'confused' | 'frustrated' | 'angry';
  /** Greeting token the customer used, lower case, for example "yo" or "hi" or "". */
  greeting: string;
  /** Address terms the customer used themselves, for example ["bro"]. Only these may be mirrored. */
  address_terms: string[];
  elongation: number; // 0..1 share of words with stretched letters
  emoji_rate: number; // emojis per message
  lowercase: boolean; // customer writes mostly without capitals (a fact about them: replies never copy it)
  punctuation: 'none' | 'light' | 'full';
  avg_chars: number;
  language: string; // BCP 47 guess, "en" when unsure
  slang: string[];
}

export interface HistoryMessage {
  direction: 'in' | 'out';
  author: 'customer' | 'agent' | 'owner';
  body: string;
  kind: MessageKind;
  ts: number;
  /** A reply already queued for this chat that has not been sent yet. Never repeat it. */
  pending?: boolean;
}

export interface DecideInput {
  channel: Channel;
  contact_name: string | null;
  subject: string | null;
  /** Oldest first, at most 30 messages. The last one is from the customer. */
  history: HistoryMessage[];
  /** Short facts about this conversation, for example a checkout reminder that was sent. */
  context_notes: string[];
  now: number;
  /** playground: never logs usage against the live feed. */
  mode: 'live' | 'playground';
  /**
   * Photos (and single frames of videos) that came with the unanswered customer messages, oldest
   * first, at most 3. Only a model that can look at pictures gets them (src/brain/decide.ts).
   */
  media?: DecideMedia[];
}

/** One picture for the brain. `index` is the position in `history` of the message it came with. */
export interface DecideMedia {
  index: number;
  kind: 'image' | 'video_frame';
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  /** base64, no data: prefix. */
  data: string;
}

export interface LlmUsage {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  ms: number;
}

/** Where a conversation stands as a sale. support: help with an order or a kit they own. none: not about buying. */
export type SalesStage = 'browsing' | 'interested' | 'ready' | 'bought' | 'support' | 'none';
export const SALES_STAGES: SalesStage[] = ['browsing', 'interested', 'ready', 'bought', 'support', 'none'];

/** The brain's read of the sale, from the same decide call. product is a product title from the knowledge. */
export interface SalesRead {
  stage: SalesStage;
  product: string | null;
}

export interface Decision {
  /** reply: send parts. escalate: add to Urgent (parts may hold a short holding line). ignore: send nothing. */
  action: 'reply' | 'escalate' | 'ignore';
  /** One to three short messages, already sanitized, sent in order. */
  parts: string[];
  confidence: number;
  escalate: { question: string; reason: string; category: string } | null;
  tone: ToneProfile;
  flags: { opt_out: boolean; asked_if_bot: boolean; needs_human: boolean };
  /** kb_docs ids that informed the answer. */
  kb_refs: string[];
  note: string;
  usage: LlmUsage | null;
  /** Optional: older callers and the media path leave it out. */
  sales?: SalesRead | null;
}

export interface PolishInput {
  channel: Channel;
  contact_name: string | null;
  question: string;
  owner_answer: string;
  history: HistoryMessage[];
  now: number;
}

export interface PolishResult {
  parts: string[];
  /** A reusable fact for the knowledge base, written neutrally, or null when the answer was specific to this customer. */
  learned: { title: string; content: string } | null;
  usage: LlmUsage | null;
}

// ---- Outbox jobs (what the extension executes) ----------------------------------------------------

export interface JobTarget {
  thread_external_id: string | null;
  title: string | null;
  phone: string | null; // E.164 with leading +
  email: string | null;
  handle: string | null;
  subject: string | null;
}

export interface AgentJob {
  id: string;
  channel: Channel;
  kind: 'reply' | 'new_chat';
  source: string;
  target: JobTarget;
  parts: string[];
  pacing: { delay_ms: number; typing_cps: number };
  lease_until: number;
  attempts: number;
}

// ---- Rows ---------------------------------------------------------------------------------------

export interface ContactRow {
  id: string; channel: Channel; external_id: string; display_name: string;
  phone: string | null; email: string | null; handle: string | null;
  tone_profile: string; notes: string; opted_out: number; created_at: number; updated_at: number;
}

export interface ConversationRow {
  id: string; channel: Channel; contact_id: string; external_thread_id: string; title: string;
  subject: string | null; status: string; paused_until: number | null; pause_reason: string | null;
  needs_reply_since: number | null; processing_until: number | null; context_notes: string;
  last_inbound_at: number | null; last_outbound_at: number | null; last_preview: string;
  last_direction: string; created_at: number; updated_at: number;
  /** The cron sweeper waits until then after a failed brain call (migration 0008). */
  retry_at?: number | null;
  /** Sales columns (migration 0006). */
  sales_stage?: SalesStage | null; sales_product?: string | null; sales_link?: string | null; sales_link_at?: number | null;
  sales_stage_at?: number | null; interested_at?: number | null; ready_at?: number | null; bought_at?: number | null;
  order_total?: number | null; order_currency?: string | null; followup_at?: number | null; followup_status?: string | null;
  followup_outbox_id?: string | null;
}

export interface MessageRow {
  id: string; conversation_id: string; direction: 'in' | 'out'; author: 'customer' | 'agent' | 'owner';
  external_id: string | null; body: string; kind: MessageKind; status: string; outbox_id: string | null;
  meta: string; ts: number; created_at: number;
}

export interface OutboxRow {
  id: string; channel: Channel; kind: 'reply' | 'new_chat'; conversation_id: string | null; target: string;
  parts: string; status: string; source: string; ref_id: string | null; not_before: number;
  expires_at: number | null; lease_until: number | null; lease_device: string | null; attempts: number;
  last_error: string | null; dedupe_key: string | null; pacing: string; created_at: number; sent_at: number | null;
  /** Agent replies (migration 0008): the customer message answered, and when it arrived as best known. */
  reply_to_id?: string | null; reply_to_ts?: number | null;
}

export interface UrgentRow {
  id: string; conversation_id: string; channel: Channel; question: string; customer_message: string;
  reason: string; category: string; status: string; owner_answer: string | null; polished_answer: string | null;
  learn: number; kb_doc_id: string | null; outbox_id: string | null; created_at: number;
  answered_at: number | null; sent_at: number | null;
  /** Set on a discount code request: the draft row in discount_codes. */
  discount_id: string | null;
  /** The owner's note when they told the agent what is going on instead of typing the reply. */
  owner_note: string | null;
}

export interface DeviceRow {
  id: string; name: string; token_hash: string; created_at: number; last_seen_at: number | null;
  status: string; version: string; revoked_at: number | null;
}

export interface CheckoutRow {
  id: string; token: string | null; name: string; first_name: string | null; email: string | null;
  phone_raw: string | null; phone_e164: string | null; country: string | null; total: string | null;
  currency: string | null; items: string; recovery_url: string | null; created_at_shop: number | null;
  updated_at_shop: number | null; completed_at: number | null; consent_sms: number; consent_email: number;
  source: string; status: string; skip_reason: string | null; message_text: string | null;
  messaged_at: number | null; outbox_id: string | null; run_id: string | null; first_seen_at: number; updated_at: number;
}
