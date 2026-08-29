/**
 * The ONE boundary between third-party bytes and the operator's terminal.
 *
 * WHY THIS IS A MODULE AND NOT A CALL AT EACH SINK. Issue #78 was fixed at two sinks —
 * `runFailureDetail` and `resolveToolchain` — and a review of that fix found at least seven more,
 * all of them live:
 *
 *   · seven raw `fail()` sites in `witness.ts` interpolating `X.output.slice(0, 200)`, reachable
 *     because `allowlist.yaml` runs `setupCommand: npm ci` with cwd inside the untrusted clone, so
 *     that repository's lifecycle scripts author every byte of the refusal an operator then reads;
 *   · the freeze excerpt in `packet.ts` — the target repository's own CONTRIBUTING/AGENTS.md, at
 *     the same trust level as witnessed stdout and with LESS containment, since nothing sandboxes
 *     a fetched document;
 *   · `policy.matchedPhrases`, which are substrings of that same text.
 *
 * The freeze one is the argument for doing this as a class rather than as a ninth patch. A hostile
 * `CONTRIBUTING.md` that places `\x1b[8m` (SGR conceal, never reset) early in its text hides every
 * line the terminal paints after it — which is every disclosure issue #77 added: the end-of-excerpt
 * marker, the split scan claim, the verdict, and the "high-recall suggester, not the arbiter" line.
 * A repository that does not want to be read could therefore suppress the notice added to tell the
 * operator it had not been read, using the mechanism the same commit was filed to close. Patching
 * one more sink leaves the tenth.
 *
 * So the boundary is the process's own terminal streams, installed once by each entry point. It is
 * not a sink that can be forgotten: a `console.log` added tomorrow, by anyone, in any verb, is
 * already behind it. `terminal.test.ts` DRIVES every entry point it discovers from `package.json`
 * and the workflow — spawning each one with a probe that prints hostile bytes through its own
 * `console`, rather than grepping its source — so a new entry point fails until it either installs
 * the boundary or is written into `EXEMPT` with a reason.
 *
 * WHAT IT DOES NOT COVER, said out loud rather than implied. This paragraph used to claim that "the
 * only way past is a NEW entry point that never installs it". That is the claim about SINKS, and it
 * holds; it is not a claim about every byte the process can emit, and two paths reach the terminal
 * without going through `stream.write` as this module replaces it:
 *
 *   · Node's own fatal-exception printer. An uncaught `Error` is formatted and written by the
 *     runtime, not by a `console.*` call. Latent rather than live on this tree: every `throw new
 *     Error` in this repository is in `load-allowlist.ts`, `policy-records.ts` or
 *     `validate-allowlist.ts` and interpolates OUR OWN committed files, while every GitHub read
 *     parses its response inside a `try`/`catch` that returns `{ ok: false }` rather than throwing.
 *     So the hole has nothing in it. It is named so the next `throw new Error(thirdPartyText)` is
 *     recognised as putting something in it.
 *   · A non-`Buffer` typed array, which the wrapper passes through untouched on purpose (see the
 *     comment at the `text === undefined` branch below). Nothing in this repository writes one.
 *
 * So: no SINK can bypass the boundary, and that is what the boundary is for. "Nothing can" would be
 * a larger claim than the mechanism supports.
 *
 * RENDERING, NOT RECORD. Everything persisted keeps the original bytes: the witness run logs on
 * disk, the sha256 computed over them, the ledger. What is sanitised is the copy a human reads.
 * The audit trail is unchanged; a `git show` of a run log still shows exactly what the repository
 * emitted.
 */

/**
 * ANSI/OSC/DCS/APC and friends, as full sequences rather than as a lone `\x1b` (issue #78).
 *
 * Stripping only the introducer would leave `]52;c;<base64>` sitting in the text, one concatenation
 * away from being a working OSC 52 again — so a sequence is removed whole or not at all.
 *
 * Both encodings of each introducer are handled, because a strip that knows only about `\x1b` is a
 * strip a terminal in 8-bit mode walks straight through: `\x9b` IS `\x1b[` and `\x9d` IS `\x1b]`,
 * so they take the same body grammar rather than merely losing their first byte and leaving the
 * parameters behind as text.
 *
 * The string-terminated forms are bounded by `[^\x07\x1b\x9c\n]*`, and the `\n` in that set is
 * load-bearing. Without it an unterminated OSC ran to the end of the input, so a run whose output
 * contained a bare `\x1b]0;t` lost EVERY line after it — including the real failure. That is issue
 * #78's own harm ("conceal its own failure output") achieved through the sanitiser rather than
 * around it, and it is why the bound is stated per line: an unterminated sequence costs the
 * operator that one sequence, not the rest of the run log. A real OSC payload (a title, an OSC 52
 * base64 body) never contains a newline, so nothing legitimate is split by this.
 *
 * The final byte of each form is optional so a sequence truncated by a tail slice still loses its
 * introducer and parameters.
 */
