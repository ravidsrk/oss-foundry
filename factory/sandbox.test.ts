import assert from "node:assert/strict";
import { test } from "node:test";
import { SANDBOX_RULES } from "./sandbox.ts";

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
