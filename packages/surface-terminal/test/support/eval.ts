// A minimal `EvalContext`, so a checkpoint written in the artifact's own predicate language can be
// evaluated against an `Observation` this driver produced.
//
// Nothing here is terminal-specific, which is the point: these are `@crr/core`'s types and
// `@crr/core`'s evaluator, and they neither know nor care that the observation came off an 80x24
// character grid rather than out of Chromium's accessibility tree.

import type { EvalContext, ProgramFacts } from "@crr/core";
import type { Observation } from "@crr/core";

export const EMPTY_PROGRAM: ProgramFacts = {
  routes: [],
  vocabulary: {},
  continuity: [],
  outputs: {},
  brandingTokens: [],
  maxEffect: "READ",
  restartSafeUpToPc: 0,
  resumePoints: [],
};

export const contextFor = (
  observation: Observation,
  program: Partial<ProgramFacts> = {},
): EvalContext => ({
  observation,
  program: { ...EMPTY_PROGRAM, ...program },
  bindings: [],
});
