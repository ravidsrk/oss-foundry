import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import type { AllowlistedRepo, SandboxKind } from "./types.ts";
import { witnessChildEnv } from "./witness.ts";

const require = createRequire(import.meta.url);

/**
 * Subscription-backed implement harness, shaped after oh-my-pi/robomp.
 *
 * WHAT THIS IS. Wave 0 implement does not need `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
 * `E2B_API_KEY` in the operator shell. The operator already pays for coding-plan OAuth
 * (Claude Pro/Max, Codex ChatGPT, SuperGrok, Copilot, …). Those grants live in omp's
 * host store (`~/.omp/agent/agent.db`) or in a logged-in host CLI. The agent child
 * bills them. Foundry keeps `FOUNDRY_PAT` and opens the draft itself.
 *
 * WHAT THIS IS NOT. Foundry still does not run the coding agent (ADR 0001: execution
 * stays in orca-fleet `oss-contribute`; G-36: stations 4–5 are not a second playbook).
 * This module is the contract that worker — or the operator running `omp` by hand —
 * has to honour: which executable, which model, which env the child may see.
 *
 * TRUST SPLIT (robomp `python/robomp/src/worker.py` `_SCRUBBED_ENV_KEYS` + staged HOME):
 *   - Orchestrator (this CLI) holds `FOUNDRY_PAT`. GitHub writes go through `open-draft`.
 *   - Agent child gets {@link agentChildEnv}: the witness allowlist plus `OMP_APP_NAME`.
 *     It can read the OAuth store via `HOME=~/.omp/agent/agent.db`. It cannot see the PAT.
 *   - Wave 1+ does not run here (ADR 0003). The planned worker host talks to
 *     `omp auth-gateway` so the box never holds refresh tokens either.
 *
 * The credential `data` column is never selected. Provider ids and types are enough
 * to decide whether a subscription exists; the tokens stay in sqlite.
 */

/** Usage attribution the pi-native gateway forwards as `x-omp-app` (robomp sets `robomp`). */
export const FOUNDRY_APP_NAME = "foundry";

/**
 * Secrets that must not reach an agent subprocess. robomp overlays empty strings
 * because `omp_rpc.RpcClient` merges the overlay onto `os.environ`; a `delete`
 * on the parent would not mask the child's copy. Foundry's own spawn uses the
 * witness allowlist (keys absent, not empty). {@link maskSecretsForMerge} is the
 * overlay for a merge-style spawner so a future RpcClient cannot leak by inherit.
 */
export const SCRUBBED_AGENT_ENV_KEYS = [
  "FOUNDRY_PAT",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "E2B_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "NPM_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "OP_SERVICE_ACCOUNT_TOKEN",
] as const;

/**
 * Columns we are allowed to read from omp's `auth_credentials`. `data` holds the
 * refresh token / API key and is deliberately not in this list.
 */
export const OMP_CREDENTIAL_QUERY =
  "SELECT provider, credential_type, disabled_cause FROM auth_credentials";

/** Coding-plan OAuth providers (oh-my-pi `packages/ai/src/registry/oauth/`). */
const PLAN_PROVIDERS = new Set([
  "kimi",
  "kimi-code",
  "zai",
  "zai-coding-plan",
  "alibaba-coding-plan",
  "alibaba-token-plan",
  "minimax",
  "muse-code",
]);

export type CredentialKind = "oauth" | "plan" | "api-key";

export interface StoredCredential {
  provider: string;
  kind: CredentialKind;
  active: boolean;
}

export interface HostCli {
  name: "omp" | "claude" | "codex" | "grok";
  path: string;
}

export interface HarnessProbe {
  credentials: StoredCredential[];
  clis: HostCli[];
  defaultModel?: string;
  storePath?: string;
  storeError?: string;
}

export type HarnessVia = "omp-oauth" | "host-cli" | "unusable" | "worker-host";

export interface HarnessPlan {
  usable: boolean;
  via: HarnessVia;
  reason: string;
  executable?: string;
  argv: string[];
  model?: string;
  providers: string[];
  sandbox: SandboxKind;
  wave: number;
}

