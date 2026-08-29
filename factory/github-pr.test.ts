import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareCommits,
  createDraftPull,
  fetchIssueClosingRef,
  fetchIssueState,
  fetchRepoFile,
  listCrossReferencingOpenPulls,
  listOpenPulls,
} from "./github-pr.ts";

const BASE = "251fe899c5bd843a7dad71d908c0af3bfcea79e1";
const HEAD = "d91fe2f6725163fab8f9dd42e5c2b0c0c9f0f40d";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("compareCommits accepts only a fast-forward ahead range with a diff", async () => {
  const ahead = await compareCommits("ravidsrk/orca-fleet", BASE, HEAD, async () =>
    jsonResponse(200, {
      status: "ahead",
      ahead_by: 2,
      behind_by: 0,
      files: [{ additions: 8, deletions: 1 }],
      commits: [{ commit: { message: "Fixes #71" } }],
    }),
  );
  assert.equal(ahead.ok, true);
  if (ahead.ok) {
    assert.equal(ahead.aheadBy, 2);
    assert.equal(ahead.filesChanged, 1);
    assert.equal(ahead.diffLines, 9);
    assert.deepEqual(ahead.messages, ["Fixes #71"]);
  }

  const diverged = await compareCommits("ravidsrk/orca-fleet", BASE, HEAD, async () =>
    jsonResponse(200, { status: "diverged", ahead_by: 3, behind_by: 1, files: [{ additions: 1 }] }),
  );
  assert.equal(diverged.ok, false);
  if (!diverged.ok) assert.match(diverged.error, /not an ancestor/);

  const unrelated = await compareCommits("ravidsrk/orca-fleet", BASE, HEAD, async () =>
    jsonResponse(200, { status: "ahead", ahead_by: 0, behind_by: 0 }),
  );
  assert.equal(unrelated.ok, false);

  const emptyDiff = await compareCommits("ravidsrk/orca-fleet", BASE, HEAD, async () =>
    jsonResponse(200, { status: "ahead", ahead_by: 1, behind_by: 0, files: [], commits: [] }),
  );
  assert.equal(emptyDiff.ok, false);
});

test("listOpenPulls returns open PR title and body", async () => {
  const listed = await listOpenPulls("ravidsrk/orca-fleet", async () =>
    jsonResponse(200, [
      { number: 72, title: "fix validator", body: "Fixes #71", html_url: "https://github.com/ravidsrk/orca-fleet/pull/72" },
    ]),
  );
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.equal(listed.pulls[0]?.number, 72);
    assert.equal(listed.pulls[0]?.body, "Fixes #71");
  }

  const failed = await listOpenPulls("ravidsrk/orca-fleet", async () => jsonResponse(403, { message: "nope" }));
  assert.equal(failed.ok, false);
});

test("fetchRepoFile returns raw text or undefined on 404", async () => {
  const ok = await fetchRepoFile("ravidsrk/orca-fleet", "AGENTS.md", async () => new Response("Agents may open draft PRs.", { status: 200 }));
  assert.equal(ok, "Agents may open draft PRs.");
  const missing = await fetchRepoFile("ravidsrk/orca-fleet", "AGENTS.md", async () => jsonResponse(404, {}));
  assert.equal(missing, undefined);
});

test("listOpenPulls carries the head branch name", async () => {
  const listed = await listOpenPulls("ravidsrk/orca-fleet", async () =>
    jsonResponse(200, [
      {
        number: 74,
        title: "wip",
        body: "",
        html_url: "https://github.com/ravidsrk/orca-fleet/pull/74",
        head: { ref: "fix/71-validator" },
      },
    ]),
  );
  assert.equal(listed.ok, true);
  if (listed.ok) assert.equal(listed.pulls[0]?.headRef, "fix/71-validator");
});

test("listCrossReferencingOpenPulls keeps only open cross-referenced pull requests", async () => {
  const result = await listCrossReferencingOpenPulls("ravidsrk/orca-fleet", 71, async () =>
    jsonResponse(200, [
      {
        event: "cross-referenced",
        source: {
          issue: {
            state: "open",
            pull_request: {},
            html_url: "https://github.com/ravidsrk/orca-fleet/pull/9",
          },
        },
      },
      {
        event: "cross-referenced",
        source: {
          issue: {
            state: "closed",
            pull_request: {},
            html_url: "https://github.com/ravidsrk/orca-fleet/pull/5",
          },
        },
      },
      {
        event: "cross-referenced",
        source: { issue: { state: "open", html_url: "https://github.com/ravidsrk/orca-fleet/issues/3" } },
      },
      { event: "labeled" },
    ]),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.urls, ["https://github.com/ravidsrk/orca-fleet/pull/9"]);

  const failed = await listCrossReferencingOpenPulls("ravidsrk/orca-fleet", 71, async () => jsonResponse(500, {}));
  assert.equal(failed.ok, false);
});

