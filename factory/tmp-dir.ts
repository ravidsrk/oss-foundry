import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One home for scratch directories in the test suite, and the only place `mkdtempSync` is called.
 *
 * WHAT IT COST TO NOT HAVE THIS. Every `mkdtempSync` site in the suite leaked its directory. Issue
 * #64 measured 41,213 `foundry-*` directories in one `$TMPDIR`; by the time it was fixed the same
 * machine held **576,921**, and a full run added about 195 more. That is past a tidiness complaint:
 * it is enough to slow directory enumeration in `$TMPDIR` for everything else on the machine, and
 * the per-run cost is growing rather than static, because the suite now drives real clones and real
 * test commands end to end.
 *
 * WHY A MODULE AND NOT A HELPER PER FILE. It was already two — `evidenceScratchDir` in
 * `engine.test.ts` and `scratch` in `terminal.test.ts`, the same six lines written twice, with the
 * other five test files having no cleanup at all. `fixture-counts.ts` states the rule this follows:
 * "Two copies of one rule is the defect this repository keeps shipping: the rule drifts on one side,
 * the other side keeps passing, and nothing says so because each copy looks correct read on its own."
 *
 * WHY `process.on("exit")` AND NOT AN `after()` HOOK IN EACH FILE. An `after()` per file is a
 * hand-maintained roster of seven files that have to remember, and `run-tests.ts:8` names that shape
 * as "the same silent hole this runner exists to close from the other end": the eighth test file
 * would leak, silently, and nothing would say so. Registering inside this module means a call site
 * cannot forget, because using `tmp()` at all is what installs the cleanup. `rmSync` is synchronous,
 * which is what makes it legal in an exit handler.
 *
 * Deliberately NOT a `.test.ts`: `run-tests.ts` collects every `*.test.ts` in this directory, and
 * a shared helper that registered itself as a test file would be counted as one.
 */

/** Every directory handed out this process, newest last. */
const created: string[] = [];
let installed = false;

/**
 * `mkdtempSync(join(tmpdir(), prefix))`, registered for removal when the process exits.
 *
 * The prefix is a filename fragment, not a path: a separator in it would place the directory
 * somewhere other than `$TMPDIR`, and — since these are removed recursively — somewhere other than
 * `$TMPDIR` is precisely where a recursive remove must never be pointed. Refused rather than
 * sanitised, because silently rewriting a caller's path is how you end up deleting the rewritten one.
 */
export function tmp(prefix: string): string {
  if (prefix.includes("/") || prefix.includes("\\") || prefix.includes("\0")) {
    throw new Error(`tmp() prefix must be a filename fragment, not a path: ${JSON.stringify(prefix)}`);
  }
  if (!installed) {
    installed = true;
    process.on("exit", removeTmpDirs);
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * Remove every directory `tmp()` handed out, and forget them.
 *
 * Exported for the test that proves this module works — the cleanup has to be callable from an
 * assertion, not only from an exit handler nothing can observe. Idempotent: `rmSync` with
 * `force: true` is a no-op on a directory a test already removed itself, which is what lets a
 * per-test `finally` and this registry coexist without either having to know about the other.
 */
export function removeTmpDirs(): void {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
