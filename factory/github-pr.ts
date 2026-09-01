import { classifyRevert, REVERT_WINDOW_DAYS, type RevertVerdict } from "./scorecard.ts";
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

/** Bound on every GitHub fetch. A stalled api.github.com must not hang the clock (issue #113). */
export const GITHUB_FETCH_TIMEOUT_MS = 15_000;

/** Inclusive ceiling on `FOUNDRY_GITHUB_TIMEOUT_MS`. Above this the shipped 15s bound is used. */
export const GITHUB_FETCH_TIMEOUT_MAX_MS = 3_600_000;

/**
 * Deadline for one GitHub fetch (issue #113).
 *
 * `FOUNDRY_GITHUB_TIMEOUT_MS` is an integer millisecond override. A truthy invalid value
 * (`-1`, `Infinity`, `15.5`, a non-number) used to reach `AbortSignal.timeout` and throw a
 * RangeError before any request left — the clock and every CLI verb then died on a low-level
 * message that did not name the env var. Those values now fall back to the shipped 15s bound.
 */
export function githubFetchTimeoutMs(
  raw: string | number | undefined = process.env.FOUNDRY_GITHUB_TIMEOUT_MS,
): number {
  const n = typeof raw === "number" ? raw : raw == null || raw === "" ? Number.NaN : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= GITHUB_FETCH_TIMEOUT_MAX_MS) return n;
  return GITHUB_FETCH_TIMEOUT_MS;
}

export function githubRequestInit(
  extra: RequestInit = {},
  timeoutMs: number = githubFetchTimeoutMs(),
): RequestInit {
  if (extra.signal) return extra;
  return { ...extra, signal: AbortSignal.timeout(githubFetchTimeoutMs(timeoutMs)) };
}

/**
 * REST API version this client pins on every request.
 *
 * Unversioned requests inherit GitHub's rolling default. Version `2026-03-10`
 * removes `merge_commit_sha` from every PR payload. This module copies that
 * field onto `PrMeta.mergeCommitSha` in `syncGithubPr`, and that value is the
 * sole input to `classifyRevert` — the entire revert-detection path. When the
 * unversioned default rolls forward the field is `undefined`, `revertCheck`
 * short-circuits on `if (!meta.mergeCommitSha)`, and revert detection stops
 * **silently**. `reverts > 0` is what forces `health=stop`, so the failure
 * mode is a governance gate that quietly stops firing. `2022-11-28` is
 * supported until 2028-03-10.
 */
export const GITHUB_API_VERSION = "2022-11-28";

/**
 * GitHub REST **primary** (core) rate-limit ceilings. They appeared nowhere in
 * the repo, so headroom against a measured ~19-requests-per-tick spend could
 * not be computed (G-10 / R-05).
 *
 * Authenticated PAT: 5,000 requests/hour. Unauthenticated: 60/hour — the
 * fourth tick of an hour then fails with an unexplained 403 if reads run
 * without `GITHUB_TOKEN`/`GH_TOKEN`. Secondary limits are a different class
 * (body matching `/secondary rate limit/i`) and already halt-and-never-retry;
 * this module does not add retries for either class.
 */
export const GITHUB_AUTHENTICATED_RATE_LIMIT_PER_HOUR = 5_000;
export const GITHUB_UNAUTHENTICATED_RATE_LIMIT_PER_HOUR = 60;

let unauthenticatedGithubWarningEmitted = false;

/**
 * The unauthenticated warning is process-wide and once-only so a tick does not
 * print 19 copies of the same ceiling. Tests reset it so they do not depend on
 * suite order.
 */
export function resetUnauthenticatedGithubWarning(): void {
  unauthenticatedGithubWarningEmitted = false;
}

