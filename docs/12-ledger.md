# Live ledger — 2026-08-29

Operator snapshot. Foundry does not merge. Seed: `factory/seed.ts`. The block between the
GENERATED markers is emitted by `node --experimental-strip-types factory/cli.ts ledger` — regenerate
it after any state change instead of hand-editing; the clock cross-checks the committed seed against
GitHub every tick (`factory/verify-ledger.ts`: a divergence fails the run, an advisory is printed
and does not — see "What stops the clock" in `08-operations.md`), and `reconcile` absorbs
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
| pkt_matplotlib_matplotlib_0 | — | — | parked | — |

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

Three carried claims were re-checked against their sources; none held as written.

1. **background-agents merge figure re-derived.** `141 of 272 external PRs merged` named no method
   and does not reproduce. Re-measured 2026-08-29 (GitHub search
   `q=repo:ColeMurray/background-agents is:pr -author:ColeMurray`, plus `is:merged` for the
   numerator): **250 of 408 non-owner PRs merged (61%)**. Figure and method live in
   `allowlist.yaml`'s `policyNotes`. The `policy-records.json` `quote` is one verbatim statement
   from the source (`docs/SPEC.md` §3, `docs/10-schemas.md`) and renders to the maintainer as their
   own words, so it is the absence note alone — and `parsePolicyRecords` now refuses a `silent`
   record whose quote carries a derived figure, rather than trusting the convention.
2. **pydantic deny reason re-read at source.** A round-2 review recorded pydantic's AI policy as
   unconfirmable; that was wrong. It is `CONTRIBUTING.md` §"AI policy", re-read 2026-08-29 — one
   file under two paths, since the root `CONTRIBUTING.md` is a git symlink (tree mode `120000`) to
   `docs/contributing.md`. Pydantic *welcomes* AI use, reserves the right to close any PR at its
   discretion (mass-submission across repositories is a named case, and can end in a permanent ban),
   and auto-closes a PR opened on an issue without assignment. "Bans AI PRs" overstated it; the deny
   stands on fit.
3. **Repo ids are matched case-insensitively, end to end.** `halt` typed in a maintainer's casing
   reported success, incremented `bans`, and left the scorecard row `tone=neutral health=good` with
   the packet still in flight. `applyHalt` and `buildPacket` now canonicalise at the boundary and
   every lookup shares one comparison — ASCII-only, because GitHub's own case-insensitivity is, so a
   Unicode homoglyph is a different repo rather than a way onto the roster. Bans in the block above
   stay 0: no repository was actually halted by the defect.

## Corrections — 2026-08-29 (issue #49)

**ColeMurray/background-agents#1652 is not a draft, and seven doc surfaces said it was.** The seed
recorded `draft: true` at head `48c2242`, truthfully, as of the 16:16:39Z sync on 2026-08-28. At
**18:09:24Z the operator (`ravidsrk`) marked the PR ready for review**, and `6b6ff04` — a merge of
upstream `main`, the 7th commit — landed eight seconds later. Nothing synced afterwards, so
`verify-ledger` went red on `main` and stayed red. The clock was right.

Asked to choose, the operator kept the ready-for-review state rather than re-drafting upstream.
Draft-only is the hardest rule this factory has. **This is a deviation, not a healing** — the same
posture as the frontguard#196 operator merge: it happened, a named human did it at a named time, it
is recorded, and it does not license a second one. What changed:

1. `factory/seed.ts` `prMeta` synced to live: `draft: false`, `headSha: 6b6ff04`, `commits: 7`,
   `updatedAt: 2026-08-28T18:09:34Z`, `syncedAt: 2026-08-29T05:08:48Z`. Fetched read-only from
   `GET /repos/ColeMurray/background-agents/pulls/1652`. Nothing was written to that repository.
2. **Seven surfaces asserted a draft**, across five files. All corrected and date-qualified:
   `README.md` Status; `docs/PRODUCT.md` at the Status table row, the Wave 1 in-flight row, and the
   §8 disclosure paragraph; `docs/06-v2.md` Live packets; `docs/03-allowlist.md` roster entry; and
   this file's Next list. Issue #49 named five — `06-v2.md` and `03-allowlist.md` were found by
   sweeping every file for the PR number. `docs/PRODUCT.md` §10 separately told the operator to
   "prefer marking #1652 **draft**"; that instruction now records the decision instead of
   contradicting it. `docs/08-operations.md` asserted no draft flag but named the packet, so it
   gained the deviation and the clock section below.
3. No doc states a live PR property in bare present tense any more. Every such claim now names the
   sync it came from, because one click in a browser this factory does not control can falsify a
   sentence written in the present tense. **This sweep missed one** (issue #38): `docs/06-v2.md`
   read "Verbatim disclosure in body", and `docs/PRODUCT.md` §8 and this file's Next list asserted
   the same match with a date that no longer covered it. A change to `DISCLOSURE` falsifies such a
   sentence just as a browser click does, and nothing was watching that axis — `packetChecks` never
   read body text. All three are corrected, and the drift is now a check rather than a claim.
4. **The evidence was not touched.** It still describes `48c2242`, because nobody re-ran the test
   command at `6b6ff04`. Re-stamping `reviewedSha` would have made the clock green by claiming a
   test run that never happened. A re-witness is owed and outstanding.
5. `verify-ledger` now separates a **divergence** (the ledger contradicting GitHub — SPEC.md §7,
   still fatal, still reds `main`) from an **advisory** (a debt on a ledger that already
   reconciles — printed every tick, never a gate). See "What stops the clock" in
   `docs/08-operations.md`. Two advisories are outstanding on #1652 as of 2026-08-29: the
   re-witness gap, and the disclosure drift issue #38 added (Next, item 2).

## Next

1. Follow #1652 (**ready for review, not draft**, as of the 2026-08-29 sync — disclosure verbatim **as recorded at open**, no longer matching the current `DISCLOSURE` since ADR 0004's qualifier landed; the draft-only deviation is recorded above and the disclosure drift below) until quiet / merged-by-maintainer / closed.
2. #1652's body carries the pre-qualifier disclosure block. It is grandfathered and flagged, not
   falsified: `verify-ledger` prints it as an advisory every tick. Clearing it means editing a pull
   request on a repository this project does not own — **an outward-facing write needing an explicit
   operator go, which has not been given.** Until then the advisory is the correct output, and
   re-wording `DISCLOSURE` back to match would be falsifying doctrine for every future PR to make
   one old body look compliant. Policy is written beside the constant in `factory/neighbor.ts`.
3. Re-witness #1652 at `6b6ff04` before its evidence is read as covering the live head. `verify-ledger` reports the gap as an advisory every tick until someone does.
4. `sync pkt_ColeMurray_background-agents_1476 --threads-answered` once ≥14 quiet days accrue — the slot releases itself.
5. Idle. One packet in flight.
