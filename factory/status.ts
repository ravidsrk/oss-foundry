import { repoById } from "./allowlist.ts";
import type { PacketStatus, PolicyVerdict, TaskPacket } from "./types.ts";

export function statusTone(
  status: PacketStatus,
): "muted" | "ok" | "danger" | "hold" | "accent" {
  if (status === "merged" || status === "draft-ready" || status === "followed-up") return "ok";
  if (status === "rejected" || status === "parked") return "danger";
  if (status === "gated" || status === "reviewing" || status === "approved") return "hold";
  return "accent";
}

export function policyTone(
  code: PolicyVerdict["code"],
): "muted" | "ok" | "danger" | "hold" | "accent" {
  if (code === "ALLOW") return "ok";
  if (code === "DENY_FORBIDDEN" || code === "DENY_UNKNOWN_POLICY") return "danger";
  return "hold";
}

export function formatWhen(iso: string | null) {
  if (!iso || iso === "—") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function needsFollowUp(packet: TaskPacket): boolean {
  if (!packet.prUrl) return false;
  if (["merged", "parked", "rejected"].includes(packet.status)) return false;
  if (packet.status === "followed-up") return false;
  return packet.status === "submitted" || packet.station === "follow-up";
}

export function foundryAttestedWave0Merges(packets: TaskPacket[]): number {
  return packets.filter((p) => {
    const repo = repoById(p.repoId);
    return repo?.wave === 0 && p.status === "merged" && Boolean(p.humanAttest);
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
