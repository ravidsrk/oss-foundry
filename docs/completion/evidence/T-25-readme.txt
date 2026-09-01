T-25 / G-03 — README stranger path (nine failures).

Branch: ravidsrk/p6-readme
Base: origin/main c99541b9be09f47277a152819411ce52661de0a2
Docs-only: README.md, CONTRIBUTING.md. No production behaviour changed.

Negative control: `git show origin/main:README.md` still has the nine holes;
this branch does not.

Grep over origin/main README.md for
npm|clone|install|status|tick|approve|Node|foundry-state|FOUNDRY_|GITHUB_TOKEN
→ 4 hits, none a setup or command step:
  - oss-tick.yml (filename)
  - ## Status (heading, not the verb)
  - "tick walks each repo's named firstIssues" (behaviour, not how to run it)
  - "Node 22+:" under ## Tests, 19 lines below the operator-loop line
The words npm, git clone, install, status (as a command) and approve: ZERO.

================================================================
1. No clone step and no repo URL
================================================================
BEFORE: clone URL only in docs/PRODUCT.md header table.
AFTER: README "## Clone" and the header "Public repo" row:
  git clone https://github.com/ravidsrk/oss-foundry.git
  https://github.com/ravidsrk/oss-foundry

================================================================
2. Node floor only under Tests, and stated as "Node 22+"
================================================================
BEFORE: `## Tests` / `Node 22+:` — 19 lines below the operator-loop line.
        Wrong floor: the flag needs 22.6.0; the suite oracle needs 22.10.0
        (T-01: 22.9.0 refuses, 22.10.0 green).
AFTER: Node ≥22.10.0 sits in "## Clone", beside the first commands, with the
       one-clause reason (per-file test:summary, not the type-stripping flag).

================================================================
3. No install guidance; npm ci fails
================================================================
BEFORE: nothing. Only .github/workflows/ci.yml says there is no lockfile.
AFTER: "There is nothing to install. package.json declares no dependencies
       and this repo has no lockfile, so npm ci fails. `"private": true`
       is a publish guard on a public MIT repo, not a mistake."

Executed (worktree, no lockfile):
  $ npm ci
  npm error code EUSAGE
  The `npm ci` command can only install with an existing package-lock.json
  or npm-shrinkwrap.json with lockfileVersion >= 1.
  exit=1

================================================================
4. npm never mentioned; only raw node invocations
================================================================
BEFORE: operator loop = `node --experimental-strip-types factory/cli.ts`
        tests = same flag against factory/run-tests.ts
        `npm run foundry -- <cmd>` in no doc.
AFTER: header Operator loop = `npm run foundry -- <cmd>`
       first command / tick / tests all use the npm scripts
       (foundry, test, validate, typecheck named).

================================================================
5. No command list
================================================================
BEFORE: status, tick, approve, sync, reconcile, open-draft, events
        appear nowhere as verbs to type.
AFTER: "## Commands" table names all seven. `npm run foundry` with no args
       lists every verb (executed; 18 verbs, matches factory/cli.ts usage()).

================================================================
6. No explanation of .foundry-state.json
================================================================
BEFORE: first command prints
  no state file at … — showing the committed seed ledger, not live state
  and the README never mentions the ledger, the seed, or gitignored live state.
AFTER: "## First command" quotes that stderr line, names .foundry-state.json
       as the gitignored live ledger, factory/seed.ts + docs/12-ledger.md as
       the published record, and the fail-closed loader (missing → seed;
       malformed → refuse).

================================================================
7. No environment variables
================================================================
BEFORE: FOUNDRY_OPERATOR, FOUNDRY_PAT, GITHUB_TOKEN/GH_TOKEN, E2B_API_KEY,
        FOUNDRY_LIVE unnamed. T-24 put the full table in
        docs/01-architecture.md.
AFTER: header Env row links that table; README does not duplicate it.
       tick paragraph names GITHUB_TOKEN/GH_TOKEN as the optional rate-limit
       raise. approve row names FOUNDRY_OPERATOR. open-draft row names
       FOUNDRY_PAT.

================================================================
8. No link to the operator procedure or station model
================================================================
BEFORE: links PRODUCT.md, docs/ (bare directory, no index), allowlist.yaml,
        the clock, 06-v2, 12-ledger. Not 08-operations.md, not 04-stations.md.
AFTER: header Operator loop → docs/08-operations.md
       header Stations → docs/04-stations.md
       bare docs/ directory link removed.

================================================================
9. No statement of what tick actually does
================================================================
BEFORE: docs/12-ledger.md Next §5 "Idle until a named, witnessable first
        issue is added." README silent.
AFTER: "## What tick does today" — stands down each consumed firstIssues
       row, prints idle, exits 0. A new named first issue is a maintainer
       decision. tick writes .foundry-state.json even when idle.

================================================================
CONTRIBUTING.md
================================================================
BEFORE (14 lines): raw node test command; no npm test; no CI gate;
  "Draft PRs. Disclose agent help…" but no "branch off main".
AFTER: branch off main; draft PR; CI (.github/workflows/ci.yml) on every
  pull_request and every push to main, Node 22.10.0 and 24;
  npm test / npm run validate / npm run typecheck.

