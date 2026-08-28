import { ALLOWLIST } from "./allowlist.ts";
import { githubApiHeaders } from "./github-pr.ts";
import { rankIssues } from "./scout.ts";
import type { ScoutScore } from "./types.ts";

export interface LiveIssue {
  repoId: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
  daysOld: number;
  scout: ScoutScore;
  agentsMd?: string;
  contributing?: string;
}

export async function scoutGithub(data: { maxPerRepo?: number } = {}) {
  const maxPerRepo = Math.min(Math.max(data.maxPerRepo ?? 5, 1), 8);
  const found: Omit<LiveIssue, "scout">[] = [];
  const errors: string[] = [];
  const headers = githubApiHeaders();

  for (const repo of ALLOWLIST.filter((r) => r.wave <= 1)) {
    const url = `https://api.github.com/repos/${repo.owner}/${repo.name}/issues?state=open&per_page=${maxPerRepo}&sort=updated`;
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        errors.push(
          res.status === 403
            ? `${repo.id}: GitHub 403 (rate limit). Operator host needs GITHUB_TOKEN.`
            : `${repo.id}: GitHub ${res.status}`,
        );
        continue;
      }
      const issues = (await res.json()) as {
        number: number;
        title: string;
        html_url: string;
        pull_request?: unknown;
        labels: { name: string }[];
        created_at: string;
      }[];
      for (const issue of issues) {
        if (issue.pull_request) continue;
        const daysOld = Math.max(
          0,
          Math.floor((Date.now() - new Date(issue.created_at).getTime()) / 86_400_000),
        );
        found.push({
          repoId: repo.id,
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          labels: issue.labels.map((l) => l.name),
          daysOld,
        });
      }
    } catch (err) {
      errors.push(`${repo.id}: ${err instanceof Error ? err.message : "fetch failed"}`);
    }
  }

  const ranked: LiveIssue[] = rankIssues(found).slice(0, 12);
  return { ok: true as const, issues: ranked, errors };
}
