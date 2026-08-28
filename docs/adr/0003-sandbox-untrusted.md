# ADR 0003 — Untrusted upstream runs in E2B

## Status

Accepted

## Context

Cloning a stranger’s repo onto the operator machine is running their `postinstall` as us.

## Decision

Wave 0 may use a host worktree. Wave 1+ must use E2B (or Daytona). Secrets never enter the box. Harvest is git-only, then destroy.

## Consequences

- E2B cost per packet (small).
- Some test suites will not run; those packets park instead of skipping tests.
- Dry-run mode is labeled honestly until a key is present. It does not report a successful harvest.
