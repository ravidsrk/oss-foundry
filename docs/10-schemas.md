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

- `witness` (required for `draft-ready`): `{ provider: host|e2b|daytona, testExit, revertExit, testLogSha, revertLogSha, ranAt }` — the sandbox executed both runs itself; log hashes are sha256. Trust boundary (recorded, by design): a caller with direct engine/state access can attach a shape-valid witness — that access is equivalent to editing the operator's state file; the CLI never constructs one except from an actual run.

A packet without `negativeControl=red-on-revert`, real (non-placeholder) `baseSha` / `headSha`, and a `witness` whose `testExit` is 0 and `revertExit` is non-zero cannot enter `draft-ready`. The engine does not invent SHAs, and it does not take the operator's word for an exit code.

## Allowlist repo

See `allowlist.yaml`. Required fields: `id`, `wave`, `aiPolicy`, `testCommand`, `maxFiles`, `maxDiffLines`, `sandbox`, `preferredLabels`. Optional: `setupCommand` — environment step the witness runs after clone (and re-runs after the between-phases clean), e.g. `npm ci`; without it, dependency-needing suites read as red-at-head and the witness refuses. It MUST be a clean-slate installer (`npm ci`, `pnpm install --frozen-lockfile`), never an incremental one — the between-phases `git clean` excludes `node_modules`, so the re-run of this command is what guarantees a fresh dependency tree. Optional: `policyNotes` — a free-text provenance note (why a policy value was chosen, dated). It is appended to the policy-scan blob, so keep it free of gate phrases. Optional: `disclosureTrailer` — `assisted-by` | `generated-by` | `pr-body-only` (default): the commit-disclosure convention the target follows; the evidence gate requires the matching trailer when set. Wave 1+ should name at least one `firstIssues` entry before the clock may select them.

## Policy record (`policy-records.json`)

One record per allowlisted repo; the validator refuses records for unlisted repos.

```
repoId       allowlist id
source       file the quote came from (e.g. CONTRIBUTING.md, .github/pull_request_template.md)
url          canonical link to the source
fetchedAt    date the source was read (staleness is visible, not hidden)
stance       forbidden | conditional | welcome | silent
conditions   e.g. assignment-first, human-template, labeled-issue, cla, dco
quote        ONE verbatim statement from the source (never spliced from separate lines; an explicit absence note for silent)
```

`conditions` must be non-empty exactly when `stance` is `conditional` — the loader refuses records that would silently drop conditions. A record is evidence, not an override: `aiPolicy` in the YAML remains the operator's call, and the
verdict carries the record (`PolicyVerdict.record`) so every gate decision is auditable back to a
quoted, dated source.
