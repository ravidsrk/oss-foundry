import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SANDBOX_RULES } from "./sandbox.ts";
import { witnessEvidence } from "./witness.ts";

/**
 * Doctrine text that tells the operator what to do must name a verb the operator has. The CLI's
 * verbs are `status`, `tick`, `approve`, `reject`, `halt`, `advance`, `evidence`, `body`,
 * `open-draft`, `reconcile`, `evidence-page`, `ledger`, `sync`, `attach-draft` — there is no
 * `park`. `parked` is a status the *engine* writes (over-cap scope, a scorecard halt, a policy
 * denial); the operator's tool for standing a packet down is `reject`. "Park the packet" reads as
 * an instruction and points at a button that does not exist (issue #44 item 5).
 */
test("sandbox doctrine tells the operator to reject, not to press a verb the CLI lacks", () => {
  const oracle = SANDBOX_RULES.find((rule) => /tests cannot run/i.test(rule));
  assert.ok(oracle, "the oracle rule must survive any rewording");
  assert.match(oracle, /\breject\b/i);
  assert.doesNotMatch(oracle, /park the packet/i);
  assert.match(oracle, /do not skip the oracle/i);
});

/**
 * Same pin as the sandbox doctrine above, for the SPEC §5 negative-control refusal.
 * `parked` is a status the engine writes; the operator's stand-down verb is `reject` (issue #62).
 */
test("negative-control refusal tells the operator to reject, not to press a verb the CLI lacks", async () => {
  const runner = async (step: string) => {
    if (step === "mkdtemp") return { exit: 0, output: "/tmp/foundry-witness-fake" };
    if (step === "run-tests@head") return { exit: 0, output: "ok" };
    if (step === "run-tests@revert") return { exit: 0, output: "still ok" };
    return { exit: 0, output: "" };
  };
  const outcome = await witnessEvidence(
    {
      packetId: "pkt_ravidsrk_orca-fleet_71",
      repoId: "ravidsrk/orca-fleet",
      baseSha: "251fe899c5bd843a7dad71d908c0af3bfcea79e1",
      headSha: "d91fe2f6725163fab8f9dd42e5c2b0c0c9f0f40d",
      testCommand: "true",
      sandbox: "host",
      wave: 0,
    },
    runner,
    {},
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.error, /\breject\b/i);
    assert.doesNotMatch(outcome.error, /park the packet/i);
    assert.match(outcome.error, /does not bind the change/i);
  }
});

/**
 * The `//` that starts a trailing comment, or -1. String contents are masked to the same width
 * first, so the `//` in a URL inside a string literal cannot fabricate a comment — inventing one is
 * how a scan starts reporting violations that are not there, which is the whole subject of #99.
 */
function trailingCommentAt(line: string): number {
  let masked = "";
  let quote = "";
  for (const char of line) {
    if (quote === "") {
      if (char === '"' || char === "'" || char === "`") quote = char;
      masked += char;
      continue;
    }
    // Inside a literal: keep the width, drop the content, and let the closing quote through.
    masked += char === quote ? char : " ";
    if (char === quote) quote = "";
  }
  return masked.indexOf("//");
}

/**
 * Every comment in a source, separately: each block comment, each run of consecutive `//` lines, and
 * each trailing comment written after code.
 *
 * Separately is the whole point. The first version of the guard below matched
 * `/KNOWN DEFECT[\s\S]{0,200}issue #\d+/` over the raw file, and `[\s\S]` crosses newlines, code and
 * the boundary between two comments — so a `KNOWN DEFECT` note with an unrelated `issue #N` mention
 * 200 characters downstream tripped it (issue #99).
 */
function commentsIn(source: string): string[] {
  const out = [...source.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0]);
  let run: string[] = [];
  const endRun = () => {
    if (run.length > 0) out.push(run.join("\n"));
    run = [];
  };
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) {
      run.push(trimmed);
      continue;
    }
    endRun();
    // A note written after code is its own comment, not part of any run around it.
    const at = trailingCommentAt(line);
    if (at >= 0) out.push(line.slice(at));
  }
  endRun();
  return out;
}

/** One comment that both flags a defect and points at an issue to track it. */
function tracksAnIssue(comment: string): boolean {
  return comment.includes("KNOWN DEFECT") && /issue #\d+/.test(comment);
}

