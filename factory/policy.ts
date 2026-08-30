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

/** A human gate that is NOT a signature: someone looks, nobody signs. Separate roster so the
 * verdict code comes from WHICH roster matched, not from substring-testing the matched text. */
const HUMAN_REVIEW_STATEMENTS: RegExp[] = [
  /human:/i,
  /\bhuman\s+(?:review\s+)?required\b/i,
  /must\s+be\s+reviewed\s+by\s+a\s+human/i,
  /\bhuman\s+attest\w*/i,
];

/**
 * The instruments a human must sign. Presence is not a requirement — `signaturePolarity` decides.
 *
 * The bare CLA acronym is the fix for #52: without it the only CLA patterns were
 * `sign(?:ing)?\s+the\s+cla` and `\bcla\s+(?:is\s+)?required\b`, both defeated by an interposed
 * "not", so five "waive the DCO, assert the CLA" documents held on `main` only by the ACCIDENT of an
 * un-negated `\bdco\b` in the same sentence — each reporting `human=["DCO"]`, nothing about the CLA.
 *
 * Plurals are a P1 from review: `\bcla\b` misses `CLAs`, so "No DCO. CLAs are mandatory." saw
 * nothing. `\bclas?\b` cannot match "class" (the optional `s` needs a boundary), asserted by a row.
 * Not a bare `/agreement/i`: "your agreement with the Code of Conduct" is not a CLA. Sign-off
 * vocabulary is DCO family — "All commits must carry a Signed-off-by line." matched nothing at all.
 */
