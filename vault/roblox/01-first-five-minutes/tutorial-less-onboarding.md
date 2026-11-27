# Tutorial-Less Onboarding

> Teach by arranging the world so the only sensible thing to do is the right thing, and reserve text for single short prompts tied to an object.

## Why avoid a classic tutorial

Many players are young, many are on phones, and many will not read. A forced tutorial with dialogue boxes delays the first reward and trains players to tap "next" without absorbing anything. Learning by doing sticks, because the player connects their own action to the result.

## Techniques

- **Funnel with geometry.** Spawn the player in a short corridor or on a path that leads to the first interactable. Why: direction is communicated without words.
- **One goal on screen.** Show a single objective line such as "Collect 10 coins" with a progress count. Replace it when done. Why: one instruction is followed; three are ignored.
- **Point, do not explain.** Use a beam, arrow or highlight from the player to the target. A `Beam` between attachments or a `Highlight` on the target works without any text. Why: it also works for players who cannot read the language.
- **Use the platform's own interaction pattern.** A `ProximityPrompt` shows the correct input for keyboard, touch and gamepad automatically. Why: you avoid writing "Press E" for a player who has no keyboard.
- **Gate by action, not by time.** The next hint appears when the previous step is completed on the server. Why: fast players are not held back, slow players are not rushed.
- **Lock complexity until needed.** Hide trading and pets until the player reaches the point where each matters. The rebirth button is the exception: it is shown early as a locked goal with its requirement, per [[Rebirth And Prestige Systems]]. Why: a HUD full of unknown buttons is intimidating; see [[Mobile-First HUD Zones]].
- **Let hints fade.** After the step has been done a few times, stop showing its hint. Why: guidance that never leaves feels patronising.

## State handling

Store the onboarding step in the player's saved data and drive hints from it. The server advances the step; the client only renders the hint for the current step. This keeps the sequence consistent after a rejoin and makes it measurable, as described in [[First Reward Inside Thirty Seconds]].

## What still deserves words

Irreversible actions (rebirth resets progress) and anything involving Robux need a clear, short sentence. See [[Rebirth And Prestige Systems]].

## Check before you hand off

- A tester who is told nothing completes the first loop without asking a question.
- No screen shows more than one objective at a time.
- Hints use prompts or pointers that work on touch, keyboard and gamepad.
- Onboarding step is saved and advanced only by the server.
- Advanced features are hidden or shown as locked goals until their unlock condition is met.
