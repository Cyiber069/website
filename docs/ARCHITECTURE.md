# ACX Agent: architecture and contracts

ACX Agent answers ACX Ebikes customers on WhatsApp, Gmail and TikTok by driving the owner's own
logged-in Chrome tabs, asks the owner when it does not know something, and every day at 20:00
Europe/London messages people who abandoned a checkout.

This file is the contract between the parts. Keep it true when you change code.

## 1. The parts

```
 customer ──► WhatsApp Web / Gmail / TikTok tab  (owner's Chrome, laptop left on)
                    ▲  reads + types
                    │
        extension/  │  Chrome MV3 extension: the hands and eyes. No AI inside it.
                    │  https, bearer device token
                    ▼
        src/        Cloudflare Worker: the brain. API + D1 database + cron + static dashboard.
                    ▲  https, session cookie
                    │
        public/     Dashboard (static SPA, also installable on the owner's phone).
```

* The laptop only has to be on with Chrome open. Everything else lives on Cloudflare, so the owner can
  answer Urgent questions from their phone anywhere and the laptop sends the reply.
* Nothing is sent to a customer except through the `outbox` table, executed by the extension.
* Selectors for the three sites are data (`extension/selectors.json`), served by the Worker and
  overridable from the dashboard, so a site redesign is fixed without reinstalling the extension.

## 2. Repo layout

| Path | What | Notes |
|---|---|---|
| `wrangler.jsonc` | production Worker config | D1 id, cron, assets, Workers AI |
| `wrangler.test.jsonc` | local dev + tests | no remote bindings, sets `ACX_TEST_MODE=1` |
| `migrations/` | D1 schema | add new numbered files, never edit applied ones |
| `src/index.ts` | entry: API router, static assets, cron | |
| `src/types.ts` | shared types | the brain / pipeline contract lives here |
| `src/lib/` | http router, db helpers, auth, crypto, settings, time, events, push | |
| `src/pipeline/` | inbound (store + decide + queue), outbox, urgent, alerts | the spine |
| `src/brain/` | tone profile, style sanitizer, prompts, LLM providers | exports via `src/brain/index.ts` |
| `src/kb/` | knowledge base: extract, chunk, search, store sync | exports via `src/kb/index.ts` |
| `src/shopify/` | Shopify client, webhooks, phone normalising | |
| `src/recovery/` | abandoned checkout run + template | exports via `src/recovery/index.ts` |
| `src/sales/` | lead stages (`leads.ts`), orders matched to chats (`conversions.ts`), the one follow up `salesTick` and the Sales screen numbers (`index.ts`) | |
| `src/discounts/` | creator codes: shared create + send (`index.ts`), the agent's code turn (`agent.ts`), pure rules (`rules.ts`) | |
| `src/routes/` | one file per API area, each exports `register(r)` | |
| `src/cron.ts` | every-minute tasks | |
| `public/` | dashboard | no build step |
| `extension/` | Chrome extension | no build step, load unpacked |
| `seed/knowledge/` | starter knowledge exported from the store | bundled into the Worker |
| `test/` | unit tests (vitest) and end to end (Playwright) | in test mode every API response carries `x-acx-d1-queries`; `test/api/limits.test.ts` keeps heavy paths under 50 |

### Monitoring (`src/pipeline/monitor.ts`, every minute in cron)

Alerts the owner once per problem (push, throttled in `alertOwner`) and logs a good event when it is fixed:
a channel not switched off with no good scan for 10 min while the laptop is online (`channel_down` / `channel_ok`),
signed out or blocked for 10 min, the laptop offline (`device_offline`), a chat with `needs_reply_since` over
15 min and nothing processing it (`reply_stuck`), 3 failed AI calls in a row (`ai_failing` / `ai_ok`), and D1
use over 70% of a free daily limit (`usage_high`, once a UTC day). State lives in `state:monitor`;
`GET /api/overview` and `GET /api/health` return it as `monitor { channels, stuck, ai_failing }`.

