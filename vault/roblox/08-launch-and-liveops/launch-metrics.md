# Launch Metrics To Measure

> Track a small set of numbers, onboarding funnel, session length, day-one retention and purchase conversion, and let the worst one decide what to work on next.

## The core set

| Metric | Meaning | What a weak value points to |
| --- | --- | --- |
| Onboarding funnel | Share of new players reaching each early step | The step with the biggest drop; see [[01 First Five Minutes]] |
| Average session length | Time from join to leave | Loop fun and pacing; see [[Session Pacing And Stopping Points]] |
| Day-one retention | Share of new players who return the next day | Missing long goal or return hook |
| Day-seven retention | Share returning a week later | Content depth and update rhythm |
| Conversion | Share of players who buy anything | Offer relevance and timing; see [[Fair Offer Design]] |
| Revenue per paying player | Spend among buyers | Catalogue depth |

Why these: they follow the player's journey in order. A problem early in the journey makes later numbers meaningless, so read from the top down.

Roblox's creator dashboard reports retention, session time and monetization for an experience and compares them with similar experiences. Use those benchmarks rather than numbers quoted elsewhere, because typical values vary by genre and change over time.

## Instrumenting the funnel

Define five to ten steps that every new player should pass, in order: character spawned, first action, first reward, first upgrade, second zone, rebirth unlocked. Log each once per player from the server. `AnalyticsService` provides onboarding funnel logging for this purpose; check the current documentation for the exact method signatures, and wrap calls in one module so they can change in a single place.

```lua
-- Server wrapper: one place that knows the analytics API
local Analytics = {}

function Analytics.onboardingStep(player: Player, step: number, name: string)
	task.spawn(function()
		pcall(function()
			AnalyticsService:LogOnboardingFunnelStepEvent(player, step, name)
		end)
	end)
end

return Analytics
```

Why server-side and once: clients can be tampered with, and repeated logging inflates steps.

## Economy and custom events

Log currency sources and sinks by type, and purchases by item. Why: it shows where currency pools and which offers matter, feeding [[Cost Curves And Tuning]].

## Reading the numbers

- Compare cohorts by join date, before and after a change. Why: totals mix old and new players and hide the effect.
- Wait for enough players before drawing conclusions; small samples swing widely.
- Change one significant thing per release. Why: otherwise the cause of a shift is unknowable.
- Pair numbers with observation from [[Watching New Players Play]]. Numbers say where; watching says why.

## Honesty

Report metrics exactly as measured, with the date range and sample size. Do not predict results or quote targets you cannot source.

## Check before you hand off

- Funnel steps are defined in order and logged once per player on the server.
- Analytics calls are isolated in one module and wrapped in `pcall`.
- Currency sources, sinks and purchases are logged by type.
- A short note says which metric is currently weakest and what change addresses it.
- Any reported number includes its date range and sample size.
