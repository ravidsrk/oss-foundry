import { resolve } from "node:path";
import { ALLOWLIST, repoById } from "./allowlist.ts";
import {
  applyAdvance,
  applyApprove,
  applyAttachDraft,
  applyAttachEvidence,
  applyHalt,
  applyReject,
  applyTick,
  findCompetingPull,
  hasInflight,
  INFLIGHT_STATUSES,
} from "./engine.ts";
import {
  compareCommits,
  draftPullPayload,
  fetchRepoFile,
  listOpenPulls,
  parsePrUrl,
  syncGithubPr,
} from "./github-pr.ts";
import type { LiveIssue } from "./github-scout.ts";
import { DISCLOSURE } from "./neighbor.ts";
import { renderPrBody } from "./packet.ts";
import { health } from "./scorecard.ts";
import { loadFactoryState, saveFactoryState } from "./state.ts";
import { foundryAttestedWave0Merges } from "./status.ts";
import type { EvidenceManifest } from "./types.ts";

const STATE_FILE = resolve(".foundry-state.json");

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function mustLoad() {
  const loaded = loadFactoryState(STATE_FILE);
  if (!loaded.ok) {
    console.error(loaded.error);
    process.exit(1);
  }
  return loaded.state;
}

function printStatus(state: ReturnType<typeof mustLoad>) {
  const inflight = state.packets.filter((p) => INFLIGHT_STATUSES.includes(p.status));
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

async function tickWithGithub(state: ReturnType<typeof mustLoad>) {
  if (hasInflight(state.packets)) return applyTick(state);
  const competingKeys: string[] = [];
  const live: LiveIssue[] = [];
  for (const repo of ALLOWLIST) {
    if (repo.firstIssues.length === 0) continue;
    const pulls = await listOpenPulls(repo.id);
    if (!pulls.ok) {
      console.error(pulls.error);
      process.exit(1);
    }
    const agentsMd = await fetchRepoFile(repo.id, "AGENTS.md");
    const contributing =
      (await fetchRepoFile(repo.id, "CONTRIBUTING.md")) ??
      (await fetchRepoFile(repo.id, ".github/CONTRIBUTING.md"));
    for (const issue of repo.firstIssues) {
      const key = `${repo.id}#${issue.number}`;
      if (findCompetingPull(pulls.pulls, issue.number, issue.url, repo.id)) {
        competingKeys.push(key);
        continue;
      }
      live.push({
        repoId: repo.id,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        labels: repo.preferredLabels,
        daysOld: 0,
        scout: { total: 0, parts: { wave: 0, labels: 0, size: 0, freshness: 0 } },
        agentsMd,
        contributing,
      });
    }
  }
  return applyTick(state, live, competingKeys);
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  console.log(`Foundry operator loop

  status
  tick
  approve <packetId> --note <text>
  reject <packetId> --reason <text>
  halt <repoId> --reason <text>
  advance <packetId>
  evidence <packetId> --base <sha> --head <sha> --test-exit <n> --negative <red-on-revert|pending|failed>
  body <packetId>
  attach-draft <packetId> <prUrl>

State: ${STATE_FILE} (seed if missing; refuse if present but malformed). Foundry never merges.
Disclosure:
${DISCLOSURE}
`);
  process.exit(0);
}

async function main() {
  const state = mustLoad();

  if (cmd === "status") {
    printStatus(state);
    return;
  }

  if (cmd === "tick") {
    const result = await tickWithGithub(state);
    saveFactoryState(STATE_FILE, result.state);
    if (!result.packet) {
      console.log(result.reason);
      printStatus(result.state);
      process.exit(result.reason === "idle" || result.reason === "in-flight" ? 0 : 1);
    }
    console.log(`${result.packet.id}  ${result.packet.status}  ${result.packet.repoId}#${result.packet.issueNumber}  ${result.packet.policy.code}`);
    return;
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
    saveFactoryState(STATE_FILE, result.state);
    console.log(`approved ${id}`);
    return;
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
    saveFactoryState(STATE_FILE, result.state);
    console.log(`rejected ${id}`);
    return;
  }

  if (cmd === "halt") {
    const repoId = rest[0];
    if (!repoId) {
      console.error("halt requires a repo id (owner/name)");
      process.exit(1);
    }
    const result = applyHalt(state, repoId, flag(rest, "--reason") ?? "maintainer asked the factory to stop.");
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    saveFactoryState(STATE_FILE, result.state);
    console.log(`halted ${repoId} (scorecard banned). Edit allowlist.yaml denylist the same hour.`);
    return;
  }

  if (cmd === "advance") {
    const id = rest[0];
    if (!id) {
      console.error("advance requires a packet id");
      process.exit(1);
    }
    const result = applyAdvance(state, id);
    if (result.error) {
      const parked = result.state.packets.find((p) => p.id === id)?.status === "parked";
      if (parked) saveFactoryState(STATE_FILE, result.state);
      console.error(result.error);
      process.exit(1);
    }
    saveFactoryState(STATE_FILE, result.state);
    const p = result.state.packets.find((x) => x.id === id);
    console.log(`advanced ${id} → ${p?.status}`);
    return;
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
    if (!packet) {
      console.error(`unknown packet ${id}`);
      process.exit(1);
    }
    const testExitRaw = flag(rest, "--test-exit");
    const negative = flag(rest, "--negative");
    if (testExitRaw === undefined || negative === undefined) {
      console.error(
        "evidence requires --test-exit <n> and --negative <red-on-revert|pending|failed> (no success defaults)",
      );
      process.exit(1);
    }
    if (negative !== "red-on-revert" && negative !== "pending" && negative !== "failed") {
      console.error("invalid --negative");
      process.exit(1);
    }
    const compared = await compareCommits(packet.repoId, base, head);
    if (!compared.ok) {
      console.error(compared.error);
      process.exit(1);
    }
    const evidence: EvidenceManifest = {
      baseSha: base,
      headSha: head,
      testCommand: repoById(packet.repoId)?.testCommand ?? packet.evidence?.testCommand ?? "",
      testExit: Number(testExitRaw),
      negativeControl: negative,
      filesChanged: compared.filesChanged,
      diffLines: compared.diffLines,
      notes: ["attached via CLI"],
    };
    if (!evidence.testCommand) {
      console.error("no testCommand for this repo");
      process.exit(1);
    }
    const result = applyAttachEvidence(state, id, evidence, {
      fastForward: compared.aheadBy >= 1,
      messages: compared.messages,
      filesChanged: compared.filesChanged,
      diffLines: compared.diffLines,
    });
    if (result.error) {
      const parked = result.state.packets.find((p) => p.id === id)?.status === "parked";
      if (parked) saveFactoryState(STATE_FILE, result.state);
      console.error(result.error);
      process.exit(1);
    }
    saveFactoryState(STATE_FILE, result.state);
    console.log(`evidence attached ${id}`);
    return;
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
    return;
  }

  if (cmd === "attach-draft") {
    const id = rest[0];
    const url = rest[1];
    if (!id || !url) {
      console.error("attach-draft requires <id> <prUrl>");
      process.exit(1);
    }
    if (!parsePrUrl(url)) {
      console.error("Not a GitHub pull request URL.");
      process.exit(1);
    }
    const synced = await syncGithubPr({ url });
    if (!synced.ok) {
      console.error(synced.error);
      process.exit(1);
    }
    const result = applyAttachDraft(state, id, url, {
      draft: synced.meta.draft,
      headSha: synced.meta.headSha,
      title: synced.title,
      body: synced.body,
    });
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    saveFactoryState(STATE_FILE, result.state);
    console.log(`attached ${url} (draft=${synced.meta.draft})`);
    return;
  }

  console.error(`unknown command ${cmd}`);
  process.exit(1);
}

await main();
