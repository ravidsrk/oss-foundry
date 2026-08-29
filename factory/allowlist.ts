import {
  assertAllowlist,
  loadAllowlistFile,
  type AllowlistCaps,
  type ParsedAllowlist,
} from "./load-allowlist.ts";
import type { AllowlistedRepo, Wave } from "./types.ts";

const parsed: ParsedAllowlist = loadAllowlistFile();
assertAllowlist(parsed);

export const CAPS: AllowlistCaps = parsed.caps;
export const DENYLIST: { id: string; reason: string }[] = parsed.denylist;
export const ALLOWLIST: AllowlistedRepo[] = parsed.repos;

/**
 * GitHub treats `owner/repo` case-insensitively, so a live path can hand us casing that does not
 * match the YAML's. `isDenied` already normalizes; this one compared raw strings, so the two halves
 * of the roster gate disagreed. The mismatch failed *closed* — an unmatched id is "not on the
 * allowlist" — so it was never exploitable, but a gate that holds only because live paths happen to
 * echo the file is a gate resting on an accident (issue #44 item 10). `maySelectRepo` still checks
 * `isDenied` before this, so the denylist keeps winning under any casing.
 */
export function repoById(id: string): AllowlistedRepo | undefined {
  const wanted = id.toLowerCase();
  return ALLOWLIST.find((r) => r.id.toLowerCase() === wanted);
}

export function isDenied(id: string): { id: string; reason: string } | undefined {
  return DENYLIST.find((d) => d.id.toLowerCase() === id.toLowerCase());
}

export function waveLabel(wave: Wave): string {
  if (wave === 0) return "Wave 0 · own";
  if (wave === 1) return "Wave 1 · allowlisted";
  return "Wave 2 · adjacent";
}
