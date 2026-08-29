import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EvidenceWitness, SandboxKind, Wave } from "./types.ts";

/**
 * A witness step is one of: "git" (args passed to git), "run-tests@head" / "run-tests@revert"
 * (args[0] is the repo's test command, executed by the runner), "cleanup" (args[0] is a scratch
 * dir). The runner seam is what makes the protocol testable without a network or a shell.
 */
export type WitnessStep = "git" | "run-setup" | "run-tests@head" | "run-tests@revert" | "cleanup";
export type WitnessRunner = (
  step: WitnessStep,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ exit: number; output: string }>;

/** The two run logs, returned so the caller can persist them at the paths the witness declares. */
export interface WitnessLogs {
  test: string;
  revert: string;
}

export type WitnessOutcome =
  | { ok: true; witness: EvidenceWitness; logs: WitnessLogs }
  | { ok: false; error: string };

/** An externally produced witness plus the command it ran — the `attach-witness` ingest format. */
export interface IngestedWitness {
  witness: EvidenceWitness;
  testCommand: string;
  notes: string[];
}

/** Where a packet's run logs live, relative to the repo root. Committed beside the evidence page. */
export const WITNESS_LOG_ROOT = "docs/evidence/logs";

/**
 * How an operator actually runs the ingest verb. `package.json` is `private: true` with no `bin`,
 * so `foundry` is an npm script name, not a command on anyone's PATH — every pointer in this repo
 * spells the real invocation (docs/05-v1.md, docs/08-operations.md, factory/README.md). A refusal
 * that names a command the operator cannot type is the defect issue #35 was filed against.
 */
export const INGEST_INVOCATION = "node --experimental-strip-types factory/cli.ts attach-witness";

export function witnessLogPaths(packetId: string): {
  testLogPath: string;
  revertLogPath: string;
} {
  return {
    testLogPath: `${WITNESS_LOG_ROOT}/${packetId}/test.log`,
    revertLogPath: `${WITNESS_LOG_ROOT}/${packetId}/revert.log`,
  };
}

/**
 * The one rule docs/10-schemas.md states about log paths, enforced instead of assumed: the two run
 * logs live at `docs/evidence/logs/<packetId>/{test,revert}.log` and nowhere else.
 *
 * This matters twice. A manifest is operator-supplied file content that `attach-witness` then reads
 * off disk, so `../../../../etc/passwd` or an absolute path must be refused *before* the read, not
 * after. And a path that is well-formed but names another packet's directory would let a witness
 * whose `repoId`/`baseSha`/`headSha` all bind correctly still hash somebody else's run. Requiring
 * exact equality with `witnessLogPaths(packetId)` closes both, and costs a real run nothing —
 * `witnessEvidence` emits precisely these paths.
 */
export function witnessLogPathViolation(
  packetId: string,
  witness: { testLogPath?: string; revertLogPath?: string },
): string | undefined {
  const want = witnessLogPaths(packetId);
  for (const [label, actual, expected] of [
    ["test", witness.testLogPath, want.testLogPath],
    ["revert", witness.revertLogPath, want.revertLogPath],
  ] as const) {
    if (actual !== expected) {
      return `witness ${label} log path ${actual ? `\`${actual}\`` : "(absent)"} is not \`${expected}\` — run logs are repo-root-relative and live under ${WITNESS_LOG_ROOT}/<packetId>/ (docs/10-schemas.md); a witness may name only its own packet's logs`;
    }
  }
  return undefined;
}

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+$|_test\.(go|py)$|_spec\.rb$/i;

/** Exported for probing: the classifier that decides which changed files count as tests (and stay un-reverted for the negative control). */
export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

/** The one digest the witness, the evidence page, and the log check all speak. */
export function witnessLogSha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Execute the evidence protocol instead of attesting it: clone, tests green at head, revert the
 * non-test production change to base, tests must go red. Refusals are structured, never a
 * degraded fake-green: E2B without a key is dry-run and says so; host execution outside Wave 0
 * violates ADR 0003.
 */
