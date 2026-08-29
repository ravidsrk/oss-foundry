import { ALLOWLIST, CAPS, sameRepoId } from "./allowlist.ts";
import type { ScorecardRow, TaskPacket } from "./types.ts";

/**
 * The one way to reach a scorecard row. Rows are keyed by the roster's spelling; callers may hold
 * any casing GitHub accepts. Matching raw strings here is how a halt could report success against
 * a row it never touched (issue #44 item 10) — so the comparison is `sameRepoId`, the same one the
 * roster gate uses.
 */
export function scorecardRow(rows: ScorecardRow[], repoId: string): ScorecardRow | undefined {
  return rows.find((r) => sameRepoId(r.repoId, repoId));
}

export function emptyScorecard(): ScorecardRow[] {
  return ALLOWLIST.map((repo) => ({
    repoId: repo.id,
    opened: 0,
    merged: 0,
    closedUnmerged: 0,
    reviewCommentsAvg: 0,
    humanReviewComments: 0,
    humanReviewedPrs: 0,
    noReview: 0,
    reverts: 0,
    maintainerTone: "neutral" as const,
    lastTouch: "—",
  }));
}

/** Drafts that reached a terminal outcome. Merge rate is computed over these, per docs/08-operations.md. */
export function terminalCount(row: ScorecardRow): number {
  return row.merged + row.closedUnmerged;
}

export function mergeRate(row: ScorecardRow): number {
  const terminal = terminalCount(row);
  if (terminal === 0) return 0;
  return row.merged / terminal;
}

export function health(row: ScorecardRow): "good" | "watch" | "stop" {
  if (row.maintainerTone === "banned" || row.reverts > 0) return "stop";
  if (
    row.opened >= CAPS.halt_after_opens &&
    terminalCount(row) > 0 &&
    mergeRate(row) < CAPS.halt_merge_rate
  ) {
    return "stop";
  }
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
    if (!sameRepoId(row.repoId, packet.repoId)) return row;
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
  const terminal = rows.reduce((a, r) => a + terminalCount(r), 0);
  const reverts = rows.reduce((a, r) => a + r.reverts, 0);
  const noReview = rows.reduce((a, r) => a + r.noReview, 0);
  const banned = rows.filter((r) => r.maintainerTone === "banned").length;
  return {
    opened,
    merged,
    terminal,
    mergeRate: terminal === 0 ? 0 : merged / terminal,
    reverts,
    noReview,
    banned,
  };
}

/**
 * Fold one terminal PR's human review split into the repo's row (issue #39).
 *
 * The two KPIs docs/08-operations.md defines here have different denominators, and keeping them
 * apart is the whole point:
 *
 *   - `noReview` counts terminal drafts with **zero human review activity** — no human review at
 *     all, comment or bare approval.
 *   - `reviewCommentsAvg` is a mean over **PRs with ≥1 human review comment**, so a bare approval
 *     belongs to neither counter: it is review activity (not `noReview`) with nothing to average.
 *
 * `observed === undefined` means the review endpoints were not read. Nothing moves, and the caller
 * is expected to say so — recording a 0 there would invent the very metric this function exists to
 * stop inventing.
 *
 * The mean is recomputed from the stored sum and denominator on every write rather than folded
 * into itself, so it is exact and re-derivable from the row by hand.
 */
export function applyReviewToScorecard(
  rows: ScorecardRow[],
  repoId: string,
  observed: { reviews: number; comments: number } | undefined,
): ScorecardRow[] {
  if (!observed) return rows;
  return rows.map((row) => {
    if (!sameRepoId(row.repoId, repoId)) return row;
    const next = { ...row };
    if (observed.reviews === 0 && observed.comments === 0) {
      next.noReview += 1;
      return next;
    }
    if (observed.comments >= 1) {
      next.humanReviewComments += observed.comments;
      next.humanReviewedPrs += 1;
      next.reviewCommentsAvg = next.humanReviewComments / next.humanReviewedPrs;
    }
    return next;
  });
}

/**
 * Is this packet's PR at a terminal outcome the review KPIs are defined over? (issue #39 round 3.)
 *
 * ONE predicate, deliberately, read by both the writer (`applyReviewObservation`) and the reporter
 * (`packetChecks`). Two hand-written copies is how this unit shipped the same defect three times:
 * one consumer pinned and its sibling not. If these two could disagree, `reconcile` could fold an
 * observation into a cumulative counter for a packet the reporter says is not in the population, or
 * the reporter could nag about a packet the writer refuses to fix — and either is worse than the
 * gap they exist to close.
 *
 * Read off the STORED `prMeta`, not off the packet's status and not off the live PR. It is exactly
 * `recordTerminalReview`'s own trigger condition — `meta.merged`, or `meta.state === "closed"` —
 * expressed against the meta the ledger kept, so "should this packet have a review observation?"
 * has the same answer here as it had on the tick that absorbed the outcome. Status is the wrong key:
 * `applyPrSync` writes `closedUnmerged` and leaves the packet `followed-up`, from where `park` or
 * `reject` can move it later without changing what the scorecard already counted. The live PR is
 * the wrong key too: a `rejected` packet can name a PR someone else closed, which the ledger never
 * absorbed and never counted.
 */
export function isTerminalReviewSubject(packet: TaskPacket): boolean {
  const meta = packet.prMeta;
  return meta !== undefined && (meta.merged || meta.state === "closed");
}

/**
 * Prefix on the follow-up note a recorded revert writes. Also its dedupe key, and the way the
 * clock tells "GitHub says our patch was reverted" from "…and the ledger already says so".
 */
