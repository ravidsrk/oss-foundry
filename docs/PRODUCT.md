# Foundry — Product Bible

Operator takeover document. This is the whole product: why it exists, how it runs, what has shipped, what is blocked, and what you do next.

| | |
|---|---|
| Public repo | https://github.com/ravidsrk/oss-foundry |
| Control plane | `factory/` TypeScript + `allowlist.yaml`. Operator loop: `node --experimental-strip-types factory/cli.ts` |
| Data plane | [ravidsrk/orca-fleet](https://github.com/ravidsrk/orca-fleet) `oss-contribute` |
| License | MIT |
| Status | Wave 0 **3** Foundry packets merged (2 attested promotion-gate merges on orca-fleet, plus frontguard#196). Wave 1 packet **in flight**: [ColeMurray/background-agents#1652](https://github.com/ColeMurray/background-agents/pull/1652) (open, **draft**, disclosure verbatim). |

---

## 1. One sentence

Foundry is an always-on, etiquette-correct **control plane** that decides *whether* an open-source contribution may exist. Orca / `oss-contribute` decides *how* the patch is built. Foundry never merges.

The product is not “open more PRs.” The product is **merged, etiquette-correct patches on an allowlist, with zero maintainer bans.**

---

## 2. Why this exists

2026 made unattended OSS agents radioactive:

- matplotlib banned autonomous-agent PRs after a slop incident
- curl maintainers asked agents to stop after a HackerOne flood
- pydantic welcomes AI-assisted PRs but bans mass submission across repos — the very pattern a contribution factory is
- drive-by volume without governance is vandalism

Foundry’s posture is the inverse: **contribute less, merge more, never surprise a maintainer.**

---

## 3. Hard constraints (absolute)

These cannot be relaxed by a tick, a prompt, or “just this once.” The factory engine refuses the packet.

1. **Allowlist only.** If a repo is not in [`allowlist.yaml`](../allowlist.yaml), it does not exist. YAML is the only source; `factory/` and the clock parse that file.
2. **Denylist is absolute.** `matplotlib/matplotlib`, `curl/curl`, `pydantic/pydantic`, `stablyai/orca`. No override in the CLI.
3. **One packet in flight.** `gated` / `frozen` / `approved` / `implementing` / `reviewing` / `draft-ready` / **`submitted`** blocks a new tick. `followed-up` is not in-flight.
4. **Draft PRs only.** Never merge. Never `--admin`. Never forge CLA/DCO. Never click Ready except as a human after CI is green. The create helper hard-codes `draft: true`.
5. **Disclose Foundry + human attest** in every PR body (verbatim block below).
6. **Parse policy first.** No `AGENTS.md` / `CONTRIBUTING` blob ⇒ `DENY_UNKNOWN_POLICY`. There is no canned welcome corpus. Unknown `aiPolicy` without fetched docs is deny.
7. **Wave 1+ in E2B** (or dry-run labeled as dry-run). Wave 0 may use a host worktree on repos we own. Secrets never enter the box.
8. **Stop the same hour** a maintainer asks (denylist + scorecard tone `banned`; scorecard = per-repo standing, see §5 — unrelated to OpenSSF Scorecard).
9. **Failing-first.** Test or repro is red before the fix. Revert must go red again. The engine does not stamp placeholder SHAs or auto-`red-on-revert`.
10. **Scope caps.** Per-repo `maxFiles` / `maxDiffLines`. Overflow = park.
11. **No competing PRs.** If upstream already has an open PR on the issue, assist or stand down.
12. **Follow up until quiet / merged / closed.** A rotting draft is still slop.

Promotion: Wave 1+ packets cannot be queued until **two Foundry-attested Wave 0 merges** exist (`status === "merged"` and `humanAttest` on a Wave 0 repo).

Scorecard halt: a repo with health `stop` cannot be queued or approved.

Disclosure block (verbatim; `factory/neighbor.ts` `DISCLOSURE`):

```
This patch was prepared by Foundry (ravidsrk/oss-foundry), an operator-gated contribution factory.
A human reviewed the packet, the diff, and the tests before this draft was opened.
The factory does not merge. Maintainers own the merge.
```

---

## 4. Architecture

```
 CLOCK (GHA 6h / operator tick)
        │  one packet at a time
        ▼
 ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
 │ 1 Scout     │ → │ 2 Policy    │ → │ 3 Freeze    │ → │ 4 Implement │
 │ heuristic   │   │ AGENTS.md   │   │ human only  │   │ sandboxed   │
 └─────────────┘   └─────────────┘   └─────────────┘   └──────┬──────┘
                                                              │
                       ┌─────────────┐   ┌─────────────┐      │
                       │ 7 Scorecard │ ← │ 6 Draft PR  │ ←  5 Review (blind)
                       │ halt rules  │   │ never merge │      │
                       └─────────────┘   └─────────────┘      │
```

| Plane | What | Stack |
|---|---|---|
| Control | Allowlist, policy, freeze, clock, scorecard, operator CLI | TypeScript in `factory/`, `allowlist.yaml`, Node 22+ |
| Data | Patch build, tests, evidence manifest | orca-fleet `oss-contribute` / Orca workers |
| GitHub | Fork → upstream **draft** | REST, User-Agent `oss-foundry`. Create helper is draft-only. **No admin. No merge.** |

Foundry does **not** replace Orca, Mastra, or HeyCMO. ADR 0001: extend, don’t replace.

There is **no** TanStack operator console in this repository. The freeze/tick/draft-body loop is the CLI.

### Trust boundaries

| Boundary | Rule |
|---|---|
| Allowlist | Unlisted = invisible |
| Policy | Forbidden phrases beat “but the issue is tiny.” No fetched docs = deny |
| Freeze | First 20 packets always human. Forever on CLA/DCO and Wave 2. Wave 1+ never auto-freeze |
| Sandbox | Wave 1+ clones never hit the operator laptop. Dry-run is labeled `dry-run`, not harvested |
| Reviewer | Blind to implementer traces. Diff + tests only. Reviewed SHA = head SHA at draft |
| GitHub | Draft only. No merge helper |

---

## 5. Stations

| # | Station | Does |
|---|---|---|
| 1 | Scout | Allowlist issues only. Drop denylist, RFC/meta, issues with an in-flight maintainer PR. Heuristic rank. Clock / CLI never invent issue numbers |
| 2 | Policy | Deterministic. Grok has no vote |
| 3 | Freeze | Operator `approve` (attest) or `reject` (park). Denied / halted packets cannot be approved. `merged` packets cannot be rejected — terminal, and a late reject desyncs the promotion-gate counters. Rejecting a `submitted` packet is the halt-everything path, but it never closes the PR: the CLI names the one left open |
| 4 | Implement | One playbook pack. Failing-first. Wave 0 host / Wave 1+ E2B. Console/CLI dry-run does not fake a green harvest |
| 5 | Review | Independent, lit. Negative control: revert goes red. Evidence attached by the operator, not invented |
| 6 | Draft | Fork → upstream draft. Body from `renderPrBody`. Create helper sets `draft: true` |
| 7 | Follow-up | Sync live PR. Answer threads. Mark quiet. **Never merge.** Scorecard on merged / closed-unmerged |

### Policy codes

| Code | Meaning |
|---|---|
| `ALLOW` | May enter freeze |
| `DENY_FORBIDDEN` | Ban-list or “no AI PRs.” Terminal |
| `DENY_UNKNOWN_POLICY` | Fetch docs and retry. Also used for unlisted repos |
| `HOLD_CLA` | Park `needs-human`. Never forge |
| `HOLD_HUMAN` | Wave 2 / HUMAN: markers |
| `HOLD_SCOPE` | Caps or RFC shape |

### Packet statuses

`scouted` → `gated` → `frozen` → `approved` → `implementing` → `reviewing` → `draft-ready` → `submitted` → `followed-up` → `merged` | `parked` | `rejected`

`hasInflight` gates: `gated`, `frozen`, `approved`, `implementing`, `reviewing`, `draft-ready`, **`submitted`**. `followed-up` is **not** in-flight.

`submitted` → `followed-up` is bounded (ADR 0002, `applyPrSync`): threads answered + PR quiet ≥ 14 days releases the slot; maintainer activity on a `followed-up` packet re-blocks the tick until answered — unless a newer packet already holds the slot, in which case the older packet stays `followed-up` and records a `reply-owed:` note rather than doubling the count; ≥ 45 quiet days records a `stale-intent` note (`closedUnmerged` + polite close is a human act). Maintainer silence cannot idle the factory indefinitely.

### Scorecard halt

*Foundry's scorecard is per-repo standing; it is unrelated to OpenSSF Scorecard (ADR 0004).*

Stop a repo when:

- maintainer tone is `banned`, or
- any revert of our patch, or
- opened ≥ 3, **at least one terminal outcome**, and merge rate < 40% (merge rate = merged / terminal outcomes)

Silence alone never halts — three still-open unreviewed drafts are `watch`, not `stop`.

Watch when tone is `cold`, or opened ≥ 2 and merge rate < 60% (watch carries no silence guard by design — it is soft caution).

A `stop` repo is unselectable until a human edits `allowlist.yaml`.

PR volume is a vanity metric. Not shown as a success KPI.

---

## 6. Waves and roster

| Wave | Who | Sandbox | Human freeze |
|---|---|---|---|
| 0 | Repos we own (`orca-fleet`, `frontguard`) | Host worktree | First 20 factory-wide, then mechanical if `aiPolicy: owner` |
| 1 | AI-welcome, small blast radius | E2B (dry-run in this repo) | **Always** |
| 2 | Adjacent (Mastra, OpenHands) | E2B | Always + HUMAN/DCO holds |

Caps (`allowlist.yaml`): `in_flight: 1`, `first_human_freezes: 20`, `halt_merge_rate: 0.4`, `halt_after_opens: 3`.

### Wave 0

- `ravidsrk/orca-fleet` — Python/Markdown. Test: `python3 scripts/validate.py && python3 -m unittest discover -s tests -v`
- `ravidsrk/frontguard` — TypeScript. Test: `npm test`

### Wave 1

- `ColeMurray/background-agents` — OpenInspect. `aiPolicy: unknown` — no written AI policy; behaviorally open (141/272 external PRs merged). First issue **#1476** (in flight as #1652)
- `github/awesome-copilot` — Markdown content (repo language JavaScript). First issue **#2684** (skills/github-issues reference gaps, docs class); documented 🤖🤖🤖 fast track
- `e2b-dev/e2b-cookbook` — replaces e2b-dev/E2B; genuinely silent (no CONTRIBUTING anywhere), gate holds until policy exists
- `mcp-use/mcp-use` — policy **unknown** until CONTRIBUTING parsed

Removed: `kortix-ai/suna` (secret-gated dev loop; externally unverifiable — issue #12)

### Wave 2

- `mastra-ai/mastra` — human-required
- `OpenHands/OpenHands` (org renamed from All-Hands-AI) — HUMAN: markers, docs only

### Denylist (hard)

- `matplotlib/matplotlib` — autonomous-agent ban
- `curl/curl` — maintainer asked agents to stop
- `pydantic/pydantic` — welcomes AI-assisted PRs; bans mass submission across repos + unassigned PRs. Denied as poor factory fit, not anti-AI
- `stablyai/orca` — no AI restriction; denied for conflict of interest (the runtime Foundry rides). Contribute via orca-fleet

---

## 7. Files

| Path | Role |
|---|---|
| [`allowlist.yaml`](../allowlist.yaml) | The product. Only repos the factory may see |
| [`factory/`](../factory/) | Control-plane modules (policy, engine, packet, scout, sandbox, scorecard) |
| [`factory/cli.ts`](../factory/cli.ts) | Operator freeze / tick / draft-body loop |
| [`factory/seed.ts`](../factory/seed.ts) | Ledger seed; must stay in sync with GitHub |
| [`factory/policy.ts`](../factory/policy.ts) | Deterministic gate |
| [`factory/engine.ts`](../factory/engine.ts) | Tick / queue / approve / advance; honors hard rules |
| [`factory/packet.ts`](../factory/packet.ts) | `buildPacket` / `renderPrBody` |
| [`factory/github-pr.ts`](../factory/github-pr.ts) | Draft-only create payload + live PR sync. **No merge.** |
| [`factory/sandbox.ts`](../factory/sandbox.ts) | Dry-run plan. Never auto-harvests as green |
| [`factory/scorecard.ts`](../factory/scorecard.ts) | Halt rules; engine consults `health()` |
| [`.github/workflows/oss-tick.yml`](../.github/workflows/oss-tick.yml) | Clock. Parses YAML. **Dry unless `FOUNDRY_LIVE=true`.** Never opens contribution PRs |
| [`docs/`](.) | Protocol. This file is the takeover bible |
| [`CONTEXT.md`](../CONTEXT.md) | Glossary |

Tests: `node --experimental-strip-types factory/run-tests.ts` (Node 22+).

---

## 8. Live ledger — 2026-08-28

`foundryAttestedWave0Merges` = packets with `status === "merged"` **and** `humanAttest` on Wave 0.

### Wave 0

| Packet | Issue | PR | Status |
|---|---|---|---|
| CHANGELOG 0.5.0 | orca-fleet#42 | [orca-fleet#70](https://github.com/ravidsrk/orca-fleet/pull/70) | **merged** 2026-08-27T07:04:52Z. Follow-up `d91fe2f`. Attested merge **1/2** |
| README architecture | frontguard#195 | [frontguard#196](https://github.com/ravidsrk/frontguard/pull/196) | **merged** 2026-08-28T06:40:44Z by `ravidsrk`. Doctrine is “Foundry never clicks merge, even on a repo we own.” This merge happened; it does not count as a promotion-gate merge for Wave 1 (promotion is orca-fleet#70 + #72). Do not treat it as a pattern |
| Validator unreadable SKILL.md | orca-fleet#71 | [orca-fleet#72](https://github.com/ravidsrk/orca-fleet/pull/72) | **merged** 2026-08-27T11:30:04Z. Attested merge **2/2** |

Promotion rule: Wave 1 may tick only after **two Foundry-attested Wave 0 merges**. That is true (#70 and #72). Historical oss-contribute (5 PRs) counts as mission evidence, not as this control plane’s counter.

### Wave 1 — in flight

| Packet | Issue | PRs | Status |
|---|---|---|---|
| Right sidebar toggle icon | [ColeMurray/background-agents#1476](https://github.com/ColeMurray/background-agents/issues/1476) | Fork [ravidsrk/background-agents#1](https://github.com/ravidsrk/background-agents/pull/1) **closed** (draft, unmerged). Upstream [ColeMurray#1652](https://github.com/ColeMurray/background-agents/pull/1652) **open, draft** (converted 2026-08-28, live-verified), `mergeable_state=blocked`, +88/−1 across 3 files, head `48c2242` | **`submitted`** — in-flight until the quiet-day rule releases it. Do not tick another packet |

Policy parsed for #1476 (operator, before open):

- `AGENTS.md`: no AI ban, conventional commits, welcome
- `CONTRIBUTING.md`: no CLA/DCO
- Labels: `good first issue`, `help wanted`, `enhancement`
- No open competing PR on #1476 at open time

#1652 was opened from a browser session because the GitHub App cannot `POST` pulls on ColeMurray/background-agents (403). It was opened **ready**, not draft, with a shortened disclosure — a doctrine miss, healed 2026-08-28: converted to draft (live-verified) and the verbatim disclosure confirmed in the body. The slot releases via the quiet-day rule; issue #5 machine-enforces the moment of contact so this class of miss cannot recur.

### Scorecard (Foundry packets in this control plane)

| Repo | opened | merged | tone | halt |
|---|---|---|---|---|
| ravidsrk/orca-fleet | 2 | 2 | warm | no |
| ravidsrk/frontguard | 1 | 1 | warm | no |
| ColeMurray/background-agents | 1 | 0 | neutral | no |
| bans | 0 | | | |
| reverts | 0 | | | |

Merge-rate halt is **not** tripped (`opened ≥ 3` required).

**Corrections 2026-08-28 (issue #3):** six allowlist facts fixed after live verification — pydantic and stablyai/orca deny reasons rewritten (both were mischaracterized as AI-restrictions), OpenHands org rename, background-agents `welcome` → `unknown` (no written policy), E2B surface re-scoped toward e2b-cookbook, awesome-copilot language. Details in [12-ledger.md](12-ledger.md).

---

## 9. GitHub App limitation

The connected GitHub token is a **GitHub App user-to-server token** (`ghu_`, empty `X-OAuth-Scopes`).

It can:

- read public repos
- write to `ravidsrk/*` (forks, oss-foundry, orca-fleet, frontguard)
- open PRs **on repos the App is installed on** (our repos)

It **cannot**:

- `POST /repos/ColeMurray/background-agents/pulls` → **403 Resource not accessible by integration**

A human browser session opened #1652 — the last one. Future Wave 1 drafts on stranger repos go through `open-draft` with the machine account's classic `public_repo` PAT (`FOUNDRY_PAT`; see docs/07): draft hard-coded, disclosure enforced, competing-work re-checked, secondary-rate-limit = halt.

The in-repo create path hard-codes `draft: true` end to end: `createDraftPull` is the one `POST /pulls` surface, it exists only for drafts, and there is no merge path anywhere. `cli.ts body` remains for inspection; browser opens are emergency-only.

---

## 10. Operator loop

```
node --experimental-strip-types factory/cli.ts status
node --experimental-strip-types factory/cli.ts tick
node --experimental-strip-types factory/cli.ts approve <packetId> --note "…"
node --experimental-strip-types factory/cli.ts halt <owner/name> --reason "…"
node --experimental-strip-types factory/cli.ts body <packetId>
```

Daily:

- Read `status` / this ledger
- Answer any review thread before starting a new packet
- If a maintainer says stop → `halt <repoId>` (scorecard `banned`) and denylist in `allowlist.yaml` the same hour. `tick` fetches AGENTS.md / CONTRIBUTING and refuses issues that already have an open closing-keyword PR.

Now:

- [ ] Follow ColeMurray#1652 until quiet / merged / closed. **Do not merge.**
- [ ] Prefer marking #1652 **draft** until CI/tests on that head are green
- [ ] Do not tick. #1652 is `submitted` (in-flight)
- [ ] Do not open awesome-copilot or any other Wave 1 packet

Never:

- [ ] `gh pr merge`
- [ ] `FOUNDRY_LIVE=true` until you personally want the clock to file a *packet request issue* on oss-foundry (it still must not auto-open contribution PRs)
- [ ] Put GitHub App private keys in E2B
- [ ] Touch denylist repos
- [ ] Farm random `good-first-issue` or invent issue numbers

### Incident: slop accusation

1. Convert PR to draft or close it
2. Apologize on the thread. Do not argue
3. Move the repo to denylist
4. Scorecard tone `banned`
5. No external PR for 14 days

---

## 11. 90-day success

Terms are defined operationally in [08-operations.md](08-operations.md) — denominators matter.

- ≥ 1 merged PR on a Wave 1 repo that is not ours
- Merge rate ≥ 60% on opened drafts that reached a terminal state (stale-closed counts against)
- Review-comment average ≤ 4 over human-reviewed PRs (`noReview` — terminal-state drafts never human-reviewed — reported alongside)
- **Bans = 0. Reverts = 0** (revert = explicit revert of our merge commit, or a maintainer-stated rollback naming the PR, within 30 days; rework is not a revert)
- First 20 packets each have a human attest

---

## 12. v1 vs v2

**v1 (enforced today):** allowlist YAML as sole source, deterministic policy, one-in-flight including `submitted`, human freeze via CLI, draft PR body, Wave 0 dogfood, clock that parses YAML and stays dry, halt consulted, no invented issues, no placeholder evidence.

**v2 (adapters, credentials outside git):** live GitHub scout (user-initiated), E2B session lifecycle labeled dry-run unless a key is present on the worker host, follow-up PR sync, draft-only create on repos the App can write. Grok scout overlay is **not shipped**. Clock stays dry unless `FOUNDRY_LIVE` is set.

---

## 13. Related protocol docs

| Doc | Topic |
|---|---|
| [00-vision.md](00-vision.md) | Why / non-goals / 90-day success |
| [01-architecture.md](01-architecture.md) | Control vs data plane |
| [02-good-neighbor.md](02-good-neighbor.md) | Ten rules + disclosure |
| [03-allowlist.md](03-allowlist.md) | Waves, adding/removing a repo |
| [04-stations.md](04-stations.md) | Scout → follow-up |
| [05-v1.md](05-v1.md) | v1 scope |
| [06-v2.md](06-v2.md) | Scout, sandbox, halt, GitHub App |
| [07-github-app.md](07-github-app.md) | Least privilege |
| [08-operations.md](08-operations.md) | Daily / halt / incident |
| [09-ethics.md](09-ethics.md) | Will / will not |
| [10-schemas.md](10-schemas.md) | YAML / packet schemas |
| [11-reuse.md](11-reuse.md) | What we reuse from orca-fleet |
| [12-ledger.md](12-ledger.md) | Live packet table |
| [adr/0001](adr/0001-extend-not-replace-orca.md) | Extend Orca, don’t replace |
| [adr/0002](adr/0002-draft-only.md) | Draft only, never merge |
| [adr/0003](adr/0003-sandbox-untrusted.md) | Untrusted clones in E2B |
| [adr/0004](adr/0004-naming.md) | Naming: Foundry + scorecard collisions, revisit at spec publication |
| [adr/0005](adr/0005-positioning.md) | Positioning: the re-admission layer; SPEC.md v0 |

---

## 14. Handoff note

You own: follow-up on #1652, all future freezes, allowlist edits, and stopping the factory
([08-operations.md](08-operations.md) — three mechanisms, only one of which `clear-halt` lifts).

Foundry still does not merge. Even on repos you own.
