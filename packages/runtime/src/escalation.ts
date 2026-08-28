// What is escalatable, and the brief that goes with it (SPEC section 7.2 and 7.3).
//
// "Stuck" is not a feeling and it is not "the run took a long time". It is a CLASSIFICATION that
// has already happened: `classify` returned a `FailureClass`, and this module answers the only
// question left - could a human at a terminal plausibly finish this job? Two answers are wrong in
// opposite and expensive ways:
//
//   · escalating something a human cannot fix (a bad artifact, an argument the contract rejects)
//     wastes an operator's shift and trains them to close interventions unread;
//   · failing something a human was forty seconds from finishing tells a calling agent to apologise
//     for a job that was about to succeed (SPEC section 0.6).
//
// So the map is EXHAUSTIVE over `FailureClass` rather than a default-true or default-false rule.
// Adding a failure class to `@crr/core` fails this file's typecheck until somebody decides which
// side of the line it falls on, which is the only mechanism that keeps a table like this honest.
//
// One entry is not a judgement call: `effect-in-doubt` escalates REGARDLESS of the caller's
// `onIntervention`. Nobody gets to say "fail and go home" about an irreversible action whose result
// was never observed - the alternative is a member with two sub-accounts and nobody looking.

import {
  type ExpectationTrace,
  FAILURE_GUIDANCE,
  type FailureClass,
  type Intervention,
  type ObservedSummary,
  type SuspensionReason,
} from "@crr/core";

// ---------------------------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------------------------

/**
 * Every failure class, and the `SuspensionReason` it raises - or `null` for "a human at the app
 * cannot fix this by clicking".
 *
 * `Record<FailureClass, ...>` and not `Partial<...>`: the exhaustiveness is the control. The `null`
 * rows carry their reason in a comment because a reviewer's question is always "why not that one",
 * and a table of thirty entries with no reasons is a table nobody audits.
 */
export const ESCALATION: Readonly<Record<FailureClass, SuspensionReason | null>> = {
  // -- Pre-flight. Decided before a session existed; there is nothing at the app to look at. -----
  "link-error": null,
  "argument-invalid": null,
  "contract-stale": null,
  "artifact-invalid": null,

  // -- Pre-act gates ----------------------------------------------------------------------------
  //
  // A precondition that does not hold is the run's own statement that it is not where it thought
  // it was. It is escalatable in principle, but NOT here: the only place it is raised is the resume
  // re-check (SPEC section 7.4 step 4), which is what a human handing back already failed. Offering
  // the same human the same session again is a loop, not an escalation.
  "precondition-not-met": null,
  // The deployment's allowlist refused. A person clicking cannot widen an allowlist, and if they
  // could, the chokepoint would be advisory.
  "policy-denied": null,
  "approval-required": "approval-required",
  "lease-lost": "session-lost",

  // -- Targeting --------------------------------------------------------------------------------
  //
  // "The control is not there" is usually drift or a wrong tenant, and a human clicking it once by
  // hand teaches the system nothing. Ambiguity and underdetermination are different: we REFUSED to
  // guess between two live candidates, and a person can see which one was meant.
  "target-not-found": null,
  "target-ambiguous": "target-ambiguous",
  "target-underdetermined": "target-underdetermined",
  "target-assert-failed": null,

  // -- Acting and verifying ---------------------------------------------------------------------
  "action-rejected": null,
  "no-observable-effect": null,
  // SPEC section 7.7: the growth mechanism. A screen that matched no declared rule and failed the
  // checkpoint is exactly the case where a human either recognises a business answer nobody
  // declared or a nuisance nobody modelled, and either way the frozen observation becomes a
  // conformance case.
  "checkpoint-failed": "unclassified-state",
  // The run was on a different record than it started on. A human is the only thing that can say
  // whether that was them, and re-running blind is how a balance gets read off the wrong account.
  "continuity-broken": "unclassified-state",
  "output-extraction-failed": null,

  // -- Environment ------------------------------------------------------------------------------
  //
  // An unmodelled native prompt is the second half of `unclassified-state`: the automation will not
  // answer a dialog nobody declared, and a person can.
  "undeclared-dialog": "unclassified-state",
  "session-expired-unrecoverable": "session-lost",
  // The AUTOMATION's role lacks the entitlement. That is stable under retry and it is not a
  // question about this record - a human at a terminal cannot grant their own service account a
  // permission by clicking, and OPEN-QUESTIONS Q1's asymmetry puts it on the failure side.
  "entitlement-denied": null,
  "app-error": null,
  "did-not-settle": null,
  "surface-error": null,

  // -- Taxonomy and budget ----------------------------------------------------------------------
  //
  // Two rules tied. That is an artifact review finding, not a screen a person can unstick.
  "ambiguous-classification": null,
  "recovery-exhausted": "recovery-exhausted",
  // The caller's own ceiling. Handing it to an operator would spend a human's minutes to work
  // around a number the caller chose; the caller re-invokes with a bigger budget instead.
  "budget-exhausted": null,

  // -- The one that must never be retried --------------------------------------------------------
  "effect-in-doubt": "effect-in-doubt",

  // -- The engine admitting it is broken ---------------------------------------------------------
  "internal-invariant": null,
};

