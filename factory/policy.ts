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

/**
 * A human gate that is NOT a signature: someone must look, but nobody signs anything.
 * Kept separate from the signature families below so the verdict code comes from WHICH roster
 * matched, rather than from substring-testing the matched text afterwards.
 */
const HUMAN_REVIEW_STATEMENTS: RegExp[] = [
  /human:/i,
  /\bhuman\s+(?:review\s+)?required\b/i,
  /must\s+be\s+reviewed\s+by\s+a\s+human/i,
  /\bhuman\s+attest\w*/i,
];

/**
 * The instruments a human must sign, by family. Presence is not a requirement — polarity is
 * decided per occurrence by `signaturePolarity`.
 *
 * WHY A BARE `\bcla\b` IS HERE. It was not, and that was the fail-open at the centre of issue #52.
 * The only CLA-acronym patterns were `sign(?:ing)?\s+the\s+cla` and `\bcla\s+(?:is\s+)?required\b`,
 * both defeated by an interposed "not", so five realistic "waive the DCO, assert the CLA" documents
 * held on `main` only by the ACCIDENT of an un-negated `\bdco\b` elsewhere in the sentence —
 * measured, every one of them reporting `human=["DCO"]` and nothing about the CLA. Make the DCO
 * negation-aware without adding this token and all five fail open.
 *
 * `contributor\s+agreement` is separate from `contributor\s+licen[cs]e\s+agreement` because the
 * short form is common and was unmatched. Neither is a bare `/agreement/i`: "you signal your
 * agreement with the Code of Conduct" must not read as a CLA, which is the over-block direction.
 *
 * `signed[-\s]?off[-\s]?by` and `sign[-\s]?off` sit in the DCO family because that is what they
 * are. On `main` "All commits must carry a Signed-off-by line." reached ALLOW with EMPTY matched
 * phrases — a real signature requirement the scanner could not see at all.
 */
const SIGNATURE_FAMILIES: { family: string; token: string }[] = [
  /**
   * The acronyms are PLURAL-TOLERANT, and that was a P1 fail-open in the first version of this
   * change: `\bcla\b` does not match `CLAs`, so "No DCO. CLAs are mandatory." waived the DCO, saw
   * nothing about the CLA, and reached ALLOW for a repository that demands a signature — the exact
   * defect this issue exists to close, reintroduced in its own fix in a new spelling. Measured:
   * "CLAs are required for all contributors." and "We require DCOs on every commit." were both
   * SILENT, matching nothing at all.
   *
   * `\bclas?\b` cannot match "class": the optional `s` still needs a word boundary after it, and
   * "class" has another letter there. The spelled-out forms already matched inside their own plurals
   * by substring; the explicit `s?` says so rather than leaving it to be rediscovered.
   */
  {
    family: "CLA",
    token: String.raw`(?:\bclas?\b|contributor\s+licen[cs]e\s+agreements?|contributor\s+agreements?)`,
  },
  {
    family: "DCO",
    token: String.raw`(?:\bdcos?\b|developer\s+certificates?\s+of\s+origin|signed[-\s]?off[-\s]?by|sign[-\s]?offs?\b)`,
  },
];

/**
 * "There is no DCO bypass" says the DCO is mandatory, not that it is waived. Checked BEFORE the
 * waivers, because it is literally a negation sitting next to the token and every waiver pattern
 * below would otherwise claim it.
 */
const ESCAPE_HATCH = String.raw`(?:bypass|exception|exemption|waiver|opt[-\s]?out|workaround|way\s+around)`;

/** Words that turn a waiver into a conditional requirement: it IS required, somewhere. */
const SCOPE_LIMITER = /\b(?:except|unless|other\s+than|apart\s+from|save\s+for)\b/i;

/**
 * There is deliberately NO "asserts a requirement" list here, and its absence is a finding rather
 * than an omission.
 *
 * One was written — the usual `required|mandatory|must|sign\w*|…` roster — and the injection pass on
 * the differential harness showed the harness could not see it being deleted. The reason is that it
 * could never decide anything: an occurrence that matches no waiver already returns `"required"` on
 * the line below, so the list and the fallback had the same answer and the list was unreachable. An
 * unreachable roster of authoritative-looking vocabulary is exactly what issue #75 is about — the
 * thing someone wires up later without re-reading.
 *
 * So the rule is one sentence: a signature instrument is WAIVED only if a waiver pattern governs it,
 * and REQUIRED otherwise. Two corpus rows pin that the fallback is `required` and not `waived`
 * ("See our CLA for details.", "We dropped the CLA requirement."), verified by flipping it.
 */

/**
 * Decide whether one occurrence of a signature token is REQUIRED or WAIVED.
 *
 * Two different spans on purpose, and getting this wrong was a fail-open in the first draft of this
 * function:
 *
 * - The WAIVER and the requirement verb are read from the CLAUSE, so two instruments in one
 *   sentence cannot borrow each other's verb. "No DCO, contributor agreement required." needs this.
 * - The SCOPE LIMITER is read from the whole SENTENCE, because "except" routinely sits in the next
 *   clause. "A CLA is not required, except for new dependencies." read the waiver and never saw the
 *   exception, so a scoped requirement came out as a blanket waiver — the exact fail-open class this
 *   issue is about, reproduced inside its own fix. Caught by probing before it shipped.
 *
 * The ORDER is the rest of the design. Every waiver pattern that can swallow a requirement word
 * does so explicitly — `no DCO is required` is one pattern, not "a negation" and "a requirement"
 * fighting over one clause. The previous attempt made the DCO negation-aware and left the CLA
 * invisible, and 8 of 10 realistic documents regressed to ALLOW.
 */
