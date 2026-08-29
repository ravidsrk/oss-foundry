import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tmp } from "./tmp-dir.ts";
import {
  installTerminalBoundary,
  sanitizeTerminalText,
  terminalBoundaryNotice,
  type TerminalStream,
} from "./terminal.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TERMINAL = resolve(REPO_ROOT, "factory/terminal.ts");

/** A stream that records what the boundary actually handed to the real `write`. */
function capture(): TerminalStream & { written: string[]; text: string } {
  const written: string[] = [];
  return {
    written,
    get text() {
      return written.join("");
    },
    write(chunk: unknown) {
      written.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    },
  };
}

/** Everything a terminal ACTS on rather than shows. `\n` and `\t` are not in it. */
// eslint-disable-next-line no-control-regex
const ACTIONABLE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

/**
 * A hostile repository's greatest hits, in one string.
 *
 * `\x1b[8m` is the one that matters most and it is the reason this boundary exists rather than a
 * ninth per-sink call: SGR conceal, never reset, hides every line the terminal paints AFTER it. A
 * `CONTRIBUTING.md` carrying it early suppresses each disclosure issue #77 added — the
 * end-of-excerpt marker, the split scan claim, the verdict, the "not the arbiter" line — using the
 * mechanism the same commit was filed to close.
 */
const HOSTILE = "\x1b]52;c;cm0gLXJmIH4=\x07\x1b[8mconcealed\r\x1b[2Jrepainted\x9b31mgreen\x9d0;title\x07";
/** What HOSTILE looks like once the boundary has had it: the marker every drive below matches on. */
const DEFANGED = "concealedrepaintedgreen";
const DISCLOSED = /byte\(s\) of terminal control sequence removed/;

/**
 * Every temp tree this file makes is removed by `tmp()`'s own registry (factory/tmp-dir.ts), which
 * replaced this file's hand-rolled copy of it and the identical one in `engine.test.ts`.
 */

