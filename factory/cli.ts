import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  evidenceBindingViolation,
  isBoundSha,
  findCompetingPull,
  hasInflight,
  issueStandDownReason,
  maySelectRepo,
  QUIET_RELEASE_DAYS,
  quietDaysOf,
  repliesOwed,
} from "./engine.ts";
import {
  compareCommits,
  createDraftPull,
  draftPullPayload,
  fetchIssueClosingRef,
  fetchIssueState,
  fetchRepoFile,
  listCrossReferencingOpenPulls,
  listOpenPulls,
  parsePrUrl,
  syncGithubPr,
  type IssueLiveState,
} from "./github-pr.ts";
import type { LiveIssue } from "./github-scout.ts";
import {
  applySecondaryLimitHalt,
  clearFactoryHalt,
  factoryHalt,
  SECONDARY_LIMIT_BANNER,
} from "./halt.ts";
import { packetChecks, seedDivergences } from "./ledger-check.ts";
import { DISCLOSURE } from "./neighbor.ts";
import { renderEvidencePage, renderPrBody } from "./packet.ts";
import { health } from "./scorecard.ts";
import { seedState } from "./seed.ts";
import { loadFactoryState, saveFactoryState } from "./state.ts";
import { foundryAttestedWave0Merges, ledgerSections, quietLabel } from "./status.ts";
import { INFLIGHT_STATUSES, type EvidenceManifest, type EvidenceWitness, type FactoryState } from "./types.ts";
import {
  hostRunner,
  parseWitnessManifest,
  resolveToolchain,
  toolchainLabel,
  verifyWitnessLogs,
  witnessEvidence,
  type WitnessLogs,
} from "./witness.ts";

/**
 * The sha256 on the evidence page is only proof if the maintainer can recompute it. Write the two
 * run logs at the repo-root-relative paths the witness names, so the digest is checkable on disk.
 * `root` exists so this is drivable against a scratch tree instead of the operator's checkout.
 */
