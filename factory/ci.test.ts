import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW_DIR = join(REPO_ROOT, ".github/workflows");

/**
 * Issue #54: the suite never ran in CI. `docs/SPEC.md` §8 conditions conformance on the
 * implementation's own evidence and names the test suite as the demonstration, and the
 * demonstration ran only on the machine of whoever remembered to type `npm test`.
 *
 * WHY A TEST AND NOT JUST THE WORKFLOW FILE. Adding `ci.yml` fixes the gap today; it does nothing
 * about the gap reopening. Deleting the `npm test` step, or adding a `paths:` filter that happens to
 * exclude `factory/`, would restore the exact original defect and no red mark anywhere would say so
 * — and a silently-gutted gate is worse than a missing one, because the green check keeps being
 * cited as evidence. This repository's own argument for machine enforcement (`docs/SPEC.md` §9, via
 * RepoComplianceBench) applies to its CI configuration too.
 *
 * HONEST LIMITATION, STATED RATHER THAN PAPERED OVER. Every other guard of this shape in the repo
 * is behavioural — `terminal.test.ts` SPAWNS each entry point rather than grepping for a call,
 * because "round 2 stated this as a regex and a regex that matches inside a comment is not evidence
 * that anything runs". That is not available here: GitHub Actions cannot be driven locally, so
 * there is no process to spawn and no bytes to assert over. This is a text-level check on a config
 * file and is the strongest oracle available for one. Two things keep it from being satisfied by a
 * comment: YAML comment lines are stripped before matching, and the trigger assertions parse the
 * `on:` block's own structure instead of searching the whole document for a keyword.
 */

/** The workflow files, with YAML comments removed so a commented-out step cannot satisfy a check. */
function workflows(): { name: string; text: string }[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((name) => {
      const text = readFileSync(join(WORKFLOW_DIR, name), "utf8")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
      return { name, text };
    });
}

/**
 * The `on:` block only, so `pull_request` appearing in a step name or an `if:` expression elsewhere
 * in the file cannot be mistaken for a trigger. Ends at the next top-level key.
 */
function triggerBlock(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^on:/.test(l));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^[A-Za-z]/.test(l));
  return rest.slice(0, end === -1 ? rest.length : end).join("\n");
}

test("some workflow runs the full test suite on the pull-request path", () => {
  const gates = workflows().filter((w) => /^\s*pull_request:\s*$/m.test(triggerBlock(w.text)));
  assert.ok(
    gates.length > 0,
    "no workflow triggers on `pull_request` — the suite is not a pull-request gate, which is issue #54 reopened",
  );

  // `npm test` or the runner directly; either is the whole suite. `node --test` on its own is NOT
  // accepted: run-tests.ts exists because `node --test` reports a file whose process exits mid-run
  // as a pass with zero subtests, exit 0.
  const runsSuite = gates.filter((w) => /run:\s*npm test\b/.test(w.text) || /run-tests\.ts/.test(w.text));
  assert.ok(
    runsSuite.length > 0,
    `workflows trigger on pull_request (${gates.map((g) => g.name).join(", ")}) but none runs the suite`,
  );

  // The validator too — issue #54's second bullet. It gates `allowlist.yaml` and
  // `policy-records.json`, and before this it ran only on the six-hour clock.
  const runsValidator = runsSuite.filter(
    (w) => /run:\s*npm run validate\b/.test(w.text) || /validate-allowlist\.ts/.test(w.text),
  );
  assert.ok(
    runsValidator.length > 0,
    `${runsSuite.map((r) => r.name).join(", ")} runs the suite on pull requests but not \`npm run validate\``,
  );
});

/**
 * The `pull_request:` trigger's own nested block, ending at the next sibling key.
 *
 * `{2}` is a literal space count, not `\s{2}`: `\s` also matches a newline, so the sloppier form
 * expresses "two of any whitespace" when the actual rule is "a sibling key indented two spaces".
 * `\S` rather than `\w` so a quoted key (`"push":`) also ends the block. Erring toward returning
 * MORE text is the safe direction here — the caller asserts an absence, so over-reading can only
 * cause a false failure, never a false pass.
 */
