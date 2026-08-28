import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCommits, createDraftPull, fetchRepoFile, listCrossReferencingOpenPulls, listOpenPulls } from "./github-pr.ts";

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
