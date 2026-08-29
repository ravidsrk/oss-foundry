import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceIsStale, needsRewitness, packetDivergences } from "./ledger-check.ts";
import { DISCLOSURE } from "./neighbor.ts";
import { buildPacket, POLICY_DOC_EXCERPT_LIMIT, renderEvidencePage, renderFreezeEvidence } from "./packet.ts";
import { seedState } from "./seed.ts";

/** Synthetic, and deliberately sharing no abbreviated prefix with any SHA in the seed. */
const LIVE_HEAD = "facade00c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6";

test("the evidence page says when the PR moved past the witnessed commit", () => {
  const packet = seedState().packets.find((p) => p.status === "submitted")!;
  const witnessed = packet.evidence!.reviewedSha!;

  // Control: witnessed head === recorded head, nothing to warn about. Constructed rather than
  // taken from the seed, because since #49 the seed's in-flight packet is itself in the moved-past
  // state — its evidence covers 48c2242 and #1652 has moved to 6b6ff04.
  const atWitnessed = { ...packet, prMeta: { ...packet.prMeta!, headSha: witnessed } };
  assert.equal(/moved past/i.test(renderEvidencePage(atWitnessed)), false);
  // ...and the seed's real packet does warn, because it genuinely is behind.
  assert.match(renderEvidencePage(packet), /moved past/i);

  // A maintainer reading this page after new commits landed must be told the proof is older
  // than the branch — the page is the artifact they trust.
  const moved = renderEvidencePage({
    ...packet,
    prMeta: { ...packet.prMeta!, headSha: LIVE_HEAD },
  });
  assert.match(moved, /moved past/i);
  assert.match(moved, new RegExp(witnessed.slice(0, 12)));
  assert.match(moved, new RegExp(LIVE_HEAD.slice(0, 12)));
  // A live packet owes a re-witness, and the page says so.
  assert.match(moved, /Re-witness before this evidence is read as current/);
});

test("the evidence page and the divergence list agree about a terminal packet", () => {
  // orca-fleet#70 was reviewed at 3ba13f1 and a follow-up commit landed before the maintainer
  // merged it. Both surfaces read the same predicate, so they agree the evidence is stale; they
  // differ only in what they ask for. The page states the historical limit of the proof — a
  // maintainer auditing a merged PR needs it — and asks for nothing, because a terminal packet
  // cannot be re-witnessed. `packetDivergences` stays silent for exactly that reason.
  const merged = seedState().packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_42")!;
  const head = merged.prMeta!.headSha;
  assert.notEqual(merged.evidence!.reviewedSha, head);
  assert.equal(evidenceIsStale(merged, head), true, "the fact is the same on both surfaces");
  assert.equal(needsRewitness(merged, head), false, "nobody can re-witness a merged packet");

  const page = renderEvidencePage(merged);
  assert.match(page, /moved past the witnessed commit before it reached merged/);
  assert.match(page, /Nothing to re-witness/);
  assert.equal(
    /Re-witness before this evidence is read as current/.test(page),
    false,
    "a terminal packet must not be given an action item the operator cannot take",
  );
  assert.deepEqual(
    packetDivergences(merged, {
      state: "closed",
      merged: true,
      draft: false,
      headSha: head,
      body: `${DISCLOSURE}\n`,
      // A merged packet is only "entirely clean" once the revert re-check has run (issue #39).
      revert: { reverted: false, why: "no revert on the base branch since the merge" },
    }),
    [],
  );
});

/**
 * Issue #37, second half. `buildPacket` forwarded the fetched `AGENTS.md` / `CONTRIBUTING` text
 * into `evaluatePolicy` and then dropped it on the floor, so the packet recorded a verdict and no
 * evidence for it. The documented second layer of defence — the mandatory human freeze
 * (docs/04-stations.md §3) — was therefore reading a boolean about text it could not see, and the
 * only way to catch a scanner miss was to go and read the repo out of band, which is exactly the
 * diligence this tool claims to systematize.
 *
 * Scope note: this landed without the matcher work from the same issue, which is parked. Nothing
 * here asserts what the scanner catches; the ban fixture below is one `main` already matches,
 * chosen so these tests move if the *display* breaks and stay still if recall changes.
 */
const CLEAN_CONTRIBUTING =
  "Thanks for contributing! Run `pnpm test` before opening a pull request, keep the changeset entry short, and open an issue first for anything large.";
/** A phrasing `main`'s scanner already matches — the display is under test here, not the matcher. */
const BAN_AGENTS_MD = "AI-generated pull requests are not welcome in this repository.";

function freezePacket(docs: { agentsMd?: string; contributing?: string }) {
  return buildPacket({
    repoId: "mcp-use/mcp-use",
    issueNumber: 999,
    issueTitle: "docs typo",
    issueUrl: "https://github.com/mcp-use/mcp-use/issues/999",
    ...docs,
  });
}

