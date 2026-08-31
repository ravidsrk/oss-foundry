import { classifyCompetition, competingWorkAdvisory, findCompetingPull, type CompetitionVerdict } from "./engine.ts";
import { listCrossReferencingOpenPulls, listOpenPulls, MAX_LIST_PAGES, parsePrUrl } from "./github-pr.ts";
import type { TaskPacket } from "./types.ts";

/**
 * Live competing-work verdict for one packet. Own PR is excluded — a submitted draft that
 * mentions its issue is not a competitor of itself (issue #111).
 */
export async function readCompetition(
  packet: { repoId: string; issueNumber: number; issueUrl: string; prUrl?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; verdict: CompetitionVerdict; truncated: boolean }
  | { ok: false; error: string }
> {
  const pulls = await listOpenPulls(packet.repoId, fetchImpl);
  if (!pulls.ok) return pulls;
  const ownNumber = packet.prUrl ? parsePrUrl(packet.prUrl)?.number : undefined;
  const others = ownNumber === undefined ? pulls.pulls : pulls.pulls.filter((p) => p.number !== ownNumber);
  const keywordHit = findCompetingPull(others, packet.issueNumber, packet.issueUrl, packet.repoId);
  const crossRefs = keywordHit
    ? { ok: true as const, urls: [] as string[], truncated: false }
    : await listCrossReferencingOpenPulls(packet.repoId, packet.issueNumber, fetchImpl);
  if (!crossRefs.ok) return crossRefs;
  const otherRefs =
    ownNumber === undefined
      ? crossRefs.urls
      : crossRefs.urls.filter((u) => parsePrUrl(u)?.number !== ownNumber);
  return {
    ok: true,
    truncated: pulls.truncated || crossRefs.truncated,
    verdict: classifyCompetition(
      { pulls: others, crossReferencedPullUrls: otherRefs },
      packet.issueNumber,
      packet.issueUrl,
      packet.repoId,
    ),
  };
}

export type CompetitionRead = Awaited<ReturnType<typeof readCompetition>>;

/**
 * What the clock, `sync`, and `reconcile` print after `readCompetition` (issue #111).
 *
 * `truncated` is the same fact `refuseIfCapped` gates tick/approve/open-draft on: a short
 * open-pull or timeline read cannot establish the ABSENCE of a competitor. Those verbs refuse.
 * These three re-check an already-open packet, so they ADVISE — but they must still say so.
 * Dropping the flag (the defect this helper exists to close) made a capped `clear` look like
 * "no competing work" on every surface an operator reads.
 *
 * ONE reporter, on purpose. Three hand-written copies is how revertTruncated and reviewTruncated
 * shipped the same hole twice.
 */
export function competitionAdvisories(packet: TaskPacket, read: CompetitionRead): string[] {
  if (!read.ok) {
    return [
      `${packet.id}: could not re-check competing work on ${packet.repoId} — a closing-keyword PR would go unnoticed this run (${read.error})`,
    ];
  }
  const out: string[] = [];
  if (read.truncated) {
    out.push(
      `${packet.id}: the competing-work re-check on ${packet.repoId} hit its ${MAX_LIST_PAGES}-page cap, so "no competing pull request" is not a fact this run can assert. A re-run will cap again — read open PRs by hand, or raise the cap deliberately`,
    );
  }
  const hit = competingWorkAdvisory(packet, read.verdict);
  if (hit) out.push(hit);
  return out;
}
