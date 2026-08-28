import { isDenied, repoById } from "./allowlist.ts";
import { policyRecordFor } from "./policy-records.ts";
import type { PolicyRecord, PolicyVerdict } from "./types.ts";

/**
 * The gate matches policy STATEMENTS, not topic words. A repo whose docs merely
 * discuss autonomous agents is not banning them; a ban pairs an AI subject with a
 * contribution object and a refusal verdict inside one sentence-sized window.
 */
// Word-boundaried subjects: bare "ai"/"bot" must never match inside maintain/explain/robot.
const SUBJECT = String.raw`(?:\bai\b|\ba\.i\.|\bllms?\b|\bautonomous\b|\bmachine[- ]generated\b|\bbots?\b|\bagents?\b|\bcopilot\b|\bgenerative\b)`;
const OBJECT = String.raw`(?:\bcontribut\w*|\bpull[- ]requests?\b|\bprs?\b|\bpatch\w*|\bsubmission\w*|\bcode\b|\bcontent\b|\bissues?\b|\bcomment\w*)`;
const VERDICT = String.raw`(?:not\s+(?:allowed|welcome|accepted|permitted)|unacceptable|prohibited|banned|forbidden|declin\w*|reject\w*|will\s+be\s+closed|are\s+closed)`;
// Sentence-sized window that a real period ends — but abbreviation dots (e.g., i.e., etc.) do not.
const W = String.raw`(?:e\.g\.|i\.e\.|etc\.|[^.\n]){0,90}`;

