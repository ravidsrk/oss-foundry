import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tmp } from "./tmp-dir.ts";
import { scoutGithub } from "./github-scout.ts";
import {
  hostRunner,
  resolveToolchain,
  witnessChildEnv,
  witnessChildTimeoutMs,
  witnessEvidence,
  WITNESS_CHILD_TIMEOUT_MS,
  WITNESS_CHILD_TIMEOUT_MAX_MS,
} from "./witness.ts";

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
test("#114 / G-02: the host runner allowlists the child env and drops planted secrets", async () => {
  const isolated = witnessChildEnv({
    PATH: "/usr/bin",
    HOME: "/tmp",
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    TZ: "UTC",
    GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
    HTTPS_PROXY: "http://user:foundry_planted_proxy_pass@proxy.example:8080",
    HTTP_PROXY: "http://proxy.example:3128",
    NO_PROXY: "localhost,127.0.0.1",
    NVM_DIR: "/opt/nvm",
    NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
    GIT_SSL_CAINFO: "/etc/ssl/git.pem",
    MISE_DATA_DIR: "/opt/mise",
    MISE_GITHUB_TOKEN: "foundry_planted_mise_token",
    ASDF_GITHUB_API_TOKEN: "foundry_planted_asdf_token",
    GIT_ASKPASS: "/tmp/askpass",
    SHELL: "/bin/zsh",
    FOUNDRY_PAT: "ghp_should_never_leak",
    GITHUB_TOKEN: "ghs_also_secret",
    GH_TOKEN: "ghp_gh",
    E2B_API_KEY: "e2b_secret",
    NPM_TOKEN: "foundry_planted_npm_token",
    AWS_SECRET_ACCESS_KEY: "foundry_planted_aws_secret",
    ANTHROPIC_API_KEY: "foundry_planted_anthropic_key",
    OP_SERVICE_ACCOUNT_TOKEN: "foundry_planted_op_token",
    NOT_A_TOOLCHAIN_VAR: "foundry_planted_unrelated",
  });
  assert.equal(isolated.PATH, "/usr/bin");
  assert.equal(isolated.HOME, "/tmp");
  assert.equal(isolated.TMPDIR, "/tmp");
  assert.equal(isolated.LANG, "C.UTF-8");
  assert.equal(isolated.TZ, "UTC");
  assert.equal(isolated.GIT_CONFIG_GLOBAL, "/tmp/gitconfig");
  assert.equal(isolated.HTTPS_PROXY, "http://proxy.example:8080");
  assert.equal(isolated.HTTP_PROXY, "http://proxy.example:3128");
  assert.equal(isolated.NO_PROXY, "localhost,127.0.0.1");
  assert.equal(isolated.NVM_DIR, "/opt/nvm");
  assert.equal(isolated.NODE_EXTRA_CA_CERTS, "/etc/ssl/corp.pem");
  assert.equal(isolated.GIT_SSL_CAINFO, "/etc/ssl/git.pem");
  assert.equal(isolated.MISE_DATA_DIR, "/opt/mise");
  assert.equal(isolated.MISE_GITHUB_TOKEN, undefined, "MISE_GITHUB_TOKEN is a credential; no MISE_* glob");
  assert.equal(isolated.ASDF_GITHUB_API_TOKEN, undefined, "ASDF_GITHUB_API_TOKEN is a credential; no ASDF_* glob");
  assert.equal(isolated.GIT_ASKPASS, undefined, "GIT_ASKPASS is a credential helper, not a toolchain need");
  assert.equal(isolated.SHELL, undefined, "SHELL is not a toolchain need; bash -c is the contract");
  assert.equal(isolated.FOUNDRY_PAT, undefined);
  assert.equal(isolated.GITHUB_TOKEN, undefined);
  assert.equal(isolated.GH_TOKEN, undefined);
  assert.equal(isolated.E2B_API_KEY, undefined);
  assert.equal(isolated.NPM_TOKEN, undefined);
  assert.equal(isolated.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(isolated.ANTHROPIC_API_KEY, undefined);
  assert.equal(isolated.OP_SERVICE_ACCOUNT_TOKEN, undefined);
  assert.equal(isolated.NOT_A_TOOLCHAIN_VAR, undefined);
  assert.deepEqual(
    Object.keys(isolated).sort(),
    [
      "GIT_CONFIG_GLOBAL",
      "GIT_SSL_CAINFO",
      "HOME",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "LANG",
      "MISE_DATA_DIR",
      "NODE_EXTRA_CA_CERTS",
      "NO_PROXY",
      "NVM_DIR",
      "PATH",
      "TMPDIR",
      "TZ",
    ].sort(),
  );

  const planted: Record<string, string> = {
    NPM_TOKEN: "foundry_planted_npm_token",
    AWS_SECRET_ACCESS_KEY: "foundry_planted_aws_secret",
    ANTHROPIC_API_KEY: "foundry_planted_anthropic_key",
    OP_SERVICE_ACCOUNT_TOKEN: "foundry_planted_op_token",
    FOUNDRY_PAT: "foundry_planted_foundry_pat",
    NOT_A_TOOLCHAIN_VAR: "foundry_planted_unrelated",
    MISE_GITHUB_TOKEN: "foundry_planted_mise_token",
    HTTPS_PROXY: "http://user:foundry_planted_proxy_pass@127.0.0.1:9",
    NVM_DIR: "/tmp/foundry-nvm-dir",
  };
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(planted)) saved[key] = process.env[key];
  try {
    Object.assign(process.env, planted);
    const run = await hostRunner("run-tests@head", [
      [
        'echo PATH_LEN=${#PATH}',
        'echo HOME_SET=$(if [ -n "$HOME" ]; then echo yes; else echo no; fi)',
        "printenv",
      ].join("; "),
    ]);
    assert.equal(run.exit, 0, run.output);
    assert.match(run.output, /PATH_LEN=[1-9]/, `child PATH was empty — over-aggressive allowlist: ${run.output}`);
    assert.match(run.output, /HOME_SET=yes/, `child HOME was missing: ${run.output}`);
    assert.match(run.output, /^NVM_DIR=\/tmp\/foundry-nvm-dir$/m, `NVM_DIR did not reach the child: ${run.output}`);
    assert.match(run.output, /^HTTPS_PROXY=http:\/\/127\.0\.0\.1:9\/?$/m, `stripped proxy URL missing: ${run.output}`);
    for (const [key, value] of Object.entries(planted)) {
      if (key === "NVM_DIR") continue;
      if (key === "HTTPS_PROXY") {
        assert.doesNotMatch(run.output, /foundry_planted_proxy_pass/, `proxy userinfo reached the child: ${run.output}`);
        continue;
      }
      assert.doesNotMatch(run.output, new RegExp(value), `${key} reached the child: ${run.output}`);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the host runner refuses a scratch prefix that would escape the tmpdir", async () => {
  for (const bad of ["../escape-", "foundry/../../escape-", "a\\b-"]) {
    const result = await hostRunner("mkdtemp", [bad]);
    assert.equal(result.exit, 1, `${bad} was accepted: ${result.output}`);
    assert.match(result.output, /path separator/, result.output);
  }
});

test("G-14: a hung witness child is killed at the deadline and the refusal names the step", async () => {
  // Real clock on purpose: the production deadline is `setTimeout` + SIGKILL of a live
  // `sleep` process group. Fake timers cannot observe whether the grandchild actually died.
  const prev = process.env.FOUNDRY_WITNESS_TIMEOUT_MS;
  process.env.FOUNDRY_WITNESS_TIMEOUT_MS = "250";
  const started = Date.now();
  try {
    const run = await Promise.race([
      hostRunner("run-tests@head", ["sleep 10"]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("hung witness child was not killed")), 2000),
      ),
    ]);
    assert.notEqual(run.exit, 0, run.output);
    assert.match(
      run.output,
      /witness step "run-tests@head" exceeded the 250ms deadline and was killed/,
      run.output,
    );
    assert.ok(Date.now() - started < 2000, `hung child took ${Date.now() - started}ms`);
  } finally {
    if (prev === undefined) delete process.env.FOUNDRY_WITNESS_TIMEOUT_MS;
    else process.env.FOUNDRY_WITNESS_TIMEOUT_MS = prev;
  }
});

