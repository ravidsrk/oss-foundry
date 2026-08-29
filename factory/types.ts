export type Wave = 0 | 1 | 2;
export type AiPolicy =
  | "owner"
  | "welcome"
  | "human-required"
  | "unknown"
  | "forbidden";

export type PacketClass =
  | "buildable"
  | "already-has-pr"
  | "needs-human"
  | "externally-resolved"
  | "out-of-scope"
  | "policy-denied";

export type Station =
  | "scout"
  | "policy"
  | "freeze"
  | "implement"
  | "review"
  | "draft"
  | "follow-up"
  | "terminal";

export type PacketStatus =
  | "scouted"
  | "gated"
  /**
   * Reserved, never written. `applyApprove` accepts it as a source status and `INFLIGHT_STATUSES`
   * counts it, but no code path sets it — packets go `gated` → `approved` on the operator's attest.
   * It is kept so a future explicit freeze step (separating "the human has read it" from "the human
   * has attested it") lands without a state migration. In a committed ledger it means a hand edit.
   * See docs/04-stations.md §3 (issue #44 item 1).
   */
  | "frozen"
  | "approved"
  | "implementing"
  | "reviewing"
  | "draft-ready"
  | "submitted"
  | "followed-up"
  | "merged"
  | "parked"
  | "rejected";

/**
 * The statuses that occupy the one in-flight slot. docs/PRODUCT.md, "Packet statuses": "`hasInflight`
 * gates: `gated`, `frozen`, `approved`, `implementing`, `reviewing`, `draft-ready`, **`submitted`**.
 * `followed-up` is **not** in-flight." `followed-up` is deliberately absent: the slot releases once
 * threads are answered and the PR goes quiet.
 *
 * The list lives here rather than in `engine.ts` because `state.ts` needs the same set when it loads
 * a ledger, and it needs a *different predicate* over it: `engine.ts`'s `hasInflight` asks "is the
 * slot full?" — `inflightCount(packets) >= CAPS.in_flight` — while the loader asks "is this file
 * over the cap?" — `> CAPS.in_flight`, because a ledger sitting exactly at the cap is legal and must
 * still load. Different questions, so `hasInflight` was not reusable; the reusable piece is the
 * count. Reading `CAPS` is not what divides them — `state.ts` imports it directly.
 */
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

/** Every Foundry packet is independently reviewed. The historical `dark-eligible` value is not representable. */
export type Lighting = "lit";

export type SandboxKind = "host" | "e2b" | "daytona";

export interface AllowlistedRepo {
  id: string;
  owner: string;
  name: string;
  wave: Wave;
  language: string;
  aiPolicy: AiPolicy;
  policyNotes: string;
  testCommand: string;
  maxFiles: number;
  maxDiffLines: number;
  sandbox: SandboxKind;
  /** Optional environment step the witness runs after clone/checkout and again after the between-runs clean (e.g. `npm ci`). */
  setupCommand?: string;
  /** Commit-disclosure convention the target follows: kernel-style Assisted-by, ASF-style Generated-by, or PR-body prose only (default). */
  disclosureTrailer: "assisted-by" | "generated-by" | "pr-body-only";
  contributingUrl?: string;
  agentsMdUrl?: string;
  preferredLabels: string[];
  firstIssues: { number: number; title: string; url: string }[];
}

/** A parsed, quoted, dated record of what a repo's own docs say about AI contributions (policy-records.json). Evidence, not override. */
export interface PolicyRecord {
  repoId: string;
  source: string;
  url: string;
  fetchedAt: string;
  stance: "forbidden" | "conditional" | "welcome" | "silent";
  conditions: string[];
  quote: string;
}

export interface PolicyVerdict {
  allow: boolean;
  code:
    | "ALLOW"
    | "DENY_FORBIDDEN"
    | "DENY_UNKNOWN_POLICY"
    | "HOLD_CLA"
    | "HOLD_HUMAN"
    | "HOLD_SCOPE";
  reasons: string[];
  matchedPhrases: string[];
  record?: PolicyRecord;
}

/**
 * One document the gate actually read, kept on the packet so the human freeze can confirm the
 * verdict against the maintainer's own words instead of a boolean.
 *
 * `buildPacket` used to forward `agentsMd` / `contributing` into `evaluatePolicy` and then drop
 * them, which left the mandatory freeze (docs/04-stations.md §3) blind to the very text the
 * scanner parsed — and the scanner is a high-recall suggester with a known miss mode, not an
 * arbiter (issue #37). Catching a miss then meant going and reading the repo out of band, which is
 * exactly the diligence the tool claims to systematize.
 *
 * `chars` is the size of the document as fetched, `excerpt` is what the ledger keeps of it: a
 * truncated record still states the true size, so a short excerpt can never be misread as a short
 * document.
 */
export interface PolicyDocSource {
  /** The document as the fetcher named it: `AGENTS.md` or `CONTRIBUTING`. */
  name: string;
  /** Length of the fetched text in characters, BEFORE truncation. */
  chars: number;
  /** The head of the fetched text, capped at `POLICY_DOC_EXCERPT_LIMIT`. */
  excerpt: string;
  /** True exactly when `excerpt` is shorter than the document `chars` describes. */
  truncated: boolean;
}

