import { canonicalRepoId, repoById } from "./allowlist.ts";
import { evidenceIsStale, needsRewitness, witnessedSha } from "./ledger-check.ts";
import { ABORT_DEFAULT, commitTrailerLine, DISCLOSURE, FOUNDRY_REPO_URL, NON_GOALS_DEFAULT } from "./neighbor.ts";
import { evaluatePolicy } from "./policy.ts";
import { scoreIssue } from "./scout.ts";
import type { PacketClass, PolicyDocSource, TaskPacket } from "./types.ts";

function idFor(repoId: string, issue: number) {
  return `pkt_${repoId.replace("/", "_")}_${issue}`;
}

/**
 * How much of each fetched document the packet keeps. Enough that a policy section is read whole —
 * a real AI-contribution paragraph sits in the first page or two of a CONTRIBUTING — without
 * turning the ledger into a mirror of every target's docs. The record's `chars` always states the
 * true size, so a truncation is never mistaken for a short document.
 */
export const POLICY_DOC_EXCERPT_LIMIT = 4000;

/**
 * The documents that were fetched, in the order the scan blob concatenates them. A document that
 * was never fetched is absent rather than empty: "we read nothing" and "we read a blank file" are
 * different facts, and the freeze must not be shown the second one when the first is true.
 */
function policyDocsOf(input: { agentsMd?: string; contributing?: string }): PolicyDocSource[] | undefined {
  const sources: [string, string | undefined][] = [
    ["AGENTS.md", input.agentsMd],
    ["CONTRIBUTING", input.contributing],
  ];
  const docs: PolicyDocSource[] = [];
  for (const [name, text] of sources) {
    if (text === undefined) continue;
    const excerpt = text.slice(0, POLICY_DOC_EXCERPT_LIMIT);
    docs.push({ name, chars: text.length, excerpt, truncated: excerpt.length < text.length });
  }
  return docs.length > 0 ? docs : undefined;
}

/**
 * The other id boundary (with `applyHalt`). A packet is a stored record, and everything that later
 * finds it — its own `id`, the scorecard row it credits, `policyRecordFor`'s exact-key map, the
 * duplicate check in `applyQueueLive` — keys off `repoId`. Storing whatever casing the scout
 * happened to see gives a repo two packet-id namespaces and a scorecard row that never moves
 * (issue #44 item 10), so the roster's spelling is resolved once, here, and stored. A repo the
 * roster does not know keeps the id it arrived with; `evaluatePolicy` refuses it either way.
 */
export function buildPacket(input: {
  repoId: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  labels?: string[];
  agentsMd?: string;
  contributing?: string;
}): TaskPacket {
  const repoId = canonicalRepoId(input.repoId);
  const repo = repoById(repoId);
  const policy = evaluatePolicy({
    repoId,
    agentsMd: input.agentsMd,
    contributing: input.contributing,
    issueTitle: input.issueTitle,
  });

  let classified: PacketClass = "buildable";
  if (!policy.allow) {
    if (policy.code === "DENY_FORBIDDEN" || policy.code === "DENY_UNKNOWN_POLICY") {
      classified = "policy-denied";
    } else if (policy.code === "HOLD_CLA" || policy.code === "HOLD_HUMAN") {
      classified = "needs-human";
    } else {
      classified = "out-of-scope";
    }
  }

  const now = new Date().toISOString();
  const scout = scoreIssue({
    repoId,
    title: input.issueTitle,
    labels: input.labels ?? repo?.preferredLabels ?? [],
  });

  const buildable = classified === "buildable";

  return {
    id: idFor(repoId, input.issueNumber),
    repoId,
    issueNumber: input.issueNumber,
    issueTitle: input.issueTitle,
    issueUrl: input.issueUrl,
    objective: `Land a minimal, tested fix for ${repoId}#${input.issueNumber}: ${input.issueTitle}`,
    nonGoals: NON_GOALS_DEFAULT,
    acceptance: [
      "Failing-first test or repro exists before the fix.",
      "Negative control goes red when the fix is reverted.",
      `Files ≤ ${repo?.maxFiles ?? 4}, diff ≤ ${repo?.maxDiffLines ?? 200} lines.`,
      "PR body discloses Foundry + human attest. Draft only.",
      "No merge. Follow-up until quiet, closed, or merged by maintainers.",
    ],
    abort: ABORT_DEFAULT,
    class: classified,
    status: buildable ? "gated" : "parked",
    station: buildable ? "freeze" : "terminal",
    lighting: "lit",
    policy,
    policyDocs: policyDocsOf(input),
    scout,
    createdAt: now,
    updatedAt: now,
    parkReason: buildable ? undefined : policy.reasons[0],
  };
}

