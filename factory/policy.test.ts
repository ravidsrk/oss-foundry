import assert from "node:assert/strict";
import { test } from "node:test";
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

test("committed policy record satisfies parse-policy-first and carries provenance", () => {
  const v = evaluatePolicy({ repoId: "github/awesome-copilot", issueTitle: "add a prompt file" });
  assert.equal(v.code, "ALLOW");
  assert.equal(v.record?.source, "CONTRIBUTING.md");
  assert.equal(/🤖🤖🤖/.test(v.record?.quote ?? ""), true);
});

test("a conditional record holds with the quoted condition even without fetched docs", () => {
  const v = evaluatePolicy({ repoId: "mastra-ai/mastra", issueTitle: "docs fix" });
  assert.equal(v.code, "HOLD_HUMAN");
  assert.equal(/without being assigned first/.test(v.record?.quote ?? ""), true);
});
