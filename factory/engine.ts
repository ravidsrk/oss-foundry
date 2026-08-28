import { ALLOWLIST, isDenied, repoById } from "./allowlist.ts";
import type { LiveIssue } from "./github-scout.ts";
import { buildPacket } from "./packet.ts";
import { health } from "./scorecard.ts";
import { foundryAttestedWave0Merges } from "./status.ts";
import type {
  FactoryEvent,
  FactoryState,
  PacketStatus,
  ScorecardRow,
  TaskPacket,
} from "./types.ts";

export const INFLIGHT_STATUSES: PacketStatus[] = [
  "gated",
  "frozen",
  "approved",
  "implementing",
  "reviewing",
  "draft-ready",
  "submitted",
];

export function hasInflight(packets: TaskPacket[]): boolean {
  return packets.some((p) => INFLIGHT_STATUSES.includes(p.status));
}

export function repoHealth(scorecard: ScorecardRow[], repoId: string) {
  const row = scorecard.find((r) => r.repoId === repoId);
  if (!row) return "good" as const;
  return health(row);
}

export function maySelectRepo(
  state: FactoryState,
  repoId: string,
): { ok: true } | { ok: false; reason: string } {
  const denied = isDenied(repoId);
  if (denied) return { ok: false, reason: denied.reason };
  const repo = repoById(repoId);
  if (!repo) return { ok: false, reason: `${repoId} is not on the allowlist.` };
  if (repoHealth(state.scorecard, repoId) === "stop") {
    return { ok: false, reason: `${repoId} is halted on the scorecard.` };
  }
  if (repo.wave >= 1 && foundryAttestedWave0Merges(state.packets) < 2) {
    return {
      ok: false,
      reason: "Wave 1+ waits on two Foundry-attested Wave 0 merges.",
    };
  }
  return { ok: true };
}

export function applyTick(
  state: FactoryState,
  live: LiveIssue[] = [],
): { state: FactoryState; packet: TaskPacket | null; reason: string } {
  if (hasInflight(state.packets)) {
    const next = appendEvent(state, ev("tick", "Tick aborted — a packet is already in flight. One at a time."));
    return { state: next, packet: null, reason: "in-flight" };
  }

  const used = usedKeys(state.packets);
  const candidate = pickCandidate(state, live, used);
  if (!candidate) {
    const next = appendEvent(
      state,
      ev("tick", "Tick idle — no named candidate. Factory will not invent work."),
    );
    return { state: { ...next, ticksRun: state.ticksRun + 1, lastTickAt: now() }, packet: null, reason: "idle" };
  }

  const packet = buildPacket(candidate);
  const next: FactoryState = {
    ...state,
    packets: [packet, ...state.packets],
    events: [ev("tick", `Tick scouted ${packet.repoId}#${packet.issueNumber}`, packet.id), ...state.events].slice(0, 80),
    ticksRun: state.ticksRun + 1,
    lastTickAt: now(),
  };
  return { state: next, packet, reason: packet.policy.allow ? "gated" : packet.policy.code };
}

export function applyQueueLive(
  state: FactoryState,
  issue: LiveIssue,
  docs?: { agentsMd?: string; contributing?: string },
): { state: FactoryState; packet: TaskPacket | null; reason: string } {
  if (hasInflight(state.packets)) {
    const next = appendEvent(state, ev("tick", "Queue blocked — a packet is already in flight."));
    return { state: next, packet: null, reason: "in-flight" };
  }
  const existing = state.packets.find((p) => p.repoId === issue.repoId && p.issueNumber === issue.number);
  if (existing) return { state, packet: existing, reason: "duplicate" };

  const gate = maySelectRepo(state, issue.repoId);
  if (!gate.ok) {
    const next = appendEvent(state, ev("tick", `Queue refused ${issue.repoId}#${issue.number}: ${gate.reason}`));
    return { state: next, packet: null, reason: gate.reason };
  }

  const packet = buildPacket({
    repoId: issue.repoId,
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueUrl: issue.url,
    labels: issue.labels,
    agentsMd: docs?.agentsMd,
    contributing: docs?.contributing,
  });
  const next: FactoryState = {
    ...state,
    packets: [packet, ...state.packets],
    events: [ev("scout", `Queued live ${issue.repoId}#${issue.number}`, packet.id), ...state.events].slice(0, 80),
  };
  return { state: next, packet, reason: packet.policy.allow ? "gated" : packet.policy.code };
}

