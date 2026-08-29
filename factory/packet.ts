import { repoById } from "./allowlist.ts";
import { evidenceIsStale, needsRewitness, witnessedSha } from "./ledger-check.ts";
import { ABORT_DEFAULT, commitTrailerLine, DISCLOSURE, FOUNDRY_REPO_URL, NON_GOALS_DEFAULT } from "./neighbor.ts";
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

/** The artifact a maintainer consumes (ADR 0005): every claim on one page, each bound to a source they can check. */
export function renderEvidencePage(packet: TaskPacket): string {
  const attest = packet.humanAttest;
  const ev = packet.evidence;
  const w = ev?.witness;
  const record = packet.policy.record;
  // The witnessed commit is immutable; the PR head is not. When they differ, the maintainer is
  // reading proof that is older than the branch in front of them, and must be told so here.
  //
  // Staleness is decided by the SAME predicate the divergence list uses (`evidenceIsStale`), so
  // the audit page and `packetDivergences` can never disagree about the fact. They differ only in
  // what they ask for: a live packet owes a re-witness, and `needsRewitness` says so on both
  // surfaces; a terminal packet is at rest, so the page states the limit of the proof as history
  // and the divergence list stays silent rather than re-flagging it every tick.
  const witnessed = witnessedSha(packet);
  const liveHead = packet.prMeta?.headSha;
  const stale = !evidenceIsStale(packet, liveHead)
    ? ""
    : needsRewitness(packet, liveHead)
      ? `\n- **The pull request has moved past the witnessed commit.** Proof above is bound to \`${witnessed!.slice(0, 12)}\`; the branch is at \`${liveHead!.slice(0, 12)}\`. Commits after the witness are not covered by it. Re-witness before this evidence is read as current.`
      : `\n- **The pull request moved past the witnessed commit before it reached ${packet.status}.** Proof above is bound to \`${witnessed!.slice(0, 12)}\`; the branch ended at \`${liveHead!.slice(0, 12)}\`. Commits after the witness were never covered by it. Nothing to re-witness — this is the historical limit of the proof.`;
  const lines = [
    `# Evidence — ${packet.repoId}#${packet.issueNumber}`,
    "",
    `**Issue:** [${packet.issueTitle}](${packet.issueUrl})`,
    `**Pull request:** ${packet.prUrl ?? "not opened"}  ·  **status:** ${packet.status}`,
    "",
    "## Who approved this",
    attest
      ? `Attested by **${attest.by}** at ${attest.at}: ${attest.note}`
      : "No human attestation on record — this packet must not reach a maintainer.",
    "",
    "## What your policy says",
    record
      ? `From \`${record.source}\` (fetched ${record.fetchedAt}, stance: ${record.stance}):\n\n> ${record.quote}`
      : "No committed policy record; the gate relied on live-fetched docs at evaluation time.",
    "",
    "## What ran",
    ev
      ? [
          `- Range: \`${ev.baseSha.slice(0, 12)}..${ev.headSha.slice(0, 12)}\` — ${ev.filesChanged} files, ${ev.diffLines} changed lines`,
          `- Test command: \`${ev.testCommand}\``,
          w
            ? `- Witnessed by the ${w.provider} sandbox at ${w.ranAt}: tests exit ${w.testExit} at head; **exit ${w.revertExit} with the change reverted** (the proof binds). Log hashes sha256 ${w.testLogSha.slice(0, 12)}… / ${w.revertLogSha.slice(0, 12)}…`
            : `- Negative control: ${ev.negativeControl} (recorded before machine witnessing shipped — attested, not witnessed)`,
          ...(w?.testLogPath && w?.revertLogPath
            ? [
                // Paths alone resolve to nothing in the maintainer's own tree — name the repository
                // they are in, or the "recompute it yourself" offer is not one they can take.
                `- Recompute it yourself: both logs are committed in ${FOUNDRY_REPO_URL} (Foundry's repo, not yours) at \`${w.testLogPath}\` and \`${w.revertLogPath}\`. From a clone of it: \`shasum -a 256 ${w.testLogPath} ${w.revertLogPath}\`.`,
              ]
            : []),
        ].join("\n") + stale
      : "No evidence manifest — this packet must not reach a maintainer.",
    "",
    "## Standing commitments",
    "- Opened as a draft; you own the merge — the factory has no merge capability.",
    "- One packet in flight; follow-up until merged, closed, or quiet.",
    "- Say stop and the repository is halted the same hour.",
    "",
    "---",
    DISCLOSURE,
    "",
  ];
  return lines.join("\n");
}
