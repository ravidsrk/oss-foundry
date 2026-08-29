import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hostRunner, resolveToolchain } from "./witness.ts";

/**
 * `hostRunner` driven against a real shell — the only assertions in the repo that a fake runner
 * cannot make.
 *
 * Everything else about the witness protocol is proven through the `WitnessRunner` seam, which is
 * what keeps `witnessEvidence` testable without a network or a shell. That seam also means the
 * *implementation* of the seam had no test at all: the shell it chooses, and therefore which
 * `python3` the operator's evidence was produced by, was unasserted. Issue #41 is what that cost —
 * a login shell on macOS re-resolved the interpreter and the witness died at head with no output.
 */

/** A directory on PATH holding one executable that shadows a system tool of the same name. */
function shimDir(name: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "foundry-path-"));
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho SHIMMED\n`);
  chmodSync(path, 0o755);
  return { dir, path };
}

async function withPathPrefix<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved ?? ""}`;
  try {
    return await body();
  } finally {
    process.env.PATH = saved;
  }
}

test("the host runner executes the repo's command in a non-login, non-interactive shell", async () => {
  // The cause, asserted at the cause. `/etc/profile` — and therefore macOS `path_helper`, which
  // rebuilds PATH from scratch with /usr/bin ahead of everything the operator installed — is
  // sourced only by a *login* shell. `shopt -q login_shell` is bash's own answer to which one it
  // is, so this holds on every platform rather than only where path_helper exists.
  const login = await hostRunner("run-tests@head", [
    "shopt -q login_shell && echo LOGIN || echo NOT_LOGIN",
  ]);
  assert.equal(login.exit, 0, login.output);
  assert.match(login.output, /NOT_LOGIN/, `the witness ran a login shell: ${login.output}`);

  const interactive = await hostRunner("run-tests@head", [
    `case $- in *i*) echo INTERACTIVE ;; *) echo NOT_INTERACTIVE ;; esac`,
  ]);
  assert.equal(interactive.exit, 0, interactive.output);
  assert.match(interactive.output, /NOT_INTERACTIVE/, interactive.output);
});

test("the host runner resolves tools from the operator's PATH, in the operator's order", async () => {
  // Not "is the tool findable" — *which* one wins. A login shell on macOS leaves the shim on PATH
  // and merely demotes it below /usr/bin, which is exactly how six-minor-versions-too-old
  // interpreter selection stays invisible: everything resolves, to the wrong thing.
  const { dir, path } = shimDir("sort");
  try {
    const resolved = await withPathPrefix(dir, () => hostRunner("run-tests@head", ["command -v sort"]));
    assert.equal(resolved.exit, 0, resolved.output);
    assert.equal(
      resolved.output.trim(),
      path,
      `the witness resolved a different \`sort\` than the operator's PATH names first: ${resolved.output}`,
    );
  } finally {
    // The shim is a directory of executables on `$TMPDIR`; leaving one behind per run is how a
    // machine ends up with sixty of them. Removed on the failure path too — the assertion above
    // is where this test is most likely to exit.
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the toolchain probe reports the very interpreter the test phase would run", async () => {
  // The pre-flight is only worth anything if it resolves through the same shell the run does.
  // Probing one way and executing another is how a green pre-flight and a red witness coexist.
  const viaRun = await hostRunner("run-tests@head", ["command -v python3"]);
  assert.equal(viaRun.exit, 0, `no python3 on this machine at all: ${viaRun.output}`);

  const probed = await resolveToolchain(
    "python3 scripts/validate.py && python3 -m unittest discover -s tests -v",
    hostRunner,
  );
  assert.equal(probed.length, 1, `python3 is named twice but is one tool: ${JSON.stringify(probed)}`);
  assert.equal(probed[0].tool, "python3");
  assert.equal(probed[0].path, viaRun.output.trim());
  assert.match(
    probed[0].version ?? "",
    /^\d+\.\d+/,
    `the probe found python3 but reported no version: ${JSON.stringify(probed[0])}`,
  );
});

test("the toolchain probe reports a missing tool as missing rather than inventing one", async () => {
  const probed = await resolveToolchain("foundry-no-such-tool --run", hostRunner);
  assert.equal(probed.length, 1);
  assert.equal(probed[0].tool, "foundry-no-such-tool");
  assert.equal(probed[0].path, undefined);
  assert.equal(probed[0].version, undefined);
});

/**
 * Issue #56: the witness clone directory was named from `Date.now()` alone —
 * `foundry-witness-${repoId}-${Date.now()}`, no pid and no randomness. Two witness runs for the
 * same repository starting in the same millisecond produced the same path, and `git clone` refuses
 * a destination that exists and is not empty:
 *
 *     destination path '...foundry-witness-ravidsrk_orca-fleet-1787981801727' already exists
 *
 * Observed as a red suite once in seventeen full runs, on the one surface whose entire job is to be
 * reproducible. The fix is not a wider clock — it is to stop naming the path ourselves and let the
 * OS allocate it, which removes the collision class rather than narrowing it.
 *
 * THIS TEST IS THE COLLISION, not a proxy for it. A loop is not "the same millisecond" by
 * assumption: the assertion below requires that at least two of the calls genuinely landed in one
 * millisecond, so a machine slow enough to space them out reports that rather than passing
 * vacuously. Under the old naming every one of those same-millisecond calls produced an identical
 * path; under `mkdtempSync` they cannot, because it creates the directory as it names it and fails
 * rather than returning a path that already exists.
 */
test("two witness scratch directories requested in the same millisecond are distinct and real", async () => {
  const made: string[] = [];
  try {
    const stamps: number[] = [];
    for (let i = 0; i < 24; i += 1) {
      stamps.push(Date.now());
      const result = await hostRunner("mkdtemp", ["foundry-witness-ravidsrk_orca-fleet-"]);
      assert.equal(result.exit, 0, `mkdtemp refused: ${result.output}`);
      made.push(result.output);
    }

    const sameMillisecond = stamps.some((t, i) => i > 0 && t === stamps[i - 1]);
    assert.ok(
      sameMillisecond,
      `no two of the ${stamps.length} requests shared a millisecond, so this run did not exercise the collision (stamps: ${stamps.join(",")})`,
    );

    assert.equal(new Set(made).size, made.length, `two scratch directories collided: ${made.join(", ")}`);
    for (const dir of made) {
      // `mkdtempSync` CREATES the directory, which is what makes the uniqueness the OS's promise
      // rather than ours. A path that does not exist would mean the name was merely composed.
      assert.ok(statSync(dir).isDirectory(), `${dir} was named but not created`);
      assert.ok(dir.startsWith(join(tmpdir(), "foundry-witness-")), `${dir} is not under the tmpdir prefix it asked for`);
    }
  } finally {
    // Issue #64's convention: a test that creates temp dirs removes them. Twenty-four per run would
    // otherwise be a new instance of the very leak that issue is about.
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The prefix reaches this function from `repoId`, i.e. from `allowlist.yaml`. A prefix carrying a
 * path separator would place the scratch directory outside `tmpdir()` — the class of defect issue
 * #80 was filed for, one layer down. Refused here as well as sanitised by the caller, because a
 * guard that only exists at the call site is one call site away from not existing.
 */
test("the host runner refuses a scratch prefix that would escape the tmpdir", async () => {
  for (const bad of ["../escape-", "foundry/../../escape-", "a\\b-"]) {
    const result = await hostRunner("mkdtemp", [bad]);
    assert.equal(result.exit, 1, `${bad} was accepted: ${result.output}`);
    assert.match(result.output, /path separator/, result.output);
  }
});
