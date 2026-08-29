/**
 * Mutation audit for the issue #39 surface (the revert re-check and the two review KPIs).
 *
 * WHY THIS IS COMMITTED. `npm test` passing says the suite runs; it does not say the suite would
 * NOTICE if the code stopped doing what the comments claim. Three times in this unit a fact had two
 * consumers, one was pinned and the other was not, and the suite stayed green while the two verbs
 * an operator reads disagreed about what had been checked. The claim "these lines are pinned" is
 * only worth anything if a reviewer can re-derive it, and a mutation count reported in prose is
 * exactly the kind of unverifiable assertion this repository exists to refuse.
 *
 *   node --experimental-strip-types scripts/mutation-audit.ts          # run every mutant
 *   node --experimental-strip-types scripts/mutation-audit.ts --list   # print the table only
 *   node --experimental-strip-types scripts/mutation-audit.ts req2a    # run one by label
 *
 * Each mutant is a single semantics-preserving-looking edit: the file still compiles and the
 * harness still runs, so a failure is a real assertion failing and never a build break. Every
 * mutant is applied, tested, and reverted from an in-memory copy of the original bytes, and the
 * baseline is re-verified green afterwards. It exits non-zero if any mutant SURVIVES or if the
 * baseline does not come back, so it can be read as a check rather than as a report.
 *
 * `--experimental-strip-types` is why so many of these are possible at all: types are erased, not
 * checked, so a dropped object field is a runtime `undefined` and a wrong-typed literal reaches the
 * function that dereferences it. The type annotations in this repo document intent; they do not
 * enforce it at runtime, and only a test does.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");

interface Mutant {
  label: string;
  file: string;
  /** Exactly one occurrence must exist, or the mutant is reported as stale rather than run. */
  from: string;
  to: string;
  /** What the mutant would break in production if it shipped. */
  why: string;
  /**
   * `"killed"` for every real mutant. `"survives"` marks a control that the suite MUST NOT catch —
   * a change with no behavioural content at all. Without one of those, a harness that had silently
   * broken into always-reporting-killed would look like a perfect score, and the whole run would be
   * the unfalsifiable claim it exists to replace.
   */
  expect?: "killed" | "survives";
}

