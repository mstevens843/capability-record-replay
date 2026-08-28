// The resume precondition re-check - SPEC section 7.4, "the part that is usually a TODO".
//
// Resume is NOT "continue at pc". A human has held the session; the screen they hand back is not
// the screen they were given, and the interesting failure is silent: the operator investigated by
// pulling up a DIFFERENT member's record, handed back, and the run carried on reading a balance off
// the wrong account. Nothing about that is visible in a log unless somebody checked.
//
// So six checks run before the interpreter is allowed to touch the surface again, in SPEC's order,
// and the seventh is that the step re-runs from the TOP of the cycle rather than from the middle.
// Each one is reported as a row, pass or fail, because a re-check whose passes are invisible is a
// re-check nobody believes and nobody notices when it stops running.
//
// Two decisions inside are worth defending:
//
//   · STEP 3 CLASSIFIES WITH THE PRECONDITION REMOVED, and step 4 evaluates the precondition on its
//     own. `classify`'s band G checks the precondition before every B band, so a single call would
//     report every hand-back onto a wrong screen as `precondition-not-met` and step 3 would never
//     get to say anything. They are different questions - "does the taxonomy already have an answer
//     for this screen" and "may this step run here" - and SPEC gives them separate lines and
//     separate failure classes.
//   · THE BUSINESS-OUTCOME PROBE IS A SECOND `classify` CALL AT PHASE `post`, and only its
//     `outcome` arm is read. Outcome detectors are declared `phase: "post"` by the schema (they must
//     not fire before the action that would produce them), so a pre-phase classification structurally
//     cannot see one - and SPEC section 7.4 step 3 requires that a human who landed on a declared
//     business answer TERMINATES the run correctly rather than resuming into it. Re-implementing
//     band B3 here to get around that would put a second copy of the taxonomy in the runtime, which
//     is the one thing this design refuses to do. Asking the real classifier one narrow question and
//     ignoring every other arm is the honest version.

import {
  type AttemptCounters,
  type ClassifierInput,
  type EvalContext,
  type ExpectationTrace,
  type FailureClass,
  type LeaseState,
  type LinkedProgram,
  type Observation,
  type PerceiveFault,
  type ResolvedBindings,
  type ResolvedStep,
  type Verdict,
  classify,
  evaluatePredicate,
  renderVerdict,
} from "@crr/core";
import type { ApprovalGrant } from "./approval.js";

/** One line of the re-check, as an operator and a journal both see it. */
export interface ResumeCheck {
  /** 1-7, SPEC section 7.4's own numbering. */
  readonly step: number;
  readonly name: string;
  readonly passed: boolean;
  readonly note: string;
}

export type ResumePrecheckResult =
  /** Every check held. The interpreter may re-run the step from the top of the cycle. */
  | { readonly kind: "proceed"; readonly checks: readonly ResumeCheck[] }
  /**
   * The screen has not settled yet. NOT a failure and NOT a resume: the operator is standing at the
   * console and can press the button again in two seconds. Converting a half-painted page into a
   * terminal failure would be exactly the "not yet is not not so" mistake, one level up.
   */
  | { readonly kind: "not-yet"; readonly checks: readonly ResumeCheck[]; readonly note: string }
  /** The human left the session on a screen the taxonomy already has an answer for. */
  | {
      readonly kind: "outcome";
      readonly verdict: Extract<Verdict, { readonly kind: "outcome" }>;
      readonly checks: readonly ResumeCheck[];
    }
  /** The run does not continue. `failure` names why, and `notes` say which check and what it saw. */
  | {
      readonly kind: "refuse";
      readonly failure: FailureClass;
      readonly notes: readonly string[];
      readonly checks: readonly ResumeCheck[];
    };

