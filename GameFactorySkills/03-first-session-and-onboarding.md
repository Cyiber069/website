# First Session and Onboarding

> Get a new player into the core loop fast and send them away knowing what to come back for.

## When to use

- When building the spawn area and first rewards.
- When the onboarding funnel shows a drop at an early step.
- When a new feature needs explaining.

## Rules

1. Teach only two things: the controls and the core loop, both what to do and why.
   Why: each extra thing to learn raises the chance of an overwhelmed player quitting. [Roblox docs: onboarding]
2. Follow this order: spawn facing the first interactable, prompt one action, reward at once, show the next short goal, then reveal social and progression.
   Why: the player is inside the loop before anything can distract them. [repo: AshExplained/roblox-skills]
3. Reach the fun within five minutes at the very latest, aiming far lower; keep any tutorial short, contextual and interactive.
   Why: leaving costs nothing, and Roblox players prefer to jump in and work things out. [Roblox docs: engagement; get-started/strategies]
4. Show other players doing the core loop, plus one cheap social hook: a public celebration, a friend boost that does not punish solo players, or an invite moment.
   Why: early social visibility is a strong, low-cost retention multiplier. [repo: AshExplained/roblox-skills]
5. Teach with visuals: an arrow on the button, a dimmed screen with the target outlined, a sign in the spawn line of sight, a trail to the destination.
   Why: players skip text; pictures need no translation and stay readable on phones. [Roblox docs: onboarding-techniques]
6. Keep the marker visible until the step is done, but never block wandering.
   Why: persistent hints recover distracted players without feeling forced. [Roblox docs: onboarding-techniques]
7. Trigger a feature's tutorial only when the player first meets the condition to use it.
   Why: just-in-time teaching shortens onboarding, and immediate practice sticks. [Roblox docs: onboarding-techniques]
8. Add timed hints: measure in playtests how long most players take, then highlight just after that, once, only for players who have not acted.
   Why: it helps stuck players without annoying the rest; Roblox's example is 10 seconds typical, hint at 11. [Roblox docs: onboarding-techniques]
9. Grant starter items and soft currency on first join (amount tunable, to A/B test), and set the first level thresholds very low.
   Why: the player runs the full loop and levels up within minutes. [Roblox docs: onboarding; engagement]
10. After the first completed loop, fire a celebration (reward, animation, effects), then show short, mid and long-term goals.
   Why: a joyful ending plus visible goals makes players want to return. [Roblox docs: onboarding; retention]
11. No interrupting popups in the first five minutes and no shop pressure in the first session.
   Why: interruptions scare off players before the loop hooks them. [repo: AshExplained/roblox-skills]
12. Design the funnel steps first, log them from the server with AnalyticsService:LogOnboardingFunnelStepEvent as sequential 1-based steps, and badge early milestones.
   Why: the day after launch, each step shows where new players quit. [repo: EL4CTEO/roblox-skills]

## Checklist

- [ ] Spawn faces the first interactable
- [ ] Timed hint delays set from playtest timings
- [ ] Starter items and currency granted; amount in config
- [ ] Celebration, then goals, after first completed loop
- [ ] No popups or shop pressure early
- [ ] Other players visible doing the loop; one cheap social hook
- [ ] Funnel steps logged server-side; early badge awarded

## Sources

- Roblox docs: onboarding; onboarding-techniques; retention; engagement; get-started/strategies
- repo: AshExplained/roblox-skills
- repo: EL4CTEO/roblox-skills

## Lessons from launched games

Add dated lessons here after each launch.
