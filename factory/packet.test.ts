import assert from "node:assert/strict";
import { test } from "node:test";
import { renderEvidencePage } from "./packet.ts";
import { seedState } from "./seed.ts";

const LIVE_HEAD = "6b6ff04c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a";

test("the evidence page says when the PR moved past the witnessed commit", () => {
  const packet = seedState().packets.find((p) => p.status === "submitted")!;
  const witnessed = packet.evidence!.reviewedSha!;

  // Witnessed head === recorded head: nothing to warn about.
  assert.equal(/moved past/i.test(renderEvidencePage(packet)), false);

  // A maintainer reading this page after new commits landed must be told the proof is older
  // than the branch — the page is the artifact they trust.
  const moved = renderEvidencePage({
    ...packet,
    prMeta: { ...packet.prMeta!, headSha: LIVE_HEAD },
  });
  assert.match(moved, /moved past/i);
  assert.match(moved, new RegExp(witnessed.slice(0, 12)));
  assert.match(moved, new RegExp(LIVE_HEAD.slice(0, 12)));
});
