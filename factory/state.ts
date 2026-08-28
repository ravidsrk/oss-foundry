import { readFileSync, writeFileSync } from "node:fs";
import { CAPS } from "./allowlist.ts";
import { seedState } from "./seed.ts";
import { inflightCount, type FactoryState } from "./types.ts";

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
const POLICY_CODES = new Set([
  "ALLOW",
  "DENY_FORBIDDEN",
  "DENY_UNKNOWN_POLICY",
  "HOLD_CLA",
  "HOLD_HUMAN",
  "HOLD_SCOPE",
]);
const LIGHTING = new Set(["lit"]);
const NEGATIVE = new Set(["red-on-revert", "pending", "failed"]);
const SANDBOX_KINDS = new Set(["host", "e2b", "daytona"]);
const SANDBOX_STATUSES = new Set([
  "dry-run",
  "booting",
  "ready",
  "executing",
  "harvested",
  "destroyed",
]);
const FOLLOWUP_KINDS = new Set(["review-reply", "bot-reconcile", "quiet", "ci", "note"]);
const PR_STATES = new Set(["open", "closed"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function optional(value: unknown, check: (v: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

function isPolicy(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.allow === "boolean" &&
    typeof o.code === "string" &&
    POLICY_CODES.has(o.code) &&
    isStringArray(o.reasons) &&
    isStringArray(o.matchedPhrases)
  );
}

function isScout(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  const parts = o.parts as Record<string, unknown> | undefined;
  return (
    typeof o.total === "number" &&
    !!parts &&
    typeof parts.wave === "number" &&
    typeof parts.labels === "number" &&
    typeof parts.size === "number" &&
    typeof parts.freshness === "number"
  );
}

function isEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.baseSha === "string" &&
    typeof o.headSha === "string" &&
    typeof o.testCommand === "string" &&
    typeof o.testExit === "number" &&
    typeof o.negativeControl === "string" &&
    NEGATIVE.has(o.negativeControl) &&
    typeof o.filesChanged === "number" &&
    typeof o.diffLines === "number" &&
    isStringArray(o.notes) &&
    optional(o.reviewedSha, (v) => typeof v === "string") &&
    optional(o.shaVerified, (v) => typeof v === "boolean") &&
    optional(o.witness, isWitness)
  );
}

function isWitness(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    (o.provider === "host" || o.provider === "e2b" || o.provider === "daytona") &&
    typeof o.testExit === "number" &&
    typeof o.revertExit === "number" &&
    typeof o.testLogSha === "string" &&
    /^[0-9a-f]{64}$/.test(o.testLogSha) &&
    typeof o.revertLogSha === "string" &&
    /^[0-9a-f]{64}$/.test(o.revertLogSha) &&
    typeof o.ranAt === "string"
  );
}

function isAttest(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.by === "string" && typeof o.at === "string" && typeof o.note === "string";
}

function isPrMeta(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.url === "string" &&
    typeof o.title === "string" &&
    typeof o.draft === "boolean" &&
    typeof o.state === "string" &&
    PR_STATES.has(o.state) &&
    typeof o.merged === "boolean" &&
    typeof o.mergeable === "string" &&
    typeof o.commits === "number" &&
    typeof o.reviewComments === "number" &&
    typeof o.issueComments === "number" &&
    typeof o.headSha === "string" &&
    typeof o.updatedAt === "string" &&
    typeof o.syncedAt === "string"
  );
}

function isFollowUp(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.at === "string" &&
    typeof o.kind === "string" &&
    FOLLOWUP_KINDS.has(o.kind) &&
    typeof o.body === "string" &&
    optional(o.url, (v) => typeof v === "string")
  );
}

function isSandbox(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.provider === "string" &&
    SANDBOX_KINDS.has(o.provider) &&
    typeof o.id === "string" &&
    typeof o.status === "string" &&
    SANDBOX_STATUSES.has(o.status) &&
    typeof o.image === "string" &&
    Array.isArray(o.commands) &&
    o.commands.every((cmd) => {
      if (!cmd || typeof cmd !== "object") return false;
      const c = cmd as Record<string, unknown>;
      return typeof c.cmd === "string" && typeof c.exit === "number" && typeof c.at === "string";
    })
  );
}

function isPacket(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.repoId === "string" &&
    Number.isInteger(o.issueNumber) &&
    typeof o.issueTitle === "string" &&
    typeof o.issueUrl === "string" &&
    typeof o.objective === "string" &&
    isStringArray(o.nonGoals) &&
    isStringArray(o.acceptance) &&
    isStringArray(o.abort) &&
    typeof o.status === "string" &&
    PACKET_STATUSES.has(o.status) &&
    typeof o.station === "string" &&
    STATIONS.has(o.station) &&
    typeof o.class === "string" &&
    CLASSES.has(o.class) &&
    typeof o.lighting === "string" &&
    LIGHTING.has(o.lighting) &&
    typeof o.createdAt === "string" &&
    typeof o.updatedAt === "string" &&
    isPolicy(o.policy) &&
    isScout(o.scout) &&
    optional(o.humanAttest, isAttest) &&
    optional(o.evidence, isEvidence) &&
    optional(o.prBody, (v) => typeof v === "string") &&
    optional(o.prUrl, (v) => typeof v === "string") &&
    optional(o.prMeta, isPrMeta) &&
    optional(o.followUps, (v) => Array.isArray(v) && v.every(isFollowUp)) &&
    optional(o.parkReason, (v) => typeof v === "string") &&
    optional(o.sandboxSession, isSandbox)
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
    typeof o.closedUnmerged === "number" &&
    typeof o.reviewCommentsAvg === "number" &&
    typeof o.noReview === "number" &&
    typeof o.reverts === "number" &&
    typeof o.maintainerTone === "string" &&
    TONES.has(o.maintainerTone) &&
    typeof o.lastTouch === "string"
  );
}

