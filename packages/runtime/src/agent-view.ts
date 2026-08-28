// SPEC section 2.7 - two audiences, one result.
//
// `ReplayResult` is for a PROGRAM: a discriminated union whose `outcome` arm narrows `data` to that
// outcome's own payload. A model does not receive a discriminated union. It receives text, in a
// transcript, that it will still be conditioning on twenty turns later. So the host renders a
// second, deliberately POORER view, and every subtraction below is deliberate:
//
//   · STEP IDS, DESCRIPTORS, EXPECTATION TRACES, OBSERVATION DIGESTS, DRIFT, BUDGETS are removed. A
//     model handed "expected the heading Member Detail" will try to navigate there itself; a model
//     handed a target description will try to route around the engine. Diagnostics are for the
//     operator console and the journal, whose readers are trying to FIX the run rather than finish
//     it. This is the single largest difference between the two projections and it is a safety
//     property, not tidiness.
//   · `suspended` BECOMES `pending`. The model has no session and no lease; from where it sits the
//     run has not finished. Same fact, the model's vocabulary.
//   · OUTPUTS THE CONTRACT WILL NOT DISCLOSE ARE NOT DELIVERED. A tool result is itself a persisted
//     artifact - it lands in the provider transcript and in the agent's conversation history - so
//     "taint governs persistence, not delivery" is not sufficient on its own. This is the control
//     that stops it quietly meaning "regulated data leaves the perimeter". The typed
//     `ReplayOk.outputs` handed to the calling PROGRAM is never masked.
//   · NOTHING IS ADDED. `guidance` is copied from the reviewed `OutcomeDecl` or from core's static
//     per-`FailureClass` table. It is never generated at render time by the component with the least
//     context and the most incentive to be reassuring.
//
// ONE DELIBERATE REFINEMENT OF SPEC 2.7. The spec lists `mask` and `withhold` together under "what
// it removes". Taken literally the two enum members would be indistinguishable, and an enum with
// two indistinguishable members is one member and a bug waiting to be written. So: neither value
// ever reaches the model - that is the safety property and it is absolute - but a `mask` output
// keeps its KEY with a constant placeholder while a `withhold` output does not appear at all. The
// difference is what a model can honestly say: "I have the member's name on file but cannot read it
// to you" is true, useful, and impossible to say about a key that was never there.
//
// The placeholder carries no length. SPEC section 6.2's discovery projection renders
// `value=<masked:12>` because the model there is deciding whether a field truncated what it typed
// and the capacity is on the box anyway. A tool-result reader has no such need, and a length in a
// third-party transcript is a small leak bought for nothing.

import {
  type AgentToolResult,
  AgentToolResultSchema,
  type CapabilityContract,
  type ExtractedValue,
  FAILURE_GUIDANCE,
  type FailureClass,
  type OutputSpec,
  type ReplayResult,
  type ReplayResultDocument,
  type Retriable,
} from "@crr/core";

/** The constant. Not a length, not a hash, not a prefix - see the header note. */
export const MASKED_PLACEHOLDER = "<masked>";

type AgentRetryable = AgentToolResult["retryable"];

/**
 * The model's view of a finished (or parked) run.
 *
 * Accepts either the generic `ReplayResult<C>` a typed call site holds or the validated
 * `ReplayResultDocument` the host actually produced. They are the same runtime shape - the generic
 * is a compile-time refinement of it, which is exactly what the codegen'd literal types buy - so
 * the body narrows on the document and the signature keeps the spec's shape for a typed caller.
 *
 * The output is validated on the way out. That is not belt and braces: this function's whole job is
 * to be the last thing between a regulated value and a third-party transcript, and a projection
 * that silently emitted a field the schema forbids would fail in exactly the place nobody looks.
 */
export function renderForAgent<C extends CapabilityContract>(
  result: ReplayResult<C> | ReplayResultDocument,
  contract: C,
): AgentToolResult {
  const document = result as ReplayResultDocument;
  return AgentToolResultSchema.parse(project(document, contract)) as AgentToolResult;
}

