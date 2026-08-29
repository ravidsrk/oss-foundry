/**
 * The disclosure block. SPEC.md §6: the PR body MUST carry it "verbatim and unabridged".
 *
 * Enforced at the moment of contact on BOTH create paths — `open-draft` refuses a body without it
 * before its POST (`factory/cli.ts`), and `applyAttachDraft` refuses one before it binds a PR a
 * human opened in a browser (`factory/engine.ts`, the path the App's 403 keeps alive; see
 * docs/07-github-app.md). Contact is the last moment the block can still be got right for free.
 *
 * ## Changing this constant (issue #38)
 *
 * A change here cannot reach a pull request that is already open. The body upstream is a fixed
 * artifact on someone else's repository; the only thing that can move it is an edit made there,
 * which is an outward-facing write and needs an operator's explicit go. So a change to this text
 * silently splits the world into PRs that carry the new block and PRs that carry the old one, and
 * the policy for the old ones is:
 *
 * 1. **They are grandfathered.** Their bodies stand as recorded at open. Nothing in this tree
 *    rewrites the record to claim they match the new text, and nothing back-dates the constant.
 * 2. **They are flagged, not falsified.** `packetChecks` (`factory/ledger-check.ts`) diffs the
 *    live body against this constant for every still-live packet and reports a mismatch as an
 *    ADVISORY on every clock tick, forever, until an authorised operator edits the upstream body.
 *    Advisory and not fatal for the reason the re-witness debt is advisory (issue #49): no commit
 *    to this repository can clear it, and reddening the default branch over a debt no merge can
 *    pay is the pressure that gets records re-stamped instead of re-derived.
 * 3. **Every doc that claims a live body matches must be re-dated, not left in the present
 *    tense.** "Verbatim as recorded at open" is the honest form once the constant has moved past
 *    a body; "verbatim disclosure in body" is not.
 *
 * Precedent: ADR 0004 added the `(ravidsrk/oss-foundry)` qualifier while
 * ColeMurray/background-agents#1652 was open. That PR's body still reads the unqualified line, the
 * clock now says so every tick, and docs/PRODUCT.md §8 records it as a drift rather than a match.
 */
export const DISCLOSURE = `This patch was prepared by Foundry (ravidsrk/oss-foundry), an operator-gated contribution factory.
A human reviewed the packet, the diff, and the tests before this draft was opened.
The factory does not merge. Maintainers own the merge.`;

/**
 * Everything after the first line — the part ADR 0004's qualifier did not touch.
 *
 * Used for one thing only: telling "this body carries a Foundry disclosure that is no longer the
 * current block" apart from "this body carries no Foundry disclosure at all" when reporting a
 * drift. Those are different things for an operator to do, so they must not print the same line.
 * Derived from `DISCLOSURE` rather than written out again, so a second literal cannot rot away
 * from the first; it is never a substitute for the verbatim check, which is always the whole block.
 */
export const DISCLOSURE_TAIL = DISCLOSURE.split("\n").slice(1).join("\n");

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
