// SPEC section 4 - the entire runtime error taxonomy, as one total function.
//
// This is the product. The step list is the easy part; the declared mapping from *what the screen
// shows* to *what the caller is told* is what a replay engine is actually for, and getting it wrong
// is silent. The assignment names conflating an expected business outcome with a hard failure as
// the most common design mistake in this problem, and every rule below exists to make that mistake
// unrepresentable rather than merely discouraged.
//
// Four governing rules, in the order they override each other:
//
//   1. FAIL CLOSED TOWARD `failed`. Promotion to a business outcome requires an explicit declared
//      detector on the step. Nothing is inferred into an outcome - not by string similarity, not by
//      a model, not by "the page looks empty". A false MEMBER_NOT_FOUND is the worst thing this
//      system can emit, because it is indistinguishable from a true one at the receiving end.
//   2. "NOT YET" IS NOT "NOT SO". No negative business outcome may be classified against a surface
//      that has not demonstrably settled. B0 runs before every declared detector, and
//      `requiresSettled` is a non-configurable literal on top of that.
//   3. AN OUTCOME IS A FACT THAT SURVIVES A RETRY; A FAILURE IS A FACT ABOUT THE SYSTEM THAT MIGHT
//      NOT. A permission denial about the RECORD is an outcome. A permission denial about the
//      AUTOMATION'S OWN SESSION is `failed / entitlement-denied`. Where a detector cannot tell them
//      apart, the undeclared case is the failure - never the outcome.
//   4. AMBIGUITY IS A REFUSAL, NEVER A COIN FLIP. Two rules matching in one band with no total
//      order is `ambiguous-classification` and a hard stop. It is not resolved by declaration
//      order, because an answer chosen by array index has already been shipped to a member by the
//      time anybody notices.
//
// The function is pure, total, and deterministic: no clock (`elapsedMs` is an argument), no I/O, no
// randomness, no driver import, no mutation of its input, one fixed band order in code. That is not
// stylistic - it is what makes SPEC section 4.8 true, which is that a production failure becomes a
// unit test by saving one JSON file, and it is why this whole taxonomy is exercised in
// `test/classifier.test.ts` with no browser anywhere.

import type { RecoveryRule, Remedy, ResolvedStep } from "./artifact.js";
import type {
  ExtractedOutput,
  FailureClass,
  FailureDetail,
  SideEffects,
  TargetCandidate,
  Verdict,
} from "./diagnostics.js";
import { FAILURE_GUIDANCE, PRE_FLIGHT_FAILURES } from "./diagnostics.js";
import {
  type EvalContext,
  type ExtractOutcome,
  type ProgramFacts,
  type ResolvedBindings,
  bindingFor,
  evaluatePredicate,
  isCallerSupplied,
  observedSummaryOf,
  queryNodes,
  readExtractSpec,
  renderPredicate,
} from "./evaluate.js";
import type { ActFault, Observation, PerceiveFault, UINode } from "./observation.js";
import type { PolicyDecision } from "./policy.js";
import { renderVerdict } from "./render.js";

// ---------------------------------------------------------------------------------------------
// Inputs
//
// Deliberately plain interfaces rather than zod schemas. Everything here is constructed by the
// interpreter in-process from documents that were ALREADY validated; none of it crosses a trust
// boundary, and a second validator on the far side of a merge buys a version skew rather than a
// guarantee. The one input that does arrive from outside - the `Observation` - has a validator, and
// that is what makes a frozen snapshot on disk a complete test case.
// ---------------------------------------------------------------------------------------------

/** Who holds the session. A handoff resume is the one case where the automation did not lose it. */
export type LeaseState = "held" | "lost" | "handoff-resume";

/** The four resolution outcomes of SPEC section 5, as the classifier consumes them. Resolution
 *  itself belongs to the target resolver; classifying its result belongs here. */
export type TargetResolutionStatus =
  | "resolved"
  | "not-found"
  | "ambiguous"
  | "underdetermined"
  | "assert-failed";

/**
 * How target resolution came out, as the classifier consumes it.
 *
 * Structurally the subset of the target resolver's own `TargetResolutionResult` that a
 * classification needs, so the executor hands its result straight across with no adapter.
 * Deliberately not an import: the classifier is unit 4 and the resolver is unit 5, and a band that
 * only needs "which of the four outcomes, and what did each descriptor say" should not take a
 * dependency on how they were computed.
 *
 * The field is `status` and not `kind` because that is what makes the previous sentence TRUE rather
 * than merely intended. The two units were built in parallel, agreed on the name of the type
 * (`TargetResolutionStatus`) and on every one of its five values, and then spelled the field two
 * different ways - so the "no adapter" claim was one rename away from being false, and nothing
 * caught it until `test/integration.test.ts` assigned one to the other.
 */
export interface TargetOutcome {
  readonly status: TargetResolutionStatus;
  /** Each descriptor's account of itself, including its evidence source - because three candidates
   *  that agree are not three pieces of evidence if they all read the same label. */
  readonly candidates: readonly TargetCandidate[];
}

/**
 * The pre-act facts the executor already knows and the classifier cannot compute for itself.
 *
 * Band G is a CLASSIFICATION of these, not a re-derivation of them: the lease lives in the runtime,
 * the policy decision comes from the single chokepoint, and resolution is the target resolver's.
 * Absent when the executor has not reached that part of the cycle yet.
 */
export interface GateFacts {
  readonly lease: LeaseState;
  readonly policy: PolicyDecision | null;
  readonly target: TargetOutcome | null;
}

export interface BudgetCounter {
  readonly used: number;
  readonly limit: number;
}

/**
 * The three nested ledgers of SPEC section 3.4, as plain integers.
 *
 * They are counters and not clocks on purpose. Exhaustion is a CLASSIFICATION - it carries which
 * recovery, how many attempts, and the skeleton digest at each one - rather than a timeout, so
 * "why did dismissing this dialog not work" is answerable from the journal with no reproduction.
 */
