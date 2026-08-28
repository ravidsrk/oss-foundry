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

The App is installed on `ravidsrk` only. `POST /repos/ColeMurray/background-agents/pulls` is **403**. ColeMurray#1652 was opened in a browser session, ready rather than draft — a doctrine miss to follow up, not a reason to add a merge helper.

## Secrets

Live in the operator host / GHA environment:

- `FOUNDRY_APP_ID`
- `FOUNDRY_APP_PRIVATE_KEY`
- `FOUNDRY_INSTALLATION_ID`
- `E2B_API_KEY` (v2)
- `XAI_API_KEY` (optional; Grok overlay is not shipped)

Never in `allowlist.yaml`, never in the E2B box, never in a packet.
