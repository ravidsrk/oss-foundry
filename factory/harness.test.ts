import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmp } from "./tmp-dir.ts";
import {
  activeSubscriptions,
  agentChildEnv,
  credentialKind,
  FOUNDRY_APP_NAME,
  maskSecretsForMerge,
  OMP_CREDENTIAL_QUERY,
  parseOmpDefaultModel,
  planHarness,
  probeHarness,
  renderHarnessCheck,
  sandboxHarnessLines,
  SCRUBBED_AGENT_ENV_KEYS,
  whichOnPath,
} from "./harness.ts";
import { runSandboxDry } from "./sandbox.ts";
import { seedState } from "./seed.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(REPO_ROOT, "factory/cli.ts");
const HARNESS_SRC = join(REPO_ROOT, "factory/harness.ts");

function writeStore(
  home: string,
  rows: { provider: string; type: string; disabled?: string | null }[],
  config?: string,
): string {
  const agent = join(home, ".omp", "agent");
  mkdirSync(agent, { recursive: true });
  const dbPath = join(agent, "agent.db");
  const sql = [
    `CREATE TABLE auth_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      credential_type TEXT NOT NULL,
      data TEXT NOT NULL,
      disabled_cause TEXT
    );`,
    ...rows.map((row) => {
      const disabled = row.disabled == null ? "NULL" : `'${row.disabled.replaceAll("'", "''")}'`;
      return `INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause) VALUES ('${row.provider}', '${row.type}', 'test-fixture-not-a-secret', ${disabled});`;
    }),
  ].join("\n");
  const run = spawnSync("sqlite3", [dbPath], { input: sql, encoding: "utf8" });
  assert.equal(run.status, 0, `sqlite3 fixture failed: ${run.stderr}`);
  if (config !== undefined) writeFileSync(join(agent, "config.yml"), config);
  return dbPath;
}

function stubBin(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

test("credentialKind maps omp store types onto oauth / plan / api-key", () => {
  assert.equal(credentialKind("anthropic", "oauth"), "oauth");
  assert.equal(credentialKind("openai-codex", "oauth"), "oauth");
  assert.equal(credentialKind("xai-oauth", "oauth"), "oauth");
  assert.equal(credentialKind("kimi-code", "oauth"), "plan");
  assert.equal(credentialKind("zai", "oauth"), "plan");
  assert.equal(credentialKind("openrouter", "api_key"), "api-key");
});

test("parseOmpDefaultModel reads modelRoles.default and ignores sibling keys", () => {
  const yaml = [
    "providers:",
    "  webSearchOrder:",
    "    []",
    "modelRoles:",
    "  default: anthropic/claude-fable-5-1:max",
    "  task: xai-oauth/grok-4.6:xhigh",
    "theme:",
    "  dark: titanium",
  ].join("\n");
  assert.equal(parseOmpDefaultModel(yaml), "anthropic/claude-fable-5-1:max");
  assert.equal(parseOmpDefaultModel("theme:\n  dark: x\n"), undefined);
});

test("OMP_CREDENTIAL_QUERY never selects the token payload column", () => {
  assert.equal(
    OMP_CREDENTIAL_QUERY,
    "SELECT provider, credential_type, disabled_cause FROM auth_credentials",
  );
  assert.doesNotMatch(OMP_CREDENTIAL_QUERY, /\bdata\b/);
  const source = readFileSync(HARNESS_SRC, "utf8");
  const sql = [...source.matchAll(/"(SELECT[^"]*)"/g)].map((m) => m[1]);
  assert.ok(sql.length >= 1, "harness.ts must contain a SQL SELECT string");
  for (const query of sql) {
    assert.doesNotMatch(
      query,
      /\bdata\b/i,
      `SQL must not name the token payload column: ${query}`,
    );
  }
});

test("probeHarness reads provider ids from a fixture store and ignores disabled + api-key for billing", () => {
  const home = tmp("foundry-harness-home-");
  writeStore(
    home,
    [
      { provider: "anthropic", type: "oauth" },
      { provider: "openai-codex", type: "oauth" },
      { provider: "xai-oauth", type: "oauth" },
      { provider: "kimi-code", type: "oauth", disabled: "invalid_grant" },
      { provider: "openrouter", type: "api_key" },
    ],
    "modelRoles:\n  default: anthropic/claude-sonnet-4-6\n",
  );
  const bin = tmp("foundry-harness-bin-");
  const omp = stubBin(bin, "omp");
  const probe = probeHarness({ home, path: bin });
  assert.equal(probe.storeError, undefined, probe.storeError);
  assert.equal(probe.defaultModel, "anthropic/claude-sonnet-4-6");
  assert.deepEqual(
    probe.credentials.map((c) => `${c.provider}:${c.kind}:${c.active}`),
    [
      "anthropic:oauth:true",
      "openai-codex:oauth:true",
      "xai-oauth:oauth:true",
      "kimi-code:plan:false",
      "openrouter:api-key:true",
    ],
  );
  assert.deepEqual(
    activeSubscriptions(probe).map((c) => c.provider),
    ["anthropic", "openai-codex", "xai-oauth"],
  );
  assert.deepEqual(
    probe.clis.map((c) => c.name),
    ["omp"],
  );
  assert.equal(probe.clis[0]?.path, omp);
});

test("probeHarness on an empty HOME is a named gap, not a crash", () => {
  const home = tmp("foundry-harness-empty-");
  const probe = probeHarness({ home, path: "" });
  assert.match(probe.storeError ?? "", /absent/);
  assert.deepEqual(probe.credentials, []);
  assert.deepEqual(probe.clis, []);
});

test("agentChildEnv keeps HOME so omp can read the OAuth store, and drops PAT + API keys", () => {
  const env = agentChildEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/foundry-home",
    FOUNDRY_PAT: "ghp_should_never_leak",
    GITHUB_TOKEN: "ghs_also_secret",
    GH_TOKEN: "ghp_gh",
    E2B_API_KEY: "e2b_secret",
    ANTHROPIC_API_KEY: "sk-ant-planted",
    OPENAI_API_KEY: "sk-openai-planted",
    XAI_API_KEY: "xai-planted",
    NPM_TOKEN: "npm-planted",
    NOT_A_TOOLCHAIN_VAR: "unrelated",
  });
  assert.equal(env.HOME, "/tmp/foundry-home");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.OMP_APP_NAME, FOUNDRY_APP_NAME);
  assert.equal(env.FOUNDRY_PAT, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NOT_A_TOOLCHAIN_VAR, undefined);
  for (const key of SCRUBBED_AGENT_ENV_KEYS) {
    assert.equal(env[key], undefined, `${key} must be absent from the allowlist child, not empty`);
  }
});

