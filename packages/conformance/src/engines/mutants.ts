// THE NINE WEAKENED ENGINES OF SPEC SECTION 4.8.
//
// Every one of them is the REAL replay engine. Not a stub, not a re-implementation: `replay()` from
// `@crr/runtime`, the same linker, the same lease, the same budget ledgers, the same journal, with
// exactly ONE of the two pure decision functions replaced by a version that is wrong in one
// specific, plausible way. That is what makes the meta-test's claim worth anything - a suite that
// can tell a real engine from a stub has proved nothing about a suite pointed at a real engine that
// is subtly wrong.
//
// Each is a shortcut a competent engineer would take under deadline, and each has a name in the
// design documents because each was argued about:
//
//   · `firstMatch`     - "if two descriptors disagree, use the best-ranked one" (a fallback chain).
//   · `countQuorum`    - "three descriptors agreed, that is plenty" (evidence is not counted).
//   · `noAssert`       - "we already resolved it, the assertion is belt and braces".
//   · `noSettleGate`   - "the driver told us it was settled".
//   · `checkpointFirst`- "verify the postcondition first, then look for known outcomes".
//   · `noContinuity`   - "the click was unambiguous; of course it is the right record".
//   · `noDelta`        - "the checkpoint passed, so something must have happened".
//   · `nearestMatch`   - "nothing matched exactly, so return the closest declared outcome".
//   · `noProvenance`   - "a validation error is a validation error".
//
// `mustKill` on each is a FLOOR, not an exact set: these bugs are not surgically isolated from one
// another, and a mutant may fail more scenarios than it names. What the list must never do is
// shrink - every id in it was observed failing for the reason the mutant models.

import {
  type ClassifierInput,
  type ExpectationTrace,
  type NodeFingerprint,
  type Observation,
  type ResolveTargetInput,
  type ResolvedBinding,
  type TargetCandidate,
  type TargetResolutionResult,
  type UINode,
  type Verdict,
  classify,
  fingerprintOf,
  resolveTarget,
} from "@crr/core";
import type { DecisionFunctions } from "@crr/runtime";
import type { ReplayEngine } from "../types.js";

const EMPTY_TRACE: ExpectationTrace = { rendered: "no assertion was evaluated", clauses: [] };

