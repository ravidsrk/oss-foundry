import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCommits, fetchRepoFile, listOpenPulls } from "./github-pr.ts";

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