D1 usage meter (`src/lib/usage.ts`): env.DB is wrapped to sum `meta.rows_read` / `rows_written` of all(),
run() and batch() (first() is not counted; `one()` in db.ts uses all()). Flushed to `state:d1_usage` at most
every 5 min per isolate. An estimate: `usage` on overview, `d1_usage` on health.

## 3. Data model

See `migrations/0001_init.sql` (commented). Timestamps are unix milliseconds. Key tables:
`settings` (JSON groups + `state:*` keys), `secrets` (write only), `devices`, `kb_docs` / `kb_chunks`,
`contacts`, `conversations`, `messages`, `urgent`, `outbox`, `checkouts`, `recovery_runs`, `events`,
`diagnostics`, `llm_usage`, `sales_conversions` (one row per order matched to a chat, `migrations/0006_sales.sql`, which also adds the `sales_*`, `followup_*`, `interested_at`, `ready_at`, `bought_at` and `order_*` columns of `conversations`), `discount_codes` (`made_by` owner | agent, `migrations/0004_agent_discounts.sql`).
`urgent.discount_id` links a code request to its draft, `urgent.owner_note` holds the owner's note when they told the agent what is going on.

Settings groups and defaults: `src/lib/settings.ts` (`DEFAULT_SETTINGS`), typed in `src/types.ts`.
Read with `getSettings(db)`, write with `patchSettings(db, group, patch)`. Secrets: `getSecret` /
`setSecret` / `secretHints`. Secret keys in use: `anthropic_api_key`, `shopify_client_id`,
`shopify_client_secret`, `shopify_admin_token`, `shopify_webhook_secret`, `vapid_private_jwk`.

## 4. Auth

* Owner: password set on first visit (`POST /api/setup`), PBKDF2, session cookie `acx_session`
  (HttpOnly, SameSite=Lax). State changing owner routes also check `Origin`.
* Extension: `POST /api/agent/pair {code,name}` swaps a 15 minute one-time code for a device token
  (`acxd_...`), sent as `Authorization: Bearer`. Only the sha256 is stored.
* Route auth level is declared at registration: `r.post(path, 'owner' | 'device' | 'public', handler)`.

## 5. API

Errors are `{ "error": "<code>", "message": "<human text>" }` with a 4xx/5xx status.

### Extension (`device`)

`POST /api/agent/sync` every `poll_seconds` and after finishing any job.
```jsonc
// request
{ "version": "0.1.0", "selectors_version": "1.0",
  "status": { "paused_locally": false,
    "channels": { "whatsapp": { "state": "ready", "detail": "", "unread": 2, "busy": false } } } }
// state: ready | no_tab | loading | logged_out | blocked | error
// optional health per channel: last_ok_at (ms of last good scan), last_scan_at, last_error (short text),
// recoveries (self heal actions today), version. Kept clamped and clipped. The device row is written only
// when something visible changed or at least every 55 s, so a sync is normally 0 rows written.
// response
{ "server_time": 0,
  "config": { "enabled": true, "channels": { "whatsapp": { "mode": "auto" } },
              "pacing": { "settle_seconds": 12, "typing_cps": 11 }, "poll_seconds": 20,
              "selectors_version": "1.0", "dashboard_url": "https://..." },
  "jobs": [ AgentJob ],            // at most one per ready, non busy channel
  "selectors": null | { "version": "1.0", "pack": { } } }   // sent when the version differs
```

`POST /api/agent/inbound` when a thread has customer messages the extension has not reported.
Send the last messages visible in the thread (up to 40, oldest first), both directions.
```jsonc
{ "channel": "whatsapp",
  "thread": { "external_id": "447700900123@c.us", "title": "Jake", "is_group": false, "subject": null,
              "contact": { "name": "Jake", "phone": "+447700900123", "email": null, "handle": null } },
  "messages": [ { "external_id": "false_447700900123@c.us_3EB0A1", "direction": "in",
                  "body": "yo how long is delivery", "kind": "text", "ts": 1794695171000 } ] }
```
The response is newline delimited JSON, streamed so the connection stays alive while the brain works:
```
{"type":"accepted","conversation_id":"cv_x","new_inbound":1}
{"type":"ping"}
{"type":"decision","conversation_id":"cv_x","action":"reply","reason":"...","jobs":[AgentJob],"new_inbound":1}
```
`action`: `reply` (jobs to run now), `review` (draft waits for the owner), `escalate` (went to Urgent,
`jobs` may hold a short holding line), `none`. If the stream breaks the work still finishes server
side and the jobs arrive on the next sync.

