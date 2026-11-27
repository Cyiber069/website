# StreamingEnabled Setup

> Turn on instance streaming so each client loads only the world near its character, and write every client script to tolerate instances that are not present yet.

## What it does

With `Workspace.StreamingEnabled` on, the server sends each client the 3D content around that player's character and can remove distant content when memory is tight. Why use it: join time and client memory then depend on the surroundings rather than on the whole map, which is what lets a large world run on a low-memory phone.

## Settings to decide

- **Target and minimum radius** (`StreamingTargetRadius`, `StreamingMinRadius`). The minimum is loaded with priority; the target is filled as resources allow. Start with defaults, then lower the target if phones struggle or raise it if pop-in is visible in open areas. Why: larger radius costs memory and network; smaller radius shows gaps.
- **Model streaming mode** (`ModelStreamingMode` on each `Model`):
  - Atomic: the model arrives and leaves as one unit. Use for anything a script treats as a whole, such as a shop stand or a vehicle. Why: scripts never see a half-loaded model.
  - Persistent: always present for every client. Use sparingly for small, essential things such as a global scoreboard. Why: each persistent model removes the benefit of streaming.
- **Keep non-spatial data out of Workspace.** Config, remotes and shared modules belong in `ReplicatedStorage`, which is not streamed; see [[Code Layout In Roblox Services]].

## Rules for client code

- **Never index distant world objects directly at startup.** `workspace.Zone5.Boss` may be nil. Why: it has not been streamed in.
- **React to arrival and removal.** Tag interactive objects with `CollectionService` and use the tag's instance added and removed signals to set up and tear down client behaviour. Why: the same code handles objects present at join and objects that stream in later.

```lua
local CollectionService = game:GetService("CollectionService")

local function setup(node: Instance) NodeView.attach(node) end
local function teardown(node: Instance) NodeView.detach(node) end

for _, node in CollectionService:GetTagged("ResourceNode") do setup(node) end
CollectionService:GetInstanceAddedSignal("ResourceNode"):Connect(setup)
CollectionService:GetInstanceRemovedSignal("ResourceNode"):Connect(teardown)
```

- **`WaitForChild` with a timeout** for things that should be near the player, and handle the timeout.
- **Teleports.** Before moving a character far away, ask the server to stream the destination with `Player:RequestStreamAroundAsync`, then move. Why: otherwise the character can arrive before the ground does.
- **The server sees everything.** Server scripts are unaffected; keep gameplay rules there, as in [[Server-Authoritative Remotes]].

## Testing

Test with a lowered target radius to exaggerate streaming and expose assumptions, then walk and teleport across the whole map watching the Output window. Device steps are in [[Studio Test Modes]]. Memory effects are tracked under [[Part Count And Performance Budgets]].

## Check before you hand off

- Streaming is enabled and the radius values are recorded with the reason for any change from default.
- Scripted multi-part objects are Atomic; Persistent is used only where justified.
- No client script indexes far-away Workspace paths without waiting or tag signals.
- Teleports request streaming at the destination first.
- A full-map walk and teleport test produced no client errors.
