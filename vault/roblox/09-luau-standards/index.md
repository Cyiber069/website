# 09 Luau Standards

> This chapter sets the code layout, typing, networking and security rules that every script in the project must follow.

## Why this chapter exists

Roblox runs your code in two places: a server you control and clients you do not. Anything on a client can be read and altered by someone using exploit tools, and anything a client sends can be forged. Code standards here are therefore not style preferences. They decide whether the economy can be cheated, whether data survives, and whether another agent can find and safely change a system later.

## Notes in this chapter

- [[Code Layout In Roblox Services]] says what goes in `ServerScriptService`, `ReplicatedStorage`, `StarterPlayerScripts` and elsewhere, and how to structure ModuleScripts.
- [[Rojo Project Layout]] gives a file-system project structure and project file for teams and agents that edit code outside Studio.
- [[Server-Authoritative Remotes]] covers RemoteEvent design, validating every argument and never trusting the client.
- [[Rate Limiting Client Requests]] gives a per-player limiter for remotes and explains what to do when limits are hit.
- [[Strict Typing And The Task Library]] covers `--!strict`, type annotations, the `task` library in place of `wait` and `spawn`, and connection cleanup.

## How to use it

Read the layout note before creating any script, the remotes and rate limiting notes before adding any RemoteEvent or RemoteFunction, and the typing note before writing any module.

## Related chapters

- Saving code follows [[DataStore Save Patterns]].
- Purchase code follows [[ProcessReceipt Idempotency]].
- Verification follows [[Studio Test Modes]].

## Non-negotiables

- The server owns all game state that matters.
- Every remote handler validates types, ranges, ownership and rate.
- No secrets, prices or reward logic that must be trusted live only on the client.
- No deprecated `wait`, `spawn` or `delay`.
- Every yielding web or data call is wrapped in `pcall`.