test("the packet keeps the policy text the gate parsed", () => {
  const packet = freezePacket({ agentsMd: "Agents may open draft PRs.", contributing: CLEAN_CONTRIBUTING });
  const docs = packet.policyDocs ?? [];
  assert.deepEqual(
    docs.map((d) => [d.name, d.chars, d.truncated]),
    [
      ["AGENTS.md", 26, false],
      ["CONTRIBUTING", CLEAN_CONTRIBUTING.length, false],
    ],
  );
  assert.equal(docs[1].excerpt, CLEAN_CONTRIBUTING);

  // A document that was never fetched is absent, not an empty string: "we read nothing" and "we
  // read a blank file" are different facts and the freeze must not be shown the second one.
  assert.deepEqual(freezePacket({ contributing: CLEAN_CONTRIBUTING }).policyDocs?.map((d) => d.name), [
    "CONTRIBUTING",
  ]);
  assert.deepEqual(freezePacket({}).policyDocs, undefined);

  // A document fetched and empty is a RECORD with `chars: 0` — the fact the packet must be able to
  // tell apart from the absent one above, and the input the freeze's char-counted absence needs.
  assert.deepEqual(freezePacket({ contributing: "" }).policyDocs, [
    { name: "CONTRIBUTING", chars: 0, excerpt: "", truncated: false },
  ]);
});

test("a long policy document is truncated on the packet but its true size is not", () => {
  const long = `${CLEAN_CONTRIBUTING}\n${"filler prose. ".repeat(400)}`;
  const doc = freezePacket({ contributing: long }).policyDocs![0];
  assert.equal(doc.chars, long.length);
  assert.equal(doc.truncated, true);
  assert.ok(doc.excerpt.length < long.length, "a truncated excerpt must actually be shorter");
  assert.equal(doc.excerpt.length, POLICY_DOC_EXCERPT_LIMIT);
  // The head is kept, so the operator still reads the document from its beginning.
  assert.ok(long.startsWith(doc.excerpt));
  // `truncated` is a statement ABOUT the other two fields, and the loader re-derives it that way
  // (state.ts `isPolicyDoc`). What is written must satisfy what is read back.
  assert.equal(doc.truncated, doc.excerpt.length < doc.chars);
});

test("the freeze prints the words the scanner read, not a boolean", () => {
  const packet = freezePacket({ contributing: CLEAN_CONTRIBUTING });
  assert.equal(packet.policy.code, "ALLOW");
  const out = renderFreezeEvidence(packet);

  // The text itself, so the approver confirms against real words.
  assert.match(out, /keep the changeset entry short/);
  // Named source and size, so a truncated or suspiciously short fetch is visible as such.
  assert.match(out, /CONTRIBUTING/);
  assert.match(out, new RegExp(`${CLEAN_CONTRIBUTING.length} chars`));
  // The miss mode stated out loud rather than left silent.
  assert.match(out, /no ban statement matched/i);
  assert.match(out, /AGENTS\.md.*not fetched/i);
});

/**
 * Issue #77, and the reason it is a P1 rather than a rendering nit.
 *
 * #37 legs 2–3 exist because "the human freeze is blind — fetched docs are discarded". #70 fixed
 * that by printing the parsed text, and then capped the print at 4,000 characters — so for the one
 * case the whole mechanism is for, the human was still blind. The scanner reads the WHOLE document;
 * the freeze showed a prefix. And #37's scanner leg is parked, so "the scanner misses a realistic
 * ban" is a live condition on this tree, not a hypothesis.
 *
 * The specific sentence that made it dangerous is the closing one. After 4,000 characters of quoted
 * text the surface said `no ban statement matched in 4,882 chars from CONTRIBUTING` — a claim of
 * coverage over 882 characters the operator had not been shown, phrased as reassurance, sitting
 * directly above the attest. The `(first 4000 shown)` marker was real but was ~55 screens further
 * up, which is not a disclosure at the moment of the decision.
 *
 * INVARIANT: an operator must never be able to approve while text the scanner read is hidden from
 * them without their knowing it. So the withheld amount is stated where the text stops AND in the
 * scan claim itself, and the scan claim may never assert coverage over characters it did not show.
 */
const withheldFixture = (banAt: number, ban: string) => {
  const filler = "Please read the guidelines below before opening a pull request.\n".repeat(200);
  return `${filler.slice(0, banAt)}\n${ban}\n`;
};

