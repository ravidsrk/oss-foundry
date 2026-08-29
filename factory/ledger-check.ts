import type { FactoryState, TaskPacket } from "./types.ts";

export interface LivePrLite {
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headSha: string;
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
  return { fatal: out, advisory };
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
    (packet.status === "submitted" || packet.status === "followed-up")
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
