import { readFileSync } from "node:fs";
import { assertAllowlist, loadAllowlistFile } from "./load-allowlist.ts";
import { parsePolicyRecords, policyRecordsPath } from "./policy-records.ts";

const parsed = loadAllowlistFile();
assertAllowlist(parsed);
const deny = parsed.denylist.map((d) => d.id).join(", ");
const repos = parsed.repos.map((r) => r.id).join(", ");
console.log("allowlist ok");
console.log(`version ${parsed.version} repos=${parsed.repos.length} denylist=${parsed.denylist.length}`);
console.log(`denylist: ${deny}`);
console.log(`repos: ${repos}`);

const records = parsePolicyRecords(readFileSync(policyRecordsPath(), "utf8"));
for (const id of records.keys()) {
  if (!parsed.repos.some((r) => r.id === id)) {
    throw new Error(`policy-records.json: ${id} is not on the allowlist`);
  }
}
const missing = parsed.repos.filter((r) => !records.has(r.id)).map((r) => r.id);
console.log(`policy records ok: ${records.size} records${missing.length ? `; missing: ${missing.join(", ")}` : ""}`);
