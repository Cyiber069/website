# 03 Progression and Economy

> This chapter covers currencies, upgrade cost curves, rebirth layers and the saving code that keeps every earned value safe.

## Why this chapter exists

Progression stretches a fun loop from minutes into weeks. It works when the gap between rewards grows slowly enough to stay motivating and when nothing a player earns is ever lost. Both halves matter equally: a perfect curve is worthless if data is wiped, and perfect saving cannot rescue a curve that walls players after ten minutes.

## Notes in this chapter

- [[Soft And Hard Currencies]] defines the two currency roles, where each comes from and goes, and how to keep sources and sinks balanced.
- [[Cost Curves And Tuning]] gives the exponential cost formula, how to choose the growth rate, and the timing table used to tune it.
- [[Rebirth And Prestige Systems]] explains reset-for-multiplier layers, when to unlock them and how to price repeated rebirths.
- [[DataStore Save Patterns]] gives the loading, session locking, `UpdateAsync`, retry and `BindToClose` rules for player data.

## How to use it

1. Decide currencies and what each buys.
2. Put every price and rate in one config module.
3. Generate a timing table from the config and adjust until early gaps are short and later gaps grow smoothly.
4. Implement saving before adding more content, so the data shape settles early.

## Related chapters

- The loop being stretched is defined in [[02 Core Loop]].
- Selling currency or boosts is covered in [[06 Monetization]].
- All economy changes happen on the server; see [[Server-Authoritative Remotes]].

## Warning signs

- Players report lost progress, even once.
- A single upgrade is always the best purchase.
- Currency piles up with nothing to spend it on.
- The second rebirth takes longer than the first.
