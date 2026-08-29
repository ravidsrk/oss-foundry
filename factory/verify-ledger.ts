import { packetChecks } from "./ledger-check.ts";
import { syncGithubPr } from "./github-pr.ts";
import { seedState } from "./seed.ts";

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
  const checks = packetChecks(packet, {
    state: synced.meta.state,
    merged: synced.meta.merged,
    draft: synced.meta.draft,
    headSha: synced.meta.headSha,
  });
  fatal.push(...checks.fatal);
  advisory.push(...checks.advisory);
}
for (const a of advisory) console.error(`ADVISORY ${a}`);
if (fatal.length > 0) {
  for (const d of fatal) console.error(`DIVERGENCE ${d}`);
  process.exit(1);
}
const owed = advisory.length === 0 ? "" : `; ${advisory.length} advisory outstanding (see above)`;
console.log(`ledger ok: ${withPr.length} packets match GitHub${owed}`);