function project(
  result: ReplayResultDocument,
  contract: CapabilityContract,
): Record<string, unknown> {
  switch (result.status) {
    case "ok":
      return {
        status: "ok",
        data: discloseOutputs(result.outputs, contract.outputs),
        // There is no reviewed prose for "it worked", and inventing some would be the one place
        // this function generated text. The sentence is a constant, it says only what the arm
        // already says, and it exists because the schema requires the field.
        guidance: "The capability completed. Use the values in `data`.",
        retryable: "never",
        runId: result.run.runId,
      };

    case "outcome": {
      // Copied VERBATIM from the reviewed declaration on the contract, never from the artifact's
      // rule and never re-derived here. The whole argument for a closed outcome set is that
      // somebody thought about each member of it once, in advance, calmly.
      const declared = contract.outcomes.find((o) => o.code === result.outcome);
      return {
        status: "outcome",
        outcome: result.outcome,
        data: discloseOutcomePayload(result.data, declared?.payload ?? []),
        guidance: declared?.agentGuidance ?? result.guidance,
        retryable: declared?.retryable ?? result.retryable,
        runId: result.run.runId,
      };
    }

    case "suspended":
      return {
        status: "pending",
        // Everything already extracted and validated, disclosed by the same rule as `ok`. This is
        // what lets an agent say something TRUE - "I found your account, I'm checking the balance"
        // - instead of something vague, which is the entire argument for a fourth arm.
        data: discloseOutputs(result.partialOutputs, contract.outputs),
        guidance:
          "A person has been asked to finish this in the system. Tell the user it is being handled and do not start again.",
        retryable: "after_delay",
        runId: result.run.runId,
        // The one string a member can quote to a human. NOT the console url and NOT the step: an
        // intervention id is an opaque handle by construction, which is what makes it safe to say
        // out loud in a chat transcript.
        reference: result.intervention.id,
      };

    case "failed": {
      const guidance = FAILURE_GUIDANCE[result.failure.class];
      return {
        status: "error",
        guidance: guidance.agentGuidance,
        retryable: agentRetryable(result.failure.class, result.failure.retriable),
        runId: result.run.runId,
        reference: result.run.runId,
      };
    }
  }
}

/**
 * `Retriable` -> the agent's vocabulary.
 *
 * The two vocabularies are NOT the same three values, and the difference is load-bearing. An
 * operator's `Retriable` answers "is trying again a coherent idea"; the agent's answers "and is the
 * fix in MY hands". `with_different_inputs` has no counterpart in `Retriable`, so on the failed arm
 * it can only come from the class - and exactly one class means "the argument you supplied is the
 * thing that is wrong": `argument-invalid`. Every other class is either transient (retry as-is) or
 * needs a person to change the environment first (the model must not retry at all).
 *
 * Total by construction, and the reason it is a function rather than a lookup table is that a table
 * keyed by `FailureClass` would be a second copy of core's `FAILURE_GUIDANCE` drifting beside it.
 */
export function agentRetryable(failure: FailureClass, retriable: Retriable): AgentRetryable {
  if (failure === "argument-invalid") return "with_different_inputs";
  return retriable === "same-inputs" ? "after_delay" : "never";
}

/**
 * The disclosure gate for the run's declared outputs.
 *
 * Anything the contract does not declare is dropped rather than passed through. A key the engine
 * produced and the contract never named is, by definition, a value nobody reviewed for disclosure,
 * and the safe reading of an unreviewed value is `withhold`.
 */
function discloseOutputs(
  outputs: Readonly<Record<string, ExtractedValue>>,
  declared: readonly OutputSpec[],
): Readonly<Record<string, ExtractedValue>> {
  const disclosed: Record<string, ExtractedValue> = {};
  for (const spec of declared) {
    if (!(spec.name in outputs)) continue;
    if (spec.agentDisclosure === "withhold") continue;
    disclosed[spec.name] =
      spec.agentDisclosure === "mask" ? MASKED_PLACEHOLDER : (outputs[spec.name] as ExtractedValue);
  }
  return disclosed;
}

/**
 * The same gate over an outcome's payload.
 *
 * An `OutcomeDecl`'s payload fields are `FieldSpec`s and carry `sensitivity` but no
 * `agentDisclosure` - there is no third state to declare, because a payload field exists to be told
 * to the caller. `sensitive` is still masked: a payload field that carries regulated data is
 * exactly as much of a transcript problem as an output is, and the field the schema gives us to
 * decide with is `sensitivity`.
 */
function discloseOutcomePayload(
  data: Readonly<Record<string, ExtractedValue>>,
  declared: readonly { readonly name: string; readonly sensitivity: string }[],
): Readonly<Record<string, ExtractedValue>> {
  const disclosed: Record<string, ExtractedValue> = {};
  for (const field of declared) {
    if (!(field.name in data)) continue;
    disclosed[field.name] =
      field.sensitivity === "sensitive" ? MASKED_PLACEHOLDER : (data[field.name] as ExtractedValue);
  }
  return disclosed;
}
