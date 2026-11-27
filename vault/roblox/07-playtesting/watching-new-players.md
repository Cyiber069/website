# Watching New Players Play

> Put the build in front of someone who has never seen it, say nothing, watch where they hesitate, and fix the earliest point of confusion first.

## Why observe

The builder cannot un-know the game. Things that are obvious to the author, where to go, what a button does, are invisible assumptions. A fresh player exposes them within a minute. Observation finds the cause of drop-off; analytics only show that drop-off exists.

## Setting up a session

- **Use a truly fresh player and a fresh profile.** Why: prior knowledge or saved progress hides onboarding problems.
- **Prefer the device most of the audience uses**, a phone, at least for some sessions.
- **Give no instructions** beyond "play as you normally would and say what you are thinking".
- **Do not help.** If they are stuck, wait. Note how long before they recover or give up. Why: in the real world nobody is there to rescue them, and they leave.
- **Record screen and, with consent, voice**, or take timestamped notes. For minors, get a parent or guardian's permission and keep sessions short.

When no human tester is available, an agent can approximate by playing from an empty profile on phone emulation and logging a timeline, but must label the result as self-testing, not as player evidence.

## What to note

| Time | Observation | Type |
| --- | --- | --- |
| 0:12 | Walked away from the first node | Wayfinding |
| 0:40 | Tapped the counter expecting a shop | Interface |

Watch for:

- Time to first action, first reward and first purchase; compare with [[First Reward Inside Thirty Seconds]].
- Hesitations longer than a few seconds.
- Taps on things that are not interactive, and misses on things that are.
- Questions asked aloud. Each one is a missing signal in the game.
- The moment attention drifts, and what had just happened.
- What they say they want next. It should match the next goal on the [[First Session Goal Ladder]].

## Turning notes into changes

- Fix the earliest problem first. Why: later problems are only seen by players who survive earlier ones.
- Fix by changing the world or the interface, not by adding explanatory text; see [[Tutorial-Less Onboarding]].
- Change one thing, then test again with a different fresh player. Why: a used tester is no longer fresh.
- A problem seen with several separate testers is a pattern; one-off preferences can wait.

## After the session

Ask two questions only: "What was the game about?" and "What would you do next?" If the answers differ from the intended loop and next goal, the design has not communicated them.

## Check before you hand off

- At least one fresh-player or clearly labelled self-test session was run on phone-sized layout.
- A timestamped observation table exists.
- Times to first action, reward and purchase are recorded.
- The earliest point of confusion has a change made or proposed.
- Evidence type, human tester or agent self-test, is stated honestly.