function warnUnauthenticatedGithubReads(): void {
  if (unauthenticatedGithubWarningEmitted) return;
  unauthenticatedGithubWarningEmitted = true;
  console.error(
    `warning: GitHub reads are unauthenticated (neither GITHUB_TOKEN nor GH_TOKEN is set). Anonymous ceiling is ${GITHUB_UNAUTHENTICATED_RATE_LIMIT_PER_HOUR} requests/hour against a documented ~19-requests-per-tick spend, so the fourth tick of an hour fails with 403. Authenticated PAT ceiling is ${GITHUB_AUTHENTICATED_RATE_LIMIT_PER_HOUR}/hour. The token is not required; set GITHUB_TOKEN or GH_TOKEN to raise the ceiling.`,
  );
}

/** `x-ratelimit-reset` is unix seconds; ISO is the operator-readable form. */
function formatRateLimitReset(raw: string | null | undefined): string {
  const n = raw == null || raw === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "at an unknown time";
  const ms = n < 1e12 ? n * 1000 : n;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "at an unknown time";
  return d.toISOString();
}

/**
 * Primary quota exhaustion only: 403/429 with `x-ratelimit-remaining: 0`.
 * Absent remaining is not a match — that is how an ordinary 403 stays an
 * ordinary 403, and how a secondary-limit body is left to its own handler.
 */
function primaryRateLimitMessage(res: Response): string | undefined {
  if (res.status !== 403 && res.status !== 429) return undefined;
  const remaining = res.headers?.get("x-ratelimit-remaining");
  if (remaining !== "0") return undefined;
  const resource = res.headers?.get("x-ratelimit-resource") ?? "core";
  const limit = res.headers?.get("x-ratelimit-limit");
  const resetAt = formatRateLimitReset(res.headers?.get("x-ratelimit-reset"));
  const retryAfter = res.headers?.get("retry-after");
  const retry = retryAfter ? `; retry-after ${retryAfter}s` : "";
  const ceiling =
    limit != null && limit !== ""
      ? `${limit} requests/hour`
      : `${GITHUB_AUTHENTICATED_RATE_LIMIT_PER_HOUR}/hour authenticated, ${GITHUB_UNAUTHENTICATED_RATE_LIMIT_PER_HOUR}/hour unauthenticated`;
  return `GitHub primary rate limit exhausted (${resource}: ${ceiling}, remaining 0, resets ${resetAt}${retry})`;
}

function githubHttpError(res: Response, what: string): string {
  const primary = primaryRateLimitMessage(res);
  if (primary) return what ? `${primary} ${what}` : primary;
  return what ? `GitHub ${res.status} ${what}` : `GitHub ${res.status}`;
}

/**
 * Transport-class failures (offline host, DNS, dropped connection, AbortError)
 * used to reach the operator as the bare undici string `fetch failed` — no repo,
 * no operation, no remedy, indistinguishable from a product defect (G-21 / T-14).
 * HTTP-status failures already carry `what` (`listing pulls on ${repoId}`); this
 * is that same label on the `catch` path. A helper one site forgets to call is
 * the original hole, so every call site that can throw must go through here.
 */
function githubTransportError(err: unknown, what: string): string {
  const detail = err instanceof Error && err.message ? err.message : "fetch failed";
  return what ? `${detail} ${what}` : detail;
}

export function githubApiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "oss-foundry",
    ...extra,
    // Spread extra first so a caller cannot drop the pin. `Accept` may still
    // be overridden (raw-file reads); the version may not.
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (!headers.Authorization) warnUnauthenticatedGithubReads();
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
): Promise<{ ok: true; pulls: OpenPull[]; truncated: boolean } | { ok: false; error: string }> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return { ok: false, error: `bad repo id ${repoId}` };
  try {
    // The sharpest of the five: this feeds the competing-work gate, >100 open PRs is ordinary, and a
    // missed one means opening a duplicate against work in flight (docs/PRODUCT.md §2).
    const read = await listAllPages<{
      number: number;
      title?: string;
      body?: string | null;
      html_url: string;
      head?: { ref?: string };
    }>(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
      `listing pulls on ${repoId}`,
      fetchImpl,
    );
    if (!read.ok) return read;
    return {
      ok: true,
      truncated: read.truncated,
      pulls: read.items.map((p) => ({
        number: p.number,
        title: p.title ?? "",
        body: p.body ?? "",
        url: p.html_url,
        headRef: p.head?.ref ?? "",
      })),
    };
  } catch (err) {
    return { ok: false, error: githubTransportError(err, `listing pulls on ${repoId}`) };
  }
}

