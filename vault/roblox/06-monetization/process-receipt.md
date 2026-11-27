# ProcessReceipt Idempotency

> Grant each developer product purchase exactly once by recording its purchase ID in the player's saved data and confirming only after that data is safely stored.

## How the callback works

After a developer product is bought, Roblox calls the single function assigned to `MarketplaceService.ProcessReceipt` on a server, passing a receipt with fields including `PlayerId`, `ProductId` and `PurchaseId`. The function returns `Enum.ProductPurchaseDecision.PurchaseGranted` or `NotProcessedYet`. If it does not return granted, the platform calls it again later, possibly in a different server after the player rejoins.

Why this demands care: the callback can run more than once for the same purchase. Granting without a record risks double delivery; confirming without saving risks a paid purchase lost to a crash.

## Rules

- **Assign `ProcessReceipt` in exactly one server script.** Why: it is a single callback; a second assignment silently replaces the first.
- **Record `PurchaseId` in the player's profile.** If it is already there, do not grant again. Why: this makes the handler idempotent, meaning repeated calls have the same result as one.
- **Return granted only after a successful save.** Why: once you confirm, the platform will never ask again.
- **Return `NotProcessedYet` when unsure**: player not in the server, profile not loaded, unknown product, save failed. Why: a retry is safe; a wrong confirmation is not.
- **Never yield indefinitely**, and wrap the handler body in `pcall`.
- **Bound the stored history**, keeping the most recent purchase IDs. Why: the profile must not grow without limit.

## Pattern

```lua
local Granted = Enum.ProductPurchaseDecision.PurchaseGranted
local Retry = Enum.ProductPurchaseDecision.NotProcessedYet

MarketplaceService.ProcessReceipt = function(receipt)
	local player = Players:GetPlayerByUserId(receipt.PlayerId)
	local profile = player and Profiles.get(player)
	local grant = Products[receipt.ProductId]
	if not profile or not grant then
		return Retry
	end

	if not profile.Purchases[receipt.PurchaseId] then
		local ok = pcall(grant, player, profile)
		if not ok then
			return Retry
		end
		profile.Purchases[receipt.PurchaseId] = os.time()
	end

	-- Already applied in memory (now or on an earlier attempt): make sure it is stored.
	if Profiles.saveNow(player) then
		return Granted
	end
	return Retry
end
```

The grant functions should change only profile data, so that the grant and its record are written together by the same save. Saving rules, including session locking that stops two servers handling one player, are in [[DataStore Save Patterns]].

## Things to test

- Buy, then stop the server before a save: after rejoining, the item is delivered once.
- Force the save to fail: the handler returns retry and no duplicate appears later.
- Buy the same product several times quickly: each purchase is granted once.

Product design and the pass alternative are covered in [[Game Passes Versus Developer Products]].

## Check before you hand off

- One script assigns `ProcessReceipt`.
- Purchase IDs are stored in the saved profile and checked before granting.
- Granted is returned only after a confirmed save.
- Every uncertain branch returns `NotProcessedYet`.
- The three tests above were run in Studio and their results noted.