test("createDraftPull opens draft-only with the machine-account PAT", async () => {
  let captured: { url?: string; auth?: string | null; body?: Record<string, unknown> } = {};
  const created = await createDraftPull(
    "ColeMurray/background-agents",
    { title: "feat: icon", head: "ravidsrk:foundry/issue-1476", body: "Fixes #1476" },
    async (url, init) => {
      captured = {
        url: String(url),
        auth: new Headers(init?.headers).get("Authorization"),
        body: JSON.parse(String(init?.body)),
      };
      return jsonResponse(201, {
        html_url: "https://github.com/ColeMurray/background-agents/pull/1700",
        number: 1700,
        draft: true,
      });
    },
    { FOUNDRY_PAT: "ghp_machineaccount" },
  );
  assert.equal(created.ok, true);
  if (created.ok) assert.equal(created.url, "https://github.com/ColeMurray/background-agents/pull/1700");
  assert.equal(captured.url, "https://api.github.com/repos/ColeMurray/background-agents/pulls");
  assert.equal(captured.auth, "Bearer ghp_machineaccount");
  assert.equal(captured.body?.draft, true);
  assert.equal(captured.body?.base, "main");
});

test("createDraftPull refuses without the PAT and halts on secondary limits", async () => {
  const missing = await createDraftPull(
    "ColeMurray/background-agents",
    { title: "t", head: "ravidsrk:b", body: "Fixes #1" },
    async () => jsonResponse(201, {}),
    {},
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /FOUNDRY_PAT/);

  const secondary = await createDraftPull(
    "ColeMurray/background-agents",
    { title: "t", head: "ravidsrk:b", body: "Fixes #1" },
    async () => jsonResponse(403, { message: "You have exceeded a secondary rate limit. Please wait." }),
    { FOUNDRY_PAT: "ghp_x" },
  );
  assert.equal(secondary.ok, false);
  if (!secondary.ok) {
    assert.equal(secondary.halt, true);
    assert.match(secondary.error, /halt/i);
  }

  const forbidden = await createDraftPull(
    "ColeMurray/background-agents",
    { title: "t", head: "ravidsrk:b", body: "Fixes #1" },
    async () => jsonResponse(403, { message: "Resource not accessible" }),
    { FOUNDRY_PAT: "ghp_x" },
  );
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) assert.equal(forbidden.halt, undefined);

  const notDraft = await createDraftPull(
    "ColeMurray/background-agents",
    { title: "t", head: "ravidsrk:b", body: "Fixes #1" },
    async () => jsonResponse(201, { html_url: "https://x/pull/1", number: 1, draft: false }),
    { FOUNDRY_PAT: "ghp_x" },
  );
  assert.equal(notDraft.ok, false);
  if (!notDraft.ok) assert.match(notDraft.error, /draft/i);
});

test("createDraftPull rejects unqualified heads and halts on 429 secondary limits", async () => {
  const bareHead = await createDraftPull(
    "ColeMurray/background-agents",
    { title: "t", head: "foundry/issue-1", body: "Fixes #1" },
    async () => jsonResponse(201, {}),
    { FOUNDRY_PAT: "ghp_x" },
  );
  assert.equal(bareHead.ok, false);
  if (!bareHead.ok) assert.match(bareHead.error, /fork-qualified/);

  const secondary429 = await createDraftPull(
    "ColeMurray/background-agents",
    { title: "t", head: "ravidsrk:b", body: "Fixes #1" },
    async () => jsonResponse(429, { message: "You have exceeded a secondary rate limit." }),
    { FOUNDRY_PAT: "ghp_x" },
  );
  assert.equal(secondary429.ok, false);
  if (!secondary429.ok) assert.equal(secondary429.halt, true);
});

