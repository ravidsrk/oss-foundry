# Allowlist

The allowlist is the product. Everything else is a pipeline. Sole source: [`allowlist.yaml`](../allowlist.yaml). The factory and the clock parse that file.

## Waves

| Wave | Who | Sandbox | Human freeze |
|---|---|---|---|
| 0 | Repos we own (`orca-fleet`, `frontguard`) | Host worktree | First 20 factory-wide, then mechanical if policy allows |
| 1 | AI-welcome or behaviorally open, small blast radius | E2B | Always |
| 2 | Adjacent (Mastra, OpenHands) | E2B | Always + HUMAN/DCO holds |

`aiPolicy` values: `owner`, `welcome` (documented), `undocumented-open` (behaviorally open, no written external-AI policy — higher risk), `human-required`, `unknown`, `forbidden`.

## Current roster

### Wave 0 — dogfood

- `ravidsrk/orca-fleet` — [orca-fleet#70](https://github.com/ravidsrk/orca-fleet/pull/70) and [orca-fleet#72](https://github.com/ravidsrk/orca-fleet/pull/72) **merged** (attested 2/2).
- `ravidsrk/frontguard` — [frontguard#196](https://github.com/ravidsrk/frontguard/pull/196) **merged** 2026-08-28.

### Wave 1 — low-risk external

- `ColeMurray/background-agents` — OpenInspect. `aiPolicy: undocumented-open` (CONTRIBUTING/AGENTS/CLAUDE have no external-AI policy; behavior is open). [#1476](https://github.com/ColeMurray/background-agents/issues/1476) → [ColeMurray#1652](https://github.com/ColeMurray/background-agents/pull/1652) (open **draft**, verbatim disclosure, packet **`followed-up`**). Fork rehearsal [ravidsrk/background-agents#1](https://github.com/ravidsrk/background-agents/pull/1) closed.
- `github/awesome-copilot` — JavaScript tooling / Markdown catalog, tiny diffs. Documented agent welcome. No named first issue; tick idles rather than inventing one.
- `e2b-dev/e2b-cookbook` — docs/examples surface for the sandbox we depend on. Retargeted from `e2b-dev/E2B` after that repo lost `docs/` and SDK examples (E2B#1769). Policy unknown until CONTRIBUTING is fetched. Gate holds.
- `mcp-use/mcp-use` — policy unknown until CONTRIBUTING is fetched. Gate holds.
- `kortix-ai/suna` — same: unknown until parsed.

### Wave 2 — adjacent, slower

- `mastra-ai/mastra` — HeyCMO’s runtime. Human-required.
- `OpenHands/OpenHands` — org renamed from `All-Hands-AI/OpenHands`. No CONTRIBUTING.md; policy lives in the PR template (`HUMAN:`/`AGENT:` sections, end-to-end evidence — unit tests not sufficient) and the `ready-for-dev` issue-label prerequisite.

## Denylist (hard)

- `matplotlib/matplotlib` — autonomous-agent ban.
- `curl/curl` — maintainer request to stop agent noise.
- `pydantic/pydantic` — they welcome AI, but reserve the right to close PRs from authors mass-submitting across multiple repositories (spam) — i.e. the factory pattern — plus assignment-first auto-close.
- `stablyai/orca` — conflict of interest: it is the runtime Foundry runs on. Contribute through orca-fleet, not drive-by. CONTRIBUTING actually *requires* an AI review summary.

A denylist hit is `DENY_FORBIDDEN`. There is no override in the operator CLI.

## Adding a repo

1. Read `AGENTS.md` + `CONTRIBUTING` + last 20 closed PRs from strangers.
2. Confirm a maintainer has merged *some* external PR in 90 days.
3. Record `aiPolicy`, test command, caps, sandbox, preferred labels.
4. First issue must be named (number + title + url) before the clock may select the repo. No “we’ll find one later,” and no invented issue numbers.
5. PR against this repo’s `allowlist.yaml`. Freeze required.

## Removing a repo

Any of: maintainer ask, one revert of our patch (narrow: `git revert` of the merge commit or a maintainer-stated rollback naming the PR, within 30 days), merge rate < 40% after 3 terminal drafts, tone `cold` for two cycles, or a ban. Removal is immediate and logged on the scorecard.
