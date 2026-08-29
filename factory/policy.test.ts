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
 * WHAT WAS BROKEN ON `main`, measured rather than described. All five of the realistic
 * "waive the DCO, assert the CLA" documents below did produce a hold — and every one of them did it
 * through `human=["DCO"]`, with nothing matched about the CLA at all. `HUMAN_STATEMENTS` had no bare
 * `\bcla\b`; its only CLA-acronym patterns were `sign(?:ing)?\s+the\s+cla` and
 * `\bcla\s+(?:is\s+)?required\b`, both defeated by an interposed "not". So the correct verdict was an
 * ACCIDENT of an un-negated `\bdco\b` sitting in the same sentence. Making the DCO negation-aware —
 * which the repo needs, because "No CLA. No DCO. Conventional commits." is the live Wave-1 seed text
 * and was being parked — removes the accident, and 8 of 10 such documents fail open with nothing to
 * replace it. That is what happened to the previous attempt.
 *
 * Two further holes the same measurement turned up, neither in the issue:
 *   - "All commits must carry a Signed-off-by line." reached ALLOW with EMPTY matched phrases. A
 *     plain signature requirement the scanner could not see.
 *   - "No DCO, contributor agreement required." held only via the DCO accident; the short form
 *     `contributor agreement` was unmatched.
 *
 * CORPUS PROVENANCE, which is the part issue #37's park note says to settle before touching a
 * regex. Not one row below is derived from a constant in `policy.ts`. They come from: the documents
 * quoted in #52 and #50, ordinary CONTRIBUTING.md phrasing, and deliberate paraphrase of each into
 * shapes the implementation does not name. A corpus drawn from the code under test measures whether
 * the code does what it does.
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
  // TWO TOKENS OF ONE FAMILY, waiver first. This is the row that pins the comma in `clausesOf`:
  // without the split the whole sentence is one clause, the first CLA match is the one inside
  // "No CLA", its waiver fires, and the requirement later in the sentence is never evaluated —
  // a fail-open. Every other corpus row survives losing the comma, because the waiver patterns are
  // token-anchored; this one does not.
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
  { doc: "There is no way around the DCO.", want: "required", why: "paraphrased escape hatch" },

  // --- Scoped waivers: it is required somewhere, so it holds. ---
  { doc: "A CLA is not required except for new dependencies.", want: "required", why: "#50 comment: scoped waiver" },
  { doc: "No DCO is needed unless you are adding a new module.", want: "required", why: "unless-scoped" },
  // The limiter across a clause boundary. The first draft of `signaturePolarity` read the limiter
  // from the CLAUSE, so a comma before "except" hid it and a scoped requirement came out a blanket
  // waiver — this issue's own fail-open class, reproduced inside its fix and caught before shipping.
  { doc: "A CLA is not required, except for new dependencies.", want: "required", why: "limiter behind a comma" },
  { doc: "No DCO is needed, unless you are adding a new module.", want: "required", why: "limiter behind a comma" },
  { doc: "No CLA is required, other than for vendored code.", want: "required", why: "limiter behind a comma" },
  { doc: "A CLA is not required; except for new dependencies.", want: "required", why: "limiter behind a semicolon" },

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

  // PLURALS. A P1 fail-open in the first version of this change, found in review: `\bcla\b` does
  // not match `CLAs`, so the first row below waived the DCO, saw nothing about the CLA, and reached
  // ALLOW. The second and third matched NOTHING AT ALL. Same defect as the issue, new spelling.
  { doc: "No DCO. CLAs are mandatory.", want: "required", why: "plural acronym after a waived sibling" },
  { doc: "CLAs are required for all contributors.", want: "required", why: "plural acronym, was silent" },
  { doc: "We require DCOs on every commit.", want: "required", why: "plural DCO, was silent" },
  { doc: "Contributor license agreements are required from every contributor.", want: "required", why: "plural spelled-out form" },
  { doc: "No DCO. Contributor agreements are mandatory.", want: "required", why: "plural short form after a waiver" },
  // ...and the plural must not swallow an ordinary English word: `\bclas?\b` cannot match "class",
  // because the optional s still needs a word boundary after it.
  { doc: "Add a class for the parser and document the class hierarchy.", want: "silent", why: "'class' is not a plural CLA" },

  // MIXED POLARITY IN ONE CLAUSE. A second P1 from review: polarity was decided once per clause from
  // the FIRST match, so a waiver joined to a same-family requirement by "and" — not a delimiter, and
  // it should not have to be — hid the requirement and reached ALLOW. A waiver now governs only the
  // occurrence it names; any surviving mention is ungoverned and reads as required.
  { doc: "No CLA is required for documentation and a CLA is required for code contributions.", want: "required", why: "same family, both polarities, joined by 'and'" },
  { doc: "No DCO is needed for docs and a DCO is needed for code.", want: "required", why: "same shape, DCO family" },
  { doc: "No CLA is required, and a CLA is required for vendored code.", want: "required", why: "comma and 'and' together" },
  // ...and the governance rule must not turn one instrument named twice into a requirement:
  // "a DCO sign-off" is a single thing and both words are DCO-family tokens.
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
 * Size floors, and they are not decoration. Issue #37's round 3 shipped `suite ok`, exit 0, with its
 * headline corpus EMPTIED and a known regression reintroduced, because `CORPUS` had no floor while
 * `LEXICON` did. Emptying a roster has to cost a second visible edit.
 *
 * Both directions are floored separately, because a corpus that is all must-hold rows measures only
 * recall and would let the over-block class back in — which is how round 1 of #37 failed.
 */
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
 * The verdict CODE, not just the polarity. #52's acceptance is that these hold as `HOLD_CLA`, and
 * the code used to be re-derived by substring-testing the matched phrase for "cla", "dco" or
 * "certificate" — which is why "Contributor License Agreement" landed in `HOLD_HUMAN`: those three
 * letters never appear consecutively in it (issue #50's root cause, reached from here).
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
 * The quote an operator reads is the CLAUSE, not the whole sentence.
 *
 * This is what `clausesOf` is for, and it needs saying because the clause split no longer changes
 * any VERDICT: the per-occurrence governance rule handles mixed polarity on its own, so removing the
 * comma from the splitter leaves every row of the corpus above passing. What it does change is what
 * the freeze shows. "No DCO, contributor agreement required." must point the operator at the six
 * words that assert the CLA, not hand back the whole sentence with the waiver still in it — a quote
 * that contains its own contradiction is the thing a human then has to re-read the document to
 * resolve.
 *
 * Pinned rather than deleted, and pinned rather than left as a survivor: an unpinned redundancy is
 * the shape this repo keeps filing issues about (#75), and the answer is either a reason or a
 * removal. This is the reason.
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
