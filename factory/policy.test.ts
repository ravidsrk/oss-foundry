import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hasDerivedFigure, parsePolicyRecords, policyRecordsPath } from "./policy-records.ts";
import { evaluatePolicy, scanPolicyText } from "./policy.ts";

test("denylist always forbids matplotlib", () => {
  const v = evaluatePolicy({
    repoId: "matplotlib/matplotlib",
    agentsMd: "tiny docs typo is fine",
    issueTitle: "typo",
  });
  assert.equal(v.code, "DENY_FORBIDDEN");
  assert.equal(v.allow, false);
});

test("forbidden phrase beats a welcome repo", () => {
  const v = evaluatePolicy({
    repoId: "ColeMurray/background-agents",
    agentsMd: "Autonomous agents not allowed on this tracker.",
    issueTitle: "icon tweak",
  });
  assert.equal(v.code, "DENY_FORBIDDEN");
});

test("an anaphoric requirement lands on the instrument last named, not on every family", () => {
  // The corpus above asserts the VERDICT; this asserts which instrument the record blames, which is
  // the half a sentence-wide flag got wrong and the half a human reads.
  const cla = scanPolicyText("No CLA is required for docs, but is required for code, and no DCO is needed.");
  assert.deepEqual(
    cla.signatureRequired.map((q) => q.split(":")[0]),
    ["CLA"],
    "the CLA is the instrument the elided subject refers to",
  );
  assert.deepEqual(cla.signatureWaived.map((q) => q.split(":")[0]), ["DCO"], "the DCO is waived outright");

  // Same sentence with the families swapped, so the rule cannot be passing by ordering luck.
  const dco = scanPolicyText("No DCO is needed for docs, but is required for code, and no CLA is required.");
  assert.deepEqual(dco.signatureRequired.map((q) => q.split(":")[0]), ["DCO"]);
  assert.deepEqual(dco.signatureWaived.map((q) => q.split(":")[0]), ["CLA"]);

  // Both families named BEFORE the anaphor, so "most recently named" and "first named" differ and
  // only the nearest one is right. Without this the rule passes while attributing to whichever
  // instrument happens to appear first.
  // Both families in ONE clause, so "nearest" cannot be read off the clause order - it is the token
  // position inside the clause, and the roster order is irrelevant. A P1 from review: the evidence
  // named whichever instrument the roster lists first.
  const together = scanPolicyText("No CLA or DCO is required, but is required for code.");
  assert.deepEqual(
    together.signatureRequired.map((q) => q.split(":")[0]),
    ["DCO"],
    "the DCO's token sits nearest the elided subject",
  );

  // A family named TWICE in the clause: "nearest" is its last mention, not its first, and reading the
  // first makes the other instrument look closer. Stilted, and deliberately so - the scanner reads a
  // stranger's document and the rule has to be the rule.
  const twice = scanPolicyText("A CLA is not required and no DCO is needed and no CLA is expected, but is required for code.");
  assert.deepEqual(
    twice.signatureRequired.map((q) => q.split(":")[0]),
    ["CLA"],
    "the CLA's LAST mention is nearest the elided subject",
  );

  const nearest = scanPolicyText("No DCO is needed, no CLA is required for docs, but is required for code.");
  assert.deepEqual(
    nearest.signatureRequired.map((q) => q.split(":")[0]),
    ["CLA"],
    "the CLA is the instrument named nearest the elided subject",
  );
  assert.deepEqual(nearest.signatureWaived.map((q) => q.split(":")[0]), ["DCO"]);
});

test("CLA parks needs-human", () => {
  const v = evaluatePolicy({
    repoId: "OpenHands/OpenHands",
    agentsMd: "Please sign the CLA. HUMAN: required.",
    issueTitle: "docs FAQ",
  });
  assert.equal(v.code, "HOLD_CLA");
});

test("own wave 0 allowlisted changelog is ALLOW", () => {
  const v = evaluatePolicy({
    repoId: "ravidsrk/orca-fleet",
    agentsMd: "Agents may open draft PRs.",
    issueTitle: "[P2] CHANGELOG Unreleased",
  });
  assert.equal(v.code, "ALLOW");
  assert.equal(v.allow, true);
});

test("unknown repo is denied", () => {
  const v = evaluatePolicy({ repoId: "random/slop-magnet", issueTitle: "typo" });
  assert.equal(v.code, "DENY_UNKNOWN_POLICY");
});

test("files or diff over the repo cap is HOLD_SCOPE", () => {
  const files = evaluatePolicy({
    repoId: "ravidsrk/orca-fleet",
    agentsMd: "Agents may open draft PRs.",
    issueTitle: "docs tweak",
    filesHint: 99,
  });
  assert.equal(files.code, "HOLD_SCOPE");
  assert.equal(files.allow, false);

  const diff = evaluatePolicy({
    repoId: "ravidsrk/orca-fleet",
    agentsMd: "Agents may open draft PRs.",
    issueTitle: "docs tweak",
    diffHint: 401,
  });
  assert.equal(diff.code, "HOLD_SCOPE");
});

const MATPLOTLIB_STYLE_BAN = `Use of Generative AI. The following uses are unacceptable: External AI tooling (e.g. bots, agents) directly interacting with the project; including creating issues, PRs or commenting on GitHub or Discourse. Pull requests that are AI generated will be closed.`;

const QEMU_STYLE_BAN = `Current QEMU project policy is to DECLINE any contributions which are believed to include or derive from AI generated content. This policy may evolve as AI tools mature.`;

const KERNEL_STYLE_CONDITIONAL = `AI agents MUST NOT add Signed-off-by tags. Only humans can legally certify the Developer Certificate of Origin (DCO). The human submitter is responsible for reviewing all AI-generated code and adding their own Signed-off-by tag.`;

const AGENT_FRAMEWORK_README = `This repo orchestrates autonomous agents in E2B sandboxes. Each autonomous agent gets a fresh worktree and a task queue. AI slop is what these guardrails exist to prevent.`;

test("descriptive mention of autonomous agents is not a ban", () => {
  const v = evaluatePolicy({
    repoId: "ColeMurray/background-agents",
    agentsMd: AGENT_FRAMEWORK_README,
    issueTitle: "icon tweak",
  });
  assert.equal(v.code, "ALLOW");
});

test("a ban statement denies and captures the statement as the quote", () => {
  const v = evaluatePolicy({
    repoId: "mcp-use/mcp-use",
    contributing: MATPLOTLIB_STYLE_BAN,
    issueTitle: "docs fix",
  });
  assert.equal(v.code, "DENY_FORBIDDEN");
  assert.equal(
    v.matchedPhrases.some((p) => /will be closed/i.test(p)),
    true,
  );
});

test("a decline-first ban statement denies", () => {
  const v = evaluatePolicy({
    repoId: "mcp-use/mcp-use",
    contributing: QEMU_STYLE_BAN,
    issueTitle: "docs fix",
  });
  assert.equal(v.code, "DENY_FORBIDDEN");
});

test("kernel-style DCO conditional holds CLA, not forbidden", () => {
  const v = evaluatePolicy({
    repoId: "mcp-use/mcp-use",
    contributing: KERNEL_STYLE_CONDITIONAL,
    issueTitle: "docs fix",
  });
  assert.equal(v.code, "HOLD_CLA");
});

test("a welcome record attaches provenance to the verdict", () => {
  const v = evaluatePolicy({ repoId: "github/awesome-copilot", issueTitle: "add a prompt file" });
  assert.equal(v.code, "ALLOW");
  assert.equal(v.record?.source, "CONTRIBUTING.md");
  assert.equal(/🤖🤖🤖/.test(v.record?.quote ?? ""), true);
});

