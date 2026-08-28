import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EvidenceWitness, SandboxKind, Wave } from "./types.ts";

/**
 * A witness step is one of: "git" (args passed to git), "run-tests@head" / "run-tests@revert"
 * (args[0] is the repo's test command, executed by the runner), "cleanup" (args[0] is a scratch
 * dir). The runner seam is what makes the protocol testable without a network or a shell.
 */
export type WitnessStep = "git" | "run-tests@head" | "run-tests@revert" | "cleanup";
export type WitnessRunner = (
  step: WitnessStep,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ exit: number; output: string }>;

export type WitnessOutcome = { ok: true; witness: EvidenceWitness } | { ok: false; error: string };

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+$/i;

function sha256(text: string): string {
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
    repoId: string;
    baseSha: string;
    headSha: string;
    testCommand: string;
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
    if (!env.E2B_API_KEY) {
      return {
        ok: false,
        error:
          "cannot witness evidence in dry-run — wire E2B_API_KEY on the worker host (docs/06-v2.md). The factory refuses rather than degrading to operator-claimed results.",
      };
    }
    return {
      ok: false,
      error:
        "E2B execution runs on the worker host, not in this repo's CLI (ADR 0003) — run the witness there and re-attach. This CLI refuses rather than faking a green harvest.",
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

  const headRun = await runner("run-tests@head", [input.testCommand], { cwd: dir });
  if (headRun.exit !== 0) {
    return fail(`tests are red at head ${input.headSha.slice(0, 7)} (exit ${headRun.exit}) — nothing to witness`);
  }

  const changed = await runner("git", ["-C", dir, "diff", "--name-only", input.baseSha, input.headSha]);
  const files = changed.output.split("\n").map((f) => f.trim()).filter(Boolean);
  const nonTest = files.filter((f) => !TEST_PATH_RE.test(f));
  const revertPaths = nonTest.length > 0 ? nonTest : ["."];
  const revert = await runner("git", ["-C", dir, "checkout", input.baseSha, "--", ...revertPaths]);
  if (revert.exit !== 0) return fail(`revert to base failed: ${revert.output.slice(0, 200)}`);

  const revertRun = await runner("run-tests@revert", [input.testCommand], { cwd: dir });
  await runner("cleanup", [dir]);
  if (revertRun.exit === 0) {
    return {
      ok: false,
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
      testLogSha: sha256(headRun.output),
      revertLogSha: sha256(revertRun.output),
      ranAt: new Date().toISOString(),
    },
  };
}
