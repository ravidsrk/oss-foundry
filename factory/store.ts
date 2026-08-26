import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ALLOWLIST, repoById } from "./allowlist";
import { buildPacket, renderPrBody } from "./packet";
import { runSandboxDry } from "./sandbox";
import { applyPacketToScorecard } from "./scorecard";
import { seedState } from "./seed";
import type { FactoryEvent, FactoryState, ScoutScore, TaskPacket } from "./types";

const KEY = "foundry-v2";

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

interface FoundryStore extends FactoryState {
  runTick: () => TaskPacket | null;
  approve: (id: string, note: string) => void;
  reject: (id: string, reason: string) => void;
  advance: (id: string) => void;
  applyGrokScore: (id: string, scout: ScoutScore) => void;
  reset: () => void;
}

export const useFoundry = create<FoundryStore>()(
  persist(
    (set, get) => ({
      ...seedState(),
      runTick: () => {
        const { packets, events, ticksRun } = get();
        const inflight = packets.some((p) =>
          ["gated", "frozen", "approved", "implementing", "reviewing", "draft-ready"].includes(
            p.status,
          ),
        );
        if (inflight) {
          set({
            events: [
              ev("tick", "Tick aborted — a packet is already in flight. One at a time."),
              ...events,
            ].slice(0, 80),
          });
          return null;
        }

        const used = new Set(packets.map((p) => `${p.repoId}#${p.issueNumber}`));
        let next: TaskPacket | null = null;
        for (const repo of ALLOWLIST) {
          for (const issue of repo.firstIssues) {
            const key = `${repo.id}#${issue.number}`;
            if (used.has(key)) continue;
            next = buildPacket({
              repoId: repo.id,
              issueNumber: issue.number,
              issueTitle: issue.title,
              issueUrl: issue.url,
              labels: repo.preferredLabels,
            });
            break;
          }
          if (next) break;
        }

        if (!next) {
          const fallback = ALLOWLIST.find((r) => r.wave <= 1);
          if (!fallback) return null;
          const n = 9000 + ticksRun;
          next = buildPacket({
            repoId: fallback.id,
            issueNumber: n,
            issueTitle: `Docs: clarify agent disclosure for ${fallback.name}`,
            issueUrl: `https://github.com/${fallback.id}/issues/${n}`,
            labels: fallback.preferredLabels,
          });
        }

        set({
          packets: [next, ...packets],
          events: [
            ev("tick", `Tick scouted ${next.repoId}#${next.issueNumber}`, next.id),
            ...events,
          ].slice(0, 80),
          ticksRun: ticksRun + 1,
          lastTickAt: new Date().toISOString(),
        });
        return next;
      },
      approve: (id, note) => {
        const { packets, events, humanApprovalsRemaining } = get();
        set({
          packets: packets.map((p) =>
            p.id === id
              ? bump(p, {
                  status: "approved",
                  station: "implement",
                  humanAttest: {
                    by: "operator",
                    at: new Date().toISOString(),
                    note: note || "Human freeze passed.",
                  },
                })
              : p,
          ),
          events: [ev("approve", `Approved ${id}`, id), ...events].slice(0, 80),
          humanApprovalsRemaining: Math.max(0, humanApprovalsRemaining - 1),
        });
      },
      reject: (id, reason) => {
        const { packets, events } = get();
        set({
          packets: packets.map((p) =>
            p.id === id
              ? bump(p, {
                  status: "rejected",
                  station: "terminal",
                  class: p.class === "buildable" ? "out-of-scope" : p.class,
                  parkReason: reason,
                })
              : p,
          ),
          events: [ev("reject", reason, id), ...events].slice(0, 80),
        });
      },
      advance: (id) => {
        const { packets, events, scorecard } = get();
        const packet = packets.find((p) => p.id === id);
        if (!packet) return;

        if (packet.status === "approved") {
          const sandbox = runSandboxDry(packet);
          set({
            packets: packets.map((p) =>
              p.id === id
                ? bump(p, {
                    status: "implementing",
                    station: "implement",
                    sandboxSession: sandbox,
                  })
                : p,
            ),
            events: [
              ev("sandbox", `Sandbox ${sandbox.provider} harvested for ${id}`, id),
              ...events,
            ].slice(0, 80),
          });
          return;
        }

        if (packet.status === "implementing") {
          set({
            packets: packets.map((p) =>
              p.id === id
                ? bump(p, {
                    status: "reviewing",
                    station: "review",
                    evidence: {
                      baseSha: "origin/HEAD",
                      headSha: `deadbeef${id.slice(-4)}`,
                      testCommand: repoById(p.repoId)?.testCommand ?? "true",
                      testExit: 0,
                      negativeControl: "red-on-revert",
                      filesChanged: 2,
                      diffLines: 48,
                      notes: ["Independent reviewer did not see implementer traces."],
                    },
                  })
                : p,
            ),
            events: [ev("review", `Build-blind review started for ${id}`, id), ...events].slice(0, 80),
          });
          return;
        }

        if (packet.status === "reviewing") {
          const body = renderPrBody(packet);
          set({
            packets: packets.map((p) =>
              p.id === id
                ? bump(p, {
                    status: "draft-ready",
                    station: "draft",
                    prBody: body,
                    evidence: p.evidence
                      ? { ...p.evidence, reviewedSha: p.evidence.headSha }
                      : p.evidence,
                  })
                : p,
            ),
            scorecard: applyPacketToScorecard(scorecard, packet, "opened"),
            events: [
              ev("draft", `Draft PR body ready for ${packet.repoId}#${packet.issueNumber}`, id),
              ...events,
            ].slice(0, 80),
          });
        }
      },
      applyGrokScore: (id, scout) => {
        const { packets, events } = get();
        set({
          packets: packets.map((p) => (p.id === id ? bump(p, { scout }) : p)),
          events: [ev("score", `Grok scout scored ${id}: ${scout.total}`, id), ...events].slice(0, 80),
        });
      },
      reset: () => set({ ...seedState() }),
    }),
    { name: KEY, skipHydration: true },
  ),
);
