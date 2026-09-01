# Phase 2 — deep research

Two tracks. Track A reconstructs intent from the repo's own history; Track B verifies external facts against primary sources. Every Track B item carries an explicit plan effect, including "no effect", so nothing is silently dropped.

## Confidentiality firewall log (R8)

Every outbound query was category-only. No query contained the product name, a module name, a feature name, a hostname, or verbatim code.

| # | query category | why |
|---|---|---|
| R-01 | "Node.js type stripping lifecycle / stability index / flag rename" | the runtime the product depends on |
| R-02 | "Node.js 22 and 24 LTS support windows and EOL dates" | support horizon |
| R-03 | "npm engines field enforcement and engine-strict default" | whether a declared floor is a guard |
| R-04 | "GitHub REST API deprecations, sunset headers, API versions" | the only wired integration |
| R-05 | "GitHub REST rate limits, primary and secondary, recommended handling" | self-throttling design |
| R-06 | "atomic file replacement in Node.js on POSIX and Windows" | the top-ranked data risk |

---

## Track A — internal archaeology

### A.1 Velocity topology

Evidence: `evidence/p2-a1-velocity.txt`

| date | commits | PRs merged | issues closed |
|---|---|---|---|
| 2026-08-26 | 2 | — | — |
| 2026-08-27 | 8 | — | — |
| 2026-08-28 | 59 | 17 | 16 |
| 2026-08-29 | 51 | 28 | 35 |
| 2026-08-30 | **86** | 1 | 2 |
| 2026-08-31 | 9 | 1 | 6 |
| 2026-09-01 | 14 | 5 | 6 |

**Velocity did not drop — it changed shape.** 08-28/29 were breadth days (45 PRs, 51 issues closed). 08-30 is the anomaly: 86 commits against **one** merged PR — a single branch taking 21 commits and ~20 review rounds through the policy-scanner hardening. That is the signature of depth, not stall.

The last coherent milestone is that PR: the policy scanner reached a stated, measured posture (hold on ambiguity, decided by measurement over 17 real CONTRIBUTING documents) rather than an open-ended regex chase. Everything since is small and closing.

### A.2 Abandoned branches

One local branch is unmerged into `main`: **`sweep2/issue-37`** — 3 commits, 11 files, 1542 insertions.

Evidence: `evidence/p2-a2-abandoned-branch.txt`

Issue #37 is **CLOSED** (landed by other means during the 2026-08-29 sweep), so the branch looked like a superseded duplicate. It is not. Of the 22 tests it adds, **9 are already on `main` and 13 are not**, including:

- `every forbidden matcher is the sole catcher of at least one ban row` — a per-matcher necessity guard
- `no forbidden matcher fires on any near-miss`
- `a brand lexicon does not turn ordinary software words into bans`
- `base ratchet: nothing the baseline denies reaches ALLOW unless it is listed`
- `every corpus row keeps its verdict across a hard wrap`

