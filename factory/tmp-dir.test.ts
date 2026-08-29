import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
 * `tmp()` is the only door, enforced over every file in the directory rather than a list of files.
 *
 * The leak was never one file's oversight — it was a house-wide convention, with two files having
 * hand-rolled the same registry and five having none. So the guard is stated the way
 * `run-tests.ts:8` argues for: discovered, not listed.
 *
 * SCANNED OVER `*.ts` AND NOT ONLY `*.test.ts`, raised in review of this branch. Test-reachable
 * support code is not a `.test.ts` — `fixture-counts.ts` is the precedent, and it exists precisely
 * because shared test support needs a file the runner does not collect. A helper module that reached
 * for `mkdtempSync` would have leaked on every test that imported it while a `.test.ts`-only scan
 * stayed green, which is the same one-consumer-fixed-sibling-bare shape as issue #80.
 */
const EXEMPT: Record<string, string> = {
  "tmp-dir.ts": "is the one home; this is the implementation the rule is about",
  "witness.ts":
    "production, not test support: `hostRunner`'s scratch dir holds a real clone that must outlive " +
    "no process-exit registry, and its lifecycle is the protocol's own `cleanup` step. Issue #56 " +
    "made it `mkdtempSync` deliberately, and a test module is not importable from production.",
};

test("nothing but tmp() calls mkdtempSync — the door is the only door", () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const name of readdirSync(FACTORY)) {
    if (!name.endsWith(".ts")) continue;
    if (Object.hasOwn(EXEMPT, name)) continue;
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
    `these files create temp directories outside the registry, so they leak: ${offenders.join(", ")}. Use \`tmp("foundry-…-")\` from factory/tmp-dir.ts, or add an entry to EXEMPT above with the reason it is not test scratch.`,
  );
  // Not vacuous: a rename that made the scan match nothing would otherwise pass. The directory
  // holds well over thirty `.ts` files, so this floor only trips if discovery itself broke.
  assert.ok(scanned >= 25, `only ${scanned} files were scanned; the discovery has drifted`);
});

/**
 * The exit listener itself, driven in a child process — not `removeTmpDirs()` called by hand.
 *
 * Raised in review of this branch, and it is the sharper half of the fix. Every migrated test file
 * relies on `process.on("exit", …)` firing; the tests above call the cleanup directly, so deleting
 * the registration would leave all 46 sites leaking again with the suite green. That is the exact
 * shape #83 was three rounds long over: "the boundary's mechanism was thoroughly tested and its
 * shipped configuration was not."
 *
 * So a child process asks for a directory, prints it, and exits normally. The parent then asserts
 * the path is gone. Nothing about that can be satisfied by a comment, and it fails if the listener
 * is removed, registered too late, or registered on the wrong event.
 */
test("the exit handler removes the directory without anyone calling cleanup", () => {
  const script = [
    `import { tmp } from ${JSON.stringify(join(FACTORY, "tmp-dir.ts"))};`,
    `process.stdout.write(tmp("foundry-exit-drive-"));`,
  ].join("\n");
  const entry = join(tmp("foundry-exit-parent-"), "drive.ts");
  writeFileSync(entry, script);

  const child = spawnSync(process.execPath, ["--experimental-strip-types", entry], { encoding: "utf8" });
  assert.equal(child.status, 0, `child failed: ${child.stderr}`);

  const childDir = child.stdout.trim();
  assert.ok(
    childDir.startsWith(join(tmpdir(), "foundry-exit-drive-")),
    `child did not report a scratch directory: ${JSON.stringify(child.stdout)}`,
  );
  // The child created it and never removed it itself. If it is gone, the exit handler ran.
  assert.equal(
    existsSync(childDir),
    false,
    `${childDir} outlived the process that made it — the exit handler did not run, so every migrated call site leaks`,
  );
});
