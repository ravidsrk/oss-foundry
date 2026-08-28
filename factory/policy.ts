import { isDenied, repoById } from "./allowlist.ts";
import { policyRecordFor } from "./policy-records.ts";
import type { PolicyRecord, PolicyVerdict } from "./types.ts";

/**
 * The gate matches policy STATEMENTS, not topic words. A repo whose docs merely
 * discuss autonomous agents is not banning them; a ban pairs an AI subject with a
 * contribution object and a refusal verdict inside one sentence-sized window.
 */
const SUBJECT = String.raw`(?:ai|a\.i\.|llm|autonomous|machine[- ]generated|bot|agent|copilot|generative)`;
const OBJECT = String.raw`(?:contribut\w*|pull[- ]requests?|\bprs?\b|patch\w*|submission\w*|code|content|issues?|comment\w*)`;
const VERDICT = String.raw`(?:not\s+(?:allowed|welcome|accepted|permitted)|unacceptable|prohibited|banned|forbidden|declin\w*|reject\w*|will\s+be\s+closed|are\s+closed)`;
const W = String.raw`[^.\n]{0,90}`;

const FORBIDDEN_STATEMENTS: RegExp[] = [
  new RegExp(`${SUBJECT}${W}${OBJECT}${W}${VERDICT}`, "i"),
  new RegExp(`${OBJECT}${W}${SUBJECT}${W}${VERDICT}`, "i"),
  new RegExp(`${VERDICT}${W}${OBJECT}${W}${SUBJECT}`, "i"),
  new RegExp(`${VERDICT}${W}${SUBJECT}${W}${OBJECT}`, "i"),
  /no\s+ai[- ]generated\s+(?:code|prs?|pull[- ]requests?|contributions?|content)/i,
  /do\s+not\s+(?:submit|open|send)\s+(?:ai|llm|bot|agent|machine[- ]generated)/i,
  /autonomous\s+agents?\s+(?:are\s+)?not\s+(?:allowed|welcome|permitted)/i,
];

const HUMAN_STATEMENTS: RegExp[] = [
  /human:/i,
  /\bhuman\s+(?:review\s+)?required\b/i,
  /must\s+be\s+reviewed\s+by\s+a\s+human/i,
  /\bhuman\s+attest\w*/i,
  /\bdco\b/i,
  /developer\s+certificate\s+of\s+origin/i,
  /sign(?:ing)?\s+the\s+cla/i,
  /\bcla\s+(?:is\s+)?required\b/i,
  /contributor\s+license\s+agreement/i,
];

function quoteOf(match: RegExpExecArray): string {
  return match[0].replace(/\s+/g, " ").trim().slice(0, 160);
}

export function scanPolicyText(text: string): {
  forbidden: string[];
  human: string[];
} {
  const forbidden: string[] = [];
  const human: string[] = [];
  for (const re of FORBIDDEN_STATEMENTS) {
    const m = re.exec(text);
    if (m) forbidden.push(quoteOf(m));
  }
  for (const re of HUMAN_STATEMENTS) {
    const m = re.exec(text);
    if (m) human.push(quoteOf(m));
  }
  return { forbidden: [...new Set(forbidden)], human: [...new Set(human)] };
}

function holdFromConditions(record: PolicyRecord): PolicyVerdict | undefined {
  const conditions = record.conditions.map((c) => c.toLowerCase());
  if (conditions.some((c) => c.includes("cla") || c.includes("dco"))) {
    return {
      allow: false,
      code: "HOLD_CLA",
      reasons: [
        `Policy record (${record.source} @ ${record.fetchedAt}): CLA/DCO needs a human signature. Park needs-human. Never forge.`,
      ],
      matchedPhrases: [record.quote],
      record,
    };
  }
  if (conditions.length > 0) {
    return {
      allow: false,
      code: "HOLD_HUMAN",
      reasons: [
        `Policy record (${record.source} @ ${record.fetchedAt}): ${record.conditions.join(", ")} — a human clears this gate.`,
      ],
      matchedPhrases: [record.quote],
      record,
    };
  }
  return undefined;
}

