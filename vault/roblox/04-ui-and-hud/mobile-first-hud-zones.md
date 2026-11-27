# Mobile-First HUD Zones

> Lay out the HUD on a landscape phone first, keeping your elements out of the areas Roblox uses for its top bar, thumbstick and jump button.

## Reserved zones on touch devices

| Zone | Used by | Your rule |
| --- | --- | --- |
| Top strip | Roblox top bar: menu and chat buttons, and other platform controls | Nothing interactive of yours here |
| Lower left | Movement thumbstick; the dynamic thumbstick responds across a wide lower-left area | No buttons |
| Lower right | Jump button | No buttons within a thumb's width of it |
| Upper right | Player list, when enabled | Avoid, or disable the list if unused |
| Screen edges | Notches, rounded corners, system gesture bars | Respect safe-area insets |

Why: a button under a platform control either cannot be pressed or causes accidental jumps and camera drags. Players blame the game, not the layout.

## Free zones and what goes there

- **Top centre, below the top bar:** currency counters and the current objective. Why: glanceable, never under a thumb.
- **Left edge, middle:** a short vertical stack of menu buttons (shop, inventory, settings). Why: reachable by the left thumb above the thumbstick.
- **Right edge, middle:** action buttons specific to the game (sprint, ability). Why: reachable by the right thumb above the jump button.
- **Bottom centre:** a hotbar or progress bar, kept narrow. Why: it sits between the two thumb zones.
- **Centre:** keep clear during play. Why: this is where the character and the world are.

## Sizing rules

- Touch targets should be comfortably thumb-sized with clear gaps between them. Why: adjacent small buttons cause mis-taps.
- Limit the always-visible HUD to a handful of elements. Hide systems until unlocked, as in [[Tutorial-Less Onboarding]].
- Text must be readable at arm's length on a small phone; see [[UI Scaling And Constraints]] for minimum sizes.

## Safe-area handling

`ScreenGui` has a `ScreenInsets` property that controls whether its contents stay inside the area clear of the platform's core UI and device cutouts. Keep interactive HUD in a ScreenGui that respects the core UI safe insets, and use a separate full-bleed ScreenGui only for backgrounds or screen fades. Why: full-screen effects should cover everything, but buttons must never sit under a notch or the top bar.

## Input-aware layout

Detect touch with `UserInputService.TouchEnabled` and the last input type, and show touch action buttons only when touch is in use. Why: on-screen ability buttons are clutter for keyboard players, and key hints are meaningless on phones.

## Check before you hand off

- In the device emulator on a small phone, no HUD element overlaps the top bar, thumbstick area or jump button.
- All interactive elements sit inside the safe area on a notched device preset.
- The centre of the screen is clear during play.
- Touch-only buttons are hidden for keyboard and gamepad players.
- The HUD was also checked on a tablet and a desktop size.
