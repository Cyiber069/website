# Spawn Area And First View

> The spawn point and the first camera frame should show the player what the game is about, where to go, and what they could become.

## Compose the first frame

Stand a test character on the `SpawnLocation` and look at what the default camera shows. That frame is the real first impression.

- **Face the action.** Rotate the `SpawnLocation` so the character faces the first interactable. Why: the default camera sits behind the character, so facing decides what is seen.
- **Show a near goal and a far goal.** Close by, the first thing to use. In the distance, something impressive: a locked area, a huge version of the starter tool, a high-tier player base. Why: the near goal starts the loop; the far goal promises depth. See [[First Session Goal Ladder]].
- **Keep it readable.** Strong contrast between walkable ground, interactables and backdrop. See [[Lighting And Readability]].

## Keep spawn safe and uncrowded

- Spread spawn points or use several `SpawnLocation` objects. Why: a pile of characters hides the world and the first interactable.
- Protect new players from being attacked at spawn in competitive games; the spawn force field duration on `SpawnLocation` exists for this. Why: dying before understanding the game reads as unfair.
- In plot-based games, assign a plot on the server at join and spawn the player there. Why: ownership is felt immediately.

## Load fast

- Enable instance streaming so the client only needs the area around spawn first; see [[StreamingEnabled Setup]]. With streaming on, client scripts must not assume distant instances exist.
- Keep the spawn neighbourhood cheap: few unique meshes and textures. Why: fewer assets to fetch means a shorter wait before control is given.
- If you add a custom loading screen from `ReplicatedFirst`, remove it as soon as the character and nearby world are ready, and do not block on preloading every asset in the game. Why: a long blocking preload converts loading time into quits.

## Sound and first seconds

Start ambient audio at a modest volume and avoid a loud sting on join. Why: many players join with sound on in shared spaces, and a harsh start prompts muting or leaving.

## Check before you hand off

- From spawn, without touching the camera, the first interactable and one aspirational far goal are both visible.
- Spawn works with several players joining at once without stacking.
- Time from join to control was measured on phone emulation and noted.
- No client script errors when distant parts are not yet streamed in.
- New players cannot be killed or blocked at spawn.
