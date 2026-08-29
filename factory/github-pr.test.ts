import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareCommits,
  countHumanReview,
  createDraftPull,
  fetchIssueClosingRef,
  fetchIssueState,
  fetchRepoFile,
  fetchHumanReview,
  isBotAccount,
  listCommitsSince,
  listCrossReferencingOpenPulls,
  listOpenPulls,
  MAX_COMMIT_PAGES,
  nextPageUrl,
  revertCheck,
  syncGithubPr,
  MAX_LIST_PAGES,
} from "./github-pr.ts";
import { REVERT_WINDOW_DAYS } from "./scorecard.ts";

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

/**
 * docs/08-operations.md defines both review KPIs over **human, non-bot** accounts, so the bot
 * filter is not a detail of the fetch — it IS the definition. `pr.review_comments` (the scalar the
 * PR object carries, and the one issue #39's own proposal reached for) cannot answer it: it is a
 * total with no author in it. ravidsrk/orca-fleet#70 is the live proof — 2 review comments, one
 * from `greptile-apps[bot]` and one from a person.
 */
test("the bot filter reads GitHub's own account type, then the [bot] suffix, then the roster", () => {
  assert.equal(isBotAccount({ login: "ravidsrk", type: "User" }), false);
  assert.equal(isBotAccount({ login: "greptile-apps[bot]", type: "Bot" }), true);
  // The reviews endpoint is the one that carries `type`; other surfaces omit it, so the suffix has
  // to stand on its own.
  assert.equal(isBotAccount({ login: "coderabbitai[bot]" }), true);
  assert.equal(isBotAccount({ login: "CodeRabbitAI[Bot]" }), true);
  // A GitHub App installed as an ordinary account carries neither signal; the roster is the floor.
  assert.equal(isBotAccount({ login: "greptile-apps" }), true);
  assert.equal(isBotAccount({ login: "coderabbitai" }), true);
  // A person whose name merely contains the word is not a bot.
  assert.equal(isBotAccount({ login: "robotnik", type: "User" }), false);
  assert.equal(isBotAccount(null), false);
});

test("countHumanReview drops the bots from both review surfaces and keeps them apart", () => {
  // The live shape of ravidsrk/orca-fleet#70 on 2026-08-29.
  const counted = countHumanReview({
    reviews: [
      { user: { login: "greptile-apps[bot]", type: "Bot" } },
      { user: { login: "ravidsrk", type: "User" } },
    ],
    comments: [
      { user: { login: "greptile-apps[bot]", type: "Bot" } },
      { user: { login: "ravidsrk", type: "User" } },
    ],
  });
  assert.deepEqual(counted, { reviews: 1, comments: 1 });

  // A bare approval: review activity, no review comment. The two counts must not be collapsed —
  // `noReview` is about activity, `reviewCommentsAvg` is about comments (docs/08-operations.md).
  const approval = countHumanReview({
    reviews: [{ user: { login: "ravidsrk", type: "User" } }],
    comments: [],
  });
  assert.deepEqual(approval, { reviews: 1, comments: 0 });

  const botsOnly = countHumanReview({
    reviews: [{ user: { login: "greptile-apps[bot]", type: "Bot" } }],
    comments: [{ user: { login: "greptile-apps[bot]", type: "Bot" } }],
  });
  assert.deepEqual(botsOnly, { reviews: 0, comments: 0 });
});

