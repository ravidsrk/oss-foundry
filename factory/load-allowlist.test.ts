import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalRepoId, isDenied, repoById } from "./allowlist.ts";
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
 * through `maySelectRepo` as "not on the allowlist" (issue #44 item 10). Deny is still checked
 * first in `maySelectRepo` — `engine.test.ts` pins that ordering, which this file cannot see.
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

/**
 * Loosening the match must be as visible as tightening it. Every negative above (`not/on-the-list`,
 * `Matplotlib/MatPlotLib`) also passes under a matcher that ignores the owner half entirely, so
 * none of them constrains looseness — a `repoById` comparing only the repo name would have kept the
 * suite green while making `attacker/orca-fleet` selectable. The allowlist is a **roster** gate, not
 * a name gate: owner and name are both load-bearing, and neither half alone is a match.
 */
test("the roster matches the whole id — a familiar name under a stranger's owner is not on it", () => {
  // Right name, wrong owner. This is the shape a typosquat or a fork takes.
  assert.equal(repoById("attacker/orca-fleet"), undefined);
  assert.equal(repoById("evil-corp/frontguard"), undefined);
  assert.equal(repoById("ColeMurray/orca-fleet"), undefined);
  // Right owner, wrong name — and a name that is on the roster under a different owner.
  assert.equal(repoById("ravidsrk/OpenHands"), undefined);
  assert.equal(repoById("ravidsrk/background-agents"), undefined);
  // Half an id is not an id.
  assert.equal(repoById("orca-fleet"), undefined);
  assert.equal(repoById("ravidsrk"), undefined);
  // Substrings do not match either way.
  assert.equal(repoById("ravidsrk/orca-fleet-2"), undefined);
  assert.equal(repoById("xravidsrk/orca-fleet"), undefined);

  // The denylist is a roster too, and refusing the wrong repo is as wrong as admitting one.
  assert.equal(isDenied("attacker/matplotlib"), undefined);
  assert.equal(isDenied("ravidsrk/curl"), undefined);

  // The control: the real ids still resolve, so the assertions above are not passing vacuously.
  assert.equal(repoById("ravidsrk/orca-fleet")?.id, "ravidsrk/orca-fleet");
  assert.equal(isDenied("matplotlib/matplotlib")?.id, "matplotlib/matplotlib");
});

/**
 * `canonicalRepoId` is the boundary conversion `applyHalt` and `buildPacket` run before they touch
 * any store keyed by repo id. Round 1 normalized the *lookup* and left the stores raw, which turned
 * a loud "not on the allowlist" refusal into a halt that reported success and banned nothing
 * (issue #44 item 10).
 */
test("canonicalRepoId resolves to the roster's spelling and leaves strangers alone", () => {
  assert.equal(canonicalRepoId("colemurray/background-agents"), "ColeMurray/background-agents");
  assert.equal(canonicalRepoId("COLEMURRAY/BACKGROUND-AGENTS"), "ColeMurray/background-agents");
  assert.equal(canonicalRepoId("ColeMurray/background-agents"), "ColeMurray/background-agents");
  assert.equal(canonicalRepoId("RavidSrk/Orca-Fleet"), "ravidsrk/orca-fleet");
  // Not on the roster: returned untouched, so callers that must refuse it still can.
  assert.equal(canonicalRepoId("matplotlib/matplotlib"), "matplotlib/matplotlib");
  assert.equal(canonicalRepoId("attacker/orca-fleet"), "attacker/orca-fleet");
});

/**
 * The config invariant and the runtime lookups must share one notion of "the same repo".
 * `assertAllowlist` compared raw strings while `repoById` / `isDenied` compare case-insensitively,
 * so a denylisted id could sit among `repos` under different casing and still load clean — leaving
 * `maySelectRepo`'s deny-first ordering as the only thing keeping it out (issue #44 item 10).
 */
test("a denylist id among repos fails assertion under any casing", () => {
  const yaml = readFileSync(new URL("../allowlist.yaml", import.meta.url), "utf8");
  const leaked = yaml.replace(
    "repos:\n",
    "repos:\n  - id: StablyAI/Orca\n    wave: 1\n    language: TS\n    aiPolicy: welcome\n    testCommand: true\n    maxFiles: 1\n    maxDiffLines: 1\n    sandbox: e2b\n    preferredLabels: []\n    firstIssues: []\n",
  );
  assert.notEqual(leaked, yaml, "fixture replace matched nothing");
  assert.throws(() => assertAllowlist(parseAllowlistYaml(leaked)), /leaked into repos: StablyAI\/Orca/);

  // Same for uniqueness: one repo listed twice under two spellings is one repo, listed twice.
  const twice = yaml.replace(
    "repos:\n",
    "repos:\n  - id: RavidSrk/Orca-Fleet\n    wave: 0\n    language: TS\n    aiPolicy: owner\n    testCommand: true\n    maxFiles: 1\n    maxDiffLines: 1\n    sandbox: host\n    preferredLabels: []\n    firstIssues: []\n",
  );
  assert.throws(() => assertAllowlist(parseAllowlistYaml(twice)), /duplicate repo/);
});