const SIGNATURE_FAMILIES: { family: string; token: string }[] = [
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
 * The words a requirement is asserted WITH, when its subject has been elided.
 *
 * ONE roster, because there were two and they drifted: the waiver patterns knew `expected` and this
 * did not, so "No CLA is expected for docs and expected for code." waived the whole sentence and
 * reached ALLOW — a P1 from review. A waiver and a requirement are the same vocabulary under
 * opposite polarity, so a word this factory can waive is a word it must be able to require.
 */
const PREDICATE = String.raw`(?:required|needed|necessary|expected|mandatory|obligatory|compulsory)`;

/**
 * What must follow a bare `PREDICATE` for it to be a requirement rather than a noun modifier.
 *
 * Without a copula there is no verb to anchor on, so the SCOPE anchors instead: "required for code"
 * asserts something about the instrument, "required reading is the style guide" does not. One adverb
 * may intervene, so "needed only for release" still counts.
 */
const SCOPE_FOLLOWS = String.raw`(?=\s*(?:$|[.;,]|(?:\w+\s+)?(?:for|on|in|when|with|of|from)\b))`;

/**
 * There is deliberately NO "asserts a requirement" roster. One was written, and the injection pass
 * showed the harness could not see it deleted: an occurrence matching no waiver already returns
 * `"required"`, so the list and the fallback gave the same answer and it was unreachable — the #75
 * orphan shape. The rule is one sentence: WAIVED only if a waiver governs it, REQUIRED otherwise.
 */

/**
 * Decide whether one occurrence of a signature token is REQUIRED or WAIVED.
 *
 * Two different spans on purpose, and getting this wrong was a fail-open in the first draft:
 *
 * - The WAIVER is read from the CLAUSE, so two instruments in one sentence cannot borrow each
 *   other's verb ("No DCO, contributor agreement required.").
 * - The SCOPE LIMITER is read from the waiver's own STATEMENT, which crosses the clause boundary but
 *   stops short of the whole sentence. Three wrong spans shipped for this one decision; the block at
 *   the limiter check names each and why the current one is neither too narrow nor too wide.
 *
 * The ORDER is the rest: every waiver that can swallow a requirement word does so explicitly, so
 * `no DCO is required` is one pattern rather than a negation and a requirement fighting over a
 * clause. The previous attempt negated the DCO and left the CLA invisible — 8 of 10 documents
 * regressed to ALLOW.
 */
function signaturePolarity(clause: string, clauseAt: number, sentence: string, token: string): "required" | "waived" {
  const T = token;
  if (new RegExp(String.raw`\bno\s+${T}\s+${ESCAPE_HATCH}`, "i").test(clause)) return "required";
  const waivers = [
    String.raw`\bno\s+${T}\s+(?:is\s+|are\s+)?${PREDICATE}\b`,
    String.raw`${T}\s*:?\s*(?:is\s+|are\s+)?not\s+${PREDICATE}\b`,
    // Bounded filler, stopping at any clause break so it cannot borrow a neighbour's waiver. It
    // exists because "do not need TO SIGN a contributor license agreement" puts an infinitive
    // between verb and token — a shape the corpus caught and the first draft of this list missed.
    String.raw`\b(?:do(?:es)?\s+not|don['’]t|doesn['’]t|will\s+not|won['’]t)\s+(?:require|need|ask\s+for|expect)\b[^.;,\n]{0,25}?${T}`,
    String.raw`\bthere\s+(?:is|are)\s+no\s+${T}`,
    String.raw`\bno\s+${T}\b`,
  ];
  /**
   * EVERY waiver occurrence in the clause, in the patterns' priority order. One is not enough: the
   * limiter can scope the second waiver in a single clause ("no DCO is needed for docs and no DCO is
   * needed for tests, other than vendored trees"), and deciding from the first occurrence alone cut
   * the forward span at the intervening "and" and reached a blanket waiver. Found by adversarially
   * probing the fix for the cross-clause version of exactly this, which is the shape a repo would
   * use to get ALLOW while demanding a signature.
   *
   * The patterns overlap by design, so the same text yields several spans; that costs a few
   * iterations and changes no verdict, because a limiter scoping ANY occurrence means the instrument
   * is required somewhere.
   */
  const spans: { at: number; length: number }[] = [];
  for (const w of waivers) {
    const re = new RegExp(w, "gi");
    for (let m = re.exec(clause); m; m = re.exec(clause)) spans.push({ at: m.index, length: m[0].length });
  }
  if (spans.length > 0) {
    /**
     * A scoped waiver is a requirement in a waiver's clothes. The limiter must belong to THIS
     * waiver, and both wrong spans shipped here: the CLAUSE missed "A CLA is not required, except
     * for new dependencies." (fail-open), the whole SENTENCE reclassified "No CLA is required, and
     * all patches are welcome except spam", where the except is about spam (fail-closed, parking a
     * packet that waives the CLA outright — P1 from review). So the span is the waiver's own
     * statement: its clause, what follows up to the first coordinating conjunction, and a leading
     * "Except for X, ..." it is the main clause of.
     *
     * The position is the clause's offset plus the match's offset inside it. Asking the SENTENCE
     * where the matched text is answers with the first copy, so a repeated waiver measured the later
     * one from the earlier one's position: the forward span stopped at the intervening conjunction,
     * the limiter behind it was never in view, and a scoped requirement reached ALLOW. Third P1 from
     * review, and the third wrong span for this one decision.
     */
    for (const span of spans) {
      const at = clauseAt + span.at;
      const after = sentence.slice(at + span.length);
      const conjunction = after.search(/\b(?:and|or|but|however)\b/i);
      const forward = conjunction === -1 ? after : after.slice(0, conjunction);
      const leading = at > 0 && SCOPE_LIMITER.test(sentence.slice(0, at).replace(/^[\s"'(\[]*/, "").split(/[,;]/)[0] ?? "");
      if (SCOPE_LIMITER.test(forward) || leading) return "required";
    }
    /**
     * A COORDINATED requirement on the same elided subject: "no CLA is required for docs and
     * required for code." `and` is not a clause delimiter, so this requirement lives inside the
     * waiver's own clause, where the limiter check finds no limiter and the anaphora pass — which
     * needs a clause-INITIAL predicate — cannot see it either. The waiver read as blanket and the
     * repo was ALLOWED while demanding a signature for code. A P1 from review, and the same
     * fail-open class as everything else on this branch: a requirement hiding behind a waiver's
     * coordination.
     *
     * Between the conjunction and the predicate only an elided subject's own copula may stand — "and
     * is required for code", "and it is required for code". Nothing else: "and tests are required"
     * has its OWN subject and must not flip the instrument, and "and no CLA is required for code" is
     * a second waiver rather than a requirement. Both are excluded because a noun sits where the
     * copula or predicate has to be, which is a rule about position rather than a word list.
     */
    const COORDINATED = String.raw`\b(?:and|or|but|however)\s+(?:(?:it|they)\s+)?(?:is|are)?\s*(?:also\s+)?(?:still\s+)?${PREDICATE}\b${SCOPE_FOLLOWS}`;
    if (new RegExp(COORDINATED, "i").test(clause)) {
      return "required";
    }
    /**
     * A WAIVER GOVERNS ONLY THE OCCURRENCE IT NAMES — a P1 from review. Polarity was decided once
     * per clause from the first match, so "No CLA is required for documentation and a CLA is
     * required for code." matched the waiver, never saw the second occurrence, and reached ALLOW.
     * Removing the waived span and asking whether the instrument is still mentioned settles it
     * without guessing at conjunctions; any surviving mention is ungoverned, so it reads as required.
     *
     * EVERY waived span comes out, not just this one — another P1, the mirror of the fix above. One
     * clause can waive the same instrument twice ("no CLA is required for docs and no CLA is required
     * for code", one span because "and" does not split a clause), and removing only the first left
     * the second reading as an ungoverned requirement: a document waiving BOTH scopes was parked.
     * Fail-closed rather than open, so it cost a look rather than a signature, but it was wrong.
     *
     * One instrument can also be named twice in a row: "a DCO sign-off" is a single thing and both
     * words are DCO-family tokens, so a mention abutting a removed span is absorbed with it.
     * Without that, "We don't require a DCO sign-off on contributions." became a hold.
     */
    const abuts = new RegExp(String.raw`^[\s\-]{0,3}${T}`, "i");
    let residual = clause;
    for (let removed = true; removed; ) {
      removed = false;
      for (const w of waivers) {
        const span = new RegExp(w, "i").exec(residual);
        if (!span) continue;
        let tail = residual.slice(span.index + span[0].length);
        for (let abut = abuts.exec(tail); abut; abut = abuts.exec(tail)) tail = tail.slice(abut[0].length);
        residual = `${residual.slice(0, span.index)} ${tail}`;
        removed = true;
        break;
      }
    }
    if (new RegExp(T, "i").test(residual)) return "required";
    return "waived";
  }
  // Undecided reads as REQUIRED — the repo's asymmetry, not a shrug. A false hold costs one look; a
  // false allow opens a draft into a repo demanding a signature, and PRODUCT.md §3 says never forge.
  return "required";
}

/**
 * A sentence boundary is a terminator followed by whitespace and something that starts a sentence.
 *
 * Requiring the capital keeps `e.g.` and `i.e.` from ending a sentence mid-clause — the hazard the
 * `W` window above spells out abbreviation by abbreviation. A newline ends one too: these are
 * markdown, and a list item is a sentence whether or not it carries a full stop.
 *
 * A CONTINUATION is not a new statement, it is more of the previous one, so it is joined back —
 * which lets every existing clause and scope rule see it instead of adding a second way to decide
 * scope. Three P1s from review, all the same defect at different punctuation:
 *
 * - "No CLA is required. Except for code." — the scope, split off as a token-less fragment.
 * - "A CLA is not required for docs. But is required for code." — the requirement, same shape.
 * - "No CLA is required.\n- Except for code." — the same again behind a markdown list marker, which
 *   the first version of this rule did not allow for.
 *
 * Each left a blanket waiver and a fragment nothing looked at, and the repo reached ALLOW while
 * requiring a signature. What makes a continuation is its FIRST word: a scope limiter or a
 * coordinating conjunction, after any list marker or opening quote. That is what separates them from
 * "No CLA. Reviews are quick, except during release weeks.", where the limiter sits mid-sentence
 * with its own subject and must not reach the waiver.
 *
 * A fragment that is genuinely ambiguous joins, and joining over-blocks rather than over-allows —
 * the asymmetry `signaturePolarity` closes with, applied to punctuation.
 */
const CONTINUATION = new RegExp(
  String.raw`^(?:[-*+>]|\d+[.)])?[\s"'(\[]*(?:${SCOPE_LIMITER.source.replace(/^\\b|\\b$/g, "")}|and|or|but|however)\b`,
  "i",
);

/**
 * A fragment that is nothing but a list marker. `1.` ends in a terminator followed by a capital, so
 * the boundary rule above splits an ordered item into a marker and a body — and the marker then stood
 * between a waiver and its scope, so the scope joined to the marker instead of the waiver. Joining
 * the marker back first puts them in one sentence again.
 */
const MARKER_ONLY = /^(?:[-*+>]|\d+[.)])\s*$/;

function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z])|\n+/).map((s) => s.trim()).filter(Boolean)) {
    const previous = out.at(-1);
    const continues = CONTINUATION.test(sentence) || MARKER_ONLY.test(sentence);
    if (previous !== undefined && continues) out[out.length - 1] = `${previous} ${sentence}`;
    else out.push(sentence);
  }
  return out;
}

