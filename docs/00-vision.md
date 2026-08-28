# Vision

Foundry is a **software factory for open-source contributions** that runs all the time without becoming a slop bot.

The product is not “open more PRs.” The product is **merged, etiquette-correct patches on allowlisted repos, with zero maintainer bans.**

## Why this exists

2026 made unattended OSS agents radioactive. curl’s HackerOne shutdown, matplotlib’s agent-interaction ban, and OpenClaw-style maintainer attacks all taught the same lesson: volume without governance is vandalism. (Pydantic, often cited alongside these, actually welcomes AI-assisted PRs — what it bans is factory-pattern mass submission; see the denylist reason.)

Foundry is the opposite posture:

- Contribute **less**, merge **more**.
- Never surprise a maintainer.
- Never merge. Never `--admin`. Never forge a CLA.
- Treat `AGENTS.md` / `CONTRIBUTING` as law, not flavour text.
- Dogfood on repos we own before we touch anyone else’s.

## What we already paid for

This is not a new agent framework. It is a **control plane** that sits in front of work we already run:

| Existing | Role in Foundry |
|---|---|
| [orca-fleet `oss-contribute`](https://github.com/ravidsrk/orca-fleet) | The per-issue pipeline. Already externally run (5 PRs, 4 review-assists). |
| Orca runtime | Coordinator / isolated workers / evidence manifests / ledgers. |
| frontguard | Visual regression when a UI patch needs an oracle. |
| HeyCMO / Mastra | Not the factory. Different product. Do not reimplement Foundry in Mastra. |

Foundry adds what `oss-contribute` does not have: an **always-on clock**, a **hard allowlist**, a **policy compiler**, a **human freeze CLI**, **E2B isolation for untrusted upstream**, and a **scorecard that can halt the factory**.

## Non-goals

- Replacing Orca or orca-fleet.
- Auto-merging anything, including our own default branches.
- Scraping GitHub for random `good-first-issue` labels.
- Competing with an in-flight maintainer PR.
- A new coding model. Workers use whatever Orca already runs.

## Success

After 90 days (operational definitions in [08-operations.md](08-operations.md)):

- ≥ 1 merged PR on a Wave 1 repo that is not ours.
- Merge rate ≥ 60% on opened drafts that reached a terminal state; stale-closed counts against.
- Review-comment average ≤ 4 over human-reviewed PRs, with the no-review count reported alongside.
- **Bans = 0. Reverts = 0.** A revert is an explicit revert of our merge commit within 30 days; post-merge rework is not a revert.
- The first 20 packets each have a human attest in the ledger.
