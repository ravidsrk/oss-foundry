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
 * GitHub treats `owner/repo` case-insensitively, so an operator or a live path can hand us casing
 * that does not match the YAML's. Every comparison of two repo ids goes through here so no two
 * halves of a gate can disagree about what "the same repo" means.
 *
 * The fold is ASCII-only because GitHub's is. `String.prototype.toLowerCase` applies full Unicode
 * case mapping, under which U+212A KELVIN SIGN lowercases to `k` — so `ravidsrK/orca-fleet` typed
 * with that character resolved to the roster's `ravidsrk/orca-fleet` and could be halted as it. It
 * fails safe (the homoglyph maps *onto* a roster entry, never off one, and `isDenied` folds the
 * same way), but it is still the wrong answer: that string is not a repository GitHub would serve
 * under this name, and a gate that says otherwise is describing a repo that does not exist.
 */
export function sameRepoId(a: string, b: string): boolean {
  return asciiFold(a) === asciiFold(b);
}

/** ASCII `A-Z` only — see `sameRepoId` for why the Unicode mapping is the wrong one here. */
function asciiFold(id: string): string {
  return id.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * Resolve a caller-supplied id to the roster's spelling — the boundary conversion.
 *
 * Case-insensitive *lookup* alone is not enough, and getting that wrong turned a loud fail-closed
 * into a silent fail-open. Round 1 normalized `repoById` only; every downstream store still keyed
 * on the raw string, so `halt "colemurray/background-agents"` found the roster row, reported
 * success and pushed `bans` to 1 while the scorecard row for `ColeMurray/background-agents` stayed
 * `tone=neutral health=good` and the in-flight packet was never parked — the operator's same-hour
 * stop (docs/PRODUCT.md:47, SPEC §7) silently did nothing. The same gap let
 * `maySelectRepo("RavidSrk/Orca-Fleet")` return `{ok:true}` for a repo whose scorecard says `stop`.
 *
 * So: convert once, at every entry point that takes an id from outside (`applyHalt`,
 * `buildPacket`), and store the canonical spelling. An id the roster does not know is returned
 * unchanged — an unlisted or denied repo keeps the id it arrived with, and the callers that must
 * refuse it still refuse it loudly (issue #44 item 10).
 */
export function canonicalRepoId(id: string): string {
  return repoById(id)?.id ?? id;
}

export function repoById(id: string): AllowlistedRepo | undefined {
  return ALLOWLIST.find((r) => sameRepoId(r.id, id));
}

export function isDenied(id: string): { id: string; reason: string } | undefined {
  return DENYLIST.find((d) => sameRepoId(d.id, id));
}

export function waveLabel(wave: Wave): string {
  if (wave === 0) return "Wave 0 · own";
  if (wave === 1) return "Wave 1 · allowlisted";
  return "Wave 2 · adjacent";
}