`external_id` must be the platform's own stable id when one exists (WhatsApp `data-id`, Gmail message
id). When there is none send `null`: the server matches by walking both message lists in order.
`thread.external_id` identifies the thread on that channel (WhatsApp JID, Gmail thread id, TikTok
conversation id or peer handle). `ts` is unix ms when the page shows a time, else `null`.
`kind` is one of `text image voice video sticker document other`; non text kinds may have an empty body.

`AgentJob`
```jsonc
{ "id": "ob_x", "channel": "whatsapp", "kind": "reply" | "new_chat", "source": "auto",
  "target": { "thread_external_id": "447700900123@c.us", "title": "Jake", "phone": "+447700900123",
              "email": null, "handle": null, "subject": null },
  "parts": ["hey bro", "delivery is 2 to 4 days in the UK"],   // send in order as separate messages
  "pacing": { "delay_ms": 7000, "typing_cps": 11 },             // wait, then type at about this speed
  "lease_until": 0, "attempts": 1 }
```
* `reply`: open the existing thread and send. `new_chat`: start a chat from `target.phone`
  (WhatsApp) or `target.email` (Gmail compose) and send.
* The extension must be idempotent: remember finished job ids, and before typing check the thread's
  last outgoing message is not already `parts[last]`.

`POST /api/agent/jobs/:id/result`
```jsonc
{ "status": "sent" | "failed", "error_code": "not_on_whatsapp", "error": "text", "retryable": false,
  "sent_external_ids": ["true_447700900123@c.us_3EB0B2"] }
```
Error codes: `thread_not_found`, `composer_missing`, `composer_busy`, `send_not_confirmed`, `not_on_whatsapp`,
`invalid_number`, `logged_out`, `tab_missing`, `blocked`, `timeout`, `unknown`.

`POST /api/agent/diagnostics` `{ "channel", "kind": "selector_miss" | "dom_snapshot" | "error" | "note", "data": {} }`.
`GET /api/agent/selectors` returns `{ version, pack }`.

### Dashboard (`owner`) implemented in `src/routes/dashboard.ts`

`GET /api/session` (public), `POST /api/setup`, `POST /api/login`, `POST /api/logout`, `POST /api/password`,
`GET /api/overview`, `GET /api/events?after=&limit=`, `POST /api/agent-toggle {enabled}`, `POST /api/panic`,
`GET /api/urgent?status=open|done` (returns `urgent[]` and `review[]`),
`POST /api/urgent/:id/answer {answer, learn}`, `POST /api/urgent/:id/note {note, remember}` (section 6), `POST /api/urgent/:id/send-draft {text?}`,
`POST /api/urgent/:id/dismiss`, `POST /api/review/:id/approve {text?}`, `POST /api/review/:id/reject`,
`GET /api/conversations?channel=&q=`, `GET /api/conversations/:id`,
`POST /api/conversations/:id/pause {minutes}` (0 resumes), `POST /api/conversations/:id/send {text}`,
`POST /api/contacts/:id/opt-out {opted_out}`, `GET /api/settings`, `PUT /api/settings/:group`,
`GET /api/devices`, `POST /api/devices/pair-code`, `DELETE /api/devices/:id`, `GET /api/health`,
`GET /api/selectors`, `PUT /api/selectors {override}`.

### Knowledge (`owner`, `src/routes/kb.ts`)