test("syncGithubPr reads the human review split for a terminal PR, and says nothing when it cannot", async () => {
  const prBody = (over: Record<string, unknown>) => ({
    html_url: "https://github.com/ravidsrk/orca-fleet/pull/70",
    title: "t",
    body: "b",
    draft: false,
    state: "closed",
    merged: true,
    merged_at: "2026-08-27T07:04:52Z",
    merge_commit_sha: "36d0f23708adbdf911e4df050ed516821278a9fc",
    base: { ref: "main" },
    mergeable_state: "clean",
    commits: 1,
    review_comments: 2,
    comments: 0,
    head: { sha: "abc1234" },
    updated_at: "2026-08-27T07:04:52Z",
    ...over,
  });

  const terminal = await syncGithubPr({ url: "https://github.com/ravidsrk/orca-fleet/pull/70" }, async (url) => {
    const u = String(url);
    if (u.endsWith("/reviews?per_page=100")) {
      return jsonResponse(200, [
        { user: { login: "greptile-apps[bot]", type: "Bot" } },
        { user: { login: "ravidsrk", type: "User" } },
      ]);
    }
    if (u.endsWith("/comments?per_page=100")) {
      return jsonResponse(200, [
        { user: { login: "greptile-apps[bot]", type: "Bot" } },
        { user: { login: "ravidsrk", type: "User" } },
      ]);
    }
    return jsonResponse(200, prBody({}));
  });
  assert.equal(terminal.ok, true);
  if (terminal.ok) {
    assert.deepEqual(terminal.meta.humanReview, { reviews: 1, comments: 1 });
    assert.equal(terminal.meta.mergeCommitSha, "36d0f23708adbdf911e4df050ed516821278a9fc");
    assert.equal(terminal.meta.mergedAt, "2026-08-27T07:04:52Z");
    assert.equal(terminal.meta.baseRef, "main");
    // The scalar GitHub hands over still counts the bot. Keeping it un-doctored is the point:
    // the honest number is the derived one beside it, not a quietly rewritten total.
    assert.equal(terminal.meta.reviewComments, 2);
  }

  // An open PR has no terminal transition to feed, so the two extra requests are not spent.
  const paths: string[] = [];
  const open = await syncGithubPr({ url: "https://github.com/ravidsrk/orca-fleet/pull/70" }, async (url) => {
    paths.push(new URL(String(url)).pathname);
    return jsonResponse(200, prBody({ state: "open", merged: false, merged_at: null, merge_commit_sha: null }));
  });
  assert.equal(open.ok, true);
  if (open.ok) assert.equal(open.meta.humanReview, undefined);
  assert.deepEqual(paths, ["/repos/ravidsrk/orca-fleet/pulls/70"]);

  // Closed WITHOUT a merge is the other terminal outcome, and docs/08-operations.md defines both
  // KPIs over both buckets — `closedUnmerged` is half of the merge-rate denominator. Every other
  // fixture in this file is `state: "closed", merged: true`, so `|| pr.state === "closed"` could be
  // deleted and the whole suite stayed green while a rejected PR that a human had actually reviewed
  // reported `humanReview: null` and folded into the ledger as {noReview: 0, avg: 0, hrp: 0}.
  const rejected = await syncGithubPr({ url: "https://github.com/ravidsrk/orca-fleet/pull/70" }, async (url) => {
    const u = String(url);
    if (u.endsWith("/reviews?per_page=100")) {
      return jsonResponse(200, [
        { user: { login: "greptile-apps[bot]", type: "Bot" } },
        { user: { login: "ravidsrk", type: "User" } },
      ]);
    }
    if (u.endsWith("/comments?per_page=100")) {
      return jsonResponse(200, [{ user: { login: "ravidsrk", type: "User" } }]);
    }
    return jsonResponse(200, prBody({ merged: false, merged_at: null, merge_commit_sha: null }));
  });
  assert.equal(rejected.ok, true);
  if (rejected.ok) {
    assert.equal(rejected.meta.merged, false);
    assert.equal(rejected.meta.state, "closed");
    assert.deepEqual(rejected.meta.humanReview, { reviews: 1, comments: 1 });
  }

  // Terminal, but GitHub will not answer the review endpoints. `undefined` means NOT OBSERVED —
  // never "zero human reviews". A 0 here would be an invented metric, which is the whole defect
  // issue #39 is about.
  const unreadable = await syncGithubPr({ url: "https://github.com/ravidsrk/orca-fleet/pull/70" }, async (url) => {
    if (String(url).includes("/reviews")) return jsonResponse(500, { message: "boom" });
    if (String(url).includes("/comments")) return jsonResponse(200, []);
    return jsonResponse(200, prBody({}));
  });
  assert.equal(unreadable.ok, true);
  if (unreadable.ok) assert.equal(unreadable.meta.humanReview, undefined);

  // A CAPPED read is not observed either: the flag was computed and dropped here, so ten pages of a
  // busy PR's reviews would have been published as a complete count — a wrong KPI, worse than none.
  const capped = await syncGithubPr({ url: "https://github.com/ravidsrk/orca-fleet/pull/70" }, async (url) => {
    const u = String(url);
    if (u.includes("/reviews") || u.includes("/comments")) {
      return new Response(JSON.stringify([{ user: { login: "a", type: "User" } }]), {
        status: 200,
        headers: { "Content-Type": "application/json", link: `<${u}>; rel="next"` },
      });
    }
    return jsonResponse(200, prBody({}));
  });
  assert.equal(capped.ok, true, "a capped read is still a successful sync");
  if (capped.ok) {
    assert.equal(
      capped.meta.humanReview,
      undefined,
      "a capped review read was recorded as a complete count",
    );
    // ...and distinguishable from an endpoint FAILURE: retrying helps one and not the other.
    assert.equal(capped.reviewTruncated, true, "a capped review read is indistinguishable from an outage");
  }
  if (unreadable.ok) {
    assert.equal(unreadable.reviewTruncated, false, "an outage must not report itself as a capped read");
  }
});

