// The static effect analysis (SPEC sections 2.4, 3.5 and 3.6).
//
// `artifact.ts` already derives what a document can prove about ITSELF - `deriveEffectSummary` runs
// inside the validator and needs no other document. This module is the second half: the derivation
// that needs the CONTRACT in hand, because `EffectSummary.reads` pairs each extracted field with a
// sensitivity that only the contract declares.
//
// The property worth stating plainly, because it is the clearest case in the whole design of a
// refusal buying a safety guarantee: `restartSafeUpToPc` is computable at all only because the
// program is a straight line. With one `if` in the language, "which steps are irreversible" and "is
// a restart safe from here" both become questions you can only answer by running the program - and a
// restart gate you can only evaluate after the fact is not a gate.
//
// Every read below is defensive. The linker calls this on a MERGED program that no validator has
// seen yet, so a half-formed step has to produce a wrong answer the linker can report rather than an
// exception nobody catches.

import { type EffectSummary, type InstructionKind, collectRouteRefs } from "./artifact.js";
import { asObject, asObjects, asString } from "./document-walk.js";
import { EFFECT_RANK, derivedEffectClass, reconcileEffectClass } from "./policy-engine.js";
import type { EffectClass, RouteId, Sensitivity, StepId } from "./primitives.js";

/** The shape the analysis reads. A parsed `Flow` satisfies it, and so does a merged program that is
 *  still plain JSON - which is the whole reason it is written structurally. */
export interface EffectStepInput {
  readonly id: StepId;
  readonly effect: EffectClass;
  readonly instruction: { readonly kind: string };
  readonly extract?: readonly { readonly output: string }[];
}

export interface EffectFlowInput {
  readonly entry: { readonly route: RouteId };
  readonly steps: readonly EffectStepInput[];
}

/**
 * One step's effect, with the declaration and the derivation kept apart.
 *
 * SPEC section 8.2: the class is declared on the step and re-derived by the linker; where the two
 * disagree the HIGHER wins and the linker reports it. Both halves are recorded rather than folded
 * into one value, because "we silently promoted your READ step to a write" is precisely the kind of
 * quiet correction an approver needs to see.
 */
export interface StepEffect {
  readonly stepId: StepId;
  readonly index: number;
  readonly declared: EffectClass;
  /** `null` when the instruction proves nothing - which is most of them. `activate` on a Search
   *  button is a read and `activate` on Close Account is not, and no pure function can tell. */
  readonly derived: EffectClass | null;
  readonly effective: EffectClass;
  readonly agreed: boolean;
}

export interface EffectAnalysis {
  readonly summary: EffectSummary;
  readonly perStep: readonly StepEffect[];
  /** Steps whose declared class and derived class disagreed. Empty on a well-formed artifact. */
  readonly disagreements: readonly StepEffect[];
}

/**
 * Gate 2 of SPEC section 3.6: the largest program counter a restart is still safe from.
 *
 * The index of the first irreversible step, or the step count when there is none. A program that has
 * already opened a sub-account cannot be restarted, and this says which steps make that true BEFORE
 * anything runs.
 */
export function restartSafeUpToPc(steps: readonly { readonly effect: EffectClass }[]): number {
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i]?.effect === "WRITE_IRREVERSIBLE") return i;
  }
  return steps.length;
}

/**
 * The whole `EffectSummary`, recomputed from the steps rather than believed from the document.
 *
 * `sensitivityOf` comes from the contract's outputs. An output the contract does not declare is a
 * link error in its own right (check 7); here it falls back to `sensitive`, because the direction a
 * missing sensitivity should be wrong in is never "assume it is safe to log".
 */
export function analyzeEffects(
  flow: EffectFlowInput,
  sensitivityOf: Readonly<Record<string, Sensitivity>>,
): EffectAnalysis {
  const perStep: StepEffect[] = [];
  const irreversibleSteps: StepId[] = [];
  let maxRank = 0;

  const steps = asObjects(flow.steps);
  steps.forEach((step, index) => {
    const declared = (asString(step.effect) ?? "READ") as EffectClass;
    const kind = asString(asObject(step.instruction)?.kind) as InstructionKind | null;
    const derived = kind === null ? null : derivedEffectClass(kind);
    const { effect, agreed } = reconcileEffectClass(declared, derived);
    const stepId = (asString(step.id) ?? "") as StepId;
    perStep.push({ stepId, index, declared, derived, effective: effect, agreed });
    if (EFFECT_RANK[effect] > maxRank) maxRank = EFFECT_RANK[effect];
    if (effect === "WRITE_IRREVERSIBLE") irreversibleSteps.push(stepId);
  });

  const maxEffect = effectOfRank(maxRank);
  const entryRoute = asString(asObject(flow.entry)?.route);
  const routes = new Set<RouteId>();
  if (entryRoute !== null) routes.add(entryRoute as RouteId);
  for (const route of collectRouteRefs(flow)) routes.add(route);

  // Read in step order, and only from a step's own `extract`. An outcome's `capture` bindings are
  // deliberately absent: they live in the terminal namespace of a run that ended at that outcome
  // (check 6), and rolling them into the summary a human approves would overstate what a SUCCESSFUL
  // run reads.
  const reads: { readonly field: string; readonly sensitivity: Sensitivity }[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    for (const spec of asObjects(step.extract)) {
      const field = asString(spec.output);
      if (field === null || seen.has(field)) continue;
      seen.add(field);
      reads.push({ field, sensitivity: sensitivityOf[field] ?? "sensitive" });
    }
  }

  const summary: EffectSummary = {
    maxEffect,
    irreversibleSteps,
    routesTouched: [...routes],
    reads,
    requiresApproval: maxEffect === "WRITE_IRREVERSIBLE",
    restartSafeUpToPc: restartSafeUpToPc(perStep.map((s) => ({ effect: s.effective }))),
  };

  return { summary, perStep, disagreements: perStep.filter((s) => !s.agreed) };
}

function effectOfRank(rank: number): EffectClass {
  for (const [effect, r] of Object.entries(EFFECT_RANK) as [EffectClass, number][]) {
    if (r === rank) return effect;
  }
  return "READ";
}
