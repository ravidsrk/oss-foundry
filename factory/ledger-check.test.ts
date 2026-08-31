import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evidenceIsStale,
  needsRewitness,
  packetChecks,
  packetDivergences,
  seedDivergences,
} from "./ledger-check.ts";
import { DISCLOSURE, DISCLOSURE_TAIL } from "./neighbor.ts";
import { seedState } from "./seed.ts";
import { asOpenSubmitted, WAVE1_PACKET_ID, wave1Packet } from "./seed-fixtures.ts";
import { INFLIGHT_STATUSES, type TaskPacket } from "./types.ts";

/**
 * A head the PR moved to after the evidence was witnessed. Synthetic — deliberately sharing no
 * abbreviated prefix with any SHA in the seed, so an assertion on the seven-character form cannot
 * pass by colliding with the real #1652 head below.
 */
const LIVE_HEAD = "facade00c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6";
/** A head the committed ledger still names after the branch has moved on. */
const STALE_HEAD = "deadbee1c0ffee2b3a4d5e6f708192a3b4c5d6e7";

/**
 * The real head ColeMurray/background-agents#1652 sits at, and the commit its evidence was
 * witnessed against. Both read-only from `GET /repos/ColeMurray/background-agents/pulls/1652`
 * (fetched 2026-08-29); the seed was synced to the first by issue #49 and must never be synced to
 * the second, because nobody re-ran the tests there.
 */
const LIVE_HEAD_1652 = "6b6ff04079a47109263b81726a1c29459b334de5";
const WITNESSED_1652 = "48c2242683705b00503d3436575bf3c28b1b0c9b";
/**
 * The third fact the #49 sync promoted, from the same read-only fetch. It is pinned here because
 * nothing else can hold it: `packetChecks` reconciles draft, head and merge state, and deliberately
 * says nothing about `commits` — so a hand-edited count in the seed is invisible to the clock, and
 * this assertion is the only thing standing between it and a silently wrong published number.
 */
const LIVE_COMMITS_1652 = 7;

/**
 * The disclosure block ColeMurray/background-agents#1652 actually carries, read-only from
 * `GET /repos/ColeMurray/background-agents/pulls/1652` (fetched 2026-08-29) — three lines,
 * transcribed, not derived. ADR 0004 added the `(ravidsrk/oss-foundry)` qualifier to `DISCLOSURE`
 * while this PR was already open, and an open PR's body is not retroactively patched by a constant
 * change: the live block is the one below, and it is what a maintainer reads today.
 *
 * Transcribed rather than computed from `DISCLOSURE` on purpose. A derivation would follow the
 * constant the day someone edits it, and the whole point of the check under test is that the live
 * body does NOT follow. `assert.notEqual` below keeps it from silently becoming a copy.
 */
const LIVE_DISCLOSURE_1652 = `This patch was prepared by Foundry, an operator-gated contribution factory.
A human reviewed the packet, the diff, and the tests before this draft was opened.
The factory does not merge. Maintainers own the merge.`;

/** A PR body that satisfies SPEC.md §6 — the current block, verbatim and unabridged. */
const VERBATIM_BODY = `## Summary\n\nFixes the thing.\n\n## Disclosure\n\n${DISCLOSURE}\n`;

function submittedPacket(): TaskPacket {
  return asOpenSubmitted(wave1Packet());
}

