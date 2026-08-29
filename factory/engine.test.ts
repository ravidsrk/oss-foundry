import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CAPS } from "./allowlist.ts";
import {
  applyAdvance,
  applyApprove,
  applyAttachDraft,
  applyAttachEvidence,
  applyHalt,
  applyPrSync,
  applyQueueLive,
  applyReject,
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
  mentionsIssue,
  referencesIssue,
  type EvidenceBinding,
} from "./engine.ts";
import { draftPullPayload } from "./github-pr.ts";
import { packetDivergences } from "./ledger-check.ts";
import { isTestPath, witnessEvidence } from "./witness.ts";
import { DISCLOSURE } from "./neighbor.ts";
import { buildPacket, renderEvidencePage, renderPrBody } from "./packet.ts";
import { evaluatePolicy } from "./policy.ts";
import { runSandboxDry } from "./sandbox.ts";
import { emptyScorecard, health } from "./scorecard.ts";
import { seedState } from "./seed.ts";
import { loadFactoryState } from "./state.ts";
import type { LiveIssue as ScoutIssue } from "./github-scout.ts";
import { inflightCount, type FactoryState } from "./types.ts";

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

function witnessed() {
  return {
    provider: "host" as const,
    testExit: 0,
    revertExit: 1,
    testLogSha: "c".repeat(64),
    revertLogSha: "d".repeat(64),
    ranAt: "2026-08-28T16:00:00.000Z",
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
  assert.match(unrelatedExisting.error, /does not close/);

  const casualMention = applyAttachEvidence(state, id, {
    baseSha: BASE,
    headSha: OTHER,
    testCommand: "true",
    testExit: 0,
    negativeControl: "red-on-revert",
    filesChanged: 1,
    diffLines: 1,
    notes: [],
  }, bindingFor(state.packets[0], { messages: [`see also #${state.packets[0].issueNumber}`] }));
  assert.ok(casualMention.error);
  assert.match(casualMention.error, /does not close/);

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
  assert.match(foreignRepo.error, /does not close/);

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
  assert.equal(evidenceIsReady(state.packets[0].evidence), true);
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
      body: `Fixes #${state.packets[0].issueNumber}`,
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

test("tick skips issues that already have a competing PR", () => {
  const ticked = applyTick(blank(), [], ["ravidsrk/orca-fleet#71"]);
  assert.ok(ticked.packet);
  assert.notEqual(`${ticked.packet.repoId}#${ticked.packet.issueNumber}`, "ravidsrk/orca-fleet#71");

  const queued = applyQueueLive(blank(), live("ravidsrk/orca-fleet", 80), undefined, true);
  assert.equal(queued.packet, null);
  assert.equal(queued.reason, "already-has-pr");
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
  });
  assert.equal(mergedUpstream.some((d) => d.includes(`sync ${submitted.id}`)), true);

  const draftFlip = packetDivergences(submitted, {
    state: "open",
    merged: false,
    draft: !(submitted.prMeta?.draft ?? false),
    headSha: submitted.prMeta?.headSha ?? "",
  });
  assert.equal(draftFlip.some((d) => /draft=/.test(d) && /by hand|doctrine/.test(d)), true);

  const mergedPacket = seed.packets.find((p) => p.status === "merged" && p.prUrl)!;
  const ghost = packetDivergences(mergedPacket, {
    state: "open",
    merged: false,
    draft: true,
    headSha: "0000000000000000000000000000000000000000",
  });
  assert.equal(ghost.some((d) => /ledger says merged/.test(d)), true);

  const clean = packetDivergences(submitted, {
    state: "open",
    merged: false,
    draft: submitted.prMeta?.draft ?? false,
    headSha: submitted.prMeta?.headSha ?? "",
  });
  assert.deepEqual(clean, []);
});

test("an absorbed close is at rest: reconcile-style re-diff reports no divergence", () => {
  const state = seedState();
  const submitted = state.packets.find((p) => p.status === "submitted")!;
  const closedMeta = prMetaAt("2026-09-01T00:00:00.000Z", { state: "closed" });
  const absorbed = applyPrSync(state, submitted.id, closedMeta, {
    threadsAnswered: false,
    at: "2026-09-02T00:00:00.000Z",
  });
  const after = absorbed.state.packets.find((p) => p.id === submitted.id)!;
  const live = { state: "closed" as const, merged: false, draft: closedMeta.draft, headSha: closedMeta.headSha };
  assert.deepEqual(packetDivergences(after, live), []);
  const unabsorbed = packetDivergences(submitted, live);
  assert.equal(unabsorbed.some((d) => d.includes(`sync ${submitted.id}`)), true);
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
  const runner = async (cmd: string, args: string[]) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const hit = Object.entries(script).find(([prefix]) => line.includes(prefix));
    return hit ? hit[1] : { exit: 0, output: "" };
  };
  return { runner, calls };
}

