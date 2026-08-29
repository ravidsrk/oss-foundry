# Live ledger — 2026-08-28

Operator snapshot. Foundry does not merge. Seed: `factory/seed.ts`. The block between the
GENERATED markers is emitted by `node --experimental-strip-types factory/cli.ts ledger` — regenerate
it after any state change instead of hand-editing; the clock cross-checks the committed seed against
GitHub every tick (`factory/verify-ledger.ts`, divergence fails the run), and `reconcile` absorbs
merges/closes into local state without ever releasing the in-flight slot.

<!-- GENERATED: node --experimental-strip-types factory/cli.ts ledger — do not hand-edit between these markers -->
### Wave 0

| packet | issue | PR | status | attested by |
|---|---|---|---|---|
| pkt_ravidsrk_orca-fleet_71 | [ravidsrk/orca-fleet#71](https://github.com/ravidsrk/orca-fleet/issues/71) | https://github.com/ravidsrk/orca-fleet/pull/72 | merged | operator |
| pkt_ravidsrk_frontguard_195 | [ravidsrk/frontguard#195](https://github.com/ravidsrk/frontguard/issues/195) | https://github.com/ravidsrk/frontguard/pull/196 | merged | operator |
| pkt_ravidsrk_orca-fleet_42 | [ravidsrk/orca-fleet#42](https://github.com/ravidsrk/orca-fleet/issues/42) | https://github.com/ravidsrk/orca-fleet/pull/70 | merged | operator |

### Wave 1

| packet | issue | PR | status | attested by |
|---|---|---|---|---|
| pkt_ColeMurray_background-agents_1476 | [ColeMurray/background-agents#1476](https://github.com/ColeMurray/background-agents/issues/1476) | https://github.com/ColeMurray/background-agents/pull/1652 | submitted | operator |

### Wave 2

| packet | issue | PR | status | attested by |
|---|---|---|---|---|
| pkt_OpenHands_OpenHands_16907 | [OpenHands/OpenHands#16907](https://github.com/OpenHands/OpenHands/issues/16907) | — | parked | — |

### Off allowlist — denied or unlisted

| packet | issue | PR | status | attested by |
|---|---|---|---|---|
| pkt_matplotlib_matplotlib_0 | [matplotlib/matplotlib#0](https://github.com/matplotlib/matplotlib) | — | parked | — |

Foundry-attested Wave 0 merges: 3 (promotion gate: 2).

### Scorecard

- ravidsrk/orca-fleet: opened=2 merged=2 closedUnmerged=0 noReview=0 tone=warm
- ravidsrk/frontguard: opened=1 merged=1 closedUnmerged=0 noReview=0 tone=warm
- ColeMurray/background-agents: opened=1 merged=0 closedUnmerged=0 noReview=0 tone=neutral
- bans: 0  mergedTotal: 3
<!-- /GENERATED -->

Promotion gate (two attested Wave 0 merges on orca-fleet): **passed** (#70, #72).
frontguard#196 was merged by the operator — recorded, not a promotion-gate merge, not a pattern.
Fork rehearsal [ravidsrk/background-agents#1](https://github.com/ravidsrk/background-agents/pull/1) is **closed** (draft, unmerged).
Do **not** open the compare URL again. The upstream PR exists. Follow up. Do not merge.

## Corrections — 2026-08-28 (issue #3)

Live verification found six factual errors in the allowlist; all corrected:

1. pydantic deny reason was "high slop-PR close rate" (unsubstantiated). Pydantic's CONTRIBUTING **welcomes** AI-assisted PRs; the real gates are anti-mass-submission and assignment-first. Deny kept, reason rewritten.
2. stablyai/orca deny reason implied an AI restriction; upstream has none (PRs must *include* an AI review summary). Deny kept as conflict-of-interest.
3. `All-Hands-AI/OpenHands` → `OpenHands/OpenHands` (org renamed; old id redirects).
4. background-agents `aiPolicy: welcome` was an inference — no written AI policy exists. Now `unknown` with a `policyNotes` provenance record.
5. E2B "docs/examples only" surface left that repo (E2B#1769, 2026-08-25); re-scoped via `policyNotes`, retarget tracked in issue #12.
6. awesome-copilot repo language is JavaScript tooling; content Markdown.

**Roster change — 2026-08-28 (issue #12):** awesome-copilot gains first issue #2684 (docs class; caps raised 80→120 lines for reference work); e2b-dev/E2B → e2b-dev/e2b-cookbook (the docs/examples surface moved); kortix-ai/suna removed (secret-gated dev loop, externally unverifiable). Policy records updated to match (8 records).

## Corrections — 2026-08-29 (issue #44)

1. **background-agents merge figure re-derived.** The `141 of 272 external PRs merged` figure carried
   in `allowlist.yaml`, `docs/03-allowlist.md` and `docs/PRODUCT.md` named no method and **does not
   reproduce**. Re-measured 2026-08-29 via the GitHub search API —
   `q=repo:ColeMurray/background-agents is:pr -author:ColeMurray` for the denominator and the same
   query plus `is:merged` for the numerator: **250 of 408 non-owner PRs merged (61%)**. The figure
   and its method live in `allowlist.yaml`'s `policyNotes`, which is what that field is for
   (`docs/10-schemas.md`). It was briefly written into the `policy-records.json` `quote` instead;
   that field is reserved for *one verbatim statement from the source* (`docs/SPEC.md` §3,
   `docs/10-schemas.md`) and renders on the maintainer-facing evidence page as their own words, so
   the quote is back to the absence note alone.
2. **pydantic deny reason re-read at source.** Round 2 recorded pydantic's AI policy as
   unconfirmable; that was wrong. It is in `docs/contributing.md` §"AI policy" (the repo's root
   `CONTRIBUTING.md` is a one-line pointer to it), re-read 2026-08-29. Pydantic *welcomes* AI use,
   reserves the right to close any PR at its discretion — mass-submission across multiple
   repositories is a named case, and can end in a permanent ban from the organization — and
   auto-closes PRs opened on an issue without assignment. "Bans AI PRs" overstated it; the deny
   stands, on fit rather than on an AI ban.
3. **Repo ids are matched case-insensitively, end to end.** GitHub treats `owner/repo` that way, and
   the roster gate did not: `halt` typed in a maintainer's casing reported success, incremented
   `bans`, and left the scorecard row `tone=neutral health=good` with the packet still in flight.
   `applyHalt` and `buildPacket` now resolve to the roster's spelling at the boundary, every
   scorecard lookup shares one comparison, and `assertAllowlist` checks disjointness the same way.
   Bans in the block above stay 0 — no repository was actually halted by that defect.

## Next

1. Follow #1652 (now **draft**, disclosure verbatim — healed 2026-08-28) until quiet / merged-by-maintainer / closed.
2. `sync pkt_ColeMurray_background-agents_1476 --threads-answered` once ≥14 quiet days accrue — the slot releases itself.
3. Idle. One packet in flight.
