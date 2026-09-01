import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyReviewToScorecard,
  classifyRevert,
  emptyScorecard,
  health,
  REVERT_WINDOW_DAYS,
  revertWindow,
  scorecardRow,
  stopReasons,
} from "./scorecard.ts";

const MERGE = "36d0f23708adbdf911e4df050ed516821278a9fc";
const MERGED_AT = "2026-08-27T07:04:52Z";

test("the revert window is closed at the deadline instant", () => {
  // "within 30 days of merge" includes the closing instant (issue #76). Closed, not open:
  // applyRevert already records day 30. GitHub's commit `until` is exclusive ("before this date"),
  // so the mechanical read never feeds this instant; the operator `--at` path can, and must agree.
  const deadline = new Date(Date.parse(MERGED_AT) + REVERT_WINDOW_DAYS * 86_400_000).toISOString();
  const atDeadline = revertWindow(MERGED_AT, deadline);
  assert.equal(atDeadline.known, true);
  if (atDeadline.known) {
    assert.equal(atDeadline.within, true, "a rollback at mergedAt+30d is inside the window");
    assert.equal(atDeadline.deadline, deadline);
    assert.equal(atDeadline.days, 30);
  }

  const hit = classifyRevert({
    mergeCommitSha: MERGE,
    mergedAt: MERGED_AT,
    commits: [
      {
        sha: "ffff1110000000000000000000000000000000aa",
        message: `This reverts commit ${MERGE}.`,
        committedAt: deadline,
      },
    ],
  });
  assert.equal(hit.reverted, true, "classifyRevert must count a revert at the deadline instant");

  const justAfter = new Date(Date.parse(deadline) + 1).toISOString();
  const late = revertWindow(MERGED_AT, justAfter);
  if (late.known) assert.equal(late.within, false, "one millisecond past the deadline is outside");
});

test("a comments-only split is review activity, not noReview", () => {
  // countHumanReview filters bots per list, so a bot review plus a human line-comment is
  // {reviews: 0, comments: >0} on the live path. The named engine.test.ts case never passes that
  // split, so `&& observed.comments === 0` survived (issue #76).
  const repo = "ravidsrk/orca-fleet";
  const rows = applyReviewToScorecard(emptyScorecard(), repo, { reviews: 0, comments: 1 });
  const row = scorecardRow(rows, repo)!;
  assert.equal(row.noReview, 0, "a human review comment is not zero activity");
  assert.equal(row.humanReviewedPrs, 1);
  assert.equal(row.humanReviewComments, 1);
});

/**
 * `health` is DERIVED from `stopReasons`, not merely consistent with it, and this pins that.
 *
 * `status` used to carry its own copy of the three `stop` predicates so it could explain a frozen
 * repository. Two independent implementations of one rule is the defect this repository keeps
 * shipping, and a drifted copy here is worse than no explanation at all: the operator reads a
 * reason, clears it, and the repository stays stopped for the reason that was not printed.
 */
test("health is stop exactly when stopReasons is non-empty, and names every reason", () => {
  // `scorecardRow` is a finder over a list, not a constructor — take a real row from an empty
  // scorecard so every field is the shape the loader validates.
  const base = emptyScorecard()[0]!;

  // Not stopped: no reasons.
  assert.deepEqual(stopReasons(base), []);
  assert.notEqual(health(base), "stop");

  // Each predicate alone.
  const banned = { ...base, maintainerTone: "banned" as const };
  assert.deepEqual(stopReasons(banned), ["banned"]);
  assert.equal(health(banned), "stop");

  const reverted = { ...base, reverts: 2 };
  assert.deepEqual(stopReasons(reverted), ["reverts=2"]);
  assert.equal(health(reverted), "stop");

  // ALL holding predicates, not the short-circuit winner. An operator who clears only the reason
  // that happened to print first would otherwise be surprised a second time.
  const both = { ...base, maintainerTone: "banned" as const, reverts: 1 };
  assert.deepEqual(stopReasons(both), ["banned", "reverts=1"]);
  assert.equal(health(both), "stop");

  // The merge-rate predicate, and its message shape, which `status` prints verbatim.
  const poor = { ...base, opened: 3, merged: 0, closedUnmerged: 3 };
  const reasons = stopReasons(poor);
  assert.equal(reasons.length, 1, `expected only the merge-rate reason, got ${JSON.stringify(reasons)}`);
  assert.match(reasons[0]!, /^merge-rate 0\/3</);
  assert.equal(health(poor), "stop");

  // The invariant itself, over every combination: stop iff there is a reason.
  for (const tone of ["warm", "neutral", "cold", "banned"] as const) {
    for (const reverts of [0, 1]) {
      for (const opened of [0, 3]) {
        const row = { ...base, maintainerTone: tone, reverts, opened, merged: 0, closedUnmerged: opened };
        assert.equal(
          health(row) === "stop",
          stopReasons(row).length > 0,
          `health and stopReasons disagree for tone=${tone} reverts=${reverts} opened=${opened} — they have drifted, which is exactly what deriving one from the other exists to prevent`,
        );
      }
    }
  }
});