function spawnNode(script: string, args: string[], opts: { preload?: string } = {}) {
  const nodeArgs = ["--experimental-strip-types"];
  if (opts.preload) nodeArgs.push("--import", pathToFileURL(opts.preload).href);
  const run = spawnSync(process.execPath, [...nodeArgs, script, ...args], {
    // Deliberately not the checkout: an entry point that only behaves from the repo root is not an
    // entry point an operator can run.
    cwd: tmpdir(),
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
}

test("the sanitiser removes whole sequences, keeps the shape of a log, and says how much it took", () => {
  const clean = sanitizeTerminalText(HOSTILE);
  assert.equal(ACTIONABLE.test(clean.text), false, JSON.stringify(clean.text));
  assert.equal(clean.text, DEFANGED);
  assert.ok(clean.removed > 0);
  assert.equal(clean.removed, HOSTILE.length - clean.text.length);

  // Whole or not at all: `]52;c;<base64>` must not survive as text, one concatenation from working.
  assert.equal(clean.text.includes("52;c;"), false);
  assert.equal(clean.text.includes("31m"), false);

  // `\n` and `\t` are the shape of a test log and of a policy document. A diagnostic flattened to
  // one line is the diagnostic thrown away.
  const log = "FAIL spec.ts\n\tat line 3\n";
  assert.deepEqual(sanitizeTerminalText(log), { text: log, removed: 0 });
});

/**
 * THE C1/DEL SWEEP, WHICH NO SEQUENCE GRAMMAR COVERS.
 *
 * Every C1 byte the fixture above carries — `\x9b`, `\x9d` — is ALSO a sequence introducer, and
 * `TERMINAL_SEQUENCE` removes those whether or not the C0/C1/DEL sweep exists at all. So narrowing
 * `CONTROL_CHAR` to `[\x00-\x08\x0b-\x1f]` left the whole suite green: the bytes only the sweep can
 * remove were in no fixture, and issue #78's acceptance says "strip C0/**C1** control characters".
 *
 * The unexercised ones are not decorative:
 *   · `\x8d` RI (reverse index) moves the cursor up a line and SCROLLS at the top of the screen —
 *     the "repaint a red witness as green" primitive, with no `\x1b` in it to notice.
 *   · `\x85` NEL is a line break the terminal obeys and no line count expects.
 *   · `\x7f` DEL, and `\x80` at the bottom of the C1 block, pin both ends of the range.
 */
test("the sweep removes the C1 and DEL bytes that are not sequence introducers", () => {
  for (const [byte, name] of [
    ["\x7f", "DEL"],
    ["\x80", "PAD (C1 low end)"],
    ["\x85", "NEL"],
    ["\x8d", "RI — reverse index, which scrolls"],
  ] as const) {
    const hex = byte.charCodeAt(0).toString(16);
    assert.deepEqual(
      sanitizeTerminalText(`red${byte}green`),
      { text: "redgreen", removed: 1 },
      `\\x${hex} (${name}) survived: TERMINAL_SEQUENCE does not know this byte, so the sweep is the only thing that can remove it`,
    );
  }

  // …and it is disclosed like anything else, because a byte removed in silence is a byte the
  // operator is not told about.
  const stream = capture();
  installTerminalBoundary([stream]);
  stream.write("witness: red\x8dgreen\n");
  assert.match(stream.text, DISCLOSED, stream.text);
});

/**
 * The sanitiser must not swallow the diagnostic it exists to preserve.
 *
 * Its own comment promised that "an unterminated OSC should cost the operator that one sequence,
 * not every line of the run log after it" — and the body class `[^\x07\x1b\x9c]*` included `\n`, so
 * it ran to the end of the input and did exactly the opposite. A repository whose output contained a
 * bare `\x1b]0;t` lost EVERY line after it, including the real failure: issue #78's own harm
 * ("conceal its own failure output") achieved THROUGH the sanitiser rather than around it.
 */
test("an unterminated OSC costs its own line, not the rest of the run log", () => {
  const run = "\x1b]0;t\nFAIL src/auth.test.ts\n  expected 200, got 500\n  at verify (src/auth.ts:31)\n";
  const clean = sanitizeTerminalText(run);
  assert.match(clean.text, /FAIL src\/auth\.test\.ts/);
  assert.match(clean.text, /expected 200, got 500/);
  assert.match(clean.text, /at verify \(src\/auth\.ts:31\)/);
  assert.equal(clean.text.split("\n").length, run.split("\n").length, clean.text);
  // The sequence itself is gone, introducer and parameters together.
  assert.equal(clean.text.includes("\x1b"), false);

  // The bound is the LINE the introducer sits on: that line's remainder is forfeit, and it stops
  // there. Stated as an assertion rather than left implicit, because the difference between "this
  // line" and "everything after" is the whole diagnostic.
  const inline = sanitizeTerminalText("\x1b]0;tFAIL one\nFAIL two\n");
  assert.equal(inline.text, "\nFAIL two\n");

  // A terminated OSC still loses its whole body, newline or no newline in the text around it.
  assert.equal(sanitizeTerminalText("a\x1b]0;title\x07b").text, "ab");
});

test("the boundary sanitises every write to a stream, whatever printed it", () => {
  const stream = capture();
  installTerminalBoundary([stream]);

  // Three different "sinks", none of which knows the boundary exists — which is the point.
  stream.write(`freeze excerpt: ${HOSTILE}\n`);
  stream.write(Buffer.from(`witness stdout: ${HOSTILE}\n`, "utf8"));
  stream.write(`matched phrase: ${HOSTILE}\n`);

  assert.equal(ACTIONABLE.test(stream.text), false, JSON.stringify(stream.text));
  assert.equal(stream.written.length, 3, "one write in, one write out — no reordering");
  for (const line of stream.written) assert.match(line, new RegExp(DEFANGED));
});

test("the boundary discloses what it removed rather than tidying in silence", () => {
  const stream = capture();
  installTerminalBoundary([stream]);

  stream.write(`policy text: ${HOSTILE}\n`);
  const removed = sanitizeTerminalText(HOSTILE).removed;
  assert.match(stream.text, new RegExp(`${removed} byte\\(s\\) of terminal control sequence removed`));
  assert.equal(stream.text.includes(terminalBoundaryNotice(removed)), true, stream.text);

  // A sink that sanitised upstream leaves nothing to remove, so the notice appears exactly once per
  // write and never as noise on clean output.
  const clean = capture();
  installTerminalBoundary([clean]);
  clean.write("tests are red at head d91fe2f (exit 1) — nothing to witness\n");
  assert.equal(clean.text.includes("removed"), false, clean.text);
  assert.equal(clean.written.length, 1);
});

/**
 * What the `WRAPPED` WeakSet actually decides, which is not what this test used to claim.
 *
 * The old claim was "installing twice does not sanitise twice or double the disclosure", and it
 * passed with the WeakSet DELETED: sanitising is idempotent, so a second pass over already-clean
 * text removes nothing and appends no second notice. It was a spurious pin — an assertion about a
 * property the guard is not the cause of.
 *
 * The guard's own effect is the wrapper count: one install, one layer, however many times an entry
 * point and something it imported both ask. So that is what is asserted, and the idempotence is
 * kept underneath it as the consequence rather than as the evidence.
 */
test("installing the boundary twice wraps the stream once", () => {
  const stream = capture();
  installTerminalBoundary([stream]);
  const wrapped = stream.write;
  installTerminalBoundary([stream]);
  assert.equal(
    stream.write,
    wrapped,
    "a second install re-wrapped an already-wrapped stream: every write now pays for two full sanitising passes and the chain grows once per call",
  );

  stream.write(`x${HOSTILE}\n`);
  const notices = stream.text.match(new RegExp(DISCLOSED, "g")) ?? [];
  assert.equal(notices.length, 1, stream.text);
});

/**
 * The promise `installTerminalBoundary`'s own comment makes — "only the CHUNK is replaced … so
 * back-pressure, `drain`, and write callbacks behave exactly as before" — which nothing held it to.
 * `inner(…, encoding, callback)` → `inner(…); return true` survived the suite.
 *
 * A boundary that drops the callback strands every `write(chunk, cb)` caller, and one that always
 * returns `true` tells a piping writer there is no back-pressure while the pipe fills.
 */
test("only the chunk is replaced — encoding, callback and back-pressure pass through", () => {
  const seen: { chunk: unknown; encoding: unknown; callback: unknown }[] = [];
  const stream: TerminalStream = {
    write(chunk: unknown, encoding?: unknown, callback?: unknown) {
      seen.push({ chunk, encoding, callback });
      return false; // the real signal: the buffer is full, stop writing
    },
  };
  installTerminalBoundary([stream]);
  const done = () => {};

  assert.equal(stream.write(`x${HOSTILE}\n`, "utf8", done), false, "back-pressure was swallowed");
  assert.equal(seen[0].encoding, "utf8");
  assert.equal(seen[0].callback, done);
  assert.equal(typeof seen[0].chunk, "string", "a string in stays a string out");

  // A Buffer in stays a Buffer out: the chunk's TYPE survives, not only its text.
  stream.write(Buffer.from(`y${HOSTILE}\n`, "utf8"), "utf8", done);
  assert.equal(Buffer.isBuffer(seen[1].chunk), true);
  assert.match(String(seen[1].chunk), new RegExp(DEFANGED));

  // A non-Buffer typed array is raw bytes, not a terminal render. Passed through as the SAME
  // object, so nothing re-encodes a caller's binary payload — documented at the wrapper since it
  // was written, and untested until now.
  const raw = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d]);
  stream.write(raw, undefined, done);
  assert.equal(seen[2].chunk, raw, "a typed array that is not a Buffer must reach the stream intact");
});

