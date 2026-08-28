import { packetDivergences } from "./ledger-check.ts";
import { syncGithubPr } from "./github-pr.ts";
import { seedState } from "./seed.ts";

// Clock-side, read-only: the committed seed ledger must match GitHub. Any divergence fails the
// run visibly — drift is caught within one tick, not at the next hand edit.
const state = seedState();
const withPr = state.packets.filter((p) => p.prUrl);
let divergences: string[] = [];
for (const packet of withPr) {
  const synced = await syncGithubPr({ url: packet.prUrl! });
  if (!synced.ok) {
    console.error(`verify-ledger: ${packet.id}: ${synced.error}`);
    process.exit(1);
  }
  divergences = divergences.concat(
    packetDivergences(packet, {
      state: synced.meta.state,
      merged: synced.meta.merged,
      draft: synced.meta.draft,
      headSha: synced.meta.headSha,
    }),
  );
}
if (divergences.length > 0) {
  for (const d of divergences) console.error(`DIVERGENCE ${d}`);
  process.exit(1);
}
console.log(`ledger ok: ${withPr.length} packets match GitHub`);