const MUTANTS: Mutant[] = [
  // ---- REQUIRED 2: reconcile's incomplete-read surface (round 2 pinned only the clock's) ----
  {
    label: "req2a",
    file: "factory/cli.ts",
    from: "        revertTruncated: reverted?.ok ? reverted.truncated : undefined,\n",
    to: "",
    why: "reconcile stops reporting a page-capped commit read; the clock still does, so the two verbs disagree about what was checked",
  },
  {
    label: "req2b",
    file: "factory/cli.ts",
    from: "        revertTruncated: reverted?.ok ? reverted.truncated : undefined,",
    to: "        revertTruncated: false,",
    why: "a capped read is reported to reconcile as a complete one — the exact indistinguishability the flag exists to remove",
  },
  {
    label: "req2c",
    file: "factory/cli.ts",
    from: "          owed.push(\n            `${packet.id}: could not read ${packet.repoId} commits since the merge — a revert would go unnoticed this run (${reverted.error})`,\n          );\n",
    to: "",
    why: "a commit read GitHub refused outright is silent on reconcile",
  },
  {
    label: "req2d",
    file: "factory/cli.ts",
    from: "          owed.push(\n            `${packet.id}: could not read",
    to: "          doctrine.push(\n            `${packet.id}: could not read",
    why: "a failed read prints as DIVERGENCE, teaching that word a second meaning the bucket split exists to prevent",
  },

  // ---- REQUIRED 1: the review KPI had no consumer and no surface ----
  {
    label: "req1-advisory",
    file: "factory/ledger-check.ts",
    from: "  if (isTerminalReviewSubject(packet) && liveTerminal",
    to: "  if (false && isTerminalReviewSubject(packet) && liveTerminal",
    why: "a terminal packet the ledger never observed is silent again; noReview stays a rate over a quietly short denominator",
  },
  {
    label: "req1-idempotent",
    file: "factory/engine.ts",
    from: "  if (meta.humanReview) return { state, recorded: false };",
    to: "  if (false) return { state, recorded: false };",
    why: "the recovery re-folds on every tick, inflating two cumulative counters every six hours forever",
  },
  {
    label: "req1-consumer",
    file: "factory/engine.ts",
    from: "  if (!isTerminalReviewSubject(packet)) {",
    to: "  if (false) {",
    why: "an OPEN PR's review is folded into a mean defined over terminal outcomes",
  },
  {
    label: "req1-advice",
    file: "factory/engine.ts",
    from: 'run \\`reconcile\\` once GitHub answers the review endpoints (NOT \\`sync\\`, which refuses a terminal packet: "cannot sync PR from status ...")',
    to: "re-sync once GitHub answers the review endpoints",
    why: "the remedy names `sync`, which answers `cannot sync PR from status merged` — advice that cannot be followed",
  },
  {
    label: "req1-predicate-wide",
    file: "factory/scorecard.ts",
    from: '  return meta !== undefined && (meta.merged || meta.state === "closed");',
    to: "  return meta !== undefined;",
    why: "an open PR counts as a terminal outcome in both the writer and the reporter",
  },
  {
    label: "req1-predicate-narrow",
    file: "factory/scorecard.ts",
    from: '  return meta !== undefined && (meta.merged || meta.state === "closed");',
    to: "  return meta !== undefined && meta.merged;",
    why: "the closed-unmerged half of the KPI's definition silently drops out of both consumers",
  },

  // ---- MAJOR A: an unbounded read window against a fixed page cap ----
  {
    label: "majA-until-arg",
    file: "factory/github-pr.ts",
    from: "      until: Number.isFinite(windowEnd) ? new Date(windowEnd).toISOString() : undefined,\n",
    to: "",
    why: "the read window grows a day every day and never closes; past ~day 60 on a busy base branch every merged packet emits a permanent, unclearable truncation advisory",
  },
  {
    label: "majA-until-query",
    file: "factory/github-pr.ts",
    from: '  if (opts.until) query.set("until", opts.until);\n',
    to: "",
    why: "same, one layer down: the bound is computed and then dropped before the request",
  },

  // ---- MAJOR B: rel="next" unanchored — a fixture gap, not a parser bug ----
  {
    label: "majB-rel",
    file: "factory/github-pr.ts",
    from: 'const match = part.match(/<([^>]+)>\\s*;\\s*rel="next"/i);',
    to: 'const match = part.match(/<([^>]+)>\\s*;\\s*rel="[a-z]+"/i);',
    why: "on the Link header GitHub serves for a middle page the parser returns the `prev` cursor: pages 1<->2 ping-pong to the cap, a false `truncated: true`, and pages 3+ are never read",
  },

  // ---- MINORS ----
  {
    label: "min-cap-2",
    file: "factory/github-pr.ts",
    from: "export const MAX_COMMIT_PAGES = 10;",
    to: "export const MAX_COMMIT_PAGES = 2;",
    why: "the cap is 200 commits, so almost every revert window is a short read",
  },
  {
    label: "min-cap-100",
    file: "factory/github-pr.ts",
    from: "export const MAX_COMMIT_PAGES = 10;",
    to: "export const MAX_COMMIT_PAGES = 100;",
    why: "10,000 commits per merged packet per tick — the AUP's bulk-activity line",
  },
  {
    label: "min-per-page",
    file: "factory/github-pr.ts",
    from: 'const query = new URLSearchParams({ since: opts.since, per_page: "100" });',
    to: 'const query = new URLSearchParams({ since: opts.since, per_page: "1" });',
    why: "the 10-page cap becomes 10 commits; `MAX_COMMIT_PAGES` only means 1000 together with this",
  },
  {
    label: "min-base-ref",
    file: "factory/github-pr.ts",
    from: "      sha: meta.baseRef,\n",
    to: "",
    why: "a PR merged to a non-default base has its revert searched on the default branch and returns a silent clean bill of health on a SPEC.md §7 MUST",
  },
  {
    label: "min-prmeta-baseref",
    file: "factory/state.ts",
    from: '    optional(o.baseRef, (v) => typeof v === "string") &&\n',
    to: "",
    why: "a hand-edited non-string `baseRef` loads and goes into the commit query as the branch searched",
  },
  {
    label: "min-prmeta-mergesha",
    file: "factory/state.ts",
    from: '    optional(o.mergeCommitSha, (v) => typeof v === "string") &&\n',
    to: "",
    why: "a hand-edited `mergeCommitSha: 12345` loads and reaches `classifyRevert`'s `.toLowerCase()`",
  },
  {
    label: "min-prmeta-mergedat",
    file: "factory/state.ts",
    from: '    optional(o.mergedAt, (v) => typeof v === "string") &&\n',
    to: "",
    why: "a hand-edited non-string `mergedAt` loads and becomes both ends of the revert read window",
  },
  {
    label: "min-provenance-cli",
    file: "factory/cli.ts",
    from: '            source: "commit",',
    to: '            source: "operator",',
    why: "a machine-detected revert is recorded as maintainer-stated — words in a maintainer's mouth, permanently",
  },
  {
    label: "min-provenance-note",
    file: "factory/engine.ts",
    from: "`${REVERT_NOTE_PREFIX} (${input.source}) ${detail}`",
    to: "`${REVERT_NOTE_PREFIX} (operator) ${detail}`",
    why: "same, in the follow-up note",
  },
  {
    label: "min-provenance-event",
    file: "factory/engine.ts",
    from: "`REVERT recorded (${input.source}) on ${packet.repoId}",
    to: "`REVERT recorded (operator) on ${packet.repoId}",
    why: "same, in the scorecard event — the note and the event would then disagree",
  },
  {
    label: "min-short-sha",
    file: "factory/scorecard.ts",
    from: "  if (merge.length < 7 || !Number.isFinite(mergedMs)) {",
    to: "  if (!Number.isFinite(mergedMs)) {",
    why: "`classifyRevert` matches by prefix in both directions, so a 1-character recorded sha halts the repo on somebody else's revert",
  },
  {
    label: "min-usage",
    file: "factory/cli.ts",
    from: "  reconcile   (live re-read of every packet that names a PR;",
    to: "  RECONCILE_REMOVED   (live re-read of every packet that names a PR;",
    why: "a shipped verb goes missing from the only list of them",
  },

  // ---- NEGATIVE CONTROL ----
  // The clock's own copy of the line REQUIRED 2 is about. It was already killed before this round,
  // and it must still be — a harness that reported everything as killed would prove nothing, and one
  // that reported this as surviving would mean the harness, not the suite, had broken.
  {
    label: "control-noop",
    file: "factory/github-pr.ts",
    from: "  const commits: { sha: string; message: string; committedAt: string }[] = [];",
    to: "  const collected: { sha: string; message: string; committedAt: string }[] = [];\n  const commits = collected;",
    why: "POSITIVE CONTROL — a local rebinding with no behavioural content. It MUST survive: a harness where everything dies is not measuring the suite",
    expect: "survives",
  },
  {
    label: "control-clock-truncated",
    file: "factory/verify-ledger.ts",
    from: "    revertTruncated: reverted?.ok ? reverted.truncated : undefined,\n",
    to: "",
    why: "NEGATIVE CONTROL — the clock's sibling of req2a, pinned since round 2 and expected to be killed",
  },
];