test("the freeze never claims a clean scan over characters it did not show", () => {
  // A ban the scanner MISSES, past the excerpt limit: the exact composition issue #77 describes.
  const missedBan = "Kindly refrain from opening pull requests that were authored by an AI assistant.";
  const doc = withheldFixture(POLICY_DOC_EXCERPT_LIMIT + 801, missedBan);
  const packet = freezePacket({ contributing: doc });

  // Preconditions — if either of these stops holding, the test below is measuring something else.
  assert.equal(packet.policy.code, "ALLOW", "the scanner must MISS this ban for the test to bite");
  assert.ok(doc.length > POLICY_DOC_EXCERPT_LIMIT, "the document must exceed the excerpt limit");
  assert.equal(packet.policyDocs![0].truncated, true);

  const out = renderFreezeEvidence(packet);
  const withheld = doc.length - POLICY_DOC_EXCERPT_LIMIT;

  // 1. The withheld amount is stated, in characters, so "how much" is answerable.
  assert.match(out, new RegExp(`${withheld} character`), out);

  // 2. It is stated WHERE THE TEXT STOPS, not only in a header 4,000 characters earlier. The line
  //    after the last quoted line must be the notice — that is the position an operator scrolling
  //    to the end of the quote actually lands on.
  //    Located from the DOCUMENT's own header, not from the last `| ` line in the render: the
  //    committed policy record and `policyNotes` are quoted the same way further down, so a
  //    whole-output search would land on those and pass over a marker that was never emitted.
  const lines = out.split("\n");
  const header = lines.findIndex((l) => l.startsWith(`  ${packet.policyDocs![0].name} — `));
  assert.ok(header >= 0, out);
  let end = header + 1;
  while (lines[end]?.startsWith("  | ")) end += 1;
  assert.match(
    lines[end] ?? "",
    /not shown|withheld/i,
    `the line where the document's text stops must say so:\n${lines.slice(end - 1, end + 2).join("\n")}`,
  );

  // 3. The closing scan claim — the sentence directly above the attest — may not stand as a clean
  //    bill of health over the full character count. The shipped line was exactly
  //    `Scanner: no ban statement matched in 4883 chars from CONTRIBUTING.`: a complete sentence,
  //    terminated, unqualified. The count may still be reported (it is a true fact about the
  //    scanner) but it may not be the last word, so the FULL STOP is what must be gone.
  assert.equal(
    out.includes(`no ban statement matched in ${doc.length} chars from CONTRIBUTING.`),
    false,
    `the scan claim must not close over unshown text:\n${out.slice(-900)}`,
  );
  // …and the qualification is in the closing block, where the decision is made, not only upstream.
  const closing = out.slice(out.lastIndexOf("  Scanner:"));
  assert.match(closing, new RegExp(`${withheld}`), closing);
  assert.match(closing, /not shown|you have not/i, closing);

  // 4. And the ban itself is genuinely absent from the render — this is the harm, restated as a
  //    fact rather than assumed. The operator's protection is that they are TOLD it is absent.
  assert.equal(out.includes(missedBan), false, "precondition: the ban really is past the limit");
});

test("a fully shown document carries no withheld notice at all", () => {
  // The negative half. A guard that fires on every document teaches the operator to skip it, and
  // "N characters not shown" over a document that was shown whole is a false statement in its own
  // right. Most CONTRIBUTINGs fit, and those freezes must read exactly as they did.
  const out = renderFreezeEvidence(freezePacket({ contributing: CLEAN_CONTRIBUTING }));
  assert.equal(/not shown|withheld/i.test(out), false, out);
  assert.match(out, new RegExp(`no ban statement matched in ${CLEAN_CONTRIBUTING.length} chars`, "i"));
});

test("the freeze prints the ban statement the scanner did match", () => {
  const packet = freezePacket({ agentsMd: BAN_AGENTS_MD });
  assert.equal(packet.policy.code, "DENY_FORBIDDEN");
  const out = renderFreezeEvidence(packet);
  assert.match(out, /are not welcome/i);
  assert.equal(/no ban statement matched/i.test(out), false);
});

test("a freeze with nothing fetched says so instead of reporting a clean scan", () => {
  // The fail-safe direction of the display: "the scanner found no ban" over zero characters of
  // policy text is the single most misleading thing this surface could tell an approver.
  const out = renderFreezeEvidence(freezePacket({}));
  assert.match(out, /no policy text/i);
  assert.equal(/no ban statement matched/i.test(out), false);
});

test("a document that was fetched but came back empty is an absence, not a clean scan", () => {
  // Absence is counted in characters, not in documents. A present-and-empty CONTRIBUTING, or a
  // truncated response, produced a `policyDocs` entry and therefore took the scanned branch —
  // printing "no ban statement matched in 0 chars from CONTRIBUTING", which is the exact sentence
  // the zero-document branch exists to prevent, with a source name attached to make it worse.
  const out = renderFreezeEvidence(freezePacket({ contributing: "" }));
  assert.equal(/no ban statement matched/i.test(out), false, out);
  assert.match(out, /came back empty/i);
  assert.match(out, /re-gate before you attest/i);

  // Both empty is still an absence; one empty and one real is NOT — the real one gets scanned and
  // the operator must still be shown the scan line for it.
  const bothEmpty = renderFreezeEvidence(freezePacket({ agentsMd: "", contributing: "" }));
  assert.equal(/no ban statement matched/i.test(bothEmpty), false, bothEmpty);
  const oneReal = renderFreezeEvidence(freezePacket({ agentsMd: "", contributing: CLEAN_CONTRIBUTING }));
  assert.match(oneReal, new RegExp(`no ban statement matched in ${CLEAN_CONTRIBUTING.length} chars`, "i"));
});
