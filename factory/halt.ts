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
    id: `evt_halt_${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    kind: "score",
    message,
  };
}

/**
 * The halt on `state`, or `undefined` when the factory is running.
 *
 * `isFactoryState` does not validate this field, so a hand-edited or truncated record could be
 * anything. Read it fail-closed: anything present but unreadable still halts.
 */
export function factoryHalt(state: FactoryState): FactoryHalt | undefined {
  const raw: unknown = state.halt;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    return { at: "—", reason: "unreadable halt record in the ledger — clear it by hand", source: "secondary-rate-limit" };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.at !== "string" || typeof o.reason !== "string") {
    return { at: "—", reason: "unreadable halt record in the ledger — clear it by hand", source: "secondary-rate-limit" };
  }
  return {
    at: o.at,
    reason: o.reason,
    source: "secondary-rate-limit",
    repoId: typeof o.repoId === "string" ? o.repoId : undefined,
  };
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
