# Foundry — completion status

<!-- Rewritten at the top of every phase. Verdict first. -->

```
VERDICT: PHASE 4 COMPLETE — plan frozen, execution ready
COMPLETION: 68% (baseline 74af0b2)   GATE: not evaluated — evaluation is T-28, after the work
CRITICAL FLOWS: 7 total · 1 verified · 2 works · 4 partial · 0 cut
GAPS: 40 decided — S0 2 · S1 16 · S2 17 · S3 4 · FINISH 23 · CUT 1 · DEFER 16 · ACCEPT 0
TASKS: 0/28 · BLOCKED 0 · HUMAN ACTIONS gating launch: 2 (H-01, H-03)
NEXT: T-01 — raise the Node floor and enforce it at runtime (npm does not enforce `engines`)
```

---

## Phase 0 — baseline freeze

| | |
|---|---|
| Product | **Foundry** — an operator-gated OSS contribution factory: a control plane that decides *whether* a contribution packet may exist against an allowlisted upstream repo. It never builds and never merges. |
| Repo | `ravidsrk/oss-foundry` — public, MIT, created **2026-08-26** (6 days old) |
| Baseline commit | `74af0b27f17ac39cda9779cbc6c73e7ed265e7df` (`74af0b2`) |
| Branch / tree | `main`, clean (0 dirty files), 0 stashes, `HEAD == origin/main` |
| Lifetime volume | 65 issues closed · 52 PRs merged · 232 commits |
| Open work | **0 open PRs** · **2 open issues** (#15 watchlist, #121 block-close gap) |
| `MODE` | `drive` |
| `DOMAIN_HINTS` | inferred: **oss-contribution-tooling / developer-tool**. Not fintech, not consumer, no payments, no end-user PII. |

### Toolchain (recorded per R1)

| Tool | Version |
|---|---|
| git | 2.55.0 |
| node | v24.20.0 (**CI pins 22**) |
| npm | 11.19.0 |
| gh | 2.98.0 |
| greptile | 3.4.2 |
| jq | jaq 2.3.0 |

Also present: `mise`, `uv`, `pnpm`, `just`, `cargo`, `docker`.

### Inventory

`factory/` 49 files / 22,840 lines · `docs/` 21 files / 2,033 lines · `scripts/` 2 files / 845 lines · `.github/` 3 files. 30 non-test modules, 19 test files, 9,639 non-test TypeScript lines.

Zero declared dependencies. No lockfile. No build step. No bundler. Runtime is `node --experimental-strip-types`.

### Cold start — **PASS**

Evidence: `evidence/p0-coldstart-1-clone-install.txt`, `evidence/p0-coldstart-2-build-test-run.txt`

| Step | Result |
|---|---|
| `git clone` into empty scratch dir | exit 0, HEAD `74af0b2` |
| `npm ci` | **exit 1** — no lockfile exists |
| `npm install` | exit 0 (`up to date in 86ms`; nothing to install) |
| `npm test` | exit 0 — **379 tests / 19 files, pass 379, fail 0**, 7.8s |
| `npm run validate` | exit 0 — `version 2 repos=8 denylist=4`, `policy records ok: 8 records` |
| `npm run foundry -- --help` | exit 0 — prints all 18 verbs + the verbatim disclosure block |

A stranger who runs `npm ci` — the canonical install-from-lockfile step, and the reflex — gets a hard failure with no explanation in the README. The workflow file explains it; the front door does not.

---

## Phase 1 — 360° audit

### Scores

| # | Angle | W | Score | RAG |
|---|---|---|---|---|
| 1 | Product definition & critical flows | 8 | 3/4 | 🟢 |
| 2 | Functional completeness | 14 | 3/4 | 🟢 |
| 3 | Code quality & architecture | 4 | 2/4 | 🟡 |
| 4 | Testing | 8 | 3/4 | 🟢 |
| 5 | Security | 14 | 3/4 | 🟢 |
| 6 | Data | 8 | 2/4 | 🟡 |
| 7 | Infrastructure & deployment | 6 | 2/4 | 🟡 |
| 8 | Reliability & operability | 5 | 3/4 | 🟢 |
| 9 | Observability | 4 | 2/4 | 🟡 |
| 10 | Performance & cost | 5 | 2/4 | 🟡 |
| 11 | Third-party integrations | 5 | 2/4 | 🟡 |
| 12 | AI / LLM layer | 5 | **N/A** | — |
| 13 | UX & frontend (CLI) | 5 | 3/4 | 🟢 |
| 14 | Documentation | 3 | 3/4 | 🟢 |
| 15 | Legal & compliance | 5 | 3/4 | 🟢 |
| 16 | Business / GTM readiness | 4 | 2/4 | 🟡 |
| 17 | Ownership & operations | 2 | 1/4 | 🔴 |

**Angle 12 is N/A with a checkable reason:** `git grep` for `openai|anthropic|claude|gpt-|@ai-sdk|langchain|ollama|bedrock|generativelanguage` across non-test source returns four hits, all of which are **detector regexes** in `factory/policy.ts:12,33,35` and `factory/neighbor.ts:64` that classify AI-related wording in *fetched upstream policy documents*. There is no model client, no prompt directory, no eval set, and no model output is ever shipped. Weight 5 redistributed across the remaining 16 angles (factor 1.05).

**`completion_pct` = Σ (effective weight × score / 4) = 68.2% → 68%.**

---

### Critical flows

Derived from the seven-station model in `docs/04-stations.md` and the 18-verb surface in `factory/cli.ts`, not from aspiration.

| id | flow | entry | irreversible | state |
|---|---|---|---|---|
| **CF-01** | Select the next packet (scout → policy gate) | `foundry tick` | no | **partial** — cannot complete today |
| **CF-02** | Human freeze / attest | `foundry approve <id> --note --by` | no | **works** |
| **CF-03** | Produce witnessed evidence → `draft-ready` | `foundry evidence` / `attach-witness` | no (executes upstream tests on host) | **partial** — zero real artifacts |
| **CF-04** | **Open the draft PR upstream** | `foundry open-draft <id> --head` | **YES — the boundary crossing** | **partial** — never fired |
| **CF-05** | Bind an out-of-band PR | `foundry attach-draft <id> <url>` | binds a live PR | **works** |
| **CF-06** | Follow up, release slot, score the repo | `foundry sync` / `reconcile` | no | **verified** |
| **CF-07** | Stop the factory | `halt` / `revert` / `clear-halt` | no | **partial** — never fired |

**CF-04 is the only write into a repository the operator does not own.** `createDraftPull` (`factory/github-pr.ts:726-747`) is the single `POST /pulls` in the tree; `draft: true` is hard-coded with no override; there is no merge path and no `--admin` anywhere. No money is involved in any flow.

Three flows are **doctrine-only** by the repo's own standard (`AGENTS.md:27` — "A station without SHA-bound evidence is doctrine-only"):

- **CF-01** deterministically returns `idle`. All three named `firstIssues` rows (`allowlist.yaml:33,48,63`) already have packets; every other roster entry is `firstIssues: []`. `docs/12-ledger.md:313` concedes it.
- **CF-03** has produced no machine witness ever. All four evidence manifests in `factory/seed.ts` are operator-attested `red-on-revert`; `docs/evidence/logs/` does not exist.
- **CF-04** has never opened a PR. The one external PR (#1652) was a human browser session (`docs/07-github-app.md:34`).

---

### Findings by angle

Full per-finding detail with `file:line` citations is in the scout transcripts (`history://AngleFunctional`, `history://AngleSecData`, `history://AngleOps`, `history://AngleProductDocs`). The findings that will drive Phase 3 are listed here.

#### 1 — Product & critical flows (3/4)

- **F-1-01** `tick` returns `idle` on the committed roster — the primary intake flow is unrunnable end to end without a human first editing `allowlist.yaml`. `allowlist.yaml:33,48,63,77,91,102,113,124` + `factory/engine.ts:381-403`
- **F-1-02** No packet carries a machine `witness` block; the SPEC §5 MUST has produced zero artifacts. `factory/seed.ts:70-79,142-151,204-213,291-306`
- **F-1-04** `open-draft` has never opened a PR — the single irreversible flow, and the reason the whole gate chain exists, is unproven. `docs/PRODUCT.md:305`
- **F-1-05** The published frontguard packet asserts `negativeControl: "red-on-revert"` over `testCommand: "true"`. A noop command cannot go red on revert — this contradicts the repo's own issue-#112 doctrine. **The published ledger carries a negative control that controls for nothing.** `factory/seed.ts:146-148`
- **F-1-06** That same packet records `testCommand: "true"` while `allowlist.yaml:42` declares `npm test` for the repo. Published oracle ≠ roster oracle.
- **F-1-07** A transport failure surfaces as the bare string `fetch failed`, exit 1 — no repo, no operation, no remedy. `factory/github-pr.ts:117`
- **F-1-09** **Promotion-gate arithmetic diverges from doctrine.** `docs/PRODUCT.md` §8 says frontguard#196 "does not count as a promotion-gate merge", but `foundryAttestedWave0Merges` (`factory/status.ts:39-44`) filters on `wave===0 && merged && humanAttest` with no exclusion, and prints `attestedWave0=3` against a gate of `< 2` (`factory/engine.ts:66`). The doctrinal exclusion is prose only. **A Wave-1 promotion could pass on a merge the doctrine excludes.**
- **F-1-10** Stations 4 (Implement) and 5 (Review) have no enforcement beyond a status bump. `factory/engine.ts:782-802`
- **F-1-11** `docs/06-v2.md` describes an E2B lifecycle with a *shallow* clone; `factory/sandbox.ts:27` plans a *full* clone and executes nothing.

#### 2 — Functional completeness (3/4)

- **F-2-01** All 18 `--help` verbs map 1:1 to 18 dispatch branches. No help/code divergence.
- **F-2-03** **Zero** `TODO`/`FIXME`/`HACK`/`XXX`/`@ts-ignore`/`@ts-expect-error` in the entire repo. Unusually clean.
- **F-2-06** E2B/Daytona execution refuses explicitly in both directions rather than faking a green harvest. `factory/witness.ts:399-418`
- **F-2-08** `tickWithGithub` writes hardcoded `daysOld: 0` and an all-zero scout score for every discovered issue. Inert (`applyTick` never reads them, `buildPacket` re-derives), but they are fabricated values on a live path. `factory/cli.ts:421-422`
- **F-2-09/10** No hardcoded credential and no absolute filesystem path in any non-test source file.
- **F-2-12** Off-by-default posture verified: with a fresh checkout and no env, `tick`/`status`/`ledger` work read-only and `open-draft`/`evidence` both refuse. **Nothing can auto-open a PR.**
- **F-2-13** Seven dead runtime exports — zero callers, zero tests, zero mentions: `statusTone`, `policyTone`, `formatWhen`, `needsFollowUp` (`factory/status.ts:4,13,21,33`), `waveLabel` (`factory/allowlist.ts:65`), `policyLabel` (`factory/policy.ts:717`), `scoutGithub` (`factory/github-scout.ts:30`). Six are UI-layer leftovers contradicting `docs/01-architecture.md:33` ("There is no TanStack console in this repository").
- **F-2-14** `github-scout.ts` — the entire live-discovery half of station 1 — has zero callers and zero tests. Documented as unwired.

#### 3 — Code quality & architecture (2/4)

- **F-3-01** **Only 1 of 4 quality gates exists.** No formatter, no linter, **no type-checker** — no `tsconfig.json`, no `typescript` dependency, no `tsc`/`typecheck` script. `--experimental-strip-types` *erases* types without checking them, so 9,639 lines of TypeScript are enforced by nothing but review. The two `eslint-disable` comments suppress nothing.
- **F-3-03** CI runs exactly two steps (`npm test`, `npm run validate`). The merge gate cannot catch a type error.
- **F-3-06** **`engines.node: ">=22"` is below the floor the code requires.** `--experimental-strip-types` was added in **v22.6.0**. On Node 22.0–22.5 every documented command fails immediately, while `engines` says the environment is supported. No `.nvmrc`, no `.mise.toml`.
- **F-3-07** The non-test import graph is **provably acyclic** (DFS, 29 modules, zero cycles). A genuine strength.
- **F-3-08** **The competing-work read is hand-copied 5 times** — `cli.ts:351,550,1002,1339` re-implement what `competition-read.ts:9-38` exists to centralise, and whose own docblock names this exact pattern as the project's recurring defect. **Drift is already visible:** `readCompetition` excludes the packet's own PR (issue #111) and `attach-draft` replicates that by hand; the other three copies omit it.
- **F-3-09** Two GitHub REST clients with divergent invariants: every fetch in `github-pr.ts` carries a deadline (asserted by its own test); `github-scout.ts:39` uses a bare `fetch` with none.
- **F-3-11** `docs/01-architecture.md` names 8 modules; `factory/` has 29 non-test modules. The 17 omitted include `witness.ts`, `terminal.ts`, `state.ts` — every module implementing SPEC §5/§6/§7.

#### 4 — Testing (3/4) — *audited directly*

Evidence: `evidence/p1-a4-suite-twice.txt`, `evidence/p1-a4-coverage-map.txt`, `evidence/p1-a4-indirect-coverage.txt`

- **F-4-01** Suite run twice: **379/379 both times**, 8.08s and 8.05s. **Zero flakes.**
- **F-4-02** 19 test files against 27 non-test modules. Eleven modules lack a sibling test, but only **three have zero test imports of any kind**: `scout.ts` (transitively exercised via `packet.ts`), `validate-allowlist.ts` and `verify-ledger.ts` — the latter two are themselves CI entry points, exercised by CI rather than by the suite.
- **F-4-03** No coverage instrument exists. Critical-flow coverage is asserted structurally (every one of the 18 verbs is driven through a spawned CLI process) but never measured.
- **F-4-04** The suite has a real oracle: `run-tests.ts` refuses a run in which any file reported zero subtests, so a silently-skipped file reds the suite.
- **F-4-05** No test exercises a real GitHub call — `fetchImpl` is injected everywhere. Correct for a unit suite; it means CF-04 has 20 test references and zero live proof.

#### 5 — Security (3/4)

- **F-5-06/07** **Git history secret scan over all 232 commits: CLEAN.** Every hit is a test fixture (`ghp_should_never_leak`) or a doc reference to a token *prefix*.
- **F-5-10** **`witnessChildEnv` is an allow-by-default denylist of exactly 4 names** (`factory/witness.ts:67-72,81-92`). Every other variable in the operator's shell — `NPM_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `ANTHROPIC_API_KEY`, `OP_SERVICE_ACCOUNT_TOKEN` — is passed verbatim into a third-party repo's `setupCommand`/`testCommand`. An `npm ci` on an allowlisted repo runs its `preinstall`/`postinstall` scripts with the operator's whole non-Foundry environment. **This is the largest residual security risk and it is not stated in `docs/08-operations.md:49`, which describes only the four.**
- **F-5-08** `.gitignore` is 3 lines and has no `.env*` pattern. `.claude/settings.local.json` is ignored only by the developer's *personal global* gitignore — a fresh clone on another machine would not ignore it.
- **F-5-12** Any non-empty fetched document satisfies "parse-policy-first" for an `aiPolicy: unknown` repo. A one-byte `CONTRIBUTING.md` saying nothing about AI flips `DENY_UNKNOWN_POLICY` → `ALLOW` for three roster entries. Intentional per `docs/SPEC.md:29` and loudly disclosed at the freeze surface, but the machine verdict alone is `ALLOW`.
- **F-5-14** Terminal injection is closed at the **stream**, not per-sink: `installTerminalBoundary` strips ANSI/OSC/DCS/APC in both 7- and 8-bit forms and discloses the byte count removed. Its test *discovers* entry points from `package.json` + workflows and spawns each with a hostile probe, so a new entry point reds the suite until it installs the boundary. Genuinely strong.
- **F-5-22** **Packet `id` has no format validation and is interpolated into a filesystem write path.** `isPacket` checks only `typeof o.id === "string"` (`factory/state.ts:248`); `witnessLogPaths` builds `${WITNESS_LOG_ROOT}/${packetId}/test.log` and `persistWitnessLogs` resolves and writes it. A packet id of `pkt_../../../../tmp/x` yields an arbitrary write. The path-pinning guard cannot catch it because the expected path derives from the same poisoned id. Precondition is ledger write access (conceded operator-equivalent), so this is missing defence-in-depth rather than a live exploit.
- **F-5-30/31/33** The denylist is deny-first at every gate, has a **hardcoded floor** that `allowlist.yaml` cannot remove (deleting a row makes the module fail to import), and folds ASCII-only deliberately so a Unicode homoglyph cannot resolve onto a roster entry. No engine path reaches `ALLOW` for a denylisted repo.

#### 6 — Data (2/4)

- **F-6-13** **The ledger is written in-place and non-atomically: one bare `writeFileSync` (`factory/state.ts:455`).** A crash, `SIGINT`, or ENOSPC mid-write leaves truncated JSON. The loader then refuses it — which means **every CLI verb dies, including `status`** — and per F-6-10/11 there is no backup and no documented recovery. **The single most material data finding.**
- **F-6-10/11** **No backup mechanism and no restore procedure exist.** Verified by absence: zero hits for `renameSync|fsync|atomic` and no operational hit for `backup|restore|recover`.
- **F-6-22** **The ledger is not append-only.** `events` is a bounded ring — `[event, ...state.events].slice(0, 80)` in **14 distinct places**. The 81st event silently destroys the oldest, with no overflow log, no counter and no marker.
- **F-6-23** **The 80-event cap is documented nowhere.** `docs/10-schemas.md:83` lists `events` as a plain field with no bound — while `docs/12-ledger.md` positions the ledger as the audit surface.
- **F-6-21** The prompt's premise that the docs *claim* append-only is **false at this commit** — no such claim exists. Reported as a fact rather than assumed.
- **F-6-05/06/08/09** Fail-closed loading is excellent: an explicit `version: 6` checked twice, a non-v6 file refused rather than upgraded or overwritten, malformed JSON refused with the parser's message and an explicit non-overwrite promise, and a ledger violating the one-in-flight invariant refused outright.
- **F-6-03** Three real `TaskPacket` fields (`createdAt`, `updatedAt`, `parkReason`) are absent from the documented schema block. A reader building a ledger from the doc produces a file the loader refuses.
- **F-6-17/20** The login of whoever closed an issue is stored in a ledger event. No retention policy, no deletion path, no privacy statement anywhere in the repo. Exposure is low (gitignored, local, evicted by the 80-event ring as a side effect) but neither the retention nor the eviction is a stated policy.

#### 7 — Infrastructure & deployment (2/4) — *audited directly*

Evidence: `evidence/p1-a7-infra.txt`

- **F-7-01** **There is no deployment target.** The product runs on the operator's own host plus a 6-hour GitHub Action. No IaC, no container, no staging environment — correctly, because there is nothing to provision. Angle scored against *reproducible execution*, not against deploys.
- **F-7-02** **Version skew between CI and the operator.** CI pins `node-version: "22"` (`ci.yml:53`, `oss-tick.yml:29`); the operator host runs v24.20.0. Nothing pins the local version — no `.nvmrc`, no `.mise.toml` — and `engines: ">=22"` is below the real 22.6.0 floor (F-3-06). Reproducibility rests entirely on an under-specified runtime.
- **F-7-03** CI hygiene is good: actions SHA-pinned with version comments, `permissions: contents: read`, a `concurrency` group that never cancels a push run, and the workflow configuration itself under test (`factory/ci.test.ts`, 6 tests).
- **F-7-04** `ci.yml` has **no `timeout-minutes`**; only `oss-tick.yml` bounds itself (20 min against a 6-hour cron).
- **F-7-05** Rollback is `git revert` of a merge commit; rehearsed in anger during the 2026-08-29 sweep, but not written down as a procedure.

#### 8 — Reliability & operability (3/4)

- **F-8-11** All 11 HTTP call sites route through one `githubRequestInit` seam carrying `AbortSignal.timeout` (15s default, range-clamped override). Both list reads are page-capped at 10 and return a `truncated` flag, so **a short read is never mistaken for a clean one**.
- **F-8-13** **`witness.ts:125` runs `git clone`, `npm ci` and the upstream `testCommand` through `execFile` with no `timeout` option.** A hung clone, a hung registry, or an upstream suite that never exits blocks `evidence` forever with no deadline anywhere in the process.
- **F-8-12** `github-scout.ts:39` bypasses the deadline entirely — latent only because the module is unwired.
- **F-8-15** `reconcile` exits 1 mid-loop on the first GitHub failure, discarding every absorption already folded in for earlier packets. No resumability; the whole request budget must be re-spent.
- **F-8-17** `open-draft` can leave a live PR the ledger has never heard of (POST succeeds, follow-up sync fails). The recovery instruction exists **in the CLI string** and not in `docs/08-operations.md`.
- **F-8-18** Primary rate limit and expired credentials are indistinguishable from any other error. Zero implementation of `Retry-After`/`x-ratelimit-*` inspection anywhere.
- **F-8-19** Reads are unauthenticated when no token is set — no warning, no refusal. GitHub's anonymous ceiling is 60/hr against a documented tick cost of 19 requests, so the fourth tick of an hour fails with an unexplained 403. Nothing says the token is required.
- **F-8-23/24** The per-repo `stop` (banned tone, or `reverts > 0`) has **no clearing verb** and no decrement — a one-way door escapable only by hand-editing a gitignored JSON file the loader will refuse if the edit is malformed. Documented as deliberate.
- **F-8-26** **A ledger that fails to load disables every command including `status`** — the operator's only diagnostic surface is unavailable exactly when the ledger is broken.
- **F-8-28/29** **Verdict on the three recovery scenarios: corrupt ledger — NO. Revoked PAT — NO. Maintainer-requested stop — YES**, unusually well (exact verb, exact ordering, denylist edit, 14-day cooldown, a 5-step slop-accusation drill).

#### 9 — Observability (2/4)

- **F-9-04** The terminal boundary is the standout: one sanitisation point installed on the process's own streams, idempotent, back-pressure-preserving, disclosing the byte count removed, and honest in its docblock about the two paths it does not cover.
- **F-9-06** Every state-mutating `apply*` emits an event — coverage is complete across the critical flows.
- **F-9-07** **The events array is written and never read.** No CLI verb prints it; `status` and `ledger` print packets and scorecard rows only. **The audit trail exists solely as JSON inside a gitignored file the operator must open by hand.**
- **F-9-10/11** `reverts` and `reviewCommentsAvg` are computed, stored, and printed by **no command** — while `reverts > 0` forces `health=stop`. An operator sees a repository frozen with no surfaced reason.
- **F-9-13** **There is no alerting of any kind.** No `if: failure()` step in either workflow, no webhook, no issue-on-failure. Nothing notifies a human when the 6-hour clock fails, when a halt trips, or when a packet is stuck.
- **F-9-15** A tripped factory halt is announced on stderr of the *next* command the operator happens to run. The clock reads the committed seed and never reads the live ledger, so it cannot see the halt at all.
- **F-9-18** `status` cannot explain a stuck factory: it omits the halt, every event, `reverts`, the policy verdict of a gated packet, and the reason a repo is `health=stop`.

#### 10 — Performance & cost (2/4) — *audited directly*

Evidence: `evidence/p1-a10-a12-a13.txt`

- **F-10-01** Suite is 8.05s — fast enough that no one is tempted to skip it.
- **F-10-02** Per-operation request spend is measured and documented (`docs/04-stations.md:15-16`: "a full tick went 15 requests → 19"; `docs/12-ledger.md:167-170`). Page caps bound the worst case at 1000 items.
- **F-10-03** **No aggregate budget and no ceiling numbers.** GitHub's 5000/hr authenticated and 60/hr unauthenticated limits appear nowhere, so headroom cannot be computed against the measured spend.
- **F-10-04** Cloud cost today is **zero** — no E2B client exists. GitHub Actions minutes are unbudgeted and `ci.yml` is unbounded. E2B cost is acknowledged as "small" in ADR 0003 with no counter and no cap.

#### 11 — Third-party integrations (2/4)

- **F-11-01/02** GitHub REST is the only wired provider, and it is handled carefully: one credential for the one write, constructed inline so the read token can never be used for a write; `draft: true` hard-coded; the response checked to actually *be* a draft; secondary limit → durable halt.
- **F-11-14** **The GitHub App is documented as the primary auth model and does not exist in code.** `docs/07-github-app.md:3` asserts "The factory authenticates as a GitHub App, never as a personal PAT" while `FOUNDRY_APP_ID`/`FOUNDRY_APP_PRIVATE_KEY`/`FOUNDRY_INSTALLATION_ID` have **zero** references in `factory/`. An operator following that doc provisions three secrets that do nothing.
- **F-11-15** **E2B is 0% implemented** — no SDK, no client, no worker host. The entire surface is a presence check on `E2B_API_KEY` that changes which refusal is printed. Every Wave 1+ packet depends on a runner that is not merely unconfigured but **unwritten and unlocated**.
- **F-11-12** The required `public_repo` scope is enforced **only by the setup wizard at mint time**, never by the factory at runtime. An over-scoped or later-broadened token is accepted silently.
- **F-11-19** `attach-witness` cannot distinguish a witness produced on a worker host from one an operator wrote by hand — stated plainly in `docs/10-schemas.md:69`. Wave 1+ evidence is operator-attested-by-file with consistency checks, not machine-witnessed.
- **F-11-26/27/28** Three candidate Human Actions: the machine account + PAT (90-day rotation, no reminder, no runbook), an E2B account + worker host + the runner itself, and the `foundry-bot` App and its installations.

#### 13 — UX / CLI (3/4) — *audited directly*

Evidence: `evidence/p1-a13-exit-codes.txt`

- **F-13-01** Exit codes are correct: `bogus-command` → 1, `advance`/`halt` without an id → 1, `--help`/`ledger` → 0.
- **F-13-02** Help lists all 18 verbs and matches dispatch 1:1. Error messages name the remedy (`draft opened but sync failed — run: attach-draft <id> <url>`).
- **F-13-03** The absent-state message is exemplary: `no state file at … — showing the committed seed ledger, not live state. Mutating commands will create it.`
- **F-13-04** No `--json`/`--format` mode and no `--version`. Machine consumption requires screen-scraping (F-9-01).
- **F-13-05** A stranger cannot diagnose a stuck factory from the CLI alone (F-9-18) and a transport error reads as a bare `fetch failed` (F-1-07).

#### 14 — Documentation (3/4)

- **F-14-01/02** The `docs/12-ledger.md` GENERATED block is **byte-identical** to `foundry ledger` stdout (1650 chars each), and `docs/evidence/pkt_ravidsrk_orca-fleet_71.md` is byte-identical to `foundry evidence-page` output (1340 chars each). Machine-derived, provably current — the strongest documentation-currency signal in the repo.
- **F-14-04** **The README fails the stranger path at 9 enumerated points.** `npm`, `git clone`, `install`, `status` and `approve` appear **zero times** in it. No setup section, no clone URL, no command list; `Node 22+` appears only under `## Tests`, 19 lines below the operator-loop line. The reflexive `npm ci` fails and nothing warns about it. Recovery depends on the stranger noticing that the bare CLI prints usage — recovery by accident, not by document.
- **F-14-05** **No environment-variable reference exists.** `FOUNDRY_GITHUB_TIMEOUT_MS` is read by shipping code and documented in zero markdown files.
- **F-14-07** **`docs/07-github-app.md:3` makes a false security claim** — "authenticates as a GitHub App, never as a personal PAT" — contradicted by its own file 30 lines below and by the code. A skimming reader gets the wrong security model.
- **F-14-10** `docs/01-architecture.md` is stale: 8 of 29 modules, omitting every module implementing SPEC §5/§6/§7.
- **F-14-12** Countervailing strength worth recording: the docs carry an unusually honest self-correction culture — five dated "Corrections" sections in `docs/12-ledger.md` naming what was wrong and why. Where these docs fail they fail by staleness, not concealment.

#### 15 — Legal & compliance (3/4) — *audited directly*

Evidence: `evidence/p1-a15-a16-a17.txt`

- **F-15-01** MIT licensed, public. No end users, no accounts, no service, no PII collection — so ToS/privacy/cookie/DPA obligations do not attach. N/A with reason.
- **F-15-02** The product's *domain* is contribution legality, and that surface is the strongest part of the codebase: CLA/DCO detection against a 349-row adversarial corpus, disclosure enforced byte-for-byte on both bind paths, denylist absolute with a hardcoded floor, draft-only with no merge path.
- **F-15-03** `package.json` says `"private": true` while the repo is public and MIT. Harmless (an npm-publish guard) but inconsistent with the shipped posture.
- **F-15-04** No retention or deletion policy for the third-party GitHub logins stored in ledger events (F-6-17/20). Low exposure — gitignored, local, ring-evicted — but unstated.
- **F-15-05** Upstream-policy obligations are enforced live rather than assumed: the gate refuses `DENY_UNKNOWN_POLICY` when no policy document can be parsed.

#### 16 — Business / GTM readiness (2/4) — *audited directly*

- **F-16-01** **This is not a commercial product and does not claim to be.** Zero references to pricing, billing, Stripe/Razorpay, subscriptions, analytics, or a landing page. Angle re-framed against the launch surfaces that *do* apply: a truthful public repo and a published protocol.
- **F-16-02** The stated success metric is **re-admission** — "the process a burned project could require before saying yes to agents again" (`docs/00-vision.md:11-13`) — measured as merged etiquette-correct patches with zero maintainer bans.
- **F-16-03** The artifact that serves that metric — the maintainer-facing evidence page — exists, is regenerable, and is byte-verified (F-14-02). But it advertises a `shasum -a 256` recomputation against `docs/evidence/logs/`, **a directory that does not exist** (F-1-03).
- **F-16-04** The front door does not open (F-14-04). For a product whose entire thesis is being trusted by strangers, the README failing the stranger path is the GTM defect.

#### 17 — Ownership & operations (1/4) — *audited directly*

- **F-17-01** Bus factor is 1, explicitly. Twelve distinct env vars/credentials referenced; **three of them (`FOUNDRY_APP_ID`, `FOUNDRY_APP_PRIVATE_KEY`, `FOUNDRY_INSTALLATION_ID`) are documented as required and read by no code.**
- **F-17-02** **No account/key inventory document exists** — no single place listing every account, domain and service with its owner and recovery path.
- **F-17-03** **Recovery fails two of three scenarios** (F-8-28/29): a corrupt ledger and a revoked PAT both leave a stranger — including Ravindra's own future self — with no documented path. The PAT's 90-day rotation is mentioned once, in a shell script comment.
- **F-17-04** Incident process exists and is good where it exists: the slop-accusation drill (`docs/08-operations.md:225`) and the maintainer-stop procedure are concrete and ordered.
- **F-17-05** Repo hygiene debt: **9 stale worktrees** under `~/projects/oss-foundry-*` and **15 merged local branches** from prior sweeps, plus one unmerged branch (`sweep2/issue-37`, 3 commits, 1542 insertions) whose issue was closed by other means — a salvage-or-delete decision.

---

## Top risks entering Phase 2

| Rank | Finding | Why it ranks |
|---|---|---|
| 1 | **F-6-13** non-atomic ledger write + **F-6-10/11** no backup, no restore | A single interrupted write bricks every command, including the one used to diagnose it, with no documented recovery. Data-loss class. |
| 2 | **F-5-10** `witnessChildEnv` denylist leaks the operator's whole environment into third-party install scripts | Secrets exposure on the one path that executes untrusted code. |
| 3 | **F-1-04 / F-1-02 / F-1-01** three of seven critical flows never fired | The product's own standard calls these doctrine-only. Completion cannot be claimed on unexercised flows. |
| 4 | **F-1-09** promotion-gate arithmetic contradicts the doctrine it enforces | A governance gate that can promote on a merge the docs exclude. |
| 5 | **F-9-13** no alerting whatsoever + **F-9-07** the audit trail has no reader | An unattended 6-hour clock nobody is told about when it fails. |

## Assumptions recorded this phase

`A-01` … `A-06` — see `ASSUMPTIONS.md`.

## Second look

Two corrections made by re-reading my own output adversarially:

1. **My angle-13 exit-code probe was wrong.** I first recorded `unknown command bogus-command … exit=0` and nearly logged a bug. The `$?` was capturing `tail`'s status through a pipeline, not the CLI's. Re-measured without the pipe: exit **1**, correct. The finding was deleted rather than shipped.
2. **A scout reported the suite as 105 failures across 8 files** (`F-2-18`) and honestly flagged it as a possible sandbox artifact. It was: every failure rooted in one denied `mkdtemp` syscall. I had already run the suite twice myself at 379/379, so the caveat is resolved by my own evidence rather than carried forward as doubt. Recorded because the *underlying* observation is real and worth keeping: 8 of 19 test files hard-require `$TMPDIR` write permission with no skip path.