test("#49: promoting the live facts into the seed reconciles the clock without erasing the re-witness debt", () => {
  // The operator marked #1652 ready for review at 18:09:24Z on 2026-08-28 and a seventh commit
  // landed eight seconds later, so the seed's `draft: true` / `headSha: 48c2242` contradicted
  // GitHub and `verify-ledger` was red on `main`. Promoting the live facts clears that
  // contradiction. It must NOT clear the fact that the evidence describes a commit two pushes
  // back — that is the signal #43 anchored to the immutable `evidence.reviewedSha` precisely so
  // this sync could not silently erase it.
  const packet = submittedPacket();
  const live = {
    state: "open" as const,
    merged: false,
    draft: false,
    headSha: LIVE_HEAD_1652,
    body: VERBATIM_BODY,
  };

  // The committed seed must name exactly the live facts; that is what makes the clock green.
  assert.equal(packet.prMeta!.draft, live.draft, "the seed still records a draft the PR is not");
  assert.equal(packet.prMeta!.headSha, live.headSha, "the seed still records a head GitHub left");
  assert.equal(
    packet.prMeta!.commits,
    LIVE_COMMITS_1652,
    "the seed still records a commit count GitHub left — and no check downstream of here can tell",
  );
  // ...and must NOT have re-stamped the evidence, which is the one way to make the clock green by
  // lying: nobody re-ran the test command at 6b6ff04, so the proof still covers 48c2242 only.
  assert.equal(
    packet.evidence!.reviewedSha,
    WITNESSED_1652,
    "evidence may only move when a witness actually re-ran it",
  );

  const { fatal, advisory } = packetChecks(packet, live);
  assert.deepEqual(fatal, [], `the ledger must reconcile against live; got ${JSON.stringify(fatal)}`);
  assert.equal(
    advisory.some(
      (a) => a.includes(WITNESSED_1652.slice(0, 7)) && a.includes(LIVE_HEAD_1652.slice(0, 7)),
    ),
    true,
    `the re-witness debt must outlive the sync; got ${JSON.stringify(advisory)}`,
  );
});

test("#49: staleness anchored to prMeta.headSha would have gone silent at this exact sync", () => {
  // The ordering rationale for #49 behind #43, executable. Before #43 the staleness check measured
  // from the MUTABLE prMeta.headSha; reproduced here in shape, it is silent on the very inputs the
  // sync above produces, so the sync would have erased the witnessed-at-48c2242 fact for good.
  const packet = submittedPacket();
  const unanchoredIsStale = (p: TaskPacket, headSha: string) => p.prMeta!.headSha !== headSha;

  assert.equal(
    unanchoredIsStale(packet, LIVE_HEAD_1652),
    false,
    "the un-anchored predicate goes quiet the moment prMeta catches up — this is what #43 removed",
  );
  assert.equal(evidenceIsStale(packet, LIVE_HEAD_1652), true, "the anchored fact is still true");
  assert.equal(needsRewitness(packet, LIVE_HEAD_1652), true, "and someone still owes the re-witness");
});

test("#49: only the re-witness debt is advisory — a ledger contradiction stays fatal", () => {
  // The fatal/advisory split exists so a debt the operator owes cannot masquerade as the ledger
  // lying, and it must not become a way to demote real contradictions out of the clock.
  const packet = submittedPacket();
  const at = (over: Partial<{ draft: boolean; headSha: string }>) =>
    packetChecks(packet, {
      state: "open" as const,
      merged: false,
      draft: packet.prMeta!.draft,
      headSha: packet.prMeta!.headSha!,
      body: VERBATIM_BODY,
      ...over,
    });

  const flipped = at({ draft: !packet.prMeta!.draft });
  assert.equal(
    flipped.fatal.some((d) => d.includes("doctrine event")),
    true,
    `a draft-flag flip must stop the clock; got ${JSON.stringify(flipped)}`,
  );
  const behind = at({ headSha: STALE_HEAD });
  assert.equal(
    behind.fatal.some((d) => d.includes("recorded head")),
    true,
    `a ledger head behind live must stop the clock; got ${JSON.stringify(behind)}`,
  );
  // The flat view stays whole: every line still reaches a caller that only reports.
  assert.deepEqual(
    packetDivergences(packet, {
      state: "open",
      merged: false,
      draft: !packet.prMeta!.draft,
      headSha: STALE_HEAD,
      body: VERBATIM_BODY,
    }).length,
    at({ draft: !packet.prMeta!.draft, headSha: STALE_HEAD }).fatal.length +
      at({ draft: !packet.prMeta!.draft, headSha: STALE_HEAD }).advisory.length,
  );
});

