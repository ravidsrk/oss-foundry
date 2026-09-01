# Gap register

Every finding standing between `74af0b2` and `DEFINITION.md`. Decision rules applied: **S0 → FINISH or CUT, never DEFER/ACCEPT.** S1 → FINISH by default. S2/S3 → DEFER by default, FINISH only if ≤ S size and on a critical flow.

Cut line is drawn after `G-24`. Everything above it is in `PLAN.md`; everything below is filed and out of scope.

## Above the line

| id | source | angle | flow | sev | decision | rationale |
|---|---|---|---|---|---|---|
| **G-01** | F-6-13, F-6-10, F-6-11, F-8-27, R-06 | 6 | all | **S0** | FINISH | The ledger is written by one bare `writeFileSync` with no temp file, no fsync and no backup. An interrupted write leaves truncated JSON; the loader then correctly refuses it, which kills **every** command including the `status` an operator would use to diagnose it. No restore procedure exists anywhere. Data-loss class. Fix is exact (R-06): temp-in-same-dir → `writeFileSync(tmp, json, { flush: true })` → `renameSync`. |
| **G-02** | F-5-10 | 5 | CF-03 | **S0** | FINISH | `witnessChildEnv` strips four secret names and passes everything else through, so `npm ci` on an allowlisted third-party repo runs its lifecycle scripts with the operator's whole environment — `NPM_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `ANTHROPIC_API_KEY`, `OP_SERVICE_ACCOUNT_TOKEN`. Credential exposure to arbitrary third-party code on the one path that executes it. Invert to an allowlist. |
| **G-03** | F-14-04, cold-start `npm ci` | 14, 16 | all | S1 | FINISH | The README fails the stranger path at 9 enumerated points; `npm`, `git clone`, `install`, `status` and `approve` appear **zero times**. The reflexive `npm ci` fails and only the CI workflow explains why. For a product whose thesis is being trusted by strangers, this is the GTM defect. |
| **G-04** | R-04 | 11, 8 | CF-06 | S1 | FINISH | No `X-GitHub-Api-Version` header is sent, so every request inherits a rolling default. The tool consumes `merge_commit_sha` (`github-pr.ts:695` → `classifyRevert`), which API version `2026-03-10` **removes**. When the default rolls forward, revert detection stops **silently** — and `reverts` is what forces `health=stop`. One header fixes it. |
| **G-05** | F-3-01, F-3-02, R-01 | 3 | all | S1 | FINISH | No type-check gate exists at all: no `tsconfig.json`, no `typescript` dep, no script, and `--experimental-strip-types` is verified erasure-only. 9,639 lines of TypeScript enforced by nothing. Angle 3 cannot reach the required 3 without this. |
| **G-06** | F-3-06, F-7-02, R-02, R-03 | 3, 7 | all | S1 | FINISH | `engines: ">=22"` is below the real floor (22.18.0 for default-on stripping; 22.6.0 for the flag) **and npm does not enforce `engines` anyway** — it is not a guard. Compounding it, CI pins Node 22, which is maintenance-only **and** the line where type stripping is still a release candidate, while the operator runs 24 where it is Stable. |
| **G-07** | F-9-13, F-9-15 | 9 | all | S1 | FINISH | No alerting of any kind. No `if: failure()` in either workflow. Nothing tells a human when the unattended 6-hour clock fails, when a halt trips, or when a packet is stuck. Launch gate §6 requires one proven alert. |
| **G-08** | F-9-07, F-9-10, F-9-11, F-9-18 | 9 | all | S1 | FINISH | The events array is written and **never read** by any command — the audit trail exists only as JSON in a gitignored file. `reverts` and `reviewCommentsAvg` are computed, stored and printed by nothing, while `reverts > 0` forces `health=stop`: an operator sees a repo frozen with no surfaced reason. |
| **G-09** | F-6-22, F-6-23 | 6 | all | S1 | FINISH | `events` is a bounded ring — `.slice(0, 80)` in **14 places** — and the 81st event destroys the oldest with no marker, no counter, no archive. The cap is documented nowhere, while `docs/12-ledger.md` positions the ledger as the audit surface. Truncation must be either recorded or documented; silent is not an option. |
| **G-10** | F-8-18, F-8-19, F-10-03, R-05 | 8, 10 | all | S1 | FINISH | GitHub's **primary** rate limit is neither detected nor documented. Reads are silently unauthenticated when no token is set — 60/hr against a measured 19-requests-per-tick spend, so the fourth tick of an hour fails with an unexplained 403 and nothing says a token is required. |
| **G-11** | F-8-28, F-8-29, F-17-03 | 8, 17 | all | S1 | FINISH | Verified by the audit: a stranger **cannot** recover from a corrupt ledger, and **cannot** recover from a revoked PAT, from the docs alone. Launch gate §8 requires all three scenarios; only maintainer-stop is covered today. |
| **G-12** | F-1-09 | 1 | CF-04 | S1 | FINISH | `foundryAttestedWave0Merges` counts a Wave 0 merge that `docs/PRODUCT.md` §8 says is excluded from the promotion gate. The exclusion is prose only; the code prints `attestedWave0=3` against a gate of `< 2`. A governance gate can promote on a merge its own doctrine excludes. Code and doctrine must agree — in whichever direction the maintainer states. |
| **G-13** | F-1-05, F-1-06 | 1 | CF-03 | S1 | FINISH | The published frontguard packet asserts `negativeControl: "red-on-revert"` over `testCommand: "true"`. A noop command cannot go red on revert, and the repo's own issue-#112 doctrine says so. **The published ledger carries a negative control that controls for nothing**, and its recorded test command contradicts `allowlist.yaml:42`. Published-evidence integrity on the product's core claim. |
| **G-14** | F-8-13 | 8 | CF-03 | S1 | FINISH | `witness.ts:125` runs `git clone`, `npm ci` and the upstream `testCommand` through `execFile` with **no timeout**. A hung clone, registry or upstream suite blocks `evidence` forever with no deadline anywhere in the process. |
| **G-15** | F-14-07, F-14-06, F-11-14, F-1-11, F-1-10 | 14, 11 | — | S1 | FINISH | `docs/07-github-app.md:3` asserts "authenticates as a GitHub App, never as a personal PAT" — **false**, contradicted 30 lines below and by the code. Three secrets it mandates are read by no code. `docs/06-v2.md` describes an E2B lifecycle that does not exist and disagrees with the code on clone depth. Stations 4/5 are described as gates but are a status bump. A false security claim in the docs is worse than a missing one. |
| **G-16** | F-1-04, F-11-26 | 1 | **CF-04** | S1 | FINISH (`human:H-01`) | The single irreversible flow has never fired. `open-draft` needs a machine account and a `public_repo` PAT that only a human may create — the wizard forbids an agent doing it. Blocks launch gate §2 for CF-04. |
| **G-17** | F-1-02, F-1-03, F-11-15, F-11-19, F-11-27 | 1, 11 | **CF-03** | S1 | FINISH (`human:H-02`) | No machine witness has ever been produced; `docs/evidence/logs/` does not exist, so the evidence page's `shasum` offer has no files behind it. Wave 1+ needs an E2B account, a key, and a worker host whose runner is **unwritten and unlocated**. Blocks launch gate §2 for CF-03. |
| **G-18** | F-1-01 | 1 | **CF-01** | S1 | FINISH (`human:H-03`) | `tick` deterministically returns `idle`: all three named `firstIssues` rows are consumed and every other roster entry is empty. The code works; the roster is exhausted. Choosing the next target is a maintainer product decision, not the agent's. |
| **G-19** | F-5-22 | 5 | CF-03 | S2 | FINISH | Packet `id` has no format validation and is interpolated into a filesystem write path, so a hand-edited ledger yields an arbitrary write. Defence-in-depth (precondition is operator-equivalent access) but ≤S and on a critical flow. |
| **G-20** | F-5-08 | 5 | — | S2 | FINISH | `.gitignore` is 3 lines with no `.env*` pattern, and `.claude/settings.local.json` is ignored only by the developer's **personal global** config — a fresh clone elsewhere would not ignore it. Trivial, and it is a secrets surface. |
| **G-21** | F-1-07 | 13, 8 | all | S2 | FINISH | A transport failure surfaces as the bare string `fetch failed` — no repo, no operation, no remedy. One line; affects every flow. |
| **G-22** | F-3-11, F-14-10, F-14-05, F-6-03 | 14, 3 | — | S2 | FINISH | `docs/01-architecture.md` lists 8 of 29 modules, omitting every module implementing SPEC §5/§6/§7. There is **no env-var reference anywhere** and `FOUNDRY_GITHUB_TIMEOUT_MS` is read by shipping code and documented in zero files. Three real packet fields are missing from the schema doc. Required for angle 17 → 2 and for the Stranger Test. |
| **G-23** | F-7-04, F-17-05, F-15-03 | 7, 17 | — | S2 | FINISH | `ci.yml` has no `timeout-minutes`. 15 merged local branches are debris. `package.json` says `"private": true` on a public MIT repo. Three one-line hygiene fixes, batched. |
| **G-24** | F-2-13 | 2, 3 | — | S2 | **CUT** | Seven dead runtime exports — zero callers, zero tests, zero mentions. Four are UI-layer leftovers (`statusTone`, `policyTone`, `formatWhen`, `needsFollowUp`) for a console `docs/01-architecture.md:33` states does not exist here. Delete, do not wire. |

