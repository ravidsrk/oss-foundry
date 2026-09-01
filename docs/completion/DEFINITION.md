# Definition of Complete — Foundry

```
frozen_at: a708920 (docs/completion baseline)  ·  derived from audit at 74af0b2
status: FROZEN
```

**Immutable after this commit.** R13: this definition may not be lowered, narrowed, or reinterpreted. If it is wrong, it is wrong in writing and stays that way until a human amends it deliberately.

The bar comes from the repo's own rule, which is a better one than this driver would have invented:

> A station without SHA-bound evidence is doctrine-only. — `AGENTS.md:27`

Completion for this product is therefore **not** feature coverage. It is: every critical flow demonstrated, the ledger survivable, and the one integration forward-compatible.

---

## 1. Critical flows and their acceptance evidence

Seven flows, final list. Each is complete when **both** a happy path and one realistic failure path are evidenced under `docs/completion/evidence/`.

| id | flow | happy-path evidence required | failure-path evidence required |
|---|---|---|---|
| **CF-01** | Select the next packet | `tick` produces a `gated` packet with an `ALLOW` verdict against a live roster row — full command, stdout, exit 0 | `tick` on a repo whose upstream policy denies → refusal naming the matched phrase |
| **CF-02** | Human freeze / attest | `approve` moves `gated` → `approved`, `humanAttest` written, `humanApprovalsRemaining` decremented | `approve` refused because the upstream issue closed or competing work appeared between gate and freeze |
| **CF-03** | Witnessed evidence → `draft-ready` | a packet reaching `draft-ready` carrying a real `witness` block: `testExit: 0`, `revertExit != 0`, two distinct log sha256s, and the log files present on disk | `attach-witness` refused for a provenance or log-path violation |
| **CF-04** | **Open the draft PR upstream** | a **real draft PR** on a repository the operator does not own, opened by `open-draft`, with the ledger recording `prUrl`/`prMeta` — the PR URL is the evidence | `open-draft` refused: disclosure missing, or competing work found, or a secondary rate limit writing a durable halt |
| **CF-05** | Bind an out-of-band PR | `attach-draft` binds a live PR, pins `reviewedSha`, enforces the disclosure block | `attach-draft` refused for a body with no verbatim disclosure |
| **CF-06** | Follow up, release slot, score | `sync`/`reconcile` absorbs a terminal outcome and writes the scorecard row | a GitHub read failure during `reconcile` leaves the ledger uncorrupted |
| **CF-07** | Stop the factory | `halt <repoId>` reaches `health=stop`; `clear-halt` lifts the factory-wide halt | the per-repo `stop` is **not** lifted by `clear-halt` (the documented asymmetry, proven) |

**CF-04 is the only flow that writes into a repository the operator does not own.** It is the one the entire gate chain exists to protect, and it has never fired. No amount of unit coverage substitutes for the PR URL.

## 2. The launch gate

Every line must be true, with evidence, or the verdict is NO-GO.

1. **Every S0 gap closed.** No `ACCEPT` at S0, ever.
2. **Every critical flow carries happy-path *and* failure-path evidence** per §1.
3. **The ledger survives a kill.** A `SIGKILL` mid-write leaves a loadable ledger — demonstrated, not argued.
4. **A backup has been restored once**, to a scratch path, from a documented procedure.
5. **A rollback has been rehearsed once.** For this product that is: revert a merge on `main`, CI returns green.
6. **One alert has been proven to fire.** A failing scheduled run reaches a human through a mechanism that exists in the repo, not through a personal GitHub account setting.
7. **Stranger Test passed:** `git clone` → first critical flow, README alone, ≤ 15 minutes, no knowledge not in the docs.
8. **Recovery is documented for the three scenarios** the audit tested: corrupt ledger, revoked PAT, maintainer-requested stop. All three, not two.
9. **`main` is green** — build, the full suite, and the allowlist validator.
10. **Launch-gating Human Actions enumerated** in `HUMAN_ACTIONS.md`. If only these remain outstanding, the verdict is CONDITIONAL GO, not GO.

