import { classifyRevert, type RevertVerdict } from "./scorecard.ts";
import type { PrMeta } from "./types.ts";

export type { PrMeta } from "./types.ts";

export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 4 || parts[2] !== "pull") return null;
    const number = Number(parts[3]);
    if (!Number.isInteger(number) || number < 1) return null;
    return { owner: parts[0], repo: parts[1], number };
  } catch {
    return null;
  }
}

export function draftPullPayload(input: {
  title: string;
  head: string;
  base?: string;
  body: string;
}): { title: string; head: string; base: string; body: string; draft: true } {
  return {
    title: input.title,
    head: input.head,
    base: input.base ?? "main",
    body: input.body,
    draft: true,
  };
}

export function githubApiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "oss-foundry",
    ...extra,
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export interface OpenPull {
  number: number;
  title: string;
  body: string;
  url: string;
  headRef: string;
}

export async function listOpenPulls(
  repoId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; pulls: OpenPull[] } | { ok: false; error: string }> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return { ok: false, error: `bad repo id ${repoId}` };
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100`, {
      headers: githubApiHeaders(),
    });
    if (!res.ok) return { ok: false, error: `GitHub ${res.status} listing pulls on ${repoId}` };
    const body = (await res.json()) as {
      number: number;
      title?: string;
      body?: string | null;
      html_url: string;
      head?: { ref?: string };
    }[];
    return {
      ok: true,
      pulls: body.map((p) => ({
        number: p.number,
        title: p.title ?? "",
        body: p.body ?? "",
        url: p.html_url,
        headRef: p.head?.ref ?? "",
      })),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}

/** Open pull requests GitHub's issue timeline links to the issue (`cross-referenced` events). Issues and closed PRs are dropped. */
export async function listCrossReferencingOpenPulls(
  repoId: string,
  issueNumber: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; urls: string[] } | { ok: false; error: string }> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return { ok: false, error: `bad repo id ${repoId}` };
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=100`,
      { headers: githubApiHeaders() },
    );
    if (!res.ok) {
      return { ok: false, error: `GitHub ${res.status} reading timeline for ${repoId}#${issueNumber}` };
    }
    const body = (await res.json()) as {
      event?: string;
      source?: { issue?: { state?: string; html_url?: string; pull_request?: unknown } };
    }[];
    const urls = body
      .filter(
        (e) =>
          e.event === "cross-referenced" &&
          e.source?.issue?.pull_request !== undefined &&
          e.source.issue.state === "open" &&
          typeof e.source.issue.html_url === "string",
      )
      .map((e) => e.source!.issue!.html_url as string);
    return { ok: true, urls: [...new Set(urls)] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}

/** The target issue's own state, as GitHub records it. */
export interface IssueLiveState {
  number: number;
  state: "open" | "closed";
  /** GitHub's `state_reason`: `completed`, `not_planned`, `reopened`, or absent. */
  stateReason?: string;
  /**
   * The number names a pull request. GitHub serves pull requests from the issues endpoint too,
   * distinguished only by this key — without it a roster row pointing at a PR number reads back as
   * a perfectly healthy issue.
   */
  isPullRequest: boolean;
  closedAt?: string;
  /** Login of whoever closed it, when GitHub reports one. */
  closedBy?: string;
  url: string;
}

/**
 * Is the target issue still open? (issue #40)
 *
 * The read nothing in the factory made. Competing-work detection sees only OPEN pull requests —
 * `listOpenPulls` asks for `state=open`, and `listCrossReferencingOpenPulls` drops every
 * cross-reference that is not an open PR — so a fix that merged and closed the issue leaves no
 * trace in either, and `classifyCompetition` returns `{kind: "clear"}`, byte-identical to an issue
 * nobody has touched. This endpoint is the only one that answers the question.
 *
 * Fails closed like every other read on these paths: a non-answer is `{ok: false}`, never an
 * assumed-open issue. Callers refuse on it.
 */