test("evidence staleness is bound to the witnessed SHA and survives the sync that moves prMeta", () => {
  const packet = submittedPacket();
  const witnessed = packet.evidence!.reviewedSha!;
  const live = {
    state: "open" as const,
    merged: false,
    draft: true,
    headSha: LIVE_HEAD,
    body: VERBATIM_BODY,
  };

  const beforeSync = packetDivergences(packet, live);
  assert.equal(
    beforeSync.some((d) => d.includes(witnessed.slice(0, 7)) && d.includes(LIVE_HEAD.slice(0, 7))),
    true,
    "new commits past the witnessed head must be reported",
  );

  // `sync` overwrites prMeta.headSha with the live head. evidence.reviewedSha is immutable, so the
  // staleness must still be reported afterwards — otherwise the sync silently erases the signal.
  const synced: TaskPacket = { ...packet, prMeta: { ...packet.prMeta!, headSha: LIVE_HEAD } };
  const afterSync = packetDivergences(synced, live);
  assert.equal(
    afterSync.some((d) => d.includes(witnessed.slice(0, 7)) && d.includes(LIVE_HEAD.slice(0, 7))),
    true,
    "the staleness flag must outlive the sync that overwrites prMeta.headSha",
  );
});

test("recorded-head-vs-live is reported even when the packet carries evidence", () => {
  // SPEC.md §7: the committed ledger MUST be reconcilable against the platform's live state — the
  // one MUST the 6h clock enforces. Chaining this behind the evidence check made it reachable only
  // for packets with no evidence at all, so a seed could publish a head that is not the live head
  // and `verify-ledger` would still print `ledger ok`.
  const packet = submittedPacket();
  const witnessed = packet.evidence!.reviewedSha!;
  const behind: TaskPacket = { ...packet, prMeta: { ...packet.prMeta!, headSha: STALE_HEAD } };

  // The evidence is current (witnessed === live head), so ONLY the ledger-behind-live signal fires.
  const out = packetDivergences(behind, {
    state: "open",
    merged: false,
    draft: behind.prMeta!.draft,
    headSha: witnessed,
    body: VERBATIM_BODY,
  });
  assert.equal(
    out.some(
      (d) => d.includes("recorded head") && d.includes(STALE_HEAD.slice(0, 7)) && d.includes(witnessed.slice(0, 7)),
    ),
    true,
    `ledger-behind-live must be reported; got ${JSON.stringify(out)}`,
  );
  assert.equal(
    out.some((d) => d.includes("evidence witnessed at")),
    false,
    "evidence witnessed at the live head is not stale",
  );
});

test("evidence staleness and ledger-behind-live are independent signals", () => {
  // Both true at once: the seed names one head, the evidence a second, GitHub a third. Neither
  // signal may mask the other.
  const packet = submittedPacket();
  const witnessed = packet.evidence!.reviewedSha!;
  const drifted: TaskPacket = { ...packet, prMeta: { ...packet.prMeta!, headSha: STALE_HEAD } };
  const out = packetDivergences(drifted, {
    state: "open",
    merged: false,
    draft: drifted.prMeta!.draft,
    headSha: LIVE_HEAD,
    body: VERBATIM_BODY,
  });
  assert.equal(
    out.some((d) => d.includes("evidence witnessed at") && d.includes(witnessed.slice(0, 7))),
    true,
    `evidence staleness must be reported; got ${JSON.stringify(out)}`,
  );
  assert.equal(
    out.some((d) => d.includes("recorded head") && d.includes(STALE_HEAD.slice(0, 7))),
    true,
    `ledger-behind-live must be reported; got ${JSON.stringify(out)}`,
  );
});

test("re-witnessing at the live head clears the staleness", () => {
  const packet = submittedPacket();
  const rewitnessed: TaskPacket = {
    ...packet,
    prMeta: { ...packet.prMeta!, headSha: LIVE_HEAD },
    evidence: { ...packet.evidence!, headSha: LIVE_HEAD, reviewedSha: LIVE_HEAD },
  };
  assert.deepEqual(
    packetDivergences(rewitnessed, {
      state: "open",
      merged: false,
      // The live flag the seed records, whatever it is — the subject here is staleness, and
      // hard-coding `true` made this test fail the day the seed recorded the ready-for-review
      // state (#49) for a reason that has nothing to do with re-witnessing.
      draft: rewitnessed.prMeta!.draft,
      headSha: LIVE_HEAD,
      body: VERBATIM_BODY,
    }),
    [],
  );
});

