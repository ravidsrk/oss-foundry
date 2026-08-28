import { ALLOWLIST, CAPS, isDenied, repoById } from "./allowlist.ts";
import { parsePrUrl } from "./github-pr.ts";
import type { LiveIssue } from "./github-scout.ts";
import { AGENT_NAME_RE, commitTrailerLine, type DisclosureTrailer } from "./neighbor.ts";
import { buildPacket, renderPrBody } from "./packet.ts";
import { planSandbox, runSandboxDry } from "./sandbox.ts";
import { applyPacketToScorecard, health } from "./scorecard.ts";
import { foundryAttestedWave0Merges } from "./status.ts";
import type {
  EvidenceManifest,
  FactoryEvent,
  FactoryState,
  FollowUpEntry,
  PacketStatus,
  PrMeta,
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

export function inflightCount(packets: TaskPacket[]): number {
  return packets.filter((p) => INFLIGHT_STATUSES.includes(p.status)).length;
}

export function hasInflight(packets: TaskPacket[]): boolean {
  return inflightCount(packets) >= CAPS.in_flight;
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
  competingKeys: readonly string[] = [],
  adjacentKeys: readonly string[] = [],
): { state: FactoryState; packet: TaskPacket | null; reason: string } {
  if (hasInflight(state.packets)) {
    const next = appendEvent(state, ev("tick", "Tick aborted — a packet is already in flight. One at a time."));
    return { state: next, packet: null, reason: "in-flight" };
  }

  let held = state;
  if (adjacentKeys.length > 0) {
    held = appendEvent(
      held,
      ev(
        "tick",
        `Tick held ${adjacentKeys.join(", ")} — adjacent PR activity mentions the issue; taste gate, human triage before scouting.`,
      ),
    );
  }

  const used = usedKeys(held.packets);
  const blocked = new Set([...competingKeys, ...adjacentKeys]);
  const candidate = pickCandidate(held, live, used, blocked);
  if (!candidate) {
    const next = appendEvent(
      held,
      ev("tick", "Tick idle — no named candidate. Factory will not invent work."),
    );
    return { state: { ...next, ticksRun: held.ticksRun + 1, lastTickAt: now() }, packet: null, reason: "idle" };
  }

  const packet = buildPacket(candidate);
  const next: FactoryState = {
    ...held,
    packets: [packet, ...held.packets],
    events: [ev("tick", `Tick scouted ${packet.repoId}#${packet.issueNumber}`, packet.id), ...held.events].slice(0, 80),
    ticksRun: held.ticksRun + 1,
    lastTickAt: now(),
  };
  return { state: next, packet, reason: packet.policy.allow ? "gated" : packet.policy.code };
}

export function applyQueueLive(
  state: FactoryState,
  issue: LiveIssue,
  docs?: { agentsMd?: string; contributing?: string },
  competingPr = false,
): { state: FactoryState; packet: TaskPacket | null; reason: string } {
  if (hasInflight(state.packets)) {
    const next = appendEvent(state, ev("tick", "Queue blocked — a packet is already in flight."));
    return { state: next, packet: null, reason: "in-flight" };
  }
  if (competingPr) {
    const next = appendEvent(
      state,
      ev("tick", `Queue refused ${issue.repoId}#${issue.number}: an open PR already covers the issue.`),
    );
    return { state: next, packet: null, reason: "already-has-pr" };
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
    agentsMd: docs?.agentsMd ?? issue.agentsMd,
    contributing: docs?.contributing ?? issue.contributing,
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

export function applyHalt(
  state: FactoryState,
  repoId: string,
  reason: string,
): { state: FactoryState; error?: string } {
  const repo = repoById(repoId);
  if (!repo) return { state, error: `${repoId} is not on the allowlist.` };
  const note = reason || "maintainer asked the factory to stop.";
  const row = state.scorecard.find((r) => r.repoId === repoId);
  const alreadyBanned = row?.maintainerTone === "banned";
  const scorecard = state.scorecard.map((r) =>
    r.repoId === repoId
      ? { ...r, maintainerTone: "banned" as const, lastTouch: now().slice(0, 10) }
      : r,
  );
  let next: FactoryState = {
    ...state,
    scorecard,
    bans: alreadyBanned ? state.bans : state.bans + 1,
  };
  for (const packet of state.packets) {
    if (packet.repoId !== repoId) continue;
    if (!INFLIGHT_STATUSES.includes(packet.status) && packet.status !== "followed-up") continue;
    next = park(next, packet.id, note, "score");
  }
  return {
    state: appendEvent(next, ev("score", `Halted ${repoId}: ${note}`)),
  };
}

function pickCandidate(
  state: FactoryState,
  live: LiveIssue[],
  used: Set<string>,
  competing: Set<string>,
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
    if (used.has(key) || competing.has(key)) continue;
    if (!maySelectRepo(state, issue.repoId).ok) continue;
    const packet = buildPacket({
      repoId: issue.repoId,
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueUrl: issue.url,
      labels: issue.labels,
      agentsMd: issue.agentsMd,
      contributing: issue.contributing,
    });
    if (!packet.policy.allow) continue;
    return {
      repoId: issue.repoId,
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueUrl: issue.url,
      labels: issue.labels,
      agentsMd: issue.agentsMd,
      contributing: issue.contributing,
    };
  }

  for (const repo of ALLOWLIST) {
    if (!maySelectRepo(state, repo.id).ok) continue;
    for (const issue of repo.firstIssues) {
      const key = `${repo.id}#${issue.number}`;
      if (used.has(key) || competing.has(key)) continue;
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

export function findCompetingPull(
  pulls: { title: string; body: string; url: string }[],
  issueNumber: number,
  issueUrl: string,
  repoId: string,
): { title: string; body: string; url: string } | undefined {
  return pulls.find((pull) => mentionsIssue(`${pull.title}\n${pull.body}`, issueNumber, issueUrl, repoId));
}

/**
 * Plain reference without a closing keyword: bare #N (not repo-prefixed), this repo's
 * owner/repo#N, or the issue URL. Foreign owner/repo#N does not count. Deliberately
 * over-inclusive: "PR #71" (a pull's own number) also matches — over-inclusion only
 * escalates to an adjacent hold a human clears, never a silent skip. Do not "fix" this
 * into a false negative.
 */
export function referencesIssue(
  text: string,
  issueNumber: number,
  issueUrl: string,
  repoId: string,
): boolean {
  const n = String(issueNumber);
  const bare = new RegExp(String.raw`(?<![\w/])#${n}(?!\d)`);
  const prefixed = new RegExp(`(?<![\\w/])${escapeRe(repoId)}#${n}(?!\\d)`, "i");
  if (bare.test(text) || prefixed.test(text)) return true;
  return Boolean(issueUrl) && text.includes(issueUrl);
}

/** Head branch names that conventionally carry an issue number: fix/71, issue-71, gh_71, bug/71-slug. `bug` is a deliberate superset of the spec's fix|issue|gh seed list. */
export function branchMentionsIssue(headRef: string | undefined, issueNumber: number): boolean {
  if (!headRef) return false;
  const n = String(issueNumber);
  const re = new RegExp(String.raw`(?:^|[/_-])(?:fix|issue|bug|gh)[/_-]?0*${n}(?:$|[^0-9])`, "i");
  return re.test(headRef);
}

export interface CompetitionPull {
  title: string;
  body: string;
  url: string;
  headRef?: string;
}

export type CompetitionVerdict =
  | { kind: "competing"; url: string; why: "closing-keyword" | "timeline-link" }
  | { kind: "adjacent"; url: string; why: "plain-mention" | "branch-name" }
  | { kind: "clear" };

/**
 * Two-tier competing-work verdict per docs/02-good-neighbor.md rule 8.
 * competing (stand down): a closing-keyword PR, or an open PR GitHub's issue timeline links.
 * adjacent (taste gate, hold for a human): a plain textual mention or an issue-numbered branch.
 */
export function classifyCompetition(
  input: { pulls: CompetitionPull[]; crossReferencedPullUrls?: readonly string[] },
  issueNumber: number,
  issueUrl: string,
  repoId: string,
): CompetitionVerdict {
  const closing = findCompetingPull(input.pulls, issueNumber, issueUrl, repoId);
  if (closing) return { kind: "competing", url: closing.url, why: "closing-keyword" };
  const linked = (input.crossReferencedPullUrls ?? [])[0];
  if (linked) return { kind: "competing", url: linked, why: "timeline-link" };
  const mention = input.pulls.find((pull) =>
    referencesIssue(`${pull.title}\n${pull.body}`, issueNumber, issueUrl, repoId),
  );
  if (mention) return { kind: "adjacent", url: mention.url, why: "plain-mention" };
  const branch = input.pulls.find((pull) => branchMentionsIssue(pull.headRef, issueNumber));
  if (branch) return { kind: "adjacent", url: branch.url, why: "branch-name" };
  return { kind: "clear" };
}

function scopeOverflow(repoId: string, filesChanged: number, diffLines: number): string | undefined {
  const repo = repoById(repoId);
  if (!repo) return undefined;
  if (filesChanged > repo.maxFiles) {
    return `Packet would touch ${filesChanged} files; cap is ${repo.maxFiles}.`;
  }
  if (diffLines > repo.maxDiffLines) {
    return `Diff ${diffLines} lines exceeds cap ${repo.maxDiffLines}.`;
  }
  return undefined;
}

export function applyAttachEvidence(
  state: FactoryState,
  id: string,
  evidence: EvidenceManifest,
  binding: EvidenceBinding,
): { state: FactoryState; error?: string } {
  const packet = state.packets.find((p) => p.id === id);
  if (!packet) return { state, error: `unknown packet ${id}` };
  if (packet.status !== "reviewing") {
    return { state, error: `cannot attach evidence from status ${packet.status}; packet must be reviewing` };
  }
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
  const overflow = scopeOverflow(packet.repoId, binding.filesChanged, binding.diffLines);
  if (overflow) {
    const parked = park(state, id, overflow);
    return { state: parked, error: `${overflow} Packet parked.` };
  }
  const blob = binding.messages.join("\n");
  if (!mentionsIssue(blob, packet.issueNumber, packet.issueUrl, packet.repoId)) {
    return { state, error: `commit range does not close ${packet.repoId}#${packet.issueNumber}` };
  }
  const trailerViolation = commitTrailerViolation(
    binding.messages,
    repoById(packet.repoId)?.disclosureTrailer ?? "pr-body-only",
  );
  if (trailerViolation) {
    return { state, error: trailerViolation };
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
    const overflow = scopeOverflow(
      packet.repoId,
      packet.evidence!.filesChanged,
      packet.evidence!.diffLines,
    );
    if (overflow) {
      const parked = park(state, id, overflow);
      return { state: parked, error: `${overflow} Packet parked.` };
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
  const expected = packet.evidence?.reviewedSha ?? packet.evidence?.headSha;
  if (!isBoundSha(opts.headSha)) {
    return { state, error: "PR head SHA is required and must match reviewed evidence" };
  }
  if (!isBoundSha(expected) || opts.headSha!.toLowerCase() !== expected.toLowerCase()) {
    return { state, error: `PR head ${opts.headSha!.slice(0, 7)} does not match evidence head` };
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

function park(
  state: FactoryState,
  id: string,
  reason: string,
  kind: FactoryEvent["kind"] = "reject",
): FactoryState {
  const packets = state.packets.map((p) =>
    p.id === id
      ? bump(p, {
          status: "parked",
          station: "terminal",
          class: "out-of-scope",
          parkReason: reason,
        })
      : p,
  );
  return {
    ...state,
    packets,
    events: [ev(kind, reason, id), ...state.events].slice(0, 80),
  };
}

/** The one place the CLI turns a compare result into an evidence binding — fastForward is derived, never asserted. */
export function bindingFromCompare(compared: {
  aheadBy: number;
  filesChanged: number;
  diffLines: number;
  messages: string[];
}): EvidenceBinding {
  return {
    fastForward: compared.aheadBy >= 1,
    messages: compared.messages,
    filesChanged: compared.filesChanged,
    diffLines: compared.diffLines,
  };
}

/** ADR 0002: answered threads + this many quiet days move `submitted` → `followed-up`, releasing the slot. */
export const QUIET_RELEASE_DAYS = 14;
/** ADR 0002: after this many quiet days an abandoned draft gets a closedUnmerged-intent note. A human closes; the engine never does. */
export const STALE_INTENT_DAYS = 45;

/** Whole days since the PR's last recorded activity. GitHub bumps updated_at on any activity, bots included — conservative: noise resets the clock, it never releases early. */
export function quietDaysOf(meta: PrMeta, at: string): number {
  const updated = Date.parse(meta.updatedAt);
  const nowMs = Date.parse(at);
  if (!Number.isFinite(updated) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.floor((nowMs - updated) / 86_400_000));
}

function followUpEntry(at: string, kind: FollowUpEntry["kind"], body: string, url?: string): FollowUpEntry {
  return {
    id: `fu_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    at,
    kind,
    body,
    url,
  };
}

/**
 * Apply a live PR sync to a submitted/followed-up packet.
 * merged → terminal + scorecard `merged`. closed unmerged → followed-up + scorecard `closedUnmerged`.
 * open: answered threads + ≥QUIET_RELEASE_DAYS quiet releases the in-flight slot; new maintainer
 * activity on a followed-up packet re-blocks the factory until answered; ≥STALE_INTENT_DAYS quiet
 * records a stale-intent note — closing stays a human act.
 */
export function applyPrSync(
  state: FactoryState,
  id: string,
  meta: PrMeta,
  opts: { threadsAnswered: boolean; at?: string },
): { state: FactoryState; error?: string } {
  const packet = state.packets.find((p) => p.id === id);
  if (!packet) return { state, error: `unknown packet ${id}` };
  if (packet.status !== "submitted" && packet.status !== "followed-up") {
    return { state, error: `cannot sync PR from status ${packet.status}` };
  }
  const at = opts.at ?? now();
  const events: FactoryEvent[] = [];
  let next: TaskPacket = bump(packet, { prMeta: meta });
  let scorecard = state.scorecard;

  let mergedNow = false;
  if (meta.merged) {
    // Reachable only from submitted/followed-up; the merged status blocks re-entry, so this fires once.
    next = bump(next, { status: "merged", station: "terminal" });
    scorecard = applyPacketToScorecard(scorecard, packet, "merged");
    mergedNow = true;
    events.push(ev("follow-up", `Merged by maintainers — ${meta.url}`, id));
  } else if (meta.state === "closed") {
    next = bump(next, { status: "followed-up" });
    // Edge-triggered: write closedUnmerged only on the open→closed transition. Re-syncing an
    // already-closed PR must not inflate the terminal count (it feeds mergeRate and the halt).
    const firstClose = packet.prMeta?.state !== "closed";
    if (firstClose) {
      scorecard = applyPacketToScorecard(scorecard, packet, "closed");
      events.push(ev("follow-up", `Closed unmerged — scorecard closedUnmerged written for ${packet.repoId}`, id));
    }
  } else {
    const quiet = quietDaysOf(meta, at);
    const woke =
      packet.status === "followed-up" &&
      packet.prMeta !== undefined &&
      packet.prMeta.updatedAt !== meta.updatedAt;
    if (woke) {
      next = bump(next, { status: "submitted" });
      events.push(ev("follow-up", `Maintainer activity on ${meta.url} — answer threads before any new tick`, id));
    } else if (packet.status === "submitted" && opts.threadsAnswered && quiet >= QUIET_RELEASE_DAYS) {
      next = bump(next, {
        status: "followed-up",
        followUps: [
          ...(next.followUps ?? []),
          followUpEntry(at, "quiet", `Threads answered; PR quiet ${quiet} days — slot released, follow-up continues.`, meta.url),
        ],
      });
      events.push(ev("follow-up", `Quiet ${quiet}d ≥ ${QUIET_RELEASE_DAYS} — packet followed-up, slot released`, id));
    }
    // Deliberately no scorecard write here: a still-open draft is not a terminal outcome, and
    // closedUnmerged feeds mergeRate/halt (docs/08-operations.md). The row is written once, on the
    // actual open→closed transition above. The note records the intent; a human performs the close.
    if (quiet >= STALE_INTENT_DAYS) {
      const already = (next.followUps ?? []).some((f) => f.kind === "note" && f.body.startsWith("stale-intent"));
      if (!already) {
        next = bump(next, {
          followUps: [
            ...(next.followUps ?? []),
            followUpEntry(
              at,
              "note",
              `stale-intent: quiet ${quiet} days ≥ ${STALE_INTENT_DAYS}. Record closedUnmerged and close with a polite note — a human decides; the engine does not close PRs.`,
              meta.url,
            ),
          ],
        });
        events.push(ev("follow-up", `Stale ${quiet}d — closedUnmerged intent recorded; a human closes`, id));
      }
    }
  }

  return {
    state: {
      ...state,
      packets: state.packets.map((p) => (p.id === id ? next : p)),
      scorecard,
      mergedTotal: mergedNow ? state.mergedTotal + 1 : state.mergedTotal,
      events: [...events.reverse(), ...state.events].slice(0, 80),
    },
  };
}

/** Doctrine: Foundry never signs the DCO, and Co-authored-by names people, never agents (docs/02). */
export function commitTrailerViolation(
  messages: string[],
  convention: DisclosureTrailer,
): string | undefined {
  const blob = messages.join("\n");
  if (/^\s*signed-off-by:/im.test(blob)) {
    return "commit range carries a Signed-off-by trailer — Foundry never signs the DCO. A human signs outside the factory, or the packet parks needs-human.";
  }
  for (const co of blob.matchAll(/^\s*co-authored-by:(.*)$/gim)) {
    if (AGENT_NAME_RE.test(co[1] ?? "")) {
      return "commit range credits an agent via Co-authored-by — Git reads that trailer as a person. Use the repo's disclosure trailer instead.";
    }
  }
  const required = commitTrailerLine(convention);
  if (required) {
    const [key, value] = required.split(": ");
    const re = new RegExp(`^\\s*${key}:\\s*${value}\\b`, "im");
    if (!re.test(blob)) {
      return `commit range is missing the repo's disclosure trailer (${required}).`;
    }
  }
  return undefined;
}