/**
 * What a sequence split across two writes costs, stated rather than assumed.
 *
 * The boundary sees one chunk at a time and keeps no cross-write state, so a `\x1b[` in one write
 * and `31m` in the next cannot be matched as one sequence. What it does instead is take the
 * INTRODUCER with the first chunk — the final byte of every form is optional exactly so a truncated
 * sequence still loses it — and the remainder then arrives as literal text a terminal prints rather
 * than obeys. Correct, and until now nowhere written down.
 */
test("an escape split across two writes still loses its introducer", () => {
  const stream = capture();
  installTerminalBoundary([stream]);
  stream.write("a\x1b[");
  stream.write("31mb\n");
  assert.equal(ACTIONABLE.test(stream.text), false, JSON.stringify(stream.text));
  assert.match(stream.text, /31mb/, "the orphaned tail is shown as text, which is the honest rendering");
});

/**
 * THE DEFAULT STREAM LIST — the half of the boundary nothing bound.
 *
 * Every test above hands `installTerminalBoundary` an explicit stream, which is what a test must do
 * to observe it — and it means the argument that actually SHIPS was exercised by nothing. Deleting
 * `process.stderr` from the default left 302/302 green, and stderr is the sink issue #78 names: a
 * `setupCommand` running `npm ci` inside the untrusted clone authors `setup.output`, `witness.ts`
 * interpolates 200 characters of it into a `fail()`, and `cli.ts` prints that with `console.error`.
 *
 * Driven as a process because that is the only place `process.stdout` and `process.stderr` are the
 * real things: wrapping this suite's own streams in-process would rewrite the reporter underneath
 * the run.
 */
