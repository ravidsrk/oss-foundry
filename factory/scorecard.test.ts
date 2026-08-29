import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyReviewToScorecard,
  classifyRevert,
  emptyScorecard,
  REVERT_WINDOW_DAYS,
  revertWindow,
  scorecardRow,
} from "./scorecard.ts";

const MERGE = "36d0f23708adbdf911e4df050ed516821278a9fc";
const MERGED_AT = "2026-08-27T07:04:52Z";

test("the revert window is closed at the deadline instant", () => {
  // "within 30 days of merge" includes the instant the window closes (issue #76). Day 1 and day 31
  // cannot see `<=` flipped to `<`. Closed, not open: both halves share this predicate, and a
  // rollback dated exactly 30 days after the merge is still within 30 days.
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
