import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isDenied, repoById } from "./allowlist.ts";
import { assertAllowlist, parseAllowlistYaml } from "./load-allowlist.ts";

test("committed allowlist.yaml parses and keeps denylist disjoint", () => {
  const parsed = parseAllowlistYaml(readFileSync(new URL("../allowlist.yaml", import.meta.url), "utf8"));
  assertAllowlist(parsed);
  assert.equal(parsed.denylist.some((d) => d.id === "stablyai/orca"), true);
  assert.equal(parsed.repos.some((r) => r.id === "stablyai/orca"), false);
});

test("omitted wave is not coerced to Wave 0 host-trusted", () => {
  const yaml = readFileSync(new URL("../allowlist.yaml", import.meta.url), "utf8");
  const missing = yaml.replace(
    "  - id: ravidsrk/frontguard\n    wave: 0\n    language: TypeScript",
    "  - id: ravidsrk/frontguard\n    wave:\n    language: TypeScript",
  );
  assert.throws(() => parseAllowlistYaml(missing), /missing wave/);
});

test("Wave 2 host sandbox is rejected at load", () => {
  const yaml = readFileSync(new URL("../allowlist.yaml", import.meta.url), "utf8");
  const host = yaml.replace(
    "  - id: OpenHands/OpenHands\n    wave: 2\n    language: Python\n    aiPolicy: human-required\n    testCommand: poetry run pytest\n    maxFiles: 3\n    maxDiffLines: 140\n    sandbox: e2b",
    "  - id: OpenHands/OpenHands\n    wave: 2\n    language: Python\n    aiPolicy: human-required\n    testCommand: poetry run pytest\n    maxFiles: 3\n    maxDiffLines: 140\n    sandbox: host",
  );
  assert.notEqual(host, yaml, "fixture replace matched nothing — committed entry drifted from this test");
  const parsed = parseAllowlistYaml(host);
  assert.throws(() => assertAllowlist(parsed), /Wave 1\+ repo OpenHands\/OpenHands must not use host sandbox/);
});

test("a denylist id among repos fails assertion", () => {
  const yaml = readFileSync(new URL("../allowlist.yaml", import.meta.url), "utf8");
  const leaked = yaml.replace(
    "repos:\n",
    "repos:\n  - id: stablyai/orca\n    wave: 1\n    language: TS\n    aiPolicy: welcome\n    testCommand: true\n    maxFiles: 1\n    maxDiffLines: 1\n    sandbox: e2b\n    preferredLabels: []\n    firstIssues: []\n",
  );
  const parsed = parseAllowlistYaml(leaked);
  assert.throws(() => assertAllowlist(parsed), /leaked into repos: stablyai\/orca/);
});

/**
 * The two roster lookups must agree on casing. `isDenied` lowercased both sides; `repoById`
 * compared raw strings, so a live path carrying GitHub's own casing rather than the YAML's fell
 * through `maySelectRepo` as "not on the allowlist". That fails *closed*, so it was never
 * exploitable — but a gate whose two halves disagree is a gate held up by the accident that live
 * paths happen to echo the file. Normalize both (issue #44 item 10). Deny is still checked first
 * in `maySelectRepo`, so the denylist keeps winning under any casing.
 */
test("allowlist and denylist lookups agree on casing", () => {
  assert.equal(isDenied("matplotlib/matplotlib")?.id, "matplotlib/matplotlib");
  assert.equal(isDenied("Matplotlib/MatPlotLib")?.id, "matplotlib/matplotlib");

  assert.equal(repoById("ravidsrk/orca-fleet")?.id, "ravidsrk/orca-fleet");
  assert.equal(repoById("RavidSrk/Orca-Fleet")?.id, "ravidsrk/orca-fleet");
  assert.equal(repoById("OPENHANDS/OPENHANDS")?.id, "OpenHands/OpenHands");

  assert.equal(repoById("not/on-the-list"), undefined);
  assert.equal(isDenied("not/on-the-list"), undefined);
  // A denied repo must not become findable on the allowlist just because casing changed.
  assert.equal(repoById("Matplotlib/MatPlotLib"), undefined);
});
