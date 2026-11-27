# Libraries
> Which outside libraries the factory uses by default, which it skips, and why.

Nothing here is installed yet. Versions and dates are what the projects' own files said when read; commit dates could not be checked.

## Rules
1. Use ProfileStore for all player data.
   Why: session locking, autosave and a documented purchase pattern in one server module; its docs recommend it for new games.
2. Use Rojo so every game is text files in a template repository.
   Why: an agent can edit, diff and review code; it is actively maintained.
3. Use TopbarPlus for secondary buttons such as Shop, Daily Reward, Codes and Settings.
   Why: frees thumb space and gives red-dot badges. Its licence requires credit in each game, and topbar icons are too small for primary actions.
4. Use Cmdr as a shared debug and admin console, limited to the owner's account.
   Why: one set of commands (give currency, wipe data, simulate purchase) reused in every game. It opens from a keyboard key, so use it from desktop.
5. Build UI with plain Roblox instances and a small shared component folder by default.
   Why: nothing to learn and no version drift; see skill 13.
6. Reach for vide only when a game's UI is heavily data-driven.
   Why: smallest reactive library and easy to learn, but still pre-1.0 with breaking changes between versions.
7. Skip Fusion by default.
   Why: pre-1.0 and its syntax changed a lot between versions, so AI-written code easily mixes old and new styles.
8. Skip NevermoreEngine.
   Why: built for large long-lived games; it needs a Node toolchain and pulls many dependencies. Borrow ideas, not the framework.
9. Use ZonePlus only when a game truly needs area triggers, and pin the version.
   Why: it works but appears unmaintained since 2021, so any breakage is ours to fix.
10. Use Wally only once a game has several outside packages; otherwise keep pinned copies in the template.
    Why: fewer moving parts. Every third-party package is code that runs inside the game.
11. Do not use boshyxd/robloxstudio-mcp.
    Why: its own README says it is being archived and the author lost control of the npm account, while its install command pulls the latest package automatically. It also listens on all network interfaces by default.
12. Treat awesome-roblox as a catalogue and Roblox/creator-docs as the source of truth for any API or policy question.
    Why: the first is unvetted links; the second is official.
13. Turn off automatic updates for any third-party module in a shipped game.
    Why: an update we did not read should never reach players.

## Video tools (Group B)
None are needed for the method in skill 12. They all install extra software, and one reads browser cookies, one asks for an account and API key, and one uploads video to a third party. In this cloud environment YouTube blocks direct downloads; reading the spoken transcript through a web fetch worked.

## Lessons from launched games
Add dated lessons here after each launch.
