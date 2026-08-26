# Operations

## Daily

- Read the Board. If a packet is `draft-ready`, open the draft on GitHub yourself.
- Answer any review thread before running another tick.
- If a maintainer replies “please stop,” remove the repo the same hour.

## Tick cadence

Every 6 hours, **or** operator button. Never both overlapping. One packet in flight.

## First week (Wave 0 only)

1. Freeze `orca-fleet#42`.
2. Run it through `oss-contribute` / Orca, not through a stranger’s repo.
3. Merge is yours (you own the repo) but still use a PR. Record evidence.
4. Only then enable Wave 1 ticks.

## Halt switch

`useFoundry.getState()` will still tick Wave 0 if Wave 1 is halted. To halt everything, reject in-flight packets and stop pressing Run tick. The GHA default is dry (`FOUNDRY_LIVE` unset).

## Metrics that matter

- Merge rate (merged / opened drafts)
- Review comments per PR
- Time-to-quiet (open → last comment)
- Reverts
- Bans (must stay 0)

PR volume is a vanity metric and is not shown as a success KPI.

## Incident: slop accusation

1. Convert the PR to draft or close it.
2. Apologize on the thread. Do not argue.
3. Move the repo to denylist.
4. Write a scorecard event with tone `banned`.
5. Do not open another external PR for 14 days.
