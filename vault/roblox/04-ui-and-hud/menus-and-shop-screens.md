# Menus And Shop Screens

> Menus should open instantly, show one purpose per panel, close with one obvious tap, and never interrupt the player in the middle of the core action.

## Panel rules

- **One panel at a time.** Opening a menu closes any other. Why: stacked panels on a phone hide each other and the close buttons.
- **Large close button in the top right of the panel, plus tap-outside to close.** Why: players look for it there, and a missed close tap is a frustrating first impression.
- **Leave the world partly visible** or dim it rather than replacing it. Why: the player keeps a sense of place and danger.
- **Keep character control predictable.** If a panel covers the thumbstick area, the player cannot move; say so through design by making the panel modal and quick to dismiss.
- **Tabs for categories, a scrolling grid for items.** Use a `ScrollingFrame` with a `UIGridLayout` and automatic canvas sizing. Why: the same layout handles five items or five hundred.
- **Open and close with a short tween.** Why: motion shows where the panel came from; long animations make frequent use tedious.

## Shop item cards

Each card shows: icon, short name, the effect in numbers ("x2 coins"), the price with a currency icon, and a state (affordable, too expensive, owned). Why: the player should be able to decide without opening a detail view.

- Grey out, do not hide, unaffordable items. Why: visible locked items are goals; see [[First Session Goal Ladder]].
- Show prices computed from the shared config so they match what the server charges; see [[Cost Curves And Tuning]].
- After a purchase, update from server-replicated state, not from an optimistic local guess. Why: a card that says "owned" when the server refused is a support problem.

## Robux purchases

- Mark Robux-priced items clearly and separate them from soft-currency items. Why: confusing the two feels like a trick.
- Use the platform purchase prompts; never build a look-alike. Flows are in [[Game Passes Versus Developer Products]].
- For random rewards, display odds on the card or one tap away, per [[Paid Random Items Compliance]].

## When to open UI automatically

- Never during the first thirty seconds, and never mid-action.
- Acceptable: when the player walks into a shop area, or after a milestone, once.
- Why: an unrequested panel reads as an advert; a requested one reads as a feature.

## Gamepad and keyboard

Set selection order so a gamepad can reach every button, and bind a key to close. Why: console and PC players should not need a pointer for basic navigation.

## Check before you hand off

- Only one panel can be open at once, and each closes with one tap.
- Item cards show effect, price and state without extra taps.
- Shop state updates come from the server.
- Robux items are visually distinct from soft-currency items.
- No panel opens by itself before the first upgrade is bought.
- Every button is reachable on touch and by gamepad selection.
