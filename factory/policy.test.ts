import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hasDerivedFigure, parsePolicyRecords, policyRecordsPath } from "./policy-records.ts";
import { evaluatePolicy } from "./policy.ts";

test("denylist always forbids matplotlib", () => {
  const v = evaluatePolicy({
    repoId: "matplotlib/matplotlib",
    agentsMd: "tiny docs typo is fine",
    issueTitle: "typo",
  });
  assert.equal(v.code, "DENY_FORBIDDEN");
  assert.equal(v.allow, false);
});

test("forbidden phrase beats a welcome repo", () => {
  const v = evaluatePolicy({
    repoId: "ColeMurray/background-agents",
    agentsMd: "Autonomous agents not allowed on this tracker.",
    issueTitle: "icon tweak",
  });
  assert.equal(v.code, "DENY_FORBIDDEN");
});

test("CLA parks needs-human", () => {
  const v = evaluatePolicy({
    repoId: "OpenHands/OpenHands",
    agentsMd: "Please sign the CLA. HUMAN: required.",
    issueTitle: "docs FAQ",
  });
  assert.equal(v.code, "HOLD_CLA");
});

test("own wave 0 allowlisted changelog is ALLOW", () => {
  const v = evaluatePolicy({
    repoId: "ravidsrk/orca-fleet",
    agentsMd: "Agents may open draft PRs.",
    issueTitle: "[P2] CHANGELOG Unreleased",
  });
  assert.equal(v.code, "ALLOW");
  assert.equal(v.allow, true);
});

test("unknown repo is denied", () => {
  const v = evaluatePolicy({ repoId: "random/slop-magnet", issueTitle: "typo" });
  assert.equal(v.code, "DENY_UNKNOWN_POLICY");
});

test("files or diff over the repo cap is HOLD_SCOPE", () => {
  const files = evaluatePolicy({
    repoId: "ravidsrk/orca-fleet",
    agentsMd: "Agents may open draft PRs.",
    issueTitle: "docs tweak",
    filesHint: 99,
  });
  assert.equal(files.code, "HOLD_SCOPE");
  assert.equal(files.allow, false);

  const diff = evaluatePolicy({
    repoId: "ravidsrk/orca-fleet",
    agentsMd: "Agents may open draft PRs.",
    issueTitle: "docs tweak",
    diffHint: 401,
  });
  assert.equal(diff.code, "HOLD_SCOPE");
});

const MATPLOTLIB_STYLE_BAN = `Use of Generative AI. The following uses are unacceptable: External AI tooling (e.g. bots, agents) directly interacting with the project; including creating issues, PRs or commenting on GitHub or Discourse. Pull requests that are AI generated will be closed.`;

const QEMU_STYLE_BAN = `Current QEMU project policy is to DECLINE any contributions which are believed to include or derive from AI generated content. This policy may evolve as AI tools mature.`;

const KERNEL_STYLE_CONDITIONAL = `AI agents MUST NOT add Signed-off-by tags. Only humans can legally certify the Developer Certificate of Origin (DCO). The human submitter is responsible for reviewing all AI-generated code and adding their own Signed-off-by tag.`;

const AGENT_FRAMEWORK_README = `This repo orchestrates autonomous agents in E2B sandboxes. Each autonomous agent gets a fresh worktree and a task queue. AI slop is what these guardrails exist to prevent.`;

test("descriptive mention of autonomous agents is not a ban", () => {
  const v = evaluatePolicy({
    repoId: "ColeMurray/background-agents",
    agentsMd: AGENT_FRAMEWORK_README,
    issueTitle: "icon tweak",
  });
  assert.equal(v.code, "ALLOW");
});

test("a ban statement denies and captures the statement as the quote", () => {
  const v = evaluatePolicy({
    repoId: "mcp-use/mcp-use",
    contributing: MATPLOTLIB_STYLE_BAN,
    issueTitle: "docs fix",
  });
  assert.equal(v.code, "DENY_FORBIDDEN");
  assert.equal(
    v.matchedPhrases.some((p) => /will be closed/i.test(p)),
    true,
  );
});

