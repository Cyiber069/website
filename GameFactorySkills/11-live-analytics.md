# Live Analytics

> Which numbers to read after launch, in what order, and how to turn
> them into a keep, fix or kill decision.

## When to use

- While building, to wire up events before launch.
- In the first days after a release or update.
- When deciding whether a game earns more work.

## Rules

1. Set target KPIs before building: D1 retention and playtime per user
   first; D7, D30, conversion and ARPPU later. Why: these drive Home
   recommendations. [Roblox docs: strategies]
2. Log the same minimum events in every game: session start, spawn,
   first action, tutorial steps, core loop, first upgrade, shop funnel,
   exits. Why: games become comparable.
   [repo: AshExplained/roblox-skills]
3. Log one onboarding funnel step per core-loop action, including
   failures, and fix the biggest drop first. Why: it shows where new
   players quit. [Roblox docs: funnel events, retention]
4. Log every currency source and sink from the server with an accurate
   ending balance. Why: one missing flow misleads the Economy
   dashboard. [Roblox docs: economy events; repo: EL4CTEO/roblox-skills]
5. Stay under 120 + 20 x CCU analytics requests per minute and 100
   custom event names; use custom fields with category values. Why:
   excess events are dropped or grouped as "Other".
   [Roblox docs: custom events, event types]
6. Read in this order: play through rate and first play bounce rate,
   first-session retention, D1/D7/D30 by cohort, session time, then
   conversion, ARPPU, ARPDAU. Why: Home recommendations rank on play
   through and bounce rate.
   [Roblox docs: discovery, analytics dashboard]
7. Compare each number with the dashboard benchmark band (50th to 90th
   percentile of similar games). Why: Roblox gives no official
   kill-or-keep threshold. [Roblox docs: analytics dashboard]
8. Starting assumption (not from a source): keep a game whose D1 and
   session time reach the benchmark band on normal traffic; kill it
   when both stay below the band after one fix cycle. Why: a default
   is needed; tune it. [no source]
9. Judge a new game on D1 and first-session data, and expect gaps:
   full dashboards need over 10 DAU and 10 play hours for 7 straight
   days. Why: D7 and D30 arrive later.
   [Roblox docs: analytics dashboard, retention]
10. Diagnose by the weak number: low D1 means core loop, first-time
    experience or performance; low D7 means progression; low D30 means
    endgame and social. Why: it aims limited effort.
    [Roblox docs: retention]
11. Ignore a retention dip on a big new-user spike day. Why: Roblox
    calls that dip typical. [Roblox docs: retention]
12. Change one thing, then compare the cohort that joined after it
    with earlier cohorts. Why: it shows whether the change worked.
    [Roblox docs: strategies, retention]
13. After every update watch crash rate, out-of-memory exits and
    memory by platform, with an alert such as "client crash rate above
    5% for 5 minutes". Why: a spike means a mobile regression.
    [Roblox docs: performance, alerts]
14. Send data-store error, overwrite and critical-state signals to the
    log sink. Why: they are the earliest sign of data loss.
    [repo: MadStudioRoblox/ProfileStore]

## Checklist

- [ ] Target KPIs written down before building
- [ ] Minimum event set logged
- [ ] Onboarding funnel logged, including fail outcomes
- [ ] Every currency source and sink logged from the server
- [ ] Event names under the limit, values low-cardinality
- [ ] Crash-rate alert set to a webhook
- [ ] Save-error signals reach the log sink
- [ ] Day-one read done in order, against the benchmark band
- [ ] Traffic checked against dashboard minimums before any verdict
- [ ] Keep, fix or kill decision recorded with date and cohort

## Sources

- Roblox docs: strategies, discovery, analytics dashboard, retention,
  funnel events, economy events, custom events, event types,
  performance, alerts
- repo: AshExplained/roblox-skills
- repo: EL4CTEO/roblox-skills
- repo: MadStudioRoblox/ProfileStore

## Lessons from launched games

Add dated lessons here after each launch.