export interface ResumePrecheckInput {
  readonly program: LinkedProgram;
  /** The step the run suspended at. Resume re-runs THIS step, never the next one. */
  readonly step: ResolvedStep;
  /** A fresh `perceive()`, taken after the human handed back. `null` when perception faulted. */
  readonly observation: Observation | null;
  readonly perceiveFault?: PerceiveFault | null;
  readonly bindings: ResolvedBindings;
  readonly counters: AttemptCounters;
  readonly elapsedMs: number;
  /**
   * The lease authority's answer for the token the run held BEFORE the handoff.
   *
   * Asking about the pre-handoff token is the whole point: `handoff-resume` is the one state that
   * says "this automation gave the session up deliberately and has just been handed it back", and
   * it is distinguishable from `lost` only if the question names the old grant.
   */
  readonly leaseState: LeaseState;
  readonly approval: ApprovalGrant | null;
  /**
   * True when an irreversible action was already authorized in this run, read off the journal's own
   * `policy.decided` events. SPEC section 7.4 step 6: "a token consumed before the handoff does not
   * survive it."
   */
  readonly approvalAlreadySpent: boolean;
}

const NAMES = {
  1: "lease re-acquired at a new epoch",
  2: "surface re-observed",
  3: "screen re-classified",
  4: "step precondition re-verified",
  5: "continuity re-verified",
  6: "effect gate re-checked",
  7: "step re-runs from the top of the cycle",
} as const;