* `GET /api/kb` -> `{ docs: [{ id, title, category, source, filename, bytes, enabled, pinned, token_estimate, updated_at, preview }], totals: { docs, tokens }, gaps: [{ question, why_it_matters, category }] }`
* `GET /api/kb/:id` -> `{ doc }` including `content`
* `POST /api/kb/upload` multipart form (`file`, optional `category`) -> `{ doc }`. Errors `unsupported_type`, `too_large` (10 MB), `empty_text`
* `POST /api/kb/note { title, content, category?, pinned? }` -> `{ doc }`
* `PATCH /api/kb/:id { title?, content?, category?, enabled?, pinned? }` -> `{ doc }`; `DELETE /api/kb/:id`
* `POST /api/kb/sync-store` -> `{ ok, added, updated }` (public catalogue and policies of the store)
* `POST /api/kb/gaps/answer { question, answer }` -> `{ doc }` (saves the answer as knowledge, removes the gap); `POST /api/kb/gaps/dismiss { question }`

Categories: `products policies shipping faq learned general`. Sources: `upload note store learned seed`.
Seed notes added after the first release (for example `seed_creator_sponsorship`, "Creator sponsorship and discount codes",
from `seed/knowledge/creator-sponsorship.md`) are inserted once by `ensureSeeded` into an existing knowledge base too,
unless a doc with that title exists; a state flag per note keeps a deleted note deleted.

### Voice (`owner`, `src/routes/voice.ts`)

* Style settings are the `voice` settings group (`PUT /api/settings/voice`).
* `POST /api/playground { messages: [{ direction: 'in'|'out', body }], channel? }` ->
  `{ decision: { action, parts, confidence, escalate, tone, flags, note }, kb_refs: [{ id, title }], ms, provider, model }`. Nothing is stored or sent.

### Recovery (`owner`, `src/routes/recovery.ts`)

* `GET /api/recovery` -> `{ settings, shopify: { connected, mode }, next_run_at, template: { text, approved, updated_at }, variables: [..], eligible: [{ id, first_name, phone_masked, country, total, currency, items, age_hours, preview_text }], skipped: [{ id, first_name, reason }], runs: [..], stats: { messaged_30d, replied_30d, recovered_30d } }`
* `POST /api/recovery/teach { rough }` -> `{ suggestion }` (not saved)
* `PUT /api/recovery/template { text, approved, consent_mode? }` saves the message. `approved: true` with a `consent_mode` also sets `consent_confirmed`.
* `POST /api/recovery/run { dry_run }` -> `{ run }`; `POST /api/recovery/refresh` pulls checkouts now; `POST /api/recovery/checkouts/:id/skip`
* Other options through `PUT /api/settings/recovery`.

Template variables: `{first_name}` `{product}` `{total}` `{checkout_link}` `{shop}`.

### Discount codes (`owner`, `src/routes/discounts.ts`, Shopify part in `src/shopify/discounts.ts`)

* `GET /api/discounts` -> `{ discounts: [{ id, conversation_id, contact_id, customer, channel, code, amount, currency, applies_to, expires_at, usage_limit, shopify_id, shopify_status, message_text, outbox_id, message_status, sent_at, status, error, created_at, updated_at }], shopify: { connected }, defaults: { amount, currency, applies_to, message } }`
* `POST /api/discounts { conversation_id, code, amount?, applies_to?, expires_at?, usage_limit?, message_text?, send?, confirm_exists? }` -> 201 `{ discount, shopify: { ok, status, error_code, message, discount_status }, queued, needs_confirm }`.
  Makes the code in Shopify when the API is connected (`discountCodeBasicCreate`, fixed amount, only the collections titled Kits, Bundles and Batteries, needs `write_discounts` and `read_products`).
  With `send: true` the message is queued only once the code is live (made in Shopify, or `confirm_exists: true` when the owner made it by hand). Otherwise the row stays a `draft` and `needs_confirm` is true.
  Errors `invalid_code` (3 to 30 of A to Z and 0 to 9), `invalid_amount` (1 to 500), `invalid_expiry` (`YYYY-MM-DD`, in the future), `invalid_usage_limit`, `conversation_not_found`, `code_taken` (409).