test("listCommitsSince returns the base-branch commits after a moment, with their messages", async () => {
  let seen = "";
  const ok = await listCommitsSince(
    "ravidsrk/orca-fleet",
    { since: "2026-08-27T07:04:52Z", sha: "main" },
    async (url) => {
      seen = String(url);
      return jsonResponse(200, [
        {
          sha: "ffff111",
          commit: { message: 'Revert "fix validator"\n\nThis reverts commit 36d0f237.', committer: { date: "2026-08-28T09:00:00Z" } },
        },
      ]);
    },
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.commits.length, 1);
    assert.equal(ok.commits[0]?.sha, "ffff111");
    assert.match(ok.commits[0]!.message, /This reverts commit 36d0f237/);
    assert.equal(ok.commits[0]?.committedAt, "2026-08-28T09:00:00Z");
  }
  assert.match(seen, /\/repos\/ravidsrk\/orca-fleet\/commits\?/);
  assert.match(seen, /since=2026-08-27T07%3A04%3A52Z/);
  assert.match(seen, /sha=main/);

  const failed = await listCommitsSince("ravidsrk/orca-fleet", { since: "2026-08-27T07:04:52Z" }, async () =>
    jsonResponse(403, { message: "nope" }),
  );
  assert.equal(failed.ok, false);
});

/** A page of commits with GitHub's own cursor attached, exactly as the live API serves one. */
function pagedResponse(body: unknown, next?: string): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (next) headers.Link = `<${next}>; rel="next", <${next}>; rel="last"`;
  return new Response(JSON.stringify(body), { status: 200, headers });
}

/**
 * The `Link` header GitHub actually serves for a MIDDLE page — `prev` first, then `next`, `last`,
 * `first`, all four with different URLs.
 *
 * `pagedResponse` above cannot express this, and that is the whole point: it emits `next` first and
 * points every rel at the same URL, so a parser that ignored the rel name entirely would still
 * return the right cursor from it. Page 2 in that fixture carries no `Link` at all, so no assertion
 * anywhere reached a header with a competing rel. Against this one, a relaxed match returns `prev`
 * and the read ping-pongs between pages 1 and 2 to the cap: a false `truncated: true`, and pages 3
 * onward never read — the far end of the revert window, silently unexamined.
 */
function middlePageResponse(body: unknown, rels: { prev: string; next: string; last: string; first: string }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      Link: `<${rels.prev}>; rel="prev", <${rels.next}>; rel="next", <${rels.last}>; rel="last", <${rels.first}>; rel="first"`,
    },
  });
}