test("a conditional record holds with the quoted condition even without fetched docs", () => {
  const v = evaluatePolicy({ repoId: "mastra-ai/mastra", issueTitle: "docs fix" });
  assert.equal(v.code, "HOLD_HUMAN");
  assert.equal(/needs triage/.test(v.record?.quote ?? ""), true);
});

const MATPLOTLIB_CLAUSE_ONLY = `Use of Generative AI. The following uses are unacceptable: External AI tooling (e.g. bots, agents) directly interacting with the project; including creating issues, PRs or commenting on GitHub or Discourse.`;

const ZIG_STYLE_BAN = `We do not accept contributions written by LLMs.`;

const DO_NOT_ACCEPT_BAN = `We do not accept machine-generated patches.`;

const PYDANTIC_WELCOME = `We welcome the use of AI when contributing to Pydantic. However, users should certify that they fully understand the code being submitted.`;

const BOILERPLATE_ALLOW = `We maintain a high bar for code quality, so incomplete or untested submissions may be rejected during review. Please explain your changes clearly; issues without an explanation will be rejected.`;

const ROBOT_ALLOW = `This is a robot-cleaning simulation library. Submissions are rejected by CI when tests fail.`;

test("a ban clause behind an abbreviation dot still denies on its own", () => {
  const v = evaluatePolicy({ repoId: "mcp-use/mcp-use", contributing: MATPLOTLIB_CLAUSE_ONLY, issueTitle: "docs" });
  assert.equal(v.code, "DENY_FORBIDDEN");
});

test("active-voice refusals deny: do-not-accept phrasing", () => {
  const zig = evaluatePolicy({ repoId: "mcp-use/mcp-use", contributing: ZIG_STYLE_BAN, issueTitle: "docs" });
  assert.equal(zig.code, "DENY_FORBIDDEN");
  const machine = evaluatePolicy({ repoId: "mcp-use/mcp-use", contributing: DO_NOT_ACCEPT_BAN, issueTitle: "docs" });
  assert.equal(machine.code, "DENY_FORBIDDEN");
});

test("ordinary contributing prose is not a ban", () => {
  const welcome = evaluatePolicy({ repoId: "mcp-use/mcp-use", contributing: PYDANTIC_WELCOME, issueTitle: "docs" });
  assert.equal(welcome.code, "ALLOW");
  const boilerplate = evaluatePolicy({ repoId: "mcp-use/mcp-use", contributing: BOILERPLATE_ALLOW, issueTitle: "docs" });
  assert.equal(boilerplate.code, "ALLOW");
  const robot = evaluatePolicy({ repoId: "mcp-use/mcp-use", contributing: ROBOT_ALLOW, issueTitle: "docs" });
  assert.equal(robot.code, "ALLOW");
});

test("an affirmative record satisfies parse-policy-first for an unknown repo; a silent one does not", () => {
  const affirmative = evaluatePolicy(
    { repoId: "mcp-use/mcp-use", issueTitle: "docs" },
    {
      repoId: "mcp-use/mcp-use",
      source: "CONTRIBUTING.md",
      url: "",
      fetchedAt: "2026-08-28",
      stance: "welcome",
      conditions: [],
      quote: "We welcome all kinds of contributions!",
    },
  );
  assert.equal(affirmative.code, "ALLOW");
  assert.equal(affirmative.record?.stance, "welcome");

  const silent = evaluatePolicy(
    { repoId: "mcp-use/mcp-use", issueTitle: "docs" },
    {
      repoId: "mcp-use/mcp-use",
      source: "CONTRIBUTING.md",
      url: "",
      fetchedAt: "2026-08-28",
      stance: "silent",
      conditions: [],
      quote: "Parsed; no AI-contribution language found.",
    },
  );
  assert.equal(silent.code, "DENY_UNKNOWN_POLICY");
  assert.equal(silent.record?.stance, "silent");
});

/**
 * The invariant `docs/12-ledger.md` states for this field — "one verbatim statement from the
 * source", rendered to the maintainer as their own words — had no enforcement, so withdrawing the
 * unreproducible `Behaviorally open: 141 of 272 external PRs merged.` from the committed record was
 * a convention one edit could undo silently: putting it back left the whole suite green and the
 * evidence page quoted it back at the maintainer as if they had said it.
 *
 * Both directions are asserted, because a guard that refuses everything is not a guard: a `silent`
 * quote carrying a derived figure is refused at parse, and the absence notes the committed file
 * actually holds — dates, file paths and all — still load.
 */
const record = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    records: {
      "ColeMurray/background-agents": {
        source: "CONTRIBUTING.md",
        url: "https://github.com/ColeMurray/background-agents/blob/HEAD/CONTRIBUTING.md",
        fetchedAt: "2026-08-28",
        stance: "silent",
        conditions: [],
        quote: "No AI-contribution language in CONTRIBUTING.md, AGENTS.md, or CLAUDE.md.",
        ...over,
      },
    },
  });

test("a silent quote may hold an absence note but never a derived figure", () => {
  // Loads: the absence note the committed record carries.
  assert.equal(
    parsePolicyRecords(record()).get("ColeMurray/background-agents")?.stance,
    "silent",
  );
  // Loads: an absence note carrying a date and paths — the guard must not fire on those.
  assert.ok(
    parsePolicyRecords(
      record({
        quote:
          "No CONTRIBUTING.md at the root or .github/ as of 2026-08-28; the README is an examples catalog with no contribution or AI language.",
      }),
    ).get("ColeMurray/background-agents"),
  );

  // Refused: the exact string that was withdrawn, and the re-derived figure that replaced it.
  for (const figure of [
    "Behaviorally open: 141 of 272 external PRs merged.",
    "Behaviorally open: 250/408 non-owner PRs merged.",
    "Behaviorally open: 61% of non-owner PRs merged.",
  ]) {
    assert.throws(
      () => parsePolicyRecords(record({ quote: figure })),
      /is silent but its quote carries a derived figure/,
      figure,
    );
  }

  // A measurement in a maintainer's own prose is not this defect: only `silent` quotes are ours.
  assert.ok(
    parsePolicyRecords(
      record({ stance: "welcome", quote: "We merge roughly 9 of 10 community pull requests." }),
    ).get("ColeMurray/background-agents"),
  );
});

/**
 * The guard failed in BOTH directions at once, which is why one test covers both (issue #82).
 *
 * Permissive: the pattern had no `i` flag, so `of` matched lowercase only and `141 Of 272` walked
 * straight through the guard #44 added — the same unreproducible measurement in a maintainer's
 * mouth, one shift key away.
 *
 * Strict: the `number/number` alternative was unanchored, so it also matched the `2026/08` inside a
 * path. That contradicts the constant's own comment, which requires that "an ISO date, a file path
 * and a version number must all pass, because absence notes carry them" — and a rejected absence
 * note is not a cosmetic failure: `policyRecordFor` throws out of a lazy cache, so one such quote
 * takes down `validate` and every packet build that touches the record.
 */