export function credentialKind(provider: string, credentialType: string): CredentialKind {
  if (credentialType === "api_key") return "api-key";
  if (PLAN_PROVIDERS.has(provider)) return "plan";
  return "oauth";
}

/**
 * Parse `modelRoles.default` from omp `config.yml` without a YAML library.
 * The file is small and the key we want is a single unquoted scalar.
 */
export function parseOmpDefaultModel(yaml: string): string | undefined {
  const lines = yaml.split(/\r?\n/);
  let inRoles = false;
  for (const line of lines) {
    if (/^modelRoles:\s*$/.test(line)) {
      inRoles = true;
      continue;
    }
    if (!inRoles) continue;
    if (/^\S/.test(line)) {
      inRoles = false;
      continue;
    }
    const match = line.match(/^\s+default:\s*(\S+)\s*$/);
    if (match) return match[1];
  }
  return undefined;
}

export function whichOnPath(
  name: string,
  pathEnv: string | undefined = process.env.PATH,
): string | undefined {
  if (!pathEnv) return undefined;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function rowsToCredentials(rows: Record<string, unknown>[]): StoredCredential[] {
  return rows.map((row) => {
    const provider = String(row.provider ?? "");
    const credentialType = String(row.credential_type ?? "");
    const disabled = row.disabled_cause;
    return {
      provider,
      kind: credentialKind(provider, credentialType),
      active: disabled === null || disabled === undefined || disabled === "",
    };
  });
}

function readViaNodeSqlite(dbPath: string): StoredCredential[] | undefined {
  try {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (
        path: string,
        opts?: { readOnly?: boolean },
      ) => {
        prepare(sql: string): { all: () => Record<string, unknown>[] };
        close(): void;
      };
    };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return rowsToCredentials(db.prepare(OMP_CREDENTIAL_QUERY).all());
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * `sqlite3` is the Node 22.10 floor path: `node:sqlite` still needs
 * `--experimental-sqlite` there. A harness-check child whose PATH is only a
 * stub bin (the CLI test, a locked-down worker) must still find the binary.
 */
const SQLITE3_CANDIDATES = [
  "sqlite3",
  "/usr/bin/sqlite3",
  "/opt/homebrew/bin/sqlite3",
  "/usr/local/bin/sqlite3",
];

function readViaSqlite3(dbPath: string): StoredCredential[] | undefined {
  for (const bin of SQLITE3_CANDIDATES) {
    const run = spawnSync(bin, ["-json", dbPath, OMP_CREDENTIAL_QUERY], {
      encoding: "utf8",
    });
    if (run.status !== 0) continue;
    try {
      const parsed = JSON.parse(run.stdout || "[]") as Record<string, unknown>[];
      if (!Array.isArray(parsed)) continue;
      return rowsToCredentials(parsed);
    } catch {
      continue;
    }
  }
  return undefined;
}

function readOmpStore(agentDir: string): {
  credentials: StoredCredential[];
  error?: string;
} {
  const dbPath = join(agentDir, "agent.db");
  if (!existsSync(dbPath)) {
    return { credentials: [], error: `absent (${dbPath})` };
  }
  const fromNode = readViaNodeSqlite(dbPath);
  if (fromNode !== undefined) return { credentials: fromNode };
  const fromCli = readViaSqlite3(dbPath);
  if (fromCli !== undefined) return { credentials: fromCli };
  return {
    credentials: [],
    error: `unreadable (${dbPath}) — need node:sqlite or sqlite3; never copies the data column`,
  };
}

export interface ProbeOptions {
  home?: string;
  path?: string;
}

/**
 * Look at this machine the way robomp looks at the host: omp's OAuth store and
 * the coding-plan CLIs on PATH. Never reads credential payloads.
 */
export function probeHarness(opts: ProbeOptions = {}): HarnessProbe {
  const home = opts.home ?? process.env.HOME ?? "";
  const pathEnv = opts.path ?? process.env.PATH;
  const agentDir = join(home, ".omp", "agent");
  const storePath = join(agentDir, "agent.db");
  const { credentials, error } = home ? readOmpStore(agentDir) : { credentials: [], error: "HOME is unset" };
  let defaultModel: string | undefined;
  const configPath = join(agentDir, "config.yml");
  if (existsSync(configPath)) {
    try {
      defaultModel = parseOmpDefaultModel(readFileSync(configPath, "utf8"));
    } catch {
      // An unreadable config is not a missing store; model stays unnamed.
    }
  }
  const clis: HostCli[] = [];
  for (const name of ["omp", "claude", "codex", "grok"] as const) {
    const path = whichOnPath(name, pathEnv);
    if (path) clis.push({ name, path });
  }
  return {
    credentials,
    clis,
    defaultModel,
    storePath: home ? storePath : undefined,
    storeError: error,
  };
}

export function activeSubscriptions(probe: HarnessProbe): StoredCredential[] {
  return probe.credentials.filter((c) => c.active && c.kind !== "api-key");
}

/**
 * The env an implementer agent (omp / claude / grok / codex) runs under.
 *
 * Allowlist, not denylist: same contract as {@link witnessChildEnv} (issue #114, G-02)
 * plus `OMP_APP_NAME=foundry`. HOME is on the allowlist on purpose — omp reads
 * `~/.omp/agent/agent.db` from it. Provider API keys and `FOUNDRY_PAT` are not.
 */
export function agentChildEnv(
  from: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const env = witnessChildEnv(from);
  env.OMP_APP_NAME = FOUNDRY_APP_NAME;
  return env;
}

/**
 * robomp-style overlay: empty strings for every scrubbed name, so a spawner that
 * merges onto `process.env` cannot leak the parent's PAT or API keys.
 */
export function maskSecretsForMerge(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of SCRUBBED_AGENT_ENV_KEYS) {
    out[key] = "";
  }
  return out;
}

export function planHarness(
  repo: Pick<AllowlistedRepo, "wave" | "sandbox"> | undefined,
  probe: HarnessProbe,
): HarnessPlan {
  const wave = repo?.wave ?? 1;
  const sandbox: SandboxKind = repo?.sandbox ?? "e2b";
  if (!(sandbox === "host" && wave === 0)) {
    return {
      usable: false,
      via: "worker-host",
      reason:
        `${sandbox} execution runs on the worker host, not in this CLI (ADR 0003). Route model calls through omp auth-gateway; do not copy agent.db or FOUNDRY_PAT into the box.`,
      argv: [],
      providers: [],
      sandbox,
      wave,
    };
  }
  const subs = activeSubscriptions(probe);
  const omp = probe.clis.find((c) => c.name === "omp");
  const model = probe.defaultModel;
  if (omp && subs.length > 0) {
    const argv = [
      omp.path,
      "--mode",
      "rpc",
      "--cwd",
      "<worktree>",
      "--session-dir",
      "<session>",
      "--no-title",
    ];
    if (model) argv.push("--model", model);
    return {
      usable: true,
      via: "omp-oauth",
      reason: `Wave 0 host implement bills omp OAuth/plan (${unique(subs.map((s) => s.provider)).join(", ")}); FOUNDRY_PAT stays in Foundry.`,
      executable: omp.path,
      argv,
      model,
      providers: unique(subs.map((s) => s.provider)),
      sandbox,
      wave,
    };
  }
  const hostCli = probe.clis.find((c) => c.name !== "omp");
  if (hostCli) {
    return {
      usable: true,
      via: "host-cli",
      reason: `Wave 0 host implement uses the logged-in ${hostCli.name} CLI (that CLI's own subscription). Exact flags are the CLI's; GitHub writes stay in Foundry.`,
      executable: hostCli.path,
      argv: [hostCli.path, "-p", "<packet prompt>"],
      providers: unique(subs.map((s) => s.provider)),
      sandbox,
      wave,
    };
  }
  return {
    usable: false,
    via: "unusable",
    reason:
      "no active OAuth/plan subscription in ~/.omp/agent/agent.db and no claude/codex/grok CLI on PATH — contributions cannot bill a coding-plan subscription on this machine",
    argv: [],
    providers: [],
    sandbox,
    wave,
  };
}

/**
 * Deterministic dry-run lines stored on the packet. Must not enumerate this
 * machine's providers — `applyAdvance` has to be test-stable across CI and
 * laptops. {@link probeHarness} / `harness-check` is the machine-specific half.
 */
export function sandboxHarnessLines(repo: Pick<AllowlistedRepo, "wave" | "sandbox"> | undefined): string[] {
  const wave = repo?.wave ?? 1;
  const sandbox: SandboxKind = repo?.sandbox ?? "e2b";
  if (sandbox === "host" && wave === 0) {
    return [
      "omp --mode rpc --cwd <worktree> --session-dir <session> --model <omp default> --no-title  # bills host OAuth/plan subscriptions, not provider API keys",
      "child env: witness allowlist + OMP_APP_NAME=foundry; FOUNDRY_PAT, GITHUB_TOKEN, GH_TOKEN, E2B_API_KEY, provider API keys absent",
    ];
  }
  return [
    `${sandbox} worker host: route model calls through omp auth-gateway; do not copy ~/.omp/agent/agent.db or FOUNDRY_PAT into the box`,
  ];
}

export function renderHarnessCheck(
  probe: HarnessProbe,
  repos: Pick<AllowlistedRepo, "wave" | "sandbox">[],
): string {
  const lines: string[] = [
    "harness pre-flight — how Wave 0 implement bills on THIS machine",
    "trust split: agent child never sees FOUNDRY_PAT / GITHUB_TOKEN / provider API keys",
    "GitHub writes stay in Foundry (open-draft). Model calls bill host OAuth/plan subscriptions.",
    "",
  ];
  if (!probe.storePath) {
    lines.push("omp store: HOME is unset — cannot locate ~/.omp/agent/agent.db");
  } else if (probe.storeError) {
    lines.push(`omp store: ${probe.storeError}`);
  } else {
    lines.push(`omp store: ${probe.storePath}`);
  }
  if (probe.credentials.length === 0) {
    lines.push("  (no credentials) — run `omp login` for Claude / Codex / SuperGrok");
  } else {
    const width = Math.max(...probe.credentials.map((c) => c.provider.length), 8);
    for (const cred of probe.credentials) {
      const status = cred.active ? "active" : "disabled";
      const extra = cred.kind === "api-key" ? "  (API key — not a coding-plan subscription; not the default billing path)" : "";
      lines.push(`  ${cred.provider.padEnd(width)}  ${cred.kind.padEnd(7)}  ${status}${extra}`);
    }
  }
  lines.push("");
  lines.push(`default model: ${probe.defaultModel ?? "(none in ~/.omp/agent/config.yml)"}`);
  lines.push("");
  lines.push("host CLIs:");
  if (probe.clis.length === 0) {
    lines.push("  (none of omp, claude, codex, grok on PATH)");
  } else {
    for (const cli of probe.clis) {
      lines.push(`  ${cli.name.padEnd(7)}  ${cli.path}`);
    }
  }
  lines.push("");
  const hostRepos = repos.filter((r) => r.sandbox === "host" && r.wave === 0);
  const plan = planHarness(hostRepos[0] ?? { wave: 0, sandbox: "host" }, probe);
  lines.push(`Wave 0 host implement: ${plan.usable ? `usable via ${plan.via}` : `not usable (${plan.via})`}`);
  lines.push(`  ${plan.reason}`);
  if (plan.argv.length) {
    lines.push(`  ${plan.argv.join(" ")}`);
  }
  if (plan.providers.length) {
    lines.push(`  bills: ${plan.providers.join(", ")}`);
  }
  lines.push("");
  lines.push(
    "Wave 1+ (e2b/daytona): not executed here (ADR 0003). Worker host; secrets never enter the box.",
  );
  lines.push("  Point the box at omp auth-gateway; do not copy agent.db or FOUNDRY_PAT into the sandbox.");
  return lines.join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
