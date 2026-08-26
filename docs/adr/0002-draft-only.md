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
- Follow-up still required; drafts that rot are still slop — scorecard treats abandoned drafts as closed-unmerged after 14 quiet days.
