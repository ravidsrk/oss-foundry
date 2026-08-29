import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ALLOWLIST } from "./allowlist.ts";
import { applySecondaryLimitHalt } from "./halt.ts";
import { buildPacket } from "./packet.ts";
import { emptyScorecard } from "./scorecard.ts";
import { seedState } from "./seed.ts";
import type { FactoryState } from "./types.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = resolve(REPO_ROOT, "factory/cli.ts");
/**
 * The 6-hour clock. A second entry point, not a CLI subcommand: it reads the COMMITTED SEED (no
 * `--state`), so the only thing a test controls is what GitHub says back — which is exactly the
 * input its exit code is a function of.
 */
const CLOCK = resolve(REPO_ROOT, "factory/verify-ledger.ts");

interface Spawned {
  code: number;
  stdout: string;
  out: string;
}

function runNode(
  script: string,
  args: string[],
  cwd: string,
  opts: { preload?: string; env?: Record<string, string> } = {},
): Spawned {
  const nodeArgs = ["--experimental-strip-types"];
  if (opts.preload) nodeArgs.push("--import", pathToFileURL(opts.preload).href);
  const run = spawnSync(process.execPath, [...nodeArgs, script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...opts.env },
  });
  return { code: run.status ?? 1, stdout: run.stdout, out: `${run.stdout}${run.stderr}` };
}

function runCli(
  args: string[],
  cwd: string,
  opts: { preload?: string; env?: Record<string, string> } = {},
): Spawned {
  return runNode(CLI, args, cwd, opts);
}

function writeState(state: FactoryState): string {
  const path = join(mkdtempSync(join(tmpdir(), "foundry-cli-")), "state.json");
  writeFileSync(path, JSON.stringify(state, null, 2));
  return path;
}

/**
 * GitHub's answer for one `GET /repos/{owner}/{repo}/issues/{n}`, keyed `owner/repo#n`.
 *
 * `"unreadable"` is the fail-closed input: GitHub answers 500, so the CLI knows nothing about the
 * issue's state. The default for an unnamed key is an OPEN issue, on the same principle as
 * `livePrs` below — a test states only the one fact it changes, so a refusal can only come from
 * the fact the test set.
 */
type IssueFact =
  | {
      state: "open" | "closed";
      /** GitHub's `state_reason`: completed | not_planned | reopened | null. */
      reason?: string;
      /** The number names a pull request, which GitHub also serves from the issues endpoint. */
      isPr?: boolean;
      closedBy?: string;
      /** A pull request the issue's timeline cross-references, as the closing reference. */
      closedByPr?: string;
    }
  | "unreadable";

/**
 * Replace global `fetch` before the CLI's entry module runs, and log every call.
 *
 * The log is the proof: "refused before contacting GitHub" is only demonstrated by showing that no
 * request was made, not by the absence of an error string that only appears when a request WAS
 * made. `secondaryLimit` additionally answers the open-draft pre-flight and then returns GitHub's
 * secondary-rate-limit body for the create, which is the only way to reach the halt-write path.
 *
 * The read routes are served in every mode, because the live-state reads are pre-flight for the
 * create: a mode that 404s `GET /issues/{n}` would refuse fail-closed and never reach the POST.
 */