export function evaluatePolicy(input: {
  repoId: string;
  agentsMd?: string;
  contributing?: string;
  issueTitle?: string;
  filesHint?: number;
  diffHint?: number;
}): PolicyVerdict {
  const denied = isDenied(input.repoId);
  if (denied) {
    return {
      allow: false,
      code: "DENY_FORBIDDEN",
      reasons: [denied.reason],
      matchedPhrases: [],
    };
  }

  const repo = repoById(input.repoId);
  if (!repo) {
    return {
      allow: false,
      code: "DENY_UNKNOWN_POLICY",
      reasons: [`${input.repoId} is not on the allowlist.`],
      matchedPhrases: [],
    };
  }

  const record = policyRecordFor(input.repoId);
  if (record?.stance === "forbidden") {
    return {
      allow: false,
      code: "DENY_FORBIDDEN",
      reasons: [`Policy record (${record.source} @ ${record.fetchedAt}) forbids AI contributions.`],
      matchedPhrases: [record.quote],
      record,
    };
  }

  const blob = `${input.agentsMd ?? ""}\n${input.contributing ?? ""}\n${repo.policyNotes}`;
  const scanned = scanPolicyText(blob);

  if (scanned.forbidden.length > 0 || repo.aiPolicy === "forbidden") {
    return {
      allow: false,
      code: "DENY_FORBIDDEN",
      reasons: ["Repo policy forbids autonomous or AI-generated PRs."],
      matchedPhrases: scanned.forbidden,
      record,
    };
  }

  if (record?.stance === "conditional") {
    const scannedCla = scanned.human.some((p) => {
      const lower = p.toLowerCase();
      return lower.includes("cla") || lower.includes("dco") || lower.includes("certificate");
    });
    if (scannedCla) {
      return {
        allow: false,
        code: "HOLD_CLA",
        reasons: ["CLA/DCO requires a human signature. Park needs-human. Never forge."],
        matchedPhrases: [...scanned.human, record.quote],
        record,
      };
    }
    const hold = holdFromConditions(record);
    if (hold) return hold;
  }

  // A silent record ("parsed, no AI language found") does not excuse a live fetch for an
  // unknown repo — absence must be re-verified. Affirmative records (welcome/conditional/
  // forbidden) carry a quoted statement and do satisfy parse-policy-first.
  const hasParsedEvidence = Boolean(
    input.agentsMd || input.contributing || (record && record.stance !== "silent"),
  );
  if (repo.aiPolicy === "unknown" && !hasParsedEvidence) {
    return {
      allow: false,
      code: "DENY_UNKNOWN_POLICY",
      reasons: [
        "AI policy is unknown. Fetch AGENTS.md / CONTRIBUTING (or commit a policy record) and re-run the gate before freeze.",
      ],
      matchedPhrases: [],
    };
  }

  const reasons: string[] = [];
  const matched = [...scanned.human];

  if (repo.aiPolicy === "human-required" || scanned.human.length > 0) {
    const cla = scanned.human.some((p) => {
      const lower = p.toLowerCase();
      return lower.includes("cla") || lower.includes("dco") || lower.includes("certificate");
    });
    return {
      allow: false,
      code: cla ? "HOLD_CLA" : "HOLD_HUMAN",
      reasons: [
        cla
          ? "CLA/DCO requires a human signature. Park needs-human. Never forge."
          : "Policy requires a human attest before any PR is opened.",
      ],
      matchedPhrases: matched,
      record,
    };
  }

  if (typeof input.filesHint === "number" && input.filesHint > repo.maxFiles) {
    return {
      allow: false,
      code: "HOLD_SCOPE",
      reasons: [`Packet would touch ${input.filesHint} files; cap is ${repo.maxFiles}.`],
      matchedPhrases: [],
      record,
    };
  }

  if (typeof input.diffHint === "number" && input.diffHint > repo.maxDiffLines) {
    return {
      allow: false,
      code: "HOLD_SCOPE",
      reasons: [`Diff ${input.diffHint} lines exceeds cap ${repo.maxDiffLines}.`],
      matchedPhrases: [],
      record,
    };
  }

  if (/rfc|tracking|meta|epic/i.test(input.issueTitle ?? "")) {
    return {
      allow: false,
      code: "HOLD_SCOPE",
      reasons: ["Issue looks like RFC/meta/tracking — out of scope for the factory."],
      matchedPhrases: [],
      record,
    };
  }

  reasons.push("Allowlisted, policy parsed, scope inside caps.");
  if (record) {
    reasons.push(`Policy record: ${record.stance} (${record.source} @ ${record.fetchedAt}).`);
  }
  return { allow: true, code: "ALLOW", reasons, matchedPhrases: matched, record };
}

export function policyLabel(code: PolicyVerdict["code"]): string {
  switch (code) {
    case "ALLOW":
      return "Allow";
    case "DENY_FORBIDDEN":
      return "Denied · forbidden";
    case "DENY_UNKNOWN_POLICY":
      return "Denied · unknown policy";
    case "HOLD_CLA":
      return "Hold · CLA/DCO";
    case "HOLD_HUMAN":
      return "Hold · human";
    case "HOLD_SCOPE":
      return "Hold · scope";
  }
}
