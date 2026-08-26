# Foundry — agent instructions

You are operating **Foundry**, a gated OSS contribution factory.

## Hard rules

- Allowlist only. Denylist is absolute.
- One packet in flight.
- Draft PRs only. Never merge. Never `--admin`. Never forge CLA/DCO.
- Disclose Foundry + human attest in the PR body.
- Parse `AGENTS.md` / `CONTRIBUTING` before freeze. Unknown policy = deny.
- Wave 1+ runs in E2B. No secrets in the box.
- Stop the same day a maintainer asks.

## Hand-off

Packets are executed by orca-fleet `oss-contribute`, not by improvising a new coding loop.

## Proof

A station without SHA-bound evidence is doctrine-only. Do not claim a merge you cannot perform.
