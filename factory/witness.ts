import { execFile, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sanitizeTerminalText } from "./terminal.ts";
import type { EvidenceWitness, SandboxKind, Wave } from "./types.ts";

/**
 * A witness step is one of: "git" (args passed to git), "run-setup" / "run-tests@head" /
 * "run-tests@revert" / "probe" (args[0] is a shell command line the runner executes), "mkdtemp"
 * (args[0] is a filename prefix; returns the created scratch dir as its `output`), "cleanup"
 * (args[0] is a scratch dir). The runner seam is what makes the protocol testable without a
 * network or a shell.
 *
 * "mkdtemp" is a step rather than a `mkdtempSync` call inside the protocol on purpose. Creating the
 * directory is a filesystem effect, and every other filesystem effect here already crosses this
 * seam — `cleanup` is `rm -rf` behind it. Calling `mkdtempSync` directly would make each of the
 * protocol's stubbed tests create a real directory it has no way to remove, which is issue #64's
 * defect, and would put an unfakeable effect inside the one function this seam exists to keep
 * fakeable.
 */
export type WitnessStep =
  | "git"
  | "run-setup"
  | "run-tests@head"
  | "run-tests@revert"
  | "probe"
  | "mkdtemp"
  | "cleanup";
export type WitnessRunner = (
  step: WitnessStep,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ exit: number; output: string }>;

/**
 * The host implementation of the seam: what actually runs on the operator's machine at Wave 0.
 *
 * It lives beside the protocol rather than in `cli.ts` because *which shell this picks* is a
 * property of the witness, not of the operator loop — it decides which interpreter produced an
 * exit code we then publish as evidence. It is also the one part of the protocol a fake runner
 * cannot cover, so it needs to be importable without dragging the CLI in (`witness-host.test.ts`).
 *
 * **The shell is `bash -c`: non-login, non-interactive, with an allowlisted child env.**
 * That is the whole of the contract, and each half of it was chosen against a failure:
 *
 * - **Non-login.** `bash -lc` sources `/etc/profile`, and on macOS that runs `path_helper`, which
 *   rebuilds `PATH` from `/etc/paths` and puts `/usr/bin` ahead of everything the operator
 *   installed — even against an explicit override on the invocation. On a stock machine the
 *   witness therefore ran `/usr/bin/python3` (3.9.6) while the operator's own shell had 3.14.x,
 *   and the repo's suite died on `str | None` at head with no output. Issue #41.
 * - **Non-interactive, and no `$SHELL`.** The operator's login shell is not a stable contract: it
 *   may be zsh, fish, or nushell, whose `-c` semantics differ, and whose rc files are theirs to
 *   change. `bash -c` is the same shell everywhere the factory runs, including CI. `$SHELL` is
 *   therefore not on the child allowlist — passing it would reintroduce the operator's shell as
 *   a side channel without changing which interpreter we invoke.
 * - **Isolated environment.** `execFile` used to inherit `process.env` wholesale, so a Wave 0
 *   `setupCommand` (`npm ci` on frontguard) ran lifecycle scripts with `FOUNDRY_PAT` in the
 *   child's environment (issue #114). A four-name denylist closed that one leak and left
 *   `NPM_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `ANTHROPIC_API_KEY` — every other secret in the
 *   operator shell — still reaching third-party `preinstall` scripts (G-02). The child now
 *   gets `witnessChildEnv()`: an allowlist of what `git clone` / `npm ci` / a test command
 *   actually need. Presence of `E2B_API_KEY` is still read by `witnessEvidence` from the
 *   *caller* env — that check never reaches this child.
 *
 * A repo needing anything more than this declares it as `setupCommand` in `allowlist.yaml`, where
 * it is visible, rather than relying on a profile nobody reads.
 */

/**
 * Names copied into a host-witness child. Anything not listed is dropped — including
 * `NPM_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `ANTHROPIC_API_KEY`, `OP_SERVICE_ACCOUNT_TOKEN`,
 * `FOUNDRY_PAT`, and every other operator secret. A denylist cannot stay complete; this
 * list is the whole contract (G-02).
 *
 * `SHELL` is absent on purpose (see the host-runner contract above). Windows `SystemRoot` /
 * `USERPROFILE` are absent because the host runner is POSIX (`bash -c`, `rm -rf`); Wave 0
 * witnessing does not run on stock Windows.
 *
 * Version-manager *directories* are listed, never a `MISE_*` / `ASDF_*` glob:
 * `MISE_GITHUB_TOKEN` and `ASDF_GITHUB_API_TOKEN` are credentials, and a prefix match
 * would put them in the child. PATH already carries the shims; these dirs are what
 * `nvm` / `mise` / `asdf` / `volta` / `fnm` / `pyenv` consult to resolve a pin.
 *
 * Proxy URLs (`HTTP_PROXY` and friends) can embed `user:password@`. Copied verbatim,
 * that password reaches third-party `preinstall` scripts. The *names* still pass —
 * git/npm cannot reach a corporate proxy without them — but {@link witnessChildEnv}
 * strips userinfo from the value. A proxy that required that password then fails
 * closed, without leaking it. `NO_PROXY` is a host list, not a URL, and is copied as-is.
 */
