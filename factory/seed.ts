import { buildPacket, renderPrBody } from "./packet";
import { emptyScorecard } from "./scorecard";
import type { FactoryState, TaskPacket } from "./types";

function touch(packet: TaskPacket, status: TaskPacket["status"], station: TaskPacket["station"]): TaskPacket {
  return { ...packet, status, station, updatedAt: new Date().toISOString() };
}

export function seedState(): FactoryState {
  let changelog = buildPacket({
    repoId: "ravidsrk/orca-fleet",
    issueNumber: 42,
    issueTitle:
      "[P2] CHANGELOG [Unreleased] describes changes already on main; version bump pending",
    issueUrl: "https://github.com/ravidsrk/orca-fleet/issues/42",
    labels: ["documentation", "p2"],
  });
  changelog = {
    ...touch(changelog, "followed-up", "follow-up"),
    humanAttest: {
      by: "operator",
      at: "2026-08-26T19:17:00.000Z",
      note: "Wave 0 hygiene. Three files. Validator + 100 tests green.",
    },
    prUrl: "https://github.com/ravidsrk/orca-fleet/pull/70",
    prBody: renderPrBody(changelog),
    prMeta: {
      url: "https://github.com/ravidsrk/orca-fleet/pull/70",
      title: "Release 0.5.0: fold Unreleased into a dated heading",
      draft: true,
      state: "open",
      merged: false,
      mergeable: "clean",
      commits: 2,
      reviewComments: 1,
      issueComments: 0,
      headSha: "d91fe2f6725163fab8f9dd42e5c2b0c0c9f0f40d",
      updatedAt: "2026-08-26T19:32:00.000Z",
      syncedAt: "2026-08-26T19:32:00.000Z",
    },
    followUps: [
      {
        id: "fu_pr70_date",
        at: "2026-08-26T19:31:00.000Z",
        kind: "bot-reconcile",
        body: "Greptile future-date: folded 0.5.0 heading to 2026-08-26 (d91fe2f). Thread resolved. Merge left to maintainer.",
        url: "https://github.com/ravidsrk/orca-fleet/pull/70#discussion_r3866028420",
      },
    ],
    evidence: {
      baseSha: "251fe899c5bd843a7dad71d908c0af3bfcea79e1",
      headSha: "d91fe2f6725163fab8f9dd42e5c2b0c0c9f0f40d",
      reviewedSha: "3ba13f155e1828f3a3b3978e970b0c79687520f5",
      testCommand: "python3 scripts/validate.py && python3 -m unittest discover -s tests -q",
      testExit: 0,
      negativeControl: "red-on-revert",
      filesChanged: 3,
      diffLines: 13,
      notes: [
        "Draft PR #70. Foundry does not merge.",
        "Follow-up d91fe2f: changelog date UTC.",
      ],
    },
  };

  const sidebar = buildPacket({
    repoId: "ColeMurray/background-agents",
    issueNumber: 1476,
    issueTitle: "Differentiate the right sidebar toggle icon by state",
    issueUrl: "https://github.com/ColeMurray/background-agents/issues/1476",
    labels: ["good first issue", "help wanted", "enhancement"],
  });

  const matplotlib = buildPacket({
    repoId: "matplotlib/matplotlib",
    issueNumber: 0,
    issueTitle: "Docs typo in examples gallery",
    issueUrl: "https://github.com/matplotlib/matplotlib",
    labels: ["Documentation"],
  });

  const openhands = buildPacket({
    repoId: "All-Hands-AI/OpenHands",
    issueNumber: 16907,
    issueTitle: "Document HUMAN: requirement in contributor FAQ",
    issueUrl: "https://github.com/All-Hands-AI/OpenHands/issues/16907",
    labels: ["documentation"],
  });

  const scorecard = emptyScorecard().map((row) => {
    if (row.repoId === "ravidsrk/orca-fleet") {
      return {
        ...row,
        opened: 6,
        merged: 5,
        reviewCommentsAvg: 1.2,
        maintainerTone: "warm" as const,
        lastTouch: "2026-08-26",
      };
    }
    return row;
  });

  return {
    version: 4,
    packets: [changelog, sidebar, matplotlib, openhands],
    events: [
      {
        id: "evt_pr70_follow",
        at: "2026-08-26T19:31:00.000Z",
        kind: "follow-up",
        packetId: changelog.id,
        message:
          "Follow-up on orca-fleet#70: Greptile date thread answered (d91fe2f). Still draft. Merge left to maintainer.",
      },
      {
        id: "evt_pr70",
        at: "2026-08-26T19:17:20.000Z",
        kind: "draft",
        packetId: changelog.id,
        message:
          "Wave 0 draft opened: ravidsrk/orca-fleet#70 (release 0.5.0). Merge left to the maintainer.",
      },
      {
        id: "evt_seed_oss",
        at: "2026-07-16T00:00:00.000Z",
        kind: "draft",
        message:
          "oss-contribute external-run: 5 PRs + 4 review-assist comments. Merge left to maintainers.",
      },
      {
        id: "evt_seed_gate",
        at: "2026-08-26T19:00:00.000Z",
        kind: "gate",
        packetId: matplotlib.id,
        message: "Policy denied matplotlib/matplotlib — autonomous-agent ban.",
      },
    ],
    scorecard,
    ticksRun: 2,
    lastTickAt: "2026-08-26T19:31:00.000Z",
    mergedTotal: 5,
    bans: 0,
    humanApprovalsRemaining: 18,
  };
}

export { renderPrBody };
