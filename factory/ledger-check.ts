import { DISCLOSURE, DISCLOSURE_TAIL } from "./neighbor.ts";
import { isTerminalReviewSubject, revertNote, type RevertVerdict } from "./scorecard.ts";
import type { FactoryState, TaskPacket } from "./types.ts";

/** A packet whose PR has reached a terminal GitHub state is at rest for re-witness and disclosure. */
function isAbsorbedClose(packet: TaskPacket): boolean {
  return isTerminalReviewSubject(packet);
}

export interface LivePrLite {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headSha: string;
  /**
   * The PR body as GitHub serves it (`syncGithubPr` returns it beside `meta`). Required, not
   * optional: `disclosureDivergence` reads it for the SPEC.md §6 MUST, and a caller that omits it
   * gets a reported line rather than a silently skipped check — a check that can be turned off by
   * forgetting a field is not a check.
   */
  body: string;
  /**
   * What the base branch says about a revert of this packet's merge commit, as `revertCheck` read
   * it — SPEC.md §7, "MUST halt a repository on ... any revert of the operator's patch" (issue
   * #39). Optional in the type and NOT optional in effect: a merged packet that arrives without
   * one is reported as a check that did not run, on the same principle as `body` above. A doctrine
   * check you can switch off by forgetting a field is not a check.
   */
  revert?: RevertVerdict;
  /**
   * Did the commit read behind `revert` stop at its page cap? A capped read hands back the same
   * `reverted: false` a complete one does, so without this the two are indistinguishable and a
   * short read prints `ledger ok` — the one thing a doctrine check must never do. Surfaced on the
   * same advisory path a failed read takes, because it is the same fact at a lower strength.
   */
  revertTruncated?: boolean;
  /**
   * Did the human-review read stop at its page cap? `revertTruncated`'s fact one endpoint over: a
   * capped read records nothing, like a failed one, so without this the advisory below says "re-run
   * when GitHub answers" — advice that cannot work, because it answered and the cap is deterministic.
   */
  reviewTruncated?: boolean;
}

/**
 * One packet's reconciliation against the live PR, split by what the reader owes.
 *
 * `fatal` is SPEC.md §7 — "the committed ledger MUST be reconcilable against the platform's live
 * state" — the one MUST the 6-hour clock exists to enforce. Every line here is the published
 * ledger asserting something GitHub contradicts, so it stops the clock until a human resolves it.
 *
 * `advisory` is work the operator owes on a ledger that already reconciles. Nothing in it
 * contradicts GitHub, so failing CI on it would red the default branch for a debt measured in
 * days, with no edit to this repository able to clear it — and would push whoever wanted green
 * toward re-stamping evidence nobody re-ran. It is always reported, never a gate.
 */
export interface LedgerReconciliation {
  fatal: string[];
  advisory: string[];
}

/**
 * Compare one packet's recorded state against the live PR. Mechanical drift (a merge or close the
 * ledger has not absorbed) names the `sync` command that resolves it; doctrine drift (a draft flag
 * or head SHA that contradicts the record) is printed for a human — divergence is a doctrine
 * event, never silently rewritten.
 */
