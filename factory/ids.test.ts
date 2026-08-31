import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mintLedgerId } from "./ids.ts";

test("two ids minted in the same millisecond differ", () => {
  const frozen = 1_787_981_801_727;
  const a = mintLedgerId("evt_halt", frozen, 0.1111111111);
  const b = mintLedgerId("evt_halt", frozen, 0.2222222222);
  assert.notEqual(a, b);
  assert.match(a, /^evt_halt_1787981801727_/);
  assert.match(b, /^evt_halt_1787981801727_/);

  const many = Array.from({ length: 32 }, (_, i) => mintLedgerId("evt", frozen, (i + 1) / 64));
  assert.equal(new Set(many).size, many.length, `collision under a frozen clock: ${many.join(", ")}`);
});

test("the three prefix conventions live on the helper", () => {
  assert.match(mintLedgerId("evt", 1, 0.5), /^evt_1_/);
  assert.match(mintLedgerId("fu", 1, 0.5), /^fu_1_/);
  assert.match(mintLedgerId("evt_halt", 1, 0.5), /^evt_halt_1_/);
});

/**
 * Issue #88: uniqueness from `Date.now()` alone is the defect. The helper is the door; a new
 * template literal that interpolates `Date.now()` into an `id:` is a fourth site.
 */
test("no factory id derives uniqueness from Date.now() alone", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const offenders: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const text = readFileSync(join(dir, name), "utf8");
    // An id template that interpolates Date.now() and does not also interpolate Math.random /
    // mintLedgerId. The helper file itself is the one place the clock is allowed in an id.
    for (const m of text.matchAll(/id:\s*`([^`]+)`/g)) {
      const tpl = m[1];
      if (!tpl.includes("${Date.now()") && !tpl.includes("${Date.now()")) continue;
      if (name === "ids.ts") continue;
      offenders.push(`${name}: ${tpl}`);
    }
    // Direct Date.now().toString in an id — the halt.ts spelling.
    if (name !== "ids.ts" && /id:\s*`[^`]*\$\{Date\.now\(\)/.test(text)) {
      offenders.push(`${name}: interpolates Date.now() into an id`);
    }
  }
  assert.deepEqual(offenders, [], `clock-only ids:\n${offenders.join("\n")}`);
});
