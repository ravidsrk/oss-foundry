import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evidenceIsStale,
  needsRewitness,
  packetChecks,
  packetDivergences,
  seedDivergences,
} from "./ledger-check.ts";
import { seedState } from "./seed.ts";
import type { TaskPacket } from "./types.ts";

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

function submittedPacket(): TaskPacket {
  return seedState().packets.find((p) => p.status === "submitted")!;
}

test("#49: promoting the live facts into the seed reconciles the clock without erasing the re-witness debt", () => {
  // The operator marked #1652 ready for review at 18:09:24Z on 2026-08-28 and a seventh commit
  // landed eight seconds later, so the seed's `draft: true` / `headSha: 48c2242` contradicted
  // GitHub and `verify-ledger` was red on `main`. Promoting the live facts clears that
  // contradiction. It must NOT clear the fact that the evidence describes a commit two pushes
  // back — that is the signal #43 anchored to the immutable `evidence.reviewedSha` precisely so
  // this sync could not silently erase it.
  const packet = submittedPacket();
  const live = { state: "open" as const, merged: false, draft: false, headSha: LIVE_HEAD_1652 };

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
    }).length,
    at({ draft: !packet.prMeta!.draft, headSha: STALE_HEAD }).fatal.length +
      at({ draft: !packet.prMeta!.draft, headSha: STALE_HEAD }).advisory.length,
  );
});

test("evidence staleness is bound to the witnessed SHA and survives the sync that moves prMeta", () => {
  const packet = submittedPacket();
  const witnessed = packet.evidence!.reviewedSha!;
  const live = { state: "open" as const, merged: false, draft: true, headSha: LIVE_HEAD };

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
      p.status === "submitted" ? { ...p, status: "followed-up" as const } : p,
    ),
  };
  const drift = seedDivergences(moved, seed);
  assert.equal(drift.length, 1);
  assert.match(drift[0], /submitted/);
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
      p.status === "submitted" ? { ...p, prMeta: { ...p.prMeta!, headSha: LIVE_HEAD } } : p,
    ),
  };
  assert.equal(
    seedDivergences(advanced, seed).some((d) => d.includes(LIVE_HEAD.slice(0, 7))),
    true,
  );
});
