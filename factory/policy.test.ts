import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePolicy } from "./policy.ts";
import { seedState } from "./seed.ts";

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

// A CLA/DCO keyword says the topic appears; it does not say the repo requires one. These fixtures
// run both directions off the same vocabulary — the waiver must clear, the requirement must hold.

const WAIVER_LIVE_WAVE1 = `No CLA. No DCO. Conventional commits.`;

const WAIVER_NO_CLA_REQUIRED = `No CLA required. Just open a PR.`;

const WAIVER_NOT_REQUIRED = `A Contributor License Agreement is not required for this project.`;

const WAIVER_DONT_REQUIRE = `We don't require a DCO sign-off on contributions.`;

const WAIVER_SIGNOFF_NOT_REQUIRED = `DCO sign-off is not required here.`;

// The waiver must not reach across a clause that is still asserting the requirement.
const REQUIRES_CLA_MIXED_CLAUSE = `The CLA is required, though a separate review sign-off is not required.`;

const REQUIRES_DCO = `We require a DCO sign-off on every commit.`;

// "without" is a negation word that is not a waiver: the sentence still asserts the requirement.
const REQUIRES_CLA_BY_REFUSAL = `Pull requests without a signed Contributor License Agreement will be closed.`;

test("the live Wave-1 CONTRIBUTING text waives CLA/DCO and must not hold the packet", () => {
  const v = evaluatePolicy({
    repoId: "ColeMurray/background-agents",
    agentsMd:
      "Well-formed agent PRs are welcome if they include tests, a failing-first reproduction, and a short disclosure. Keep diffs small.",
    contributing: WAIVER_LIVE_WAVE1,
    issueTitle: "Differentiate the right sidebar toggle icon by state",
  });
  assert.equal(v.code, "ALLOW");
  assert.deepEqual(v.matchedPhrases, []);
});

test("waiver phrasings read as waivers, not as requirements", () => {
  for (const contributing of [
    WAIVER_NO_CLA_REQUIRED,
    WAIVER_NOT_REQUIRED,
    WAIVER_DONT_REQUIRE,
    WAIVER_SIGNOFF_NOT_REQUIRED,
  ]) {
    const v = evaluatePolicy({
      repoId: "ColeMurray/background-agents",
      agentsMd: "Agent PRs are welcome with tests and a disclosure.",
      contributing,
      issueTitle: "icon tweak",
    });
    assert.equal(v.code, "ALLOW", `expected ALLOW for: ${contributing}`);
  }
});

test("negation handling does not weaken a real CLA/DCO requirement", () => {
  for (const contributing of [
    REQUIRES_DCO,
    "Please sign the CLA before your first pull request.",
    KERNEL_STYLE_CONDITIONAL,
    REQUIRES_CLA_MIXED_CLAUSE,
  ]) {
    const v = evaluatePolicy({
      repoId: "ColeMurray/background-agents",
      agentsMd: "Agent PRs are welcome with tests and a disclosure.",
      contributing,
      issueTitle: "icon tweak",
    });
    assert.equal(v.code, "HOLD_CLA", `expected HOLD_CLA for: ${contributing}`);
  }
  // A negation word inside a sentence that still asserts the requirement is not a waiver.
  // (This phrasing parks as HOLD_HUMAN rather than HOLD_CLA today — a separate classification
  // gap tracked in issue #37; what matters here is that the hold survives.)
  const refusal = evaluatePolicy({
    repoId: "ColeMurray/background-agents",
    agentsMd: "Agent PRs are welcome with tests and a disclosure.",
    contributing: REQUIRES_CLA_BY_REFUSAL,
    issueTitle: "icon tweak",
  });
  assert.equal(refusal.allow, false);
  assert.match(refusal.code, /^HOLD_/);
});

test("the seeded Wave-1 packet is buildable, not parked needs-human", () => {
  const sidebar = seedState().packets.find((p) => p.issueNumber === 1476)!;
  assert.equal(sidebar.policy.code, "ALLOW");
  assert.equal(sidebar.class, "buildable");
  assert.equal(sidebar.parkReason, undefined);
});
