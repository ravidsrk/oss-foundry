import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ALLOWLIST } from "./allowlist.ts";
import { applySecondaryLimitHalt } from "./halt.ts";
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
 * Replace global `fetch` before the CLI's entry module runs, and log every call.
 *
 * The log is the proof: "refused before contacting GitHub" is only demonstrated by showing that no
 * request was made, not by the absence of an error string that only appears when a request WAS
 * made. `secondaryLimit` additionally answers the open-draft pre-flight and then returns GitHub's
 * secondary-rate-limit body for the create, which is the only way to reach the halt-write path.
 */
function githubStub(mode: "record" | "secondary-limit"): { preload: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "foundry-stub-"));
  const log = join(dir, "fetch.log");
  const preload = join(dir, "preload.mjs");
  const routes =
    mode === "secondary-limit"
      ? `
  if (method === "POST" && /\\/pulls$/.test(u)) {
    return json(403, { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." });
  }
  if (/\\/pulls\\?state=open/.test(u)) return json(200, []);
  if (/\\/timeline\\?/.test(u)) return json(200, []);`
      : "";
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const method = (init?.method ?? "GET").toUpperCase();
  appendFileSync(${JSON.stringify(log)}, method + " " + u + "\\n");${routes}
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

test("witness-check reports the toolchain each allowlisted repo's testCommand would really use", () => {
  // The pre-flight issue #41 asked for. Its whole value is being runnable with nothing in flight:
  // the alternative is discovering at evidence time that `python3` on this machine is 3.9.6, from
  // a refusal that looks identical to a bad patch.
  const path = writeState(seedState());
  const run = runCli(["witness-check", "--state", path], tmpdir());
  assert.equal(run.code, 0, run.out);

  for (const repo of ALLOWLIST) {
    assert.ok(run.stdout.includes(repo.id), `${repo.id} is not in the pre-flight: ${run.stdout}`);
    assert.ok(run.stdout.includes(repo.testCommand), `${repo.id}'s testCommand is not printed`);
  }
  // A host repo resolves for real: an absolute path and a version, both read off this machine.
  assert.match(run.stdout, /python3\s+\/\S+python3\s+\S*\d+\.\d+/, run.stdout);
  // A sandboxed repo must not be given a host answer — this CLI does not run those (ADR 0003), so
  // resolving OUR python3 for a Wave-1 e2b repo would be a confident report about another machine.
  const e2bLine = run.stdout.split("\n").find((l) => l.includes("github/awesome-copilot"))!;
  assert.ok(e2bLine, run.stdout);
  assert.match(run.stdout.slice(run.stdout.indexOf(e2bLine)), /e2b[\s\S]*?worker host/i, run.stdout);

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