export const WITNESS_CHILD_ENV_KEYS = [
  "PATH", // git, npm, node, python, bash — a child with no PATH cannot clone or test
  "HOME", // npm cache (~/.npm); git/python user-level files the toolchain actually reads
  "TMPDIR", // npm extract + test temp files; Node's os.tmpdir() honours this
  "TEMP", // Windows-style alias some tools read even on POSIX when the operator set it
  "TMP", // Windows-style alias of TMPDIR
  "LANG", // UTF-8 / locale-sensitive tools (git, python) without a C locale surprise
  "LC_ALL", // overrides LANG when the operator set a full locale
  "LC_CTYPE", // character type / UTF-8 without a full locale override
  "TZ", // timestamps in logs and time-sensitive tests
  // git's documented override for ~/.gitconfig. The evidence fixtures rewrite the clone URL
  // through `url.insteadOf` here so a local origin is cloned instead of GitHub; dropping it
  // sends `git clone` at the real network and the fixture SHAs are not reachable. An operator
  // isolating git config the same way needs the same pass-through. Not a secret.
  "GIT_CONFIG_GLOBAL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE", // OpenSSL / git / python custom CA file
  "SSL_CERT_DIR", // OpenSSL hashed CA directory
  "NODE_EXTRA_CA_CERTS", // Node's extra CA bundle (npm ci on a corp intercepting proxy)
  "GIT_SSL_CAINFO", // git's own CA override; SSL_CERT_FILE is not always consulted
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE", // Python requests; the clone's tests may need the same corp CA
  "ASDF_DIR",
  "ASDF_DATA_DIR",
  "NVM_DIR",
  "VOLTA_HOME",
  "FNM_DIR",
  "FNM_MULTISHELL_PATH",
  "PYENV_ROOT",
  "MISE_DATA_DIR",
  "MISE_CONFIG_DIR",
  "MISE_CACHE_DIR",
] as const;

/** Proxy vars whose value is a URL and may embed `user:password@`. Not `NO_PROXY`. */
const PROXY_URL_KEYS: readonly string[] = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

/**
 * Drop `user:password@` from a proxy URL. Unparseable values that contain `@` are
 * treated as credential-shaped and discarded rather than guessed at.
 */
function stripProxyUserinfo(value: string): string {
  try {
    const url = new URL(value);
    if (url.username === "" && url.password === "") return value;
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.protocol}//${url.host}${path}${url.search}${url.hash}`;
  } catch {
    return value.includes("@") ? "" : value;
  }
}

/**
 * The env a clone's `setupCommand` / `testCommand` runs under (issue #114, G-02).
 *
 * Allowlist, not denylist: copies only {@link WITNESS_CHILD_ENV_KEYS} from the parent.
 * Proxy URL values have userinfo stripped (see the allowlist comment). Presence of
 * `E2B_API_KEY` is still read by `witnessEvidence` from the *caller* env — that check
 * never reaches this child.
 */
export function witnessChildEnv(
  from: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of WITNESS_CHILD_ENV_KEYS) {
    const value = from[key];
    if (value === undefined) continue;
    const copied = PROXY_URL_KEYS.includes(key) ? stripProxyUserinfo(value) : value;
    if (copied === "") continue;
    env[key] = copied;
  }
  return env;
}

/**
 * Default deadline for one host-witness child (`git clone`, `setupCommand`, `testCommand`).
 *
 * Minutes, not seconds: a cold `npm ci` plus an upstream suite is a multi-minute job, and
 * the 15s GitHub-fetch bound would kill a healthy run. Fifteen minutes is long enough for
 * that job on a laptop and short enough that a hung registry or an upstream `while true`
 * cannot pin the `evidence` verb until the operator SIGKILLs the factory.
 */
export const WITNESS_CHILD_TIMEOUT_MS = 15 * 60 * 1000;

/** Inclusive ceiling on `FOUNDRY_WITNESS_TIMEOUT_MS`. Above this the shipped 15-minute bound is used. */
export const WITNESS_CHILD_TIMEOUT_MAX_MS = 60 * 60 * 1000;

/**
 * Deadline for one host-witness `execFile` (G-14).
 *
 * `FOUNDRY_WITNESS_TIMEOUT_MS` is an integer millisecond override. A truthy invalid value
 * (`-1`, `Infinity`, `15.5`, a non-number) must not reach the timer as `NaN` / `0` (which
 * would disable the deadline) — those values fall back to the shipped 15-minute bound,
 * matching `githubFetchTimeoutMs`.
 */
