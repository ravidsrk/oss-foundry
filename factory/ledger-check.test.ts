import assert from "node:assert/strict";
import { test } from "node:test";
import { packetDivergences, seedDivergences } from "./ledger-check.ts";
import { seedState } from "./seed.ts";
import type { TaskPacket } from "./types.ts";

/** A head the PR moved to after the evidence was witnessed. */
const LIVE_HEAD = "6b6ff04c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a";

function submittedPacket(): TaskPacket {
  return seedState().packets.find((p) => p.status === "submitted")!;
}

test("evidence staleness is bound to the witnessed SHA and survives the sync that moves prMeta", () => {
  const packet = submittedPacket();
  const witnessed = packet.evidence!.reviewedSha!;
  const live = { state: "open" as const, merged: false, draft: true, headSha: LIVE_HEAD };

  const beforeSync = packetDivergences(packet, live);
  assert.equal(
    beforeSync.some((d) => d.includes(witnessed.slice(0, 7)) && d.includes(LIVE_HEAD.slice(0, 7))),
    true,
    "new commits past the witnessed head must be reported",
  );

  // `sync` overwrites prMeta.headSha with the live head. evidence.reviewedSha is immutable, so the
  // staleness must still be reported afterwards — otherwise the sync silently erases the signal.
  const synced: TaskPacket = { ...packet, prMeta: { ...packet.prMeta!, headSha: LIVE_HEAD } };
  const afterSync = packetDivergences(synced, live);
  assert.equal(
    afterSync.some((d) => d.includes(witnessed.slice(0, 7)) && d.includes(LIVE_HEAD.slice(0, 7))),
    true,
    "the staleness flag must outlive the sync that overwrites prMeta.headSha",
  );
});

test("re-witnessing at the live head clears the staleness", () => {
  const packet = submittedPacket();
  const rewitnessed: TaskPacket = {
    ...packet,
    prMeta: { ...packet.prMeta!, headSha: LIVE_HEAD },
    evidence: { ...packet.evidence!, headSha: LIVE_HEAD, reviewedSha: LIVE_HEAD },
  };
  assert.deepEqual(
    packetDivergences(rewitnessed, {
      state: "open",
      merged: false,
      draft: true,
      headSha: LIVE_HEAD,
    }),
    [],
  );
});

test("a terminal packet is never re-flagged for evidence staleness", () => {
  // orca-fleet#70 was reviewed at 3ba13f1 and a follow-up commit landed before the maintainer
  // merged it. The packet is at rest; re-reporting it every clock tick would train the operator
  // to ignore divergence, and would fail the committed-seed check in CI forever.
  const merged = seedState().packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_42")!;
  assert.notEqual(merged.evidence!.reviewedSha, merged.prMeta!.headSha);
  assert.deepEqual(
    packetDivergences(merged, {
      state: "closed",
      merged: true,
      draft: false,
      headSha: merged.prMeta!.headSha,
    }),
    [],
  );
});

test("live state that has moved past the committed seed is reported packet by packet", () => {
  const seed = seedState();
  assert.deepEqual(seedDivergences(seed, seed), []);

  const moved = {
    ...seed,
    packets: seed.packets.map((p) =>
      p.status === "submitted" ? { ...p, status: "followed-up" as const } : p,
    ),
  };
  const drift = seedDivergences(moved, seed);
  assert.equal(drift.length, 1);
  assert.match(drift[0], /submitted/);
  assert.match(drift[0], /followed-up/);

  const extra = { ...seed, packets: [...seed.packets.slice(1)] };
  assert.equal(
    seedDivergences(extra, seed).some((d) => /only in the committed seed/.test(d)),
    true,
  );

  // The #49 shape: a sync moved the live head forward, the committed seed still names the old one.
  const advanced = {
    ...seed,
    packets: seed.packets.map((p) =>
      p.status === "submitted" ? { ...p, prMeta: { ...p.prMeta!, headSha: LIVE_HEAD } } : p,
    ),
  };
  assert.equal(
    seedDivergences(advanced, seed).some((d) => d.includes(LIVE_HEAD.slice(0, 7))),
    true,
  );
});
