# Contributing to Foundry

Foundry is a factory that contributes *elsewhere*. Changes *here* follow the same rules.

1. Read `docs/00-vision.md` and `docs/09-ethics.md`.
2. Protocol changes land as docs first, then code.
3. Allowlist additions name a first issue (number, title, url) and a parsed `aiPolicy`. Edit `allowlist.yaml` only — do not hand-sync a second copy.
4. Tests (Node 22+):

   ```
   node --experimental-strip-types --test factory/*.test.ts
   ```

5. Draft PRs. Disclose agent help. Do not merge your own default-branch push unless you own the repo and still used a PR.
