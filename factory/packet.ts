import { repoById } from "./allowlist.ts";
import { ABORT_DEFAULT, commitTrailerLine, DISCLOSURE, NON_GOALS_DEFAULT } from "./neighbor.ts";
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

/** Written for the maintainer, not the factory: what changed, how it was verified, who prepared it. Internal vocabulary (policy codes, scout scores, lighting) stays in the packet record. */
export function renderPrBody(packet: TaskPacket): string {
  const repo = repoById(packet.repoId);
  const scope = packet.evidence
    ? `- Scope: ${packet.evidence.filesChanged} files, ${packet.evidence.diffLines} changed lines (caps ${repo?.maxFiles ?? "?"} / ${repo?.maxDiffLines ?? "?"}).`
    : `- Scope caps: ${repo?.maxFiles ?? "?"} files, ${repo?.maxDiffLines ?? "?"} changed lines.`;
  const trailer = commitTrailerLine(repo?.disclosureTrailer ?? "pr-body-only");
  const trailerNote = trailer ? `\nCommits carry \`${trailer}\`.` : "";
  return `## Summary

${packet.objective}

## Verification

- Test command: \`${repo?.testCommand ?? packet.evidence?.testCommand ?? ""}\`
- A failing test existed before the change; reverting the change makes it fail again (negative control).
${scope}
- An independent reviewer read the diff and tests before this draft was opened.

## Non-goals

${packet.nonGoals.map((a) => `- ${a}`).join("\n")}

## Disclosure

${DISCLOSURE}${trailerNote}

Closes #${packet.issueNumber}
`;
}
