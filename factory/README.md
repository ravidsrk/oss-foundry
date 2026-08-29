# factory/

TypeScript modules for the Foundry control plane. No operator web UI lives in this repository.

| Module | Role |
|---|---|
| `allowlist.ts` | Loads [`allowlist.yaml`](../allowlist.yaml) — the only roster |
| `policy.ts` | Deterministic gate. No canned CONTRIBUTING corpus |
| `engine.ts` | Tick / queue / approve / advance. Enforces hard rules |
| `packet.ts` | `buildPacket` / `renderPrBody` |
| `cli.ts` | Operator freeze / tick / draft-body loop |
| `github-pr.ts` | Draft-only create payload + PR sync. No POST-pulls helper. No merge helper |
| `github-scout.ts` | Live issue fetch — the discovery half of the scout seam, **not wired**: `tick` walks named `firstIssues`. Public API; `GITHUB_TOKEN` raises the rate limit |
| `sandbox.ts` | Dry-run plan. Does not stamp harvested/exit 0 |
| `scorecard.ts` | Halt rules; engine consults `health()` |
| `seed.ts` | Ledger seed. Keep in sync with GitHub |
| `run-tests.ts` | The suite's own oracle — see below. Discovers every `factory/*.test.ts`; nothing to register |
| `witness.ts` | Executes the evidence protocol; owns `hostRunner` — the shell Wave 0 tests actually run in ([08-operations](../docs/08-operations.md#witnessing-on-the-host-wave-0)); parses and re-checks ingested witnesses |

```
node --experimental-strip-types factory/cli.ts status
node --experimental-strip-types factory/run-tests.ts
node --experimental-strip-types factory/validate-allowlist.ts
```

Do not replace the runner with a bare `node --test`. Its exit code is not a trustworthy oracle
here: a test file whose *process* exits mid-run — anything a module-scope `process.exit()` can
reach through an import — is reported as a passing top-level entry with zero subtests, and the run
still exits 0. That silently deleted 71 of 113 tests once. `run-tests.ts` asserts one `test:summary`
per declared file and refuses a run where any file reported none.

Never put a token in this repo.
