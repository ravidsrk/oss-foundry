# Completion plan

Dependency-ordered. `TARGET_DATE` unset, so this is ordered by dependency, not calendar — no dates are invented.

**28 tasks · 23 FINISH gaps + 1 CUT · 0 L-sized.** Longest dependency chain: **6** — `T-01 → T-02 → T-05 → T-07 → T-22 → T-28`. Human Actions filed: **3**, of which **2 gate launch** (`H-01`, `H-03`; `H-02` does not).

## Phase entry/exit

| phase | name | exit criteria (evidence-backed) |
|---|---|---|
| **P1** | Green baseline | Type-check gate runs and is green in CI; runtime floor is correct and enforced at runtime, not just declared; cold start passes including `npm ci`; branch list clean |
| **P2** | Safety & kill switches | A `SIGKILL` mid-write leaves a loadable ledger; a backup has been restored to a scratch path; witness children receive an allowlisted env only; every GitHub request carries a pinned API version; no unbounded child process remains |
| **P3** | Critical flows | Code and doctrine agree on the promotion gate; the published ledger's negative control is true; dead surfaces deleted; CF-06 and CF-07 carry happy **and** failure evidence |
| **P4** | Operability | One alert proven to fire; the audit trail has a reader; event truncation is recorded or documented; primary rate limit detected; runbooks exist for corrupt ledger and revoked PAT |
| **P5** | Doc truthfulness | No doc asserts behaviour the code lacks; a complete env-var reference exists; the architecture doc names every module implementing SPEC §5/§6/§7 |
| **P6** | Launch surfaces | Stranger Test passes: clone → first critical flow on README alone, ≤15 min |
| **P7** | Launch rehearsal | Rollback rehearsed; remaining flow evidence captured or explicitly blocked on a named `H-NN`; gate evaluated |

## Tasks

### P1 — Green baseline

| id | task | gaps | size | depends | acceptance evidence |
|---|---|---|---|---|---|
| **T-01** | Raise `engines.node` to `>=22.18.0`; add a runtime `process.versions.node` check that fails with an actionable message (npm does not enforce `engines` — R-03); pin the local runtime in `.mise.toml`; extend CI to a matrix of 22.18.x and 24.x | G-06 | S | — | `evidence/T-01-version-floor.txt`: the CLI's refusal text on a simulated old version, plus both CI legs green |
| **T-02** | Add a type-check gate: `tsconfig.json` with `noEmit`, `allowImportingTsExtensions`, `verbatimModuleSyntax` and `erasableSyntaxOnly`; run it in CI via a **pinned `npx typescript@<version>`** — no `dependencies`, no `devDependencies`, no lockfile (see `A-11`) | G-05 | M | T-01 | `evidence/T-02-typecheck.txt`: `tsc --noEmit` exit 0 over the whole tree, and the CI step green |
| **T-03** | Hygiene batch, three commits on one branch: `timeout-minutes` on `ci.yml`; delete the 15 merged local branches; remove `"private": true` or document why a public MIT repo declares it | G-23 | S | — | `evidence/T-03-hygiene.txt`: `git branch --list` before/after, workflow diff |
| **T-04** | Add `.env*` to `.gitignore`; commit an ignore rule for `.claude/settings.local.json` so a fresh clone on another machine ignores it too | G-20 | S | — | `evidence/T-04-gitignore.txt`: `git check-ignore -v` for both patterns in a fresh clone |

### P2 — Safety & kill switches (the S0 phase)

| id | task | gaps | size | depends | acceptance evidence |
|---|---|---|---|---|---|
| **T-05** | Make the ledger write atomic **and** durable: temp file in the same directory → `writeFileSync(tmp, json, { flush: true })` → `renameSync`. `flush` is required; without it the rename is atomic but the bytes may still be in page cache (R-06) | G-01 | S | T-02 | `evidence/T-05-atomic-write.txt`: unit test + the write path diff |
| **T-06** | **Prove it with a kill.** Spawn a CLI write, `SIGKILL` mid-write in a loop, assert the ledger loads every time. This is launch gate §3 and it must be a test, not an argument | G-01 | M | T-05 | `evidence/T-06-sigkill-loop.txt`: N iterations, 0 unloadable ledgers |
| **T-07** | Ledger backup + a documented restore procedure, then **restore it once** to a scratch path | G-01 | M | T-05 | `evidence/T-07-restore.txt`: the transcript of an actual backup→corrupt→restore→`status` cycle |
| **T-08** | Invert `witnessChildEnv` from a 4-name denylist to an **allowlist** (`PATH`, `HOME`, and the minimum the toolchain needs). Add a test asserting a planted `NPM_TOKEN`/`AWS_SECRET_ACCESS_KEY` does **not** reach the child | G-02 | M | — | `evidence/T-08-env-allowlist.txt`: the child's observed env, with the planted secrets absent |
| **T-09** | Pin `X-GitHub-Api-Version: 2022-11-28` in `githubApiHeaders`, and add a test asserting **every** request carries it — mirroring the existing "every GitHub fetch must carry a deadline" test that already works | G-04 | S | — | `evidence/T-09-api-version.txt`: the header on all 11 call sites, test green |
| **T-10** | Add a `timeout` to `witness.ts`'s `execFile` so a hung clone/registry/upstream suite cannot block `evidence` forever; add the missing deadline to `github-scout.ts`'s bare `fetch` (safety only — **do not wire the module**, R6) | G-14, G-26 | S | — | `evidence/T-10-child-timeout.txt`: a deliberately-hung child terminating at the deadline |
| **T-11** | Validate the packet `id` format at the `isPacket` boundary so a hand-edited ledger cannot drive an arbitrary filesystem write through `witnessLogPaths` | G-19 | S | T-05 | `evidence/T-11-id-validation.txt`: `pkt_../../../../tmp/x` refused at load |

