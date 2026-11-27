# UI and Game Feel
> Build touch-first screens and layered feedback so a simple loop reads clearly and feels good on a phone.

## When to use
- Building or reskinning a HUD, menu, popup or shop screen.
- Adding animation, sound or effects to a core action.
- Checking a build on a phone-sized screen before launch.

## Rules
1. Size and place UI with Scale plus aspect and size constraints; keep Offset for padding, strokes and icons.
   Why: pixel layouts break across phone sizes. [Roblox docs: position-and-size]
2. Keep interactive ScreenGuis on ScreenInsets = CoreUISafeInsets and set ResetOnSpawn = false.
   Why: buttons stay clear of notches and the top bar. [Roblox docs: screen-insets]
3. Make touch targets about 44x44 px and text at least 14 px, with fixed TextSize plus AutomaticSize instead of TextScaled.
   Why: a UI check can assert these numbers. [repo: EL4CTEO/roblox-skills]
4. Connect buttons with Activated, never depend on hover or a keyboard, and adapt with PreferredInput and ViewportDisplaySize.
   Why: Activated fires for touch, mouse and gamepad. [Roblox docs: cross-platform]
5. Keep primary buttons within thumb reach but off the bottom-corner thumbstick and jump zones, shown only in context.
   Why: default controls block badly placed UI. [Roblox docs: input/mobile]
6. Put secondary menus (Shop, Daily Reward, Quests, Settings) in the topbar with TopbarPlus: one bindToggleItem per panel, explicit setOrder, theme from Config.
   Why: thumb space stays free, one panel opens at a time, a reskin is a data change. [repo: 1ForeverHD/TopbarPlus]
7. The HUD always shows objective, currency, progress and next reward, and every screen has default, empty, loading, error and locked states.
   Why: players should never open a menu to learn what to do next. [repo: AshExplained/roblox-skills]
8. Give every core action an immediate layered response: animation, sound, effect burst, UI change, world reaction.
   Why: without feedback players assume the game is broken. [Roblox docs: onboarding-techniques]
9. Run effects on the client and animate UIScale, not Size, for pops.
   Why: layout stays stable and the server pays nothing. [repo: EL4CTEO/roblox-skills]
10. Use springs for motion whose target can change (presses, counters, bars) and tweens only for fixed one-shot curves; damping near 1 for panels, below 1 for reward pops, never 0.
    Why: a restarted tween loses velocity; zero damping never settles. [repo: dphfox/Fusion]
11. Play feedback sounds locally, pool frequent ones, preload only critical ones, and ship Music and SFX sliders plus mute.
    Why: server-played sounds ignore each player's volume. [repo: EL4CTEO/roblox-skills]
12. Write each UI piece as a function taking props, one per ModuleScript, that only displays what it is given and reports clicks through a callback.
    Why: stateless components survive reskins. [repo: dphfox/Fusion]
13. Teach with icons and arrows rather than small text, and keep the HUD clear of the action.
    Why: small text is unreadable on phones, and many players find games through shared clips. [Roblox docs: strategies]

## Checklist
- [ ] No interactive element sized or placed in pure Offset.
- [ ] Safe insets on; ResetOnSpawn off.
- [ ] Touch targets and text meet minimum sizes.
- [ ] Every core action playable by touch alone.
- [ ] Nothing sits on the thumbstick or jump zones.
- [ ] Only one panel open at a time.
- [ ] Empty, loading, error and locked states exist.
- [ ] Each core action has animation, sound, effect and UI change.
- [ ] Music and SFX sliders and mute work.
- [ ] Audio is owned by the experience owner or free to use.
- [ ] One shareable "wow" moment exists.

## Sources
- Roblox creator docs: position-and-size, screen-insets, input/mobile, cross-platform, onboarding-techniques, strategies.
- EL4CTEO/roblox-skills; AshExplained/roblox-skills.
- 1ForeverHD/TopbarPlus; dphfox/Fusion; centau/vide (spring damping).

## Lessons from launched games
Add dated lessons here after each launch.
