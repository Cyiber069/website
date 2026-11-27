# First Session Goal Ladder

> Give the player a chain of goals at three distances, seconds, minutes and next visit, so there is always a reason to continue and a reason to return.

## The ladder

| Distance | Example shape | Purpose |
| --- | --- | --- |
| Seconds | Next upgrade is almost affordable | Keeps hands busy |
| Minutes | Unlock the next zone or tool tier | Gives the session a shape |
| Next visit | Rebirth, a collection, a timed reward | Gives a reason to come back |

Why three: a player with only short goals feels busy but aimless; a player with only long goals feels the grind. Overlapping distances mean finishing one goal always happens in sight of another.

## Rules

- **Show goals with progress.** A bar or "42 / 100" beside the goal. Why: visible progress makes the remaining effort feel smaller as it shrinks.
- **Front-load unlocks.** New mechanics or areas should arrive frequently in the first minutes and then stretch out. Why: early novelty builds the habit before the grind arrives. Tune spacing with [[Cost Curves And Tuning]].
- **Reveal the next rung before the current one ends.** Show the locked zone's gate and price while the player is still in the first zone. Why: a finished goal with no successor is a natural exit point.
- **End the first session on an open goal.** Aim for the player to be partway to something meaningful around the time a first session typically ends. Why: an unfinished goal is remembered. See [[Session Pacing And Stopping Points]].
- **Introduce the long goal by the five-minute mark.** Unlock or at least display the rebirth or collection system by then. See [[Rebirth And Prestige Systems]].

## Implementation sketch

Keep goals as data so they can be reordered without code changes.

```lua
export type Goal = { id: string, text: string, stat: string, target: number, reward: number }

local Goals: { Goal } = {
	{ id = "collect10", text = "Collect 10 coins", stat = "CoinsCollected", target = 10, reward = 25 },
	{ id = "firstUpgrade", text = "Buy your first upgrade", stat = "UpgradesBought", target = 1, reward = 50 },
	{ id = "zone2", text = "Unlock the second zone", stat = "ZonesUnlocked", target = 2, reward = 200 },
}
return Goals
```

The server tracks the stats and grants rewards; the client shows the current goal text and bar.

## Check before you hand off

- At every point in the first five minutes, a seconds-goal and a minutes-goal are visible.
- A long goal is revealed by the five-minute mark.
- Each goal shows numeric or bar progress.
- Goals are defined in a data module and rewarded by the server.
- A timed first-session playthrough is recorded with the time of each unlock.