export interface ScoutScore {
  total: number;
  parts: {
    wave: number;
    labels: number;
    size: number;
    freshness: number;
  };
}

export interface FollowUpEntry {
  id: string;
  at: string;
  kind: "review-reply" | "bot-reconcile" | "quiet" | "ci" | "note";
  body: string;
  url?: string;
}

export interface PrMeta {
  url: string;
  title: string;
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  mergeable: string;
  commits: number;
  reviewComments: number;
  issueComments: number;
  headSha: string;
  updatedAt: string;
  syncedAt: string;
}

export interface TaskPacket {
  id: string;
  repoId: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  objective: string;
  nonGoals: string[];
  acceptance: string[];
  abort: string[];
  class: PacketClass;
  status: PacketStatus;
  station: Station;
  lighting: Lighting;
  policy: PolicyVerdict;
  /**
   * The fetched documents the verdict was computed from. Absent when nothing was fetched — which
   * is a different fact from a document that was fetched and came back empty (`chars: 0`), and the
   * freeze displays the two differently.
   */
  policyDocs?: PolicyDocSource[];
  scout: ScoutScore;
  createdAt: string;
  updatedAt: string;
  humanAttest?: { by: string; at: string; note: string };
  evidence?: EvidenceManifest;
  prBody?: string;
  prUrl?: string;
  prMeta?: PrMeta;
  followUps?: FollowUpEntry[];
  parkReason?: string;
  sandboxSession?: SandboxSession;
}

/**
 * Machine-executed proof: the sandbox ran the tests and the revert control itself. Attested exits
 * are history; witnessed exits are the bar. A witness also names its **subject** (`repoId`,
 * `baseSha`, `headSha`) and where its two run logs were persisted, so an ingested witness cannot
 * be re-pointed at a different packet or range and the log hashes stay recomputable from disk.
 */
export interface EvidenceWitness {
  provider: "host" | "e2b" | "daytona";
  testExit: number;
  revertExit: number;
  testLogSha: string;
  revertLogSha: string;
  ranAt: string;
  /** The packet's repo this witness was produced for. The gate refuses a witness bound elsewhere. */
  repoId: string;
  /** The commit range this witness was produced for; must equal the manifest's own range. */
  baseSha: string;
  headSha: string;
  /** Repo-root-relative paths to the persisted run logs the two sha256s hash. */
  testLogPath: string;
  revertLogPath: string;
  /**
   * What the `testCommand` actually resolved to on the machine that ran it — `"python3 3.14.7"`.
   *
   * Advisory, never a gate. It is absent on every witness produced before issue #41 and on any run
   * whose tools reported no version, and an absent toolchain must not stop a packet: the claim it
   * supports is "here is which interpreter produced this exit 0", not "this run is legitimate".
   * The gate's job is provenance and subject binding; this is for the reader.
   */
  toolchain?: string;
}

export interface EvidenceManifest {
  baseSha: string;
  headSha: string;
  reviewedSha?: string;
  testCommand: string;
  testExit: number;
  negativeControl: "red-on-revert" | "pending" | "failed";
  filesChanged: number;
  diffLines: number;
  notes: string[];
  /** True only after a repo commit lookup succeeded for base and head. */
  shaVerified?: boolean;
  witness?: EvidenceWitness;
}

export interface SandboxSession {
  provider: SandboxKind;
  id: string;
  status: "dry-run" | "booting" | "ready" | "executing" | "harvested" | "destroyed";
  image: string;
  commands: { cmd: string; exit: number; at: string }[];
}

export interface ScorecardRow {
  repoId: string;
  opened: number;
  merged: number;
  closedUnmerged: number;
  /** Mean human (non-bot) review comments over PRs that received ≥1 human review comment. */
  reviewCommentsAvg: number;
  /** Opened drafts that reached a terminal state with zero human review activity. */
  noReview: number;
  /** Explicit `git revert` of our merge commit (or maintainer-stated rollback naming the PR) within 30 days. Post-merge rework is not a revert. */
  reverts: number;
  maintainerTone: "warm" | "neutral" | "cold" | "banned";
  lastTouch: string;
}

export interface FactoryEvent {
  id: string;
  at: string;
  kind:
    | "tick"
    | "gate"
    | "freeze"
    | "approve"
    | "reject"
    | "review"
    | "draft"
    | "sandbox"
    | "score"
    | "scout"
    | "follow-up";
  packetId?: string;
  message: string;
}

/**
 * A durable stop on the whole factory. SPEC.md §6: a platform secondary rate limit MUST halt the
 * factory, never retry — so the stop lives in the ledger, not in a console line that dies with the
 * process. It carries no expiry on purpose: only a human clears it (`clear-halt`).
 */
export interface FactoryHalt {
  at: string;
  reason: string;
  /** Where the halt came from, so the ledger can tell a throttle apart from a maintainer ask. */
  source: "secondary-rate-limit";
  repoId?: string;
}

export interface FactoryState {
  version: 6;
  packets: TaskPacket[];
  events: FactoryEvent[];
  scorecard: ScorecardRow[];
  ticksRun: number;
  lastTickAt: string | null;
  mergedTotal: number;
  bans: number;
  humanApprovalsRemaining: number;
  halt?: FactoryHalt;
}
