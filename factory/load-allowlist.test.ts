import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertAllowlist, parseAllowlistYaml } from "./load-allowlist.ts";

test("committed allowlist.yaml parses and keeps denylist disjoint", () => {
  const parsed = parseAllowlistYaml(readFileSync(new URL("../allowlist.yaml", import.meta.url), "utf8"));
  assertAllowlist(parsed);
  assert.equal(parsed.denylist.some((d) => d.id === "stablyai/orca"), true);
  assert.equal(parsed.repos.some((r) => r.id === "stablyai/orca"), false);

  const pydantic = parsed.denylist.find((d) => d.id === "pydantic/pydantic");
  assert.ok(pydantic);
  assert.match(pydantic.reason, /mass-submitting/);
  assert.equal(/slop-PR close rate/i.test(pydantic.reason), false);

  const orca = parsed.denylist.find((d) => d.id === "stablyai/orca");
  assert.ok(orca);
  assert.match(orca.reason, /Conflict of interest/i);

  assert.equal(parsed.repos.some((r) => r.id === "OpenHands/OpenHands"), true);
  assert.equal(parsed.repos.some((r) => r.id === "All-Hands-AI/OpenHands"), false);
  assert.equal(parsed.repos.some((r) => r.id === "e2b-dev/e2b-cookbook"), true);
  assert.equal(parsed.repos.some((r) => r.id === "e2b-dev/E2B"), false);

  const ba = parsed.repos.find((r) => r.id === "ColeMurray/background-agents");
  assert.equal(ba?.aiPolicy, "undocumented-open");
  const copilot = parsed.repos.find((r) => r.id === "github/awesome-copilot");
  assert.match(copilot?.language ?? "", /JavaScript/);
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
    /(\n  - id: OpenHands\/OpenHands[\s\S]*?sandbox: )e2b/,
    "$1host",
  );
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