test("a decline-first ban statement denies", () => {
  const v = evaluatePolicy({
    repoId: "mcp-use/mcp-use",
    contributing: QEMU_STYLE_BAN,
    issueTitle: "docs fix",
  });
  assert.equal(v.code, "DENY_FORBIDDEN");
});

test("kernel-style DCO conditional holds CLA, not forbidden", () => {
  const v = evaluatePolicy({
    repoId: "mcp-use/mcp-use",
    contributing: KERNEL_STYLE_CONDITIONAL,
    issueTitle: "docs fix",
  });
  assert.equal(v.code, "HOLD_CLA");
});

test("a welcome record attaches provenance to the verdict", () => {
  const v = evaluatePolicy({ repoId: "github/awesome-copilot", issueTitle: "add a prompt file" });
  assert.equal(v.code, "ALLOW");
  assert.equal(v.record?.source, "CONTRIBUTING.md");
  assert.equal(/🤖🤖🤖/.test(v.record?.quote ?? ""), true);
});

test("a conditional record holds with the quoted condition even without fetched docs", () => {
  const v = evaluatePolicy({ repoId: "mastra-ai/mastra", issueTitle: "docs fix" });
  assert.equal(v.code, "HOLD_HUMAN");
  assert.equal(/needs triage/.test(v.record?.quote ?? ""), true);
});

const MATPLOTLIB_CLAUSE_ONLY = `Use of Generative AI. The following uses are unacceptable: External AI tooling (e.g. bots, agents) directly interacting with the project; including creating issues, PRs or commenting on GitHub or Discourse.`;

const ZIG_STYLE_BAN = `We do not accept contributions written by LLMs.`;

const DO_NOT_ACCEPT_BAN = `We do not accept machine-generated patches.`;

const PYDANTIC_WELCOME = `We welcome the use of AI when contributing to Pydantic. However, users should certify that they fully understand the code being submitted.`;

const BOILERPLATE_ALLOW = `We maintain a high bar for code quality, so incomplete or untested submissions may be rejected during review. Please explain your changes clearly; issues without an explanation will be rejected.`;

const ROBOT_ALLOW = `This is a robot-cleaning simulation library. Submissions are rejected by CI when tests fail.`;

test("a ban clause behind an abbreviation dot still denies on its own", () => {
  const v = evaluatePolicy({ repoId: "mcp-use/mcp-use", contributing: MATPLOTLIB_CLAUSE_ONLY, issueTitle: "docs" });
  assert.equal(v.code, "DENY_FORBIDDEN");
});

test("active-voice refusals deny: do-not-accept phrasing", () => {
  const zig = evaluatePolicy({ repoId: "mcp-use/mcp-use", contributing: ZIG_STYLE_BAN, issueTitle: "docs" });
  assert.equal(zig.code, "DENY_FORBIDDEN");
  const machine = evaluatePolicy({ repoId: "mcp-use/mcp-use", contributing: DO_NOT_ACCEPT_BAN, issueTitle: "docs" });
  assert.equal(machine.code, "DENY_FORBIDDEN");
});

test("ordinary contributing prose is not a ban", () => {
  const welcome = evaluatePolicy({ repoId: "mcp-use/mcp-use", contributing: PYDANTIC_WELCOME, issueTitle: "docs" });
  assert.equal(welcome.code, "ALLOW");
  const boilerplate = evaluatePolicy({ repoId: "mcp-use/mcp-use", contributing: BOILERPLATE_ALLOW, issueTitle: "docs" });
  assert.equal(boilerplate.code, "ALLOW");
  const robot = evaluatePolicy({ repoId: "mcp-use/mcp-use", contributing: ROBOT_ALLOW, issueTitle: "docs" });
  assert.equal(robot.code, "ALLOW");
});