export function witnessChildTimeoutMs(
  raw: string | number | undefined = process.env.FOUNDRY_WITNESS_TIMEOUT_MS,
): number {
  const n = typeof raw === "number" ? raw : raw == null || raw === "" ? Number.NaN : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= WITNESS_CHILD_TIMEOUT_MAX_MS) return n;
  return WITNESS_CHILD_TIMEOUT_MS;
}

/**
 * SIGKILL the child and every descendant. The deadline is ours, not `execFile`'s
 * `timeout`: that option kills only the spawned PID, reparents `bash -c 'npm test'`
 * grandchildren to init, and then `pgrep -P` on the dead shell sees nothing. Walking
 * the tree while the shell is still alive, children first, is the whole fix.
 */
function killWitnessProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // Not a process-group leader — expected for execFile.
  }
  killPidTree(pid);
}

function killPidTree(pid: number): void {
  let children: string[] = [];
  try {
    const listed = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    if (listed.status === 0) {
      children = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    }
  } catch {
    // pgrep is absent; fall through and kill this pid alone.
  }
  for (const childPid of children) {
    const n = Number(childPid);
    if (Number.isInteger(n) && n > 1) killPidTree(n);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already exited
  }
}

export const hostRunner: WitnessRunner = (step, args, opts) => {
  /**
   * Handled before the `execFile` shapes below because it is the one step with no command: the OS
   * allocates the name, which is the entire point. `mkdtempSync` appends its own random suffix to
   * the prefix and fails if the result already exists, so two witness runs starting in the same
   * millisecond cannot collide — the defect in issue #56, where the directory was named from
   * `Date.now()` alone and the suite went red once in seventeen runs.
   *
   * The prefix is refused if it contains a path separator. It is derived from `repoId`, which comes
   * from `allowlist.yaml`, and a prefix carrying a `/` would place the scratch directory outside
   * `tmpdir()` — the same class of path-resolution defect as issue #80, guarded here rather than
   * trusted to the caller.
   */
  if (step === "mkdtemp") {
    const prefix = args[0] ?? "foundry-witness-";
    if (prefix.includes("/") || prefix.includes("\\") || prefix.includes("\0")) {
      return Promise.resolve({ exit: 1, output: `refusing a scratch-directory prefix containing a path separator: ${prefix}` });
    }
    try {
      return Promise.resolve({ exit: 0, output: mkdtempSync(join(tmpdir(), prefix)) });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return Promise.resolve({ exit: 1, output: `cannot create a scratch directory: ${why}` });
    }
  }
  const { promise, resolve: resolveRun } = Promise.withResolvers<{ exit: number; output: string }>();
  const timeoutMs = witnessChildTimeoutMs();
  const [cmd, cmdArgs] =
    step === "git"
      ? ["git", args]
      : step === "cleanup"
        ? ["rm", ["-rf", ...args]]
        : ["bash", ["-c", args[0] ?? "false"]]; // run-setup, probe and both run-tests phases execute the repo's own commands
  let timedOut = false;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const child = execFile(
    cmd,
    cmdArgs,
    {
      cwd: opts?.cwd,
      env: witnessChildEnv(),
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    },
    (err, stdout, stderr) => {
      settled = true;
      clearTimeout(timer);
      // `ExecException.code` is already typed `number | undefined`, so the shape needs narrowing, not
      // an assertion: a signal-killed child reports `signal` with no numeric code and must read as 1.
      const output = `${stdout}${stderr}`;
      if (timedOut) {
        resolveRun({
          exit: 1,
          output: `witness step "${step}" exceeded the ${timeoutMs}ms deadline and was killed\n${output}`,
        });
        return;
      }
      if (err?.signal) {
        resolveRun({
          exit: 1,
          output: `witness step "${step}" was killed by ${err.signal}\n${output}`,
        });
        return;
      }
      const exit = !err ? 0 : typeof err.code === "number" ? err.code : 1;
      resolveRun({ exit, output });
    },
  );
  timer = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    killWitnessProcessTree(child);
  }, timeoutMs);
  return promise;
};

/** The two run logs, returned so the caller can persist them at the paths the witness declares. */
export interface WitnessLogs {
  test: string;
  revert: string;
}

export type WitnessOutcome =
  | { ok: true; witness: EvidenceWitness; logs: WitnessLogs }
  | { ok: false; error: string };

/** An externally produced witness plus the command it ran — the `attach-witness` ingest format. */
export interface IngestedWitness {
  witness: EvidenceWitness;
  testCommand: string;
  notes: string[];
}

/** Where a packet's run logs live, relative to the repo root. Committed beside the evidence page. */
export const WITNESS_LOG_ROOT = "docs/evidence/logs";

