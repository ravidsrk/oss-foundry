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
