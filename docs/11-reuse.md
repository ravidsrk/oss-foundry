# Reuse of existing work

Foundry is a new repository so the control plane can version independently of the mission catalog. It does not fork orca-fleet.

## orca-fleet

| Piece | How Foundry uses it |
|---|---|
| `skills/oss-contribute` | Worker protocol. Definition of done still `CONTRIBUTED` / `CONTRIBUTED-WITH-PARKED`. |
| Evidence manifest | Copied as TypeScript types, same semantics. |
| Gate classification | Freeze is a one-way door. Taste gates are logged. |
| Attention budget | One in-flight packet. |
| Sandbox policy | `ro` / `rw` / `danger`. Danger only in E2B. |
| Proof status | Foundry’s own missions start `self-run` on Wave 0. |

Install: keep `oss-contribute` linked in Claude Code / Orca. Foundry emits packets; Orca executes them.

## frontguard

When a Wave 0/1 packet changes UI, attach a frontguard run as an extra oracle in `evidence.notes`. Do not make frontguard a required station for docs-only packets.

## HeyCMO / Mastra

Out of scope. Do not port Foundry into the marketing-agent monorepo.

## Grok / xAI

Not shipped as a scout overlay. Code patches still belong to the Orca worker model. Do not use Grok as the implementer.
