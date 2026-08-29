# Foundry

A gated OSS contribution factory: the control plane that decides whether a packet may exist. Orca / `oss-contribute` builds the patch. Foundry never merges.

## Language

**Packet**:
The unit of work for one allowlisted issue, from scout through follow-up or park.
_Avoid_: ticket, task, job, mission

**Allowlist**:
The only repos the factory may see, committed as `allowlist.yaml`.
_Avoid_: roster, catalog, target list

**Denylist**:
Repos the factory must refuse. Absolute; no operator override.
_Avoid_: blocklist, ban list (the scorecard tone `banned` is a halt reason, not this list)

**Wave**:
A trust tier on an allowlisted repo: `0` own, `1` AI-welcome external, `2` adjacent/human-required.

**Policy verdict**:
The deterministic gate result for a packet (`ALLOW`, `DENY_*`, `HOLD_*`). Grok does not vote.

**Freeze**:
The human attest that a packet may move from gate to implement. Nothing auto-freezes at any wave — there is no `autoFreeze` code path, and the first-20 counter is an odometer, not a gate that opens ([04-stations](docs/04-stations.md)).

**In-flight**:
A packet whose status is `gated`, `frozen`, `approved`, `implementing`, `reviewing`, `draft-ready`, or `submitted`. At most one. `followed-up`, `merged`, `parked`, and `rejected` are not in-flight.

**Draft**:
A GitHub pull request opened with `draft: true`. Ready-for-review is a human browser action after CI is green.

**Attest**:
The human freeze record `{ by, at, note }` required before implement on Wave 1+, and counted toward the first-20 freeze budget.

**Scorecard** (disambiguation): per-repo standing — merge rate, tone, reverts, halts. Unrelated to OpenSSF Scorecard, the security-health scanner (see ADR 0004).

**Scorecard halt**:
A per-repo stop when tone is `banned`, any revert of our patch, or opened ≥ 3 with at least one terminal outcome and merge rate < 40% (merge rate = merged / terminal outcomes; silence alone never halts). A halted repo is treated as unselectable until a human edits `allowlist.yaml`.

**Evidence**:
SHA-bound proof that tests ran and a revert goes red. A packet without `negativeControl=red-on-revert` and real SHAs cannot become `draft-ready`.
_Avoid_: logs, transcript (those are notes, not evidence)

**Clock**:
The 6h GitHub Action that validates the allowlist and verifies the **committed seed** against live
GitHub. It never reads `.foundry-state.json` (gitignored, absent in CI), so it guarantees the
published ledger, not the operator's in-flight work; promoting live state into the seed is a human
step, and `status` names the gap. It does not open contribution PRs.

**Factory halt**:
A durable, factory-wide stop written into the state record when a platform secondary rate limit
answers a draft creation (SPEC.md §6: halt, never retry). Every repo becomes unselectable until a
human runs `clear-halt`. Unrelated to a **scorecard halt**, which is per-repo and maintainer-driven.
