import assert from "node:assert/strict";
import { test } from "node:test";
import { seedState } from "./seed.ts";
import {
  OFF_ALLOWLIST_WAVE,
  foundryAttestedWave0Merges,
  isPromotionGateExcluded,
  ledgerSections,
  PROMOTION_GATE_MERGES,
  promotionGateWave0Merges,
  quietLabel,
} from "./status.ts";

/**
 * The ledger is the audit surface. `status` counts every packet; the `ledger` command grouped by
 * `repoById(p.repoId)?.wave`, so a packet whose repo is *not* on the allowlist matched no wave and
 * silently disappeared — the denied `matplotlib/matplotlib` scout, which is precisely the refusal
 * the ledger exists to show. Under-reporting a denial is the one omission an audit surface cannot
 * afford (issue #44 item 9).
 */
test("the ledger lists every packet, including the ones the allowlist denied", () => {
  const packets = seedState().packets;
  const sections = ledgerSections(packets);
  const listed = sections.flatMap((s) => s.packets);

  assert.equal(listed.length, packets.length);
  assert.deepEqual(
    new Set(listed.map((p) => p.id)),
    new Set(packets.map((p) => p.id)),
  );

  const off = sections.find((s) => s.wave === OFF_ALLOWLIST_WAVE);
  assert.ok(off, "an off-allowlist packet needs a section of its own, not silence");
  assert.equal(
    off.packets.some((p) => p.repoId === "matplotlib/matplotlib"),
    true,
  );
  assert.match(off.title, /allowlist/i);
});

test("ledger sections keep wave order and drop the ones with nothing in them", () => {
  const packets = seedState().packets;
  const waves = ledgerSections(packets).map((s) => s.wave);
  assert.deepEqual(waves, [...waves].sort((a, b) => a - b));
  assert.equal(
    ledgerSections(packets).every((s) => s.packets.length > 0),
    true,
  );
  assert.deepEqual(ledgerSections([]), []);
});

/**
 * PRODUCT.md §8 and docs/12-ledger.md record three Foundry-attested Wave 0 merges and then
 * exclude frontguard#196 from the promotion gate: the operator clicked merge on a repo they
 * own, which Foundry must never do, so the merge is history rather than evidence a stranger
 * accepted a Foundry patch. Promotion is orca-fleet#70 + #72.
 *
 * `foundryAttestedWave0Merges` stays the raw count (status/ledger print 3). The gate reads
 * `promotionGateWave0Merges`. If the exclusion is dropped, the two counters collapse and
 * Wave 1 can open on a merge doctrine names as excluded.
 */
test("promotion-gate arithmetic excludes frontguard#196 and counts orca-fleet#70+#72", () => {
  const packets = seedState().packets;
  assert.equal(
    foundryAttestedWave0Merges(packets),
    3,
    "the ledger records three attested Wave 0 merges, including the excluded one",
  );
  assert.equal(
    promotionGateWave0Merges(packets),
    PROMOTION_GATE_MERGES,
    "the gate counts two; frontguard#196 is recorded, not a promotion-gate merge",
  );

  const excluded = packets.filter(isPromotionGateExcluded);
  assert.equal(excluded.length, 1, "exactly one packet is named as excluded");
  assert.equal(excluded[0].repoId, "ravidsrk/frontguard");
  assert.equal(excluded[0].issueNumber, 195);
  assert.equal(excluded[0].status, "merged");
  assert.ok(excluded[0].humanAttest, "the excluded merge is attested; that is why the raw counter includes it");

  const withoutOrca = packets.filter((p) => p.repoId !== "ravidsrk/orca-fleet");
  assert.equal(foundryAttestedWave0Merges(withoutOrca), 1);
  assert.equal(
    promotionGateWave0Merges(withoutOrca),
    0,
    "frontguard#196 alone must not satisfy the gate — this is the assertion that dies if the exclusion is dropped",
  );

  const oneOrcaPlusExcluded = packets.filter(
    (p) => p.status === "merged" && (p.repoId === "ravidsrk/frontguard" || p.issueNumber === 42),
  );
  assert.equal(foundryAttestedWave0Merges(oneOrcaPlusExcluded), 2);
  assert.equal(
    promotionGateWave0Merges(oneOrcaPlusExcluded),
    1,
    "one orca-fleet merge plus frontguard#196 is still one gate merge, not two",
  );
});

/**
 * `quietDaysOf` measures wall-clock against `prMeta.updatedAt`, which is a *stored observation*
 * refreshed only by `sync`. Printing a bare `quiet=0d/14` reads as a live reading of the PR; on any
 * day after the last sync it is an extrapolation from a frozen fact. The number must name the
 * observation it came from and the command that refreshes it (issue #44 item 11).
 *
 * `factory/engine.test.ts` drives `status` itself — this file only pins the string.
 */
test("the quiet counter names the observation it was extrapolated from", () => {
  const line = quietLabel(0, 14, {
    updatedAt: "2026-08-28T16:16:39Z",
    syncedAt: "2026-08-28T16:16:39Z",
  });
  assert.match(line, /quiet=0d\/14/);
  assert.match(line, /2026-08-28/);
  assert.match(line, /sync/);
  assert.doesNotMatch(line, /16:16:39/, "the operator needs the day, not a timestamp");
});

test("the quiet counter still labels its source once the count has drifted", () => {
  const meta = { updatedAt: "2026-08-28T16:16:39Z", syncedAt: "2026-08-28T16:16:39Z" };
  assert.match(quietLabel(31, 14, meta), /quiet=31d\/14/);
  assert.match(quietLabel(31, 14, meta), /2026-08-28/);
});

/**
 * The two dates only look like one fact in the seed, where they coincide. `updatedAt` is the PR's
 * own last activity — what the count is measured from; `syncedAt` is when we read it. After a real
 * `sync` they diverge, and a line that printed only one of them would read as though the count had
 * been measured from the other.
 */
test("the quiet counter distinguishes the PR's last activity from when we read it", () => {
  const line = quietLabel(3, 14, {
    updatedAt: "2026-09-01T00:00:00Z",
    syncedAt: "2026-09-04T09:30:00Z",
  });
  assert.match(line, /quiet=3d\/14/);
  assert.match(line, /PR last active 2026-09-01/);
  assert.match(line, /read by `sync` 2026-09-04/);
});