export function persistWitnessLogs(
  witness: EvidenceWitness,
  logs: WitnessLogs,
  root = ".",
): void {
  for (const [path, text] of [
    [witness.testLogPath, logs.test],
    [witness.revertLogPath, logs.revert],
  ] as const) {
    const full = resolve(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(resolve(path), "utf8");
  } catch {
    return undefined;
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

const ARGV = process.argv.slice(2);
// The ledger belongs to the repository, not to whatever directory the operator happened to be in.
// A cwd-relative path silently served the committed seed as live truth from anywhere else, and a
// mutating command forked a second state file next to it.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATE_FILE_FLAG = flag(ARGV, "--state");
const STATE_FILE = resolve(STATE_FILE_FLAG ?? resolve(REPO_ROOT, ".foundry-state.json"));

/**
 * Every ledger write goes through here so a test can never make one to the repo root.
 *
 * Anchoring `STATE_FILE` took away the isolation that spawned-CLI tests were getting for free from
 * a temp cwd: with the path fixed to the repo root, a test that forgets `--state` reads and writes
 * the developer's real ledger, and the damage lands in whichever *other* test file reads it next —
 * far from the test that caused it. The refusal is deliberately at the write and not at the load,
 * because reading the default path is a legitimate thing for a test to assert (that is how the
 * anchoring itself is proven); it is the mutation that leaks. `NODE_TEST_CONTEXT` is set by
 * `node --test` and inherited by spawned children, so this is inert for a real operator.
 */
function persist(state: FactoryState): void {
  if (!STATE_FILE_FLAG && process.env.NODE_TEST_CONTEXT) {
    console.error(
      `refusing to write the repo-root ledger ${STATE_FILE} from a test run — pass \`--state <tmpfile>\` to every spawned CLI so the test cannot mutate real state.`,
    );
    process.exit(1);
  }
  saveFactoryState(STATE_FILE, state);
}

function mustLoad() {
  const loaded = loadFactoryState(STATE_FILE);
  if (!loaded.ok) {
    console.error(loaded.error);
    process.exit(1);
  }
  if (loaded.source === "seed") {
    console.error(
      `no state file at ${STATE_FILE} — showing the committed seed ledger, not live state. Mutating commands will create it.`,
    );
  }
  const halted = factoryHalt(loaded.state);
  if (halted) {
    console.error(`FACTORY HALTED ${halted.at}: ${halted.reason}`);
  }
  return { state: loaded.state, source: loaded.source };
}

function printStatus(state: FactoryState, source: "file" | "seed") {
  console.log(`state: ${STATE_FILE}${source === "seed" ? " (absent — committed seed)" : ""}`);
  // The clock verifies the committed seed, never this file (docs/08-operations.md). This is the
  // only place the operator is told the two have parted company.
  if (source === "file") {
    for (const d of seedDivergences(state, seedState())) console.log(`SEED DRIFT ${d}`);
  }
  const inflight = state.packets.filter((p) => INFLIGHT_STATUSES.includes(p.status));
  console.log(`Foundry  packets=${state.packets.length} ticks=${state.ticksRun} attestedWave0=${foundryAttestedWave0Merges(state.packets)} inflight=${hasInflight(state.packets)}`);
  console.log(`humanApprovalsRemaining=${state.humanApprovalsRemaining} mergedTotal=${state.mergedTotal} bans=${state.bans}`);
  if (inflight.length) {
    console.log("in flight:");
    for (const p of inflight) {
      const quiet = p.prMeta
        ? `  ${quietLabel(quietDaysOf(p.prMeta, new Date().toISOString()), QUIET_RELEASE_DAYS, p.prMeta)}`
        : "";
      console.log(`  ${p.id}  ${p.status}  ${p.repoId}#${p.issueNumber}  ${p.prUrl ?? ""}${quiet}`);
    }
  } else {
    console.log("in flight: none — tick is allowed");
  }
  const following = state.packets.filter((p) => p.status === "followed-up" && p.prMeta?.state === "open");
  // The re-block is conditional, so the line must be too: `applyPrSync` reclaims `submitted` only
  // when the slot is free. While a newer packet holds it, maintainer activity records a reply owed
  // and the packet stays `followed-up` — printing "re-blocks the tick" there is simply false.
  const slotHeld = hasInflight(state.packets);
  for (const p of following) {
    const rule = slotHeld
      ? "(slot held — maintainer activity records a reply owed, it does not re-block the tick)"
      : "(maintainer activity re-blocks the tick)";
    console.log(
      `  following ${p.repoId}#${p.issueNumber}  quiet=${quietDaysOf(p.prMeta!, new Date().toISOString())}d  ${rule}`,
    );
    // A reply owed re-blocks nothing and closes no thread, so nothing else nags about it: this is
    // the operator-facing surface for it. Same "proceed but say so out loud" duty as reject.
    for (const owed of repliesOwed(p)) {
      console.log(
        `    reply owed: ${owed.url ?? p.prUrl ?? ""} — maintainer activity ${owed.at.slice(0, 10)} arrived while another packet held the slot; answer it by hand`,
      );
    }
  }
  console.log("scorecard:");
  for (const row of state.scorecard) {
    if (row.opened === 0 && row.merged === 0 && row.reverts === 0) continue;
    console.log(`  ${row.repoId}  opened=${row.opened} merged=${row.merged} tone=${row.maintainerTone} health=${health(row)}`);
  }
}

/**
 * The closing commit or pull request, read only when there is a refusal to enrich (issue #40).
 *
 * Calling `fetchIssueClosingRef` unconditionally would spend a timeline request on every open issue
 * at every gate, which is the opposite of the point: the reference exists for the refusal message,
 * and an open issue has no refusal message. On the path where it IS spent, the issue was already
 * refused and the timeline call the tick would have made for competing work is skipped — so the
 * closed case costs no more requests than the open one.
 */
async function closingRefFor(
  issue: IssueLiveState,
  target: { repoId: string; issueNumber: number },
): Promise<string | undefined> {
  if (issue.state === "open") return undefined;
  return fetchIssueClosingRef(target.repoId, target.issueNumber);
}

async function tickWithGithub(state: FactoryState) {
  if (hasInflight(state.packets)) return applyTick(state);
  const competingKeys: string[] = [];
  const adjacentKeys: string[] = [];
  const closedIssues: { key: string; reason: string }[] = [];
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
      // Is the target still open at all? First, ahead of the competing-work classification, for
      // two reasons: it is the more decisive fact (a closed issue needs no competitor to be
      // unscoutable), and refusing here short-circuits the per-issue timeline call below — so a
      // closed row costs FEWER requests than it does today, not more. The added cost is one GET
      // per named `firstIssues` row on the rows that are still open; `allowlist.yaml` names four.
      const liveIssue = await fetchIssueState(repo.id, issue.number);
      if (!liveIssue.ok) {
        // Fail closed, exactly like the two reads either side of it: "GitHub would not say" is not
        // "the issue is open".
        console.error(liveIssue.error);
        process.exit(1);
      }
      const target = { repoId: repo.id, issueNumber: issue.number };
      const standDown = issueStandDownReason(target, liveIssue.issue, await closingRefFor(liveIssue.issue, target));
      if (standDown) {
        // The reason names the issue itself, so the prefix does not repeat it — unlike the
        // competing/adjacent lines below, whose verdicts carry only a PR url.
        console.error(`stand down: ${standDown}`);
        closedIssues.push({ key, reason: standDown });
        continue;
      }
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
  return applyTick(state, live, competingKeys, adjacentKeys, closedIssues);
}

const [cmd, ...rest] = ARGV;

/**
 * Kept inside `main()` rather than at module scope: this used to `console.log` + `process.exit(0)`
 * on import, which made the module impossible to import from anywhere — including a test.
 */
function usage(): void {
  console.log(`Foundry operator loop

  status
  tick
  approve <packetId> --note <text> [--by <name>]   (identity also via FOUNDRY_OPERATOR)
  reject <packetId> --reason <text>
  halt <repoId> --reason <text>   (per-repo scorecard stop — a maintainer asked; NOT cleared by clear-halt)
  advance <packetId>
  evidence <packetId> --base <sha> --head <sha>   (tests + revert control run in the sandbox — witnessed, never attested; host/Wave 0 only)
  witness-check [repoId]   (pre-flight: resolve the interpreter each allowlisted testCommand would really use here, before a packet is in flight)
  attach-witness <packetId> --manifest <path>   (ingest a witness produced on the worker host; provenance and log hashes re-checked here)
  body <packetId>
  attach-draft <packetId> <prUrl>
  open-draft <packetId> --head <forkOwner:branch>   (machine-account PAT; draft-only; one create per run)
  sync <packetId> [--threads-answered]
  reconcile
  ledger
  evidence-page <packetId>   (maintainer-facing audit page, markdown to stdout)
  clear-halt --by <name> --note <text>   (a human lifts the factory-wide rate-limit halt — not the halt above)

Any command takes --state <path> to point at a different ledger.
State: ${STATE_FILE} (seed if missing; refuse if present but malformed). Foundry never merges.
Disclosure:
${DISCLOSURE}
`);
}

async function main() {
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }
  const { state, source } = mustLoad();

  if (cmd === "status") {
    printStatus(state, source);
    return;
  }

  if (cmd === "clear-halt") {
    const halted = factoryHalt(state);
    if (!halted) {
      console.error("the factory is not halted");
      process.exit(1);
    }
    const by = flag(rest, "--by") ?? process.env.FOUNDRY_OPERATOR ?? "operator";
    persist(clearFactoryHalt(state, by, flag(rest, "--note") ?? ""));
    console.log(`halt from ${halted.at} cleared by ${by}`);
    return;
  }

  if (cmd === "tick") {
    const result = await tickWithGithub(state);
    persist(result.state);
    if (!result.packet) {
      console.log(result.reason);
      printStatus(result.state, source);
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
      // SPEC.md §4: the approval step re-checks for competing upstream work and stands down rather
      // than proceed. An issue closed since gating is the strongest form of that — the work is
      // already done or explicitly unwanted — and it is invisible to the open-PR half of the
      // re-check. A check at selection alone would not catch it: the tick that gated this packet
      // may have run days ago.
      const liveIssue = await fetchIssueState(packetForFreeze.repoId, packetForFreeze.issueNumber);
      if (!liveIssue.ok) {
        console.error(liveIssue.error);
        process.exit(1);
      }
      const standDown = issueStandDownReason(packetForFreeze, liveIssue.issue, await closingRefFor(liveIssue.issue, packetForFreeze));
      if (standDown) {
        // Refuse, do not park: `reject` is the operator's verb and a closed issue can be reopened.
        // The freeze is the human's, so the refusal hands the decision back rather than making it.
        console.error(`stand down: ${standDown} Reject or leave it gated — do not approve.`);
        process.exit(1);
      }
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
    persist(result.state);
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
    // Reject still succeeds (it is the documented halt-everything path) but it does not go quiet:
    // an abandoned live PR is named on the terminal, not only in parkReason and the event log.
    if (result.warning) console.error(result.warning);
    persist(result.state);
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
    persist(result.state);
    // Echo the roster's spelling, not the operator's: a halt typed in GitHub's casing now moves the
    // row it names, and the line must say which row that was (issue #44 item 10).
    console.log(`halted ${result.repoId ?? repoId} (scorecard banned). Edit allowlist.yaml denylist the same hour.`);
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
      if (parked) persist(result.state);
      console.error(result.error);
      process.exit(1);
    }
    persist(result.state);
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
    const repo = repoById(packet.repoId);
    if (!repo?.testCommand) {
      console.error("no testCommand for this repo");
      process.exit(1);
    }
    if (!isBoundSha(base) || !isBoundSha(head)) {
      console.error("evidence requires full 40-hex commit SHAs for --base and --head (no refs, no placeholders) — refusing before any clone or test run");
      process.exit(1);
    }
    const compared = await compareCommits(packet.repoId, base, head);
    if (!compared.ok) {
      console.error(compared.error);
      process.exit(1);
    }
    // The binding is decidable right here, from messages already in hand, and the gate will refuse
    // on it anyway — so refusing after the clone and both test runs threw away several seconds of
    // genuinely green witness work at a string check (issue #42). Pre-check, like the 40-hex SHA
    // guard above, and before the progress line so the terminal narrates no clone it will not do.
    const unbound = evidenceBindingViolation(packet, compared.messages);
    if (unbound) {
      console.error(unbound);
      process.exit(1);
    }
    // Only the host path clones anything. On a sandboxed repo `witnessEvidence` refuses on the very
    // next line without touching the network, so promising a clone here described work that never
    // happened — the operator's terminal is a claim surface like any other.
    const range = `${packet.repoId} ${base.slice(0, 7)}..${head.slice(0, 7)}`;
    console.error(
      repo.sandbox === "host"
        ? `witnessing ${range} (host) — cloning and running \`${repo.testCommand}\` twice`
        : `witnessing ${range} (${repo.sandbox}) — this CLI does not run ${repo.sandbox} sandboxes; checking whether it can witness at all`,
    );
    const outcome = await witnessEvidence(
      {
        packetId: packet.id,
        repoId: packet.repoId,
        baseSha: base,
        headSha: head,
        testCommand: repo.testCommand,
        setupCommand: repo.setupCommand,
        sandbox: repo.sandbox,
        wave: repo.wave,
      },
      hostRunner,
      process.env,
    );
    if (!outcome.ok) {
      console.error(outcome.error);
      process.exit(1);
    }
    const evidence: EvidenceManifest = {
      baseSha: base,
      headSha: head,
      testCommand: repo.testCommand,
      testExit: outcome.witness.testExit,
      negativeControl: outcome.witness.revertExit !== 0 ? "red-on-revert" : "failed",
      filesChanged: compared.filesChanged,
      diffLines: compared.diffLines,
      notes: [`witnessed via CLI (${outcome.witness.provider}); logs sha256 ${outcome.witness.testLogSha.slice(0, 12)}/${outcome.witness.revertLogSha.slice(0, 12)} kept at ${outcome.witness.testLogPath} and ${outcome.witness.revertLogPath}`],
      witness: outcome.witness,
    };
    const result = applyAttachEvidence(state, id, evidence, bindingFromCompare(compared));
    if (result.error) {
      const parked = result.state.packets.find((p) => p.id === id)?.status === "parked";
      if (parked) persist(result.state);
      console.error(result.error);
      process.exit(1);
    }
    // Only now: a refusal above must not leave two orphan logs on disk with no ledger entry
    // pointing at them, which is exactly what a maintainer would later fail to recompute.
    persistWitnessLogs(outcome.witness, outcome.logs);
    persist(result.state);
    console.log(`evidence attached ${id}`);
    return;
  }

  if (cmd === "witness-check") {
    // The pre-flight issue #41 asked for. Its whole value is being runnable with nothing in
    // flight: the alternative is learning at evidence time that this machine's `python3` is 3.9.6,
    // from a refusal that reads exactly like a broken patch.
    const repoArg = rest[0] && !rest[0].startsWith("--") ? rest[0] : undefined;
    const named = repoArg ? repoById(repoArg) : undefined;
    if (repoArg && !named) {
      console.error(
        `${repoArg} is not on the allowlist — witness-check resolves only repos the factory may see (allowlist.yaml)`,
      );
      process.exit(1);
    }
    const repos = named ? [named] : ALLOWLIST;
    console.log("witness pre-flight — what the `evidence` verb would run on THIS machine");
    console.log("shell: bash -c (non-login, non-interactive; inherits this process's environment)");
    // Said out loud because it is the one way this report can be wrong: the witness resolves
    // inside the clone, where a repo that pins its interpreter selects its own.
    console.log(
      "resolved in this working directory; a repo that pins its interpreter (.python-version, .tool-versions, .nvmrc) may select a different one inside the clone — the witness records what it actually used",
    );
    for (const repo of repos) {
      console.log("");
      console.log(`${repo.id}  wave ${repo.wave}  sandbox ${repo.sandbox}`);
      if (repo.setupCommand) console.log(`  setupCommand: ${repo.setupCommand}`);
      console.log(`  testCommand: ${repo.testCommand}`);
      if (repo.sandbox !== "host") {
        // Resolving OUR python3 for a Wave-1 e2b repo would be a confident report about a machine
        // this process has never seen. ADR 0003 keeps those runs off the host; so does this.
        console.log(
          `  not resolved here: ${repo.sandbox === "e2b" ? "an" : "a"} ${repo.sandbox} repo's suite runs on the worker host, not this machine (ADR 0003) — witness there and ingest with \`attach-witness\``,
        );
        continue;
      }
      const resolved = await resolveToolchain(repo.testCommand, hostRunner);
      for (const tool of resolved) {
        console.log(
          tool.path
            ? `  ${tool.tool}  ${tool.path}  ${tool.version ?? "no version reported"}`
            : `  ${tool.tool}  NOT FOUND on this machine's PATH  —  the witness would die at head with no output`,
        );
      }
      const label = toolchainLabel(resolved);
      console.log(`  toolchain a witness from here would record: ${label || "(none resolved)"}`);
    }
    return;
  }

  if (cmd === "attach-witness") {
    const id = rest[0];
    const manifestPath = flag(rest, "--manifest");
    if (!id || !manifestPath) {
      console.error("attach-witness requires <packetId> --manifest <path>");
      process.exit(1);
    }
    const packet = state.packets.find((p) => p.id === id);
    if (!packet) {
      console.error(`unknown packet ${id}`);
      process.exit(1);
    }
    const repo = repoById(packet.repoId);
    if (!repo?.testCommand) {
      console.error("no testCommand for this repo");
      process.exit(1);
    }
    const raw = readIfPresent(manifestPath);
    if (raw === undefined) {
      console.error(`cannot read witness manifest ${manifestPath}`);
      process.exit(1);
    }
    const parsed = parseWitnessManifest(raw, packet.id);
    if (!parsed.ok) {
      console.error(parsed.error);
      process.exit(1);
    }
    const { witness, testCommand, notes } = parsed.manifest;
    if (testCommand !== repo.testCommand) {
      console.error(
        `witness ran \`${testCommand}\`, but ${repo.id}'s oracle is \`${repo.testCommand}\` — a different command is not this repo's evidence`,
      );
      process.exit(1);
    }
    // The hashes must cover logs that exist here, or the digest on the evidence page proves nothing.
    const logs = verifyWitnessLogs(witness, readIfPresent);
    if (!logs.ok) {
      console.error(logs.error);
      process.exit(1);
    }
    console.error(
      `ingesting ${witness.provider} witness for ${packet.repoId} ${witness.baseSha.slice(0, 7)}..${witness.headSha.slice(0, 7)} — log hashes recomputed from disk; verifying the range upstream`,
    );
    const compared = await compareCommits(packet.repoId, witness.baseSha, witness.headSha);
    if (!compared.ok) {
      console.error(compared.error);
      process.exit(1);
    }
    const evidence: EvidenceManifest = {
      baseSha: witness.baseSha,
      headSha: witness.headSha,
      testCommand,
      testExit: witness.testExit,
      negativeControl: witness.revertExit !== 0 ? "red-on-revert" : "failed",
      filesChanged: compared.filesChanged,
      diffLines: compared.diffLines,
      notes: [
        `ingested ${witness.provider} witness produced ${witness.ranAt}; logs sha256 ${witness.testLogSha.slice(0, 12)}/${witness.revertLogSha.slice(0, 12)} recomputed from ${witness.testLogPath} and ${witness.revertLogPath}`,
        ...notes,
      ],
      witness,
    };
    const result = applyAttachEvidence(state, id, evidence, bindingFromCompare(compared));
    if (result.error) {
      const parked = result.state.packets.find((p) => p.id === id)?.status === "parked";
      if (parked) persist(result.state);
      console.error(result.error);
      process.exit(1);
    }
    persist(result.state);
    console.log(`witness ingested ${id} (${witness.provider})`);
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

  if (cmd === "open-draft") {
    const id = rest[0];
    const head = flag(rest, "--head");
    if (!id || !head) {
      console.error("open-draft requires <packetId> --head <forkOwner:branch>");
      process.exit(1);
    }
    const packet = state.packets.find((p) => p.id === id);
    if (!packet) {
      console.error(`unknown packet ${id}`);
      process.exit(1);
    }
    // Refuse before any GitHub call: a persisted halt (SPEC.md §6) must stop the retry, not
    // discover it after another request has already gone out.
    const gate = maySelectRepo(state, packet.repoId);
    if (!gate.ok) {
      console.error(`refusing to open a draft on ${packet.repoId}: ${gate.reason}`);
      process.exit(1);
    }
    if (packet.status !== "draft-ready" || packet.prUrl) {
      console.error(`open-draft needs a draft-ready packet with no PR; ${id} is ${packet.status}${packet.prUrl ? ` with ${packet.prUrl}` : ""}`);
      process.exit(1);
    }
    // The moment of contact (SPEC.md §6), and the last one that can still be taken back. The gate
    // at tick cannot cover this: an issue can close while a packet is in flight, and by here the
    // implementation, the review and the witness are all already spent. Refusing costs that work;
    // proceeding costs a maintainer's attention on a PR nobody needs, which is what
    // docs/02-good-neighbor.md rule 8 stands down for. Before the create, so a closed issue never
    // becomes a write.
    const liveIssue = await fetchIssueState(packet.repoId, packet.issueNumber);
    if (!liveIssue.ok) {
      console.error(liveIssue.error);
      process.exit(1);
    }
    const issueStandDown = issueStandDownReason(packet, liveIssue.issue, await closingRefFor(liveIssue.issue, packet));
    if (issueStandDown) {
      console.error(`stand down: ${issueStandDown} Reject or park — do not open.`);
      process.exit(1);
    }
    const pulls = await listOpenPulls(packet.repoId);
    const crossRefs = pulls.ok
      ? findCompetingPull(pulls.pulls, packet.issueNumber, packet.issueUrl, packet.repoId)
        ? { ok: true as const, urls: [] as string[] }
        : await listCrossReferencingOpenPulls(packet.repoId, packet.issueNumber)
      : pulls;
    if (!pulls.ok || !crossRefs.ok) {
      console.error(!pulls.ok ? pulls.error : (crossRefs as { error: string }).error);
      process.exit(1);
    }
    const verdict = classifyCompetition(
      { pulls: pulls.pulls, crossReferencedPullUrls: crossRefs.urls },
      packet.issueNumber,
      packet.issueUrl,
      packet.repoId,
    );
    if (verdict.kind === "competing") {
      console.error(`stand down: competing PR ${verdict.url} (${verdict.why}). Assist or park — do not open.`);
      process.exit(1);
    }
    if (verdict.kind === "adjacent") {
      console.error(`taste gate: adjacent PR ${verdict.url} (${verdict.why}) — you are the human; open only if it does not cover the issue.`);
    }
    const body = packet.prBody ?? renderPrBody(packet);
    if (!body.includes(DISCLOSURE)) {
      console.error("refusing to open: the PR body does not carry the verbatim disclosure block");
      process.exit(1);
    }
    const created = await createDraftPull(packet.repoId, {
      title: packet.issueTitle,
      head,
      body,
    });
    if (!created.ok) {
      if (created.halt) {
        // The banner is for the human at the keyboard; the ledger write is what stops the next run.
        console.error(SECONDARY_LIMIT_BANNER);
        persist(applySecondaryLimitHalt(state, { repoId: packet.repoId, detail: created.error }));
        console.error(`halt recorded in ${STATE_FILE} — clear it with \`clear-halt\` once a human has checked.`);
      }
      console.error(created.error);
      process.exit(1);
    }
    console.log(`opened draft ${created.url}`);
    const synced = await syncGithubPr({ url: created.url });
    if (!synced.ok) {
      console.error(`draft opened but sync failed (${synced.error}) — run: attach-draft ${id} ${created.url}`);
      process.exit(1);
    }
    const attached = applyAttachDraft(state, id, created.url, {
      draft: synced.meta.draft,
      headSha: synced.meta.headSha,
      title: synced.title,
      body: synced.body,
    });
    if (attached.error) {
      console.error(`draft opened but not recorded (${attached.error}) — run: attach-draft ${id} ${created.url}`);
      process.exit(1);
    }
    persist(attached.state);
    console.log(`attached ${created.url} (draft=${synced.meta.draft}) — packet submitted`);
    return;
  }

  if (cmd === "reconcile") {
    let next = state;
    const doctrine: string[] = [];
    const owed: string[] = [];
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
      const checks = packetChecks(next.packets.find((p) => p.id === packet.id)!, live);
      doctrine.push(...checks.fatal);
      owed.push(...checks.advisory);
    }
    persist(next);
    // Same split, same words as the clock (`verify-ledger.ts`): a ledger that contradicts GitHub is
    // a DIVERGENCE, a debt on a ledger that already reconciles is an ADVISORY. `reconcile` gates on
    // neither — it reports so the operator can act — but calling a re-witness debt a divergence
    // here and not there would teach two different meanings for one word.
    for (const a of owed) console.error(`ADVISORY ${a}`);
    for (const d of doctrine) console.error(`DIVERGENCE ${d}`);
    console.log(
      `reconciled ${state.packets.filter((p) => p.prUrl).length} packets; divergences=${doctrine.length} advisories=${owed.length}`,
    );
    return;
  }

  if (cmd === "evidence-page") {
    const id = rest[0];
    const packet = state.packets.find((p) => p.id === id);
    if (!packet) {
      console.error(`unknown packet ${id}`);
      process.exit(1);
    }
    console.log(renderEvidencePage(packet));
    return;
  }

  if (cmd === "ledger") {
    // Emits the generated block for docs/12-ledger.md — paste between the GENERATED markers.
    // Grouping runs through `ledgerSections`, not `repoById(...)?.wave`: an off-allowlist packet has
    // no wave, so the old filter dropped the denied scout the ledger most needs to show (issue #44).
    for (const { title, packets } of ledgerSections(state.packets)) {
      console.log(`### ${title}`);
      console.log("");
      console.log("| packet | issue | PR | status | attested by |");
      console.log("|---|---|---|---|---|");
      for (const p of packets) {
        // `#0` is the refusal fixture's placeholder for "there is no issue here", not an issue
        // number — and this repo's doctrine is that the clock never invents issue numbers. Rendered
        // as a link label, `matplotlib/matplotlib#0` reads exactly like one. A packet with no real
        // issue gets a dash, the same way a packet with no PR does; the packet id still names the
        // repo, so the dash costs the reader nothing.
        const issue = p.issueNumber > 0 ? `[${p.repoId}#${p.issueNumber}](${p.issueUrl})` : "—";
        console.log(
          `| ${p.id} | ${issue} | ${p.prUrl ?? "—"} | ${p.status} | ${p.humanAttest?.by ?? "—"} |`,
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
    persist(result.state);
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
    // Deliberately NOT gated on the issue's state (issue #40), unlike tick / approve / open-draft.
    // By here the pull request already exists on GitHub; the only question left is whether the
    // ledger records it. Refusing would leave a live PR the ledger has never heard of — the
    // abandoned-live-PR hole `packetChecks` exists to surface (ledger-check.ts, issue #34) — and
    // the closed issue would still be there, now with nothing watching the draft. The right
    // response to a draft on an issue that closed is a human closing the draft, which needs the
    // record first.
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
    persist(result.state);
    console.log(`attached ${url} (draft=${synced.meta.draft})`);
    return;
  }

  console.error(`unknown command ${cmd}`);
  process.exit(1);
}

/**
 * True only when this module *is* the process entry point.
 *
 * Both sides are canonicalised. Node already resolves symlinks when loading a module, so
 * `import.meta.url` is the real path, while `process.argv[1]` is whatever the operator typed —
 * through a symlinked checkout (`~/bin/foundry -> .../factory/cli.ts`, a `pnpm link`ed tree) the
 * two differ and a `resolve()`-only comparison silently exits 0 having done nothing. A CLI that
 * says nothing and reports success is the exact failure mode this project exists to prevent, so
 * the comparison is on real paths. `realpathSync` throws when the path does not exist (`node -e`,
 * a deleted script), which is not the entry point either.
 */
function isProcessEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Guarded so the module can be imported (by a test, or another verb) without the whole CLI running
// and calling `process.exit`. Spawning `cli.ts` as the entry point still runs `main()` unchanged.
if (isProcessEntryPoint()) {
  await main();
}
