import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

/**
 * The entry-point guard on `factory/cli.ts`, driven as a process.
 *
 * This lives in its own file on purpose. The regression it locks — an unguarded `await main()`
 * that reaches `usage()` and `process.exit(0)` during module evaluation — kills the *process* of
 * whichever test file imports `cli.ts`, and `node --test` reports such a file as a passing
 * top-level entry with zero subtests. Put these assertions in `engine.test.ts` and the guard's
 * own regression deletes them. (`factory/run-tests.ts` refuses a run where any file reports no
 * tests, which is the other half of the same lock.)
 */

const CLI = join(import.meta.dirname, "cli.ts");
const REPO_ROOT = dirname(import.meta.dirname);
const USAGE_BANNER = /Foundry operator loop/;

function node(args: string[], opts: { cwd?: string } = {}) {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", ...args], {
    cwd: opts.cwd,
    encoding: "utf8",
  });
  return { ...run, seen: `${run.stdout}${run.stderr}` };
}

test("importing cli.ts does not run the CLI", () => {
  // The importer is a real script file, so `process.argv[1]` is *a* path that is not cli.ts —
  // exactly the shape `node --test factory/engine.test.ts` presents. If `main()` runs anyway it
  // reaches `usage()`, and the pre-guard code then called `process.exit(0)` from module scope:
  // the marker below would never print and the exit status would still be 0.
  const dir = mkdtempSync(join(tmpdir(), "foundry-entry-"));
  const importer = join(dir, "import-cli.mjs");
  writeFileSync(
    importer,
    `await import(${JSON.stringify(pathToFileURL(CLI).href)});\n` +
      `console.log("IMPORT_RETURNED");\n`,
  );

  const run = node([importer]);
  assert.equal(run.status, 0, run.seen);
  assert.match(
    run.stdout,
    /IMPORT_RETURNED/,
    "importing cli.ts must return to its importer — a module-scope process.exit here silently deletes the importing test file's whole suite",
  );
  assert.doesNotMatch(run.seen, USAGE_BANNER, "importing the module must not run main()");
});

test("spawning cli.ts as the entry point still runs main()", () => {
  // The complement: the guard must not be satisfiable only by never running. Both directions are
  // needed — deleting the guard passes the test above's exit-status check but fails this one's
  // sibling, and hard-coding `false` passes neither.
  const run = node([CLI, "--help"]);
  assert.equal(run.status, 0, run.seen);
  assert.match(run.stdout, USAGE_BANNER, run.seen);
  assert.match(run.stdout, /attach-witness <packetId> --manifest <path>/, run.seen);
});

test("the entry point is recognised through a symlinked checkout", () => {
  // `process.argv[1]` is the path the operator typed; `import.meta.url` is already canonical
  // because Node resolves symlinks when it loads a module. Comparing them without canonicalising
  // argv[1] makes the CLI exit 0 having printed nothing whenever the checkout is reached through a
  // link — a silent success, which is worse than the crash the guard replaced.
  const dir = mkdtempSync(join(tmpdir(), "foundry-symlink-"));
  const link = join(dir, "foundry-checkout");
  symlinkSync(REPO_ROOT, link, "dir");

  const run = node([join(link, "factory", "cli.ts"), "--help"]);
  assert.equal(run.status, 0, run.seen);
  assert.match(
    run.stdout,
    USAGE_BANNER,
    "invoked through a symlink the CLI printed nothing and exited 0",
  );
});
