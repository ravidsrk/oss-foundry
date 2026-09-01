# Architecture

Foundry splits into a **control plane** (`factory/` in this repo) and a **data plane** (Orca workers in a sandbox).

```
 CLOCK (GHA 6h / operator tick)
        │  one packet at a time
        ▼
 ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
 │ 1 Scout     │ → │ 2 Policy    │ → │ 3 Freeze    │ → │ 4 Implement │
 │ roster order│   │ AGENTS.md   │   │ human only  │   │ dry-run     │
 └─────────────┘   └─────────────┘   └─────────────┘   └──────┬──────┘
                                                              │
                       ┌─────────────┐   ┌─────────────┐      │
                       │ 7 Scorecard │ ← │ 6 Draft PR  │ ←  5 Review
                       │ halt rules  │   │ never merge │   evidence gate
                       └─────────────┘   └─────────────┘      │
```

Station 1 picks the next named `firstIssues` row in roster order (`pickCandidate` in `factory/engine.ts`), not a heuristic rank. Stations 4 and 5 are status bumps on `applyAdvance`; the evidence protocol is the gate on that arc. See [04-stations.md](04-stations.md).

## Control plane

TypeScript in `factory/`. Deterministic. No LLM required to refuse a banned repo. There is no TanStack console in this repository. The clock **must not** open contribution PRs.

The inventory below was derived from `factory/*.ts` on this tree (29 non-`*.test.ts` modules). [`factory/README.md`](../factory/README.md) is the closer map of the operator-facing surface — the modules you actually run — and this page is the complete list so the two stay honest: README names a subset; nothing it names is described differently here.

### Operator-facing (also in `factory/README.md`)

- `allowlist.ts` — loaded roster. Canonical id fold, `repoById`, denylist. YAML parse lives in `load-allowlist.ts`.
- `policy.ts` — phrase scanner + wave / CLA / scope caps. No canned welcome corpus.
- `engine.ts` — tick / queue / approve / advance. Honors inflight, halt, promotion, deny. Owns `pickCandidate`, `applyAdvance`, `applyAttachEvidence`, `evidenceIsReady`.
- `packet.ts` — `buildPacket` / `renderPrBody`. Stamps `scoreIssue` onto the packet as a record; that score does not pick the candidate.
- `cli.ts` — operator freeze / tick / draft-body loop.
- `github-pr.ts` — SPEC §6 moment of contact: draft-only `createDraftPull` (`FOUNDRY_PAT`), PR sync, issue/competing-work reads (`GITHUB_TOKEN` / `GH_TOKEN`). No merge helper.
- `github-scout.ts` — live issue fetch + `rankIssues`. **Not wired**: `tick` walks named `firstIssues`. Public API; `GITHUB_TOKEN` raises the rate limit.
- `sandbox.ts` — dry-run plan. Emits `# planned · not executed ·` commands with `exit: -1`. Does not stamp harvested/exit 0. Clone in the plan is **full**, not shallow.
- `scorecard.ts` — SPEC §7 standing: merge rate, tone, reverts, the two review KPIs. `health()` can halt a repo; the engine consults it. `classifyRevert` decides what counts as a revert; `applyRevert` (engine) is the only writer of `reverts`.
- `seed.ts` — committed ledger seed. Keep in sync with GitHub.
- `run-tests.ts` — the suite's own oracle. Discovers every `factory/*.test.ts` and refuses a run where any file reported zero tests.
- `witness.ts` — SPEC §5 evidence protocol. Owns `hostRunner` (Wave 0 host shell) and `witnessEvidence`; parses and re-checks ingested witnesses. E2B/Daytona execution is not in this tree.

### SPEC §5 / §6 / §7 and supporting modules README omits