================================================================
Stranger Test rehearsal — fresh clone, README commands, no env
================================================================
Machine: Node v24.20.0. GITHUB_TOKEN/GH_TOKEN/FOUNDRY_PAT/FOUNDRY_OPERATOR/
E2B_API_KEY/FOUNDRY_LIVE unset. Scratch: /tmp/t25-scratch
Clone URL as the README writes it (origin/main c99541b — the commands
exist on main; this branch only documents them).

Start 2026-09-01T21:39:18+0530

$ git clone https://github.com/ravidsrk/oss-foundry.git
Cloning into 'oss-foundry'...
exit=0  elapsed=1.40s
HEAD=c99541b9be09f47277a152819411ce52661de0a2

$ npm run foundry -- status
exit=0  elapsed=0.15s
stderr:
  no state file at /private/tmp/t25-scratch/oss-foundry/.foundry-state.json — showing the committed seed ledger, not live state. Mutating commands will create it.
stdout:
  state: /private/tmp/t25-scratch/oss-foundry/.foundry-state.json (absent — committed seed)
  Foundry  packets=6 ticks=4 attestedWave0=3 inflight=false
  humanApprovalsRemaining=16 mergedTotal=3 bans=0
  in flight: none — tick is allowed
  scorecard:
    ravidsrk/orca-fleet  opened=2 merged=2 reverts=0 reviewCommentsAvg=1 tone=warm health=good
    ravidsrk/frontguard  opened=1 merged=1 reverts=0 reviewCommentsAvg=0 tone=warm health=good
    ColeMurray/background-agents  opened=1 merged=0 reverts=0 reviewCommentsAvg=0 tone=neutral health=good

FIRST CRITICAL FLOW (clone → status) = 1.55s

$ npm run foundry --
exit=0  elapsed=0.14s
  Foundry operator loop
  status / events / tick / approve / reject / halt / revert / advance /
  evidence / witness-check / attach-witness / body / attach-draft /
  open-draft / sync / reconcile / ledger / evidence-page / clear-halt
  (matches factory/cli.ts usage())

$ npm run foundry -- events
exit=0  elapsed=0.14s
  events: 9 (newest first; ring cap 80)
  (same no-state stderr as status)

$ npm run foundry -- tick
exit=0  elapsed=6.61s
stderr:
  no state file at … — showing the committed seed ledger, not live state. Mutating commands will create it.
  warning: GitHub reads are unauthenticated (neither GITHUB_TOKEN nor GH_TOKEN is set). Anonymous ceiling is 60 requests/hour against a documented ~19-requests-per-tick spend, so the fourth tick of an hour fails with 403. Authenticated PAT ceiling is 5000/hour. The token is not required; set GITHUB_TOKEN or GH_TOKEN to raise the ceiling.
  stand down: ravidsrk/orca-fleet#71 is closed by ravidsrk (https://github.com/ravidsrk/orca-fleet/pull/72) — it was already resolved. A PR on a closed issue is a surprise, not a contribution.
  stand down: ravidsrk/frontguard#195 is closed by ravidsrk (https://github.com/ravidsrk/frontguard/pull/196) — it was already resolved. A PR on a closed issue is a surprise, not a contribution.
  stand down: ColeMurray/background-agents#1476 is closed by ColeMurray (https://github.com/ColeMurray/background-agents/pull/1668) — it was already resolved. A PR on a closed issue is a surprise, not a contribution.
stdout:
  idle
  state: … (absent — committed seed)   # printStatus still carries mustLoad's source; the file WAS written
  Foundry  packets=6 ticks=5 attestedWave0=3 inflight=false
  … tick is allowed; three scorecard rows
Post-condition: .foundry-state.json exists, ticksRun=5. README says this.

$ npm test
exit=0  elapsed=9.65s
  suite ok — 418 tests across 20 files, every file accounted for
  ℹ tests 418 / pass 418 / fail 0

$ npm run validate
exit=0  elapsed=0.12s
  allowlist ok
  version 2 repos=8 denylist=4
  policy records ok: 8 records

$ npm run typecheck
exit=0  elapsed=1.47s
  added 3 packages, and audited 4 packages in 581ms
  found 0 vulnerabilities
  tsc --noEmit: 0 errors

STRANGER WALKTHROUGH wall-clock (machine, README commands in order):
  clone → status (first critical flow) = 1.55s
  clone → tick                         = 8.44s
  clone → npm test                     = 18.10s
  clone → all README-named commands    = 19.69s
Plan Stranger Test target ≤15 minutes. Rehearsal is 20 seconds of commands
on a short README; a human reading it and typing the same sequence stays
inside the gate.

Mutating verbs in the Commands table (approve / sync / reconcile / open-draft)
were not executed: they need a gated packet and/or FOUNDRY_PAT. They are
listed by `npm run foundry` with no args, which was executed.

================================================================
Negative control
================================================================
  git show origin/main:README.md | grep -c 'git clone'
    → 0
  git show origin/main:README.md | grep -c 'npm run foundry'
    → 0
  git show origin/main:README.md | grep -c foundry-state
    → 0
  git show origin/main:CONTRIBUTING.md | grep -c 'npm test'
    → 0
  This branch has all four. Restoring origin/main README + CONTRIBUTING
  restores the GTM hole; that is the guard.