export function packetChecks(packet: TaskPacket, live: LivePrLite): LedgerReconciliation {
  const out: string[] = [];
  const advisory: string[] = [];
  if (packet.status === "merged" && !live.merged) {
    out.push(
      `${packet.id}: ledger says merged but the PR is ${live.state} and unmerged — resolve by hand; the ledger never un-merges itself`,
    );
  }
  // A rejected or parked packet is terminal in the ledger, but if it still names a PR that is
  // open on GitHub the draft was abandoned, not closed — without this branch it never surfaces
  // again (issue #34). Once the PR is actually closed, there is nothing left to flag.
  if ((packet.status === "rejected" || packet.status === "parked") && packet.prUrl) {
    if (!live.merged && live.state === "open") {
      out.push(
        `${packet.id}: packet is ${packet.status} but ${packet.prUrl} is still open on GitHub — an abandoned live PR; close it by hand or it stays invisible`,
      );
    }
  }
  if (packet.status === "submitted" || packet.status === "followed-up") {
    if (live.merged) {
      out.push(`${packet.id}: PR merged upstream — mechanical: run \`sync ${packet.id}\` to record it`);
    } else if (live.state === "closed" && packet.prMeta?.state !== "closed") {
      // Only an UNABSORBED close is drift. Once sync has recorded the close (prMeta.state ===
      // "closed"), the followed-up packet is at rest — re-reporting it forever would train the
      // operator (and the clock) to ignore real divergence.
      out.push(`${packet.id}: PR closed unmerged — mechanical: run \`sync ${packet.id}\` to record it`);
    }
  }
  if (packet.prMeta && packet.prMeta.draft !== live.draft) {
    out.push(
      `${packet.id}: recorded draft=${packet.prMeta.draft} but live draft=${live.draft} — doctrine event, resolve by hand`,
    );
  }
  // Two independent signals, deliberately NOT an if/else chain — they answer different questions,
  // either can be true on its own, and they land in different buckets.
  //
  // (1) Evidence staleness is measured from the WITNESSED commit, not from `prMeta.headSha` —
  // `sync` overwrites prMeta on every run, so anchoring there erases the warning exactly when new
  // commits arrive. `evidence.reviewedSha` is immutable, so the flag persists until the packet is
  // re-witnessed. Only live packets are checked: a terminal packet is at rest, and re-reporting it
  // every tick would train the operator (and the clock) to ignore real divergence. It is ADVISORY:
  // the ledger is not lying about GitHub, the proof simply predates the head, and the only cure is
  // a sandbox re-run against the upstream branch — nothing a commit to this repository can supply.
  //
  // (2) Recorded-ledger-vs-live is SPEC.md §7 — "the committed ledger MUST be reconcilable against
  // the platform's live state" — the one MUST the 6-hour clock exists to enforce. Chaining it
  // behind (1) made it reachable only for packets with no evidence at all, so a seed could publish
  // a PR head that is not the live head and `verify-ledger` would still print `ledger ok`. FATAL.
  const witnessed = witnessedSha(packet);
  if (witnessed && needsRewitness(packet, live.headSha)) {
    advisory.push(
      `${packet.id}: evidence witnessed at ${witnessed.slice(0, 7)} but live head ${live.headSha.slice(0, 7)} — commits landed after the review; re-witness before the evidence is read as current`,
    );
  }
  if (live.headSha && packet.prMeta && packet.prMeta.headSha !== live.headSha) {
    out.push(
      `${packet.id}: recorded head ${packet.prMeta.headSha.slice(0, 7)} but live head ${live.headSha.slice(0, 7)} — new commits since the last sync`,
    );
  }
  // (3) A third independent signal, and deliberately not chained behind either of the above: a
  // body can drift while the head is current, and a head can move while the body is untouched.
  const disclosure = disclosureDivergence(packet, live.body);
  if (disclosure) advisory.push(disclosure);
  // (4) The revert, on merged packets only — a revert is of a merge (issue #39).
  //
  // FATAL, and the bucket is the argument. This is the `fatal` shape exactly: the published ledger
  // carries no record of a revert GitHub says happened, and one commit to THIS repository clears it
  // — record the revert and promote it into the seed. That is the difference from the disclosure
  // drift above, which no commit here can fix. SPEC.md §7 makes the halt a MUST, and the 6-hour
  // clock is the only thing that runs unattended, so this is where the MUST stops depending on a
  // human happening to look. Once the revert is recorded the line goes quiet, so the clock never
  // pressures anyone toward green by any means.
  //
  // What "the ledger records no revert" is read from, precisely: `revertNote(packet)`, not the
  // scorecard's `reverts` counter — `packetChecks` is given one packet and never sees the
  // scorecard. The two are equivalent because `applyRevert` is the sole writer of either and writes
  // both in one step (pinned by "applyRevert writes the note and the counter together"). The
  // residual hole is a hand-edited seed carrying the note with `reverts: 0`, which would quiet this
  // line while the KPI still read zero; nothing here checks that pairing, and a checker that did
  // would need the scorecard threaded in.
  if (packet.status === "merged" && live.merged) {
    if (!live.revert) {
      advisory.push(
        `${packet.id}: the revert re-check did not run — SPEC.md §7 halts on any revert of our patch and nothing looked at ${packet.repoId}`,
      );
    } else if (live.revert.reverted) {
      if (!revertNote(packet)) {
        out.push(
          `${packet.id}: ${live.revert.why} — SPEC.md §7 MUST halt ${packet.repoId}. The ledger records no revert, and this clock reads the COMMITTED SEED: record it locally (\`reconcile\`, or \`revert ${packet.id} --reason …\` if a maintainer said so in prose), then promote the recorded revert into factory/seed.ts and regenerate the docs/12-ledger.md block. Only the seed edit greens this line — .foundry-state.json is gitignored and CI never sees it (docs/08-operations.md: "Promoting live state into the seed is an explicit human step")`,
        );
      }
    } else if (live.revertTruncated) {
      // The verdict is `reverted: false` and the read did not reach the end, so the sentence the
      // clock would otherwise print — "no revert" — is not one it is entitled to.
      advisory.push(
        `${packet.id}: the revert re-check on ${packet.repoId} hit its page cap before reaching the merge — only the commits it read were classified, and a revert in the unread remainder would go unnoticed this run`,
      );
    }
  }
  // (5) The review KPIs, on any packet whose PR reached a terminal outcome (issue #39 round 3).
  //
  // `noReview` and `reviewCommentsAvg` are written once, by `recordTerminalReview`, on the tick
  // that absorbs the merge or the first close. A packet whose review endpoints were down for that
  // one request carries no `humanReview` — and `recordTerminalReview` correctly refuses to write a
  // zero it never saw, so the row simply excludes it. That is the honest thing to do to the
  // numerator, and it silently shrinks the denominator: the scorecard reports `noReview` over
  // fewer terminal PRs than the merge count implies, and nothing anywhere said so. Issue #39's own
  // indictment — "a zero nobody observed is an invented KPI" — has a second edge, which is a KPI
  // computed over a population nobody was told was short.
  //
  // ADVISORY, not FATAL, and the bucket is the argument. FATAL is reserved for the published
  // ledger asserting something GitHub CONTRADICTS. Here the ledger asserts less than GitHub knows;
  // it contradicts nothing. This is the same shape — and the same bucket — as "the revert re-check
  // did not run" above: a check that produced no observation, reported so nobody reads its absence
  // as a result.
  //
  // Read off the RECORDED packet, not off `live`: the question is what the published ledger
  // observed, and the clock reads the committed seed.
  //
  // The predicate is `isTerminalReviewSubject` — the SAME function the recovery writer refuses on,
  // not a second hand-written copy of it. That matters here more than anywhere: a `rejected` or
  // `parked` packet can name a PR someone else closed, which the ledger never absorbed and never
  // counted, so flagging one would report a hole in a denominator it was never in. If the writer
  // and this reporter could disagree, one of them would be wrong about every such packet.
  //
  // No live field is threaded in for this. It was, briefly, so the line could say whether the
  // review endpoints answer on this pass — and it was unreachable in both verbs: `reconcile`
  // RECOVERS the observation before it checks, so it can only reach this line when the endpoints
  // were down (and the live split is therefore absent anyway), and the clock reads a committed seed
  // whose merged packets all carry one. A branch neither verb can enter is a branch no test can
  // pin, which is how the last two rounds of this unit went wrong. The line is derived from the
  // packet and from fields both call sites already supply, so surfacing it takes no new agreement
  // between them and cannot be switched off by forgetting a field at one of the two.
  //
  // Live agreement IS required on top of the predicate, from those same already-supplied fields:
  // while the ledger and GitHub disagree about the outcome there is a FATAL above, and that is the
  // sentence the operator should be reading rather than this one.
  const liveTerminal = live.merged || live.state === "closed";
  if (isTerminalReviewSubject(packet) && liveTerminal && packet.prUrl && !packet.prMeta?.humanReview) {
    // WHY it is missing decides the advice, and the two reasons want opposite advice: a failed
    // endpoint is worth re-running, a CAPPED read caps again. Emitting both lines in one run told the
    // operator to re-run and not to re-run about one PR.
    advisory.push(
      live.reviewTruncated
        ? `${packet.id}: the human-review read on ${packet.repoId} stopped at its page cap, so noReview and reviewCommentsAvg are computed WITHOUT this PR. A re-run will cap again — read the PR by hand, or raise the cap deliberately`
        : `${packet.id}: the ledger records no human-review observation for a terminal PR — ${packet.repoId}'s noReview and reviewCommentsAvg are computed WITHOUT it, so the KPI's denominator is smaller than the terminal count suggests. Run \`reconcile\` on a pass where GitHub answers the review endpoints (NOT \`sync\`, which refuses a terminal packet), then promote the recovered row into factory/seed.ts`,
    );
  }
  return { fatal: out, advisory };
}

