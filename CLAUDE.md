# ACX Agent

Customer service agent for ACX Ebikes (Shopify, acxebikes.com). Read `docs/ARCHITECTURE.md` first; owner setup is `docs/SETUP.md`.

* `src/` Cloudflare Worker (API, D1, cron, brain). `public/` dashboard. `extension/` Chrome MV3 extension (load unpacked). `seed/knowledge/` starter knowledge.
* D1 database `acx-agent`, id in `wrangler.jsonc`. The Worker applies `migrations/` itself (`src/lib/schema.ts`); deploy is only `npx wrangler deploy`.
* Checks: `npx tsc --noEmit`, `npx vitest run` (starts a local Worker with a mock brain), `npm run test:e2e` (extension against mock WhatsApp, Gmail and TikTok pages in Chromium).
* Local dev uses `wrangler.test.jsonc` (no remote bindings, `ACX_TEST_MODE=1`). Never set `ACX_TEST_MODE` in production: it enables `/api/test/*`.
* The three live sites were never tested from a cloud session. When the owner reports a broken channel, read the `diagnostics` table, then fix selectors in `extension/selectors/<channel>.json` or as an override through `PUT /api/selectors`.
* Owner copy rules apply to everything a customer or the owner reads: no em or en dashes, few commas, short, plain words.
* The recovery message is only ever approved by the owner (Recovery screen or `PUT /api/recovery/template`).
