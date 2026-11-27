# Game Design and Core Loop

> Design a loop that is fun within 10-30 seconds of spawning and gets stronger each time it repeats.

## When to use

- After an idea passes market research, before any building.
- When a playtest shows players leaving in the first minutes.
- When scoping the first playable slice.

## Rules

1. State the loop as one verb (jump, build, collect) wrapped in do, earn, upgrade, repeat.
   Why: one verb stays explainable and buildable in days. [repo: AshExplained/roblox-skills; repo: m4bwav/roblox-agent]
2. Fill three boxes before building: the minute-to-minute action, the most repeated action set, and the progression engine.
   Why: Roblox defines the loop this way; with the third box empty the game turns repetitive and shallow. [Roblox docs: core-loops]
3. Make everything earned visibly improve the player's ability to do the first two boxes again.
   Why: that link turns a list of actions into a loop. [Roblox docs: core-loops]
4. Let the player do the first fun action within 10-30 seconds of spawning.
   Why: players leave in one tap, and this number is what playtests measure against. [repo: AshExplained/roblox-skills]
5. End every loop cycle with a reward and a visible next goal, and tune difficulty away from both frustration and boredom.
   Why: clear, fun, rewarded steps are the main driver of D1 retention. [Roblox docs: retention]
6. Make three answers obvious from play alone: what is fun, what is different, why play again.
   Why: new players decide within minutes, and they skip text. [Roblox docs: get-started/strategies]
7. Do not lock the fun behind progression; session one needs enough content to be enjoyable.
   Why: progression should slow later consumption, not starve the first session. [Roblox docs: get-started/strategies]
8. Show short, mid and long-term goals in the world or HUD.
   Why: Roblox ties D1 to the loop, D7 to progression, D30 to endgame and social systems. [Roblox docs: core-loops; retention]
9. Design for friends: no forced solo instances, no long gates before meeting others, and a map small enough that players meet.
   Why: player interaction acts as free content; huge maps spread players thin. [Roblox docs: get-started/strategies; engagement]
10. Avoid forced cutscenes, long tutorials, desktop-only controls, hidden progression, harsh early penalties and pay-to-win shortcuts, and content that runs out before roughly 2-3 hours of play; place a meaningful unlock just before that mark.
   Why: the source ties the 2-3 hour content wall to Day-3 drop-off. [repo: AshExplained/roblox-skills]
11. Build a tracer bullet first: one action, one reward, one next goal, through input, remote, server, data and UI. Then add persistence, progression, social, monetization, polish.
   Why: a broken idea shows up in hours, and server authority is there from the start. [repo: AshExplained/roblox-skills]
12. Skip any system used fewer than three times, and fix one word per currency or item.
   Why: it keeps each game cheap and reskins workable. [repo: m4bwav/roblox-agent; repo: AshExplained/roblox-skills]

## Checklist

- [ ] Loop written as one verb plus do-earn-upgrade-repeat
- [ ] Three boxes filled; box three not empty
- [ ] Upgrades visibly strengthen the core action
- [ ] First fun action reachable in 10-30 seconds
- [ ] Short, mid and long goals visible in world or HUD
- [ ] Friends can play together; map is compact
- [ ] Unlock planned before the 2-3 hour mark
- [ ] Tracer bullet slice defined and playtested alone
- [ ] One canonical name per currency and item

## Sources

- Roblox docs: core-loops; retention; engagement; get-started/strategies
- repo: AshExplained/roblox-skills
- repo: m4bwav/roblox-agent
- repo: awesome-roblox/awesome-roblox (example games Price Point and Slither; unopened, unverified)

## Lessons from launched games

Add dated lessons here after each launch.
