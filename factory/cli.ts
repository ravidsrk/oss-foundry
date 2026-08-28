import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyAdvance,
  applyApprove,
  applyAttachDraft,
  applyAttachEvidence,
  applyReject,
  applyTick,
  hasInflight,
} from "./engine.ts";
import { DISCLOSURE } from "./neighbor.ts";
import { renderPrBody } from "./packet.ts";
import { draftPullPayload } from "./github-pr.ts";
import { health } from "./scorecard.ts";
import { seedState } from "./seed.ts";
import { foundryAttestedWave0Merges } from "./status.ts";
import type { EvidenceManifest, FactoryState } from "./types.ts";

const STATE_FILE = resolve(".foundry-state.json");

function loadState(): FactoryState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as FactoryState;
  } catch {
    return seedState();
  }
}

function saveState(state: FactoryState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function printStatus(state: FactoryState) {
  const inflight = state.packets.filter((p) =>
    ["gated", "frozen", "approved", "implementing", "reviewing", "draft-ready", "submitted"].includes(p.status),
  );
  console.log(`Foundry  packets=${state.packets.length} ticks=${state.ticksRun} attestedWave0=${foundryAttestedWave0Merges(state.packets)} inflight=${hasInflight(state.packets)}`);
  console.log(`humanApprovalsRemaining=${state.humanApprovalsRemaining} mergedTotal=${state.mergedTotal} bans=${state.bans}`);
  if (inflight.length) {
    console.log("in flight:");
    for (const p of inflight) {
      console.log(`  ${p.id}  ${p.status}  ${p.repoId}#${p.issueNumber}  ${p.prUrl ?? ""}`);
    }
  } else {
    console.log("in flight: none — tick is allowed");
  }
  console.log("scorecard:");
  for (const row of state.scorecard) {
    if (row.opened === 0 && row.merged === 0 && row.reverts === 0) continue;
    console.log(`  ${row.repoId}  opened=${row.opened} merged=${row.merged} tone=${row.maintainerTone} health=${health(row)}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  console.log(`Foundry operator loop

  status
  tick
  approve <packetId> --note <text>
  reject <packetId> --reason <text>
  advance <packetId>
  evidence <packetId> --base <sha> --head <sha> [--files N] [--diff N] [--test-exit 0] [--negative red-on-revert]
  body <packetId>
  attach-draft <packetId> <prUrl>

State: ${STATE_FILE} (seed if missing). Foundry never merges.
Disclosure:
${DISCLOSURE}
`);
  process.exit(0);
}

let state = loadState();

if (cmd === "status") {
  printStatus(state);
  process.exit(0);
}

if (cmd === "tick") {
  const result = applyTick(state);
  saveState(result.state);
  if (!result.packet) {
    console.log(result.reason);
    printStatus(result.state);
    process.exit(result.reason === "idle" || result.reason === "in-flight" ? 0 : 1);
  }
  console.log(`${result.packet.id}  ${result.packet.status}  ${result.packet.repoId}#${result.packet.issueNumber}  ${result.packet.policy.code}`);
  process.exit(0);
}

if (cmd === "approve") {
  const id = rest[0];
  if (!id) {
    console.error("approve requires a packet id");
    process.exit(1);
  }
  const result = applyApprove(state, id, flag(rest, "--note") ?? "");
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  saveState(result.state);
  console.log(`approved ${id}`);
  process.exit(0);
}

if (cmd === "reject") {
  const id = rest[0];
  if (!id) {
    console.error("reject requires a packet id");
    process.exit(1);
  }
  const result = applyReject(state, id, flag(rest, "--reason") ?? "operator reject");
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  saveState(result.state);
  console.log(`rejected ${id}`);
  process.exit(0);
}

if (cmd === "advance") {
  const id = rest[0];
  if (!id) {
    console.error("advance requires a packet id");
    process.exit(1);
  }
  const result = applyAdvance(state, id);
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  saveState(result.state);
  const p = result.state.packets.find((x) => x.id === id);
  console.log(`advanced ${id} → ${p?.status}`);
  process.exit(0);
}

if (cmd === "evidence") {
  const id = rest[0];
  const base = flag(rest, "--base");
  const head = flag(rest, "--head");
  if (!id || !base || !head) {
    console.error("evidence requires <id> --base <sha> --head <sha>");
    process.exit(1);
  }
  const packet = state.packets.find((p) => p.id === id);
  const evidence: EvidenceManifest = {
    baseSha: base,
    headSha: head,
    testCommand: packet ? (packet.evidence?.testCommand ?? "true") : "true",
    testExit: Number(flag(rest, "--test-exit") ?? 0),
    negativeControl: (flag(rest, "--negative") ?? "red-on-revert") as EvidenceManifest["negativeControl"],
    filesChanged: Number(flag(rest, "--files") ?? 1),
    diffLines: Number(flag(rest, "--diff") ?? 1),
    notes: ["attached via CLI"],
  };
  const result = applyAttachEvidence(state, id, evidence);
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  saveState(result.state);
  console.log(`evidence attached ${id}`);
  process.exit(0);
}

if (cmd === "body") {
  const id = rest[0];
  const packet = state.packets.find((p) => p.id === id);
  if (!packet) {
    console.error(`unknown packet ${id}`);
    process.exit(1);
  }
  const body = packet.prBody ?? renderPrBody(packet);
  console.log(body);
  const payload = draftPullPayload({
    title: packet.issueTitle,
    head: `foundry/issue-${packet.issueNumber}`,
    body,
  });
  console.log("---");
  console.log(`create payload draft=${payload.draft} (no merge helper)`);
  process.exit(0);
}

if (cmd === "attach-draft") {
  const id = rest[0];
  const url = rest[1];
  if (!id || !url) {
    console.error("attach-draft requires <id> <prUrl>");
    process.exit(1);
  }
  const result = applyAttachDraft(state, id, url);
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  saveState(result.state);
  console.log(`attached ${url}`);
  process.exit(0);
}

console.error(`unknown command ${cmd}`);
process.exit(1);