## 3. Minimum score per angle

Default bar: **≥3 on angles 1–9**, **≥2 on angles 10–17**. Deviations are recorded as assumptions, not silently applied.

| angle | now | required | delta |
|---|---|---|---|
| 1 product | 3 | 3 | — |
| 2 functional | 3 | 3 | — |
| 3 code quality | **2** | **3** | needs a type-check gate |
| 4 testing | 3 | 3 | — |
| 5 security | 3 | 3 | — |
| 6 data | **2** | **3** | needs atomic+durable write, backup, restore |
| 7 infra & deploy | **2** | **3** | needs a real version floor and runtime parity |
| 8 reliability | 3 | 3 | — |
| 9 observability | **2** | **3** | needs alerting and a reader for the audit trail |
| 10 performance & cost | 2 | 2 | — |
| 11 integrations | 2 | 2 | — |
| 12 AI/LLM | N/A | N/A | N/A per `A-04` |
| 13 UX | 3 | 2 | already above |
| 14 documentation | 3 | 2 | already above |
| 15 legal | 3 | 2 | already above |
| 16 GTM | 2 | 2 | — |
| 17 ownership & ops | **1** | **2** | needs an account inventory and recovery docs |

**Five angles must move: 3, 6, 7, 9, 17.** The score is informational; the gate in §2 is binding. **A 92% with one open S0 is NO-GO.**

## 4. Explicitly out of scope

Recorded here so a future session cannot re-litigate them.

**CUT — the code goes away rather than shipping half-built:**
- The seven dead runtime exports, including four UI-layer leftovers (`statusTone`, `policyTone`, `formatWhen`, `needsFollowUp`) for a console `docs/01-architecture.md:33` states does not exist in this repository.

**DEFER — post-launch, filed as issues labelled `post-launch`:**
- Wiring the live issue scout (`github-scout.ts`). Wiring it is a **feature**, forbidden by R6 after this freeze. Its missing request deadline is a safety fix and is in scope; its wiring is not.
- Machine enforcement for stations 4 (Implement) and 5 (Review). Today they are a human procedure with a status bump. The docs will be corrected to say so; building the enforcement is a new capability.
- Splitting `engine.test.ts` (5718 lines / 151 tests) and `cli.ts` (1422 lines).
- A coverage instrument.
- A `--json` output mode and a `--version` flag.
- De-duplicating the five hand-copied competing-work reads. **This one is deferred reluctantly** — it is the repo's own named recurring defect and drift is already visible — but it is a refactor across four call sites on the highest-traffic file, and R6's feature freeze plus the S0 work take precedence. Filed, not forgotten.

**ACCEPT — risk accepted with an expiry:**
- Packet-id-driven arbitrary file write (`G-20`) is *hardened* in this plan, but the underlying concession stands: `docs/10-schemas.md:67` states direct ledger write access is equivalent to operator control. No in-process check can fix that, and it is not pretended otherwise.
- Wave 1+ evidence is operator-attested-by-file, not machine-witnessed, until an E2B worker host exists. Stated plainly in `docs/10-schemas.md:69`. **Expiry: the first Wave 1 packet.** Until then, `attach-witness` may not be described as machine witnessing.

**Not applicable, with reasons:**
- **AI/LLM layer** — no model client anywhere; the only AI-related patterns are detectors for upstream policy prose (`A-04`).
- **Pricing, billing, subscriptions, analytics, landing page** — public MIT control plane, no users to bill (`A-05`).
- **ToS, privacy policy, cookie consent, DPA, PCI** — no service, no accounts, no end-user PII (`F-15-01`).
- **India fintech/VDA/DPDP obligations** — no money movement, no customer funds, no personal data beyond public GitHub logins (`A-03`).
