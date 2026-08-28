import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PolicyRecord } from "./types.ts";

const STANCES = new Set(["forbidden", "conditional", "welcome", "silent"]);

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
