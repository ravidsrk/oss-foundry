import { repoById } from "./allowlist.ts";
import { ABORT_DEFAULT, DISCLOSURE, NON_GOALS_DEFAULT } from "./neighbor.ts";
import { evaluatePolicy } from "./policy.ts";
import { scoreIssue } from "./scout.ts";
import type { PacketClass, TaskPacket } from "./types.ts";

function idFor(repoId: string, issue: number) {
  return `pkt_${repoId.replace("/", "_")}_${issue}`;
}

export function buildPacket(input: {
  repoId: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  labels?: string[];
  agentsMd?: string;
  contributing?: string;
}): TaskPacket {
  const repo = repoById(input.repoId);
  const policy = evaluatePolicy({
    repoId: input.repoId,
    agentsMd: input.agentsMd,
    contributing: input.contributing,
    issueTitle: input.issueTitle,
  });

  let classified: PacketClass = "buildable";
  if (!policy.allow) {
    if (policy.code === "DENY_FORBIDDEN" || policy.code === "DENY_UNKNOWN_POLICY") {
      classified = "policy-denied";
    } else if (policy.code === "HOLD_CLA" || policy.code === "HOLD_HUMAN") {
      classified = "needs-human";
    } else {
      classified = "out-of-scope";
    }
  }

  const now = new Date().toISOString();
  const scout = scoreIssue({
    repoId: input.repoId,
    title: input.issueTitle,
    labels: input.labels ?? repo?.preferredLabels ?? [],
  });

  const buildable = classified === "buildable";

  return {
    id: idFor(input.repoId, input.issueNumber),
    repoId: input.repoId,
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    issueUrl: input.issueUrl,
    objective: `Land a minimal, tested fix for ${input.repoId}#${input.issueNumber}: ${input.issueTitle}`,
    nonGoals: NON_GOALS_DEFAULT,
    acceptance: [
      "Failing-first test or repro exists before the fix.",
      "Negative control goes red when the fix is reverted.",
      `Files ≤ ${repo?.maxFiles ?? 4}, diff ≤ ${repo?.maxDiffLines ?? 200} lines.`,
      "PR body discloses Foundry + human attest. Draft only.",
      "No merge. Follow-up until quiet, closed, or merged by maintainers.",
    ],
    abort: ABORT_DEFAULT,
    class: classified,
    status: buildable ? "gated" : "parked",
    station: buildable ? "freeze" : "terminal",
    lighting: "lit",
    policy,
    scout,
    createdAt: now,
    updatedAt: now,
    parkReason: buildable ? undefined : policy.reasons[0],
  };
}

export function renderPrBody(packet: TaskPacket): string {
  return `## Summary

Fixes ${packet.issueUrl}

${packet.objective}

## Acceptance

${packet.acceptance.map((a) => `- [ ] ${a}`).join("\n")}

## Non-goals

${packet.nonGoals.map((a) => `- ${a}`).join("\n")}

## Evidence

- Policy: \`${packet.policy.code}\`
- Scout score: ${packet.scout.total}
- Lighting: ${packet.lighting} (independent review required)
- Tests: failing-first + revert negative control

## Disclosure

${DISCLOSURE}

Closes #${packet.issueNumber}
`;
}
