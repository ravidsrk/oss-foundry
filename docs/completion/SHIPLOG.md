# SHIPLOG

Append-only. A session with zero context reads this file and continues from the resume pointer.

```
RESUME POINTER: P1/T-01
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

**28 tasks across P1–P7. 13 S · 15 M · zero L.** Longest dependency chain: 5. Both S0 gaps land in P2, the safety phase.

`A-11` resolves the one real design tension: a type-check gate needs a type checker, against an explicit, CI-documented zero-dependency property. `typescript` 7.x now ships platform-specific native optional deps, so a devDependency would import a genuine supply chain and a platform-sensitive lockfile. Decision: **CI-only type check via a pinned `npx`** — runtime supply chain stays at exactly zero, the gate still exists, CI still enforces it. The tsconfig is also made to earn its keep: `erasableSyntaxOnly` pins the Node 26 forward-compat property and `verbatimModuleSyntax` catches the type-import-elision hazard the Node docs warn about.

**Three Human Actions filed; two gate launch.** The maximum verdict reachable by the agent alone is therefore **CONDITIONAL GO** — a property of the product's boundary, not of the plan.

`H-03` is the highest-leverage item: **one line in `allowlist.yaml` unblocks three of the seven critical flows.**

Exit criteria: every above-line gap maps to ≥1 task ✔ · every task has acceptance evidence defined ✔ · no L tasks ✔ · human actions filed ✔.

**Second look — one change:** I had scoped `G-17` as "blocked on an E2B account", copying the audit's framing. Re-reading `witness.ts:400-401` against `allowlist.yaml` showed host witnessing is permitted at Wave 0 and that both `ravidsrk/orca-fleet` and `ravidsrk/frontguard` qualify (`wave: 0, sandbox: host`, real test commands). A real machine witness is reachable **today**, on repos the operator owns, with no E2B account. `H-02` was demoted from launch-gating to a product decision with a recommended zero-cost option, and `PLAN.md` says so explicitly.

→ **Next: PHASE 5 — execution begins at `T-01`. Write access to source starts here (R2).**