export interface AttemptCounters {
  /** Attempts already spent, keyed by recovery name, at THIS step. */
  readonly recoveryAttempts: Readonly<Record<string, number>>;
  /** Remedies applied to this step across all recoveries. Separate from the per-recovery budget
   *  because two recoveries can ping-pong with neither exceeding its own. */
  readonly remediationCycles: number;
  readonly run: {
    readonly actions: BudgetCounter;
    readonly observations: BudgetCounter;
    readonly remediations: BudgetCounter;
    readonly programAttempts: BudgetCounter;
  };
  /** The run's wall-clock ledger, compared against `elapsedMs`. */
  readonly deadlineMs: number;
}

export interface ClassifierInput {
  /** Frozen, surface-independent, plain JSON. */
  readonly observation: Observation;
  /**
   * The settle poll window for THIS observation: the skeleton digests the executor saw while
   * waiting, oldest first, with the current observation's last.
   *
   * Quiescence is a property of a sequence but polling is I/O: the executor polls, the classifier
   * is handed the sequence and decides. B0 corroborates the driver's own `settled` flag against
   * the last `settle.stableSamples` entries, which is the second half of the torn-read defence -
   * a driver that says "settled" while the digest is still moving does not get to be believed.
   */
  readonly recentDigests: readonly string[];
  /**
   * The skeleton digest at the moment this step began, before its action was dispatched.
   *
   * This is what the effect-delta assertion compares against (control C5). `null` means the
   * executor did not record one, and the delta therefore CANNOT be shown to have happened - which
   * fails closed to `no-observable-effect` rather than to a silent pass.
   *
   * A separate field from `recentDigests` because the two are different sequences: the poll window
   * is what the screen did while we waited, and this is what it looked like before we touched it.
   * Folding them into one array made index 0 mean two things, and the settle window is exactly
   * where the pre-act digest does NOT belong.
   */
  readonly preActDigest: string | null;
  /** Post-overlay, post-binding. */
  readonly step: ResolvedStep;
  /** Flow-level rules. Recoveries and environment conditions only - never business outcomes. */
  readonly ambient: readonly RecoveryRule[];
  readonly phase: "pre" | "post";
  /** Values AND their provenance. This is what tells SPEC section 4.2 row 4 from row 5. */
  readonly bindings: ResolvedBindings;
  readonly counters: AttemptCounters;
  /** Whole-run facts the linker resolved. */
  readonly program: ProgramFacts;
  /** Elapsed run wall time. The only way time enters, and why `classify` has no clock. */
  readonly elapsedMs: number;
  /** This step's own settle clock, compared against `step.settle.maxWaitMs`. */
  readonly settleElapsedMs: number;
  readonly gate?: GateFacts;
  readonly actFault?: ActFault;
  readonly perceiveFault?: PerceiveFault;
  /** True once dispatch has begun on an irreversible step. Gates SPEC section 3.5. */
  readonly irreversibleDispatched: boolean;
}

/** A rule with the fact of where it came from, because an ambient rule colliding with a step rule
 *  is one of the two ways a priority tie can reach a step. */
interface BandedRule {
  readonly rule: RecoveryRule;
  readonly source: "step" | "ambient";
}

// ---------------------------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------------------------

/**
 * The entire runtime error taxonomy, as one total function from a frozen `Observation` to a
 * `Verdict`.
 *
 * Bands are evaluated top to bottom and THE FIRST BAND THAT PRODUCES A VERDICT WINS; no lower band
 * runs. Four of those orderings are load-bearing and none of them is a matter of taste:
 *
 *   · B0 before everything, because a negative classification against a half-rendered page is the
 *     failure mode that makes a replay engine untrustworthy while looking like it works.
 *   · B1 (environment) before B3 (declared outcomes), because a session-expiry screen often has an
 *     empty content region that looks exactly like "no results". This is the single most important
 *     precedence call in the problem: without it, a session timeout becomes MEMBER_NOT_FOUND.
 *   · B2 (interception) before B3, because what is visible behind a modal is stale by
 *     construction - reading an outcome off it is reading history.
 *   · B3 before B4, because an outcome is terminal and already true; burning a recovery budget on a
 *     page that has given you the final answer wastes attempts and risks a remedy navigating away
 *     from it.
 */
export function classify(input: ClassifierInput): Verdict {
  const ctx: EvalContext = {
    observation: input.observation,
    program: input.program,
    bindings: input.bindings,
  };

  return terminalizeAfterIrreversibleDispatch(bands(input, ctx), input, ctx);
}

function bands(input: ClassifierInput, ctx: EvalContext): Verdict {
  // Row 34. A system that cannot say "I am broken" says "you are" instead.
  const invariant = brokenInvariant(input);
  if (invariant !== null) return fail(input, ctx, "internal-invariant", { note: invariant });

  // Row 33, and it comes before everything including the lease, because after an irreversible
  // dispatch there is no honest local classification of anything else. It did not fail and it did
  // not succeed; a replay engine that retries here opens two sub-accounts.
  if (input.irreversibleDispatched && input.perceiveFault !== undefined) {
    return fail(input, ctx, "effect-in-doubt");
  }

  const gateVerdict = bandG(input, ctx);
  if (gateVerdict !== null) return gateVerdict;

  // Row 22. A driver reports what the machinery did and never what it meant; turning one of these
  // into a failure class needs the artifact's context, which is here.
  if (input.actFault !== undefined) return actFaultVerdict(input, ctx, input.actFault);

  const quiescence = bandB0(input, ctx);
  if (quiescence !== null) return quiescence;

  const environment = bandB1(input, ctx, true);
  if (environment !== null) return environment;

  const interception = bandB2(input, ctx);
  if (interception !== null) return interception;

  // B2 returning null with something still intercepting means one thing and only one thing: the
  // step declared this dialog and B2 stood down for it (`declaredInterception`). The checkpoint
  // gets to speak - but band B3 does NOT.
  //
  // THE STAND-DOWN IS ABOUT THE DIALOG, NEVER ABOUT THE SCREEN BEHIND IT. What is behind a modal is
  // still the state before whatever raised it, so a terminal business outcome classified there
  // would be reading history - which is the TRUE half of "B2 before B3" and survives this
  // amendment untouched. Linker check 25 refuses such a step at load time for the same reason; this
  // is the structural half, and it holds for a document that was never linked.
  const behindADeclaredDialog = interceptionPresent(input.observation);

  if (input.phase === "post" && !behindADeclaredDialog) {
    const outcome = bandB3(input, ctx);
    if (outcome !== null) return outcome;
  }

  const recovery = bandB4(input, ctx);
  if (recovery !== null) return recovery;

  if (input.phase === "post") return bandB5(input, ctx);

  // Phase `pre`, nothing detected: the step may proceed. `advance` with no outputs is how the
  // classifier says "I have nothing to report", and it keeps the function total without an
  // `undefined` return the caller has to remember to handle.
  return { kind: "advance", outputs: [] };
}