test("an affirmative record satisfies parse-policy-first for an unknown repo; a silent one does not", () => {
  const affirmative = evaluatePolicy(
    { repoId: "mcp-use/mcp-use", issueTitle: "docs" },
    {
      repoId: "mcp-use/mcp-use",
      source: "CONTRIBUTING.md",
      url: "",
      fetchedAt: "2026-08-28",
      stance: "welcome",
      conditions: [],
      quote: "We welcome all kinds of contributions!",
    },
  );
  assert.equal(affirmative.code, "ALLOW");
  assert.equal(affirmative.record?.stance, "welcome");

  const silent = evaluatePolicy(
    { repoId: "mcp-use/mcp-use", issueTitle: "docs" },
    {
      repoId: "mcp-use/mcp-use",
      source: "CONTRIBUTING.md",
      url: "",
      fetchedAt: "2026-08-28",
      stance: "silent",
      conditions: [],
      quote: "Parsed; no AI-contribution language found.",
    },
  );
  assert.equal(silent.code, "DENY_UNKNOWN_POLICY");
  assert.equal(silent.record?.stance, "silent");
});

/**
 * The invariant `docs/12-ledger.md` states for this field — "one verbatim statement from the
 * source", rendered to the maintainer as their own words — had no enforcement, so withdrawing the
 * unreproducible `Behaviorally open: 141 of 272 external PRs merged.` from the committed record was
 * a convention one edit could undo silently: putting it back left the whole suite green and the
 * evidence page quoted it back at the maintainer as if they had said it.
 *
 * Both directions are asserted, because a guard that refuses everything is not a guard: a `silent`
 * quote carrying a derived figure is refused at parse, and the absence notes the committed file
 * actually holds — dates, file paths and all — still load.
 */
const record = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    records: {
      "ColeMurray/background-agents": {
        source: "CONTRIBUTING.md",
        url: "https://github.com/ColeMurray/background-agents/blob/HEAD/CONTRIBUTING.md",
        fetchedAt: "2026-08-28",
        stance: "silent",
        conditions: [],
        quote: "No AI-contribution language in CONTRIBUTING.md, AGENTS.md, or CLAUDE.md.",
        ...over,
      },
    },
  });

test("a silent quote may hold an absence note but never a derived figure", () => {
  // Loads: the absence note the committed record carries.
  assert.equal(
    parsePolicyRecords(record()).get("ColeMurray/background-agents")?.stance,
    "silent",
  );
  // Loads: an absence note carrying a date and paths — the guard must not fire on those.
  assert.ok(
    parsePolicyRecords(
      record({
        quote:
          "No CONTRIBUTING.md at the root or .github/ as of 2026-08-28; the README is an examples catalog with no contribution or AI language.",
      }),
    ).get("ColeMurray/background-agents"),
  );

  // Refused: the exact string that was withdrawn, and the re-derived figure that replaced it.
  for (const figure of [
    "Behaviorally open: 141 of 272 external PRs merged.",
    "Behaviorally open: 250/408 non-owner PRs merged.",
    "Behaviorally open: 61% of non-owner PRs merged.",
  ]) {
    assert.throws(
      () => parsePolicyRecords(record({ quote: figure })),
      /is silent but its quote carries a derived figure/,
      figure,
    );
  }

  // A measurement in a maintainer's own prose is not this defect: only `silent` quotes are ours.
  assert.ok(
    parsePolicyRecords(
      record({ stance: "welcome", quote: "We merge roughly 9 of 10 community pull requests." }),
    ).get("ColeMurray/background-agents"),
  );
});

/**
 * The guard failed in BOTH directions at once, which is why one test covers both (issue #82).
 *
 * Permissive: the pattern had no `i` flag, so `of` matched lowercase only and `141 Of 272` walked
 * straight through the guard #44 added — the same unreproducible measurement in a maintainer's
 * mouth, one shift key away.
 *
 * Strict: the `number/number` alternative was unanchored, so it also matched the `2026/08` inside a
 * path. That contradicts the constant's own comment, which requires that "an ISO date, a file path
 * and a version number must all pass, because absence notes carry them" — and a rejected absence
 * note is not a cosmetic failure: `policyRecordFor` throws out of a lazy cache, so one such quote
 * takes down `validate` and every packet build that touches the record.
 */
