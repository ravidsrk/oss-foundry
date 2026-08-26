# Foundry engine

Deterministic control-plane modules used by the operator console.

- `policy.ts` — AGENTS.md / denylist gate
- `scout.ts` — heuristic rank
- `packet.ts` — task packet + draft PR body
- `sandbox.ts` — E2B lifecycle (dry-run)
- `scorecard.ts` — halt rules
- `store.ts` — operator ledger (Zustand)

The always-on worker is still [orca-fleet oss-contribute](https://github.com/ravidsrk/orca-fleet).