function pullRequestBlock(on: string): string {
  const from = on.slice(on.indexOf("pull_request:"));
  const next = from.slice(1).search(/\n {2}\S/);
  return next === -1 ? from : from.slice(0, next + 1);
}

/**
 * A `paths:` or `paths-ignore:` filter on the gate's `pull_request` trigger is the quiet version of
 * deleting the workflow: the check does not fail, it does not run, and a pull request that changes
 * nothing on the list merges with no suite behind it. This repo has no such filter and should not
 * acquire one silently — every `*.ts` in `factory/` is load-bearing for every other one.
 */
test("the pull-request gate is not narrowed by a path filter", () => {
  /**
   * The extractor first, against the shapes it has to survive — raised in review of this file as
   * "the boundary regex treats the first nested property as the next trigger", which would have
   * left `scoped` equal to `pull_request:\n` and the assertion below permanently green. The claim
   * was checked and is not true of either indentation, but "I checked" is not evidence, so the
   * cases are pinned here where a future edit to the regex has to keep them passing.
   */
  const NARROWED = [
    'on:\n  pull_request:\n    paths: ["docs/**"]\n  push:\n    branches: ["main"]\n',
    'on:\n  push:\n    branches: ["main"]\n  pull_request:\n    paths-ignore:\n      - "docs/**"\n',
    'on:\n  pull_request:\n    types: [opened]\n    paths: ["docs/**"]\n',
  ];
  for (const yaml of NARROWED) {
    const block = pullRequestBlock(triggerBlock(yaml));
    assert.match(
      block,
      /paths(-ignore)?:/,
      `the pull_request block extractor stops before a path filter in:\n${yaml}\nso the assertion below could never see one`,
    );
  }
  // ...and it does not over-read into a sibling trigger's keys, which would make the absence
  // assertion fail on a workflow that is perfectly fine.
  assert.doesNotMatch(
    pullRequestBlock(triggerBlock('on:\n  pull_request:\n  push:\n    paths: ["x"]\n')),
    /paths:/,
    "the extractor read past pull_request: into push:, so an unrelated trigger's path filter would red this test",
  );

  for (const w of workflows()) {
    const on = triggerBlock(w.text);
    if (!/^\s*pull_request:\s*$/m.test(on)) continue;
    if (!/run:\s*npm test\b/.test(w.text) && !/run-tests\.ts/.test(w.text)) continue;
    assert.doesNotMatch(
      pullRequestBlock(on),
      /paths(-ignore)?:/,
      `${w.name} filters its pull_request trigger by path, so a change outside the filter merges with no suite behind it`,
    );
  }
});

/**
 * The post-merge half. A merge commit is a state no pull-request run ever tested — the pull request
 * tests the branch, and with a merge-commit strategy the result is a commit that existed nowhere
 * until the merge. Issue #54's acceptance asks for both a push and a pull request.
 */