export function resumePrecheck(input: ResumePrecheckInput): ResumePrecheckResult {
  const checks: ResumeCheck[] = [];
  const pass = (step: keyof typeof NAMES, note: string): void => {
    checks.push({ step, name: NAMES[step], passed: true, note });
  };
  const refuse = (
    step: keyof typeof NAMES,
    failure: FailureClass,
    note: string,
    extra: readonly string[] = [],
  ): ResumePrecheckResult => {
    checks.push({ step, name: NAMES[step], passed: false, note });
    return { kind: "refuse", failure, notes: [note, ...extra], checks };
  };

  // ---- 1  LEASE ------------------------------------------------------------------------------
  //
  // Any token minted under an older epoch is dead. `handoff-resume` is the expected answer here and
  // `held` is tolerated (a hand-back that happened without an intervening human grant); anything
  // else means the session moved somewhere this run does not know about.
  if (input.leaseState === "lost") {
    return refuse(
      1,
      "lease-lost",
      "the session is no longer held by this run at the epoch it knew",
    );
  }
  pass(1, `the automation holds the session again (${input.leaseState})`);

  // ---- 2  RE-OBSERVE -------------------------------------------------------------------------
  //
  // The screen the human left is not assumed to be the screen they were given. That is the entire
  // reason this function exists, and it is why nothing below reads a cached observation.
  if (input.observation === null) {
    return refuse(
      2,
      "surface-error",
      `the surface could not report what the screen looks like${
        input.perceiveFault == null ? "" : ` (${input.perceiveFault.kind})`
      }`,
    );
  }
  const observation = input.observation;
  const ctx: EvalContext = {
    observation,
    program: input.program.facts,
    bindings: input.bindings,
  };
  pass(
    2,
    `${observation.nodes.length} nodes at ${observation.route?.path ?? "an unnamed route"}, ${
      observation.stability.settled ? "settled" : "not settled"
    }`,
  );

  // ---- 3  RE-CLASSIFY ------------------------------------------------------------------------
  const base = classifierInput(input, observation, "pre");
  const preVerdict = classify({
    ...base,
    // See the module header: step 4 owns the precondition, so step 3 must not be allowed to answer
    // for it. Everything else about the step - its recoveries, its budgets, its effect - is intact.
    step: { ...input.step, precondition: null } as ResolvedStep,
  });

  switch (preVerdict.kind) {
    case "fail":
      return refuse(
        3,
        preVerdict.failure,
        `the screen classified as ${preVerdict.failure}`,
        preVerdict.detail.expected.rendered.length === 0
          ? []
          : [preVerdict.detail.expected.rendered],
      );
    case "pending":
      checks.push({
        step: 3,
        name: NAMES[3],
        passed: false,
        note: "the screen has not settled; hand back again once it has",
      });
      return {
        kind: "not-yet",
        checks,
        note: "the screen has not settled; hand back again once it has",
      };
    case "outcome":
      // Structurally unreachable at phase `pre` (band B3 is post-only) and handled anyway, because
      // a total switch is cheaper than a comment promising one arm cannot happen.
      pass(3, `the screen already reads as the declared outcome ${preVerdict.code}`);
      return { kind: "outcome", verdict: preVerdict, checks };
    case "recover":
      pass(
        3,
        `the declared recovery ${preVerdict.recoveryName} matches; the step will apply it on re-entry`,
      );
      break;
    case "advance":
      pass(3, "the screen matched no environment, interception or recovery rule");
      break;
  }

  // ---- 3b  THE BUSINESS-OUTCOME PROBE --------------------------------------------------------
  const probe = classify(classifierInput(input, observation, "post"));
  if (probe.kind === "outcome") {
    pass(3, `the screen already reads as the declared outcome ${probe.code}`);
    return { kind: "outcome", verdict: probe, checks };
  }

  // ---- 4  PRECONDITION -----------------------------------------------------------------------
  //
  // This is the whole point of preconditions being a declared field rather than belt and braces: a
  // language whose steps declare what they require is a language whose execution can be interrupted.
  const precondition = input.step.precondition;
  if (precondition !== null) {
    const trace = renderVerdict(precondition, ctx);
    if (!evaluatePredicate(precondition, ctx)) {
      return refuse(
        4,
        "precondition-not-met",
        `step ${input.step.id} requires ${trace.rendered}`,
        failedClauses(trace),
      );
    }
    pass(4, trace.rendered);
  } else {
    pass(4, "the step declares no precondition");
  }

  // ---- 5  CONTINUITY -------------------------------------------------------------------------
  //
  // A human who navigated to a different member's record while investigating must not have the run
  // resume into that member's account. This is the check that says so.
  for (const ref of input.step.expect.continuity) {
    if (!evaluatePredicate({ kind: "continuity", ref }, ctx)) {
      return refuse(
        5,
        "continuity-broken",
        `continuity "${ref}" no longer holds on the screen that was handed back`,
      );
    }
  }
  pass(
    5,
    input.step.expect.continuity.length === 0
      ? "the step asserts no continuity values"
      : `${input.step.expect.continuity.join(", ")} still hold`,
  );

  // ---- 6  EFFECT GATE ------------------------------------------------------------------------
  if (input.step.effect === "WRITE_IRREVERSIBLE") {
    if (input.approval === null) {
      return refuse(
        6,
        "approval-required",
        "the step is irreversible and no approval token survives the handoff",
      );
    }
    if (input.approval.digest !== input.program.artifact.digest) {
      return refuse(
        6,
        "approval-required",
        "the approval token was minted against a different artifact digest",
      );
    }
    if (input.approvalAlreadySpent) {
      return refuse(
        6,
        "approval-required",
        "this run already authorized an irreversible action; a consumed token does not survive a handoff",
      );
    }
    pass(6, "the approval token is still valid for this artifact at the new epoch");
  } else {
    pass(6, `the step is ${input.step.effect}; no approval is required`);
  }

  // ---- 7  RE-RUN FROM THE TOP ----------------------------------------------------------------
  pass(7, `step ${input.step.id} re-runs from the top of the cycle, not from the middle`);
  return { kind: "proceed", checks };
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

function classifierInput(
  input: ResumePrecheckInput,
  observation: Observation,
  phase: "pre" | "post",
): ClassifierInput {
  return {
    observation,
    // One sample. `hasQuiesced` treats a window shorter than `stableSamples` as quiesced provided
    // the driver says settled, so a single fresh perceive is enough to be classified - and a poll
    // loop here would be the settle budget spent twice, once by the interpreter and once by us.
    recentDigests: [observation.skeletonDigest],
    // Nothing has been dispatched since the human handed back, so there is no pre-act digest and
    // no delta to assert. The probe reads only the `outcome` arm, which does not consult it.
    preActDigest: null,
    step: input.step,
    ambient: input.program.ambient,
    phase,
    bindings: input.bindings,
    counters: input.counters,
    program: input.program.facts,
    elapsedMs: input.elapsedMs,
    settleElapsedMs: 0,
    gate: { lease: input.leaseState, policy: null, target: null },
    irreversibleDispatched: false,
  };
}

/** The clauses of a rendered predicate that did not hold - the half an operator actually needs. */
function failedClauses(trace: ExpectationTrace): readonly string[] {
  return trace.clauses.filter((c) => !c.verdict).map((c) => `not satisfied: ${c.rendered}`);
}