### P3 — Critical flows

| id | task | gaps | size | depends | acceptance evidence |
|---|---|---|---|---|---|
| **T-12** | Resolve the promotion-gate disagreement: `foundryAttestedWave0Merges` counts a merge `docs/PRODUCT.md` §8 excludes. Make code and doctrine agree — either exclude it in code or drop the prose exclusion — and pin the chosen answer with a test | G-12 | M | — | `evidence/T-12-promotion-gate.txt`: `status` output + the test asserting the gate arithmetic |
| **T-13** | Correct the published ledger's false negative control. The live roster guard is already complete (`load-allowlist.ts:85-93` throws on an unmarked noop oracle); only the committed seed is wrong — `factory/seed.ts:146-148` claims `red-on-revert` over `testCommand: "true"`, and that command also contradicts `allowlist.yaml:42`. Fix the record, regenerate `docs/12-ledger.md` | G-13 | S | — | `evidence/T-13-negative-control.txt`: seed diff + regenerated ledger block byte-matching `foundry ledger` |
| **T-14** | Give transport failures context: `fetch failed` becomes a message naming the repo and the operation, on every call site | G-21 | S | T-09 | `evidence/T-14-transport-error.txt`: the error text with the network down |
| **T-15** | **CUT** the seven dead runtime exports, including the four UI-layer leftovers for a console the architecture doc says does not exist here | G-24 | S | T-02 | `evidence/T-15-cut-dead-exports.txt`: deletions + suite green |
| **T-16** | Capture CF-06 evidence: happy (`reconcile` absorbs a terminal outcome, scorecard row written) and failure (a GitHub read failure leaves the ledger uncorrupted) | gate §2 | M | T-05 | `evidence/CF-06-happy-*.txt`, `evidence/CF-06-failure-*.txt` |
| **T-17** | Capture CF-07 evidence: happy (`halt` → `health=stop`; `clear-halt` lifts the factory halt) and failure (the documented asymmetry — `clear-halt` does **not** lift a per-repo `stop`) | gate §2 | S | T-05 | `evidence/CF-07-happy-*.txt`, `evidence/CF-07-failure-*.txt` |

### P4 — Operability

| id | task | gaps | size | depends | acceptance evidence |
|---|---|---|---|---|---|
| **T-18** | Add an alerting mechanism that lives **in the repo**: an `if: failure()` step on the 6-hour clock that files (or reopens) an issue. Personal GitHub notification settings do not count — the gate requires a mechanism a stranger could inherit | G-07 | M | — | `evidence/T-18-alert-fires.txt`: a deliberately-failed run and the issue it created |
| **T-19** | Give the audit trail a reader: surface recent `events` through a command, and print `reverts` and `reviewCommentsAvg` — `reverts > 0` forces `health=stop` and is currently printed by nothing | G-08 | M | — | `evidence/T-19-audit-reader.txt`: a stuck-factory state explained by one command |
| **T-20** | Stop the event ring truncating silently: record a dropped-event count (or an overflow marker) and document the 80-entry cap in `docs/10-schemas.md` | G-09 | S | T-05 | `evidence/T-20-ring-truncation.txt`: the 81st event, with the loss visible |
| **T-21** | Detect the **primary** rate limit: read `x-ratelimit-*`, distinguish quota exhaustion from other 403s, warn when reads are unauthenticated (60/hr vs 5,000/hr — R-05), and document both ceilings against the measured 19-per-tick spend | G-10 | M | T-09 | `evidence/T-21-rate-limit.txt`: the message on a simulated exhausted quota |
| **T-22** | Write the two missing runbooks — corrupt/unloadable ledger, and revoked/expired PAT — and verify each by **following it** | G-11 | M | T-07 | `evidence/T-22-runbooks.txt`: the transcript of following both, start to green |