test("the suite also runs on push to main, so a merge commit is tested", () => {
  const pushGates = workflows().filter((w) => {
    const on = triggerBlock(w.text);
    if (!/^\s*push:/m.test(on)) return false;
    return /run:\s*npm test\b/.test(w.text) || /run-tests\.ts/.test(w.text);
  });
  assert.ok(
    pushGates.length > 0,
    "no workflow runs the suite on push — nothing tests the merge commit that a merge-commit strategy creates",
  );
  for (const w of pushGates) {
    assert.match(
      triggerBlock(w.text),
      /branches:\s*\[?\s*["']?main["']?/,
      `${w.name} runs the suite on push but does not name main, so the post-merge gate may not cover the default branch`,
    );
    /**
     * The validator on the push path, asserted here and not inferred from the pull-request test.
     * Today both triggers share one job, so removing `npm run validate` reds the pull-request test
     * too — but that is a property of the current file layout, not of the claim this test makes.
     * Split the gate into a pull-request workflow and a push workflow, keep the validator only in
     * the first, and the post-merge path would silently stop checking `allowlist.yaml` and
     * `policy-records.json` while both tests stayed green.
     */
    assert.ok(
      /run:\s*npm run validate\b/.test(w.text) || /validate-allowlist\.ts/.test(w.text),
      `${w.name} runs the suite on push but not the validator, so a merge commit is never checked against allowlist.yaml or policy-records.json`,
    );
    /**
     * An unconditional `cancel-in-progress` is the quiet way to lose this gate: two merges landing
     * close together cancel the earlier run, and the merge commit it was testing keeps a green
     * check it never earned. Caught in review of this very file, where it was written that way
     * first.
     *
     * The expression must NAME THE EVENT, not merely be an expression. Round 1 of this test only
     * required a `${{`, which `${{ true }}` satisfies while cancelling exactly the runs this
     * protects — raised on the pull request. Deliberately not pinned to one literal spelling:
     * `github.event_name == 'pull_request'` and `github.event_name != 'push'` are the same
     * decision, and a test that reds on a semantically identical rewrite trains people to edit the
     * test instead of reading it. Naming `github.event_name` is the invariant; which comparison is
     * style.
     */
    const concurrency = /^concurrency:$([\s\S]*?)(?=^\S)/m.exec(w.text)?.[1] ?? "";
    if (/cancel-in-progress:/.test(concurrency)) {
      assert.match(
        concurrency,
        /cancel-in-progress:\s*\$\{\{[^}]*github\.event_name[^}]*\}\}/,
        `${w.name} enables cancel-in-progress without conditioning it on github.event_name, so a push run can be cancelled and a merge commit keeps a green check it never earned`,
      );
    }
  }
});

/**
 * `verify-ledger.ts` reads live GitHub, so it fails for reasons unrelated to a diff — issue #49 is
 * the recorded instance where a maintainer moving a PR reddened `main` while every line was
 * correct. Issue #54 asked for its placement to be "a recorded decision rather than an accident";
 * this is the decision, enforced. Keeping it off the pull-request path is what makes the gate's red
 * mean "this diff is wrong" instead of "something moved on github.com".
 */
test("the live-GitHub ledger check stays off the pull-request path", () => {
  for (const w of workflows()) {
    if (!/^\s*pull_request:\s*$/m.test(triggerBlock(w.text))) continue;
    assert.doesNotMatch(
      w.text,
      /verify-ledger\.ts/,
      `${w.name} runs verify-ledger.ts on pull requests; it reconciles against live GitHub, so it reddens pull requests for reasons outside the diff (issue #49). It belongs on the clock.`,
    );
  }
});

/**
 * Every `uses:` in every workflow names an immutable commit, not a moving tag.
 *
 * A major tag like `@v4` is a reference the upstream owner can retarget, and these actions run
 * BEFORE any check in both workflows — so retargeted code could alter the checked-out workspace,
 * swap the Node toolchain, or change a gate's verdict. Raised by the review of the pull request
 * that added `ci.yml`, and pinned across BOTH workflows rather than only the new one: `ci.yml` is
 * read-only and secretless, while `oss-tick.yml` carries `issues: write` and a `GITHUB_TOKEN` and
 * runs unattended, so it is the higher-value target of the two.
 *
 * Stated over every workflow rather than over a list of files, for the reason `run-tests.ts:8`
 * gives: a hand-maintained roster is the same silent hole. A third workflow added tomorrow with a
 * mutable ref reds this immediately.
 *
 * Issue #85 owns the remaining half — a keep-current mechanism, because a pin nobody updates trades
 * a small supply-chain risk for certain drift, and that is a policy choice with an ongoing cost.
 */
