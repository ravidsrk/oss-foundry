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
      reviewComments: pr.review_comments,
      issueComments: pr.comments,
      headSha: pr.head.sha,
      updatedAt: pr.updated_at,
      syncedAt: new Date().toISOString(),
    };
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
