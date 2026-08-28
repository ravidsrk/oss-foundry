import { assertAllowlist, loadAllowlistFile } from "./load-allowlist.ts";

const parsed = loadAllowlistFile();
assertAllowlist(parsed);
const deny = parsed.denylist.map((d) => d.id).join(", ");
const repos = parsed.repos.map((r) => r.id).join(", ");
console.log("allowlist ok");
console.log(`version ${parsed.version} repos=${parsed.repos.length} denylist=${parsed.denylist.length}`);
console.log(`denylist: ${deny}`);
console.log(`repos: ${repos}`);
