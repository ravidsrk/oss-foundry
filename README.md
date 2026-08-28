Always-on, etiquette-correct open source contributions. **Never slop.**

Foundry is the control plane in front of [orca-fleet `oss-contribute`](https://github.com/ravidsrk/orca-fleet). It does not replace Orca. It decides *whether* a packet may exist. Orca decides *how* the patch is built.

**Takeover / full product:** [`docs/PRODUCT.md`](docs/PRODUCT.md)

| | |
|---|---|
| Operator console | This preview / the TypeScript app |
| Protocol | [`docs/`](docs/) |
| Allowlist | [`allowlist.yaml`](allowlist.yaml) |
| Clock | [`.github/workflows/oss-tick.yml`](.github/workflows/oss-tick.yml) — dry by default, **never opens PRs** |

## Status (2026-08-28)

Wave 0 **2/2 attested merges**: [orca-fleet#70](https://github.com/ravidsrk/orca-fleet/pull/70), [orca-fleet#72](https://github.com/ravidsrk/orca-fleet/pull/72). Frontguard [draft #196](https://github.com/ravidsrk/frontguard/pull/196) quiet. Wave 1 patch is on the fork ([background-agents#1](https://github.com/ravidsrk/background-agents/pull/1)); **upstream PR not opened** (GitHub App 403). Operator must open the draft — copy in `docs/PRODUCT.md` §10.

## v1

Allowlist, deterministic policy gate, one-in-flight tick, human freeze, draft PR body.

## v2

Grok scout overlay (user-initiated), live GitHub scout (Wave 0–1), E2B sandbox lifecycle (dry-run in the console), follow-up station, scorecard halt rules.

## Do not

- Open PRs against the denylist.
- Merge anything. Foundry never clicks merge — even on a repo you own.
- Put GitHub App keys in the E2B box.

## License

MIT
