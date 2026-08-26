import { buildPacket, renderPrBody } from "./packet";
import { emptyScorecard } from "./scorecard";
import { runSandboxDry } from "./sandbox";
import type { FactoryState, TaskPacket } from "./types";

function touch(packet: TaskPacket, status: TaskPacket["status"], station: TaskPacket["station"]): TaskPacket {
  return { ...packet, status, station, updatedAt: new Date().toISOString() };
}

export function seedState(): FactoryState {
  const changelog = buildPacket({
    repoId: "ravidsrk/orca-fleet",
    issueNumber: 42,
    issueTitle:
      "[P2] CHANGELOG [Unreleased] describes changes already on main; version bump pending",
    issueUrl: "https://github.com/ravidsrk/orca-fleet/issues/42",
    labels: ["documentation", "p2"],
  });

  let sidebar = buildPacket({
    repoId: "ColeMurray/background-agents",
    issueNumber: 1476,
    issueTitle: "Differentiate the right sidebar toggle icon by state",
    issueUrl: "https://github.com/ColeMurray/background-agents/issues/1476",
    labels: ["good first issue", "help wanted", "enhancement"],
  });
  sidebar = {
    ...touch(sidebar, "approved", "implement"),
    humanAttest: {
      by: "operator",
      at: new Date().toISOString(),
      note: "Scope is one icon state. Tests exist. Wave 1.",
    },
    sandboxSession: runSandboxDry(sidebar),
  };

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
        opened: 5,
        merged: 5,
        reviewCommentsAvg: 1.2,
        maintainerTone: "warm" as const,
        lastTouch: "2026-07-16",
      };
    }
    return row;
  });

  return {
    version: 2,
    packets: [changelog, sidebar, matplotlib, openhands],
    events: [
      {
        id: "evt_seed_oss",
        at: "2026-07-16T00:00:00.000Z",
        kind: "draft",
        message:
          "oss-contribute external-run on orca-fleet: 5 PRs + 4 review-assist comments. Merge left to maintainers.",
      },
      {
        id: "evt_seed_gate",
        at: new Date().toISOString(),
        kind: "gate",
        packetId: matplotlib.id,
        message: "Policy denied matplotlib/matplotlib — autonomous-agent ban.",
      },
    ],
    scorecard,
    ticksRun: 1,
    lastTickAt: "2026-07-16T00:00:00.000Z",
    mergedTotal: 5,
    bans: 0,
    humanApprovalsRemaining: 19,
  };
}

export { renderPrBody };
