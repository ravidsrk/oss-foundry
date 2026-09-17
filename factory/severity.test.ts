import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { LINE, emitLine } from "./severity.ts";

test("G-40: every operator prefix is named in LINE", () => {
  assert.deepEqual(
    Object.values(LINE).sort(),
    ["ADVISORY", "DIVERGENCE", "FACTORY HALTED", "REVERT", "REVIEW", "SEED DRIFT"].sort(),
  );
});

test("G-40: cli and the clock print prefixes only through emitLine", () => {
  const cli = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
  const clock = readFileSync(new URL("./verify-ledger.ts", import.meta.url), "utf8");
  for (const src of [cli, clock]) {
    assert.match(src, /emitLine\(/, "must call emitLine");
    assert.equal(
      /console\.error\(`ADVISORY /.test(src),
      false,
      "raw ADVISORY console.error reopened the convention",
    );
    assert.equal(
      /console\.error\(`DIVERGENCE /.test(src),
      false,
      "raw DIVERGENCE console.error reopened the convention",
    );
    assert.equal(
      /console\.error\(`SEED DRIFT /.test(src),
      false,
      "raw SEED DRIFT console.error reopened the convention",
    );
  }
});

test("G-40: emitLine writes the prefix", () => {
  const err: string[] = [];
  const log: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a: unknown[]) => {
    err.push(String(a[0]));
  };
  console.log = (...a: unknown[]) => {
    log.push(String(a[0]));
  };
  try {
    emitLine("advisory", "x");
    emitLine("halt", "y", "report");
    emitLine("halt", "z");
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
  assert.deepEqual(err, ["ADVISORY x", "FACTORY HALTED z"]);
  assert.deepEqual(log, ["FACTORY HALTED y"]);
});