These are real invariants of the class the current suite still lacks. **But** `factory/policy.ts` was substantially rewritten after that branch was cut (the CLA/DCO work, PR #91), so the tests will not apply unmodified. This is a genuine salvage-or-delete decision with content on both sides → gap **G-29**.

The other 15 local branches are merged into `main` and are pure debris; 9 stale worktrees sit under `~/projects/oss-foundry-*` (left untouched per `A-07`).

### A.3 Prior plans and audits

There is no committed roadmap, backlog, or TODO file, and no prior audit document. Scope has always lived in the GitHub issue tracker. The in-repo next-actions surfaces are `docs/PRODUCT.md` §10 "Now:" and `docs/12-ledger.md` "## Next".

This means `docs/completion/` is the first durable plan artifact this repo has had — there is no earlier plan to reconcile against, and therefore no plan-vs-reality divergence to explain. The divergences found in Phase 1 are all **doc-vs-code**, not plan-vs-code.

### A.4 Original intent vs current intent

The first `README.md` (`dd41a55`, 2026-08-27) reads:

> Always-on, etiquette-correct open source contributions. Never slop. Control plane + protocol for a software factory that extends orca-fleet oss-contribute.

That sentence is **still the repo description today, unchanged**. The delta over six days is not in intent but in *what the intent was discovered to require*:

- **Added:** an evidence/witness protocol (`witness.ts`, 677 lines), a terminal sanitisation boundary (`terminal.ts`), a ledger with fail-closed loading (`state.ts`), reconciliation against live GitHub (`verify-ledger.ts`, `ledger-check.ts`), and a published SPEC. None of these appear in the original framing.
- **Sharpened:** "etiquette-correct" resolved into concrete, machine-enforced rules — draft-only, verbatim disclosure, absolute denylist, one packet in flight, halt-never-retry.
- **Not added:** features. There is no scope creep. The growth is all in *proving* the original claim rather than extending it.

**Conclusion: intent has held.** The gap is between the claim and its demonstration, which is exactly what `AGENTS.md:27` says ("A station without SHA-bound evidence is doctrine-only"). That framing carries directly into the Definition of Complete.

---

## Track B — external research

### R-01 — Node.js type stripping: lifecycle and stability

**Answer.** `--experimental-strip-types` was added in **v22.6.0**. Type stripping became default-on in **v23.6.0 / v22.18.0** (2025-07-31). As of 2026-09-01 it is **Stability 2 — Stable** on 24.x/25.x/26.x but still **Stability 1.2 — Release candidate** on the 22.x line. The flag was *renamed*, not removed: `--strip-types` is canonical and `--experimental-strip-types` survives as a registered alias (`src/node_options.cc:1218`) with **no deprecation entry** in `doc/api/deprecations.md`. Type stripping performs **no type checking** — whitespace erasure only, and `tsconfig.json` is ignored entirely. `--experimental-transform-types` was **removed outright in v26.0.0** (PR #61803), so enums, runtime namespaces, parameter properties and import aliases now have no runtime escape hatch at all.

**Sources** (fetched 2026-09-01): `nodejs.org/docs/v22.6.0/api/cli.html` (flag "Added in: v22.6.0") · `nodejs.org/api/typescript.html` (history table + stability marker + the no-type-checking statement) · `nodejs.org/docs/latest-v22.x/api/typescript.html` (1.2 RC on 22.x) · `nodejs.org/docs/latest-v24.x/api/typescript.html` (2 Stable on 24.x) · `github.com/nodejs/node/blob/main/src/node_options.cc` (the alias) · `github.com/nodejs/node/blob/main/doc/api/deprecations.md` (zero matches for strip-types) · `CHANGELOG_V26.md` (transform-types removal).

**EFFECT: confirms_gap (F-3-01/F-3-02) + one thing the repo already gets right.**
- Confirms there is genuinely no type checking, so the ~200 lines of hand-written runtime validators in `factory/state.ts` are re-deriving what a compiler would prove. → **G-05**.
- **The repo's choice of spelling is correct and should not be "modernised".** `--strip-types` does not exist on the 22.x line, so switching to the canonical name would break every Node 22 user. `--experimental-strip-types` is the only spelling that works across the whole 22.6.0+ range.

### R-02 — Node.js support windows

**Answer.** Node 22 "Jod": LTS 2024-10-29, **maintenance since 2025-10-21**, EOL **2027-04-30**. Node 24 "Krypton": LTS 2025-10-28, maintenance 2026-10-20, EOL 2028-04-30. **Node 24 is the current Active LTS**; Node 22 is maintenance-only (security fixes).

**Sources:** `github.com/nodejs/Release/blob/main/schedule.json` (machine-readable, authoritative) · `nodejs.org/en/about/previous-releases` (status corroboration).

**EFFECT: new_gap.** CI pins `node-version: "22"` — the line that is both **maintenance-only** and the one where type stripping is still a **release candidate**, while the operator runs 24, where it is Stable. The suite is being proven on the least stable of the two lines it actually runs on. → **G-06**.

### R-03 — `engines` as a guard

**Answer.** A `>=22` floor is too loose. Code relying on default-on stripping breaks on **22.0.0–22.17.1**; code passing the flag explicitly breaks on **22.0.0–22.5.1**, where Node aborts on the unrecognised option. The correct floor is `>=22.18.0`. Separately, **npm does not enforce `engines`** — the field is advisory and only warns unless `engine-strict` is set, whose default is `false` and which `--force` overrides anyway.

**Sources:** `CHANGELOG_V22.md` (22.18.0 "Type stripping is enabled by default"; 22.17.1 immediately prior; 22.5.1 immediately before 22.6.0) · `github.com/npm/cli/.../package-json.md` (advisory only) · `docs.npmjs.com/cli/v11/using-npm/config` (`engine-strict` default false).

**EFFECT: new_gap, and worse than Phase 1 recorded.** `engines: ">=22"` is not merely imprecise — it is *not a guard at all*. A stranger on Node 22.4 satisfies the declared floor, gets no npm warning that matters, and hits an unrecognised-option abort on their first command. The floor must be raised **and** backed by a runtime `process.versions.node` check, because the manifest cannot enforce it. → **G-06**.

### R-04 — GitHub REST API: deprecations and versioning

**Answer.** **Verified: no deprecation found.** All nine read endpoints and the one write endpoint return 200 with **zero `Deprecation` and zero `Sunset` headers** under both API versions (live sweep, authenticated and unauthenticated). `application/vnd.github.raw` **is still supported**. The timeline endpoint is **no longer preview** — no preview media type required.

**The real finding is version-gated field removal.** A new REST API version **`2026-03-10`** exists — the first breaking version since date-based versioning began. `2022-11-28` is supported until **2028-03-10**, and unversioned requests default to `2022-11-28` *today*. Under `2026-03-10`, confirmed empirically on `GET /pulls/{n}` (48 keys → 46): **`merge_commit_sha` is removed from all PR payloads**, and singular `assignee` is removed from issue and PR payloads.

**Sources:** `docs.github.com/en/rest/about-the-rest-api/breaking-changes` · `.../api-versions` (unversioned defaults to 2022-11-28; unsupported version → 410 Gone) · `docs.github.com/en/rest/issues/timeline` · live probe of `api.github.com` with a controlled version-to-version field diff.

**EFFECT: new_gap — and it is a silent-failure gap on a governance path.** Verified against the code (`evidence/p2-b2-github-api-version.txt`):

- `githubApiHeaders` (`factory/github-pr.ts:66-73`) sends `Accept` and `User-Agent` and **no `X-GitHub-Api-Version`**. Every request inherits a rolling default.
- The tool **does** consume the removed field: `github-pr.ts:695` reads `pr.merge_commit_sha` into `meta.mergeCommitSha`, which is the sole input to `classifyRevert` (`factory/scorecard.ts:209-213`) — the entire revert-detection path.
- When the unversioned default rolls forward, `merge_commit_sha` becomes `undefined`, `github-pr.ts:611` short-circuits on `if (!meta.mergeCommitSha || !meta.mergedAt)`, and **revert detection stops silently**. `reverts` is the field that forces `health=stop`, so the failure mode is a governance gate that quietly stops firing.
- `assignee` is not consumed — not affected.

→ **G-04**. One header fixes it.

### R-05 — GitHub rate limits and recommended handling

**Answer.** Authenticated PAT: **5,000 req/hr** (live-confirmed `resources.core.limit = 5000`). Unauthenticated: **60 req/hr** (live-confirmed). Secondary limits on content creation: **no more than 80 content-generating requests per minute and 500 per hour**, counted across web UI, REST and GraphQL together. GitHub's documented handling is **back off, not retry**: honour `retry-after`; else if `x-ratelimit-remaining` is 0 wait for `x-ratelimit-reset`; else wait at least a minute; then exponential backoff and give up after a cap. The docs warn that continuing to request while limited **may result in banning the integration**. Primary state is in `x-ratelimit-*`; secondary limits surface as 403/429 with a message and `retry-after`, and **cannot be checked in advance**.

**Sources:** `docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api` · live `GET /rate_limit`.

**EFFECT: confirms_gap, and confirms one design decision is better than the baseline.**
- **Better than required:** the product's halt-and-never-retry on a secondary limit is *more* conservative than GitHub's own guidance, and "cannot be checked in advance" is exactly why a durable halt is the right shape. `docs/SPEC.md:61` is vindicated, not merely defensible. No change.
- **Confirms the gap:** the **primary** limit is neither detected nor documented. The 5,000/hr and 60/hr ceilings appear nowhere in the repo, so nobody can compute headroom against the measured 19-requests-per-tick spend — and an unauthenticated operator silently gets 60/hr, failing on the fourth tick of an hour with an unexplained 403. → **G-10**.

### R-06 — Atomic and durable file replacement

**Answer.** The correct pattern: write a temp file **in the same directory**, fsync it, close, `rename` over the target, optionally fsync the directory. **POSIX `rename` is atomic** — the spec requires the destination name to remain continuously visible as either the old or the new file, and the RATIONALE states the action is required to be atomic. **On Windows it overwrites but carries no atomicity guarantee** — libuv uses `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` without `MOVEFILE_WRITE_THROUGH`, and Microsoft asserts atomicity nowhere; `ReplaceFile` even documents partial-failure states leaving inconsistent names. Critically: **`fs.writeFileSync` does not flush to disk** — page cache only. Durability is opt-in via the `flush` option (added v21.0.0/v20.10.0), whose **default is `false`**.

**Sources:** `nodejs.org/docs/latest/api/fs.html` (rename overwrites; `flush` default false) · `pubs.opengroup.org/.../rename.html` (atomicity) · `libuv` `src/win/fs.c` · `learn.microsoft.com/.../MoveFileExW` and `.../ReplaceFileW`.

**EFFECT: new_gap, with a precise fix.** This converts the Phase 1 top risk from "should be atomic" into an exact prescription for `factory/state.ts:455`:

```
tmp in same dir → writeFileSync(tmp, json, { flush: true }) → renameSync(tmp, path)
```

`flush: true` is required — without it the rename is atomic but the bytes may still be in the page cache, so a power loss loses the write it appeared to make. → **G-01**.

---

## Track C — synthesis

### Research-derived findings promoted to gaps

| id | source | becomes |
|---|---|---|
| F-R-01 | R-06 | **G-01** — ledger write is neither atomic nor durable; exact fix known |
| F-R-02 | R-04 | **G-04** — no `X-GitHub-Api-Version` pin; `merge_commit_sha` removal will silently kill revert detection |
| F-R-03 | R-02 + R-03 | **G-06** — `engines` floor is wrong *and* unenforceable; CI pins the RC line |
| F-R-04 | R-05 | **G-10** — primary rate limit undetected and undocumented |

### Definition inputs — what "complete" requires in this domain

Research and archaeology together say completion for *this* product is not feature coverage. It is three things:

1. **Demonstration over doctrine.** The repo's own rule (`AGENTS.md:27`) is the right bar, and three of seven critical flows currently fail it. A flow that has never run is not complete no matter how well tested.
2. **Survivability of the ledger.** The ledger is the product — it is the audit surface, the state, and the evidence. It is currently written non-atomically, non-durably, with no backup, no restore procedure, a silent 80-event truncation, and a loader that (correctly) refuses a damaged file — which means damage takes down the diagnostic command too.
3. **Forward-compat on the one integration.** GitHub is the only provider. An unpinned API version on a payload field that feeds a governance gate is a silent time bomb with a known fuse (default rolls forward before 2028-03-10).

### Items with no plan effect, recorded so nothing is silently dropped

- **R-01 flag spelling:** `--experimental-strip-types` is correct and must NOT be changed to `--strip-types`. No action; recorded to prevent a well-meaning future "modernisation" from breaking Node 22.
- **R-01 non-erasable syntax:** verified zero enums, namespaces, parameter properties, decorators and import aliases in `factory/` and `scripts/` (`evidence/p2-b1-node26-forward-compat.txt`), and the suite runs green on v24.20.0. Node 26 removed the escape hatch; the source needs none. No action.
- **R-04 endpoint deprecation:** verified none. No action.
- **R-04 `vnd.github.raw`:** still supported. No action.
- **R-05 secondary-limit handling:** the product exceeds GitHub's documented guidance. No action.
- **R-02 Node 22 EOL 2027-04-30:** outside any plausible planning horizon for this repo. Recorded, no action.