test("host witness: green at head, red on revert, sha-bound logs", async () => {
  const { runner } = fakeRunner({
    "run-tests@head": { exit: 0, output: "42 passing" },
    "run-tests@revert": { exit: 1, output: "3 failing" },
  });
  const outcome = await witnessEvidence(
    {
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
    { repoId: "ravidsrk/orca-fleet", baseSha: BASE, headSha: HEAD, testCommand: "true", sandbox: "host", wave: 0 },
    fakeRunner({ "run-tests@head": { exit: 0, output: "ok" }, "run-tests@revert": { exit: 0, output: "still ok" } }).runner,
    {},
  );
  assert.equal(greenRevert.ok, false);
  if (!greenRevert.ok) assert.match(greenRevert.error, /negative control/i);

  const redHead = await witnessEvidence(
    { repoId: "ravidsrk/orca-fleet", baseSha: BASE, headSha: HEAD, testCommand: "true", sandbox: "host", wave: 0 },
    fakeRunner({ "run-tests@head": { exit: 2, output: "boom" } }).runner,
    {},
  );
  assert.equal(redHead.ok, false);
  if (!redHead.ok) assert.match(redHead.error, /red at head/i);
});

test("witness refuses instead of degrading: e2b without a key, host outside Wave 0", async () => {
  const noKey = await witnessEvidence(
    { repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "e2b", wave: 1 },
    fakeRunner({}).runner,
    {},
  );
  assert.equal(noKey.ok, false);
  if (!noKey.ok) assert.match(noKey.error, /cannot witness evidence in dry-run/i);

  const hostWave1 = await witnessEvidence(
    { repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "host", wave: 1 },
    fakeRunner({}).runner,
    {},
  );
  assert.equal(hostWave1.ok, false);
  if (!hostWave1.ok) assert.match(hostWave1.error, /Wave 0/);
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
  const witnessed = {
    ...unwitnessed,
    witness: {
      provider: "host" as const,
      testExit: 0,
      revertExit: 1,
      testLogSha: "a".repeat(64),
      revertLogSha: "b".repeat(64),
      ranAt: "2026-08-28T16:00:00.000Z",
    },
  };
  state2 = applyAttachEvidence(state2, id, witnessed, bindingFor(state2.packets[0])).state;
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
    { repoId: "ravidsrk/orca-fleet", baseSha: BASE, headSha: HEAD, testCommand: "true", sandbox: "host", wave: 0 },
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
    },
  }, bindingFor(packet)).state;
  const blocked = applyAdvance(state, id);
  assert.match(blocked.error ?? "", /witnessed/);
});

test("daytona witnesses validate and daytona refusals name the right provider", async () => {
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
    },
  };
  const path = join(mkdtempSync(join(tmpdir(), "foundry-")), "daytona.json");
  writeFileSync(path, JSON.stringify({ ...seed, packets: [packet, ...seed.packets.slice(1)] }));
  const loaded = loadFactoryState(path);
  assert.equal(loaded.ok, true);

  const noKey = await witnessEvidence(
    { repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "daytona", wave: 1 },
    (async () => ({ exit: 0, output: "" })) as never,
    {},
  );
  assert.equal(noKey.ok, false);
  if (!noKey.ok) assert.match(noKey.error, /dry-run/i);

  const daytonaNamed = await witnessEvidence(
    { repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "daytona", wave: 1 },
    (async () => ({ exit: 0, output: "" })) as never,
    { E2B_API_KEY: "present" },
  );
  assert.equal(daytonaNamed.ok, false);
  if (!daytonaNamed.ok) assert.match(daytonaNamed.error, /Daytona execution/);

  const e2bNamed = await witnessEvidence(
    { repoId: "mcp-use/mcp-use", baseSha: BASE, headSha: HEAD, testCommand: "pnpm test", sandbox: "e2b", wave: 1 },
    (async () => ({ exit: 0, output: "" })) as never,
    { E2B_API_KEY: "present" },
  );
  assert.equal(e2bNamed.ok, false);
  if (!e2bNamed.ok) assert.match(e2bNamed.error, /E2B execution/);
});