test("the derived-figure guard reads case-insensitively and does not mistake a path for a ratio", () => {
  // Permissive direction. Every casing of the ratio word is the same claim.
  for (const figure of [
    "Behaviorally open: 141 Of 272 external PRs merged.",
    "Behaviorally open: 141 OF 272 external PRs merged.",
    "Behaviorally open: 141 oF 272 external PRs merged.",
  ]) {
    assert.throws(
      () => parsePolicyRecords(record({ quote: figure })),
      /is silent but its quote carries a derived figure/,
      figure,
    );
  }

  // Strict direction. A numeric path segment is a path, not a measurement.
  //
  // BOTH lookarounds are exercised. Every fixture here used to put the numeric pair AFTER a `/`,
  // which only ever tested the LOOKBEHIND: deleting `(?![/\w])` on its own left the suite green.
  // The last two put a numeric segment BEFORE a `/` with an ordinary word boundary in front of it,
  // so the trailing exclusion is the only thing that can save them.
  for (const note of [
    "no CONTRIBUTING.md at docs/2026/08 as of 2026-08-28",
    "nothing under .github/2026/08/ and nothing in AGENTS.md as of 2026-08-28",
    "checked https://example.invalid/docs/2026/08/policy as of 2026-08-28",
    "read 2026/08/28 of the archived policy page as of 2026-08-28",
    "no AGENTS.md; the wiki path is 2026/08/28/contributing as of 2026-08-28",
  ]) {
    assert.ok(
      parsePolicyRecords(record({ quote: note })).get("ColeMurray/background-agents"),
      note,
    );
  }

  // The guard's known limit, pinned rather than left to be rediscovered. A bare two-component
  // `2026/08` — no third segment, no surrounding path — is indistinguishable IN FORM from the
  // ratio `141/272`, and the constant's comment says in as many words that it will not learn to
  // recognise dates ("without needing to know it is a date"). So it refuses, and that is the right
  // direction: the guard THROWS, so a false positive stops `validate` in front of a human who can
  // reword the note, while a false negative puts an unreproducible measurement in a maintainer's
  // mouth on the evidence page and nothing ever says so. What the comment promises is that an ISO
  // date passes, and it does.
  assert.equal(hasDerivedFigure("no CONTRIBUTING.md as of 2026-08-28"), false);
  assert.equal(hasDerivedFigure("no CONTRIBUTING.md as of 2026/08"), true, "known limit, not a promise");
  assert.equal(hasDerivedFigure("no CONTRIBUTING.md as of 2026/08/28"), false, "three segments read as a path");

  // …and the loosening must not cost the catch it was loosened around: a bare ratio still dies,
  // whether or not the writer put spaces around the slash. Every fixture wrote it tight, so the
  // `\s*` on either side of the `/` was pinned by nothing and deleting it stayed green — and
  // `141 / 272` is how a human types a ratio into prose at least as often as `141/272`.
  for (const figure of [
    "Behaviorally open: 250/408 non-owner PRs merged.",
    "Behaviorally open: 141 / 272 external PRs merged.",
    "Behaviorally open: 141/ 272 external PRs merged.",
  ]) {
    assert.throws(
      () => parsePolicyRecords(record({ quote: figure })),
      /is silent but its quote carries a derived figure/,
      figure,
    );
  }
});

test("the committed policy records parse under the quote guard", () => {
  // Reads the shipped file, so restoring a figure into any silent quote turns this suite red.
  // Deliberately not a pin on the quote *text*: a legitimate refresh — upstream finally writes a
  // CONTRIBUTING, or the absence note is reworded — must stay green. Only the class is asserted.
  const records = parsePolicyRecords(readFileSync(policyRecordsPath(import.meta.url), "utf8"));
  assert.ok(records.size > 0);
  const silent = [...records.values()].filter((r) => r.stance === "silent");
  assert.ok(silent.length > 0, "the file must still hold a silent record or this asserts nothing");
  // Through the guard's OWN predicate, not a second copy of it. The copy that used to sit here was
  // written when the two agreed, and issue #82 made them disagree: it had no `i` flag but also no
  // path exclusion, so it was simultaneously looser and STRICTER than the rule it was checking. A
  // legitimate absence note carrying `docs/2026/08` would have passed `validate` and turned this
  // file red — the second half of #82's defect, relocated into the test suite.
  for (const r of silent) {
    assert.equal(hasDerivedFigure(r.quote), false, `${r.repoId} quote: ${r.quote}`);
  }
});

/**
 * Issue #37, leg 4 — the assertion behind a sentence in docs/04-stations.md §2, not a claim about
 * recall.
 *
 * The page used to leave a reader to infer that deny-by-default covers a scanner miss. It does
 * not, and the two guards must not be conflated: `hasParsedEvidence` is satisfied by ANY fetched
 * document, so a `CONTRIBUTING` whose refusal the scanner cannot read is evidence the gate counts,
 * and the packet reaches `ALLOW`. Only the no-evidence case denies.
 *
 * This is a CHARACTERIZATION test of the gate as it stands, deliberately asserting `ALLOW` on
 * phrasings the scanner misses. It is not a recall assertion and must not be read as endorsing the
 * miss: the matcher work from the same issue is parked, and the freeze display (`renderFreezeEvidence`)
 * is what stands between these strings and a PR. If the matchers are later broadened so that these
 * DENY, this test is the thing that should be rewritten alongside the sentence it pins — that is
 * what it is for.
 */
test("deny-by-default covers the no-evidence case, not the missed-ban case", () => {
  // Paraphrases from the issue's own probe table that this tree's scanner does not match.
  const missed = [
    "we are not currently accepting AI-generated contributions",
    "only human contributors may open pull requests",
    "we don't want AI slop here",
  ];
  for (const text of missed) {
    assert.equal(
      evaluatePolicy({ repoId: "mcp-use/mcp-use", issueTitle: "docs typo", contributing: text }).code,
      "ALLOW",
      `a ban the scanner cannot read reaches ALLOW: ${text}`,
    );
  }
  // The same packet with nothing fetched is the case deny-by-default actually covers...
  assert.equal(
    evaluatePolicy({ repoId: "mcp-use/mcp-use", issueTitle: "docs typo" }).code,
    "DENY_UNKNOWN_POLICY",
  );
  // ...and so is a fetch that came back empty, which carries no evidence either.
  assert.equal(
    evaluatePolicy({ repoId: "mcp-use/mcp-use", issueTitle: "docs typo", contributing: "" }).code,
    "DENY_UNKNOWN_POLICY",
  );
});

/**
 * ISSUE #52 — the CLA/DCO fail-open, and the corpus that has to keep it closed.
 *
 * WHAT WAS BROKEN ON `main`, measured rather than described. All five "waive the DCO, assert the
 * CLA" documents below did hold — every one through `human=["DCO"]`, with nothing matched about the
 * CLA. There was no bare `\bcla\b`; the only CLA patterns were `sign(?:ing)?\s+the\s+cla` and
 * `\bcla\s+(?:is\s+)?required\b`, both defeated by an interposed "not". The correct verdict was an
 * ACCIDENT. Negating the DCO — which the repo needs, since "No CLA. No DCO. Conventional commits."
 * is the live Wave-1 seed text and was being parked — removes the accident with nothing behind it,
 * which is what happened to the previous attempt.
 *
 * Two more holes the same measurement found, neither in the issue: "All commits must carry a
 * Signed-off-by line." reached ALLOW matching NOTHING, and the short `contributor agreement` was
 * unmatched, so "No DCO, contributor agreement required." also held only by the accident.
 *
 * CORPUS PROVENANCE — what #37's park note says to settle before touching a regex. No row below is
 * derived from a constant in `policy.ts`; they come from the documents quoted in #52 and #50,
 * ordinary CONTRIBUTING.md phrasing, and paraphrase. A corpus drawn from the code under test only
 * measures that the code does what it does.
 */
type Polarity = "required" | "waived" | "silent";

