# Foundry — Product Bible

**Operator takeover document.** Written 2026-08-28. This is the whole product: why it exists, how it runs, what has shipped, what is blocked, and what you do next.

| | |
|---|---|
| Public repo | https://github.com/ravidsrk/oss-foundry |
| Console | TanStack Start app on `0.0.0.0:8080` (Grok preview). Persist key `foundry-v6` |
| Data plane | [ravidsrk/orca-fleet](https://github.com/ravidsrk/orca-fleet) `oss-contribute` |
| License | MIT |
| Status | Wave 0 **2/2 attested merges**. Wave 1 packet implemented. **Upstream PR not opened** (GitHub App 403). |

---

## 1. One sentence

Foundry is an always-on, etiquette-correct **control plane** that decides *whether* an open-source contribution may exist. Orca / `oss-contribute` decides *how* the patch is built. Foundry never merges.

The product is not “open more PRs.” The product is **merged, etiquette-correct patches on an allowlist, with zero maintainer bans.**

---

## 2. Why this exists

2026 made unattended OSS agents radioactive:

- matplotlib banned autonomous-agent PRs after a slop incident
- curl maintainers asked agents to stop after a HackerOne flood
- pydantic closed slop PRs at a high rate
- drive-by volume without governance is vandalism

Foundry’s posture is the inverse: **contribute less, merge more, never surprise a maintainer.**

---

## 3. Hard constraints (absolute)

These cannot be relaxed by a tick, a prompt, or “just this once.”

1. **Allowlist only.** If a repo is not in [`allowlist.yaml`](../allowlist.yaml), it does not exist.
2. **Denylist is absolute.** `matplotlib/matplotlib`, `curl/curl`, `pydantic/pydantic`, `stablyai/orca`. No override in the UI.
3. **One packet in flight.** Gated / frozen / approved / implementing / reviewing / draft-ready blocks a new tick.
4. **Draft PRs only.** Never merge. Never `--admin`. Never forge CLA/DCO. Never click Ready except as a human after CI is green.
5. **Disclose Foundry + human attest** in every PR body.
6. **Parse policy first.** `AGENTS.md` / `CONTRIBUTING` unknown ⇒ deny, not “try it.”
7. **Wave 1+ in E2B** (or dry-run). Wave 0 may use a host worktree on repos we own.
8. **Stop the same hour** a maintainer asks.
9. **Failing-first.** Test or repro is red before the fix. Revert must go red again.
10. **Scope caps.** Per-repo `maxFiles` / `maxDiffLines`. Overflow = park.
11. **No competing PRs.** If upstream already has an open PR on the issue, assist or stand down.
12. **Follow up until quiet / merged / closed.** A rotting draft is still slop.

Disclosure block (verbatim):

```
This patch was prepared by Foundry, an operator-gated contribution factory.
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
 │ Grok rank   │   │ AGENTS.md   │   │ human only  │   │ sandboxed   │
 └─────────────┘   └─────────────┘   └─────────────┘   └──────┬──────┘
                                                              │
                       ┌─────────────┐   ┌─────────────┐      │
                       │ 7 Scorecard │ ← │ 6 Draft PR  │ ←  5 Review (blind)
                       │ halt rules  │   │ never merge │      │
                       └─────────────┘   └─────────────┘      │
```

| Plane | What | Stack |
|---|---|---|
| Control | Allowlist, policy, freeze, clock, scorecard, operator UI | TypeScript, TanStack Start, React 19, Tailwind v4, zustand persist (`foundry-v6`) |
| Data | Patch build, tests, evidence manifest | orca-fleet `oss-contribute` / Orca workers |
| GitHub | Fork → upstream **draft** | REST, User-Agent `oss-foundry`. App: contents read upstream, write on operator forks, PR write (draft). **No admin. No merge.** |

Foundry does **not** replace Orca, Mastra, or HeyCMO. ADR 0001: extend, don’t replace.

### Trust boundaries

| Boundary | Rule |
|---|---|
| Allowlist | Unlisted = invisible |
| Policy | Forbidden phrases beat “but the issue is tiny” |
| Freeze | First 20 packets always human. Forever on CLA/DCO and Wave 2. Wave 1+ never auto-freeze |
| Sandbox | Wave 1+ clones never hit the operator laptop. No GitHub App keys, SSH, npm tokens, or `.env` in the box |
| Reviewer | Blind to implementer traces. Diff + tests only. Reviewed SHA = head SHA at draft |
| GitHub | Draft only |

---

## 5. Stations

| # | Station | Does |
|---|---|---|
| 1 | Scout | Allowlist issues only. Drop denylist, RFC/meta, issues with an in-flight maintainer PR. Heuristic + optional Grok overlay (user-initiated, never on page load) |
| 2 | Policy | Deterministic. Grok has no vote |
| 3 | Freeze | Operator Approve (attest) or Reject (park) |
| 4 | Implement | One playbook pack. Failing-first. Wave 0 host / Wave 1+ E2B |
| 5 | Review | Independent, lit. Negative control: revert goes red |
| 6 | Draft | Fork → upstream draft. Body from `renderPrBody` |
| 7 | Follow-up | Sync live PR. Answer threads. Mark quiet. **Never merge.** Scorecard on merged / closed-unmerged |

### Policy codes

| Code | Meaning |
|---|---|
| `ALLOW` | May enter freeze |
| `DENY_FORBIDDEN` | Ban-list or “no AI PRs.” Terminal |
| `DENY_UNKNOWN_POLICY` | Fetch docs and retry |
| `HOLD_CLA` | Park `needs-human`. Never forge |
| `HOLD_HUMAN` | Wave 2 / HUMAN: markers |
| `HOLD_SCOPE` | Caps or RFC shape |

### Packet statuses

`scouted` → `gated` → `frozen` → `approved` → `implementing` → `reviewing` → `draft-ready` → `submitted` → `followed-up` → `merged` | `parked` | `rejected`

`hasInflight` gates only: `gated`, `frozen`, `approved`, `implementing`, `reviewing`, `draft-ready`. `followed-up` is **not** in-flight.

### Scorecard halt

Stop a repo when:

- maintainer tone is `banned`, or
- any revert of our patch, or
- opened ≥ 3 **and** merge rate < 40%

Watch when tone is `cold`, or opened ≥ 2 and merge rate < 60%.

PR volume is a vanity metric. Not shown as a success KPI.

---

## 6. Waves and roster

| Wave | Who | Sandbox | Human freeze |
|---|---|---|---|
| 0 | Repos we own (`orca-fleet`, `frontguard`) | Host worktree | First 20 factory-wide, then mechanical if `aiPolicy: owner` |
| 1 | AI-welcome, small blast radius | E2B | **Always** |
| 2 | Adjacent (Mastra, OpenHands) | E2B | Always + HUMAN/DCO holds |

Caps (`allowlist.yaml`): `in_flight: 1`, `first_human_freezes: 20`, `halt_merge_rate: 0.4`, `halt_after_opens: 3`.

### Wave 0

- `ravidsrk/orca-fleet` — Python/Markdown. Test: `python3 scripts/validate.py && python3 -m unittest discover -s tests -v`
- `ravidsrk/frontguard` — TypeScript. Test: `npm test`

### Wave 1

- `ColeMurray/background-agents` — OpenInspect. `aiPolicy: welcome`. First issue **#1476**
- `github/awesome-copilot` — Markdown docs
- `e2b-dev/E2B` — docs/examples only
- `mcp-use/mcp-use` — policy **unknown** until CONTRIBUTING parsed
- `kortix-ai/suna` — policy **unknown** until parsed

### Wave 2

- `mastra-ai/mastra` — human-required
- `All-Hands-AI/OpenHands` — HUMAN: markers, docs only

### Denylist (hard)

- `matplotlib/matplotlib` — autonomous-agent ban
- `curl/curl` — maintainer asked agents to stop
- `pydantic/pydantic` — high slop-PR close rate
- `stablyai/orca` — contribute via orca-fleet, not drive-by

---

## 7. Console and files

Operator console: React 19 + TanStack Start + Tailwind v4 + zustand persist.

| Path | Role |
|---|---|
| [`allowlist.yaml`](../allowlist.yaml) | The product. Only repos the factory may see |
| [`src/lib/foundry/`](../src/lib/foundry/) | Control-plane modules |
| `store.ts` | Persist key **`foundry-v6`**. `skipHydration` so hydrate doesn’t block paint |
| `seed.ts` | Ledger seed (must stay in sync with GitHub reality) |
| `policy.ts` | Deterministic gate + tests in `policy.test.ts` |
| `packet.ts` | `buildPacket` / `renderPrBody` |
| `github-scout.ts` | Live issue fetch. User-Agent `oss-foundry`. `GH_TOKEN` for rate limits |
| `github-pr.ts` | Draft-only PR helper |
| `sandbox.ts` | E2B lifecycle, dry-run in console |
| `scorecard.ts` | Halt rules |
| `scout-ai.ts` | Grok overlay, model `grok-4.5`, user-initiated, `max_tokens: 280` |
| [`.github/workflows/oss-tick.yml`](../.github/workflows/oss-tick.yml) | Clock. **Dry unless `FOUNDRY_LIVE=true`.** Never opens PRs by default |
| [`docs/`](.) | Protocol. This file is the takeover bible |

Routes: `/` board, `/queue`, `/queue/$packetId`, `/allowlist`, `/stations`, `/scorecard`, `/sandbox`, `/docs`, `/protocol`.

---

## 8. Live ledger — 2026-08-28

`foundryAttestedWave0Merges` = packets with `status === "merged"` **and** `humanAttest` on Wave 0.

### Wave 0 — 2/2 attested merges (promotion gate passed)

| Packet | Issue | PR | Status |
|---|---|---|---|
| CHANGELOG 0.5.0 | orca-fleet#42 | [orca-fleet#70](https://github.com/ravidsrk/orca-fleet/pull/70) | **merged** 2026-08-27T07:04:52Z by maintainer. Follow-up `d91fe2f` (changelog date UTC). Greptile 5/5 |
| README architecture | frontguard#195 | [frontguard#196](https://github.com/ravidsrk/frontguard/pull/196) | **quiet draft**. Greptile 5/5. CI red is **pre-existing on main** (playwright lockfile + setup-node from dependabot #185/#184). README only. Do not merge. Do not “fix CI” in this packet |
| Validator unreadable SKILL.md | orca-fleet#71 | [orca-fleet#72](https://github.com/ravidsrk/orca-fleet/pull/72) | **merged** 2026-08-27T11:30:04Z by maintainer. `read_text_safe`, 103 tests, 5 files +72/−15. Greptile 5/5 |

Promotion rule: Wave 1 may tick only after **two Foundry-attested Wave 0 merges**. That is now true (#70 and #72). Historical oss-contribute (5 PRs) counts as mission evidence, not as this control plane’s counter.

### Wave 1 — implemented, upstream PR **not opened**

| Packet | Issue | Branch | Fork PR | Upstream |
|---|---|---|---|---|
| Right sidebar toggle icon | [ColeMurray/background-agents#1476](https://github.com/ColeMurray/background-agents/issues/1476) | `foundry/issue-1476-sidebar-toggle-icon` @ `217511d855e58f95cdfff82b05ebd92114fc59e2` | [ravidsrk/background-agents#1](https://github.com/ravidsrk/background-agents/pull/1) draft, Greptile **5/5**, mergeable=clean | **missing — App 403** |

Policy parsed:

- `AGENTS.md`: no AI ban, conventional commits, welcome
- `CONTRIBUTING.md`: no CLA/DCO
- Labels: `good first issue`, `help wanted`, `enhancement`
- No open competing PR on #1476

Patch:

- Closed: existing `RightSidebarIcon` (outline + right rail `line x1=15`)
- Open: `RightSidebarOpenIcon` filled right rail (`packages/web/src/components/ui/right-sidebar-open-icon.tsx`)
- `session-header.tsx` switches on `isDesktopDetailsOpen`
- Tests: `session-header-sidebar-icon.test.tsx`
- Files: 3. Diff +88 / −1
- ARIA label / `aria-expanded` unchanged

### Scorecard (approx)

| Repo | opened | merged | tone | halt |
|---|---|---|---|---|
| ravidsrk/orca-fleet | 8 | 7 | warm | no |
| ravidsrk/frontguard | 1 | 0 | warm | no (only 1 open; CI not our fault) |
| ColeMurray/background-agents | 1 (fork) | 0 | neutral | no |
| bans | 0 | | | |
| reverts | 0 | | | |

Merge-rate halt is **not** tripped (`opened ≥ 3` required).

Do **not** open another Wave 0 draft for vanity volume while #196 sits quiet.

---

## 9. GitHub App limitation (why Wave 1 is stuck)

The connected GitHub token is a **GitHub App user-to-server token** (`ghu_`, empty `X-OAuth-Scopes`).

It can:

- read public repos
- write to `ravidsrk/*` (forks, oss-foundry, orca-fleet, frontguard)
- open PRs **on repos the App is installed on** (our repos)

It **cannot**:

- `POST /repos/ColeMurray/background-agents/pulls` → **403 Resource not accessible by integration**

Reconnect did not fix this. The App is not installed on ColeMurray/background-agents and does not have `public_repo` OAuth scope.

**Only a human browser session can open the upstream PR.** That is now the operator’s job (you).

---

## 10. Your first action — open the Wave 1 draft

Compare (create as **Draft**):

https://github.com/ColeMurray/background-agents/compare/main...ravidsrk:foundry/issue-1476-sidebar-toggle-icon?quick_pull=1

### Title

```
feat: differentiate the right sidebar toggle icon by state
```

### Body (paste verbatim)

```
## Summary

Fixes https://github.com/ColeMurray/background-agents/issues/1476

The desktop right-sidebar toggle used the same outline icon whether the details pane was open or closed. `aria-expanded` already flipped; the glyph did not.

- Closed: keep existing `RightSidebarIcon` (outline + right rail)
- Open: `RightSidebarOpenIcon` (filled right rail)
- Toggle behavior and accessible name unchanged

## Acceptance

- [x] Open and closed states are visually distinct from the icon alone
- [x] Icon updates with `isDesktopDetailsOpen`
- [x] Tests cover both glyphs (`session-header-sidebar-icon.test.tsx`)
- [x] Existing header test still matches the shared rail line

## Files

- `packages/web/src/components/session-header.tsx`
- `packages/web/src/components/ui/right-sidebar-open-icon.tsx`
- `packages/web/src/components/session-header-sidebar-icon.test.tsx`

+88 / −1 across 3 files.

## Disclosure

This patch was prepared by Foundry, an operator-gated contribution factory.
A human reviewed the packet, the diff, and the tests before this draft was opened.
The factory does not merge. Maintainers own the merge.

Closes #1476
```

After it opens: record the PR number, keep it draft, follow up until quiet. **Do not merge.**

---

## 11. Operator takeover checklist

Daily:

- [ ] Read the Board / this ledger
- [ ] Answer any review thread before starting a new packet
- [ ] If a maintainer says stop → denylist same hour

Now:

- [ ] Open ColeMurray #1476 upstream draft (section 10)
- [ ] Leave frontguard#196 draft. Do not merge. Do not pile on CI
- [ ] Do not open another Wave 0 packet
- [ ] Do not tick Wave 1 again until #1476 is quiet/merged/closed (one in flight)

This week after #1476 is in follow-up:

- [ ] Watch Greptile / CI on the upstream PR
- [ ] Reply to review threads; do not argue
- [ ] Next Wave 1 candidate only after #1476 leaves in-flight: prefer `github/awesome-copilot` (tiny Markdown) over unknown-policy repos

Never:

- [ ] `gh pr merge`
- [ ] `FOUNDRY_LIVE=true` until you personally want the clock to propose packets (it still must not auto-open PRs)
- [ ] Put GitHub App private keys in E2B
- [ ] Touch denylist repos
- [ ] Farm random `good-first-issue`

### Incident: slop accusation

1. Convert PR to draft or close it
2. Apologize on the thread. Do not argue
3. Move the repo to denylist
4. Scorecard tone `banned`
5. No external PR for 14 days

---

## 12. 90-day success

- ≥ 1 merged PR on a Wave 1 repo that is not ours
- Merge rate ≥ 60% on opened drafts
- Review-comment average ≤ 4
- **Bans = 0. Reverts = 0**
- First 20 packets each have a human attest

---

## 13. v1 vs v2

**v1 (safe today):** allowlist, deterministic policy, one-in-flight, human freeze, draft PR body, Wave 0 dogfood.

**v2 (wired, credentials outside git):** Grok scout overlay, live GitHub scout, E2B sandbox lifecycle (console is dry-run), follow-up station, scorecard halt. Clock stays dry unless `FOUNDRY_LIVE` is set on the operator host.

---

## 14. Related protocol docs

| Doc | Topic |
|---|---|
| [00-vision.md](00-vision.md) | Why / non-goals / 90-day success |
| [01-architecture.md](01-architecture.md) | Control vs data plane |
| [02-good-neighbor.md](02-good-neighbor.md) | Ten rules + disclosure |
| [03-allowlist.md](03-allowlist.md) | Waves, adding/removing a repo |
| [04-stations.md](04-stations.md) | Scout → follow-up |
| [05-v1.md](05-v1.md) | v1 scope |
| [06-v2.md](06-v2.md) | Grok, E2B, halt, GitHub App |
| [07-github-app.md](07-github-app.md) | Least privilege |
| [08-operations.md](08-operations.md) | Daily / halt / incident |
| [09-ethics.md](09-ethics.md) | Will / will not |
| [10-schemas.md](10-schemas.md) | YAML / packet schemas |
| [11-reuse.md](11-reuse.md) | What we reuse from orca-fleet |
| [adr/0001](adr/0001-extend-not-replace-orca.md) | Extend Orca, don’t replace |
| [adr/0002](adr/0002-draft-only.md) | Draft only, never merge |
| [adr/0003](adr/0003-sandbox-untrusted.md) | Untrusted clones in E2B |

---

## 15. Handoff note

Grok (this session) built the control plane, ran Wave 0 through two attested maintainer merges, implemented Wave 1 #1476 on the fork, and could not open the ColeMurray PR because of GitHub App 403.

You own: the browser click that opens the draft, all future freezes, all follow-up, allowlist edits, and the halt switch.

Foundry still does not merge. Even on repos you own.
