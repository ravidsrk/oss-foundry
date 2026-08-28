import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { maySelectRepo } from "./engine.ts";
import { applySecondaryLimitHalt, clearFactoryHalt, factoryHalt } from "./halt.ts";
import { seedState } from "./seed.ts";
import { loadFactoryState, saveFactoryState } from "./state.ts";

function tmpStatePath() {
  return join(mkdtempSync(join(tmpdir(), "foundry-halt-")), "state.json");
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

test("an unreadable halt record fails closed", () => {
  const state = { ...seedState(), halt: { nonsense: true } } as unknown as ReturnType<
    typeof seedState
  >;
  const record = factoryHalt(state);
  assert.ok(record, "a halt record that cannot be read must still halt");
  assert.equal(maySelectRepo(state, "ravidsrk/orca-fleet").ok, false);
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
