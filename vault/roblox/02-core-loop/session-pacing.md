# Session Pacing And Stopping Points

> Shape each session as bursts of activity separated by short rests, and make sure a player who stops is leaving something unfinished that they want to return to.

## Rhythm inside a session

- **Alternate intensity.** Follow a stretch of active collecting or fighting with a calmer moment: spending, customising, walking to a new area. Why: constant intensity tires players; constant calm bores them.
- **Shorten early cycles, lengthen later ones.** Early purchases come seconds apart, later ones minutes apart. Why: the habit forms on fast rewards and is then sustained by bigger ones. Tune with [[Cost Curves And Tuning]].
- **Give active play a clear edge over idling.** If the game has passive income, active play should earn noticeably more. Why: otherwise the best strategy is to do nothing, which is not a game.

## Stopping points

Players stop when a goal completes and nothing else is in view. Control that moment:

- **Overlap goals** so finishing one reveals progress on another. See [[First Session Goal Ladder]].
- **Offer a positive exit.** A visible "come back for" item, such as a timed chest or a daily streak, turns leaving into anticipation. Why: a player who leaves with a plan returns more reliably than one who leaves from boredom.
- **Never punish leaving.** No decaying progress, no losses while offline. Why: punishment creates dread, and dread ends in uninstalling rather than loyalty.

## Return hooks, used honestly

- **Offline or away earnings**, capped to a modest amount. Why: the returning player opens with a reward and something to spend immediately.
- **Daily reward with a forgiving streak.** Use server time from `os.time()` and saved timestamps, never the client clock. Why: client time can be changed by the player. Save patterns are in [[DataStore Save Patterns]].
- **Short timed boosts** earned through play. Why: they create a "use it now" burst without forcing anything.

```lua
-- Server: has a new daily reward become available?
local DAY = 24 * 60 * 60
local function canClaimDaily(profile): boolean
	return os.time() - (profile.LastDailyClaim or 0) >= DAY
end
```

## What to avoid

Timers that block the core action, energy systems that stop play outright, and pop-ups that interrupt a burst. Why: they convert a willing player into a waiting one.

## Check before you hand off

- A session timeline shows alternating active and calm beats.
- Active play out-earns idling by a clear margin in the config.
- At least one return hook exists and uses server time.
- No system removes progress while the player is away.
- Finishing any first-session goal leaves another goal visibly in progress.
