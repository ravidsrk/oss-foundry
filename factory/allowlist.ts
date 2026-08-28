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

export function repoById(id: string): AllowlistedRepo | undefined {
  return ALLOWLIST.find((r) => r.id === id);
}

export function isDenied(id: string): { id: string; reason: string } | undefined {
  return DENYLIST.find((d) => d.id.toLowerCase() === id.toLowerCase());
}

export function waveLabel(wave: Wave): string {
  if (wave === 0) return "Wave 0 · own";
  if (wave === 1) return "Wave 1 · allowlisted";
  return "Wave 2 · adjacent";
}
