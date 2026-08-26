# ADR 0001 — Extend oss-contribute, do not replace Orca

## Status

Accepted

## Context

We considered Mastra, Temporal, OpenHands-as-orchestrator, and a greenfield Python factory.

## Decision

Foundry is a control plane. Execution stays in Orca + orca-fleet `oss-contribute`.

## Consequences

- Faster to an honest v1.
- Evidence protocol remains SHA-bound.
- We cannot hide from orca-fleet’s instruction-budget and proof-status rules — that is a feature.