test("the default stream list is both halves of the terminal — stdout AND stderr", () => {
  const dir = tmp("foundry-streams-");
  const script = join(dir, "default-streams.mjs");
  writeFileSync(
    script,
    `import { installTerminalBoundary } from ${JSON.stringify(pathToFileURL(TERMINAL).href)};\n` +
      `const hostile = ${JSON.stringify(HOSTILE)};\n` +
      // No argument: the production call, exactly as every entry point makes it.
      `installTerminalBoundary();\n` +
      `process.stdout.write(hostile + "\\n");\n` +
      // #78's named sink, reached the way a refusal reaches it.
      `console.error("witness: setup command failed — " + hostile);\n`,
  );

  const run = spawnNode(script, []);
  assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
  for (const [name, text] of [
    ["stdout", run.stdout],
    ["stderr", run.stderr],
  ] as const) {
    // Order matters: the raw-bytes check names the real fault. A stream left out of the default
    // list carries the probe as RAW escapes, in which case `concealedrepaintedgreen` is not
    // contiguous either — and "carried none of the probe" would be a true statement about the
    // wrong thing.
    assert.equal(
      ACTIONABLE.test(text),
      false,
      `${name} is not in the default stream list: raw control bytes reached it\n${JSON.stringify(text)}`,
    );
    assert.match(
      text,
      new RegExp(DEFANGED),
      `${name} carried none of the probe — this drive proves nothing:\n${JSON.stringify(text)}`,
    );
    assert.match(text, DISCLOSED, `${name} was stripped without saying so:\n${JSON.stringify(text)}`);
  }
});

/**
 * A preload that makes any entry point print hostile bytes THROUGH ITS OWN `console`.
 *
 * The injection has to sit ABOVE the stream, not below it. `installTerminalBoundary` replaces
 * `stream.write` and is therefore the outermost wrapper by construction, so anything that hooks the
 * stream first ends up INSIDE the boundary and its bytes are emitted after sanitising — proving
 * nothing. `console.log` / `console.error` are the layer above: a wrapper there is exactly a verb
 * that printed third-party text, which is the class the boundary claims to cover.
 *
 * The stream probe fires from inside the entry point's FIRST print, and both halves of it matter:
 *   · it is the entry point's own output that carries it, so an install that happens AFTER the
 *     first `console.log` (or under an `if (process.stdout.isTTY)` that is false in a runner) is
 *     caught by bytes already on the pipe;
 *   · it writes to stdout AND stderr, so the default stream list is bound per entry point too.
 * Not from a `process.on("exit")` handler, which would be the obvious place: piped stdio is
 * asynchronous on macOS and an exit-time write is a truncated one.
 *
 * `fetch` is replaced because a guard that reaches the network is a guard that fails on a plane. A
 * 500 is the shortest path from `verify-ledger.ts` to a printed line.
 */
