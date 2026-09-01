# SHIPLOG

Append-only. A session with zero context reads this file and continues from the resume pointer.

```
RESUME POINTER: CONDITIONAL_GO/H-03
```

---

## 2026-09-01T11:42Z — run `20260901-1143` starts

Driver: product-completion. Mode `drive`. Repo `/Users/ravindra/projects/oss-foundry`.
Baseline `74af0b27f17ac39cda9779cbc6c73e7ed265e7df`, tree clean, `HEAD == origin/main`.
Working branch `ravidsrk/p0-completion-audit` (worktree `/tmp/pcd-wt`) — `docs/completion/` only, no source touched.

**R1 environment check.** Agentic with write access. `git` 2.55.0 · `node` v24.20.0 · `npm` 11.19.0 · `gh` 2.98.0 · `greptile` 3.4.2. Full pipeline available.

## PHASE 0 — baseline freeze · COMPLETE

Cold start from a fresh clone into `/tmp/pcd-coldstart`:

| step | result |
|---|---|
| `git clone` | exit 0, HEAD `74af0b2` |
| `npm ci` | **exit 1** — no lockfile |
| `npm install` | exit 0, no-op (zero declared deps) |
| `npm test` | exit 0 — **379/379**, 7.8s |
| `npm run validate` | exit 0 — `repos=8 denylist=4`, `policy records ok: 8` |
| `npm run foundry -- --help` | exit 0 — 18 verbs + verbatim disclosure |

Verdict **PASS**, with the `npm ci` failure recorded as data rather than smoothed over.
Evidence: `evidence/p0-coldstart-1-clone-install.txt`, `evidence/p0-coldstart-2-build-test-run.txt`.

Exit criteria: baseline recorded ✔ · cold start captured ✔.

## PHASE 1 — 360° audit · COMPLETE

Method: four read-only scouts on the heavy inspection slices (angles 2+3, 5+6, 8+9+11, 1+14) run in parallel; angles 4, 7, 10, 12, 13, 15, 16, 17 audited directly while they ran.

**Result: 68% complete.** 8 angles green, 7 amber, 1 red, 1 N/A.

| | angles |
|---|---|
| 🟢 3/4 | 1 product · 2 functional · 4 testing · 5 security · 8 reliability · 13 UX · 14 docs · 15 legal |
| 🟡 2/4 | 3 code quality · 6 data · 7 infra · 9 observability · 10 perf/cost · 11 integrations · 16 GTM |
| 🔴 1/4 | 17 ownership & ops |
| — N/A | 12 AI/LLM (grep-checkable: no model client anywhere) |

Critical flows: **7 identified · 1 verified · 2 works · 4 partial · 0 cut.** Exactly one (`CF-04 open-draft`) writes into a repository the operator does not own, and it has never fired.

Top five risks entering Phase 2:

1. `F-6-13` + `F-6-10/11` — non-atomic ledger write, no backup, no restore. One interrupted write bricks every command including `status`.
2. `F-5-10` — `witnessChildEnv` is a 4-key denylist, so the operator's whole environment reaches a third-party repo's install scripts.
3. `F-1-01/02/04` — three of seven critical flows have never fired; doctrine-only by the repo's own standard.
4. `F-1-09` — the promotion gate counts a merge the doctrine says it excludes.
5. `F-9-13` + `F-9-07` — no alerting at all, and the audit trail has no reader.

Evidence added: 8 files. Assumptions: `A-01` … `A-10`.

Exit criteria: no angle unscored ✔ · every score ≥3 backed by captured evidence ✔ · second look logged ✔.

**Second look — two changes made:**
- Deleted a false finding. My first exit-code probe reported `unknown command → exit 0`; `$?` was reading `tail` through a pipeline. Re-measured directly: exit **1**. The bug did not exist.
- Overrode a scout. `AngleFunctional` reported 105 test failures and flagged it as possibly its own sandbox; it was — one denied `mkdtemp` syscall, and `factory/tmp-dir.ts:52` is the single call site the whole suite funnels through. My own two runs (379/379, twice) stand. The residual observation is kept: 8 of 19 test files hard-require `$TMPDIR` with no skip path.

## PHASE 2 — deep research · COMPLETE

**Track A.** Velocity did not drop, it changed shape: 08-28/29 were breadth (45 PRs, 51 issues closed), 08-30 was depth (86 commits, **one** merged PR — the policy-scanner hardening taking 21 commits and ~20 review rounds). No committed roadmap or prior audit has ever existed, so `docs/completion/` is this repo's first durable plan artifact and there is no plan-vs-reality divergence to explain — every divergence found is doc-vs-code.