test("fetchIssueState reports the issue's own state, reason and closer", async () => {
  // The read nothing in the factory made before issue #40. `listOpenPulls` and the timeline filter
  // both see only OPEN pull requests, so a fix that merged and closed the issue is invisible to
  // them — this endpoint is the only one that answers "is the target still open?".
  let seen = "";
  const closed = await fetchIssueState("ravidsrk/orca-fleet", 71, async (url) => {
    seen = String(url);
    return jsonResponse(200, {
      number: 71,
      html_url: "https://github.com/ravidsrk/orca-fleet/issues/71",
      state: "closed",
      state_reason: "completed",
      closed_at: "2026-08-27T11:30:05Z",
      closed_by: { login: "ravidsrk" },
    });
  });
  assert.equal(seen, "https://api.github.com/repos/ravidsrk/orca-fleet/issues/71");
  assert.equal(closed.ok, true);
  if (closed.ok) {
    assert.equal(closed.issue.state, "closed");
    assert.equal(closed.issue.stateReason, "completed");
    assert.equal(closed.issue.closedBy, "ravidsrk");
    assert.equal(closed.issue.isPullRequest, false);
  }

  const open = await fetchIssueState("ravidsrk/orca-fleet", 80, async () =>
    jsonResponse(200, { number: 80, html_url: "u", state: "open", state_reason: null }),
  );
  assert.equal(open.ok, true);
  if (open.ok) {
    assert.equal(open.issue.state, "open");
    assert.equal(open.issue.stateReason, undefined);
  }

  // The defensive half of the normalisation, which only the literal "open" survives: a 200 whose
  // `state` is missing, null, or a value this code does not know reads as CLOSED. An unrecognised
  // value is not a licence to contact a maintainer — and a 200 never reaches the fail-closed path,
  // so this ternary is the only thing standing between a schema surprise and an unwanted PR.
  for (const body of [
    { number: 81, html_url: "u" },
    { number: 81, html_url: "u", state: null },
    { number: 81, html_url: "u", state: "OPEN" },
    { number: 81, html_url: "u", state: "locked" },
  ]) {
    const odd = await fetchIssueState("ravidsrk/orca-fleet", 81, async () => jsonResponse(200, body));
    assert.equal(odd.ok, true);
    if (odd.ok) {
      assert.equal(
        odd.issue.state,
        "closed",
        `an unrecognised state must not read as open: ${JSON.stringify(body)}`,
      );
    }
  }
});

test("fetchIssueState marks a number that names a pull request, and fails closed on an error", async () => {
  // GitHub serves pull requests from the issues endpoint too, distinguished only by the
  // `pull_request` key. Without it an allowlist row naming a PR number reads as a healthy issue.
  const pr = await fetchIssueState("ravidsrk/orca-fleet", 72, async () =>
    jsonResponse(200, {
      number: 72,
      html_url: "https://github.com/ravidsrk/orca-fleet/pull/72",
      state: "closed",
      pull_request: { url: "https://api.github.com/repos/ravidsrk/orca-fleet/pulls/72" },
    }),
  );
  assert.equal(pr.ok, true);
  if (pr.ok) assert.equal(pr.issue.isPullRequest, true);

  const failed = await fetchIssueState("ravidsrk/orca-fleet", 71, async () => jsonResponse(500, { message: "boom" }));
  assert.equal(failed.ok, false, "a read that did not answer is not an open issue");
  if (!failed.ok) assert.match(failed.error, /GitHub 500 reading ravidsrk\/orca-fleet#71/);

  const threw = await fetchIssueState("ravidsrk/orca-fleet", 71, async () => {
    throw new Error("socket hang up");
  });
  assert.equal(threw.ok, false);
});

test("fetchIssueClosingRef recovers the reference listCrossReferencingOpenPulls throws away", async () => {
  // The closing pull request is CLOSED by definition, and `listCrossReferencingOpenPulls` keeps
  // only open ones — so the timeline call the factory already makes has the answer and drops it.
  // Live shape: ravidsrk/orca-fleet#71's timeline cross-references the closed PR #72.
  const viaPull = await fetchIssueClosingRef("ravidsrk/orca-fleet", 71, async () =>
    jsonResponse(200, [
      {
        event: "cross-referenced",
        source: { issue: { state: "closed", pull_request: {}, html_url: "https://github.com/ravidsrk/orca-fleet/pull/72" } },
      },
      { event: "closed", commit_id: null },
    ]),
  );
  assert.equal(viaPull, "https://github.com/ravidsrk/orca-fleet/pull/72");

  // A commit that closed the issue directly outranks a mere cross-reference.
  const viaCommit = await fetchIssueClosingRef("ravidsrk/orca-fleet", 71, async () =>
    jsonResponse(200, [
      {
        event: "cross-referenced",
        source: { issue: { state: "closed", pull_request: {}, html_url: "https://github.com/ravidsrk/orca-fleet/pull/72" } },
      },
      { event: "closed", commit_id: "d91fe2f6725163fab8f9dd42e5c2b0c0c9f0f40d" },
    ]),
  );
  assert.equal(viaCommit, "commit d91fe2f");

  // Enrichment only, never a gate: a timeline that will not load must degrade the refusal message,
  // not turn a refusal into a crash or a proceed.
  const failed = await fetchIssueClosingRef("ravidsrk/orca-fleet", 71, async () => jsonResponse(500, {}));
  assert.equal(failed, undefined);
  const none = await fetchIssueClosingRef("ravidsrk/orca-fleet", 71, async () => jsonResponse(200, [{ event: "labeled" }]));
  assert.equal(none, undefined);
});
