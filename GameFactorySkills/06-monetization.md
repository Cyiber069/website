# Monetization
> Design a fair, clear shop and code purchases safely, inside what Roblox allows.

## When to use
- Choosing what a game sells and at what price steps.
- Building the shop, starter pack or contextual offers.
- Writing the shared purchase module, or checking compliance before launch.

## Rules
1. Classify every item in Config as durable or consumable, and as enhancement or expression; cover more than one cell.
   Why: it forces a mix of one-time and repeat items. [Roblox docs: monetization-foundations]
2. Sell durable perks as passes and repeatable items as developer products, and always include repeatables.
   Why: the wrong type breaks repurchase; repeat purchases have no ceiling. [Roblox docs: monetization]
3. Build a low, mid and premium price ladder plus a starter pack shown in a new player's first minutes, not on the first loading screen.
   Why: casual spenders and fans both need something to buy. [Roblox docs: strategies]
   Starting assumption (not from a source): mid about 4x and premium about 15x the lowest price.
4. Grant developer products only in one server-side ProcessReceipt handler; report success only after the grant is saved, never from PromptProductPurchaseFinished.
   Why: that event does not prove payment; unresolved receipts are retried. [Roblox docs: developer-products]
5. Keep a capped list of handled PurchaseIds in player data and skip ids already seen.
   Why: retries cannot double-grant. [repo: MadStudioRoblox/ProfileStore]
6. Confirm real ownership before permanent pass grants, do not cache it for the session, and look up the current ownership API first.
   Why: pass free trials can report ownership, and sources disagree on the method. [Roblox docs: passes]
7. Read prices at runtime, mark items Listed, and give each a custom icon.
   Why: hard-coded prices go wrong under regional pricing. [Roblox docs: price-optimization]
8. Make the shop easy to find, styled like the HUD, instant to open, grouped by category, with a truthful one-line effect, amount and duration per item.
   Why: players only buy what they understand. [Roblox docs: monetization-foundations]
9. Place offers at natural pauses, never stack modals, and give the best-value bundle more space.
   Why: a purchase flow takes seconds and hurts mid-action. [Roblox docs: contextual-purchases]
10. Not allowed: paid random items without all outcomes and percentage odds shown before purchase, including items bought with Robux-bought currency.
    Why: required by Roblox's terms; odds total 100% and update with luck boosts. [Roblox docs: paid-random-items]
11. Check PolicyService per player on the server; hide paid random items or paid-item trading where restricted.
    Why: Roblox states this is required for compliance. [Roblox docs: paid-random-items]
12. Not allowed: fake urgency such as permanent sales, restarting timers, false stock claims or pressure copy.
    Why: discounts must be genuine; use neutral labels like "Open Shop". [Roblox docs: monetization]
13. Do not make pay-to-skip timers the main monetization.
    Why: Roblox says players resent them and downvote. [Roblox docs: monetization]

## Checklist
- [ ] Catalog has durable and consumable items, each on the correct product type.
- [ ] Three price tiers and a starter pack exist.
- [ ] One receipt handler; grants saved before success.
- [ ] Duplicate receipts do not re-grant; no hard-coded prices.
- [ ] Every item states effect, amount and duration.
- [ ] Odds sit behind a worded "Info" or "Details" button.
- [ ] PolicyService checked on join.
- [ ] Offer timers use server time and really expire.
- [ ] Shop stock rotates with each update.
- [ ] TopbarPlus credit condition met, if used.
- [ ] Cross-game sales, Robux payouts, subscriptions: check the current Roblox policy before shipping.

## Sources
- Roblox creator docs: monetization, monetization-foundations, developer-products, passes, paid-random-items, price-optimization, contextual-purchases, strategies.
- MadStudioRoblox/ProfileStore (devproducts); EL4CTEO/roblox-skills and MSayib/roblox-dev-skill (API disagreement).
- 1ForeverHD/TopbarPlus README, LICENSE.

## Lessons from launched games
Add dated lessons here after each launch.
