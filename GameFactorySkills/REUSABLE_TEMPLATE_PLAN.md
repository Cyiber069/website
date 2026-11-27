# Reusable Template Plan

> The shared systems every game clones, so a new game needs only a new theme and one new mechanic.

This is a plan, not code. Interface names are proposals.
Skill files: 07 (structure, data), 08 (remotes), 06 (purchases), 05, 04, 11, 10.

## Rules

1. Folder layout. One Rojo project: `src/shared`, `src/server`, `src/client`, one entry script per side, everything else ModuleScripts.
   Interface: each system exposes Init then Start; neither yields.
   Reskin: nothing. Never changes: the layout itself.
2. Config module (shared). Holds display data only: names, icons, theme, item and quest lists, save template, tunable key names.
   Interface: `Config.<Section>`, deep-frozen and typed.
   Reskin: all of it. Never changes: section names and shapes.
3. Server tables (server-only). Prices and reward tables that decide outcomes.
   Interface: `ServerTables.get(itemId)`.
   Reskin: the values. Never changes: lookup by id; never placed in ReplicatedStorage.
4. Data/profile layer. ProfileStore, one store per game, one key per player, Reconcile on load, version field with ordered migrations.
   Interface: `Data.get(player)` returns the active profile or nil.
   Reskin: the save template. Never changes: kick on failed load, no save before load, EndSession first on leave.
5. Currency service (server-owned). The only code that changes balances; logs each source and sink.
   Interface: `Currency.add(player, id, amount, reason)` and `Currency.spend(...)`.
   Reskin: currency names and icons. Never changes: IsActive check and write in one step; NaN guards.
6. Shop, passes and developer products. One catalog, one ProcessReceipt handler, handled PurchaseIds kept in player data, prices read at runtime.
   Interface: `Shop.grant(player, itemId)`; client sends item id only.
   Reskin: catalog entries and art. Never changes: grant saved before success; ownership confirmed before pass grants; odds and PolicyService checks.
7. Rebirth/prestige. The long-term progression step.
   Starting assumption (not from a source): reset soft progress in exchange for a permanent multiplier.
   Interface: `Rebirth.request(player)`.
   Reskin: name, cost curve, multiplier. Never changes: server decides eligibility.
8. Daily rewards and streaks. Server UTC day number plus streak count in saved data.
   Interface: `Daily.claim(player)`, idempotent.
   Reskin: reward list. Never changes: server time only; tolerant of a crash before the last save.
9. Quests. Objectives that repeat the core loop, with daily quests paying small soft-currency rewards.
   Interface: `Quests.progress(player, eventName, amount)`.
   Reskin: quest list and rewards. Never changes: objective and next reward shown on the HUD.
10. HUD and menu shell. HUD shows objective, currency, progress, next reward. Topbar icons open Shop, Daily Reward, Quests, Settings, one panel at a time. Stateless components taking props.
    Interface: `UI.mount(state)`; clicks return through callbacks.
    Reskin: theme, icons, text. Never changes: Scale layout, safe insets, minimum sizes, five screen states.
11. Remotes layer. One wrapper every remote passes through: permission, type, range, then a per-player token bucket.
    Interface: `Remotes.on(name, validator, handler)`.
    Reskin: nothing. Never changes: arguments treated as unknown; silent drop on mismatch; bucket cleared on leave. Default limit: the docs example of 5 requests per 10 seconds.
12. Analytics events. Same minimum event set in every game, onboarding funnel steps, economy events from the server.
    Interface: `Analytics.step(player, n)` and `Analytics.economy(...)`.
    Reskin: funnel step names. Never changes: event names, kept under the name limit.
13. Debug/admin commands. Grant currency, set stage, reset data, skip timers, using Cmdr.
    Interface: one shared command set.
    Reskin: nothing. Never changes: server-side owner list, deny by default.
14. Live tuning. Tunable numbers read through Roblox Configs, keys named in Config.
    Interface: `Tuning.get(key)`.
    Reskin: default values. Never changes: no hard-coded tunables.

## What a new game adds

- A filled-in Config: theme, names, items, quests, save template.
- Server table values: prices and rewards.
- One new mechanic, with its own validated remotes.
- Map, models, sounds and icons.
- Onboarding funnel step list.
- Packaging: icon, thumbnails, description.

## Build order

- Folder layout and entry scripts.
- Config and server tables.
- Data/profile layer.
- Remotes layer.
- Currency service.
- HUD and menu shell.
- Analytics events.
- Debug/admin commands.
- Shop, passes and developer products.
- Daily rewards and streaks, then quests.
- Rebirth/prestige.
- Live tuning.
- Prove it: reskin the template once using Config and assets only.
