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

- `ColeMurray/background-agents` — OpenInspect. `aiPolicy: unknown` — no written AI policy anywhere (CONTRIBUTING, AGENTS.md, CLAUDE.md); behaviorally open — 250/408 non-owner PRs merged (61%), GitHub search `is:pr -author:ColeMurray`, measured 2026-08-29. [#1476](https://github.com/ColeMurray/background-agents/issues/1476) → [ColeMurray#1652](https://github.com/ColeMurray/background-agents/pull/1652) (open, **draft** since 2026-08-28). Fork rehearsal [ravidsrk/background-agents#1](https://github.com/ravidsrk/background-agents/pull/1) closed. **In flight.**
- `github/awesome-copilot` — docs catalog, tiny diffs. Documented AI-agent fast track in CONTRIBUTING (🤖🤖🤖 title marker). First issue named: [#2684](https://github.com/github/awesome-copilot/issues/2684) (skills/github-issues reference gaps — docs class).
- `e2b-dev/e2b-cookbook` — replaces `e2b-dev/E2B` (its docs/examples surface left that repo, E2B#1769). Genuinely silent: no CONTRIBUTING anywhere; the gate holds until upstream writes policy or the record turns affirmative. External merges current.
- `mcp-use/mcp-use` — policy unknown until CONTRIBUTING is fetched. Gate holds.

Removed 2026-08-28: `kortix-ai/suna` — its documented dev/test loop is gated on encrypted-secret access an outside contributor cannot run; external verification is impractical, so it leaves the roster (issue #12).

### Wave 2 — adjacent, slower

- `mastra-ai/mastra` — HeyCMO’s runtime. Human-required (assignment-first auto-close).
- `OpenHands/OpenHands` — org renamed from `All-Hands-AI`. No CONTRIBUTING.md: policy lives in the PR template (reserved `HUMAN:` section, `AGENT:` sections, "evidence that the code runs properly end-to-end. Just running unit tests is NOT sufficient") and issues must be labeled `ready-for-dev` before a PR. Docs only.

## Denylist (hard)

- `matplotlib/matplotlib` — autonomous-agent ban.
- `curl/curl` — maintainer request to stop agent noise.
- `pydantic/pydantic` — welcomes AI-assisted PRs; **reserves the right to close any PR at its discretion**, naming mass submission across repos as a case, and **auto-closes** PRs opened against an issue without being assigned first. Denied as a poor factory fit, not as anti-AI. Re-confirmed 2026-08-29 against pydantic's live `CONTRIBUTING.md` (§"AI policy" and the assignment rule); a round-2 review recorded this as unconfirmable, which was wrong. "Bans" overstated it by a notch and is corrected here — the deny reason in `allowlist.yaml` already carried the precise wording (issue #44 item 7).
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