### P5 — Doc truthfulness

| id | task | gaps | size | depends | acceptance evidence |
|---|---|---|---|---|---|
| **T-23** | Remove every false claim: the "never as a personal PAT" headline (`docs/07-github-app.md:3`), the three secrets no code reads, the E2B lifecycle that does not exist and its clone-depth disagreement, and the stations 4/5 description that implies gates where there is a status bump | G-15 | M | — | `evidence/T-23-doc-truth.txt`: each corrected claim beside the code that decides it |
| **T-24** | Complete the reference material: `docs/01-architecture.md` to name every module implementing SPEC §5/§6/§7; a full env-var reference (including `FOUNDRY_GITHUB_TIMEOUT_MS`, read by shipping code and documented nowhere); the three missing packet fields in the schema doc | G-22 | M | T-23 | `evidence/T-24-reference.txt`: a grep of `process.env` reconciled against the new reference, zero unlisted |

### P6 — Launch surfaces

| id | task | gaps | size | depends | acceptance evidence |
|---|---|---|---|---|---|
| **T-25** | Fix the README's nine stranger-path failures: clone step and URL, the Node floor beside the first command, an install statement that says what to run and why `npm ci` behaves as it does, the `npm run` entry points, a command list, what `.foundry-state.json` is, the env vars, links to the operator loop and station model, and what actually happens on a first `tick` | G-03 | M | T-01, T-24 | `evidence/T-25-readme.txt`: the diff plus the Stranger Test run in T-26 |

### P7 — Launch rehearsal

| id | task | gaps | size | depends | acceptance evidence |
|---|---|---|---|---|---|
| **T-26** | Stranger Test: fresh clone into a scratch dir, README alone, timed to the first critical flow. Every point needing knowledge not in the docs becomes a docs fix closed in this phase | gate §7 | M | T-25 | `evidence/T-26-stranger-test.txt`: timing + every gap found and closed |
| **T-27** | Rehearse rollback: revert a merge on `main`, confirm CI returns green, restore | gate §5 | S | — | `evidence/T-27-rollback.txt`: the revert PR, CI run, and restoration |
| **T-28** | Evaluate the launch gate mechanically against `DEFINITION.md` §2; write the final report; hand off to a fresh adversarial reviewer in a separate context (R Phase 7.2 — I do not review my own work) | gate | S | all | `STATUS.md` final report + the reviewer's findings re-entered as `G-NN` |

## Blocked on Human Actions

Three flows cannot be evidenced by the agent. Each is a real external dependency, not a scoping dodge.

| flow | blocked by | what unblocks it |
|---|---|---|
| **CF-01** happy path | `H-03` | a named `firstIssues` row on the roster — choosing the next target is a maintainer product decision |
| **CF-02** happy path | `H-03` | needs a `gated` packet, which needs a successful `tick` |
| **CF-03** happy path | `H-03` | **not blocked on E2B.** Wave 0 host witnessing is implemented and `ravidsrk/orca-fleet` and `ravidsrk/frontguard` are both `wave: 0, sandbox: host` with real test commands. It needs a packet to witness, which needs a roster row. |
| **CF-04** happy path | `H-01` | the machine account and its `public_repo` PAT — the wizard explicitly forbids an agent creating it |
| **CF-05** happy path | `H-01` | a live PR to bind |

**Consequence: the maximum verdict reachable by the agent alone is CONDITIONAL GO.** That is a property of the product's boundary, not of the plan.

## Task counts

| phase | tasks | S | M |
|---|---|---|---|
| P1 | 4 | 3 | 1 |
| P2 | 7 | 4 | 3 |
| P3 | 6 | 4 | 2 |
| P4 | 5 | 1 | 4 |
| P5 | 2 | 0 | 2 |
| P6 | 1 | 0 | 1 |
| P7 | 3 | 2 | 1 |
| **total** | **28** | **14** | **14** |

Zero L-sized tasks. Severity coverage: both S0 gaps land in P2; all 16 S1 gaps are mapped; the 5 FINISH S2 gaps are mapped; `G-24` is the single CUT.

## Fit check

`TARGET_DATE` is unset, so there is nothing to fit against and nothing is cut for schedule. Reported rather than acted on: if a date were imposed, the compressible set is P4 and P5 (operability and doc truthfulness, 7 tasks); P1–P3 and P7 are not compressible without failing the gate.