/** Rebuild a `resolved` result around a node the real resolver refused to commit to. */
function resolveAnyway(
  input: ResolveTargetInput,
  base: Extract<TargetResolutionResult, { status: Exclude<string, "resolved"> }> & {
    readonly candidates: readonly TargetCandidate[];
    readonly warnings: TargetResolutionResult["warnings"];
  },
  chosen: TargetCandidate,
): TargetResolutionResult {
  const node = input.ctx.observation.nodes.find((n: UINode) => n.id === chosen.nodeId);
  if (node === undefined || node.ariaRole === null) return base as TargetResolutionResult;
  const fingerprint: NodeFingerprint | null = fingerprintOf(node, input.ctx.observation.nodes);
  if (fingerprint === null) return base as TargetResolutionResult;
  return {
    status: "resolved",
    nodeId: node.id,
    resolvedNode: node,
    fingerprint,
    agreeingDescriptors: [chosen.descriptorId],
    declaredSources: [chosen.evidenceSource],
    independentSources: 1,
    assertion: EMPTY_TRACE,
    candidates: base.candidates,
    warnings: base.warnings,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. First matching descriptor instead of agreement
// ---------------------------------------------------------------------------------------------

/**
 * A fallback chain, which is what "use the highest-ranked descriptor that resolved" is.
 *
 * The argument for it sounds reasonable - `role-name` outranks `ordinal-in-container`, so prefer it -
 * and it is a machine for converting an ambiguity into a confident wrong click. When two independent
 * descriptions of "the control" name different controls, the one fact you have is that you do not
 * know which one the recording meant.
 */
export const firstMatch: DecisionFunctions = {
  classify,
  resolveTarget: (input) => {
    const base = resolveTarget(input);
    // `assert-failed` and `not-found` are left alone: this mutant models the AGREEMENT shortcut and
    // nothing else, so each mutant stays attributable to one decision.
    if (base.status !== "ambiguous" && base.status !== "underdetermined") return base;
    const chosen = base.candidates.find((c) => c.nodeId !== null);
    return chosen === undefined ? base : resolveAnyway(input, base, chosen);
  },
};

// ---------------------------------------------------------------------------------------------
// 2. Descriptor COUNT instead of distinct evidence sources
// ---------------------------------------------------------------------------------------------

/**
 * Counts descriptors, not evidence.
 *
 * Three descriptors that all read the same label are a quorum of one, and the day the vendor renames
 * that label all three die together. This is the subtlest of the nine: the engine looks like it has
 * corroboration and has a single point of failure wearing a quorum's clothes.
 */
export const countQuorum: DecisionFunctions = {
  classify,
  resolveTarget: (input) => {
    const base = resolveTarget(input);
    if (base.status !== "underdetermined") return base;
    const agreeing = base.candidates.filter((c) => c.verdict === "resolved" && c.nodeId !== null);
    const distinct = new Set(agreeing.map((c) => c.nodeId));
    if (agreeing.length < input.target.quorum.min || distinct.size !== 1) return base;
    return resolveAnyway(input, base, agreeing[0] as TargetCandidate);
  },
};

// ---------------------------------------------------------------------------------------------
// 3. No pre-act target assertion
// ---------------------------------------------------------------------------------------------

/**
 * Resolves, then dispatches, without re-deriving the identity of what it is about to touch.
 *
 * The assertion costs one predicate evaluation and it is the only control that fires BEFORE the
 * click. Everything downstream of it is archaeology.
 */
export const noAssert: DecisionFunctions = {
  classify,
  resolveTarget: (input) => {
    const base = resolveTarget(input);
    if (base.status !== "assert-failed" || base.nodeId === null) return base;
    const chosen = base.candidates.find((c) => c.nodeId === base.nodeId);
    return chosen === undefined ? base : resolveAnyway(input, base, chosen);
  },
};

// ---------------------------------------------------------------------------------------------
// 4. No quiescence gate
// ---------------------------------------------------------------------------------------------

const asSettled = (observation: Observation): Observation =>
  ({
    ...observation,
    stability: { ...observation.stability, settled: true, pendingReason: null },
  }) as Observation;

/**
 * Believes whatever is on the screen right now.
 *
 * This is the failure mode that makes a replay engine untrustworthy WHILE LOOKING LIKE IT WORKS: it
 * is right on every fast page and wrong on the slow one, which is the one that matters. The grid
 * frame says "0 records found" while it is still painting, and this engine tells a member their
 * account is not on file.
 */
export const noSettleGate: DecisionFunctions = {
  classify: (input: ClassifierInput) =>
    classify({
      ...input,
      observation: asSettled(input.observation),
      // An empty window means the digest history cannot contradict the driver's flag, which is the
      // other half of the gate this mutant removes.
      recentDigests: [],
    }),
  resolveTarget,
};

// ---------------------------------------------------------------------------------------------
// 5. Checkpoint before outcomes
// ---------------------------------------------------------------------------------------------

/**
 * Verifies the postcondition first and only then looks for declared outcomes.
 *
 * It is the ordering a test-automation habit produces, and it is why `MEMBER_NOT_FOUND` becomes an
 * exception: the checkpoint for "the member's record opened" is false on a no-results page, so the
 * engine reports a broken flow instead of the answer the caller asked for. This mutant is not
 * dangerous the way the others are - it is over-cautious - and it is in the suite because the
 * assignment's own glossary calls conflating an outcome with a failure the most common design
 * mistake here.
 */
export const checkpointFirst: DecisionFunctions = {
  classify: (input) => {
    const base = classify(input);
    if (base.kind !== "outcome") return base;
    return classify({ ...input, step: { ...input.step, outcomes: [] } });
  },
  resolveTarget,
};

// ---------------------------------------------------------------------------------------------
// 6. No continuity assertions
// ---------------------------------------------------------------------------------------------

/**
 * Checks that A member detail page loaded, never that it is THE member's.
 *
 * The click was unambiguous, the row key matched, the assertion passed - and the application's own
 * search silently widened and navigated somewhere else. Nothing on the screen is wrong; it is simply
 * a different person's money.
 */
export const noContinuity: DecisionFunctions = {
  classify: (input) => {
    const base = classify(input);
    if (base.kind !== "fail" || base.failure !== "continuity-broken") return base;
    return classify({
      ...input,
      step: { ...input.step, expect: { ...input.step.expect, continuity: [] } },
    });
  },
  resolveTarget,
};

// ---------------------------------------------------------------------------------------------
// 7. No effect-delta assertion
// ---------------------------------------------------------------------------------------------

/**
 * Trusts the checkpoint to notice that the action did something.
 *
 * It does not, and it cannot: a checkpoint is a statement about the screen, not about the change.
 * On a page that looks similar before and after - a legacy tab panel that renders `0.00` until its
 * tab loads - a dead control is indistinguishable from success, and the engine returns a balance of
 * zero on the `ok` arm.
 */
export const noDelta: DecisionFunctions = {
  classify: (input) => {
    const base = classify(input);
    if (base.kind !== "fail" || base.failure !== "no-observable-effect") return base;
    return classify({
      ...input,
      step: {
        ...input.step,
        expect: { ...input.step.expect, delta: { ...input.step.expect.delta, mustChange: false } },
      },
    });
  },
  resolveTarget,
};

// ---------------------------------------------------------------------------------------------
// 8. Nearest-string-match promotion of an unmatched screen
// ---------------------------------------------------------------------------------------------

const WORDS = /[a-z0-9]+/g;

const tokensOf = (text: string): readonly string[] => text.toLowerCase().match(WORDS) ?? [];

/**
 * "Nothing matched exactly, so return the closest declared outcome."
 *
 * This is the mutant that models a REAL temptation: an unclassified screen is an operational
 * nuisance, and an engine that always has an answer looks better on a dashboard. It fires only where
 * the correct answer is a hard failure, which is precisely where it does the most damage - a vendor
 * exception page that happens to contain the word "member" becomes `MEMBER_RESTRICTED`, and a member
 * is transferred to a specialist because a downstream service is down.
 *
 * Half the declared code's words is a low bar on purpose. A high bar would make the mutant harmless
 * and prove nothing; the point is that ANY similarity threshold is a machine for inventing outcomes,
 * which is why SPEC section 0.2 refuses to infer one at all.
 */
export const nearestMatch: DecisionFunctions = {
  classify: (input) => {
    const base = classify(input);
    if (base.kind !== "fail" || input.phase !== "post") return base;
    const screen = new Set(
      input.observation.nodes.flatMap((n: UINode) =>
        tokensOf(`${n.name} ${n.text ?? ""} ${n.value ?? ""}`),
      ),
    );
    let best: { readonly code: string; readonly priority: number; readonly score: number } | null =
      null;
    for (const rule of input.step.outcomes) {
      const wanted = tokensOf(rule.code.replace(/_/g, " "));
      if (wanted.length === 0) continue;
      const hits = wanted.filter((w) => screen.has(w)).length;
      const score = hits / wanted.length;
      if (score >= 0.5 && (best === null || score > best.score)) {
        best = { code: rule.code, priority: rule.priority, score };
      }
    }
    if (best === null) return base;
    return { kind: "outcome", code: best.code, data: [], priority: best.priority, alsoMatched: [] };
  },
  resolveTarget,
};

// ---------------------------------------------------------------------------------------------
// 9. No binding provenance in the classifier
// ---------------------------------------------------------------------------------------------

const IGNORED_PROVENANCE = "__provenance-was-not-consulted";

/**
 * Treats every rejected value as if the caller had supplied it.
 *
 * The same red banner means two different things, and the ONLY input that can tell them apart is
 * where the value came from. Told "retry with a different input" for a value it does not control,
 * an agent retries the identical call forever - a loop it cannot exit, on an artifact bug no caller
 * can fix. This is parameterization's second, unadvertised return, and this mutant is what makes
 * that claim measurable rather than rhetorical.
 */
export const noProvenance: DecisionFunctions = {
  classify: (input) => {
    const instruction = input.step.instruction;
    if (instruction.kind !== "fill") return classify(input);
    const carried: ResolvedBinding = {
      name: IGNORED_PROVENANCE,
      origin: "param",
      value: "",
      sensitivity: "public",
      handle: null,
    };
    return classify({
      ...input,
      step: {
        ...input.step,
        instruction: { ...instruction, value: { from: "param", param: IGNORED_PROVENANCE } },
      },
      bindings: [...input.bindings, carried],
    } as ClassifierInput);
  },
  resolveTarget,
};

// ---------------------------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------------------------

export interface Mutant extends ReplayEngine {
  readonly decisions: DecisionFunctions;
  /** Scenario ids this engine MUST fail. Enforced by the meta-test. A floor, never an exact set. */
  readonly mustKill: readonly string[];
}

export const ALL_MUTANTS: readonly Mutant[] = [
  {
    id: "firstMatch",
    description: "takes the first descriptor that resolved instead of requiring agreement",
    // 17 is observed failing too, and not by accident: an under-quorum target is the other
    // shape of "not enough agreement", so the same shortcut commits to it. 16 is the scenario the
    // mutant was written against, and the list is a floor.
    mustKill: ["16"],
    decisions: firstMatch,
  },
  {
    id: "countQuorum",
    description: "counts descriptors instead of counting distinct evidence sources",
    mustKill: ["17"],
    decisions: countQuorum,
  },
  {
    id: "noAssert",
    description: "dispatches without re-deriving the identity of the node it is about to touch",
    mustKill: ["18"],
    decisions: noAssert,
  },
  {
    id: "noSettleGate",
    description: "classifies against whatever is on screen, settled or not",
    mustKill: ["13"],
    decisions: noSettleGate,
  },
  {
    id: "checkpointFirst",
    description: "verifies the checkpoint before looking for declared business outcomes",
    // 03 is observed failing too: it is the other declared-outcome step in the flow.
    mustKill: ["02", "05"],
    decisions: checkpointFirst,
  },
  {
    id: "noContinuity",
    description: "verifies that a member detail page loaded, never that it is the right member's",
    mustKill: ["21"],
    decisions: noContinuity,
  },
  {
    id: "noDelta",
    description: "trusts the checkpoint to notice that the action did anything at all",
    mustKill: ["20"],
    decisions: noDelta,
  },
  {
    id: "nearestMatch",
    description:
      "promotes an unmatched screen to the closest declared outcome by string similarity",
    // The broadest of the nine by construction, and observed failing 04, 06, 08, 09 and 21 as well:
    // any similarity threshold fires on any screen that happens to share words with a declared code.
    // 15 - a vendor exception page becoming MEMBER_RESTRICTED - is the one it was written against.
    mustKill: ["15"],
    decisions: nearestMatch,
  },
  {
    id: "noProvenance",
    description: "classifies a validation error without asking where the rejected value came from",
    mustKill: ["04"],
    decisions: noProvenance,
  },
];

export const REFERENCE_ENGINE: ReplayEngine = {
  id: "reference",
  description: "@crr/runtime's replay engine with @crr/core's own classifier and target resolver",
};