test("the derived-figure guard reads case-insensitively and does not mistake a path for a ratio", () => {
  // Permissive direction. Every casing of the ratio word is the same claim.
  for (const figure of [
    "Behaviorally open: 141 Of 272 external PRs merged.",
    "Behaviorally open: 141 OF 272 external PRs merged.",
    "Behaviorally open: 141 oF 272 external PRs merged.",
  ]) {
    assert.throws(
      () => parsePolicyRecords(record({ quote: figure })),
      /is silent but its quote carries a derived figure/,
      figure,
    );
  }

  // Strict direction. A numeric path segment is a path, not a measurement.
  for (const note of [
    "no CONTRIBUTING.md at docs/2026/08 as of 2026-08-28",
    "nothing under .github/2026/08/ and nothing in AGENTS.md as of 2026-08-28",
    "checked https://example.invalid/docs/2026/08/policy as of 2026-08-28",
  ]) {
    assert.ok(
      parsePolicyRecords(record({ quote: note })).get("ColeMurray/background-agents"),
      note,
    );
  }

  // …and the loosening must not cost the catch it was loosened around: a bare ratio still dies.
  assert.throws(
    () => parsePolicyRecords(record({ quote: "Behaviorally open: 250/408 non-owner PRs merged." })),
    /is silent but its quote carries a derived figure/,
  );
});

test("the committed policy records parse under the quote guard", () => {
  // Reads the shipped file, so restoring a figure into any silent quote turns this suite red.
  // Deliberately not a pin on the quote *text*: a legitimate refresh — upstream finally writes a
  // CONTRIBUTING, or the absence note is reworded — must stay green. Only the class is asserted.
  const records = parsePolicyRecords(readFileSync(policyRecordsPath(import.meta.url), "utf8"));
  assert.ok(records.size > 0);
  const silent = [...records.values()].filter((r) => r.stance === "silent");
  assert.ok(silent.length > 0, "the file must still hold a silent record or this asserts nothing");
  // Through the guard's OWN predicate, not a second copy of it. The copy that used to sit here was
  // written when the two agreed, and issue #82 made them disagree: it had no `i` flag but also no
  // path exclusion, so it was simultaneously looser and STRICTER than the rule it was checking. A
  // legitimate absence note carrying `docs/2026/08` would have passed `validate` and turned this
  // file red — the second half of #82's defect, relocated into the test suite.
  for (const r of silent) {
    assert.equal(hasDerivedFigure(r.quote), false, `${r.repoId} quote: ${r.quote}`);
  }
});

/**
 * Issue #37, leg 4 — the assertion behind a sentence in docs/04-stations.md §2, not a claim about
 * recall.
 *
 * The page used to leave a reader to infer that deny-by-default covers a scanner miss. It does
 * not, and the two guards must not be conflated: `hasParsedEvidence` is satisfied by ANY fetched
 * document, so a `CONTRIBUTING` whose refusal the scanner cannot read is evidence the gate counts,
 * and the packet reaches `ALLOW`. Only the no-evidence case denies.
 *
 * This is a CHARACTERIZATION test of the gate as it stands, deliberately asserting `ALLOW` on
 * phrasings the scanner misses. It is not a recall assertion and must not be read as endorsing the
 * miss: the matcher work from the same issue is parked, and the freeze display (`renderFreezeEvidence`)
 * is what stands between these strings and a PR. If the matchers are later broadened so that these
 * DENY, this test is the thing that should be rewritten alongside the sentence it pins — that is
 * what it is for.
 */
test("deny-by-default covers the no-evidence case, not the missed-ban case", () => {
  // Paraphrases from the issue's own probe table that this tree's scanner does not match.
  const missed = [
    "we are not currently accepting AI-generated contributions",
    "only human contributors may open pull requests",
    "we don't want AI slop here",
  ];
  for (const text of missed) {
    assert.equal(
      evaluatePolicy({ repoId: "mcp-use/mcp-use", issueTitle: "docs typo", contributing: text }).code,
      "ALLOW",
      `a ban the scanner cannot read reaches ALLOW: ${text}`,
    );
  }
  // The same packet with nothing fetched is the case deny-by-default actually covers...
  assert.equal(
    evaluatePolicy({ repoId: "mcp-use/mcp-use", issueTitle: "docs typo" }).code,
    "DENY_UNKNOWN_POLICY",
  );
  // ...and so is a fetch that came back empty, which carries no evidence either.
  assert.equal(
    evaluatePolicy({ repoId: "mcp-use/mcp-use", issueTitle: "docs typo", contributing: "" }).code,
    "DENY_UNKNOWN_POLICY",
  );
});
