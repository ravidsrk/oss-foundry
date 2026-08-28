import { ALLOWLIST, isDenied, repoById } from "./allowlist.ts";
import { parsePrUrl } from "./github-pr.ts";
import type { LiveIssue } from "./github-scout.ts";
import { buildPacket, renderPrBody } from "./packet.ts";
import { planSandbox, runSandboxDry } from "./sandbox.ts";
import { applyPacketToScorecard, health } from "./scorecard.ts";
import { foundryAttestedWave0Merges } from "./status.ts";
import type {
  EvidenceManifest,
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

export function isPlaceholderSha(sha: string | undefined): boolean {
  return !isBoundSha(sha);
}

/** Full SHA-1, not abbreviated, not a known fake, not a single repeated nibble. */
export function isBoundSha(sha: string | undefined): boolean {
  if (!sha) return false;
  const s = sha.trim().toLowerCase();
  if (s === "origin/head" || s.startsWith("deadbeef")) return false;
  if (!/^[0-9a-f]{40}$/.test(s)) return false;
  if (/^([0-9a-f])\1{39}$/.test(s)) return false;
  return true;
}

export function evidenceIsReady(evidence: EvidenceManifest | undefined): boolean {
  if (!evidence) return false;
  if (evidence.negativeControl !== "red-on-revert") return false;
  if (evidence.testExit !== 0) return false;
  if (!isBoundSha(evidence.baseSha) || !isBoundSha(evidence.headSha)) return false;
  if (evidence.baseSha.toLowerCase() === evidence.headSha.toLowerCase()) return false;
  if (evidence.shaVerified !== true) return false;
  return true;
}

export interface EvidenceBinding {
  fastForward: boolean;
  messages: string[];
  filesChanged: number;
  diffLines: number;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** GitHub closing keywords only. Bare #N or this packet's owner/repo#N / issue URL. Foreign owner/repo#N does not bind. */
export function mentionsIssue(
  text: string,
  issueNumber: number,
  issueUrl: string,
  repoId: string,
): boolean {
  const kw = String.raw`(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)`;
  const n = String(issueNumber);
  const closeBare = new RegExp(`${kw}\\s*:?\\s*#${n}(?!\\d)`, "i");
  const closePrefixed = new RegExp(`${kw}\\s*:?\\s*${escapeRe(repoId)}#${n}(?!\\d)`, "i");
  if (closeBare.test(text) || closePrefixed.test(text)) return true;
  if (issueUrl) {
    const closeUrl = new RegExp(`${kw}\\s*:?\\s*${escapeRe(issueUrl)}`, "i");
    if (closeUrl.test(text)) return true;
  }
  return false;
}

export function applyAttachEvidence(
  state: FactoryState,
  id: string,
  evidence: EvidenceManifest,
  binding: EvidenceBinding,
): { state: FactoryState; error?: string } {
  const packet = state.packets.find((p) => p.id === id);
  if (!packet) return { state, error: `unknown packet ${id}` };
  if (!isBoundSha(evidence.baseSha) || !isBoundSha(evidence.headSha)) {
    return { state, error: "evidence SHAs must be full 40-char git objects, not placeholders" };
  }
  if (evidence.baseSha.toLowerCase() === evidence.headSha.toLowerCase()) {
    return { state, error: "evidence baseSha and headSha must differ" };
  }
  if (!binding.fastForward) {
    return {
      state,
      error: `evidence range is not a fast-forward from base to head on ${packet.repoId}`,
    };
  }
  if (binding.filesChanged < 1 || binding.diffLines < 1) {
    return { state, error: "compared range has no file diff" };
  }
  if (evidence.filesChanged !== binding.filesChanged || evidence.diffLines !== binding.diffLines) {
    return { state, error: "evidence scope must match the compared range" };
  }
  const blob = binding.messages.join("\n");
  if (!mentionsIssue(blob, packet.issueNumber, packet.issueUrl, packet.repoId)) {
    return { state, error: `commit range does not close ${packet.repoId}#${packet.issueNumber}` };
  }
  const bound: EvidenceManifest = { ...evidence, shaVerified: true };
  const packets = state.packets.map((p) => (p.id === id ? bump(p, { evidence: bound }) : p));
  return {
    state: {
      ...state,
      packets,
      events: [ev("review", `Evidence attached for ${id}`, id), ...state.events].slice(0, 80),
    },
  };
}

export function applyAdvance(
  state: FactoryState,
  id: string,
): { state: FactoryState; error?: string } {
  const packet = state.packets.find((p) => p.id === id);
  if (!packet) return { state, error: `unknown packet ${id}` };
  if (!packet.humanAttest && packet.status === "approved") {
    /* attest is written by approve; keep the belt */
  }
  if (packet.status === "approved") {
    if (!packet.humanAttest) return { state, error: `cannot advance ${id}: un-attested` };
    const sandbox = runSandboxDry(packet);
    const planned = planSandbox(packet);
    const session = { ...sandbox, status: "dry-run" as const, id: planned.id };
    const packets = state.packets.map((p) =>
      p.id === id ? bump(p, { status: "implementing", station: "implement", sandboxSession: session }) : p,
    );
    return {
      state: {
        ...state,
        packets,
        events: [ev("sandbox", `Sandbox ${session.provider} dry-run planned for ${id}`, id), ...state.events].slice(0, 80),
      },
    };
  }

  if (packet.status === "implementing") {
    const packets = state.packets.map((p) =>
      p.id === id ? bump(p, { status: "reviewing", station: "review" }) : p,
    );
    return {
      state: {
        ...state,
        packets,
        events: [ev("review", `Build-blind review started for ${id}`, id), ...state.events].slice(0, 80),
      },
    };
  }

  if (packet.status === "reviewing") {
    if (!evidenceIsReady(packet.evidence)) {
      return {
        state,
        error: `cannot enter draft-ready: attach SHA-bound evidence with red-on-revert first`,
      };
    }
    const body = renderPrBody(packet);
    const packets = state.packets.map((p) =>
      p.id === id
        ? bump(p, {
            status: "draft-ready",
            station: "draft",
            prBody: body,
            evidence: p.evidence ? { ...p.evidence, reviewedSha: p.evidence.headSha } : p.evidence,
          })
        : p,
    );
    return {
      state: {
        ...state,
        packets,
        events: [ev("draft", `Draft PR body ready for ${packet.repoId}#${packet.issueNumber}`, id), ...state.events].slice(0, 80),
      },
    };
  }

  return { state, error: `cannot advance ${id} from status ${packet.status}` };
}

export function applyAttachDraft(
  state: FactoryState,
  id: string,
  url: string,
  opts: { draft: boolean; headSha?: string; title?: string; body?: string },
): { state: FactoryState; error?: string } {
  const packet = state.packets.find((p) => p.id === id);
  if (!packet) return { state, error: `unknown packet ${id}` };
  if (packet.status !== "draft-ready" && packet.status !== "submitted") {
    return { state, error: `cannot attach draft from status ${packet.status}` };
  }
  const parsed = parsePrUrl(url);
  if (!parsed) return { state, error: "Not a GitHub pull request URL." };
  const [owner, name] = packet.repoId.split("/");
  if (parsed.owner !== owner || parsed.repo !== name) {
    return {
      state,
      error: `PR ${parsed.owner}/${parsed.repo}#${parsed.number} does not match packet repo ${packet.repoId}`,
    };
  }
  if (opts.draft !== true) {
    return { state, error: "PR must be a draft. Foundry will not attach a ready-for-review pull request." };
  }
  if (opts.headSha && packet.evidence?.headSha && opts.headSha !== packet.evidence.headSha) {
    return { state, error: `PR head ${opts.headSha.slice(0, 7)} does not match evidence head` };
  }
  const linked = `${opts.title ?? ""}\n${opts.body ?? ""}`;
  if (!mentionsIssue(linked, packet.issueNumber, packet.issueUrl, packet.repoId)) {
    return {
      state,
      error: `PR does not close packet issue ${packet.repoId}#${packet.issueNumber}`,
    };
  }
  const alreadyOpened = packet.status === "submitted" || Boolean(packet.prUrl);
  const packets = state.packets.map((p) =>
    p.id === id ? bump(p, { status: "submitted", station: "follow-up", prUrl: url }) : p,
  );
  return {
    state: {
      ...state,
      packets,
      scorecard: alreadyOpened ? state.scorecard : applyPacketToScorecard(state.scorecard, packet, "opened"),
      events: [ev("draft", `Attached draft ${url}`, id), ...state.events].slice(0, 80),
    },
  };
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
