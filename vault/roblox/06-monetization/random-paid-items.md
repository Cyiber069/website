# Paid Random Items Compliance

> Any random reward that can be obtained with Robux, directly or through purchased currency, must show its odds before purchase and must be disabled for players whose region restricts it.

## What counts

A paid random item is any reward whose contents are decided by chance and which a player can get by spending Robux, including through an in-game currency that can be bought with Robux. Eggs, crates, spins and gacha banners usually qualify. Why this matters: Roblox policy requires disclosure of odds for such items, and some countries restrict them entirely. Non-compliance risks moderation of the experience and harms players.

Read the current Roblox Community Standards and monetization policies before shipping; this note states the principle, and the official text governs.

## Rules

- **Show the actual odds before the purchase.** List every possible reward or rarity tier with its percentage, on the item's card or one tap away. Why: informed choice is the requirement, and transparent odds also build trust.
- **Displayed odds must be the real odds.** Generate the display from the same server config table that the roll uses. Why: two separate tables drift apart, and misstating odds is deceptive.
- **Roll on the server.** The client never chooses or reports the outcome. See [[Server-Authoritative Remotes]].
- **Check the player's policy info.** `PolicyService:GetPolicyInfoForPlayerAsync(player)` returns a table that includes `ArePaidRandomItemsRestricted`. When true, do not offer paid random items to that player.
- **Fail closed.** If the policy call errors, treat the player as restricted until it succeeds. Why: the safe default is not to sell.
- **Offer a non-random alternative** for restricted players, such as buying a specific item at a fixed price or earning rolls only through play with a currency that cannot be bought. Why: they still deserve a complete game.

```lua
local PolicyService = game:GetService("PolicyService")

local function paidRandomAllowed(player: Player): boolean
	local ok, info = pcall(PolicyService.GetPolicyInfoForPlayerAsync, PolicyService, player)
	if not ok or not info then
		return false
	end
	return not info.ArePaidRandomItemsRestricted
end
```

Call this on the server, cache the result for the session, send the client a flag to hide the relevant interface, and enforce the same check again in the server's purchase handler. Why both: hiding is for clarity; the server check is the actual control.

## Design guidance

- Add a pity or guaranteed-progress mechanic so bad luck is bounded. Why: unbounded bad streaks produce regret and quits; see [[Fair Offer Design]].
- Disclose pity rules alongside the odds.
- Do not tie core progression to random paid rewards.

## Check before you hand off

- Every paid random item displays complete odds before purchase.
- Displayed odds are generated from the server's roll table.
- Outcomes are rolled on the server only.
- `ArePaidRandomItemsRestricted` is checked server-side, fails closed, and is enforced in the purchase handler.
- Restricted players see a working non-random alternative and no broken buttons.
