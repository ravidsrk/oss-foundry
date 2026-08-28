import { readFileSync, writeFileSync } from "node:fs";
import { seedState } from "./seed.ts";
import type { FactoryState } from "./types.ts";

const PACKET_STATUSES = new Set([
  "scouted",
  "gated",
  "frozen",
  "approved",
  "implementing",
  "reviewing",
  "draft-ready",
  "submitted",
  "followed-up",
  "merged",
  "parked",
  "rejected",
]);
const STATIONS = new Set([
  "scout",
  "policy",
  "freeze",
  "implement",
  "review",
  "draft",
  "follow-up",
  "terminal",
]);
const CLASSES = new Set([
  "buildable",
  "already-has-pr",
  "needs-human",
  "externally-resolved",
  "out-of-scope",
  "policy-denied",
]);
const TONES = new Set(["warm", "neutral", "cold", "banned"]);
const EVENT_KINDS = new Set([
  "tick",
  "gate",
  "freeze",
  "approve",
  "reject",
  "review",
  "draft",
  "sandbox",
  "score",
  "scout",
  "follow-up",
]);

function isPacket(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  const policy = o.policy as Record<string, unknown> | undefined;
  const scout = o.scout as Record<string, unknown> | undefined;
  return (
    typeof o.id === "string" &&
    typeof o.repoId === "string" &&
    Number.isInteger(o.issueNumber) &&
    typeof o.issueTitle === "string" &&
    typeof o.issueUrl === "string" &&
    typeof o.status === "string" &&
    PACKET_STATUSES.has(o.status) &&
    typeof o.station === "string" &&
    STATIONS.has(o.station) &&
    typeof o.class === "string" &&
    CLASSES.has(o.class) &&
    !!policy &&
    typeof policy.allow === "boolean" &&
    typeof policy.code === "string" &&
    !!scout &&
    typeof scout.total === "number"
  );
}

function isEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.at === "string" &&
    typeof o.kind === "string" &&
    EVENT_KINDS.has(o.kind) &&
    typeof o.message === "string"
  );
}

function isScorecardRow(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.repoId === "string" &&
    typeof o.opened === "number" &&
    typeof o.merged === "number" &&
    typeof o.reverts === "number" &&
    typeof o.maintainerTone === "string" &&
    TONES.has(o.maintainerTone)
  );
}

export function isFactoryState(value: unknown): value is FactoryState {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o.version === 6 &&
    Array.isArray(o.packets) &&
    o.packets.every(isPacket) &&
    Array.isArray(o.events) &&
    o.events.every(isEvent) &&
    Array.isArray(o.scorecard) &&
    o.scorecard.every(isScorecardRow) &&
    typeof o.ticksRun === "number" &&
    typeof o.mergedTotal === "number" &&
    typeof o.bans === "number" &&
    typeof o.humanApprovalsRemaining === "number" &&
    (o.lastTickAt === null || typeof o.lastTickAt === "string")
  );
}

export function loadFactoryState(
  path: string,
  seed: () => FactoryState = seedState,
): { ok: true; state: FactoryState; source: "file" | "seed" } | { ok: false; error: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, state: seed(), source: "seed" };
    return { ok: false, error: `cannot read ${path}: ${err instanceof Error ? err.message : "unreadable"}` };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isFactoryState(parsed)) {
      return {
        ok: false,
        error: `refusing to load ${path}: not a Foundry v6 state file. Fix or remove it; will not overwrite with seed.`,
      };
    }
    return { ok: true, state: parsed, source: "file" };
  } catch (err) {
    return {
      ok: false,
      error: `refusing to load ${path}: ${err instanceof Error ? err.message : "malformed JSON"}. Fix or remove it; will not overwrite with seed.`,
    };
  }
}

export function saveFactoryState(path: string, state: FactoryState): void {
  writeFileSync(path, JSON.stringify(state, null, 2));
}