/**
 * How an operator actually runs the ingest verb. `package.json` is `private: true` with no `bin`,
 * so `foundry` is an npm script name, not a command on anyone's PATH — every pointer in this repo
 * spells the real invocation (docs/05-v1.md, docs/08-operations.md, factory/README.md). A refusal
 * that names a command the operator cannot type is the defect issue #35 was filed against.
 */
export const INGEST_INVOCATION = "node --experimental-strip-types factory/cli.ts attach-witness";

/**
 * The pre-flight verb, spelled the same way and for the same reason as `INGEST_INVOCATION`: a
 * refusal that names a command the operator cannot type is the defect issue #35 was filed against.
 */
export const PREFLIGHT_INVOCATION = "node --experimental-strip-types factory/cli.ts witness-check";

/** How much of a failed run a refusal carries. Enough to read a stack trace, not a whole suite. */
export const WITNESS_TAIL_LINES = 40;

/**
 * The one boundary between third-party bytes and the operator's terminal now lives in
 * `terminal.ts`, and this module is one of its CALLERS rather than its owner.
 *
 * It moved because the name was making the mistake. A sanitiser that lives in `witness.ts` reads as
 * a witness concern, and issue #78's fix was scoped to witness sinks accordingly — while the freeze
 * printed a fetched CONTRIBUTING raw, seven `fail()` sites here printed `setupCommand` output raw,
 * and the class stayed open. The subject was never "the witness"; it is any text a third party
 * wrote that a human is about to read.
 *
 * The two sanitise calls left in this file are the ones whose result is RECORDED, not merely
 * printed: `runFailureDetail` splits into lines and counts them, so a `\r` must not become a
 * "line"; `resolveToolchain` stores `path`/`raw` on the witness, which the evidence page renders
 * from disk. The stream boundary cannot do either of those — it sees the finished string.
 */

/**
 * The diagnostic block every run-failure refusal ends with.
 *
 * Before this, `tests are red at head d91fe2f (exit 1) — nothing to witness` was the entire
 * message: it never referenced the run's output at all, so a broken patch and a six-minor-versions
 * -too-old interpreter produced byte-identical refusals in about three seconds (issue #41). The
 * command is included because the operator does not necessarily know it by heart, and the
 * toolchain because that is the fact that separates the two cases.
 */
export function runFailureDetail(command: string, output: string, toolchain?: string): string {
  const detail = [`  command: ${command}`];
  if (toolchain) detail.push(`  toolchain: ${toolchain}`);
  // Sanitised BEFORE the trim and the line split, so a `\r` cannot survive into a "line" that the
  // terminal then repaints, and so the line count the block reports is the count of lines a human
  // will actually see. `command` and `toolchain` are ours — `allowlist.yaml`'s testCommand and a
  // tool name plus a digits-only version — so the repository's output is the only untrusted input.
  const scrubbed = sanitizeTerminalText(output);
  const body = scrubbed.text.replace(/\s+$/, "");
  if (scrubbed.removed > 0) {
    detail.push(
      `  ${scrubbed.removed} byte(s) of terminal control sequence removed from this repository's output before printing it — a witnessed repo does not get to move your cursor. The persisted run log keeps the original bytes.`,
    );
  }
  if (body.length === 0) {
    // The single most misleading case, so it gets a sentence rather than an empty block: a command
    // that dies before printing anything is usually the environment, not the patch.
    detail.push(
      `  the run produced no output at all — the command may not have started. \`${PREFLIGHT_INVOCATION} <repoId>\` resolves what this machine would actually run.`,
    );
    return `\n${detail.join("\n")}`;
  }
  const lines = body.split("\n");
  const omitted = Math.max(0, lines.length - WITNESS_TAIL_LINES);
  detail.push(
    omitted > 0
      ? `  last ${WITNESS_TAIL_LINES} lines (${omitted} earlier lines omitted):`
      : `  output (${lines.length} line${lines.length === 1 ? "" : "s"}):`,
  );
  for (const line of lines.slice(-WITNESS_TAIL_LINES)) detail.push(`  | ${line}`);
  return `\n${detail.join("\n")}`;
}

/** What a `testCommand` resolves to on the machine that would run it. */
export interface ToolResolution {
  tool: string;
  /** Absolute path the shell selects, or undefined when the tool is not on PATH at all. */
  path?: string;
  /** First dotted number the tool's own `--version` printed, when it printed one. */
  version?: string;
  /** That `--version` line verbatim, so an unparseable one is still readable. */
  raw?: string;
}

/** `&&`, `||`, `|`, `;` and newlines separate commands. A bare `&` does not — `2>&1` is not one. */
const COMMAND_SEPARATOR = /&&|\|\||[;|\n]/;
/** `FOO=1 python3 …` — a leading environment assignment is not the tool. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** A bare command name or path. Anything else (a substitution, a quote, a glob) is not probed. */
const TOOL_TOKEN = /^[A-Za-z0-9_.+-][A-Za-z0-9_.+/-]*$/;
const VERSION = /\d+(?:\.\d+)+/;

