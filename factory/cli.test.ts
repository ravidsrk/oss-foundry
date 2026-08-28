import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { applySecondaryLimitHalt } from "./halt.ts";
import { seedState } from "./seed.ts";
import type { FactoryState } from "./types.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = resolve(REPO_ROOT, "factory/cli.ts");

function runCli(args: string[], cwd: string): { code: number; stdout: string; out: string } {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return { code: run.status ?? 1, stdout: run.stdout, out: `${run.stdout}${run.stderr}` };
}

function writeState(state: FactoryState): string {
  const path = join(mkdtempSync(join(tmpdir(), "foundry-cli-")), "state.json");
  writeFileSync(path, JSON.stringify(state, null, 2));
  return path;
}

test("the state path is anchored to the repo root, not the cwd", () => {
  const fromRoot = runCli(["status"], REPO_ROOT);
  const fromElsewhere = runCli(["status"], tmpdir());
  const line = (out: string) => out.split("\n").find((l) => l.startsWith("state:"));
  assert.equal(fromRoot.code, 0);
  assert.equal(fromElsewhere.code, 0);
  assert.equal(
    line(fromRoot.stdout)?.startsWith(`state: ${resolve(REPO_ROOT, ".foundry-state.json")}`),
    true,
    `unexpected state line: ${line(fromRoot.stdout)}`,
  );
  assert.equal(line(fromElsewhere.stdout), line(fromRoot.stdout));
});

test("a seed-backed run says so instead of presenting the seed as live truth", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "foundry-cli-")), "absent.json");
  const seeded = runCli(["status", "--state", missing], tmpdir());
  assert.equal(seeded.code, 0);
  assert.match(seeded.out, /no state file/i);
  assert.match(seeded.out, /committed seed/i);

  const live = runCli(["status", "--state", writeState(seedState())], tmpdir());
  assert.equal(live.code, 0);
  assert.equal(/no state file/i.test(live.out), false);
});

test("status warns when the live state file has drifted from the committed seed", () => {
  const seed = seedState();
  const drifted: FactoryState = {
    ...seed,
    packets: seed.packets.map((p) =>
      p.status === "submitted" ? { ...p, status: "followed-up" as const } : p,
    ),
  };
  const out = runCli(["status", "--state", writeState(drifted)], tmpdir()).out;
  assert.match(out, /SEED DRIFT/);
  assert.match(out, /followed-up/);

  const clean = runCli(["status", "--state", writeState(seed)], tmpdir()).out;
  assert.equal(/SEED DRIFT/.test(clean), false);
});

test("a halt written by an earlier run refuses open-draft before any GitHub call", () => {
  const seed = seedState();
  const readyToOpen: FactoryState = {
    ...seed,
    packets: seed.packets.map((p) =>
      p.status === "submitted"
        ? {
            ...p,
            status: "draft-ready" as const,
            station: "draft" as const,
            prUrl: undefined,
            prMeta: undefined,
          }
        : p,
    ),
  };
  const halted = applySecondaryLimitHalt(readyToOpen, {
    repoId: "ColeMurray/background-agents",
    at: "2026-08-29T09:00:00.000Z",
  });
  const id = "pkt_ColeMurray_background-agents_1476";
  const result = runCli(
    ["open-draft", id, "--head", "ravidsrk:foundry/issue-1476", "--state", writeState(halted)],
    tmpdir(),
  );
  assert.equal(result.code, 1);
  assert.match(result.out, /halt/i);
  assert.equal(/GitHub \d\d\d/.test(result.out), false, "must refuse before contacting GitHub");
});