/**
 * How many characters the scanner read that the freeze will NOT show (issue #77). Derived from the
 * two fields `policyDocSource` already carries, so there is one number and no new stored state.
 */
function withheldChars(docs: PolicyDocSource[]): number {
  return docs.reduce((n, d) => n + Math.max(0, d.chars - d.excerpt.length), 0);
}

/**
 * What the operator reads at the freeze, before the attest is taken.
 *
 * The freeze is the documented second layer over a scanner whose miss mode is known and named
 * (docs/04-stations.md §2), and a second layer that is handed a boolean is not a second layer. So
 * this prints the text the gate actually parsed, names every source with its size, and states the
 * scan result as a claim *about that text*.
 *
 * The absence branch is the load-bearing one. "No ban statement matched" over zero characters of
 * policy text is the single most misleading thing this surface could say, so an empty fetch is
 * reported as an absence and the scan line is withheld entirely — the same fail-safe direction as
 * `DENY_UNKNOWN_POLICY` itself (AGENTS.md: "Unknown policy = deny").
 *
 * Absence is measured in CHARACTERS, not in documents. A fetch that returned a 0-byte
 * `CONTRIBUTING` — a repository with the file present and empty, a truncated response — produces a
 * `policyDocs` entry, so a document-counted branch would take the scanned path and print the exact
 * sentence the branch exists to prevent: "no ban statement matched in 0 chars from CONTRIBUTING".
 *
 * PARTIAL absence is the same defect one step in, and it is issue #77. The scanner reads the whole
 * fetched document; the packet keeps `POLICY_DOC_EXCERPT_LIMIT` characters of it. So this surface
 * could print 4,000 characters and then close with "no ban statement matched in 4,882 chars from
 * CONTRIBUTING" — a claim of coverage over 882 characters the reader had not been given, phrased as
 * reassurance, immediately above the attest. Combined with the scanner's known-and-parked miss mode
 * (#37) that is an operator approving a contribution to a repository that said in words not to.
 *
 * The fix is loudness, not more text, and the reason is that the excerpt limit is a LEDGER bound:
 * `policyDocs` is stored state, the full document is never kept, and re-fetching at freeze time
 * would show text the gate never parsed — which is the opposite of what this function promises. So
 * what is shown cannot grow; what can change is that the omission is impossible to miss and the
 * scan claim can no longer overstate itself. `withheldChars` is computed ONCE, from `chars` and
 * `excerpt.length` the record already carries — no new stored field, and the three places that
 * mention the omission render one value rather than each deriving it.
 */
