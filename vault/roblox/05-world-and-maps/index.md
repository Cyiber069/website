# 05 World and Maps

> This chapter covers laying out a map players can navigate without help, streaming it efficiently, staying inside performance budgets and lighting it so gameplay is readable.

## Why this chapter exists

The world is where the loop physically happens. A map that confuses players slows their first reward; a map that is too heavy will not run acceptably on the phones much of the audience uses, and a player with a stuttering frame rate leaves regardless of how good the design is. World building is therefore a retention task and a performance task at the same time, and the performance half has to be considered from the first part placed, not at the end.

## Notes in this chapter

- [[Map Layout And Wayfinding]] covers hub-and-spoke layouts, landmarks, zone gating and travel time.
- [[StreamingEnabled Setup]] explains instance streaming, what it changes for client scripts, and how to keep important models reliably present.
- [[Part Count And Performance Budgets]] sets out what costs frame time and memory and how to set and hold a budget measured on a phone.
- [[Lighting And Readability]] covers contrast, colour coding of interactables, time of day and post-processing restraint.

## How to use it

1. Block out the map with plain parts and walk it on phone emulation before detailing anything.
2. Turn streaming on at the start so scripts are written for it.
3. Set a budget, then detail zone by zone, measuring as you go.
4. Light last, checking that interactables still stand out.

## Related chapters

- Spawn composition is in [[Spawn Area And First View]].
- Zones are goals on the [[First Session Goal Ladder]].
- Device verification is in [[Playtest Checklist For PC And Phone]].

## Principles

- The player should always know where they are and where the next goal is.
- Cost is paid by the weakest device in your audience.
- Beauty that hides the gameplay is a defect.
