import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPS } from "./allowlist.ts";
import {
  applyPacketToScorecard,
  emptyScorecard,
  factoryKpis,
  health,
  mergeRate,
  noReviewRate,
  terminalDrafts,
} from "./scorecard.ts";
import type { TaskPacket } from "./types.ts";

function packet(repoId: string): TaskPacket {
  return { id: `pkt_${repoId.replace("/", "_")}_1`, repoId } as TaskPacket;
}

test("merge rate uses terminal drafts; stale-closed counts against it", () => {
  let rows = emptyScorecard();
  const pkt = packet("ravidsrk/orca-fleet");
  rows = applyPacketToScorecard(rows, pkt, "opened");
  rows = applyPacketToScorecard(rows, pkt, "opened");
  rows = applyPacketToScorecard(rows, pkt, "opened");
  const inflight = rows.find((r) => r.repoId === "ravidsrk/orca-fleet")!;
  assert.equal(inflight.opened, 3);
  assert.equal(terminalDrafts(inflight), 0);
  assert.equal(mergeRate(inflight), 0);
  assert.equal(health(inflight), "good");

  rows = applyPacketToScorecard(rows, pkt, "merged", { humanReviewComments: 2 });
  rows = applyPacketToScorecard(rows, pkt, "stale-closed", { humanReviewComments: 0 });
  rows = applyPacketToScorecard(rows, pkt, "closed", { humanReviewComments: 3 });
  const row = rows.find((r) => r.repoId === "ravidsrk/orca-fleet")!;
  assert.equal(row.merged, 1);
  assert.equal(row.closedUnmerged, 2);
  assert.equal(row.staleClosed, 1);
  assert.equal(terminalDrafts(row), 3);
  assert.equal(mergeRate(row), 1 / 3);
  assert.equal(health(row), "stop");
  assert.equal(row.humanReviewed, 2);
  assert.equal(row.noReview, 1);
  assert.equal(row.reviewCommentsAvg, 2.5);
  assert.equal(noReviewRate(row), 1 / 3);
});

test("reviewCommentsAvg ignores silent PRs; noReview is the companion counter", () => {
  let rows = emptyScorecard();
  const pkt = packet("ravidsrk/frontguard");
  rows = applyPacketToScorecard(rows, pkt, "merged", { humanReviewComments: 4 });
  rows = applyPacketToScorecard(rows, pkt, "merged", { humanReviewComments: 0 });
  rows = applyPacketToScorecard(rows, pkt, "merged", { humanReviewComments: 0 });
  const row = rows.find((r) => r.repoId === "ravidsrk/frontguard")!;
  assert.equal(row.reviewCommentsAvg, 4);
  assert.equal(row.humanReviewed, 1);
  assert.equal(row.noReview, 2);
  assert.equal(noReviewRate(row), 2 / 3);
  const kpis = factoryKpis(rows);
  assert.equal(kpis.reviewCommentsAvg, 4);
  assert.equal(kpis.noReview, 2);
  assert.equal(kpis.mergeRate, 1);
});

test("rework is informational and does not halt; revert does", () => {
  let rows = emptyScorecard();
  const pkt = packet("ravidsrk/orca-fleet");
  rows = applyPacketToScorecard(rows, pkt, "merged");
  rows = applyPacketToScorecard(rows, pkt, "rework");
  const afterRework = rows.find((r) => r.repoId === "ravidsrk/orca-fleet")!;
  assert.equal(afterRework.rework, 1);
  assert.equal(afterRework.reverts, 0);
  assert.equal(health(afterRework), "good");

  rows = applyPacketToScorecard(rows, pkt, "reverted");
  const afterRevert = rows.find((r) => r.repoId === "ravidsrk/orca-fleet")!;
  assert.equal(afterRevert.reverts, 1);
  assert.equal(health(afterRevert), "stop");
});

test("halt_after_opens needs terminal outcomes, not in-flight drafts", () => {
  const rows = emptyScorecard().map((row) =>
    row.repoId === "ravidsrk/orca-fleet"
      ? { ...row, opened: CAPS.halt_after_opens, merged: 0, closedUnmerged: 0 }
      : row,
  );
  const inflight = rows.find((r) => r.repoId === "ravidsrk/orca-fleet")!;
  assert.equal(health(inflight), "good");
});