export async function witnessEvidence(
  input: {
    packetId: string;
    repoId: string;
    baseSha: string;
    headSha: string;
    testCommand: string;
    setupCommand?: string;
    sandbox: SandboxKind;
    wave: Wave;
  },
  runner: WitnessRunner,
  env: Record<string, string | undefined>,
): Promise<WitnessOutcome> {
  if (input.sandbox === "host" && input.wave !== 0) {
    return { ok: false, error: "host witnessing is Wave 0 only (ADR 0003) — untrusted clones never run on the operator machine" };
  }
  if (input.sandbox !== "host") {
    // Both refusals name the ingest verb: an operator without a key is the *first* one to need it,
    // since the way forward is a witness produced elsewhere, not a key on this machine.
    if (!env.E2B_API_KEY) {
      return {
        ok: false,
        error:
          `cannot witness evidence in dry-run — wire E2B_API_KEY on the worker host (docs/06-v2.md), or ingest a witness produced there with \`${INGEST_INVOCATION} ${input.packetId} --manifest <path>\`. The factory refuses rather than degrading to operator-claimed results.`,
      };
    }
    return {
      ok: false,
      error:
        `${input.sandbox === "daytona" ? "Daytona" : "E2B"} execution runs on the worker host, not in this repo's CLI (ADR 0003) — run the witness there, then ingest it here with \`${INGEST_INVOCATION} ${input.packetId} --manifest <path>\`. This CLI refuses rather than faking a green harvest.`,
    };
  }

  const dir = join(tmpdir(), `foundry-witness-${input.repoId.replace("/", "_")}-${Date.now()}`);
  const url = `https://github.com/${input.repoId}.git`;
  const fail = async (error: string): Promise<WitnessOutcome> => {
    await runner("cleanup", [dir]);
    return { ok: false, error };
  };

  const clone = await runner("git", ["clone", url, dir]);
  if (clone.exit !== 0) return fail(`clone failed for ${input.repoId}: ${clone.output.slice(0, 200)}`);
  const fetched = await runner("git", ["-C", dir, "fetch", "origin", input.baseSha, input.headSha]);
  if (fetched.exit !== 0) {
    const full = await runner("git", ["-C", dir, "fetch", "origin"]);
    if (full.exit !== 0) return fail(`fetch failed: ${full.output.slice(0, 200)}`);
  }
  for (const sha of [input.baseSha, input.headSha]) {
    const has = await runner("git", ["-C", dir, "cat-file", "-e", sha]);
    if (has.exit !== 0) return fail(`commit ${sha.slice(0, 7)} is not reachable in ${input.repoId}`);
  }
  const checkout = await runner("git", ["-C", dir, "checkout", "--detach", input.headSha]);
  if (checkout.exit !== 0) return fail(`checkout failed: ${checkout.output.slice(0, 200)}`);

  if (input.setupCommand) {
    const setup = await runner("run-setup", [input.setupCommand], { cwd: dir });
    if (setup.exit !== 0) {
      return fail(`setup command failed (exit ${setup.exit}) — cannot witness without a working environment: ${setup.output.slice(0, 200)}`);
    }
  }

  const headRun = await runner("run-tests@head", [input.testCommand], { cwd: dir });
  if (headRun.exit !== 0) {
    return fail(`tests are red at head ${input.headSha.slice(0, 7)} (exit ${headRun.exit}) — nothing to witness`);
  }

  // Untracked artifacts from the head run (build output, caches) must not keep the revert run
  // green — or make it spuriously red. Clean everything the clone did not track before reverting.
  const clean = await runner("git", ["-C", dir, "clean", "-fdx", "--exclude", "node_modules"]);
  if (clean.exit !== 0) return fail(`clean between runs failed: ${clean.output.slice(0, 200)}`);
  if (input.setupCommand) {
    const resetup = await runner("run-setup", [input.setupCommand], { cwd: dir });
    if (resetup.exit !== 0) {
      return fail(`setup re-run after clean failed (exit ${resetup.exit}): ${resetup.output.slice(0, 200)}`);
    }
  }

  const changed = await runner("git", ["-C", dir, "diff", "--name-only", input.baseSha, input.headSha]);
  const files = changed.output.split("\n").map((f) => f.trim()).filter(Boolean);
  const nonTest = files.filter((f) => !isTestPath(f));
  const revertPaths = nonTest.length > 0 ? nonTest : ["."];
  const revert = await runner("git", ["-C", dir, "checkout", input.baseSha, "--", ...revertPaths]);
  if (revert.exit !== 0) return fail(`revert to base failed: ${revert.output.slice(0, 200)}`);

  const revertRun = await runner("run-tests@revert", [input.testCommand], { cwd: dir });
  await runner("cleanup", [dir]);
  if (revertRun.exit === 0) {
    return {
      ok: false,
      // KNOWN DEFECT, diagnosed not undiscovered (issue #44 item 5): the "park the packet" below
      // names a verb the operator does not have. `parked` is a status the engine writes on its own;
      // the operator's stand-down verb is `reject`, as the corrected sibling string in
      // `factory/sandbox.ts` already says. The wording here should read "reject the packet"; delete
      // this comment with that edit.
      error:
        "negative control failed — tests stayed green with the production change reverted. The proof does not bind the change; park the packet.",
    };
  }

  return {
    ok: true,
    witness: {
      provider: "host",
      testExit: headRun.exit,
      revertExit: revertRun.exit,
      testLogSha: witnessLogSha(headRun.output),
      revertLogSha: witnessLogSha(revertRun.output),
      ranAt: new Date().toISOString(),
      repoId: input.repoId,
      baseSha: input.baseSha,
      headSha: input.headSha,
      ...witnessLogPaths(input.packetId),
    },
    logs: { test: headRun.output, revert: revertRun.output },
  };
}

