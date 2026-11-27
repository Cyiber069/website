# Lighting And Readability

> Light the world so that interactables, hazards and paths stand out at a glance on a small, dim phone screen in a bright room.

## Readability first

A player must instantly tell four things apart: ground they can walk on, things they can use, things that hurt, and backdrop. Mood comes after that. Why: a beautiful scene in which the collectable blends into the floor slows the loop and loses new players.

## Rules

- **Value contrast between gameplay objects and their surroundings.** Check the scene in greyscale (a temporary `ColorCorrectionEffect` with saturation at minus one). If interactables vanish, fix their brightness, not just their hue. Why: brightness contrast survives poor screens and colour-vision differences.
- **Reserve one or two saturated colours for interactables.** Keep the environment less saturated. Why: the eye goes to the most saturated thing in view.
- **Consistent colour language.** One colour always means collectable, another always means danger, another always means locked. Why: learned once, read everywhere.
- **Favour bright, clear daytime for core areas.** Dark scenes are hard to see on phones outdoors. If a zone is dark for mood, light its paths and interactables locally.
- **Highlight sparingly.** A `Highlight` instance or a soft glow on the current objective only. Why: when everything glows, nothing is emphasised; highlights also have a rendering cost.
- **Keep the sky and horizon calm.** Why: a busy backdrop competes with the foreground.

## Lighting settings

- Choose the lighting technology in the `Lighting` service for the project deliberately and test it on the target phone; more advanced technologies look better and cost more. Record the choice in the performance notes from [[Part Count And Performance Budgets]].
- Set `ClockTime`, `Brightness`, ambient colours and an `Atmosphere` for depth. Mild haze separates distant zones from near ones, which helps the landmarks from [[Map Layout And Wayfinding]].
- Limit point, spot and surface lights, and disable their shadows unless they matter. Why: many shadow-casting lights are expensive on mobile.
- Remember that players on low graphics quality see fewer effects. Why: a clue that exists only as a subtle shadow or bloom will be invisible to them.

## Post-processing restraint

Bloom, depth of field and heavy colour correction should be mild. Why: bloom washes out interface text over bright areas, and blur hides distant goals the player needs to see. Interface text over the world should carry its own backing or stroke, as in [[UI Scaling And Constraints]].

## Test conditions

View the game at the lowest graphics quality setting and on phone emulation, and if a device is available, with screen brightness lowered.

## Check before you hand off

- Interactables remain obvious in a greyscale check.
- Each colour meaning is used consistently across zones.
- The scene is readable at the lowest graphics quality.
- Dynamic shadow-casting lights are few and justified.
- No gameplay information depends on a post-processing effect.
