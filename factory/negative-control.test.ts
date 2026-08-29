import assert from "node:assert/strict";
import test from "node:test";

/**
 * THROWAWAY. Exists only to prove the CI gate added in #86 actually reds a pull request on a
 * failing test, which is issue #54's acceptance criterion ("a deliberately broken test fails the
 * PR"). This branch is never merged and is deleted once the red run is recorded.
 */
test("deliberately broken: proves the CI gate reds a pull request", () => {
  assert.equal(1, 2, "this assertion is meant to fail");
});
