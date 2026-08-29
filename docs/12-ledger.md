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

- ravidsrk/orca-fleet: opened=2 merged=2 closedUnmerged=0 noReview=1 tone=warm
- ravidsrk/frontguard: opened=1 merged=1 closedUnmerged=0 noReview=1 tone=warm
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

## Corrections — 2026-08-29 (issue #39)

**Three of the four 90-day KPIs could not be computed by any code path, and one of them was a
safety MUST.** `noReview` had no writer, `reviewCommentsAvg` was never derived, and `reverts` had no
producer at all: `applyPacketToScorecard`'s `"reverted"` branch had zero callers, while `health()`
turned `reverts > 0` into an unconditional stop and SPEC.md §7 makes halting on a revert a MUST. The
scorecard read `0` forever, correct or not.

1. **`noReview` and `reviewCommentsAvg` are written at the terminal transition**, in both branches
   of `applyPrSync` — merged and closedUnmerged. The input is the human (non-bot) review split read
   from `GET /pulls/{n}/reviews` and `GET /pulls/{n}/comments`, spent only at a terminal outcome. The
   PR object's own `review_comments` scalar is still recorded and is deliberately never the metric:
   it counts bots and names no author. When the endpoints cannot be read, neither counter moves and
   the ledger says so — a zero nobody observed is an invented KPI, which is the defect this issue is
   about.
2. **The seeded values were wrong, and the live re-read (read-only `GET`, 2026-08-29) says so.**
   `ravidsrk/orca-fleet` carried a hand-typed `reviewCommentsAvg: 0.5` — arithmetically `1/2`, the
   seed's own `prMeta.reviewComments: 1` over the two merged PRs. Wrong twice, structurally: the
   denominator was the merge-rate one, not "PRs with ≥ 1 human review comment" as
   docs/08-operations.md defines it, and the numerator was `prMeta.reviewComments`, GitHub's own
   scalar — a total that counts bots and names no author, so it cannot be a human-only numerator
   whatever value is typed into it. (Which *account* the typed `1` stood for is not recoverable and
   is not claimed here; the live scalar is `2`, one bot and one person.) #70's live review split is
   one human review comment and one bot's; #72 and frontguard#196 have no reviews and no review
   comments at all. Corrected to
   `reviewCommentsAvg: 1` over one reviewed PR, `noReview: 1` on orca-fleet and `noReview: 1` on
   frontguard. The seed's `prMeta.reviewComments` for #70 was also stale (`1`; live is `2`).
3. **`reverts` has two producers, one per half of its definition.** The mechanical half — a commit
   on the base branch saying `This reverts commit <our merge commit>` within 30 days — is found
   without a human: `verify-ledger` (the 6-hour clock, the only unattended runner) fails the run
   while the ledger still records no revert, and `reconcile` records it and stops the repo. The prose
   half — "a maintainer-stated rollback naming the PR" — is
   `revert <packetId> --reason <text> [--at <iso>]`, reason mandatory and stored verbatim, `--at`
   the day the ROLLBACK happened (defaults to now). Both halves measure the 30-day window from the
   event, through one shared predicate: the classifier passes the reverting commit's `committedAt`,
   the verb passes `--at`. Without that flag an operator writing up a day-10 rollback on day 35 was
   refused by the verb and recorded by `reconcile` — one rollback, two verdicts. Post-merge rework is
   excluded structurally: nothing but a commit naming our merge commit can reach the counter.
4. **`applyPrSync`'s status guard is untouched.** It has never seen a merged packet and still does
   not — the quiet-day and `closedUnmerged` semantics ADR 0002 describes are unchanged. The revert
   re-check went where merged packets were already being fetched: `reconcile`'s loop and the clock.

