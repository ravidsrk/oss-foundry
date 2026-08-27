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
    ...touch(changelog, "merged", "terminal"),
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
      draft: false,
      state: "closed",
      merged: true,
      mergeable: "unknown",
      commits: 2,
      reviewComments: 1,
      issueComments: 0,
      headSha: "d91fe2f6725163fab8f9dd42e5c2b0c0c9f0f40d",
      updatedAt: "2026-08-27T07:04:56.000Z",
      syncedAt: "2026-08-27T07:10:00.000Z",
    },
    followUps: [
      {
        id: "fu_pr70_merged",
        at: "2026-08-27T07:04:52.000Z",
        kind: "quiet",
        body: "Maintainer merged #70. Foundry-attested Wave 0 merge 1/2.",
        url: "https://github.com/ravidsrk/orca-fleet/pull/70",
      },
      {
        id: "fu_pr70_date",
        at: "2026-08-26T19:31:00.000Z",
        kind: "bot-reconcile",
        body: "Greptile future-date: folded 0.5.0 heading to 2026-08-26 (d91fe2f). Thread resolved.",
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
        "Merged by maintainer 2026-08-27. Foundry did not click merge.",
        "Follow-up d91fe2f: changelog date UTC.",
      ],
    },
  };

  let architecture = buildPacket({
    repoId: "ravidsrk/frontguard",
    issueNumber: 195,
    issueTitle: "[docs] README Architecture still describes a src/ tree; repo is packages/ + apps/",
    issueUrl: "https://github.com/ravidsrk/frontguard/issues/195",
    labels: ["documentation"],
  });
  architecture = {
    ...touch(architecture, "followed-up", "follow-up"),
    humanAttest: {
      by: "operator",
      at: "2026-08-27T07:15:00.000Z",
      note: "Wave 0 #2. README only. Tree matches packages/ apps/ integrations/.",
    },
    prUrl: "https://github.com/ravidsrk/frontguard/pull/196",
    prBody: renderPrBody(architecture),
    prMeta: {
      url: "https://github.com/ravidsrk/frontguard/pull/196",
      title: "docs: README architecture matches the monorepo",
      draft: true,
      state: "open",
      merged: false,
      mergeable: "unstable",
      commits: 1,
      reviewComments: 0,
      issueComments: 0,
      headSha: "09882b0075d7bb8f99a76c2526504b9194ce380d",
      updatedAt: "2026-08-27T07:11:25.000Z",
      syncedAt: "2026-08-27T07:17:00.000Z",
    },
    followUps: [
      {
        id: "fu_pr196_quiet",
        at: "2026-08-27T07:17:00.000Z",
        kind: "quiet",
        body: "Greptile 5/5. No review threads. CI red is pre-existing on main (playwright lockfile + setup-node drift). README-only; Foundry does not merge.",
        url: "https://github.com/ravidsrk/frontguard/pull/196",
      },
      {
        id: "fu_pr196_ci",
        at: "2026-08-27T07:16:30.000Z",
        kind: "ci",
        body: "CI failures match main since dependabot #185/#184. Not caused by this README diff.",
        url: "https://github.com/ravidsrk/frontguard/actions/runs/33048625018",
      },
    ],
    evidence: {
      baseSha: "4d77aa0c976b51b47240e41f37e1682696991728",
      headSha: "09882b0075d7bb8f99a76c2526504b9194ce380d",
      reviewedSha: "09882b0075d7bb8f99a76c2526504b9194ce380d",
      testCommand: "true",
      testExit: 0,
      negativeControl: "red-on-revert",
      filesChanged: 1,
      diffLines: 43,
      notes: [
        "Draft PR #196 quiet. Foundry does not merge.",
        "README only. CI red is pre-existing on main.",
      ],
    },
  };

  let unreadable = buildPacket({
    repoId: "ravidsrk/orca-fleet",
    issueNumber: 71,
    issueTitle: "[P2] Validator: one unreadable SKILL.md must not abort the catalog",
    issueUrl: "https://github.com/ravidsrk/orca-fleet/issues/71",
    labels: ["documentation", "p2"],
  });
  unreadable = {
    ...touch(unreadable, "followed-up", "follow-up"),
    humanAttest: {
      by: "operator",
      at: "2026-08-27T07:18:00.000Z",
      note: "Wave 0 #3. Validator guard only. 5 files, +72/−15. 103 tests green.",
    },
    prUrl: "https://github.com/ravidsrk/orca-fleet/pull/72",
    prBody: renderPrBody(unreadable),
    prMeta: {
      url: "https://github.com/ravidsrk/orca-fleet/pull/72",
      title: "fix(validate): one unreadable SKILL.md must not abort the catalog",
      draft: true,
      state: "open",
      merged: false,
      mergeable: "clean",
      commits: 1,
      reviewComments: 0,
      issueComments: 0,
      headSha: "8c7068a5467a283de524c88e549dfa66782eeec2",
      updatedAt: "2026-08-27T07:20:57.000Z",
      syncedAt: "2026-08-27T10:24:00.000Z",
    },
    followUps: [
      {
        id: "fu_pr72_quiet",
        at: "2026-08-27T10:24:00.000Z",
        kind: "quiet",
        body: "Greptile 5/5. No review threads. mergeable=clean. Foundry does not merge.",
        url: "https://github.com/ravidsrk/orca-fleet/pull/72",
      },
    ],
    evidence: {
      baseSha: "36d0f23708adbdf911e4df050ed516821278a9fc",
      headSha: "8c7068a5467a283de524c88e549dfa66782eeec2",
      reviewedSha: "8c7068a5467a283de524c88e549dfa66782eeec2",
      testCommand: "python3 scripts/validate.py && python3 -m unittest discover -s tests -q",
      testExit: 0,
      negativeControl: "red-on-revert",
      filesChanged: 5,
      diffLines: 87,
      notes: [
        "Draft PR #72 quiet. Foundry does not merge.",
        "103 tests. Badge JSON regenerated 100 → 103.",
      ],
    },
  };

  let sidebar = buildPacket({
    repoId: "ColeMurray/background-agents",
    issueNumber: 1476,
    issueTitle: "Differentiate the right sidebar toggle icon by state",
    issueUrl: "https://github.com/ColeMurray/background-agents/issues/1476",
    labels: ["good first issue", "help wanted", "enhancement"],
  });
  sidebar = {
    ...touch(sidebar, "parked", "terminal"),
    parkReason:
      "Wave 1 waits on two Foundry-attested Wave 0 merges. #70 is 1/2. Frontguard #196 and orca-fleet #72 are quiet drafts.",
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
        opened: 7,
        merged: 6,
        reviewCommentsAvg: 1.2,
        maintainerTone: "warm" as const,
        lastTouch: "2026-08-27",
      };
    }
    if (row.repoId === "ravidsrk/frontguard") {
      return {
        ...row,
        opened: 1,
        merged: 0,
        reviewCommentsAvg: 0,
        maintainerTone: "warm" as const,
        lastTouch: "2026-08-27",
      };
    }
    return row;
  });

  return {
    version: 6,
    packets: [unreadable, architecture, changelog, sidebar, matplotlib, openhands],
    events: [
      {
        id: "evt_pr72_quiet",
        at: "2026-08-27T10:24:00.000Z",
        kind: "follow-up",
        packetId: unreadable.id,
        message:
          "orca-fleet#72 quiet. Greptile 5/5. mergeable=clean. Foundry does not merge.",
      },
      {
        id: "evt_pr72",
        at: "2026-08-27T07:18:57.000Z",
        kind: "draft",
        packetId: unreadable.id,
        message:
          "Wave 0 draft opened: ravidsrk/orca-fleet#72 (unreadable SKILL.md). Merge left to the maintainer.",
      },
      {
        id: "evt_pr196_quiet",
        at: "2026-08-27T07:17:00.000Z",
        kind: "follow-up",
        packetId: architecture.id,
        message:
          "frontguard#196 quiet. Greptile 5/5. CI red is pre-existing on main. Foundry does not merge.",
      },
      {
        id: "evt_pr196",
        at: "2026-08-27T07:15:00.000Z",
        kind: "draft",
        packetId: architecture.id,
        message:
          "Wave 0 draft opened: ravidsrk/frontguard#196 (README architecture). Merge left to the maintainer.",
      },
      {
        id: "evt_pr70_merged",
        at: "2026-08-27T07:04:52.000Z",
        kind: "follow-up",
        packetId: changelog.id,
        message:
          "Maintainer merged orca-fleet#70. Foundry-attested Wave 0 merge 1/2. Wave 1 still waits.",
      },
      {
        id: "evt_wave1_park",
        at: "2026-08-27T07:14:00.000Z",
        kind: "gate",
        packetId: sidebar.id,
        message:
          "Parked ColeMurray/background-agents#1476 — Wave 1 needs two Foundry Wave 0 merges.",
      },
      {
        id: "evt_pr70_follow",
        at: "2026-08-26T19:31:00.000Z",
        kind: "follow-up",
        packetId: changelog.id,
        message: "Follow-up on orca-fleet#70: Greptile date thread answered (d91fe2f).",
      },
      {
        id: "evt_pr70",
        at: "2026-08-26T19:17:20.000Z",
        kind: "draft",
        packetId: changelog.id,
        message: "Wave 0 draft opened: ravidsrk/orca-fleet#70 (release 0.5.0).",
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
    ticksRun: 4,
    lastTickAt: "2026-08-27T10:24:00.000Z",
    mergedTotal: 6,
    bans: 0,
    humanApprovalsRemaining: 16,
  };
}

export { renderPrBody };
