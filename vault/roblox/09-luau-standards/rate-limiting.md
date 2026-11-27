# Rate Limiting Client Requests

> Give every remote a per-player limit enforced on the server, so that spamming a valid request cannot multiply rewards or exhaust server resources.

## Why validation alone is not enough

A request can be perfectly valid and still be sent a thousand times a second. Without a limit, an auto-clicker or script multiplies income, floods DataStore or purchase logic, or slows the server for everyone. Limits also catch honest bugs, such as a client loop firing a remote every frame.

## Rules

- **Enforce on the server.** A client-side cooldown is only a courtesy to honest players.
- **Limit per player and per remote.** Why: a fast legitimate action, such as tapping to collect, needs a different allowance from a slow one, such as rebirth.
- **Use the game's own cadence.** If the tool swings twice a second, the server accepts about that rate plus a small tolerance for network jitter. Why: bursts arrive bunched on poor connections; a limit with no tolerance punishes mobile players.
- **Drop excess requests silently.** Do not queue them. Why: a queue lets spam turn into delayed rewards.
- **Count repeated violations.** Occasional overflow is lag; sustained overflow is automation. Log it, and kick only on extreme, persistent abuse. Why: false positives against laggy players cost real users.
- **Clean up on leave.** Remove the player's entries in `PlayerRemoving`. Why: per-player tables otherwise leak memory over a long-running server.
- **Rate limit before expensive validation.** Why: the cheapest check should run first.

## Token bucket pattern

Each player has a bucket per action that refills steadily up to a cap. A request spends one token; an empty bucket means rejection. The cap allows short bursts; the refill rate sets the sustained limit.

```lua
--!strict
local RateLimit = {}

type Bucket = { tokens: number, last: number }
type Rule = { perSecond: number, burst: number }

local rules: { [string]: Rule } = {
	Collect = { perSecond = 4, burst = 6 },
	BuyUpgrade = { perSecond = 5, burst = 10 },
	Rebirth = { perSecond = 0.5, burst = 1 },
}

local buckets: { [Player]: { [string]: Bucket } } = {}

function RateLimit.check(player: Player, action: string): boolean
	local rule = rules[action]
	if not rule then return false end

	local now = os.clock()
	local playerBuckets = buckets[player]
	if not playerBuckets then
		playerBuckets = {}
		buckets[player] = playerBuckets
	end

	local bucket = playerBuckets[action]
	if not bucket then
		bucket = { tokens = rule.burst, last = now }
		playerBuckets[action] = bucket
	end

	bucket.tokens = math.min(rule.burst, bucket.tokens + (now - bucket.last) * rule.perSecond)
	bucket.last = now
	if bucket.tokens < 1 then return false end
	bucket.tokens -= 1
	return true
end

function RateLimit.clear(player: Player)
	buckets[player] = nil
end

return RateLimit
```

The numbers above are placeholders; derive real ones from the action's designed speed. An unknown action name is rejected, so every remote must be registered. Why: forgetting to add a rule fails safe.

## Beyond remotes

Apply the same thinking to anything a player can trigger repeatedly: purchases in soft currency, chat-like features, and requests that cause DataStore writes; see [[DataStore Save Patterns]]. Argument validation is covered in [[Server-Authoritative Remotes]].

## Check before you hand off

- Every remote handler calls the limiter first.
- Limits match each action's intended cadence with a small burst tolerance.
- Excess requests are dropped, not queued.
- Player entries are cleared on leave.
- Spamming each remote from a test client produced no extra rewards and no server slowdown.