export function applyApprove(
  state: FactoryState,
  id: string,
  note: string,
): { state: FactoryState; error?: string } {
  const packet = state.packets.find((p) => p.id === id);
  if (!packet) return { state, error: `unknown packet ${id}` };
  if (packet.status !== "gated" && packet.status !== "frozen") {
    return { state, error: `cannot approve ${id} from status ${packet.status}` };
  }
  if (!packet.policy.allow) {
    return { state, error: `cannot approve ${id}: policy ${packet.policy.code}` };
  }
  const gate = maySelectRepo(state, packet.repoId);
  if (!gate.ok) return { state, error: `cannot approve ${id}: ${gate.reason}` };

  const packets = state.packets.map((p) =>
    p.id === id
      ? bump(p, {
          status: "approved",
          station: "implement",
          humanAttest: {
            by: "operator",
            at: now(),
            note: note || "Human freeze passed.",
          },
        })
      : p,
  );
  return {
    state: {
      ...state,
      packets,
      events: [ev("approve", `Approved ${id}`, id), ...state.events].slice(0, 80),
      humanApprovalsRemaining: Math.max(0, state.humanApprovalsRemaining - 1),
    },
  };
}

export function applyReject(
  state: FactoryState,
  id: string,
  reason: string,
): { state: FactoryState; error?: string } {
  const packet = state.packets.find((p) => p.id === id);
  if (!packet) return { state, error: `unknown packet ${id}` };
  const packets = state.packets.map((p) =>
    p.id === id
      ? bump(p, {
          status: "rejected",
          station: "terminal",
          class: p.class === "buildable" ? "out-of-scope" : p.class,
          parkReason: reason,
        })
      : p,
  );
  return {
    state: {
      ...state,
      packets,
      events: [ev("reject", reason, id), ...state.events].slice(0, 80),
    },
  };
}

function pickCandidate(
  state: FactoryState,
  live: LiveIssue[],
  used: Set<string>,
): {
  repoId: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  labels?: string[];
  agentsMd?: string;
  contributing?: string;
} | null {
  for (const issue of live) {
    const key = `${issue.repoId}#${issue.number}`;
    if (used.has(key)) continue;
    if (!maySelectRepo(state, issue.repoId).ok) continue;
    const packet = buildPacket({
      repoId: issue.repoId,
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueUrl: issue.url,
      labels: issue.labels,
    });
    if (!packet.policy.allow) continue;
    return {
      repoId: issue.repoId,
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueUrl: issue.url,
      labels: issue.labels,
    };
  }

  for (const repo of ALLOWLIST) {
    if (!maySelectRepo(state, repo.id).ok) continue;
    for (const issue of repo.firstIssues) {
      const key = `${repo.id}#${issue.number}`;
      if (used.has(key)) continue;
      const packet = buildPacket({
        repoId: repo.id,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.url,
        labels: repo.preferredLabels,
      });
      if (!packet.policy.allow) continue;
      return {
        repoId: repo.id,
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.url,
        labels: repo.preferredLabels,
      };
    }
  }
  return null;
}

function usedKeys(packets: TaskPacket[]): Set<string> {
  return new Set(packets.map((p) => `${p.repoId}#${p.issueNumber}`));
}

function bump(p: TaskPacket, patch: Partial<TaskPacket>): TaskPacket {
  return { ...p, ...patch, updatedAt: now() };
}

function now() {
  return new Date().toISOString();
}

function ev(kind: FactoryEvent["kind"], message: string, packetId?: string): FactoryEvent {
  return {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    at: now(),
    kind,
    packetId,
    message,
  };
}

function appendEvent(state: FactoryState, event: FactoryEvent): FactoryState {
  return { ...state, events: [event, ...state.events].slice(0, 80) };
}
