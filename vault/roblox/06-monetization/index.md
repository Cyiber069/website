# 06 Monetization

> This chapter covers what to sell for Robux, how to grant purchases safely, how to comply with policy on random paid items, and how to keep offers fair.

## Why this chapter exists

Revenue on Roblox comes from players who enjoy a game enough to stay, and who then choose to spend. Monetization therefore follows retention; it cannot substitute for it. The technical side matters just as much as the design side: a purchase that is charged but not delivered, or delivered twice, damages trust or the economy, and an offer that breaks platform policy can get an experience moderated.

## Notes in this chapter

- [[Game Passes Versus Developer Products]] explains the two purchase types, when to use each, and how to check ownership and prompt purchases.
- [[ProcessReceipt Idempotency]] gives the pattern for granting developer products exactly once, even across retries and server changes.
- [[Paid Random Items Compliance]] covers showing odds and using `PolicyService` to respect regional restrictions on paid random rewards.
- [[Fair Offer Design]] sets out what to sell, when to show it, and what never to do.

## How to use it

1. Finish and playtest the free loop first; see [[Build Order From Prototype To Launch]].
2. Choose a small catalogue: a few permanent passes and a few repeatable products.
3. Implement granting on the server with saved purchase records.
4. Test every purchase path in Studio, where test purchases do not charge real Robux.

## Related chapters

- Currency roles are in [[Soft And Hard Currencies]].
- Shop interface rules are in [[Menus And Shop Screens]].
- Purchase conversion is measured per [[Launch Metrics To Measure]].

## Principles

- The server grants; the client only asks the platform to open a prompt.
- Free players must be able to progress and have fun. They are the community paying players want to play in.
- Read the current Roblox policies before shipping any paid feature; policies change, and this playbook describes principles, not legal advice.
