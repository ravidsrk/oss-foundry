# Foundry

Always-on, etiquette-correct open source contributions. **Never slop.**

Foundry is the control plane in front of [orca-fleet `oss-contribute`](https://github.com/ravidsrk/orca-fleet). It does not replace Orca. It decides *whether* a packet may exist. Orca decides *how* the patch is built.

**Takeover / full product:** [`docs/PRODUCT.md`](docs/PRODUCT.md)

| | |
|---|---|
| Public repo | https://github.com/ravidsrk/oss-foundry |
| Operator loop | `npm run foundry -- <cmd>` — daily procedure: [`docs/08-operations.md`](docs/08-operations.md) |
| Stations | [`docs/04-stations.md`](docs/04-stations.md) |
| Allowlist | [`allowlist.yaml`](allowlist.yaml) — the only source |
| Clock | [`.github/workflows/oss-tick.yml`](.github/workflows/oss-tick.yml) — dry by default, **never opens contribution PRs** |
| Env | [`docs/01-architecture.md`](docs/01-architecture.md#environment-variables) — do not copy the table here |

## Clone

```
git clone https://github.com/ravidsrk/oss-foundry.git
cd oss-foundry
```

Node **≥22.10.0**. The type-stripping flag only needs 22.6.0; the floor is `node:test`'s per-file `test:summary`, which the suite's own oracle requires. Below 22.10.0 `npm test` refuses outright. CI proves 22.10.0 and 24.

There is nothing to install. `package.json` declares no dependencies and this repo has no lockfile, so `npm ci` fails. `"private": true` is a publish guard on a public MIT repo, not a mistake.

## First command

No environment is required. From the checkout:

```
npm run foundry -- status
```

stderr:

```
no state file at <checkout>/.foundry-state.json — showing the committed seed ledger, not live state. Mutating commands will create it.
```

stdout is the committed seed snapshot: six packets, none in flight, `in flight: none — tick is allowed`, three scorecard rows. That is not live operator state.

`.foundry-state.json` is the gitignored live ledger. The published record is `factory/seed.ts` plus the generated block in [`docs/12-ledger.md`](docs/12-ledger.md). Missing file → seed (this path). Present but malformed → refuse; the loader will not overwrite damage with seed.

`npm run foundry` with no args lists every verb.

## Commands

| | |
|---|---|
| `status` | Seed or live snapshot. Read-only. |
| `events` | Ledger event log, newest first. |
| `tick` | Next named `firstIssues` row, or idle. Mutating. |
| `approve <id> --note <text>` | Human freeze. Attribution via `--by` or `FOUNDRY_OPERATOR`. |
| `sync <id>` | Live PR follow-up. Never merges. |
| `reconcile` | Absorb merges/closes into local state. |
| `open-draft <id> --head <forkOwner:branch>` | Draft-only create. Needs `FOUNDRY_PAT`. |

## What `tick` does today

```
npm run foundry -- tick
```

The command stands down each consumed row, then prints `idle` and exits 0. Every named `firstIssues` row on the roster is already consumed (closed). The factory will not invent issue numbers. A new named, witnessable first issue is a maintainer decision — [`docs/12-ledger.md`](docs/12-ledger.md). `tick` writes `.foundry-state.json` even when idle. With no token it warns that GitHub reads are unauthenticated (60 req/hr anonymous vs ~19 per tick); `GITHUB_TOKEN` / `GH_TOKEN` raise the ceiling. They are not required.

## Status (2026-08-31)

Wave 0 attested merges: [orca-fleet#70](https://github.com/ravidsrk/orca-fleet/pull/70), [orca-fleet#72](https://github.com/ravidsrk/orca-fleet/pull/72). frontguard [PR #196](https://github.com/ravidsrk/frontguard/pull/196) also merged. Wave 1 [ColeMurray/background-agents#1652](https://github.com/ColeMurray/background-agents/pull/1652) **closed unmerged** 2026-08-30 after the maintainer completed #1476 via #1668. Slot released. Draft-only and disclosure deviations on that PR are history — [`docs/12-ledger.md`](docs/12-ledger.md), [`docs/PRODUCT.md`](docs/PRODUCT.md) §8. **Do not re-open #1652.**

## v1

Allowlist YAML, deterministic policy gate, one-in-flight including `submitted`, human freeze, draft PR body, halt consulted, no invented issues.

## v2

E2B dry-run labeled as dry-run, follow-up PR sync, draft-only create helper. Credentials stay out of git. The live issue **scout** (`factory/github-scout.ts`) is written but **not wired**: `tick` walks each repo's named `firstIssues` rather than discovering issues — see [06-v2](docs/06-v2.md).

## Tests

```
npm test
```

Same oracle as `node --experimental-strip-types factory/run-tests.ts`. `npm run validate` checks `allowlist.yaml` and `policy-records.json`. `npm run typecheck` installs a pinned checker for that run only — it is not a repo dependency.

## Do not

- Open PRs against the denylist.
- Merge anything. Foundry never clicks merge — even on a repo you own.
- Put GitHub App keys in the E2B box.
- Invent issue numbers when the named first-issue list is empty.

## License

MIT
