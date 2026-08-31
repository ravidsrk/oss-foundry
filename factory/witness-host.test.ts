import assert from "node:assert/strict";
import { chmodSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tmp } from "./tmp-dir.ts";
import { hostRunner, resolveToolchain, witnessChildEnv, witnessEvidence } from "./witness.ts";

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
  const dir = tmp("foundry-path-");
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
 * reproducible. A test that fails once in seventeen for reasons unrelated to the code teaches the
 * operator to re-run rather than read, which is the habit that lets a real red through.
 *
 * THE CLOCK IS FROZEN RATHER THAN RACED. The first version of this test sampled `Date.now()` around
 * each call and asserted that two samples matched — which makes the test itself timing-dependent: a
 * loaded worker spaces the calls past a millisecond boundary and the suite goes red with the fix
 * working perfectly. Adding an intermittent test to a change that exists to remove one is the wrong
 * trade, and it was caught in review of this branch.
 *
 * Freezing is also the stronger statement. "Two runs in the same millisecond" is not really a claim
 * about time; it is a claim that the name does not DEPEND on time. With `Date.now` pinned to the
 * exact timestamp from the reported failure, the old code produces one path for every call by
 * construction, and `mkdtempSync` cannot, because it creates the directory as it names it and fails
 * rather than returning a path that already exists. No scheduling, no flake, and the defect is
 * reproduced exactly rather than approximated.
 */
const FROZEN_MS = 1787981801727; // the timestamp in the reported collision

async function withFrozenClock<T>(body: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => FROZEN_MS;
  try {
    return await body();
  } finally {
    Date.now = real;
  }
}

test("the witness scratch directory does not depend on the clock: frozen time still yields distinct real dirs", async () => {
  const made: string[] = [];
  try {
    await withFrozenClock(async () => {
      for (let i = 0; i < 8; i += 1) {
        const result = await hostRunner("mkdtemp", ["foundry-witness-ravidsrk_orca-fleet-"]);
        assert.equal(result.exit, 0, `mkdtemp refused: ${result.output}`);
        made.push(result.output);
      }
    });

    // The stub is undone, or every later test in this file inherits a frozen clock.
    assert.notEqual(Date.now(), FROZEN_MS, "withFrozenClock leaked its stub past the body");
    assert.equal(new Set(made).size, made.length, `scratch directories collided under a frozen clock: ${made.join(", ")}`);
    for (const dir of made) {
      // `mkdtempSync` CREATES the directory, which is what makes uniqueness the OS's promise rather
      // than ours. A path that does not exist would mean the name was merely composed.
      assert.ok(statSync(dir).isDirectory(), `${dir} was named but not created`);
      assert.ok(dir.startsWith(join(tmpdir(), "foundry-witness-")), `${dir} is not under the prefix it asked for`);
      assert.equal(dir.includes(String(FROZEN_MS)), false, `${dir} still carries the wall clock, so the name depends on time`);
    }
  } finally {
    // Issue #64's convention: a test that creates temp dirs removes them.
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The acceptance criterion in the issue's own words — "two witness runs for the same repo started
 * in the same millisecond both succeed" — driven through `witnessEvidence` rather than through
 * `hostRunner` alone, because the protocol is what the operator runs and the protocol is what used
 * to fail. Raised in review of this branch: a unit test of the naming does not by itself show that
 * the caller consumes it correctly.
 *
 * Hybrid runner on purpose: `mkdtemp` goes to the REAL `hostRunner`, so uniqueness is the OS's
 * actual behaviour and not a stub's promise, while git and the test phases are faked so no network
 * or repository is needed. This is the one assertion in the repo that needs both halves.
 */
test("two witness runs for the same repo under one frozen millisecond both succeed, in different dirs", async () => {
  const dirs: string[] = [];
  try {
    const outcomes = await withFrozenClock(async () => {
      const runOnce = async () => {
        const runner = async (step: string, args: string[]) => {
          if (step === "mkdtemp") {
            const real = await hostRunner("mkdtemp", args);
            if (real.exit === 0) dirs.push(real.output);
            return real;
          }
          if (step === "run-tests@head") return { exit: 0, output: "ok" };
          if (step === "run-tests@revert") return { exit: 1, output: "red" };
          if (step === "git" && args.includes("--name-only")) return { exit: 0, output: "src/thing.ts\n" };
          return { exit: 0, output: "" };
        };
        return witnessEvidence(
          {
            packetId: "pkt_ravidsrk_orca-fleet_71",
            repoId: "ravidsrk/orca-fleet",
            baseSha: "1".repeat(40),
            headSha: "2".repeat(40),
            testCommand: "npm test",
            sandbox: "host",
            wave: 0,
          },
          runner as never,
          {},
        );
      };
      return [await runOnce(), await runOnce()];
    });

    for (const [i, outcome] of outcomes.entries()) {
      assert.equal(outcome.ok, true, `run ${i + 1} failed: ${outcome.ok ? "" : outcome.error}`);
    }
    assert.equal(dirs.length, 2, `expected two scratch dirs, got ${dirs.length}`);
    assert.notEqual(dirs[0], dirs[1], `both witness runs used the same directory ${dirs[0]} — the #56 collision`);
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The prefix reaches this function from `repoId`, i.e. from `allowlist.yaml`. A prefix carrying a
 * path separator would place the scratch directory outside `tmpdir()` — the class of defect issue
 * #80 was filed for, one layer down. Refused here as well as sanitised by the caller, because a
 * guard that only exists at the call site is one call site away from not existing.
 */
test("#114: the host runner does not pass FOUNDRY_PAT into the child", async () => {
  const isolated = witnessChildEnv({
    PATH: "/usr/bin",
    FOUNDRY_PAT: "ghp_should_never_leak",
    GITHUB_TOKEN: "ghs_also_secret",
    GH_TOKEN: "ghp_gh",
    E2B_API_KEY: "e2b_secret",
    HOME: "/tmp",
  });
  assert.equal(isolated.FOUNDRY_PAT, undefined);
  assert.equal(isolated.GITHUB_TOKEN, undefined);
  assert.equal(isolated.GH_TOKEN, undefined);
  assert.equal(isolated.E2B_API_KEY, undefined);
  assert.equal(isolated.PATH, "/usr/bin");
  assert.equal(isolated.HOME, "/tmp");

  const saved = process.env.FOUNDRY_PAT;
  process.env.FOUNDRY_PAT = "ghp_should_never_leak";
  try {
    const run = await hostRunner("run-tests@head", ["printenv FOUNDRY_PAT || true"]);
    assert.doesNotMatch(run.output, /ghp_should_never_leak/);
  } finally {
    if (saved === undefined) delete process.env.FOUNDRY_PAT;
    else process.env.FOUNDRY_PAT = saved;
  }
});

test("the host runner refuses a scratch prefix that would escape the tmpdir", async () => {
  for (const bad of ["../escape-", "foundry/../../escape-", "a\\b-"]) {
    const result = await hostRunner("mkdtemp", [bad]);
    assert.equal(result.exit, 1, `${bad} was accepted: ${result.output}`);
    assert.match(result.output, /path separator/, result.output);
  }
});
