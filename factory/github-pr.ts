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

export async function createGithubDraftPr(
  input: {
    owner: string;
    repo: string;
    title: string;
    head: string;
    base?: string;
    body: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const payload = draftPullPayload(input);
  if (payload.draft !== true) return { ok: false, error: "create helper refused a non-draft PR." };
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "oss-foundry",
    "Content-Type": "application/json",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${input.owner}/${input.repo}/pulls`,
      { method: "POST", headers, body: JSON.stringify(payload) },
    );
    if (!res.ok) return { ok: false, error: `GitHub ${res.status}` };
    const pr = (await res.json()) as { html_url: string; draft: boolean };
    if (!pr.draft) return { ok: false, error: "GitHub returned a non-draft PR; abort." };
    return { ok: true, url: pr.html_url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}

export async function commitExists(
  repoId: string,
  sha: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return { ok: false, error: `bad repo id ${repoId}` };
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "oss-foundry",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`, {
      headers,
    });
    if (!res.ok) return { ok: false, error: `GitHub ${res.status} for ${repoId}@${sha.slice(0, 7)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}

/** Base must be an ancestor of head with at least one commit in between (GitHub compare `ahead`). */
export async function compareCommits(
  repoId: string,
  baseSha: string,
  headSha: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; aheadBy: number } | { ok: false; error: string }> {
  const [owner, repo] = repoId.split("/");
  if (!owner || !repo) return { ok: false, error: `bad repo id ${repoId}` };
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "oss-foundry",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`,
      { headers },
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
    };
    if (body.status !== "ahead" || body.behind_by !== 0 || body.ahead_by < 1) {
      return {
        ok: false,
        error: `base is not an ancestor of head (${body.status}, ahead=${body.ahead_by}, behind=${body.behind_by})`,
      };
    }
    return { ok: true, aheadBy: body.ahead_by };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}

export async function syncGithubPr(data: { url: string }, fetchImpl: typeof fetch = fetch) {
    const parsed = parsePrUrl(data.url);
    if (!parsed) return { ok: false as const, error: "Not a GitHub pull request URL." };

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "oss-foundry",
    };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await fetchImpl(
        `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`,
        { headers },
      );
      if (!res.ok) return { ok: false as const, error: `GitHub ${res.status}` };
      const pr = (await res.json()) as {
        html_url: string;
        title: string;
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
      return { ok: true as const, meta };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "fetch failed",
      };
    }
}
