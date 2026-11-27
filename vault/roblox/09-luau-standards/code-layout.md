# Code Layout In Roblox Services

> Put server-only code in ServerScriptService, shared modules and remotes in ReplicatedStorage, client code in StarterPlayerScripts, and keep almost all logic in ModuleScripts.

## Where things go

| Location | Contents | Why |
| --- | --- | --- |
| `ServerScriptService` | Server entry script, services, data, purchase handling | Never replicated to clients, so it cannot be read by exploiters |
| `ServerStorage` | Server-only assets and templates to clone | Not replicated until the server places them |
| `ReplicatedStorage` | Shared modules, config, type definitions, remotes, assets both sides need | Visible to server and client |
| `StarterPlayer.StarterPlayerScripts` | Client entry script, controllers, input, camera | Runs once per player, survives respawn |
| `StarterPlayer.StarterCharacterScripts` | Only code that must restart with each character | Re-runs on every respawn |
| `StarterGui` | ScreenGui templates | Copied to each player's PlayerGui |
| `ReplicatedFirst` | Minimal loading screen | Arrives before the rest |
| `Workspace` | 3D world only | Keep scripts out so streaming and building stay simple |

Rule: anything in `ReplicatedStorage` or under a player is readable by that player. Never place reward logic that must be trusted, secrets or admin tools there.

## One entry point per side

Use a single `Script` on the server and a single `LocalScript` on the client. Each requires modules and starts them in a defined order.

```lua
--!strict
-- ServerScriptService/Server/init.server.luau
local services = { "DataService", "EconomyService", "PurchaseService" }

local loaded = {}
for _, name in services do
	loaded[name] = require(script:WaitForChild(name))
end
for _, name in services do
	local service = loaded[name]
	if service.start then
		task.spawn(service.start)
	end
end
```

Why: with dozens of independent scripts, start order is undefined and bugs depend on timing. One entry point makes order explicit and failures visible.

## Module conventions

- One responsibility per ModuleScript, named for it: `DataService`, `ShopController`, `UpgradeConfig`.
- Server modules end in `Service`, client modules in `Controller`, shared pure logic has neither suffix. Why: the name tells you where it may be required.
- Modules return a table and have no side effects at require time beyond defining things; work begins in `start`. Why: avoids circular-require deadlocks.
- Shared config holds prices, rates and curves used by both sides; see [[Cost Curves And Tuning]].
- Create remotes in one place, a `Remotes` folder in `ReplicatedStorage`, and reference them through one module. Why: every network entry point is listed for security review; see [[Server-Authoritative Remotes]].

## Finding instances

- Get services with `game:GetService`.
- On the client, use `WaitForChild` for replicated instances that may not have arrived; in streamed worlds follow [[StreamingEnabled Setup]].
- Tag world objects with `CollectionService` instead of putting a script inside each. Why: one module handles all instances and nothing is duplicated.

The file-based version of this layout is in [[Rojo Project Layout]].

## Check before you hand off

- No trusted logic or secret lives in a replicated location.
- There is one server entry script and one client entry script.
- New code is in ModuleScripts with single responsibilities and clear suffixes.
- Remotes are created and listed in one place.
- No scripts are parented inside Workspace models.