/**
 * Recompute both declared sha256s from the persisted logs. A hash of something nobody can produce
 * is not evidence; this is what makes the digest on the evidence page checkable by a maintainer.
 * The reader is a seam so the check is exercised against real files without a live clone.
 */
export function verifyWitnessLogs(
  witness: EvidenceWitness,
  read: (path: string) => string | undefined,
): { ok: true } | { ok: false; error: string } {
  for (const [label, path, declared] of [
    ["test", witness.testLogPath, witness.testLogSha],
    ["revert", witness.revertLogPath, witness.revertLogSha],
  ] as const) {
    if (!path) {
      return { ok: false, error: `witness declares no ${label} log path — the sha256 is unauditable` };
    }
    const text = read(path);
    if (text === undefined) {
      return {
        ok: false,
        error: `${label} log ${path} is missing or unreadable — the witness sha256 cannot be recomputed`,
      };
    }
    const actual = witnessLogSha(text);
    if (actual !== declared) {
      return {
        ok: false,
        error: `${label} log ${path} hashes to ${actual.slice(0, 12)}…, which does not match the witness sha256 ${declared.slice(0, 12)}… — the log on disk is not what was witnessed`,
      };
    }
  }
  return { ok: true };
}

const HEX40 = /^[0-9a-f]{40}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse an externally produced witness manifest for `packetId`. Shape validation cannot detect a
 * lie — provenance is settled by the engine gate and the log hashes by `verifyWitnessLogs`. This
 * refuses input that could not have come from a run at all, so a malformed file never reaches the
 * state machine, and it settles the two log paths against `packetId` because the caller reads
 * whatever they name off disk immediately afterwards.
 */
export function parseWitnessManifest(
  raw: string,
  packetId: string,
): { ok: true; manifest: IngestedWitness } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `witness manifest is not JSON: ${err instanceof Error ? err.message : "unparseable"}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "witness manifest must be a JSON object" };
  }
  const o = parsed as Record<string, unknown>;
  const providers: SandboxKind[] = ["host", "e2b", "daytona"];
  if (!providers.includes(o.provider as SandboxKind)) {
    return { ok: false, error: `witness manifest provider must be one of ${providers.join(", ")}` };
  }
  if (typeof o.testExit !== "number" || typeof o.revertExit !== "number") {
    return { ok: false, error: "witness manifest must record both run exit codes as numbers" };
  }
  if (typeof o.testLogSha !== "string" || !HEX64.test(o.testLogSha)) {
    return { ok: false, error: "witness manifest testLogSha must be a sha256 hex digest" };
  }
  if (typeof o.revertLogSha !== "string" || !HEX64.test(o.revertLogSha)) {
    return { ok: false, error: "witness manifest revertLogSha must be a sha256 hex digest" };
  }
  if (!nonEmptyString(o.ranAt)) {
    return { ok: false, error: "witness manifest must record ranAt" };
  }
  if (!nonEmptyString(o.repoId)) {
    return { ok: false, error: "witness manifest must name the repoId it was produced for" };
  }
  if (typeof o.baseSha !== "string" || !HEX40.test(o.baseSha)) {
    return { ok: false, error: "witness manifest baseSha must be a full 40-hex commit SHA" };
  }
  if (typeof o.headSha !== "string" || !HEX40.test(o.headSha)) {
    return { ok: false, error: "witness manifest headSha must be a full 40-hex commit SHA" };
  }
  if (!nonEmptyString(o.testLogPath) || !nonEmptyString(o.revertLogPath)) {
    return {
      ok: false,
      error: "witness manifest must reference the persisted run logs (testLogPath, revertLogPath)",
    };
  }
  const strayLogs = witnessLogPathViolation(packetId, {
    testLogPath: o.testLogPath,
    revertLogPath: o.revertLogPath,
  });
  if (strayLogs) return { ok: false, error: strayLogs };
  if (!nonEmptyString(o.testCommand)) {
    return { ok: false, error: "witness manifest must record the testCommand that was run" };
  }
  const notes = Array.isArray(o.notes) && o.notes.every((n) => typeof n === "string")
    ? (o.notes as string[])
    : [];
  return {
    ok: true,
    manifest: {
      testCommand: o.testCommand,
      notes,
      witness: {
        provider: o.provider as EvidenceWitness["provider"],
        testExit: o.testExit,
        revertExit: o.revertExit,
        testLogSha: o.testLogSha.toLowerCase(),
        revertLogSha: o.revertLogSha.toLowerCase(),
        ranAt: o.ranAt,
        repoId: o.repoId,
        baseSha: o.baseSha.toLowerCase(),
        headSha: o.headSha.toLowerCase(),
        testLogPath: o.testLogPath,
        revertLogPath: o.revertLogPath,
      },
    },
  };
}