const TERMINAL_SEQUENCE = new RegExp(
  [
    // OSC / DCS / SOS / PM / APC: introducer, string body, string terminator.
    "(?:\\x1b[\\]PX^_]|[\\x9d\\x90\\x98\\x9e\\x9f])[^\\x07\\x1b\\x9c\\n]*(?:\\x07|\\x1b\\\\|\\x9c)?",
    // CSI: parameter bytes, intermediate bytes, final byte.
    "(?:\\x1b\\[|\\x9b)[0-?]*[ -/]*[@-~]?",
    // Any other two-character escape sequence, and a lone ESC.
    "\\x1b[@-Z\\\\-_]?",
  ].join("|"),
  "g",
);
/** Everything else a terminal acts on rather than shows: C0, DEL, C1. `\n` and `\t` are not that. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Make text safe to put in front of an operator.
 *
 * The subject is any THIRD-PARTY text: a witnessed repository's stdout (executed in a sandbox
 * precisely because it is not trusted), a fetched CONTRIBUTING/AGENTS.md, a phrase quoted out of
 * one, an issue title. With control sequences intact that text can repaint a red witness as green
 * (`\r` plus a cursor move), scroll its own failure out of the scrollback, hide every line printed
 * after it (`\x1b[8m`), or invoke a terminal action outright (OSC 52 writes the clipboard).
 *
 * `\n` and `\t` are kept: they are the shape of a test log and of a policy document, and a
 * diagnostic flattened to one line is the diagnostic thrown away.
 *
 * `removed` is returned rather than discarded so a caller can say that something was taken out. A
 * sanitiser that silently tidies hostile output is itself a concealment channel: the operator would
 * see a coherent transcript with no sign that the coherence was ours.
 */
export function sanitizeTerminalText(text: string): { text: string; removed: number } {
  const stripped = text.replace(TERMINAL_SEQUENCE, "").replace(CONTROL_CHAR, "");
  return { text: stripped, removed: text.length - stripped.length };
}

/**
 * What the boundary says when it had to remove something.
 *
 * The removal is disclosed for the same reason `runFailureDetail` discloses its own: a sanitiser
 * that quietly tidies hostile output hands the operator a coherent transcript with no sign that the
 * coherence was ours. A sink that sanitises upstream (`runFailureDetail`, `resolveToolchain`) hands
 * the boundary text with nothing left to remove, so this line appears exactly once per write and
 * names only bytes no sink had already accounted for.
 */
export function terminalBoundaryNotice(removed: number): string {
  return `  [foundry: ${removed} byte(s) of terminal control sequence removed from the third-party text above — a repository does not get to move your cursor or hide the lines under it. The records on disk keep the original bytes.]`;
}

/** Streams already wrapped, so a second install is a no-op rather than a second sanitising pass. */
const WRAPPED = new WeakSet<object>();

/** The minimum a stream must offer to be wrapped — enough for a test to pass a fake one. */
export interface TerminalStream {
  write(chunk: unknown, encoding?: unknown, callback?: unknown): boolean;
}

/**
 * Route every byte this process writes to the operator's terminal through `sanitizeTerminalText`.
 *
 * Called by each entry point (`cli.ts`, `verify-ledger.ts`, `validate-allowlist.ts`) as the first
 * thing it does, and by nothing else. `run-tests.ts` is deliberately exempt and `terminal.test.ts`
 * says why: it pipes `node:test`'s own reporter, which is our output and legitimately coloured.
 *
 * Installed at the stream and not at each `console.*` call on purpose. A sink-by-sink fix is a list
 * that has to stay complete, and this repository has now shipped an incomplete one twice; a stream
 * has no list. Only the CHUNK is replaced — the encoding and callback arguments are passed through
 * untouched — so back-pressure, `drain`, and write callbacks behave exactly as before.
 */
export function installTerminalBoundary(
  streams: TerminalStream[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    if (WRAPPED.has(stream)) continue;
    WRAPPED.add(stream);
    const inner = stream.write.bind(stream);
    stream.write = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : undefined;
      // Not text at all (a typed array of raw bytes) — not a terminal render, so not ours to touch.
      if (text === undefined) return inner(chunk, encoding, callback);
      const scrubbed = sanitizeTerminalText(text);
      const out =
        scrubbed.removed === 0
          ? scrubbed.text
          : `${scrubbed.text}${scrubbed.text === "" || scrubbed.text.endsWith("\n") ? "" : "\n"}${terminalBoundaryNotice(scrubbed.removed)}\n`;
      return inner(typeof chunk === "string" ? out : Buffer.from(out, "utf8"), encoding, callback);
    };
  }
}
