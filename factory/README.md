# factory/

TypeScript modules for the Foundry control plane. No operator web UI lives in this repository.

| Module | Role |
|---|---|
| `allowlist.ts` | Loads [`allowlist.yaml`](../allowlist.yaml) — the only roster |
| `policy.ts` | Deterministic gate. No canned CONTRIBUTING corpus |
| `engine.ts` | Tick / queue / approve / advance. Enforces hard rules |
| `packet.ts` | `buildPacket` / `renderPrBody` |
| `cli.ts` | Operator freeze / tick / draft-body loop |
| `github-pr.ts` | Draft-only create payload + PR sync. No merge helper |
| `github-scout.ts` | User-initiated live issue fetch. Public API; `GITHUB_TOKEN` raises the rate limit |
| `sandbox.ts` | Dry-run plan. Does not stamp harvested/exit 0 |
| `scorecard.ts` | Halt rules; engine consults `health()` |
| `seed.ts` | Ledger seed. Keep in sync with GitHub |

```
node --experimental-strip-types factory/cli.ts status
node --experimental-strip-types --test factory/engine.test.ts factory/policy.test.ts factory/load-allowlist.test.ts factory/state.test.ts factory/github-pr.test.ts
node --experimental-strip-types factory/validate-allowlist.ts
```

Never put a token in this repo.