function boundaryProbe(): string {
  const dir = tmp("foundry-probe-");
  const preload = join(dir, "probe.mjs");
  writeFileSync(
    preload,
    `const HOSTILE = ${JSON.stringify(HOSTILE)};
let probed = false;
function probe() {
  if (probed) return;
  probed = true;
  process.stdout.write(HOSTILE + " probe-stdout\\n");
  process.stderr.write(HOSTILE + " probe-stderr\\n");
}
for (const name of ["log", "error"]) {
  const inner = console[name].bind(console);
  console[name] = (...args) => {
    probe();
    inner(HOSTILE, ...args);
  };
}
globalThis.fetch = async () =>
  new Response(JSON.stringify({ message: "boundary probe: this guard does not use the network" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
`,
  );
  return preload;
}

/**
 * THE CLASS INVARIANT — the assertion round 1 did not have, and the reason it failed.
 *
 * Round 1 fixed issue #78 at two sinks and its test named those two sinks. A test that names call
 * sites can never see a third, and there were nine: seven raw `fail()` sites in `witness.ts`, the
 * freeze excerpt, and `policy.matchedPhrases`. So the invariant is stated over the CLASS instead:
 * the boundary is installed on the process's own streams, which means no sink can bypass it, and
 * the only remaining way out is a NEW ENTRY POINT that never installs it.
 *
 * BEHAVIOURAL, NOT A GREP. Round 2 stated this as `/installTerminalBoundary\(\)/.test(source)`, and
 * a regex that matches inside a comment is not evidence that anything runs. Four realistic
 * regressions survived it green: commenting the call out in `verify-ledger.ts`; commenting it out in
 * `validate-allowlist.ts`; guarding it with `if (process.stdout.isTTY)`, which is FALSE in the
 * Actions runner where the unattended six-hour clock actually runs, so the boundary would have been
 * off exactly where nobody is watching; and moving the call to the LAST line of
 * `validate-allowlist.ts`, after every `console.log` it makes. Only `cli.ts` had any behavioural
 * backup, and nothing anywhere checked "installed before anything prints".
 *
 * So each entry point is SPAWNED and made to print, and the assertion is over its bytes. That binds
 * the install, the ordering and the default stream list at once, and no comment can satisfy it.
 *
 * Entry points are DISCOVERED — from `package.json`'s scripts and from the workflow that runs
 * unattended — rather than listed here. Add `factory/whatever.ts` to either, and this test fails
 * until it has a drive below, or is written into `EXEMPT` with a reason.
 */