**— CUT LINE —**

## Below the line

| id | source | sev | decision | rationale |
|---|---|---|---|---|
| G-25 | F-3-08 | S2 | DEFER | The competing-work read is hand-copied **5 times** with visible drift, and the repo's own docblock names this exact pattern as its recurring defect. Deferred reluctantly: a refactor across four call sites of the busiest file, against an S0 queue and R6's freeze. Filed, not forgotten. |
| G-26 | F-2-14, F-3-09, F-8-12 | S2 | DEFER (partial FINISH) | `github-scout.ts` is unwired with 0 callers and 0 tests, and its bare `fetch` carries no deadline. **Wiring it is a feature** → forbidden by R6. The missing deadline is folded into `G-14` as a safety fix; the wiring is deferred. |
| G-27 | F-8-15 | S2 | DEFER | `reconcile` exits 1 on the first GitHub failure, discarding absorptions already folded in for earlier packets. Correct but not resumable; the whole request budget must be re-spent. |
| G-28 | F-1-03, F-16-03 | S2 | DEFER | The evidence page advertises a `shasum -a 256` recomputation against `docs/evidence/logs/`, which does not exist. Resolves as a side effect of `G-17` (the first real witness creates the directory). |
| G-29 | Track A.2 | S2 | DEFER | `sweep2/issue-37` holds **13 unlanded policy-scanner invariants** — per-matcher necessity, near-miss non-firing, a base ratchet, wrap-invariance. Real value, but `policy.ts` was rewritten after the branch was cut so none apply unmodified. Salvage as a fresh issue against current code; do **not** delete the branch until that issue exists. |
| G-30 | F-17-02, F-8-29, F-11-12 | S2 | DEFER | No account/key inventory document. The PAT's 90-day rotation is mentioned once, in a shell-script comment. Scope is enforced only by the wizard at mint time, never at runtime. Partly addressed by `G-11`'s recovery docs; the full inventory is deferred. |
| G-31 | F-6-20, F-15-04 | S2 | DEFER | No retention or deletion policy for the third-party GitHub logins stored in ledger events. Exposure is low — gitignored, local, ring-evicted — but neither the retention nor the eviction is a stated policy. |
| G-32 | F-13-04 | S2 | DEFER | No `--json`/`--format` mode and no `--version`. Machine consumption requires screen-scraping. |
| G-33 | F-4-03 | S2 | DEFER | No coverage instrument. Critical-flow coverage is asserted structurally but never measured. |
| G-34 | A-09 residual | S2 | DEFER | 8 of 19 test files hard-require `$TMPDIR` write permission with no skip path, so one denied syscall reds the whole suite in a constrained sandbox. |
| G-35 | F-2-08 | S2 | DEFER | `tickWithGithub` writes hardcoded `daysOld: 0` and an all-zero scout score on the live path. Inert today (never read; `buildPacket` re-derives) but they are fabricated values in a shipped code path. |
| G-36 | F-1-10 | S2 | DEFER | Stations 4/5 have no enforcement beyond a status bump. The **doc correction** is in `G-15`; building the enforcement is a new capability. |
| G-37 | F-2-02, F-13-01 | S3 | DEFER | `help` is handled but not listed in its own usage text; no-args exits 0. |
| G-38 | F-2-15 | S3 | DEFER | 12 exported-but-file-local symbols widen the mutation surface without a consumer, two of them security-relevant (`WITNESS_SECRET_KEYS`, `witnessLogSha`) with no direct test. |
| G-39 | F-3-04 | S3 | DEFER | `engine.test.ts` is 5718 lines / 151 tests and `cli.ts` is 1422 lines mixing argv parsing, path anchoring, GitHub orchestration and 18 verb bodies. The single largest maintenance liability. |
| G-40 | F-9-02 | S3 | DEFER | Severity prefixes are a convention, not a schema, and the stdout/stderr split is inconsistent (`SEED DRIFT` to stdout, `ADVISORY` to stderr). |

## Counts

| | S0 | S1 | S2 | S3 | total |
|---|---|---|---|---|---|
| FINISH | 2 | 16 | 5 | 0 | **23** |
| CUT | 0 | 0 | 1 | 0 | **1** |
| DEFER | 0 | 0 | 12 | 4 | **16** |
| ACCEPT | 0 | 0 | 0 | 0 | **0** |

**Zero `ACCEPT` at any severity, and zero at S0** — required by `DEFINITION.md` §2.1. The two standing concessions (operator-equivalent ledger access; attested-not-witnessed Wave 1+ evidence) are recorded in `DEFINITION.md` §4 as scope statements with an expiry, not as accepted gaps.

Three FINISH gaps are blocked on Human Actions (`G-16`, `G-17`, `G-18`) and all three gate the launch. The maximum verdict reachable by the agent alone is therefore **CONDITIONAL GO**.