const FORBIDDEN_STATEMENTS: RegExp[] = [
  new RegExp(`${SUBJECT}${W}${OBJECT}${W}${VERDICT}`, "i"),
  new RegExp(`${OBJECT}${W}${SUBJECT}${W}${VERDICT}`, "i"),
  new RegExp(`${VERDICT}${W}${OBJECT}${W}${SUBJECT}`, "i"),
  new RegExp(`${VERDICT}${W}${SUBJECT}${W}${OBJECT}`, "i"),
  /no\s+ai[- ]generated\s+(?:code|prs?|pull[- ]requests?|contributions?|content)/i,
  /do\s+not\s+(?:submit|open|send)\s+(?:ai|llms?|bots?|agents?|machine[- ]generated)\b/i,
  // Active-voice refusals: "we do not accept contributions written by LLMs",
  // "does not accept machine-generated patches".
  new RegExp(String.raw`\b(?:do(?:es)?\s+not|don['’]t|never)\s+accept[^.\n]{0,60}${SUBJECT}`, "i"),
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

/**
 * A CLA/DCO keyword says the topic appears; it does not say the repo requires one. "No CLA. No
 * DCO." is a repo *waiving* the requirement, and reading it as "this is required" parks a
 * legitimate packet. Negation is read inside the matched sentence only — and a sentence that
 * still asserts the requirement ("without a signed CLA will be closed") keeps its hold.
 *
 * Only an UNCONDITIONAL waiver is a waiver. A scoped one ("not required for documentation
 * changes"), a benefit denial ("No DCO, no merge."), and a denied escape hatch ("there is no DCO
 * bypass") all keep the hold: the gate cannot evaluate a scope, and reading any of them as a
 * waiver is fail-open on a hard constraint.
 */
const NEG_DETERMINER =
  /\b(?:no|without)\s+(?:(?:a|an|any|the|signed|separate|explicit|formal)\s+)*$/i;
const NEG_VERB =
  /\b(?:don['’]t|do(?:es)?\s+not|never)\s+(?:require|need|ask\s+for)\w*\s+(?:(?:a|an|any|the|signed|separate|explicit|formal)\s+)*$/i;
// One filler word only ("DCO sign-off is not required"), so the waiver cannot jump into the next
// clause of a sentence that is still asserting the requirement.
const NOT_REQUIRED_AFTER =
  /^\W*(?:[\w-]+\s+)?(?:is|are|was|were)?\s*(?:not|isn['’]t|aren['’]t)\s+(?:required|needed|necessary|mandatory)\b/i;
const REQUIREMENT_WORD = /\b(?:required|needed|necessary|mandatory)\b/i;
/**
 * Anything in the sentence that still asserts the requirement, so a bare "without" is not a
 * waiver. `merge\w*` is here because "No DCO, no merge." denies the *benefit*, which asserts the
 * requirement; the escape-hatch nouns (`bypass`, `exception`, `waiver`, …) are here because
 * "There is no DCO bypass." negates the escape, not the rule.
 */
const ASSERTS_REQUIREMENT =
  /\b(?:require\w*|mandator\w*|must|need\w*|sign\w*|closed|reject\w*|cannot|can['’]t|won['’]t|merge\w*|bypass\w*|exception\w*|exempt\w*|waiver\w*|workaround\w*|opt[- ]?outs?|skip\w*)\b/i;
/**
 * The "no X, no Y" idiom denies a benefit in exchange for the missing X — "No DCO, no merge." is
 * the requirement stated backwards. Y must be a benefit: "No CLA, no DCO." is two waivers, not
 * this idiom, so the benefit list never contains a policy artefact.
 */
const NO_X_NO_BENEFIT =
  /\bno\s+[\w.'’-]+\s*,\s*no\s+(?:merg\w*|review\w*|pull[- ]request\w*|prs?\b|ship\w*|releas\w*|land\w*|entry|deal|service|support)/i;
/**
 * A waiver that names a scope waives the requirement *for that scope only*. The gate has no notion
 * of change class, contributor class, or diff size, so it cannot tell whether this packet falls
 * inside the exemption — the only safe reading is that a qualified waiver is not a waiver.
 */
const QUALIFIER_CONNECTIVE =
  /\b(?:unless|except|other\s+than|besides|save\s+for|provided(?:\s+that)?|as\s+long\s+as|so\s+long\s+as|if|when(?:ever)?|while|only)\b/i;
/** Every "for …" / "on …" object in the sentence; a narrowing one makes the waiver conditional. */
const SCOPING_PREPOSITION = /\b(?:for|on)\s+([^.;\n]*)/gi;
/**
 * The objects that denote the project as a whole, so "not required for this project" and "we
 * don't require a DCO on contributions" stay unconditional waivers. The object must END the
 * clause: "for contributors from partner orgs" is narrowing even though it starts with a
 * universal noun.
 */
const UNIVERSAL_SCOPE =
  /^(?:(?:this|our|the)\s+(?:project|repo|repository|codebase|org|organi[sz]ation)|contributions?|contributors?|any(?:one|body)|everyone|us|all)\s*(?:[.,;)]|$)/i;

/** True when the sentence waives only inside a named scope, which this gate cannot evaluate. */
function isQualified(sentence: string): boolean {
  if (QUALIFIER_CONNECTIVE.test(sentence)) return true;
  for (const m of sentence.matchAll(SCOPING_PREPOSITION)) {
    if (!UNIVERSAL_SCOPE.test((m[1] ?? "").trim())) return true;
  }
  return false;
}

/**
 * The sentence-sized slice holding `index`, and where the match starts inside it.
 *
 * `,` is deliberately NOT a delimiter. Narrowing the window is the fail-open direction: it would
 * cut "no merge" out of "No DCO, no merge." and hand the idiom back its waiver. Comma clauses that
 * genuinely waive ("you must sign the CLA, but no DCO is needed") are already handled by reading
 * the negation next to the match rather than anywhere in the window.
 */
function sentenceAround(text: string, index: number, length: number) {
  let start = index;
  while (start > 0 && !/[.;\n]/.test(text[start - 1]!)) start--;
  let end = index + length;
  while (end < text.length && !/[.;\n]/.test(text[end]!)) end++;
  return { sentence: text.slice(start, end), at: index - start };
}

function isWaived(text: string, index: number, length: number): boolean {
  const { sentence, at } = sentenceAround(text, index, length);
  const before = sentence.slice(0, at);
  const fromMatch = sentence.slice(at);
  const after = sentence.slice(at + length);
  // These two gate EVERY waiver path, including "we don't require …": a false hold costs an
  // operator one look, a false allow ships a patch into a repo that forbids it.
  if (isQualified(sentence)) return false;
  if (NO_X_NO_BENEFIT.test(sentence)) return false;
  // "we don't require a DCO" / "a CLA is not required"
  if (NEG_VERB.test(before) || NOT_REQUIRED_AFTER.test(after)) return true;
  if (!NEG_DETERMINER.test(before)) return false;
  // "no CLA required" — the negation and the requirement word are one idiom.
  if (REQUIREMENT_WORD.test(fromMatch)) return true;
  // "No CLA." — a bare absence, only when the sentence asserts nothing to the contrary.
  return !ASSERTS_REQUIREMENT.test(sentence);
}

function quoteOf(match: RegExpExecArray): string {
  return match[0].replace(/\s+/g, " ").trim().slice(0, 160);
}

/** First hit of `re` in `text` that the surrounding sentence does not waive. */
function firstUnwaived(re: RegExp, text: string): RegExpExecArray | undefined {
  const scan = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = scan.exec(text)) !== null) {
    if (m[0].length === 0) break;
    if (!isWaived(text, m.index, m[0].length)) return m;
  }
  return undefined;
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
    const m = firstUnwaived(re, text);
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

export function evaluatePolicy(
  input: {
    repoId: string;
    agentsMd?: string;
    contributing?: string;
    issueTitle?: string;
    filesHint?: number;
    diffHint?: number;
  },
  record: PolicyRecord | undefined = policyRecordFor(input.repoId),
): PolicyVerdict {
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
        "AI policy is unknown. Fetch AGENTS.md / CONTRIBUTING (or commit an affirmative policy record) and re-run the gate before freeze.",
      ],
      matchedPhrases: [],
      record,
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