function signaturePolarity(clause: string, sentence: string, token: string): "required" | "waived" {
  const T = token;
  if (new RegExp(String.raw`\bno\s+${T}\s+${ESCAPE_HATCH}`, "i").test(clause)) return "required";
  const waivers = [
    String.raw`\bno\s+${T}\s+(?:is\s+|are\s+)?(?:required|needed|necessary|expected)\b`,
    String.raw`${T}\s*:?\s*(?:is\s+|are\s+)?not\s+(?:required|needed|necessary|expected)\b`,
    // The filler is bounded and stops at any clause break, so it cannot reach across a comma or a
    // full stop to borrow a waiver from a neighbouring clause. It exists because "do not need TO
    // SIGN a contributor license agreement" puts an infinitive between the verb and the token — a
    // shape the corpus caught and the first draft of this list missed.
    String.raw`\b(?:do(?:es)?\s+not|don['’]t|doesn['’]t|will\s+not|won['’]t)\s+(?:require|need|ask\s+for|expect)\b[^.;,\n]{0,25}?${T}`,
    String.raw`\bthere\s+(?:is|are)\s+no\s+${T}`,
    String.raw`\bno\s+${T}\b`,
  ];
  for (const w of waivers) {
    if (!new RegExp(w, "i").test(clause)) continue;
    // A scoped waiver is a requirement wearing a waiver's clothes: "not required EXCEPT for new
    // dependencies" means a packet touching one needs it. Read from the sentence, not the clause.
    return SCOPE_LIMITER.test(sentence) ? "required" : "waived";
  }
  /**
   * Undecided reads as REQUIRED, which is the repo's stated asymmetry rather than a shrug: a false
   * hold costs the operator one look, a false allow opens a draft into a repository that demands a
   * signature, and `docs/PRODUCT.md` §3 constraint 4 is "Never forge CLA/DCO". A bare "see our CLA"
   * with no verb is exactly the case where the tool should make a human decide.
   */
  return "required";
}

/**
 * A sentence boundary is a terminator followed by whitespace and something that starts a sentence.
 *
 * Requiring the capital (or an opening quote/bracket) is what keeps `e.g.` and `i.e.` from ending a
 * sentence mid-clause — the same hazard the `W` window above spells out abbreviation by
 * abbreviation. A newline also ends one, because policy documents are markdown and a list item is a
 * sentence whether or not it carries a full stop.
 */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Clause-sized spans, so two instruments in one sentence are judged separately.
 *
 * "No DCO, contributor agreement required." is the case that makes this necessary: one sentence
 * holding a waiver and a requirement. Splitting on the comma is what lets the DCO read as waived and
 * the contributor agreement as required, instead of one borrowing the other's verb. A code comment
 * in the previous attempt claimed a `NEG_FILLER` regex handled the comma and nothing tested it;
 * this is the same guarantee made structural.
 */
function clausesOf(sentence: string): string[] {
  return sentence
    .split(/[,;]|\bbut\b|\bhowever\b/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

function quoteOf(match: RegExpExecArray): string {
  return match[0].replace(/\s+/g, " ").trim().slice(0, 160);
}

export function scanPolicyText(text: string): {
  forbidden: string[];
  human: string[];
  /** Signature phrases the document ASSERTS. Non-empty is what makes a verdict HOLD_CLA. */
  signatureRequired: string[];
  /** Signature phrases the document WAIVES, kept so a freeze can show what was read and dismissed. */
  signatureWaived: string[];
} {
  const forbidden: string[] = [];
  const humanReview: string[] = [];
  const signatureRequired: string[] = [];
  const signatureWaived: string[] = [];
  for (const re of FORBIDDEN_STATEMENTS) {
    const m = re.exec(text);
    if (m) forbidden.push(quoteOf(m));
  }
  for (const re of HUMAN_REVIEW_STATEMENTS) {
    const m = re.exec(text);
    if (m) humanReview.push(quoteOf(m));
  }
  for (const sentence of sentencesOf(text)) {
    for (const clause of clausesOf(sentence)) {
      for (const { family, token } of SIGNATURE_FAMILIES) {
        if (!new RegExp(token, "i").test(clause)) continue;
        const quote = `${family}: ${clause.replace(/\s+/g, " ").trim().slice(0, 140)}`;
        if (signaturePolarity(clause, sentence, token) === "required") signatureRequired.push(quote);
        else signatureWaived.push(quote);
      }
    }
  }
  return {
    forbidden: [...new Set(forbidden)],
    // A WAIVED signature is deliberately absent: a document that says "No CLA. No DCO." must not
    // park the packet, which is the over-block half of issue #52 and the live Wave-1 seed text.
    human: [...new Set([...humanReview, ...signatureRequired])],
    signatureRequired: [...new Set(signatureRequired)],
    signatureWaived: [...new Set(signatureWaived)],
  };
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
    // The code comes from WHICH roster matched, not from substring-testing the matched text. The
    // old test asked whether the phrase contained "cla", "dco" or "certificate", which is why
    // "Contributor License Agreement" — the phrasing most likely to appear in a real
    // CONTRIBUTING.md — landed in HOLD_HUMAN: the letters c, l, a never appear consecutively in it.
    if (scanned.signatureRequired.length > 0) {
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
    // Second of the two call sites that re-derived this. One source now, for the reason
    // fixture-counts.ts gives about two copies of one rule.
    const cla = scanned.signatureRequired.length > 0;
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
