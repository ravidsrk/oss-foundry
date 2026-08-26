# Architecture

Foundry splits into a **control plane** (this app) and a **data plane** (Orca workers in a sandbox).

```
 CLOCK (GHA 6h / operator tick)
        │  one packet at a time
        ▼
 ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
 │ 1 Scout     │ → │ 2 Policy    │ → │ 3 Freeze    │ → │ 4 Implement │
 │ Grok rank   │   │ AGENTS.md   │   │ human only  │   │ sandboxed   │
 └─────────────┘   └─────────────┘   └─────────────┘   └──────┬──────┘
                                                              │
                       ┌─────────────┐   ┌─────────────┐      │
                       │ 7 Scorecard │ ← │ 6 Draft PR  │ ←  5 Review (blind)
                       │ halt rules  │   │ never merge │      │
                       └─────────────┘   └─────────────┘      │
```

## Control plane

TypeScript. Deterministic. No LLM required to refuse a banned repo.

- `allowlist.ts` / `allowlist.yaml` — the only repos the factory may see.
- `policy.ts` — phrase scanner + wave / CLA / scope caps.
- `scout.ts` — heuristic rank; optional Grok overlay (user-initiated).
- `packet.ts` — the unit of work. Objective, non-goals, acceptance, abort.
- `sandbox.ts` — E2B/Daytona dry-run in v1; real provider in v2.
- `scorecard.ts` — merge rate, tone, reverts. Can halt a repo or the factory.

The operator console is the human freeze. The clock **must not** open PRs.

## Data plane

Unchanged from orca-fleet:

- Coordinator never writes code.
- One worker, one playbook pack (Matt **or** Addy, never both).
- SHA-bound evidence manifest.
- Independent verifier re-derives tests, ancestry, negative control.
- `oss-contribute` never merges. `awaiting-maintainer-merge` is a success state.

## Trust boundaries

| Boundary | Rule |
|---|---|
| Allowlist | If it is not listed, it does not exist. |
| Policy | Forbidden phrases win over “but the issue is tiny.” |
| Freeze | First 20 packets: always human. Forever on CLA/DCO and Wave 2. |
| Sandbox | Wave 1+ clones never hit the operator laptop. No secrets in the box. |
| Reviewer | Does not see implementer traces. Reviews the diff + tests only. |
| GitHub | GitHub App, fork → upstream **draft** PR. No admin, no merge. |

## Why not Temporal / Mastra / a new Python agent

Orca already is the orchestrator. Mastra already is HeyCMO. A third runtime would duplicate `oss-contribute` and lose the evidence protocol. Foundry is YAML + TS gates + a clock + a UI.

## v1 vs v2 in this repo

Both ship. v1 is safe to run today (tick → packet → freeze → draft body). v2 is wired: Grok scout, E2B session lifecycle, scorecard halt. Real E2B keys and a GitHub App live **outside** this preview — the adapters are real, the credentials are not baked in.