/** Open pull requests GitHub's issue timeline links to the issue (`cross-referenced` events). Issues and closed PRs are dropped. */
export async function listCrossReferencingOpenPulls(
  repoId: string,
  issueNumber: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; urls: string[]; truncated: boolean } | { ok: false; error: string }> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return { ok: false, error: `bad repo id ${repoId}` };
  try {
    const read = await listAllPages<{
      event?: string;
      source?: { issue?: { state?: string; html_url?: string; pull_request?: unknown } };
    }>(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=100`,
      `reading timeline for ${repoId}#${issueNumber}`,
      fetchImpl,
    );
    if (!read.ok) return read;
    const body = read.items;
    const urls = body
      .filter(
        (e) =>
          e.event === "cross-referenced" &&
          e.source?.issue?.pull_request !== undefined &&
          e.source.issue.state === "open" &&
          typeof e.source.issue.html_url === "string",
      )
      .map((e) => e.source!.issue!.html_url as string);
    return { ok: true, urls: [...new Set(urls)], truncated: read.truncated };
  } catch (err) {
    return { ok: false, error: githubTransportError(err, `reading timeline for ${repoId}#${issueNumber}`) };
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
    const res = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      githubRequestInit({ headers: githubApiHeaders() }),
    );
    if (!res.ok) {
      return { ok: false, error: githubHttpError(res, `reading ${repoId}#${issueNumber}`) };
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
    return { ok: false, error: githubTransportError(err, `reading ${repoId}#${issueNumber}`) };
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
    // Paginated, but deliberately WITHOUT a truncation signal: best-effort by contract (docblock
    // above), called only after a refusal is decided, so a short read degrades a message and cannot
    // move a verdict.
    const read = await listAllPages<{
      event?: string;
      commit_id?: string | null;
      source?: { issue?: { html_url?: string; pull_request?: unknown } };
    }>(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=100`,
      `reading timeline for ${repoId}#${issueNumber}`,
      fetchImpl,
    );
    if (!read.ok) return undefined;
    const body = read.items;
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
    const res = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      githubRequestInit({ headers: githubApiHeaders({ Accept: "application/vnd.github.raw" }) }),
    );
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
      githubRequestInit({ headers: githubApiHeaders() }),
    );
    if (!res.ok) {
      return {
        ok: false,
        error: githubHttpError(
          res,
          `comparing ${baseSha.slice(0, 7)}...${headSha.slice(0, 7)} on ${repoId}`,
        ),
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
    return {
      ok: false,
      error: githubTransportError(
        err,
        `comparing ${baseSha.slice(0, 7)}...${headSha.slice(0, 7)} on ${repoId}`,
      ),
    };
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
 * That trade is only worth paying because something CONSUMES the re-read, and for a merged packet
 * nothing did until issue #39 round 3. Stated precisely, because the earlier version of this
 * comment got it backwards: `recordTerminalReview` has exactly two call sites, both inside
 * `applyPrSync`'s terminal *transition* branches; `applyPrSync` refuses any status that is not
 * `submitted`/`followed-up`; `reconcile` therefore never hands it a merged packet; and
 * `verify-ledger` never reads `humanReview` at all. So a merged packet whose review endpoints
 * 500ed on the one tick that absorbed the merge WAS stranded at "not observed" forever — not by a
 * transition-gated fetch, but by the shipped code — and the 6 requests/tick this paragraph budgets
 * bought exactly nothing. `reconcile` now calls `applyReviewObservation` with what this returns,
 * which is what makes the re-read worth its cost; the same call is what a maintainer's review
 * comment landing days after the close is picked up by.
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
): Promise<
  | { ok: true; humanReview: { reviews: number; comments: number }; truncated: boolean }
  | { ok: false; error: string }
> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return { ok: false, error: `bad repo id ${repoId}` };
  try {
    const base = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
    // A busy PR undercounts on one page: an under-read here is a wrong KPI, not a missing one.
    type Actor = { user?: { login?: string; type?: string } | null };
    const [reviewsRead, commentsRead] = await Promise.all([
      listAllPages<Actor>(`${base}/reviews?per_page=100`, "on reviews", fetchImpl),
      listAllPages<Actor>(`${base}/comments?per_page=100`, "on review comments", fetchImpl),
    ]);
    if (!reviewsRead.ok) return reviewsRead;
    if (!commentsRead.ok) return commentsRead;
    return {
      ok: true,
      humanReview: countHumanReview({ reviews: reviewsRead.items, comments: commentsRead.items }),
      truncated: reviewsRead.truncated || commentsRead.truncated,
    };
  } catch (err) {
    return { ok: false, error: githubTransportError(err, `reading reviews on ${repoId}#${number}`) };
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

/** Pages one list read may follow: 1,000 items, same bound and reason as `MAX_COMMIT_PAGES` — this
 * runs unattended every six hours (docs/07-github-app.md's "excessive automated bulk activity"). */
export const MAX_LIST_PAGES = 10;

/**
 * Every page of a GitHub list endpoint, to a stated cap, saying so when it stops short. ONE HOME:
 * #39 fixed `listCommitsSince` and left five siblings identical, and five copies of its loop are five
 * places to drift — `listCommitsSince` reads through here too. `truncated` exists because a short
 * read returns the same items and verdict as a complete one. `headers?.get` is optional: GitHub omits
 * `Link` on a single page, and absent means no next page.
 */
async function listAllPages<T>(
  firstUrl: string,
  what: string,
  fetchImpl: typeof fetch,
  cap: number = MAX_LIST_PAGES,
): Promise<{ ok: true; items: T[]; truncated: boolean } | { ok: false; error: string }> {
  let url = firstUrl;
  const items: T[] = [];
  for (let page = 0; page < cap; page += 1) {
    const res = await fetchImpl(url, githubRequestInit({ headers: githubApiHeaders() }));
    if (!res.ok) return { ok: false, error: githubHttpError(res, what) };
    const body = await res.json();
    if (!Array.isArray(body)) return { ok: false, error: `GitHub returned a non-list ${what}` };
    items.push(...(body as T[]));
    // GitHub's own cursor, followed verbatim rather than a `page=` this code increments: the header
    // is what the API documents, and the only thing that says "there is more".
    const next = nextPageUrl(res.headers?.get("link"));
    if (!next) return { ok: true, items, truncated: false };
    url = next;
  }
  return { ok: true, items, truncated: true };
}

/**
 * How many pages of commits one revert re-check may read: 1000 commits, ten requests. A bound is
 * needed because this runs unattended every six hours over every merged packet, and an unbounded
 * follow on a busy base branch is exactly the "excessive automated bulk activity" the AUP names (docs/07-github-app.md).
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
 * **Bounded at both ends by its caller.** `revertCheck` passes `until = mergedAt + 30 days`, the
 * classifier's own deadline, so the window is a fixed size from the day it opens instead of one
 * that grows a day every day against a fixed page cap. See `revertCheck` for the arithmetic.
 *
 * The `truncated` flag exists because a short read and a clean read return the same commits and the
 * same verdict. Every consumer already shouts about a read that FAILED; nothing could tell them
 * about one that merely stopped early, and a capped read must never be indistinguishable from a
 * clean one — least of all here, where the silent difference is a FATAL that never fires.
 */
export async function listCommitsSince(
  repoId: string,
  opts: { since: string; until?: string; sha?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<
  | { ok: true; commits: { sha: string; message: string; committedAt: string }[]; truncated: boolean }
  | { ok: false; error: string }
> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return { ok: false, error: `bad repo id ${repoId}` };
  const query = new URLSearchParams({ since: opts.since, per_page: "100" });
  // The far end of the window, and the reason the read does not grow without bound — see
  // `revertCheck` below, which is the only caller that can compute it.
  if (opts.until) query.set("until", opts.until);
  if (opts.sha) query.set("sha", opts.sha);
  try {
    // Through the same loop as the other five (issue #69). Correct first, and still the reference —
    // but as a CALLER of the shared loop rather than the one good copy.
    const read = await listAllPages<{
      sha?: string;
      commit?: { message?: string; committer?: { date?: string } | null };
    }>(
      `https://api.github.com/repos/${owner}/${repo}/commits?${query}`,
      "for commits",
      fetchImpl,
      MAX_COMMIT_PAGES,
    );
    if (!read.ok) return read;
    return {
      ok: true,
      truncated: read.truncated,
      commits: read.items.map((c) => ({
        sha: c.sha ?? "",
        message: c.commit?.message ?? "",
        committedAt: c.commit?.committer?.date ?? "",
      })),
    };
  } catch (err) {
    return { ok: false, error: githubTransportError(err, `listing commits on ${repoId}`) };
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
  // BOTH ends of the window, deliberately (issue #39 round 3). `since` alone reads [mergedAt, now],
  // which grows by a day every day and never closes — while `classifyRevert` discards anything past
  // `mergedAt + REVERT_WINDOW_DAYS`, so every commit beyond that is fetched, paged, and thrown away.
  // Measured on ravidsrk/orca-fleet (read-only GET, 2026-08-29): main runs ~17 commits/day, so the
  // 30-day window holds ~505 — comfortably under the 1000-commit cap. The unbounded read is under
  // it only for now: at that rate it crosses the cap around day 60, and from then on every
  // long-lived merged packet emits a truncation advisory on every tick, permanently, about a window
  // that closed a month earlier. Nothing could ever clear it. That is how an advisory channel gets
  // trained into background noise — the exact failure this file's siblings cite as their reason for
  // edge-triggering (ledger-check.ts). Bounding at the classifier's own deadline makes the read a
  // fixed size forever and keeps a truncation advisory meaning what it says.
  const windowEnd = Date.parse(meta.mergedAt) + REVERT_WINDOW_DAYS * 86_400_000;
  const listed = await listCommitsSince(
    repoId,
    {
      since: meta.mergedAt,
      until: Number.isFinite(windowEnd) ? new Date(windowEnd).toISOString() : undefined,
      sha: meta.baseRef,
    },
    fetchImpl,
  );
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
      githubRequestInit({ headers: githubApiHeaders() }),
    );
    if (!res.ok) return { ok: false as const, error: githubHttpError(res, "") };
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
    let reviewTruncated = false;
    if (pr.merged || pr.state === "closed") {
      const review = await fetchHumanReview(parsed.owner + "/" + parsed.repo, parsed.number, fetchImpl);
      // A CAPPED read leaves the field absent like a failed one, but is REPORTED separately: an
      // endpoint outage is worth retrying and a capped read is not.
      reviewTruncated = review.ok && review.truncated;
      if (review.ok && !review.truncated) meta.humanReview = review.humanReview;
    }
    return { ok: true as const, meta, title: pr.title ?? "", body: pr.body ?? "", reviewTruncated };
  } catch (err) {
    return {
      ok: false as const,
      error: githubTransportError(err, `syncing ${parsed.owner}/${parsed.repo}#${parsed.number}`),
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
    const res = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/pulls`,
      githubRequestInit({
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "oss-foundry",
          Authorization: `Bearer ${pat}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        body: JSON.stringify(payload),
      }),
    );
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
    const primary = primaryRateLimitMessage(res);
    if (primary) {
      return { ok: false, error: `${primary} creating the draft on ${repoId}` };
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
    return { ok: false, error: githubTransportError(err, `creating the draft on ${repoId}`) };
  }
}
