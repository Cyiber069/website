# Code Architecture

> Build every game on one cloned template: one Config module to reskin, a server that owns all currency, and data saving that cannot lose or duplicate progress.

## When to use
- Starting a new game from the factory template.
- Adding any system that touches currency, items or saved data.

## Rules
1. Keep one identical Rojo layout per game: `src/shared` to ReplicatedStorage, `src/server` to ServerScriptService, `src/client` to StarterPlayerScripts, with one entry script per side and everything else ModuleScripts.
   Why: same layout makes cloning fast and load order predictable. [repo: rojo-rbx/rojo; repo: EL4CTEO/roblox-skills]
2. Put all reskin data in one Config module: display data, save template, tunable keys. A new game changes Config and assets only.
   Why: one config surface is what makes a reskin take hours. [repo: EL4CTEO/roblox-skills]
3. Split authority: shared Config holds display data; prices and reward tables that decide outcomes live in a server-only module.
   Why: everything in ReplicatedStorage can be read by exploiters. [repo: EL4CTEO/roblox-skills]
4. Use `--!strict`, annotate every exported function, and deep-freeze Config tables.
   Why: `table.freeze` is shallow, and untyped exports are where reskins break. [repo: fizzyhex/luau-skills]
5. Use ProfileStore as the only data layer: one store per game, one key per player, template from Config, `Reconcile` on load.
   Why: session locking stops two servers writing one player. [repo: MadStudioRoblox/ProfileStore]
6. Load with the documented flow: handle players already in the server, pass a Cancel check, and kick with a rejoin message if the profile is nil.
   Why: a failed load must never fall through to default data. [repo: MadStudioRoblox/ProfileStore]
7. Never save until the load has succeeded.
   Why: defaults would overwrite real progress. [repo: Quenty/NevermoreEngine]
8. Call `EndSession` first in PlayerRemoving, with no yield before it.
   Why: an unreleased lock makes the next server wait. [repo: MadStudioRoblox/ProfileStore]
9. Check `IsActive` and write currency in the same step, with no yield between.
   Why: the save guarantee ends at the next yield. [repo: MadStudioRoblox/ProfileStore]
10. Keep saved data plain: no NaN, Instances, Vector3, mixed keys or sparse arrays.
    Why: the data store rejects the save. [repo: MadStudioRoblox/ProfileStore]
11. Store a version field and run ordered migrations on load; never delete a field in the release that stops writing it, and never reuse a field name with a new meaning.
    Why: templates change often and updates must be rollback-safe. [repo: EL4CTEO/roblox-skills]
12. Save purchase records yourself at grant time.
    Why: Roblox does not keep purchase records for you. [Roblox docs: monetization]
13. Read tunable numbers through Roblox Configs, with keys named in Config.
    Why: values change live without publishing. [Roblox docs: configs]
14. Pick one pinned library per category, never edit its source, and look up any uncertain API in the official docs.
    Why: mixed versions and recalled signatures produce broken code. [repo: awesome-roblox/awesome-roblox; repo: zilibobi/roblox-skills]

## Checklist
- [ ] `servePlaceIds` set to this game.
- [ ] One entry script per side; systems use Init then Start, neither yields.
- [ ] No authoritative price or reward table in ReplicatedStorage.
- [ ] Every division feeding saved data is guarded against NaN.
- [ ] Studio testing uses a separate test universe or data store name, never live data.
- [ ] Each player and feature has one cleanup object.
- [ ] `wally.lock` committed; game manifest marked private.

## Sources
- Roblox docs: production/monetization, production/configs
- repo: MadStudioRoblox/ProfileStore
- repo: rojo-rbx/rojo (and rojo.space project format)
- repo: UpliftGames/wally
- repo: EL4CTEO/roblox-skills
- repo: fizzyhex/luau-skills
- repo: Quenty/NevermoreEngine
- repo: zilibobi/roblox-skills
- repo: awesome-roblox/awesome-roblox

## Lessons from launched games
Add dated lessons here after each launch.
