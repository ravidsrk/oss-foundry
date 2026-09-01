import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tmp } from "./tmp-dir.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The suite's own oracle depends on one property the type definitions do not admit exists.
 *
 * `factory/run-tests.ts` refuses a run in which any file reported zero tests or any failing test,
 * and it reads the failure count from `node:test`'s `test:summary` event as `counts.failed`.
 * `@types/node` (checked through 24.9.2) omits `failed` from that shape, so the source carries a
 * narrow cast. A cast is a promise to the compiler, and an unchecked promise about the one field the
 * whole suite's verdict rests on is worth nothing.
 *
 * So the promise is checked at runtime. If a future Node drops or renames `failed`, this reds —
 * loudly, here — instead of `run-tests.ts` silently reading `undefined`, evaluating `undefined > 0`
 * as false, and reporting a suite that has failures as green.
 *
 * SPAWNED, not run in-process. `node:test`'s `run()` called from inside a test emits no per-file
 * summary — attempted first, and it reported zero summaries rather than one. A child process is
 * also the honest shape: it observes what the real oracle observes, in the same conditions.
 *
 * The probe is written to a FILE rather than passed with `--eval`, and that is not incidental.
 * Under `--input-type=module --eval`, `run({ files: [...] })` emits no per-file summary at all —
 * confirmed against a working file-based probe side by side. Two false negatives came out of that
 * before the cause was clear: first `process.argv` shifts under `--eval` so the path was
 * `undefined`, and then even with the path supplied by environment the eval form still emitted
 * nothing. Both looked identical to "the property is missing", which is precisely the wrong
 * conclusion for this test to reach by accident.
 */
const PROBE = `
import { run } from "node:test";
const counts = [];
const stream = run({ files: [process.env.PROBE_FILE], concurrency: false });
stream.on("test:summary", (e) => { if (typeof e.file === "string") counts.push(e.counts); });
stream.on("data", () => {});
stream.on("end", () => { process.stdout.write(JSON.stringify(counts)); });
`;

test("node:test's per-file summary really carries a numeric `failed` count", () => {
  // `ids.test.ts` is the probe target: fast, no scratch-dir dependency, and a file the oracle
  // accounts for anyway.
  const probePath = join(tmp("foundry-oracle-probe"), "probe.mjs");
  writeFileSync(probePath, PROBE);
  // `NODE_TEST_CONTEXT` must be DELETED, not blanked. Node keys "am I inside a test file?" on the
  // variable's presence, so an inherited one makes the child print `run() is being called
  // recursively within a test file. skipping running files.` and emit nothing — the third false
  // negative this test produced before the cause was found, and again indistinguishable from the
  // property being absent. Setting it to "" is still setting it.
  const childEnv: Record<string, string | undefined> = { ...process.env, PROBE_FILE: "factory/ids.test.ts" };
  delete childEnv.NODE_TEST_CONTEXT;
  const out = execFileSync(process.execPath, ["--experimental-strip-types", probePath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: childEnv,
  });
  const summaries = JSON.parse(out) as Record<string, unknown>[];

  assert.equal(summaries.length, 1, `expected one per-file summary, got ${summaries.length}: ${out}`);
  const counts = summaries[0]!;
  assert.ok(
    "failed" in counts,
    `test:summary counts has no \`failed\` key — run-tests.ts reads it to decide the suite verdict. Keys present: ${Object.keys(counts).sort().join(", ")}`,
  );
  assert.equal(
    typeof counts.failed,
    "number",
    `test:summary \`failed\` is ${typeof counts.failed}, not a number — the oracle's \`failed > 0\` comparison would be meaningless`,
  );
  // ...and the other field the oracle reads, for the same reason.
  assert.equal(typeof counts.tests, "number");
  assert.ok((counts.tests as number) > 0, "the probe target reported zero tests, so this proves nothing");
});