test("the next cursor is the one rel named next, on the header GitHub serves for a middle page", async () => {
  const base = "https://api.github.com/repositories/1298943477/commits?per_page=100";
  const rels = { prev: `${base}&page=1`, next: `${base}&page=3`, last: `${base}&page=9`, first: `${base}&page=1` };

  // The unit, first: four rels, `prev` ahead of `next`, and only one right answer.
  assert.equal(nextPageUrl(middlePageResponse([], rels).headers.get("link")), rels.next);
  // Order must not matter either. Same four rels, `next` last.
  assert.equal(
    nextPageUrl(`<${rels.first}>; rel="first", <${rels.prev}>; rel="prev", <${rels.last}>; rel="last", <${rels.next}>; rel="next"`),
    rels.next,
  );
  // The last page names prev/first/last and no next. That is the read's only stop signal.
  assert.equal(
    nextPageUrl(`<${rels.prev}>; rel="prev", <${rels.first}>; rel="first", <${rels.last}>; rel="last"`),
    undefined,
  );

  // And end to end, because a parser bug shows up as a page the read never asked for. Three pages,
  // each a real middle page except the last; a relaxed match would follow `prev` back to page 1 and
  // spin there until the cap, reporting `truncated: true` over commits it never saw.
  const seen: string[] = [];
  const page = (n: number) => `${base}&page=${n}`;
  const walked = await listCommitsSince("ravidsrk/orca-fleet", { since: "2026-08-27T07:04:52Z" }, async (url) => {
    const u = String(url);
    seen.push(u);
    const n = Number(new URL(u).searchParams.get("page") ?? "1");
    const body = [{ sha: `p${n}`, commit: { message: `page ${n}`, committer: { date: "2026-08-28T09:00:00Z" } } }];
    if (n >= 3) {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json", Link: `<${page(2)}>; rel="prev", <${page(1)}>; rel="first"` },
      });
    }
    return middlePageResponse(body, { prev: page(Math.max(1, n - 1)), next: page(n + 1), last: page(3), first: page(1) });
  });
  assert.equal(walked.ok, true);
  if (walked.ok) {
    assert.deepEqual(walked.commits.map((c) => c.sha), ["p1", "p2", "p3"], "the read must go forwards");
    assert.equal(walked.truncated, false, "a read that reached the last page is not a short one");
  }
  assert.equal(seen.length, 3, `following the prev cursor would spin to the page cap instead:\n${seen.join("\n")}`);
  assert.equal(seen[1], page(2));
  assert.equal(seen[2], page(3));
});

test("listCommitsSince follows GitHub's next link, and says so when it stops short", async () => {
  // GitHub serves commits newest-first, so page 1 is the FAR end of the `since` window and a
  // one-page read hides the hours right after the merge — the hours a revert is most likely to
  // land in. Live on ravidsrk/orca-fleet (read-only GET, 2026-08-29): `since` #70's merge
  // (2026-08-27T07:04:52Z) returns 100 commits on page 1 and 11 on page 2, and page 1's oldest
  // commit is 2026-08-28T14:08:01Z. A ~31-hour hole opening at the merge, widening daily.
  const seen: string[] = [];
  const page2 = "https://api.github.com/repositories/1298943477/commits?since=2026-08-27T07%3A04%3A52Z&per_page=100&sha=main&page=2";
  const both = await listCommitsSince(
    "ravidsrk/orca-fleet",
    { since: "2026-08-27T07:04:52Z", sha: "main" },
    async (url) => {
      seen.push(String(url));
      if (String(url) === page2) {
        return pagedResponse([
          { sha: "old222", commit: { message: "only page 2 can see this", committer: { date: "2026-08-27T08:00:00Z" } } },
        ]);
      }
      return pagedResponse(
        [{ sha: "new111", commit: { message: "recent", committer: { date: "2026-08-28T14:08:01Z" } } }],
        page2,
      );
    },
  );
  assert.equal(both.ok, true);
  if (both.ok) {
    assert.deepEqual(both.commits.map((c) => c.sha), ["new111", "old222"]);
    // Read to the end of the cursor, so nothing was left behind and the flag says exactly that.
    assert.equal(both.truncated, false);
  }
  assert.equal(seen.length, 2);
  // The cursor GitHub handed back, followed verbatim — not a page number this code guessed.
  assert.equal(seen[1], page2);

  // A `next` that never runs out. The read stops at the page cap and REPORTS it. A capped read
  // must never be byte-identical to a clean one: that indistinguishability is the whole defect,
  // because the loud path already exists for a FAILED read and said nothing about a short one.
  let calls = 0;
  const capped = await listCommitsSince("ravidsrk/orca-fleet", { since: "2026-08-27T07:04:52Z" }, async () => {
    calls += 1;
    return pagedResponse(
      [{ sha: `c${calls}`, commit: { message: "m", committer: { date: "2026-08-28T09:00:00Z" } } }],
      "https://api.github.com/endless",
    );
  });
  assert.equal(capped.ok, true);
  if (capped.ok) {
    assert.equal(capped.truncated, true);
    assert.equal(capped.commits.length, MAX_COMMIT_PAGES);
  }
  assert.equal(calls, MAX_COMMIT_PAGES);
  // The VALUE, not just the constant. Both assertions above read `MAX_COMMIT_PAGES`, so `10 → 2`
  // and `10 → 100` both keep them true while changing what the cap actually is — a cap of 2 makes
  // almost every revert window a short read, and a cap of 100 is 10,000 commits per merged packet
  // per tick against the AUP's bulk-activity line. One literal is what pins the number itself.
  assert.equal(MAX_COMMIT_PAGES, 10, "1000 commits per revert re-check; changing it is a doctrine change");

  // A failure on a later page is a failure, not a short read dressed as a clean one.
  const brokeLate = await listCommitsSince("ravidsrk/orca-fleet", { since: "2026-08-27T07:04:52Z" }, async (url) =>
    String(url).includes("page=2") ? jsonResponse(502, { message: "bad gateway" }) : pagedResponse([], "https://api.github.com/x?page=2"),
  );
  assert.equal(brokeLate.ok, false);
  if (!brokeLate.ok) assert.match(brokeLate.error, /502/);
});

