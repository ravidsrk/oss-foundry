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
status            scouted → gated → approved → implementing → reviewing → draft-ready → submitted → followed-up | parked | rejected | merged
                  (`frozen` is reserved in the union and never written — `approve` accepts it as a
                  source status, but packets go `gated` → `approved`. See 04-stations §3.)
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

- `witness` (required for `draft-ready`): `{ provider: host|e2b|daytona, testExit, revertExit, testLogSha, revertLogSha, ranAt, repoId, baseSha, headSha, testLogPath, revertLogPath }` — the sandbox executed both runs itself; log hashes are sha256.
  - **Subject binding.** `repoId` / `baseSha` / `headSha` name the packet and range the witness was produced for. The gate refuses a witness whose subject is a different repo, or a different range than the manifest's own — so an ingested witness cannot be re-pointed at another packet.
  - **Provenance.** `provider` must be legal for the packet's repo: `host` only when `sandbox: host` **and** `wave: 0` (ADR 0003); `e2b` / `daytona` only when they equal that repo's declared `sandbox` in `allowlist.yaml` (ADR 0003 allows either at Wave 1+ — the per-repo choice is the allowlist's, not the ADR's). This is checked at the state-machine gate (`witnessProvenanceViolation`, consulted by both `applyAttachEvidence` and `evidenceIsReady`), not only inside the executor — a shape-valid `host` witness on a Wave-1 `e2b` repo is refused, in the same message class as the executor's own refusal.
  - **Persisted logs.** `testLogPath` / `revertLogPath` are repo-root-relative paths to the two run logs the hashes cover, written under `docs/evidence/logs/<packetId>/`. That is enforced, not assumed: `witnessLogPathViolation` requires both to equal `witnessLogPaths(packetId)` exactly, checked in `parseWitnessManifest` before `attach-witness` reads anything off disk (a manifest is operator-supplied file content, so `../../../../etc/passwd` is refused before the read, not after) and again at the gate, where it completes subject binding — a witness whose repo and range bind correctly may still not name another packet's log directory. The evidence page prints the `shasum -a 256` line that recomputes them **and names the repository they are committed in**, since the maintainer the page is written for has their own checkout, not Foundry's. `attach-witness` re-reads both logs and refuses a manifest whose hashes do not match what is on disk.

A packet without `negativeControl=red-on-revert`, real (non-placeholder) `baseSha` / `headSha`, and a `witness` whose `testExit` is 0, `revertExit` is non-zero, provenance is legal for the repo, and subject matches the packet cannot enter `draft-ready`. The engine does not invent SHAs, and it does not take the operator's word for an exit code.

### Residual trust boundary (recorded, by design)

Direct write access to `.foundry-state.json` remains equivalent to operator control: someone who can edit that file can write any packet in any status, and no in-process check can stop them. What changed is that a *forged ledger* is no longer reachable through the normal engine API. Every path that promotes a packet — `applyAttachEvidence`, `evidenceIsReady`, `applyAdvance` — now cross-checks the witness's provider against the repo's gated sandbox and its subject against the packet, so the well-meaning operator who hits the Wave-1 refusal is pointed at `attach-witness`, not at hand-editing the ledger.

That is a narrower claim than it may read as, and the difference matters. **`attach-witness` cannot tell a witness produced on the worker host from one an operator wrote by hand.** Two log files and a manifest naming them, with no `E2B_API_KEY` anywhere and no ledger access at all, take a packet to `draft-ready` through the ordinary verb — every check the ingest path runs is a consistency check (does the manifest bind to this packet, this repo, this range; do the two digests match the bytes on disk; are the two runs distinguishable), not an attestation that the run happened. What the machinery buys is **falsifiability by the reader**: the evidence page names the exact files and the exact `shasum` line, so a maintainer who suspects a fabricated witness can check it against the range it claims to cover, and a fabricated one is a deliberate lie by a named human rather than a plausible mistake. It is not a proof of execution, and nothing in this repo should be read as offering one.

Three limits are deliberate and stated rather than papered over:

- The engine is pure and never touches the filesystem, so it verifies that a witness **references** its logs, not that the bytes are there. Recomputation happens in `attach-witness` (`verifyWitnessLogs`) and, for the reader, in the `shasum` line on the evidence page.
- The two digests must differ. Identical `testLogSha` / `revertLogSha` means the green and red runs produced byte-identical output — for a repo whose `testCommand` prints nothing, `e3b0c442…` offered twice — so the gate refuses it as a negative control that controls for nothing. That is a floor, not a guarantee the outputs are meaningful.
- `loadFactoryState`'s `isWitness` still validates shape only. Shape validation cannot detect a lie; that is the gate's job, and a legacy witness that predates subject binding loads fine and is then refused at the gate rather than silently promoted.

## Allowlist repo

See `allowlist.yaml`. Required fields: `id`, `wave`, `aiPolicy`, `testCommand`, `maxFiles`, `maxDiffLines`, `sandbox`, `preferredLabels`. Optional: `setupCommand` — environment step the witness runs after clone (and re-runs after the between-phases clean), e.g. `npm ci`; without it, dependency-needing suites read as red-at-head and the witness refuses. It MUST be a clean-slate installer (`npm ci`, `pnpm install --frozen-lockfile`), never an incremental one — the between-phases `git clean` excludes `node_modules`, so the re-run of this command is what guarantees a fresh dependency tree. Optional: `policyNotes` — a free-text provenance note (why a policy value was chosen, dated). It is appended to the policy-scan blob, so keep it free of gate phrases. Optional: `disclosureTrailer` — `assisted-by` | `generated-by` | `pr-body-only` (default): the commit-disclosure convention the target follows; the evidence gate requires the matching trailer when set. Wave 1+ should name at least one `firstIssues` entry before the clock may select them.

## Factory state (`.foundry-state.json`)

`version: 6`, plus `packets`, `events`, `scorecard`, `ticksRun`, `lastTickAt`, `mergedTotal`,
`bans`, `humanApprovalsRemaining`, and:

```
halt?        { at, reason, source: "secondary-rate-limit", repoId? }
```

A durable, factory-wide stop (SPEC.md §6). While it is set, `maySelectRepo` refuses every repo, so
tick, approve, and open-draft all stop; only `clear-halt` removes it. `isFactoryState` validates
`halt` like every other field, so a halt record present but unreadable makes the whole ledger
refuse to load — no command runs at all until a human fixes the file, which is stricter than
letting an unreadable record through and re-reading it defensively. Distinct from `bans`, which
counts maintainer asks.

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
