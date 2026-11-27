# Defining The Core Loop

> The core loop is one sentence, do an action, earn a reward, spend it to do the action better, and it must be fun before any progression is added.

## Write the sentence

Template: "The player **[verb]s [thing]** to earn **[resource]**, which they spend on **[upgrade]** so they can **[verb] bigger or faster**."

Examples of the shape, not of any particular game:

- The player mines rocks to earn ore, which they spend on pickaxes so they can mine tougher rocks.
- The player serves customers to earn cash, which they spend on stations so they can serve more customers at once.

Why one sentence: if the loop cannot be said simply, a new player will not discover it in thirty seconds.

## Tests the loop must pass

- **Verb test.** The action involves a decision or a skill, even a small one: where to go, what to target, when to cash in. Why: pure waiting gives nothing to do and nothing to master.
- **Visible change test.** An upgrade changes something the player can see: a bigger tool, a faster character, a new area. Why: a number changing in a menu is forgettable.
- **Short cycle test.** Early on, one full turn takes well under a minute. Why: fast early cycles deliver many rewards while the player is still deciding whether to stay.
- **Stretch test.** The same loop still makes sense when numbers are a thousand times larger. Why: progression will scale it; see [[Cost Curves And Tuning]].
- **Social test.** Other players in the server make the loop better or at least visible: seeing someone's stronger gear is free advertising for progress. Why: Roblox is played with friends, and comparison motivates.

## Prototype it

Build with anchored grey parts, one resource, one upgrade. Keep all rules on the server from the start, as in [[Server-Authoritative Remotes]], because retrofitting authority means rewriting the loop.

```lua
-- Server: one turn of a collect loop
local function onCollect(player: Player, node: BasePart)
	local profile = Profiles.get(player)
	if not profile or not Nodes.isValidTarget(player, node) then return end
	profile.Coins += Config.NodeValue * profile.Multiplier
	Nodes.respawnLater(node)
end
```

Hand this build to a tester with no explanation. If they keep going unprompted, proceed to [[Feedback And Juice]]. If not, change the verb, not the art.

## Check before you hand off

- The loop sentence is written at the top of the design or config file.
- All five tests have a written yes or no.
- A grey-box build of the loop exists and was played by someone other than its author.
- The reward is granted by server code that validates the action.
- Tuning values are in a config module.