/** The `SuspensionReason` a failure raises, or `null` when a human at the app cannot help. */
export function escalationFor(failure: FailureClass): SuspensionReason | null {
  return ESCALATION[failure];
}

export function isEscalatable(failure: FailureClass): boolean {
  return ESCALATION[failure] !== null;
}

/**
 * The one failure that escalates even when the caller asked for `onIntervention: "fail"`.
 *
 * SPEC section 7.2. An irreversible action whose result was never observed is neither a success nor
 * a failure, and "fail and go home" about it is a decision no caller is entitled to make on behalf
 * of the member whose account it touched.
 */
export function escalatesRegardlessOfCaller(failure: FailureClass): boolean {
  return failure === "effect-in-doubt";
}

// ---------------------------------------------------------------------------------------------
// Why it stopped, in words
// ---------------------------------------------------------------------------------------------

/**
 * One sentence from the failure-class table - never free text, never generated at render time.
 *
 * SPEC section 7.3 is explicit that `whyStopped` comes "from the FailureClass table". Two runs that
 * stopped for the same reason must explain themselves the same way, or an operator learns to read
 * the phrasing instead of the class.
 */
export const SUSPENSION_WHY: Readonly<Record<SuspensionReason, string>> = {
  "unclassified-state":
    "The screen matched no declared outcome or recovery and did not satisfy the step's checkpoint.",
  "recovery-exhausted":
    "A declared recovery for this condition gave up, and it is declared to escalate rather than retry.",
  "approval-required":
    "The next action is irreversible and no approval token was presented for this artifact.",
  "target-ambiguous":
    "Two independently computed descriptors selected different controls, so the run refused to click either.",
  "target-underdetermined":
    "Too few independent descriptors agreed on a control, so the run refused to guess.",
  "session-lost":
    "The authenticated session is gone, and re-establishing it is a human act rather than an automated one.",
  "effect-in-doubt":
    "An irreversible action was dispatched and its result was never observed. Do not re-run it; reconcile against the system of record.",
};

/**
 * What to actually do, taken from `FAILURE_GUIDANCE` where the run named a failure class.
 *
 * The suspension reason says what happened; the failure class is what the engine decided, and
 * `@crr/core` already carries a person-facing line for each one. Reusing it is not laziness: it is
 * the same string the failed arm would have shown, so an operator who sees this intervention and
 * later reads the run's result document is not told two different things.
 */
export function suggestedActionFor(reason: SuspensionReason, failure: FailureClass | null): string {
  if (failure !== null) return FAILURE_GUIDANCE[failure].operatorAction;
  switch (reason) {
    case "unclassified-state":
      return "Look at the screen. If it is a business answer nobody declared, add an outcome; if it is a nuisance, add a recovery to the tenant overlay.";
    case "recovery-exhausted":
      return "Clear the condition by hand, then hand back - or abort if the flow cannot continue.";
    case "approval-required":
      return "Mint an approval token for this artifact digest, or abort; the console will not perform an irreversible action.";
    case "target-ambiguous":
    case "target-underdetermined":
      return "Identify the control the step meant, perform it by hand, and hand back so the step re-verifies.";
    case "session-lost":
      return "Re-authenticate the session profile for this tenant, then hand back.";
    case "effect-in-doubt":
      return "Reconcile against the system of record before doing anything else. Do not re-run the capability.";
  }
}

// ---------------------------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------------------------

/**
 * Everything a human needs in order to act, on one screen, with nothing else open.
 *
 * SPEC section 7.3 is deliberate about this: "a link to a log is not context, it is a second task."
 * So the brief carries the capability, the goal TEMPLATE (parameterized - never a member number),
 * where in the flow it stopped, the generated expectation trace, the redacted observed summary, the
 * masked capture, why it stopped and what to do. Nothing here is a value the caller supplied.
 */
export interface BriefInput {
  readonly capabilityTitle: string;
  readonly goalTemplate: string;
  readonly stepIndex: number;
  readonly stepTitle: string;
  readonly expected: ExpectationTrace;
  readonly observed: ObservedSummary;
  readonly evidence: string | null;
  readonly reason: SuspensionReason;
  readonly failure: FailureClass | null;
  /** The remedy's own sentence, when a declared recovery escalated. It is the artifact author's
   *  words about this specific condition and it beats a generic line - so it is appended to the
   *  table's, never substituted for it. */
  readonly note?: string | null;
}

export function interventionBrief(input: BriefInput): Intervention["brief"] {
  const why = SUSPENSION_WHY[input.reason];
  const note = input.note == null || input.note.length === 0 ? "" : ` ${input.note}`;
  return {
    capabilityTitle: clip(input.capabilityTitle, 200),
    goalTemplate: clip(input.goalTemplate, 2000),
    stepIndex: input.stepIndex,
    stepTitle: clip(input.stepTitle, 200),
    whatWasExpected: input.expected,
    whatWasObserved: input.observed,
    evidence: input.evidence as Intervention["brief"]["evidence"],
    whyStopped: clip(`${why}${note}`, 500),
    suggestedAction: clip(suggestedActionFor(input.reason, input.failure), 500),
  } as Intervention["brief"];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
