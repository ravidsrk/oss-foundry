import { ALLOWLIST, CAPS } from "./allowlist.ts";
import type { ScorecardRow, TaskPacket } from "./types.ts";

export function emptyScorecard(): ScorecardRow[] {
  return ALLOWLIST.map((repo) => ({
    repoId: repo.id,
    opened: 0,
    merged: 0,
    closedUnmerged: 0,
    reviewCommentsAvg: 0,
    noReview: 0,
    reverts: 0,
    maintainerTone: "neutral" as const,
    lastTouch: "—",
  }));
}

export function mergeRate(row: ScorecardRow): number {
  if (row.opened === 0) return 0;
  return row.merged / row.opened;
}

export function health(row: ScorecardRow): "good" | "watch" | "stop" {
  if (row.maintainerTone === "banned" || row.reverts > 0) return "stop";
  if (row.opened >= CAPS.halt_after_opens && mergeRate(row) < CAPS.halt_merge_rate) return "stop";
  if (row.maintainerTone === "cold") return "watch";
  if (row.opened >= 2 && mergeRate(row) < 0.6) return "watch";
  return "good";
}

export function applyPacketToScorecard(
  rows: ScorecardRow[],
  packet: TaskPacket,
  kind: "opened" | "merged" | "closed" | "reverted",
): ScorecardRow[] {
  return rows.map((row) => {
    if (row.repoId !== packet.repoId) return row;
    const next = { ...row, lastTouch: new Date().toISOString().slice(0, 10) };
    if (kind === "opened") next.opened += 1;
    if (kind === "merged") next.merged += 1;
    if (kind === "closed") next.closedUnmerged += 1;
    if (kind === "reverted") next.reverts += 1;
    return next;
  });
}

export function factoryKpis(rows: ScorecardRow[]) {
  const opened = rows.reduce((a, r) => a + r.opened, 0);
  const merged = rows.reduce((a, r) => a + r.merged, 0);
  const reverts = rows.reduce((a, r) => a + r.reverts, 0);
  const noReview = rows.reduce((a, r) => a + r.noReview, 0);
  const banned = rows.filter((r) => r.maintainerTone === "banned").length;
  return {
    opened,
    merged,
    mergeRate: opened === 0 ? 0 : merged / opened,
    reverts,
    noReview,
    banned,
  };
}
