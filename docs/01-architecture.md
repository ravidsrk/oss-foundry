# Architecture

Foundry splits into a **control plane** (`factory/` in this repo) and a **data plane** (Orca workers in a sandbox).

```
 CLOCK (GHA 6h / operator tick)
        │  one packet at a time
        ▼
 ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
 │ 1 Scout     │ → │ 2 Policy    │ → │ 3 Freeze    │ → │ 4 Implement │
 │ heuristic   │   │ AGENTS.md   │   │ human only  │   │ sandboxed   │
 └─────────────┘   └─────────────┘   └─────────────┘   └──────┬──────┘
                                                              │
                       ┌─────────────┐   ┌─────────────┐      │
                       │ 7 Scorecard │ ← │ 6 Draft PR  │ ←  5 Review (blind)
                       │ halt rules  │   │ never merge │      │
                       └─────────────┘   └─────────────┘      │
```

## Control plane

TypeScript in `factory/`. Deterministic. No LLM required to refuse a banned repo.

- `allowlist.ts` loads `allowlist.yaml` — the only repos the factory may see.
- `policy.ts` — phrase scanner + wave / CLA / scope caps. No canned welcome corpus.
- `scout.ts` — heuristic rank.
- `engine.ts` — tick / queue / approve / advance. Honors inflight, halt, promotion, deny.
- `packet.ts` — the unit of work. Objective, non-goals, acceptance, abort.
- `sandbox.ts` — dry-run plan; never auto-harvests as green.
- `scorecard.ts` — merge rate (terminal drafts), human review-comment average, no-review rate, narrow reverts vs rework, tone. `health()` can halt a repo; the engine consults it.
- `cli.ts` — operator freeze / tick / draft-body loop.

There is no TanStack console in this repository. The clock **must not** open contribution PRs.

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
| Policy | Forbidden phrases win over “but the issue is tiny.” No docs = deny. |
| Freeze | First 20 packets: always human. Forever on CLA/DCO and Wave 2. |
| Sandbox | Wave 1+ clones never hit the operator laptop. No secrets in the box. Dry-run is labeled dry-run. |
| Reviewer | Does not see implementer traces. Reviews the diff + tests only. |
| GitHub | Fork → upstream **draft** PR. No admin, no merge helper. |

## Why not Temporal / Mastra / a new Python agent

Orca already is the orchestrator. Mastra already is HeyCMO. A third runtime would duplicate `oss-contribute` and lose the evidence protocol. Foundry is YAML + TS gates + a clock + a CLI.

## v1 vs v2 in this repo

v1 is enforced: tick → packet → freeze → draft body, with halt / promotion / inflight including `submitted`. v2 adapters (live scout, PR sync, draft-only create payload) are real modules; credentials stay out of git. Dry-run sandbox does not pretend a harvest succeeded. Grok scout overlay is not shipped.