/**
 * A durable factory halt (SPEC.md §6). Validated like every other field: a hand-edited or
 * truncated halt record makes the whole ledger refuse to load, which is stricter than reading it
 * defensively — the operator cannot run any command until they fix the file by hand.
 */
function isHalt(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.at === "string" &&
    typeof o.reason === "string" &&
    o.source === "secondary-rate-limit" &&
    optional(o.repoId, (v) => typeof v === "string")
  );
}

export function isFactoryState(value: unknown): value is FactoryState {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o.version === 6 &&
    optional(o.halt, isHalt) &&
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

function migratePacket(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const o = { ...(value as Record<string, unknown>) };
  if (o.objective === undefined) o.objective = "";
  if (o.nonGoals === undefined) o.nonGoals = [];
  if (o.acceptance === undefined) o.acceptance = [];
  if (o.abort === undefined) o.abort = [];
  if (o.lighting === undefined) o.lighting = "lit";
  if (o.createdAt === undefined) o.createdAt = typeof o.updatedAt === "string" ? o.updatedAt : "—";
  if (o.updatedAt === undefined) o.updatedAt = typeof o.createdAt === "string" ? o.createdAt : "—";
  if (o.policy && typeof o.policy === "object") {
    const policy = { ...(o.policy as Record<string, unknown>) };
    if (policy.reasons === undefined) policy.reasons = [];
    if (policy.matchedPhrases === undefined) policy.matchedPhrases = [];
    o.policy = policy;
  }
  if (o.scout && typeof o.scout === "object") {
    const scout = { ...(o.scout as Record<string, unknown>) };
    if (scout.parts === undefined) {
      scout.parts = { wave: 0, labels: 0, size: 0, freshness: 0 };
    }
    o.scout = scout;
  }
  if (o.evidence && typeof o.evidence === "object") {
    const evidence = { ...(o.evidence as Record<string, unknown>) };
    if (evidence.notes === undefined) evidence.notes = [];
    if (evidence.negativeControl === undefined) evidence.negativeControl = "pending";
    if (evidence.filesChanged === undefined) evidence.filesChanged = 0;
    if (evidence.diffLines === undefined) evidence.diffLines = 0;
    if (evidence.testCommand === undefined) evidence.testCommand = "";
    if (evidence.testExit === undefined) evidence.testExit = 1;
    o.evidence = evidence;
  }
  return o;
}

function migrateScorecard(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const o = { ...(value as Record<string, unknown>) };
  if (o.closedUnmerged === undefined) o.closedUnmerged = 0;
  if (o.reviewCommentsAvg === undefined) o.reviewCommentsAvg = 0;
  if (o.noReview === undefined) o.noReview = 0;
  if (o.reverts === undefined) o.reverts = 0;
  if (o.lastTouch === undefined) o.lastTouch = "—";
  return o;
}

/** Fill fields added after v6 shipped. Wrong types are left in place so validation still refuses them. */
export function migrateV6(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const o = { ...(value as Record<string, unknown>) };
  if (Array.isArray(o.packets)) o.packets = o.packets.map(migratePacket);
  if (Array.isArray(o.scorecard)) o.scorecard = o.scorecard.map(migrateScorecard);
  return o;
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
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 6) {
      return {
        ok: false,
        error: `refusing to load ${path}: not a Foundry v6 state file. Fix or remove it; will not overwrite with seed.`,
      };
    }
    const migrated = migrateV6(parsed);
    if (!isFactoryState(migrated)) {
      return {
        ok: false,
        error: `refusing to load ${path}: not a Foundry v6 state file. Fix or remove it; will not overwrite with seed.`,
      };
    }
    // Shape validation above says nothing about doctrine: a hand-edited or drifted file can still
    // describe more packets in flight than CAPS.in_flight allows. The one-packet-in-flight
    // invariant is the doctrine's central throttle (issue #34) — fail closed rather than load it.
    const inflight = inflightCount(migrated.packets);
    if (inflight > CAPS.in_flight) {
      return {
        ok: false,
        error: `refusing to load ${path}: ${inflight} packets are in flight but CAPS.in_flight is ${CAPS.in_flight} — the one-packet-in-flight invariant is violated. Fix or remove it; will not overwrite with seed.`,
      };
    }
    return { ok: true, state: migrated, source: "file" };
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