/**
 * The live PR body against the current `DISCLOSURE` — SPEC.md §6, "the PR body MUST disclose ...
 * verbatim and unabridged", measured against the only copy that matters once a PR is open.
 *
 * Nothing checked this. `packetChecks` diffed `{status/merged, draft, headSha}` and never looked
 * at body text, so ADR 0004 could add the `(ravidsrk/oss-foundry)` qualifier to `DISCLOSURE` while
 * ColeMurray/background-agents#1652 was open, the live body could keep the old block, and
 * `verify-ledger` printed `ledger ok` over a violated MUST on a stranger's repository (issue #38).
 *
 * **ADVISORY, and the bucket is the whole argument.** The two buckets ask different questions.
 * `fatal` is "the published ledger asserts something GitHub contradicts" — a lie this repository
 * can fix by editing the record. This is not that: the ledger's `prBody` is the body Foundry
 * *prepared*, never a claim about what is live, so nothing here is contradicted. What is violated
 * is doctrine, on an artifact this repository cannot reach: only an edit to the upstream PR body
 * moves it, which is an outward-facing write on someone else's repo needing an operator's explicit
 * go. Making it fatal would red the default branch until someone performed that write — the exact
 * "green by any means" pressure issue #49 removed for the re-witness debt, whose shape this
 * matches precisely: an immutable historical artifact that the current record has moved past.
 *
 * So the doctrine is: **enforce at contact, report after it.** `open-draft` and `applyAttachDraft`
 * refuse an undisclosed body before it ever becomes a pull request; from that moment on the clock
 * can only name what it finds, every tick, until a human with authorisation fixes it upstream.
 *
 * Doctrine, never mechanical: the line names no `sync` command, because running one would make the
 * divergence look absorbed while the upstream body sat untouched.
 */