function githubStub(
  mode: "record" | "secondary-limit",
  issues: Record<string, IssueFact> = {},
): { preload: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "foundry-stub-"));
  const log = join(dir, "fetch.log");
  const preload = join(dir, "preload.mjs");
  const create =
    mode === "secondary-limit"
      ? `
  if (method === "POST" && /\\/pulls$/.test(u)) {
    return json(403, { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." });
  }`
      : "";
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";
const facts = ${JSON.stringify(issues)};
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  appendFileSync(${JSON.stringify(log)}, method + " " + u + "\\n");${create}
  const path = new URL(u).pathname;
  // The timeline path is a prefix extension of the issue path, so it is matched first.
  const tl = /^\\/repos\\/([^/]+)\\/([^/]+)\\/issues\\/(\\d+)\\/timeline$/.exec(path);
  if (tl) {
    const fact = facts[tl[1] + "/" + tl[2] + "#" + tl[3]];
    const ref = fact && fact !== "unreadable" ? fact.closedByPr : undefined;
    return json(200, ref
      ? [
          { event: "cross-referenced", source: { issue: { state: "closed", pull_request: {}, html_url: ref } } },
          { event: "closed", commit_id: null },
        ]
      : []);
  }
  const iss = /^\\/repos\\/([^/]+)\\/([^/]+)\\/issues\\/(\\d+)$/.exec(path);
  if (iss) {
    const fact = facts[iss[1] + "/" + iss[2] + "#" + iss[3]] ?? { state: "open" };
    if (fact === "unreadable") return json(500, { message: "boom" });
    return json(200, {
      number: Number(iss[3]),
      html_url: "https://github.com/" + iss[1] + "/" + iss[2] + "/issues/" + iss[3],
      state: fact.state,
      state_reason: fact.reason ?? null,
      closed_at: fact.state === "closed" ? "2026-08-27T11:30:05Z" : null,
      closed_by: fact.closedBy ? { login: fact.closedBy } : null,
      ...(fact.isPr ? { pull_request: { url: "https://api.github.com/x" } } : {}),
    });
  }
  if (/\\/pulls\\?state=open/.test(u)) return json(200, []);
  return json(404, { message: "unstubbed " + method + " " + u });
};
`,
  );
  return { preload, log };
}

/** The live pull-request facts `packetChecks` reconciles a packet against. */
interface LivePr {
  draft: boolean;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  updatedAt: string;
}

/**
 * GitHub's half of a reconciliation, as a table keyed by the packet's own `prUrl`.
 *
 * The default is "GitHub says exactly what the committed ledger says", so a test states only the
 * ONE fact it makes GitHub disagree about and everything else stays reconciled. That matters for
 * the clock: a divergence anywhere in the seed would stop it for a reason the test did not set,
 * and the exit code would stop meaning what the test claims it means.
 */
function livePrs(overrides: Record<string, Partial<LivePr>> = {}): Record<string, LivePr> {
  const table: Record<string, LivePr> = {};
  for (const packet of seedState().packets) {
    if (!packet.prUrl || !packet.prMeta) continue;
    const { draft, state, merged, headSha, updatedAt } = packet.prMeta;
    table[packet.prUrl] = { draft, state, merged, headSha, updatedAt };
  }
  for (const [url, over] of Object.entries(overrides)) {
    const base = table[url];
    assert.ok(base, `no committed-seed packet names ${url} — the override would be silently unused`);
    table[url] = { ...base, ...over };
  }
  return table;
}

/**
 * A preload that answers `GET /repos/{owner}/{repo}/pulls/{n}` from that table and 404s the rest,
 * in the shape `syncGithubPr` parses. Same mechanism as `githubStub` above: replace `globalThis
 * .fetch` before the spawned entry module runs, so no test here can reach the network.
 */
function prFactsStub(table: Record<string, LivePr>): string {
  const preload = join(mkdtempSync(join(tmpdir(), "foundry-prfacts-")), "preload.mjs");
  writeFileSync(
    preload,
    `const facts = ${JSON.stringify(table)};
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url) => {
  const parts = new URL(String(url)).pathname.split("/").filter(Boolean);
  const path = parts[0] === "repos" && parts[3] === "pulls"
    ? parts[1] + "/" + parts[2] + "/pull/" + parts[4]
    : "";
  const pr = facts["https://github.com/" + path];
  if (!pr) return json(404, { message: "unstubbed " + url });
  return json(200, {
    html_url: "https://github.com/" + path,
    title: "stub",
    body: "",
    draft: pr.draft,
    state: pr.state,
    merged: pr.merged,
    mergeable_state: "clean",
    commits: 1,
    review_comments: 0,
    comments: 0,
    head: { sha: pr.headSha },
    updated_at: pr.updatedAt,
  });
};
`,
  );
  return preload;
}

function runClock(table: Record<string, LivePr>): Spawned {
  return runNode(CLOCK, [], tmpdir(), { preload: prFactsStub(table) });
}

/** The seed with its in-flight packet rewound to draft-ready, so `open-draft` is the next step. */
function draftReadyState(): FactoryState {
  const seed = seedState();
  return {
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
}

const DRAFT_READY_ID = "pkt_ColeMurray_background-agents_1476";
const DRAFT_READY_REPO = "ColeMurray/background-agents";

/** The annotation `status` appends when the resolved path holds no file. */
const SEED_SUFFIX = " (absent — committed seed)";

test("the state path is anchored to the repo root, not the cwd", () => {
  // The state line carries two independent facts, and only one of them is this test's claim.
  // WHICH path the CLI resolves is fixed by the repo layout. Whether that path currently holds a
  // file is not: a developer's own ledger, or a sibling test file running in parallel under
  // `node --test factory/*.test.ts`, decides it. Comparing the whole line across the two runs
  // therefore asserted the anchoring AND raced on the annotation. So: the path is asserted
  // exactly (stronger than the prefix match it replaces), and the annotation is pinned below on
  // paths whose absence and presence this test sets itself.
  const stateLine = (out: string) => {
    const l = out.split("\n").find((x) => x.startsWith("state: "));
    assert.ok(l, `no state line in:\n${out}`);
    return l;
  };
  const statePath = (out: string) =>
    stateLine(out).slice("state: ".length).replace(SEED_SUFFIX, "");

  // A decoy exactly where the ledger used to be read from. Under the old cwd-relative path this
  // file WAS the state; the canary tick count is what proves it is not consulted now — a path
  // assertion alone would still pass if the CLI printed one path and read another.
  const decoyDir = mkdtempSync(join(tmpdir(), "foundry-anchor-"));
  writeFileSync(
    join(decoyDir, ".foundry-state.json"),
    JSON.stringify({ ...seedState(), ticksRun: 90210 }),
  );

  const fromRoot = runCli(["status"], REPO_ROOT);
  const fromElsewhere = runCli(["status"], decoyDir);
  assert.equal(fromRoot.code, 0, fromRoot.out);
  assert.equal(fromElsewhere.code, 0, fromElsewhere.out);

  const anchored = resolve(REPO_ROOT, ".foundry-state.json");
  assert.equal(statePath(fromRoot.stdout), anchored);
  assert.equal(statePath(fromElsewhere.stdout), anchored, "the cwd moved; the ledger must not");
  assert.equal(
    /ticks=90210/.test(fromElsewhere.out),
    false,
    `the cwd's decoy ledger was read, not the repo root's: ${fromElsewhere.out}`,
  );

  // And the annotation the line carries, driven where absence and presence are facts we set.
  const absentPath = join(decoyDir, "absent.json");
  assert.equal(stateLine(runCli(["status", "--state", absentPath], decoyDir).stdout), `state: ${absentPath}${SEED_SUFFIX}`);
  const present = writeState(seedState());
  assert.equal(stateLine(runCli(["status", "--state", present], decoyDir).stdout), `state: ${present}`);
});

test("a test that spawns the CLI without --state cannot write the repo-root ledger", () => {
  // The landmine anchoring created, and the reason this guard exists. #34's spawned-CLI tests
  // isolated themselves with a temp `cwd`, which worked only while the ledger path was
  // cwd-relative. Anchored, those spawns began rewriting the real repo-root file, and the damage
  // surfaced in a DIFFERENT test file that read it — the failure landing nowhere near its cause.
  //
  // The two candidate guards were "assert no test leaves a state file behind" and "make a missing
  // --state loud". The first cannot be made deterministic here: `node --test factory/*.test.ts`
  // runs the files in parallel processes, so an end-of-run absence check is racy against whichever
  // file is still going, and a check that runs before the offending write simply misses it. This
  // one fires at the moment of the write, in the offending process, whatever the order.
  //
  // Reads of the default path stay legal — the anchoring test above depends on them, and a read
  // leaks nothing. It is the write that escapes the test, so the write is what refuses.
  const anchored = resolve(REPO_ROOT, ".foundry-state.json");
  const snapshot = () => (existsSync(anchored) ? readFileSync(anchored, "utf8") : null);
  const before = snapshot();

  const blocked = runCli(["reject", DRAFT_READY_ID, "--reason", "guard probe"], tmpdir());
  assert.equal(blocked.code, 1, blocked.out);
  assert.match(blocked.out, /refusing to write the repo-root ledger/);
  assert.ok(blocked.out.includes(anchored), blocked.out);
  assert.match(blocked.out, /--state/);
  assert.equal(/^rejected /m.test(blocked.stdout), false, "the write must not be reported as done");
  assert.equal(snapshot(), before, "the refused run must leave the repo-root ledger untouched");

  // Not a blanket ban on the command: the same reject, pointed at its own ledger, still lands.
  const path = writeState(seedState());
  const allowed = runCli(["reject", DRAFT_READY_ID, "--reason", "guard probe", "--state", path], tmpdir());
  assert.equal(allowed.code, 0, allowed.out);
  assert.match(allowed.stdout, new RegExp(`rejected ${DRAFT_READY_ID}`));
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  assert.equal(onDisk.packets.find((p) => p.id === DRAFT_READY_ID)?.status, "rejected");
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
  const halted = applySecondaryLimitHalt(draftReadyState(), {
    repoId: DRAFT_READY_REPO,
    at: "2026-08-29T09:00:00.000Z",
  });
  const stub = githubStub("record");
  const result = runCli(
    [
      "open-draft",
      DRAFT_READY_ID,
      "--head",
      "ravidsrk:foundry/issue-1476",
      "--state",
      writeState(halted),
    ],
    tmpdir(),
    { preload: stub.preload, env: { FOUNDRY_PAT: "test-pat" } },
  );
  assert.equal(result.code, 1);
  // The gate's OWN message. `/halt/i` alone matches the informational `FACTORY HALTED` banner that
  // `mustLoad` prints on every command, so it stays green with the gate deleted.
  assert.match(result.out, new RegExp(`refusing to open a draft on ${DRAFT_READY_REPO}`));
  assert.match(result.out, /Factory halted 2026-08-29T09:00:00\.000Z/);
  // Proof, not a proxy: no request was made at all. The stub logs every call it receives.
  assert.equal(
    existsSync(stub.log),
    false,
    `must refuse before contacting GitHub; requests made: ${existsSync(stub.log) ? readFileSync(stub.log, "utf8") : ""}`,
  );
});

test("a secondary rate limit during open-draft writes a halt that outlives the process", () => {
  // SPEC.md §6 is "halt the factory, never retry". A printed banner dies with the process and the
  // next `open-draft` a minute later makes exactly the retry the rule forbids, so what is under
  // test is the LEDGER WRITE, checked on disk and then in a second process.
  const path = writeState(draftReadyState());
  const stub = githubStub("secondary-limit");
  const hit = runCli(
    ["open-draft", DRAFT_READY_ID, "--head", "ravidsrk:foundry/issue-1476", "--state", path],
    tmpdir(),
    { preload: stub.preload, env: { FOUNDRY_PAT: "test-pat" } },
  );
  assert.equal(hit.code, 1);
  assert.match(hit.out, /FACTORY HALT SIGNAL — secondary rate limit/);

  const onDisk = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  assert.ok(onDisk.halt, "the halt must be persisted, not just printed");
  assert.equal(onDisk.halt?.source, "secondary-rate-limit");
  assert.equal(onDisk.halt?.repoId, DRAFT_READY_REPO);

  // A second process reads it back and refuses — the point of writing it down.
  const next = runCli(
    ["open-draft", DRAFT_READY_ID, "--head", "ravidsrk:foundry/issue-1476", "--state", path],
    tmpdir(),
    { preload: githubStub("record").preload, env: { FOUNDRY_PAT: "test-pat" } },
  );
  assert.equal(next.code, 1);
  assert.match(next.out, new RegExp(`refusing to open a draft on ${DRAFT_READY_REPO}`));
});

test("clear-halt lifts the durable halt so the factory can run again", () => {
  // Neutered, this command can never lift a halt and the factory is bricked permanently.
  const path = writeState(
    applySecondaryLimitHalt(seedState(), {
      repoId: DRAFT_READY_REPO,
      at: "2026-08-29T09:00:00.000Z",
    }),
  );
  const before = runCli(["status", "--state", path], tmpdir());
  assert.match(before.out, /FACTORY HALTED 2026-08-29T09:00:00\.000Z/);

  const cleared = runCli(
    ["clear-halt", "--by", "ravidsrk", "--note", "rate window elapsed", "--state", path],
    tmpdir(),
  );
  assert.equal(cleared.code, 0, cleared.out);
  assert.match(cleared.out, /halt from 2026-08-29T09:00:00\.000Z cleared by ravidsrk/);

  const onDisk = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  assert.equal(onDisk.halt, undefined, "the halt must be removed from the ledger, not just logged");
  assert.equal(
    onDisk.events.some((e) => /ravidsrk/.test(e.message) && /rate window elapsed/.test(e.message)),
    true,
    "the ledger records who lifted the halt and why",
  );

  const after = runCli(["status", "--state", path], tmpdir());
  assert.equal(/FACTORY HALTED/.test(after.out), false);
  // Clearing twice is refused, so a stale `clear-halt` in a script cannot mask a live halt.
  const again = runCli(["clear-halt", "--by", "ravidsrk", "--state", path], tmpdir());
  assert.equal(again.code, 1);
  assert.match(again.out, /not halted/);
});

test("clear-halt attributes the lift to FOUNDRY_OPERATOR when --by is omitted", () => {
  // The ledger event names the human who lifted the halt, so the environment fallback is an
  // attribution guarantee, not a convenience: without it the record reads "operator" and the
  // audit loses the name. Same fallback `approve` advertises in --help.
  const path = writeState(
    applySecondaryLimitHalt(seedState(), {
      repoId: DRAFT_READY_REPO,
      at: "2026-08-29T09:00:00.000Z",
    }),
  );
  const cleared = runCli(["clear-halt", "--note", "window elapsed", "--state", path], tmpdir(), {
    env: { FOUNDRY_OPERATOR: "ravidsrk" },
  });
  assert.equal(cleared.code, 0, cleared.out);
  assert.match(cleared.out, /cleared by ravidsrk/);
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  assert.equal(
    onDisk.events.some((e) => /cleared by ravidsrk/.test(e.message)),
    true,
    'the ledger records the environment-supplied identity, not the literal "operator"',
  );
});

test("`clear-halt` does not undo `halt`, and --help says so", () => {
  // The two sit next to each other in --help and read as a pair. They are not one: `halt` writes
  // a per-repo scorecard ban a maintainer asked for, `clear-halt` deletes the factory-wide
  // rate-limit halt, and neither touches the other's record. An operator who infers otherwise
  // resumes work on a repo whose maintainer said stop.
  const path = writeState(seedState());
  const banned = runCli(
    ["halt", DRAFT_READY_REPO, "--reason", "maintainer asked the factory to stop", "--state", path],
    tmpdir(),
  );
  assert.equal(banned.code, 0, banned.out);
  const tone = (s: FactoryState) => s.scorecard.find((r) => r.repoId === DRAFT_READY_REPO)?.maintainerTone;
  const read = () => JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  assert.equal(tone(read()), "banned");

  writeFileSync(
    path,
    JSON.stringify(
      applySecondaryLimitHalt(read(), { repoId: DRAFT_READY_REPO, at: "2026-08-29T09:00:00.000Z" }),
      null,
      2,
    ),
  );
  const cleared = runCli(["clear-halt", "--by", "ravidsrk", "--note", "window elapsed", "--state", path], tmpdir());
  assert.equal(cleared.code, 0, cleared.out);

  const onDisk = read();
  assert.equal(onDisk.halt, undefined, "clear-halt lifts the factory halt");
  assert.equal(tone(onDisk), "banned", "clear-halt must NOT lift the per-repo ban `halt` wrote");

  // The help block is where an operator meets both commands first, so the disambiguation lives
  // there and not only in CONTEXT.md's definitions (docs/adr/0004-naming.md).
  const help = runCli(["--help"], tmpdir());
  assert.match(help.stdout, /halt <repoId>[^\n]*NOT cleared by clear-halt/);
  assert.match(help.stdout, /clear-halt[^\n]*not the halt above/);
});

/** The line that claims a resolved toolchain. Absent under a sandboxed repo is the ADR-0003 rule. */
const TOOLCHAIN_CLAIM = "toolchain a witness from here would record:";