* `POST /api/discounts/:id/send { message_text?, confirm_exists? }` -> `{ ok, discount, already_queued, shopify }`. Not live yet and no `confirm_exists`: Shopify is tried again, then 409 `needs_confirm`.
  The message is an outbox job with `source: 'manual'`, `ref_id` = discount id and `dedupe_key` `discount:<id>`, so a second send never duplicates. After a failed send the old job gives up the key and a new one is queued. The text goes out as written (no style sanitizer).
* `POST /api/discounts/:id/approve { message_text?, confirm_exists? }` -> `{ ok, discount, already_queued, shopify, parts }`. The Urgent "Approve code" button: same as send (409 `needs_confirm` when Shopify says no and nothing is confirmed), job `source: 'discount'`, then closes the Urgent item that points at the draft.
* `DELETE /api/discounts/:id` drafts only (409 `not_a_draft` otherwise).
* `GET /api/discounts` also returns `settings` (the `discounts` group) and each row's `made_by`. `defaults` follow the settings.
* Settings group `discounts` (`PUT /api/settings/discounts`, checked by `checkDiscountPatch`): `mode` `auto` | `ask` | `off` (default `auto`), `amount` 20, `currency` GBP, `applies_to`, `message` (template with `{CODE}` and `{AMOUNT}`, must contain `{CODE}`), `daily_cap` 10, `one_per_customer` true.

Create and send live in `src/discounts/index.ts` (`insertDiscount`, `makeLive`, `queueDiscountMessage`, `liveThenSend`) and are shared by the routes and the agent. In test mode only, the state key `test_fake_shopify` (`"created"` or `"taken"`) stands in for Shopify (`shopifyCreator`).

Statuses: `draft` (saved, not live) | `live` (in Shopify, or confirmed by the owner) | `sent` | `failed`. `sent` and `failed` are read from the row's outbox job on every `GET`.
`shopify_status`: `not_connected` | `created` | `failed` | `owner_confirmed`. Table `discount_codes` (`migrations/0003_discounts.sql`).

### Sales (`owner`, `src/routes/sales.ts`, logic in `src/sales/`)

* `GET /api/sales` -> `{ funnel: [{ days: 7|30, chats, interested, ready, bought, revenue }], leads: [{ conversation_id, channel, customer, stage, product, link, last_message, last_direction, stage_at, followup_status }], followups: [{ days, sent, waiting, replies }], settings }`.
  `bought` and `revenue` (GBP) count only orders `from_chat` (the agent wrote in that chat in the 14 days before the order). Leads are interested or ready in the last 3 days, ready first.
* `PUT /api/sales/settings { follow_ups?, follow_up_hours? (1 to 72), style? ('friendly' | 'relaxed' | 'keen') }` -> `{ ok, settings }`. 400 `invalid_field` otherwise. Settings group `sales` (defaults on, 20, friendly).
* `POST /api/test/sales-tick { now? }` runs `salesTick` (test mode only).

Lead stages: `decide` returns an optional `sales: { stage, product }` (`browsing | interested | ready | bought | support | none`) in the same call. The pipeline stores it on the conversation (`recordSalesRead`), with the product link the agent queued. `none` or `browsing` never overwrite a live lead; an upset customer or a complaint is always `support`.

Follow up (`salesTick(env)`, to be called from the every minute job): ONE short follow up, written by the cheapest model of the provider (`brain.writeFollowUp`, checked like a reply, fixed line on any failure), when a chat is interested or ready, the agent sent a product link, our message is the last one and `follow_up_hours` passed. Only 10:00 to 20:00 London (nothing is read outside those hours), at most 3 per run, through the partial index `conversations_followup_due`. Never a second one (`followup_status`), never when opted out, paused, taken over by the owner, bought, the channel is off, or on WhatsApp more than 23 hours after the customer's last message. Review mode makes it a draft. Queued as `source: 'auto'`, `ref_id: 'followup'`, so a takeover, an opt out or a new message cancels it.

Conversions: `recordOrder` (orders/create) and checkouts seen completed (webhook or daily pull) call `recordConversions`, which matches by E.164 phone or email, marks every matched chat `bought` with total and time, and writes one `sales_conversions` row per order (same chat within 6 hours counts once).

