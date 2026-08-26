import type { PacketStatus, PolicyVerdict } from "./types";

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
