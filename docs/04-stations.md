# Stations

Four working stations plus freeze, draft, and follow-up. Mapped onto `oss-contribute` so we do not invent a second pipeline.

## 1. Scout

Input: allowlist + open issues + open PRs (both denominators).

Does:

- Drop denylist, RFC/meta/tracking, issues with an in-flight maintainer PR.
- **Is the target still open?** (`fetchIssueState` → `issueStandDownReason`.) Read first because it
  is the more decisive fact — *not* to save requests. Refusing on it does skip the competing-work
  timeline call, but the refusal message then spends the identical timeline GET, so the saving is
  zero: the check costs **+1 GET per named `firstIssues` row, unconditionally**, closed rows
  included (measured live over the four named rows: a full tick went 15 requests → 19).
  Competing-work detection sees only OPEN pull requests, so once someone else's fix merges the PR
  closes, the issue closes, and the verdict returns to `clear` — indistinguishable from an issue
  nobody has touched. A closed issue is **skipped, never consumed**: nothing is written against it,
  the ledger records the reason, and a reopen makes the row selectable again with no hand edit. The
  same check re-runs at `approve` and at `open-draft`; a number that turns out to name a pull
  request is refused there too. A read that does not answer fails closed. (issue #40)
- Competing-work verdict is two-tier (`classifyCompetition`): **competing** = a closing-keyword PR
  or an open PR the issue's GitHub timeline cross-references → stand down; **adjacent** = a plain
  textual mention or an issue-numbered head branch → taste gate, held for human triage, never
  silently scouted. The same check re-runs at `approve` (freeze), at `open-draft` and at
  `attach-draft` — a competitor that appeared since gating refuses the approval, the open or the
  attach; an adjacent mention at freeze is surfaced to the human doing the freezing, who is the
  taste gate.
- Heuristic score: wave, labels, size, freshness.
- Never invent issue numbers. If every named `firstIssues` row is consumed or blocked, the tick **idles**.

Output: at most one candidate. Clock / CLI skip if anything is in flight (`gated` … `submitted`).

## 2. Policy gate

Input: candidate + `AGENTS.md` / `CONTRIBUTING` blob + the repo's committed policy record
([`policy-records.json`](../policy-records.json) — quoted verbatim, dated, with source path).

The scanner matches policy **statements**, not topic words: a ban pairs an AI subject with a
contribution object and a refusal verdict inside one sentence-sized window. A repo whose docs
merely *discuss* autonomous agents is not banning them.

**The scanner is a high-recall suggester feeding a human gate, not a sufficient arbiter.** Its miss
mode is real, and stated here rather than left to be inferred: a phrasing nobody has written a
pattern for reads as silence. Nine paraphrases of real maintainer ban language were run through it
and seven reached `ALLOW` (issue #37). The matcher work from that issue is **parked** — three review
rounds failed on it and the unit hit its cap — so this page describes the scanner as it actually is,
not as the fix would have left it.

Be exact about what catches a miss, because the two guards cover different cases and only one of
them covers this one. **Deny-by-default covers the no-evidence case, not the missed-ban case.** A
repo with nothing fetched and no affirmative record is `DENY_UNKNOWN_POLICY` and never `ALLOW` — but
`hasParsedEvidence` is satisfied by *any* fetched document, so a `CONTRIBUTING` whose refusal the
scanner cannot read is evidence the gate counts, and **a missed ban on a fetched document reaches
`ALLOW`.** Verified, not assumed, and pinned in `factory/policy.test.ts` ("deny-by-default covers the
no-evidence case, not the missed-ban case"): three ban phrasings the scanner does not match, supplied
as fetched docs, each returned `ALLOW`; the same packet with nothing fetched, and the same packet
with a fetch that came back empty, both returned `DENY_UNKNOWN_POLICY`. The freeze (§3) is the only
thing standing there. That is precisely why it is now shown the parsed text — the operator reading
the maintainer's own words is the guard against a scanner miss, and the gate's default is not.

The over-block direction is a real cost too, not a free safety margin. `DENY_FORBIDDEN` is terminal
and there is no in-tool operator override, so a false positive is not a one-look correction at the
freeze; it is an allowlisted repo the factory cannot work with until a human edits
`factory/policy.ts`. Most of `allowlist.yaml` is agent and MCP infrastructure — `background-agents`,
`awesome-copilot`, `e2b-cookbook`, `mcp-use`, `mastra`, `OpenHands`, `orca-fleet` — whose docs use
`agent`, `bot` and the brand words as ordinary vocabulary rather than as the subject of a refusal.
That is why broadening recall here is not the cheap change it looks like, and why it was parked
rather than half-landed.

Precedence: record `forbidden` → scanned
ban statement → CLA/DCO (from scan or record conditions) → record conditions → unknown-without-
evidence. A `silent` record ("parsed, found nothing") does **not** satisfy parse-policy-first for
an `unknown` repo — absence is re-verified by a live fetch; affirmative records (welcome /
conditional / forbidden) carry a quote and do.

Codes:

| Code | Meaning |
|---|---|
| `ALLOW` | May enter freeze. |
| `DENY_FORBIDDEN` | Ban-list or “no AI PRs.” Terminal. |
| `DENY_UNKNOWN_POLICY` | Fetch docs and retry. Terminal until parsed. Also unlisted repos. |
| `HOLD_CLA` | Park `needs-human`. Never forge. |
| `HOLD_HUMAN` | Wave 2 / HUMAN: markers. |
| `HOLD_SCOPE` | Caps or RFC shape. |

The gate is deterministic. Grok does not get a vote here. There is no demo CONTRIBUTING corpus.

## 3. Freeze (human)

The operator reads the packet: objective, non-goals, acceptance, abort, policy, scout.

`approve` prints the policy text the gate parsed *before* it takes the attest, for whatever packet
the operator names — each fetched document with its name and character count, the `policyNotes` and
committed record that were also in the scan blob, and either the statement the scanner matched or
an explicit "no ban statement matched in N chars from <source>". A packet with nothing fetched is
told so as an absence and the scan line is withheld: "no ban statement matched" over zero characters
of policy text is the most misleading thing this surface could say, and absence is therefore counted
in **characters**, not in documents — a `CONTRIBUTING` that was fetched and came back empty produces
a document record and would otherwise take the scanned branch. The print happens before the
competing-work network reads, so a stand-down or an unreachable GitHub cannot swallow the one thing
the human is there to read. The documents ride on the packet (`policyDocs`, excerpt-capped with the
true size recorded), so what the operator reads is the text the verdict was actually computed from
and not a re-fetch. Before issue #37 `buildPacket` forwarded those documents into `evaluatePolicy`
and discarded them, which left the second layer of defence confirming a boolean about text it could
not see.

Actions: `approve` (attest) or `reject` (stand the packet down — it writes status `rejected`, not `parked`; see below). Denied, halted, and unlisted packets cannot be approved. Approve re-runs the competing-work check SPEC §4 requires, and reads the issue's own state alongside it: either a competitor that appeared since gating or an issue that closed since gating blocks the approval; an adjacent mention is shown to the approver. Neither *parks* the packet — the freeze is the human's, so a refusal hands the decision back rather than making it, and `reject` stays the operator's verb.

`reject` has its own scope. A `merged` packet **cannot** be rejected: it is terminal and already counted toward `mergedTotal` and the attested Wave 0 merges, so a late reject would desync the promotion gate from the ledger. A `submitted` packet **can** — that is the documented halt-everything path (`docs/08-operations.md`) — but reject does not close the PR, so when the packet names a live PR the CLI prints an `open pr:` warning naming it and the packet record says which PR was left open. Until a human closes it, `reconcile` keeps flagging it as an abandoned live PR.

The first 20 factory-wide approvals decrement a visible counter (`humanApprovalsRemaining`, printed by `status`). It is an odometer on the first-20 freeze budget, not a gate that ever opens: **no packet auto-freezes, at any wave, at any count.** Nothing reads the counter as a condition and there is no `autoFreeze` code path. An earlier draft of this page promised Wave 0 auto-freeze at zero when policy was `owner` and lighting stayed `lit`; that mechanism was never built, and the claim is deleted rather than implemented — building it would weaken a human gate that is currently doing its job (issue #44 item 1).

`approve` accepts a packet in status `gated` or `frozen`, but no code path ever *writes* `frozen`: packets go `gated` → `approved` on the operator's attest. `frozen` is reserved in `PacketStatus` and counted as in-flight so that a future explicit freeze step — one that separates "the human has read it" from "the human has attested it" — can land without a state migration. Until that step exists, reading `frozen` in a committed ledger means the file was hand-edited.

## 4. Implementer

Worker in a fresh worktree (Wave 0) or E2B box (else). One playbook pack. Failing-first. No coordinator chat in the trace that the reviewer will see.

The CLI dry-run **plans** sandbox commands. It does not stamp `harvested` with exit 0.

## 5. Independent reviewer

Build-blind. Sees the diff, the test command, the negative control. Does not see the implementer’s chain of thought. Reviewed SHA must equal head SHA at draft time.

Evidence is attached by the operator (`attachEvidence`), from a run the operator did not perform by
hand: `evidence` witnesses on the host (Wave 0 only), and `attach-witness` ingests a manifest
produced on the worker host (Wave 1+). The engine will not invent `deadbeef` SHAs or auto-set
`red-on-revert`, and it refuses a witness whose provider is illegal for the repo's sandbox, or whose
bound repo/range — or pair of log paths — is not this packet's own. Provenance is settled at the
gate, not by CLI convention.

Binding is two-tier, and the tiers differ on purpose. A **commit range** only has to *reference*
the packet's issue — `#71`, `ravidsrk/orca-fleet#71`, the issue URL, or the `(issue #71)` form this
project's own merged Wave-0 range uses. A **PR body** must carry a real GitHub *closing keyword*,
because that is the text GitHub's auto-close semantics actually read; `applyAttachDraft` enforces
it there and nowhere else. Neither tier binds a foreign `other-owner/other-repo#71`, a longer
number (`#710`), or an issue URL that merely starts with this one's. The range check runs *before*
`witnessEvidence`, on the messages `compareCommits` already returned, so a mis-bound range is
refused without a clone or a test run — the same pre-check discipline as the 40-hex SHA guard.
`applyAttachEvidence` repeats it, because the reducer is the authority and `attach-witness` reaches
it with no pre-check at all.

## 6. Draft

Opens a **draft** PR from the operator fork to upstream default. Body is generated by `renderPrBody`. The create helper hard-codes `draft: true`. Human marks ready when CI is green.

`open-draft` re-reads the issue's live state before the create, because a check at selection goes
stale: an issue can close while a packet is in flight, and this is the last moment the contact can
still be called off. `attach-draft` deliberately does **not** gate on it — the pull request already
exists there, and refusing to record it would leave a live PR the ledger has never heard of.

That sits in tension with the competing-work check, which *does* refuse at `attach-draft` (§1) and
so creates exactly the orphan described above. The resolution is not to copy it: the orphan is the
older bug — it is the abandoned-live-PR hole `packetChecks` exists to surface (issue #34) — and a
second path into it is not worth adding for a fact that changes nothing now the PR exists.

## 7. Follow-up / scorecard

A draft PR is not done. The packet stays on this station until merged, closed, or quiet.

Does:

- Sync the live PR (draft/open/merged, head SHA, review comment count). User-initiated. Never on load.
- Record bot-reconcile and review-reply notes against the current head. `review-reply` is a reply
  that was **made**; a reply still **owed** — maintainer activity arriving while another packet
  holds the in-flight slot — is a `note` prefixed `reply-owed:`, the same shape as `stale-intent`
  (the shape only; `stale-intent` is deduped, a reply owed is not).
- Mark quiet when threads are answered. **Never merge.**
- When GitHub reports `merged`, write the scorecard `merged` row. When closed unmerged, write `closedUnmerged`.

Halt rules fire here. See `docs/06-v2.md`. `submitted` remains in-flight so a quiet-but-unmerged draft still blocks a new tick until `followed-up`.

Quiet-day rule (ADR 0002, enforced by `applyPrSync`, driven by the operator CLI:
`sync <packetId> [--threads-answered]` — the flag is the operator's attestation that every review
thread has a reply): once threads are answered and the PR has been quiet ≥ **14 days**, sync moves
the packet to `followed-up` and the slot frees — the factory is bounded by discipline, not by
maintainer latency. New maintainer activity on a `followed-up` packet moves it back to `submitted`
(answer before any new tick) — **unless a newer packet already holds the in-flight slot**, in which
case the older packet stays `followed-up` and records a `reply-owed:` note rather than doubling the
in-flight count. Nothing else nags about that reply — no tick was blocked and no thread was closed —
so `status` prints it under the packet rather than leaving it buried in the ledger; answering is a
human act and the note is a permanent record of the arrival, not a checkbox the engine clears. One
note per arrival, not one per packet: each new maintainer comment owes its own reply. At ≥ **45 quiet days**
sync records a `stale-intent` follow-up note (deduped — the staleness is one standing fact);
the close itself is a human act, and the scorecard's `closedUnmerged` row is written once, on the
actual open→closed transition — never for a still-open draft, which is not a terminal outcome
(docs/08-operations.md). Quiet days derive from GitHub's `updated_at`, which any activity bumps —
bot noise can defer a release but can never release early; conservative by design.

Live follow-up: [orca-fleet#70](https://github.com/ravidsrk/orca-fleet/pull/70) — Greptile future-dated the 0.5.0 heading; Foundry folded it to `2026-08-26` (`d91fe2f`) and resolved the thread. **Merged** by the maintainer 2026-08-27.

In-flight: [ColeMurray/background-agents#1652](https://github.com/ColeMurray/background-agents/pull/1652).
