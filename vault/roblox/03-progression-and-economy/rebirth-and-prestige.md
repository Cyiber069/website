# Rebirth And Prestige Systems

> A rebirth lets the player reset core progress in exchange for a permanent multiplier, turning a slowing curve into a new, faster run.

## Why it works

Exponential costs eventually make progress crawl. Rebirth converts that wall into a choice: start again, but stronger. The replay is faster than the first run, which feels powerful, and the permanent multiplier is a long goal that survives every reset. It reuses existing content, so it adds hours without new assets.

## Design rules

- **Unlock visibility early, availability later.** Show the rebirth button and its requirement within the first session. Why: it is the long goal on the [[First Session Goal Ladder]].
- **Make the first rebirth reachable in the first or second session.** Why: the mechanic only motivates once experienced.
- **Each run must be faster than the last.** If the requirement grows quicker than the multiplier, later rebirths feel worse. Check with the timing table from [[Cost Curves And Tuning]].
- **Reset only loop progress.** Soft currency and upgrades reset. Hard currency, purchases, cosmetics and collections do not. Why: wiping paid or rare items feels like theft.
- **Confirm clearly.** One dialog stating what is lost and what is gained. Why: this is the one place onboarding needs words; see [[Tutorial-Less Onboarding]].
- **Add something new per layer.** A new zone, a cosmetic aura, a rebirth-only shop. Why: repeating identical content with bigger numbers wears thin.

## Tuning the curve

```lua
local Rebirth = {}

function Rebirth.requirement(count: number): number
	return math.floor(Config.RebirthBaseCost * Config.RebirthCostGrowth ^ count)
end

function Rebirth.multiplier(count: number): number
	return 1 + Config.RebirthBonusPerRebirth * count
end

return Rebirth
```

- Requirement growth sets how much further each run must go.
- Multiplier growth sets how much faster each run is.
- Simulate: for rebirth counts 0 to 10, estimate run time with the multiplier applied. Aim for run times that stay flat or rise gently. If run time climbs steeply, raise the bonus or lower cost growth; if it collapses to seconds, do the reverse.

Why simulate instead of guess: the two exponents interact, and a small mismatch compounds into either a wall or a triviality within a few rebirths.

## Server implementation

The rebirth request carries no arguments. The server checks the requirement against saved data, applies the reset and increments the count in one step, then saves. See [[Server-Authoritative Remotes]] and [[DataStore Save Patterns]].

## Check before you hand off

- The rebirth requirement is visible in the first session.
- A simulation table of run time per rebirth exists and does not climb steeply.
- Purchased and rare items survive rebirth.
- A confirmation dialog states losses and gains in one or two short lines.
- The server performs and validates the whole rebirth; the client sends no values.
