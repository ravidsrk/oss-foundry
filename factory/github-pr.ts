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
