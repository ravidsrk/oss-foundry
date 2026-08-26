import { repoById } from "./allowlist";
import type { PacketStatus, PolicyVerdict, TaskPacket } from "./types";

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

export function waveOf(packet: TaskPacket): number {
  return repoById(packet.repoId)?.wave ?? 99;
}