test("G-14: a hung grandchild is dead after the deadline, not reparented", async () => {
  // Real clock: we have to observe a live grandchild PID and then that it is gone.
  // Fake timers cannot tell a reparented `sleep` from a reaped one.
  const pidFile = join(tmp("foundry-grandchild-"), "pid");
  const prev = process.env.FOUNDRY_WITNESS_TIMEOUT_MS;
  process.env.FOUNDRY_WITNESS_TIMEOUT_MS = "400";
  try {
    const run = await Promise.race([
      hostRunner("run-tests@head", [`(sleep 20 & echo $! > ${JSON.stringify(pidFile)}; wait)`]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("hung grandchild parent was not killed")), 2000),
      ),
    ]);
    assert.notEqual(run.exit, 0, run.output);
    assert.match(run.output, /exceeded the 400ms deadline/, run.output);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(pid) && pid > 1, `pid file held ${pid}`);
    const listed = spawnSync("ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8" });
    const state = listed.stdout.trim();
    assert.ok(
      state === "" || state.startsWith("Z"),
      `grandchild ${pid} still running (ps state=${JSON.stringify(state)}) — reparented after the shell died`,
    );
  } finally {
    if (prev === undefined) delete process.env.FOUNDRY_WITNESS_TIMEOUT_MS;
    else process.env.FOUNDRY_WITNESS_TIMEOUT_MS = prev;
  }
});

