import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ALLOWLIST, repoById } from "./allowlist";
import type { LiveIssue } from "./github-scout";
import { buildPacket, renderPrBody } from "./packet";
import { runSandboxDry } from "./sandbox";
import { applyPacketToScorecard } from "./scorecard";
import { seedState } from "./seed";
import type { FactoryEvent, FactoryState, FollowUpEntry, PrMeta, ScoutScore, TaskPacket } from "./types";

const KEY = "foundry-v4";

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

function hasInflight(packets: TaskPacket[]) {
  return packets.some((p) =>
    ["gated", "frozen", "approved", "implementing", "reviewing", "draft-ready"].includes(p.status),
  );
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
        const { packets, events } = get();
        if (hasInflight(packets)) {
          set({
            events: [
              ev("tick", "Queue blocked — a packet is already in flight."),
              ...events,
            ].slice(0, 80),
          });
          return null;
        }
        if (packets.some((p) => p.repoId === issue.repoId && p.issueNumber === issue.number)) {
          return packets.find((p) => p.repoId === issue.repoId && p.issueNumber === issue.number) ?? null;
        }
        const next = buildPacket({
          repoId: issue.repoId,
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueUrl: issue.url,
          labels: issue.labels,
        });
        set({
          packets: [next, ...packets],
          events: [
            ev("scout", `Queued live ${issue.repoId}#${issue.number}`, next.id),
            ...events,
          ].slice(0, 80),
        });
        return next;
      },
      runTick: () => {
        const { packets, events, ticksRun, live } = get();
        if (hasInflight(packets)) {
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

        const liveHit = live.find((issue) => !used.has(`${issue.repoId}#${issue.number}`));
        if (liveHit) {
          next = buildPacket({
            repoId: liveHit.repoId,
            issueNumber: liveHit.number,
            issueTitle: liveHit.title,
            issueUrl: liveHit.url,
            labels: liveHit.labels,
          });
        }

        if (!next) {
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
      attachDraft: (id, url) => {
        const { packets, events, scorecard } = get();
        const packet = packets.find((p) => p.id === id);
        if (!packet) return;
        const alreadyOpened = packet.status === "submitted" || packet.status === "followed-up";
        set({
          packets: packets.map((p) =>
            p.id === id
              ? bump(p, { status: "submitted", station: "follow-up", prUrl: url })
              : p,
          ),
          scorecard: alreadyOpened ? scorecard : applyPacketToScorecard(scorecard, packet, "opened"),
          events: [ev("draft", `Attached draft ${url}`, id), ...events].slice(0, 80),
        });
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
