# 07 Playtesting

> This chapter covers how to test a build in Studio, the checklist to run on PC and phone before any hand-off, and how to learn from watching new players.

## Why this chapter exists

Most defects that lose players are not exotic. They are a button under the jump control, a save that fails on server shutdown, a client error when a part has not streamed in, or an opening that confuses anyone who did not build it. All of these are found by a short, disciplined test routine and almost none are found by reading code. An agent that reports a task as complete without running the game has reported a guess.

## Notes in this chapter

- [[Studio Test Modes]] explains which Studio testing mode to use for which question: solo play, local server with several clients, device emulation and data testing.
- [[Playtest Checklist For PC And Phone]] is the list to run before every hand-off, grouped by first-time flow, input, interface, data, purchases and performance.
- [[Watching New Players Play]] describes how to run and record an observation session with a fresh player and turn it into changes.

## How to use it

1. After any change, run the smallest test that could prove it wrong.
2. Before hand-off, run the full checklist and record results with the device presets used.
3. Before launch and after major updates, observe at least a few fresh players.

## Related chapters

- Performance measurements are defined in [[Part Count And Performance Budgets]].
- Live measurements after release are in [[Launch Metrics To Measure]].
- Honest reporting rules are in [[How To Use This Playbook]].

## Principles

- Test as a new player with empty data, and as a returning player with old data.
- Test with more than one client; many bugs need two players.
- An untested claim is labelled as untested in the hand-off.
