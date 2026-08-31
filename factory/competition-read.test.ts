import assert from "node:assert/strict";
import { test } from "node:test";
import { competitionAdvisories, readCompetition } from "./competition-read.ts";
import { MAX_LIST_PAGES } from "./github-pr.ts";
import { asOpenSubmitted, wave1Packet } from "./seed-fixtures.ts";

test("a capped competition read is not reported as clear", () => {
  const open = asOpenSubmitted(wave1Packet());
  const capped = competitionAdvisories(open, {
    ok: true,
    truncated: true,
    verdict: { kind: "clear" },
  });
  assert.equal(capped.length, 1);
  assert.match(capped[0], /page cap/);
  assert.match(capped[0], /no competing pull request/);
  assert.match(capped[0], new RegExp(`${MAX_LIST_PAGES}-page cap`));

  const complete = competitionAdvisories(open, {
    ok: true,
    truncated: false,
    verdict: { kind: "clear" },
  });
  assert.deepEqual(complete, [], "a complete clear read must stay quiet or the cap line means nothing");
});

test("a capped read that already found a competitor reports both facts", () => {
  const open = asOpenSubmitted(wave1Packet());
  const lines = competitionAdvisories(open, {
    ok: true,
    truncated: true,
    verdict: {
      kind: "competing",
      url: "https://github.com/ColeMurray/background-agents/pull/1668",
      why: "closing-keyword",
    },
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], /page cap/);
  assert.match(lines[1], /competing PR/);
});

test("a failed competition read is one advisory, not a silent all-clear", () => {
  const open = asOpenSubmitted(wave1Packet());
  const lines = competitionAdvisories(open, { ok: false, error: "GitHub 502" });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /could not re-check competing work/);
  assert.match(lines[0], /GitHub 502/);
});

test("readCompetition surfaces truncated from a never-ending open-pulls cursor", async () => {
  const open = asOpenSubmitted(wave1Packet());
  const hungPages: typeof fetch = (url) => {
    const u = String(url);
    if (/\/pulls\?state=open/.test(u)) {
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json", link: `<${u}>; rel="next"` },
        }),
      );
    }
    // A complete empty timeline so only the open-pulls cap is under test. 404 here would
    // return `{ ok: false }` and never surface `truncated`.
    if (/\/timeline/.test(u)) {
      return Promise.resolve(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ message: `unstubbed ${u}` }), { status: 404 }));
  };
  const read = await readCompetition(open, hungPages);
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.truncated, true);
    assert.equal(read.verdict.kind, "clear");
  }
  const lines = competitionAdvisories(open, read);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /page cap/);
});
