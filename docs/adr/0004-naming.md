# ADR 0004 — Naming: "Foundry" and "scorecard"

## Status

Accepted (decision delegated to the operator loop, 2026-08-28; revisit gate below)

## Context

Field research (2026-08-28) found both core names already owned in the exact audiences this
project addresses:

- **Microsoft's Azure AI Foundry ships a product literally named "Foundry Control Plane",**
  marketed as "the governance and operations layer" for AI agents — same noun, same descriptor,
  same domain. Secondary collisions: Palantir Foundry, Foundry Digital, Foundry VTT, foundry.com
  (VFX), Paradigm's Ethereum toolchain.
- **"Scorecard" is owned by OpenSSF Scorecard** in the open-source-security community (~1M repos
  scanned weekly, CISA-endorsed) — the community whose trust this project needs most.

The disclosure block ships the project name to strangers on every external PR, so the rename cost
grows with every packet. Options considered: rename now; keep as a working name and decide at
spec publication; keep permanently.

## Decision

1. **"Foundry" stays as the working name** for the operator tool. The hard revisit gate is
   **external publication of the spec** (ADR 0005): the spec or anything marketed outside this
   repository must not ship under a name that resolves to Microsoft first. An in-repo draft may
   carry the working name with a provisional-naming notice. Effective with this ADR, the
   disclosure block — the fastest-hardening external surface — qualifies the name as
   "Foundry (ravidsrk/oss-foundry)" (`factory/neighbor.ts`).
2. **The scorecard rename ("standing") is deferred to the same gate — explicitly overriding the
   earlier recommendation** (issue #13 comment, 2026-08-28: "Option 2 + scorecard→standing now
   ... cheap, internal"). What changed between that comment and this ADR: the field now lives in
   operator state files (a load-fails-closed rename means a migration), in the generated ledger
   block, and across code that just cleared review — the "cheap" estimate predates all three. The
   value today is low relative to that churn, not zero: the live confusion risk is carried by
   disambiguation lines instead — *Foundry's scorecard is per-repo standing (merge rate, tone,
   halts), unrelated to OpenSSF Scorecard, the security-health scanner* — placed at the concept's
   first prominent use, not only at its definition.

## Consequences

- Grep-ability preserved: "Foundry" and "scorecard" remain single, consistent tokens, so the
  eventual rename is mechanical.
- The spec milestone inherits a mandatory naming decision; ADR 0005 links here.
- The disclosure block is the one surface that hardens fastest; if external volume grows before
  the spec ships, this ADR must be revisited early.
