import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPacket } from "./packet.ts";
import { applyReviewToScorecard, emptyScorecard, health, mergeRate } from "./scorecard.ts";
import { seedState } from "./seed.ts";
import { loadFactoryState, saveFactoryState } from "./state.ts";

test("missing state file loads seed and does not invent a file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "missing.json");
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.source, "seed");
  assert.equal(loaded.state.packets.length, seedState().packets.length);
});

test("malformed state file is refused instead of falling back to seed", () => {
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "bad.json");
  writeFileSync(path, "{not json");
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.match(loaded.error, /will not overwrite with seed/);
  const after = loadFactoryState(path);
  assert.equal(after.ok, false);
});

test("incompatible state object is refused", () => {
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "v5.json");
  writeFileSync(path, JSON.stringify({ version: 5, packets: [] }));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.match(loaded.error, /not a Foundry v6 state file/);
});

test("nested malformed packet is refused", () => {
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "nested.json");
  const seed = seedState();
  writeFileSync(
    path,
    JSON.stringify({
      ...seed,
      packets: [5, { id: "bad" }],
    }),
  );
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.match(loaded.error, /not a Foundry v6 state file/);
});

test("malformed nested packet fields are refused", () => {
  const seed = seedState();
  const base = seed.packets[0];
  const cases: unknown[] = [
    { ...base, acceptance: "not an array" },
    { ...base, nonGoals: [1, 2] },
    { ...base, evidence: { baseSha: 1 } },
    { ...base, humanAttest: {} },
    { ...base, prMeta: { url: "https://example" } },
    { ...base, followUps: [{ id: "x" }] },
    { ...base, sandboxSession: { status: "dry-run" } },
  ];
  for (const packet of cases) {
    const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "fields.json");
    writeFileSync(path, JSON.stringify({ ...seed, packets: [packet] }));
    const loaded = loadFactoryState(path);
    assert.equal(loaded.ok, false, JSON.stringify(packet).slice(0, 80));
  }
});

test("a stored witness may carry a toolchain string, and nothing else in that slot", () => {
  // `toolchain` is advisory, not a gate: a ledger written before #41 has no such field and must
  // load untouched, while a hand-edited one cannot put a non-string where the evidence page
  // interpolates a sentence for the maintainer.
  const seed = seedState();
  const base = seed.packets[0];
  const witness = {
    provider: "host",
    testExit: 0,
    revertExit: 1,
    testLogSha: "c".repeat(64),
    revertLogSha: "d".repeat(64),
    ranAt: "2026-08-29T09:00:00.000Z",
    repoId: base.repoId,
    baseSha: base.evidence!.baseSha,
    headSha: base.evidence!.headSha,
    testLogPath: `docs/evidence/logs/${base.id}/test.log`,
    revertLogPath: `docs/evidence/logs/${base.id}/revert.log`,
  };
  const withWitness = (extra: Record<string, unknown>) => ({
    ...seed,
    packets: [{ ...base, evidence: { ...base.evidence, witness: { ...witness, ...extra } } }],
  });
  const write = (state: unknown): string => {
    const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "toolchain.json");
    writeFileSync(path, JSON.stringify(state));
    return path;
  };

  assert.equal(loadFactoryState(write(withWitness({}))).ok, true, "a witness without one still loads");
  const carried = loadFactoryState(write(withWitness({ toolchain: "python3 3.14.7" })));
  assert.equal(carried.ok, true);
  if (carried.ok) {
    assert.equal(carried.state.packets[0].evidence?.witness?.toolchain, "python3 3.14.7");
  }
  // `""` included: docs/10-schemas.md says `isWitness` and `parseWitnessManifest` both hold this
  // to an optional *non-empty* string, and only the manifest parser did. An empty one renders on
  // the evidence page as a claim about the run with the fact missing — the honest record for a
  // toolchain nobody could resolve is absence, which the line above already accepts.
  for (const junk of [3.14, { python3: "3.14.7" }, ["python3"], null, ""]) {
    assert.equal(
      loadFactoryState(write(withWitness({ toolchain: junk }))).ok,
      false,
      `toolchain: ${JSON.stringify(junk)} must not load`,
    );
  }
});

