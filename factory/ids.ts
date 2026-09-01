/**
 * Ledger event / follow-up ids (issue #88).
 *
 * THREE call sites used to mint these, and two of them already knew the collision class:
 * `engine.ts` appended `Math.random()`, `halt.ts` did not. Two halt events in the same
 * millisecond shared an id. The helper is the only door, so a fourth site cannot be written
 * clock-only.
 *
 * `${kind}_${ms}_${entropy}` — the clock names when, the entropy makes two-in-one-ms differ.
 * Kind is the prefix convention (`evt`, `fu`, `evt_halt`) so it has one home rather than three.
 */
export type LedgerIdKind = "evt" | "fu" | "evt_halt";

export function mintLedgerId(
  kind: LedgerIdKind,
  nowMs: number = Date.now(),
  entropy: number = Math.random(),
): string {
  // Map `[0, 1)` onto a 5-digit base-36 token. `Number.toString(36).slice(2, 7)` collapses
  // nearby fractions (and empty-slices `0`) back to clock-only, which is the defect.
  const span = 36 ** 5;
  const unit = ((entropy % 1) + 1) % 1;
  const token = Math.floor(unit * span).toString(36).padStart(5, "0");
  return `${kind}_${nowMs}_${token}`;
}
