# Live ledger — 2026-08-28

Operator snapshot. Foundry does not merge. Seed: `factory/seed.ts`. Refresh this file when GitHub changes.

## Wave 0

| Packet | Issue | PR | Status |
|---|---|---|---|
| CHANGELOG 0.5.0 | orca-fleet#42 | [#70](https://github.com/ravidsrk/orca-fleet/pull/70) | **merged** 2026-08-27T07:04:52Z. Attested **1/2** |
| README architecture | frontguard#195 | [#196](https://github.com/ravidsrk/frontguard/pull/196) | **merged** 2026-08-28T06:40:44Z by `ravidsrk`. Not a promotion-gate merge |
| Validator unreadable SKILL.md | orca-fleet#71 | [#72](https://github.com/ravidsrk/orca-fleet/pull/72) | **merged** 2026-08-27T11:30:04Z. Attested **2/2** |

Wave 1 promotion gate (two attested Wave 0 merges on orca-fleet): **passed**.

## Wave 1 — in flight (`submitted`)

| Packet | Issue | PR | Status |
|---|---|---|---|
| Right sidebar toggle icon | [background-agents#1476](https://github.com/ColeMurray/background-agents/issues/1476) | [ColeMurray#1652](https://github.com/ColeMurray/background-agents/pull/1652) | **open, ready-for-review** (not draft), blocked mergeability, +88/−1, 3 files. Head `48c2242683705b00503d3436575bf3c28b1b0c9b` |

Fork rehearsal [ravidsrk/background-agents#1](https://github.com/ravidsrk/background-agents/pull/1) is **closed** (still draft, not merged) as of 2026-08-28T10:14:36Z.

Do **not** open the compare URL again. The upstream PR exists. Follow up. Do not merge. Do not tick.

## Scorecard (this control plane)

- bans: 0
- reverts: 0
- orca-fleet: 2 opened, 2 merged, warm
- frontguard: 1 opened, 1 merged, warm
- background-agents: 1 opened, 0 merged, neutral
- halt: none

## Next

1. Follow #1652 until quiet / merged-by-maintainer / closed.
2. Prefer converting #1652 to **draft** until tests on that head are green.
3. Paste verbatim disclosure if the body is edited (`factory/neighbor.ts`).
4. Idle. One packet in flight.
