import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmp } from "./tmp-dir.ts";
import { EVENT_RING_CAP, eventsDroppedOf, maySelectRepo } from "./engine.ts";
import { applySecondaryLimitHalt, clearFactoryHalt, factoryHalt } from "./halt.ts";
import { mintLedgerId } from "./ids.ts";
import { seedState } from "./seed.ts";
import { loadFactoryState, saveFactoryState } from "./state.ts";

function tmpStatePath() {
  return join(tmp("foundry-halt-"), "state.json");
}

test("a secondary-rate-limit halt survives the process that printed the banner", () => {
  const state = seedState();
  assert.equal(factoryHalt(state), undefined);
  assert.equal(maySelectRepo(state, "ravidsrk/orca-fleet").ok, true);

  const halted = applySecondaryLimitHalt(state, {
    repoId: "ColeMurray/background-agents",
    at: "2026-08-29T09:00:00.000Z",
  });

  // The next process reads the halt off disk — a console line would have evaporated with the exit.
  const path = tmpStatePath();
  saveFactoryState(path, halted);
  const reloaded = loadFactoryState(path);
  assert.equal(reloaded.ok, true);
  if (!reloaded.ok) return;
  assert.equal(reloaded.source, "file");

  const record = factoryHalt(reloaded.state);
  assert.ok(record);
  assert.equal(record.at, "2026-08-29T09:00:00.000Z");
  assert.match(record.reason, /secondary rate limit/i);
});

test("the halt stops the whole factory, not just the repo that hit the limit", () => {
  const halted = applySecondaryLimitHalt(seedState(), {
    repoId: "ColeMurray/background-agents",
    at: "2026-08-29T09:00:00.000Z",
  });
  for (const repoId of ["ColeMurray/background-agents", "ravidsrk/orca-fleet"]) {
    const gate = maySelectRepo(halted, repoId);
    assert.equal(gate.ok, false, `${repoId} must be refused while the factory is halted`);
    if (!gate.ok) assert.match(gate.reason, /halt/i);
  }
});

test("a malformed halt record is refused at load, not read defensively", () => {
  // `halt` is validated like every other field: the ledger refuses to load at all, so no command
  // runs until a human fixes the file. That is stricter than reading it fail-closed at use.
  for (const halt of [
    { nonsense: true },
    { at: "2026-08-29T09:00:00.000Z" },
    { at: 1, reason: "truncated", source: "secondary-rate-limit" },
    { at: "2026-08-29T09:00:00.000Z", reason: "wrong source", source: "maintainer-ask" },
    { at: "2026-08-29T09:00:00.000Z", reason: "bad repoId", source: "secondary-rate-limit", repoId: 7 },
    "halted",
    null,
  ]) {
    const path = tmpStatePath();
    writeFileSync(path, JSON.stringify({ ...seedState(), halt }, null, 2));
    const loaded = loadFactoryState(path);
    assert.equal(loaded.ok, false, `a malformed halt must refuse the ledger: ${JSON.stringify(halt)}`);
    if (!loaded.ok) assert.match(loaded.error, /refusing to load/);
  }

  // A well-formed halt still loads, and still halts.
  const good = tmpStatePath();
  saveFactoryState(
    good,
    applySecondaryLimitHalt(seedState(), {
      repoId: "ColeMurray/background-agents",
      at: "2026-08-29T09:00:00.000Z",
    }),
  );
  const loaded = loadFactoryState(good);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.ok(factoryHalt(loaded.state));
  assert.equal(maySelectRepo(loaded.state, "ravidsrk/orca-fleet").ok, false);
});

test("#88: two halt events in the same millisecond do not share an id", () => {
  const realNow = Date.now;
  Date.now = () => 1_787_981_801_727;
  try {
    const first = applySecondaryLimitHalt(seedState(), {
      repoId: "ColeMurray/background-agents",
      at: "2026-08-29T09:00:00.000Z",
    });
    const second = applySecondaryLimitHalt(first, {
      repoId: "ravidsrk/orca-fleet",
      at: "2026-08-29T09:00:00.001Z",
    });
    const haltIds = [first.events[0].id, second.events[0].id];
    assert.notEqual(haltIds[0], haltIds[1], `same-millisecond halt ids collided: ${haltIds.join(", ")}`);
    assert.match(haltIds[0], /^evt_halt_/);
    assert.match(haltIds[1], /^evt_halt_/);
    assert.notEqual(haltIds[0], mintLedgerId("evt_halt", 1_787_981_801_727, 0));
  } finally {
    Date.now = realNow;
  }
});

test("only a human clears the halt, and the ledger records who", () => {
  const halted = applySecondaryLimitHalt(seedState(), {
    repoId: "ColeMurray/background-agents",
    at: "2026-08-29T09:00:00.000Z",
  });
  const cleared = clearFactoryHalt(halted, "ravidsrk", "rate window elapsed; verified by hand");
  assert.equal(factoryHalt(cleared), undefined);
  assert.equal(maySelectRepo(cleared, "ravidsrk/orca-fleet").ok, true);
  assert.equal(
    cleared.events.some((e) => /ravidsrk/.test(e.message) && /halt/i.test(e.message)),
    true,
  );
});

test("a halt on a full event ring records the dropped event", () => {
  const seed = seedState();
  const full = {
    ...seed,
    events: Array.from({ length: EVENT_RING_CAP }, (_, i) => ({
      id: `evt_fill_${i}`,
      at: "2026-08-29T00:00:00.000Z",
      kind: "tick" as const,
      message: `fill ${i}`,
    })),
  };
  assert.equal(eventsDroppedOf(full), 0);
  const halted = applySecondaryLimitHalt(full, { repoId: "ColeMurray/background-agents" });
  assert.equal(halted.events.length, EVENT_RING_CAP);
  assert.equal(
    eventsDroppedOf(halted),
    1,
    "halt.ts must go through appendEvent so a drop on the factory-halt path is counted",
  );
});
