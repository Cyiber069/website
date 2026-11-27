# Game templates

Six starting points for Roblox Game Factory games. Each one is a proven genre with the shared systems already in place, so a new game needs a theme and one new mechanic.

**Status: waiting for the owner to approve which ones to build. Nothing here is built yet.**

The images are concept previews of the phone screen, drawn in `previews.html`. They are not screenshots of a running game: final art and layout are made in Roblox Studio.

| # | Template | Genre | Loop in one line | The one mechanic you change per game |
|---|---|---|---|---|
| 1 | Tap Simulator | Simulation, incremental | Tap for power, unlock zones, rebirth | The twist on the tap |
| 2 | Collect and Sell | Simulation, gathering | Fill the bag, sell, upgrade tool and bag | What you collect and how |
| 3 | Empire Tycoon | Simulation, tycoon | Buy machines, earn per second, expand the plot | The business you run |
| 4 | Roll for Rarity | Simulation, luck | Roll for auras with shown odds, fill the index | What a roll gives |
| 5 | Survive the Rounds | Survival, rounds | Survive the disaster, earn coins, buy perks | The danger |
| 6 | Tower Obby | Obby, climbing | Clear stages, bank checkpoints, race the timer | The obstacle set |

## Why these six

On the day they were drawn, Roblox's public charts showed Simulation as the largest genre in Up-and-Coming (46 of 97 games) and Survival second (14). Four templates are simulation variants, one is survival, one is the obby genre the playbook lists as proven.

## What every template shares

Saving, currency, shop, passes and products with one purchase handler, rebirth, daily rewards, quests, the HUD shell, server-checked actions with rate limits, analytics events and one settings file for reskinning. See `GameFactorySkills/REUSABLE_TEMPLATE_PLAN.md`.

## Estimates

"Shared code" and "days to first build" on the previews are estimates, not measurements. No template has been built or timed.

## Rules that apply to all of them

- Template 4 shows every outcome and its odds to the player, and rolls are earned by playing. Any paid luck item shows its odds before purchase, as Roblox requires.
- No pay-to-skip timers as the main income; skips are a side option only.
- Nothing is sold in the first minutes of a new player's first session.

## After approval

The shared core is built once, then each approved template on top of it, as text files a Rojo project can sync into Roblox Studio. The code can be written and checked here; it can only be play-tested inside Roblox Studio on the owner's PC.
