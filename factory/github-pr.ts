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

export async function syncGithubPr(data: { url: string }) {
    const parsed = parsePrUrl(data.url);
    if (!parsed) return { ok: false as const, error: "Not a GitHub pull request URL." };

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "oss-foundry",
    };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await fetch(
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
