import { competingWorkAdvisory } from "./engine.ts";
import { readCompetition } from "./competition-read.ts";
import { packetChecks } from "./ledger-check.ts";
import { revertCheck, syncGithubPr } from "./github-pr.ts";
import { seedState } from "./seed.ts";
import { installTerminalBoundary } from "./terminal.ts";

// Clock-side, read-only: the committed seed ledger must match GitHub. A divergence — the published
// ledger asserting something GitHub contradicts — fails the run visibly, so drift is caught within
// one tick and not at the next hand edit.
//
// Advisories are printed on the same terminal and never gate. They are debts on a ledger that
// already reconciles (today: evidence witnessed at a commit the branch has moved past), and no
// commit to this repository can clear one — only a sandbox re-run against the upstream branch can.
// Failing CI on them would leave the default branch red for days with nothing to merge that fixes
// it, which is the pressure that gets a SHA re-stamped by someone who wants green. Issue #49: the
// clock says the ledger reconciles AND says the proof is behind, and means both.
// The clock renders third-party text too: a pull request body, a divergence quoting one, an error
// string GitHub wrote. Same boundary as `cli.ts`, installed before the first line is printed —
// this runs unattended every six hours and its output is read as the record of what was checked.
installTerminalBoundary();

const state = seedState();
const withPr = state.packets.filter((p) => p.prUrl);
const fatal: string[] = [];
const advisory: string[] = [];
for (const packet of withPr) {
  const synced = await syncGithubPr({ url: packet.prUrl! });
  if (!synced.ok) {
    console.error(`verify-ledger: ${packet.id}: ${synced.error}`);
    process.exit(1);
  }
  // SPEC.md §7 halts a repository on any revert of the operator's patch, and this workflow is the
  // only thing that runs unattended (.github/workflows/oss-tick.yml, every 6h). The clock cannot
  // write the ledger — it reads the committed seed — but it can refuse to call a ledger reconciled
  // while GitHub says our merge commit was reverted and the record says otherwise (issue #39).
  // Only for a merged packet, and no longer one request: since the read follows GitHub's `Link`
  // cursor it costs 1..MAX_COMMIT_PAGES (10) requests, one per page of the bounded revert window.
  const reverted =
    packet.status === "merged" ? await revertCheck(packet.repoId, synced.meta) : undefined;
  if (reverted && !reverted.ok) {
    advisory.push(
      `${packet.id}: could not read ${packet.repoId} commits since the merge — a revert would go unnoticed this run (${reverted.error})`,
    );
  }
  const checks = packetChecks(packet, {
    state: synced.meta.state,
    merged: synced.meta.merged,
    draft: synced.meta.draft,
    headSha: synced.meta.headSha,
    // The live body, for the SPEC.md §6 disclosure MUST (issue #38). Dropping this field does not
    // break the call — it makes the check report that it could not run, which is the loudest thing
    // a skipped doctrine check can do.
    body: synced.body,
    // Same contract for the revert verdict (issue #39): omit it on a merged packet and the check
    // says it did not run.
    revert: reverted?.ok ? reverted.verdict : undefined,
    // And whether that verdict saw the whole window. A capped read returns the same commits and
    // the same `reverted: false` a complete one does, so without this the clock cannot tell a
    // clean base branch from one it only half-read — and it would print `ledger ok` over both.
    revertTruncated: reverted?.ok ? reverted.truncated : undefined,
    // And the same for the review read (issue #69): a capped one records nothing, and the operator
    // needs to be told the cap did it rather than an outage.
    reviewTruncated: synced.reviewTruncated,
  });
  fatal.push(...checks.fatal);
  advisory.push(...checks.advisory);
  // Competing work is re-checked on the clock, not only at tick/approve/open-draft (issue #111).
  // A closed-unmerged packet is at rest — the close FATAL/absorption owns that story.
  const stillOpen =
    (packet.status === "submitted" || packet.status === "followed-up") &&
    packet.prMeta?.state !== "closed" &&
    !packet.prMeta?.merged;
  if (stillOpen) {
    const competition = await readCompetition(packet);
    if (!competition.ok) {
      advisory.push(
        `${packet.id}: could not re-check competing work on ${packet.repoId} — a closing-keyword PR would go unnoticed this run (${competition.error})`,
      );
    } else {
      const line = competingWorkAdvisory(packet, competition.verdict);
      if (line) advisory.push(line);
    }
  }
}
for (const a of advisory) console.error(`ADVISORY ${a}`);
if (fatal.length > 0) {
  for (const d of fatal) console.error(`DIVERGENCE ${d}`);
  process.exit(1);
}
const owed = advisory.length === 0 ? "" : `; ${advisory.length} advisory outstanding (see above)`;
console.log(`ledger ok: ${withPr.length} packets match GitHub${owed}`);
