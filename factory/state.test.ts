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

test("a stored witness may carry a toolchain string, and nothing else in that slot", () => {
  // `toolchain` is advisory, not a gate: a ledger written before #41 has no such field and must
  // load untouched, while a hand-edited one cannot put a non-string where the evidence page
  // interpolates a sentence for the maintainer.
  const seed = seedState();
  const base = seed.packets[0];
  const witness = {
    provider: "host",
    testExit: 0,
    revertExit: 1,
    testLogSha: "c".repeat(64),
    revertLogSha: "d".repeat(64),
    ranAt: "2026-08-29T09:00:00.000Z",
    repoId: base.repoId,
    baseSha: base.evidence!.baseSha,
    headSha: base.evidence!.headSha,
    testLogPath: `docs/evidence/logs/${base.id}/test.log`,
    revertLogPath: `docs/evidence/logs/${base.id}/revert.log`,
  };
  const withWitness = (extra: Record<string, unknown>) => ({
    ...seed,
    packets: [{ ...base, evidence: { ...base.evidence, witness: { ...witness, ...extra } } }],
  });
  const write = (state: unknown): string => {
    const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "toolchain.json");
    writeFileSync(path, JSON.stringify(state));
    return path;
  };

  assert.equal(loadFactoryState(write(withWitness({}))).ok, true, "a witness without one still loads");
  const carried = loadFactoryState(write(withWitness({ toolchain: "python3 3.14.7" })));
  assert.equal(carried.ok, true);
  if (carried.ok) {
    assert.equal(carried.state.packets[0].evidence?.witness?.toolchain, "python3 3.14.7");
  }
  for (const junk of [3.14, { python3: "3.14.7" }, ["python3"], null]) {
    assert.equal(
      loadFactoryState(write(withWitness({ toolchain: junk }))).ok,
      false,
      `toolchain: ${JSON.stringify(junk)} must not load`,
    );
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

test("a hand-edited state file with more in-flight packets than the cap is refused, not trusted", () => {
  // issue #34: the loader validated shapes only, so a drifted file with two concurrent in-flight
  // packets loaded happily even though the one-packet-in-flight invariant forbids it.
  const seed = seedState();
  assert.equal(seed.packets.filter((p) => p.status === "submitted").length, 1);
  const secondInflightId = seed.packets.find((p) => p.status === "merged")!.id;
  const packets = seed.packets.map((p) =>
    p.id === secondInflightId ? { ...p, status: "gated" as const, station: "freeze" as const } : p,
  );
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "overcap.json");
  writeFileSync(path, JSON.stringify({ ...seed, packets }));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.match(loaded.error, /in.flight/i);
  assert.match(loaded.error, /will not overwrite with seed/);
});

test("a state file at exactly the in-flight cap still loads", () => {
  const seed = seedState();
  assert.equal(seed.packets.filter((p) => p.status === "submitted").length, 1);
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "atcap.json");
  writeFileSync(path, JSON.stringify(seed));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true);
});
