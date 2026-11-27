# Part Count And Performance Budgets

> Decide a frame-rate and memory target on a low-end phone before detailing the map, then measure regularly and treat any breach as a bug.

## Why a budget

Performance is lost one harmless addition at a time. Without a number, nobody can say when to stop. With one, every addition is checked against it. The target device should be a modest phone, because it sets the floor for a large part of the audience.

## Set the budget

Do not copy numbers from elsewhere; measure. Build one representative zone, run it on the weakest device you can test or the closest emulation, and record frame rate, client memory and instance count from the Developer Console and the performance stats overlay. Multiply by planned zones in view, compare with the target, and write the resulting per-zone allowance into the project notes.

## What costs frame time

- **Unanchored parts.** Each one is simulated by physics. Anchor everything that does not need to move. Why: physics cost scales with moving bodies and their contacts.
- **Draw calls from variety.** Many different meshes, materials and textures cost more than many copies of one. Reuse assets. Why: identical meshes can be batched.
- **Triangles.** High-polygon meshes repeated many times. Set `RenderFidelity` on `MeshPart` to automatic so distant copies use lower detail.
- **Collision complexity.** Use simple `CollisionFidelity` such as box or hull for decorative meshes, and turn off `CanCollide`, `CanTouch` and `CanQuery` on pure decoration. Why: precise collision meshes are expensive and rarely needed.
- **Shadows and lights.** Disable `CastShadow` on small or distant details; limit dynamic light sources. See [[Lighting And Readability]].
- **Transparency and particles.** Overlapping transparent surfaces and high emission rates are costly on mobile graphics chips.
- **Per-frame scripts.** Avoid doing work for every object every frame; update on events or at a low rate. Why: script time shares the frame with rendering.
- **Interface churn.** Hundreds of live GUI objects or constant text updates cost too; pool effects as in [[Feedback And Juice]].

## What costs memory

Unique textures, meshes, sounds and animations, plus instance count. Streaming limits how much of the map is held at once; see [[StreamingEnabled Setup]].

## Server-side cost

Moving parts replicate to every client. Animate cosmetic motion (spinning coins, bobbing pickups) on each client rather than moving the part on the server. Why: this removes network traffic and server physics for things that do not affect rules.

## Holding the line

- Measure after each zone is detailed, not at the end.
- Use the MicroProfiler to see whether a slow frame is physics, rendering or scripts before optimising. Why: guessing optimises the wrong thing.
- Offer a low-detail setting that removes decoration tagged as optional.

## Check before you hand off

- A written budget exists with the device or emulation it was measured on.
- All static geometry is anchored.
- Decorative parts have collision, touch and query disabled and shadows off where small.
- Cosmetic motion runs on clients.
- Frame rate and memory were measured in the busiest area with several players and recorded.