/**
 * The distinct tools a `testCommand` would invoke, in the order it names them.
 *
 * Each token is interpolated into a probe command, so anything that is not a bare command name is
 * dropped rather than resolved. That is not a new trust boundary — `testCommand` comes from
 * `allowlist.yaml` and the witness already runs it verbatim — it is a refusal to open a second one.
 *
 * It is each segment's *first* token and nothing beneath it: `npm test` yields `npm`, never the
 * `node` that actually runs the suite. So for a JS repo `witness.toolchain` names the package
 * manager and the runtime is left to the run log, while for a Python repo naming `python3` the two
 * coincide and the field answers the interpreter question directly (docs/10-schemas.md). Widening
 * it would mean guessing at a runtime the command does not name, which is the sort of confident
 * invention the whole field exists to replace.
 */
export function commandTools(testCommand: string): string[] {
  const tools: string[] = [];
  for (const segment of testCommand.split(COMMAND_SEPARATOR)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    const first = tokens.find((t) => !ENV_ASSIGNMENT.test(t));
    if (!first || !TOOL_TOKEN.test(first)) continue;
    if (!tools.includes(first)) tools.push(first);
  }
  return tools;
}

/**
 * Resolve each tool through the runner — i.e. through the very shell the test phases use.
 *
 * Probing one way and executing another is how a green pre-flight and a red witness coexist, which
 * is the whole failure this exists to prevent. `cwd` matters for the same reason: a repo that pins
 * its interpreter (`.python-version`, `.tool-versions`, `.nvmrc`) selects a different one inside
 * the clone than in the operator's home directory.
 */
export async function resolveToolchain(
  testCommand: string,
  runner: WitnessRunner,
  cwd?: string,
): Promise<ToolResolution[]> {
  const resolved: ToolResolution[] = [];
  for (const tool of commandTools(testCommand)) {
    // `&&` binds looser than `|`, so this is `command -v tool && (tool --version | head -1)`: the
    // pipeline's status is `head`'s, which keeps a tool whose `--version` is unsupported (BSD
    // `tee`) from being reported as missing.
    const probe = await runner(
      "probe",
      [`command -v ${tool} && ${tool} --version 2>&1 | head -n 1`],
      cwd ? { cwd } : undefined,
    );
    // The SECOND repository-controlled sink (issue #78). Inside `witnessEvidence` this probe runs
    // with `cwd` set to the clone, and `TOOL_TOKEN` admits a path — so a repo whose `testCommand`
    // names something it ships (`./scripts/test.sh`) writes every byte of both lines below. `path`
    // is printed verbatim by `witness-check`, so it is an operator surface exactly like the failure
    // detail is. Sanitised before the split for the same reason: a `\r` must not become a "line".
    const lines = sanitizeTerminalText(probe.output).text.split("\n").map((l) => l.trim()).filter(Boolean);
    const path = probe.exit === 0 ? lines[0] : undefined;
    if (!path) {
      resolved.push({ tool });
      continue;
    }
    const raw = lines[1];
    const version = raw ? (VERSION.exec(raw)?.[0] ?? undefined) : undefined;
    resolved.push({ tool, path, ...(raw ? { raw } : {}), ...(version ? { version } : {}) });
  }
  return resolved;
}

/**
 * The one-line summary a witness records. Only tools that actually reported a version appear:
 * `python3 (not found)` on an evidence page would read as a fact about the run that produced the
 * green, and a run that produced a green did not fail to find its interpreter.
 */
export function toolchainLabel(resolved: ToolResolution[]): string {
  return resolved
    .filter((r) => r.version)
    .map((r) => `${r.tool} ${r.version}`)
    .join(", ");
}

export function witnessLogPaths(packetId: string): {
  testLogPath: string;
  revertLogPath: string;
} {
  return {
    testLogPath: `${WITNESS_LOG_ROOT}/${packetId}/test.log`,
    revertLogPath: `${WITNESS_LOG_ROOT}/${packetId}/revert.log`,
  };
}

/**
 * The one rule docs/10-schemas.md states about log paths, enforced instead of assumed: the two run
 * logs live at `docs/evidence/logs/<packetId>/{test,revert}.log` and nowhere else.
 *
 * This matters twice. A manifest is operator-supplied file content that `attach-witness` then reads
 * off disk, so `../../../../etc/passwd` or an absolute path must be refused *before* the read, not
 * after. And a path that is well-formed but names another packet's directory would let a witness
 * whose `repoId`/`baseSha`/`headSha` all bind correctly still hash somebody else's run. Requiring
 * exact equality with `witnessLogPaths(packetId)` closes both, and costs a real run nothing —
 * `witnessEvidence` emits precisely these paths.
 */
