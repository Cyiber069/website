# First Reward Inside Thirty Seconds

> A new player should perform the core action and receive a visible, audible reward within thirty seconds of gaining control of their character.

## The rule

From the moment the character can move, count thirty seconds. Inside that window the player must: see the first interactable, use it, and watch a number go up or an object appear. Why: the first reward proves the game responds to them. Before it, they are evaluating; after it, they are playing.

## How to hit the budget

- **Place the first interactable within a few seconds' walk of spawn, in the camera's view.** Why: searching is not fun yet, because the player does not know what they are searching for.
- **Make the first action free and impossible to fail.** No cost, no cooldown, no enemy. Why: failure before understanding reads as "this game is broken".
- **Make the first reward large relative to the first price.** One or two actions should afford the first upgrade. Why: the purchase teaches the spend half of the loop while attention is highest.
- **Stack the feedback.** Sound, a number popping from the object, and the HUD counter animating together. See [[Feedback And Juice]].
- **Delay everything else.** Daily rewards, shop pop-ups, group invitations and codes wait until after the first upgrade. Why: each modal before the first reward is a chance to leave.

## Returning players

Skip staged steps for anyone with saved progress. Check loaded data and place them straight into their loop. Why: repeating the opening wastes a returning player's time and signals that their progress was not recognised.

## Measuring it

Record a timestamp when the character spawns and when the first reward is granted, on the server. Log the steps as an onboarding funnel so the gap is visible in analytics; see [[Launch Metrics To Measure]]. During development, time it by hand with a fresh data profile, as described in [[Watching New Players Play]].

```lua
-- Server: mark funnel steps once per new player
local function markStep(player: Player, profile, step: number, name: string)
	if profile.Onboarding[name] then return end
	profile.Onboarding[name] = true
	Analytics.onboardingStep(player, step, name) -- thin wrapper around your analytics calls
end
```

## Check before you hand off

- With a brand-new profile, first reward arrives within thirty seconds on phone emulation.
- The first interactable is visible from the spawn camera without turning.
- No modal, prompt or purchase offer appears before the first upgrade is bought.
- Returning players skip the staged opening.
- Funnel steps are recorded on the server once per player.
