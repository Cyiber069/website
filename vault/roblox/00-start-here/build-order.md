# Build Order From Prototype To Launch

> Build the core loop with placeholder art first, then saving and progression, then UI and world polish, then monetization, and only then launch.

## Why order matters

Polish applied to a loop that is not fun is wasted, and monetization bolted onto a game nobody replays earns nothing. Each stage below has an exit test; do not move on until it passes.

## Stages

**Stage 1: Grey-box loop.** Plain parts, no menus. Implement the action, the reward and one upgrade from [[Defining The Core Loop]]. Exit test: a tester plays for several minutes without being asked to.

**Stage 2: Project skeleton.** Set up folders, modules and remotes as in [[Code Layout In Roblox Services]] and, if using external tooling, [[Rojo Project Layout]]. Why now: restructuring later, with a dozen scripts, costs far more.

**Stage 3: Saving.** Add player data loading and saving per [[DataStore Save Patterns]]. Why before progression content: every later system writes into this data shape, and migration is painful.

**Stage 4: Progression.** Add upgrade tiers, cost curves and a rebirth layer per [[Cost Curves And Tuning]] and [[Rebirth And Prestige Systems]]. Exit test: a timing table shows a sensible gap between purchases for the first session.

**Stage 5: First five minutes.** Design spawn, onboarding and the first reward per [[01 First Five Minutes]]. Why after progression: you cannot stage the opening until you know what the player is progressing toward.

**Stage 6: HUD and world.** Lay out the HUD per [[Mobile-First HUD Zones]], then build the map within [[Part Count And Performance Budgets]].

**Stage 7: Monetization.** Add passes and products per [[06 Monetization]]. Why late: offers should accelerate a loop that already works for free players.

**Stage 8: Playtest and launch.** Run [[Playtest Checklist For PC And Phone]], then follow [[Soft Launch And Store Page]].

## Rules while building

- Keep the game playable at the end of every work session. Why: a broken build cannot be playtested, and untested work hides defects.
- One system per change. Why: when retention or a bug shifts, you know the cause.
- Write tuning values in one config ModuleScript. Why: balance changes become data edits instead of code hunts.

## Check before you hand off

- You stated which stage the project is in and whether its exit test passed.
- No stage was skipped; if one was, the reason is written down.
- The build runs without errors in the Output window from a fresh start.
- Tuning numbers live in a config module, not scattered through scripts.