export function renderFreezeEvidence(packet: TaskPacket): string {
  const docs = packet.policyDocs ?? [];
  const fetched = new Set(docs.map((d) => d.name));
  const lines: string[] = [
    `Policy text the gate parsed for ${packet.repoId}#${packet.issueNumber} — read it before you attest:`,
    "",
  ];

  for (const doc of docs) {
    const missing = Math.max(0, doc.chars - doc.excerpt.length);
    lines.push(
      `  ${doc.name} — ${doc.chars} chars${missing > 0 ? ` (first ${doc.excerpt.length} shown, ${missing} NOT shown)` : ""}`,
    );
    for (const line of doc.excerpt.split("\n")) lines.push(`  | ${line}`);
    // Where the text stops, because that is where a scrolling reader's eye lands. The header above
    // carries the same number, but after 4,000 characters of quoted prose it is dozens of screens
    // back — a disclosure the operator has to remember is not one they have at the decision.
    if (missing > 0) {
      lines.push(
        `  ⟪ ${missing} more characters of ${doc.name} are NOT shown above. The scanner read them; you have not. ⟫`,
      );
    }
    lines.push("");
  }
  for (const name of ["AGENTS.md", "CONTRIBUTING"]) {
    if (!fetched.has(name)) lines.push(`  ${name} — not fetched.`);
  }

  // `policyNotes` is concatenated into the scan blob (docs/10-schemas.md), so it is part of what
  // the scanner read — but it is ours, not the repository's, and is labelled as such.
  const notes = repoById(packet.repoId)?.policyNotes;
  if (notes) {
    lines.push("", `  allowlist.yaml policyNotes — ${notes.length} chars, written by us, not the repo:`, `  | ${notes}`);
  }
  const record = packet.policy.record;
  if (record) {
    lines.push(
      "",
      `  Committed policy record — ${record.source} (fetched ${record.fetchedAt}, stance ${record.stance}):`,
      `  | ${record.quote}`,
    );
  }

  lines.push("");
  const total = docs.reduce((n, d) => n + d.chars, 0);
  const withheld = withheldChars(docs);
  if (total === 0) {
    lines.push(
      docs.length === 0
        ? "  No policy text was fetched for this packet, so any scan result would stand on nothing."
        : `  ${docs.map((d) => d.name).join(" + ")} came back empty, so any scan result would stand on nothing.`,
      "  Fetch AGENTS.md / CONTRIBUTING and re-gate before you attest.",
    );
  } else if (packet.policy.matchedPhrases.length > 0) {
    lines.push("  Scanner matched — confirm these are the maintainer's words and mean what the verdict says:");
    for (const phrase of packet.policy.matchedPhrases) lines.push(`    · ${phrase}`);
  } else if (withheld > 0) {
    // The sentence issue #77 is about. `no ban statement matched in ${total} chars` is true of the
    // SCANNER and false of the reader, and printed unqualified directly above the attest it read as
    // a clean bill of health over text nobody had seen. Split, so the two subjects stay separate:
    // what the scanner covered, and what the operator was actually shown.
    lines.push(
      `  Scanner: no ban statement matched in ${total} chars from ${docs.map((d) => d.name).join(" + ")} —`,
      `  BUT ${withheld} of those ${total} characters are not shown above. The scanner read them; you have not,`,
      "  and the scanner's miss mode is exactly what your reading is here to cover. Treat this as unread policy",
      "  text: open the document upstream and check the rest, or do not attest.",
    );
  } else {
    lines.push(`  Scanner: no ban statement matched in ${total} chars from ${docs.map((d) => d.name).join(" + ")}.`);
  }
  lines.push(
    `  Verdict: ${packet.policy.code}${packet.policy.reasons.length > 0 ? ` — ${packet.policy.reasons.join(" ")}` : ""}`,
    "  The scanner is a high-recall suggester with a known miss mode, not the arbiter. You are.",
    "",
  );
  return lines.join("\n");
}

/** Written for the maintainer, not the factory: what changed, how it was verified, who prepared it. Internal vocabulary (policy codes, scout scores, lighting) stays in the packet record. */
export function renderPrBody(packet: TaskPacket): string {
  const repo = repoById(packet.repoId);
  const scope = packet.evidence
    ? `- Scope: ${packet.evidence.filesChanged} files, ${packet.evidence.diffLines} changed lines (caps ${repo?.maxFiles ?? "?"} / ${repo?.maxDiffLines ?? "?"}).`
    : `- Scope caps: ${repo?.maxFiles ?? "?"} files, ${repo?.maxDiffLines ?? "?"} changed lines.`;
  const trailer = commitTrailerLine(repo?.disclosureTrailer ?? "pr-body-only");
  const trailerNote = trailer ? `\nCommits carry \`${trailer}\`.` : "";
  return `## Summary

${packet.objective}

## Verification

- Test command: \`${repo?.testCommand ?? packet.evidence?.testCommand ?? ""}\`
- A failing test existed before the change; reverting the change makes it fail again (negative control).
${scope}
- An independent reviewer read the diff and tests before this draft was opened.

## Non-goals

${packet.nonGoals.map((a) => `- ${a}`).join("\n")}

## Disclosure

${DISCLOSURE}${trailerNote}

Closes #${packet.issueNumber}
`;
}

