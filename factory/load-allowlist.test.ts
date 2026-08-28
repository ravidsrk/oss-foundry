import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertAllowlist, parseAllowlistYaml } from "./load-allowlist.ts";

test("committed allowlist.yaml parses and keeps denylist disjoint", () => {
  const parsed = parseAllowlistYaml(readFileSync(new URL("../allowlist.yaml", import.meta.url), "utf8"));
  assertAllowlist(parsed);
  assert.equal(parsed.denylist.some((d) => d.id === "stablyai/orca"), true);
  assert.equal(parsed.repos.some((r) => r.id === "stablyai/orca"), false);
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
