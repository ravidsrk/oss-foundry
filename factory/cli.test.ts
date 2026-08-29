import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tmp } from "./tmp-dir.ts";
import { ALLOWLIST } from "./allowlist.ts";
import { assertDisjointCounts } from "./fixture-counts.ts";
import { applySecondaryLimitHalt } from "./halt.ts";
import { packetChecks } from "./ledger-check.ts";
import { DISCLOSURE } from "./neighbor.ts";
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
  const path = join(tmp("foundry-cli-"), "state.json");
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
  const dir = tmp("foundry-stub-");
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
  /**
   * The body GitHub serves. `packetChecks` reads it for the SPEC.md §6 disclosure MUST (issue
   * #38), so it is a fact of the reconciliation exactly like `headSha`, and a stub that omits it
   * is a stub that cannot tell a compliant PR from an undisclosed one.
   */
  body: string;
  /** The merge facts a revert re-check needs (issue #39); defaulted from the committed prMeta. */
  mergeCommitSha?: string;
  mergedAt?: string;
  baseRef?: string;
  /** What `GET /pulls/{n}/reviews` and `/comments` answer. Bots included — filtering is the code's job. */
  reviews?: { login: string; type?: string }[];
  reviewComments?: { login: string; type?: string }[];
  /**
   * GitHub 500s both review endpoints. The fail-closed input for the human-review split: the sync
   * then records `humanReview` as ABSENT, which is "not observed" and emphatically not "nobody
   * reviewed it" — the distinction the two review KPIs are built on (issue #39).
   */
  reviewsUnreadable?: boolean;
}

/** What `GET /repos/{owner}/{repo}/commits?since=…` answers, keyed by repo id. */
type CommitFacts = Record<string, { sha: string; message: string; committedAt: string }[]>;

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
    const { draft, state, merged, headSha, updatedAt, mergeCommitSha, mergedAt, baseRef } = packet.prMeta;
    // The body Foundry prepared, which is what "GitHub says exactly what the ledger says" means
    // for the disclosure MUST. The live #1652 body does NOT say this — the drift is the subject of
    // its own test below, stated there as the one fact that test changes.
    table[packet.prUrl] = {
      draft,
      state,
      merged,
      headSha,
      updatedAt,
      body: packet.prBody ?? "",
      mergeCommitSha,
      mergedAt,
      baseRef,
    };
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
 *
 * The empty open-pulls list and empty timeline are served too, because `attach-draft` re-runs the
 * competing-work check before it binds anything: without them the verb refuses on a 404 and every
 * assertion about the binding rules would be passing over a network error instead.
 */
function prFactsStub(
  table: Record<string, LivePr>,
  commits: CommitFacts = {},
  // Two ways the commit read can be less than a clean answer, per repo id. `fail` is GitHub
  // refusing outright; `truncate` is GitHub answering with a `Link: rel="next"` that never runs
  // out, so the paginated read stops at its page cap. The second exists because a capped read and
  // a clean one return the same commits and the same verdict — the clock has to tell them apart.
  commitReads: { fail?: string[]; truncate?: string[] } = {},
): string {
  const preload = join(tmp("foundry-prfacts-"), "preload.mjs");
  writeFileSync(
    preload,
    `const facts = ${JSON.stringify(table)};
const commitFacts = ${JSON.stringify(commits)};
const commitFail = ${JSON.stringify(commitReads.fail ?? [])};
const commitTruncate = ${JSON.stringify(commitReads.truncate ?? [])};
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const actors = (list) => (list ?? []).map((u) => ({ user: { login: u.login, type: u.type } }));
globalThis.fetch = async (url) => {
  const u = String(url);
  if (/\\/pulls\\?state=open/.test(u)) return json(200, []);
  if (/\\/issues\\/\\d+\\/timeline/.test(u)) return json(200, []);
  const parts = new URL(u).pathname.split("/").filter(Boolean);
  // The revert re-check's commit listing (issue #39). Answered per repo; the default is "nothing
  // landed on the base branch since the merge", which is a real answer, not a hole.
  if (parts[0] === "repos" && parts[3] === "commits") {
    const repoId = parts[1] + "/" + parts[2];
    if (commitFail.includes(repoId)) return json(500, { message: "commits unavailable" });
    const list = commitFacts[repoId] ?? [];
    const body = list.map((c) => ({ sha: c.sha, commit: { message: c.message, committer: { date: c.committedAt } } }));
    if (commitTruncate.includes(repoId)) {
      // A cursor that never ends, exactly as far as the reader can tell from the header. It points
      // back at this same path, so every page answers and only the page cap ever stops the read.
      const page = Number(new URL(u).searchParams.get("page") ?? "1") + 1;
      const next = "https://api.github.com/repos/" + repoId + "/commits?page=" + page;
      return json(200, body, { link: '<' + next + '>; rel="next", <' + next + '>; rel="last"' });
    }
    return json(200, body);
  }
  const path = parts[0] === "repos" && parts[3] === "pulls"
    ? parts[1] + "/" + parts[2] + "/pull/" + parts[4]
    : "";
  const pr = facts["https://github.com/" + path];
  if (!pr) return json(404, { message: "unstubbed " + url });
  // The two review surfaces the human-review split is read from (issue #39). Sub-resources of the
  // pull, so they are matched before the pull itself.
  if (parts[5] === "reviews" || parts[5] === "comments") {
    if (pr.reviewsUnreadable) return json(500, { message: "review endpoints unavailable" });
    return json(200, actors(parts[5] === "reviews" ? pr.reviews : pr.reviewComments));
  }
  return json(200, {
    html_url: "https://github.com/" + path,
    title: "stub",
    body: pr.body,
    draft: pr.draft,
    state: pr.state,
    merged: pr.merged,
    mergeable_state: "clean",
    commits: 1,
    review_comments: (pr.reviewComments ?? []).length,
    comments: 0,
    head: { sha: pr.headSha },
    base: { ref: pr.baseRef ?? "main" },
    merge_commit_sha: pr.mergeCommitSha ?? null,
    merged_at: pr.mergedAt ?? null,
    updated_at: pr.updatedAt,
  });
};
`,
  );
  return preload;
}