/** The artifact a maintainer consumes (ADR 0005): every claim on one page, each bound to a source they can check. */
export function renderEvidencePage(packet: TaskPacket): string {
  const attest = packet.humanAttest;
  const ev = packet.evidence;
  const w = ev?.witness;
  const record = packet.policy.record;
  // The witnessed commit is immutable; the PR head is not. When they differ, the maintainer is
  // reading proof that is older than the branch in front of them, and must be told so here.
  //
  // Staleness is decided by the SAME predicate the divergence list uses (`evidenceIsStale`), so
  // the audit page and `packetDivergences` can never disagree about the fact. They differ only in
  // what they ask for: a live packet owes a re-witness, and `needsRewitness` says so on both
  // surfaces; a terminal packet is at rest, so the page states the limit of the proof as history
  // and the divergence list stays silent rather than re-flagging it every tick.
  const witnessed = witnessedSha(packet);
  const liveHead = packet.prMeta?.headSha;
  const stale = !evidenceIsStale(packet, liveHead)
    ? ""
    : needsRewitness(packet, liveHead)
      ? `\n- **The pull request has moved past the witnessed commit.** Proof above is bound to \`${witnessed!.slice(0, 12)}\`; the branch is at \`${liveHead!.slice(0, 12)}\`. Commits after the witness are not covered by it. Re-witness before this evidence is read as current.`
      : `\n- **The pull request moved past the witnessed commit before it reached ${packet.status}.** Proof above is bound to \`${witnessed!.slice(0, 12)}\`; the branch ended at \`${liveHead!.slice(0, 12)}\`. Commits after the witness were never covered by it. Nothing to re-witness — this is the historical limit of the proof.`;
  const lines = [
    `# Evidence — ${packet.repoId}#${packet.issueNumber}`,
    "",
    `**Issue:** [${packet.issueTitle}](${packet.issueUrl})`,
    `**Pull request:** ${packet.prUrl ?? "not opened"}  ·  **status:** ${packet.status}`,
    "",
    "## Who approved this",
    attest
      ? `Attested by **${attest.by}** at ${attest.at}: ${attest.note}`
      : "No human attestation on record — this packet must not reach a maintainer.",
    "",
    "## What your policy says",
    record
      ? `From \`${record.source}\` (fetched ${record.fetchedAt}, stance: ${record.stance}):\n\n> ${record.quote}`
      : "No committed policy record; the gate relied on live-fetched docs at evaluation time.",
    "",
    "## What ran",
    ev
      ? [
          `- Range: \`${ev.baseSha.slice(0, 12)}..${ev.headSha.slice(0, 12)}\` — ${ev.filesChanged} files, ${ev.diffLines} changed lines`,
          `- Test command: \`${ev.testCommand}\``,
          w
            ? // The toolchain answers the question a maintainer cannot answer from our machine:
              // *which* interpreter produced this exit 0. Printed only when the witness resolved
              // one — a witness that did not know says nothing rather than implying it asked.
              `- Witnessed by the ${w.provider} sandbox at ${w.ranAt}${w.toolchain ? ` (toolchain: ${w.toolchain})` : ""}: tests exit ${w.testExit} at head; **exit ${w.revertExit} with the change reverted** (the proof binds). Log hashes sha256 ${w.testLogSha.slice(0, 12)}… / ${w.revertLogSha.slice(0, 12)}…`
            : `- Negative control: ${ev.negativeControl} (recorded before machine witnessing shipped — attested, not witnessed)`,
          ...(w?.testLogPath && w?.revertLogPath
            ? [
                // Paths alone resolve to nothing in the maintainer's own tree — name the repository
                // they are in, or the "recompute it yourself" offer is not one they can take.
                `- Recompute it yourself: both logs are committed in ${FOUNDRY_REPO_URL} (Foundry's repo, not yours) at \`${w.testLogPath}\` and \`${w.revertLogPath}\`. From a clone of it: \`shasum -a 256 ${w.testLogPath} ${w.revertLogPath}\`.`,
              ]
            : []),
        ].join("\n") + stale
      : "No evidence manifest — this packet must not reach a maintainer.",
    "",
    "## Standing commitments",
    "- Opened as a draft; you own the merge — the factory has no merge capability.",
    "- One packet in flight; follow-up until merged, closed, or quiet.",
    "- Say stop and the repository is halted the same hour.",
    "",
    "---",
    DISCLOSURE,
    "",
  ];
  return lines.join("\n");
}
