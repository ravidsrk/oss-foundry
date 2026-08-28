# Schemas

## Task packet

```
id                pkt_{owner}_{repo}_{issue}
repoId            allowlist id
issueNumber
issueTitle
issueUrl
objective         one sentence
nonGoals          list
acceptance        list of checkable claims
abort             list of stop conditions
class             buildable | already-has-pr | needs-human | externally-resolved | out-of-scope | policy-denied
status            scouted → gated → frozen → approved → implementing → reviewing → draft-ready → submitted → followed-up | parked | rejected | merged
station           scout | policy | freeze | implement | review | draft | follow-up | terminal
lighting          lit
policy            PolicyVerdict
scout             ScoutScore
humanAttest       { by, at, note }  required before implement on Wave 1+
evidence          EvidenceManifest
prBody
prUrl
prMeta            { url, title, draft, state, merged, mergeable, commits, reviewComments, issueComments, headSha, updatedAt, syncedAt }
followUps         [{ id, at, kind: review-reply|bot-reconcile|quiet|ci|note, body, url? }]
sandboxSession
```

## PolicyVerdict.code

`ALLOW | DENY_FORBIDDEN | DENY_UNKNOWN_POLICY | HOLD_CLA | HOLD_HUMAN | HOLD_SCOPE`

## EvidenceManifest

SHA-bound. Copied from orca-fleet `runtime/evidence-manifest.md`:

- `baseSha`, `headSha`, `reviewedSha` (must equal head at draft)
- `testCommand`, `testExit`
- `negativeControl`: `red-on-revert` | `pending` | `failed`
- `filesChanged`, `diffLines` vs repo caps
- `notes`

A packet without `negativeControl=red-on-revert` and real (non-placeholder) `baseSha` / `headSha` cannot enter `draft-ready`. The engine does not invent SHAs.

## Allowlist repo

See `allowlist.yaml`. Required fields: `id`, `wave`, `aiPolicy`, `testCommand`, `maxFiles`, `maxDiffLines`, `sandbox`, `preferredLabels`. Optional: `language`, `policyNotes`, `firstIssues`. Wave 1+ should name at least one `firstIssues` entry before the clock may select them.

### `aiPolicy`

| Value | Meaning |
|---|---|
| `owner` | Repo we own. |
| `welcome` | **Documented** external-AI welcome (CONTRIBUTING/AGENTS says so). |
| `undocumented-open` | Behaviorally open, but no written external-AI-contribution policy. Higher risk than `welcome`. Fetch docs before freeze (same gate as `unknown`). |
| `human-required` | HUMAN:/CLA/DCO holds. |
| `unknown` | Not yet parsed. Deny until AGENTS.md / CONTRIBUTING is fetched. |
| `forbidden` | Treat as denylist. |

### Scorecard row

| Field | Meaning |
|---|---|
| `opened` | Drafts we opened. Volume only. |
| `merged` / `closedUnmerged` | Terminal outcomes. `staleClosed` is a subset of `closedUnmerged` (14 quiet days). |
| `reviewCommentsAvg` | Mean **human, non-bot** review comments over `humanReviewed` only. |
| `humanReviewed` | PRs with ≥1 human, non-bot review comment. |
| `noReview` | PRs with 0 human, non-bot review comments. Companion to the average. |
| `reverts` | `git revert` of our merge, or maintainer-stated rollback naming the PR, within 30 days. |
| `rework` | Post-merge edits. Informational; does not halt. |