### Connections and push (`owner`, `src/routes/connections.ts`)

* `GET /api/connections` -> `{ brain: { provider, model, effort, claude_key: { saved, hint }, workers_ai: { available, model }, models: [{ id, label, note }] }, shopify: { mode, domain, myshopify_domain, api: { saved, hint }, webhook: { url, secret_saved, last_received_at } }, push: { public_key, subscriptions }, alerts }`
* `PUT /api/connections/brain { anthropic_api_key?, provider?, model?, effort? }`; `POST /api/connections/brain/test` -> `{ ok, provider, model, ms, sample, error? }`
* `PUT /api/connections/shopify { myshopify_domain?, client_id?, client_secret?, admin_token?, webhook_secret? }`; `POST /api/connections/shopify/test` -> `{ ok, shop_name?, checkouts?, error? }`; `DELETE /api/connections/shopify`
* `POST /api/push/subscribe { endpoint, keys: { p256dh, auth } }`; `POST /api/push/unsubscribe { endpoint }`; `POST /api/push/test`

### Shopify webhooks (`public`, `src/routes/hooks.ts`)

* `POST /api/hooks/shopify` verified with `X-Shopify-Hmac-Sha256`. Topics: checkout create / update, order create.

## 6. The inbound pipeline (`src/pipeline/inbound.ts`)

1. `storeInbound`: find or create contact + conversation, store unseen messages. An outgoing message
   the agent did not queue means the owner replied by hand: the conversation is paused for
   `pacing.human_takeover_minutes` and the agent's own unsent jobs in it (`auto`, `holding`, pending or review)
   are cancelled (`cancelAgentJobs`). Pausing a chat from the dashboard does the same.
2. `processConversation` gates: agent on, channel mode not `off`, contact not opted out, not paused,
   last message is from the customer, hourly reply cap, short lock.
3. Creator code turn (`src/discounts/agent.ts handleCodeTurn`, skipped when `discounts.mode` is `off`). Group chats
   never reach this point (`handleInbound` drops them). Only when the new customer messages contain code, discount,
   sponsor, promo or coupon, one small call `brain.extractDiscountRequest(env, history)` returns
   `{ wants_code, code, confidence }` (mock in test mode: "discount code" or "creator code" plus a quoted or upper case token).
   `planCodeRequest` (pure, `src/discounts/rules.ts`) then decides:
   * no code named: the normal reply runs with a context note telling it to ask what they want their code to be.
   * `create` (mode `auto` and every check passes): the code is made in Shopify, the template is queued in the same chat
     (`source: 'discount'`, `review` status when the channel asks first) instead of a brain reply, an event
     "Made discount code X for name" is logged and the owner gets a push (`alertOwner` kind `discount`).
   * `park`: a draft row (`made_by: 'agent'`) plus an Urgent item (`category: 'discount_code'`, `discount_id`) with
     an Approve code button, and one fixed holding line that never mentions the code. Parks on: mode `ask`, confidence
     below 0.7, a rude word or the shop name alone, the code taken here or in Shopify, the person already has a code
     (`one_per_customer`), `daily_cap` codes made by the agent today (London day), Shopify not connected or refusing.
   A turn that made or parked a code sends nothing else. Any normal reply that says a code is live or ready
   (`promisesLiveCode`) is parked for the owner instead of sent.
4. `brain.decide(...)` returns a `Decision` (`src/types.ts`). When the customer is shopping (`isShopping`) the knowledge search adds product words and the
   product picker note (`seed_product_picker`, every product with price and link, built from `seed/knowledge/products.md`) is included in full.
   The brain follows a sales playbook (one question at a time, one product with its real price and link, answer the objection, close with the link,
   at most one relevant extra, no pressure, never sell to an upset customer). In code: a link not found in the knowledge parks the draft for the owner,
   and a reply that sounds unsure ("not sure", "no idea", "I can't help" ...) becomes an escalation (`unknown_fact`) with a confident holding line.
   An escalation may carry two parts: the part of the answer the knowledge covers, then the holding line. Questions about parts of a kit the
   customer owns go to the owner as `product_support`, and the answer is learned like any Urgent answer.
