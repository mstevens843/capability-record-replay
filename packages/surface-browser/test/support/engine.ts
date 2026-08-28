// The smallest `EvalContext` that lets `@crr/core`'s own resolver run over a real observation.
//
// It is here so the browser tests can prove something stronger than "the driver produced a
// plausible-looking tree": that the ENGINE, unmodified, reads the right cell out of it. The program
// facts are all empty because none of them bear on a cell lookup - what matters is that the
// observation and the bindings are real.

import type { EvalContext, Observation, ResolvedBindings } from "@crr/core";

export function evalContextFor(
  observation: Observation,
  params: Readonly<Record<string, string>> = {},
): EvalContext {
  const bindings: ResolvedBindings = Object.entries(params).map(([name, value]) => ({
    name,
    origin: "param",
    value,
    sensitivity: "internal",
    handle: null,
  }));
  return {
    observation,
    bindings,
    program: {
      routes: [],
      vocabulary: {},
      continuity: [],
      outputs: {},
      brandingTokens: [],
      maxEffect: "READ",
      restartSafeUpToPc: 0,
      resumePoints: [],
    },
  };
}
