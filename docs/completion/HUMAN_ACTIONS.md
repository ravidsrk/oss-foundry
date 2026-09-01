# Human actions

Things only Ravindra can do. Each carries the exact instruction, what it unblocks, and the verification I will run once it is confirmed. Nothing here is started, attempted, or worked around.

R15: I do not create accounts, mint credentials, set repository variables, provision infrastructure, or spend money.

---

## H-01 — Create the machine account and its `public_repo` PAT · **GATES LAUNCH**

**Why only you.** `scripts/machine-account-wizard.sh:18-25` says it outright: *do not have this wizard or any agent create the account.* GitHub account creation is also a ToS matter, and the credential must be owned by a person.

**Exact instruction.**
1. Run `bash scripts/machine-account-wizard.sh` and follow its five steps.
2. Create a **separate** GitHub account for the factory — not `ravidsrk`.
3. Mint a **classic** PAT with **only** `public_repo` checked. Not `repo`. Nothing else. (`wizard:34`)
4. Expiration 90 days. Note the expiry date somewhere you will see it — nothing in the repo reminds you (that is `G-30`, deferred).
5. Export it as `FOUNDRY_PAT` in the operator shell.
6. Let the wizard's step 4 verify it: it reads `x-oauth-scopes` from `HEAD /user` and exits 1 unless the scope set is exactly `public_repo`.

**Unblocks.** Launch-gate §2 evidence for **CF-04** and **CF-05** — the only flow that writes into a repository you do not own, and the one the entire gate chain exists to protect. It has never fired. There is deliberately no `T-NN` for it: `PLAN.md` §"Blocked on Human Actions" carries these two rather than a task, because the agent cannot start them.

**My verification once you confirm.** Run `foundry witness-check`, then drive `open-draft` end to end on an approved packet and capture the resulting draft PR URL as `evidence/CF-04-happy-*.txt`. I will also confirm the negative path: that a body without the verbatim disclosure block is refused before any POST.

---

## H-02 — Decide the E2B / worker-host question · does **not** gate launch

**Why only you.** It needs a third-party account, an API key, and infrastructure — and the decision of whether to build it at all is a product call.

**The situation, stated accurately.** `docs/06-v2.md` and ADR 0003 require E2B (or Daytona) for every Wave 1+ packet. In this repository there is **no SDK, no client, and no worker host** — the entire surface is a presence check on `E2B_API_KEY` that changes which refusal is printed. The runner is not merely unconfigured; it is **unwritten and unlocated**.

**What I found that changes the shape of this decision.** CF-03 — producing a real machine witness — is **not** blocked on E2B. Wave 0 host witnessing is fully implemented, and both `ravidsrk/orca-fleet` and `ravidsrk/frontguard` are `wave: 0, sandbox: host` with real test commands. So the evidence station can be demonstrated on repos you own, today, without E2B. E2B is required only to move a **Wave 1+** packet.

**Your options.**
- **(a)** Demonstrate CF-03 at Wave 0 now, defer E2B until a Wave 1 packet is actually wanted. Cheapest; unblocks the gate.
- **(b)** Build the worker host now. Needs an E2B account, a key, a host, and the runner itself.
- **(c)** Say Wave 1+ is out of scope and mark the roster's four `wave: 1` entries accordingly.

**My recommendation: (a).** It closes the launch gate for CF-03 without buying infrastructure, and it keeps `docs/10-schemas.md:69`'s honest admission — that `attach-witness` cannot tell a worker-host witness from a hand-written one — as a stated limitation with an expiry rather than a hidden one.

**Unblocks.** Wave 1+ packets, and the `ACCEPT` expiry recorded in `DEFINITION.md` §4.

**My verification.** Under (a): capture a real Wave 0 witness with two distinct log sha256s and the log files present on disk. Under (b): re-run provenance checks against a witness produced on the host you name.

---

## H-03 — Name the next roster target · **GATES LAUNCH**

**Why only you.** `AGENTS.md` puts allowlist additions and their first issue in maintainer hands, and the 2026-08-29 sweep already treated allowlist targets as a product decision and out of bounds for the agent. I will not pick which stranger's repository this factory approaches next.

**Exact instruction.** Add one `firstIssues` row to `allowlist.yaml` under an existing allowlisted repo — number, title, and URL — for an issue that is open, unclaimed, and has no competing PR. Constraints the code will enforce for you, so you do not need to check them by hand:
- A repo whose `negativeControl` is `no-suite` **cannot** name a first issue (`load-allowlist.ts:90-93`) — that rules out `github/awesome-copilot` and `e2b-dev/e2b-cookbook`, both `testCommand: "true"`.
- A `wave >= 1` repo with `sandbox: host` is refused at load (`load-allowlist.ts:82-84`).
- For a Wave 0 demonstration, `ravidsrk/orca-fleet` and `ravidsrk/frontguard` are the two eligible repos.

**Why it is blocking.** `tick` deterministically returns `idle` today: all three named rows are consumed and every other roster entry is empty. `docs/12-ledger.md:313` already concedes it — *"Idle until a named, witnessable first issue is added."* Without a row, **CF-01, CF-02 and CF-03 cannot be demonstrated at all**, and three of seven critical flows stay doctrine-only.

**Unblocks.** CF-01, CF-02, CF-03 — three of the four unproven flows, with one edit.

**My verification.** `npm run validate` (the roster invariants), then `tick` → a `gated` packet with an `ALLOW` verdict captured as `evidence/CF-01-happy-*.txt`, then `approve` → `evidence/CF-02-happy-*.txt`, then `evidence` → a real machine witness for `evidence/CF-03-happy-*.txt`.

---

## Not a human action, recorded so it is not mistaken for one

**`FOUNDRY_LIVE`** — the repository variable that takes the 6-hour clock out of dry mode. It is **deliberately unset** and should stay unset until the gate is met. Setting it is the launch act, not a prerequisite for it. I will not set it, and nothing in this plan asks you to.

---

## Summary

| id | gates launch | unblocks | cost to you |
|---|---|---|---|
| **H-03** | **yes** | CF-01, CF-02, CF-03 | one edit to `allowlist.yaml` |
| **H-01** | **yes** | CF-04, CF-05 | ~10 minutes with the wizard |
| H-02 | no | Wave 1+ only | a decision; option (a) costs nothing |

**H-03 is the highest-leverage action on this list: one line unblocks three of the seven critical flows.**