test("every workflow action is pinned to an immutable commit", () => {
  const seen: string[] = [];
  for (const w of workflows()) {
    for (const m of w.text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)) {
      const ref = m[1];
      const comment = m[2];
      seen.push(`${w.name}: ${ref}`);
      const at = ref.lastIndexOf("@");
      assert.notEqual(at, -1, `${w.name} uses \`${ref}\` with no ref at all, so it floats on the default branch`);
      assert.match(
        ref.slice(at + 1),
        /^[0-9a-f]{40}$/,
        `${w.name} uses \`${ref}\`, a mutable ref. Pin the 40-character commit SHA with a trailing \`# vX.Y.Z\` comment; the upstream owner can retarget a tag, and this runs before every check in the job.`,
      );
      assert.match(
        comment,
        /#\s*v\d+\.\d+\.\d+/,
        `${w.name} pins \`${ref}\` without a \`# vX.Y.Z\` comment, so Dependabot cannot name the release it is updating`,
      );
    }
  }
  // The scan itself is not vacuous: a rename or an indentation change that made the pattern miss
  // every `uses:` line would otherwise pass this test by finding nothing to check.
  assert.ok(seen.length >= 4, `action discovery found only ${seen.length} \`uses:\` lines (${seen.join(", ")})`);
});

test("pinned action SHAs have a keep-current mechanism (issue #85)", () => {
  const text = readFileSync(join(REPO_ROOT, ".github/dependabot.yml"), "utf8");
  assert.match(text, /package-ecosystem:\s*github-actions/);
  assert.match(text, /directory:\s*\//);
  assert.match(text, /schedule:/);
});

/**
 * ISSUE: `engines.node` read `>=22` while every documented command in this repository passes
 * `--experimental-strip-types`, a flag that does not exist before **22.6.0**. A stranger on 22.4
 * satisfied the declared floor and got `node: bad option: --experimental-strip-types`.
 *
 * WHY THIS IS A TEST AND NOT A RUNTIME CHECK. Node rejects an unknown option *before* executing
 * anything — verified: `node --experimental-bogus-flag -e 'console.log(1)'` prints `node: bad
 * option:` and runs no code. So on the versions the floor is meant to exclude, no in-process check
 * can possibly run. A runtime `process.versions.node` guard would be unreachable dead code. The
 * only enforceable thing is that the DECLARED floor stays true, and that CI actually executes it.
 *
 * Three claims, each of which can drift independently:
 *   1. the floor equals the flag's introduction version,
 *   2. every script still passes the flag — because if one stopped, the real floor would jump to
 *      22.18.0 (where stripping became default-on) and the manifest would be silently wrong,
 *   3. CI runs the declared floor, so the claim is executed rather than asserted.
 */
const STRIP_TYPES_ADDED = "22.6.0";

test("the declared Node floor is the version that introduced the flag every script passes", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };
  assert.equal(
    manifest.engines?.node,
    `>=${STRIP_TYPES_ADDED}`,
    `engines.node must be >=${STRIP_TYPES_ADDED} — the release that added --experimental-strip-types. Anything lower claims support for versions where Node aborts on the flag before running a line.`,
  );

  // Claim 2: the floor is only correct while every entry point passes the flag explicitly.
  const scripts = Object.entries(manifest.scripts ?? {});
  assert.ok(scripts.length > 0, "package.json declares no scripts");
  /**
   * A node INVOCATION, not the word "node". `\bnode\b` matched `@types/node@24.9.2` in the
   * typecheck script — `/` and `@` are both word boundaries — and demanded a strip-types flag from
   * an npm install. Anchoring to a command position is the fix: start of string, or after `&&`,
   * `||`, `;` or a pipe.
   */
  const NODE_INVOCATION = /(?:^|&&|\|\||;|\|)\s*node\s/;
  for (const [name, body] of scripts) {
    if (!NODE_INVOCATION.test(body)) continue;
    assert.match(
      body,
      /--experimental-strip-types/,
      `script \`${name}\` runs node without --experimental-strip-types: \`${body}\`. Relying on default-on type stripping moves the real floor to 22.18.0, so engines.node above is now wrong.`,
    );
  }
  // ...pinned both ways, because a predicate that matched nothing would make the loop vacuous.
  assert.equal(NODE_INVOCATION.test("node --experimental-strip-types factory/cli.ts"), true);
  assert.equal(NODE_INVOCATION.test("npm i x && node --experimental-strip-types a.ts"), true);
  assert.equal(NODE_INVOCATION.test("npm install @types/node@24.9.2"), false, "@types/node is not an invocation");
  assert.equal(NODE_INVOCATION.test("./node_modules/.bin/tsc --noEmit"), false, "node_modules is not an invocation");
});

