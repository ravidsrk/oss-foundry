import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceIsStale, needsRewitness, packetDivergences } from "./ledger-check.ts";
import { DISCLOSURE } from "./neighbor.ts";
import { renderEvidencePage } from "./packet.ts";
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
    }),
    [],
  );
});
