# Game Passes Versus Developer Products

> Use game passes for permanent one-time unlocks and developer products for anything a player can buy repeatedly, and grant both only from the server.

## The two types

| | Game pass | Developer product |
| --- | --- | --- |
| Bought | Once per account | Any number of times |
| Good for | Permanent perks: double coins, extra slot, VIP area | Currency packs, timed boosts, skips |
| Ownership check | Platform remembers it | You must record what was granted |
| Grant path | Check ownership on join and after purchase | `ProcessReceipt` callback |

Why the split matters: the platform tracks pass ownership for you, so passes are simple and safe for permanent benefits. Products have no ownership record, so your data is the only proof of delivery; see [[ProcessReceipt Idempotency]].

## Game pass rules

- **Check ownership on the server when the player joins** with `MarketplaceService:UserOwnsGamePassAsync(userId, passId)` inside `pcall`, and cache the result in the session. Why: the call is a web request that can fail and should not be repeated constantly.
- **Apply the perk in server logic.** A double-coins pass changes the multiplier in the server's reward function. Why: a perk applied on the client can be faked.
- **Handle purchase during play.** Listen to `PromptGamePassPurchaseFinished` on the server and, when `wasPurchased` is true for a known pass id, set the session's cached ownership to true and apply the perk directly. Do not call `UserOwnsGamePassAsync` again there. Why: that call is cached per server and can still return false right after an in-experience purchase, and making the player rejoin to receive what they bought feels broken.
- **Passes survive rebirth and resets.** See [[Rebirth And Prestige Systems]].

```lua
local MarketplaceService = game:GetService("MarketplaceService")

local function ownsPass(player: Player, passId: number): boolean
	local ok, owns = pcall(MarketplaceService.UserOwnsGamePassAsync, MarketplaceService, player.UserId, passId)
	return ok and owns
end
```

## Developer product rules

- Prompt from the client with `MarketplaceService:PromptProductPurchase`; grant only in the server's `ProcessReceipt`.
- Keep product IDs and their effects in one server-side table. Why: one place to audit what each purchase gives.
- Design products as accelerators of the existing loop, per [[Fair Offer Design]].

## Prompting

- Open prompts only from a deliberate tap on a clearly priced button; see [[Menus And Shop Screens]].
- Never fire a prompt automatically on join or on death. Why: unrequested prompts feel predatory and teach players to dismiss everything.
- Fetch names and prices from the platform with `MarketplaceService:GetProductInfo(id, Enum.InfoType.GamePass)` for passes or `Enum.InfoType.Product` for developer products, inside `pcall`, and cache the result, rather than hard-coding prices in the interface. Why: a price edited on the website would otherwise mismatch the button; the `InfoType` argument is required because the default is `Asset`, which looks up the wrong kind of id.

## Testing

Purchases made in Studio testing are simulated and do not spend Robux. Test buying each item, buying a pass mid-session, and joining as an existing owner. See [[Studio Test Modes]].

## Check before you hand off

- Permanent perks are passes; repeatable purchases are products.
- Pass ownership is checked on the server at join, with `pcall`, and cached.
- A pass bought mid-session takes effect without rejoining.
- No client script grants a perk or currency.
- Displayed prices come from the platform, not constants.
