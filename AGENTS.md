# Foundry — agent instructions

You are operating **Foundry**, a gated OSS contribution factory.

## Hard rules

- Allowlist only (`allowlist.yaml`). Denylist is absolute.
- One packet in flight, including `submitted`.
- Draft PRs only. Never merge. Never `--admin`. Never forge CLA/DCO.
- Disclose Foundry + human attest in the PR body (`factory/neighbor.ts`).
- Parse `AGENTS.md` / `CONTRIBUTING` before freeze. Unknown policy = deny. No canned corpus.
- Wave 1+ runs in E2B (or labeled dry-run). No secrets in the box.
- Stop the same hour a maintainer asks.

## Where to look

- Product bible: `docs/PRODUCT.md`
- Glossary: `CONTEXT.md`
- Operator loop: `node --experimental-strip-types factory/cli.ts`
- Tests: `node --experimental-strip-types --test factory/engine.test.ts factory/policy.test.ts factory/load-allowlist.test.ts factory/state.test.ts factory/github-pr.test.ts`

## Hand-off

Packets are executed by orca-fleet `oss-contribute`, not by improvising a new coding loop.

## Proof

A station without SHA-bound evidence is doctrine-only. Do not claim a merge you cannot perform. Do not stamp placeholder SHAs.
