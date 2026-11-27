# Server-Authoritative Remotes

> The client sends requests describing intent, the server validates every argument and decides the outcome, and nothing the client says is ever trusted.

## The threat model

A player running exploit software can read every LocalScript and replicated ModuleScript, fire any RemoteEvent with any arguments at any rate, and change anything on their own client, including their character's position. They cannot read or change server scripts or server memory. Every rule below follows from that boundary. Why it matters for retention: one cheater inflating currency or ruining a leaderboard devalues the progress of every honest player.

## Design rules

- **Send intent, not results.** `RequestUpgrade("speed")`, never `SetCoins(5000)` or `BuyItem(id, price)`. Why: any value the client supplies can be forged.
- **The server computes everything that matters**: prices, rewards, damage, cooldowns, random rolls.
- **State replicates down, requests go up.** Clients read state from replicated values or attributes set by the server.
- **Keep remotes few and specific.** Why: each one is an entry point to audit.
- **Avoid server-to-client RemoteFunction invocation.** A client can refuse to return and stall the server thread. Use RemoteEvents for server-to-client messages.

## Validate every request

The first parameter of `OnServerEvent`, the player, is supplied by Roblox and can be trusted. Everything after it cannot.

1. **Type**: check with `typeof`; reject tables where strings are expected, and reject `NaN` and infinite numbers.
2. **Range and whitelist**: IDs must exist in server config; numbers must be within bounds; strings within a length limit.
3. **Ownership**: the instance or item referred to must belong to this player.
4. **State**: the player can afford it, has unlocked it, is alive, is not on cooldown.
5. **Plausibility**: the character is close enough to the thing they claim to use.
6. **Rate**: see [[Rate Limiting Client Requests]].

```lua
--!strict
local MAX_REACH = 18

Remotes.Collect.OnServerEvent:Connect(function(player: Player, node: unknown)
	if not RateLimit.check(player, "Collect") then return end
	if typeof(node) ~= "Instance" or not node:IsA("BasePart") then return end
	if not node:IsDescendantOf(workspace.Nodes) or not node:GetAttribute("Active") then return end

	local character = player.Character
	local root = character and character:FindFirstChild("HumanoidRootPart")
	if not root or not root:IsA("BasePart") then return end
	if (root.Position - node.Position).Magnitude > MAX_REACH then return end

	EconomyService.rewardCollect(player, node)
end)
```

Fail silently toward the client and log on the server. Why: detailed rejection messages teach an attacker what the checks are.

## Other trust boundaries

- **Character movement** is client-controlled by default. For rewards tied to position or speed, add server sanity checks with tolerance for lag rather than exact matching.
- **Touched events** can be spoofed for the player's own character; verify distance on the server.
- **Client-side checks are for user experience only**: greying a button is helpful, never sufficient.
- **Instances passed over remotes** may be nil if they do not exist on the server.

Economy handlers built this way are used in [[Defining The Core Loop]] and [[Rebirth And Prestige Systems]]. Test by firing remotes with wrong arguments from a client in a local server, as in [[Studio Test Modes]].

## Check before you hand off

- No remote accepts a price, amount, reward or outcome from the client.
- Every handler checks type, whitelist or range, ownership, state and rate.
- No server code invokes a RemoteFunction on a client.
- Proximity is verified for world interactions.
- Each new remote was fired with bad arguments in a test and did nothing.
