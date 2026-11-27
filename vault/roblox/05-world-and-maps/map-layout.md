# Map Layout And Wayfinding

> Arrange the world as a compact hub with clearly gated zones and tall landmarks, so players always know where they are and where the next unlock is.

## Layout rules

- **Hub and spokes.** Spawn, shops and the rebirth station sit in a central hub; gameplay zones branch from it. Why: every trip starts and ends somewhere familiar, and new players see services as they pass.
- **Keep the first zone adjacent to spawn.** Why: travel before the first reward spends the thirty-second budget from [[First Reward Inside Thirty Seconds]].
- **Order zones by progression along a visible path.** Zone two's gate is visible from zone one. Why: the gate is a goal the player can see while they work; see [[First Session Goal Ladder]].
- **Gate with something legible.** A barrier showing the price or requirement on a `BillboardGui` or `SurfaceGui`. Why: an invisible wall is a bug to the player; a priced gate is a target.
- **Short travel, shrinking with progress.** Add teleport pads, speed upgrades or shortcuts as zones get further away. Why: walking time grows with the map, and it is dead time in the loop.
- **Compact beats large.** Why: an empty expanse costs performance and attention, and spreads players so thin the server feels deserted.

## Wayfinding

- **Landmarks.** One tall, uniquely shaped or coloured object per zone, visible over other geometry. Why: players navigate by silhouette before they read signs.
- **Colour identity per zone.** A dominant palette for each area. Why: a glance tells the player which zone they are in.
- **Paths and light lead the eye.** Brighter ground, rails and lamps along the intended route. See [[Lighting And Readability]].
- **Signs as icons.** A coin icon over the shop instead of a word. Why: works across languages and reading levels.
- **Pointer to the current objective.** A beam or arrow when the objective is out of view, as in [[Tutorial-Less Onboarding]].

## Building for phones

- Wide walkways and forgiving jumps. Why: thumbstick movement is less precise than a keyboard.
- Avoid tight interiors where the camera clips into walls. Why: touch camera control is slow to correct.
- Keep interact points apart so prompts do not overlap.
- Place the camera test: stand at each key point and confirm the next destination is visible without rotating far.

## Server population

Size the play area and the server's player limit together. Why: seeing other players doing the loop is motivation, while crowding on scarce resources is frustration. If resources are contested, give each player their own nodes or plot.

## Check before you hand off

- From spawn, the first zone and the hub services are visible.
- Each zone has a landmark and a distinct palette.
- Every locked gate shows its requirement.
- The longest routine trip was timed and has a shortcut or speed option.
- The map was walked on phone emulation without camera clipping or missed jumps.
