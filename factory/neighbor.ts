export const DISCLOSURE = `This patch was prepared by Foundry (ravidsrk/oss-foundry), an operator-gated contribution factory.
A human reviewed the packet, the diff, and the tests before this draft was opened.
The factory does not merge. Maintainers own the merge.`;

/**
 * Where Foundry's own tree lives (docs/PRODUCT.md). The evidence page is written for an upstream
 * maintainer who has their checkout, not this one, so anything the page asks them to go look at has
 * to say which repository it is in.
 */
export const FOUNDRY_REPO_URL = "https://github.com/ravidsrk/oss-foundry";

/** Per-repo commit-disclosure convention. `Co-authored-by` designates a person in Git's reading — never an agent. */
export type DisclosureTrailer = "assisted-by" | "generated-by" | "pr-body-only";

export function commitTrailerLine(convention: DisclosureTrailer): string | undefined {
  if (convention === "assisted-by") return "Assisted-by: Foundry";
  if (convention === "generated-by") return "Generated-by: Foundry";
  return undefined;
}

export const AGENT_NAME_RE = /foundry|claude|copilot|cursor|devin|codex|gpt|openai|anthropic|\bbot\b/i;

export const ABORT_DEFAULT = [
  "Policy gate flips to forbidden or unknown.",
  "An upstream PR already covers the issue.",
  "Scope exceeds maxFiles / maxDiffLines.",
  "CLA/DCO needs a human signature.",
  "Maintainer asks the factory to stop.",
  "Tests cannot be run, or the negative control does not go red on revert.",
];

export const NON_GOALS_DEFAULT = [
  "Refactors adjacent to the issue.",
  "Dependency bumps.",
  "Drive-by lint/format of unrelated files.",
  "Alternative PRs that compete with a maintainer patch.",
  "Closing keywords on RFC/meta/tracking issues.",
];