export async function fetchIssueState(
  repoId: string,
  issueNumber: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; issue: IssueLiveState } | { ok: false; error: string }> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return { ok: false, error: `bad repo id ${repoId}` };
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
      headers: githubApiHeaders(),
    });
    if (!res.ok) {
      return { ok: false, error: `GitHub ${res.status} reading ${repoId}#${issueNumber}` };
    }
    const body = (await res.json()) as {
      number?: number;
      state?: string;
      state_reason?: string | null;
      pull_request?: unknown;
      closed_at?: string | null;
      closed_by?: { login?: string } | null;
      html_url?: string;
    };
    return {
      ok: true,
      issue: {
        number: body.number ?? issueNumber,
        // Anything that is not the literal "open" is treated as closed: an unrecognised value is
        // not a licence to contact a maintainer.
        state: body.state === "open" ? "open" : "closed",
        stateReason: body.state_reason ?? undefined,
        isPullRequest: body.pull_request !== undefined && body.pull_request !== null,
        closedAt: body.closed_at ?? undefined,
        closedBy: body.closed_by?.login,
        url: body.html_url ?? `https://github.com/${repoId}/issues/${issueNumber}`,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}

/**
 * The commit or pull request GitHub's timeline says resolved the issue — for the refusal message,
 * so the operator can go look at who fixed it instead of guessing.
 *
 * The same timeline `listCrossReferencingOpenPulls` reads, mined for what that one throws away: the
 * closing pull request is CLOSED by definition, and that filter keeps only open ones. Live shape on
 * ravidsrk/orca-fleet#71 — the roster's own first named issue, closed 2026-08-27 — is a
 * `cross-referenced` event naming closed PR #72 plus a `closed` event with a null `commit_id`.
 *
 * Best-effort by design, and called only once a refusal has already been decided: a timeline that
 * will not load degrades the message and nothing else. It must never be able to turn a refusal into
 * a proceed, so it returns `undefined` rather than an error the caller could mistake for a verdict.
 */
export async function fetchIssueClosingRef(
  repoId: string,
  issueNumber: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return undefined;
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=100`,
      { headers: githubApiHeaders() },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      event?: string;
      commit_id?: string | null;
      source?: { issue?: { html_url?: string; pull_request?: unknown } };
    }[];
    // A commit that closed the issue outright is the more specific answer, so it outranks a
    // cross-reference that merely names it.
    const closingCommit = body.find((e) => e.event === "closed" && typeof e.commit_id === "string");
    if (closingCommit?.commit_id) return `commit ${closingCommit.commit_id.slice(0, 7)}`;
    const referenced = body
      .filter((e) => e.event === "cross-referenced" && e.source?.issue?.pull_request !== undefined)
      .map((e) => e.source?.issue?.html_url)
      .filter((url): url is string => typeof url === "string");
    return referenced.at(-1);
  } catch {
    return undefined;
  }
}

export async function fetchRepoFile(
  repoId: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return undefined;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
      headers: githubApiHeaders({ Accept: "application/vnd.github.raw" }),
    });
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

/** Base must be an ancestor of head with at least one commit in between (GitHub compare `ahead`). */
export async function compareCommits(
  repoId: string,
  baseSha: string,
  headSha: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; aheadBy: number; filesChanged: number; diffLines: number; messages: string[] }
  | { ok: false; error: string }
> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return { ok: false, error: `bad repo id ${repoId}` };
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`,
      { headers: githubApiHeaders() },
    );
    if (!res.ok) {
      return {
        ok: false,
        error: `GitHub ${res.status} comparing ${baseSha.slice(0, 7)}...${headSha.slice(0, 7)} on ${repoId}`,
      };
    }
    const body = (await res.json()) as {
      status: string;
      ahead_by: number;
      behind_by: number;
      files?: { additions?: number; deletions?: number }[];
      commits?: { commit?: { message?: string } }[];
    };
    if (body.status !== "ahead" || body.behind_by !== 0 || body.ahead_by < 1) {
      return {
        ok: false,
        error: `base is not an ancestor of head (${body.status}, ahead=${body.ahead_by}, behind=${body.behind_by})`,
      };
    }
    const files = body.files ?? [];
    const diffLines = files.reduce(
      (n, f) => n + (Number(f.additions) || 0) + (Number(f.deletions) || 0),
      0,
    );
    if (files.length < 1 || diffLines < 1) {
      return { ok: false, error: "compared range has no file diff" };
    }
    const messages = (body.commits ?? []).map((c) => c.commit?.message ?? "").filter(Boolean);
    return {
      ok: true,
      aheadBy: body.ahead_by,
      filesChanged: files.length,
      diffLines,
      messages,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}

/**
 * Review bots this project has actually met, spelled without the `[bot]` suffix.
 *
 * Not a guess at every review bot on GitHub — a floor, and an **unexercised** one. Be exact about
 * what it is for and what evidence exists, because the first draft of this comment was neither.
 *
 * The case it covers: a GitHub App can also be installed as an ordinary user account, and then it
 * carries neither `type: "Bot"` nor the `[bot]` suffix, so the two higher-authority signals in
 * `isBotAccount` both miss it and a bot's review counts as a human's.
 *
 * The evidence, re-read live 2026-08-29 (read-only GET): `greptile-apps[bot]` left one review and
 * one review comment on ravidsrk/orca-fleet#70 — `type: "Bot"`, `[bot]` suffix. `coderabbitai[bot]`
 * left ONE ISSUE COMMENT on ColeMurray/background-agents#1652, which is not a review surface: that
 * PR's `review_comments` is 0 and both `/pulls/1652/reviews` and `/pulls/1652/comments` are empty,
 * so it feeds neither KPI. Both logins therefore wear `type: "Bot"` AND the suffix, and **neither
 * has ever reached this roster** — `isBotAccount` returns true two branches earlier for both.
 *
 * So this list is a documented floor against a case this project has not yet met, kept because the
 * cost of the miss (a bot's review counted as a human's, silently, in a published KPI) is worse
 * than the cost of the list. It is in tension with this repo's own doctrine — factory/run-tests.ts:
 * "Discovered, not listed. A hand-maintained roster is the same silent hole this runner exists to
 * close from the other end." The tension is resolved the only honest way available: the roster
 * never overrides a discovered signal, it only runs after both have said no. Add a login here the
 * first time one is observed reviewing a Foundry PR *without* either discovered signal — and if
 * that never happens, this list should eventually be deleted rather than grown.
 */
export const KNOWN_REVIEW_BOTS: readonly string[] = ["coderabbitai", "greptile-apps"];

/**
 * Is this account a bot? docs/08-operations.md defines BOTH review KPIs over **human, non-bot**
 * accounts, so this predicate is not a detail of the fetch — it is half of the definition.
 *
 * Three signals, in order of authority: GitHub's own `type` (only the reviews/comments endpoints
 * carry it), the `[bot]` login suffix GitHub App accounts wear, and the roster above. Substring
 * matching is deliberately NOT used — a person may be called `robotnik`.
 */
export function isBotAccount(user: { login?: string; type?: string } | null | undefined): boolean {
  if (!user) return false;
  if (user.type === "Bot") return true;
  const login = (user.login ?? "").toLowerCase();
  if (login.length === 0) return false;
  if (login.endsWith("[bot]")) return true;
  return KNOWN_REVIEW_BOTS.includes(login);
}

/**
 * The two human review counts, kept apart on purpose.
 *
 * `reviews` and `comments` answer different KPIs and must not be collapsed into one number: a
 * maintainer who clicks Approve with no text is **review activity** (so the PR is not `noReview`)
 * but contributes **no review comment** (so it stays out of the `reviewCommentsAvg` denominator).
 * Summing them would put a bare approval in a mean of comment counts, which is not the documented
 * metric.
 */
export function countHumanReview(input: {
  reviews: { user?: { login?: string; type?: string } | null }[];
  comments: { user?: { login?: string; type?: string } | null }[];
}): { reviews: number; comments: number } {
  return {
    reviews: input.reviews.filter((r) => !isBotAccount(r.user)).length,
    comments: input.comments.filter((c) => !isBotAccount(c.user)).length,
  };
}

/**
 * The human review split for one pull request, or a failure.
 *
 * Two requests, spent on any PR `syncGithubPr` finds in a terminal STATE — not on a terminal
 * *transition*. Be precise about that: `syncGithubPr` is handed a URL and knows nothing about the
 * packet's prior status, so it cannot tell "this PR just closed" from "this PR closed last week".
 * The practical cost is 2 extra requests per already-terminal PR on every `reconcile` and every
 * 6-hourly clock tick, forever — at today's ledger, 6 requests a tick against a 5000/hour budget.
 *
 * That is a deliberate trade, not an oversight. A terminal PR is not frozen: a maintainer can leave
 * a review comment days after closing it, and — more importantly — a sync whose review endpoints
 * 500ed records `humanReview` as ABSENT, and re-reading on the next pass is the only way that ever
 * gets filled in. A transition-gated fetch would strand such a packet at "not observed" forever.
 * An OPEN PR is still skipped: `noReview` and `reviewCommentsAvg` are defined over terminal
 * outcomes and an open PR has none, so it costs exactly the one request it always did.
 *
 * A failure is reported, never smoothed to zero: "we could not read it" and "nobody reviewed it"
 * are different facts, and only one of them is a KPI.
 */
export async function fetchHumanReview(
  repoId: string,
  number: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; humanReview: { reviews: number; comments: number } } | { ok: false; error: string }> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return { ok: false, error: `bad repo id ${repoId}` };
  try {
    const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
    const [reviewsRes, commentsRes] = await Promise.all([
      fetchImpl(`${base}/reviews?per_page=100`, { headers: githubApiHeaders() }),
      fetchImpl(`${base}/comments?per_page=100`, { headers: githubApiHeaders() }),
    ]);
    if (!reviewsRes.ok) return { ok: false, error: `GitHub ${reviewsRes.status} on reviews` };
    if (!commentsRes.ok) return { ok: false, error: `GitHub ${commentsRes.status} on review comments` };
    const reviews = (await reviewsRes.json()) as { user?: { login?: string; type?: string } | null }[];
    const comments = (await commentsRes.json()) as { user?: { login?: string; type?: string } | null }[];
    if (!Array.isArray(reviews) || !Array.isArray(comments)) {
      return { ok: false, error: "GitHub returned a non-list for the review endpoints" };
    }
    return { ok: true, humanReview: countHumanReview({ reviews, comments }) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}

/** `rel="next"` out of a GitHub `Link` header — the cursor, or `undefined` at the last page. */
export function nextPageUrl(link: string | null | undefined): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/i);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * How many pages of commits one revert re-check may read: 1000 commits, ten requests. A bound is
 * needed because this runs unattended every six hours over every merged packet, and an unbounded
 * follow on a busy base branch is exactly the "excessive automated activity" the AUP names.
 */
export const MAX_COMMIT_PAGES = 10;

/**
 * Commits on a branch after a moment in time — the only place a revert of our merge commit can
 * show up (docs/08-operations.md: "an explicit `git revert` of our merge commit ... within 30 days
 * of merge").
 *
 * Deliberately not `compareCommits`: that one refuses a range that is not strictly ahead with a
 * file diff, because it exists to bind evidence. Here the common answer is "nothing landed since
 * the merge", which is a perfectly good answer and not an error.
 *
 * **Paginated, and loud when it stops short.** GitHub serves commits newest-first, so page 1 is the
 * FAR end of the `since` window: a one-page read hides the hours immediately after the merge, which
 * is when a revert is most likely to land. This was live, not theoretical — on ravidsrk/orca-fleet
 * (read-only GET, 2026-08-29) `since` #70's merge returns 100 commits on page 1 and 11 on page 2,
 * and page 1's oldest commit is `2026-08-28T14:08:01Z` against a merge at `2026-08-27T07:04:52Z`:
 * a ~31-hour blind window opening at the merge, widening every day.
 *
 * The `truncated` flag exists because a short read and a clean read return the same commits and the
 * same verdict. Every consumer already shouts about a read that FAILED; nothing could tell them
 * about one that merely stopped early, and a capped read must never be indistinguishable from a
 * clean one — least of all here, where the silent difference is a FATAL that never fires.
 */
export async function listCommitsSince(
  repoId: string,
  opts: { since: string; sha?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; commits: { sha: string; message: string; committedAt: string }[]; truncated: boolean }
  | { ok: false; error: string }
> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return { ok: false, error: `bad repo id ${repoId}` };
  const query = new URLSearchParams({ since: opts.since, per_page: "100" });
  if (opts.sha) query.set("sha", opts.sha);
  let url = `https://api.github.com/repos/${owner}/${repo}/commits?${query}`;
  const commits: { sha: string; message: string; committedAt: string }[] = [];
  try {
    for (let page = 0; page < MAX_COMMIT_PAGES; page += 1) {
      const res = await fetchImpl(url, { headers: githubApiHeaders() });
      if (!res.ok) return { ok: false, error: `GitHub ${res.status}` };
      const body = (await res.json()) as {
        sha?: string;
        commit?: { message?: string; committer?: { date?: string } | null };
      }[];
      if (!Array.isArray(body)) return { ok: false, error: "GitHub returned a non-list for commits" };
      for (const c of body) {
        commits.push({
          sha: c.sha ?? "",
          message: c.commit?.message ?? "",
          committedAt: c.commit?.committer?.date ?? "",
        });
      }
      // GitHub's own cursor, followed verbatim rather than a `page=` this code increments: the
      // header is what the API documents, and it is also the only thing that says "there is more".
      const next = nextPageUrl(res.headers.get("link"));
      if (!next) return { ok: true, commits, truncated: false };
      url = next;
    }
    return { ok: true, commits, truncated: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}

/**
 * Has our merge commit been reverted on the base branch? (SPEC.md §7 MUST, issue #39.)
 *
 * One seam, two callers on purpose: `verify-ledger.ts` (the 6-hour clock, which can only report)
 * and `reconcile` (which records). Two hand-rolled copies of "list the commits, then classify"
 * would be two chances to drift, and the clock and the operator verb disagreeing about whether a
 * repository is halted is exactly the failure this check exists to prevent.
 *
 * A packet with no recorded merge commit is not an error: it answers "nothing to check".
 *
 * `truncated` rides out beside the verdict because `reverted: false` alone cannot distinguish "no
 * revert" from "no revert in the part we read". Callers surface it on the same advisory path they
 * already use for a read that failed outright — the two facts are the same fact at different
 * strengths, and neither may be printed as a clean bill of health.
 */
export async function revertCheck(
  repoId: string,
  meta: { mergeCommitSha?: string; mergedAt?: string; baseRef?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; verdict: RevertVerdict; truncated: boolean } | { ok: false; error: string }> {
  if (!meta.mergeCommitSha || !meta.mergedAt) {
    return {
      ok: true,
      truncated: false,
      verdict: { reverted: false, why: `no merge commit recorded for ${repoId} — nothing to revert` },
    };
  }
  const listed = await listCommitsSince(repoId, { since: meta.mergedAt, sha: meta.baseRef }, fetchImpl);
  if (!listed.ok) return { ok: false, error: listed.error };
  return {
    ok: true,
    truncated: listed.truncated,
    verdict: classifyRevert({
      mergeCommitSha: meta.mergeCommitSha,
      mergedAt: meta.mergedAt,
      commits: listed.commits,
    }),
  };
}

export async function syncGithubPr(data: { url: string }, fetchImpl: typeof fetch = fetch) {
  const parsed = parsePrUrl(data.url);
  if (!parsed) return { ok: false as const, error: "Not a GitHub pull request URL." };

  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`,
      { headers: githubApiHeaders() },
    );
    if (!res.ok) return { ok: false as const, error: `GitHub ${res.status}` };
    const pr = (await res.json()) as {
      html_url: string;
      title: string;
      body: string | null;
      draft: boolean;
      state: "open" | "closed";
      merged: boolean;
      mergeable_state: string;
      commits: number;
      review_comments: number;
      comments: number;
      head: { sha: string };
      base?: { ref?: string } | null;
      merge_commit_sha?: string | null;
      merged_at?: string | null;
      updated_at: string;
    };
    const meta: PrMeta = {
      url: pr.html_url,
      title: pr.title,
      draft: pr.draft,
      state: pr.state,
      merged: pr.merged,
      mergeable: pr.mergeable_state,
      commits: pr.commits,
      // GitHub's own total, left un-doctored: it counts bots and carries no author, so it is a
      // record of what the platform said and NOT the KPI. `humanReview` below is the KPI.
      reviewComments: pr.review_comments,
      issueComments: pr.comments,
      headSha: pr.head.sha,
      updatedAt: pr.updated_at,
      syncedAt: new Date().toISOString(),
    };
    if (pr.base?.ref) meta.baseRef = pr.base.ref;
    if (pr.merge_commit_sha) meta.mergeCommitSha = pr.merge_commit_sha;
    if (pr.merged_at) meta.mergedAt = pr.merged_at;
    // Enriched for a PR in a terminal STATE — both halves, merged and closed-unmerged, because
    // docs/08-operations.md defines `noReview` and `reviewCommentsAvg` over terminal outcomes and
    // `closedUnmerged` is half of that denominator. A state test, not a transition test: this
    // function is handed a URL and has no idea what the packet's status was a moment ago. See
    // `fetchHumanReview` for why re-reading an already-terminal PR is wanted rather than tolerated.
    // An open PR costs exactly the one request it always did. A failure leaves `humanReview` ABSENT
    // — the consumer must then say it could not compute the metric rather than record a zero.
    if (pr.merged || pr.state === "closed") {
      const review = await fetchHumanReview(parsed.owner + "/" + parsed.repo, parsed.number, fetchImpl);
      if (review.ok) meta.humanReview = review.humanReview;
    }
    return { ok: true as const, meta, title: pr.title ?? "", body: pr.body ?? "" };
  } catch (err) {
    return {
      ok: false as const,
      error: err instanceof Error ? err.message : "fetch failed",
    };
  }
}

export type CreateDraftResult =
  | { ok: true; url: string; number: number }
  | { ok: false; error: string; halt?: true };

/**
 * The moment of contact, machine-enforced (issue #5). Opens a fork→upstream DRAFT pull request
 * with the dedicated machine account's classic `public_repo` PAT (`FOUNDRY_PAT`) — the only
 * credential type GitHub documents for writes to unaffiliated public repos; App tokens 403 by
 * design (intersection model, docs/07). draft: true is hard-coded via draftPullPayload; there is
 * no ready-for-review or merge surface here. One create per CLI invocation; a secondary-rate-limit
 * response is a factory halt signal, not a retry.
 */
export async function createDraftPull(
  repoId: string,
  input: { title: string; head: string; base?: string; body: string },
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<CreateDraftResult> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return { ok: false, error: `bad repo id ${repoId}` };
  const pat = env.FOUNDRY_PAT;
  if (!pat) {
    return {
      ok: false,
      error:
        "FOUNDRY_PAT is not set — the machine account's classic public_repo PAT opens drafts on repos the App is not installed on (the App 403s there by design). Run scripts/machine-account-wizard.sh, export FOUNDRY_PAT on the operator host, and retry. Never commit it; never put it in the E2B box.",
    };
  }
  if (!/^[\w-]+:[\w./-]+$/.test(input.head)) {
    return { ok: false, error: `head must be fork-qualified (owner:branch), got ${input.head}` };
  }
  const payload = draftPullPayload(input);
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "oss-foundry",
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as {
      html_url?: string;
      number?: number;
      draft?: boolean;
      message?: string;
    };
    if ((res.status === 403 || res.status === 429) && /secondary rate limit/i.test(body.message ?? "")) {
      return {
        ok: false,
        halt: true,
        error:
          "GitHub secondary rate limit on content creation — HALT the factory (AUP: excessive automated bulk activity). Do not retry; investigate before any further create.",
      };
    }
    if (res.status === 403) {
      return {
        ok: false,
        error: `GitHub 403 creating the draft on ${repoId}: ${body.message ?? "forbidden"}. Check: PAT is classic with public_repo scope; the upstream has not restricted PR creation to collaborators (Feb 2026 repo settings).`,
      };
    }
    if (res.status !== 201) {
      return { ok: false, error: `GitHub ${res.status} creating the draft on ${repoId}: ${body.message ?? "error"}` };
    }
    if (body.draft !== true) {
      return {
        ok: false,
        error: "upstream returned a non-draft pull request — stand down and inspect before proceeding; Foundry opens drafts only.",
      };
    }
    return { ok: true, url: body.html_url ?? "", number: body.number ?? 0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}
