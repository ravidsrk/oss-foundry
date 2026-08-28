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

/** Machine-executed proof: the sandbox ran the tests and the revert control itself. Attested exits are history; witnessed exits are the bar. */
export interface EvidenceWitness {
  provider: "host" | "e2b";
  testExit: number;
  revertExit: number;
  testLogSha: string;
  revertLogSha: string;
  ranAt: string;
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
}
