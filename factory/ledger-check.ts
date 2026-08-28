import type { TaskPacket } from "./types.ts";

export interface LivePrLite {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headSha: string;
}

/**
 * Compare one packet's recorded state against the live PR. Mechanical drift (a merge or close the
 * ledger has not absorbed) names the `sync` command that resolves it; doctrine drift (a draft flag
 * or head SHA that contradicts the record) is printed for a human — divergence is a doctrine
 * event, never silently rewritten.
 */
export function packetDivergences(packet: TaskPacket, live: LivePrLite): string[] {
  const out: string[] = [];
  if (packet.status === "merged" && !live.merged) {
    out.push(
      `${packet.id}: ledger says merged but the PR is ${live.state} and unmerged — resolve by hand; the ledger never un-merges itself`,
    );
  }
  // A rejected or parked packet is terminal in the ledger, but if it still names a PR that is
  // open on GitHub the draft was abandoned, not closed — without this branch it never surfaces
  // again (issue #34). Once the PR is actually closed, there is nothing left to flag.
  if ((packet.status === "rejected" || packet.status === "parked") && packet.prUrl) {
    if (!live.merged && live.state === "open") {
      out.push(
        `${packet.id}: packet is ${packet.status} but ${packet.prUrl} is still open on GitHub — an abandoned live PR; close it by hand or it stays invisible`,
      );
    }
  }
  if (packet.status === "submitted" || packet.status === "followed-up") {
    if (live.merged) {
      out.push(`${packet.id}: PR merged upstream — mechanical: run \`sync ${packet.id}\` to record it`);
    } else if (live.state === "closed" && packet.prMeta?.state !== "closed") {
      // Only an UNABSORBED close is drift. Once sync has recorded the close (prMeta.state ===
      // "closed"), the followed-up packet is at rest — re-reporting it forever would train the
      // operator (and the clock) to ignore real divergence.
      out.push(`${packet.id}: PR closed unmerged — mechanical: run \`sync ${packet.id}\` to record it`);
    }
  }
  if (packet.prMeta && packet.prMeta.draft !== live.draft) {
    out.push(
      `${packet.id}: recorded draft=${packet.prMeta.draft} but live draft=${live.draft} — doctrine event, resolve by hand`,
    );
  }
  if (packet.prMeta && live.headSha && packet.prMeta.headSha !== live.headSha) {
    out.push(
      `${packet.id}: recorded head ${packet.prMeta.headSha.slice(0, 7)} but live head ${live.headSha.slice(0, 7)} — new commits since the last sync; review evidence may be stale`,
    );
  }
  return out;
}