export const REVERT_NOTE_PREFIX = "revert:";

/** The recorded revert on a packet, if one has been. `applyRevert` counts a packet at most once. */
export function revertNote(packet: TaskPacket) {
  return (packet.followUps ?? []).find((f) => f.kind === "note" && f.body.startsWith(REVERT_NOTE_PREFIX));
}

/** docs/08-operations.md: a revert counts only "within 30 days of merge". */
export const REVERT_WINDOW_DAYS = 30;

/**
 * Is a rollback observed at `at` inside the window opened by `mergedAt`? (issue #81.)
 *
 * ONE predicate, deliberately, read by BOTH halves of docs/08-operations.md's single definition:
 * `classifyRevert` for the mechanical path, `applyRevert` for the operator's prose one. They used
 * to be one enforcement and one nothing — the classifier discarded a commit past the deadline while
 * the `revert` verb applied any rollback of any age, so the same maintainer statement about the
 * same merge counted or did not depending on which door it came through. Two hand-written copies of
 * a deadline is the shape this repository has shipped the same defect through repeatedly; a shared
 * function is the only version of "they agree" that a mutation can prove.
 *
 * `unknown` is a third answer, not a lenient `true`. A packet whose ledger carries no parseable
 * `mergedAt` cannot be placed against the deadline at all, and the two callers want opposite things
 * from that: the classifier already refuses such a packet outright (it has no merge commit to match
 * either), while the operator's verb must NOT treat a missing field as permission to skip the halt.
 * Collapsing it into a boolean would pick one of those silently.
 */
export function revertWindow(
  mergedAt: string | undefined,
  at: string,
): { known: true; within: boolean; deadline: string; days: number } | { known: false } {
  const mergedMs = Date.parse(mergedAt ?? "");
  const atMs = Date.parse(at);
  if (!Number.isFinite(mergedMs) || !Number.isFinite(atMs)) return { known: false };
  const deadlineMs = mergedMs + REVERT_WINDOW_DAYS * 86_400_000;
  return {
    known: true,
    // Both bounds, because both callers need both. `classifyRevert` filters pre-merge commits in
    // its own loop and so never asked this predicate for the lower one; the operator path reaches
    // here directly with `--at` and did. An impossible pre-merge rollback that passes increments
    // `reverts`, and `health()` turns that into a permanent `stop`.
    within: atMs >= mergedMs && atMs <= deadlineMs,
    deadline: new Date(deadlineMs).toISOString(),
    days: Math.floor((atMs - mergedMs) / 86_400_000),
  };
}

export interface RevertCandidate {
  sha: string;
  message: string;
  committedAt: string;
}

export type RevertVerdict =
  | { reverted: true; sha: string; at: string; why: string }
  | { reverted: false; why: string };

/**
 * Did anything on the base branch revert our merge commit? (SPEC.md §7 MUST, issue #39.)
 *
 * The only accepted evidence is a commit whose message names our merge commit after `This reverts
 * commit` — the line `git revert` writes itself. That is deliberately narrow, and it is what makes
 * docs/08-operations.md's exclusion structural rather than a judgement call: "Post-merge
 * edits/refactors of our code are **rework** ... never counted as reverts." A refactor of our code
 * cannot reach this counter, because it does not name the commit.
 *
 * The other half of the documented definition — "a maintainer-stated rollback naming the PR" — is
 * prose, and no classifier should pretend to read it. That half is the operator's `revert` verb.
 */
export function classifyRevert(input: {
  mergeCommitSha: string;
  mergedAt: string;
  commits: RevertCandidate[];
}): RevertVerdict {
  const merge = input.mergeCommitSha.toLowerCase();
  const mergedMs = Date.parse(input.mergedAt);
  if (merge.length < 7 || !Number.isFinite(mergedMs)) {
    return { reverted: false, why: "no merge commit recorded for this packet — nothing to revert" };
  }
  let late: RevertCandidate | undefined;
  for (const commit of input.commits) {
    // A commit cannot revert itself, and the merge commit is in the branch's own history.
    if (commit.sha.toLowerCase() === merge) continue;
    let names = false;
    for (const match of commit.message.matchAll(/this reverts commit\s+([0-9a-f]{7,40})/gi)) {
      const named = (match[1] ?? "").toLowerCase();
      if (merge.startsWith(named) || named.startsWith(merge)) names = true;
    }
    if (!names) continue;
    const at = Date.parse(commit.committedAt);
    if (!Number.isFinite(at) || at < mergedMs) continue;
    // The shared deadline (issue #81) — the same call the operator's `revert` verb makes, so the
    // two halves of one documented definition cannot drift into disagreeing about a date.
    const window = revertWindow(input.mergedAt, commit.committedAt);
    if (window.known && !window.within) {
      late = commit;
      continue;
    }
    return {
      reverted: true,
      sha: commit.sha,
      at: commit.committedAt,
      why: `${commit.sha.slice(0, 12)} on the base branch reverts our merge commit ${merge.slice(0, 12)} (${commit.committedAt})`,
    };
  }
  if (late) {
    const window = revertWindow(input.mergedAt, late.committedAt);
    const days = window.known ? window.days : 0;
    return {
      reverted: false,
      why: `${late.sha.slice(0, 12)} names our merge commit but landed ${days} days after the merge, past the ${REVERT_WINDOW_DAYS}-day window (docs/08-operations.md) — not counted as a revert`,
    };
  }
  return { reverted: false, why: `no commit on the base branch since ${input.mergedAt} reverts ${merge.slice(0, 12)}` };
}