export function witnessLogPathViolation(
  packetId: string,
  witness: { testLogPath?: string; revertLogPath?: string },
): string | undefined {
  const want = witnessLogPaths(packetId);
  for (const [label, actual, expected] of [
    ["test", witness.testLogPath, want.testLogPath],
    ["revert", witness.revertLogPath, want.revertLogPath],
  ] as const) {
    if (actual !== expected) {
      return `witness ${label} log path ${actual ? `\`${actual}\`` : "(absent)"} is not \`${expected}\` — run logs are repo-root-relative and live under ${WITNESS_LOG_ROOT}/<packetId>/ (docs/10-schemas.md); a witness may name only its own packet's logs`;
    }
  }
  return undefined;
}

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+$|_test\.(go|py)$|_spec\.rb$/i;

/** Exported for probing: the classifier that decides which changed files count as tests (and stay un-reverted for the negative control). */
export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

/** The one digest the witness, the evidence page, and the log check all speak. */
export function witnessLogSha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Execute the evidence protocol instead of attesting it: clone, tests green at head, revert the
 * non-test production change to base, tests must go red. Refusals are structured, never a
 * degraded fake-green: E2B without a key is dry-run and says so; host execution outside Wave 0
 * violates ADR 0003.
 */
export async function witnessEvidence(
  input: {
    packetId: string;
    repoId: string;
    baseSha: string;
    headSha: string;
    testCommand: string;
    setupCommand?: string;
    sandbox: SandboxKind;
    wave: Wave;
  },
  runner: WitnessRunner,
  env: Record<string, string | undefined>,
): Promise<WitnessOutcome> {
  if (input.sandbox === "host" && input.wave !== 0) {
    return { ok: false, error: "host witnessing is Wave 0 only (ADR 0003) — untrusted clones never run on the operator machine" };
  }
  if (input.sandbox !== "host") {
    // Both refusals name the ingest verb: an operator without a key is the *first* one to need it,
    // since the way forward is a witness produced elsewhere, not a key on this machine.
    if (!env.E2B_API_KEY) {
      return {
        ok: false,
        error:
          `cannot witness evidence in dry-run — wire E2B_API_KEY on the worker host (docs/06-v2.md), or ingest a witness produced there with \`${INGEST_INVOCATION} ${input.packetId} --manifest <path>\`. The factory refuses rather than degrading to operator-claimed results.`,
      };
    }
    return {
      ok: false,
      error:
        `${input.sandbox === "daytona" ? "Daytona" : "E2B"} execution runs on the worker host, not in this repo's CLI (ADR 0003) — run the witness there, then ingest it here with \`${INGEST_INVOCATION} ${input.packetId} --manifest <path>\`. This CLI refuses rather than faking a green harvest.`,
    };
  }

  /**
   * The OS allocates this name, not the wall clock. It used to be
   * `foundry-witness-${repoId}-${Date.now()}`, which collides when two witness runs for the same
   * repository start in the same millisecond — observed as a red suite once in seventeen runs
   * (issue #56). The suite is fast and now drives real clones end to end, so two runs landing in
   * the same millisecond is ordinary rather than exotic, and the failure landed on the one surface
   * whose whole job is to be reproducible.
   *
   * `replaceAll` because `replace` with a string pattern substitutes only the FIRST match, so a
   * repoId with two separators would have left one in the prefix and put the clone somewhere other
   * than `tmpdir()`. The runner refuses such a prefix outright; both halves are needed, since the
   * caller must not depend on the runner's guard to be correct.
   */
  const scratch = await runner("mkdtemp", [`foundry-witness-${input.repoId.replaceAll("/", "_")}-`]);
  const dir = scratch.output.trim();
  if (scratch.exit !== 0 || dir === "") {
    // Fail closed. Cloning into an empty path would clone into the process's working directory.
    return { ok: false, error: `cannot create a scratch directory for the witness: ${scratch.output.slice(0, 200) || "no path returned"}` };
  }
  const url = `https://github.com/${input.repoId}.git`;
  // Every refusal below interpolates a step's raw output, and that output is REPOSITORY-CONTROLLED:
  // `allowlist.yaml` carries `setupCommand: npm ci`, run with `cwd` set to this clone, so the
  // repository's own lifecycle scripts author every byte of "setup command failed (exit 1) — …".
  //
  // Not sanitised here, and that is deliberate rather than an oversight. Issue #78's round-1 fix was
  // a sanitise call at each sink, and the list came up seven short — precisely these. The boundary
  // is now on the operator's terminal streams (`terminal.ts`, installed by every entry point), which
  // is the one place that cannot be short. Adding calls back here would trade a complete rule for a
  // list that has to stay complete, and the list is what failed. `runFailureDetail` keeps its own
  // call because it SPLITS the output into lines and counts them — a `\r` must not become a "line" —
  // which the stream boundary cannot do; it sees the finished string.
  const fail = async (error: string): Promise<WitnessOutcome> => {
    await runner("cleanup", [dir]);
    return { ok: false, error };
  };

  const clone = await runner("git", ["clone", url, dir]);
  if (clone.exit !== 0) return fail(`clone failed for ${input.repoId}: ${clone.output.slice(0, 200)}`);
  const fetched = await runner("git", ["-C", dir, "fetch", "origin", input.baseSha, input.headSha]);
  if (fetched.exit !== 0) {
    const full = await runner("git", ["-C", dir, "fetch", "origin"]);
    if (full.exit !== 0) return fail(`fetch failed: ${full.output.slice(0, 200)}`);
  }
  for (const sha of [input.baseSha, input.headSha]) {
    const has = await runner("git", ["-C", dir, "cat-file", "-e", sha]);
    if (has.exit !== 0) return fail(`commit ${sha.slice(0, 7)} is not reachable in ${input.repoId}`);
  }
  const checkout = await runner("git", ["-C", dir, "checkout", "--detach", input.headSha]);
  if (checkout.exit !== 0) return fail(`checkout failed: ${checkout.output.slice(0, 200)}`);

  if (input.setupCommand) {
    const setup = await runner("run-setup", [input.setupCommand], { cwd: dir });
    if (setup.exit !== 0) {
      return fail(`setup command failed (exit ${setup.exit}) — cannot witness without a working environment: ${setup.output.slice(0, 200)}`);
    }
  }

  // Resolved after setup (a `setupCommand` may be what provisions the interpreter) and before the
  // head run, so the refusal below can name the toolchain that produced the red — the one fact
  // that tells "your patch is broken" apart from "this machine's python3 is six minors too old".
  const toolchain = toolchainLabel(await resolveToolchain(input.testCommand, runner, dir)) || undefined;

  const headRun = await runner("run-tests@head", [input.testCommand], { cwd: dir });
  if (headRun.exit !== 0) {
    return fail(
      `tests are red at head ${input.headSha.slice(0, 7)} (exit ${headRun.exit}) — nothing to witness` +
        runFailureDetail(input.testCommand, headRun.output, toolchain),
    );
  }

  // Untracked artifacts from the head run (build output, caches) must not keep the revert run
  // green — or make it spuriously red. Clean everything the clone did not track before reverting.
  const clean = await runner("git", ["-C", dir, "clean", "-fdx", "--exclude", "node_modules"]);
  if (clean.exit !== 0) return fail(`clean between runs failed: ${clean.output.slice(0, 200)}`);
  if (input.setupCommand) {
    const resetup = await runner("run-setup", [input.setupCommand], { cwd: dir });
    if (resetup.exit !== 0) {
      return fail(`setup re-run after clean failed (exit ${resetup.exit}): ${resetup.output.slice(0, 200)}`);
    }
  }

  const changed = await runner("git", ["-C", dir, "diff", "--name-only", input.baseSha, input.headSha]);
  const files = changed.output.split("\n").map((f) => f.trim()).filter(Boolean);
  const nonTest = files.filter((f) => !isTestPath(f));
  const revertPaths = nonTest.length > 0 ? nonTest : ["."];
  const revert = await runner("git", ["-C", dir, "checkout", input.baseSha, "--", ...revertPaths]);
  if (revert.exit !== 0) return fail(`revert to base failed: ${revert.output.slice(0, 200)}`);

  const revertRun = await runner("run-tests@revert", [input.testCommand], { cwd: dir });
  await runner("cleanup", [dir]);
  if (revertRun.exit === 0) {
    return {
      ok: false,
      // `reject` is the operator's verb; `parked` is a status the engine writes on its own.
      // A refusal that reads as an instruction must name a button the operator has (issue #62).
      error:
        "negative control failed — tests stayed green with the production change reverted. The proof does not bind the change; reject the packet." +
        runFailureDetail(input.testCommand, revertRun.output, toolchain),
    };
  }

  return {
    ok: true,
    witness: {
      provider: "host",
      testExit: headRun.exit,
      revertExit: revertRun.exit,
      testLogSha: witnessLogSha(headRun.output),
      revertLogSha: witnessLogSha(revertRun.output),
      ranAt: new Date().toISOString(),
      repoId: input.repoId,
      baseSha: input.baseSha,
      headSha: input.headSha,
      ...(toolchain ? { toolchain } : {}),
      ...witnessLogPaths(input.packetId),
    },
    logs: { test: headRun.output, revert: revertRun.output },
  };
}