test("maskSecretsForMerge overlays empty strings so a merge-style spawner cannot inherit the PAT", () => {
  const merged = maskSecretsForMerge({
    PATH: "/usr/bin",
    FOUNDRY_PAT: "ghp_should_never_leak",
    ANTHROPIC_API_KEY: "sk-ant-planted",
  });
  assert.equal(merged.PATH, "/usr/bin");
  assert.equal(merged.FOUNDRY_PAT, "");
  assert.equal(merged.ANTHROPIC_API_KEY, "");
  assert.equal(merged.GITHUB_TOKEN, "");
});

test("planHarness bills omp OAuth on Wave 0 host and refuses to run Wave 1+ here", () => {
  const home = tmp("foundry-harness-plan-");
  writeStore(home, [{ provider: "anthropic", type: "oauth" }], "modelRoles:\n  default: anthropic/claude-sonnet-4-6\n");
  const bin = tmp("foundry-harness-plan-bin-");
  stubBin(bin, "omp");
  const probe = probeHarness({ home, path: bin });
  const wave0 = planHarness({ wave: 0, sandbox: "host" }, probe);
  assert.equal(wave0.usable, true);
  assert.equal(wave0.via, "omp-oauth");
  assert.ok(wave0.argv.includes("--mode"));
  assert.ok(wave0.argv.includes("rpc"));
  assert.ok(wave0.argv.includes("--model"));
  assert.ok(wave0.argv.includes("anthropic/claude-sonnet-4-6"));
  assert.deepEqual(wave0.providers, ["anthropic"]);
  assert.match(wave0.reason, /FOUNDRY_PAT stays in Foundry/);

  const wave1 = planHarness({ wave: 1, sandbox: "e2b" }, probe);
  assert.equal(wave1.usable, false);
  assert.equal(wave1.via, "worker-host");
  assert.match(wave1.reason, /auth-gateway/);
  assert.match(wave1.reason, /FOUNDRY_PAT/);
});

test("planHarness without a subscription and without a host CLI is unusable, not a silent API-key path", () => {
  const home = tmp("foundry-harness-none-");
  writeStore(home, [{ provider: "openrouter", type: "api_key" }]);
  const probe = probeHarness({ home, path: "" });
  const plan = planHarness({ wave: 0, sandbox: "host" }, probe);
  assert.equal(plan.usable, false);
  assert.equal(plan.via, "unusable");
  assert.match(plan.reason, /coding-plan subscription/);
});

