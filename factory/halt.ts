import { mintLedgerId } from "./ids.ts";
import type { FactoryEvent, FactoryHalt, FactoryState } from "./types.ts";

/**
 * SPEC.md §6: "a platform secondary rate limit MUST halt the factory, never retry."
 *
 * A printed banner is not a halt — it dies with the process, and the next `open-draft` a minute
 * later makes exactly the AUP-violating retry the rule exists to prevent. The halt is therefore
 * written into the ledger and read back by `maySelectRepo`, so it outlives the run that hit the
 * limit. It halts the *factory*, not the repo: a secondary limit is a limit on the operator's
 * account, so moving to a different allowlisted repo would be the same retry.
 *
 * Scorecard tone `banned` is deliberately not reused — `bans` counts maintainer asks
 * (docs/08-operations.md) and a platform throttle is not a maintainer saying stop.
 */
export const SECONDARY_LIMIT_BANNER = "=== FACTORY HALT SIGNAL — secondary rate limit ===";

function ev(message: string): FactoryEvent {
  return {
    id: mintLedgerId("evt_halt"),
    at: new Date().toISOString(),
    kind: "score",
    message,
  };
}

/**
 * The halt on `state`, or `undefined` when the factory is running.
 *
 * This reads the field, it does not re-derive it. `isFactoryState` validates `halt` the same way
 * it validates every other field, so a hand-edited or truncated record makes `loadFactoryState`
 * refuse the ledger outright — stricter than reading it defensively here, and the same
 * validate-at-load / trust-after contract the rest of the record follows.
 */
export function factoryHalt(state: FactoryState): FactoryHalt | undefined {
  return state.halt;
}

export function applySecondaryLimitHalt(
  state: FactoryState,
  input: { repoId: string; at?: string; detail?: string },
): FactoryState {
  const at = input.at ?? new Date().toISOString();
  const detail = input.detail ? ` ${input.detail}` : "";
  const halt: FactoryHalt = {
    at,
    reason: `GitHub secondary rate limit while opening a draft on ${input.repoId}.${detail} Never retry — a human clears this with \`clear-halt\`.`,
    source: "secondary-rate-limit",
    repoId: input.repoId,
  };
  return {
    ...state,
    halt,
    events: [ev(`FACTORY HALT (${halt.source}): ${halt.reason}`), ...state.events].slice(0, 80),
  };
}

export function clearFactoryHalt(state: FactoryState, by: string, note: string): FactoryState {
  const previous = factoryHalt(state);
  if (!previous) return state;
  const rest = { ...state };
  delete rest.halt;
  return {
    ...rest,
    events: [
      ev(`Factory halt from ${previous.at} cleared by ${by}: ${note || "no note"}`),
      ...state.events,
    ].slice(0, 80),
  };
}
