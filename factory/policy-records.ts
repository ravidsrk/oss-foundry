import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PolicyRecord } from "./types.ts";

const STANCES = new Set(["forbidden", "conditional", "welcome", "silent"]);

/**
 * A derived measurement: a ratio (`141 of 272`, `141/272`) or a percentage (`61%`). Deliberately
 * narrow — an ISO date, a file path and a version number must all pass, because absence notes carry
 * them ("no CONTRIBUTING.md ... as of 2026-08-28").
 *
 * The two alternatives are written separately, and the `i` flag is why (issue #82). The first
 * pattern was `(?:\/|of)` under one case-sensitive expression, which failed in both directions at
 * once: `141 Of 272` walked through the guard because `of` matched lowercase only, and `docs/2026/08`
 * tripped it because a slash between two numbers was accepted anywhere at all — including inside a
 * path, which the comment above says must pass. Only the word needs the case fold, so only the word
 * gets it; the slash form is instead anchored to *not* be a path segment. That anchoring is the
 * whole difference between a ratio and a path: a ratio has whitespace or a sentence around it, a
 * path segment has another `/` on one side. Adjacent slashes are therefore the exclusion, which
 * also drops `2026/08/28` — a date written the other way — without needing to know it is a date.
 */
const RATIO_IN_WORDS = /\b\d[\d,]*\s*of\s*\d[\d,]*\b/i;
const RATIO_AS_SLASH = /(?<![/\w])\b\d[\d,]*\s*\/\s*\d[\d,]*\b(?![/\w])/;
const PERCENTAGE = /\b\d+(?:\.\d+)?\s*%/;

export function hasDerivedFigure(quote: string): boolean {
  return RATIO_IN_WORDS.test(quote) || RATIO_AS_SLASH.test(quote) || PERCENTAGE.test(quote);
}

export function policyRecordsPath(from = import.meta.url): string {
  return join(dirname(fileURLToPath(from)), "..", "policy-records.json");
}

export function parsePolicyRecords(text: string): Map<string, PolicyRecord> {
  const raw = JSON.parse(text) as {
    version?: unknown;
    records?: Record<string, Record<string, unknown>>;
  };
  if (raw.version !== 1) throw new Error(`policy-records.json: unsupported version ${raw.version}`);
  const out = new Map<string, PolicyRecord>();
  for (const [repoId, r] of Object.entries(raw.records ?? {})) {
    const stance = String(r.stance ?? "");
    if (!STANCES.has(stance)) throw new Error(`policy-records.json: ${repoId} bad stance ${stance}`);
    const source = String(r.source ?? "");
    const fetchedAt = String(r.fetchedAt ?? "");
    const quote = String(r.quote ?? "");
    if (!source || !fetchedAt || !quote) {
      throw new Error(`policy-records.json: ${repoId} needs source, fetchedAt, and quote`);
    }
    // A `silent` record's quote is the one we write ourselves — "the source says nothing" — and it
    // still renders on the maintainer-facing evidence page as their own words. A derived figure is
    // therefore the one thing it must never carry: `Behaviorally open: 141 of 272 external PRs
    // merged.` sat in this field putting an unreproducible measurement into a maintainer's mouth,
    // and nothing refused it. Measurements belong in `allowlist.yaml`'s `policyNotes`, which names
    // its method. Scoped to `silent` on purpose: a `welcome` / `conditional` / `forbidden` quote is
    // genuinely the maintainer's prose and may legitimately count something (issue #44 item 2,
    // docs/SPEC.md §3, docs/10-schemas.md).
    if (stance === "silent" && hasDerivedFigure(quote)) {
      throw new Error(
        `policy-records.json: ${repoId} is silent but its quote carries a derived figure — ` +
          `that quote renders as the maintainer's own words; measurements belong in allowlist.yaml policyNotes`,
      );
    }
    const conditions = Array.isArray(r.conditions) ? r.conditions.map((c) => String(c)) : [];
    if (stance === "conditional" && conditions.length === 0) {
      throw new Error(`policy-records.json: ${repoId} is conditional but names no conditions`);
    }
    if (stance !== "conditional" && conditions.length > 0) {
      throw new Error(`policy-records.json: ${repoId} has conditions but stance ${stance} never consults them`);
    }
    out.set(repoId, {
      repoId,
      source,
      url: String(r.url ?? ""),
      fetchedAt,
      stance: stance as PolicyRecord["stance"],
      conditions,
      quote,
    });
  }
  return out;
}

let cache: Map<string, PolicyRecord> | undefined;

export function policyRecordFor(repoId: string): PolicyRecord | undefined {
  if (!cache) cache = parsePolicyRecords(readFileSync(policyRecordsPath(), "utf8"));
  return cache.get(repoId);
}
