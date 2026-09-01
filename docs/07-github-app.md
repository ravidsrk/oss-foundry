# GitHub credentials

The factory does **not** authenticate as a GitHub App. The shipping write credential is a classic personal access token (`FOUNDRY_PAT`); the shipping read credential is `GITHUB_TOKEN` or `GH_TOKEN`. A previous version of this page led with “authenticates as a GitHub App, never as a personal PAT.” That sentence was false — contradicted by the machine-account section below and by the code — and a false security claim is worse than a missing one.

## What the code actually uses

| Credential | Direction | Where it is read | Unset |
|---|---|---|---|
| `FOUNDRY_PAT` | **The only write.** Classic PAT, minted at `public_repo` scope by `scripts/machine-account-wizard.sh`. | `createDraftPull` reads `env.FOUNDRY_PAT` (`factory/github-pr.ts`). `env` defaults to `process.env`. Used on exactly one call: `POST /repos/{owner}/{repo}/pulls` with `draft: true` hard-coded via `draftPullPayload`. | The POST never leaves. The function returns an error naming the wizard. |
| `GITHUB_TOKEN` / `GH_TOKEN` | **The only read.** | `githubApiHeaders` (`factory/github-pr.ts`): `process.env.GITHUB_TOKEN \|\| process.env.GH_TOKEN`. Attached as `Authorization: Bearer …` when present. `createDraftPull` constructs its own header with `FOUNDRY_PAT` inline, so a read token cannot be used for a write. | Unauthenticated public reads (GitHub’s 60 req/hr anonymous ceiling vs 5,000 with a token). |
| `E2B_API_KEY` | Not a GitHub credential. Presence check only. | `witnessEvidence` (`factory/witness.ts`) reads `env.E2B_API_KEY`. With or without it, this CLI does not run an E2B sandbox — see [06-v2.md](06-v2.md). | Wave 1+ `evidence` refuses with “cannot witness evidence in dry-run”. |

There is no App client in this tree. `FOUNDRY_APP_ID`, `FOUNDRY_APP_PRIVATE_KEY`, and `FOUNDRY_INSTALLATION_ID` have **zero** reads under `factory/`. Provisioning them does nothing. Do not set them.

The full environment-variable reference — including `FOUNDRY_GITHUB_TIMEOUT_MS`, `FOUNDRY_OPERATOR`, `NODE_TEST_CONTEXT`, and the `FOUNDRY_LIVE` repository variable, which is not a `process.env` read — lives in [01-architecture.md](01-architecture.md#environment-variables).

## Why a PAT at the moment of contact

PATs inherit the operator’s social graph. A leaked PAT is a reputation incident. An App would be scoped, rotatable, and named so maintainers can see who is calling. **That App is not implemented.** GitHub App user-to-server tokens 403 on `POST /pulls` against repos the App is not installed on (intersection of installations and user access). Fine-grained PATs are not the documented credential for fork→upstream PRs on unaffiliated public repos. The one documented credential for that write is a **classic PAT**.

So the moment of contact is machine-enforced with the PAT, not with an App:

- a dedicated, ToS-compliant **machine account** holds a classic PAT scoped to `public_repo` only (`FOUNDRY_PAT`, operator host env — never git, never the E2B box), used for exactly one call: `createDraftPull` → `POST /pulls` with `draft: true` hard-coded (`factory/github-pr.ts`);
- this repository does not clone, push a branch, or otherwise write with an App token — those steps, when they happen, are operator / worker-host work outside this tree;
- `open-draft <packetId> --head <fork:branch>` re-runs the competing-work check, refuses a body without the verbatim disclosure, opens the draft, and records it via the normal attach flow;
- one create per CLI run; a secondary-rate-limit response is a **durable factory halt**, never a retry (AUP: excessive automated bulk activity): it is written into the state record, not just printed, so the next run refuses too until a human runs `clear-halt` ([08-operations.md](08-operations.md) §1);
- setup is human-only: `scripts/machine-account-wizard.sh` walks account, 2FA, token, and verification. No agent creates accounts.

Browser sessions are demoted to emergency-only. No contribution PR opens by hand again — and if one ever does, `attach-draft` refuses to bind it unless the body carries the verbatim disclosure block. That refusal lives in `applyAttachDraft` (`factory/engine.ts`), not in a verb, so both create paths run it; until issue #38 it existed only in `open-draft`, which is not the path that opened ColeMurray/background-agents#1652.

## Draft discipline

`factory/github-pr.ts` `draftPullPayload` sets `draft: true` unconditionally. There is no merge / `--admin` helper in that module. Marking ready-for-review is not in the method set; a human uses the browser.

`POST /repos/ColeMurray/background-agents/pulls` with an App token is **403** (no installation). ColeMurray#1652 was opened in a browser session, ready rather than draft — the doctrine miss that motivated the machine account above. The in-repo create path would use `FOUNDRY_PAT`, not an App.

## GitHub App (unimplemented / aspirational)

Nothing below is wired. It is the permission floor to implement against if an App is ever built, not a description of today’s auth.

Intended permissions (least):

| Permission | Access | Why |
|---|---|---|
| Metadata | read | List repos. |
| Contents | read on upstream, write on forks we own | Clone + push branches. |
| Pull requests | write | Open **drafts** only. |
| Issues | read | Scout. |
| Checks | read | Follow-up. |
| Actions | none | |
| Administration | none | |
| Merge queues | none | |

Intended installations, if that App exists:

- Installation 1: `ravidsrk` — Wave 0 + `oss-foundry`.
- Installation 2 (later): only after a Wave 1 maintainer invites the App. Do not send unsolicited App installs.

Do not put App private keys — or `FOUNDRY_PAT` — in `allowlist.yaml`, in the E2B box, or in a packet.