test("the revert read is bounded at both ends, so it cannot outgrow its own page cap", async () => {
  // `since: mergedAt` with no `until` reads [merge, now] — a window that grows a day every day and
  // never closes — while `classifyRevert` throws away everything past `mergedAt + 30 days`. So the
  // extra pages are fetched, paged, and discarded. Measured on ravidsrk/orca-fleet (read-only GET,
  // 2026-08-29): main runs ~17 commits/day (118 in the last 7 days), so the 30-day window holds
  // ~505 — under the 1000-commit cap. The UNBOUNDED window is under it only for now: at that rate
  // it crosses the cap around day 60, and from then on every long-lived merged packet emits a
  // truncation advisory on every tick, permanently, about a window that closed a month earlier and
  // that no commit anywhere can clear. That is how an advisory channel is trained into background
  // noise — the failure ledger-check.ts cites twice as its reason for edge-triggering other checks.
  const MERGE = "36d0f23708adbdf911e4df050ed516821278a9fc";
  const MERGED_AT = "2026-08-27T07:04:52Z";
  // A NON-default base on purpose. Every seed packet merges to `main`, so an assertion written
  // against `main` cannot tell "the branch we asked for" from "the branch GitHub defaults to" —
  // and dropping `sha: meta.baseRef` would search a release branch's revert on the default branch
  // and return a silent clean bill of health on a SPEC.md §7 MUST.
  let seen = "";
  await revertCheck(
    "ravidsrk/orca-fleet",
    { mergeCommitSha: MERGE, mergedAt: MERGED_AT, baseRef: "release/2.0" },
    async (url) => {
      seen = String(url);
      return pagedResponse([]);
    },
  );
  const query = new URL(seen).searchParams;
  assert.equal(query.get("since"), MERGED_AT, "the near end is the merge");
  // 100 is the page size the 10-page cap is a bound over. At `per_page=1` the cap is 10 commits
  // and every window is a short read; the two numbers only mean "1000 commits" together.
  assert.equal(query.get("per_page"), "100");
  // The far end is the classifier's own deadline, not "now" — the same constant `classifyRevert`
  // measures against, so the read and the classification can never disagree about the window.
  const expected = new Date(Date.parse(MERGED_AT) + REVERT_WINDOW_DAYS * 86_400_000).toISOString();
  assert.equal(query.get("until"), expected, `the far end must be mergedAt + ${REVERT_WINDOW_DAYS}d`);
  assert.equal(expected, "2026-09-26T07:04:52.000Z", "and that is a fixed instant, not a moving one");
  assert.equal(query.get("sha"), "release/2.0", "the revert must be searched on the PR's own base");

  // A packet merged long ago reads exactly the same window it always did — the property the bound
  // buys. Without `until` this read would span years and truncate forever.
  let old = "";
  await revertCheck(
    "ravidsrk/orca-fleet",
    { mergeCommitSha: MERGE, mergedAt: "2020-01-01T00:00:00Z", baseRef: "main" },
    async (url) => {
      old = String(url);
      return pagedResponse([]);
    },
  );
  const oldQuery = new URL(old).searchParams;
  assert.equal(oldQuery.get("until"), "2020-01-31T00:00:00.000Z");
  assert.equal(
    Date.parse(oldQuery.get("until")!) - Date.parse(oldQuery.get("since")!),
    REVERT_WINDOW_DAYS * 86_400_000,
    "the window is a fixed width from the day it opens, whatever today is",
  );
});

