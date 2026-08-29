import { buildPacket, renderPrBody } from "./packet.ts";
import { emptyScorecard } from "./scorecard.ts";
import type { FactoryState, TaskPacket } from "./types.ts";

function touch(
  packet: TaskPacket,
  status: TaskPacket["status"],
  station: TaskPacket["station"],
): TaskPacket {
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
    agentsMd:
      "This is our repository. Agents may open draft PRs. Human freeze still applies.",
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
      // GitHub's own total, re-read live 2026-08-29 (issue #39): 2, not the 1 that was typed here.
      // Both surfaces are one bot + one person — `greptile-apps[bot]` and `ravidsrk` — which is
      // exactly why this scalar cannot be the KPI. `humanReview` below is.
      reviewComments: 2,
      issueComments: 0,
      headSha: "d91fe2f6725163fab8f9dd42e5c2b0c0c9f0f40d",
      updatedAt: "2026-08-27T07:04:56.000Z",
      syncedAt: "2026-08-29T00:00:00.000Z",
      baseRef: "main",
      mergeCommitSha: "36d0f23708adbdf911e4df050ed516821278a9fc",
      mergedAt: "2026-08-27T07:04:52Z",
      humanReview: { reviews: 1, comments: 1 },
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
    agentsMd: "This is our repository. Agents may open draft PRs.",
  });
  architecture = {
    ...touch(architecture, "merged", "terminal"),
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
      draft: false,
      state: "closed",
      merged: true,
      mergeable: "unknown",
      commits: 1,
      reviewComments: 0,
      issueComments: 0,
      headSha: "09882b0075d7bb8f99a76c2526504b9194ce380d",
      // The PR's own last activity, which is NOT its merge instant: GitHub stamps `updated_at` when
      // the merge finishes writing, a beat after `merged_at`. Both values here were the merge
      // instant, copied into the wrong field; re-read live 2026-08-29 (read-only GET) they are
      // 06:40:45Z here and 11:30:08Z on orca-fleet#72.
      updatedAt: "2026-08-28T06:40:45.000Z",
      syncedAt: "2026-08-29T00:00:00.000Z",
      baseRef: "main",
      mergeCommitSha: "4375afc98341e6b991544df592f2b7fa7441ca7e",
      mergedAt: "2026-08-28T06:40:44Z",
      // Read live 2026-08-29: no reviews and no review comments at all. This is a `noReview` row.
      humanReview: { reviews: 0, comments: 0 },
    },
    followUps: [
      {
        id: "fu_pr196_merged",
        at: "2026-08-28T06:40:44.000Z",
        kind: "quiet",
        body: "Merged by ravidsrk 2026-08-28. Doctrine is never-merge even on owned repos; this happened. Not a Wave 1 promotion-gate merge.",
        url: "https://github.com/ravidsrk/frontguard/pull/196",
      },
      {
        id: "fu_pr196_ci",
        at: "2026-08-27T07:16:30.000Z",
        kind: "ci",
        body: "CI failures matched main since dependabot #185/#184. README-only packet.",
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
      notes: ["Merged 2026-08-28 by operator on an owned repo. Foundry still does not merge as policy."],
    },
  };

  let unreadable = buildPacket({
    repoId: "ravidsrk/orca-fleet",
    issueNumber: 71,
    issueTitle: "[P2] Validator: one unreadable SKILL.md must not abort the catalog",
    issueUrl: "https://github.com/ravidsrk/orca-fleet/issues/71",
    labels: ["documentation", "p2"],
    agentsMd: "This is our repository. Agents may open draft PRs.",
  });
  unreadable = {
    ...touch(unreadable, "merged", "terminal"),
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
      draft: false,
      state: "closed",
      merged: true,
      mergeable: "unknown",
      commits: 1,
      reviewComments: 0,
      issueComments: 0,
      headSha: "8c7068a5467a283de524c88e549dfa66782eeec2",
      updatedAt: "2026-08-27T11:30:08.000Z",
      syncedAt: "2026-08-29T00:00:00.000Z",
      baseRef: "main",
      // Note the ordering: this merge COMMIT is stamped 11:30:03Z, one second BEFORE `merged_at`,
      // so a `since: mergedAt` read excludes it. Harmless — `classifyRevert` skips the merge commit
      // anyway — but it is why "the read reaches the merge commit itself" is true of #70 and not of
      // this one.
      mergeCommitSha: "32050a009299df3608f5e67d9db3362c0a9ab4bb",
      mergedAt: "2026-08-27T11:30:04Z",
      // Read live 2026-08-29: no reviews and no review comments at all. This is a `noReview` row.
      humanReview: { reviews: 0, comments: 0 },
    },
    followUps: [
      {
        id: "fu_pr72_merged",
        at: "2026-08-27T11:30:04.000Z",
        kind: "quiet",
        body: "Maintainer merged #72. Foundry-attested Wave 0 merge 2/2.",
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
      notes: ["Merged by maintainer 2026-08-27. Foundry did not click merge.", "103 tests."],
    },
  };

  let sidebar = buildPacket({
    repoId: "ColeMurray/background-agents",
    issueNumber: 1476,
    issueTitle: "Differentiate the right sidebar toggle icon by state",
    issueUrl: "https://github.com/ColeMurray/background-agents/issues/1476",
    labels: ["good first issue", "help wanted", "enhancement"],
    agentsMd:
      "Well-formed agent PRs are welcome if they include tests, a failing-first reproduction, and a short disclosure. Keep diffs small.",
    contributing: "No CLA. No DCO. Conventional commits.",
  });
  sidebar = {
    ...touch(sidebar, "submitted", "follow-up"),
    humanAttest: {
      by: "operator",
      at: "2026-08-27T12:00:00.000Z",
      note: "Wave 1 #1476. Icon + test. Caps 3 files / +88. Opened from a browser session (App 403).",
    },
    prUrl: "https://github.com/ColeMurray/background-agents/pull/1652",
    prBody: renderPrBody(sidebar),
    prMeta: {
      url: "https://github.com/ColeMurray/background-agents/pull/1652",
      title: "feat: differentiate the right sidebar toggle icon by state",
      // Live as of the 2026-08-29 sync (issue #49). NOT doctrine-correct: draft-only is the
      // hardest rule this factory has, and #1652 is not a draft. The ledger records what GitHub
      // says; `docs/12-ledger.md` and PRODUCT.md §8 carry the deviation and who caused it.
      draft: false,
      state: "open",
      merged: false,
      mergeable: "blocked",
      commits: 7,
      reviewComments: 0,
      issueComments: 1,
      headSha: "6b6ff04079a47109263b81726a1c29459b334de5",
      updatedAt: "2026-08-28T18:09:34Z",
      syncedAt: "2026-08-29T05:08:48.000Z",
    },
    followUps: [
      {
        id: "fu_pr1652_opened",
        at: "2026-08-28T10:14:03.000Z",
        kind: "note",
        body: "Upstream PR opened ready-for-review (doctrine miss: should have been draft). Fork rehearsal ravidsrk/background-agents#1 closed. Follow up; do not merge; do not tick.",
        url: "https://github.com/ColeMurray/background-agents/pull/1652",
      },
      {
        id: "fu_pr1652_bot_reconcile",
        at: "2026-08-28T10:30:00.000Z",
        kind: "bot-reconcile",
        body: "CodeRabbit reviewed head 48c2242: no actionable comments, merge risk minimal, one docstring-coverage warning. Not a human review; noReview semantics unaffected.",
        url: "https://github.com/ColeMurray/background-agents/pull/1652",
      },
      {
        id: "fu_pr1652_drafted",
        at: "2026-08-28T16:16:39Z",
        kind: "note",
        body: "Doctrine healed: draft=true live-verified at head 48c2242; verbatim DISCLOSURE confirmed in the body. GitHub's timeline attributes three draft toggles to the operator account: convert_to_draft 13:47Z, ready_for_review 14:16Z, convert_to_draft 16:16Z (final). A parallel session recorded the first conversion as done while the PR sat ready again by 14:16 — Foundry's own attestation trail has no entry for those two events; this record is corrected against the timeline. Slot stays submitted; it releases via the quiet-day rule (sync --threads-answered after >=14 quiet days).",
        url: "https://github.com/ColeMurray/background-agents/pull/1652",
      },
      {
        id: "fu_pr1652_ready_for_review",
        at: "2026-08-28T18:09:24Z",
        kind: "note",
        body: "Marked ready for review by ravidsrk at 18:09:24Z, and 6b6ff04 (merge of upstream main) pushed eight seconds later. Doctrine is draft-only — ready-for-review is a human act, and a human did it; this happened and stands. Recorded, not healed: #1652 is live as ready for review, the deviation is disclosed in PRODUCT.md §8 and docs/12-ledger.md, and it does not license a second one. Evidence still covers 48c2242 only — a re-witness at 6b6ff04 is owed and the clock says so every tick.",
        url: "https://github.com/ColeMurray/background-agents/pull/1652",
      },
    ],
    evidence: {
      baseSha: "217511d855e58f95cdfff82b05ebd92114fc59e2",
      headSha: "48c2242683705b00503d3436575bf3c28b1b0c9b",
      reviewedSha: "48c2242683705b00503d3436575bf3c28b1b0c9b",
      testCommand: "npm test",
      testExit: 0,
      negativeControl: "red-on-revert",
      filesChanged: 3,
      diffLines: 89,
      notes: [
        "Opened ready, not draft (historical miss). Converted to draft 2026-08-28T16:16:39Z, then marked ready for review again by the operator at 18:09:24Z — the state it is in.",
        "Disclosure verbatim on the live body as verified 2026-08-28 — as the block read THEN. ADR 0004 added the `(ravidsrk/oss-foundry)` qualifier to `DISCLOSURE` afterwards, and an open PR's body does not follow a constant, so the live body no longer matches the current block. Grandfathered and flagged, not re-stated as matching: `verify-ledger` reports it as an advisory every tick until an operator with an explicit go edits the upstream body (issue #38).",
        "Covers 48c2242 only. 6b6ff04 landed after the review and was never witnessed; do not read this proof as covering the live head.",
        "Fork PR #1 closed unmerged.",
      ],
    },
  };

  const matplotlib = buildPacket({
    repoId: "matplotlib/matplotlib",
    issueNumber: 0,
    issueTitle: "Docs typo in examples gallery",
    issueUrl: "https://github.com/matplotlib/matplotlib",
    labels: ["Documentation"],
  });

  const openhands = buildPacket({
    repoId: "OpenHands/OpenHands",
    issueNumber: 16907,
    issueTitle: "Document HUMAN: requirement in contributor FAQ",
    issueUrl: "https://github.com/OpenHands/OpenHands/issues/16907",
    labels: ["documentation"],
    agentsMd: "Please sign the CLA. HUMAN: required.",
    contributing: "Developer Certificate of Origin. Sign-off required.",
  });

  const scorecard = emptyScorecard().map((row) => {
    if (row.repoId === "ravidsrk/orca-fleet") {
      return {
        ...row,
        opened: 2,
        merged: 2,
        // Derived from the two merged PRs, re-read live 2026-08-29 (issue #39), NOT typed:
        //   #70 — 1 human review comment (the other was `greptile-apps[bot]`)  → in the denominator
        //   #72 — no human review activity at all                              → noReview
        // docs/08-operations.md computes the mean "only over PRs with ≥1 human review comment", so
        // it is 1/1 = 1. The 0.5 that stood here was 1/2 — the merge-rate denominator, which is the
        // wrong one — over a comment count that had counted a bot.
        reviewCommentsAvg: 1,
        humanReviewComments: 1,
        humanReviewedPrs: 1,
        noReview: 1,
        maintainerTone: "warm" as const,
        lastTouch: "2026-08-27",
      };
    }
    if (row.repoId === "ravidsrk/frontguard") {
      return {
        ...row,
        opened: 1,
        merged: 1,
        // #196 merged with no reviews and no review comments (live 2026-08-29): a silent merge.
        // Nothing enters the mean's denominator; the row it belongs in is `noReview`.
        reviewCommentsAvg: 0,
        noReview: 1,
        maintainerTone: "warm" as const,
        lastTouch: "2026-08-28",
      };
    }
    if (row.repoId === "ColeMurray/background-agents") {
      return {
        ...row,
        opened: 1,
        merged: 0,
        reviewCommentsAvg: 0,
        maintainerTone: "neutral" as const,
        lastTouch: "2026-08-28",
      };
    }
    return row;
  });

  return {
    version: 6,
    packets: [sidebar, unreadable, architecture, changelog, matplotlib, openhands],
    events: [
      {
        id: "evt_pr1652_ready_for_review",
        at: "2026-08-28T18:09:24Z",
        kind: "follow-up",
        packetId: sidebar.id,
        message:
          "ColeMurray/background-agents#1652 marked ready for review by ravidsrk; head moved to 6b6ff04. Draft-only doctrine deviation — recorded, not a pattern. Ledger synced 2026-08-29 (issue #49); evidence still at 48c2242.",
      },
      {
        id: "evt_pr1652",
        at: "2026-08-28T10:14:03.000Z",
        kind: "draft",
        packetId: sidebar.id,
        message:
          "Wave 1 upstream PR ColeMurray/background-agents#1652 opened (ready, not draft). Follow up. Do not merge. Do not tick.",
      },
      {
        id: "evt_pr196_merged",
        at: "2026-08-28T06:40:44.000Z",
        kind: "follow-up",
        packetId: architecture.id,
        message: "frontguard#196 merged by ravidsrk. Not a promotion-gate merge.",
      },
      {
        id: "evt_pr72_merged",
        at: "2026-08-27T11:30:04.000Z",
        kind: "follow-up",
        packetId: unreadable.id,
        message: "Maintainer merged orca-fleet#72. Foundry-attested Wave 0 merge 2/2.",
      },
      {
        id: "evt_pr70_merged",
        at: "2026-08-27T07:04:52.000Z",
        kind: "follow-up",
        packetId: changelog.id,
        message: "Maintainer merged orca-fleet#70. Foundry-attested Wave 0 merge 1/2.",
      },
      {
        id: "evt_pr70_follow",
        at: "2026-08-26T19:31:00.000Z",
        kind: "follow-up",
        packetId: changelog.id,
        message: "Follow-up on orca-fleet#70: Greptile date thread answered (d91fe2f).",
      },
      {
        id: "evt_seed_oss",
        at: "2026-07-16T00:00:00.000Z",
        kind: "draft",
        message:
          "oss-contribute external-run: 5 PRs + 4 review-assist comments. Merge left to maintainers. Not this control plane’s attested counter.",
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
    lastTickAt: "2026-08-28T10:14:03.000Z",
    mergedTotal: 3,
    bans: 0,
    humanApprovalsRemaining: 16,
  };
}

export { renderPrBody };
