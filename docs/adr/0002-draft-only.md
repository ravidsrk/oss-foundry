# ADR 0002 — Draft PRs only, never merge

## Status

Accepted

## Context

Unattended `gh pr create` + merge bots are how 2026 slop landed in maintainer inboxes as if it were ready.

## Decision

The GitHub App wrapper hard-codes `draft: true`. Merge methods are not implemented. Ready-for-review is a human browser click.

## Consequences

- Slightly slower cycle time.
- Maintainers see “Draft” which is the honest state of an agent patch.
- Follow-up still required; drafts that rot are still slop. The quiet-day rule moves the *packet*, never the scorecard: at 14 quiet days with threads answered a `submitted` packet becomes `followed-up` and releases the in-flight slot (`QUIET_RELEASE_DAYS`), and at 45 quiet days it gets a stale-intent note asking a human to close it with a polite word (`STALE_INTENT_DAYS`). `closedUnmerged` is written **only** on a real GitHub open→closed transition observed by `sync` — the engine never closes a PR and never scores a silence as a rejection. `factory/engine.test.ts` pins this: at 45 quiet days the scorecard row still reads `closedUnmerged === 0`. (An earlier version of this consequence claimed the scorecard counted abandoned drafts as closed-unmerged at 14 days; it never did — corrected per issue #44 item 2.)
