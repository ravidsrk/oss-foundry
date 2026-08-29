import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { removeTmpDirs, tmp } from "./tmp-dir.ts";

const FACTORY = fileURLToPath(new URL(".", import.meta.url));

/**
 * Issue #64: every `mkdtempSync` site in the suite leaked its directory. 41,213 `foundry-*`
 * directories when the issue was filed; **576,921** on the same machine by the time it was fixed,
 * with a full run adding 195.
 *
 * Measured rather than asserted, because the delta is the acceptance criterion and no test can
 * observe its own process's exit handler: one full run under a clean `TMPDIR` leaves **0**
 * `foundry-*` directories on this branch and **195** at `origin/main`. What the tests below can
 * pin is the mechanism that produces that number, and the door staying the only door.
 */

test("tmp() creates a real directory and removeTmpDirs() takes it away again", () => {
  const dir = tmp("foundry-tmpdir-selftest-");

  assert.ok(dir.startsWith(join(tmpdir(), "foundry-tmpdir-selftest-")), `${dir} is not under the requested prefix`);
  assert.ok(existsSync(dir), `${dir} was named but not created`);

  // Contents too: `rmSync` is recursive, and a registry that only removed empty directories would
  // leave every fixture in the suite behind — they all write files.
  const file = join(dir, "fixture.json");
  writeFileSync(file, "{}");
  assert.equal(readFileSync(file, "utf8"), "{}");

  removeTmpDirs();
  assert.equal(existsSync(dir), false, `${dir} survived removeTmpDirs()`);

  // Idempotent, which is what lets a per-test `finally` and this registry coexist: several tests in
  // the suite still remove their own directory, and the exit handler must not throw over it.
  removeTmpDirs();
});

test("tmp() refuses a prefix that is a path rather than a filename fragment", () => {
  // These are removed RECURSIVELY at exit, so a prefix that escapes `$TMPDIR` would point a
  // recursive delete somewhere it must never point. Refused, not sanitised — silently rewriting a
  // caller's path is how the rewritten one gets deleted.
  for (const bad of ["../escape-", "foundry/nested-", "a\\b-"]) {
    assert.throws(() => tmp(bad), /filename fragment/, `tmp(${JSON.stringify(bad)}) was accepted`);
  }
});

/**
 * `tmp()` is the only door, enforced over the whole directory rather than a list of files.
 *
 * The leak was never one file's oversight — it was a house-wide convention, with two files having
 * hand-rolled the same registry and five having none. So the guard is stated the way
 * `run-tests.ts:8` argues for: discovered, not listed. An eighth test file that reaches for
 * `mkdtempSync` directly reds this the day it is written, which is the only version of this fix that
 * survives the next contributor.
 */
test("no test file calls mkdtempSync directly — tmp() is the only door", () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const name of readdirSync(FACTORY)) {
    if (!name.endsWith(".test.ts")) continue;
    scanned += 1;
    const source = readFileSync(join(FACTORY, name), "utf8")
      // Comments discuss `mkdtempSync` by name in several files, including this one.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    if (/\bmkdtempSync\s*\(/.test(source)) offenders.push(name);
  }

  assert.deepEqual(
    offenders,
    [],
    `these test files create temp directories outside the registry, so they leak: ${offenders.join(", ")}. Use \`tmp("foundry-…-")\` from factory/tmp-dir.ts.`,
  );
  // Not vacuous: a rename that made the scan match nothing would otherwise pass.
  assert.ok(scanned >= 10, `only ${scanned} test files were scanned; the discovery has drifted`);
});
