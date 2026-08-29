# Operations

## Daily

- `node --experimental-strip-types factory/cli.ts status`
- `node --experimental-strip-types factory/cli.ts reconcile` — absorb merges/closes; read any `DIVERGENCE` lines (doctrine events, resolved by hand, never auto-rewritten)
- `node --experimental-strip-types factory/cli.ts witness-check` — on a new machine, or after a toolchain change, before anything is in flight ([Witnessing on the host](#witnessing-on-the-host-wave-0))
- Answer any review thread before running another tick.
- Approvals record who attested: `approve <id> --note … --by <name>` (or set `FOUNDRY_OPERATOR`).
- If a maintainer replies “please stop,” remove the repo the same hour.

## What the clock actually verifies

`factory/verify-ledger.ts` (the 6h job) checks the **committed seed** — `factory/seed.ts`, the
published ledger — against live GitHub. It does **not** read `.foundry-state.json`: that file is
gitignored and absent in CI, so it does not exist to be checked. It prints two kinds of line and
fails the run on only one of them — [What stops the clock](#what-stops-the-clock) below says which,
and why the other never gates.

The guarantee is therefore: *what this repository publishes about its PRs is true.* It is not:
*what the operator has in flight locally is true.* Two consequences:

1. **Promoting live state into the seed is an explicit human step.** Nothing does it automatically.
   After a status change lands (a sync, a merge, a park), hand-edit `factory/seed.ts` and regenerate
   the block in `docs/12-ledger.md`. Until you do, the clock is verifying the older story.
2. **The local pre-flight is `status`.** It compares the live state file against the committed seed
   and prints `SEED DRIFT …` per packet that differs. Drift is not an error — it is the list of
   promotions you owe the seed.

`reconcile` is the other half: it absorbs live GitHub into local state and prints `DIVERGENCE …`
for anything a human must resolve. Neither command rewrites doctrine on its own.

## Witnessing on the host (Wave 0)

`evidence` clones the repo and runs its `testCommand` twice. Two things about *how* it runs it are
load-bearing enough that an operator should not have to read `factory/witness.ts` to learn them.

**The shell is `bash -c` — non-login, non-interactive, inheriting the environment the CLI was
started with.** Not the operator's `$SHELL`, and deliberately not a login shell:

- A login shell (`bash -lc`) sources `/etc/profile`, and on macOS that runs `path_helper`, which
  rebuilds `PATH` from `/etc/paths` with `/usr/bin` ahead of everything the operator installed —
  even against an explicit `PATH=…` on the invocation. The witness then ran `/usr/bin/python3`
  (3.9.6) while the operator's own shell had 3.14.x, `ravidsrk/orca-fleet`'s suite died on
  3.10-only syntax at head, and the refusal was indistinguishable from a bad patch (issue #41).
- `$SHELL -c` is not a contract: zsh, fish and nushell differ on `-c`, and their rc files are the
  operator's to change. `bash -c` is the same shell on every machine the factory runs on.

So: whatever `python3` your terminal resolves is what the witness resolves. A repo that needs more
than that declares it as `setupCommand` in `allowlist.yaml`, where it is visible, rather than
relying on a profile nobody reads.

**Pre-flight before a packet is in flight.**

```
node --experimental-strip-types factory/cli.ts witness-check [repoId]
```

It resolves each allowlisted repo's `testCommand` through that same shell and prints the tool, the
absolute path it selects and its version — so an interpreter mismatch is a line of output rather
than an evidence-time refusal. It resolves in the current working directory, and says so: a repo
that pins its own interpreter (`.python-version`, `.tool-versions`, `.nvmrc`) may select a
different one inside the clone, which is why the witness records what it *actually* used
(`witness.toolchain`, docs/10-schemas.md). Sandboxed repos are named but not resolved — their
suites run on the worker host, not here (ADR 0003).

**Both run failures print their run.** A red-at-head refusal and a failed negative control carry
the resolved command, the toolchain, and the last 40 lines of the run. If a run produced no output
at all the refusal says that too, and points at `witness-check` — a command that dies before
printing anything is usually the environment, not the patch.

## Stopping the factory

Three mechanisms, in descending scope. They are not interchangeable — know which one is in force.

**1. Factory halt (durable, automatic, factory-wide).** A GitHub **secondary rate limit** during
`open-draft` writes a halt into the ledger (`halt` on the state record) and prints the halt banner.
SPEC.md §6 is "halt the factory, never retry", so the halt is factory-wide, not per repo, and it
persists across runs: `maySelectRepo` refuses every repository — tick, approve, and open-draft
included — until a human runs `clear-halt --by <name> --note <text>`. It is not a scorecard
`banned` tone: `bans` counts maintainer asks, and a platform throttle is not a maintainer saying
stop. Nothing sets this halt by hand; only the rate-limit path writes it.

**2. Scorecard stop (durable, per repo).** A repo with scorecard health `stop` cannot be queued or
approved. Every other allowlisted repo keeps running. This is the one an operator writes by hand:
`halt <repoId> --reason <text>` is the same-hour stop for "a maintainer said stop". It sets that
repo's scorecard tone to `banned` (`applyHalt`), counts a ban, and parks that repo's in-flight
packet. `clear-halt` does **not** undo it — that lifts the §1 factory halt only, and no command
lifts a `banned` tone. Denylist the repo in `allowlist.yaml` the same hour, per the incident drill
below.

**3. Operator stand-down (procedural, factory-wide).** Nothing writes the §1 *factory* halt by
hand, and §2's `halt` stops one repo per invocation, so a deliberate full stop across the factory
is still a procedure: reject the in-flight packets and stop pressing tick. The GHA default is dry
(`FOUNDRY_LIVE` unset), so the 6-hour clock does not open PRs on its own.

## Tick cadence

Every 6 hours, **or** operator `tick`. Never both overlapping. One packet in flight, including `submitted`.

## Current (2026-08-29)

1. Wave 0 attested 2/2: [orca-fleet#70](https://github.com/ravidsrk/orca-fleet/pull/70), [orca-fleet#72](https://github.com/ravidsrk/orca-fleet/pull/72).
2. [frontguard#196](https://github.com/ravidsrk/frontguard/pull/196) merged by `ravidsrk`. Do not repeat operator-merge on a Foundry packet.
3. Wave 1 in flight: [ColeMurray/background-agents#1652](https://github.com/ColeMurray/background-agents/pull/1652) — **ready for review, not draft**, as of the 2026-08-29 sync; marked ready by `ravidsrk` at 2026-08-28T18:09:24Z. Do not repeat ready-for-review on a Foundry packet. Follow up. Do not merge. Do not tick.
4. #1652's evidence was witnessed at `48c2242`; the branch is at `6b6ff04`. A re-witness is owed — the clock says so every tick and will not stop until someone re-runs it.

## What stops the clock

`verify-ledger` runs on every tick, over the committed seed as above. It reports two different
things and gates on only one.

- A **divergence** is the published ledger asserting something GitHub contradicts: a draft flag, a
  recorded head, a merge the ledger has not absorbed. It exits non-zero and **reds the default
  branch**. That is deliberate — SPEC.md §7 makes divergence a doctrine event, and a red branch is
  the loudest surface available. It also means one click in a browser this factory does not control
  can red `main`, and only a human editing the seed can green it again. Know that going in: the
  clock measures a live system it has no authority over. Resolve a divergence by deciding what is
  true and syncing the seed, or by changing the live state. Never by relaxing the check.
- An **advisory** is a debt on a seed that already reconciles. It prints on the same terminal and
  exits 0. Today there are exactly two, both on #1652:
  1. Its evidence covers `48c2242` and the branch has moved to `6b6ff04`. No commit to this
     repository can clear it — only a sandbox re-run against the upstream branch can.
  2. Its body carries the disclosure block as recorded at open, which ADR 0004's
     `(ravidsrk/oss-foundry)` qualifier moved past. No commit here can clear that one either: the
     only cure is editing a pull request on a repository this project does not own, which is an
     outward-facing write needing an explicit operator go. Already-open PRs are grandfathered and
     flagged, never re-stated as matching — the policy is beside the constant in
     `factory/neighbor.ts` (issue #38).

  Both share the shape that decides the bucket. Gating CI on either would leave `main` red for days
  with nothing mergeable that fixes it, which is the precise pressure that gets an evidence SHA
  re-stamped by someone who never re-ran the tests — or, here, a disclosure constant quietly
  re-worded to match one old body. The signal is louder when it is honest than when it is fatal.
  What the clock *can* enforce is the moment of contact, and does: `open-draft` and
  `attach-draft` both refuse a body without the verbatim block before a PR is ever bound.

## Metrics that matter — operational definitions

Silence is the modal outcome for external agent PRs, so every KPI names its denominator.

- **Merge rate** = merged / opened drafts that reached a terminal state. There are exactly **two**
  terminal buckets — `merged` and `closedUnmerged` (`terminalCount` in `factory/scorecard.ts`); there
  is no third "stale-closed" field, and earlier wording here implied one. A draft the quiet-day rule
  has aged is *not* terminal by itself: at 45 quiet days it gets a stale-intent note, and it enters
  the denominator as `closedUnmerged` only once a human actually closes it and `sync` observes the
  close. So a stale draft that a human closes does count **against** the rate; one nobody ever closes
  stays out of the denominator, along with any draft still open and in follow-up.
- **Review-comment average** = mean **human, non-bot** review comments, computed **only over PRs
  with ≥ 1 human review comment**. The `noReview` counter is reported beside it — opened drafts that
  reached a terminal state with **zero** human review activity (a still-open silent draft is not yet
  counted; the silent share is `noReview / terminal outcomes`, the same denominator as merge rate).
  A low average from silence is not a low average from clean work.
  - **Human review activity** = at least one review (a bare approval counts) **or** at least one
    review comment, from a non-bot account. The two are counted separately, so a maintainer who
    approves without typing anything is *not* `noReview` and is *not* in the average's denominator
    either. Both are read at the terminal transition, from `GET /pulls/{n}/reviews` and
    `GET /pulls/{n}/comments`; the PR object's own `review_comments` total counts bots and names no
    author, so it is recorded but never used as the metric.
  - **Non-bot** = GitHub's `user.type` is not `Bot`, the login does not end in `[bot]`, and the
    login is not on `KNOWN_REVIEW_BOTS` (`factory/github-pr.ts`) — the short roster of review bots
    this project has actually met, kept because a GitHub App installed as an ordinary account
    carries neither of the first two signals. Substring matching is not used: a person may be
    called `robotnik`.
  - When the review endpoints cannot be read, the counters do **not** move and the ledger records
    that they could not be computed. "We could not read it" is not "nobody reviewed it".
  - **And that gap is recoverable, exactly once.** The counters are written on the terminal
    transition — the tick that absorbs the merge or the first close — and that transition happens
    once. A packet whose review endpoints were down for that one request used to be stranded at "not
    observed" permanently, with its terminal outcome silently outside `noReview`'s denominator:
    `applyPrSync` refuses a merged packet, so `sync` could not retry it, and nothing read the field
    afterwards. `reconcile` now folds a later observation in, once, guarded on the packet's own
    stored `prMeta.humanReview` — these are cumulative counters and a fold that ran every tick would
    inflate them on its own. Until it is recovered, both `reconcile` and the clock print an
    **advisory** naming the packet, because a rate over a population nobody was told was short is
    the same defect as a zero nobody observed.
- **Time-to-quiet** = open → last human activity (comment, review, or push).
- **Revert** = an explicit `git revert` of our merge commit, or a maintainer-stated rollback naming
  the PR, within 30 days of merge. Post-merge edits/refactors of our code are **rework**, tracked as
  informational notes, never counted as reverts.
  - The definition has two halves and so does its enforcement. The **mechanical** half — a commit on
    the base branch whose message says `This reverts commit <our merge commit>` inside the 30-day
    window — is found without a human: `verify-ledger` (the 6-hour clock) fails the run while the
    ledger still records no revert, and `reconcile` records it and stops the repo. The **prose**
    half — a maintainer-stated rollback — is `revert <packetId> --reason <text> [--at <iso>]`, where
    the reason is mandatory and stored verbatim. Nothing else can set `reverts`, and one revert is
    counted per packet: `health()` already stops the repo at one, so a second would only inflate the
    number.
  - **Both halves date the window from the EVENT.** "Within 30 days of merge" is a fact about when
    the rollback happened, not about when anybody wrote it down, and the two halves share one
    predicate (`revertWindow`) precisely so they cannot disagree about it — but a shared predicate
    only agrees if it is handed the same subject. The mechanical half passes the reverting commit's
    `committedAt`; the prose half passes `--at`, which defaults to now for an operator recording a
    rollback as it happens. An operator writing up a day-10 rollback on day 35 passes `--at` with
    day 10; without it the same rollback would be refused as out of window while `reconcile` would
    have recorded it, which is the SPEC.md §7 MUST going unsatisfied with no path to satisfy it.
    A `--at` typed with nothing after it is **refused**, not read as "now": `undefined` is what the
    argument parser returns for both "no flag" and "flag at the end of the line", and defaulting the
    second to the moment of typing would reach this exact failure through the flag that exists to
    avoid it. Omit `--at` to mean now; say so by omitting it.
  - The mechanical half reads `GET /repos/{o}/{r}/commits?since=<mergedAt>&until=<mergedAt+30d>`
    **through GitHub's own `Link: rel="next"` cursor**, up to a cap of 10 pages (1000 commits).
    GitHub serves commits newest-first, so a single-page read hides the window that opens *at the
    merge* — the window a revert is most likely to land in. If the cap is reached, the check says so
    as an advisory rather than reporting a clean base branch: a capped read and a complete one
    otherwise return the same verdict, and a short read that reads as `ledger ok` would silently
    disable the halt above.
  - **Both ends of the window are bounded, and the far end is the classifier's own deadline.**
    `since` alone reads `[merge, now]`, which grows a day every day and never closes, while a revert
    past 30 days is discarded anyway — so the extra pages are fetched and thrown away, and on a busy
    base branch the read eventually exceeds the cap and emits a truncation advisory *forever*, about
    a window that closed a month earlier and that nothing can clear. `until` makes the read a fixed
    width from the day it opens. There is deliberately no expiry on the re-check itself: with the
    bound in place it is cheap, and an expiry would mean a revert first observed after day 30 — with
    the clock down, say — is never seen at all.
  - **Clearing a revert the clock has found takes a seed edit.** `reconcile` and `revert` write
    `.foundry-state.json`, which is gitignored and which `verify-ledger` never reads — it reads the
    committed seed. Record the revert with those verbs, then promote it into `factory/seed.ts` and
    regenerate the block in `docs/12-ledger.md`. Do **not** reach for `allowlist.yaml`: scorecard
    rows are built from the roster, so removing a repo there deletes the row that holds `reverts`
    and destroys the record instead of clearing it.
- **Bans** (must stay 0) = scorecard tone `banned`: a maintainer asked the factory to stop.

PR volume is a vanity metric and is not shown as a success KPI.

## Incident: slop accusation

1. Convert the PR to draft or close it.
2. Apologize on the thread. Do not argue.
3. Move the repo to denylist.
4. Write a scorecard event with tone `banned`.
5. Do not open another external PR for 14 days.
