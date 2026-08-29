import assert from "node:assert/strict";

/**
 * One home for the fixture rule the issue #77 count assertions depend on.
 *
 * A number that is a substring of another number in the same render cannot be asserted by matching
 * for it, and a test that cannot fail is not evidence. Round 1 of #77 shipped a document of 4,883
 * characters withholding 883 of them, and `"883"` is a suffix of `"4883"`: every assertion about the
 * withheld count matched inside the TOTAL, all four count mutants survived a green suite, and the
 * number an operator's approval rests on was pinned nowhere.
 *
 * WHY THIS IS A MODULE AND NOT A HELPER IN EACH SUITE. It was two — defined in `packet.test.ts` and
 * hand-written again inside `cli.test.ts`. Two copies of one rule is the defect this repository
 * keeps shipping: the rule drifts on one side, the other side keeps passing, and nothing says so
 * because each copy looks correct read on its own.
 *
 * Deliberately NOT a `.test.ts`. `run-tests.ts` collects every `*.test.ts` in this directory, and
 * importing one test file from another registers its tests a second time, so shared test support
 * needs a file the runner does not collect. Kept trivial for the same reason it was inline: this
 * has to read as a precondition, not as a second mechanism.
 */
export function assertDisjointCounts(total: number, withheld: number): void {
  assert.equal(
    String(total).includes(String(withheld)),
    false,
    `fixture is unusable: ${withheld} is a substring of ${total}, so matching for the withheld count would match inside the total (this is exactly how round 1 of #77 shipped three unpinned counts)`,
  );
}