test("G-14: a daemonized grandchild is dead after the deadline", async () => {
  // Real clock. The intermediate subshell exits immediately so `sleep` is
  // reparented to init — `pgrep -P` on the witness shell cannot see it.
  // Process-group membership survives that; a group SIGKILL must reap it.
  const pidFile = join(tmp("foundry-daemon-"), "pid");
  const prev = process.env.FOUNDRY_WITNESS_TIMEOUT_MS;
  process.env.FOUNDRY_WITNESS_TIMEOUT_MS = "400";
  let daemonPid: number | undefined;
  try {
    const run = await Promise.race([
      hostRunner("run-tests@head", [
        `(sleep 20 >/dev/null 2>&1 & echo $! > ${JSON.stringify(pidFile)}); sleep 20`,
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("hung daemon parent was not killed")), 2000),
      ),
    ]);
    assert.notEqual(run.exit, 0, run.output);
    assert.match(run.output, /exceeded the 400ms deadline/, run.output);
    daemonPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(daemonPid) && daemonPid > 1, `pid file held ${daemonPid}`);
    const listed = spawnSync("ps", ["-p", String(daemonPid), "-o", "state="], { encoding: "utf8" });
    const state = listed.stdout.trim();
    assert.ok(
      state === "" || state.startsWith("Z"),
      `daemonized grandchild ${daemonPid} still running (ps state=${JSON.stringify(state)}) — escaped the process group`,
    );
  } finally {
    if (daemonPid !== undefined) {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {
        // already dead
      }
    }
    if (prev === undefined) delete process.env.FOUNDRY_WITNESS_TIMEOUT_MS;
    else process.env.FOUNDRY_WITNESS_TIMEOUT_MS = prev;
  }
});

test("G-14: a setsid grandchild is not reached — that is the sandbox boundary", async () => {
  // Pins the documented limit, not a bug. A process that calls setsid() leaves
  // the group we signal and is not a pgrep -P child after the intermediate
  // parent exits. Defeating it would need a cgroup/jail/VM (ADR 0003); a
  // best-effort pid scan that sometimes kills the wrong process is worse.
  // This test fails if the limit silently changes shape (we start reaching it,
  // or we stop spawning a group at all and start claiming we do).
  const dir = tmp("foundry-setsid-");
  const pidFile = join(dir, "pid");
  const script = join(dir, "escape.py");
  writeFileSync(
    script,
    [
      "import os, sys, time",
      "pid = os.fork()",
      "if pid > 0:",
      "    sys.stdout.write(str(pid))",
      "    sys.exit(0)",
      "os.setsid()",
      "devnull = os.open(os.devnull, os.O_RDWR)",
      "os.dup2(devnull, 0)",
      "os.dup2(devnull, 1)",
      "os.dup2(devnull, 2)",
      "time.sleep(20)",
    ].join("\n"),
  );
  const prev = process.env.FOUNDRY_WITNESS_TIMEOUT_MS;
  process.env.FOUNDRY_WITNESS_TIMEOUT_MS = "400";
  let escapedPid: number | undefined;
  try {
    const run = await Promise.race([
      hostRunner("run-tests@head", [
        `python3 ${JSON.stringify(script)} > ${JSON.stringify(pidFile)} 2>/dev/null; sleep 20`,
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("setsid parent was not killed")), 2000),
      ),
    ]);
    assert.notEqual(run.exit, 0, run.output);
    assert.match(run.output, /exceeded the 400ms deadline/, run.output);
    escapedPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(escapedPid) && escapedPid > 1, `pid file held ${escapedPid}`);
    const listed = spawnSync("ps", ["-p", String(escapedPid), "-o", "state="], { encoding: "utf8" });
    const state = listed.stdout.trim();
    assert.ok(
      state.length > 0 && !state.startsWith("Z"),
      `setsid grandchild ${escapedPid} was reached (ps state=${JSON.stringify(state)}) — the session-escape boundary moved`,
    );
  } finally {
    if (escapedPid !== undefined) {
      try {
        process.kill(escapedPid, "SIGKILL");
      } catch {
        // already dead
      }
    }
    if (prev === undefined) delete process.env.FOUNDRY_WITNESS_TIMEOUT_MS;
    else process.env.FOUNDRY_WITNESS_TIMEOUT_MS = prev;
  }
});

