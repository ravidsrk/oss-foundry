import { ALLOWLIST, CAPS } from "./allowlist.ts";
import type { ScorecardRow, TaskPacket } from "./types.ts";

/** Explicit git-revert of our merge, or maintainer-stated rollback naming the PR, counted if within this many days of merge. */
export const REVERT_WINDOW_DAYS = 30;

/** Quiet drafts become stale-closed (count against merge rate) after this many days with no human activity. */
export const STALE_QUIET_DAYS = 14;

export type ScoreKind = "opened" | "merged" | "closed" | "stale-closed" | "reverted" | "rework";

export function emptyScorecard(): ScorecardRow[] {
  return ALLOWLIST.map((repo) => ({
    repoId: repo.id,
    opened: 0,
    merged: 0,
    closedUnmerged: 0,
    staleClosed: 0,
    reviewCommentsAvg: 0,
    humanReviewed: 0,
    noReview: 0,
    reverts: 0,
    rework: 0,
    maintainerTone: "neutral" as const,
    lastTouch: "—",
  }));
}

/** Opened drafts that reached a terminal state. Stale-closed is included via closedUnmerged. */
export function terminalDrafts(row: ScorecardRow): number {
  return row.merged + row.closedUnmerged;
}

/** merged / terminal. In-flight drafts are not in the denominator. */
export function mergeRate(row: ScorecardRow): number {
  const den = terminalDrafts(row);
  if (den === 0) return 0;
  return row.merged / den;
}

/** noReview / (humanReviewed + noReview). Distinct from reviewCommentsAvg. */
export function noReviewRate(row: ScorecardRow): number {
  const den = row.humanReviewed + row.noReview;
  if (den === 0) return 0;
  return row.noReview / den;
}

export function health(row: ScorecardRow): "good" | "watch" | "stop" {
  if (row.maintainerTone === "banned" || row.reverts > 0) return "stop";
  if (terminalDrafts(row) >= CAPS.halt_after_opens && mergeRate(row) < CAPS.halt_merge_rate) {
    return "stop";
  }
  if (row.maintainerTone === "cold") return "watch";
  if (terminalDrafts(row) >= 2 && mergeRate(row) < 0.6) return "watch";
  return "good";
}

function recordHumanReview(row: ScorecardRow, humanReviewComments: number): void {
  if (humanReviewComments >= 1) {
    const n = row.humanReviewed;
    row.reviewCommentsAvg = (row.reviewCommentsAvg * n + humanReviewComments) / (n + 1);
    row.humanReviewed = n + 1;
  } else {
    row.noReview += 1;
  }
}

export function applyPacketToScorecard(
  rows: ScorecardRow[],
  packet: TaskPacket,
  kind: ScoreKind,
  review?: { humanReviewComments: number },
): ScorecardRow[] {
  return rows.map((row) => {
    if (row.repoId !== packet.repoId) return row;
    const next = { ...row, lastTouch: new Date().toISOString().slice(0, 10) };
    if (kind === "opened") next.opened += 1;
    if (kind === "merged") next.merged += 1;
    if (kind === "closed") next.closedUnmerged += 1;
    if (kind === "stale-closed") {
      next.closedUnmerged += 1;
      next.staleClosed += 1;
    }
    if (kind === "reverted") next.reverts += 1;
    if (kind === "rework") next.rework += 1;
    if (review) recordHumanReview(next, review.humanReviewComments);
    return next;
  });
}

export function factoryKpis(rows: ScorecardRow[]) {
  const opened = rows.reduce((a, r) => a + r.opened, 0);
  const merged = rows.reduce((a, r) => a + r.merged, 0);
  const closedUnmerged = rows.reduce((a, r) => a + r.closedUnmerged, 0);
  const staleClosed = rows.reduce((a, r) => a + r.staleClosed, 0);
  const terminal = merged + closedUnmerged;
  const reverts = rows.reduce((a, r) => a + r.reverts, 0);
  const rework = rows.reduce((a, r) => a + r.rework, 0);
  const noReview = rows.reduce((a, r) => a + r.noReview, 0);
  const humanReviewed = rows.reduce((a, r) => a + r.humanReviewed, 0);
  const banned = rows.filter((r) => r.maintainerTone === "banned").length;
  const reviewWeighted = rows.reduce((a, r) => a + r.reviewCommentsAvg * r.humanReviewed, 0);
  return {
    opened,
    merged,
    closedUnmerged,
    staleClosed,
    terminal,
    mergeRate: terminal === 0 ? 0 : merged / terminal,
    reviewCommentsAvg: humanReviewed === 0 ? 0 : reviewWeighted / humanReviewed,
    noReview,
    humanReviewed,
    noReviewRate: humanReviewed + noReview === 0 ? 0 : noReview / (humanReviewed + noReview),
    reverts,
    rework,
    banned,
  };
}