**Intent has held.** The first README's sentence (`dd41a55`, 2026-08-27) is still the repo description today, unchanged. Six days added an evidence protocol, a terminal boundary, a fail-closed ledger and a published SPEC — all of it *proving* the original claim, none of it extending scope. There is no scope creep. The gap is between the claim and its demonstration, which is exactly what `AGENTS.md:27` says.

**One salvage decision found.** `sweep2/issue-37` looked like a superseded duplicate (issue #37 is closed). It is not: of 22 tests it adds, 9 are on `main` and **13 are not**, including per-matcher necessity, near-miss non-firing, and a base ratchet. But `policy.ts` was rewritten after the branch was cut, so none apply unmodified → `G-29`, DEFER with an explicit instruction not to delete the branch until a salvage issue exists.

**Track B — six category-only queries, four new gaps.** The two that changed the plan's shape:

- **`X-GitHub-Api-Version` is unpinned, and it matters.** REST API version `2026-03-10` removes `merge_commit_sha`; the tool consumes it at `github-pr.ts:695` and feeds it to `classifyRevert`. When the unversioned default rolls forward, revert detection stops **silently** — on the field that forces `health=stop`. One header. → `G-04`.
- **`writeFileSync` does not flush.** Node's `flush` option defaults to `false`, so the fix for the top-ranked risk is exact rather than approximate: temp-in-same-dir → `writeFileSync(tmp, json, { flush: true })` → `renameSync`. POSIX rename is atomic; Windows has no such guarantee. → `G-01`.

Three findings recorded as **no effect** so they are not silently dropped, including one that prevents a future mistake: `--experimental-strip-types` is the **correct** spelling and must not be "modernised" to `--strip-types`, which does not exist on the Node 22 line.

Verified rather than assumed: zero enums, namespaces, parameter properties, decorators or import aliases in the tree, so the source is Node 26 forward-compatible even though v26 removed the transform-types escape hatch.

Exit criteria: RESEARCH.md sourced ✔ · every Track B item has an explicit plan effect ✔ · firewall log present ✔.

## PHASE 3 — definition and gap register · COMPLETE

`DEFINITION.md` **frozen at `a708920`**. The bar is the repo's own: *a station without SHA-bound evidence is doctrine-only*. Completion is therefore not feature coverage but three things — every critical flow demonstrated, the ledger survivable, the one integration forward-compatible.

**40 gaps, every one decided. 23 FINISH · 1 CUT · 16 DEFER · 0 ACCEPT.**

| | S0 | S1 | S2 | S3 |
|---|---|---|---|---|
| FINISH | 2 | 16 | 5 | 0 |
| CUT | — | — | 1 | — |
| DEFER | — | — | 12 | 4 |

Zero `ACCEPT` at any severity. The two standing concessions — operator-equivalent ledger access, and attested-not-witnessed Wave 1+ evidence — are scope statements in `DEFINITION.md` §4 with an expiry, not accepted gaps.

Five angles must move to meet the bar: **3, 6, 7, 9, 17**.

One gap sharpened while writing the register: `G-13` looked like a roster defect, but `load-allowlist.ts:85-93` already throws on an unmarked noop oracle and a `no-suite` repo cannot name a first issue. The live guard is complete; only the **published historical record** in `seed.ts:146-148` is wrong. Much better scoped.

Exit criteria: definition frozen ✔ · every gap decided ✔ · cut line drawn ✔.

## PHASE 4 — phased plan · COMPLETE

**28 tasks across P1–P7. 14 S · 14 M · zero L.** Longest dependency chain: **6** — `T-01 → T-02 → T-05 → T-07 → T-22 → T-28`. Both S0 gaps land in P2, the safety phase. (Counts recomputed from `status.json` after review round 1; the figures first written here by hand were wrong.)

`A-11` resolves the one real design tension: a type-check gate needs a type checker, against an explicit, CI-documented zero-dependency property. `typescript` 7.x now ships platform-specific native optional deps, so a devDependency would import a genuine supply chain and a platform-sensitive lockfile. Decision: **CI-only type check via a pinned `npx`** — runtime supply chain stays at exactly zero, the gate still exists, CI still enforces it. The tsconfig is also made to earn its keep: `erasableSyntaxOnly` pins the Node 26 forward-compat property and `verbatimModuleSyntax` catches the type-import-elision hazard the Node docs warn about.

**Three Human Actions filed; two gate launch.** The maximum verdict reachable by the agent alone is therefore **CONDITIONAL GO** — a property of the product's boundary, not of the plan.

`H-03` is the highest-leverage item: **one line in `allowlist.yaml` unblocks three of the seven critical flows.**

Exit criteria: every above-line gap maps to ≥1 task ✔ · every task has acceptance evidence defined ✔ · no L tasks ✔ · human actions filed ✔.

**Second look — one change:** I had scoped `G-17` as "blocked on an E2B account", copying the audit's framing. Re-reading `witness.ts:400-401` against `allowlist.yaml` showed host witnessing is permitted at Wave 0 and that both `ravidsrk/orca-fleet` and `ravidsrk/frontguard` qualify (`wave: 0, sandbox: host`, real test commands). A real machine witness is reachable **today**, on repos the operator owns, with no E2B account. `H-02` was demoted from launch-gating to a product decision with a recommended zero-cost option, and `PLAN.md` says so explicitly.

→ **Next: PHASE 5 — execution begins at `T-01`. Write access to source starts here (R2).**

## 2026-09-01T13:40Z — post-merge correction: PR #122's bot comments

**Process failure, recorded because it would otherwise recur.** PR #122 merged with two unaddressed review comments. The GitHub bot posted them at **12:43:23Z** and I merged at **12:44:04Z** — **41 seconds later**, on the strength of the green `Greptile Review` check. **A green check means the review ran, not that it found nothing.** I never fetched the inline comments. R11 makes the local CLI run the gate, and I read that as licence to ignore the bot — it is not. See `A-13`.

Both findings were valid and are fixed here:

- **[P1] `STATUS.md`'s verdict header was stale.** It still read `PHASE 1 COMPLETE`, `definition not yet frozen`, `TASKS: 0/0`, `NEXT: Phase 2`, while `SHIPLOG.md` and `status.json` pointed at `P1/T-01`. A reader resuming from the file the driver designates as verdict-first would have been sent back through three completed phases. The header is the one artifact the spec says to rewrite at the top of *every* phase, and I wrote it once in Phase 1.
- **[P2] Four cross-references pointed at valid-but-wrong identifiers.** `RESEARCH.md` mapped the abandoned-branch salvage to `G-16` (the machine-account gap) instead of `G-29`; the rate-limit research effect to `G-09`/`G-10` (the first is the event ring) instead of `G-10`; `DEFINITION.md` mapped the packet-id write to `G-20` (`.gitignore`) instead of `G-19`; and `HUMAN_ACTIONS.md` cited `T-16` for CF-04/CF-05 evidence when `T-16` is CF-06's. All four were artifacts of writing the prose before the register was renumbered.

Fixed the class rather than the four instances: every `G-`/`T-`/`CF-` reference in all five prose artifacts is now checked against the register mechanically — **28 references, each printed beside the row it points at**. No dangling identifiers, and every subject matches. The check is cheap to re-run and is the thing that should have existed before the first commit.

Audit of the other PRs from this pass, for completeness: **#117/#118/#119** were skipped by the bot (dependabot is on its excluded-authors list) — no findings. **#120** was **APPROVED** with zero comments. **#116** carries two inline comments dated `be804a4`, both of which are the two P1s I fixed at `c49c516`/`254801a` and verified by provenance at the time — addressed, though never replied to on the PR itself.

### Round 2 on the fix PR (#123) — two more, both hand-typed numbers

The bot found two more on the correction itself, and the pattern across both rounds is one thing: **every finding on these artifacts has been a figure I typed by hand disagreeing with `status.json`.** Round 1 on #122 was the task count and the size split; round 2 on #123 was the S2 subtotal (`17` against an actual `18`, making the severity sum 39 against a stated 40) and a placeholder timestamp (`12:5xZ`) I left in a heredoc.

Both fixed by deriving from the register rather than retyping: `S0 2 · S1 16 · S2 18 · S3 4`, summing to 40, and a real timestamp.

**The rule this establishes:** no count in a prose artifact is written by hand. `status.json` is the register; every subtotal in `STATUS.md`, `PLAN.md`, `GAPS.md` and this log is computed from it. Three of the seven findings across this pass were arithmetic drift between a hand-typed prose number and the machine-readable state, and that class is fully preventable.


---

## PHASES 1–7 — EXECUTED · 27/28 tasks · **CONDITIONAL GO**

`main` at `ba59027`. **418 tests** (from 379), type check **0 errors**, validator green, zero open PRs, zero `ravidsrk/*` branches.

**Completion 68% → 86%.** Ten of sixteen scored angles moved, and **every angle now meets the frozen Definition's required minimum** — the five that had to move (3, 6, 7, 9, 17) all did.

### The two S0 gaps are closed

**G-01, the ledger.** It was one `writeFileSync` — a truncating write in place, so a crash left a prefix of valid JSON, the loader correctly refused it, and that took out `status` too: the one command an operator would reach for. Now temp-file + `flush: true` + `renameSync` + a directory fsync, with a one-generation backup and a rehearsed restore. Proven by a concurrent reader rather than a kill loop, because the kill loop was measured at a 1-in-12 tear rate and would have been a flake: **old 29 partial reads of 187, new 0 of 186.**

**G-02, the witness environment.** Four secret names were stripped and everything else passed into a third-party repo's `npm ci` lifecycle scripts. Now an explicit allowlist — widened after review to admit proxy/CA/version-manager settings, with proxy userinfo stripped so credentials cannot ride in a URL.

### What the phases produced

| phase | outcome |
|---|---|
| **P1** | Real Node floor **executed** in CI, not asserted. A type-check gate where nothing had ever read the types — it found six real problems in non-test source on its first run. |
| **P2** | Both S0s. API version pinned. Every child process bounded. Packet ids can no longer escape the log directory. |
| **P3** | The promotion gate now matches the doctrine it enforces. The published ledger no longer claims a negative control it could not have performed. Six dead exports gone. Event loss counted instead of silent. |
| **P4** | The clock can now tell a human it failed. The audit trail has a reader. `status` can explain a stuck factory. |
| **P5** | No doc asserts behaviour the code lacks — including a false security headline that had survived since the file was written. |
| **P6** | The front door opens: fresh clone to first command in **19.7s** against a 15-minute target. |
| **P7** | Rollback rehearsed and closed unmerged. Gate evaluated. |

### The review loop did real work

**23 findings across 13 review rounds, 21 fixed and 2 rebutted with evidence.** Not one was cosmetic. The ones worth naming:

- **The Node floor was wrong twice.** `>=22` claimed versions where Node aborts on the flag; my correction to `>=22.6.0` was still wrong because the binding constraint is `node:test`'s per-file `test:summary`, which the suite's own oracle needs. Bisected against real runtimes: **22.9.0 refuses, 22.10.0 green.** Neither mistake was reportable from inside the process — below 22.6.0 nothing runs, and between 22.6.0 and 22.9.0 the failure *is* the oracle that would have reported it. That is the argument for executing a floor rather than declaring one, and it took two wrong answers to make it concrete.
- **A fake green.** The type gate's first "0 errors" came from `npx tsc` resolving to a squatter package that prints *"This is not the tsc command you are looking for"*. The negative controls caught it. A gate reporting zero because it checked nothing is worse than no gate.
- **`always()` does not survive a job timeout.** Two rounds were spent on an alert that would have been silent in exactly the outage it exists for. The fix is a sibling job.
- **A doc error of mine, one phase old.** I wrote that the in-flight cap is not consumed at `draft-ready`. It is. Corrected the same day, in the phase that exists to remove exactly that.

### What is NOT done, stated plainly

**Five of seven critical flows still have no happy-path evidence** — CF-01 through CF-05 — and all five are blocked on the same two Human Actions. That is why the verdict is CONDITIONAL GO and not GO. No amount of further agent work changes it.

Gate §6 (one alert proven to fire) is met in mechanism and unit-proven against a fake octokit, but a real scheduled-run failure cannot be produced from this repository. Recorded as a limit rather than claimed as a pass.

16 gaps remain DEFERred below the cut line, unchanged and still filed — including `G-25`, the five hand-copied competing-work reads, which is deferred reluctantly and says so.

### Second look — one change

I nearly recorded a false regression: re-measuring the atomic write after adding the directory fsync showed 13 partial reads, which would have looked like the fsync breaking atomicity. The probe was still pointed at the previous worktree, whose patch I had reverted. Re-pointed: **0 partial**. The lesson is the same one the fake-green produced — a measurement you did not verify the setup of is not a measurement.

→ **Next: `H-03`.** One line in `allowlist.yaml` unblocks three of the five remaining flows.
