import { repoById } from "./allowlist.ts";
import type { ScoutScore } from "./types.ts";

export function scoreIssue(input: {
  repoId: string;
  title: string;
  labels: string[];
  daysOld?: number;
}): ScoutScore {
  const repo = repoById(input.repoId);
  const wave = repo ? (repo.wave === 0 ? 40 : repo.wave === 1 ? 28 : 12) : 0;

  const wanted = new Set(
    (repo?.preferredLabels ?? []).map((l) => l.toLowerCase()),
  );
  const hit = input.labels.filter((l) => wanted.has(l.toLowerCase())).length;
  const labels = Math.min(25, hit * 12 + (input.labels.includes("good first issue") ? 8 : 0));

  const title = input.title.toLowerCase();
  let size = 18;
  if (/rfc|epic|tracking|rewrite|refactor everything/.test(title)) size = 0;
  else if (/typo|changelog|docs|readme|icon|label|typo/.test(title)) size = 22;
  else if (title.length > 90) size = 10;

  const days = input.daysOld ?? 30;
  const freshness = days < 14 ? 12 : days < 60 ? 8 : 4;

  const total = wave + labels + size + freshness;

  return {
    total,
    parts: { wave, labels, size, freshness },
  };
}

export function rankIssues<T extends { repoId: string; title: string; labels: string[] }>(
  issues: T[],
): (T & { scout: ScoutScore })[] {
  return issues
    .map((issue) => ({ ...issue, scout: scoreIssue(issue) }))
    .sort((a, b) => b.scout.total - a.scout.total);
}
