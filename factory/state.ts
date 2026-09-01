import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
const NEGATIVE = new Set(["red-on-revert", "pending", "failed", "no-suite"]);
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

/**
 * The freeze reads these fields back and renders them to the operator as the maintainer's own
 * words, so the shape check is also a coherence check: `chars` is the document's TRUE size and
 * `excerpt` may be a prefix of it, which means `truncated` is not an independent fact but a
 * statement about the other two. A stored record claiming `truncated: false` over an excerpt
 * shorter than `chars` tells the approver they are reading the whole document when they are not,
 * and a non-integer size describes no document at all.
 */
function isPolicyDoc(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    Number.isInteger(o.chars) &&
    typeof o.excerpt === "string" &&
    // No separate `chars >= 0`: a string's length is never negative, so `excerpt.length <= chars`
    // already refuses every negative size. The clause could be deleted with the suite green, and a
    // guard that cannot fail is a guard a reader trusts for a reason that is not there.
    o.excerpt.length <= (o.chars as number) &&
    typeof o.truncated === "boolean" &&
    o.truncated === o.excerpt.length < (o.chars as number)
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
    typeof o.ranAt === "string" &&
    // Optional, because it is advisory and post-dates every witness in the committed seed. Still
    // validated — and non-empty, the same bar `parseWitnessManifest` holds an ingested manifest
    // to — because the evidence page interpolates it into a sentence for the maintainer, and
    // `toolchain: ""` renders as a claim about the run with the fact missing. The two validators
    // agreeing is also what makes docs/10-schemas.md's "both validate it as an optional non-empty
    // string" true; it was accepting `""` here.
    optional(o.toolchain, (v) => typeof v === "string" && v.length > 0)
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
    typeof o.syncedAt === "string" &&
    optional(o.baseRef, (v) => typeof v === "string") &&
    optional(o.mergeCommitSha, (v) => typeof v === "string") &&
    optional(o.mergedAt, (v) => typeof v === "string") &&
    // Absent is a fact here — "the review endpoints were not read" — so `humanReview` is optional.
    // What it must never be is present-but-unreadable: a malformed split read as zero would be an
    // invented `noReview`, which is the defect issue #39 exists to close.
    optional(o.humanReview, isHumanReview)
  );
}