test("a followed-up packet owes the re-witness exactly as a submitted one does", () => {
  // `needsRewitness` gates on a PAIR of live statuses, and the seed's only advisory-bearing packet
  // is `submitted` — so narrowing the guard to `submitted` alone leaves the whole suite green while
  // a packet that has already been answered once, with commits landed after its review, silently
  // stops being reported. Since #49 that guard decides what the clock prints and what `reconcile`
  // labels, so both arms are pinned here and the terminal arm below stays shut.
  const packet = submittedPacket();
  const followedUp: TaskPacket = { ...packet, status: "followed-up" };
  assert.equal(
    needsRewitness(followedUp, LIVE_HEAD_1652),
    true,
    "a followed-up packet is still live — its stale evidence is still someone's debt",
  );
  const { fatal, advisory } = packetChecks(followedUp, {
    state: "open",
    merged: false,
    draft: followedUp.prMeta!.draft,
    headSha: LIVE_HEAD_1652,
    body: VERBATIM_BODY,
  });
  assert.deepEqual(fatal, [], `nothing here contradicts GitHub; got ${JSON.stringify(fatal)}`);
  assert.equal(
    advisory.some((a) => a.includes(WITNESSED_1652.slice(0, 7)) && a.includes(LIVE_HEAD_1652.slice(0, 7))),
    true,
    `the debt must reach the advisory bucket from this status too; got ${JSON.stringify(advisory)}`,
  );
  // The complement: the guard is those two statuses, not "any status". A rejected packet is at
  // rest and nobody can re-witness it, so it must not be asked to.
  assert.equal(
    needsRewitness({ ...packet, status: "rejected" }, LIVE_HEAD_1652),
    false,
    "a terminal packet is at rest — re-reporting it every tick trains the operator to ignore the line",
  );
});

/**
 * SPEC.md §6 — "The PR body MUST disclose ... verbatim and unabridged" — measured against the copy
 * that matters once a PR is open: GitHub's.
 *
 * `packetChecks` diffed `{status/merged, draft, headSha}` and never looked at body text, so ADR
 * 0004 could add the `(ravidsrk/oss-foundry)` qualifier to `DISCLOSURE` while #1652 was open and
 * `verify-ledger` would still print `ledger ok` over a violated MUST. The drift below is the real
 * one, not a fixture. Issue #38.
 */