function runSuite(): { ok: boolean; firstFailure: string } {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "factory/run-tests.ts"], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  const out = `${run.stdout}${run.stderr}`;
  const failure = /^✖ (.+)$/m.exec(out)?.[1] ?? "";
  return { ok: run.status === 0, firstFailure: failure };
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const selected = wanted.length > 0 ? MUTANTS.filter((m) => wanted.includes(m.label)) : MUTANTS;

if (process.argv.includes("--list")) {
  for (const m of MUTANTS) console.log(`${m.label.padEnd(24)} ${m.file}\n${" ".repeat(25)}${m.why}`);
  process.exit(0);
}

if (selected.length === 0) {
  console.error(`no mutant matches ${wanted.join(", ")} — run with --list`);
  process.exit(2);
}

const baseline = runSuite();
if (!baseline.ok) {
  console.error("baseline is not green — a mutation audit over a red suite means nothing");
  process.exit(2);
}
console.log(`baseline green; ${selected.length} mutant(s)\n`);

const survived: Mutant[] = [];
const stale: Mutant[] = [];
let killed = 0;
let inertControls = 0;

for (const mutant of selected) {
  const path = join(REPO, mutant.file);
  const original = readFileSync(path, "utf8");
  const hits = original.split(mutant.from).length - 1;
  if (hits !== 1) {
    stale.push(mutant);
    console.log(`${mutant.label}: STALE — ${hits} occurrence(s) of its anchor in ${mutant.file}`);
    continue;
  }
  writeFileSync(path, original.replace(mutant.from, mutant.to));
  let result: { ok: boolean; firstFailure: string };
  try {
    result = runSuite();
  } finally {
    // Always from the bytes read above, never from git — a restore that depends on the working
    // tree being clean is a restore that loses uncommitted work at the worst possible moment.
    writeFileSync(path, original);
  }
  const expected = mutant.expect ?? "killed";
  const actual = result.ok ? "survives" : "killed";
  if (actual === expected) {
    if (actual === "killed") killed += 1;
    else inertControls += 1;
    console.log(
      actual === "killed"
        ? `${mutant.label}: killed by "${result.firstFailure}"`
        : `${mutant.label}: survived, as its control requires`,
    );
  } else if (actual === "survives") {
    survived.push(mutant);
    console.log(`${mutant.label}: SURVIVED  <<< test gap — ${mutant.why}`);
  } else {
    survived.push(mutant);
    console.log(`${mutant.label}: KILLED but was expected to survive — the control is no longer inert`);
  }
  const restored = runSuite();
  if (!restored.ok) {
    console.error(`${mutant.label}: BASELINE NOT RESTORED — stopping`);
    process.exit(2);
  }
}

console.log(
  `\n${killed} killed, ${survived.length} unexpected, ${inertControls} inert control(s) survived as required, ${stale.length} stale`,
);
if (stale.length > 0) {
  console.error("stale mutants: their anchor text moved. Re-point them at the current source, do not delete them.");
}
process.exit(survived.length > 0 || stale.length > 0 ? 1 : 0);