- `state.ts` — fail-closed ledger loader (`loadFactoryState`). Refuses a non-v6 / unshaped / over-inflight file rather than overwriting it with seed.
- `types.ts` — shared unions and `TaskPacket` / `FactoryState` shapes. `Lighting = "lit"` only.
- `halt.ts` — SPEC §6 durable factory halt on a GitHub secondary rate limit. Written into the ledger; `clear-halt` is the only lift.
- `verify-ledger.ts` — clock-side, read-only: committed seed vs live GitHub. Divergence fails the run; advisories do not.
- `ledger-check.ts` — per-packet reconciliation (draft/head/disclosure/revert/stale evidence). Used by the clock and `reconcile`.
- `competition-read.ts` — live competing-work verdict for one packet, plus the one reporter the clock / `sync` / `reconcile` share.
- `policy-records.ts` — SPEC §3 committed policy-record loader (`policy-records.json`).
- `load-allowlist.ts` — YAML subset parser + `assertAllowlist` (disjointness, uniqueness, noop-oracle guard).
- `validate-allowlist.ts` — CLI entry: allowlist + policy-records consistency. `npm run validate`.
- `neighbor.ts` — SPEC §6 disclosure block (`DISCLOSURE`) and commit-trailer conventions. The verbatim PR-body text. Do not reformat it; `factory/engine.test.ts` asserts every in-repo quotation is byte-identical to the constant.
- `terminal.ts` — the sole third-party-text sanitisation boundary. Installed on stdout/stderr by every real entry point.
- `status.ts` — promotion-gate counter (`foundryAttestedWave0Merges`), ledger sections, quiet label. Also still exports unused UI-layer helpers (`statusTone`, `policyTone`, `formatWhen`, `needsFollowUp`) for a console that does not exist here.
- `ids.ts` — `mintLedgerId`: the only door for event / follow-up / halt ids.
- `scout.ts` — `scoreIssue` / `rankIssues`. Rank is unwired (see `github-scout.ts`). Score is stamped on packets and not consulted by `pickCandidate`.

### Test-support modules (not `*.test.ts`, not collected by `run-tests.ts`)

- `fixture-counts.ts` — `assertDisjointCounts` for issue #77 count fixtures.
- `seed-fixtures.ts` — Wave 1 packet helpers so reducer tests can rewind the absorbed close.
- `tmp-dir.ts` — the only `mkdtempSync` in the suite; registers `$TMPDIR` cleanup on `process.exit`.

## Data plane

Unchanged from orca-fleet:

- Coordinator never writes code.
- One worker, one playbook pack (Matt **or** Addy, never both).
- SHA-bound evidence manifest.
- Independent verifier re-derives tests, ancestry, negative control.
- `oss-contribute` never merges. `awaiting-maintainer-merge` is a success state.

That worker is not in this repository. Wave 0 host witnessing is (`witness.ts`). Wave 1+ execution is the worker host described in [06-v2.md](06-v2.md), ingested here with `attach-witness`.

## Trust boundaries

| Boundary | Rule |
|---|---|
| Allowlist | If it is not listed, it does not exist. |
| Policy | Forbidden phrases win over “but the issue is tiny.” No docs = deny. |
| Freeze | Every packet, at every wave. Nothing auto-freezes; the first-20 counter is an odometer, not a gate that opens. |
| Sandbox | Wave 1+ clones never hit the operator laptop. No secrets in the box. Dry-run is labeled dry-run. This CLI does not run the box. |
| Reviewer | Doctrine: does not see implementer traces. In this tree the review *station* is a status bump; the machine gate is `evidenceIsReady`. |
| GitHub | Fork → upstream **draft** PR via `FOUNDRY_PAT`. No admin, no merge helper. No GitHub App client. |

## Why not Temporal / Mastra / a new Python agent

Orca already is the orchestrator. Mastra already is HeyCMO. A third runtime would duplicate `oss-contribute` and lose the evidence protocol. Foundry is YAML + TS gates + a clock + a CLI.

## v1 vs v2 in this repo

