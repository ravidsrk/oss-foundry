import { repoById } from "./allowlist.ts";
import type { SandboxSession, TaskPacket } from "./types.ts";

function now() {
  return new Date().toISOString();
}

export function planSandbox(packet: TaskPacket): SandboxSession {
  const repo = repoById(packet.repoId);
  const provider = repo?.sandbox ?? "e2b";
  const hostOk = provider === "host" && (repo?.wave ?? 1) === 0;
  return {
    provider: hostOk ? "host" : provider === "daytona" ? "daytona" : "e2b",
    id: `sbx_${packet.id}`,
    status: "dry-run",
    image: hostOk
      ? "host-worktree (Wave 0 only)"
      : "e2b/code-interpreter · fresh · no secrets",
    commands: [],
  };
}

export function runSandboxDry(packet: TaskPacket): SandboxSession {
  const base = planSandbox(packet);
  const repo = repoById(packet.repoId);
  const cmds = [
    `git clone https://github.com/${packet.repoId}.git  # full clone — historical SHAs must be reachable`,
    repo?.testCommand ?? "true",
    "git diff --stat",
    "harvest patch via git format-patch / git push to fork",
    "destroy sandbox · secrets never entered the box",
  ];
  return {
    ...base,
    status: "dry-run",
    commands: cmds.map((cmd) => ({
      cmd: `# planned · not executed · ${cmd}`,
      exit: -1,
      at: now(),
    })),
  };
}

export const SANDBOX_RULES = [
  "Wave 0 (own repos) may use a host worktree. Everything else is E2B or Daytona.",
  "No GitHub App private key, no npm tokens, no SSH keys inside the box.",
  "Clone is full (historical SHAs must be reachable). Network is allowlisted to git + package registries.",
  "Harvest is git-only: format-patch or push to the operator fork. Then destroy.",
  // `reject` is the operator's verb; `parked` is a status the engine writes on its own (over-cap
  // scope, a scorecard halt, a policy denial). Doctrine that reads as an instruction must name a
  // button the operator actually has (issue #44 item 5).
  "If tests cannot run in the box, reject the packet. Do not skip the oracle.",
];
