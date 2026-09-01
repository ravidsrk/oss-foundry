import { readdirSync } from "node:fs";
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * Discovered, not listed. A hand-maintained roster is the same silent hole this runner exists to
 * close from the other end: a `*.test.ts` nobody remembered to add runs never and says nothing.
 */
export function testFiles(dir = import.meta.dirname): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * `node --test` on its own is not a trustworthy oracle for this repo, and the runner's exit code
 * is the thing that lies. A test file whose *process* exits mid-run — which any module-scope
 * `process.exit(0)` reachable from an import will do — is reported as a passing top-level entry
 * with zero subtests, and the run exits 0. Reproduced on this tree: restoring the pre-guard
 * `await main()` + `process.exit(0)` pair in factory/cli.ts made `factory/engine.test.ts`
 * contribute 0 of its 71 tests while the summary read `tests 42 / pass 42 / fail 0`, exit 0.
 * Every provenance, subject-binding and log-path assertion in the repo disappeared without a
 * single red mark.
 *
 * So the count is asserted, not inferred: `run()` emits one `test:summary` per file, and this
 * refuses unless every declared file reported one and reported at least one test in it. A missing
 * or empty file summary is a failed run, exactly like a failed assertion.
 */
async function main(): Promise<void> {
  const files = testFiles();
  if (files.length === 0) {
    console.error("no *.test.ts files found — refusing to report a green run over nothing");
    process.exitCode = 1;
    return;
  }
  const perFile = new Map<string, { tests: number; failed: number }>();

  const stream = run({ files, concurrency: true });
  stream.on("test:summary", (event) => {
    // The run-wide summary carries no `file`; only the per-file ones do.
    if (typeof event.file !== "string") return;
    /**
     * `counts.failed` is real and this cast is a TYPES gap, not a guess. `@types/node` (checked
     * through 24.9.2) omits `failed` from the `test:summary` counts while the runtime emits it —
     * verified directly: the event carries
     * `{tests,failed,passed,cancelled,skipped,todo,topLevel,suites}`. Casting rather than reaching
     * for `any` keeps the other seven fields checked, and `run-tests.test.ts` pins the runtime
     * property so that if Node ever DOES drop it, a test says so instead of this file silently
     * reading `undefined` and reporting every file as having zero failures.
     */
    const counts = event.counts as typeof event.counts & { failed: number };
    perFile.set(event.file, { tests: counts.tests, failed: counts.failed });
  });

  // `pipe()` returns the destination, not a promise — await the transfer itself, or the checks
  // below run against an empty map and the runner reports a hole that is only its own impatience.
  await pipeline(stream.compose(spec), process.stdout, { end: false });

  const problems: string[] = [];
  for (const file of files) {
    const summary = perFile.get(file);
    if (!summary) {
      problems.push(
        `${file} reported no summary — its process ended before the runner could account for it`,
      );
      continue;
    }
    if (summary.tests === 0) {
      problems.push(
        `${file} reported 0 tests — a file that runs nothing is a hole in the suite, not a pass (an unguarded process.exit reachable from one of its imports will do this)`,
      );
    }
    if (summary.failed > 0) {
      problems.push(`${file} reported ${summary.failed} failing test(s)`);
    }
  }

  if (problems.length > 0) {
    console.error("\nsuite refused:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  const total = [...perFile.values()].reduce((sum, c) => sum + c.tests, 0);
  console.log(`\nsuite ok — ${total} tests across ${files.length} files, every file accounted for`);
}

await main();
