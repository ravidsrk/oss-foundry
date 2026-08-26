# Good-neighbor protocol

Maintainers do not owe us review. Foundry earns the next review by how the last one behaved.

## Rules (all of them are machine-checked or human-gated)

1. **Parse policy first.** `AGENTS.md`, `CONTRIBUTING.md`, `.github/CODEOWNERS`, CLA bot, issue templates. Unknown policy = deny, not “try it.”
2. **Allowlist only.** No GitHub search for random help-wanted.
3. **One in flight.** A tick no-ops if a packet is gated, approved, implementing, reviewing, or draft-ready.
4. **Draft PRs only.** Ready-for-review is a human action after CI is green.
5. **Disclose.** PR body states Foundry + human attest. No pretending to be a solo late-night hacker.
6. **Failing-first.** Test or repro is red before the fix exists. Revert must go red again.
7. **Scope caps.** Per-repo `maxFiles` and `maxDiffLines`. Overflow = park, don’t “just this once.”
8. **No competing PRs.** If upstream already has an open PR on the issue, assist or stand down. Alternative PR only if a maintainer invites it.
9. **Follow up.** A draft that ignores review threads is slop with extra steps. Follow up until merged, closed, or quiet.
10. **Stop when asked.** A single maintainer “please don’t” removes the repo from the allowlist the same day.

## Contribution decision (from oss-contribute)

For `already-has-pr`:

- Default posture: **complement, not compete.**
- Assist vs stand-down is a taste gate — log it, a human may veto.
- Unbidden alternative PRs have been rejected in a live run. Do not repeat that field lesson.

## Disclosure block (verbatim)

```
This patch was prepared by Foundry, an operator-gated contribution factory.
A human reviewed the packet, the diff, and the tests before this draft was opened.
The factory does not merge. Maintainers own the merge.
```

## Lighting

Every packet is `lit` by default: a reviewer who did not implement it reads the diff. `dark-eligible` is not used in Foundry v1/v2. Upstream is not our default branch.
