# Operations

## Daily

- `node --experimental-strip-types factory/cli.ts status`
- Answer any review thread before running another tick.
- If a maintainer replies “please stop,” remove the repo the same hour.

## Tick cadence

Every 6 hours, **or** operator `tick`. Never both overlapping. One packet in flight, including `submitted`. `followed-up` is not in-flight.

## Current (2026-08-28)

1. Wave 0 attested 2/2: [orca-fleet#70](https://github.com/ravidsrk/orca-fleet/pull/70), [orca-fleet#72](https://github.com/ravidsrk/orca-fleet/pull/72).
2. [frontguard#196](https://github.com/ravidsrk/frontguard/pull/196) merged by `ravidsrk`. Do not repeat operator-merge on a Foundry packet.
3. Wave 1 [ColeMurray/background-agents#1652](https://github.com/ColeMurray/background-agents/pull/1652) converted to **draft**, verbatim disclosure restored, packet **`followed-up`**. In-flight slot released. Do not merge.

## Halt switch

A repo with scorecard health `stop` cannot be queued or approved. To halt everything, reject in-flight packets and stop pressing tick. The GHA default is dry (`FOUNDRY_LIVE` unset).

Halt (`stop`) when:

- maintainer tone is `banned`, or
- any **revert** of our patch (narrow definition below), or
- **terminal** drafts ≥ 3 and merge rate < 40%.

Watch when tone is `cold`, or terminal drafts ≥ 2 and merge rate < 60%. In-flight drafts do not count toward the merge-rate sample.

## Metrics that matter

These are the operational definitions. `factory/scorecard.ts` encodes them so the scorecard cannot be computed the other way.

| Metric | Definition |
|---|---|
| **Merge rate** | `merged / terminal`, where **terminal** = opened drafts that reached merged, closed, or **stale-closed**. Stale-closed = still open, no human activity, 14 quiet days (ADR 0002). Stale-closed **counts against** the rate. In-flight drafts are not in the denominator. 90-day target: ≥ 60%. |
| **Review-comment average** | Mean number of **human, non-bot** review comments, over PRs with ≥ 1 such comment (`humanReviewed`). Bot-only threads (CodeRabbit, Greptile, …) do not enter the average. 90-day target: ≤ 4. |
| **No-review rate** | `noReview / (humanReviewed + noReview)`. Reported **alongside** the average so silence is not mistaken for cleanliness. |
| **Time-to-quiet** | Open → last human comment. |
| **Revert** | An explicit `git revert` of the merge commit, **or** a maintainer-stated rollback that names the PR, within **30 days** of merge (`REVERT_WINDOW_DAYS`). 90-day target: 0. Trips halt. |
| **Rework** | Post-merge edits or refactors of our code that are not a revert. Informational only; does not trip halt or the revert KPI. |
| **Bans** | Maintainer asked us to stop, or scorecard tone `banned`. Must stay 0. |

PR volume is a vanity metric and is not shown as a success KPI.

## Incident: slop accusation

1. Convert the PR to draft or close it.
2. Apologize on the thread. Do not argue.
3. Move the repo to denylist.
4. Write a scorecard event with tone `banned`.
5. Do not open another external PR for 14 days.
