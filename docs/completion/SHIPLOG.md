# SHIPLOG

Append-only. A session with zero context reads this file and continues from the resume pointer.

```
RESUME POINTER: PHASE_2
```

---

## 2026-09-01T11:42Z — run `20260901-1143` starts

Driver: product-completion. Mode `drive`. Repo `/Users/ravindra/projects/oss-foundry`.
Baseline `74af0b27f17ac39cda9779cbc6c73e7ed265e7df`, tree clean, `HEAD == origin/main`.
Working branch `ravidsrk/p0-completion-audit` (worktree `/tmp/pcd-wt`) — `docs/completion/` only, no source touched.

**R1 environment check.** Agentic with write access. `git` 2.55.0 · `node` v24.20.0 · `npm` 11.19.0 · `gh` 2.98.0 · `greptile` 3.4.2. Full pipeline available.

## PHASE 0 — baseline freeze · COMPLETE

Cold start from a fresh clone into `/tmp/pcd-coldstart`:

| step | result |
|---|---|
| `git clone` | exit 0, HEAD `74af0b2` |
| `npm ci` | **exit 1** — no lockfile |
| `npm install` | exit 0, no-op (zero declared deps) |
| `npm test` | exit 0 — **379/379**, 7.8s |
| `npm run validate` | exit 0 — `repos=8 denylist=4`, `policy records ok: 8` |
| `npm run foundry -- --help` | exit 0 — 18 verbs + verbatim disclosure |

Verdict **PASS**, with the `npm ci` failure recorded as data rather than smoothed over.
Evidence: `evidence/p0-coldstart-1-clone-install.txt`, `evidence/p0-coldstart-2-build-test-run.txt`.

Exit criteria: baseline recorded ✔ · cold start captured ✔.

## PHASE 1 — 360° audit · COMPLETE

Method: four read-only scouts on the heavy inspection slices (angles 2+3, 5+6, 8+9+11, 1+14) run in parallel; angles 4, 7, 10, 12, 13, 15, 16, 17 audited directly while they ran.

**Result: 68% complete.** 8 angles green, 7 amber, 1 red, 1 N/A.

| | angles |
|---|---|
| 🟢 3/4 | 1 product · 2 functional · 4 testing · 5 security · 8 reliability · 13 UX · 14 docs · 15 legal |
| 🟡 2/4 | 3 code quality · 6 data · 7 infra · 9 observability · 10 perf/cost · 11 integrations · 16 GTM |
| 🔴 1/4 | 17 ownership & ops |
| — N/A | 12 AI/LLM (grep-checkable: no model client anywhere) |

Critical flows: **7 identified · 1 verified · 2 works · 4 partial · 0 cut.** Exactly one (`CF-04 open-draft`) writes into a repository the operator does not own, and it has never fired.

Top five risks entering Phase 2:

1. `F-6-13` + `F-6-10/11` — non-atomic ledger write, no backup, no restore. One interrupted write bricks every command including `status`.
2. `F-5-10` — `witnessChildEnv` is a 4-key denylist, so the operator's whole environment reaches a third-party repo's install scripts.
3. `F-1-01/02/04` — three of seven critical flows have never fired; doctrine-only by the repo's own standard.
4. `F-1-09` — the promotion gate counts a merge the doctrine says it excludes.
5. `F-9-13` + `F-9-07` — no alerting at all, and the audit trail has no reader.

Evidence added: 8 files. Assumptions: `A-01` … `A-10`.

Exit criteria: no angle unscored ✔ · every score ≥3 backed by captured evidence ✔ · second look logged ✔.

**Second look — two changes made:**
- Deleted a false finding. My first exit-code probe reported `unknown command → exit 0`; `$?` was reading `tail` through a pipeline. Re-measured directly: exit **1**. The bug did not exist.
- Overrode a scout. `AngleFunctional` reported 105 test failures and flagged it as possibly its own sandbox; it was — one denied `mkdtemp` syscall, and `factory/tmp-dir.ts:52` is the single call site the whole suite funnels through. My own two runs (379/379, twice) stand. The residual observation is kept: 8 of 19 test files hard-require `$TMPDIR` with no skip path.

→ **Next: PHASE 2 — internal archaeology + external research.**
