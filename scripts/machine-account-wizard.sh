#!/usr/bin/env bash
# Machine-account setup wizard for Foundry's moment of contact (issue #5).
# Walks the operator through the ONLY steps a human must perform. Never stores secrets in git.
set -euo pipefail

step() { printf '\n\033[1m== Step %s — %s ==\033[0m\n' "$1" "$2"; }
confirm() { read -r -p "$1 [press Enter when done] " _; }

cat <<'INTRO'
Foundry machine-account wizard
------------------------------
Why: the GitHub App can never open PRs on repos it is not installed on (403 by design —
intersection model). The only credential GitHub documents for fork→upstream PRs on
unaffiliated public repos is a CLASSIC personal access token. GitHub's ToS permits one
free machine account per person; the human who creates it is responsible for it.
INTRO

step 1 "Create the machine account"
cat <<'S1'
  In a private browser window: https://github.com/signup
  - Username suggestion: <you>-foundry-courier (clearly a machine account, per ToS)
  - Use an email alias you control (e.g. you+foundry@…)
  - Enable 2FA immediately (Settings → Password and authentication)
  Do NOT have this wizard or any agent create the account — account creation is yours.
S1
confirm "Account created with 2FA enabled?"

step 2 "Mint the classic PAT (public_repo only)"
cat <<'S2'
  Signed in AS THE MACHINE ACCOUNT:
  https://github.com/settings/tokens/new
  - Note: foundry-open-draft
  - Expiration: 90 days (rotate on expiry)
  - Scope: check ONLY 'public_repo'. Nothing else. Not 'repo'.
S2
confirm "Token generated and copied?"

step 3 "Export FOUNDRY_PAT on this host (never in git, never in E2B)"
read -r -s -p "Paste the token (input hidden): " FOUNDRY_PAT; echo
export FOUNDRY_PAT

step 4 "Verify the token"
USER_JSON=$(curl -s -H "Authorization: Bearer $FOUNDRY_PAT" -H "User-Agent: oss-foundry" https://api.github.com/user || true)
LOGIN=$(printf '%s' "$USER_JSON" | sed -n 's/.*"login": *"\([^"]*\)".*/\1/p')
if [ -z "$LOGIN" ]; then echo "Verification FAILED — token rejected by the API."; exit 1; fi
SCOPES=$(curl -sI -H "Authorization: Bearer $FOUNDRY_PAT" -H "User-Agent: oss-foundry" https://api.github.com/user 2>/dev/null | tr -d '\r' | sed -n 's/^x-oauth-scopes: *//Ip' || true)
echo "Authenticated as: $LOGIN  (scopes: ${SCOPES:-none})"
if [ "${SCOPES:-}" != "public_repo" ]; then
  echo "WARNING: expected scopes to be exactly 'public_repo'; got '${SCOPES:-none}'. Re-mint the token with only public_repo checked."
  exit 1
fi

step 5 "Persist for the operator shell"
cat <<S5
  Add to your shell profile or secret manager (NOT this repo):
    export FOUNDRY_PAT=…       # the token you just verified
  Doctrine reminders:
    - draft-only: the create helper hard-codes draft:true; there is no merge surface
    - one create per CLI run; a secondary-rate-limit response halts the factory
    - never put FOUNDRY_PAT in allowlist.yaml, a packet, or the E2B box
S5
echo
echo "Done. Try: node --experimental-strip-types factory/cli.ts open-draft <packetId> --head $LOGIN:branch"