// ---------------------------------------------------------------------------------------------
// Band G - lease, budget, policy, precondition, target
// ---------------------------------------------------------------------------------------------

function bandG(input: ClassifierInput, ctx: EvalContext): Verdict | null {
  const gate = input.gate;

  // Row 28. The interesting failure is not a human and an automation racing for a click; it is an
  // automation that still believes it holds a session a human took forty seconds ago.
  if (gate !== undefined && gate.lease === "lost") return fail(input, ctx, "lease-lost");

  // Row 32, first of two placements. A run ledger is checked BEFORE acting and again before a
  // recovery is granted, and nowhere else: returning an outcome or advancing spends no budget, so
  // a page that has already given us the final answer is not withheld because the ledger is thin.
  if (input.phase === "pre" && runLedgerExhausted(input)) {
    return fail(input, ctx, "budget-exhausted");
  }

  // Row 27.
  if (gate?.policy != null && gate.policy.allow === false) {
    const cls: FailureClass =
      gate.policy.reason === "irreversible-requires-approval"
        ? "approval-required"
        : "policy-denied";
    return fail(input, ctx, cls, { note: gate.policy.detail });
  }

  // Row 29.
  if (
    input.phase === "pre" &&
    input.step.precondition !== null &&
    !evaluatePredicate(input.step.precondition, ctx)
  ) {
    return fail(input, ctx, "precondition-not-met");
  }

  // Rows 17-20. B2 is consulted here and not only after the fact: a blocking overlay makes every
  // locator resolution suspect, so "we could not find the button" behind an undeclared modal is
  // reported as the modal, which is the condition a human can actually act on.
  if (gate?.target != null && gate.target.status !== "resolved") {
    if (interceptionPresent(input.observation)) return null;
    return fail(input, ctx, TARGET_FAILURE[gate.target.status], {
      candidates: gate.target.candidates,
    });
  }

  return null;
}

const TARGET_FAILURE: Readonly<Record<Exclude<TargetResolutionStatus, "resolved">, FailureClass>> =
  {
    "not-found": "target-not-found",
    ambiguous: "target-ambiguous",
    underdetermined: "target-underdetermined",
    "assert-failed": "target-assert-failed",
  };

function runLedgerExhausted(input: ClassifierInput): boolean {
  const { run, deadlineMs } = input.counters;
  return (
    run.actions.used >= run.actions.limit ||
    run.observations.used >= run.observations.limit ||
    input.elapsedMs >= deadlineMs
  );
}

// ---------------------------------------------------------------------------------------------
// Post-act driver refusals - row 22
// ---------------------------------------------------------------------------------------------

function actFaultVerdict(input: ClassifierInput, ctx: EvalContext, fault: ActFault): Verdict {
  switch (fault.kind) {
    case "lease-not-held":
      return fail(input, ctx, "lease-lost");
    case "surface-error":
      return fail(input, ctx, "surface-error", { note: fault.message });
    default:
      return fail(input, ctx, "action-rejected", { note: fault.kind });
  }
}

// ---------------------------------------------------------------------------------------------
// Band B0 - quiescence. The gate that stops "not yet" being read as "not so".
// ---------------------------------------------------------------------------------------------

function bandB0(input: ClassifierInput, ctx: EvalContext): Verdict | null {
  // Row 21. An open native dialog blocks the renderer and the accessibility tree never returns at
  // all: no error, no timeout of its own. That is a hang, and a hang has no failure class - which
  // is why `perceive` carries a deadline and reports a fault instead.
  if (input.perceiveFault !== undefined) {
    const cls: FailureClass =
      input.observation.nativeDialog !== null && matchingRules(input, ctx, "interception") === null
        ? "undeclared-dialog"
        : "surface-error";
    return fail(input, ctx, cls, { note: input.perceiveFault.kind });
  }

  if (hasQuiesced(input)) return null;

  // Only an environment recovery may declare `allowUnsettled`, and only because an error page or an
  // expired-session banner is WHY the surface will never settle. Everything else waits: a detector
  // that fires on a half-painted page is the exact hazard rule 2 of this module exists to close.
  const environment = bandB1(input, ctx, false);
  if (environment !== null) return environment;

  // Row 15. A spinner-forever and a 500 page are different answers, and the run says which.
  if (input.settleElapsedMs >= input.step.settle.maxWaitMs) {
    return fail(input, ctx, "did-not-settle");
  }

  // Row 14. Transient slowness needs no remedy - it IS the settle budget doing its job.
  return { kind: "pending", reason: "not-settled", settleElapsedMs: input.settleElapsedMs };
}

// ---------------------------------------------------------------------------------------------
// Band B1 - environment. Rows 11, 12, 13, 16.
// ---------------------------------------------------------------------------------------------

