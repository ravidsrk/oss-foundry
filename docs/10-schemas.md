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
policyDocs        [{ name: AGENTS.md | CONTRIBUTING, chars, excerpt, truncated }] — the fetched
                  documents the verdict was computed from, kept so the freeze reads the words the
                  scanner parsed rather than a boolean (04-stations §3). `excerpt` is capped;
                  `chars` is always the true size and `truncated` is re-derived on load as
                  `excerpt.length < chars`. Absent when nothing was fetched, which is a different
                  fact from a document fetched and empty (`chars: 0`) and is displayed as one.
scout             ScoutScore
createdAt         Required STRING, ISO 8601 by convention but not by enforcement. `isPacket`
                  (`factory/state.ts:265`) checks `typeof === "string"` and nothing more, so the
                  format is not validated on load — and `migrateV6` (`factory/state.ts:356`) fills a
                  missing key from `updatedAt` or, failing that, the literal `"—"`. So a loadable
                  packet's timestamp may not be a timestamp at all. Do not parse these without
                  checking; a non-string IS refused.
updatedAt         Required the same way, with the same caveat (`factory/state.ts:357`). Written on
                  every status bump.
humanAttest       { by, at, note }  required before implement on Wave 1+
evidence          EvidenceManifest
prBody
prUrl
prMeta            { url, title, draft, state, merged, mergeable, commits, reviewComments, issueComments, headSha, updatedAt, syncedAt,
                    baseRef?, mergeCommitSha?, mergedAt?, humanReview?: { reviews, comments } }
                  `humanReview` ABSENT means the review endpoints were not read — never "nobody reviewed it".
                  `reviewComments` is GitHub's own total: it counts bots, so it is a record, not the KPI.
followUps         [{ id, at, kind: review-reply|bot-reconcile|quiet|ci|note, body, url? }]
parkReason        optional string. Why the engine parked the packet (policy denial, scope overflow,
                  …). `isPacket` accepts a string or absence.
sandboxSession
```

## PolicyVerdict.code

`ALLOW | DENY_FORBIDDEN | DENY_UNKNOWN_POLICY | HOLD_CLA | HOLD_HUMAN | HOLD_SCOPE`

## EvidenceManifest

SHA-bound. Copied from orca-fleet `runtime/evidence-manifest.md`:

- `baseSha`, `headSha`, `reviewedSha` (must equal head at draft)
- `testCommand`, `testExit`
- `negativeControl`: `red-on-revert` | `pending` | `failed` | `no-suite`
- `filesChanged`, `diffLines` vs repo caps
- `notes`

- `witness` (required for `draft-ready`): `{ provider: host|e2b|daytona, testExit, revertExit, testLogSha, revertLogSha, ranAt, repoId, baseSha, headSha, testLogPath, revertLogPath, toolchain? }` — the sandbox executed both runs itself; log hashes are sha256.
  - **Subject binding.** `repoId` / `baseSha` / `headSha` name the packet and range the witness was produced for. The gate refuses a witness whose subject is a different repo, or a different range than the manifest's own — so an ingested witness cannot be re-pointed at another packet.
  - **Provenance.** `provider` must be legal for the packet's repo: `host` only when `sandbox: host` **and** `wave: 0` (ADR 0003); `e2b` / `daytona` only when they equal that repo's declared `sandbox` in `allowlist.yaml` (ADR 0003 allows either at Wave 1+ — the per-repo choice is the allowlist's, not the ADR's). This is checked at the state-machine gate (`witnessProvenanceViolation`, consulted by both `applyAttachEvidence` and `evidenceIsReady`), not only inside the executor — a shape-valid `host` witness on a Wave-1 `e2b` repo is refused, in the same message class as the executor's own refusal.
  - **Toolchain (optional, advisory).** `toolchain` records what the `testCommand` actually resolved to on the machine that ran it — `"python3 3.14.7"`, `"npm 11.19.0"`. It answers the one question a maintainer cannot answer from their own checkout: *which* interpreter produced this exit 0. It is **never a gate**: absent on every witness produced before issue #41, absent whenever the tools reported no version, and a packet with no `toolchain` promotes exactly as before. The executor resolves it inside the clone (so a repo pinning `.python-version` / `.tool-versions` / `.nvmrc` is recorded by what *it* selects), through the same shell the test phases use — `witness-check` resolves through that same shell too, so the two cannot disagree **about the shell**. They can still disagree about the directory: the pre-flight resolves in the operator's working directory and the witness inside the clone, so a repo that pins its interpreter may legitimately part them, which is exactly why `toolchain` records what the run *actually* used rather than what the pre-flight predicted (docs/08-operations.md, "Witnessing on the host", states the same caveat).
  - It names the tool each segment of `testCommand` *invokes*, which is not always the interpreter underneath it: `npm test` records `npm`, never the `node` that runs the suite. For a Python repo naming `python3` the two coincide and the field answers the question above directly; for a JS repo it identifies the package manager and the runtime is left to the run log. Widening it would mean guessing at a runtime the command does not name, and a guess on an evidence page is the thing this field exists to replace.
  - `loadFactoryState`'s `isWitness` and `parseWitnessManifest` both validate it as an optional non-empty string, because `renderEvidencePage` interpolates it into a sentence the maintainer reads.
  - **Persisted logs.** `testLogPath` / `revertLogPath` are repo-root-relative paths to the two run logs the hashes cover, written under `docs/evidence/logs/<packetId>/`. That is enforced, not assumed: `witnessLogPathViolation` requires both to equal `witnessLogPaths(packetId)` exactly, checked in `parseWitnessManifest` before `attach-witness` reads anything off disk (a manifest is operator-supplied file content, so `../../../../etc/passwd` is refused before the read, not after) and again at the gate, where it completes subject binding — a witness whose repo and range bind correctly may still not name another packet's log directory. The evidence page prints the `shasum -a 256` line that recomputes them **and names the repository they are committed in**, since the maintainer the page is written for has their own checkout, not Foundry's. `attach-witness` re-reads both logs and refuses a manifest whose hashes do not match what is on disk.

A packet without `negativeControl=red-on-revert` (or `no-suite` on a repo that declares that exemption), real (non-placeholder) `baseSha` / `headSha`, and a `witness` whose `testExit` is 0, `revertExit` is non-zero (unless `no-suite`), provenance is legal for the repo, and subject matches the packet cannot enter `draft-ready`. The engine does not invent SHAs, and it does not take the operator's word for an exit code. Repos whose `testCommand` is a noop (`true`, `:`) MUST set `negativeControl: no-suite` and leave `firstIssues` empty (issue #112).

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

`conditions` must be non-empty exactly when `stance` is `conditional` — the loader refuses records that would silently drop conditions. It also refuses a `silent` record whose `quote` carries a derived figure (a ratio or a percentage): that quote is written by us and renders to the maintainer as their own words, so a measurement belongs in `allowlist.yaml`'s `policyNotes`, which names its method. A record is evidence, not an override: `aiPolicy` in the YAML remains the operator's call, and the
verdict carries the record (`PolicyVerdict.record`) so every gate decision is auditable back to a
quoted, dated source.
