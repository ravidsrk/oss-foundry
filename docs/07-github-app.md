# GitHub App

The factory authenticates as a GitHub App, never as a personal PAT.

## Why

PATs inherit the operator’s social graph. A leaked PAT is a reputation incident. An App is scoped, rotatable, and named `foundry-bot` so maintainers can see who is calling.

## Permissions

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

## Installations

- Installation 1: `ravidsrk` — Wave 0 + `oss-foundry`.
- Installation 2 (later): only after a Wave 1 maintainer invites the App. Do not send unsolicited App installs.

## Draft discipline

`factory/github-pr.ts` `draftPullPayload` sets `draft: true` unconditionally. There is no merge / `--admin` helper in that module. Marking ready-for-review is not in the method set; a human uses the browser.

The App is installed on `ravidsrk` only. `POST /repos/ColeMurray/background-agents/pulls` is **403**. ColeMurray#1652 was opened in a browser session, ready rather than draft — the doctrine miss that motivated the machine account below.

## Machine account — the moment of contact (issue #5)

The App's 403 on non-installed repos is GitHub's security model (user tokens act on the
intersection of app installations and user access), and the roadmap item that would fix
fine-grained PATs is paused. The one documented credential for fork→upstream PRs on unaffiliated
public repos is a **classic PAT**. So the moment of contact is machine-enforced with a hybrid:

- the App keeps doing everything it can (clone, push the branch to the operator fork);
- a dedicated, ToS-compliant **machine account** holds a classic PAT scoped to `public_repo`
  only (`FOUNDRY_PAT`, operator host env — never git, never the E2B box), used for exactly one
  call: `createDraftPull` → `POST /pulls` with `draft: true` hard-coded;
- `open-draft <packetId> --head <fork:branch>` re-runs the competing-work check, refuses a body
  without the verbatim disclosure, opens the draft, and records it via the normal attach flow;
- one create per CLI run; a secondary-rate-limit response is a **durable factory halt**, never a
  retry (AUP: excessive automated bulk activity): it is written into the state record, not just
  printed, so the next run refuses too until a human runs `clear-halt`
  ([08-operations.md](08-operations.md) §1);
- setup is human-only: `scripts/machine-account-wizard.sh` walks account, 2FA, token, and
  verification. No agent creates accounts.

Browser sessions are demoted to emergency-only. No contribution PR opens by hand again.

## Secrets

Live in the operator host / GHA environment:

- `FOUNDRY_APP_ID`
- `FOUNDRY_APP_PRIVATE_KEY`
- `FOUNDRY_INSTALLATION_ID`
- `E2B_API_KEY` (v2)

Never in `allowlist.yaml`, never in the E2B box, never in a packet.