function bandB1(input: ClassifierInput, ctx: EvalContext, settled: boolean): Verdict | null {
  const matched = matchingRules(input, ctx, "environment", settled ? undefined : true);
  if (matched === null) return null;
  if ("ambiguous" in matched)
    return fail(input, ctx, "ambiguous-classification", { note: matched.note });

  const { rule } = matched;

  // Terminal by declaration: the author said a remedy cannot clear this and the interpreter must
  // not spend a recovery attempt pretending otherwise. Checked before the budget for that reason.
  if (rule.remedy.kind === "escalate" || rule.resume === "escalate") {
    return fail(input, ctx, terminalEnvironmentClass(rule));
  }

  const exhausted = recoveryBudget(input, ctx, rule);
  if (exhausted !== null) return exhausted;

  // Rows 13 and 16. The gate exists because a program that has already opened a sub-account cannot
  // be restarted, and the linker can say which steps make that true before anything runs.
  if (!restartGatePasses(input, rule)) return fail(input, ctx, terminalEnvironmentClass(rule));

  return recoverWith(input, ctx, rule);
}

/**
 * Which of the three terminal environment failures a declared condition is - taken from the
 * REMEDY, not from a second field and never from the rule's name.
 *
 * The three classes the taxonomy distinguishes map one-to-one onto the three things an environment
 * remedy can say, and that is not a coincidence: a condition the SESSION BROKER can fix
 * (`reauthenticate`, rows 11-13), a condition a PERSON must fix outside this run (`escalate`,
 * row 8 - the automation's own role lacks the entitlement, which will fail identically for every
 * input forever), and a condition that is the APPLICATION's own fault (anything else, row 16).
 *
 * Deriving the class rather than declaring it separately is deliberate. A second field would be a
 * second place for the same fact to live, and the interesting bug is the day the two disagree -
 * at which point an artifact says "reauthenticate" and reports "the application is broken".
 */
function terminalEnvironmentClass(rule: RecoveryRule): FailureClass {
  switch (rule.remedy.kind) {
    case "reauthenticate":
      return "session-expired-unrecoverable";
    case "escalate":
      return "entitlement-denied";
    default:
      return "app-error";
  }
}

/**
 * SPEC section 3.6 gate 2, plus row 16's one concession.
 *
 * A restart is not a jump: the supervisor discards the machine and builds a new one at pc 0 with a
 * FRESHLY BROKERED SESSION. Two things have to be true for that to be safe - the program attempt
 * ledger has room, and no irreversible step has been crossed - and row 16 adds a third for an
 * application error, which is that the whole run must be a READ.
 */
