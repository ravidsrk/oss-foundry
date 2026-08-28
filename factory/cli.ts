import { resolve } from "node:path";
import { ALLOWLIST, repoById } from "./allowlist.ts";
import {
  applyAdvance,
  applyApprove,
  applyAttachDraft,
  applyAttachEvidence,
  applyHalt,
  applyReject,
  applyPrSync,
  applyTick,
  bindingFromCompare,
  classifyCompetition,
  findCompetingPull,
  hasInflight,
  INFLIGHT_STATUSES,
  QUIET_RELEASE_DAYS,
  quietDaysOf,
} from "./engine.ts";
import {
  compareCommits,
  draftPullPayload,
  fetchRepoFile,
  listCrossReferencingOpenPulls,
  listOpenPulls,
  parsePrUrl,
  syncGithubPr,
} from "./github-pr.ts";
import type { LiveIssue } from "./github-scout.ts";
import { packetDivergences } from "./ledger-check.ts";
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
      const quiet = p.prMeta ? `  quiet=${quietDaysOf(p.prMeta, new Date().toISOString())}d/${QUIET_RELEASE_DAYS}` : "";
      console.log(`  ${p.id}  ${p.status}  ${p.repoId}#${p.issueNumber}  ${p.prUrl ?? ""}${quiet}`);
    }
  } else {
    console.log("in flight: none — tick is allowed");
  }
  const following = state.packets.filter((p) => p.status === "followed-up" && p.prMeta?.state === "open");
  for (const p of following) {
    console.log(
      `  following ${p.repoId}#${p.issueNumber}  quiet=${quietDaysOf(p.prMeta!, new Date().toISOString())}d  (maintainer activity re-blocks the tick)`,
    );
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
  const adjacentKeys: string[] = [];
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
      // Cheap path first: a closing-keyword hit in the already-fetched pulls settles "competing"
      // without spending a timeline call per issue.
      const keywordHit = findCompetingPull(pulls.pulls, issue.number, issue.url, repo.id);
      const crossRefs = keywordHit
        ? { ok: true as const, urls: [] as string[] }
        : await listCrossReferencingOpenPulls(repo.id, issue.number);
      if (!crossRefs.ok) {
        console.error(crossRefs.error);
        process.exit(1);
      }
      const verdict = classifyCompetition(
        { pulls: pulls.pulls, crossReferencedPullUrls: crossRefs.urls },
        issue.number,
        issue.url,
        repo.id,
      );
      if (verdict.kind === "competing") {
        console.error(`stand down ${key}: competing PR ${verdict.url} (${verdict.why})`);
        competingKeys.push(key);
        continue;
      }
      if (verdict.kind === "adjacent") {
        console.error(`hold ${key}: adjacent PR ${verdict.url} (${verdict.why}) — human triage before scouting`);
        adjacentKeys.push(key);
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
  return applyTick(state, live, competingKeys, adjacentKeys);
}

const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  console.log(`Foundry operator loop

  status
  tick
  approve <packetId> --note <text> [--by <name>]   (identity also via FOUNDRY_OPERATOR)
  reject <packetId> --reason <text>
  halt <repoId> --reason <text>
  advance <packetId>
  evidence <packetId> --base <sha> --head <sha> --test-exit <n> --negative <red-on-revert|pending|failed>
  body <packetId>
  attach-draft <packetId> <prUrl>
  sync <packetId> [--threads-answered]
  reconcile
  ledger

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
    const packetForFreeze = state.packets.find((p) => p.id === id);
    if (packetForFreeze && (packetForFreeze.status === "gated" || packetForFreeze.status === "frozen")) {
      const pulls = await listOpenPulls(packetForFreeze.repoId);
      if (!pulls.ok) {
        console.error(pulls.error);
        process.exit(1);
      }
      const crossRefs = findCompetingPull(
        pulls.pulls,
        packetForFreeze.issueNumber,
        packetForFreeze.issueUrl,
        packetForFreeze.repoId,
      )
        ? { ok: true as const, urls: [] as string[] }
        : await listCrossReferencingOpenPulls(packetForFreeze.repoId, packetForFreeze.issueNumber);
      if (!crossRefs.ok) {
        console.error(crossRefs.error);
        process.exit(1);
      }
      const verdict = classifyCompetition(
        { pulls: pulls.pulls, crossReferencedPullUrls: crossRefs.urls },
        packetForFreeze.issueNumber,
        packetForFreeze.issueUrl,
        packetForFreeze.repoId,
      );
      if (verdict.kind === "competing") {
        console.error(
          `stand down: competing PR ${verdict.url} (${verdict.why}) appeared on ${packetForFreeze.repoId}#${packetForFreeze.issueNumber} since gating. Reject or park — do not approve.`,
        );
        process.exit(1);
      }
      if (verdict.kind === "adjacent") {
        console.error(
          `taste gate: adjacent PR ${verdict.url} (${verdict.why}) mentions ${packetForFreeze.repoId}#${packetForFreeze.issueNumber}. You are the freeze — approve only if it does not cover the issue.`,
        );
      }
    }
    const result = applyApprove(
      state,
      id,
      flag(rest, "--note") ?? "",
      flag(rest, "--by") ?? process.env.FOUNDRY_OPERATOR ?? "operator",
    );
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
    const result = applyAttachEvidence(state, id, evidence, bindingFromCompare(compared));
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

  if (cmd === "reconcile") {
    let next = state;
    const doctrine: string[] = [];
    for (const packet of state.packets) {
      if (!packet.prUrl) continue;
      const synced = await syncGithubPr({ url: packet.prUrl });
      if (!synced.ok) {
        console.error(`${packet.id}: ${synced.error}`);
        process.exit(1);
      }
      const live = {
        state: synced.meta.state,
        merged: synced.meta.merged,
        draft: synced.meta.draft,
        headSha: synced.meta.headSha,
      };
      if (packet.status === "submitted" || packet.status === "followed-up") {
        // Mechanical absorption only: reconcile never attests threads answered, so it can
        // record merges/closes but never release the in-flight slot.
        const applied = applyPrSync(next, packet.id, synced.meta, { threadsAnswered: false });
        if (!applied.error) next = applied.state;
      }
      doctrine.push(...packetDivergences(next.packets.find((p) => p.id === packet.id)!, live));
    }
    saveFactoryState(STATE_FILE, next);
    for (const d of doctrine) console.error(`DIVERGENCE ${d}`);
    console.log(`reconciled ${state.packets.filter((p) => p.prUrl).length} packets; divergences=${doctrine.length}`);
    return;
  }

  if (cmd === "ledger") {
    // Emits the generated block for docs/12-ledger.md — paste between the GENERATED markers.
    const waves: [number, string][] = [[0, "Wave 0"], [1, "Wave 1"], [2, "Wave 2"]];
    for (const [wave, title] of waves) {
      const packets = state.packets.filter((p) => repoById(p.repoId)?.wave === wave);
      if (packets.length === 0) continue;
      console.log(`### ${title}`);
      console.log("");
      console.log("| packet | issue | PR | status | attested by |");
      console.log("|---|---|---|---|---|");
      for (const p of packets) {
        console.log(
          `| ${p.id} | [${p.repoId}#${p.issueNumber}](${p.issueUrl}) | ${p.prUrl ?? "—"} | ${p.status} | ${p.humanAttest?.by ?? "—"} |`,
        );
      }
      console.log("");
    }
    console.log(`Foundry-attested Wave 0 merges: ${foundryAttestedWave0Merges(state.packets)} (promotion gate: 2).`);
    console.log("");
    console.log("### Scorecard");
    console.log("");
    for (const row of state.scorecard) {
      if (row.opened === 0) continue;
      console.log(
        `- ${row.repoId}: opened=${row.opened} merged=${row.merged} closedUnmerged=${row.closedUnmerged} noReview=${row.noReview} tone=${row.maintainerTone}`,
      );
    }
    console.log(`- bans: ${state.bans}  mergedTotal: ${state.mergedTotal}`);
    return;
  }

  if (cmd === "sync") {
    const id = rest[0];
    if (!id) {
      console.error("sync requires a packet id");
      process.exit(1);
    }
    const packet = state.packets.find((p) => p.id === id);
    if (!packet || !packet.prUrl) {
      console.error(packet ? `packet ${id} has no PR to sync` : `unknown packet ${id}`);
      process.exit(1);
    }
    const synced = await syncGithubPr({ url: packet.prUrl });
    if (!synced.ok) {
      console.error(synced.error);
      process.exit(1);
    }
    // --threads-answered is the operator's attestation that every review thread has a reply.
    // Without it, quiet days accrue but the slot is never released.
    const result = applyPrSync(state, id, synced.meta, {
      threadsAnswered: rest.includes("--threads-answered"),
    });
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    saveFactoryState(STATE_FILE, result.state);
    const after = result.state.packets.find((p) => p.id === id);
    console.log(
      `synced ${id} → ${after?.status}  quiet=${quietDaysOf(synced.meta, new Date().toISOString())}d  draft=${synced.meta.draft} state=${synced.meta.state} merged=${synced.meta.merged}`,
    );
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
    const packetForDraft = state.packets.find((p) => p.id === id);
    if (packetForDraft) {
      const parsed = parsePrUrl(url)!;
      const pulls = await listOpenPulls(packetForDraft.repoId);
      const crossRefs = await listCrossReferencingOpenPulls(packetForDraft.repoId, packetForDraft.issueNumber);
      if (!pulls.ok || !crossRefs.ok) {
        console.error(!pulls.ok ? pulls.error : !crossRefs.ok ? crossRefs.error : "");
        process.exit(1);
      }
      const others = pulls.pulls.filter((p) => p.number !== parsed.number);
      const otherRefs = crossRefs.urls.filter((u) => parsePrUrl(u)?.number !== parsed.number);
      const verdict = classifyCompetition(
        { pulls: others, crossReferencedPullUrls: otherRefs },
        packetForDraft.issueNumber,
        packetForDraft.issueUrl,
        packetForDraft.repoId,
      );
      if (verdict.kind === "competing") {
        console.error(
          `stand down: competing PR ${verdict.url} (${verdict.why}) appeared on ${packetForDraft.repoId}#${packetForDraft.issueNumber}. Assist or park — do not attach.`,
        );
        process.exit(1);
      }
      if (verdict.kind === "adjacent") {
        console.error(
          `taste gate: adjacent PR ${verdict.url} (${verdict.why}) mentions ${packetForDraft.repoId}#${packetForDraft.issueNumber}. Proceeding — a human is at the keyboard; log the call in the ledger.`,
        );
      }
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
