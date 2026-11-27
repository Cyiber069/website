# Master Playbook

> The 30 rules every factory game must follow, from idea to live numbers.

## How to use

Read this page and NEW_GAME_CHECKLIST.md before every game.
Then open the skill files (01-12) that fit the task.

## Rules

1. [Market] Start from a proven genre and copy a current hit's structure, not its content, plus one twist. Why: build days cannot test an unproven genre (see 01).
2. [Market] Reject any idea that scores low on first-session clarity or mobile fit. Why: those cannot be fixed later (see 01).
3. [Core loop] State the loop as one verb inside do, earn, upgrade, repeat. Why: one verb is buildable in days (see 02).
4. [Core loop] Make every reward visibly strengthen the core action. Why: that link makes it a loop (see 02).
5. [Core loop] Build a tracer bullet first: one action, one reward, one next goal through input, remote, server, data and UI. Why: a broken idea shows within hours (see 02).
6. [First session] Reach the first fun action within 10-30 seconds of spawning. Why: leaving takes one tap (see 02).
7. [First session] Teach only controls and the core loop, with arrows and highlights, not text. Why: players skip text (see 03).
8. [First session] Show no interrupting popups or shop pressure in the first five minutes. Why: interruptions lose players before the loop hooks them (see 03).
9. [UI] Build UI with Scale, safe insets, roughly 44 px touch targets and Activated buttons. Why: pixel layouts and hover break on phones (see 04).
10. [UI] Keep objective, currency, progress and next reward on the HUD always. Why: nobody should need a menu to find the next step (see 04).
11. [UI] Give every core action client-side animation, sound, effect and UI change. Why: without feedback the game seems broken (see 04).
12. [Retention] Plan the first week before building, with a day-7 reward visible from day 1. Why: the reward only pulls if seen early (see 05).
13. [Retention] Run daily rewards and streaks on server UTC day math with idempotent claims. Why: clocks and retries cannot cheat it (see 05).
14. [Monetization] Sell durable perks as passes and repeatables as developer products, at low, mid and premium prices. Why: every spender needs something to buy (see 06).
15. [Monetization] Grant products only in one server ProcessReceipt handler, after saving, skipping handled PurchaseIds. Why: retries must never double-grant (see 06).
16. [Monetization] Show all outcomes and percentage odds before any paid random item, and check PolicyService per player. Why: Roblox requires it (see 06).
17. [Monetization] Never use fake urgency or make pay-to-skip timers the main income. Why: discounts must be genuine; players downvote skip timers (see 06).
18. [Architecture] Clone one template and change only Config and assets. Why: one config surface makes a reskin take hours (see 07).
19. [Architecture] Keep outcome-deciding prices and reward tables in a server-only module. Why: exploiters can read ReplicatedStorage (see 07).
20. [Architecture] Use ProfileStore as the only data layer and never save before a successful load. Why: defaults would overwrite real progress (see 07).
21. [Security] Treat every client as hostile; validate each remote for permission, type and value range. Why: client-side checks are always bypassed (see 08).
22. [Security] Accept only item ids from clients and rate-limit every client-triggered action. Why: the server alone owns currency (see 08).
23. [Security] Quarantine and read every free asset and package; never give an AI tool the account cookie. Why: either can hand over the game (see 08).
24. [Performance] Pick one low-end phone, set a budget from it and test on it throughout. Why: a budget gives pass or fail (see 09).
25. [Performance] Run effects on the client, send only batched changes through remotes and avoid polling loops. Why: phones have little frame time to spare (see 09).
26. [Launch] Before publishing, test with two clients, a late joiner, bad network and an entry-level phone profile. Why: replication bugs hide in solo play (see 10).
27. [Launch] Test saving in a separate copy, never against live data. Why: Studio writes to production data stores (see 10).
28. [Analytics] Log the same minimum events, onboarding funnel and currency flows from the server in every game. Why: games become comparable (see 11).
29. [Analytics] Judge a new game on D1 and session time against the dashboard benchmark band. Why: Roblox gives no official kill threshold (see 11).
30. [Video study] Keep a video lesson only with a timestamped link and numbers checked against a written source. Why: guesses poison the library (see 12).
