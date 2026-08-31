# Foundry

Always-on, etiquette-correct open source contributions. **Never slop.**

Foundry is the control plane in front of [orca-fleet `oss-contribute`](https://github.com/ravidsrk/orca-fleet). It does not replace Orca. It decides *whether* a packet may exist. Orca decides *how* the patch is built.

**Takeover / full product:** [`docs/PRODUCT.md`](docs/PRODUCT.md)

| | |
|---|---|
| Operator loop | `node --experimental-strip-types factory/cli.ts` |
| Protocol | [`docs/`](docs/) |
| Allowlist | [`allowlist.yaml`](allowlist.yaml) — the only source |
| Clock | [`.github/workflows/oss-tick.yml`](.github/workflows/oss-tick.yml) — dry by default, **never opens contribution PRs** |

## Status (2026-08-31)

Wave 0 attested merges: [orca-fleet#70](https://github.com/ravidsrk/orca-fleet/pull/70), [orca-fleet#72](https://github.com/ravidsrk/orca-fleet/pull/72). frontguard [PR #196](https://github.com/ravidsrk/frontguard/pull/196) also merged. Wave 1 [ColeMurray/background-agents#1652](https://github.com/ColeMurray/background-agents/pull/1652) **closed unmerged** 2026-08-30 after the maintainer completed #1476 via #1668. Slot released. Draft-only and disclosure deviations on that PR are history — [`docs/12-ledger.md`](docs/12-ledger.md), [`docs/PRODUCT.md`](docs/PRODUCT.md) §8. **Do not re-open #1652.**

## v1

Allowlist YAML, deterministic policy gate, one-in-flight including `submitted`, human freeze, draft PR body, halt consulted, no invented issues.

## v2

E2B dry-run labeled as dry-run, follow-up PR sync, draft-only create helper. Credentials stay out of git. The live issue **scout** (`factory/github-scout.ts`) is written but **not wired**: `tick` walks each repo's named `firstIssues` rather than discovering issues — see [06-v2](docs/06-v2.md).

## Tests

Node 22+:

```
node --experimental-strip-types factory/run-tests.ts
```

## Do not

- Open PRs against the denylist.
- Merge anything. Foundry never clicks merge — even on a repo you own.
- Put GitHub App keys in the E2B box.
- Invent issue numbers when the named first-issue list is empty.

## License

MIT