const SIGNATURE_CORPUS: { doc: string; want: Polarity; why: string }[] = [
  // --- The five from #52. Each waives one instrument and asserts the other. ---
  { doc: "We do not require a DCO. You must sign a CLA before your first PR.", want: "required", why: "#52 row 1" },
  { doc: "No DCO is required. All contributors need a CLA on file.", want: "required", why: "#52 row 2" },
  { doc: "There is no DCO. Our CLA must be signed before we can merge.", want: "required", why: "#52 row 3" },
  { doc: "DCO: not required. CLA: required.", want: "required", why: "#52 row 4" },
  { doc: "No DCO. CLA mandatory.", want: "required", why: "#52 row 5" },

  // --- The comma boundary. One sentence, a waiver and a requirement. ---
  { doc: "No DCO, contributor agreement required.", want: "required", why: "#52: the comma case a code comment claimed and no test asserted" },
  { doc: "No CLA, DCO sign-off required.", want: "required", why: "the same shape with the families swapped" },
  { doc: "CLA required, DCO not required.", want: "required", why: "requirement first, waiver second" },
  // Two tokens of one family, waiver first: without the comma split the first CLA match is inside
  // "No CLA", its waiver fires, and the later requirement is never evaluated — a fail-open.
  { doc: "No CLA, a contributor license agreement is required.", want: "required", why: "same family twice, waiver first — pins the comma split" },

  // --- Blanket waivers. These must NOT hold: over-blocking parks a legitimate packet. ---
  { doc: "No CLA. No DCO. Conventional commits.", want: "waived", why: "the live Wave-1 seed text, parked on main" },
  { doc: "No DCO is required.", want: "waived", why: "blanket waiver with the requirement word inside it" },
  { doc: "A CLA is not required.", want: "waived", why: "post-token negation" },
  { doc: "We do not require a CLA.", want: "waived", why: "active-voice waiver" },
  { doc: "We don't require a DCO sign-off on contributions.", want: "waived", why: "#52 names this as forced by cla|dco in the filler" },
  { doc: "There is no DCO.", want: "waived", why: "existential waiver" },
  { doc: "There is no CLA to sign.", want: "waived", why: "#52 predicted this would flip to a hold; waiver-first ordering keeps it" },
  { doc: "Contributors do not need to sign a contributor license agreement.", want: "waived", why: "spelled-out form, waived" },
  { doc: "No contributor agreement is necessary.", want: "waived", why: "short form, alternate requirement word" },
  { doc: "We will not ask for a CLA.", want: "waived", why: "future-tense waiver" },
  // The scope limiter is read from the SENTENCE, so the sentence boundary has to be real. Without
  // it the whole document is one span, this "except" — which is about spam, not about the CLA —
  // reaches the waiver, and a blanket waiver reads as scoped. Fail-closed rather than fail-open, but
  // it parks a legitimate packet, which is the over-block half of this issue.
  { doc: "No CLA is required. All patches are welcome, except spam.", want: "waived", why: "an 'except' in a LATER sentence must not scope this waiver — pins the sentence splitter" },

  // --- Escape-hatch denials. "no X bypass" asserts X, it does not waive it. ---
  { doc: "There is no DCO bypass.", want: "required", why: "#52: escape-hatch framing" },
  { doc: "There is no CLA exception for small patches.", want: "required", why: "exception framing" },
  { doc: "No CLA waiver is available.", want: "required", why: "waiver-of-the-waiver" },
  // Negating a PERMISSION asserts the requirement, and the adjectival forms were missing: they
  // matched no waiver predicate and no hatch word, so the broad `no <token>` fallback consumed the
  // mention and the repo reached ALLOW. A P1 from review.
  { doc: "No CLA is optional.", want: "required", why: "#52: negated permission, adjectival" },
  { doc: "No DCO is optional.", want: "required", why: "same, DCO family" },
  { doc: "No CLA is voluntary.", want: "required", why: "synonym" },
  { doc: "No CLA is discretionary.", want: "required", why: "synonym" },
  { doc: "There is no way around the DCO.", want: "required", why: "paraphrased escape hatch" },

  // --- One verb waives only the instrument it actually reaches. ---
  //
  // The active-voice filler was bounded by punctuation, and `and` is not punctuation, so the filler
  // crossed a conjunction AND another instrument: "We do not require a CLA and a DCO is required."
  // waived a DCO the sentence demands. A fail-open P1 from review, and the comment above the pattern
  // claimed it "stops at any clause break" while no test disagreed - a lie with a green suite.
  { doc: "We do not require a CLA and a DCO is required.", want: "required", why: "#52: one verb cannot waive across a conjunction" },
  { doc: "We do not require a CLA or a DCO sign-off.", want: "required", why: "object coordination is indistinguishable from statement coordination here, so it holds" },
  // Two family tokens adjacent, no conjunction between them. This is the row that makes the temper
  // ANOTHER INSTRUMENT rather than a conjunction: tempering on conjunctions alone waives both here.
  // A deliberate hold - "a contributor agreement sign-off" may be one thing or two, and which it is
  // is exactly the guess this scanner stopped making.
  { doc: "We do not need a contributor agreement sign-off.", want: "required", why: "cross-family adjacency: held, not guessed" },
  // ...and the shape the filler exists for still waives: an infinitive between verb and instrument.
  { doc: "We do not need to sign a contributor license agreement.", want: "waived", why: "the infinitive the filler was added for" },
  { doc: "We do not ask for a contributor agreement.", want: "waived", why: "ask-for phrasing, single instrument" },
  // The absorption exception is for a COMPOUND NOUN - "a DCO sign-off" is one instrument, so the
  // second token comes out with the first. A dash separating two statements is not that, and a
  // three-character window ate the requirement behind one: a fail-open P1 from review.
  { doc: "No DCO is required - DCO is required for code.", want: "required", why: "a dash separates statements; it is not a compound noun" },

  // --- Sentences from real CONTRIBUTING documents, quoted. ---
  //
  // Every other row here was invented to probe a rule. These were not: they are verbatim sentences
  // from upstream policy files, and they are what the gate will actually meet. All of them assert a
  // signature, which is the finding that shaped this scanner - across 17 such documents, 12 name an
  // instrument and every one of the 12 requires it. A document with no signature requirement does not
  // mention a signature at all, so the waiver rows below describe a rarer document than they look.
  { doc: "We cannot accept code without a signed CLA.", want: "required", why: "angular/angular CONTRIBUTING.md" },
  { doc: "The CLA bot will provide a prompt to sign the CLA through a comment on the pull-request.", want: "required", why: "dotnet/runtime CONTRIBUTING.md" },
  { doc: "The sign-off is a simple line at the end of the explanation for the patch.", want: "required", why: "moby/moby CONTRIBUTING.md" },
  { doc: "Again once your PR is assigned a reviewer, unless you need to fix DCO", want: "required", why: "envoyproxy/envoy - one of only 2 of 88 real sentences pairing an instrument with a limiter" },
  { doc: "While the Signed-off-by tag is mandatory, there are a number of other tags that are commonly used during QEMU development.", want: "required", why: "qemu code-provenance.rst, backticks stripped" },

  // --- Scoped waivers: it is required somewhere, so it holds. ---
  { doc: "A CLA is not required except for new dependencies.", want: "required", why: "#50 comment: scoped waiver" },
  { doc: "No DCO is needed unless you are adding a new module.", want: "required", why: "unless-scoped" },
  { doc: "A CLA is not required, except for new dependencies.", want: "required", why: "limiter behind a comma" },
  { doc: "No DCO is needed, unless you are adding a new module.", want: "required", why: "limiter behind a comma" },
  { doc: "No CLA is required, other than for vendored code.", want: "required", why: "limiter behind a comma" },
  { doc: "A CLA is not required; except for new dependencies.", want: "required", why: "limiter behind a semicolon" },
  { doc: "Except for new dependencies, a CLA is not required.", want: "required", why: "leading limiter, waiver is the main clause" },
  { doc: "No CLA is required for documentation or code except for third-party contributions.", want: "required", why: "'or' coordinates two scopes" },
  { doc: "No DCO is needed for docs or tests, unless vendored.", want: "required", why: "same, limiter behind a comma" },
  { doc: "No CLA is required for docs plus tests, other than for dependencies.", want: "required", why: "'plus' coordinates scopes too" },
  { doc: "No CLA is required for documentation, or code, except for third-party contributions.", want: "required", why: "comma before 'or'" },
  { doc: "No CLA is required for docs, or tests, or code, unless vendored.", want: "required", why: "three-item scope list" },
  { doc: "No DCO is needed for docs, and tests, other than vendored trees.", want: "required", why: "'and'-joined scope list" },

  // --- And a limiter the waiver has NOTHING to do with holds the packet too. ---
  //
  // These nine rows read as waivers to a human: the `except` is about spam, or review scope, or
  // forks. They are deliberately held anyway, and the reasoning is at `SCOPE_LIMITER`'s use in
  // `signaturePolarity`: deciding which of two statements an `except` belongs to is a parsing
  // problem, twelve of this branch's defects were that decision made four different ways, and every
  // version was correct until someone wrote down one more sentence.
  //
  // So the question is no longer asked. A waiver stands only in a sentence with nothing to argue
  // about. This reverses two review findings that called the over-block a defect, which is a real
  // cost and is why it is measured rather than asserted: across 17 real CONTRIBUTING-style documents,
  // 12 name a signature instrument and all 12 already resolve to REQUIRED. No real document waives
  // an instrument it mentions. Two of 88 instrument-naming sentences carried a limiter, both inside
  // documents already held. The shape these rows describe did not occur once.
  { doc: "No CLA is required, and all patches are welcome except spam.", want: "required", why: "the 'except' is about spam - held rather than parsed" },
  { doc: "No DCO is needed, and we review everything except vendored trees.", want: "required", why: "'except' is about review scope" },
  { doc: "No CLA is required for docs, and we review everything except vendored trees.", want: "required", why: "unrelated exception, same sentence" },
  { doc: "No CLA is required for docs, but the maintainers apply judgement except for forks.", want: "required", why: "contrastive conjunction, unrelated exception" },
  { doc: "No CLA is required for docs, and tests apply, except for code.", want: "required", why: "exception attaches to 'tests apply', not to the CLA" },
  { doc: "No CLA is required for docs, and all other repositories in this organisation, except forks.", want: "required", why: "exception about repositories" },
  { doc: "No CLA is required for docs and all patches are welcome except spam.", want: "required", why: "no comma; still an unrelated exception" },
  { doc: "No DCO is needed for docs and we review everything except vendored trees.", want: "required", why: "same, other family" },
  { doc: "No CLA is required for docs, and no CLA is required, and all patches are welcome except spam.", want: "required", why: "repeated waiver plus an unrelated exception" },
  // The limit of the rule, and the reason it is per SENTENCE: a limiter in a DIFFERENT sentence is
  // not in the waiver's sentence and does not hold it. Without this the rule would swallow whole
  // documents, since `except` appears in ordinary prose everywhere.
  { doc: "No CLA. Reviews are quick, except during release weeks.", want: "waived", why: "limiter in a later sentence about something else" },
  // ...but a sentence that STARTS with a limiter is not a new statement, it is the previous one's
  // scope. Splitting them left a blanket waiver and a token-less fragment nothing looked at, and the
  // repo reached ALLOW while requiring a CLA for code. A P1 from review. Sentence-initial is the
  // whole test, which is what separates these from the row above.
  { doc: "No CLA is required. Except for code.", want: "required", why: "sentence-initial limiter scopes the waiver before it" },
  { doc: "No DCO is needed. Unless you are adding a new module.", want: "required", why: "same, with a subject inside the fragment" },
  { doc: "No CLA is required. Other than for vendored trees.", want: "required", why: "multi-word limiter, sentence-initial" },
  { doc: "No CLA is required. Reviews are quick.", want: "waived", why: "next sentence is not a limiter at all" },
  // The same defect at three more punctuations, all P1s from review: a continuation is not a new
  // statement. A conjunction-initial fragment carries the REQUIREMENT rather than the scope, and a
  // markdown list marker hid both - including an ordered marker, which the boundary rule splits off
  // as its own fragment so that it stood between the waiver and its scope.
  { doc: "A CLA is not required for documentation. But is required for code.", want: "required", why: "conjunction-initial requirement fragment" },
  { doc: "No CLA is required.\n- Except for code contributions.", want: "required", why: "limiter behind a markdown bullet" },
  { doc: "No CLA is required.\n1. Except for code.", want: "required", why: "ordered marker, split off on its own" },
  { doc: "No CLA is required.\n> But required for code.", want: "required", why: "blockquote marker" },
  // ...and a conjunction that asserts nothing must still not flip the waiver.
  { doc: "No CLA is required. And we are friendly.", want: "waived", why: "conjunction with nothing required after it" },
  { doc: "No CLA is required. However, reviews are quick.", want: "waived", why: "'however' with its own subject" },
  { doc: "No CLA is required.\n- Please read the style guide.", want: "waived", why: "bullet that asserts nothing" },
  // A continuation can lead with the PREDICATE itself, and then there is no conjunction to find -
  // the joined fragment brings its full stop instead. Fixing the fragment without fixing the
  // separator left this reaching ALLOW. A P1 from review.
  { doc: "No CLA is required for docs.\nRequired for code.", want: "required", why: "predicate-initial continuation" },
  { doc: "No CLA is required for docs.\n- Required for code.", want: "required", why: "same, behind a bullet" },
  { doc: "No DCO is needed for docs.\nMandatory for vendored trees.", want: "required", why: "same, other predicate and family" },
  // A continuation can also lead with the COPULA, which the clause-level anaphora matcher already
  // accepted and this one did not - the two had drifted. A P1 from review.
  { doc: "No CLA is required for docs. Is required for code.", want: "required", why: "copula-initial continuation" },
  { doc: "No CLA is required for docs.\n- Is required for code.", want: "required", why: "same, behind a bullet" },
  { doc: "No DCO is needed for docs. Are required for code.", want: "required", why: "plural copula" },
  // ...and the noun-modifier reading is a NEW statement, not a continuation, in both spellings.
  { doc: "No CLA is required.\nRequired reading is the style guide.", want: "waived", why: "'Required reading' modifies a noun" },
  { doc: "No CLA is required.\nExpected turnaround is one week.", want: "waived", why: "'Expected turnaround' modifies a noun" },
  // These four now hold for a DIFFERENT reason than when they were written. They arrived as
  // fail-closed rows: `SCOPE_FOLLOWS` let any word sit between predicate and scope, so "required
  // reading for contributors" read as a requirement. That fix stands and is still pinned by the
  // pronoun-free rows below it. But a later P1 - "It applies to code, except for vendored trees." -
  // showed a pronoun clause can qualify a waiver with no predicate at all, and resolving what `it`
  // names is coreference. So a pronoun clause in a waiver's sentence holds, and these hold with it.
  { doc: "No CLA is required. It is required reading for new contributors.", want: "required", why: "held: what `It` names is coreference, not something a regex resolves" },
  { doc: "No CLA is required. It is required knowledge for reviewers.", want: "required", why: "same, held for the pronoun not the noun" },
  { doc: "No DCO is needed.\n- It is expected practice in this organisation.", want: "required", why: "same, behind a bullet" },
  // ...and the real copula requirement, which shares every word except the noun, must still hold.
  { doc: "No CLA is required. It is required for code.", want: "required", why: "copula requirement, scope follows directly" },
  { doc: "No CLA is required. It is needed only for release.", want: "required", why: "closed-set qualifier between predicate and scope" },
  // Same shapes with the anaphor in the SAME sentence as its antecedent, which is the only place the
  // clause-level matcher can reach: across a sentence boundary the fragment has no antecedent to
  // attach to, so a row split by a full stop leaves that matcher untested.
  { doc: "No CLA is required, it is required reading for new contributors.", want: "required", why: "same-sentence pronoun clause" },
  // The P1 that established the rule, and the reason it is not a vocabulary of verbs: after joining,
  // "It applies to code." asserts a requirement with no predicate this file knows. Both the limiter
  // variant and the bare one hold, so no `applies|covers|extends` roster was needed.
  { doc: "No CLA is required for docs. It applies to code, except for vendored trees.", want: "required", why: "#52: pronoun continuation carrying a limiter" },
  { doc: "No CLA is required for docs. It applies to code.", want: "required", why: "same, with no limiter and no known predicate" },
  { doc: "No CLA is required for docs.\n- This covers code.", want: "required", why: "same, demonstrative behind a bullet" },
  // The bound on that rule: a pronoun used as an OBJECT qualifies nothing, so it must not hold. The
  // rule needs a pronoun followed by something - a clause - not a pronoun anywhere in the sentence.
  { doc: "No CLA is required for that.", want: "waived", why: "'that' is an object here, not a subject asserting anything" },
  { doc: "No CLA is required. It, however, is required for code.", want: "required", why: "an aside between pronoun and verb does not detach the clause" },
  // ...and the closed qualifier set still earns its keep with no pronoun in sight: reopening it to
  // any word makes this join and read as a requirement, which is the fail-closed it was added for.
  { doc: "No CLA is required. Required reading for contributors.", want: "waived", why: "'reading' is a noun, not an adverb before the scope" },
  { doc: "No CLA is required, it is required for code.", want: "required", why: "same-sentence copula requirement" },
  // The SAME waiver stated twice, scoped only on the later copy. Position came from asking the
  // sentence where the match was, which answers with the first copy, so the later waiver's forward
  // span was cut at the intervening conjunction and its limiter never seen — ALLOW. Third P1.
  { doc: "No CLA is required for docs, and no CLA is required, except for new dependencies.", want: "required", why: "limiter belongs to the SECOND copy of an identical waiver" },
  { doc: "A CLA is not required for docs, and a CLA is not required, unless you add a dependency.", want: "required", why: "same, in the not-required phrasing" },
  { doc: "No DCO is needed for docs, and no DCO is needed, other than for vendored code.", want: "required", why: "same, DCO family" },
  { doc: "No CLA is required, except for new dependencies, and no CLA is required for docs.", want: "required", why: "limiter belongs to the FIRST copy" },
  // Rows above repeat a waiver but never byte-identically: case or a glued "and" keeps each clause
  // text unique, so finding one BY its text lands right by luck. Here both copies are exactly
  // `no CLA is required` with the conjunction between them as its own span, so a by-text search
  // returns the first and the later copy's span is cut at that "and". Stilted on purpose — this
  // reads a stranger's CONTRIBUTING.md, and a repo wanting ALLOW while demanding a signature has
  // every reason to write awkwardly.
  { doc: "For docs, no CLA is required, and, no CLA is required, except for new dependencies.", want: "required", why: "byte-identical clauses: the later copy must be found at its own offset" },
  // ...and the repetition must not become an excuse to over-block. These are the fail-closed halves:
  // identical clauses with no limiter anywhere, and a repeat whose trailing 'except' governs spam.
  { doc: "No CLA is required, no CLA is required.", want: "waived", why: "verbatim repeat, nothing scopes either copy" },
  // One clause can waive the same instrument twice - "and" does not split a clause - and removing
  // only the FIRST waived span left the second reading as an ungoverned requirement, parking a
  // document that waives BOTH scopes. A P1 from review; every waived span comes out now.
  { doc: "No CLA is required for documentation and no CLA is required for code.", want: "waived", why: "same waiver twice in ONE clause" },
  { doc: "No DCO is needed for docs and no DCO is needed for code.", want: "waived", why: "same, DCO family" },
  // The waiver patterns and the requirement roster were two lists and they drifted: the waivers knew
  // `expected` and the predicate did not, so this waived the whole sentence and reached ALLOW.
  // A P1 from review, fixed by giving both one roster rather than by adding the missing word.
  { doc: "No CLA is expected for docs and expected for code.", want: "required", why: "'expected' must work in both polarities" },
  { doc: "No CLA is expected.", want: "waived", why: "...and still waive when nothing requires it" },
  // ...and the limiter can scope the SECOND waiver inside that one clause. Deciding from the first
  // occurrence alone cut the forward span at the intervening "and" and reached a blanket waiver.
  // Found by adversarially probing the cross-clause fix above rather than reported - the same shape
  // a repo would use to get ALLOW while demanding a signature, so it is checked per occurrence now.
  { doc: "No DCO is needed for docs and no DCO is needed for tests, other than vendored trees.", want: "required", why: "limiter scopes the second waiver in ONE clause" },
  { doc: "No CLA is required for docs and no CLA is required for tests, except for dependencies.", want: "required", why: "same, CLA family" },

  // Anaphora (P1 from review): the requirement's subject is elided, so it lands in a token-less
  // clause the per-clause pass skipped, recording only the waiver.
  { doc: "A CLA is not required for documentation, but is required for code contributions.", want: "required", why: "elided subject after 'but'" },
  { doc: "No DCO is needed for docs, but is required for code.", want: "required", why: "same shape, DCO family" },
  { doc: "A CLA is not required, however it is mandatory for vendored trees.", want: "required", why: "'it is mandatory' after 'however'" },
  // The conjunction roster was written out five times and `yet` was in none of them, so this reached
  // ALLOW. A P1 from review, fixed by giving every site one pair of rosters - contrastive words end
  // a clause, coordinating words do not - rather than by adding the one missing word.
  { doc: "No CLA is required for docs, yet required for code.", want: "required", why: "'yet' is contrastive and was unlisted" },
  { doc: "No CLA is required for docs, though required for code.", want: "required", why: "'though'" },
  { doc: "No CLA is required for docs, whereas required for code.", want: "required", why: "'whereas'" },
  { doc: "No CLA is required for docs, nevertheless required for code.", want: "required", why: "'nevertheless'" },
  { doc: "No CLA is required while the repo is in beta.", want: "waived", why: "temporal 'while' asserts no requirement" },
  // ...and a later clause with its OWN subject must not flip anything, or the rule over-blocks.
  { doc: "No CLA is required, and tests are required.", want: "waived", why: "'tests' is the subject, not the CLA" },
  // An elided subject refers to the instrument most recently NAMED. A sentence-wide flag put the
  // requirement on both families, so a sentence waiving the DCO outright reported it as required -
  // a P1 from review, and fail-CLOSED. The verdict was the same because the CLA really is required,
  // but the freeze evidence named the wrong instrument, and that record is what a human signs off.
  { doc: "No CLA is required for docs, but is required for code, and no DCO is needed.", want: "required", why: "anaphora belongs to the CLA, not the DCO" },
  // English drops the copula, and a participle-initial clause was invisible: the waiver read as
  // blanket and the repo was ALLOWED despite requiring a signature for code. A P1 from review.
  // With no verb to anchor on, the SCOPE anchors instead - a bare participle counts only when a
  // scope or the clause end follows, which is what separates it from a participle modifying a noun.
  { doc: "A CLA is not required for documentation, but required for code.", want: "required", why: "copula elided as well as the subject" },
  { doc: "No CLA is needed for docs, but required for vendored trees.", want: "required", why: "same shape, needed/required" },
  { doc: "A CLA is not required for docs, however mandatory for dependencies.", want: "required", why: "copula-less after 'however'" },
  { doc: "No CLA is required, needed only for release.", want: "required", why: "one adverb between participle and scope" },
  { doc: "A CLA is not required for docs, but required.", want: "required", why: "bare participle, clause ends" },
  // ...and the participle must be PREDICATIVE. Modifying a noun asserts nothing about the
  // instrument, so these must stay waived or the rule over-blocks ordinary prose.
  { doc: "No CLA is required, required reading is the style guide.", want: "waived", why: "'required reading' modifies a noun" },
  { doc: "No CLA is required, necessary tooling is listed below.", want: "waived", why: "'necessary tooling' modifies a noun" },
  // "and" is not a clause delimiter, so a coordinated requirement lives INSIDE the waiver's clause,
  // where the limiter check finds no limiter and the clause-initial anaphora rule cannot see it.
  // The waiver read as blanket and the repo was ALLOWED while demanding a signature for code.
  // A P1 from review. The conjunction must be followed DIRECTLY by the predicate, which is what
  // separates it from "and tests are required" (own subject) and "and no CLA is required" (a second
  // waiver) - adjacency, not a word list.
  { doc: "A DCO is not required for documentation and required for code.", want: "required", why: "coordinated requirement, same elided subject" },
  { doc: "No CLA is required for docs and required for code.", want: "required", why: "same, CLA family" },
  { doc: "No CLA is required for docs and also required for dependencies.", want: "required", why: "'also' between conjunction and predicate" },
  { doc: "A CLA is not required for docs or required for tests.", want: "required", why: "'or' coordinates it too" },
  { doc: "No CLA is required for docs and tests.", want: "waived", why: "'and tests.' is a noun, not a predicate" },
  { doc: "No CLA is required and reviews are quick.", want: "waived", why: "coordination with its own subject" },
  // A comma splits the clause and leaves the requirement behind "and", which no clause-initial
  // matcher accepted; and with no comma the copula sits between conjunction and predicate, which the
  // adjacency rule rejected. Both were fail-open, both P1s, both the same class. Only an elided
  // subject's own copula may stand in that gap.
  { doc: "A CLA is not required for documentation, and is required for code contributions.", want: "required", why: "comma, then 'and is required'" },
  { doc: "No CLA is required for docs and is required for code.", want: "required", why: "no comma, copula after the conjunction" },
  { doc: "No CLA is required for docs and it is required for code.", want: "required", why: "explicit pronoun subject" },
  { doc: "No CLA is required, or is required for vendored trees.", want: "required", why: "'or' coordinates it too" },
  // The fail-CLOSED half of the same shape: with NO punctuation the participle modifies the noun -
  // "the docs required for code" - so the sentence asserts nothing about the instrument and a rule
  // that flipped it would hold repositories that waive outright.
  { doc: "No CLA is required for docs required for code.", want: "waived", why: "no separator: participle modifies 'docs'" },
  { doc: "No CLA is required for the docs required by the style guide.", want: "waived", why: "same, unmistakably a noun modifier" },

  // --- Plain requirements, in the phrasings a real CONTRIBUTING.md uses. ---
  { doc: "Pull requests without a signed Contributor License Agreement will be closed.", want: "required", why: "#50: the phrasing most likely to appear for real" },
  { doc: "We require a DCO sign-off.", want: "required", why: "plain DCO requirement" },
  { doc: "All commits must carry a Signed-off-by line.", want: "required", why: "reached ALLOW on main with empty phrases" },
  { doc: "Please sign the CLA before opening a pull request.", want: "required", why: "imperative" },
  { doc: "Every contributor must sign our Contributor Licence Agreement.", want: "required", why: "British spelling of licence" },
  { doc: "Contributions are accepted once the CLA is on file.", want: "required", why: "on-file phrasing" },
  { doc: "You will be asked to sign a contributor agreement by our CLA bot.", want: "required", why: "bot-mediated" },
  { doc: "The Developer Certificate of Origin applies to all patches.", want: "required", why: "spelled-out DCO, no requirement verb but an assertion" },
  { doc: "Sign-off is mandatory for every commit.", want: "required", why: "sign-off as the subject" },
  { doc: "We cannot merge your work until the CLA is signed.", want: "required", why: "cannot-merge framing" },
  { doc: "Your PR will not be reviewed without a DCO sign-off.", want: "required", why: "'without' is a requirement context, never a waiver" },

  // Plurals (P1 from review): `\bcla\b` misses `CLAs`, so row 1 waived the DCO and saw nothing
  // about the CLA; rows 2-3 matched NOTHING AT ALL. This issue's defect in a new spelling.
  { doc: "No DCO. CLAs are mandatory.", want: "required", why: "plural acronym after a waived sibling" },
  { doc: "CLAs are required for all contributors.", want: "required", why: "plural acronym, was silent" },
  { doc: "We require DCOs on every commit.", want: "required", why: "plural DCO, was silent" },
  { doc: "Contributor license agreements are required from every contributor.", want: "required", why: "plural spelled-out form" },
  { doc: "No DCO. Contributor agreements are mandatory.", want: "required", why: "plural short form after a waiver" },
  // ...and the plural must not swallow an ordinary English word: `\bclas?\b` cannot match "class",
  // because the optional s still needs a word boundary after it.
  { doc: "Add a class for the parser and document the class hierarchy.", want: "silent", why: "'class' is not a plural CLA" },

  // Mixed polarity in one clause (P1 from review): polarity was decided once per clause from the
  // FIRST match, so a waiver joined by "and" to a same-family requirement hid it and reached ALLOW.
  { doc: "No CLA is required for documentation and a CLA is required for code contributions.", want: "required", why: "same family, both polarities, joined by 'and'" },
  { doc: "No DCO is needed for docs and a DCO is needed for code.", want: "required", why: "same shape, DCO family" },
  { doc: "No CLA is required, and a CLA is required for vendored code.", want: "required", why: "comma and 'and' together" },
  // ...and one instrument named twice ("a DCO sign-off") must not read as a requirement.
  { doc: "No CLA and no DCO.", want: "waived", why: "two instruments, both waived, joined by 'and'" },

  // --- No signature instrument at all. These must be SILENT: matching them is the over-block. ---
  { doc: "you signal your agreement with the Code of Conduct", want: "silent", why: "#52 mutation 2: a bare /agreement/i would hold this" },
  { doc: "By contributing you agree to the terms of the licence.", want: "silent", why: "agree + licence, no instrument" },
  { doc: "Please be kind in code review.", want: "silent", why: "ordinary prose" },
  { doc: "Run the linter before submitting.", want: "silent", why: "a 'before submitting' with no instrument" },
  { doc: "Squash your commits and sign your work with a clear message.", want: "silent", why: "'sign your work' without naming DCO or a sign-off line" },
  { doc: "This project uses a licence agreement with its vendors.", want: "silent", why: "'licence agreement' without 'contributor'" },
  { doc: "Maintainers must review every pull request.", want: "silent", why: "a human gate, but not a signature — HOLD_HUMAN's territory" },
  { doc: "Documentation changes need no special treatment.", want: "silent", why: "'need no' with no instrument" },

  // --- The documented cost of failing closed on an undecided mention. ---
  { doc: "See our CLA for details.", want: "required", why: "undecided reads as required: a false hold costs one look, a false allow forges a signature" },
  { doc: "We dropped the CLA requirement.", want: "required", why: "same fail-closed default; a phrasing the waiver list does not name" },
];

