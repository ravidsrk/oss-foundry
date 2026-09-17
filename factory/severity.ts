/**
 * Operator-facing line prefixes. A convention that is not this module drifts: SEED DRIFT
 * used to go to stdout while ADVISORY went to stderr (G-40). Every prefix is named here;
 * `emitLine` is the only printer.
 */
export const LINE = {
  advisory: "ADVISORY",
  divergence: "DIVERGENCE",
  seedDrift: "SEED DRIFT",
  review: "REVIEW",
  revert: "REVERT",
  halt: "FACTORY HALTED",
} as const;

export type LineKind = keyof typeof LINE;

/**
 * `halt` on the status *report* stays on stdout — it is part of the 2 a.m. diagnostic.
 * Every other prefix, including halt on other verbs, is stderr.
 */
export function emitLine(kind: LineKind, message: string, where: "report" | "side" = "side"): void {
  const text = message.length ? `${LINE[kind]} ${message}` : LINE[kind];
  if (kind === "halt" && where === "report") console.log(text);
  else console.error(text);
}
