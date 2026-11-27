# Retention Principles For Roblox Games

> Players stay when they understand the goal fast, feel progress often, always see a next step, and never lose what they earned.

## The principles

**1. Time to fun beats everything.** A new player decides within the first minute whether to stay, and leaving costs them nothing because another experience is one tap away. Put the core action and a reward in front of them immediately. See [[First Reward Inside Thirty Seconds]].

**2. One clear loop.** The player should be able to say what they do in one sentence: do an action, get a reward, spend it to do the action better. Extra systems before the loop is fun only hide the problem. See [[Defining The Core Loop]].

**3. Always a visible next goal.** At any moment the player should see something they want and roughly how far away it is. A goal that is close keeps the current session going; a goal that is far gives a reason to return. See [[First Session Goal Ladder]].

**4. Progress is sacred.** Losing saved data is the fastest way to lose a player permanently, because it destroys the reason they came back. Saving must be boringly reliable. See [[DataStore Save Patterns]].

**5. Phone first.** If a thumb cannot reach it or an eye cannot read it on a small screen, a large part of the audience cannot play. See [[Mobile-First HUD Zones]].

**6. Fairness is long-term revenue.** Purchases that feel like a shortcut the player chose are repeated; purchases that feel forced produce quits. See [[Fair Offer Design]].

**7. Cheating ruins everyone else's progress.** If a client can award itself currency, leaderboards and trading become meaningless and honest players leave. See [[Server-Authoritative Remotes]].

**8. Fresh reasons to return.** A predictable rhythm of updates gives lapsed players a reason to come back and current players something to anticipate. See [[Update Cadence]].

## How to apply them when rules conflict

- Prefer the principle with the lower number. Time to fun outranks deep systems; reliability outranks features.
- When adding a feature, name which principle it serves. If it serves none, postpone it.
- When cutting scope, cut content volume before cutting feedback, saving or mobile support.

## Check before you hand off

- You can state the core loop in one sentence.
- A new player gets a reward within the first half minute without reading instructions.
- A next goal is visible on the HUD or in the world at all times.
- Every feature added in this task maps to a principle above.