test("the signature corpus classifies every phrasing correctly, in both directions", () => {
  const wrong: string[] = [];
  for (const { doc, want, why } of SIGNATURE_CORPUS) {
    const s = scanPolicyText(doc);
    const got: Polarity =
      s.signatureRequired.length > 0 ? "required" : s.signatureWaived.length > 0 ? "waived" : "silent";
    if (got !== want) wrong.push(`want ${want}, got ${got}: ${JSON.stringify(doc)} (${why})`);
  }
  assert.deepEqual(wrong, [], `\n${wrong.join("\n")}`);
});

/**
 * Size floors, not decoration: #37's round 3 shipped `suite ok`, exit 0, with its headline corpus
 * EMPTIED and a known regression reintroduced, because it had no floor. Emptying a roster must cost
 * a second visible edit. Both directions are floored separately — an all-must-hold corpus measures
 * only recall and lets the over-block class back in, which is how round 1 of #37 failed.
 */
/**
 * The gate reads a stranger's CONTRIBUTING.md, so it must not be possible to hang it with one.
 *
 * This is a HANG detector, not a benchmark: the bound is generous and the shapes are the ones that
 * make backtracking expensive — long filler runs, deep clause lists, a sentence with no punctuation
 * to stop at, and repetition of every construct the scanner special-cases. Written after this file's
 * own mutation harness produced a non-terminating run and the residual loop turned out to depend on
 * the string shrinking rather than being made to.
 */