test("CI executes the declared Node floor, it does not merely assert it", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  const floor = (manifest.engines?.node ?? "").replace(/^>=/, "");
  const ci = workflows().find((w) => w.name === "ci.yml");
  assert.ok(ci, "ci.yml is missing");

  const matrix = ci.text.match(/node:\s*\[([^\]]*)\]/);
  assert.ok(matrix, "ci.yml declares no node version matrix — the floor claim is then untested");
  const legs = matrix[1]!.split(",").map((v) => v.trim().replace(/^["']|["']$/g, ""));
  assert.ok(
    legs.includes(floor),
    `ci.yml matrix ${JSON.stringify(legs)} does not run the declared floor ${floor}. A floor no run exercises is a claim, not a guarantee.`,
  );
  // ...and the line an operator actually runs, where type stripping is Stable rather than a
  // release candidate. Testing only the floor would prove the project works nowhere anyone runs it.
  assert.ok(
    legs.some((v) => v === "24" || v.startsWith("24.")),
    `ci.yml matrix ${JSON.stringify(legs)} omits Node 24, the Active LTS and the only line where type stripping is Stability 2 (Stable).`,
  );
  assert.match(
    ci.text,
    /\$\{\{\s*matrix\.node\s*\}\}/,
    "ci.yml declares a node matrix but setup-node does not consume it, so every leg runs the same version",
  );
});

/**
 * The type-check gate, guarded the same way the suite step is (issue #54's argument): adding it
 * fixes today, and does nothing about it being deleted. `--experimental-strip-types` erases types
 * without checking them and ignores `tsconfig.json`, so if this step goes the repository silently
 * returns to having no type enforcement at all — and the green check keeps being cited as evidence.
 *
 * Also asserted: the checker is version-PINNED. An unpinned `npx typescript` would let the gate's
 * strictness drift under us on someone else's release schedule, which for a check that reads every
 * line of the tree is a supply-chain surface as well as a reproducibility one.
 */
test("CI type checks, with a pinned checker, and the manifest stays dependency-free", () => {
  const ci = workflows().find((w) => w.name === "ci.yml");
  assert.ok(ci, "ci.yml is missing");
  assert.match(
    ci.text,
    /run:\s*npm run typecheck/,
    "ci.yml no longer runs `npm run typecheck` — nothing in the pipeline reads the types",
  );

  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
    dependencies?: unknown;
    devDependencies?: unknown;
  };
  const typecheck = manifest.scripts?.typecheck;
  assert.ok(typecheck, "package.json declares no typecheck script");
  assert.match(typecheck, /typescript@\d+\.\d+\.\d+/, `typecheck must pin typescript exactly: ${typecheck}`);
  assert.match(typecheck, /@types\/node@\d+\.\d+\.\d+/, `typecheck must pin @types/node exactly: ${typecheck}`);
  assert.match(typecheck, /--no-save/, "the checker must not be written into package.json");
  assert.match(typecheck, /--no-package-lock/, "the checker must not create a lockfile");

  // The property the transient install exists to preserve: a clone needs nothing to run the suite.
  assert.equal(manifest.dependencies, undefined, "package.json declares runtime dependencies");
  assert.equal(
    manifest.devDependencies,
    undefined,
    "package.json declares devDependencies — the type checker is meant to be installed transiently by the typecheck script, so a clone still needs no install to run `npm test`",
  );
});
