# Contributing to Foundry

Foundry is a factory that contributes *elsewhere*. Changes *here* follow the same rules.

1. Read `docs/00-vision.md` and `docs/09-ethics.md`.
2. Protocol changes land as docs first, then code.
3. Allowlist additions name a first issue (number, title, url) and a parsed `aiPolicy`. Edit `allowlist.yaml` only — do not hand-sync a second copy.
4. Branch off `main`. Open a **draft** PR. Disclose agent help. Do not merge your own default-branch push unless you own the repo and still used a PR.
5. Node ≥22.10.0. Nothing to install. CI (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`, on Node 22.10.0 and 24:

   ```
   npm test
   npm run validate
   npm run typecheck
   ```

   `npm test` is the suite oracle (`factory/run-tests.ts`). `validate` checks `allowlist.yaml` and `policy-records.json`. `typecheck` installs a pinned TypeScript checker for that run only — it is not a repo dependency.