test("no adversarial document can hang the signature scanner", () => {
  const documents: [string, string][] = [
    ["long filler run", `We do not require ${"a ".repeat(400)}CLA.`],
    ["filler reaching no instrument", `We do not require ${"a ".repeat(2000)}`],
    ["instrument repeated inside the filler", `We do not require ${"a CLA ".repeat(300)}DCO.`],
    ["deep clause list", `No CLA is required${", or code".repeat(1500)}, except forks.`],
    ["no punctuation to stop at", `No CLA is required ${"and code ".repeat(2000)}`],
    ["pronoun repetition", `No CLA is required. ${"It is it is ".repeat(2000)}`],
    ["whitespace run inside a waiver", `We don't require${" ".repeat(5000)}a DCO sign-off`],
    ["waiver repeated across sentences", "No CLA is required. ".repeat(2000)],
    ["markdown bullet repetition", "- No CLA is required\n".repeat(2000)],
    ["limiter repetition", `No CLA is required ${"except ".repeat(2000)}`],
  ];
  for (const [name, doc] of documents) {
    const started = performance.now();
    scanPolicyText(doc);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 5000, `${name} (${doc.length} chars) took ${elapsed.toFixed(0)}ms`);
  }
});

test("the signature corpus cannot be quietly emptied or made one-sided", () => {
  assert.ok(SIGNATURE_CORPUS.length >= 40, `corpus has ${SIGNATURE_CORPUS.length} rows; the floor is 40`);
  const count = (p: Polarity) => SIGNATURE_CORPUS.filter((r) => r.want === p).length;
  assert.ok(count("required") >= 15, `only ${count("required")} must-hold rows`);
  assert.ok(count("waived") >= 10, `only ${count("waived")} must-waive rows`);
  assert.ok(count("silent") >= 6, `only ${count("silent")} must-be-silent rows`);
  // Distinct documents: duplicating one row must not be a way to satisfy the floor.
  assert.equal(new Set(SIGNATURE_CORPUS.map((r) => r.doc)).size, SIGNATURE_CORPUS.length, "corpus holds duplicate documents");
});