test("planHarness falls back to a logged-in host CLI when omp has no OAuth store", () => {
  const home = tmp("foundry-harness-cli-");
  const bin = tmp("foundry-harness-cli-bin-");
  stubBin(bin, "grok");
  const probe = probeHarness({ home, path: bin });
  const plan = planHarness({ wave: 0, sandbox: "host" }, probe);
  assert.equal(plan.usable, true);
  assert.equal(plan.via, "host-cli");
  assert.match(plan.reason, /grok/);
});

test("sandbox dry-run lines name the subscription contract and stay machine-independent", () => {
  const host = sandboxHarnessLines({ wave: 0, sandbox: "host" });
  assert.ok(host.some((l) => /omp --mode rpc/.test(l)));
  assert.ok(host.some((l) => /OAuth\/plan/.test(l)));
  assert.ok(host.some((l) => /FOUNDRY_PAT/.test(l)));
  assert.ok(
    host.every((l) => !l.includes("anthropic") && !l.includes("/Users/")),
    "stored dry-run lines must not enumerate this laptop's providers or HOME",
  );
  const e2b = sandboxHarnessLines({ wave: 1, sandbox: "e2b" });
  assert.ok(e2b.some((l) => /auth-gateway/.test(l)));
  assert.ok(e2b.every((l) => !/omp --mode rpc/.test(l)));
});

test("renderHarnessCheck names the billing path and the PAT split", () => {
  const home = tmp("foundry-harness-render-");
  writeStore(home, [
    { provider: "anthropic", type: "oauth" },
    { provider: "openrouter", type: "api_key" },
  ]);
  const bin = tmp("foundry-harness-render-bin-");
  stubBin(bin, "omp");
  const probe = probeHarness({ home, path: bin });
  const text = renderHarnessCheck(probe, [{ wave: 0, sandbox: "host" }]);
  assert.match(text, /usable via omp-oauth/);
  assert.match(text, /anthropic/);
  assert.match(text, /API key/);
  assert.match(text, /FOUNDRY_PAT/);
  assert.match(text, /auth-gateway/);
  assert.doesNotMatch(text, /test-fixture-not-a-secret/);
});

test("runSandboxDry on a Wave 0 host packet plans omp rpc, keeps dry-run, and never harvests", () => {
  const packet = seedState().packets.find((p) => p.repoId === "ravidsrk/orca-fleet");
  assert.ok(packet);
  const dry = runSandboxDry(packet);
  assert.equal(dry.status, "dry-run");
  assert.match(dry.image, /OAuth\/plan/);
  assert.ok(dry.commands.every((c) => c.exit === -1));
  assert.ok(dry.commands.some((c) => /omp --mode rpc/.test(c.cmd)));
  assert.ok(dry.commands.some((c) => /FOUNDRY_PAT/.test(c.cmd)));
  assert.ok(dry.commands.every((c) => c.cmd.startsWith("# planned · not executed ·")));
});

test("whichOnPath finds an executable stub and ignores a missing name", () => {
  const bin = tmp("foundry-harness-which-");
  const path = stubBin(bin, "omp");
  assert.equal(whichOnPath("omp", bin), path);
  assert.equal(whichOnPath("claude", bin), undefined);
});

test("harness-check is a CLI verb and reports a fixture store, not the operator's", () => {
  const home = tmp("foundry-harness-cli-home-");
  writeStore(
    home,
    [{ provider: "xai-oauth", type: "oauth" }],
    "modelRoles:\n  default: xai-oauth/grok-4.6:xhigh\n",
  );
  const bin = tmp("foundry-harness-cli-path-");
  stubBin(bin, "omp");
  const state = join(tmp("foundry-harness-cli-state-"), "state.json");
  writeFileSync(state, JSON.stringify(seedState(), null, 2));
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, "harness-check", "--state", state],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        HOME: home,
        PATH: bin,
      },
    },
  );
  const seen = `${run.stdout}${run.stderr}`;
  assert.equal(run.status, 0, seen);
  assert.match(run.stdout, /harness pre-flight/);
  assert.match(run.stdout, /xai-oauth/);
  assert.match(run.stdout, /usable via omp-oauth/);
  assert.match(run.stdout, /FOUNDRY_PAT/);
  assert.doesNotMatch(run.stdout, /test-fixture-not-a-secret/);
});
