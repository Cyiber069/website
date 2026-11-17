# ACX Agent checkpoint

Updated 2026-11-17. Keep this short: objective, decisions, what is live, what is in progress, next action.

## Live (branch claude/brave-mccarthy-rp1440, auto deployed by Cloudflare on push)
- Site: https://acxagent.kgosimosupi305.workers.dev
- Extension 0.3.2 (zip from GitHub or sent in chat): photo reading, blue theme, WhatsApp "signed out" fix, Show button per channel in the popup.
- Server: proper writing (capitals, commas, apostrophes), sales playbook and Sales screen, self healing and monitoring, Health "Share with Claude" 24 hour report link (/api/support/report/<token>, no customer text).

## Owner decisions
- Replies as fast as possible (not "within 2 minutes"): no artificial delay, no letter by letter typing, short quiet window (about 4 s) so split messages get one reply. Keep platform gaps on TikTok.
- Keep the current AI model (claude-opus-5-5, effort low) unless the owner asks for a faster lighter one.
- Recovery message is only ever approved by the owner; its preview shows the exact sent text.
- Outreach to creators starts slow (about 15 a day, 10:00 to 20:00, spaced) because TikTok can restrict accounts for bulk DMs.

## In progress
1. Speed upgrade: builder B (server) and builder A (extension, lanes registry, 0.4.0) in separate worktrees, contract in the session scratchpad (speed-contract.md). Then merge, run tsc, vitest, e2e, push, send zip.
2. WhatsApp Web selector audit (additive fallbacks in extension/selectors/whatsapp.json). Served by the server, so it reaches laptops without reinstall.
3. Research for: TikTok comments tab, TikTok creator outreach tab, people panel and laptop failover, Live tab dots.
4. Split discount requests (inside builder B).

## Open problems on the owner's laptop (from the popup screenshot)
- WhatsApp shows Working but no replies: waiting for the owner's Health report link to confirm the cause.
- Gmail tab signed into a different account (adscaledd@...), not acxebikes@gmail.com.
- TikTok tab ended up on /business-suite/: may be TikTok's Professional inbox. Unconfirmed.

## Next action
Merge A and B when both report, run all checks, push, send extension 0.4.0 zip. Then design and build the people panel, tab dots and the two TikTok lanes on top of the lanes registry.
