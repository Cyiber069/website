# How To Use This Playbook

> Read the index of the chapter that matches your task, load only the topic notes it points to, and finish by running the hand-off checklist of every note you used.

## Reading order

1. Start at [[00 Start Here]] and read [[Retention Principles For Roblox Games]] once per project. Why: the principles let you resolve cases the rules do not cover.
2. Open the index of the chapter matching the task. Each index summarises its notes in one line so you can pick without opening everything.
3. Load the topic notes you need and follow their wikilinks only when a rule depends on them. Why: context is limited; a HUD task rarely needs the DataStore note.

## How notes are written

- Every rule is followed by a "Why" clause. If the reason does not apply to your game, the rule may not either. Say so in your hand-off instead of silently ignoring it.
- Code blocks are Luau and are patterns, not drop-in libraries. Rename, type and fit them to the project's layout described in [[Code Layout In Roblox Services]].
- Numbers given as "starting points" are for first drafts only. Replace them with measured values from playtests.

## Which notes apply to which task

| Task | Minimum notes to load |
| --- | --- |
| New game from a blank place | [[Build Order From Prototype To Launch]], [[Defining The Core Loop]] |
| Any RemoteEvent | [[Server-Authoritative Remotes]], [[Rate Limiting Client Requests]] |
| Any saved value | [[DataStore Save Patterns]] |
| Any on-screen element | [[Mobile-First HUD Zones]], [[UI Scaling And Constraints]] |
| Any Robux purchase | [[Game Passes Versus Developer Products]], [[ProcessReceipt Idempotency]] |
| Before saying "done" | [[Playtest Checklist For PC And Phone]] |

## Honesty rules for agents

- Report what you tested and on which device emulation. Why: "works" without a device named usually means "works on a desktop monitor".
- Never claim a retention or revenue outcome. You can only claim that a practice was applied.
- If a Roblox API behaves differently from a note, trust the current official documentation and flag the note as stale.

## Check before you hand off

- You named the notes you applied in your summary.
- Every checklist item from those notes is ticked or explicitly marked as not applicable with a reason.
- You listed what was tested on phone emulation and what was not tested.
- Any deviation from a rule is stated with its reason.