5. **The revert re-check reads the whole window, and says so when it cannot.** `listCommitsSince`
   followed no pagination: one page, 100 commits, no way to report a short read. GitHub serves
   commits newest-first, so page 1 is the *far* end of the `since` window — the read was blind to
   the hours immediately after the merge, which is when a revert is most likely. Measured live on
   2026-08-29, read-only `GET`: since #70's merge (`2026-08-27T07:04:52Z`) the base branch carries
   **111** commits, 100 on page 1 and 11 on page 2, and page 1's oldest is `2026-08-28T14:08:01Z` —
   a **31-hour** blind window opening at the merge, widening daily; the unread remainder contained
   #72's own merge commit `32050a00`. Since #72's merge it is 108 commits, 100 + 8. **These counts
   are a moving target and are quoted as a dated observation, not a reproducible constant**: the
   window has no far end (see item 8), `orca-fleet` main runs ~17 commits/day, and a re-read later
   the same day already gave 116 and 113. What is stable, and what the item is about, is the shape —
   over 100, so more than one page, so unreadable without following the cursor. The read now
   follows GitHub's `Link: rel="next"` cursor to a cap of 10 pages and returns a `truncated` flag
   when it stops early; `revertCheck` carries it out and `packetChecks` prints it on the same
   advisory path a failed read takes. A capped read must never be byte-identical to a clean one —
   a truncated success silently disables the FATAL, because the clock cannot fail on a revert it
   never fetched. (Verified after the fix: both orca-fleet windows read to the end of their cursor,
   `truncated=false`. An earlier version of this line said they "read to the merge commit itself",
   which is true of #70 and **false of #72**: its merge commit `32050a00` has committer date
   `11:30:03Z`, one second *before* its `merged_at` of `11:30:04Z`, so `since` excludes it — the
   full paginated window contains it zero times. Immaterial to the verdict, because `classifyRevert`
   skips the merge commit anyway, but it is not what the sentence claimed.)
6. **The remedies the operator surfaces named did not work, and one was destructive.** The clock's
   revert FATAL offered `reconcile` and `revert <id> --reason`; both end at `saveFactoryState` →
   `.foundry-state.json`, which `.gitignore` excludes and which the clock never reads — so an
   operator who followed the instruction saw it work locally, pushed nothing, and left `main` red.
   All three surfaces now name the step that works: promote the recorded revert into
   `factory/seed.ts` and regenerate the block below. Separately, three lines said a reverted repo
   was "unselectable until a human edits `allowlist.yaml`". `emptyScorecard()` builds its rows from
   `ALLOWLIST` and `health()` gates on `row.reverts > 0`, so following that instruction **deletes
   the scorecard row and erases the `reverts: 1`** this issue exists to produce. `allowlist.yaml`
   carries `version`, `caps`, `denylist`, `repos` and nothing that touches reverts. Corrected in
   `factory/engine.ts`, both `factory/cli.ts` surfaces, `docs/PRODUCT.md` and `docs/06-v2.md`.

7. **The re-read had no consumer, and the KPI was unrecoverable.** `syncGithubPr` spends 2 requests
   on the review endpoints of every already-terminal PR, on every `reconcile` and every 6-hourly
   tick — 6 a tick at today's ledger. The comment justifying that cost said re-reading was "the only
   way" a `humanReview` missed by a failed endpoint ever gets filled in. It was the exact opposite.
   `recordTerminalReview` has two call sites, both inside `applyPrSync`'s terminal *transition*
   branches; `applyPrSync` refuses any status but `submitted`/`followed-up`; `reconcile` therefore
   never hands it a merged packet; and `verify-ledger` never read `humanReview` at all. So for a
   **merged** packet — 3 of the 4 seeded ones — the re-read was consumed by nothing, and a packet
   whose review endpoints were down for the single tick that absorbed its merge was stranded at
   "not observed" **forever**, exactly the outcome the comment claimed a transition gate would have
   caused. The operator advice was unactionable in the same way: "re-sync once GitHub answers the
   review endpoints" routes to `sync` → `applyPrSync` → `cannot sync PR from status merged`.
   Fixed three ways. `applyReviewObservation` is the missing consumer: `reconcile` folds a recovered
   observation in exactly once, guarded on the packet's own stored `prMeta.humanReview` rather than
   on a transition nobody can replay, because these are cumulative counters and a level-triggered
   fold would inflate them every six hours. The advice now names `reconcile` (and says plainly that
   `sync` refuses a terminal packet). And `packetChecks` reports the gap: a terminal packet whose
   ledger records no observation is an **ADVISORY** — the ledger asserts *less* than GitHub knows,
   which contradicts nothing, so it is not the FATAL shape — saying that `noReview` and
   `reviewCommentsAvg` are computed over a denominator smaller than the terminal count implies.
   "A zero nobody observed is an invented KPI" has a second edge: so is a rate over a population
   nobody was told was short. Nothing surfaced this before; the revert check got a "did not run"
   advisory and the review KPI got none.