/**
 * The pre-flight's report for one repo: its header line down to the blank line before the next.
 *
 * Reading the report as one string is what let the sandbox exclusion be pinned in one direction
 * only. `stdout.slice(indexOf(awesome-copilot))` reaches to the end of the output, and four more
 * e2b repos follow that one — so `/e2b[\s\S]*?worker host/` was satisfiable from a *different*
 * repo's block, and nothing at all asserted the ABSENCE of a host answer under a sandboxed repo.
 * Deleting the `continue;` in cli.ts left the suite green while the report said, of a machine this
 * process has never seen, "toolchain a witness from here would record: pnpm 11.24.0".
 */
function preflightBlock(stdout: string, repoId: string): string {
  const block = stdout
    .split("\n\n")
    .find((b) => b.startsWith(`${repoId}  wave `));
  assert.ok(block, `${repoId} has no block of its own in the pre-flight:\n${stdout}`);
  return block!;
}

test("witness-check reports the toolchain each allowlisted repo's testCommand would really use", () => {
  // The pre-flight issue #41 asked for. Its whole value is being runnable with nothing in flight:
  // the alternative is discovering at evidence time that `python3` on this machine is 3.9.6, from
  // a refusal that looks identical to a bad patch.
  const path = writeState(seedState());
  const run = runCli(["witness-check", "--state", path], tmpdir());
  assert.equal(run.code, 0, run.out);

  for (const repo of ALLOWLIST) {
    const block = preflightBlock(run.stdout, repo.id);
    // In the repo's OWN block, as the whole line. `stdout.includes(repo.testCommand)` is satisfied
    // by any other repo's block, and for the two repos whose testCommand is the string `true` it
    // is satisfied by the word "true" appearing anywhere in the report at all.
    assert.ok(
      block.split("\n").includes(`  testCommand: ${repo.testCommand}`),
      `${repo.id}'s own block does not print its testCommand:\n${block}`,
    );
  }

  // A host repo resolves for real, in its own block: an absolute path and a version, both read off
  // this machine. Anchored, because an unanchored match is satisfied by a *sandboxed* repo's block
  // the moment the exclusion below stops holding — the two assertions would then cover for each
  // other instead of constraining anything.
  const hostBlock = preflightBlock(run.stdout, "ravidsrk/orca-fleet");
  assert.match(hostBlock, /\n {2}python3 {2}\/\S*python3 {2}\S*\d+\.\d+/, hostBlock);
  assert.ok(hostBlock.includes(TOOLCHAIN_CLAIM), `a host repo must be resolved:\n${hostBlock}`);

  // ...and no sandboxed repo is given a host answer. This CLI does not run those (ADR 0003), so
  // resolving OUR python3 for a Wave-1 e2b repo would be a confident report about another machine.
  // Every sandboxed repo, both directions: the disclaimer present AND the claim absent. The
  // disclaimer alone is satisfied by a block that prints the caveat and then contradicts it.
  for (const repo of ALLOWLIST.filter((r) => r.sandbox !== "host")) {
    const block = preflightBlock(run.stdout, repo.id);
    assert.match(block, /not resolved here:[\s\S]*worker host[\s\S]*ADR 0003/i, block);
    assert.ok(
      !block.includes(TOOLCHAIN_CLAIM),
      `${repo.id} runs in ${repo.sandbox}, and this report claims a toolchain for it — that is a ` +
        `confident statement about a machine this process has never seen (ADR 0003):\n${block}`,
    );
    // The per-tool resolution lines the host branch prints, which the claim line summarises. Both
    // come from the same block of code, so pinning only the summary leaves half of it free.
    assert.doesNotMatch(block, /\n {2}\S+ {2}\/\S+ {2}/, `${repo.id} was resolved here:\n${block}`);
    assert.doesNotMatch(block, /NOT FOUND on this machine's PATH/, block);
  }

  // An operator who has not read the issue meets this verb in `--help` or not at all.
  const help = runCli(["--help"], tmpdir());
  assert.match(help.stdout, /witness-check \[repoId\]/, help.stdout);
});

test("witness-check narrows to one repo and refuses one that is not on the allowlist", () => {
  const path = writeState(seedState());
  const one = runCli(["witness-check", "ravidsrk/orca-fleet", "--state", path], tmpdir());
  assert.equal(one.code, 0, one.out);
  assert.ok(one.stdout.includes("ravidsrk/orca-fleet"), one.out);
  assert.ok(!one.stdout.includes("github/awesome-copilot"), one.out);

  const stranger = runCli(["witness-check", "attacker/orca-fleet", "--state", path], tmpdir());
  assert.equal(stranger.code, 1, stranger.out);
  assert.match(stranger.out, /not on the allowlist/i);
});

/**
 * The in-flight packet the fatal/advisory split was built around: the committed seed names #1652's
 * live head (the #49 sync), and the evidence still covers a commit two pushes back — a debt no
 * commit to THIS repository can clear, only a sandbox re-run upstream. Read off the seed rather
 * than re-typed: `ledger-check.test.ts` pins the SHAs and the classifier; what the three tests
 * below pin is what the two consumers that print and exit DO with the split.
 */
const INFLIGHT = seedState().packets.find((p) => p.status === "submitted")!;
/** A head no packet records — GitHub having moved somewhere the committed ledger does not claim. */
const UNRECORDED_HEAD = "b0a7edc0ffee11223344556677889900aabbccdd";

test("the clock exits 0 on a ledger that reconciles and still names the debt it cannot clear", () => {
  // The exit-code decision issue #49 exists to change, at the only place it is made. Both halves
  // are load-bearing and each is trivially satisfiable alone: gating on advisories reds the default
  // branch for days over a debt no merge can pay, and dropping the print erases the debt instead —
  // operationally the same act as re-stamping `evidence.reviewedSha`, which is the dishonesty #43
  // made impossible in the classifier. The clock must say the ledger reconciles AND say the proof
  // is behind, and mean both.
  const witnessed = INFLIGHT.evidence!.reviewedSha!;
  const live = INFLIGHT.prMeta!.headSha;
  assert.notEqual(
    witnessed,
    live,
    "the committed seed owes no re-witness any more — re-point this test at the packet that does, or retire it; it cannot pass vacuously",
  );

  const run = runClock(livePrs());
  assert.equal(run.code, 0, `a ledger GitHub agrees with must not stop the clock:\n${run.out}`);
  assert.equal(/DIVERGENCE/.test(run.out), false, run.out);
  assert.match(
    run.stdout,
    new RegExp(`ledger ok: ${seedState().packets.filter((p) => p.prUrl).length} packets match GitHub`),
    run.out,
  );
  // The advisory LINE, not the summary's count of it. Deleting the `ADVISORY` print still leaves
  // `; 1 advisory outstanding (see above)` on stdout pointing at nothing, so a count assertion on
  // its own stays green over exactly the silence this asserts against.
  assert.match(
    run.out,
    new RegExp(`^ADVISORY ${INFLIGHT.id}: .*${witnessed.slice(0, 7)}.*${live.slice(0, 7)}`, "m"),
    `the clock must name both SHAs of the outstanding re-witness:\n${run.out}`,
  );
  assert.match(run.stdout, /1 advisory outstanding/, run.out);
});

test("the clock exits 1 on a ledger GitHub contradicts, with the advisory printed beside it", () => {
  // The other direction, and the guard on the demotion: moving evidence staleness to advisory must
  // not carry the SPEC.md §7 check with it, and the advisory must not mask the divergence it is
  // printed next to — a clock that prints only the debt it cannot fix, while GitHub contradicts the
  // published ledger, is worse than one that prints nothing.
  const run = runClock(livePrs({ [INFLIGHT.prUrl!]: { headSha: UNRECORDED_HEAD } }));
  assert.equal(run.code, 1, `a live head the ledger does not record must stop the clock:\n${run.out}`);
  assert.match(
    run.out,
    new RegExp(
      `^DIVERGENCE ${INFLIGHT.id}: recorded head ${INFLIGHT.prMeta!.headSha.slice(0, 7)} but live head ${UNRECORDED_HEAD.slice(0, 7)}`,
      "m",
    ),
    run.out,
  );
  assert.equal(/ledger ok/.test(run.stdout), false, `a stopped clock must not also report success:\n${run.out}`);
  assert.match(
    run.out,
    new RegExp(`^ADVISORY ${INFLIGHT.id}: .*${INFLIGHT.evidence!.reviewedSha!.slice(0, 7)}`, "m"),
    `the re-witness debt is still owed and must not be swallowed by the divergence:\n${run.out}`,
  );
});

test("reconcile calls a contradiction DIVERGENCE and a re-witness debt ADVISORY, and counts them apart", () => {
  // The clock's sibling consumer of the same split. It gates on nothing, so the two labels and the
  // two counters ARE its entire output contract: swap the buckets and a debt no merge can pay reads
  // as the ledger lying, while a ledger GitHub actually contradicts reads as routine — one word
  // meaning opposite things in the two places an operator reads it.
  const seed = seedState();
  const path = writeState(seed);
  const claimedMerged = seed.packets.filter((p) => p.status === "merged" && p.prUrl);
  assert.ok(
    claimedMerged.length > 1,
    "more than one, so `divergences=` and `advisories=` differ and the counter line alone tells the buckets apart",
  );

  const run = runCli(["reconcile", "--state", path], tmpdir(), {
    preload: prFactsStub(
      livePrs(
        Object.fromEntries(
          claimedMerged.map((p) => [p.prUrl!, { state: "open" as const, merged: false }]),
        ),
      ),
    ),
  });
  assert.equal(run.code, 0, run.out);

  for (const packet of claimedMerged) {
    assert.match(
      run.out,
      new RegExp(`^DIVERGENCE ${packet.id}: ledger says merged but the PR is open and unmerged`, "m"),
      `a ledger GitHub contradicts is a DIVERGENCE, never an advisory:\n${run.out}`,
    );
  }
  assert.match(
    run.out,
    new RegExp(`^ADVISORY ${INFLIGHT.id}: .*${INFLIGHT.evidence!.reviewedSha!.slice(0, 7)}`, "m"),
    `a debt on a ledger that already reconciles is an ADVISORY, never a divergence:\n${run.out}`,
  );
  assert.match(
    run.stdout,
    new RegExp(`divergences=${claimedMerged.length} advisories=1`),
    `the counters must follow the buckets they count:\n${run.out}`,
  );
});

/**
 * A ledger with nothing in it, so `tick` walks `allowlist.yaml`'s named `firstIssues` from the top
 * and the Wave-0 rows are the only selectable ones. Wave 1+ needs two attested Wave 0 merges, and
 * there are none here — which fixes the candidate order to orca-fleet#71 then frontguard#195.
 */
function emptyLedger(): FactoryState {
  return {
    version: 6,
    packets: [],
    events: [],
    scorecard: emptyScorecard(),
    ticksRun: 0,
    lastTickAt: null,
    mergedTotal: 0,
    bans: 0,
    humanApprovalsRemaining: 20,
  };
}

/** A `gated` packet on the roster's first named issue — the state `approve` is the next step from. */
function gatedOn71(): FactoryState {
  return {
    ...emptyLedger(),
    packets: [
      buildPacket({
        repoId: "ravidsrk/orca-fleet",
        issueNumber: 71,
        issueTitle: "[P2] Validator: one unreadable SKILL.md must not abort the catalog",
        issueUrl: "https://github.com/ravidsrk/orca-fleet/issues/71",
      }),
    ],
  };
}

test("tick stands down on a named first issue GitHub has already closed", () => {
  // The live case, not a hypothetical: `allowlist.yaml`'s first named row IS
  // ravidsrk/orca-fleet#71, and GitHub closed it (state_reason completed) on 2026-08-27. Before
  // this gate the factory scouted it anyway, because competing-work detection reads only OPEN
  // pull requests — a merged-and-closed fix is byte-identical to an untouched issue there.
  const stub = githubStub("record", {
    "ravidsrk/orca-fleet#71": {
      state: "closed",
      reason: "completed",
      closedBy: "ravidsrk",
      closedByPr: "https://github.com/ravidsrk/orca-fleet/pull/72",
    },
    // A roster row whose number turns out to name a pull request. Same read, same refusal — the
    // issues endpoint serves both, so without this the config error reads as a healthy issue.
    "github/awesome-copilot#2684": { state: "open", isPr: true },
  });
  const path = writeState(emptyLedger());
  const ticked = runCli(["tick", "--state", path], tmpdir(), { preload: stub.preload });
  assert.equal(ticked.code, 0, ticked.out);

  // Skipped, not consumed: the next named row is scouted in the same tick.
  assert.match(ticked.stdout, /ravidsrk\/frontguard#195/, ticked.out);
  assert.equal(
    /ravidsrk\/orca-fleet#71/.test(ticked.stdout),
    false,
    `a closed issue must not become a packet:\n${ticked.out}`,
  );
  assert.match(ticked.out, /stand down: ravidsrk\/orca-fleet#71 is closed/, ticked.out);
  // Who resolved it, so the operator can go look rather than guess.
  assert.match(ticked.out, /pull\/72/, ticked.out);
  assert.match(ticked.out, /github\/awesome-copilot#2684 is a pull request, not an issue/, ticked.out);

  const onDisk = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  assert.equal(
    onDisk.packets.some((p) => p.issueNumber === 71),
    false,
    "no packet may exist for the closed issue",
  );
  // Durable, not just a terminal line: the ledger has to explain why a named row went unscouted.
  assert.ok(
    onDisk.events.some((e) => /orca-fleet#71/.test(e.message) && /closed/.test(e.message)),
    `the ledger must record the skip and its reason:\n${JSON.stringify(onDisk.events, null, 2)}`,
  );

  // With every selectable row closed there is nothing left to move on to, and this is where the
  // blocked set earns its keep: `pickCandidate` falls back to walking `allowlist.yaml` itself, so
  // omitting a candidate from the scouted list does NOT keep it out — only `applyTick`'s blocked
  // keys do. Doctrine here is docs/04-stations.md §1: the tick idles, it does not invent work.
  const allClosed = githubStub("record", {
    "ravidsrk/orca-fleet#71": { state: "closed", reason: "completed" },
    "ravidsrk/frontguard#195": { state: "closed", reason: "completed" },
  });
  const idlePath = writeState(emptyLedger());
  const idle = runCli(["tick", "--state", idlePath], tmpdir(), { preload: allClosed.preload });
  assert.equal(idle.code, 0, idle.out);
  assert.match(idle.stdout, /^idle$/m, idle.out);
  const idleDisk = JSON.parse(readFileSync(idlePath, "utf8")) as FactoryState;
  assert.deepEqual(
    idleDisk.packets.map((p) => `${p.repoId}#${p.issueNumber}`),
    [],
    `no closed row may be scouted through the allowlist fallback:\n${idle.out}`,
  );
});

test("approve refuses the freeze when the issue closed since gating", () => {
  // SPEC.md §4: the approval step re-checks for competing upstream work and stands down rather
  // than proceed. An issue closed since gating is the strongest form of that — the work is done or
  // unwanted — and it is invisible to the open-PR check the freeze already runs.
  const path = writeState(gatedOn71());
  const stub = githubStub("record", {
    "ravidsrk/orca-fleet#71": { state: "closed", reason: "completed", closedBy: "ravidsrk" },
  });
  const refused = runCli(
    ["approve", "pkt_ravidsrk_orca-fleet_71", "--note", "looks fine", "--by", "ravidsrk", "--state", path],
    tmpdir(),
    { preload: stub.preload },
  );
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /stand down/, refused.out);
  assert.match(refused.out, /ravidsrk\/orca-fleet#71/, refused.out);
  assert.match(refused.out, /closed/, refused.out);
  assert.equal(/^approved /m.test(refused.stdout), false, "the freeze must not be reported as done");
  // The instruction, not just the reason: it names the operator's real verb and the do-nothing,
  // and deliberately differs per gate (open-draft says `draft-ready`). There is no `park` command
  // for a human to type — issue #62 — so a refusal must never send one looking for it.
  assert.match(refused.out, /Reject or leave it gated — do not approve\./, refused.out);
  assert.equal(/\bpark\b/.test(refused.out), false, `no refusal may name a verb the CLI lacks:\n${refused.out}`);

  // The refusal writes nothing: no attest, no status change. `reject` stays the operator's verb.
  const onDisk = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  const packet = onDisk.packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_71");
  assert.equal(packet?.status, "gated", "a refused freeze must not move the packet");
  assert.equal(packet?.humanAttest, undefined, "a refused freeze must not stamp an attestation");

  // Not a blanket refusal: the same freeze on an open issue still lands.
  const openPath = writeState(gatedOn71());
  const allowed = runCli(
    ["approve", "pkt_ravidsrk_orca-fleet_71", "--note", "looks fine", "--by", "ravidsrk", "--state", openPath],
    tmpdir(),
    { preload: githubStub("record").preload },
  );
  assert.equal(allowed.code, 0, allowed.out);
  assert.match(allowed.stdout, /approved pkt_ravidsrk_orca-fleet_71/);
});

test("open-draft refuses a closed issue before any write reaches GitHub", () => {
  // The moment of contact (SPEC.md §6). A check only at selection goes stale — an issue can close
  // while a packet is in flight — and by here the implementation is already done, so the only thing
  // left to protect is the maintainer's attention. The POST is what must not happen.
  const stub = githubStub("record", {
    "ColeMurray/background-agents#1476": {
      state: "closed",
      reason: "not_planned",
      closedBy: "ColeMurray",
    },
  });
  const path = writeState(draftReadyState());
  const refused = runCli(
    ["open-draft", DRAFT_READY_ID, "--head", "ravidsrk:foundry/issue-1476", "--state", path],
    tmpdir(),
    { preload: stub.preload, env: { FOUNDRY_PAT: "test-pat" } },
  );
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /stand down/, refused.out);
  assert.match(refused.out, /ColeMurray\/background-agents#1476/, refused.out);
  assert.match(refused.out, /not planned/i, refused.out);
  // Same doctrine as the freeze-time refusal, different do-nothing: the packet is `draft-ready`
  // here, not `gated`. `park` is a status the engine writes, never a command (issue #62).
  assert.match(refused.out, /Reject or leave it draft-ready — do not open\./, refused.out);
  assert.equal(/\bpark\b/.test(refused.out), false, `no refusal may name a verb the CLI lacks:\n${refused.out}`);

  // Proof, not a proxy: the stub logs every call, and no create may appear in it.
  const calls = existsSync(stub.log) ? readFileSync(stub.log, "utf8") : "";
  assert.equal(/^POST /m.test(calls), false, `no draft may be created:\n${calls}`);
  assert.match(calls, /^GET https:\/\/api\.github\.com\/repos\/ColeMurray\/background-agents\/issues\/1476$/m, calls);

  const onDisk = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  const packet = onDisk.packets.find((p) => p.id === DRAFT_READY_ID);
  assert.equal(packet?.status, "draft-ready", "a refused open-draft must not move the packet");
  assert.equal(packet?.prUrl, undefined);
});

test("an unreadable issue refuses at all three gates rather than proceeding blind", () => {
  // Fail closed, like every other read on these paths. "GitHub would not tell us" is not "the
  // issue is open" — proceeding on a 500 opens exactly the PR the gate exists to stop. All three
  // call sites implement this identically, so all three are pinned: an untested guard is a guard
  // that can be deleted, and only the write gate has a second line of defence in the fetcher.
  const openDraftStub = githubStub("record", { "ColeMurray/background-agents#1476": "unreadable" });
  const path = writeState(draftReadyState());
  const refused = runCli(
    ["open-draft", DRAFT_READY_ID, "--head", "ravidsrk:foundry/issue-1476", "--state", path],
    tmpdir(),
    { preload: openDraftStub.preload, env: { FOUNDRY_PAT: "test-pat" } },
  );
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /GitHub 500 reading ColeMurray\/background-agents#1476/, refused.out);
  const calls = existsSync(openDraftStub.log) ? readFileSync(openDraftStub.log, "utf8") : "";
  assert.equal(/^POST /m.test(calls), false, `no draft may be created:\n${calls}`);

  // tick: the read-only gate, and the one that decides what gets scouted at all. A 500 must abort
  // the tick, not fall through to the competing-work check with an unread issue — `clear` there
  // would gate a packet on an issue nobody can confirm is open.
  const tickStub = githubStub("record", { "ravidsrk/orca-fleet#71": "unreadable" });
  const tickPath = writeState(emptyLedger());
  const ticked = runCli(["tick", "--state", tickPath], tmpdir(), { preload: tickStub.preload });
  assert.equal(ticked.code, 1, `an unreadable issue must abort the tick:\n${ticked.out}`);
  assert.match(ticked.out, /GitHub 500 reading ravidsrk\/orca-fleet#71/, ticked.out);
  const tickDisk = JSON.parse(readFileSync(tickPath, "utf8")) as FactoryState;
  assert.deepEqual(
    tickDisk.packets.map((p) => `${p.repoId}#${p.issueNumber}`),
    [],
    `a tick that could not read the issue must scout nothing:\n${ticked.out}`,
  );

  // approve: the freeze. A 500 must refuse the attestation, not stamp one on an issue whose state
  // GitHub declined to report.
  const approveStub = githubStub("record", { "ravidsrk/orca-fleet#71": "unreadable" });
  const approvePath = writeState(gatedOn71());
  const approved = runCli(
    ["approve", "pkt_ravidsrk_orca-fleet_71", "--note", "looks fine", "--by", "ravidsrk", "--state", approvePath],
    tmpdir(),
    { preload: approveStub.preload },
  );
  assert.equal(approved.code, 1, `an unreadable issue must refuse the freeze:\n${approved.out}`);
  assert.match(approved.out, /GitHub 500 reading ravidsrk\/orca-fleet#71/, approved.out);
  const approveDisk = JSON.parse(readFileSync(approvePath, "utf8")) as FactoryState;
  const packet = approveDisk.packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_71");
  assert.equal(packet?.status, "gated", "an unreadable issue must not move the packet");
  assert.equal(packet?.humanAttest, undefined, "an unreadable issue must not stamp an attestation");
});