function runClock(
  table: Record<string, LivePr>,
  commits: CommitFacts = {},
  commitReads: { fail?: string[]; truncate?: string[] } = {},
): Spawned {
  return runNode(CLOCK, [], tmpdir(), { preload: prFactsStub(table, commits, commitReads) });
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
  const decoyDir = tmp("foundry-anchor-");
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
  const missing = join(tmp("foundry-cli-"), "absent.json");
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
 * The disclosure block ColeMurray/background-agents#1652 actually carries, read-only from
 * `GET /repos/ColeMurray/background-agents/pulls/1652` (fetched 2026-08-29). ADR 0004 added the
 * `(ravidsrk/oss-foundry)` qualifier to `DISCLOSURE` after this PR was open; an open PR's body is
 * not retroactively patched by a constant change, so the live block is still the unqualified one.
 * Transcribed, not derived — a derivation would follow the constant, and not following it is the
 * whole fact under test.
 */
const LIVE_DISCLOSURE_1652 = `This patch was prepared by Foundry, an operator-gated contribution factory.
A human reviewed the packet, the diff, and the tests before this draft was opened.
The factory does not merge. Maintainers own the merge.`;

test("the clock names the live disclosure drift it cannot fix, and still exits 0", () => {
  // SPEC.md §6 is a MUST, and until issue #38 the clock was structurally unable to see it break:
  // `packetChecks` diffed status, draft and head, never body text. So the qualifier landed in
  // `DISCLOSURE` while #1652 was open, the live body kept the old block, and `verify-ledger`
  // printed `ledger ok` over a violated MUST on a stranger's repository.
  //
  // Advisory, not fatal, and both halves are load-bearing here because this is where the choice is
  // actually made. Fatal would red `main` until someone edits a pull request on a repo this
  // project does not own — an outward write needing an operator's explicit go — which is precisely
  // the "green by any means" pressure #49 removed for the re-witness debt. Silence would be worse:
  // the doctrine would be unenforced and unspoken.
  assert.notEqual(
    LIVE_DISCLOSURE_1652,
    DISCLOSURE,
    "the transcribed live block matches the constant — re-fetch #1652 or this test is vacuous",
  );
  const drifted = `## Summary\n\nFixes #1476\n\n## Disclosure\n\n${LIVE_DISCLOSURE_1652}\n`;
  const run = runClock(livePrs({ [INFLIGHT.prUrl!]: { body: drifted } }));

  assert.equal(run.code, 0, `a body no commit here can edit must not stop the clock:\n${run.out}`);
  assert.equal(/DIVERGENCE/.test(run.out), false, run.out);
  // The DRIFT, specifically — not merely the word "disclosure". `disclosureDivergence` also
  // reports "the body was not supplied", and a call site that stopped passing `synced.body` would
  // still print a line containing "disclosure": the looser assertion passed under exactly the
  // wiring mutation this test exists to catch.
  assert.match(
    run.out,
    new RegExp(`^ADVISORY ${INFLIGHT.id}: live PR body carries a Foundry disclosure that is not the current block`, "m"),
    `the clock must read the live body and name the drift it found:\n${run.out}`,
  );
  // Beside the re-witness debt, not instead of it: two independent debts on the same packet, and a
  // check that reported only the newer one would have quietly retired the older.
  assert.match(
    run.out,
    new RegExp(`^ADVISORY ${INFLIGHT.id}: .*${INFLIGHT.evidence!.reviewedSha!.slice(0, 7)}`, "m"),
    `the re-witness debt must survive alongside the disclosure drift:\n${run.out}`,
  );
  assert.match(run.stdout, /2 advisory outstanding/, run.out);
});

test("reconcile prints the disclosure drift as an ADVISORY and counts it", () => {
  // The split's other consumer. A classifier that buckets correctly behind a call site that never
  // passes the body reports nothing, and the two verbs an operator reads would disagree about
  // whether the doctrine is being checked at all.
  const seed = seedState();
  const path = writeState(seed);
  const drifted = `## Summary\n\nFixes #1476\n\n## Disclosure\n\n${LIVE_DISCLOSURE_1652}\n`;
  const run = runCli(["reconcile", "--state", path], tmpdir(), {
    preload: prFactsStub(livePrs({ [INFLIGHT.prUrl!]: { body: drifted } })),
  });

  assert.equal(run.code, 0, run.out);
  // Same tightening as the clock test: naming the drift, not just the topic, is what proves this
  // call site passed the live body rather than reporting that it had none.
  assert.match(
    run.out,
    new RegExp(`^ADVISORY ${INFLIGHT.id}: live PR body carries a Foundry disclosure that is not the current block`, "m"),
    `reconcile must read the live body too:\n${run.out}`,
  );
  assert.match(
    run.stdout,
    /divergences=0 advisories=2/,
    `the drift must reach the counter, beside the re-witness debt:\n${run.out}`,
  );
});

test("attach-draft refuses a browser-opened PR whose body carries no disclosure", () => {
  // The moment of contact on the only route still open for a repo the App 403s on
  // (docs/07-github-app.md): a human opens the PR in a browser, then binds it here. `open-draft`
  // refuses a body without the block before its POST; this verb did not, in the CLI or in the
  // reducer — so the one path that actually produced #1652's shortened disclosure was the one path
  // with no gate on it. Issue #38.
  const seed = draftReadyState();
  const packet = seed.packets.find((p) => p.status === "draft-ready" && p.evidence)!;
  const url = "https://github.com/ColeMurray/background-agents/pull/1652";
  const path = writeState(seed);
  const run = runCli(["attach-draft", packet.id, url, "--state", path], tmpdir(), {
    preload: prFactsStub({
      [url]: {
        draft: true,
        state: "open",
        merged: false,
        headSha: packet.evidence!.reviewedSha!,
        updatedAt: "2026-08-28T16:16:39Z",
        body: `Fixes #${packet.issueNumber}\n\nSee the issue for context, nothing else to say here.`,
      },
    }),
  });

  assert.equal(run.code, 1, `a body without the disclosure must not bind:\n${run.out}`);
  assert.match(run.out, /verbatim disclosure/, run.out);
  // The ledger is the proof, not the exit code: a refusal that still wrote the packet would leave
  // an undisclosed live PR recorded as a Foundry contribution.
  const after = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  const bound = after.packets.find((p) => p.id === packet.id)!;
  assert.equal(bound.status, "draft-ready", `a refused attach must not move the packet:\n${run.out}`);
  assert.equal(bound.prUrl, undefined, `a refused attach must not record a PR URL:\n${run.out}`);
});

test("attach-draft binds the same PR once its body carries the verbatim block", () => {
  // The complement, so the gate above is a body check and not a broken verb. Same packet, same
  // URL, same stub — one fact different.
  const seed = draftReadyState();
  const packet = seed.packets.find((p) => p.status === "draft-ready" && p.evidence)!;
  const url = "https://github.com/ColeMurray/background-agents/pull/1652";
  const path = writeState(seed);
  const run = runCli(["attach-draft", packet.id, url, "--state", path], tmpdir(), {
    preload: prFactsStub({
      [url]: {
        draft: true,
        state: "open",
        merged: false,
        headSha: packet.evidence!.reviewedSha!,
        updatedAt: "2026-08-28T16:16:39Z",
        body: `Fixes #${packet.issueNumber}\n\n## Disclosure\n\n${DISCLOSURE}\n`,
      },
    }),
  });

  assert.equal(run.code, 0, run.out);
  const after = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  const bound = after.packets.find((p) => p.id === packet.id)!;
  assert.equal(bound.status, "submitted", run.out);
  assert.equal(bound.prUrl, url, run.out);
});

/**
 * A preload for the PAT create path: the pre-flight reads `open-draft` makes, a `POST /pulls` that
 * echoes back what was sent (GitHub stores the body it is given), and the `GET /pulls/{n}` the
 * verb then syncs. Without the echo the create and the sync could disagree about the body and
 * nothing would notice — which is the whole failure class `applyAttachDraft` now guards.
 */
function createStub(): string {
  const preload = join(tmp("foundry-create-"), "preload.mjs");
  writeFileSync(
    preload,
    `let created = null;
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "POST" && /\\/pulls$/.test(u)) {
    const sent = JSON.parse(init.body);
    created = { ...sent, html_url: u.replace("https://api.github.com/repos/", "https://github.com/").replace(/\\/pulls$/, "/pull/4242"), number: 4242 };
    return json(201, created);
  }
  if (/\\/pulls\\?state=open/.test(u)) return json(200, []);
  if (/\\/issues\\/\\d+\\/timeline/.test(u)) return json(200, []);
  if (/\\/issues\\/\\d+$/.test(u)) {
    const n = Number(u.split("/").pop());
    return json(200, { number: n, html_url: "https://github.com/x/y/issues/" + n, state: "open", state_reason: null, closed_at: null, closed_by: null });
  }
  if (/\\/pulls\\/\\d+$/.test(u)) {
    if (!created) return json(404, { message: "nothing created yet" });
    return json(200, {
      html_url: created.html_url,
      title: created.title,
      body: created.body,
      draft: true,
      state: "open",
      merged: false,
      mergeable_state: "clean",
      commits: 1,
      review_comments: 0,
      comments: 0,
      head: { sha: ${JSON.stringify("PLACEHOLDER")} },
      updated_at: "2026-08-29T00:00:00Z",
    });
  }
  return json(404, { message: "unstubbed " + method + " " + u });
};
`,
  );
  return preload;
}

test("open-draft records its own POST through the same disclosure gate", () => {
  // `applyAttachDraft` has two production call sites, and the gate is in the reducer precisely so
  // both are covered. This is the other one: `open-draft` renders the body, refuses it before the
  // POST if the block is missing, then hands GitHub's copy back to the reducer. Pinning it here is
  // what stops the create path from silently breaking on a reducer that just grew a refusal.
  const seed = draftReadyState();
  const packet = seed.packets.find((p) => p.status === "draft-ready" && p.evidence)!;
  const path = writeState(seed);
  const preload = readFileSync(createStub(), "utf8").replace(
    JSON.stringify("PLACEHOLDER"),
    JSON.stringify(packet.evidence!.reviewedSha!),
  );
  const preloadPath = join(tmp("foundry-create2-"), "preload.mjs");
  writeFileSync(preloadPath, preload);

  const run = runCli(
    ["open-draft", packet.id, "--head", "ravidsrk:foundry/issue-1476", "--state", path],
    tmpdir(),
    { preload: preloadPath, env: { FOUNDRY_PAT: "test-pat" } },
  );
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /packet submitted/, run.out);

  const after = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  const bound = after.packets.find((p) => p.id === packet.id)!;
  assert.equal(bound.status, "submitted", run.out);
  // The body it actually posted carried the block — that is why the reducer accepted it.
  assert.equal(bound.prBody?.includes(DISCLOSURE), true, "open-draft must post the verbatim block");
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

/**
 * Issue #79 — SPEC.md §6 is "a platform secondary rate limit MUST halt the factory, never retry",
 * and requesting-then-refusing IS the retry.
 *
 * `open-draft` got this gate (`refusing to open a draft on …`, pinned above); `tick` and `approve`
 * are its siblings and did not. With a persisted halt on disk, `tickWithGithub` walked the whole
 * roster — open pulls, AGENTS.md, CONTRIBUTING, issue state, timeline — and only discovered the
 * halt afterwards, inside `applyTick` → `maySelectRepo`. Measured on this tree before the fix: 24
 * requests for `tick` — six per named roster row (open pulls, AGENTS.md, CONTRIBUTING.md,
 * .github/CONTRIBUTING.md, the issue, its timeline) across the four rows — and 3 for `approve`,
 * every one of them against the very limit that caused the halt, and every re-run of the halted CLI
 * spends them again. (The `20` this comment carried through round 1 was never reproducible here; it
 * is reachable only against live GitHub, where a row can answer in fewer requests.)
 *
 * The assertion is therefore a COUNT, not a verdict. A refused verdict is exactly what the broken
 * code already produced — it refused after spending the requests — so asserting on the refusal
 * alone would have been green before the fix and green after it, and would have pinned nothing.
 */
test("a persisted halt stops tick and approve before a single GitHub request", () => {
  const halt = (state: FactoryState) =>
    applySecondaryLimitHalt(state, { repoId: DRAFT_READY_REPO, at: "2026-08-29T09:00:00.000Z" });
  const requests = (log: string) =>
    (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter(Boolean);

  // tick: the read-only path, and the one that spends the most — every named row on the roster.
  const tickStub = githubStub("record");
  const tickPath = writeState(halt(emptyLedger()));
  const ticked = runCli(["tick", "--state", tickPath], tmpdir(), { preload: tickStub.preload });
  assert.equal(ticked.code, 1, `a halted tick must not report success:\n${ticked.out}`);
  assert.deepEqual(
    requests(tickStub.log),
    [],
    `a halted tick must contact GitHub zero times; it made:\n${requests(tickStub.log).join("\n")}`,
  );
  // …and says which halt, so the operator is not left reading `idle` on a bricked factory. `idle`
  // is the specific wrong answer here: with the halt refusing every repo inside `pickCandidate`,
  // a gate that merely returned no candidate would print "no named candidate" and exit 0.
  assert.match(ticked.out, /Factory halted 2026-08-29T09:00:00\.000Z/, ticked.out);
  assert.equal(/no named candidate/.test(ticked.stdout), false, ticked.out);
  const tickLedger = JSON.parse(readFileSync(tickPath, "utf8")) as FactoryState;
  assert.deepEqual(tickLedger.packets.map((p) => p.id), [], "a halted tick must scout nothing");
  // …and the refusal is IN THE LEDGER, not only on the terminal. `applyTick`'s halt branch calls
  // `appendEvent` before returning, and dropping that call leaves a tick that refused with no
  // record it ever ran: the console line evaporates with the exit, and the next reader of the
  // ledger sees a six-hour gap with no cause. Every other refusal in this file writes one.
  assert.equal(
    tickLedger.events.some(
      (e) => e.kind === "tick" && /Tick refused — factory halted 2026-08-29T09:00:00\.000Z/.test(e.message),
    ),
    true,
    `a halted tick must leave a ledger event: ${JSON.stringify(tickLedger.events)}`,
  );

  // approve: the freeze. The evidence render is local and must still print — the human's read is
  // the point of the verb — but nothing may go out over the wire.
  const approveStub = githubStub("record");
  const approvePath = writeState(halt(gatedOn71()));
  const approved = runCli(
    ["approve", "pkt_ravidsrk_orca-fleet_71", "--note", "looks fine", "--by", "ravidsrk", "--state", approvePath],
    tmpdir(),
    { preload: approveStub.preload },
  );
  assert.equal(approved.code, 1, approved.out);
  assert.deepEqual(
    requests(approveStub.log),
    [],
    `a halted approve must contact GitHub zero times; it made:\n${requests(approveStub.log).join("\n")}`,
  );
  assert.match(approved.out, /Factory halted 2026-08-29T09:00:00\.000Z/, approved.out);
  // The freeze evidence is not network work and is not skipped by the gate.
  assert.match(approved.stdout, /Policy text the gate parsed/, approved.stdout);
  const approveDisk = JSON.parse(readFileSync(approvePath, "utf8")) as FactoryState;
  assert.equal(approveDisk.packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_71")?.humanAttest, undefined);

  // The control: without the halt, both verbs DO reach GitHub. Otherwise "zero requests" would be
  // satisfied by a CLI that had simply stopped working.
  const liveStub = githubStub("record");
  const liveTick = runCli(["tick", "--state", writeState(emptyLedger())], tmpdir(), { preload: liveStub.preload });
  assert.ok(
    requests(liveStub.log).length > 0,
    `an unhalted tick must still contact GitHub, or the assertion above is vacuous:\n${liveTick.out}`,
  );
});

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

/**
 * Issue #37: the human freeze is the documented second layer of defence over a scanner with a
 * known miss mode, and it was reading a verdict with the evidence discarded. `approve` now prints
 * the policy text the gate actually parsed before the attest is taken, so the operator confirms
 * against the maintainer's own words. This is the wiring test — the rendering itself is pinned in
 * `packet.test.ts`, and this file exists to kill a mutation of the CALL SITE, which no test of
 * `renderFreezeEvidence` can see.
 */
const FREEZE_CONTRIBUTING =
  "Thanks for contributing! Run `pnpm test` before opening a pull request and open an issue first for anything large.";

/** The seed with its in-flight slot given to a freshly gated Wave 1 packet, docs and all. */
function gatedState(docs: { agentsMd?: string; contributing?: string }): FactoryState {
  const seed = seedState();
  const gated = buildPacket({
    repoId: "mcp-use/mcp-use",
    issueNumber: 999,
    issueTitle: "docs typo",
    issueUrl: "https://github.com/mcp-use/mcp-use/issues/999",
    ...docs,
  });
  assert.equal(gated.status, "gated", "the fixture must actually reach the freeze station");
  return {
    ...seed,
    packets: [gated, ...seed.packets.filter((p) => p.status !== "submitted")],
  };
}

test("approve shows the operator the policy text the gate parsed", () => {
  const state = gatedState({ contributing: FREEZE_CONTRIBUTING });
  const path = writeState(state);
  const stub = githubStub("record");
  const run = runCli(
    ["approve", state.packets[0].id, "--note", "read CONTRIBUTING myself", "--by", "ravidsrk", "--state", path],
    tmpdir(),
    { preload: stub.preload },
  );
  assert.equal(run.code, 0, run.out);
  // The maintainer's own words, on the terminal, before the attest was written.
  assert.match(run.stdout, /open an issue first for anything large/);
  assert.match(run.stdout, new RegExp(`CONTRIBUTING[^\\n]*${FREEZE_CONTRIBUTING.length} chars`));
  assert.match(run.stdout, /no ban statement matched/i);
  assert.match(run.stdout, /approved /);
  assert.equal(
    JSON.parse(readFileSync(path, "utf8")).packets.find((p: { id: string }) => p.id === state.packets[0].id).status,
    "approved",
  );
});

test("approve tells the operator, on the terminal, how much policy text it is not showing them", () => {
  // The consumer half of issue #77. `renderFreezeEvidence` is pinned in `packet.test.ts`; this
  // exists because a rendering nobody prints protects nobody, and the freeze reaches the human
  // through exactly one call site. The scenario is the issue's: a >4,000-char CONTRIBUTING whose
  // only ban sits past the excerpt limit and which the scanner misses, so the verdict is ALLOW and
  // the operator is one keystroke from attesting over text they were never shown.
  //
  // The fixture is 5234 characters withholding 1234, matching `packet.test.ts`, and for the reason
  // stated there: the previous 4883/883 pair made `883` a substring of `4883`, so every assertion
  // below matched inside the total and the number an operator's decision rests on was pinned
  // nowhere. All three renderings are asserted here too, on the real terminal, because this is the
  // surface — `renderFreezeEvidence` being right does not mean `approve` printed it.
  const missedBan = "Kindly refrain from opening pull requests that were authored by an AI assistant.";
  const long = `${"Please read the guidelines below before opening a pull request.\n".repeat(200).slice(0, 5152)}\n${missedBan}\n`;
  const state = gatedState({ contributing: long });
  assert.equal(state.packets[0].policy.code, "ALLOW", "the scanner must miss this ban");
  const total = long.length;
  const withheld = total - 4000;
  assert.deepEqual([total, withheld], [5234, 1234]);
  // The same rule `packet.test.ts` states, from the same place. It used to be written out again
  // here, which is two copies of one precondition and therefore two things that can drift apart.
  assertDisjointCounts(total, withheld);
  const path = writeState(state);
  const stub = githubStub("record");
  const run = runCli(
    ["approve", state.packets[0].id, "--note", "read it", "--by", "ravidsrk", "--state", path],
    tmpdir(),
    { preload: stub.preload },
  );
  assert.equal(run.code, 0, run.out);
  // 1. the header, 2. the marker where the text stops, 3. the closing claim above the attest.
  assert.match(
    run.stdout,
    new RegExp(`CONTRIBUTING — ${total} chars \\(first 4000 shown, ${withheld} NOT shown\\)`),
    run.stdout,
  );
  assert.match(
    run.stdout,
    new RegExp(`⟪ ${withheld} more characters of CONTRIBUTING are NOT shown above`),
    run.stdout,
  );
  assert.match(
    run.stdout,
    new RegExp(`BUT ${withheld} of those ${total} characters are not shown above`),
    run.stdout,
  );
  assert.match(run.stdout, /The scanner read them; you have not/, run.stdout);
  // The ban really is invisible — that is the harm the notice exists to disclose, not to remove.
  assert.equal(run.stdout.includes(missedBan), false, "precondition: the ban is past the limit");
  // And the closing claim above the attest is qualified rather than a clean bill of health.
  assert.equal(
    run.stdout.includes(`no ban statement matched in ${total} chars from CONTRIBUTING.`),
    false,
    run.stdout.slice(-600),
  );
});

/**
 * ISSUE #78, AS A CLASS — the assertion round 1 of this sweep did not have.
 *
 * Round 1 closed two sinks (`runFailureDetail`, `resolveToolchain`) and its tests named those two
 * sinks. A test that names call sites cannot see a third, and there were at least nine more: seven
 * raw `fail()` sites in `witness.ts` interpolating a `setupCommand`'s output from inside the
 * untrusted clone, the freeze excerpt (the target repository's own CONTRIBUTING/AGENTS.md, third
 * -party text with LESS containment than witnessed stdout — nothing sandboxes a fetched document),
 * and `policy.matchedPhrases`, which are substrings of that same text.
 *
 * The freeze one defeated the fix landed beside it. A hostile `CONTRIBUTING.md` placing `\x1b[8m`
 * (SGR conceal, never reset) early in its text hides every line a terminal paints after it — which
 * is every disclosure issue #77 added. On this tree before the boundary, with the conceal at index
 * 178, the end-of-excerpt marker, the "scanner read them; you have not" line, the verdict and the
 * "high-recall suggester, not the arbiter" line ALL fell after it. The only surviving disclosure was
 * the header, which `packet.ts`'s own comment calls inadequate. A repository that did not want to be
 * read could suppress the notice telling the operator it had not been read.
 *
 * So this asserts over the CLASS, not over sinks: whatever the verb, whatever the route the bytes
 * took in, nothing a terminal ACTS on reaches the operator. The boundary is on the process's own
 * streams (`terminal.ts`), so a tenth sink is behind it the day it is written; `terminal.test.ts`
 * holds the other half — that every entry point installs it.
 */
const ACTIONABLE_BYTE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
/** OSC 52 (clipboard write), SGR conceal, CR repaint, screen clear, and both 8-bit introducers. */
const HOSTILE_BYTES = "\x1b]52;c;cm0gLXJmIH4=\x07\x1b[8m\r\x1b[2J\x9b31m\x9d0;pwned\x07";

function hostilePacketState(): FactoryState {
  const seed = seedState();
  // Four independent third-party routes into the render, in one packet.
  const packet = buildPacket({
    repoId: "mcp-use/mcp-use",
    issueNumber: 999,
    // 1. the issue title — GitHub's bytes, rendered by `body`, `evidence-page`, `status`, `ledger`.
    issueTitle: `docs typo ${HOSTILE_BYTES}`,
    issueUrl: "https://github.com/mcp-use/mcp-use/issues/999",
    // 2. the freeze excerpt, with the conceal placed early enough to hide every #77 disclosure, and
    //    3. a document long enough that there IS something withheld to disclose.
    contributing: `Thanks for contributing!${HOSTILE_BYTES}\n${"Please read the guidelines below before opening a pull request.\n".repeat(200).slice(0, 5000)}`,
    // 4. a matched phrase — the scanner quotes the repository's own words back at the operator.
    agentsMd: `AI-generated pull requests ${HOSTILE_BYTES} are not welcome in this repository.`,
  });
  assert.equal(packet.policy.code, "DENY_FORBIDDEN", "the fixture must reach the matched-phrase branch");
  assert.ok(
    packet.policy.matchedPhrases.some((q) => q.includes("52;c;")),
    "precondition: the hostile bytes really are inside a quoted phrase",
  );
  return { ...seed, packets: [packet, ...seed.packets.filter((p) => p.status !== "submitted")] };
}

test("no byte a terminal acts on reaches the operator, whatever the verb and whatever the route", () => {
  const state = hostilePacketState();
  const id = state.packets[0].id;
  const path = writeState(state);

  // Every verb that renders a packet. `approve` refuses this one (the scanner matched a ban) but
  // still prints the freeze first, which is the surface under test.
  for (const args of [
    ["approve", id, "--note", "n", "--by", "ravidsrk"],
    ["body", id],
    ["evidence-page", id],
    ["status"],
    ["ledger"],
  ]) {
    const stub = githubStub("record");
    const run = runCli([...args, "--state", path], tmpdir(), { preload: stub.preload });
    assert.equal(
      ACTIONABLE_BYTE.test(run.out),
      false,
      `\`${args[0]}\` put a control byte on the operator's terminal: ${JSON.stringify(run.out.slice(0, 400))}`,
    );
    assert.equal(run.out.includes("52;c;"), false, `\`${args[0]}\` left an OSC 52 body one concatenation from working`);
  }
});

test("a hostile CONTRIBUTING cannot conceal the disclosure that it was not fully shown", () => {
  // The composed attack, named as its own test because it is the one that defeats issue #77 rather
  // than merely being ugly: strip the conceal and every #77 disclosure is on the screen again.
  const state = hostilePacketState();
  const path = writeState(state);
  const stub = githubStub("record");
  const run = runCli(["approve", state.packets[0].id, "--note", "n", "--state", path], tmpdir(), {
    preload: stub.preload,
  });
  assert.equal(run.code, 1, "a matched ban must still refuse the approval");

  assert.equal(run.stdout.includes("\x1b[8m"), false, "the conceal must not reach the terminal");
  for (const disclosure of [/NOT shown/, /The scanner read them; you have not/, /Verdict: DENY_FORBIDDEN/, /high-recall suggester/]) {
    assert.match(run.stdout, disclosure, run.stdout.slice(0, 600));
  }
  // The removal is stated rather than tidied away in silence: a sanitiser that hands the operator a
  // coherent transcript with no sign that the coherence was ours is itself a concealment channel.
  assert.match(run.stdout, /byte\(s\) of terminal control sequence removed/, run.stdout.slice(-800));
});

test("approve prints the policy text before the competing-work reads, not after them", () => {
  // Ordering is the whole point of where the call sits. The competing-work check is a network read
  // that can fail and `process.exit(1)` — if the evidence printed after it, an operator hitting a
  // stand-down or an unreadable issue would never see the words they are here to read. The stand
  // down still refuses the approval; what is under test is that the evidence survived it.
  const state = gatedState({ contributing: FREEZE_CONTRIBUTING });
  const path = writeState(state);
  const stub = githubStub("record", { "mcp-use/mcp-use#999": { state: "closed" } });
  const run = runCli(["approve", state.packets[0].id, "--note", "n", "--state", path], tmpdir(), {
    preload: stub.preload,
  });
  assert.equal(run.code, 1, "a closed issue must still stand the approval down");
  assert.match(run.out, /stand down/i);
  assert.match(run.stdout, /open an issue first for anything large/, "the evidence must survive the stand-down");
  assert.equal(
    JSON.parse(readFileSync(path, "utf8")).packets.find((p: { id: string }) => p.id === state.packets[0].id).status,
    "gated",
  );
});

test("approve names the absence when the gate parsed no policy text at all", () => {
  // `mcp-use/mcp-use` is `aiPolicy: unknown` with a committed `silent` record, so a packet built
  // with no fetched docs is DENY_UNKNOWN_POLICY and cannot be approved. The point is what the
  // operator is told on the way to that refusal: not a clean scan, an absence.
  const seed = seedState();
  const blind = buildPacket({
    repoId: "mcp-use/mcp-use",
    issueNumber: 998,
    issueTitle: "docs typo",
    issueUrl: "https://github.com/mcp-use/mcp-use/issues/998",
  });
  const path = writeState({ ...seed, packets: [blind, ...seed.packets.filter((p) => p.status !== "submitted")] });
  const run = runCli(["approve", blind.id, "--note", "n", "--state", path], tmpdir(), {
    preload: githubStub("record").preload,
  });
  assert.match(run.stdout, /no policy text/i);
  assert.equal(/no ban statement matched/i.test(run.stdout), false);
  assert.equal(run.code, 1, "a packet the gate denied still cannot be approved");
});

/* ------------------------------------------------------------------------------------------- *
 * issue #39 — `reverts` gets a producer, and the clock gets eyes.
 * ------------------------------------------------------------------------------------------- */

/** The merged packet whose merge commit the tests below have the base branch revert. */
const REVERTED = "pkt_ravidsrk_orca-fleet_42";

function revertCommitFor(state: FactoryState, packetId: string, at = "2026-08-28T09:00:00Z") {
  const packet = state.packets.find((p) => p.id === packetId)!;
  const sha = packet.prMeta?.mergeCommitSha;
  assert.ok(sha, `${packetId} must carry the merge commit a revert would name`);
  return {
    repoId: packet.repoId,
    commit: {
      sha: "ffff1110000000000000000000000000000000aa",
      message: `Revert "${packet.prMeta!.title}"\n\nThis reverts commit ${sha}.`,
      committedAt: at,
    },
  };
}

test("reconcile re-checks merged packets for a revert of our merge commit and records it", () => {
  // `applyPrSync` has never seen a merged packet — its status guard refuses one — so the revert
  // re-check cannot live there. `reconcile` already fetches every packet that names a PR,
  // whatever its status, so this is the one loop that was already looking at merged PRs and
  // simply had nothing to say about them.
  const seed = seedState();
  const path = writeState(seed);
  const { repoId, commit } = revertCommitFor(seed, REVERTED);
  const before = seed.scorecard.find((r) => r.repoId === repoId)!;
  assert.equal(before.reverts, 0, "the seed must start clean or this proves nothing");

  const run = runCli(["reconcile", "--state", path], tmpdir(), {
    preload: prFactsStub(livePrs(), { [repoId]: [commit] }),
  });
  assert.equal(run.code, 0, run.out);
  assert.match(
    run.out,
    new RegExp(`^REVERT ${REVERTED}: ffff111`, "m"),
    `reconcile must name the reverting commit it found:\n${run.out}`,
  );
  // The remedy the line names has to be one that exists. `emptyScorecard()` builds its rows from
  // `ALLOWLIST` and `health()` gates on `row.reverts > 0`, so "edit allowlist.yaml" told the
  // operator to delete the very row holding the count this unit was built to produce.
  assert.match(run.out, /^REVERT .*factory\/seed\.ts/m, `the seed is the edit that moves it:\n${run.out}`);
  assert.equal(
    /edits? allowlist\.yaml/.test(run.out),
    false,
    `following that instruction erases reverts=1:\n${run.out}`,
  );
  assert.match(run.stdout, /reverts=1/, `the summary counter must follow the bucket:\n${run.out}`);

  const after = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  const row = after.scorecard.find((r) => r.repoId === repoId)!;
  assert.equal(row.reverts, 1, "the scorecard row is the thing the KPI is read from");
  // WHICH half of the definition found it. `reconcile` reads a commit; `revert --reason` records a
  // maintainer's prose. Recording a machine-detected revert as `(operator)` would put words in a
  // maintainer's mouth in the permanent record — and `source: "commit"` flipped to `"operator"`
  // here, or the event's `${input.source}` hardcoded in `applyRevert`, both left the suite green.
  const recorded = after.packets.find((p) => p.id === REVERTED)!;
  const note = recorded.followUps!.find((f) => f.body.startsWith("revert:"))!;
  assert.match(note.body, /^revert: \(commit\)/, `a commit-detected revert is not operator-stated:\n${note.body}`);
  const scoreEvent = after.events.filter((e) => e.message.startsWith("REVERT recorded")).at(-1)!;
  assert.match(
    scoreEvent.message,
    /^REVERT recorded \(commit\)/,
    `the event carries the same provenance as the note, or the two records disagree:\n${scoreEvent.message}`,
  );
  // The sibling merged packet on the same repo names a different merge commit; a re-check that
  // matched on "some revert happened here" would have counted it twice.
  assert.equal(after.packets.filter((p) => p.followUps?.some((f) => f.body.startsWith("revert:"))).length, 1);

  // SPEC.md §7: the repository is halted. The operator surface is where that has to be visible.
  const status = runCli(["status", "--state", path], tmpdir());
  assert.equal(status.code, 0, status.out);
  assert.match(
    status.stdout,
    new RegExp(`${repoId}\\s+opened=\\d+ merged=\\d+ tone=\\w+ health=stop`),
    `a recorded revert must show as a stop:\n${status.stdout}`,
  );

  // Idempotent across runs: reconcile re-reads the same reverting commit every time it runs.
  const twice = runCli(["reconcile", "--state", path], tmpdir(), {
    preload: prFactsStub(livePrs(), { [repoId]: [commit] }),
  });
  assert.equal(twice.code, 0, twice.out);
  const settled = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  assert.equal(settled.scorecard.find((r) => r.repoId === repoId)!.reverts, 1);
});

test("reconcile leaves reverts alone when the base branch only carries rework", () => {
  const seed = seedState();
  const path = writeState(seed);
  const packet = seed.packets.find((p) => p.id === REVERTED)!;
  const run = runCli(["reconcile", "--state", path], tmpdir(), {
    preload: prFactsStub(livePrs(), {
      [packet.repoId]: [
        {
          sha: "bbbb2220000000000000000000000000000000cc",
          message: "refactor the changelog helper this PR added",
          committedAt: "2026-08-28T09:00:00Z",
        },
      ],
    }),
  });
  assert.equal(run.code, 0, run.out);
  assert.equal(/^REVERT /m.test(run.out), false, `rework is not a revert:\n${run.out}`);
  assert.match(run.stdout, /reverts=0/);
  const after = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  assert.equal(after.scorecard.find((r) => r.repoId === packet.repoId)!.reverts, 0);
});

test("the clock stops on a revert the committed ledger has not recorded", () => {
  // The 6-hour job is the only thing that runs unattended (.github/workflows/oss-tick.yml), so it
  // is the only place SPEC.md §7's "MUST halt ... on any revert" can be machine-enforced rather
  // than waiting on a human to notice. It cannot write the ledger; what it can do is refuse to
  // call a ledger reconciled while GitHub says our patch was reverted and the record says
  // `reverts: 0`.
  const seed = seedState();
  const { repoId, commit } = revertCommitFor(seed, REVERTED);
  const red = runClock(livePrs(), { [repoId]: [commit] });
  assert.equal(red.code, 1, `an unrecorded revert must stop the clock:\n${red.out}`);
  assert.match(
    red.out,
    new RegExp(`^DIVERGENCE ${REVERTED}: ffff111.*reverts our merge commit`, "m"),
    `the clock must name the commit, not merely complain:\n${red.out}`,
  );

  // A quiet base branch is not a revert, and must not red the clock.
  const green = runClock(livePrs(), {});
  assert.equal(green.code, 0, green.out);
  assert.equal(/REVERT|reverts our merge commit/.test(green.out), false, green.out);
});

test("the revert verb records a maintainer-stated rollback, halts the repo, and counts once", () => {
  // The half of docs/08-operations.md's definition no classifier should pretend to read: "a
  // maintainer-stated rollback naming the PR". Prose, judged by a human, recorded by hand.
  const seed = seedState();
  const path = writeState(seed);
  const id = "pkt_ravidsrk_frontguard_195";
  const repoId = seed.packets.find((p) => p.id === id)!.repoId;

  const bare = runCli(["revert", id, "--state", path], tmpdir());
  assert.equal(bare.code, 1, `a revert with no stated reason is not a record:\n${bare.out}`);
  assert.equal(
    (JSON.parse(readFileSync(path, "utf8")) as FactoryState).scorecard.find((r) => r.repoId === repoId)!.reverts,
    0,
  );

  const reason = "maintainer rolled back #196 in the 2026-08-30 release thread, naming the PR";
  const run = runCli(["revert", id, "--reason", reason, "--state", path], tmpdir());
  assert.equal(run.code, 0, run.out);
  const after = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  assert.equal(after.scorecard.find((r) => r.repoId === repoId)!.reverts, 1);
  const packet = after.packets.find((p) => p.id === id)!;
  assert.ok(
    packet.followUps?.some((f) => f.body.startsWith("revert:") && f.body.includes(reason)),
    "the operator's own words are the record; a paraphrase is not",
  );

  // Same rule on the operator's own verb: name the edit that works, not the one that destroys the
  // record. `.foundry-state.json` is gitignored, so the seed promotion is also what greens the clock.
  assert.match(run.stdout, /factory\/seed\.ts/, `the revert verb must name the seed:\n${run.stdout}`);
  assert.equal(
    /edits? allowlist\.yaml/.test(run.stdout),
    false,
    `the roster edit deletes the scorecard row:\n${run.stdout}`,
  );

  const status = runCli(["status", "--state", path], tmpdir());
  assert.match(
    status.stdout,
    new RegExp(`${repoId}\\s+opened=\\d+ merged=\\d+ tone=\\w+ health=stop`),
    `a recorded revert must show as a stop:\n${status.stdout}`,
  );

  const again = runCli(["revert", id, "--reason", reason, "--state", path], tmpdir());
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already recorded/);
  assert.equal(
    (JSON.parse(readFileSync(path, "utf8")) as FactoryState).scorecard.find((r) => r.repoId === repoId)!.reverts,
    1,
  );

  // A packet that was never merged has nothing to revert.
  const inflight = seed.packets.find((p) => p.status === "submitted")!;
  const refused = runCli(["revert", inflight.id, "--reason", reason, "--state", path], tmpdir());
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /never merged/);
});

/**
 * The `revert` VERB's half of issue #81 — named separately from the `applyRevert` unit on purpose.
 *
 * This repository's most-repeated defect is a well-tested function behind untested wiring, and a
 * window enforced in the engine with a CLI that swallowed the refusal would be exactly that again:
 * `revert` reads `result.error`, and a verb that printed the refusal but still persisted, or exited
 * 0, or reported `reverts=1` from a state it never wrote, would keep the engine test green while the
 * operator was told the repository had been halted when it had not.
 */
test("the revert verb refuses a rollback past the 30-day window and writes nothing", () => {
  const seed = seedState();
  const id = "pkt_ravidsrk_frontguard_195";
  const packet = seed.packets.find((p) => p.id === id)!;
  const repoId = packet.repoId;
  // Age the merge past the deadline. Only this one fact changes, so the refusal can only come from
  // the window: everything else is the state the in-window test above records against successfully.
  const stale: FactoryState = {
    ...seed,
    packets: seed.packets.map((p) =>
      p.id === id ? { ...p, prMeta: { ...p.prMeta!, mergedAt: "2025-06-01T00:00:00Z" } } : p,
    ),
  };
  const path = writeState(stale);
  const reason = "maintainer mentioned rolling it back in a thread from last year";

  const run = runCli(["revert", id, "--reason", reason, "--state", path], tmpdir());
  assert.equal(run.code, 1, `an out-of-window revert must refuse:\n${run.out}`);
  assert.match(run.out, /30-day window/, run.out);
  assert.match(run.out, /docs\/08-operations\.md/, run.out);

  // The ledger is the assertion, not the exit code: a refusal that still wrote the counter would
  // halt the repository behind a message saying it had not.
  const after = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  assert.equal(after.scorecard.find((r) => r.repoId === repoId)!.reverts, 0);
  assert.equal(after.packets.find((p) => p.id === id)!.followUps?.some((f) => f.body.startsWith("revert:")) ?? false, false);

  // And the repository stays selectable — the whole cost of the bug was a permanent stop.
  const status = runCli(["status", "--state", path], tmpdir());
  assert.doesNotMatch(
    status.stdout,
    new RegExp(`${repoId}\\s+opened=\\d+ merged=\\d+ tone=\\w+ health=stop`),
    `an out-of-window revert must not stop the repo:\n${status.stdout}`,
  );
});

/**
 * The operator's path to the SPEC.md §7 MUST, which round 1 of #81 closed off (round 2).
 *
 * The window predicate was shared; the SUBJECT was not. `classifyRevert` passes the reverting
 * commit's `committedAt`. `applyRevert` takes `at` — and this verb never supplied one, so it
 * defaulted to `now()`, the moment the operator typed. There was no `--at`, and therefore no way at
 * all to record a rollback that happened before today.
 *
 * The scenario below is the one that made it a defect rather than an inconvenience: a maintainer
 * rolls our merge back on day 10 and says so in a thread; the operator reads the thread on day 35.
 * `reconcile` would have recorded that rollback and stopped the repository. The verb refused it —
 * "35 days after the merge" — and left `health()` reading `good`. Same rollback, opposite answers,
 * in the safety-relevant direction, with the operator holding no verb that could satisfy the MUST.
 */
test("revert dates the window from the rollback the operator names, not from when they typed", () => {
  const seed = seedState();
  const id = "pkt_ravidsrk_frontguard_195";
  const packet = seed.packets.find((p) => p.id === id)!;
  const repoId = packet.repoId;
  // Merged 35 days ago, so "now" — the default — is outside the window and the day-10 rollback is
  // inside it. Anchored to the clock rather than to a literal, because the default IS the clock.
  const mergedMs = Date.now() - 35 * 86_400_000;
  const mergedAt = new Date(mergedMs).toISOString();
  const rollbackAt = new Date(mergedMs + 10 * 86_400_000).toISOString();
  const aged = (): FactoryState => ({
    ...seed,
    packets: seed.packets.map((p) => (p.id === id ? { ...p, prMeta: { ...p.prMeta!, mergedAt } } : p)),
  });
  const reason = "maintainer rolled it back on day 10 and said so in the thread";
  const rowOf = (path: string) =>
    (JSON.parse(readFileSync(path, "utf8")) as FactoryState).scorecard.find((r) => r.repoId === repoId)!;

  // Undated: the operator is recording as of now, and now is out of window. Refused, nothing
  // written — and the refusal names the flag that fixes it, which is the whole of issue #35's rule.
  const undatedPath = writeState(aged());
  const undated = runCli(["revert", id, "--reason", reason, "--state", undatedPath], tmpdir());
  assert.equal(undated.code, 1, undated.out);
  assert.match(undated.out, /30-day window/, undated.out);
  assert.match(undated.out, /--at <iso>/, undated.out);
  assert.equal(rowOf(undatedPath).reverts, 0);

  // Dated by the event: recorded, and the repository is stopped — which is what `reconcile` would
  // have done with the same rollback, and the disagreement this closes.
  const datedPath = writeState(aged());
  const dated = runCli(
    ["revert", id, "--reason", reason, "--at", rollbackAt, "--state", datedPath],
    tmpdir(),
  );
  assert.equal(dated.code, 0, dated.out);
  assert.match(dated.stdout, /revert recorded on/, dated.stdout);
  assert.equal(rowOf(datedPath).reverts, 1);
  const status = runCli(["status", "--state", datedPath], tmpdir());
  assert.match(
    status.stdout,
    new RegExp(`${repoId}\\s+opened=\\d+ merged=\\d+ tone=\\w+ health=stop`),
    status.stdout,
  );

  // A date the CLI cannot parse is refused BEFORE anything is written — an unparseable `--at`
  // silently falling back to now would be the original bug with a flag in front of it.
  const badPath = writeState(aged());
  const bad = runCli(["revert", id, "--reason", reason, "--at", "last Tuesday", "--state", badPath], tmpdir());
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /not a date this can parse/, bad.out);
  assert.equal(rowOf(badPath).reverts, 0);

  // A TRAILING `--at`, with nothing after it, is not "now". `flag()` answers `undefined` for both
  // "no flag" and "flag at the end of argv", so this typed the flag, got the default, and dated the
  // window from the typing — the failure the flag exists to close, reached silently and by the
  // operator who was trying hardest to avoid it. Refused, and the refusal says what omitting it
  // would have meant.
  const trailingPath = writeState(aged());
  const trailing = runCli(["revert", id, "--reason", reason, "--state", trailingPath, "--at"], tmpdir());
  assert.equal(trailing.code, 1, trailing.out);
  assert.match(trailing.out, /--at was given no value/, trailing.out);
  assert.match(trailing.out, /omitting it means the rollback is dated now/, trailing.out);
  assert.equal(rowOf(trailingPath).reverts, 0);

  // …and a `--at` whose "value" is the next FLAG is a different mistake with the same cause. It is
  // caught by the parse check rather than by the guard above, and both must stay: neither one on
  // its own covers the other.
  const swallowedPath = writeState(aged());
  const swallowed = runCli(["revert", id, "--reason", reason, "--at", "--state", swallowedPath], tmpdir());
  assert.equal(swallowed.code, 1, swallowed.out);
  assert.match(swallowed.out, /not a date this can parse/, swallowed.out);

  // And the flag is in `--help`: a verb whose behaviour depends on a flag nobody is told about is
  // the same defect as a refusal naming a command that does not exist.
  assert.match(runCli(["--help"], tmpdir()).stdout, /revert <packetId> --reason <text> \[--at <iso>\]/);
});

test("sync folds the human review split into the scorecard when the PR reaches a terminal state", () => {
  // The end-to-end shape of issue #39's first two bullets: GitHub's review endpoints, through the
  // bot filter, into the two KPI columns the ledger prints.
  const seed = seedState();
  const path = writeState(seed);
  const inflight = seed.packets.find((p) => p.status === "submitted")!;
  const run = runCli(["sync", inflight.id, "--threads-answered", "--state", path], tmpdir(), {
    preload: prFactsStub(
      livePrs({
        [inflight.prUrl!]: {
          state: "closed",
          merged: true,
          reviews: [
            { login: "coderabbitai[bot]", type: "Bot" },
            { login: "ColeMurray", type: "User" },
          ],
          reviewComments: [
            { login: "coderabbitai[bot]", type: "Bot" },
            { login: "ColeMurray", type: "User" },
            { login: "ColeMurray", type: "User" },
          ],
        },
      }),
    ),
  });
  assert.equal(run.code, 0, run.out);
  const after = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  const row = after.scorecard.find((r) => r.repoId === inflight.repoId)!;
  assert.equal(row.humanReviewedPrs, 1);
  assert.equal(row.humanReviewComments, 2, "the bot's review comment is not a human's");
  assert.equal(row.reviewCommentsAvg, 2);
  assert.equal(row.noReview, 0);
});

test("sync counts a silently merged PR as noReview, and the ledger prints it", () => {
  const seed = seedState();
  const path = writeState(seed);
  const inflight = seed.packets.find((p) => p.status === "submitted")!;
  const run = runCli(["sync", inflight.id, "--threads-answered", "--state", path], tmpdir(), {
    preload: prFactsStub(
      livePrs({
        [inflight.prUrl!]: {
          state: "closed",
          merged: true,
          // A bot reviewed it. Nobody human did. docs/08-operations.md counts that as silence.
          // Deliberately WITHOUT `type`: not every GitHub surface returns it, so the `[bot]` login
          // suffix has to carry this on its own or a bot-only review reads as a human one.
          reviews: [{ login: "coderabbitai[bot]" }],
          reviewComments: [{ login: "coderabbitai[bot]" }],
        },
      }),
    ),
  });
  assert.equal(run.code, 0, run.out);
  const after = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  const row = after.scorecard.find((r) => r.repoId === inflight.repoId)!;
  assert.equal(row.noReview, 1, "a bot-only review is not a human review");
  assert.equal(row.humanReviewedPrs, 0);

  const ledger = runCli(["ledger", "--state", path], tmpdir());
  assert.equal(ledger.code, 0, ledger.out);
  assert.match(
    ledger.stdout,
    new RegExp(`- ${inflight.repoId}: opened=\\d+ merged=\\d+ closedUnmerged=\\d+ noReview=1 `),
    `the ledger's noReview column must carry the computed value:\n${ledger.stdout}`,
  );
});

/**
 * The seed with one merged packet's review observation stripped — the shape a packet is left in
 * when GitHub's review endpoints were down for the single tick that absorbed its merge.
 */
function reviewBlindState(id: string): FactoryState {
  const seed = seedState();
  const before = seed.packets.find((p) => p.id === id)!;
  assert.ok(before.prMeta?.humanReview, `${id} must start observed or the strip proves nothing`);
  return {
    ...seed,
    packets: seed.packets.map((p) =>
      p.id === id ? { ...p, prMeta: { ...p.prMeta!, humanReview: undefined } } : p,
    ),
  };
}

test("a merged packet's review KPI is recoverable, and both verbs say so until it is", () => {
  // Issue #39 round 3. `recordTerminalReview` gets exactly one chance per packet: the tick that
  // absorbs the merge, inside `applyPrSync`, which refuses every status but submitted/followed-up.
  // If the review endpoints 500ed for that one request the KPI was written nowhere and could be
  // written nowhere afterwards — `reconcile` skips merged packets when it calls `applyPrSync`, and
  // the clock never read `humanReview` at all. Three of the four seeded packets are merged, so the
  // 2 requests/PR/tick `syncGithubPr` spends re-reading the review endpoints of an already-terminal
  // PR bought literally nothing for the majority case, while the scorecard reported noReview over a
  // denominator quietly short by one. "A zero nobody observed is an invented KPI" (issue #39) has a
  // second edge: so is a rate over a population nobody was told was short.
  const BLIND = "pkt_ravidsrk_frontguard_195";
  const blind = reviewBlindState(BLIND);
  const repoId = blind.packets.find((p) => p.id === BLIND)!.repoId;
  const before = blind.scorecard.find((r) => r.repoId === repoId)!;

  // The clock first: it cannot write, and it reads the COMMITTED SEED — so this half is asserted
  // through `packetChecks` against the stripped packet, which is what the seed would look like.
  const stranded = blind.packets.find((p) => p.id === BLIND)!;
  const seen = packetChecks(stranded, {
    state: "closed",
    merged: true,
    draft: stranded.prMeta!.draft,
    headSha: stranded.prMeta!.headSha,
    body: stranded.prBody ?? "",
    revert: { reverted: false, why: "nothing" },
  });
  assert.deepEqual(seen.fatal, [], "a KPI the ledger never observed contradicts nothing GitHub says");
  assert.match(
    seen.advisory.join("\n"),
    new RegExp(`${BLIND}: the ledger records no human-review observation for a terminal PR`),
    `an unobserved KPI must not be silent:\n${seen.advisory.join("\n")}`,
  );
  // The remedy has to name the verb that works. `sync` does not: it goes through `applyPrSync`,
  // whose status guard answers `cannot sync PR from status merged`.
  assert.match(seen.advisory.join("\n"), /Run `reconcile` on a pass where GitHub answers/);
  assert.match(seen.advisory.join("\n"), /NOT `sync`, which refuses a terminal packet/);

  // And `reconcile`, the verb that verb names, actually recovers it.
  const path = writeState(blind);
  const run = runCli(["reconcile", "--state", path], tmpdir(), {
    preload: prFactsStub(
      livePrs({
        [stranded.prUrl!]: { reviews: [{ login: "maintainer" }], reviewComments: [{ login: "maintainer" }, { login: "dependabot[bot]", type: "Bot" }] },
      }),
    ),
  });
  assert.equal(run.code, 0, run.out);
  assert.match(
    run.out,
    new RegExp(`^REVIEW ${BLIND}: human review recovered on ${repoId} \\(1 review\\(s\\), 1 comment\\(s\\)\\)`, "m"),
    `the bot's review comment is not a human's, and the recovery must name what it folded:\n${run.out}`,
  );
  assert.match(run.out, /^REVIEW .*factory\/seed\.ts/m, `local state is gitignored; the seed is the edit:\n${run.out}`);
  assert.match(run.stdout, /reviews=1/, `the summary counter must follow the bucket:\n${run.stdout}`);

  const after = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  const row = after.scorecard.find((r) => r.repoId === repoId)!;
  assert.deepEqual(
    after.packets.find((p) => p.id === BLIND)!.prMeta!.humanReview,
    { reviews: 1, comments: 1 },
    "the observation is stored on the packet, which is what makes the fold idempotent",
  );
  assert.equal(row.humanReviewedPrs, before.humanReviewedPrs + 1, "the denominator grew by exactly one");
  assert.equal(row.humanReviewComments, before.humanReviewComments + 1);

  // Idempotent. These are cumulative counters and this runs every six hours forever, so a
  // level-triggered fold that did not refuse a second time would inflate the KPI on its own.
  const twice = runCli(["reconcile", "--state", path], tmpdir(), {
    preload: prFactsStub(
      livePrs({
        [stranded.prUrl!]: { reviews: [{ login: "maintainer" }], reviewComments: [{ login: "maintainer" }] },
      }),
    ),
  });
  assert.equal(twice.code, 0, twice.out);
  assert.match(twice.stdout, /reviews=0/, `a second pass must recover nothing:\n${twice.stdout}`);
  const settled = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  const settledRow = settled.scorecard.find((r) => r.repoId === repoId)!;
  assert.equal(settledRow.humanReviewedPrs, row.humanReviewedPrs, "a re-fold would grow this forever");
  assert.equal(settledRow.humanReviewComments, row.humanReviewComments);
  // And the advisory is gone from the recovered ledger — a line that never clears is noise.
  assert.equal(
    packetChecks(settled.packets.find((p) => p.id === BLIND)!, {
      state: "closed",
      merged: true,
      draft: stranded.prMeta!.draft,
      headSha: stranded.prMeta!.headSha,
      body: stranded.prBody ?? "",
      revert: { reverted: false, why: "nothing" },
    }).advisory.some((a) => /no human-review observation/.test(a)),
    false,
  );
});

test("a merge reconcile absorbs in the same run is counted once, by the transition, not twice", () => {
  // The recovery and `recordTerminalReview` both fold into the same cumulative counters, and on the
  // tick that absorbs a merge BOTH are reachable in one pass of the loop: `applyPrSync` runs the
  // terminal transition, and the recovery then sees a packet that is now merged with a live review
  // split in hand. Folding twice would put one PR into `noReview`'s denominator twice — the same
  // double-count `firstClose` exists to prevent for `closedUnmerged`, arriving by a new door.
  //
  // The guard is that the recovery tests the packet as the ledger held it BEFORE this run, so a
  // transition `applyPrSync` is about to handle is never also "recovered".
  const seed = seedState();
  const submitted = seed.packets.find((p) => p.status === "submitted")!;
  const before = seed.scorecard.find((r) => r.repoId === submitted.repoId)!;
  const path = writeState(seed);

  const run = runCli(["reconcile", "--state", path], tmpdir(), {
    preload: prFactsStub(
      livePrs({
        [submitted.prUrl!]: {
          state: "closed",
          merged: true,
          draft: false,
          reviews: [{ login: "maintainer" }],
          reviewComments: [{ login: "maintainer" }, { login: "maintainer" }],
        },
      }),
    ),
  });
  assert.equal(run.code, 0, run.out);

  const after = JSON.parse(readFileSync(path, "utf8")) as FactoryState;
  assert.equal(after.packets.find((p) => p.id === submitted.id)!.status, "merged", "the merge was absorbed");
  const row = after.scorecard.find((r) => r.repoId === submitted.repoId)!;
  assert.equal(
    row.humanReviewedPrs,
    before.humanReviewedPrs + 1,
    `one terminal PR, one place in the denominator:\n${run.out}`,
  );
  assert.equal(row.humanReviewComments, before.humanReviewComments + 2);
  // And the transition is what recorded it, so the recovery bucket stays empty. If both had fired
  // the counters above would be doubled AND this line would name the packet.
  assert.match(run.stdout, /reviews=0/, `the transition owns this write, not the recovery:\n${run.out}`);
  assert.equal(
    /^REVIEW /m.test(run.out),
    false,
    `a merge absorbed in this very run is not a recovery:\n${run.out}`,
  );
  assert.match(
    after.events.map((e) => e.message).join("\n"),
    /human review comment\(s\) on .*reviewCommentsAvg now/,
    "the transition's own event is the one that should be in the ledger",
  );
});

test("the review-KPI advisory reaches BOTH verbs' terminals, not just the one it was written in", () => {
  // `verify-ledger.ts` and `reconcile` are two hand-written call sites into one `packetChecks`
  // split, and this unit has now shipped the same defect twice — a fact one call site supplied and
  // the other did not, with the suite green because only one verb was exercised (`revert` in round
  // 1, `revertTruncated` in round 2). Under `--experimental-strip-types` a dropped field is a
  // runtime `undefined`, never a compile error.
  //
  // The structural answer, taken here, is that this advisory needs NO new field: it is derived from
  // the packet plus `merged`/`state`, which both call sites have always supplied and which many
  // existing assertions already pin. So there is nothing to forget at one site. What is asserted
  // below is that both verbs do in fact print it, which is the claim, not the mechanism.
  const BLIND = "pkt_ravidsrk_frontguard_195";
  const blind = reviewBlindState(BLIND);
  const stranded = blind.packets.find((p) => p.id === BLIND)!;

  // The operator's terminal, on the pass where the endpoints are still down — the only pass on
  // which `reconcile` can reach the advisory at all, because when they answer it RECOVERS instead.
  const cli = runCli(["reconcile", "--state", writeState(blind)], tmpdir(), {
    preload: prFactsStub(livePrs({ [stranded.prUrl!]: { reviewsUnreadable: true } })),
  });
  assert.equal(cli.code, 0, cli.out);
  assert.match(
    cli.out,
    new RegExp(`^ADVISORY ${BLIND}: the ledger records no human-review observation`, "m"),
    `reconcile must print it too, not only the clock:\n${cli.out}`,
  );
  assert.match(cli.stdout, /reviews=0/, `nothing was recoverable on this pass:\n${cli.stdout}`);

  // The clock's terminal. It reads the COMMITTED SEED, so the only run available is the control:
  // every merged packet there carries an observation, so the line must be silent. That silence is
  // only evidence if the premise holds, so the premise is asserted rather than assumed.
  const clock = runClock(livePrs());
  assert.equal(clock.code, 0, clock.out);
  assert.equal(
    /no human-review observation/.test(clock.out),
    false,
    `every merged packet in the committed seed is observed, so the clock must stay quiet:\n${clock.out}`,
  );
  for (const packet of seedState().packets.filter((p) => p.status === "merged")) {
    assert.ok(
      packet.prMeta?.humanReview,
      `${packet.id} carries no human-review observation in the committed seed — the clock's silence above would be a hole, not a control`,
    );
  }
});

test("reconcile says so when the commit read fails, and when it merely stops short", () => {
  // The clock's sibling, and the reason it is a separate test rather than a line in that one.
  // `verify-ledger.ts` and `reconcile` are two hand-written call sites into the same `packetChecks`
  // split, and each has to supply `revertTruncated` itself — a field `--experimental-strip-types`
  // turns into a runtime `undefined` when it is dropped, never a compile error. So the clock's
  // assertion protects the clock and nothing else: with only that test, deleting the field from
  // `cli.ts`, hardcoding it `false`, deleting reconcile's failed-read advisory, or moving that
  // advisory into the DIVERGENCE bucket each left the whole suite green while the two verbs
  // disagreed about what was checked — the exact thing reconcile's own comment forbids.
  const seed = seedState();

  const unreadable = runCli(["reconcile", "--state", writeState(seed)], tmpdir(), {
    preload: prFactsStub(livePrs(), {}, { fail: ["ravidsrk/frontguard"] }),
  });
  assert.equal(unreadable.code, 0, `an unreadable commit list is a debt, not a divergence:\n${unreadable.out}`);
  assert.match(
    unreadable.out,
    /^ADVISORY pkt_ravidsrk_frontguard_195: could not read ravidsrk\/frontguard commits since the merge — a revert would go unnoticed this run/m,
    `a failed read must name the packet and the risk, on reconcile too:\n${unreadable.out}`,
  );
  // The bucket, not just the text. Moving this line into `doctrine` would print it as a DIVERGENCE
  // and teach that word a second meaning — the split's whole reason for existing.
  assert.equal(
    /^DIVERGENCE .*could not read/m.test(unreadable.out),
    false,
    `a read that failed is not the ledger contradicting GitHub:\n${unreadable.out}`,
  );

  // A capped read: GitHub answers 200 with a `Link: rel="next"` that never runs out, so the commits
  // and the verdict are byte-identical to a clean run. Only the flag differs, and only if reconcile
  // passes it on.
  const capped = runCli(["reconcile", "--state", writeState(seed)], tmpdir(), {
    preload: prFactsStub(livePrs(), {}, { truncate: ["ravidsrk/frontguard"] }),
  });
  assert.equal(capped.code, 0, `a short read is a debt, not a divergence:\n${capped.out}`);
  assert.match(
    capped.out,
    /^ADVISORY pkt_ravidsrk_frontguard_195: the revert re-check on ravidsrk\/frontguard hit its page cap/m,
    `a page-capped read must not read as a clean one on reconcile either:\n${capped.out}`,
  );
  assert.equal(
    /^DIVERGENCE .*page cap/m.test(capped.out),
    false,
    `a short read is not the ledger contradicting GitHub:\n${capped.out}`,
  );

  // The COUNT, which is what a `revertTruncated: false` hardcode changes when the text alone would
  // still match some other advisory. Three merged packets in the seed, and the truncated repo owns
  // two of them — plus the standing re-witness debt on the in-flight packet.
  const cleanRun = runCli(["reconcile", "--state", writeState(seed)], tmpdir(), {
    preload: prFactsStub(livePrs(), {}),
  });
  assert.equal(cleanRun.code, 0, cleanRun.out);
  const count = (out: string): number => Number(/advisories=(\d+)/.exec(out)?.[1] ?? -1);
  assert.ok(count(cleanRun.stdout) >= 0, `the summary must carry a count:\n${cleanRun.stdout}`);
  assert.equal(
    count(capped.stdout),
    count(cleanRun.stdout) + 1,
    `a capped read must move the advisory count, or the flag is decorative:\n${capped.stdout}\n${cleanRun.stdout}`,
  );
  // A failed read is doubly loud, and deliberately: `revertCheck` returning `ok: false` leaves
  // `revert` undefined, so `packetChecks` ALSO reports the doctrine check as one that did not run.
  // Two sentences, two different facts — why the read produced nothing, and what its absence costs.
  assert.equal(
    count(unreadable.stdout),
    count(cleanRun.stdout) + 2,
    `a failed read must move the advisory count too:\n${unreadable.stdout}\n${cleanRun.stdout}`,
  );
  assert.match(
    unreadable.out,
    /^ADVISORY pkt_ravidsrk_frontguard_195: the revert re-check did not run/m,
    `a failed read also turns the doctrine check off, and that must be said:\n${unreadable.out}`,
  );

  // And the control: a commit list GitHub serves in full says neither thing.
  assert.equal(
    /could not read|page cap/.test(cleanRun.out),
    false,
    `a complete read must stay quiet or both advisories mean nothing:\n${cleanRun.out}`,
  );
});

test("the clock says so when the commit read fails, and when it merely stops short", () => {
  // Two ways the revert re-check can be less than an answer, and the clock must sound different
  // from `ledger ok` for both. The FATAL this unit added cannot fire on a revert it never fetched,
  // so a silent short read silently defeats it.
  const unreadable = runClock(livePrs(), {}, { fail: ["ravidsrk/frontguard"] });
  assert.equal(unreadable.code, 0, `an unreadable commit list is a debt, not a divergence:\n${unreadable.out}`);
  assert.match(
    unreadable.out,
    /^ADVISORY pkt_ravidsrk_frontguard_195: could not read ravidsrk\/frontguard commits since the merge — a revert would go unnoticed this run/m,
    `a failed read must name the packet and the risk:\n${unreadable.out}`,
  );

  // A capped read. GitHub answers 200 with a `Link: rel="next"` that never runs out, so the commits
  // and the verdict are byte-identical to a clean run — the only difference is the flag. Live proof
  // the cap is not hypothetical: ravidsrk/orca-fleet serves 111 commits since #70's merge over two
  // pages, and page 1's oldest is 31 hours after the merge.
  const capped = runClock(livePrs(), {}, { truncate: ["ravidsrk/frontguard"] });
  assert.equal(capped.code, 0, `a short read is a debt, not a divergence:\n${capped.out}`);
  assert.match(
    capped.out,
    /^ADVISORY pkt_ravidsrk_frontguard_195: the revert re-check on ravidsrk\/frontguard hit its page cap/m,
    `a page-capped read must not read as a clean one:\n${capped.out}`,
  );
  assert.match(capped.out, /would go unnoticed this run/);

  // And the control: the same clock, the same seed, a commit list GitHub serves in full. No line.
  const clean = runClock(livePrs(), {});
  assert.equal(clean.code, 0, clean.out);
  assert.equal(
    /could not read|page cap/.test(clean.out),
    false,
    `a complete read must stay quiet or the advisory means nothing:\n${clean.out}`,
  );
});
