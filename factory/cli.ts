import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWLIST, CAPS, repoById } from "./allowlist.ts";
import { competitionAdvisories, readCompetition } from "./competition-read.ts";
import {
  applyAdvance,
  applyApprove,
  applyAttachDraft,
  applyAttachEvidence,
  applyHalt,
  applyReject,
  applyPrSync,
  applyReviewObservation,
  applyRevert,
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
  MAX_LIST_PAGES,
  parsePrUrl,
  revertCheck,
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
import { renderEvidencePage, renderFreezeEvidence, renderPrBody } from "./packet.ts";
import { health, mergeRate, scorecardRow, terminalCount } from "./scorecard.ts";
import { seedState } from "./seed.ts";
import { backupFactoryState, loadFactoryState, saveFactoryState } from "./state.ts";
import { foundryAttestedWave0Merges, ledgerSections, quietLabel } from "./status.ts";
import { installTerminalBoundary } from "./terminal.ts";
import { INFLIGHT_STATUSES, type EvidenceManifest, type EvidenceWitness, type FactoryEvent, type FactoryState, type ScorecardRow } from "./types.ts";
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
 *
 * The default is `LOGS_ROOT`, not `"."` (issue #80). A cwd default made this the WRITE half of the
 * same mismatch `readIfPresent` had on the read half: run the verb from outside the checkout and
 * the logs land beside the operator's shell while the evidence page keeps naming
 * `docs/evidence/logs/...` inside the repository — a recompute offer pointing at files that are not
 * there. Read and write anchor to the same value, because they name the same two files.
 */
export function persistWitnessLogs(
  witness: EvidenceWitness,
  logs: WitnessLogs,
  root = LOGS_ROOT,
): void {
  // The other half of anchoring, exactly as `persist` is for the ledger.
  //
  // Before this, a spawned-CLI test was isolated by its temp `cwd` for free. Anchoring `LOGS_ROOT`
  // to the repo root takes that away, so a test that forgets `--logs-root` writes two run logs into
  // the developer's real checkout — which is not hypothetical: an intermediate state of issue #80's
  // own fix did precisely that, and the files were sitting in `docs/evidence/logs/` afterwards.
  // Refused at the write and not at the resolve, because resolving the default path is a legitimate
  // thing for a test to assert — that is how the anchoring itself is proven; it is the mutation that
  // leaks. `NODE_TEST_CONTEXT` is set by `node --test` and inherited by spawned children, so this is
  // inert for a real operator. An explicit `root` argument is a caller who has said where they mean.
  if (root === LOGS_ROOT && !LOGS_ROOT_FLAG && process.env.NODE_TEST_CONTEXT) {
    console.error(
      `refusing to write the repo-root run logs under ${LOGS_ROOT} from a test run — pass \`--logs-root <tmpdir>\` to every spawned CLI so the test cannot write into the real checkout.`,
    );
    process.exit(1);
  }
  for (const [path, text] of [
    [witness.testLogPath, logs.test],
    [witness.revertLogPath, logs.revert],
  ] as const) {
    const full = resolve(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
}

/**
 * Read a path the OPERATOR typed on the command line. Cwd-relative, and that is correct: when
 * someone types `--manifest ./witness.json`, the `./` is theirs and means their shell's directory.
 *
 * Deliberately NOT the reader for anything the ledger or a manifest names — see `readRepoRelative`.
 * The two are separate functions with the anchor in the name because they were one function with
 * two call sites and one right answer between them (issue #80), and a single `readIfPresent` is an
 * invitation for the next call site to pick the wrong anchor silently.
 */
function readOperatorPath(path: string): string | undefined {
  try {
    return readFileSync(resolve(path), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Read a path that is RELATIVE TO THE REPOSITORY, not to the operator (issue #80).
 *
 * Witness log paths are of this kind: `witnessLogPathViolation` refuses anything that is not
 * exactly `docs/evidence/logs/<packetId>/{test,revert}.log`, and its refusal message says in so
 * many words that "run logs are repo-root-relative". Resolving them with a bare `resolve()` made
 * the schema's claim false from any directory but one, so `attach-witness` reported a perfectly
 * good witness as a missing log — the same class #43 fixed for `STATE_FILE` and left in this
 * sibling. `LOGS_ROOT` is the anchor, `--logs-root` is the override, exactly as `STATE_FILE` and
 * `--state` are.
 */
function readRepoRelative(path: string): string | undefined {
  try {
    return readFileSync(resolve(LOGS_ROOT, path), "utf8");
  } catch {
    return undefined;
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

/**
 * A flag written LAST, with nothing after it, refused instead of read as absent.
 *
 * `flag()` cannot tell `--at` at the end of argv from no `--at` at all: both are `undefined`. That
 * is harmless for a flag whose absence is already an error — `revert requires --reason <text>`
 * fires either way — and it is a silent wrong answer for a flag whose absence MEANS something.
 *
 * NOT GENERALISED into `flag()` itself, deliberately. `--state` and `--logs-root` have the same
 * "absence means something" shape, but they are read during MODULE EVALUATION, so a refusal inside
 * `flag()` would `process.exit` or throw inside whatever imported `cli.ts` — `engine.test.ts` does —
 * rather than in front of the operator who mistyped. Applied at the one call site where a silent
 * default is a safety verdict, and stated here so the next one is a decision rather than an
 * oversight.
 */
function refuseValuelessFlag(args: string[], name: string, absenceMeans: string): void {
  if (args.includes(name) && flag(args, name) === undefined) {
    console.error(
      `${name} was given no value. Pass one, or omit ${name} entirely — omitting it means ${absenceMeans}, and a trailing ${name} is not the same thing.`,
    );
    process.exit(1);
  }
}

const ARGV = process.argv.slice(2);
// The ledger belongs to the repository, not to whatever directory the operator happened to be in.
// A cwd-relative path silently served the committed seed as live truth from anywhere else, and a
// mutating command forked a second state file next to it.
/**
 * A capped competing-work read cannot support "nothing is in flight". The gate asserts the ABSENCE
 * of a competitor, and an absence is what a short read cannot establish — so it is refused, not
 * warned, with its own message so a capped read stays distinguishable from a failed one (issue #69).
 */
/**
 * A page-capped read cannot support "no competing pull request", so it is a refusal, not a warning.
 *
 * `truncated` is REQUIRED, not optional, and that is the whole point of the signature. It used to be
 * `truncated?: boolean`, which silently accepted the keyword-hit short-circuit below — a synthesised
 * `{ ok: true, urls: [] }` carrying no flag at all. That read as "not truncated" because `undefined`
 * is falsy. The behaviour was right by accident (the short-circuit's verdict comes from `pulls`,
 * which IS checked here), but the type let a reader omit the flag and get a pass, which is the
 * "truncated success silently disables the FATAL" shape docs/12-ledger.md names. Required means the
 * next synthesised success has to say which it is, out loud, or it does not compile.
 */
function refuseIfCapped(reads: { truncated: boolean }[], what: string): void {
  if (!reads.some((r) => r.truncated)) return;
  console.error(
    `${what}: a competing-work read stopped at the ${MAX_LIST_PAGES}-page cap, so "no competing pull request" is not a fact this run can assert. Narrow the target or raise the cap deliberately.`,
  );
  process.exit(1);
}

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const STATE_FILE_FLAG = flag(ARGV, "--state");
const STATE_FILE = resolve(STATE_FILE_FLAG ?? resolve(REPO_ROOT, ".foundry-state.json"));

/**
 * Where `docs/evidence/logs/<packetId>/{test,revert}.log` is rooted (issue #80).
 *
 * The witness log paths are repo-root-relative by schema, so the tree they resolve against is a
 * property of the CHECKOUT, not of the operator's shell — the identical argument #43 made for the
 * ledger, and the identical shape of fix: an anchor plus one explicit override. Exported as a
 * function of `argv` rather than read off the constant so a test can assert the DEFAULT, which is
 * the half an override can hide and the half the bug was in.
 *
 * One value for both directions on purpose. A separate read root and write root would be two places
 * that have to agree about where two named files are, and this issue is what disagreement looks
 * like: the reader hunting one tree while the evidence page promises another.
 */
export function witnessLogRootFor(argv: string[]): string {
  const override = flag(argv, "--logs-root");
  // Both branches go through `resolve()`, and the default branch needs it as much as the override:
  // `REPO_ROOT` comes from `new URL("..", …)` and therefore carries a trailing slash, which `--help`
  // printed straight into `…/oss-foundry//docs/evidence/logs/…`. `STATE_FILE` already normalises for
  // the same reason one line up; a doubled slash in the one line that tells the operator where the
  // logs are is a small thing that makes the reader doubt the rest of the sentence.
  return resolve(override ?? REPO_ROOT);
}
const LOGS_ROOT_FLAG = flag(ARGV, "--logs-root");
const LOGS_ROOT = witnessLogRootFor(ARGV);

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
  /**
   * One generation of backup, taken BEFORE the write, so `<state>.bak` is always the last ledger
   * that loaded rather than the one we are about to replace it with.
   *
   * `saveFactoryState` makes a torn write essentially impossible; this covers the failures it
   * cannot — a bad hand-edit, an `rm`, or a state the loader legitimately refuses because the
   * invariants really are violated. Recovery is written up in `docs/08-operations.md`.
   *
   * A failed backup is a WARNING, not a refusal, and the direction matters: refusing to work
   * because a convenience copy could not be made would turn a full disk into a dead factory, while
   * a missing `.bak` costs only the seatbelt. The operator is told either way.
   */
  const backup = backupFactoryState(STATE_FILE);
  if (!backup.ok) {
    console.error(`could not back up ${STATE_FILE} before writing: ${backup.error} — continuing without a backup`);
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

/**
 * Why `health()` returned `stop`. `health()` is three independent predicates (banned tone,
 * reverts > 0, merge rate under the cap) and the scorecard line used to print only the resulting
 * word — so a repository frozen by a revert looked identical to one a maintainer banned, and the
 * operator opened scorecard.ts at 2 a.m. to find out which (G-08). Named here, next to the print,
 * because a helper in scorecard.ts that nobody calls is the same as no reason.
 */
function stopReasons(row: ScorecardRow): string[] {
  const reasons: string[] = [];
  if (row.maintainerTone === "banned") reasons.push("banned");
  if (row.reverts > 0) reasons.push(`reverts=${row.reverts}`);
  if (
    row.opened >= CAPS.halt_after_opens &&
    terminalCount(row) > 0 &&
    mergeRate(row) < CAPS.halt_merge_rate
  ) {
    reasons.push(`merge-rate ${row.merged}/${terminalCount(row)}<${CAPS.halt_merge_rate}`);
  }
  return reasons;
}

function printStatus(state: FactoryState, source: "file" | "seed") {
  console.log(`state: ${STATE_FILE}${source === "seed" ? " (absent — committed seed)" : ""}`);
  // The clock verifies the committed seed, never this file (docs/08-operations.md). This is the
  // only place the operator is told the two have parted company.
  if (source === "file") {
    for (const d of seedDivergences(state, seedState())) console.log(`SEED DRIFT ${d}`);
  }
  // The halt used to reach the terminal only as a mustLoad side-effect on stderr, above the
  // report and not part of it. status is the 2 a.m. diagnostic; a factory-wide stop that is not
  // in the report is a stuck factory with no surfaced reason (G-08).
  const halted = factoryHalt(state);
  if (halted) {
    console.log(`FACTORY HALTED ${halted.at}: ${halted.reason}`);
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
      // A gated packet is waiting on the freeze; the verdict is why. Omitting it left the
      // operator reading `gated` with no idea whether the scanner allowed or denied.
      const policy = p.status === "gated" ? `  policy=${p.policy.code}` : "";
      console.log(`  ${p.id}  ${p.status}  ${p.repoId}#${p.issueNumber}  ${p.prUrl ?? ""}${quiet}${policy}`);
    }
  } else if (halted) {
    console.log("in flight: none — factory halted; tick is refused");
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
    const h = health(row);
    const why = h === "stop" ? stopReasons(row) : [];
    const stop = why.length ? `  stop=${why.join(",")}` : "";
    console.log(
      `  ${row.repoId}  opened=${row.opened} merged=${row.merged} reverts=${row.reverts} reviewCommentsAvg=${row.reviewCommentsAvg} tone=${row.maintainerTone} health=${h}${stop}`,
    );
  }
}

/**
 * The ledger's own event log, newest first. `ledger` is an export format (paste between the
 * GENERATED markers in docs/12-ledger.md) and must stay byte-stable for that paste; stuffing
 * events into it would desync the published block. `status` is the snapshot of now — halt,
 * inflight, scorecard — and 80 event lines would bury the stuck-factory answers. This verb is
 * the audit-trail reader the events array never had (G-08).
 *
 * Newest-first is a sort on read, not the array's stored order. `appendEvent` prepends, so a
 * live ledger usually already is newest-first — but the committed seed, a hand edit, or a
 * migrated file need not be, and printing the array as-is while the header claimed newest-first
 * would have the operator draw a causal conclusion from a 2026-07-16 event sitting above a
 * newer 2026-08-26 one.
 */
function eventAtMs(at: string): number | undefined {
  // `isEvent` only checks `typeof === "string"`. `migrateV6` can leave the literal `"—"` on
  // packet timestamps; a hand-edited event can carry the same, or garbage. `Date.parse("—")`
  // is NaN. Sorting NaN as 0 floats undated events to 1970; sorting them as newest puts a
  // broken timestamp at the top of a diagnostic. Neither is acceptable — callers send these
  // last, still printed, so they cannot vanish and cannot look like "what just happened".
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : undefined;
}

function eventIdMs(id: string): number | undefined {
  // mintLedgerId: `${kind}_${ms}_${token}`. Seed events and hand edits often do not match.
  // `evt_halt` must be tried before `evt` or the prefix would not consume `_halt`.
  const m = /^(?:evt_halt|evt|fu)_(\d+)_/.exec(id);
  if (!m) return undefined;
  const ms = Number(m[1]);
  return Number.isFinite(ms) ? ms : undefined;
}

function eventsNewestFirst(events: readonly FactoryEvent[]): FactoryEvent[] {
  return [...events].sort((a, b) => {
    const aAt = eventAtMs(a.at);
    const bAt = eventAtMs(b.at);
    if (aAt !== undefined && bAt !== undefined && aAt !== bAt) return bAt - aAt;
    if ((aAt === undefined) !== (bAt === undefined)) return aAt === undefined ? 1 : -1;
    const aId = eventIdMs(a.id);
    const bId = eventIdMs(b.id);
    if (aId !== undefined && bId !== undefined && aId !== bId) return bId - aId;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
}

function printEvents(state: FactoryState) {
  const ordered = eventsNewestFirst(state.events);
  const undated = ordered.filter((e) => eventAtMs(e.at) === undefined).length;
  console.log(`events: ${state.events.length} (newest first; ring cap 80)`);
  if (undated) {
    console.log(`  ${undated} with unparseable at — listed last, not treated as newest`);
  }
  if (state.events.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const e of ordered) {
    const pkt = e.packetId ?? "-";
    console.log(`${e.at}  ${e.kind}  ${pkt}  ${e.message}`);
  }
}

/**
 * The closing commit or pull request, read only when there is a refusal to enrich (issue #40).
 *
 * Calling `fetchIssueClosingRef` unconditionally would spend a timeline request on every open issue
 * at every gate, which is the opposite of the point: the reference exists for the refusal message,
 * and an open issue has no refusal message. It is not free on the path where it IS spent, and the
 * ordering does not pay for it: this is the identical `issues/{n}/timeline?per_page=100` GET the
 * competing-work check below would have made, spent on the refusal instead. So a closed row costs
 * exactly what an open row that reaches the timeline costs, and one request MORE than an open row
 * a closing-keyword hit settles from the already-fetched pulls — live, that last case is
 * ColeMurray/background-agents#1476, which spends one request here and spent none before.
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
  // Before the first request, not after the last one (issue #79).
  //
  // SPEC.md §6: "a platform secondary rate limit MUST halt the factory, never retry." The halt was
  // already consulted — inside `applyTick` → `maySelectRepo`, at the bottom of this function, after
  // the loop below had spent a `pulls`, an `AGENTS.md`, a `CONTRIBUTING`, an issue read and a
  // timeline read for every named row on the roster. Issuing those and then refusing IS the retry
  // the rule forbids, and it aggravates the exact limit that wrote the halt; #43 made the halt
  // durable so a re-run could not retry, and this ordering meant every re-run retried anyway.
  //
  // Two gates, and both earn their place: this one decides whether to spend requests, `applyTick`'s
  // decides what the tick's verdict is. They cannot drift, because there is one `factoryHalt` and
  // they both call it — and `applyTick` is left to phrase the outcome so this line never has to.
  if (factoryHalt(state)) return applyTick(state);
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
    refuseIfCapped([pulls], repo.id);
    const agentsMd = await fetchRepoFile(repo.id, "AGENTS.md");
    const contributing =
      (await fetchRepoFile(repo.id, "CONTRIBUTING.md")) ??
      (await fetchRepoFile(repo.id, ".github/CONTRIBUTING.md"));
    for (const issue of repo.firstIssues) {
      const key = `${repo.id}#${issue.number}`;
      // Is the target still open at all? First, ahead of the competing-work classification,
      // because it is the more decisive fact: a closed issue needs no competitor to be
      // unscoutable. The ordering buys no requests. Refusing here does short-circuit the
      // competing-work timeline call below, but `closingRefFor` then makes the identical
      // `issues/{n}/timeline?per_page=100` GET for the refusal message, so the saving is exactly
      // zero. Measured live over the four rows `allowlist.yaml` names, two of them closed: a full
      // tick went 15 requests → 19. The cost is +1 GET per named row, unconditionally — closed
      // rows are not cheaper, they cost the same +1 as every other row.
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
        ? { ok: true as const, urls: [] as string[], truncated: false }
        : await listCrossReferencingOpenPulls(repo.id, issue.number);
      if (!crossRefs.ok) {
        console.error(crossRefs.error);
        process.exit(1);
      }
      // BOTH reads feeding the verdict: `pulls` alone let a capped timeline through (same fail-open).
      refuseIfCapped([pulls, crossRefs], key);
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
  events   (ledger event log, newest first — the audit trail; ledger is the published export, not this)
  tick
  approve <packetId> --note <text> [--by <name>]   (identity also via FOUNDRY_OPERATOR)
  reject <packetId> --reason <text>
  halt <repoId> --reason <text>   (per-repo scorecard stop — a maintainer asked; NOT cleared by clear-halt)
  revert <packetId> --reason <text> [--at <iso>]   (a maintainer-stated rollback naming the PR — SPEC.md §7 stop; an explicit git revert of our merge commit is found by reconcile on its own. --at is WHEN THE ROLLBACK HAPPENED, which is what the 30-day window is measured from; it defaults to now)
  advance <packetId>
  evidence <packetId> --base <sha> --head <sha>   (tests + revert control run in the sandbox — witnessed, never attested; host/Wave 0 only)
  witness-check [repoId]   (pre-flight: resolve the interpreter each allowlisted testCommand would really use here, before a packet is in flight)
  attach-witness <packetId> --manifest <path>   (ingest a witness produced on the worker host; provenance and log hashes re-checked here)
  body <packetId>
  attach-draft <packetId> <prUrl>
  open-draft <packetId> --head <forkOwner:branch>   (machine-account PAT; draft-only; one create per run)
  sync <packetId> [--threads-answered]
  reconcile   (live re-read of every packet that names a PR; re-checks merged packets for a revert of our merge commit)
  ledger
  evidence-page <packetId>   (maintainer-facing audit page, markdown to stdout)
  clear-halt --by <name> --note <text>   (a human lifts the factory-wide rate-limit halt — not the halt above)

Any command takes --state <path> to point at a different ledger.
Any command takes --logs-root <path> to root the witness run logs somewhere other than the checkout.
State: ${STATE_FILE} (seed if missing; refuse if present but malformed). Foundry never merges.
Witness logs: ${LOGS_ROOT}/docs/evidence/logs/<packetId>/ (read and written there, whatever your cwd).
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

  if (cmd === "events") {
    printEvents(state);
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
    // The evidence first, and for any packet the operator names — not only the ones the gate will
    // let through. The freeze is the documented second layer over a scanner with a known miss mode
    // (docs/04-stations.md §2), and until issue #37 it was handed a verdict with the parsed text
    // discarded. Printed before the competing-work reads, so a network failure below cannot swallow
    // the one thing the human is here to read.
    if (packetForFreeze) console.log(renderFreezeEvidence(packetForFreeze));
    if (packetForFreeze && (packetForFreeze.status === "gated" || packetForFreeze.status === "frozen")) {
      // The selection gate, moved ahead of the network reads (issue #79). `applyApprove` runs the
      // identical `maySelectRepo` at the bottom of this verb, so the VERDICT is unchanged — what
      // changes is that a halted or scorecard-stopped repository stops costing GitHub requests to
      // discover. SPEC.md §6 says never retry; three reads and then a refusal is a retry. Same
      // pre-flight, same wording, as `open-draft` below.
      //
      // Deliberately AFTER the freeze evidence above and INSIDE the status guard: the render is
      // local, and it is the one thing the human came here to read (issue #37), so a refusal must
      // not swallow it. Inside the guard, a wrong-status packet still gets `applyApprove`'s own
      // "cannot approve … from status …" rather than being told about a halt it never reached.
      const gate = maySelectRepo(state, packetForFreeze.repoId);
      if (!gate.ok) {
        console.error(`cannot approve ${id}: ${gate.reason}`);
        process.exit(1);
      }
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
        ? { ok: true as const, urls: [] as string[], truncated: false }
        : await listCrossReferencingOpenPulls(packetForFreeze.repoId, packetForFreeze.issueNumber);
      if (!crossRefs.ok) {
        console.error(crossRefs.error);
        process.exit(1);
      }
      refuseIfCapped([pulls, crossRefs], packetForFreeze.repoId);
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

  if (cmd === "revert") {
    // The half of docs/08-operations.md's revert definition no classifier should pretend to read:
    // "a maintainer-stated rollback naming the PR". `reconcile` catches an explicit `git revert`
    // of our merge commit on its own; this is for prose, judged by a human. The reason is
    // mandatory and stored verbatim — an unexplained stop on someone's repository is not a record.
    const id = rest[0];
    const reason = flag(rest, "--reason");
    if (!id) {
      console.error("revert requires a packet id");
      process.exit(1);
    }
    if (!reason) {
      console.error(
        "revert requires --reason <text>: quote what the maintainer said. A revert halts the repo (SPEC.md §7); an unexplained halt is not a record.",
      );
      process.exit(1);
    }
    // WHEN THE ROLLBACK HAPPENED, not when the operator typed (issue #81, round 2).
    //
    // `applyRevert` and `classifyRevert` share one 30-day predicate so the two halves of
    // docs/08-operations.md's single definition cannot disagree — but they were handing it two
    // different SUBJECTS. `classifyRevert` passes the commit's `committedAt`; this verb passed
    // nothing, so `applyRevert` defaulted to `now()`. A maintainer who rolled our merge back on
    // day 10 and an operator who wrote it down on day 35 therefore produced OPPOSITE verdicts from
    // the same predicate over the same rollback: the mechanical path recorded it and halted the
    // repo, the operator's path refused it as out of window and left `health()` reading `good`.
    // Opposite answers in the safety-relevant direction, with no operator path to the SPEC.md §7
    // MUST at all. The window dates from the EVENT on both paths now; the default is still now,
    // which is the right reading of an operator who does not say otherwise.
    //
    // …and a trailing `--at` with no value after it is not "now". `flag` returns `undefined` for
    // both "no flag" and "flag at the end of argv", so `revert pkt --reason r --at` dated the
    // window from the moment of typing — the exact failure this flag closes, reached in silence and
    // by the operator who was trying hardest to avoid it.
    refuseValuelessFlag(rest, "--at", "the rollback is dated now");
    const at = flag(rest, "--at");
    if (at !== undefined && !Number.isFinite(Date.parse(at))) {
      console.error(
        `revert --at ${at} is not a date this can parse — pass the rollback's own timestamp as ISO-8601 (e.g. 2026-08-19T14:00:00Z). Omit --at to date it now.`,
      );
      process.exit(1);
    }
    const result = applyRevert(state, id, { source: "operator", why: reason, at });
    if (result.error) {
      console.error(result.error);
      process.exit(1);
    }
    if (!result.recorded) {
      console.log(`${id}: a revert is already recorded — reverts counts a packet once`);
      return;
    }
    persist(result.state);
    const packet = result.state.packets.find((p) => p.id === id)!;
    const row = scorecardRow(result.state.scorecard, packet.repoId);
    console.log(
      `revert recorded on ${packet.repoId} for ${id}: ${reason}\n  reverts=${row?.reverts ?? 0} health=${health(row!)} — the repo is unselectable while the ledger records it (health() gates on reverts > 0).\n  This wrote local state only, and .foundry-state.json is gitignored: promote the revert into factory/seed.ts and regenerate the docs/12-ledger.md block, or the 6-hour clock keeps reading a seed that says reverts=0.\n  Do NOT take the repo out of allowlist.yaml: scorecard rows are built from the roster, so that deletes this row and erases the count.`,
    );
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
      negativeControl:
        repo.negativeControl === "no-suite"
          ? "no-suite"
          : outcome.witness.revertExit !== 0
            ? "red-on-revert"
            : "failed",
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
    console.log(
      "shell: bash -c (non-login, non-interactive; child env omits FOUNDRY_PAT, GITHUB_TOKEN, GH_TOKEN, E2B_API_KEY)",
    );
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
    // Operator-typed, so operator-anchored: `--manifest ./witness.json` means their directory.
    const raw = readOperatorPath(manifestPath);
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
    // Repo-root-anchored, because these are the schema's paths and not the operator's (issue #80).
    const logs = verifyWitnessLogs(witness, readRepoRelative);
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
      negativeControl:
        repo.negativeControl === "no-suite"
          ? "no-suite"
          : witness.revertExit !== 0
            ? "red-on-revert"
            : "failed",
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
      // Names `reject` and the do-nothing, exactly like the freeze-time refusal above. There is no
      // `park` verb for an operator to type (issue #62): `parked` is a status the engine writes,
      // and the packet is `draft-ready` here — leaving it there is the second real option.
      console.error(`stand down: ${issueStandDown} Reject or leave it draft-ready — do not open.`);
      process.exit(1);
    }
    const pulls = await listOpenPulls(packet.repoId);
    const crossRefs = pulls.ok
      ? findCompetingPull(pulls.pulls, packet.issueNumber, packet.issueUrl, packet.repoId)
        ? { ok: true as const, urls: [] as string[], truncated: false }
        : await listCrossReferencingOpenPulls(packet.repoId, packet.issueNumber)
      : pulls;
    if (!pulls.ok || !crossRefs.ok) {
      console.error(!pulls.ok ? pulls.error : (crossRefs as { error: string }).error);
      process.exit(1);
    }
    refuseIfCapped([pulls, crossRefs], packet.repoId);
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
    // Reverts get their own bucket and their own word. `DIVERGENCE` means the ledger asserts
    // something GitHub contradicts and `ADVISORY` means a debt on a ledger that reconciles; a
    // revert is neither — it is a live safety event on a repository (SPEC.md §7). Overloading
    // either word would teach it two meanings, which is the thing the split above exists to avoid.
    const reverts: string[] = [];
    // And a fourth bucket, for the same reason. A recovered review KPI is not a divergence (the
    // ledger contradicted nothing), not a debt the operator owes (it is already paid), and not a
    // safety event. It is a scorecard number that just changed, and it needs promoting into the
    // seed exactly like a recorded revert — so it gets its own word rather than being read as one
    // of the other three.
    const reviews: string[] = [];
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
        // The live body, for the SPEC.md §6 disclosure MUST (issue #38). The clock's sibling
        // consumer reads the same split, so both call sites have to supply the same facts or the
        // two verbs an operator reads disagree about whether the doctrine is checked at all.
        body: synced.body,
      };
      if (packet.status === "submitted" || packet.status === "followed-up") {
        // Mechanical absorption only: reconcile never attests threads answered, so it can
        // record merges/closes but never release the in-flight slot.
        const applied = applyPrSync(next, packet.id, synced.meta, {
          threadsAnswered: false,
          reviewTruncated: synced.reviewTruncated,
        });
        if (!applied.error) next = applied.state;
      }
      // The review-KPI recovery (issue #39 round 3), and the reason `syncGithubPr` keeps paying 2
      // requests per already-terminal PR: before this, for a MERGED packet, those requests bought
      // nothing at all. `applyPrSync` refuses a merged packet, `recordTerminalReview` is only
      // reachable from inside it, and the clock never reads `humanReview` — so a packet whose
      // review endpoints were down on the one tick that absorbed the merge stayed at "not
      // observed" forever, with its terminal outcome silently outside noReview's denominator.
      // Safe to call on every packet, every tick, and the safety is NOT in this call site: it is
      // `applyReviewObservation`'s own refusal to write over a stored `prMeta.humanReview`. That
      // matters to state plainly, because an earlier draft of this line also tested
      // `isTerminalReviewSubject` here and a comment claimed the test was what prevented a double
      // count on the tick that absorbs a merge. It was not — with or without it the writer's guard
      // is what refuses, and both mutants survived the suite. The condition below is only the cheap
      // one: `syncGithubPr` populates `humanReview` for terminal PRs alone, so an open packet costs
      // nothing here. An error is still reported rather than swallowed, because a writer that
      // starts refusing for a new reason should be visible rather than silently skipped.
      if (synced.meta.humanReview) {
        const observed = synced.meta.humanReview;
        const recovered = applyReviewObservation(next, packet.id, observed);
        if (recovered.error) {
          owed.push(`${packet.id}: could not record the human-review observation — ${recovered.error}`);
        } else if (recovered.recorded) {
          next = recovered.state;
          reviews.push(
            `${packet.id}: human review recovered on ${packet.repoId} (${observed.reviews} review(s), ${observed.comments} comment(s)) — noReview/reviewCommentsAvg had been computed without it`,
          );
        }
      }
      // The revert re-check (issue #39). It belongs here and not in `applyPrSync`, whose status
      // guard has always refused a merged packet — which is precisely why nothing could ever
      // notice a revert. `reconcile` was already fetching every packet that names a PR, merged
      // ones included; it simply had nothing to say about them.
      let reverted: Awaited<ReturnType<typeof revertCheck>> | undefined;
      if (packet.status === "merged") {
        reverted = await revertCheck(packet.repoId, synced.meta);
        if (!reverted.ok) {
          owed.push(
            `${packet.id}: could not read ${packet.repoId} commits since the merge — a revert would go unnoticed this run (${reverted.error})`,
          );
        } else if (reverted.verdict.reverted) {
          const applied = applyRevert(next, packet.id, {
            source: "commit",
            sha: reverted.verdict.sha,
            why: reverted.verdict.why,
            at: reverted.verdict.at,
          });
          if (applied.error) {
            console.error(`${packet.id}: ${applied.error}`);
            process.exit(1);
          }
          next = applied.state;
          if (applied.recorded) reverts.push(`${packet.id}: ${reverted.verdict.why}`);
        }
      }
      const checks = packetChecks(next.packets.find((p) => p.id === packet.id)!, {
        ...live,
        revert: reverted?.ok ? reverted.verdict : undefined,
        // Same fact the clock reads (issue #39 round 2): a page-capped commit read is not a clean
        // one, and both consumers must say so or the two verbs disagree about what was checked.
        revertTruncated: reverted?.ok ? reverted.truncated : undefined,
        // The review read's own cap (issue #69), through the parameter both verbs already build so
        // neither can forget it — this unit shipped that defect twice before.
        reviewTruncated: synced.reviewTruncated,
      });
      const stillOpen =
        (packet.status === "submitted" || packet.status === "followed-up") &&
        synced.meta.state !== "closed" &&
        !synced.meta.merged;
      if (stillOpen) {
        owed.push(
          ...competitionAdvisories(
            next.packets.find((p) => p.id === packet.id)!,
            await readCompetition(packet),
          ),
        );
      }
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
    for (const r of reviews) {
      console.error(
        `REVIEW ${r}. Recorded in local state only; promote the scorecard row into factory/seed.ts (and regenerate the docs/12-ledger.md block) or the clock keeps reading a seed that never observed this PR's review.`,
      );
    }
    for (const r of reverts) {
      console.error(
        `REVERT ${r} — SPEC.md §7: the repo is now a scorecard stop and stays unselectable while the ledger records it. Recorded in local state only; promote it into factory/seed.ts (and regenerate the docs/12-ledger.md block) or the clock keeps reading a seed that says reverts=0. Not allowlist.yaml — removing the repo there deletes the scorecard row that holds the count.`,
      );
    }
    console.log(
      `reconciled ${state.packets.filter((p) => p.prUrl).length} packets; divergences=${doctrine.length} advisories=${owed.length} reverts=${reverts.length} reviews=${reviews.length}`,
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
    // Only THIS sync's events are the operator's business below. The ledger is persisted, so
    // scanning all of it reprinted a month-old advisory after a clean read, and the operator reads
    // "the read FAILED" as the current result. Reproduced before fixing.
    //
    // By ID, not by position or count: `appendEvent` PREPENDS and caps the ledger at 80, so a tail
    // slice reads the wrong end and a length delta is 0 exactly when the cap is doing its job. Ids
    // are unique enough to key on because #88 in this same PR made them so.
    const eventIdsBefore = new Set(state.events.map((e) => e.id));
    const result = applyPrSync(state, id, synced.meta, {
      threadsAnswered: rest.includes("--threads-answered"),
      reviewTruncated: synced.reviewTruncated,
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
    // Issue #92: the reason the observation is missing is now on the opts object, so `sync`
    // can say which. Print it — an event nobody reads is the same as no event. Only the events THIS
    // call appended: see `eventsBefore`.
    for (const e of result.state.events) {
      if (eventIdsBefore.has(e.id)) continue;
      if (e.packetId === id && e.message.includes("Human review not observed")) {
        console.error(`ADVISORY ${e.message}`);
      }
    }
    // Re-check competing work on a still-open submitted/followed-up packet (issue #111).
    if (after && synced.meta.state !== "closed" && !synced.meta.merged) {
      for (const line of competitionAdvisories(after, await readCompetition(after))) {
        console.error(`ADVISORY ${line}`);
      }
    }
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
      refuseIfCapped([pulls, crossRefs], packetForDraft.repoId);
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
  // BEFORE `main()`, and inside this guard rather than at module scope, because the boundary is a
  // property of *being the process*: an importer (a test, another verb) owns its own streams and
  // must not have them rewritten underneath it.
  //
  // Every verb below prints third-party text somewhere — a fetched CONTRIBUTING at the freeze, a
  // phrase quoted out of one, an issue title, a witnessed repository's stdout, a `setupCommand`'s
  // output from inside the untrusted clone. Sanitising those at each `console.*` is a list that has
  // to stay complete, and issue #78 shipped an incomplete one: two sinks closed, nine open. This is
  // the same fix applied where it cannot be forgotten — a `console.log` added tomorrow, in any verb,
  // is already behind it.
  installTerminalBoundary();
  await main();
}