test("a live PR body that no longer matches the current disclosure is an advisory, not silence", () => {
  const packet = submittedPacket();
  assert.notEqual(
    LIVE_DISCLOSURE_1652,
    DISCLOSURE,
    "the transcribed live block has become a copy of the constant — re-fetch #1652 or this test is vacuous",
  );
  const live = {
    state: "open" as const,
    merged: false,
    draft: packet.prMeta!.draft,
    headSha: packet.prMeta!.headSha,
    body: `## Summary\n\nFixes #1476\n\n## Disclosure\n\n${LIVE_DISCLOSURE_1652}\n`,
  };

  const { fatal, advisory } = packetChecks(packet, live);
  // Advisory, not fatal, and the bucket is the argument: nothing here contradicts GitHub — the
  // ledger's own record of this PR is accurate — and no commit to THIS repository can move a body
  // that lives on someone else's repo. Reddening `main` over a debt no merge can pay is the exact
  // pressure #49 removed. The cure is an authorised edit to the upstream PR; until then the clock
  // says it every tick.
  assert.deepEqual(
    fatal,
    [],
    `a grandfathered body is not the ledger lying about GitHub; got ${JSON.stringify(fatal)}`,
  );
  assert.equal(
    advisory.some((a) => a.includes("disclosure")),
    true,
    `the drift must be reported; got ${JSON.stringify(advisory)}`,
  );
  // Doctrine, never mechanical: no `sync` verb may appear next to it, or an operator will run one
  // and the divergence will look absorbed while the upstream body is untouched.
  const line = advisory.find((a) => a.includes("disclosure"))!;
  assert.doesNotMatch(line, /run `sync/, `a doctrine event must not name a mechanical fix: ${line}`);
  assert.match(line, /doctrine/, line);

  // The same packet against a body carrying the current block is clean — the check reads the body,
  // not the packet's status.
  assert.equal(
    packetChecks(packet, { ...live, body: VERBATIM_BODY }).advisory.some((a) => a.includes("disclosure")),
    false,
    "a verbatim body must not be flagged",
  );
});

test("no disclosure at all reads differently from a disclosure that drifted", () => {
  // Two different things for the operator to do — go look at why a PR opened bare, versus
  // grandfather a body the constant moved past — so they must not print the same line.
  const packet = submittedPacket();
  const at = (body: string | undefined) =>
    packetChecks(packet, {
      state: "open" as const,
      merged: false,
      draft: packet.prMeta!.draft,
      headSha: packet.prMeta!.headSha,
      body: body as string,
    }).advisory.find((a) => a.includes("disclosure"));

  const bare = at("Fixes #1476\n\nSee the issue for context.");
  assert.ok(bare, "a body with no Foundry disclosure at all must be reported");
  assert.match(bare, /no Foundry disclosure/);

  const drifted = at(`Fixes #1476\n\n${LIVE_DISCLOSURE_1652}`);
  assert.ok(drifted, "a drifted disclosure must be reported");
  assert.match(drifted, /not the current block/);
  assert.notEqual(bare, drifted, "the two states must not collapse into one message");

  // Fail closed on the caller, not just on the body. `body` is required, and a caller that does not
  // supply it gets a line saying the MUST could not be checked — never a silently skipped check.
  // This is the shape that lets a future third consumer of `packetChecks` be found by the clock
  // instead of by a maintainer reading an undisclosed PR.
  const unsupplied = at(undefined);
  assert.ok(unsupplied, "an unsupplied body must be reported, not treated as compliant");
  assert.match(unsupplied, /not supplied/);
});

test("DISCLOSURE_TAIL stays a real, non-empty part of the block it is derived from", () => {
  // The derivation is what keeps the two-message split honest, and it has one silent failure mode:
  // `"".includes("")` is true, so a one-line `DISCLOSURE` would make the tail empty and every body
  // — including an empty one — read as "a Foundry disclosure that is not the current block". The
  // guard in `disclosureDivergence` covers the runtime; this covers the premise.
  assert.ok(DISCLOSURE_TAIL.length > 0, "an empty tail makes every body look like a drifted one");
  assert.ok(DISCLOSURE.includes(DISCLOSURE_TAIL), "the tail must come from the block, not beside it");
  assert.notEqual(DISCLOSURE_TAIL, DISCLOSURE, "a tail equal to the whole block distinguishes nothing");
});

test("a terminal packet's disclosure is not re-flagged, and a live one still is", () => {
  // Same at-rest rule the re-witness debt follows: a merged or closed PR's body is history, nobody
  // can renegotiate it, and re-printing it every tick trains the operator to ignore the line.
  const packet = submittedPacket();
  const bare = "Fixes #1476\n\nnothing else";
  const live = {
    state: "open" as const,
    merged: false,
    draft: packet.prMeta!.draft,
    headSha: packet.prMeta!.headSha,
    body: bare,
  };
  const flagged = (p: TaskPacket) => packetChecks(p, live).advisory.some((a) => a.includes("disclosure"));

  assert.equal(flagged(packet), true, "a submitted packet's body is still the operator's to fix");
  assert.equal(flagged({ ...packet, status: "followed-up" }), true, "so is a followed-up one's");
  assert.equal(flagged({ ...packet, status: "merged" }), false, "a merged packet is at rest");
  assert.equal(flagged({ ...packet, status: "rejected" }), false, "so is a rejected one");
  assert.equal(flagged({ ...packet, status: "parked" }), false, "so is a parked one");
});

test("a terminal packet is never re-flagged for evidence staleness", () => {
  // orca-fleet#70 was reviewed at 3ba13f1 and a follow-up commit landed before the maintainer
  // merged it. The packet is at rest; re-reporting it every clock tick would train the operator
  // to ignore divergence, and would fail the committed-seed check in CI forever.
  const merged = seedState().packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_42")!;
  assert.notEqual(merged.evidence!.reviewedSha, merged.prMeta!.headSha);
  assert.deepEqual(
    packetDivergences(merged, {
      state: "closed",
      merged: true,
      draft: false,
      headSha: merged.prMeta!.headSha,
      body: VERBATIM_BODY,
      // "Entirely clean" now includes the revert re-check having run and found nothing. Omitting
      // it is not silence — it is the check reporting that nobody looked (issue #39).
      revert: { reverted: false, why: "no revert on the base branch since the merge" },
    }),
    [],
  );
});

test("live state that has moved past the committed seed is reported packet by packet", () => {
  const seed = seedState();
  assert.deepEqual(seedDivergences(seed, seed), []);

  const moved = {
    ...seed,
    packets: seed.packets.map((p) =>
      p.id === WAVE1_PACKET_ID ? { ...p, status: "parked" as const } : p,
    ),
  };
  const drift = seedDivergences(moved, seed);
  assert.equal(drift.length, 1);
  assert.match(drift[0], /parked/);
  assert.match(drift[0], /followed-up/);

  const extra = { ...seed, packets: [...seed.packets.slice(1)] };
  assert.equal(
    seedDivergences(extra, seed).some((d) => /only in the committed seed/.test(d)),
    true,
  );

  // The #49 shape: a sync moved the live head forward, the committed seed still names the old one.
  const advanced = {
    ...seed,
    packets: seed.packets.map((p) =>
      p.id === WAVE1_PACKET_ID ? { ...p, prMeta: { ...p.prMeta!, headSha: LIVE_HEAD } } : p,
    ),
  };
  assert.equal(
    seedDivergences(advanced, seed).some((d) => d.includes(LIVE_HEAD.slice(0, 7))),
    true,
  );
});

test("an unrecorded revert is fatal, a recorded one is quiet, and a skipped re-check says so", () => {
  // SPEC.md §7 makes halting on a revert a MUST, and `health()` has always turned `reverts > 0`
  // into an unconditional stop — but nothing could set it, so the clock could print `ledger ok`
  // over a reverted patch forever (issue #39). The bucket is the argument: this is `fatal`, not
  // advisory, because it is the published ledger asserting something GitHub contradicts, and one
  // commit to THIS repository clears it — record the revert.
  const merged = seedState().packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_42")!;
  const live = {
    state: "closed" as const,
    merged: true,
    draft: false,
    headSha: merged.prMeta!.headSha,
    body: VERBATIM_BODY,
  };

  const unrecorded = packetChecks(merged, {
    ...live,
    revert: { reverted: true, sha: "ffff111", at: "2026-08-28T09:00:00Z", why: "ffff111 reverts our merge commit 36d0f2370" },
  });
  assert.equal(unrecorded.fatal.length, 1, unrecorded.fatal.join("\n"));
  assert.match(unrecorded.fatal[0], /reverts our merge commit/);
  assert.match(unrecorded.fatal[0], /SPEC\.md §7 MUST halt ravidsrk\/orca-fleet/);
  assert.deepEqual(unrecorded.advisory, []);

  // Once the ledger records it the line goes quiet — otherwise the clock stays red forever with
  // nothing anyone can merge to fix it, which is the "green by any means" pressure this repo
  // removed from the re-witness debt (issue #49).
  const recorded = packetChecks(
    {
      ...merged,
      followUps: [
        ...(merged.followUps ?? []),
        { id: "fu_rev", at: "2026-08-28T09:00:00Z", kind: "note" as const, body: "revert: (commit) ffff111 — reverted" },
      ],
    },
    { ...live, revert: { reverted: true, sha: "ffff111", at: "2026-08-28T09:00:00Z", why: "x" } },
  );
  assert.deepEqual(recorded.fatal, []);

  // A caller that does not supply the verdict gets a reported line, not a skipped check.
  const skipped = packetChecks(merged, live);
  assert.deepEqual(skipped.fatal, []);
  assert.equal(skipped.advisory.length, 1, skipped.advisory.join("\n"));
  assert.match(skipped.advisory[0], /revert re-check did not run/);

  // A live open PR is not a merge, so nothing here fires on one.
  const open = packetChecks({ ...merged, status: "submitted" as const }, { ...live, merged: false, state: "open" as const });
  assert.equal(open.fatal.some((f) => /reverts our merge commit/.test(f)), false);
  assert.equal(open.advisory.some((a) => /revert re-check/.test(a)), false);
});

test("a revert re-check that stopped short of the end is an advisory, never a clean bill of health", () => {
  // A capped read and a complete one hand back the same `reverted: false`. The clock is already
  // loud about a read that FAILED ("a revert would go unnoticed this run") and was silent about one
  // that merely stopped early — so a truncated read printed `ledger ok`, which is the one thing it
  // must never do. Live proof this is not hypothetical: on ravidsrk/orca-fleet (2026-08-29) the
  // commit list since #70's merge is 111 commits over two pages, and the single-page read that
  // shipped could not see the 31 hours right after the merge.
  const merged = seedState().packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_42")!;
  const live = {
    state: "closed" as const,
    merged: true,
    draft: false,
    headSha: merged.prMeta!.headSha,
    body: VERBATIM_BODY,
    revert: { reverted: false as const, why: "no commit on the base branch reverts 36d0f2370" },
  };

  const complete = packetChecks(merged, { ...live, revertTruncated: false });
  assert.deepEqual(complete.fatal, []);
  assert.deepEqual(complete.advisory, []);

  const capped = packetChecks(merged, { ...live, revertTruncated: true });
  // Advisory, not fatal, and for the same reason a failed read is: nothing in the published ledger
  // is contradicted, and no commit to this repository can lengthen a page GitHub cut short.
  assert.deepEqual(capped.fatal, []);
  assert.equal(capped.advisory.length, 1, capped.advisory.join("\n"));
  assert.match(capped.advisory[0], /page cap/);
  assert.match(capped.advisory[0], /would go unnoticed this run/);
  assert.match(capped.advisory[0], /ravidsrk\/orca-fleet/);

  // A verdict that DID find the revert is not weakened by the cap — the fatal stands alone, and the
  // advisory would be a false sentence ("unnoticed") next to a revert that was very much noticed.
  const found = packetChecks(merged, {
    ...live,
    revertTruncated: true,
    revert: { reverted: true, sha: "ffff111", at: "2026-08-28T09:00:00Z", why: "ffff111 reverts our merge commit 36d0f2370" },
  });
  assert.equal(found.fatal.length, 1, found.fatal.join("\n"));
  assert.deepEqual(found.advisory, []);
});

test("the revert FATAL names the step that can actually green it — the seed edit, not `reconcile`", () => {
  // Both verbs the shipped message offered terminate at `persist()` → `saveFactoryState(STATE_FILE)`
  // → `.foundry-state.json`, which `.gitignore` line 2 excludes. This clock reads `seedState()`. An
  // operator who followed the instruction watched it work locally, pushed nothing, and left `main`
  // red with no explanation of why the thing they were told to do did not help. The step that
  // clears it — promoting the recorded revert into factory/seed.ts — was named nowhere in the diff,
  // though docs/08-operations.md:23 already states the doctrine and :117-119 states the same rule
  // for the sibling case ("only a human editing the seed can green it again").
  const merged = seedState().packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_42")!;
  const unrecorded = packetChecks(merged, {
    state: "closed",
    merged: true,
    draft: false,
    headSha: merged.prMeta!.headSha,
    body: VERBATIM_BODY,
    revert: { reverted: true, sha: "ffff111", at: "2026-08-28T09:00:00Z", why: "ffff111 reverts our merge commit 36d0f2370" },
  });
  assert.equal(unrecorded.fatal.length, 1, unrecorded.fatal.join("\n"));
  const line = unrecorded.fatal[0]!;
  // The step that works, named.
  assert.match(line, /factory\/seed\.ts/);
  // And why the local verbs alone do not: the clock never reads the file they write.
  assert.match(line, /\.foundry-state\.json is gitignored/);
  assert.match(line, /Only the seed edit greens this line/);
  // The local verbs are still offered — they are how the revert gets recorded in the first place.
  assert.match(line, /reconcile/);
  assert.match(line, /revert pkt_ravidsrk_orca-fleet_42 --reason/);
});

test("a missing review observation is not advised while the outcome itself is a FATAL", () => {
  // liveTerminal: while ledger and GitHub disagree about merged-vs-open, the FATAL is the sentence
  // the operator should read. Widening `live.merged || live.state === "closed"` to true would emit
  // the KPI advisory beside that FATAL — noise on a line that already stops the clock (issue #76).
  const merged = seedState().packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_42")!;
  const blind = { ...merged, prMeta: { ...merged.prMeta!, humanReview: undefined } };
  const disagreeing = {
    state: "open" as const,
    merged: false,
    draft: merged.prMeta!.draft,
    headSha: merged.prMeta!.headSha,
    body: VERBATIM_BODY,
  };
  const checks = packetChecks(blind, disagreeing);
  assert.equal(checks.fatal.some((f) => /ledger says merged/.test(f)), true, checks.fatal.join("\n"));
  assert.equal(
    checks.advisory.some((a) => /no human-review observation/.test(a)),
    false,
    `the KPI advisory must not ride along with the outcome FATAL:\n${checks.advisory.join("\n")}`,
  );

  const agreeing = packetChecks(blind, {
    state: "closed",
    merged: true,
    draft: merged.prMeta!.draft,
    headSha: merged.prMeta!.headSha,
    body: VERBATIM_BODY,
    revert: { reverted: false, why: "none" },
  });
  assert.equal(
    agreeing.advisory.some((a) => /no human-review observation/.test(a)),
    true,
    `the same hole must still surface once the outcome agrees:\n${agreeing.advisory.join("\n")}`,
  );
});

test("#109: the committed seed has absorbed #1652's close", () => {
  const packet = wave1Packet();
  assert.equal(INFLIGHT_STATUSES.includes(packet.status), false);
  assert.equal(packet.status, "followed-up");
  assert.equal(packet.prMeta?.state, "closed");
  assert.equal(packet.prMeta?.merged, false);
  const row = seedState().scorecard.find((r) => r.repoId === "ColeMurray/background-agents")!;
  assert.equal(row.closedUnmerged, 1);
  assert.equal(row.noReview, 1);

  const live = {
    state: "closed" as const,
    merged: false,
    draft: false,
    headSha: packet.prMeta!.headSha,
    body: VERBATIM_BODY,
  };
  const { fatal, advisory } = packetChecks(packet, live);
  assert.deepEqual(fatal, [], `absorbed close must not be a FATAL; got ${JSON.stringify(fatal)}`);
  assert.equal(
    advisory.some((a) => /re-witness|live PR body/.test(a)),
    false,
    `absorbed close must retire re-witness and disclosure; got ${JSON.stringify(advisory)}`,
  );
});

test("#110: needsRewitness and disclosureDivergence retire after an absorbed close", () => {
  const closed = wave1Packet();
  assert.equal(closed.prMeta?.state, "closed");
  assert.equal(needsRewitness(closed, LIVE_HEAD_1652), false);
  assert.equal(
    packetChecks(closed, {
      state: "closed",
      merged: false,
      draft: false,
      headSha: LIVE_HEAD_1652,
      body: "no Foundry disclosure at all",
    }).advisory.some((a) => /disclosure|re-witness/.test(a)),
    false,
  );

  const open = submittedPacket();
  assert.equal(needsRewitness(open, LIVE_HEAD_1652), true);
});
