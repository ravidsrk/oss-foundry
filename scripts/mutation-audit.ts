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

  // ---- SWEEP 2 (#77–#82): six review comments a prior sweep merged past without reading ----
  // Each of these is one call site of a fix, on purpose. The recurring defect in this repository is
  // a well-tested function behind untested wiring — a fix applied to one consumer and not its
  // sibling, eight times — so a mutant per FUNCTION would keep reporting a clean sheet over exactly
  // the gap that keeps shipping. Where a fix touched two consumers, both are listed separately.

  // #77 — the freeze showed 4,000 characters and then claimed a clean scan over the whole document.
  {
    label: "i77-claim",
    file: "factory/packet.ts",
    from: "  } else if (withheld > 0) {",
    to: "  } else if (false) {",
    why: "the freeze closes with `no ban statement matched in N chars` over text the operator was never shown — the sentence directly above the attest, and #37's parked scanner leg is what makes the missed ban real",
  },
  {
    label: "i77-marker",
    file: "factory/packet.ts",
    from:
      "        `  ⟪ ${missing} more characters of ${doc.name} are NOT shown above. The scanner read them; you have not. ⟫`,\n",
    to: '        "",\n',
    why: "the omission is announced only in a header 4,000 characters up, so the operator scrolling to where the text stops sees nothing marking the end",
  },
  {
    label: "i77-consumer",
    file: "factory/cli.ts",
    from: "    if (packetForFreeze) console.log(renderFreezeEvidence(packetForFreeze));",
    to: "    if (packetForFreeze) console.log(renderFreezeEvidence(packetForFreeze).split(\"\\n\")[0]);",
    why: "the render is correct and the verb prints one line of it — the exact untested-wiring shape this audit exists for",
  },

  // #78 — a witnessed third-party repo could write raw control sequences to the operator's console.
  {
    label: "i78-sanitizer",
    file: "factory/terminal.ts",
    from: '  const stripped = text.replace(TERMINAL_SEQUENCE, "").replace(CONTROL_CHAR, "");',
    to: "  const stripped = text;",
    why: "a sandboxed repo repaints the one surface whose job is to say what happened: `\\r` plus a cursor move turns a red witness green, and OSC 52 reaches the clipboard",
  },
  {
    label: "i78-probe-sink",
    file: "factory/witness.ts",
    from: '    const lines = sanitizeTerminalText(probe.output).text.split("\\n")',
    to: '    const lines = probe.output.split("\\n")',
    why: "the failure detail is clean and the SECOND repo-controlled sink is not — `witness-check` prints the probe's `path` verbatim",
  },

  // #79 — the halt gate ran after the platform requests it exists to prevent.
  {
    label: "i79-tick-preflight",
    file: "factory/cli.ts",
    from: "  if (factoryHalt(state)) return applyTick(state);\n",
    to: "",
    why: "a halted factory spends 24 GitHub requests per tick before refusing (6 per roster row x 4 rows, re-measured on this tree) — the retry SPEC.md §6 forbids, against the very limit that wrote the halt",
  },
  {
    label: "i79-approve-preflight",
    file: "factory/cli.ts",
    from: "      const gate = maySelectRepo(state, packetForFreeze.repoId);\n      if (!gate.ok) {\n        console.error(`cannot approve ${id}: ${gate.reason}`);\n        process.exit(1);\n      }\n",
    to: "",
    why: "same rule, the approve sibling: three reads go out under a halt and are then thrown away",
  },
  {
    label: "i79-tick-verdict",
    file: "factory/engine.ts",
    from: "  const halted = factoryHalt(state);\n  if (halted) {\n    const next = appendEvent(\n      state,\n      ev(\"tick\", `Tick refused — factory halted ${halted.at}: ${halted.reason}`),\n    );\n    return { state: next, packet: null, reason: `Factory halted ${halted.at}: ${halted.reason}` };\n  }\n",
    to: "",
    why: "a halted tick reports `idle` and exits 0 — the per-repo gate refuses every candidate and the absence of candidates reads as a quiet roster",
  },

  // #80 — witness log paths resolved against cwd; the class #43 fixed for STATE_FILE, left in a sibling.
  {
    label: "i80-read-anchor",
    file: "factory/cli.ts",
    from: "    return readFileSync(resolve(LOGS_ROOT, path), \"utf8\");",
    to: '    return readFileSync(resolve(path), "utf8");',
    why: "`attach-witness` run from anywhere but the repo root rejects a perfectly good witness as a missing log",
  },
  {
    label: "i80-write-anchor",
    file: "factory/cli.ts",
    from: "  root = LOGS_ROOT,",
    to: '  root = ".",',
    why: "the write sibling: run logs land beside the operator's shell while the evidence page keeps promising them inside the checkout",
  },
  {
    label: "i80-default",
    file: "factory/cli.ts",
    from: "  return resolve(override ?? REPO_ROOT);",
    to: "  return override ? resolve(override) : resolve(\".\");",
    why: "the override still works, so every test that passes `--logs-root` stays green while the DEFAULT — the half the bug was in — is back",
  },

  {
    label: "i80-test-guard",
    file: "factory/cli.ts",
    from: "  if (root === LOGS_ROOT && !LOGS_ROOT_FLAG && process.env.NODE_TEST_CONTEXT) {",
    to: "  if (false) {",
    why: "anchoring took away the temp-cwd isolation spawned-CLI tests had for free, so a test that forgets `--logs-root` writes two run logs into the developer's real checkout — which this change already did once before the guard existed",
  },

  // #81 — the operator revert verb bypassed the deadline the classifier enforces.
  {
    label: "i81-gate",
    file: "factory/engine.ts",
    from: "  if (window.known && !window.within) {",
    to: "  if (false) {",
    why: "a rollback of a merge from a year ago increments `reverts`, and `health()` makes that an unconditional permanent stop only a seed edit lifts",
  },
  {
    label: "i81-predicate",
    file: "factory/scorecard.ts",
    from: "    within: atMs <= deadlineMs,",
    to: "    within: true,",
    why: "the shared window always says yes — both halves of one documented definition stop enforcing it together, which is the point of sharing it",
  },
  {
    label: "i81-consumer",
    file: "factory/cli.ts",
    from: "    const result = applyRevert(state, id, { source: \"operator\", why: reason, at });\n    if (result.error) {\n      console.error(result.error);\n      process.exit(1);\n    }",
    to: "    const result = applyRevert(state, id, { source: \"operator\", why: reason, at });\n    if (result.error) {\n      console.error(result.error);\n    }",
    why: "the engine refuses and the verb carries on — the operator is told the repo was halted by a run that exited 0 having written nothing",
  },

  // #82 — the derived-figure guard failed permissively AND strictly.
  {
    label: "i82-case",
    file: "factory/policy-records.ts",
    from: "const RATIO_IN_WORDS = /\\b\\d[\\d,]*\\s*of\\s*\\d[\\d,]*\\b/i;",
    to: "const RATIO_IN_WORDS = /\\b\\d[\\d,]*\\s*of\\s*\\d[\\d,]*\\b/;",
    why: "`141 Of 272 external PRs merged` renders as a maintainer's own words again — the exact defect #44 added the guard to stop, one shift key away",
  },
  {
    label: "i82-path",
    file: "factory/policy-records.ts",
    from: "const RATIO_AS_SLASH = /(?<![/\\w])\\b\\d[\\d,]*\\s*\\/\\s*\\d[\\d,]*\\b(?![/\\w])/;",
    to: "const RATIO_AS_SLASH = /\\b\\d[\\d,]*\\s*\\/\\s*\\d[\\d,]*\\b/;",
    why: "a numeric path segment reads as a ratio, so a valid silent-absence note throws out of a lazy cache and takes `validate` and every packet build with it",
  },


  // ---- SWEEP 2, ROUND 2: the three Requireds a review found in the round-1 fixes themselves ----
  // The through-line of both rounds is ONE defect: a fix applied to a consumer and not its siblings.
  // These mutants are therefore written against the CLASS wherever the fix is class-level, and
  // against each RENDERING wherever a number is shown more than once.

  // REQUIRED 1 — issue #78 was closed at two sinks and left at least nine open (seven raw `fail()`
  // sites in witness.ts, the freeze excerpt, and policy.matchedPhrases). It is now closed at the
  // process's terminal streams, so a tenth sink is behind it the day it is written.
  {
    label: "r1-boundary-cli",
    file: "factory/cli.ts",
    from: "  installTerminalBoundary();\n  await main();",
    to: "  await main();",
    why: "every verb prints third-party bytes raw again: a hostile CONTRIBUTING's `\\x1b[8m` hides every disclosure #77 added, and an OSC 52 out of a setupCommand reaches the clipboard",
  },
  {
    label: "r1-boundary-inert",
    file: "factory/terminal.ts",
    from: "  for (const stream of streams) {",
    to: "  for (const stream of [] as TerminalStream[]) {",
    why: "the boundary is installed by every entry point and wraps nothing — the shape a class-level fix fails in, which a per-sink test would never see",
  },
  {
    label: "r1-boundary-silent",
    file: "factory/terminal.ts",
    from: "        scrubbed.removed === 0",
    to: "        true",
    why: "the strip happens and is never disclosed — a sanitiser that hands the operator a coherent transcript with no sign the coherence was ours is itself a concealment channel",
  },
  {
    label: "r1-boundary-verify-ledger",
    file: "factory/verify-ledger.ts",
    from: "installTerminalBoundary();\n\n",
    to: "",
    why: "the unattended 6-hour clock is back outside the boundary — the entry-point invariant is the only thing standing between a new entry point and a tenth sink",
  },

  // REQUIRED 2 — #77's acceptance is "N characters not shown"; N was pinned nowhere. The round-1
  // fixture made 883 a substring of 4883, so every assertion matched inside the TOTAL and all four
  // of these survived a green suite. `0 characters not shown` above a hidden ban is affirmative
  // false reassurance: worse than the silence #77 replaced.
  {
    label: "r2-count-header",
    file: "factory/packet.ts",
    from: "(first ${doc.excerpt.length} shown, ${missing} NOT shown)",
    to: "(first ${doc.excerpt.length} shown, 0 NOT shown)",
    why: "the header reports 0 characters withheld over a document that withheld 1,234 of them",
  },
  {
    label: "r2-header-clause",
    file: "factory/packet.ts",
    from: "${missing > 0 ? ` (first ${doc.excerpt.length} shown, ${missing} NOT shown)` : \"\"}",
    to: "\"\"",
    why: "the whole header clause reverts to base — source and size, with the omission gone",
  },
  {
    label: "r2-count-marker",
    file: "factory/packet.ts",
    from: "`  ⟪ ${missing} more characters of ${doc.name}",
    to: "`  ⟪ 0 more characters of ${doc.name}",
    why: "the marker at the exact place a scrolling reader stops says 0 characters are missing",
  },
  {
    label: "r2-count-closing",
    file: "factory/packet.ts",
    from: "      `  BUT ${withheld} of those ${total} characters are not shown above.",
    to: "      `  BUT 0 of those ${total} characters are not shown above.",
    why: "the sentence directly above the attest — the one #77 exists for — reads `BUT 0 of those 5234 characters are not shown`",
  },

  // REQUIRED 3 — the shared window predicate was handed two different SUBJECTS: the classifier the
  // event's date, the operator's verb the moment they typed. Same rollback, opposite verdicts, in
  // the safety-relevant direction.
  {
    label: "r3-at-dropped",
    file: "factory/cli.ts",
    from: "    const result = applyRevert(state, id, { source: \"operator\", why: reason, at });",
    to: "    const result = applyRevert(state, id, { source: \"operator\", why: reason });",
    why: "`--at` is parsed, validated, and then not passed — the round-1 shape exactly: a flag the help text promises and the engine never sees, so the window dates from the typing again",
  },
  {
    label: "r3-at-unparseable",
    file: "factory/cli.ts",
    from: "    if (at !== undefined && !Number.isFinite(Date.parse(at))) {",
    to: "    if (false) {",
    why: "`--at \"last Tuesday\"` reaches `revertWindow` as an unparseable date, which returns `known: false` — so a typo in the flag silently skips the window check entirely",
  },
  {
    label: "r3-refusal-verb",
    file: "factory/engine.ts",
    from: "are only writing it down now, re-run with \\`--at <iso>\\` naming the day THEY did it",
    to: "are only writing it down now, record it as a follow-up note instead",
    why: "the refusal names a verb that does not exist — 18 verbs in `--help`, none records a note — which is the defect issue #35 was filed against, restored inside the message that fixed it",
  },

  // ---- ROUND 2 MINORS ----
  {
    label: "min-osc-newline",
    file: "factory/terminal.ts",
    from: "[^\\\\x07\\\\x1b\\\\x9c\\\\n]*",
    to: "[^\\\\x07\\\\x1b\\\\x9c]*",
    why: "the sanitiser swallows the diagnostic it exists to preserve: a run whose output contains a bare `\\x1b]0;t` loses every line after it, including the real failure — #78's own harm, achieved through the sanitiser",
  },
  {
    label: "min-removed-guard",
    file: "factory/witness.ts",
    from: "  if (scrubbed.removed > 0) {",
    to: "  if (scrubbed.removed >= 0) {",
    why: "every witness failure prints `0 byte(s) of terminal control sequence removed`; a notice that fires every run is one the operator learns to skip",
  },
  {
    label: "min-removed-count",
    file: "factory/witness.ts",
    from: "      `  ${scrubbed.removed} byte(s) of terminal control sequence removed",
    to: "      `  0 byte(s) of terminal control sequence removed",
    why: "the count is always zero — an affirmative false statement about output that WAS tampered with",
  },
  {
    label: "min-window-deadline",
    file: "factory/scorecard.ts",
    from: "    deadline: new Date(deadlineMs).toISOString(),\n",
    to: "",
    why: "strip-types erases the field without checking: the refusal reads `past the 30-day window that closed undefined`",
  },
  {
    label: "min-window-days",
    file: "factory/scorecard.ts",
    from: "    days: Math.floor((atMs - mergedMs) / 86_400_000),\n",
    to: "",
    why: "same, one field over: `undefined days after the merge`, in the message that has to justify a permanent repository stop",
  },
  {
    label: "min-classify-days",
    file: "factory/scorecard.ts",
    from: "    const days = window.known ? window.days : 0;",
    to: "    const days = 0;",
    why: "the classifier's own late-rollback explanation says a commit landed 0 days after the merge while discarding it for being late",
  },
  {
    label: "min-manifest-anchor",
    file: "factory/cli.ts",
    from: "    return readFileSync(resolve(path), \"utf8\");",
    to: "    return readFileSync(resolve(LOGS_ROOT, path), \"utf8\");",
    why: "the operator/repo-relative split #80 turns on collapses back: `--manifest ./witness.json` stops meaning the operator's shell. Every fixture passed an ABSOLUTE path, so this survived round 1",
  },
  {
    label: "min-halt-event",
    file: "factory/engine.ts",
    from: "    const next = appendEvent(\n      state,\n      ev(\"tick\", `Tick refused — factory halted ${halted.at}: ${halted.reason}`),\n    );\n    return { state: next, packet: null,",
    to: "    return { state, packet: null,",
    why: "a halted tick refuses on the terminal and writes nothing to the ledger — the console line evaporates with the exit and the next reader sees a six-hour gap with no cause",
  },
  {
    label: "min-ratio-lookahead",
    file: "factory/policy-records.ts",
    from: "const RATIO_AS_SLASH = /(?<![/\\w])\\b\\d[\\d,]*\\s*\\/\\s*\\d[\\d,]*\\b(?![/\\w])/;",
    to: "const RATIO_AS_SLASH = /(?<![/\\w])\\b\\d[\\d,]*\\s*\\/\\s*\\d[\\d,]*\\b/;",
    why: "the RIGHT half of the path exclusion: `2026/08/28` at the start of a note reads as a ratio again, and every fixture in round 1 put the numeric segment after a `/`, exercising only the lookbehind",
  },
  {
    label: "min-logs-root-slash",
    file: "factory/cli.ts",
    from: "  return resolve(override ?? REPO_ROOT);",
    to: "  return override ? resolve(override) : REPO_ROOT;",
    why: "the default branch stops normalising, so `--help` prints `…/oss-foundry//docs/evidence/logs/<packetId>/` — a doubled slash in the one line that says where the run logs are",
  },

  // ---- SWEEP 2, ROUND 3: the boundary was thoroughly tested and its SHIPPED CONFIGURATION was not
  // Every round-2 test handed the mechanism an explicit argument — an explicit stream list, an
  // explicit `--logs-root`, an explicit C1 byte that was also a sequence introducer — so nothing
  // bound the defaults an operator actually runs. These are those defaults, one mutant per way each
  // of the round-3 Requireds could go, including the two that SHIPPED green.

  {
    label: "r3-default-stderr",
    file: "factory/terminal.ts",
    from: "  streams: TerminalStream[] = [process.stdout, process.stderr],",
    to: "  streams: TerminalStream[] = [process.stdout],",
    why: "the boundary's stderr half is gone and stderr is issue #78's named sink: a `setupCommand` running inside the untrusted clone authors `setup.output`, witness.ts puts 200 characters of it in a `fail()`, and cli.ts prints that with `console.error`. This SHIPPED green — every boundary test passed its own stream list",
  },
  {
    label: "r3-default-stdout",
    file: "factory/terminal.ts",
    from: "  streams: TerminalStream[] = [process.stdout, process.stderr],",
    to: "  streams: TerminalStream[] = [process.stderr],",
    why: "the other half of the same default: every freeze excerpt, matched phrase and issue title reaches the operator raw",
  },
  {
    label: "r3-entry-istty",
    file: "factory/verify-ledger.ts",
    from: "installTerminalBoundary();",
    to: "if (process.stdout.isTTY) installTerminalBoundary();",
    why: "the boundary is off in exactly the place nobody is watching: `isTTY` is false in the Actions runner where the unattended six-hour clock runs, and true on the developer's terminal where it is read",
  },
  {
    label: "r3-entry-validate",
    file: "factory/validate-allowlist.ts",
    from: "installTerminalBoundary();",
    to: "// installTerminalBoundary();",
    why: "one of the two entry points with no behavioural backup at all. A COMMENTED-OUT call still satisfies a source grep for `installTerminalBoundary()`, which is what round 2 asserted",
  },
  {
    label: "r3-entry-discovery",
    file: "factory/terminal.test.ts",
    from: "  const ENTRY_POINT = /factory\\/([A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.-]+)*\\.ts)/g;",
    to: "  const ENTRY_POINT = /factory\\/([A-Za-z0-9-]+\\.ts)/g;",
    why: "the guard's own discovery, narrowed back: `factory/rogue_verb.ts`, `factory/rogue.verb.ts` and `factory/tools/deep.ts` become invisible to it, so three uninstalled entry points would pass green. A mutant against the guard rather than against production, because the guard IS the production control here",
  },
  {
    label: "r3-sweep-c1",
    file: "factory/terminal.ts",
    from: "const CONTROL_CHAR = /[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]/g;",
    to: "const CONTROL_CHAR = /[\\x00-\\x08\\x0b-\\x1f]/g;",
    why: "`\\x8d` (RI) scrolls the screen with no `\\x1b` in it — the repaint-a-red-witness-green primitive — and `\\x85` (NEL) and `\\x7f` (DEL) go with it. Every C1 byte the round-2 fixtures carried was ALSO a sequence introducer, so the sweep itself was never the thing under test",
  },
  {
    label: "r3-logs-operator",
    file: "factory/cli.ts",
    from: "  if (root === LOGS_ROOT && !LOGS_ROOT_FLAG && process.env.NODE_TEST_CONTEXT) {",
    to: "  if (root === LOGS_ROOT && !LOGS_ROOT_FLAG) {",
    why: "the conjunct that makes the write guard \"inert for a real operator\": without it, `evidence <id> --base <sha> --head <sha>` with no `--logs-root` — the only documented spelling — is refused as a test run and the witness is thrown away. Every test passes `--logs-root`, so the conjunction short-circuited before the environment was ever read",
  },
  {
    label: "r3-at-trailing",
    file: "factory/cli.ts",
    from: '    refuseValuelessFlag(rest, "--at", "the rollback is dated now");\n',
    to: "",
    why: "`revert pkt --reason r --at` reads as no `--at` at all and dates the 30-day window from the typing — the exact failure the flag closes, reached silently by the operator who was trying hardest to avoid it",
  },

  // ---- ROUND 3: advisories the round-2 review left open, now closed ----
  {
    label: "r3-wrapped-weakset",
    file: "factory/terminal.ts",
    from: "    if (WRAPPED.has(stream)) continue;\n    WRAPPED.add(stream);\n",
    to: "",
    why: "a second install nests a second wrapper. The round-2 test for this was SPURIOUS — it asserted the disclosure does not double, which is true without the WeakSet because sanitising is idempotent — so the guard's own effect, the wrapper count, was pinned by nothing",
  },
  {
    label: "r3-write-passthrough",
    file: "factory/terminal.ts",
    from: '      return inner(typeof chunk === "string" ? out : Buffer.from(out, "utf8"), encoding, callback);',
    to: '      inner(typeof chunk === "string" ? out : Buffer.from(out, "utf8"));\n      return true;',
    why: "the boundary's own comment promises that \"back-pressure, `drain`, and write callbacks behave exactly as before\": this drops the callback, stranding every `write(chunk, cb)` caller, and reports a full pipe as an empty one",
  },
  {
    label: "r3-csi-final-byte",
    file: "factory/terminal.ts",
    from: '    "(?:\\\\x1b\\\\[|\\\\x9b)[0-?]*[ -/]*[@-~]?",',
    to: '    "(?:\\\\x1b\\\\[|\\\\x9b)[0-?]*[ -/]*[@-~]",',
    why: "the final byte stops being optional, so a CSI cut by a chunk boundary or by a tail slice keeps its introducer: `write(\"a\\x1b[\")` then `write(\"31mb\")` leaves a live introducer on the terminal, one concatenation from a working sequence",
  },
  {
    label: "r3-write-typedarray",
    file: "factory/terminal.ts",
    from: "      if (text === undefined) return inner(chunk, encoding, callback);",
    to: "      if (text === undefined) return inner(Buffer.from(String(chunk)), encoding, callback);",
    why: "a non-Buffer typed array is re-encoded through `String()` instead of passed through — raw bytes turned into `[object Uint8Array]` on the way to the stream",
  },
  {
    label: "r3-phrase-precedence",
    file: "factory/packet.ts",
    from: "  } else if (packet.policy.matchedPhrases.length > 0) {",
    to: "  } else if (packet.policy.matchedPhrases.length > 0 && withheld === 0) {",
    why: "a document that both matched a ban and was truncated loses the matched phrases from the block directly above the attest, replaced by a warning about unshown text — the strictly worse of the two orderings, since the phrases are the reason the verdict is DENY",
  },
  {
    label: "r3-ratio-spaces",
    file: "factory/policy-records.ts",
    from: "const RATIO_AS_SLASH = /(?<![/\\w])\\b\\d[\\d,]*\\s*\\/\\s*\\d[\\d,]*\\b(?![/\\w])/;",
    to: "const RATIO_AS_SLASH = /(?<![/\\w])\\b\\d[\\d,]*\\/\\d[\\d,]*\\b(?![/\\w])/;",
    why: "`141 / 272` walks through the derived-figure guard: every fixture wrote the ratio tight, so the whitespace either side of the slash was pinned by nothing and a spaced ratio goes into a maintainer's mouth on the evidence page",
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

/**
 * The tally, printed by the table rather than quoted in prose anywhere.
 *
 * docs/12-ledger.md used to state a figure ("27 single-line mutations … 26 must die and one must
 * survive") in the same paragraph that says a mutation score quoted in prose is not evidence. It
 * had drifted to less than half the real count by the next round, which is what a hand-copied
 * number does. The count now has exactly one source — this array — and one way to read it.
 */
function tally(): string {
  const controls = MUTANTS.filter((m) => m.expect === "survives").length;
  return `${MUTANTS.length} mutants: ${MUTANTS.length - controls} expected killed, ${controls} control(s) expected to survive`;
}

if (process.argv.includes("--list")) {
  for (const m of MUTANTS) console.log(`${m.label.padEnd(24)} ${m.file}\n${" ".repeat(25)}${m.why}`);
  console.log(`\n${tally()}`);
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
console.log(`baseline green; ${tally()}; running ${selected.length}\n`);

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
