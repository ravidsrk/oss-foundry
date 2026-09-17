import { applyAdvance, applyApprove, applyTick, type EvidenceBinding } from "./engine.ts";
import { emptyScorecard } from "./scorecard.ts";
import type { LiveIssue as ScoutIssue } from "./github-scout.ts";
import type { FactoryState } from "./types.ts";

export function blank(): FactoryState {
  return {
    version: 6,
    packets: [],
    events: [],
    scorecard: emptyScorecard(),
    ticksRun: 0,
    lastTickAt: null,
    mergedTotal: 0,
    bans: 0,
    humanApprovalsRemaining: 20,
  };
}

export const BASE = "251fe899c5bd843a7dad71d908c0af3bfcea79e1";
export const HEAD = "d91fe2f6725163fab8f9dd42e5c2b0c0c9f0f40d";
export const OTHER = "36d0f23708adbdf911e4df050ed516821278a9fc";

export function bindingFor(
  packet: { issueNumber: number; issueUrl: string },
  extra: Partial<EvidenceBinding> = {},
): EvidenceBinding {
  return {
    fastForward: true,
    messages: [`Fixes #${packet.issueNumber}`],
    filesChanged: 1,
    diffLines: 1,
    ...extra,
  };
}

export function witnessed(repoId = "ravidsrk/orca-fleet", packetId = "pkt_ravidsrk_orca-fleet_71") {
  return {
    provider: "host" as const,
    testExit: 0,
    revertExit: 1,
    testLogSha: "c".repeat(64),
    revertLogSha: "d".repeat(64),
    ranAt: "2026-08-28T16:00:00.000Z",
    repoId,
    baseSha: BASE,
    headSha: HEAD,
    testLogPath: `docs/evidence/logs/${packetId}/test.log`,
    revertLogPath: `docs/evidence/logs/${packetId}/revert.log`,
  };
}

export function reviewing(): { state: FactoryState; id: string } {
  let state = applyTick(blank()).state;
  const id = state.packets[0].id;
  state = applyApprove(state, id, "attest").state;
  state = applyAdvance(state, id).state;
  state = applyAdvance(state, id).state;
  return { state, id };
}

export function readyEvidence(
  packet: { issueNumber: number; issueUrl: string },
  extra: { filesChanged?: number; diffLines?: number } = {},
) {
  const filesChanged = extra.filesChanged ?? 1;
  const diffLines = extra.diffLines ?? 1;
  return {
    evidence: {
      baseSha: BASE,
      headSha: HEAD,
      testCommand: "true",
      testExit: 0,
      negativeControl: "red-on-revert" as const,
      filesChanged,
      diffLines,
      notes: [],
      witness: witnessed(),
    },
    binding: bindingFor(packet, { filesChanged, diffLines }),
  };
}

/**
 * `mkdtemp` answers with a fixed path unless a case overrides it. The step exists so the protocol
 * never calls `mkdtempSync` itself (issue #56): a stub that returned nothing would make every
 * witness here fail closed on the scratch directory, and a stub that created a REAL directory would
 * leak one per test, which is issue #64.
 */
export const FAKE_SCRATCH = "/tmp/foundry-witness-fake";

export function fakeRunner(script: Record<string, { exit: number; output: string }>) {
  const calls: string[] = [];
  const cwds: (string | undefined)[] = [];
  const runner = async (cmd: string, args: string[], opts?: { cwd?: string }) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    cwds.push(opts?.cwd);
    const hit = Object.entries(script).find(([prefix]) => line.includes(prefix));
    if (hit) return hit[1];
    if (cmd === "mkdtemp") return { exit: 0, output: FAKE_SCRATCH };
    return { exit: 0, output: "" };
  };
  return { runner, calls, cwds };
}

export function live(repoId: string, number: number, title = "docs tweak"): ScoutIssue {
  return {
    repoId,
    number,
    title,
    url: `https://github.com/${repoId}/issues/${number}`,
    labels: [],
    daysOld: 1,
    scout: { total: 1, parts: { wave: 0, labels: 0, size: 0, freshness: 0 } },
  };
}


