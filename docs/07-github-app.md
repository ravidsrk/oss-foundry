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

The App’s `pull_request.create` wrapper sets `draft: true` unconditionally. Marking ready-for-review is not in the App’s method set; a human uses the browser.

## Secrets

Live in the operator host / GHA environment:

- `FOUNDRY_APP_ID`
- `FOUNDRY_APP_PRIVATE_KEY`
- `FOUNDRY_INSTALLATION_ID`
- `E2B_API_KEY` (v2)
- `XAI_API_KEY` (scout overlay; already injected in this preview)

Never in `allowlist.yaml`, never in the E2B box, never in a packet.
