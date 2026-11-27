# Strict Typing And The Task Library

> Start every script with strict type checking, annotate module boundaries, use the task library for all scheduling, and disconnect what you connect.

## Strict mode

Put `--!strict` on the first line of every script and module. Why: the type checker then reports nil access, misspelled fields and wrong argument types in the editor, before a player finds them at run time. It is the cheapest test available.

- Annotate function parameters and return types at module boundaries; let inference handle locals.
- Define shared shapes once with `export type` in a shared `Types` module, for example the player profile. Why: server and client agree on field names, and renaming a field surfaces every use.
- Treat anything arriving from a remote as `unknown` and narrow it with `typeof` checks; see [[Server-Authoritative Remotes]].
- Avoid `any`. If it is unavoidable at an untyped boundary, contain it in one function.
- `FindFirstChild` returns an optional value; handle nil rather than asserting.

```lua
--!strict
export type Profile = {
	Coins: number,
	Rebirths: number,
	Upgrades: { [string]: number },
	Purchases: { [string]: number },
}

local function addCoins(profile: Profile, amount: number): number
	profile.Coins += amount
	return profile.Coins
end
```

## The task library

| Use | Instead of | Why |
| --- | --- | --- |
| `task.wait(t)` | `wait(t)` | The old global is deprecated and can be throttled, giving imprecise delays |
| `task.spawn(f, ...)` | `spawn(f)` | Runs immediately instead of after an arbitrary delay |
| `task.defer(f, ...)` | none | Runs after the current code finishes, useful to avoid re-entrancy |
| `task.delay(t, f, ...)` | `delay(t, f)` | Precise and consistent with the rest |
| `task.cancel(thread)` | flags | Stops a scheduled thread cleanly |

Further rules:

- **Prefer events to polling.** Connect to `Changed`, attribute or property signals rather than looping with waits. Why: polling costs time every frame and reacts late.
- **Never write `while true do` without a yield.** It freezes the script and can freeze the client or server.
- **Wrap yielding web calls in `pcall`**: DataStores, marketplace, policy and HTTP requests can all throw. See [[DataStore Save Patterns]].
- **Use `os.clock()` for measuring intervals and `os.time()` for calendar timestamps.**

## Cleanup

- Store connections and disconnect them when the owner is destroyed. Why: lingering connections leak memory and fire on dead objects.
- Clear per-player tables in `PlayerRemoving`.
- Call `Destroy` on instances you are finished with; it disconnects their events.
- On the client, tear down behaviour for objects that stream out; see [[StreamingEnabled Setup]].

## General style

- `local` everything; no globals.
- Get services once at the top with `game:GetService`.
- Constants in upper snake case, functions and variables in camel case, modules and types in Pascal case.
- Use generalised iteration, `for key, value in tbl do`.
- Use compound assignment and `if` expressions where they aid clarity.
- Early returns over deep nesting.
- Comments explain why, not what.
- Structure follows [[Code Layout In Roblox Services]].

## Check before you hand off

- Every file begins with `--!strict` and shows no type errors in Studio's script analysis.
- No `wait`, `spawn` or `delay` globals remain.
- No loop runs without yielding.
- Every connection made by a temporary object is disconnected.
- All data, marketplace and policy calls are wrapped in `pcall`.
