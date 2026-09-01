import { repoById, sameRepoId } from "./allowlist.ts";
import type { TaskPacket } from "./types.ts";

/**
 * Wave 1+ waits on this many Foundry-attested Wave 0 merges that *count toward the
 * promotion gate*. Distinct from `foundryAttestedWave0Merges`, which counts every
 * attested Wave 0 merge including the ones doctrine records-and-excludes.
 */
export const PROMOTION_GATE_MERGES = 2;

/**
 * frontguard#196 (packet `pkt_ravidsrk_frontguard_195`) is a Wave 0 attested merge
 * the operator clicked on a repo they own. Foundry never merges, even on owned
 * repos (docs/PRODUCT.md §3 rule 4, §8). The merge is recorded so the ledger is
 * honest; it is excluded from the promotion gate so Wave 1 cannot open on a
 * self-merge that does not evidence a stranger accepted a Foundry patch.
 *
 * Promotion is orca-fleet#70 + #72 (docs/PRODUCT.md §8, docs/12-ledger.md).
 * Hard-coding this packet is the point: the exclusion is of *this merge*, not of
 * the frontguard repo. A later attested frontguard merge still counts.
 *
 * Failure mode if dropped: `foundryAttestedWave0Merges` is 3 on the seed, the
 * gate is `< 2`, and Wave 1 promotes on a merge doctrine names as excluded.
 */
export function isPromotionGateExcluded(packet: TaskPacket): boolean {
  return sameRepoId(packet.repoId, "ravidsrk/frontguard") && packet.issueNumber === 195;
}

export function foundryAttestedWave0Merges(packets: TaskPacket[]): number {
  return packets.filter((p) => {
    const repo = repoById(p.repoId);
    return repo?.wave === 0 && p.status === "merged" && Boolean(p.humanAttest);
  }).length;
}

/**
 * The number `maySelectRepo` actually gates on. Same predicate as
 * `foundryAttestedWave0Merges` minus the merges `isPromotionGateExcluded` names.
 */
export function promotionGateWave0Merges(packets: TaskPacket[]): number {
  return packets.filter((p) => {
    const repo = repoById(p.repoId);
    return (
      repo?.wave === 0 &&
      p.status === "merged" &&
      Boolean(p.humanAttest) &&
      !isPromotionGateExcluded(p)
    );
  }).length;
}

/** `waveOf`'s sentinel for a packet whose repo is not on the allowlist — a denied or unlisted scout. */
export const OFF_ALLOWLIST_WAVE = 99;

export function waveOf(packet: TaskPacket): number {
  return repoById(packet.repoId)?.wave ?? OFF_ALLOWLIST_WAVE;
}

/**
 * The `ledger` command's grouping. It used to filter `repoById(p.repoId)?.wave === wave` over waves
 * 0–2, so a packet whose repo is not on the allowlist matched nothing and vanished: `status` said
 * `packets=6`, `ledger` printed 5, and the missing one was the denied `matplotlib/matplotlib` scout
 * — the refusal the audit surface most needs to show. Grouping through `waveOf` gives that packet
 * the `OFF_ALLOWLIST_WAVE` sentinel and a section of its own (issue #44 item 9).
 */
export function ledgerSections(
  packets: TaskPacket[],
): { wave: number; title: string; packets: TaskPacket[] }[] {
  const titles = new Map<number, string>([
    [0, "Wave 0"],
    [1, "Wave 1"],
    [2, "Wave 2"],
    [OFF_ALLOWLIST_WAVE, "Off allowlist — denied or unlisted"],
  ]);
  const waves = [...new Set(packets.map(waveOf))].sort((a, b) => a - b);
  return waves.map((wave) => ({
    wave,
    title: titles.get(wave) ?? `Wave ${wave}`,
    packets: packets.filter((p) => waveOf(p) === wave),
  }));
}

/**
 * The operator-facing quiet counter. `quietDaysOf` measures wall-clock against `prMeta.updatedAt`,
 * which is a *stored observation* refreshed only by `sync` — the committed seed's is frozen at the
 * day it was captured. A bare `quiet=0d/14` therefore reads as a live look at the PR while actually
 * being an extrapolation from whatever the last sync saw (issue #44 item 11).
 *
 * Both dates are printed because they are two different facts and only look like one in the seed,
 * where they coincide. `updatedAt` is the PR's own last activity — the anchor the count measures
 * from. `syncedAt` is when we read it. After a real `sync` they diverge, and "quiet=3d, observed
 * today" is only coherent once the line says which date is which.
 */
export function quietLabel(
  quietDays: number,
  releaseDays: number,
  meta: { updatedAt: string; syncedAt: string },
): string {
  const active = meta.updatedAt.slice(0, 10);
  const observed = meta.syncedAt.slice(0, 10);
  return `quiet=${quietDays}d/${releaseDays} (PR last active ${active}, read by \`sync\` ${observed}; \`sync\` to refresh)`;
}
