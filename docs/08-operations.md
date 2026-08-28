# Operations

## Daily

- `node --experimental-strip-types factory/cli.ts status`
- `node --experimental-strip-types factory/cli.ts reconcile` — absorb merges/closes; read any `DIVERGENCE` lines (doctrine events, resolved by hand, never auto-rewritten)
- Answer any review thread before running another tick.
- Approvals record who attested: `approve <id> --note … --by <name>` (or set `FOUNDRY_OPERATOR`).
- If a maintainer replies “please stop,” remove the repo the same hour.

## What the clock actually verifies

`factory/verify-ledger.ts` (the 6h job) checks the **committed seed** — `factory/seed.ts`, the
published ledger — against live GitHub, and fails the run on divergence. It does **not** read
`.foundry-state.json`: that file is gitignored and absent in CI, so it does not exist to be checked.

The guarantee is therefore: *what this repository publishes about its PRs is true.* It is not:
*what the operator has in flight locally is true.* Two consequences:

1. **Promoting live state into the seed is an explicit human step.** Nothing does it automatically.
   After a status change lands (a sync, a merge, a park), hand-edit `factory/seed.ts` and regenerate
   the block in `docs/12-ledger.md`. Until you do, the clock is verifying the older story.
2. **The local pre-flight is `status`.** It compares the live state file against the committed seed
   and prints `SEED DRIFT …` per packet that differs. Drift is not an error — it is the list of
   promotions you owe the seed.

`reconcile` is the other half: it absorbs live GitHub into local state and prints `DIVERGENCE …`
for anything a human must resolve. Neither command rewrites doctrine on its own.

## Factory halt

A GitHub **secondary rate limit** during `open-draft` writes a halt into the ledger (`halt` on the
state record) and prints the halt banner. SPEC.md §6 is "halt the factory, never retry", so the
halt is factory-wide, not per repo, and it persists across runs: `maySelectRepo` refuses every
repository — tick, approve, and open-draft included — until a human runs
`clear-halt --by <name> --note <text>`. It is not a scorecard `banned` tone: `bans` counts
maintainer asks, and a platform throttle is not a maintainer saying stop.

## Tick cadence

Every 6 hours, **or** operator `tick`. Never both overlapping. One packet in flight, including `submitted`.

## Current (2026-08-28)

1. Wave 0 attested 2/2: [orca-fleet#70](https://github.com/ravidsrk/orca-fleet/pull/70), [orca-fleet#72](https://github.com/ravidsrk/orca-fleet/pull/72).
2. [frontguard#196](https://github.com/ravidsrk/frontguard/pull/196) merged by `ravidsrk`. Do not repeat operator-merge on a Foundry packet.
3. Wave 1 in flight: [ColeMurray/background-agents#1652](https://github.com/ColeMurray/background-agents/pull/1652). Follow up. Do not merge. Do not tick.

## Halt switch

A repo with scorecard health `stop` cannot be queued or approved. To halt everything, reject in-flight packets and stop pressing tick. The GHA default is dry (`FOUNDRY_LIVE` unset).

## Metrics that matter — operational definitions

Silence is the modal outcome for external agent PRs, so every KPI names its denominator.

- **Merge rate** = merged / opened drafts that reached a terminal state (merged, closed-unmerged,
  or stale-closed under the quiet-day rule). Stale-closed counts **against** the rate. A draft still
  open and in follow-up is not yet in the denominator.
- **Review-comment average** = mean **human, non-bot** review comments, computed **only over PRs
  with ≥ 1 human review comment**. The `noReview` counter is reported beside it — opened drafts that
  reached a terminal state with **zero** human review activity (a still-open silent draft is not yet
  counted; the silent share is `noReview / terminal outcomes`, the same denominator as merge rate).
  A low average from silence is not a low average from clean work.
- **Time-to-quiet** = open → last human activity (comment, review, or push).
- **Revert** = an explicit `git revert` of our merge commit, or a maintainer-stated rollback naming
  the PR, within 30 days of merge. Post-merge edits/refactors of our code are **rework**, tracked as
  informational notes, never counted as reverts.
- **Bans** (must stay 0) = scorecard tone `banned`: a maintainer asked the factory to stop.

PR volume is a vanity metric and is not shown as a success KPI.

## Incident: slop accusation

1. Convert the PR to draft or close it.
2. Apologize on the thread. Do not argue.
3. Move the repo to denylist.
4. Write a scorecard event with tone `banned`.
5. Do not open another external PR for 14 days.
