import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  installTerminalBoundary,
  sanitizeTerminalText,
  terminalBoundaryNotice,
  type TerminalStream,
} from "./terminal.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

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

test("the sanitiser removes whole sequences, keeps the shape of a log, and says how much it took", () => {
  const clean = sanitizeTerminalText(HOSTILE);
  assert.equal(ACTIONABLE.test(clean.text), false, JSON.stringify(clean.text));
  assert.equal(clean.text, "concealedrepaintedgreen");
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
  for (const line of stream.written) assert.match(line, /concealedrepaintedgreen/);
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

test("installing the boundary twice does not sanitise twice or double the disclosure", () => {
  const stream = capture();
  installTerminalBoundary([stream]);
  installTerminalBoundary([stream]);
  stream.write(`x${HOSTILE}\n`);
  const notices = stream.text.match(/byte\(s\) of terminal control sequence removed/g) ?? [];
  assert.equal(notices.length, 1, stream.text);
});

/**
 * THE CLASS INVARIANT — the assertion round 1 did not have, and the reason it failed.
 *
 * Round 1 fixed issue #78 at two sinks and its test named those two sinks. A test that names call
 * sites can never see a third, and there were nine: seven raw `fail()` sites in `witness.ts`, the
 * freeze excerpt, and `policy.matchedPhrases`. So the invariant is stated over the CLASS instead:
 * the boundary is installed on the process's own streams, which means no sink can bypass it, and
 * the only remaining way out is a NEW ENTRY POINT that never installs it.
 *
 * Entry points are therefore DISCOVERED — from `package.json`'s scripts and from the workflow that
 * runs unattended — rather than listed here. Add `factory/whatever.ts` to either, and this test
 * fails until it either installs the boundary or is written into `EXEMPT` with a reason.
 */
test("every operator entry point installs the terminal boundary — a tenth sink cannot bypass it", () => {
  const scripts = Object.values(
    JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts as Record<string, string>,
  );
  const workflows = readdirSync(join(REPO_ROOT, ".github/workflows")).map((f) =>
    readFileSync(join(REPO_ROOT, ".github/workflows", f), "utf8"),
  );
  const entryPoints = new Set<string>();
  for (const text of [...scripts, ...workflows]) {
    for (const m of text.matchAll(/factory\/([A-Za-z0-9-]+\.ts)/g)) entryPoints.add(m[1]);
  }
  assert.ok(entryPoints.size >= 4, `entry-point discovery found only ${[...entryPoints].join(", ")}`);
  for (const expected of ["cli.ts", "verify-ledger.ts", "validate-allowlist.ts", "run-tests.ts"]) {
    assert.ok(entryPoints.has(expected), `discovery missed ${expected}; the regex above has drifted`);
  }

  /**
   * The one exemption, and it is not an operator surface. `run-tests.ts` pipes `node:test`'s own
   * reporter into stdout — our output, legitimately coloured — and wrapping that stream would strip
   * the colour a developer reads the suite by. It prints no third-party text: its inputs are this
   * repository's own test files.
   */
  const EXEMPT = new Map([["run-tests.ts", "pipes node:test's own reporter; prints no third-party text"]]);

  for (const file of [...entryPoints].sort()) {
    const source = readFileSync(resolve(REPO_ROOT, "factory", file), "utf8");
    const installs = /installTerminalBoundary\(\)/.test(source);
    if (EXEMPT.has(file)) {
      assert.equal(installs, false, `${file} is listed EXEMPT but installs the boundary — pick one`);
      continue;
    }
    assert.equal(
      installs,
      true,
      `factory/${file} is an entry point that never installs the terminal boundary: third-party bytes it prints reach the operator's terminal raw. Call installTerminalBoundary() before it prints anything, or add it to EXEMPT above with the reason it prints nothing third-party.`,
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