test("v6 ledger missing later-required fields is migrated, not stranded", () => {
  const seed = seedState();
  const packet = { ...seed.packets[0] } as Record<string, unknown>;
  delete packet.lighting;
  delete packet.acceptance;
  delete packet.nonGoals;
  delete packet.abort;
  delete packet.createdAt;
  const policy = { ...(packet.policy as Record<string, unknown>) };
  delete policy.reasons;
  delete policy.matchedPhrases;
  packet.policy = policy;
  const scout = { ...(packet.scout as Record<string, unknown>) };
  delete scout.parts;
  packet.scout = scout;
  const row = { ...(seed.scorecard[0] as Record<string, unknown>) };
  delete row.closedUnmerged;
  delete row.lastTouch;
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "old-v6.json");
  writeFileSync(
    path,
    JSON.stringify({
      ...seed,
      packets: [packet, ...seed.packets.slice(1)],
      scorecard: [row, ...seed.scorecard.slice(1)],
    }),
  );
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.state.packets[0].lighting, "lit");
  assert.deepEqual(loaded.state.packets[0].acceptance, []);
  assert.equal(loaded.state.packets[0].policy.reasons.length, 0);
  assert.equal(loaded.state.packets[0].scout.parts.wave, 0);
  assert.equal(loaded.state.scorecard[0].closedUnmerged, 0);
  assert.equal(loaded.state.scorecard[0].lastTouch, "—");
});

test("scorecard rows carry a noReview counter from birth", () => {
  for (const row of emptyScorecard()) {
    assert.equal(row.noReview, 0);
  }
});

test("stored scorecard without noReview is migrated to 0, not stranded", () => {
  const seed = seedState();
  const scorecard = seed.scorecard.map((r) => {
    const row = { ...r } as Record<string, unknown>;
    delete row.noReview;
    return row;
  });
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "no-noreview.json");
  writeFileSync(path, JSON.stringify({ ...seed, scorecard }));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  for (const row of loaded.state.scorecard) {
    assert.equal(row.noReview, 0);
  }
});

test("valid state round-trips without becoming seed", () => {
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "ok.json");
  const seed = seedState();
  seed.ticksRun = 99;
  saveFactoryState(path, seed);
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.source, "file");
  assert.equal(loaded.state.ticksRun, 99);
});

test("merge rate counts terminal outcomes; silence alone cannot trip the halt", () => {
  const silent = { ...emptyScorecard()[0], opened: 3 };
  assert.equal(mergeRate(silent), 0);
  assert.notEqual(health(silent), "stop");
  const allClosed = { ...silent, closedUnmerged: 3 };
  assert.equal(health(allClosed), "stop");
  const mixed = { ...silent, merged: 2, closedUnmerged: 1 };
  assert.ok(mergeRate(mixed) > 0.6);
  assert.equal(health(mixed), "good");
});

test("stored packet with dark-eligible lighting is refused", () => {
  const seed = seedState();
  const packet = { ...seed.packets[0], lighting: "dark-eligible" };
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "dark.json");
  writeFileSync(path, JSON.stringify({ ...seed, packets: [packet, ...seed.packets.slice(1)] }));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, false);
});

test("a hand-edited state file with more in-flight packets than the cap is refused, not trusted", () => {
  // issue #34: the loader validated shapes only, so a drifted file with two concurrent in-flight
  // packets loaded happily even though the one-packet-in-flight invariant forbids it.
  const seed = seedState();
  assert.equal(seed.packets.filter((p) => p.status === "submitted").length, 1);
  const secondInflightId = seed.packets.find((p) => p.status === "merged")!.id;
  const packets = seed.packets.map((p) =>
    p.id === secondInflightId ? { ...p, status: "gated" as const, station: "freeze" as const } : p,
  );
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "overcap.json");
  writeFileSync(path, JSON.stringify({ ...seed, packets }));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.match(loaded.error, /in.flight/i);
  assert.match(loaded.error, /will not overwrite with seed/);
});

test("a state file at exactly the in-flight cap still loads", () => {
  const seed = seedState();
  assert.equal(seed.packets.filter((p) => p.status === "submitted").length, 1);
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "atcap.json");
  writeFileSync(path, JSON.stringify(seed));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true);
});

/**
 * `policyDocs` is what the freeze renders to the operator as the maintainer's own words, so it is
 * the one packet field whose whole purpose is to be read by a human making a terminal decision.
 * Both the field types and their coherence are asserted, because `truncated` is not an independent
 * fact — it is a claim about `excerpt` and `chars`, and a stored `truncated: false` over a
 * shortened excerpt tells the approver they are reading the whole document.
 */
