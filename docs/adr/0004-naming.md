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
   **spec publication** (ADR 0005): the spec and anything marketed externally must not ship under
   a name that resolves to Microsoft first. Until then, external surfaces say "Foundry
   (ravidsrk/oss-foundry)" where ambiguity could mislead.
2. **The scorecard rename ("standing") is deferred to the same gate.** Renaming the state field
   now would churn stored ledgers, the generated docs, and eight freshly-reviewed units for zero
   user-facing value today. Instead, every doc that introduces the concept carries a
   disambiguation line: *Foundry's scorecard is per-repo standing (merge rate, tone, halts) — it
   is unrelated to OpenSSF Scorecard, the security-health scanner.*

## Consequences

- Grep-ability preserved: "Foundry" and "scorecard" remain single, consistent tokens, so the
  eventual rename is mechanical.
- The spec milestone inherits a mandatory naming decision; ADR 0005 links here.
- The disclosure block is the one surface that hardens fastest; if external volume grows before
  the spec ships, this ADR must be revisited early.