test("G-14: a self-SIGKILL is not reported as a deadline", async () => {
  const run = await hostRunner("run-tests@head", ["kill -KILL $$"]);
  assert.notEqual(run.exit, 0, run.output);
  assert.doesNotMatch(
    run.output,
    /exceeded the .* deadline/,
    `SIGKILL was mislabeled as a timeout: ${run.output}`,
  );
  assert.match(run.output, /killed by SIGKILL/, run.output);
});

test("G-14: a truthy invalid FOUNDRY_WITNESS_TIMEOUT_MS falls back to the shipped bound", () => {
  assert.equal(witnessChildTimeoutMs(undefined), WITNESS_CHILD_TIMEOUT_MS);
  assert.equal(witnessChildTimeoutMs(""), WITNESS_CHILD_TIMEOUT_MS);
  assert.equal(witnessChildTimeoutMs("nope"), WITNESS_CHILD_TIMEOUT_MS);
  assert.equal(witnessChildTimeoutMs("0"), WITNESS_CHILD_TIMEOUT_MS);
  assert.equal(witnessChildTimeoutMs("-1"), WITNESS_CHILD_TIMEOUT_MS);
  assert.equal(witnessChildTimeoutMs("Infinity"), WITNESS_CHILD_TIMEOUT_MS);
  assert.equal(witnessChildTimeoutMs("15.5"), WITNESS_CHILD_TIMEOUT_MS);
  assert.equal(witnessChildTimeoutMs(WITNESS_CHILD_TIMEOUT_MAX_MS + 1), WITNESS_CHILD_TIMEOUT_MS);
  assert.equal(witnessChildTimeoutMs(-1), WITNESS_CHILD_TIMEOUT_MS);
  assert.equal(witnessChildTimeoutMs(Number.POSITIVE_INFINITY), WITNESS_CHILD_TIMEOUT_MS);
  assert.equal(witnessChildTimeoutMs("250"), 250);
  assert.equal(witnessChildTimeoutMs(250), 250);
  assert.equal(witnessChildTimeoutMs(WITNESS_CHILD_TIMEOUT_MAX_MS), WITNESS_CHILD_TIMEOUT_MAX_MS);

  const prev = process.env.FOUNDRY_WITNESS_TIMEOUT_MS;
  process.env.FOUNDRY_WITNESS_TIMEOUT_MS = "-1";
  try {
    assert.equal(witnessChildTimeoutMs(), WITNESS_CHILD_TIMEOUT_MS);
  } finally {
    if (prev === undefined) delete process.env.FOUNDRY_WITNESS_TIMEOUT_MS;
    else process.env.FOUNDRY_WITNESS_TIMEOUT_MS = prev;
  }
});

test("G-26: the unwired scout's fetch carries a deadline", async () => {
  let fetches = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    fetches += 1;
    assert.ok(init?.signal, "scout fetch received no AbortSignal — githubRequestInit must attach a deadline");
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const result = await scoutGithub({ maxPerRepo: 1 }, fetchImpl);
  assert.equal(result.ok, true);
  assert.ok(fetches > 0, "scout never called fetch");
  assert.equal(result.errors.length, 0, result.errors.join("; "));
});

test("G-26: a hung scout fetch fails closed within the deadline", async () => {
  // Real clock: `AbortSignal.timeout` is what production attaches, and fake timers do not
  // fire it. The watchdog holds node:test's event loop until the abort (or 2s, the failure).
  const hung: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("hung fetch received no AbortSignal — scoutGithub must attach a deadline"));
        return;
      }
      const fail = () =>
        reject(signal.reason ?? new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    });
  const prev = process.env.FOUNDRY_GITHUB_TIMEOUT_MS;
  process.env.FOUNDRY_GITHUB_TIMEOUT_MS = "40";
  const started = Date.now();
  try {
    const result = await Promise.race([
      scoutGithub({ maxPerRepo: 1 }, hung),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("hung scout fetch was not aborted")), 2000),
      ),
    ]);
    assert.equal(result.ok, true);
    assert.ok(result.errors.length > 0, "hung scout produced no errors");
    assert.match(result.errors.join("\n"), /abort|timeout|This operation was aborted/i);
    assert.ok(Date.now() - started < 2000, `hung scout fetch took ${Date.now() - started}ms`);
  } finally {
    if (prev === undefined) delete process.env.FOUNDRY_GITHUB_TIMEOUT_MS;
    else process.env.FOUNDRY_GITHUB_TIMEOUT_MS = prev;
  }
});