test("a stored policy document must be well-formed and internally consistent", () => {
  const seed = seedState();
  const base = seed.packets[0];
  const doc = { name: "CONTRIBUTING", chars: 10, excerpt: "0123456789", truncated: false };
  const write = (policyDocs: unknown): string => {
    const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "policydocs.json");
    writeFileSync(path, JSON.stringify({ ...seed, packets: [{ ...base, policyDocs }] }));
    return path;
  };

  // Loads: a well-formed pair, whole and truncated.
  assert.equal(loadFactoryState(write([doc])).ok, true);
  assert.equal(
    loadFactoryState(write([{ name: "AGENTS.md", chars: 40, excerpt: "0123456789", truncated: true }])).ok,
    true,
  );
  // ...and a packet with no documents at all, which is the common case.
  assert.equal(loadFactoryState(write(undefined)).ok, true);
  // ...and the fetched-but-empty document, which must survive the round trip as a record rather
  // than being refused into the same shape as "never fetched".
  assert.equal(loadFactoryState(write([{ name: "CONTRIBUTING", chars: 0, excerpt: "", truncated: false }])).ok, true);

  for (const [why, bad] of [
    ["not an array", doc],
    ["missing name", [{ chars: 10, excerpt: "0123456789", truncated: false }]],
    ["name not a string", [{ ...doc, name: 3 }]],
    ["chars not an integer", [{ ...doc, chars: 10.5 }]],
    // The row above is refused by the coherence clause, not by `Number.isInteger`: at chars 10.5 a
    // ten-character excerpt IS shortened, so `truncated: false` is incoherent on its own and
    // `Number.isInteger` could be deleted with the suite green. These two agree with the coherence
    // clause and are refused only by the integer check, which is what pins it.
    ["a fractional document size", [{ ...doc, chars: 10.5, truncated: true }]],
    ["an infinite document size", [{ ...doc, chars: Infinity, truncated: true }]],
    ["negative chars", [{ ...doc, chars: -1, excerpt: "" }]],
    ["excerpt not a string", [{ ...doc, excerpt: null }]],
    ["truncated not a boolean", [{ ...doc, truncated: "no" }]],
    ["excerpt longer than the document it came from", [{ ...doc, chars: 4 }]],
    ["a shortened excerpt reported as whole", [{ ...doc, chars: 40 }]],
    ["a whole excerpt reported as truncated", [{ ...doc, truncated: true }]],
  ] as [string, unknown][]) {
    assert.equal(loadFactoryState(write(bad)).ok, false, why);
  }
});

/**
 * The round trip proper: what `buildPacket` writes must be what `loadFactoryState` accepts and
 * hands back. A validator and a producer that disagree fail in only one direction — the operator
 * loses the freeze evidence at the moment a real packet is read back off disk.
 */
test("policy documents survive save and load unchanged", () => {
  const seed = seedState();
  const built = buildPacket({
    repoId: "mcp-use/mcp-use",
    issueNumber: 991,
    issueTitle: "docs typo",
    issueUrl: "https://github.com/mcp-use/mcp-use/issues/991",
    agentsMd: "Agents may open draft PRs.",
    contributing: `${"long contributing prose. ".repeat(400)}`,
  });
  assert.equal(built.policyDocs?.length, 2);
  assert.equal(built.policyDocs?.[1].truncated, true);

  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "roundtrip.json");
  saveFactoryState(path, { ...seed, packets: [built, ...seed.packets.filter((p) => p.status !== "submitted")] });
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true, "a freshly built packet must load back");
  if (!loaded.ok) return;
  assert.deepEqual(loaded.state.packets.find((p) => p.id === built.id)?.policyDocs, built.policyDocs);
});

test("a ledger written before the review counters existed migrates to 0, never to NaN", () => {
  // The two fields `reviewCommentsAvg` is derived from arrived after v6 shipped (issue #39). An
  // older ledger has neither, and `undefined + 1` is NaN — a KPI that is silently not a number is
  // worse than one that is stuck at zero, because nothing downstream refuses it.
  const seed = seedState();
  const scorecard = seed.scorecard.map((r) => {
    const row = { ...r } as Record<string, unknown>;
    delete row.humanReviewComments;
    delete row.humanReviewedPrs;
    return row;
  });
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "pre-39.json");
  writeFileSync(path, JSON.stringify({ ...seed, scorecard }));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error);
  if (!loaded.ok) return;
  for (const row of loaded.state.scorecard) {
    assert.equal(row.humanReviewComments, 0);
    assert.equal(row.humanReviewedPrs, 0);
  }
  const rows = applyReviewToScorecard(loaded.state.scorecard, loaded.state.scorecard[0]!.repoId, {
    reviews: 1,
    comments: 2,
  });
  assert.equal(rows[0]!.reviewCommentsAvg, 2, "a migrated row must still be able to hold a mean");
});

