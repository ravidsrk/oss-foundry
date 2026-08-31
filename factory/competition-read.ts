import { classifyCompetition, findCompetingPull, type CompetitionVerdict } from "./engine.ts";
import { listCrossReferencingOpenPulls, listOpenPulls, parsePrUrl } from "./github-pr.ts";

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
