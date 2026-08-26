import type { AllowlistedRepo, Wave } from "./types";

export const DENYLIST: {
  id: string;
  reason: string;
}[] = [
  {
    id: "matplotlib/matplotlib",
    reason: "Autonomous-agent PRs banned after 2026 slop incident.",
  },
  {
    id: "curl/curl",
    reason: "HackerOne AI-report flood; maintainer asked agents to stop.",
  },
  {
    id: "pydantic/pydantic",
    reason: "High slop-PR close rate in 2026; do not farm issues.",
  },
  {
    id: "stablyai/orca",
    reason: "Upstream runtime — contribute via orca-fleet playbooks, not drive-by PRs.",
  },
];

export const ALLOWLIST: AllowlistedRepo[] = [
  {
    id: "ravidsrk/orca-fleet",
    owner: "ravidsrk",
    name: "orca-fleet",
    wave: 0,
    language: "Python / Markdown",
    aiPolicy: "owner",
    policyNotes:
      "Own catalog. Dogfood oss-contribute here first. Validator: python3 scripts/validate.py.",
    testCommand: "python3 scripts/validate.py && python3 -m unittest discover -s tests -v",
    maxFiles: 8,
    maxDiffLines: 400,
    sandbox: "host",
    contributingUrl: "https://github.com/ravidsrk/orca-fleet/blob/main/CONTRIBUTING.md",
    preferredLabels: ["documentation", "p2"],
    firstIssues: [
      {
        number: 42,
        title:
          "[P2] CHANGELOG [Unreleased] describes changes already on main; version bump pending",
        url: "https://github.com/ravidsrk/orca-fleet/issues/42",
      },
    ],
  },
  {
    id: "ravidsrk/frontguard",
    owner: "ravidsrk",
    name: "frontguard",
    wave: 0,
    language: "TypeScript",
    aiPolicy: "owner",
    policyNotes: "Own visual-regression monorepo. Prefer CLI/docs/test debt.",
    testCommand: "npm test",
    maxFiles: 10,
    maxDiffLines: 500,
    sandbox: "host",
    preferredLabels: ["bug", "documentation"],
    firstIssues: [],
  },
  {
    id: "ColeMurray/background-agents",
    owner: "ColeMurray",
    name: "background-agents",
    wave: 1,
    language: "TypeScript",
    aiPolicy: "welcome",
    policyNotes:
      "OpenInspect / background agents. Help-wanted + good-first-issue present. E2B path is in-tree.",
    testCommand: "npm test",
    maxFiles: 6,
    maxDiffLines: 280,
    sandbox: "e2b",
    preferredLabels: ["good first issue", "help wanted"],
    firstIssues: [
      {
        number: 1476,
        title: "Differentiate the right sidebar toggle icon by state",
        url: "https://github.com/ColeMurray/background-agents/issues/1476",
      },
    ],
  },
  {
    id: "github/awesome-copilot",
    owner: "github",
    name: "awesome-copilot",
    wave: 1,
    language: "Markdown",
    aiPolicy: "welcome",
    policyNotes:
      "GitHub's copilot instructions catalog. Fast-track markers for well-formed agent PRs. Docs-only, low blast radius.",
    testCommand: "true",
    maxFiles: 3,
    maxDiffLines: 80,
    sandbox: "host",
    preferredLabels: ["documentation"],
    firstIssues: [],
  },
  {
    id: "e2b-dev/E2B",
    owner: "e2b-dev",
    name: "E2B",
    wave: 1,
    language: "TypeScript / Python",
    aiPolicy: "welcome",
    policyNotes: "Sandbox we depend on. Docs, SDK examples, types. Never touch billing/auth.",
    testCommand: "npm test",
    maxFiles: 5,
    maxDiffLines: 220,
    sandbox: "e2b",
    preferredLabels: ["documentation", "good first issue"],
    firstIssues: [],
  },
  {
    id: "mcp-use/mcp-use",
    owner: "mcp-use",
    name: "mcp-use",
    wave: 1,
    language: "TypeScript",
    aiPolicy: "unknown",
    policyNotes:
      "MCP client we already use. Scout must fetch CONTRIBUTING/AGENTS.md before any packet leaves freeze. Unknown policy = HOLD until parsed.",
    testCommand: "pnpm test",
    maxFiles: 4,
    maxDiffLines: 200,
    sandbox: "e2b",
    preferredLabels: ["bug", "documentation"],
    firstIssues: [],
  },
  {
    id: "kortix-ai/suna",
    owner: "kortix-ai",
    name: "suna",
    wave: 1,
    language: "TypeScript",
    aiPolicy: "unknown",
    policyNotes: "Open-source general agent. Policy must be parsed live. Docs/examples only until proven.",
    testCommand: "npm test",
    maxFiles: 4,
    maxDiffLines: 180,
    sandbox: "e2b",
    preferredLabels: ["documentation", "good first issue"],
    firstIssues: [],
  },
  {
    id: "mastra-ai/mastra",
    owner: "mastra-ai",
    name: "mastra",
    wave: 2,
    language: "TypeScript",
    aiPolicy: "human-required",
    policyNotes:
      "Used by HeyCMO. Wave 2 — larger surface. HUMAN attest always. No drive-by refactors.",
    testCommand: "pnpm test",
    maxFiles: 4,
    maxDiffLines: 160,
    sandbox: "e2b",
    preferredLabels: ["good first issue", "documentation"],
    firstIssues: [],
  },
  {
    id: "All-Hands-AI/OpenHands",
    owner: "All-Hands-AI",
    name: "OpenHands",
    wave: 2,
    language: "Python",
    aiPolicy: "human-required",
    policyNotes:
      "Coding-agent runtime. HUMAN: markers in contributing docs. Treat as human-required even if a patch is tiny.",
    testCommand: "poetry run pytest",
    maxFiles: 3,
    maxDiffLines: 140,
    sandbox: "e2b",
    preferredLabels: ["good first issue"],
    firstIssues: [],
  },
];

export function repoById(id: string): AllowlistedRepo | undefined {
  return ALLOWLIST.find((r) => r.id === id);
}

export function isDenied(id: string): { id: string; reason: string } | undefined {
  return DENYLIST.find((d) => d.id.toLowerCase() === id.toLowerCase());
}

export function waveLabel(wave: Wave): string {
  if (wave === 0) return "Wave 0 · own";
  if (wave === 1) return "Wave 1 · allowlisted";
  return "Wave 2 · adjacent";
}
