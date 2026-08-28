# Allowlist

The allowlist is the product. Everything else is a pipeline. Sole source: [`allowlist.yaml`](../allowlist.yaml). The factory and the clock parse that file.

## Waves

| Wave | Who | Sandbox | Human freeze |
|---|---|---|---|
| 0 | Repos we own (`orca-fleet`, `frontguard`) | Host worktree | First 20 factory-wide, then mechanical if policy allows |
| 1 | AI-welcome, small blast radius | E2B | Always |
| 2 | Adjacent (Mastra, OpenHands) | E2B | Always + HUMAN/DCO holds |

## Current roster

### Wave 0 — dogfood

- `ravidsrk/orca-fleet` — [orca-fleet#70](https://github.com/ravidsrk/orca-fleet/pull/70) and [orca-fleet#72](https://github.com/ravidsrk/orca-fleet/pull/72) **merged** (attested 2/2).
- `ravidsrk/frontguard` — [frontguard#196](https://github.com/ravidsrk/frontguard/pull/196) **merged** 2026-08-28.

### Wave 1 — low-risk external

- `ColeMurray/background-agents` — OpenInspect. `aiPolicy: unknown` — no written AI policy anywhere (CONTRIBUTING, AGENTS.md, CLAUDE.md); behaviorally open, 141/272 external PRs merged. [#1476](https://github.com/ColeMurray/background-agents/issues/1476) → [ColeMurray#1652](https://github.com/ColeMurray/background-agents/pull/1652) (open, **draft** since 2026-08-28). Fork rehearsal [ravidsrk/background-agents#1](https://github.com/ravidsrk/background-agents/pull/1) closed. **In flight.**
- `github/awesome-copilot` — docs catalog, tiny diffs. Documented AI-agent fast track in CONTRIBUTING. No named first issue; tick idles rather than inventing one.
- `e2b-dev/E2B` — the sandbox we depend on. Docs/examples surface moved to `e2b-dev/e2b-cookbook` (E2B#1769 removed in-repo examples, 2026-08-25); retarget tracked in issue 12.
- `mcp-use/mcp-use` — policy unknown until CONTRIBUTING is fetched. Gate holds.
- `kortix-ai/suna` — same: unknown until parsed.

### Wave 2 — adjacent, slower

- `mastra-ai/mastra` — HeyCMO’s runtime. Human-required (assignment-first auto-close).
- `OpenHands/OpenHands` — org renamed from `All-Hands-AI`. No CONTRIBUTING.md: policy lives in the PR template (reserved `HUMAN:` section, `AGENT:` sections, "evidence that the code runs properly end-to-end. Just running unit tests is NOT sufficient") and issues must be labeled `ready-for-dev` before a PR. Docs only.

## Denylist (hard)

- `matplotlib/matplotlib` — autonomous-agent ban.
- `curl/curl` — maintainer request to stop agent noise.
- `pydantic/pydantic` — welcomes AI-assisted PRs; bans mass submission across repos and unassigned PRs. Denied as a poor factory fit, not as anti-AI.
- `stablyai/orca` — no AI restriction upstream; denied for conflict of interest (it is the runtime Foundry rides). Contribute through orca-fleet.

A denylist hit is `DENY_FORBIDDEN`. There is no override in the operator CLI.

## Adding a repo

1. Read `AGENTS.md` + `CONTRIBUTING` + last 20 closed PRs from strangers.
2. Confirm a maintainer has merged *some* external PR in 90 days.
3. Record `aiPolicy`, test command, caps, sandbox, preferred labels.
4. First issue must be named (number + title + url) before the clock may select the repo. No “we’ll find one later,” and no invented issue numbers.
5. PR against this repo’s `allowlist.yaml`. Freeze required.

## Removing a repo

Any of: maintainer ask, one revert of our patch, merge rate < 40% after 3 opens with at least one terminal outcome (silence alone never halts), tone `cold` for two cycles, or a ban. Removal is immediate and logged on the scorecard.
