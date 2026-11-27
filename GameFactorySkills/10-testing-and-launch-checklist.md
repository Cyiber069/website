# Testing and Launch Checklist

> A short, repeatable gate every small mobile-first game must pass
> before publishing or updating.

## When to use

- Before the first public release of any game.
- Before each update that touches saving, the economy or UI.
- When reskinning the template.

## Rules

1. Ship the smallest build that shows the core loop, then test it on
   real players. Why: early feedback finds the fun while direction can
   still change. [Roblox docs: strategies]
2. Test with two or more clients, a late joiner, a respawn and a player
   leaving mid-action, on an entry-level phone profile with simulated
   bad network. Why: replication and trust bugs hide in solo play.
   [Roblox docs: testing modes, device simulator; repo: EL4CTEO/roblox-skills]
3. Pass a mobile gate: first action within 10-30 seconds, large spaced
   tap targets, HUD clear of play, readable text, screenshots kept.
   Why: makes "mobile-first" measurable. [repo: AshExplained/roblox-skills]
4. Run a break-it pass: stages out of order, out of bounds, extreme
   tuning values, spammed remotes, and a death log with position and
   cause. Why: only careless play finds soft locks.
   [repo: m4bwav/roblox-agent; repo: EL4CTEO/roblox-skills]
5. Watch one first-time player without helping and time each
   hesitation. Why: those timings show where hints belong.
   [Roblox docs: onboarding techniques; repo: m4bwav/roblox-agent]
6. Never turn on Studio access to API services for the live game; test
   saving in a separate copy or with a mock store. Why: Studio writes
   to the same data stores as production.
   [Roblox docs: data stores; repo: MadStudioRoblox/ProfileStore]
7. Join, leave, rejoin and hop servers with two accounts; data must
   reload, load in under 5 seconds, and log a session end on leave.
   Why: slow loads usually mean a session was not ended.
   [repo: MadStudioRoblox/ProfileStore]
8. Where already set up (do not install tools), run format check,
   lint, type check and build in the same order locally and in CI,
   with pinned Roblox type definitions; any failure blocks the build. Why: unpinned checks change day to day.
   [repo: fizzyhex/luau-skills]
9. Where Jest Roblox is already set up, unit-test daily rewards,
   cooldowns and streaks with fake timers. Why: a 24-hour rule is tested in seconds.
   [repo: fizzyhex/luau-skills]
10. Keep one shared set of debug commands (grant currency, set stage,
    reset data, skip timers), with owner-only permission checked on the
    server. Why: repeatable QA; a client-side check is an exploit.
    [repo: evaera/Cmdr; repo: awesome-roblox/awesome-roblox]
11. Finish the whole Content Ratings Questionnaire, set genre, write a
    keyword-led first sentence, and upload 16:9 thumbnails at
    1920x1080. Why: a partial questionnaire limits release to
    age-checked 16+ users. [Roblox docs: publishing, thumbnails]
12. Budget the all-ages publishing fee: 1,000 Robux per game,
    refundable, when the account lacks two consecutive months of
    Plus/Premium; verify current policy first.
    Why: it changes the cost of each launch. [Roblox docs: publishing]
13. Make icon, thumbnail and description honestly show the game, and
    make the first 30 seconds match them. Why: packaging affects
    play-through rate and D1 retention.
    [Roblox docs: strategies; repo: AshExplained/roblox-skills]
14. After each update, restart servers if the saved data format
    changed, then check crash rate, frame rate and errors. Why: mixed
    versions and regressions surface here.
    [Roblox docs: update games, retention]

## Checklist

- [ ] Two-client, late-join, respawn, leave-mid-action, entry-level
      phone and bad-network tests pass
- [ ] First action within 10-30 seconds, screenshots saved
- [ ] Break-it pass done; death log reviewed
- [ ] Zero new errors or warnings in output
- [ ] Save, rejoin and server-hop pass on a test copy
- [ ] Format, lint, type check, build, timer tests pass (where set up)
- [ ] Ratings questionnaire, genre, description, thumbnails complete
- [ ] Publishing fee budgeted; first update planned

## Sources

- Roblox docs: pages named in each rule
- repos: EL4CTEO/roblox-skills, AshExplained/roblox-skills,
  m4bwav/roblox-agent, fizzyhex/luau-skills,
  MadStudioRoblox/ProfileStore, evaera/Cmdr,
  awesome-roblox/awesome-roblox

## Lessons from launched games

Add dated lessons here after each launch.
