# Performance on Low-End Phones

> Keep every game smooth and crash-free on cheap phones.

## When to use
- Building or importing a map, UI or effects.
- Writing any loop, remote or per-frame code.
- Running the pre-launch device test.

## Rules
1. Treat low-end performance as a launch requirement, not polish.
   Why: Roblox says poorly performing games may struggle to grow and hold players. [Roblox docs: strategies]
2. Pick one baseline low-end phone, test on it throughout, and set a budget from it; the docs' example is under 1,000 draw calls and 1,000,000 triangles.
   Why: a budget gives a pass or fail answer. [Roblox docs: performance design]
3. Read memory from the real client's Developer Console, not from Studio.
   Why: Studio runs server and client together, so numbers read far too high. [Roblox docs: performance design]
4. Profile first and fix only measured hot paths.
   Why: most code is not the bottleneck. [repo: fizzyhex/luau-skills]
5. Leave streaming on with the default minimum radius, use few Persistent models, and write client code that tolerates missing parts.
   Why: streaming is the highest-impact client memory fix. [Roblox docs: streaming]
6. Upload each mesh and texture once and reuse it; keep most images at or under 512x512 and minor ones under 256x256.
   Why: identical asset ids batch, and a 1024 texture uses four times the memory of a 512. [Roblox docs: performance improve]
7. Anchor static parts, turn off CastShadow on small parts, use Box collision, use transparency 0 or 1 only, and limit decals and particles.
   Why: these cut physics, shadows and unbatched draws. [Roblox docs: performance improve]
8. Run tweens and effects on the client, keep ReplicatedStorage lean, and preload only loading-screen and spawn assets.
   Why: server tweens replicate every frame, and ReplicatedStorage downloads before play. [Roblox docs: performance improve]
9. Send only changes through remotes, batched, never per frame and never the whole inventory.
   Why: less traffic and client work on mobile connections. [Roblox docs: performance improve; repo: fizzyhex/luau-skills]
10. No polling loops; update UI only when a value changes, hide menus with `Visible = false`, and stagger periodic work.
    Why: synchronized loops cause spikes and per-frame UI burns the frame budget. [repo: EL4CTEO/roblox-skills]
11. Per-frame code must not yield or allocate temporary tables, closures or strings.
    Why: a yield stalls the shared loop; garbage collection shows as stutter. [repo: fizzyhex/luau-skills]
12. Disconnect connections, clear per-player tables on leave, and enable PlayerCharacterDestroyBehavior.
    Why: players and characters are not destroyed automatically, so servers leak. [Roblox docs: performance improve]
13. In reactive UI, register cleanup for every connection.
    Why: self-referencing connections never get collected. [repo: centau/vide; repo: dphfox/Fusion]
14. Build zones from Block parts, keep them few, and use local-player events for client-only effects.
    Why: check frequency and precise shape queries are the main zone cost. [repo: 1ForeverHD/ZonePlus]

## Checklist
- [ ] Tested at lowest graphics quality on a real device.
- [ ] Target of 60 FPS (16.67 ms per frame) holds in the first area.
- [ ] Client memory read from the device's Developer Console.
- [ ] Decorative parts have CanCollide, CanQuery and CanTouch off.
- [ ] Server memory under 50%; LuaHeap and InstanceCount stable over a long session.
- [ ] Native code generation used only on compute-heavy typed functions.

## Sources
- Roblox docs: performance-optimization (design, improve, identify)
- Roblox docs: workspace/streaming
- Roblox docs: get-started/strategies
- repo: fizzyhex/luau-skills
- repo: EL4CTEO/roblox-skills
- repo: 1ForeverHD/ZonePlus
- repo: centau/vide
- repo: dphfox/Fusion

## Lessons from launched games
Add dated lessons here after each launch.