/**
 * Recompute both declared sha256s from the persisted logs. A hash of something nobody can produce
 * is not evidence; this is what makes the digest on the evidence page checkable by a maintainer.
 * The reader is a seam so the check is exercised against real files without a live clone.
 */
export function verifyWitnessLogs(
  witness: EvidenceWitness,
  read: (path: string) => string | undefined,
): { ok: true } | { ok: false; error: string } {
  for (const [label, path, declared] of [
    ["test", witness.testLogPath, witness.testLogSha],
    ["revert", witness.revertLogPath, witness.revertLogSha],
  ] as const) {
    if (!path) {
      return { ok: false, error: `witness declares no ${label} log path — the sha256 is unauditable` };
    }
    const text = read(path);
    if (text === undefined) {
      return {
        ok: false,
        error: `${label} log ${path} is missing or unreadable — the witness sha256 cannot be recomputed`,
      };
    }
    const actual = witnessLogSha(text);
    if (actual !== declared) {
      return {
        ok: false,
        error: `${label} log ${path} hashes to ${actual.slice(0, 12)}…, which does not match the witness sha256 ${declared.slice(0, 12)}… — the log on disk is not what was witnessed`,
      };
    }
  }
  return { ok: true };
}

const HEX40 = /^[0-9a-f]{40}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse an externally produced witness manifest for `packetId`. Shape validation cannot detect a
 * lie — provenance is settled by the engine gate and the log hashes by `verifyWitnessLogs`. This
 * refuses input that could not have come from a run at all, so a malformed file never reaches the
 * state machine, and it settles the two log paths against `packetId` because the caller reads
 * whatever they name off disk immediately afterwards.
 */