test("revertCheck sees a revert GitHub served on the second page, and never fetches with nothing to check", async () => {
  const MERGE = "36d0f23708adbdf911e4df050ed516821278a9fc";
  const page2 = "https://api.github.com/repositories/1298943477/commits?page=2";
  const found = await revertCheck(
    "ravidsrk/orca-fleet",
    { mergeCommitSha: MERGE, mergedAt: "2026-08-27T07:04:52Z", baseRef: "main" },
    async (url) => {
      if (String(url) === page2) {
        return pagedResponse([
          {
            sha: "ffff111",
            // The window right after the merge — the one the single-page read could not reach.
            commit: { message: `Revert "fix"\n\nThis reverts commit ${MERGE}.`, committer: { date: "2026-08-27T09:00:00Z" } },
          },
        ]);
      }
      return pagedResponse(
        [{ sha: "aaaa222", commit: { message: "unrelated later work", committer: { date: "2026-08-28T14:08:01Z" } } }],
        page2,
      );
    },
  );
  assert.equal(found.ok, true);
  if (found.ok) {
    assert.equal(found.verdict.reverted, true);
    assert.equal(found.truncated, false);
  }

  // A capped read that found nothing is NOT a clean read, and `revertCheck` carries the difference
  // out to its callers rather than flattening it into the same `reverted: false` a full read gives.
  const short = await revertCheck(
    "ravidsrk/orca-fleet",
    { mergeCommitSha: MERGE, mergedAt: "2026-08-27T07:04:52Z" },
    async () => pagedResponse([], "https://api.github.com/endless"),
  );
  assert.equal(short.ok, true);
  if (short.ok) {
    assert.equal(short.verdict.reverted, false);
    assert.equal(short.truncated, true);
  }

  // No merge commit recorded: the answer is "nothing to revert", and it costs no request at all.
  const nothing = await revertCheck("ravidsrk/orca-fleet", {}, async () => {
    throw new Error("revertCheck must not fetch when the packet records no merge commit");
  });
  assert.equal(nothing.ok, true);
  if (nothing.ok) {
    assert.equal(nothing.verdict.reverted, false);
    assert.match(nothing.verdict.why, /nothing to revert/);
    assert.equal(nothing.truncated, false);
  }
});

test("GitHub's own account type is enough on its own to make an account a bot", () => {
  // The highest-authority of the three signals, and the only one that came from the platform rather
  // than from a naming convention or a list this repo maintains. Every bot fixture elsewhere in the
  // suite also carries `[bot]` or sits in the roster, so `if (user.type === "Bot") return true;`
  // could be deleted and nothing noticed — a GitHub App renamed off the suffix would then have its
  // reviews counted as a human's, in a published KPI, silently.
  assert.equal(isBotAccount({ login: "reviewbuddy", type: "Bot" }), true);
  assert.equal(isBotAccount({ login: "reviewbuddy", type: "User" }), false);
  assert.equal(isBotAccount({ login: "reviewbuddy" }), false);
  // And it is the account type that decides, not the review's own shape.
  assert.deepEqual(
    countHumanReview({
      reviews: [{ user: { login: "reviewbuddy", type: "Bot" } }, { user: { login: "ravidsrk", type: "User" } }],
      comments: [{ user: { login: "reviewbuddy", type: "Bot" } }],
    }),
    { reviews: 1, comments: 0 },
  );
});