/**
 * The verdict CODE, not just the polarity. The code used to be re-derived by substring-testing the
 * matched phrase for "cla"/"dco"/"certificate", which is why "Contributor License Agreement" landed
 * in `HOLD_HUMAN`: those letters never appear consecutively in it (#50's root cause, from here).
 */
test("an asserted signature holds as HOLD_CLA, and a human-review gate stays HOLD_HUMAN", () => {
  for (const doc of SIGNATURE_CORPUS.filter((r) => r.want === "required").map((r) => r.doc)) {
    const v = evaluatePolicy({ repoId: "mcp-use/mcp-use", contributing: doc, issueTitle: "docs fix" });
    assert.equal(v.code, "HOLD_CLA", `${JSON.stringify(doc)} produced ${v.code}`);
  }
  // The spelled-out phrasing specifically, called out by name in #50.
  const spelled = evaluatePolicy({
    repoId: "mcp-use/mcp-use",
    contributing: "Pull requests without a signed Contributor License Agreement will be closed.",
    issueTitle: "docs fix",
  });
  assert.equal(spelled.code, "HOLD_CLA");

  // A human gate that is not a signature keeps its own code: erasing the distinction is #52's
  // third mutation, and the codes are not cosmetic — HOLD_CLA carries "never forge".
  const review = evaluatePolicy({
    repoId: "mcp-use/mcp-use",
    contributing: "Every pull request must be reviewed by a human maintainer.",
    issueTitle: "docs fix",
  });
  assert.equal(review.code, "HOLD_HUMAN");
});

