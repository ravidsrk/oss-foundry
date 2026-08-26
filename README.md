# Foundry

Always-on, etiquette-correct open source contributions. **Never slop.**

Foundry is the control plane in front of [orca-fleet `oss-contribute`](https://github.com/ravidsrk/orca-fleet). It does not replace Orca. It decides *whether* a packet may exist. Orca decides *how* the patch is built.

| | |
|---|---|
| Operator console | This preview / the TypeScript app |
| Protocol | [`docs/`](docs/) |
| Allowlist | [`allowlist.yaml`](allowlist.yaml) |
| Clock | [`.github/workflows/oss-tick.yml`](.github/workflows/oss-tick.yml) — dry by default, **never opens PRs** |

## v1

Allowlist, deterministic policy gate, one-in-flight tick, human freeze, draft PR body. Dogfood `ravidsrk/orca-fleet#42` → [draft PR #70](https://github.com/ravidsrk/orca-fleet/pull/70).

## v2

Grok scout overlay (user-initiated), live GitHub scout (Wave 0–1), E2B sandbox lifecycle (dry-run in the console), follow-up station, scorecard halt rules.

## Do not

- Open PRs against the denylist.
- Run the clock with `FOUNDRY_LIVE=true` until Wave 0 has a Foundry-attested freeze.
- Put GitHub App keys in the E2B box.

## License

MIT
