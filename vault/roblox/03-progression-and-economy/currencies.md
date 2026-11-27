# Soft And Hard Currencies

> Use one soft currency earned freely through play for the core loop, and at most one hard currency that is scarce, optional and never required to progress.

## Roles

| | Soft currency | Hard currency |
| --- | --- | --- |
| Source | Core action, constantly | Milestones, events, Robux purchases |
| Spent on | Core upgrades | Cosmetics, convenience, optional boosts |
| Inflates | Yes, by design | No, keep it stable |

Why separate them: the soft currency must inflate as players progress, so anything priced in it loses meaning over time. A stable second currency lets rare rewards and paid items keep their value. Why at most one hard currency: every extra currency is another thing a phone player must learn and another HUD slot; see [[Mobile-First HUD Zones]].

## Sources and sinks

List every way each currency enters the game and every way it leaves.

- **Every source needs a sink.** If currency accumulates unspent, the player has run out of goals. Add tiers or a rebirth layer, as in [[Rebirth And Prestige Systems]].
- **Sinks should feel like gains.** Upgrades, unlocks, cosmetics. Avoid taxes and repair fees. Why: paying to stand still feels like punishment.
- **Give free players a trickle of hard currency.** Why: it lets them sample what it buys and keeps the economy from feeling paywalled.

## Storage and display

- Store amounts as numbers in the player's profile on the server; replicate to the client for display only. Why: a client-owned value can be edited by exploiters. See [[Server-Authoritative Remotes]].
- Inflation can push values very high. Double-precision numbers represent whole numbers exactly only up to about nine quadrillion, so beyond that, small additions are lost. Either keep the economy below that range or store a mantissa and exponent pair. Why: silent precision loss looks like a bug to players.
- Abbreviate on the HUD (1.2K, 3.4M) and show the full value in a detail view. Why: long numbers overflow small screens.

```lua
local SUFFIXES = { "", "K", "M", "B", "T", "Qa" } -- Qa covers up to the exact-integer limit
local function abbreviate(n: number): string
	local i = 1
	while n >= 1000 and i < #SUFFIXES do
		n /= 1000
		i += 1
	end
	if i == 1 then
		return string.format("%d", n)
	end
	n = math.floor(n * 10) / 10 -- floor so 999,950 shows 999.9K, not 1000.0K
	return string.format("%.1f", n) .. SUFFIXES[i]
end
```

## Rules for anything bought with Robux

If hard currency can be purchased, grant it through a developer product handled as in [[ProcessReceipt Idempotency]], and never let it buy random rewards without following [[Paid Random Items Compliance]].

## Check before you hand off

- Each currency has a written list of sources and sinks.
- No more than two currencies appear on the HUD.
- All balances live in server-side profile data.
- Large values display abbreviated and do not overflow on a phone.
- Free players have at least one way to earn the hard currency.
