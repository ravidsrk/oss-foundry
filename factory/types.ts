export type Wave = 0 | 1 | 2;
export type AiPolicy =
  | "owner"
  | "welcome"
  | "undocumented-open"
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

export type Lighting = "lit" | "dark-eligible";

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
  contributingUrl?: string;
  agentsMdUrl?: string;
  preferredLabels: string[];
  firstIssues: { number: number; title: string; url: string }[];
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
}

export interface ScoutScore {
  total: number;
  parts: {
    wave: number;
    labels: number;
    size: number;
    freshness: number;
    grok?: number;
  };
  grokRationale?: string;
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
  /** Drafts we opened. Volume only; not the merge-rate denominator. */
  opened: number;
  merged: number;
  /** Terminal unmerged drafts, including stale-closed after 14 quiet days. */
  closedUnmerged: number;
  /** Subset of closedUnmerged: auto-closed after STALE_QUIET_DAYS with no human activity. */
  staleClosed: number;
  /**
   * Mean human (non-bot) review comments over `humanReviewed` PRs only.
   * Do not average in silent/no-review PRs.
   */
  reviewCommentsAvg: number;
  /** Opened drafts with ≥1 human, non-bot review comment. Denominator for reviewCommentsAvg. */
  humanReviewed: number;
  /** Opened drafts with 0 human, non-bot review comments (bot-only counts as no-review). */
  noReview: number;
  /**
   * Explicit `git revert` of our merge commit, or a maintainer-stated rollback
   * that names the PR, within REVERT_WINDOW_DAYS of merge. Rework is not a revert.
   */
  reverts: number;
  /** Post-merge edits/refactors of our code. Informational; does not halt. */
  rework: number;
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
