# Live ledger — 2026-08-28

Operator snapshot. Foundry does not merge. Seed: `factory/seed.ts`. Refresh this file when GitHub changes.

## Wave 0

| Packet | Issue | PR | Status |
|---|---|---|---|
| CHANGELOG 0.5.0 | orca-fleet#42 | [#70](https://github.com/ravidsrk/orca-fleet/pull/70) | **merged** 2026-08-27T07:04:52Z. Attested **1/2** |
| README architecture | frontguard#195 | [#196](https://github.com/ravidsrk/frontguard/pull/196) | **merged** 2026-08-28T06:40:44Z by `ravidsrk`. Not a promotion-gate merge |
| Validator unreadable SKILL.md | orca-fleet#71 | [#72](https://github.com/ravidsrk/orca-fleet/pull/72) | **merged** 2026-08-27T11:30:04Z. Attested **2/2** |

Wave 1 promotion gate (two attested Wave 0 merges on orca-fleet): **passed**.

## Wave 1 — followed-up (in-flight slot released)

| Packet | Issue | PR | Status |
|---|---|---|---|
| Right sidebar toggle icon | [background-agents#1476](https://github.com/ColeMurray/background-agents/issues/1476) | [ColeMurray#1652](https://github.com/ColeMurray/background-agents/pull/1652) | **open draft** (converted 2026-08-28). Verbatim `DISCLOSURE` restored. Head `48c2242683705b00503d3436575bf3c28b1b0c9b`. Packet **`followed-up`**. Do not merge. |

Fork rehearsal [ravidsrk/background-agents#1](https://github.com/ravidsrk/background-agents/pull/1) is **closed** (still draft, not merged) as of 2026-08-28T10:14:36Z.

Live-verified 2026-08-28: `isDraft=true`, body carries the three-line `factory/neighbor.ts` `DISCLOSURE` block, no human review (CodeRabbit only). Doctrine miss (ready-for-review + shortened disclosure) is corrected. In-flight slot released via `followed-up` (oss-foundry#2).

## Scorecard (this control plane)

Definitions: [`docs/08-operations.md`](08-operations.md) ("Metrics that matter").

- bans: 0
- reverts: 0 (narrow: `git revert` of merge commit or maintainer-stated rollback naming the PR, within 30 days)
- rework: 0 (post-merge edits; informational)
- orca-fleet: 2 opened, 2 merged, 2 terminal, noReview 2, humanReviewed 0, warm
- frontguard: 1 opened, 1 merged, 1 terminal, noReview 1, humanReviewed 0, warm
- background-agents: 1 opened, 0 merged, 0 terminal (still open), noReview 1 (CodeRabbit is not a human review), neutral
- halt: none (needs ≥ 3 terminal drafts)

Merge rate on terminal packets: 3/3. #1652 is not terminal, so it is not in the merge-rate denominator.

## Allowlist corrections (2026-08-28, oss-foundry#3)

Live verification of every roster/denylist claim:

- `pydantic/pydantic` deny kept; reason is factory-pattern / mass-submit close-right + assignment-first auto-close, not an unsubstantiated “slop-PR close rate.” Their CONTRIBUTING welcomes AI.
- `stablyai/orca` deny kept; reason is conflict-of-interest (Foundry’s runtime), not an AI-policy restriction. CONTRIBUTING requires an AI review summary.
- `All-Hands-AI/OpenHands` → `OpenHands/OpenHands` (org rename). Policy is the PR template (`HUMAN:`/`AGENT:`, end-to-end evidence) plus `ready-for-dev`.
- `e2b-dev/E2B` retargeted to `e2b-dev/e2b-cookbook` (SDK examples removed in E2B#1769; no `docs/` on E2B).
- `ColeMurray/background-agents` `aiPolicy` is `undocumented-open`, not `welcome`.
- `github/awesome-copilot` language is JavaScript / Markdown (registered language is JavaScript; content is Markdown).

## Next

1. Watch #1652 for a human review thread. Answer if one appears. **Do not merge.**
2. Tick is allowed; named `firstIssues` are consumed, so the clock idles.
3. Do not open awesome-copilot or e2b-cookbook until a first issue is named and policy is parsed.
