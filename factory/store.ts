import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  applyAdvance,
  applyApprove,
  applyAttachDraft,
  applyAttachEvidence,
  applyQueueLive,
  applyReject,
  applyTick,
} from "./engine.ts";
import type { LiveIssue } from "./github-scout.ts";
import { applyPacketToScorecard } from "./scorecard.ts";
import { seedState } from "./seed.ts";
import type {
  EvidenceManifest,
  FactoryEvent,
  FactoryState,
  FollowUpEntry,
  PrMeta,
  ScoutScore,
  TaskPacket,
} from "./types.ts";

const KEY = "foundry-v6";

function ev(
  kind: FactoryEvent["kind"],
  message: string,
  packetId?: string,
): FactoryEvent {
  return {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    kind,
    packetId,
    message,
  };
}

function bump(p: TaskPacket, patch: Partial<TaskPacket>): TaskPacket {
  return { ...p, ...patch, updatedAt: new Date().toISOString() };
}

function core(s: FactoryState): FactoryState {
  return {
    version: s.version,
    packets: s.packets,
    events: s.events,
    scorecard: s.scorecard,
    ticksRun: s.ticksRun,
    lastTickAt: s.lastTickAt,
    mergedTotal: s.mergedTotal,
    bans: s.bans,
    humanApprovalsRemaining: s.humanApprovalsRemaining,
  };
}

interface FoundryStore extends FactoryState {
  live: LiveIssue[];
  liveErrors: string[];
  liveAt: string | null;
  runTick: () => TaskPacket | null;
  queueLive: (issue: LiveIssue) => TaskPacket | null;
  setLive: (issues: LiveIssue[], errors: string[]) => void;
  approve: (id: string, note: string) => void;
  reject: (id: string, reason: string) => void;
  advance: (id: string) => void;
  attachEvidence: (id: string, evidence: EvidenceManifest) => void;
  attachDraft: (id: string, url: string) => void;
  recordFollowUp: (id: string, kind: FollowUpEntry["kind"], body: string, url?: string) => void;
  markQuiet: (id: string) => void;
  applyPrMeta: (id: string, meta: PrMeta) => void;
  applyGrokScore: (id: string, scout: ScoutScore) => void;
  reset: () => void;
}

export const useFoundry = create<FoundryStore>()(
  persist(
    (set, get) => ({
      ...seedState(),
      live: [],
      liveErrors: [],
      liveAt: null,
      setLive: (issues, errors) =>
        set({
          live: issues,
          liveErrors: errors,
          liveAt: new Date().toISOString(),
          events: [
            ev("scout", `Live GitHub scout returned ${issues.length} issues.`),
            ...get().events,
          ].slice(0, 80),
        }),
      queueLive: (issue) => {
        const result = applyQueueLive(core(get()), issue);
        set(result.state);
        return result.packet;
      },
      runTick: () => {
        const s = get();
        const result = applyTick(core(s), s.live);
        set(result.state);
        return result.packet;
      },
      approve: (id, note) => {
        const result = applyApprove(core(get()), id, note);
        set(result.state);
      },
      reject: (id, reason) => {
        const result = applyReject(core(get()), id, reason);
        set(result.state);
      },
      advance: (id) => {
        const result = applyAdvance(core(get()), id);
        set(result.state);
      },
      attachEvidence: (id, evidence) => {
        const result = applyAttachEvidence(core(get()), id, evidence);
        set(result.state);
      },
      attachDraft: (id, url) => {
        const result = applyAttachDraft(core(get()), id, url);
        set(result.state);
      },
      recordFollowUp: (id, kind, body, url) => {
        const { packets, events } = get();
        const packet = packets.find((p) => p.id === id);
        if (!packet) return;
        const entry: FollowUpEntry = {
          id: `fu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          at: new Date().toISOString(),
          kind,
          body,
          url,
        };
        set({
          packets: packets.map((p) =>
            p.id === id
              ? bump(p, {
                  station: "follow-up",
                  followUps: [entry, ...(p.followUps ?? [])],
                })
              : p,
          ),
          events: [ev("follow-up", body, id), ...events].slice(0, 80),
        });
      },
      markQuiet: (id) => {
        const { packets, events } = get();
        const packet = packets.find((p) => p.id === id);
        if (!packet) return;
        const entry: FollowUpEntry = {
          id: `fu_${Date.now()}_quiet`,
          at: new Date().toISOString(),
          kind: "quiet",
          body: "Threads answered. Waiting on maintainer merge. Foundry does not merge.",
        };
        set({
          packets: packets.map((p) =>
            p.id === id
              ? bump(p, {
                  status: "followed-up",
                  station: "follow-up",
                  followUps: [entry, ...(p.followUps ?? [])],
                })
              : p,
          ),
          events: [ev("follow-up", `Marked quiet — ${packet.repoId}#${packet.issueNumber}`, id), ...events].slice(
            0,
            80,
          ),
        });
      },
      applyPrMeta: (id, meta) => {
        const { packets, events, scorecard, mergedTotal } = get();
        const packet = packets.find((p) => p.id === id);
        if (!packet) return;

        let status = packet.status;
        let station = packet.station;
        let classified = packet.class;
        let nextScore = scorecard;
        let nextMerged = mergedTotal;

        if (meta.merged && packet.status !== "merged") {
          status = "merged";
          station = "terminal";
          nextScore = applyPacketToScorecard(scorecard, packet, "merged");
          nextMerged = mergedTotal + 1;
        } else if (meta.state === "closed" && !meta.merged && packet.status !== "parked") {
          status = "parked";
          station = "terminal";
          classified = "externally-resolved";
          nextScore = applyPacketToScorecard(scorecard, packet, "closed");
        } else if (["draft-ready", "submitted", "followed-up"].includes(packet.status)) {
          station = "follow-up";
          if (packet.status === "draft-ready") status = "submitted";
        }

        set({
          packets: packets.map((p) =>
            p.id === id
              ? bump(p, {
                  prUrl: meta.url,
                  prMeta: meta,
                  status,
                  station,
                  class: classified,
                  evidence: p.evidence
                    ? {
                        ...p.evidence,
                        headSha: meta.headSha,
                        notes: [...p.evidence.notes.filter((n) => !n.startsWith("Synced ")), `Synced ${meta.headSha.slice(0, 7)}`],
                      }
                    : p.evidence,
                })
              : p,
          ),
          scorecard: nextScore,
          mergedTotal: nextMerged,
          events: [
            ev(
              "follow-up",
              `Synced ${meta.url} — ${meta.merged ? "merged" : meta.draft ? "draft" : meta.state}`,
              id,
            ),
            ...events,
          ].slice(0, 80),
        });
      },
      applyGrokScore: (id, scout) => {
        const { packets, events } = get();
        set({
          packets: packets.map((p) => (p.id === id ? bump(p, { scout }) : p)),
          events: [ev("score", `Grok scout scored ${id}: ${scout.total}`, id), ...events].slice(0, 80),
        });
      },
      reset: () => set({ ...seedState(), live: [], liveErrors: [], liveAt: null }),
    }),
    { name: KEY, skipHydration: true },
  ),
);