test("every operator entry point installs the terminal boundary — driven, not grepped", () => {
  const scripts = Object.values(
    JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts as Record<string, string>,
  );
  const workflows = readdirSync(join(REPO_ROOT, ".github/workflows")).map((f) =>
    readFileSync(join(REPO_ROOT, ".github/workflows", f), "utf8"),
  );
  /**
   * `_`, `.` and `/` are in the class because they were not, and the omission was the second hole
   * in this guard: `factory/rogue_verb.ts`, `factory/rogue.verb.ts` and `factory/tools/deep.ts` were
   * all invisible to `[A-Za-z0-9-]+`, so three uninstalled entry points passed green while the
   * comment above promised the opposite.
   */
  const ENTRY_POINT = /factory\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.ts)/g;
  const entryPoints = new Set<string>();
  for (const text of [...scripts, ...workflows]) {
    for (const m of text.matchAll(ENTRY_POINT)) entryPoints.add(m[1]);
  }
  assert.ok(entryPoints.size >= 4, `entry-point discovery found only ${[...entryPoints].join(", ")}`);
  for (const expected of ["cli.ts", "verify-ledger.ts", "validate-allowlist.ts", "run-tests.ts"]) {
    assert.ok(entryPoints.has(expected), `discovery missed ${expected}; the regex above has drifted`);
  }
  // The discovery itself, pinned against the shapes it used to miss.
  for (const shape of ["factory/rogue_verb.ts", "factory/rogue.verb.ts", "factory/tools/deep.ts"]) {
    assert.deepEqual(
      [...shape.matchAll(ENTRY_POINT)].map((m) => m[1]),
      [shape.slice("factory/".length)],
      `${shape} is invisible to entry-point discovery, so it could ship without the boundary`,
    );
  }

  /**
   * The one exemption, and it is not an operator surface. `run-tests.ts` pipes `node:test`'s own
   * reporter into stdout — our output, legitimately coloured — and wrapping that stream would strip
   * the colour a developer reads the suite by. It prints no third-party text: its inputs are this
   * repository's own test files. Asserted by source and not by a drive on purpose: the drive would
   * be this suite running itself.
   */
  const EXEMPT = new Map([["run-tests.ts", "pipes node:test's own reporter; prints no third-party text"]]);

  /**
   * How to make each entry point print, offline. A drive is not optional: an entry point with no
   * way to observe its output is an entry point whose boundary nobody can check.
   *   · `cli.ts --help` is the shortest verb that prints.
   *   · `validate-allowlist.ts` takes no arguments and prints four lines.
   *   · `verify-ledger.ts` reads the committed seed and asks GitHub; the probe's 500 puts it on its
   *     `console.error` + `exit(1)` path, which is the stderr half in its own right.
   */
  const DRIVES = new Map<string, { args: string[]; code: number }>([
    ["cli.ts", { args: ["--help"], code: 0 }],
    ["validate-allowlist.ts", { args: [], code: 0 }],
    ["verify-ledger.ts", { args: [], code: 1 }],
  ]);

  const probe = boundaryProbe();
  for (const file of [...entryPoints].sort()) {
    if (EXEMPT.has(file)) {
      const source = readFileSync(resolve(REPO_ROOT, "factory", file), "utf8");
      assert.equal(
        /installTerminalBoundary\(/.test(source),
        false,
        `${file} is listed EXEMPT but installs the boundary — pick one`,
      );
      continue;
    }
    const drive = DRIVES.get(file);
    assert.ok(
      drive,
      `factory/${file} is a discovered entry point with no drive in this test. Add one — arguments that make it print, offline — or add it to EXEMPT above with the reason it prints nothing third-party. A drive is how this guard stopped being a grep.`,
    );

    const run = spawnNode(resolve(REPO_ROOT, "factory", file), drive.args, { preload: probe });
    assert.equal(run.code, drive.code, `factory/${file} ${drive.args.join(" ")}:\n${run.stdout}${run.stderr}`);
    for (const [name, text] of [
      ["stdout", run.stdout],
      ["stderr", run.stderr],
    ] as const) {
      // The raw-bytes assertion goes FIRST, because an entry point that never installs the boundary
      // fails both: its probe arrives as raw escapes, so `concealedrepaintedgreen` is not contiguous
      // in it either, and "wrote nothing" would be the wrong diagnosis of the right failure.
      assert.equal(
        ACTIONABLE.test(text),
        false,
        `factory/${file} let raw terminal control bytes reach ${name}. Either it never calls installTerminalBoundary(), or it calls it AFTER it starts printing, or it calls it on a stream list that leaves ${name} out.\n${JSON.stringify(text)}`,
      );
      assert.match(
        text,
        new RegExp(DEFANGED),
        `factory/${file} wrote nothing to ${name}, so this drive asserts nothing about it. Pick arguments that print on both streams.\n${JSON.stringify(text)}`,
      );
    }
    assert.match(
      `${run.stdout}${run.stderr}`,
      DISCLOSED,
      `factory/${file} stripped the probe without disclosing it — a sanitiser that tidies in silence is itself a concealment channel`,
    );
  }
});

/**
 * And the boundary is the ONLY definition of the strip, so there is one rule rather than a rule and
 * a copy of it. The copy is how this repository has shipped the same defect repeatedly.
 */
test("the sanitiser has exactly one home", () => {
  const owners = readdirSync(join(REPO_ROOT, "factory"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => /export function sanitizeTerminalText/.test(readFileSync(join(REPO_ROOT, "factory", f), "utf8")));
  assert.deepEqual(owners, ["terminal.ts"]);
});
