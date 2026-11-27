# Feedback And Juice

> Every core action should answer the player through several channels at once, sound, motion, numbers and HUD, within a fraction of a second.

## Why it matters

The reward in data, plus ten coins, is identical whether or not anything happens on screen. What the player feels is the response. Layered feedback makes a small reward feel earned, and it is the cheapest retention improvement available because it needs no new content.

## The layers

Apply at least three to the core action:

- **Sound.** A short, pleasant sound per action; vary pitch slightly so repetition does not grate. Why: audio confirms the action even when the thumb covers the screen.
- **Motion on the target.** Squash, shake or pop the object with `TweenService`. Why: the world acknowledges the touch.
- **Floating number.** A `BillboardGui` showing the amount gained, rising and fading. Why: it ties the reward to the place it came from.
- **HUD response.** The currency counter bumps in size and counts up. Why: it teaches where the total lives.
- **Particles.** A brief `ParticleEmitter` burst using `Emit`. Why: it scales easily for rare or big rewards.
- **Milestone moments.** A bigger effect for first-time events and tier unlocks. Why: contrast makes important moments memorable.

## Do it on the client, decide on the server

Play effects locally the instant the player acts so the game feels responsive despite latency, then let the server confirm the actual reward. If the server rejects the action, the HUD total simply does not change. Why: waiting for a round trip before any feedback makes the game feel sluggish on mobile networks. Authority rules are in [[Server-Authoritative Remotes]].

```lua
-- Client: bump the counter when the replicated value changes
local TweenService = game:GetService("TweenService")
local info = TweenInfo.new(0.12, Enum.EasingStyle.Back, Enum.EasingDirection.Out)

local function bump(scale: UIScale)
	scale.Scale = 1.25
	TweenService:Create(scale, info, { Scale = 1 }):Play()
end
```

## Keep it cheap

- Reuse effect instances from a small pool instead of creating and destroying them each action. Why: instance churn causes frame hitches on phones.
- Cap simultaneous floating numbers; merge rapid gains into one. Why: readability and frame rate.
- Offer a reduced-effects setting. Why: low-end devices and sensitive players both benefit. Budgets are in [[Part Count And Performance Budgets]].

## Check before you hand off

- The core action triggers at least three feedback layers.
- Feedback begins immediately on input, before the server reply.
- Sounds vary and are not painful when the action is spammed.
- Effects are pooled or capped, and frame rate holds on phone emulation during rapid actions.
- Milestones have a visibly bigger response than ordinary actions.
