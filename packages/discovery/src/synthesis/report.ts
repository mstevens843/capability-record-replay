// What synthesis could not decide on its own, said out loud.
//
// Synthesis is deterministic code over a frozen recording. That buys a lot - every locator in the
// artifact is computed rather than authored, every value is replaced by a parameter - but it does
// NOT buy the two things a capability needs a human for, and the honest move is to name them in a
// structured report rather than to invent them and let a reviewer assume they were derived.
//
// The two, and why neither is derivable:
//
//   · A BUSINESS OUTCOME DETECTOR. SPEC section 0.2 is explicit: promotion to a business outcome
//     requires an explicit declared detector, and nothing may be inferred into one - not by string
//     similarity, not by a model, not by "the page looks empty". The model's `finish` tool may
//     propose outcome CANDIDATES (a code, a title, a sentence of reasoning) and this unit carries
//     them into the report verbatim, but it does not write a `detect` predicate for a screen the
//     run never observed. A false MEMBER_NOT_FOUND is the worst thing this system can emit, and a
//     synthesized detector for an unobserved condition is exactly how one gets emitted.
//   · ROUTING PROSE. `whenToUse` / `whenNotToUse` / `agentGuidance` are what a model reads when it
//     decides whether to call the capability at all, and SPEC section 2.3 says models mis-route far
//     more often than they mis-fill arguments. A generated line there is a generated routing
//     decision.
//
// Everything else in the report is evidence: which descriptors survived derivation and which were
// discarded and why, which values became parameters and on what grounds, which route segments were
// canonicalized. That is the material a reviewer needs in order to approve, and SPEC section 6.3
// calls the auditability of it the thing that makes "parameterization IS the privacy control" a
// claim rather than an assertion.

import type { StepId } from "@crr/core";
import type { OutcomeCandidate } from "../tools.js";
import type { ParameterNameSource } from "./parameters.js";
import type { ValueLeak } from "./values.js";

/**
 * How much attention a note needs.
 *
 * `blocking` is not a warning that got louder: a blocking note means synthesis refuses to return a
 * document at all. `review` means the artifact exists and cannot be approved until a person has
 * read the note - the lifecycle already has a place for that, since a synthesized artifact is
 * `proposed` and reaches `draft` only through verification replay (SPEC section 6.6).
 */
export type NoteSeverity = "info" | "review" | "blocking";

export type NoteCode =
  /** A parameter was inferred from the goal text and the value is now stored nowhere. */
  | "parameter-bound"
  /** The value has the shape of regulated data. Approval is blocked until a human confirms the
   *  parameterization - SPEC section 6.3 step 5. */
  | "parameter-regulated-shape"
  /** A parameter exists but could not be NAMED from anything the application published, so it is
   *  named positionally (`value1`). A calling agent routes on the argument name, so a person must
   *  rename it before publication - see the naming chain at the top of `parameters.ts`. */
  | "parameter-name-underived"
  /** A concrete route segment was replaced by a pattern hole. */
  | "route-canonicalized"
  /** A route segment looked like an identifier but matched no parameter, so it was replaced by a
   *  hole that names nothing. Someone has to say where that value comes from. */
  | "route-segment-unbound"
  /** A descriptor candidate was computed and then discarded, with the reason. */
  | "descriptor-rejected"
  /** The surviving descriptors rest on too little independent evidence (SPEC section 5.2). */
  | "target-underdetermined"
  /** A recorded action has no representation in the artifact instruction set. */
  | "instruction-not-representable"
  /** A recorded dialog dismissal became an ambient recovery rather than a step (Q3 of
   *  OPEN-QUESTIONS-RESOLVED: an optional interstitial is a recovery, not a branch). */
  | "dialog-lifted-to-recovery"
  /** The model proposed a business outcome. No detector was written for it. */
  | "outcome-candidate-needs-detector"
  /** Prose a person must write before this contract is published. */
  | "prose-needs-author"
  /** A recorded step was not emitted, because it never dispatched. */
  | "step-not-dispatched"
  /** A continuity value was derived: the subject is re-observed at a later step. */
  | "continuity-derived";

export interface SynthesisNote {
  readonly code: NoteCode;
  readonly severity: NoteSeverity;
  /** Safe to log. Never contains a recorded value - a note about a member number that quotes the
   *  member number is the leak it is reporting. */
  readonly detail: string;
  readonly stepId?: StepId;
}

/**
 * The evidence a reviewer reads next to the artifact.
 *
 * Not part of the artifact, deliberately: the artifact is the program, and a program with an
 * "unresolved questions" section is a program whose digest changes when somebody answers one.
 */
export interface SynthesisReport {
  readonly notes: readonly SynthesisNote[];
  /** Verbatim from the model's `finish`. Carried, never converted into a detector. */
  readonly outcomeCandidates: readonly OutcomeCandidate[];
  /** Parameters, by name, with the evidence for each. Values are absent by construction. */
  readonly parameters: readonly {
    readonly name: string;
    readonly sensitivity: string;
    readonly discoveredFrom: "goal" | "operator";
    /** Which rung of the naming chain the NAME came off. `positional` means none of them did, and
     *  is always accompanied by a `parameter-name-underived` note. */
    readonly namedFrom: ParameterNameSource;
  }[];
  /** `stepId -> descriptor ids that survived`, so a reviewer can see the margin before it thins. */
  readonly descriptors: Readonly<Record<string, readonly string[]>>;
}

export function noteHasSeverity(notes: readonly SynthesisNote[], severity: NoteSeverity): boolean {
  return notes.some((note) => note.severity === severity);
}

/**
 * Synthesis refused to produce a document.
 *
 * Thrown rather than returned. A recorder that cannot write a faithful artifact has found a bug in
 * itself or a flow that this language cannot express, and both are conditions where continuing
 * with a partial document is worse than stopping - SPEC section 2.4 makes the same call about a
 * step with no postcondition ("the recorder refuses and the schema has no way to express it").
 */
export class SynthesisError extends Error {
  readonly notes: readonly SynthesisNote[];
  readonly problems: readonly string[];
  readonly leaks: readonly ValueLeak[];

  constructor(
    message: string,
    detail: {
      readonly notes?: readonly SynthesisNote[];
      readonly problems?: readonly string[];
      readonly leaks?: readonly ValueLeak[];
    } = {},
  ) {
    super(message);
    this.name = "SynthesisError";
    this.notes = detail.notes ?? [];
    this.problems = detail.problems ?? [];
    this.leaks = detail.leaks ?? [];
  }
}