/**
 * A tracking comment that names an issue reads as accounted for, and it outlives the issue: that is
 * exactly how this defect was orphaned when #44 closed with the item unfixed (issue #62).
 *
 * The rule is "no issue pointer at all", not "no CLOSED issue pointer", and the name says so. A test
 * cannot tell open from closed without the network, and it should not try — the tracker is the
 * tracker. Forbidding the pointer outright is both testable and the stronger rule, and it fires on
 * an OPEN citation too, which was verified rather than assumed.
 */
test("no KNOWN DEFECT comment in factory/ carries an issue pointer", () => {
  const factory = fileURLToPath(new URL(".", import.meta.url));
  const hits: string[] = [];
  let scanned = 0;
  for (const name of readdirSync(factory)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    scanned += 1;
    const found = commentsIn(readFileSync(join(factory, name), "utf8"));
    if (found.some(tracksAnIssue)) hits.push(name);
  }
  assert.deepEqual(hits, []);
  // Not vacuous: a rename or an extraction that stopped finding comments would pass over nothing.
  assert.ok(scanned >= 10, `only ${scanned} production file(s) scanned; the discovery has drifted`);
});

test("the KNOWN DEFECT scan reads one comment at a time, not a 200-character window", () => {
  // The direction the guard exists for.
  assert.equal(
    commentsIn("// KNOWN DEFECT: tracked in issue #12\nconst x = 1;\n").some(tracksAnIssue),
    true,
    "a comment that flags a defect and points at an issue must be caught",
  );
  assert.equal(
    commentsIn("/**\n * KNOWN DEFECT, see issue #12.\n */\nconst x = 1;\n").some(tracksAnIssue),
    true,
    "a block comment must be caught too",
  );
  // Consecutive `//` lines are ONE comment, so a note whose marker and pointer sit on different
  // lines of the same run is still that comment tracking that issue. Without this, a regression
  // that stopped joining runs would weaken the standing scan while every other case here passed.
  const spread = "// KNOWN DEFECT: the refusal names the wrong verb.\n// Filed as issue #12.\n";
  assert.equal(
    commentsIn(spread).some(tracksAnIssue),
    true,
    "a marker and a pointer on consecutive // lines are one comment",
  );
  assert.equal(commentsIn(spread).length, 1, "the run must be joined into one comment, not two");
  // A note written after code, which the first version of the extractor skipped entirely — and
  // production files here do use trailing `//` comments, so that was live coverage missing.
  assert.equal(
    commentsIn('const x = 1;  // KNOWN DEFECT: tracked in issue #12\n').some(tracksAnIssue),
    true,
    "a trailing comment after code must be scanned",
  );
  // A trailing note stands alone: it does not absorb the separate comment on the next line.
  assert.equal(
    commentsIn("const x = 1;  // KNOWN DEFECT: wrong verb.\n// Filed as issue #12.\n").some(tracksAnIssue),
    false,
    "a trailing comment is not joined to the comment below it",
  );
  // The reason string contents are masked: a URL in a literal must not become a comment. If it did,
  // the code line would read as a comment and could carry a marker into a pointer that is not there.
  assert.deepEqual(
    commentsIn('const u = "https://example.invalid/a";\n'),
    [],
    "a // inside a string literal is not a comment",
  );
  assert.deepEqual(
    commentsIn('const u = "https://example.invalid/a";  // see issue #12\n'),
    ["// see issue #12"],
    "the real trailing comment is still found on a line that also contains a URL",
  );

  // ...and the direction issue #99 is about: two SEPARATE comments, neither of which tracks
  // anything. The old window matched across the gap and reported a violation that was not one.
  const separate = [
    "// KNOWN DEFECT: the refusal below names the wrong verb.",
    "const x = 1;",
    "// Unrelated: this mirrors the shape issue #34 settled.",
    "const y = 2;",
  ].join("\n");
  assert.equal(
    commentsIn(separate).some(tracksAnIssue),
    false,
    "an issue mentioned in a DIFFERENT comment is not this comment tracking it",
  );
  // The premise of that case, so it cannot pass by finding no comments at all.
  assert.equal(commentsIn(separate).length, 2, "the two comments must be extracted as two");

  // A blank line ends a `//` run: two notes separated by one are two comments, not one.
  assert.equal(
    commentsIn("// KNOWN DEFECT: something.\n\n// Filed as issue #7.\n").some(tracksAnIssue),
    false,
    "a blank line separates two comments",
  );
});
