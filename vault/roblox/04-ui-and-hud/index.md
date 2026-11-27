# 04 UI and HUD

> This chapter covers where interface elements go on a phone screen, how to make them scale across devices, and how to build menus and shops that are quick to use.

## Why this chapter exists

The interface is how a player reads their progress and reaches every system. On Roblox it must share the screen with the platform's own controls: the top bar, and on touch devices the movement thumbstick and jump button. An interface designed on a desktop monitor and never checked on a phone will overlap those controls, shrink text below legibility, or put buttons where thumbs cannot reach. Each of those costs players who would otherwise have stayed.

## Notes in this chapter

- [[Mobile-First HUD Zones]] maps the screen into reserved and free zones and says what belongs in each.
- [[UI Scaling And Constraints]] explains Scale versus Offset, `UIScale`, `UIAspectRatioConstraint`, text size limits and safe-area insets.
- [[Menus And Shop Screens]] covers panels, tabs, close buttons, purchase buttons and the rules for opening UI at the right time.

## How to use it

1. Sketch the HUD on a phone-shaped landscape rectangle first, marking the reserved zones.
2. Build with scale-based sizes and constraints.
3. Check in the Studio device emulator at a small phone, a tablet and a desktop size, as described in [[Studio Test Modes]].

## Related chapters

- HUD goals and hints come from [[01 First Five Minutes]].
- Counter animation is covered in [[Feedback And Juice]].
- Purchase flows connect to [[06 Monetization]].
- Device checks are in [[Playtest Checklist For PC And Phone]].

## Principles

- Show only what the player needs right now; reveal more as systems unlock.
- A thumb is wider than a mouse pointer; size and space touch targets generously.
- The client displays state the server owns. No interface element decides an outcome.
