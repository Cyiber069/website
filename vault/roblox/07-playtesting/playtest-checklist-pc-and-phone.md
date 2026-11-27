# Playtest Checklist For PC And Phone

> Run this list on a desktop size and a small phone preset before every hand-off, and record a pass, fail or not-tested for each line.

## How to run it

Use a fresh profile first, then an existing one. Use the modes described in [[Studio Test Modes]]. Why both devices every time: fixes for one input method regularly break the other.

## First-time flow

- Control is given quickly after join; time noted.
- First reward arrives within thirty seconds without instructions; see [[First Reward Inside Thirty Seconds]].
- One objective is visible at every moment in the first five minutes.
- No pop-up or purchase prompt appears before the first upgrade.

## Input

- Phone: every action is possible with touch alone; no keyboard-only feature.
- Phone: no game button sits under the thumbstick area, jump button or top bar; see [[Mobile-First HUD Zones]].
- PC: every action is possible with mouse and keyboard; key hints are shown only for keyboard users.
- Gamepad, if supported: menus are navigable and closable.
- Prompts show the right input icon on each device.

## Interface

- Text is legible on the small phone preset; nothing clipped or overlapping.
- The longest currency value fits its label.
- Every panel opens, closes and scrolls by touch.
- Rotating or resizing the window does not break layout.

## Core loop and economy

- Earn, spend and upgrade all work, and totals match expectations from config.
- Unaffordable purchases are refused by the server, not just greyed out.
- Rebirth resets what it should and keeps what it should.
- Rapid tapping does not grant extra rewards; see [[Rate Limiting Client Requests]].

## Data

- Leave and rejoin: progress is intact.
- Stop the server with a player inside: progress is intact.
- A profile saved by the previous version loads without errors.

## Multiplayer

- Two clients: each sees the other correctly; neither can change the other's data.
- A late joiner sees the correct world state.

## Purchases

- Each pass and product can be bought in test mode and is granted once.
- A pass bought mid-session applies immediately.
- Restricted paid random items are hidden when the policy flag is forced on.

## Performance

- Frame rate and memory in the busiest area are within the budget from [[Part Count And Performance Budgets]].
- No error or repeating warning appears in the server or client Output.
- Walking and teleporting across the map causes no missing-instance errors.

## Reporting

List failures with steps to reproduce. Mark anything not tested on a real phone as such. Why: the next person needs to know what is verified and what is assumed.

## Check before you hand off

- Every line above has a recorded result for both device sizes.
- All failures are fixed or listed with reproduction steps.
- The report names the device presets and test modes used.
- Fresh-profile and existing-profile runs were both done.
