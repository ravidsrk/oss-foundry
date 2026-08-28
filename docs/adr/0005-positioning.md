# ADR 0005 — Positioning: the re-admission layer

## Status

Accepted (2026-08-28)

## Context

2026 field research: every commercial coding agent targets repos its operator controls; "agent
governance" products govern your agents on your systems; nobody ships guest-side,
pre-implementation gating against a target's own policy — while agents open policy files in 3.5%
of runs and comply with refuse/hand-off rules 0% of the time unaided (RepoComplianceBench,
arXiv 2607.26819), and burned projects (QEMU-class) are actively drafting how to safely re-admit
AI contributions. Maintainers will not pay (CodeRabbit gives them its product free); operators,
OSPOs, and agent vendors needing provable good citizenship might.

## Decision

Foundry's claim is **re-admission**, not throughput: the process a maintainer could require
before saying yes to agents again. Consequences of that claim, in order:

1. The protocol is worth more than the tool: publish it (docs/SPEC.md, v0) as the
   contributor-side counterpart to AGENTS.md, and prove it on documented-welcome repos first.
2. The artifact a maintainer consumes is the evidence page (policy quote, attest identity,
   witnessed runs, disclosure) — `cli.ts evidence-page` renders it; docs/evidence/ carries a
   real example.
3. Success metrics stay process-conditioned: bans 0, reverts 0, definitions and quotes that
   survive adversarial reads. Merge-rate targets remain (vision doc), but PR volume stays a
   vanity metric, never a KPI (docs/08-operations.md).

## Consequences

- Vision doc reframed; the spec inherits the ADR 0004 naming gate before external publication.
- The honesty posture — self-recorded misses, refused fabrications, verify-never-trust — is the
  moat and must survive every future feature.
