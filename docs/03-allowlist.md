# Allowlist

The allowlist is the product. Everything else is a pipeline.

## Waves

| Wave | Who | Sandbox | Human freeze |
|---|---|---|---|
| 0 | Repos we own (`orca-fleet`, `frontguard`) | Host worktree | First 20 factory-wide, then mechanical if policy allows |
| 1 | AI-welcome, small blast radius | E2B | Always |
| 2 | Adjacent (Mastra, OpenHands) | E2B | Always + HUMAN/DCO holds |

## Current roster

### Wave 0 — dogfood

- `ravidsrk/orca-fleet` — first packet [orca-fleet#70](https://github.com/ravidsrk/orca-fleet/pull/70) (CHANGELOG 0.5.0) **merged**. Third: [#71](https://github.com/ravidsrk/orca-fleet/issues/71) → [draft #72](https://github.com/ravidsrk/orca-fleet/pull/72) (unreadable SKILL.md).
- `ravidsrk/frontguard` — second packet: [#195](https://github.com/ravidsrk/frontguard/issues/195) README architecture vs the monorepo → [draft #196](https://github.com/ravidsrk/frontguard/pull/196) (quiet; CI red is pre-existing on main).

### Wave 1 — low-risk external

- `ColeMurray/background-agents` — OpenInspect. First packet: [#1476](https://github.com/ColeMurray/background-agents/issues/1476) sidebar toggle icon (good-first-issue, help-wanted).
- `github/awesome-copilot` — docs catalog, tiny diffs.
- `e2b-dev/E2B` — the sandbox we depend on. Docs/examples only.
- `mcp-use/mcp-use` — policy unknown until CONTRIBUTING is fetched. Gate holds.
- `kortix-ai/suna` — same: unknown until parsed.

### Wave 2 — adjacent, slower

- `mastra-ai/mastra` — HeyCMO’s runtime. Human-required.
- `All-Hands-AI/OpenHands` — HUMAN: markers. Docs only.

## Denylist (hard)

- `matplotlib/matplotlib` — autonomous-agent ban.
- `curl/curl` — maintainer request to stop agent noise.
- `pydantic/pydantic` — slop-PR close rate.
- `stablyai/orca` — contribute through orca-fleet, not drive-by.

A denylist hit is `DENY_FORBIDDEN`. There is no override in the operator UI.

## Adding a repo

1. Read `AGENTS.md` + `CONTRIBUTING` + last 20 closed PRs from strangers.
2. Confirm a maintainer has merged *some* external PR in 90 days.
3. Record `aiPolicy`, test command, caps, sandbox, preferred labels.
4. First issue must be named (number + title + url). No “we’ll find one later.”
5. PR against this repo’s `allowlist.yaml`. Freeze required.

## Removing a repo

Any of: maintainer ask, one revert of our patch, merge rate < 40% after 3 opens, tone `cold` for two cycles, or a ban. Removal is immediate and logged on the scorecard.