function isHumanReview(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.reviews === "number" && typeof o.comments === "number";
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

/**
 * A packet id is a filesystem path component, so its FORMAT is a security property and not a
 * cosmetic one.
 *
 * `witnessLogPaths` builds `docs/evidence/logs/<packetId>/{test,revert}.log` by interpolation, and
 * `persistWitnessLogs` resolves that and writes it. Until this guard existed the only check on an id
 * was `typeof o.id === "string"`, so a hand-edited ledger carrying
 * `pkt_../../../../tmp/anything` produced an arbitrary write — and `witnessLogPathViolation` could
 * not catch it, because the path it compares against is derived from the same poisoned id.
 *
 * This is defence in depth, stated plainly rather than oversold: `docs/10-schemas.md` already
 * concedes that direct write access to the ledger is equivalent to operator control, so anyone who
 * can plant the id can also run the CLI. What it removes is the gap between "can edit a JSON file"
 * and "can write anywhere the process can reach", which are not the same capability.
 *
 * The shape is `idFor`'s output (`factory/packet.ts`): `pkt_<owner>_<repo>_<issue>`, where the repo
 * id's `/` becomes `_`. GitHub owner and repo names allow letters, digits, `-`, `_` and `.`, so the
 * class is deliberately no wider than that — and critically it contains no `/`, no `\`, no `..`
 * and no NUL, which is the whole point.
 */
const PACKET_ID = /^pkt_[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidPacketId(id: string): boolean {
  // `..` cannot appear even though `.` is legal in a repo name: a segment of dots is a traversal,
  // and no real owner/repo/issue triple produces one.
  return PACKET_ID.test(id) && !id.includes("..");
}

function isPacket(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    isValidPacketId(o.id) &&
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
    optional(o.policyDocs, (v) => Array.isArray(v) && v.every(isPolicyDoc)) &&
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
    typeof o.humanReviewComments === "number" &&
    typeof o.humanReviewedPrs === "number" &&
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
    (o.lastTickAt === null || typeof o.lastTickAt === "string") &&
    optional(o.halt, isHalt)
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
  // `reviewCommentsAvg` is derived from these two; a row that reaches `applyReviewToScorecard`
  // without them yields `undefined + n` — NaN, a KPI nothing downstream would refuse (issue #39).
  if (o.humanReviewComments === undefined) o.humanReviewComments = 0;
  if (o.humanReviewedPrs === undefined) o.humanReviewedPrs = 0;
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

/**
 * Write the ledger so an interrupted run cannot destroy it.
 *
 * This used to be one line — `writeFileSync(path, json)` — and that is a truncating write in place.
 * `open(O_TRUNC)` empties the file first, so a crash, a `SIGKILL`, a full disk or a laptop lid
 * between truncate and the last byte leaves valid-JSON-prefix garbage. The loader above then does
 * the right thing and REFUSES it, which is where the real cost lands: every verb goes through
 * `mustLoad`, so a half-written ledger takes out `status` too — the one command an operator would
 * reach for to find out what happened. There is no backup (see `backupFactoryState`, added
 * alongside this) and there was no documented recovery.
 *
 * Three steps, each load-bearing:
 *
 *  1. **Temp file in the SAME directory.** `rename` is only atomic within a filesystem; a temp in
 *     `os.tmpdir()` can be on a different device and fails with `EXDEV`, or silently degrades to a
 *     copy. The `.tmp-` prefix and the pid keep two concurrent writers from colliding on the name.
 *  2. **`flush: true`.** This is the part that is easy to leave out and useless to omit. Node's
 *     `writeFileSync` returns once the bytes reach the OS page cache, not the disk — the `flush`
 *     option (fsync under the hood) is what makes them durable, and its default is `false`. Without
 *     it the rename is atomic over data that a power loss can still take, so the ledger would
 *     survive `SIGKILL` and not survive the wall socket.
 *  3. **`renameSync` over the target, then fsync the DIRECTORY.** POSIX requires the rename to be
 *     atomic: a reader sees either the whole old file or the whole new one, never a mixture, and
 *     the destination name never disappears. The directory fsync is the part that is easy to
 *     forget and was: `flush` persists the file's bytes, not the directory entry that names them,
 *     so without it a crash after `renameSync` returns can still lose the rename and revert the
 *     ledger after a command reported success. On Windows Node's rename overwrites but the platform
 *     documents no atomicity guarantee, so this is strictly better there and not a promise there.
 *
 * The temp file is removed on a failed write so a crashed run does not leave litter beside the
 * ledger, and the original is left exactly as it was.
 */
/**
 * Persist the directory entry a `rename` just created.
 *
 * `flush: true` on the temp write makes the FILE's bytes durable; it says nothing about the
 * DIRECTORY that now names them. On a crash between `renameSync` returning and the filesystem
 * committing the directory entry, the rename can be lost — so the ledger reverts to its previous
 * contents, or the backup vanishes, after a command reported success. Fsyncing the containing
 * directory is what closes that, and it is the step the docblock below would otherwise have been
 * claiming without doing.
 *
 * Best effort by design. Some platforms and filesystems refuse `fsync` on a directory handle
 * (Windows has no equivalent notion), and there the rename is already as durable as the platform
 * offers. Failing the whole write because the extra guarantee is unavailable would trade a real
 * capability for a theoretical one.
 */
function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Platform does not support it; the rename stands on its own.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing useful to do with a failed close of a handle we only fsynced.
      }
    }
  }
}

export function saveFactoryState(path: string, state: FactoryState): void {
  const json = JSON.stringify(state, null, 2);
  const tmpPath = join(dirname(path), `.tmp-${basename(path)}.${process.pid}`);
  try {
    writeFileSync(tmpPath, json, { flush: true });
    renameSync(tmpPath, path);
    syncDirectory(dirname(path));
  } catch (err) {
    // Leave the target untouched and take the debris with us.
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Nothing useful to do: the original ledger is intact either way, and masking the real
      // failure below with a cleanup failure would be the worse trade.
    }
    throw err;
  }
}

/**
 * Copy the ledger to `<path>.bak` before a mutating run, so there is something to restore FROM.
 *
 * `saveFactoryState` above makes a torn write nearly impossible; it does not help with the other
 * ways a ledger is lost — a bad hand-edit, an `rm`, or a state the loader legitimately refuses
 * because the invariants really are violated. The recovery procedure in
 * `docs/08-operations.md` is written against this file.
 *
 * Deliberately ONE generation, not a rotation. Two files an operator must reason about under
 * pressure is worse than one, and the durable record of record is `factory/seed.ts` plus the
 * generated block in `docs/12-ledger.md` — this is a seatbelt for the working copy between
 * promotions, not an archive. Absent ledger is not an error: there is nothing to back up on the
 * first run.
 */
export function backupFactoryState(path: string): { ok: true; backup?: string } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true };
  const backup = `${path}.bak`;
  // Same atomic dance: a backup that can itself be torn is not a backup.
  const tmpPath = join(dirname(path), `.tmp-${basename(backup)}.${process.pid}`);
  try {
    writeFileSync(tmpPath, readFileSync(path), { flush: true });
    renameSync(tmpPath, backup);
    syncDirectory(dirname(backup));
    return { ok: true, backup };
  } catch (err) {
    // Take the debris. A failed backup that leaves a full-size staging copy beside the ledger turns
    // "could not make a backup" into "quietly filled the disk with them", one per mutating run —
    // and the operator never sees it, because a failed backup is a warning and not a refusal.
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Nothing useful to do, and the real error below is the one worth reporting.
    }
    return { ok: false, error: err instanceof Error ? err.message : "backup failed" };
  }
}
