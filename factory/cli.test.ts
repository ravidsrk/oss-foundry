import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { applySecondaryLimitHalt } from "./halt.ts";
import { seedState } from "./seed.ts";
import type { FactoryState } from "./types.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = resolve(REPO_ROOT, "factory/cli.ts");

function runCli(
  args: string[],
  cwd: string,
  opts: { preload?: string; env?: Record<string, string> } = {},
): { code: number; stdout: string; out: string } {
  const nodeArgs = ["--experimental-strip-types"];
  if (opts.preload) nodeArgs.push("--import", pathToFileURL(opts.preload).href);
  const run = spawnSync(process.execPath, [...nodeArgs, CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...opts.env },
  });
  return { code: run.status ?? 1, stdout: run.stdout, out: `${run.stdout}${run.stderr}` };
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