export function parseWitnessManifest(
  raw: string,
  packetId: string,
): { ok: true; manifest: IngestedWitness } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `witness manifest is not JSON: ${err instanceof Error ? err.message : "unparseable"}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "witness manifest must be a JSON object" };
  }
  const o = parsed as Record<string, unknown>;
  const providers: SandboxKind[] = ["host", "e2b", "daytona"];
  if (!providers.includes(o.provider as SandboxKind)) {
    return { ok: false, error: `witness manifest provider must be one of ${providers.join(", ")}` };
  }
  if (typeof o.testExit !== "number" || typeof o.revertExit !== "number") {
    return { ok: false, error: "witness manifest must record both run exit codes as numbers" };
  }
  if (typeof o.testLogSha !== "string" || !HEX64.test(o.testLogSha)) {
    return { ok: false, error: "witness manifest testLogSha must be a sha256 hex digest" };
  }
  if (typeof o.revertLogSha !== "string" || !HEX64.test(o.revertLogSha)) {
    return { ok: false, error: "witness manifest revertLogSha must be a sha256 hex digest" };
  }
  if (!nonEmptyString(o.ranAt)) {
    return { ok: false, error: "witness manifest must record ranAt" };
  }
  if (!nonEmptyString(o.repoId)) {
    return { ok: false, error: "witness manifest must name the repoId it was produced for" };
  }
  if (typeof o.baseSha !== "string" || !HEX40.test(o.baseSha)) {
    return { ok: false, error: "witness manifest baseSha must be a full 40-hex commit SHA" };
  }
  if (typeof o.headSha !== "string" || !HEX40.test(o.headSha)) {
    return { ok: false, error: "witness manifest headSha must be a full 40-hex commit SHA" };
  }
  if (!nonEmptyString(o.testLogPath) || !nonEmptyString(o.revertLogPath)) {
    return {
      ok: false,
      error: "witness manifest must reference the persisted run logs (testLogPath, revertLogPath)",
    };
  }
  const strayLogs = witnessLogPathViolation(packetId, {
    testLogPath: o.testLogPath,
    revertLogPath: o.revertLogPath,
  });
  if (strayLogs) return { ok: false, error: strayLogs };
  if (!nonEmptyString(o.testCommand)) {
    return { ok: false, error: "witness manifest must record the testCommand that was run" };
  }
  // Optional in both directions: every witness produced before #41 has no toolchain and must still
  // ingest, while one that has it cannot smuggle a non-string into the ledger — `renderEvidencePage`
  // interpolates it into the sentence a maintainer reads.
  if (o.toolchain !== undefined && !nonEmptyString(o.toolchain)) {
    return {
      ok: false,
      error: 'witness manifest toolchain, when present, must be a non-empty string naming the resolved tools (e.g. "python3 3.14.7")',
    };
  }
  const notes = Array.isArray(o.notes) && o.notes.every((n) => typeof n === "string")
    ? (o.notes as string[])
    : [];
  return {
    ok: true,
    manifest: {
      testCommand: o.testCommand,
      notes,
      witness: {
        provider: o.provider as EvidenceWitness["provider"],
        testExit: o.testExit,
        revertExit: o.revertExit,
        testLogSha: o.testLogSha.toLowerCase(),
        revertLogSha: o.revertLogSha.toLowerCase(),
        ranAt: o.ranAt,
        repoId: o.repoId,
        baseSha: o.baseSha.toLowerCase(),
        headSha: o.headSha.toLowerCase(),
        testLogPath: o.testLogPath,
        revertLogPath: o.revertLogPath,
        ...(nonEmptyString(o.toolchain) ? { toolchain: o.toolchain.trim() } : {}),
      },
    },
  };
}