test("fetchHumanReview fails closed on a thrown fetch, a bad status, and a non-list body", async () => {
  // The outcome contract — "a failure is reported, never smoothed to zero" — was pinned; the three
  // guards that deliver it were not. All of them land in the same `catch`, so they could be deleted
  // together and the resulting TypeError would be caught and returned as `{ok:false}` by accident.
  // These pin each one at its own message, so the accident is no longer indistinguishable.
  const threw = await fetchHumanReview("ravidsrk/orca-fleet", 70, async () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(threw.ok, false);
  if (!threw.ok) assert.match(threw.error, /fetch failed/);

  const badReviews = await fetchHumanReview("ravidsrk/orca-fleet", 70, async (url) =>
    String(url).includes("/reviews") ? jsonResponse(503, {}) : jsonResponse(200, []),
  );
  assert.equal(badReviews.ok, false);
  if (!badReviews.ok) assert.match(badReviews.error, /503 on reviews/);

  const badComments = await fetchHumanReview("ravidsrk/orca-fleet", 70, async (url) =>
    String(url).includes("/comments") ? jsonResponse(503, {}) : jsonResponse(200, []),
  );
  assert.equal(badComments.ok, false);
  if (!badComments.ok) assert.match(badComments.error, /503 on review comments/);

  // A 200 whose body is not a list. Without the guard `.filter` throws and the failure arrives as
  // "fetch failed", which is a different and untrue account of what happened.
  //
  // Now asserted PER ENDPOINT rather than against one combined "the review endpoints" message.
  // Paginating both reads through one helper (issue #69) made the message name which endpoint
  // returned the non-list, so this tightened rather than moved: the old assertion passed whichever
  // of the two had failed, and these two cannot.
  const notListComments = await fetchHumanReview("ravidsrk/orca-fleet", 70, async (url) =>
    String(url).includes("/comments") ? jsonResponse(200, { message: "Not Found" }) : jsonResponse(200, []),
  );
  assert.equal(notListComments.ok, false);
  if (!notListComments.ok) assert.match(notListComments.error, /non-list on review comments/);

  const notListReviews = await fetchHumanReview("ravidsrk/orca-fleet", 70, async (url) =>
    String(url).includes("/reviews") ? jsonResponse(200, { message: "Not Found" }) : jsonResponse(200, []),
  );
  assert.equal(notListReviews.ok, false);
  if (!notListReviews.ok) assert.match(notListReviews.error, /non-list on reviews/);

  const badRepo = await fetchHumanReview("orca-fleet", 70, async () => jsonResponse(200, []));
  assert.equal(badRepo.ok, false);
  if (!badRepo.ok) assert.match(badRepo.error, /bad repo id/);
});

test("listCommitsSince refuses a 200 whose body is not a list of commits", async () => {
  const notList = await listCommitsSince("ravidsrk/orca-fleet", { since: "2026-08-27T07:04:52Z" }, async () =>
    jsonResponse(200, { message: "Git Repository is empty." }),
  );
  assert.equal(notList.ok, false);
  if (!notList.ok) assert.match(notList.error, /non-list for commits/);

  const threw = await listCommitsSince("ravidsrk/orca-fleet", { since: "2026-08-27T07:04:52Z" }, async () => {
    throw new TypeError("network down");
  });
  assert.equal(threw.ok, false);
  if (!threw.ok) assert.match(threw.error, /network down/);
});

/**
 * Issue #69: five list reads shared `listCommitsSince`'s pre-#39 shape, so a truncated success was
 * byte-identical to a complete one. Each is driven across a page boundary, because "it paginates" is
 * a claim about the SECOND page and a one-page fixture cannot see it.
 */
function paged(pages: unknown[][]): typeof fetch {
  // Per ENDPOINT, not one shared counter: `fetchHumanReview` reads both in parallel, and one counter
  // gave each a single page — which looked like "pagination works" while proving the opposite.
  const served = new Map<string, number>();
  return (async (url: string | URL | Request) => {
    const key = String(url).split("?")[0];
    const n = served.get(key) ?? 0;
    served.set(key, n + 1);
    const body = pages[n] ?? [];
    const isLast = n >= pages.length - 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: isLast
        ? { "Content-Type": "application/json" }
        : { "Content-Type": "application/json", link: `<${String(url)}&page=${n + 2}>; rel="next"` },
    });
  }) as typeof fetch;
}