8. **The commit read was bounded at one end against a fixed cap.** `listCommitsSince` passed
   `since: mergedAt` with no `until`, and every merged packet is re-checked every tick with no
   expiry — while `classifyRevert` discards anything past `mergedAt + 30 days`. The read window
   therefore grew a day every day and never closed, and everything past the deadline was fetched,
   paged and thrown away. Measured on `ravidsrk/orca-fleet` (read-only `GET`, 2026-08-29): `main`
   runs ~17 commits/day (118 in 7 days), so the 30-day window holds ~505 — comfortably under the
   1000-commit cap. The *unbounded* window is under it only for now: at that rate it crosses the cap
   around day 60, and from then on every long-lived merged packet emits a permanent, unclearable
   truncation advisory on every tick, about a window that closed a month earlier. That is how an
   advisory channel gets trained into background noise — the failure this codebase cites twice as
   its reason for edge-triggering other checks. `revertCheck` now passes `until = mergedAt + 30d`,
   the classifier's own deadline, so the read is a fixed width from the day it opens. Deliberately
   *not* also added: an expiry that stops re-checking a closed window. With the bound in place the
   read is cheap and constant, and an expiry would mean a revert first observed after day 30 —
   because the clock was down, say — is never seen at all.
9. **`rel="next"` was unanchored in the fixture, not in the parser.** `nextPageUrl` matches the
   literal `rel="next"` and always did, but the only fixture exercising it built
   `` `<next>; rel="next", <next>; rel="last"` `` — both rels pointing at the same URL, `next`
   first — and its page 2 carried no `Link` at all, so relaxing the match to `rel="[a-z]+"` left
   the suite green. On the header GitHub actually serves for a middle page (`prev`, `next`, `last`,
   `first`, four distinct URLs) a relaxed parser returns the **`prev`** cursor: pages 1↔2 ping-pong
   to the cap, a false `truncated: true`, and pages ≥3 never read. A middle-page fixture now kills
   that mutant.

**The evidence for all of the above is re-runnable, not asserted.**
`node --experimental-strip-types scripts/mutation-audit.ts` applies one single-line mutation per row
of its table, runs the full suite against each, restores the file from the bytes it read, and
re-verifies the baseline. It exits non-zero if any real mutant survives or if a mutant's anchor text
has moved. Every line each round added or corrected is in that table with a one-sentence statement of
what shipping the mutant would cost.

**No count is quoted here, and that is the point.** This paragraph used to say "27 single-line
mutations … 26 must die and one must survive". By the next round the table held 65 and the sentence
still said 27 — a mutation score copied into prose, in the paragraph that calls a mutation score
copied into prose worthless. So the count has one source and one reader:
`scripts/mutation-audit.ts --list` prints the table and closes with its own tally, and a full run
prints the same line before it starts. What is stated here instead is the invariant, which does not
drift: **every mutant must reach the outcome its own row declares** — killed, unless the row carries
`expect: "survives"`, and exactly one does. That one is a local rebinding with no behavioural
content, so a harness that had broken into always-reporting-killed fails on it and the run exits
non-zero. A mutation score quoted in prose is not evidence; this is the same claim in a form a
reviewer re-derives in one command.

**A correction to this section's own round-2 arithmetic.** The blind window `since`-only reads left
on orca-fleet#72 was reported as ~39 minutes. That is wrong, and it understates it by a factor of
40. The window is `[merged_at, page-1-oldest]` = `2026-08-27T11:30:04Z` → `2026-08-28T14:08:01Z` =
**≈26.6 hours**. The 8 hidden commits happened to cluster in a 39-minute burst at the far end of
that window, which is incidental to how much of it went unread. #70's figure was stated correctly:
`07:04:52Z` → `14:08:01Z` = 31h03m, over 100 + 11 = 111 commits.

Not done here: the open review-bot thread on PR #19 that first flagged the `noReview` gap.

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
