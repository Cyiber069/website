# Update Cadence

> Ship updates on a predictable rhythm you can sustain, give each one a visible headline for players, and never let an update break saved data or live servers.

## Why cadence matters

A regular update gives current players something to anticipate and lapsed players a reason to return. Predictability matters more than size: a modest update every week or two builds a habit, while a huge update after long silence arrives to an audience that has moved on. Pick a rhythm the team can keep without cutting testing.

## What goes in an update

- **One headline players can see**: a new zone, a new tier, an event, a feature. Why: it is what goes on the thumbnail and in the description.
- **Quality fixes** from metrics and feedback: the biggest funnel drop, the most reported bug.
- **A small economy adjustment at most.** Why: frequent large rebalances make progress feel unstable.
- **Update notes** in the experience description and in a short in-game panel shown once. Why: players should learn what is new without searching.

Alternate content updates with polish updates if the rhythm is tight. Use limited-time events, with real and stated end dates, to give variety without permanent content cost; see [[Fair Offer Design]].

## Shipping safely

- **Test on a separate place first**, using the routine in [[Playtest Checklist For PC And Phone]], including a profile saved by the current live version.
- **Data changes are additive.** Add fields with defaults; never rename or remove a field without a migration that has been run against old saves. Why: old servers and new servers can run at the same time during a rollout. See [[DataStore Save Patterns]].
- **Old and new servers coexist.** Publishing does not instantly replace running servers. Code must tolerate both versions writing the same profiles, and anything stored must be readable by the older version until old servers are gone.
- **Migrate players deliberately.** Use the platform's option to restart servers for the new version, at a quiet time, with an in-game warning. Why: abrupt shutdowns during play feel like crashes.
- **Feature flags in config.** Ship risky features switched off and enable them once servers are stable. Why: turning a flag off is faster than a rollback.
- **Keep the previous version ready to republish.**

## Listening

- Read the metrics for the cohort that joined after each update; see [[Launch Metrics To Measure]].
- Collect feedback where players already are and tally themes rather than reacting to the loudest post.
- Publish a short "coming next" line. Why: a known future update is itself a return hook.

## Avoiding burnout

Scope the headline to what fits the rhythm with testing included. Build tools that make content cheap: data-driven zones, items and goals defined in config modules as in [[Code Layout In Roblox Services]]. Why: cadence that depends on heroic effort stops.

## Check before you hand off

- The update has one player-visible headline and written notes.
- It was tested on a separate place with a live-version save.
- Data changes are additive or have a tested migration.
- A rollback or flag-off path exists and was stated.
- The next update's headline is drafted.
