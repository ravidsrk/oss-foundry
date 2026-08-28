import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyScorecard, health, mergeRate } from "./scorecard.ts";
import { seedState } from "./seed.ts";
import { loadFactoryState, saveFactoryState } from "./state.ts";

test("missing state file loads seed and does not invent a file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "missing.json");
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.source, "seed");
  assert.equal(loaded.state.packets.length, seedState().packets.length);
});

test("malformed state file is refused instead of falling back to seed", () => {
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "bad.json");
  writeFileSync(path, "{not json");
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.match(loaded.error, /will not overwrite with seed/);
  const after = loadFactoryState(path);
  assert.equal(after.ok, false);
});

test("incompatible state object is refused", () => {
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "v5.json");
  writeFileSync(path, JSON.stringify({ version: 5, packets: [] }));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.match(loaded.error, /not a Foundry v6 state file/);
});

test("nested malformed packet is refused", () => {
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "nested.json");
  const seed = seedState();
  writeFileSync(
    path,
    JSON.stringify({
      ...seed,
      packets: [5, { id: "bad" }],
    }),
  );
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.match(loaded.error, /not a Foundry v6 state file/);
});

test("malformed nested packet fields are refused", () => {
  const seed = seedState();
  const base = seed.packets[0];
  const cases: unknown[] = [
    { ...base, acceptance: "not an array" },
    { ...base, nonGoals: [1, 2] },
    { ...base, evidence: { baseSha: 1 } },
    { ...base, humanAttest: {} },
    { ...base, prMeta: { url: "https://example" } },
    { ...base, followUps: [{ id: "x" }] },
    { ...base, sandboxSession: { status: "dry-run" } },
  ];
  for (const packet of cases) {
    const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "fields.json");
    writeFileSync(path, JSON.stringify({ ...seed, packets: [packet] }));
    const loaded = loadFactoryState(path);
    assert.equal(loaded.ok, false, JSON.stringify(packet).slice(0, 80));
  }
});

test("v6 ledger missing later-required fields is migrated, not stranded", () => {
  const seed = seedState();
  const packet = { ...seed.packets[0] } as Record<string, unknown>;
  delete packet.lighting;
  delete packet.acceptance;
  delete packet.nonGoals;
  delete packet.abort;
  delete packet.createdAt;
  const policy = { ...(packet.policy as Record<string, unknown>) };
  delete policy.reasons;
  delete policy.matchedPhrases;
  packet.policy = policy;
  const scout = { ...(packet.scout as Record<string, unknown>) };
  delete scout.parts;
  packet.scout = scout;
  const row = { ...(seed.scorecard[0] as Record<string, unknown>) };
  delete row.closedUnmerged;
  delete row.lastTouch;
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "old-v6.json");
  writeFileSync(
    path,
    JSON.stringify({
      ...seed,
      packets: [packet, ...seed.packets.slice(1)],
      scorecard: [row, ...seed.scorecard.slice(1)],
    }),
  );
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.state.packets[0].lighting, "lit");
  assert.deepEqual(loaded.state.packets[0].acceptance, []);
  assert.equal(loaded.state.packets[0].policy.reasons.length, 0);
  assert.equal(loaded.state.packets[0].scout.parts.wave, 0);
  assert.equal(loaded.state.scorecard[0].closedUnmerged, 0);
  assert.equal(loaded.state.scorecard[0].lastTouch, "—");
});

test("scorecard rows carry a noReview counter from birth", () => {
  for (const row of emptyScorecard()) {
    assert.equal(row.noReview, 0);
  }
});

test("stored scorecard without noReview is migrated to 0, not stranded", () => {
  const seed = seedState();
  const scorecard = seed.scorecard.map((r) => {
    const row = { ...r } as Record<string, unknown>;
    delete row.noReview;
    return row;
  });
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "no-noreview.json");
  writeFileSync(path, JSON.stringify({ ...seed, scorecard }));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  for (const row of loaded.state.scorecard) {
    assert.equal(row.noReview, 0);
  }
});

test("valid state round-trips without becoming seed", () => {
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "ok.json");
  const seed = seedState();
  seed.ticksRun = 99;
  saveFactoryState(path, seed);
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.source, "file");
  assert.equal(loaded.state.ticksRun, 99);
});

test("merge rate counts terminal outcomes; silence alone cannot trip the halt", () => {
  const silent = { ...emptyScorecard()[0], opened: 3 };
  assert.equal(mergeRate(silent), 0);
  assert.notEqual(health(silent), "stop");
  const allClosed = { ...silent, closedUnmerged: 3 };
  assert.equal(health(allClosed), "stop");
  const mixed = { ...silent, merged: 2, closedUnmerged: 1 };
  assert.ok(mergeRate(mixed) > 0.6);
  assert.equal(health(mixed), "good");
});

test("stored packet with dark-eligible lighting is refused", () => {
  const seed = seedState();
  const packet = { ...seed.packets[0], lighting: "dark-eligible" };
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "dark.json");
  writeFileSync(path, JSON.stringify({ ...seed, packets: [packet, ...seed.packets.slice(1)] }));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, false);
});