test("every paginated list read follows the cursor to the second page", async () => {
  const pulls = await listOpenPulls(
    "ravidsrk/orca-fleet",
    paged([
      [{ number: 1, html_url: "https://github.com/ravidsrk/orca-fleet/pull/1", head: { ref: "a" } }],
      [{ number: 2, html_url: "https://github.com/ravidsrk/orca-fleet/pull/2", head: { ref: "b" } }],
    ]),
  );
  assert.equal(pulls.ok, true);
  if (pulls.ok) {
    assert.deepEqual(pulls.pulls.map((p) => p.number), [1, 2], "the second page of open pulls was not read");
    assert.equal(pulls.truncated, false);
  }

  const crossRefs = await listCrossReferencingOpenPulls(
    "ravidsrk/orca-fleet",
    71,
    paged([
      [{ event: "labeled" }],
      [
        {
          event: "cross-referenced",
          source: { issue: { state: "open", html_url: "https://github.com/x/y/pull/9", pull_request: {} } },
        },
      ],
    ]),
  );
  assert.equal(crossRefs.ok, true);
  // The only cross-reference lives on page 2: a one-page read reports "no competing work" here.
  if (crossRefs.ok) assert.deepEqual(crossRefs.urls, ["https://github.com/x/y/pull/9"]);

  const review = await fetchHumanReview(
    "ravidsrk/orca-fleet",
    70,
    paged([[{ user: { login: "a", type: "User" } }], [{ user: { login: "b", type: "User" } }]]),
  );
  assert.equal(review.ok, true);
  // Two pages per endpoint, both endpoints sharing the stub: 2 reviews and 2 comments.
  if (review.ok) assert.deepEqual(review.humanReview, { reviews: 2, comments: 2 });

  const closing = await fetchIssueClosingRef(
    "ravidsrk/orca-fleet",
    71,
    paged([[{ event: "labeled" }], [{ event: "closed", commit_id: "abcdef1234567890" }]]),
  );
  assert.equal(closing, "commit abcdef1", "the closing commit on page 2 was not seen");
});

test("a capped read is distinguishable from a complete one", async () => {
  // Never stops offering a next page: the cap ends it, and `truncated` is the only thing saying so.
  const endless: typeof fetch = (async (url: string | URL | Request) =>
    new Response(JSON.stringify([{ number: 1, html_url: "https://github.com/x/y/pull/1", head: { ref: "a" } }]), {
      status: 200,
      headers: { "Content-Type": "application/json", link: `<${String(url)}>; rel="next"` },
    })) as typeof fetch;

  const capped = await listOpenPulls("ravidsrk/orca-fleet", endless);
  assert.equal(capped.ok, true, "a capped read is still a successful read");
  if (capped.ok) {
    assert.equal(capped.truncated, true, "the cap was hit and nothing said so");
    assert.equal(capped.pulls.length, MAX_LIST_PAGES, "one item per page, so the cap bounds the read");
  }

  const cappedRefs = await listCrossReferencingOpenPulls("ravidsrk/orca-fleet", 71, endless);
  if (cappedRefs.ok) assert.equal(cappedRefs.truncated, true);

  const cappedReview = await fetchHumanReview("ravidsrk/orca-fleet", 70, endless);
  if (cappedReview.ok) assert.equal(cappedReview.truncated, true);

  // EACH endpoint on its own: `truncated` is an OR, and an endless stub truncates both, so it could
  // not tell the OR from `reviews` alone. Comments-only is the likelier half and was unpinned.
  const commentsOnly: typeof fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    const body = u.includes("/comments") ? [{ user: { login: "a", type: "User" } }] : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: u.includes("/comments")
        ? { "Content-Type": "application/json", link: `<${u}>; rel="next"` }
        : { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const halfCapped = await fetchHumanReview("ravidsrk/orca-fleet", 70, commentsOnly);
  assert.equal(halfCapped.ok, true);
  if (halfCapped.ok) {
    assert.equal(halfCapped.truncated, true, "a capped comments read alone must still report truncation");
    assert.equal(halfCapped.humanReview.reviews, 0);
  }
});

/**
 * The SHIPPED cap, not just the mechanism — the distinction #83 spent three rounds on. A cap the
 * tests read out of the constant they check cannot notice it changing, so the number is written here.
 */
test("the page cap is ten, and both list caps agree", () => {
  assert.equal(MAX_LIST_PAGES, 10);
  assert.equal(MAX_COMMIT_PAGES, 10, "the commit read and the list reads must bound alike");
});