test("a scorecard row whose review counters are the wrong type is refused, not coerced", () => {
  // Every counter this unit added, one at a time. Corrupting only one of them left the other guards
  // deletable — and a string that survives the load is a string that reaches `+= 1` and turns a KPI
  // into "10" on the first fold. `reverts` is here too: it is what SPEC.md §7's halt reads.
  for (const field of ["humanReviewedPrs", "humanReviewComments", "reviewCommentsAvg", "noReview", "reverts"]) {
    const seed = seedState();
    const scorecard = seed.scorecard.map((r, i) => (i === 0 ? ({ ...r, [field]: "2" } as unknown) : r));
    const path = join(mkdtempSync(join(tmpdir(), "foundry-")), `bad-${field}.json`);
    writeFileSync(path, JSON.stringify({ ...seed, scorecard }));
    assert.equal(
      loadFactoryState(path).ok,
      false,
      `a hand-edited ${field} must make the ledger refuse to load`,
    );
  }
  // The control: the same seed, untouched, still loads — so the refusals above are about the edit.
  const clean = join(mkdtempSync(join(tmpdir(), "foundry-")), "clean.json");
  writeFileSync(clean, JSON.stringify(seedState()));
  assert.equal(loadFactoryState(clean).ok, true);
});

test("the review split and merge facts a sync records survive a round trip", () => {
  const seed = seedState();
  const packets = seed.packets.map((p) =>
    p.prMeta
      ? {
          ...p,
          prMeta: {
            ...p.prMeta,
            humanReview: { reviews: 1, comments: 1 },
            mergeCommitSha: "36d0f23708adbdf911e4df050ed516821278a9fc",
            mergedAt: "2026-08-27T07:04:52Z",
            baseRef: "main",
          },
        }
      : p,
  );
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "prmeta.json");
  saveFactoryState(path, { ...seed, packets });
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.error);
  if (!loaded.ok) return;
  const withMeta = loaded.state.packets.find((p) => p.prMeta)!;
  assert.deepEqual(withMeta.prMeta!.humanReview, { reviews: 1, comments: 1 });
  assert.equal(withMeta.prMeta!.mergeCommitSha, "36d0f23708adbdf911e4df050ed516821278a9fc");
  assert.equal(withMeta.prMeta!.baseRef, "main");

  // A malformed split is refused rather than read as zero reviews.
  const broken = loaded.state.packets.map((p) =>
    p.prMeta ? { ...p, prMeta: { ...p.prMeta, humanReview: { reviews: "1", comments: 1 } } } : p,
  );
  const badPath = join(mkdtempSync(join(tmpdir(), "foundry-")), "bad-prmeta.json");
  writeFileSync(badPath, JSON.stringify({ ...loaded.state, packets: broken }));
  assert.equal(loadFactoryState(badPath).ok, false);

  // The other three fields this unit added, each one at a time. Only `humanReview` was pinned, so
  // all three `optional(...)` guards deleted green — and these are not decorative: a hand-edited
  // `mergeCommitSha: 12345` reaches `classifyRevert`, which calls `.toLowerCase()` on it, and a
  // non-string `baseRef` goes into the commit query as the branch the revert is searched on.
  for (const [field, bad] of [
    ["mergeCommitSha", 12345],
    ["mergedAt", 20260827],
    ["baseRef", { name: "main" }],
  ] as const) {
    const corrupt = loaded.state.packets.map((p) =>
      p.prMeta ? { ...p, prMeta: { ...p.prMeta, [field]: bad } } : p,
    );
    const path = join(mkdtempSync(join(tmpdir(), "foundry-")), `bad-${field}.json`);
    writeFileSync(path, JSON.stringify({ ...loaded.state, packets: corrupt }));
    assert.equal(
      loadFactoryState(path).ok,
      false,
      `a hand-edited ${field} of the wrong type must make the ledger refuse to load`,
    );
  }
  // The control: absent is legal for all three — they post-date the seed's older packets.
  const absent = loaded.state.packets.map((p) =>
    p.prMeta
      ? { ...p, prMeta: { ...p.prMeta, mergeCommitSha: undefined, mergedAt: undefined, baseRef: undefined } }
      : p,
  );
  const absentPath = join(mkdtempSync(join(tmpdir(), "foundry-")), "absent-prmeta.json");
  writeFileSync(absentPath, JSON.stringify({ ...loaded.state, packets: absent }));
  assert.equal(loadFactoryState(absentPath).ok, true, "optional must still mean optional");
});