export function disclosureDivergence(packet: TaskPacket, body: string | undefined): string | undefined {
  // The at-rest rule the re-witness debt follows. A merged, closed, rejected or parked packet's
  // body is history that nobody can renegotiate, and re-printing it every tick would train the
  // operator (and the clock) to ignore the line.
  if (packet.status !== "submitted" && packet.status !== "followed-up") return undefined;
  // Closed-unmerged is written as `followed-up` (applyPrSync). Status alone would keep flagging a
  // body nobody can renegotiate (issue #110). Same at-rest key as the review KPI.
  if (isAbsorbedClose(packet)) return undefined;
  if (typeof body !== "string") {
    return `${packet.id}: live PR body was not supplied to the reconciliation — the verbatim disclosure (SPEC.md §6) could not be checked; a caller that cannot read the body must say so, not skip the check`;
  }
  if (body.includes(DISCLOSURE)) return undefined;
  // `DISCLOSURE_TAIL.length > 0` is not decoration: `"".includes("")` is true, so a one-line
  // `DISCLOSURE` would make every body read as "a disclosure that is not the current block",
  // including a body with nothing in it. The invariant is pinned in ledger-check.test.ts.
  const shape = DISCLOSURE_TAIL.length > 0 && body.includes(DISCLOSURE_TAIL)
    ? "carries a Foundry disclosure that is not the current block"
    : "carries no Foundry disclosure at all";
  return `${packet.id}: live PR body ${shape} — SPEC.md §6 wants it verbatim and unabridged; an already-open PR is grandfathered against a later change to \`DISCLOSURE\` (factory/neighbor.ts), so this is a doctrine event: resolve by editing the upstream body with an operator's explicit go, never by re-wording the constant to match`;
}

