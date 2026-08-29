# The Foundry Protocol — v0 (draft spec)

An implementation-neutral protocol for **re-admissible** AI-agent contributions to open-source
repositories: the process a maintainer could require before saying yes to agents again. Extracted
from the reference implementation in this repository (ravidsrk/oss-foundry). **In-repo draft;
not yet published externally** — the name gates on ADR 0004 before any external publication.
MUST/SHOULD/MAY are RFC-2119-style.

## 1. Scope

Governs a *contributor-side* operator sending agent-prepared changes to repositories the operator
does **not** control. It does not govern agents on the operator's own repositories, and it never
grants the operator any merge authority.

## 2. Roster

- The operator MUST maintain an explicit allowlist of target repositories; anything unlisted
  MUST be invisible to automation. A denylist MUST be absolute, with no automated override.
- Each entry MUST carry per-repo scope caps (max files, max changed lines) and a test command.
- Automation MUST NOT select a repository without a human-named first issue (number + title +
  URL). Inventing work is non-conformant.

## 3. Policy records

- Before any work, the target's own contribution policy MUST be parsed. Unknown policy MUST deny.
- Parsed policy MUST be recorded as a committed, auditable record: source path, canonical URL,
  fetch date, structured stance (forbidden | conditional | welcome | silent), conditions, and
  **one verbatim quote** (never spliced). A silent record ("parsed, found nothing") MUST NOT
  satisfy parse-policy-first for an unknown repository — absence is re-verified live.
- A forbidden stance MUST deny regardless of patch quality; a human signature does not cure an
  AI ban.

## 4. Freeze (human attestation)

- A human MUST approve each unit of work before implementation begins, and the approval record
  MUST carry a real identity and timestamp.
- The approval step MUST re-check for competing upstream work (closing-keyword PRs, PRs the
  issue's timeline links, plain mentions, issue-numbered branches) and MUST stand down on a
  competitor rather than proceed.

## 5. Witnessed evidence

- Completion claims MUST be machine-witnessed, never operator-attested: the sandbox itself runs
  the test command at the head commit (MUST be green) and re-runs it with the non-test production
  change reverted to base (MUST be red — the negative control).
- The evidence manifest MUST bind to real commit SHAs (base an ancestor of head), record both
  exit codes and content hashes of both logs, and match the compared range's file/line scope.
  Scope over the repo's caps MUST park the unit, not proceed.
- Untrusted repositories MUST NOT execute on the operator's machine; an execution environment
  that is unavailable MUST refuse ("dry-run"), never fabricate success.

## 6. Contact

- Pull requests MUST open as drafts. Marking ready-for-review MUST be a human act after CI is
  green. The tool MUST NOT expose a merge capability; maintainers own the merge.
- The PR body MUST disclose the operator-gated, agent-prepared nature of the change and the human
  review, verbatim and unabridged. Commits MUST carry the target's disclosure convention
  (e.g. kernel `Assisted-by:`, ASF `Generated-by:`) when it has one; the agent MUST NOT emit
  `Signed-off-by` and MUST NOT appear in `Co-authored-by` (Git reads that trailer as a person).
- At most one unit in flight per operator, including submitted-and-unreviewed drafts. A
  platform secondary rate limit MUST halt the factory, never retry.

## 7. Follow-up and standing

- A submitted draft MUST be followed until merged, closed, or quiet: review threads answered,
  bots reconciled. Once threads are answered and the PR has been quiet ≥14 days, the in-flight
  slot MAY release while follow-up duties continue; new maintainer activity re-blocks new work
  until answered — unless a newer packet already holds the in-flight slot, in which case the older
  packet keeps its follow-up duty and records a reply owed rather than blocking the newer work. At
  ≥45 quiet days the operator SHOULD close politely; closing is a human act.
- Per-repo standing MUST be tracked from terminal outcomes (merge rate over terminal outcomes;
  silence alone never halts) and MUST halt a repository on: a maintainer ask (same hour), any
  revert of the operator's patch, or sustained sub-threshold merge rate with terminal outcomes.
- The committed ledger MUST be reconcilable against the platform's live state; divergence is a
  doctrine event surfaced to a human, never silently rewritten.

## 8. Conformance

An implementation conforms when every MUST above is machine-enforced or human-gated with an
auditable record, and when its ledger — statuses, attestations, evidence, and quotes — survives
an adversarial read against the platform's own record. The reference implementation's test suite
and blind-review protocol are one acceptable demonstration.

## 9. Rationale (non-normative)

§8's split is not arbitrary: agents open a repository's separate policy file in 3.5% of runs (12
of 347 non-anchor runs) and comply with refuse/hand-off rules 0% of the time unaided
(RepoComplianceBench, arXiv 2607.26819). That 3.5% excludes AGENTS.md — auto-loaded by the
benchmark harness and the one file agents reliably do see — and counts only whether an agent goes
on to read a further file (CONTRIBUTING.md or the PR template); the framing sharpens, not
weakens, the case for control outside the agent. On enforcing refuse and hand-off rules, the
benchmark's own conclusion is direct: "A project that means them must place the control outside
the agent: a CI check that blocks the merge, a required human review, or a bot that closes
AI-authored pull requests." That is exactly the machine-enforced or human-gated split §8
requires.