5. Apply: `reply` goes to `outbox` (`pending`, or `review` when the channel is in review mode; a new review
   draft cancels the older `auto` drafts of the same chat, so only one answer to the chat as it stands waits);
   low confidence or `needs_human` becomes an Urgent item that carries the draft; `escalate` creates
   or updates an Urgent item, optionally queues one holding line, and alerts the owner.
   An opt out (the brain's flag or `POST /api/contacts/:id/opt-out`) cancels everything not typed by the owner
   still queued for that contact, recovery reminders to their number included (`cancelForOptOut`).
6. Cron re-runs conversations whose live request died (`sweepConversations`), one a minute, and none in the
   minute the daily recovery run or store sync starts (the free plan allows 50 D1 queries and fetches per run).

Urgent: `answerUrgent` calls `brain.polishOwnerAnswer` (owner's rough words to a customer ready reply
in the customer's tone), queues it, and stores a reusable fact through `kb.addLearnedFact`.

Owner note (`answerUrgentWithNote`, `POST /api/urgent/:id/note { note, remember = true }` ->
`{ ok, parts, queued_as: 'pending' | 'review' | 'none', outbox_id, learned, kb_doc_id, status }`): the note becomes an
"Owner guidance" context note (`brain.ownerGuidance`, authoritative over the knowledge, never quoted) and `decide` writes
the reply, forced to reply (confidence does not hold it back; a non reply is 422 `no_reply`). Queued as an urgent answer
(`source: 'urgent'`), or a review draft when the channel asks first. A note that says to wait sends nothing. The note is
saved on the Urgent item (`owner_note`) and on the conversation's `context_notes` (last 6) so later messages follow it.
With `remember`, `brain.learnFromOwnerNote` returns a reusable neutral fact or null (null for notes about one customer),
stored through `kb.addLearnedFact` (source and category `learned`), so it shows on the Knowledge screen to edit or delete.

## 7. Style rules (owner requirements, enforced twice)

The LLM is prompted with them and `sanitizeReply` enforces them deterministically afterwards:

* Must read like a person at the shop texting, never like an assistant.
* Mirror the customer: greeting, energy, slang they used, letter stretching (a notch calmer), emoji
  use, capitalisation, length. "yoooo brooo" gets "hey broo ...". Formal customers get plain polite replies.
* No em dash, en dash or hyphen used as punctuation. Hyphens survive only inside URLs, emails, phone
  numbers, order numbers and product codes.
* Commas only when the meaning needs them. Never markdown, bullets or numbered lists.
* Short: default at most 3 sentences / 260 characters, split into up to 3 separate texts.
* Never invent facts: answer from knowledge or escalate.
* Never claim to be human. Asked sincerely whether it is a bot, answer honestly in one short line.
* Never tell a customer it is unsure or does not know: that is an escalation with a confident holding line.

## 8. Checkout recovery

Every minute `recoveryTick` checks the London clock. At `recovery.send_hour_london` (20) it runs once
per London date: pull checkouts (Shopify API or the rows fed by webhooks), pick eligible ones, render
the owner-approved template, queue WhatsApp `new_chat` jobs spaced `spacing_seconds` apart that expire
`window_minutes` after the start. No approved template means a dry run only. Replies thread into normal
conversations with a context note about the checkout.

## 9. Operating it from a Claude session

* Cloudflare D1 database: `acx-agent` (id in `wrangler.jsonc`). Query it with the Cloudflare D1 tools.
* Teach or change the recovery message: update the `recovery` row in `settings` (`template.text`,
  `template.approved`) or use the dashboard Recovery screen.
* Add knowledge: insert through the dashboard, or `kb_docs` + `kb_chunks` rows.
* Fix a broken selector: `PUT /api/selectors` or the `state:selectors_override` settings row, shape
  `{ "rev": n, "pack": { "whatsapp": { "send_button": ["..."] } } }`. Check `diagnostics` first.
* Deploys happen on push to the connected branch (Cloudflare Workers Builds).