/**
 * Clause-sized spans, so two instruments in one sentence are judged separately, each with its own
 * offset into the sentence.
 *
 * "No DCO, contributor agreement required." is the case that makes this necessary: one sentence
 * holding a waiver and a requirement. Splitting on the comma is what lets the DCO read as waived and
 * the contributor agreement as required, instead of one borrowing the other's verb. A code comment
 * in the previous attempt claimed a `NEG_FILLER` regex handled the comma and nothing tested it;
 * this is the same guarantee made structural.
 *
 * The offset is carried, not recovered later: a sentence can repeat a clause verbatim, and searching
 * for its text answers with the first copy. The cursor only moves forward, so identical clauses still
 * get their own positions.
 */
function clausesOf(sentence: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let cursor = 0;
  for (const part of sentence.split(/[,;]|\bbut\b|\bhowever\b/i)) {
    const text = part.trim();
    if (!text) continue;
    // Only the splitting delimiter lies between `cursor` and this clause, so the first match from
    // `cursor` is this clause rather than a later repeat of it.
    const at = sentence.indexOf(text, cursor);
    out.push({ text, at });
    cursor = at + text.length;
  }
  return out;
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
    const parts = clausesOf(sentence);
    /**
     * An ANAPHORIC requirement — a clause asserting one while naming no instrument, its subject
     * elided: "A CLA is not required for documentation, but is required for code." The requirement
     * lands in a token-less clause, so the per-clause pass skipped it and recorded only the waiver
     * (P1 from review). The clause must START with the verb, which is what elision looks like:
     * "and tests are required" has its own subject and must not flip the CLA, and matching the
     * keywords alone would over-block it.
     *
     * English drops the copula too — "..., but required for code." — and a participle-initial clause
     * was invisible, so the waiver read as blanket and the repo was ALLOWED despite requiring a
     * signature for code: a P1 from review, and this issue's fail-open class again. `SCOPE_FOLLOWS`
     * is what keeps a bare participle from matching a noun modifier.
     */
    const CONJUNCTION = String.raw`(?:(?:and|or|but|however)\s+)?`;
    const anaphoric = parts.some(
      ({ text: c }) =>
        (new RegExp(String.raw`^${CONJUNCTION}(?:is|are|it\s+is|they\s+are)\s+(?:still\s+)?${PREDICATE}\b`, "i").test(c) ||
          new RegExp(String.raw`^${CONJUNCTION}(?:also\s+)?(?:still\s+)?${PREDICATE}\b${SCOPE_FOLLOWS}`, "i").test(c)) &&
        !SIGNATURE_FAMILIES.some(({ token }) => new RegExp(token, "i").test(c)),
    );
    for (const { text: clause, at: clauseAt } of parts) {
      for (const { family, token } of SIGNATURE_FAMILIES) {
        if (!new RegExp(token, "i").test(clause)) continue;
        const quote = `${family}: ${clause.replace(/\s+/g, " ").trim().slice(0, 140)}`;
        const polarity = signaturePolarity(clause, clauseAt, sentence, token);
        if (polarity === "required" || anaphoric) signatureRequired.push(quote);
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