/**
 * Every line `packetChecks` produces, in one list. For callers that report rather than gate
 * (`reconcile`, and the tests that assert a packet is entirely clean); anything deciding an exit
 * code must read `fatal` and `advisory` apart, or a re-witness debt becomes a broken build.
 */
export function packetDivergences(packet: TaskPacket, live: LivePrLite): string[] {
  const { fatal, advisory } = packetChecks(packet, live);
  return [...fatal, ...advisory];
}

/** The commit the evidence actually describes: the reviewed SHA when there is one, else the witnessed head. */
export function witnessedSha(packet: TaskPacket): string | undefined {
  return packet.evidence?.reviewedSha ?? packet.evidence?.headSha;
}

/**
 * The proof does not cover the commit in front of the reader.
 *
 * One fact, two consumers: `renderEvidencePage` (what does this proof cover?) and
 * `packetDivergences` via `needsRewitness` (does anyone still owe work?). It is derived here once
 * so the audit page and the divergence list can never disagree about whether a packet is stale.
 */
export function evidenceIsStale(packet: TaskPacket, headSha: string | undefined): boolean {
  const witnessed = witnessedSha(packet);
  return Boolean(witnessed && headSha && witnessed !== headSha);
}

/**
 * Stale AND still actionable. A terminal packet is at rest — its evidence is permanently older
 * than the merged head and nobody can re-witness it, so re-reporting it every tick would train the
 * operator (and the clock) to ignore real divergence. The evidence page still STATES the fact,
 * because a maintainer auditing a merged PR needs to know what the proof covered; it just does not
 * ask anyone to act on it.
 */
export function needsRewitness(packet: TaskPacket, headSha: string | undefined): boolean {
  return (
    evidenceIsStale(packet, headSha) &&
    (packet.status === "submitted" || packet.status === "followed-up") &&
    !isAbsorbedClose(packet)
  );
}

/**
 * The clock (`verify-ledger.ts`) checks the COMMITTED SEED against GitHub — the seed is the
 * published ledger, and `.foundry-state.json` is gitignored and absent in CI. That leaves the
 * operator's live file unchecked between hand-promotions, so `status` runs this locally: whatever
 * the live file says that the committed seed does not, a human has to promote or discard.
 */
export function seedDivergences(live: FactoryState, seed: FactoryState): string[] {
  const out: string[] = [];
  const seeded = new Map(seed.packets.map((p) => [p.id, p]));
  for (const packet of live.packets) {
    const committed = seeded.get(packet.id);
    if (!committed) {
      out.push(`${packet.id}: in live state only (${packet.status}) — not in the committed seed`);
      continue;
    }
    seeded.delete(packet.id);
    if (committed.status !== packet.status) {
      out.push(`${packet.id}: live status ${packet.status}, committed seed says ${committed.status}`);
    }
    if ((packet.prUrl ?? "") !== (committed.prUrl ?? "")) {
      out.push(
        `${packet.id}: live PR ${packet.prUrl ?? "none"}, committed seed says ${committed.prUrl ?? "none"}`,
      );
    }
    // The two doctrine-bearing fields of prMeta. syncedAt/updatedAt move on every sync and say
    // nothing a human owes the seed.
    if ((packet.prMeta?.headSha ?? "") !== (committed.prMeta?.headSha ?? "")) {
      out.push(
        `${packet.id}: live head ${(packet.prMeta?.headSha ?? "none").slice(0, 7)}, committed seed says ${(committed.prMeta?.headSha ?? "none").slice(0, 7)}`,
      );
    }
    if (packet.prMeta?.draft !== committed.prMeta?.draft) {
      out.push(
        `${packet.id}: live draft=${packet.prMeta?.draft}, committed seed says draft=${committed.prMeta?.draft}`,
      );
    }
  }
  for (const packet of seeded.values()) {
    out.push(`${packet.id}: only in the committed seed (${packet.status}) — missing from live state`);
  }
  return out;
}
