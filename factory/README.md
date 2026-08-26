# factory/

TypeScript modules for the Foundry control plane. The operator console (TanStack app) imports the same logic from `src/lib/foundry/`. This copy is the protocol snapshot: no UI, no TanStack server functions.

Live GitHub scout and PR sync use the public API. On an operator host, set `GITHUB_TOKEN` (or authenticate `gh`) to raise the rate limit. Never put a token in this repo.
