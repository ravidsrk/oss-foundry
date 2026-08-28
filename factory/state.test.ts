import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
