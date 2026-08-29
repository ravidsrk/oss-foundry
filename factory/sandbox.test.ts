import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SANDBOX_RULES } from "./sandbox.ts";
import { witnessEvidence } from "./witness.ts";

/**
 * Doctrine text that tells the operator what to do must name a verb the operator has. The CLI's
 * verbs are `status`, `tick`, `approve`, `reject`, `halt`, `advance`, `evidence`, `body`,
 * `open-draft`, `reconcile`, `evidence-page`, `ledger`, `sync`, `attach-draft` — there is no
 * `park`. `parked` is a status the *engine* writes (over-cap scope, a scorecard halt, a policy
 * denial); the operator's tool for standing a packet down is `reject`. "Park the packet" reads as
 * an instruction and points at a button that does not exist (issue #44 item 5).
 */
test("sandbox doctrine tells the operator to reject, not to press a verb the CLI lacks", () => {
  const oracle = SANDBOX_RULES.find((rule) => /tests cannot run/i.test(rule));
  assert.ok(oracle, "the oracle rule must survive any rewording");
  assert.match(oracle, /\breject\b/i);
  assert.doesNotMatch(oracle, /park the packet/i);
  assert.match(oracle, /do not skip the oracle/i);
});

/**
 * Same pin as the sandbox doctrine above, for the SPEC §5 negative-control refusal.
 * `parked` is a status the engine writes; the operator's stand-down verb is `reject` (issue #62).
 */
test("negative-control refusal tells the operator to reject, not to press a verb the CLI lacks", async () => {
  const runner = async (step: string) => {
    if (step === "mkdtemp") return { exit: 0, output: "/tmp/foundry-witness-fake" };
    if (step === "run-tests@head") return { exit: 0, output: "ok" };
    if (step === "run-tests@revert") return { exit: 0, output: "still ok" };
    return { exit: 0, output: "" };
  };
  const outcome = await witnessEvidence(
    {
      packetId: "pkt_ravidsrk_orca-fleet_71",
      repoId: "ravidsrk/orca-fleet",
      baseSha: "251fe899c5bd843a7dad71d908c0af3bfcea79e1",
      headSha: "d91fe2f6725163fab8f9dd42e5c2b0c0c9f0f40d",
      testCommand: "true",
      sandbox: "host",
      wave: 0,
    },
    runner,
    {},
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.match(outcome.error, /\breject\b/i);
    assert.doesNotMatch(outcome.error, /park the packet/i);
    assert.match(outcome.error, /does not bind the change/i);
  }
});

/**
 * A tracking comment that names an issue reads as accounted for, and it outlives the issue: that is
 * exactly how this defect was orphaned when #44 closed with the item unfixed (issue #62).
 *
 * The rule is "no issue pointer at all", not "no CLOSED issue pointer", and the name says so. A test
 * cannot tell open from closed without the network, and it should not try — the tracker is the
 * tracker. Forbidding the pointer outright is both testable and the stronger rule, and it fires on
 * an OPEN citation too, which was verified rather than assumed.
 */
test("no KNOWN DEFECT comment in factory/ carries an issue pointer", () => {
  const factory = fileURLToPath(new URL(".", import.meta.url));
  const hits: string[] = [];
  for (const name of readdirSync(factory)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const text = readFileSync(join(factory, name), "utf8");
    if (/KNOWN DEFECT[\s\S]{0,200}issue #\d+/.test(text)) hits.push(name);
  }
  assert.deepEqual(hits, []);
});