test("a waived signature does not park the packet", () => {
  // The over-block half. This exact string is the live Wave-1 packet's policy text.
  const v = evaluatePolicy({
    repoId: "ravidsrk/orca-fleet",
    contributing: "No CLA. No DCO. Conventional commits.",
    issueTitle: "[P2] CHANGELOG Unreleased",
  });
  assert.equal(v.code, "ALLOW", `${v.code}: ${v.matchedPhrases.join(" | ")}`);
  // ...and the read is still visible: the waiver is reported, not silently dropped, so a freeze can
  // show the operator what was read and dismissed rather than an unexplained absence.
  const scanned = scanPolicyText("No CLA. No DCO. Conventional commits.");
  assert.equal(scanned.signatureWaived.length, 2, JSON.stringify(scanned));
  assert.equal(scanned.signatureRequired.length, 0);
});

/**
 * The quote an operator reads is the CLAUSE, not the whole sentence — which is what `clausesOf` is
 * for, and worth saying because it no longer changes any VERDICT: per-occurrence governance handles
 * mixed polarity alone, so dropping the comma from the splitter leaves every corpus row passing.
 * What it changes is the freeze. "No DCO, contributor agreement required." must point at the six
 * words asserting the CLA, not a sentence with the waiver still inside it, because a quote holding
 * its own contradiction sends a human back to the document. An unpinned redundancy is the #75 shape;
 * the answer is a reason or a removal, and this is the reason.
 */
test("a mixed-polarity sentence quotes each instrument's own clause, not the whole sentence", () => {
  const s = scanPolicyText("No DCO, contributor agreement required.");
  assert.deepEqual(s.signatureRequired, ["CLA: contributor agreement required."]);
  assert.deepEqual(s.signatureWaived, ["DCO: No DCO"]);
  // Specifically: the CLA's quote does NOT drag the DCO waiver along with it.
  assert.equal(
    s.signatureRequired[0].includes("No DCO"),
    false,
    "the required-CLA quote carries the waived DCO too, so the operator reads a self-contradicting phrase",
  );
});
