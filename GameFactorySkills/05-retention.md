# Retention
> Give players clear reasons to come back tomorrow, next week and after each update.

## When to use
- Planning the first week of play before building.
- Adding daily rewards, streaks, quests, events or a season pass.
- Scheduling updates for a game that is kept alive.

## Rules
1. Plan the first week: day 1 proves the loop fast, day 2 gives a return reason, day 3 unlocks new content, days 4-6 deepen progress, day 7 pays a reward shown since day 1.
   Why: the day-7 reward only works if seen on day 1. [repo: AshExplained/roblox-skills]
2. Show short, mid and long-term goals, but leave enough unlocked that session one is fun.
   Why: clear goals drive repeat visits; gating the fun loses new players. [Roblox docs: engagement]
3. Store the last claim as a UTC day number plus a streak count in saved data, grant on the server, and make claims idempotent.
   Why: device clocks cannot cheat it; retries cannot double-grant. [repo: EL4CTEO/roblox-skills]
4. Keep event start and end as UTC values in live config, compare on the server, and run client countdowns from server time.
   Why: timers stay true for everyone. [repo: EL4CTEO/roblox-skills]
5. Streak logic must tolerate ProfileStore's OnLastSave never firing; write nothing in OnSessionEnd.
   Why: servers can crash, and late writes are not saved. [repo: MadStudioRoblox/ProfileStore]
6. Make quests reinforce the core loop, keep objective and next reward on the HUD, and add daily quests with small reliable soft-currency rewards.
   Why: quests that need menu hunting hurt retention. [Roblox docs: introduction-to-quest-design]
7. Space rewards against average session length so a typical session earns something.
   Why: players should feel paid for their time. [Roblox docs: monetization-foundations]
   Starting assumption (not from a source): one reward per 10 minutes until session data exists.
8. Badge the Daily Reward and Quests topbar icons with notify when something is claimable; clear on claim.
   Why: an always-visible badge is a cheap prompt. [repo: 1ForeverHD/TopbarPlus]
9. Ship content weekly if possible, never less than monthly, one theme per update, built from existing systems.
   Why: winning back a lapsed player is harder than keeping one. [Roblox docs: content-updates]
10. Gate new update content behind a prerequisite or a purchase.
    Why: players who did not earn it leave soon after. [Roblox docs: monetization]
11. Run limited-time events with exclusive rewards other players can see, announced through Roblox's events system.
    Why: visible rare items make others ask how to get them. [Roblox docs: strategies]
12. For long-lived games add social systems (leaderboards, parties, trading), and reward leaderboard participation, not only top ranks.
    Why: they hold players between updates. [Roblox docs: retention]
13. A season pass needs a free track, a premium track that includes it, all rewards previewed, exact time left and XP per level; run about a month, then rest at least a week.
    Why: visible rewards become goals. [Roblox docs: season-pass-design]

## Checklist
- [ ] First-week plan written; day-7 reward visible on day 1.
- [ ] Short, mid and long-term goals visible.
- [ ] Daily claim uses server UTC day math.
- [ ] Rejoin and retry cannot double-grant.
- [ ] Objective and next reward on the HUD.
- [ ] Claimable rewards badge the topbar icon.
- [ ] Event timers use server time.
- [ ] Next update has one theme and a date.
- [ ] New content is earned or bought.

## Sources
- Roblox creator docs: strategies, engagement, retention, monetization, content-updates, introduction-to-quest-design, season-pass-design, monetization-foundations.
- AshExplained/roblox-skills; EL4CTEO/roblox-skills.
- MadStudioRoblox/ProfileStore; 1ForeverHD/TopbarPlus.

## Lessons from launched games
Add dated lessons here after each launch.
