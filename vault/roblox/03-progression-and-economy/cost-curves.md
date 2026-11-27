# Cost Curves And Tuning

> Price repeated upgrades with an exponential curve, then tune the growth rate by looking at the time between purchases rather than at the prices themselves.

## The formula

```lua
local function upgradeCost(base: number, growth: number, level: number): number
	return math.floor(base * growth ^ level)
end
```

- `base` is the first price. Set it so the first purchase lands inside the opening seconds; see [[First Reward Inside Thirty Seconds]].
- `growth` is the multiplier per level. As a starting point for drafts, values a little above 1, roughly 1.07 to 1.25, are common for upgrades bought many times; larger jumps suit tiers bought once.

Why exponential: income usually rises in proportion to upgrades owned, which is closer to linear or polynomial. A linear price would be outrun and everything would become trivially affordable. An exponential price eventually outgrows income, so each purchase takes a little longer than the last, which is what creates a sense of rising stakes.

## Tune by time-to-next

Players do not experience prices; they experience waiting. Build a table from the config:

| Level | Cost | Income per second at this level | Seconds to afford |
| --- | --- | --- | --- |

Generate it with a script and read the last column.

- **First minutes: gaps of seconds.** Why: frequent purchases teach the loop.
- **Gaps should rise smoothly.** A sudden jump is a wall; a long flat stretch is a slog with no change.
- **When a gap becomes long, a new mechanic should arrive**: a new zone, a new upgrade track, or rebirth. Why: the answer to a growing wait is a new way to shrink it. See [[Rebirth And Prestige Systems]].

## Adjusting

- Gaps grow too fast: lower `growth`, or raise the income each level adds.
- Everything is bought instantly: raise `growth` slightly; small changes compound heavily over many levels.
- One upgrade dominates: compare cost per unit of added income across tracks and bring them within a similar range. Why: a single obviously best choice removes the decision that makes spending interesting.

## Practical rules

- Keep all curve parameters in one config ModuleScript shared by server and client. Why: the shop shows the same price the server charges. Layout is in [[Code Layout In Roblox Services]].
- The server recomputes the price at purchase time and never accepts a price from the client.
- Change live values in small steps and note each change in the update log. Why: players notice, and large swings feel unfair to those who paid the old price.

## Check before you hand off

- A time-to-next table exists for the first session and was reviewed.
- No gap in the first five minutes exceeds a minute without a new unlock.
- Prices are computed from shared config on both client and server.
- The server validates affordability and charges its own computed price.
- Each upgrade track has a reason to be bought at some stage.
