import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPS } from "./allowlist.ts";
import {
  applyAdvance,
  applyApprove,
  applyAttachDraft,
  applyAttachEvidence,
  applyHalt,
  applyQueueLive,
  applyTick,
  bindingFromCompare,
  classifyCompetition,
  evidenceIsReady,
  findCompetingPull,
  hasInflight,
  isBoundSha,
  isPlaceholderSha,
  mentionsIssue,
  type EvidenceBinding,
} from "./engine.ts";
import { draftPullPayload } from "./github-pr.ts";
import { DISCLOSURE } from "./neighbor.ts";
import { buildPacket, renderPrBody } from "./packet.ts";
import { evaluatePolicy } from "./policy.ts";
import { runSandboxDry } from "./sandbox.ts";
import { emptyScorecard, health } from "./scorecard.ts";
import { seedState } from "./seed.ts";
import type { LiveIssue as ScoutIssue } from "./github-scout.ts";
import type { FactoryState } from "./types.ts";

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
  const quiet = {
    ...seed,
    packets: seed.packets.map((p) =>
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