function restartGatePasses(input: ClassifierInput, rule: RecoveryRule): boolean {
  const { run } = input.counters;
  switch (rule.resume) {
    case "restart-from-checkpoint": {
      const resumeAt = rule.resumeAt;
      return (
        resumeAt !== undefined &&
        input.program.resumePoints.includes(resumeAt) &&
        input.step.index <= input.program.restartSafeUpToPc
      );
    }
    case "restart-program": {
      if (input.step.index > input.program.restartSafeUpToPc) return false;
      if (run.programAttempts.used >= run.programAttempts.limit) return false;
      if (rule.remedy.kind !== "reauthenticate" && input.program.maxEffect !== "READ") return false;
      return true;
    }
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Band B2 - interception. Rows 9 and 10.
// ---------------------------------------------------------------------------------------------

function interceptionPresent(observation: Observation): boolean {
  return observation.nativeDialog !== null || observation.inputIntercepted;
}

/**
 * Is the interception on screen the one THIS STEP DECLARED on its checkpoint?
 *
 * SPEC section 4.4's amendment, and the whole of the `expectDialog` decision. Band B2 exists to
 * defend one true sentence - what is visible BEHIND a modal is stale by construction - and it used
 * to enforce a second, false one: that every dialog is an interruption. A confirmation dialog is
 * the postcondition of the click that raised it. An interruption is, by definition, something
 * nobody declared.
 *
 * Four conditions, and each is a refusal rather than a permission:
 *
 *   1. THE STEP DECLARED ONE. No `expect.dialog`, no stand-down. Every artifact written before this
 *      clause existed keeps the behaviour it was written against, byte for byte.
 *   2. THE CHANNEL IS THE ONE A POSTCONDITION CAN BE CHECKED ON. A native dialog blocks the
 *      renderer: there is no post-act observation to verify anything against, and a postcondition
 *      that cannot be checked is not a postcondition. `Observation.nativeDialog` therefore vetoes
 *      the stand-down outright - a `window.confirm` stays an interception, which is what it is.
 *   3. SOMETHING IS ACTUALLY OPEN. With no dialog node on screen there is nothing to excuse, and
 *      `inputIntercepted` set by something the driver could not name as a node is not covered by a
 *      declaration that names one.
 *   4. EVERY OPEN DIALOG IS THE DECLARED ONE. Not "one of them is". The fixture raises its
 *      maintenance interstitial with the SAME widget as its confirmation panel, and two modals up
 *      at once is not the dialog this step declared even though one of them is - so an undeclared
 *      dialog is still `undeclared-dialog` whether it arrives alone or in company.
 *
 * Note what this function does NOT consult: `expect.dialog.present`. Presence is what band B5
 * asserts; this is only about whether band B2 is entitled to answer first. The step that RAISES the
 * dialog and the step that ANSWERS it both declare it, because the dialog outlives the step
 * boundary - it is one step's postcondition and the next step's starting screen - and both need B2
 * to let the checkpoint speak.
 */
function declaredInterception(input: ClassifierInput, ctx: EvalContext): boolean {
  const declared = input.step.expect.dialog;
  if (declared === undefined) return false;
  if (input.observation.nativeDialog !== null) return false;
  const open = input.observation.nodes.filter(isOpenDialogNode);
  if (open.length === 0) return false;
  const matched = new Set(queryNodes(declared.where, ctx).map((node) => node.id));
  return open.every((node) => matched.has(node.id));
}

/** The classifier's own account of what is intercepting, computed from the nodes rather than taken
 *  from the driver's `inputIntercepted` boolean - because "which dialog" is the question, and a
 *  boolean cannot answer it. Deliberately the same rule the browser driver applies. */
function isOpenDialogNode(candidate: UINode): boolean {
  return candidate.ariaRole === "dialog" && candidate.state.visible === true;
}

function bandB2(input: ClassifierInput, ctx: EvalContext): Verdict | null {
  const matched = matchingRules(input, ctx, "interception");
  if (matched !== null) {
    if ("ambiguous" in matched) {
      return fail(input, ctx, "ambiguous-classification", { note: matched.note });
    }
    const exhausted = recoveryBudget(input, ctx, matched.rule);
    return exhausted ?? recoverWith(input, ctx, matched.rule);
  }

  if (!interceptionPresent(input.observation)) return null;

  // The declared dialog stands down to the checkpoint. Checked AFTER the recovery rules and not
  // before, so nothing an existing artifact declares changes meaning: an ambient interception rule
  // that fires on a screen where this step also expects its own dialog is still a recovery, which
  // is right - the fixture's maintenance notice can arrive on top of the confirmation panel, and
  // dismissing it and re-verifying is a better answer than failing the run.
  if (declaredInterception(input, ctx)) return null;

  // Row 10, and it is fail-closed in one of its more consequential instances. An unmodelled prompt
  // is not dismissed on a guess: answering a dialog nobody declared is how an automation clicks
  // "Yes, delete" on behalf of a member.
  return fail(input, ctx, "undeclared-dialog");
}

// ---------------------------------------------------------------------------------------------
// Band B3 - declared business outcomes. Rows 4, 5, 6, 7, 8, 30.
// ---------------------------------------------------------------------------------------------

function bandB3(input: ClassifierInput, ctx: EvalContext): Verdict | null {
  const matched = input.step.outcomes.filter(
    (rule) =>
      rule.phase === "post" &&
      // Deliberately redundant: B0 has already refused to reach this band on an unsettled screen.
      // The literal stays because it is what a reviewer reads in the artifact, and because a future
      // band reordering must not be able to quietly turn "not yet" into "not so".
      (!rule.requiresSettled || input.observation.stability.settled) &&
      evaluatePredicate(rule.detect, ctx),
  );
  if (matched.length === 0) return null;

  // Rows 4 vs 5. The same red banner means two different things, and binding provenance is the
  // ONLY thing that can tell them apart - which is parameterization's second, unadvertised return.
  if (rejectedValueCameFromTheArtifact(input, ctx)) return null;

  const ordered = [...matched].sort((a, b) => a.priority - b.priority);
  const winner = ordered[0] as (typeof ordered)[number];
  const runnerUp = ordered[1];
  if (runnerUp !== undefined && runnerUp.priority === winner.priority) {
    return fail(input, ctx, "ambiguous-classification", {
      note: `${winner.code} and ${runnerUp.code} both matched at priority ${winner.priority}`,
    });
  }

  // An outcome's own payload is part of the answer. A MEMBER_RESTRICTED with a missing restriction
  // code is not a complete answer, and returning it as one would hand the caller a typed hole.
  const data: ExtractedOutput[] = [];
  for (const spec of winner.capture) {
    const read = readExtractSpec(spec, input.step.instruction.kind, ctx);
    if (!read.ok) {
      return fail(input, ctx, "output-extraction-failed", { note: extractionNote(read) });
    }
    data.push(read.output);
  }

  return {
    kind: "outcome",
    code: winner.code,
    data,
    priority: winner.priority,
    alsoMatched: ordered.slice(1).map((o) => ({ code: o.code, priority: o.priority })),
  };
}

/**
 * Row 5, and it is the reason `ResolvedBindings` is a classifier input at all.
 *
 * "Member ID must be 5 digits" is a legitimate business answer when the value the app rejected came
 * from the CALLER's argument - the agent supplied a bad member id and needs to be told so it can
 * ask again. The identical banner is a hard failure when the rejected value was a LITERAL baked
 * into the artifact, because then the artifact is wrong and no caller can fix it. Telling an agent
 * "retry with different input" for an artifact bug sends it into a loop it can never exit.
 *
 * Narrowly scoped on purpose: "the offending value" only exists on a step that WROTE one, and the
 * surface has to have flagged it. Everything else - a not-found banner, a restriction notice - is
 * about the record rather than about a value this step typed, and is untouched.
 */
function rejectedValueCameFromTheArtifact(input: ClassifierInput, ctx: EvalContext): boolean {
  const instruction = input.step.instruction;
  if (instruction.kind !== "fill") return false;
  if (isCallerSupplied(bindingFor(instruction.value, input.bindings))) return false;

  const target = input.step.target;
  if (target === null) return false;
  return (
    queryNodes({ scope: target.scope, role: target.role, state: { invalid: true } }, ctx).length > 0
  );
}

// ---------------------------------------------------------------------------------------------
// Band B4 - declared recoverable conditions. Rows 31 and 32.
// ---------------------------------------------------------------------------------------------

function bandB4(input: ClassifierInput, ctx: EvalContext): Verdict | null {
  const matched = matchingRules(input, ctx, "recoverable");
  if (matched === null) return null;
  if ("ambiguous" in matched) {
    return fail(input, ctx, "ambiguous-classification", { note: matched.note });
  }
  const exhausted = recoveryBudget(input, ctx, matched.rule);
  return exhausted ?? recoverWith(input, ctx, matched.rule);
}

// ---------------------------------------------------------------------------------------------
// Band B5 - the checkpoint. Rows 23, 24, 25, 26.
// ---------------------------------------------------------------------------------------------

function bandB5(input: ClassifierInput, ctx: EvalContext): Verdict {
  const expect = input.step.expect;

  // Row 23, control C5. The weakest useful form of the assertion, and still the only thing that
  // catches a click that dispatched against a dead control: otherwise indistinguishable from
  // success on a page that looks similar before and after.
  if (expect.delta.mustChange && !somethingChanged(input)) {
    return fail(input, ctx, "no-observable-effect");
  }

  // SPEC section 4.4's amendment: the declared dialog, adjudicated where a postcondition belongs.
  //
  // This is the OBLIGATION half of `expect.dialog`, and it is what makes the licence half safe: a
  // step that told band B2 to stand down has to say what it expected to find, and be held to it. A
  // confirmation panel that failed to appear is now a `checkpoint-failed` naming the dialog, rather
  // than an `undeclared-dialog` about a dialog that is not there or a green run that walked past
  // the write it was supposed to perform.
  if (expect.dialog !== undefined) {
    const open = input.observation.nodes.filter(isOpenDialogNode);
    const matched = queryNodes(expect.dialog.where, ctx).filter(isOpenDialogNode);
    if (expect.dialog.present && matched.length === 0) {
      return fail(input, ctx, "checkpoint-failed", {
        note: `the dialog this step expected to raise is not open (${open.length} dialog(s) on screen)`,
      });
    }
    if (!expect.dialog.present && matched.length > 0) {
      return fail(input, ctx, "checkpoint-failed", {
        note: "the dialog this step answered is still open",
      });
    }
  }

  // Row 25, control C2. Not "a member detail page loaded" but "THE member detail page for the
  // member we were asked about" - which is what catches the app's own search silently correcting
  // the id, even when the click itself was unambiguous.
  for (const ref of expect.continuity) {
    if (!evaluatePredicate({ kind: "continuity", ref }, ctx)) {
      return fail(input, ctx, "continuity-broken", { note: ref });
    }
  }

  // Row 24, which is band B6: the default, and the only place a screen nobody declared anything
  // about ends up. Landing here is a legitimate answer, not a gap.
  if (!evaluatePredicate(expect.predicate, ctx)) return fail(input, ctx, "checkpoint-failed");
  if (expect.delta.navigatedTo !== undefined) {
    if (!evaluatePredicate({ kind: "route-matches", route: expect.delta.navigatedTo }, ctx)) {
      return fail(input, ctx, "checkpoint-failed", {
        note: `expected navigation to ${expect.delta.navigatedTo}`,
      });
    }
  }

  // Row 26. Extraction reads the SAME observation the checkpoint just verified - extracting from a
  // later one means you can verify the right page and read the next one, a race that is invisible
  // in a demo and produces a wrong balance in production.
  const outputs: ExtractedOutput[] = [];
  for (const spec of input.step.extract) {
    const read = readExtractSpec(spec, input.step.instruction.kind, ctx);
    if (!read.ok) {
      return fail(input, ctx, "output-extraction-failed", { note: extractionNote(read) });
    }
    outputs.push(read.output);
  }
  return { kind: "advance", outputs };
}

function somethingChanged(input: ClassifierInput): boolean {
  const before = input.preActDigest;
  if (before === null) return false;
  return input.observation.skeletonDigest !== before;
}

/**
 * Settled means the DRIVER says so and the digest window agrees.
 *
 * The conjunction is the point. `stability.settled` is one driver's opinion, arrived at by
 * whatever that surface can observe - a load event on a browser, a quiet interval on a character
 * grid - and the terminal spike measured what that opinion is worth: 120ms of silence mid-repaint
 * yielded a snapshot claiming to be settled with three nodes instead of eight. The digest window
 * is the independent check, and it costs a comparison.
 *
 * A window shorter than `stableSamples` is not evidence either way, so the driver's flag stands.
 * That keeps the gate honest rather than making it unreachable on the first poll.
 */
function hasQuiesced(input: ClassifierInput): boolean {
  if (!input.observation.stability.settled) return false;
  const window = input.recentDigests;
  const samples = input.step.settle.stableSamples;
  if (window.length < samples) return true;
  const tail = window.slice(window.length - samples);
  return tail.every((digest) => digest === tail[0]);
}

// ---------------------------------------------------------------------------------------------
// Rule selection, and the tie that is a refusal
// ---------------------------------------------------------------------------------------------

/**
 * The lowest-priority matching rule in one band, or the fact that two of them tied.
 *
 * The linker makes priorities unique within a step's own declared set, so a tie can only reach a
 * step by two routes: an AMBIENT rule colliding with a step rule, or an OVERLAY-ADDED recovery
 * colliding with a base one. Both are real, both are review findings, and neither is resolved here
 * by array index. A taxonomy tie resolved by declaration order ships an answer to a member and
 * flags it afterwards, which contradicts the fail-closed rule this module is built on.
 */
function matchingRules(
  input: ClassifierInput,
  ctx: EvalContext,
  band: RecoveryRule["band"],
  requireAllowUnsettled?: true,
): BandedRule | { readonly ambiguous: true; readonly note: string } | null {
  const all: BandedRule[] = [
    ...input.step.recoveries.map((rule) => ({ rule, source: "step" as const })),
    ...input.ambient.map((rule) => ({ rule, source: "ambient" as const })),
  ];
  const matched = all.filter(
    ({ rule }) =>
      rule.band === band &&
      phaseAdmits(rule.phase, input.phase) &&
      (requireAllowUnsettled === undefined || rule.allowUnsettled) &&
      evaluatePredicate(rule.detect, ctx),
  );
  if (matched.length === 0) return null;

  const ordered = [...matched].sort((a, b) => a.rule.priority - b.rule.priority);
  const winner = ordered[0] as BandedRule;
  const runnerUp = ordered[1];
  if (runnerUp !== undefined && runnerUp.rule.priority === winner.rule.priority) {
    return {
      ambiguous: true,
      note: `${winner.source} rule ${winner.rule.name} and ${runnerUp.source} rule ${runnerUp.rule.name} both matched in band ${band} at priority ${winner.rule.priority}`,
    };
  }
  return winner;
}

function phaseAdmits(declared: RecoveryRule["phase"], actual: "pre" | "post"): boolean {
  return declared === "both" || declared === actual;
}

/** Rows 31 and 32. Nothing refills a ledger, and no budget resets on progress within a step - a
 *  budget that resets whenever "something changed" is how you build an infinite loop that reports
 *  progress the whole way. */
function recoveryBudget(
  input: ClassifierInput,
  ctx: EvalContext,
  rule: RecoveryRule,
): Verdict | null {
  const declared = input.step.budgets.perRecoveryMaxAttempts[rule.name];
  const limit = declared === undefined ? rule.maxAttempts : Math.min(declared, rule.maxAttempts);
  const spent = input.counters.recoveryAttempts[rule.name] ?? 0;
  if (spent >= limit) return fail(input, ctx, "recovery-exhausted", { note: rule.name });
  if (input.counters.remediationCycles >= input.step.budgets.maxRemediationCycles) {
    return fail(input, ctx, "recovery-exhausted", {
      note: `${rule.name}: the step's remediation cycles are spent`,
    });
  }
  const { run } = input.counters;
  if (
    run.remediations.used >= run.remediations.limit ||
    input.elapsedMs >= input.counters.deadlineMs
  ) {
    return fail(input, ctx, "budget-exhausted", { note: rule.name });
  }
  return null;
}

function recoverWith(input: ClassifierInput, ctx: EvalContext, rule: RecoveryRule): Verdict {
  void ctx;
  const remedy: Remedy = rule.remedy;
  return {
    kind: "recover",
    recoveryName: rule.name,
    remedy,
    attempt: (input.counters.recoveryAttempts[rule.name] ?? 0) + 1,
  };
}

// ---------------------------------------------------------------------------------------------
// SPEC section 3.5 - the rules that stop a retry opening two sub-accounts
// ---------------------------------------------------------------------------------------------

/**
 * Once dispatch has begun on an irreversible step, the only verdicts that may be returned are
 * terminal: an `outcome`, an `advance`, or a failure that is not retriable.
 *
 * `recover` is unreachable by construction, because a recovery implies a retry and a retry implies
 * knowing the action did not take effect - which is precisely what is unknown. A declared
 * entitlement denial is already terminal and already says a person must change authority outside
 * this run, so preserving it keeps row 8 distinguishable without creating a retry path. Anything
 * else collapses to `effect-in-doubt`: it did not fail and it did not succeed, and the only correct
 * behaviour is to stop and let a person reconcile against the system of record.
 *
 * `pending` survives, because waiting for the confirmation screen is bounded by the settle budget
 * and is not a second dispatch.
 */
function terminalizeAfterIrreversibleDispatch(
  verdict: Verdict,
  input: ClassifierInput,
  ctx: EvalContext,
): Verdict {
  if (!input.irreversibleDispatched) return verdict;
  if (verdict.kind === "outcome" || verdict.kind === "advance" || verdict.kind === "pending") {
    return verdict;
  }
  if (
    verdict.kind === "fail" &&
    (verdict.failure === "effect-in-doubt" || verdict.failure === "entitlement-denied")
  ) {
    return verdict;
  }
  return fail(input, ctx, "effect-in-doubt", {
    note:
      verdict.kind === "recover"
        ? `recovery ${verdict.recoveryName} is unreachable after an irreversible dispatch`
        : verdict.failure,
  });
}

// ---------------------------------------------------------------------------------------------
// Building a failure
// ---------------------------------------------------------------------------------------------

interface FailOptions {
  readonly note?: string;
  readonly candidates?: readonly TargetCandidate[];
}

function fail(
  input: ClassifierInput,
  ctx: EvalContext,
  failure: FailureClass,
  options: FailOptions = {},
): Verdict {
  return { kind: "fail", failure, detail: failureDetail(input, ctx, failure, options) };
}

function failureDetail(
  input: ClassifierInput,
  ctx: EvalContext,
  failure: FailureClass,
  options: FailOptions,
): FailureDetail {
  const guidance = FAILURE_GUIDANCE[failure];
  const expected = expectationFor(input, ctx, failure, options.note);
  const detail: FailureDetail = {
    sideEffects: sideEffectsOf(failure, input),
    expected,
    observed: observedSummaryOf(input.observation, input.bindings),
    attempts: Object.entries(input.counters.recoveryAttempts).map(([recoveryId, attempts]) => ({
      recoveryId,
      attempts,
      lastSkeletonDigest: input.recentDigests[input.recentDigests.length - 1] ?? "",
    })),
    // Never derived at render time by the component most likely to get it wrong: the per-class
    // table is written once, by a person, and copied verbatim, so two runs of the same failure
    // never explain themselves differently.
    retriable: input.irreversibleDispatched ? "no" : guidance.retriable,
    operatorAction: guidance.operatorAction,
  };
  return options.candidates === undefined ? detail : { ...detail, candidates: options.candidates };
}

/**
 * `sideEffects` is the field a caller should not have to infer.
 *
 * "We definitely did not touch anything" is a materially different answer from "we stopped
 * partway", and it is said out loud rather than left to be guessed from the failure class. It can
 * be said as a FACT in exactly two situations: the failure was decided before the surface was
 * touched at all, or the run has dispatched zero actions.
 */
function sideEffectsOf(failure: FailureClass, input: ClassifierInput): SideEffects {
  if (failure === "effect-in-doubt") return "in-doubt";
  if (PRE_FLIGHT_FAILURES.has(failure)) return "none-guaranteed";
  return input.counters.run.actions.used === 0 ? "none-guaranteed" : "possible";
}

/**
 * What was expected, generated by a fold over the declared predicate - never authored.
 *
 * Authored prose drifts from the predicate it claims to describe: it is written once and the
 * predicate is edited twice. A fold cannot. And it obeys the two rules of SPEC section 4.7 - a
 * `ValueRef` renders by name, a template hole renders unresolved - so neither half of a failure
 * report ever carries a member number.
 */
function expectationFor(
  input: ClassifierInput,
  ctx: EvalContext,
  failure: FailureClass,
  note: string | undefined,
): FailureDetail["expected"] {
  const suffix = note === undefined ? "" : ` (${note})`;
  const engineExpectation = ENGINE_EXPECTATION[failure];
  if (engineExpectation !== undefined) {
    return { rendered: `${engineExpectation}${suffix}`, clauses: [] };
  }
  const predicate = input.phase === "pre" ? input.step.precondition : input.step.expect.predicate;
  const trace = renderVerdict(predicate, ctx);
  return suffix.length === 0 ? trace : { ...trace, rendered: `${trace.rendered}${suffix}` };
}

/** Failures that are not a statement about a declared predicate, so a predicate fold would render
 *  something true and irrelevant. Each line is what the engine was actually relying on. */
/** The reason line under `output-extraction-failed`: which output, why, and which column or bound.
 *  Names and numbers only - never a cell's contents, because this string is journaled. */
function extractionNote(read: Extract<ExtractOutcome, { ok: false }>): string {
  const detail = read.detail === undefined ? "" : ` - ${read.detail}`;
  return `${read.output}: ${read.reason}${detail}`;
}

const ENGINE_EXPECTATION: Partial<Record<FailureClass, string>> = {
  "lease-lost": "the automation holds the control lease",
  "policy-denied": "the action is inside the allowlist",
  "approval-required": "an approval token accompanies this invocation",
  "target-not-found": "the step's target resolves to a node",
  "target-ambiguous": "every descriptor of the step's target resolves to the SAME node",
  "target-underdetermined":
    "the step's target resolves under quorum, from independent evidence sources",
  "target-assert-failed": "the resolved node satisfies the step's own pre-act assertion",
  "action-rejected": "the surface accepts the dispatched action",
  "undeclared-dialog": "no undeclared dialog or blocking overlay is intercepting input",
  "did-not-settle": "the surface settles within the step's settle budget",
  "surface-error": "the driver can report what the screen looks like",
  "session-expired-unrecoverable": "the session can be re-established and the program restarted",
  "entitlement-denied": "the automation's own role carries the entitlement this screen needs",
  "app-error": "the application is serving its own pages rather than an error page",
  "ambiguous-classification": "at most one rule matches in any one band",
  "recovery-exhausted": "a declared recovery clears its condition within its attempt budget",
  "budget-exhausted": "the run completes inside its action, observation and wall-clock ledgers",
  "effect-in-doubt": "the result of an irreversible action is observed before the session ends",
  "internal-invariant": "the interpreter's own invariants hold",
  // Not a statement about the checkpoint: the checkpoint PASSED, and every clause of it would
  // render `true`, which is the most misleading thing this field could say at 2am.
  "output-extraction-failed":
    "every declared output can be read and typed from the screen the checkpoint verified",
};

// ---------------------------------------------------------------------------------------------
// Row 34 - the interpreter violating its own invariant
// ---------------------------------------------------------------------------------------------

/**
 * A system that cannot say "I am broken" says "you are" instead.
 *
 * Every check here is something the schema already guarantees for a document that came through the
 * validator. They are re-checked because the classifier is also called by the conformance suite,
 * the discovery loop's self-replay and any future host, and a step assembled by hand that quietly
 * disabled `requiresSettled` would turn "not yet" into "not so" with nothing in the journal to say
 * so.
 */
function brokenInvariant(input: ClassifierInput): string | null {
  if (input.phase === "pre" && input.actFault !== undefined) {
    return "an act fault was reported before the action was dispatched";
  }
  if (input.phase === "pre" && input.irreversibleDispatched) {
    return "dispatch is marked begun during the pre-act classification";
  }
  for (const outcome of input.step.outcomes) {
    if (outcome.phase !== "post") {
      return `outcome ${outcome.code} declares phase ${outcome.phase}; an outcome is always post`;
    }
    if (outcome.requiresSettled !== true) {
      return `outcome ${outcome.code} does not require a settled surface`;
    }
  }
  if (input.counters.run.actions.limit <= 0 || input.counters.deadlineMs <= 0) {
    return "the run was started with an empty budget ledger";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rows 1-3 - the cheapest classification touches no surface
// ---------------------------------------------------------------------------------------------

/**
 * The pre-flight failures, which are decided before `perceive()` is ever called and therefore
 * before `classify` is ever called either.
 *
 * They live here anyway, because the SHAPE of the answer is the classifier's: `sideEffects:
 * "none-guaranteed"` is a fact rather than a hope, and it is enforced from `PRE_FLIGHT_FAILURES`
 * rather than passed in. And they are failures, not outcomes: mixing "the core has never heard of
 * this member" with "you put letters in a digits field" in one `outcome` arm asks the caller to
 * distinguish two things the union should distinguish for it.
 */
export function preFlightVerdict(failure: FailureClass, expected: string): Verdict {
  if (!PRE_FLIGHT_FAILURES.has(failure)) {
    return {
      kind: "fail",
      failure: "internal-invariant",
      detail: {
        sideEffects: "possible",
        expected: {
          rendered: `${failure} is not a pre-flight failure and cannot be decided before the surface is touched`,
          clauses: [],
        },
        observed: EMPTY_OBSERVED,
        attempts: [],
        retriable: FAILURE_GUIDANCE["internal-invariant"].retriable,
        operatorAction: FAILURE_GUIDANCE["internal-invariant"].operatorAction,
      },
    };
  }
  const guidance = FAILURE_GUIDANCE[failure];
  return {
    kind: "fail",
    failure,
    detail: {
      sideEffects: "none-guaranteed",
      expected: { rendered: expected, clauses: [] },
      observed: EMPTY_OBSERVED,
      attempts: [],
      retriable: guidance.retriable,
      operatorAction: guidance.operatorAction,
    },
  };
}

/** No surface was touched, and the summary says exactly that rather than inventing a screen. */
const EMPTY_OBSERVED = {
  route: null,
  settled: false,
  pendingReason: null,
  skeletonDigest: "sha256:none",
  nodeCount: 0,
  nativeDialog: null,
  inputIntercepted: false,
  salient: [],
  redactionsApplied: 0,
} as const;

// `renderPredicate` used to be re-exported from here, so that a host could render the same prose
// the classifier put in the failure detail. It is not any more: `src/index.ts` exports it once,
// from `evaluate.ts` where it is defined, and one name arriving at the barrel by two routes is
// exactly the ambiguity `test/barrel.test.ts` refuses.