v1 is enforced: tick → packet → freeze → draft body, with halt / promotion / inflight including `submitted`. v2 adapters (unwired live scout, PR sync, draft-only create payload, dry-run sandbox plan) are real modules; credentials stay out of git. Dry-run sandbox does not pretend a harvest succeeded. Grok scout overlay is not shipped.

## Environment variables

Derived by grepping `process.env.[A-Z_]+` across `factory/` and cross-checking `env.NAME` parameters that default to or are passed `process.env` (`FOUNDRY_PAT`, `E2B_API_KEY`). `PATH` appears in tests only (toolchain prefix) and is not a Foundry setting. No other `FOUNDRY_*` names are read by shipping code on this tree.

| Name | Read by | Default | Unset / invalid |
|---|---|---|---|
| `FOUNDRY_PAT` | `createDraftPull` (`factory/github-pr.ts`) via `env.FOUNDRY_PAT`, `env` defaulting to `process.env`. The only write credential. Also listed in `WITNESS_SECRET_KEYS` so a host-witness child never sees it (`factory/witness.ts`). | none | `POST /pulls` never leaves. Returns an error naming `scripts/machine-account-wizard.sh`. |
| `GITHUB_TOKEN` | `githubApiHeaders` (`factory/github-pr.ts`): `process.env.GITHUB_TOKEN \|\| process.env.GH_TOKEN`. Read path only. Also a `WITNESS_SECRET_KEYS` strip. The 6-hour clock injects `secrets.GITHUB_TOKEN` into `verify-ledger` (`.github/workflows/oss-tick.yml`). | none | Unauthenticated public reads (60 req/hr anonymous vs 5,000 with a token). |
| `GH_TOKEN` | Fallback for `GITHUB_TOKEN` in `githubApiHeaders`. Same secret strip. | none | Ignored if `GITHUB_TOKEN` is set; if both unset, unauthenticated reads. |
| `FOUNDRY_GITHUB_TIMEOUT_MS` | `githubFetchTimeoutMs` (`factory/github-pr.ts`). Integer milliseconds, 1…`GITHUB_FETCH_TIMEOUT_MAX_MS` (1 hour). | `15000` (`GITHUB_FETCH_TIMEOUT_MS`) | Unset, empty, non-integer, `< 1`, or above the max → shipped 15s bound. Does not throw. |
| `FOUNDRY_OPERATOR` | `factory/cli.ts` `approve` and `clear-halt` when `--by` is omitted. Attribution in the ledger, not a credential. | `"operator"` | Ledger events record `by: "operator"`. |
| `E2B_API_KEY` | `witnessEvidence` (`factory/witness.ts`) via caller `env` (`cli.ts` passes `process.env`). Presence check only — this CLI never talks to E2B. Also a `WITNESS_SECRET_KEYS` strip. | none | Wave 1+ `evidence` refuses with “cannot witness evidence in dry-run”. **Set** still refuses: execution belongs to the worker host; ingest with `attach-witness`. |
| `NODE_TEST_CONTEXT` | `factory/cli.ts` persist / logs-root guards. Set by `node:test` for spawned CLI children. Not an operator setting. | unset in a real operator shell | When set, and the CLI was not given `--state` / `--logs-root`, the process refuses to write the repo-root ledger or run logs. Unset: those writes are allowed. |
| `FOUNDRY_LIVE` | **Not a `process.env` read.** GitHub Actions **repository variable** `vars.FOUNDRY_LIVE` in `.github/workflows/oss-tick.yml`. | unset (dry) | `!= 'true'` → clock prints “FOUNDRY_LIVE is not set — clock stays dry” and does not file a packet-request issue. `== 'true'` → files (or updates) that issue on `oss-foundry`. Still must not open contribution PRs. |

Not secrets, not read, do not provision: `FOUNDRY_APP_ID`, `FOUNDRY_APP_PRIVATE_KEY`, `FOUNDRY_INSTALLATION_ID`. They appear in no `factory/` read. See [07-github-app.md](07-github-app.md).
