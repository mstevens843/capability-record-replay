// The interpreter: SPEC section 3.1's thirteen-step cycle, once per step, straight line, no
// backward edge it does not declare.
//
// Everything decision-shaped in here is delegated. Resolution is `resolveTarget`, authorization is
// `check`, classification is `classify`, extraction happens inside `classify`'s band B5. What is
// left - and it is genuinely all that is left - is sequencing, the impure half of the cycle
// (perceive, act, wait, journal, freeze evidence) and the budget arithmetic that makes the
// termination argument hold. That division is the point: everything that has to be RIGHT is a pure
// function over one frozen observation and is tested without a browser, and everything that has to
// be TIMELY is here.
//
// Four sequencing decisions are load-bearing and are the ones a rewrite gets wrong:
//
//   · THE PRE-ACT SKELETON DIGEST IS CAPTURED BEFORE EVERY DISPATCH. `classify` treats a missing
//     one as "the change cannot be shown to have happened" and fails closed to
//     `no-observable-effect`, so a step that worked perfectly classifies as a failure if the
//     executor forgets. It cost the core integration twenty minutes; it would cost more here.
//   · RESOLUTION RUNS ALL DESCRIPTORS AGAINST ONE SNAPSHOT. If the resolver re-observed between
//     descriptors, two of them could legitimately disagree because the page moved underneath them,
//     and the quorum would be measuring latency instead of ambiguity.
//   · EXTRACTION READS THE OBSERVATION THE CHECKPOINT VERIFIED. Both happen inside one `classify`
//     call for exactly that reason; extracting from a later one means verifying the right page and
//     reading the next one, a race invisible in a demo that produces a wrong balance in production.
//   · A BUDGET IS NEVER REFILLED. `maxRemediationCycles` resets only when the step's checkpoint is
//     reached and `pc` advances; the run ledgers never reset at all, including across a
//     `restart-program`. That is what makes "every program terminates" checkable rather than hoped.

import {
  type ActFault,
  type Action,
  type ActionKind,
  type Allowlist,
  APPROVAL_POLICY_VERSION,
  type ApprovalDemand,
  type ApprovalVerdict,
  type ClassifierInput,
  type ControlTransfer,
  type EffectClass,
  type EvalContext,
  type EvidenceRef,
  type ExpectationTrace,
  type ExtractedOutput,
  type FailureClass,
  type FailureDetail,
  type GateFacts,
  type LeaseToken,
  type LinkedProgram,
  type Observation,
  type ObservedSummary,
  type PolicyContext,
  type PolicyDecision,
  type PolicyMoment,
  type RemedyInstruction,
  type ResolveTargetInput,
  type ResolvedBinding,
  type ResolvedBindings,
  type ResolvedStep,
  type RouteLocation,
  type RunWarning,
  type StepTrace,
  type Surface,
  type SuspensionReason,
  type TargetRef,
  type TargetResolutionResult,
  type UINode,
  type Verdict,
  approvalArgsHash,
  bindingFor,
  check,
  classify,
  effectExceeds,
  authorizeIrreversibleWrite,
  instructionActs,
  irreversibleApprovalOf,
  observedSummaryOf,
  outputBindingName,
  redactTaint,
  renderTarget,
  renderVerdict,
  resolveTarget,
} from "@crr/core";
import { type ApprovalGrant, approvalGrant, type InvocationApprovalGrant } from "./approval.js";
import { type RunLedger, StepLedger } from "./budgets.js";
import type { Clock } from "./clock.js";
import { escalatesRegardlessOfCaller } from "./escalation.js";
import type { EvidenceSink } from "./evidence.js";
import type { IdSource } from "./ids.js";
import type { Journal } from "./journal.js";
import type { LeaseAuthority } from "./lease.js";
import { lowerInstruction } from "./lower.js";
import { verifyInstructionPostcondition } from "./postcondition.js";
import type { SessionBroker } from "./session.js";
import { settle } from "./settle.js";

// ---------------------------------------------------------------------------------------------
// What the interpreter is given, and what it hands back
// ---------------------------------------------------------------------------------------------

/**
 * The `replay-dry` boundary (SPEC section 6.6).
 *
 * A verification replay runs against a surface the discovery run just mutated. For a READ
 * capability that is harmless. For a write capability it is not: the mechanism that proves the
 * recording is faithful would itself be an unapproved, unattended, DUPLICATED irreversible write
 * against a bank system - which is the thing the whole safety model exists to prevent. So a dry run
 * executes every step up to the boundary and then, at the boundary step, does everything except
 * dispatch: it observes, classifies the precondition, resolves the descriptors under quorum, runs
 * the target `assert`, and lowers the instruction to a concrete `Action`. Then it stops.
 *
 * That is not a token gesture. Locators, checkpoints and parameter binding are the parts of a fresh
 * recording most likely to be wrong, and all three are exercised at the boundary step. What is NOT
 * exercised is the write's own postcondition - the confirmation screen, the continuity assertion on
 * it, and every step after it - which is exactly why the resulting grade is
 * `partial-up-to-irreversible` and not `full`.
 *
 * `stopBeforeEffect` is `WRITE_IRREVERSIBLE` for verification, per SPEC section 6.6's table. A
 * deployment running this as a production dry-run against a tenant after a vendor upgrade can
 * tighten it to `WRITE_REVERSIBLE`: "reversible" means a human can undo it, not that an unattended
 * second execution is free. It is a parameter rather than a constant for that reason, and the
 * default follows the spec rather than the stricter reading.
 */
export interface DryRunPolicy {
  /** Stop before dispatching at the first step whose effect is AT OR ABOVE this class. */
  readonly stopBeforeEffect: EffectClass;
}

export interface DryRunBoundaryReport {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly effect: EffectClass;
  readonly expectedAction: ActionKind;
  readonly requiresApproval: boolean;
}

/**
 * The engine's two pure decision functions, as PARAMETERS.
 *
 * Everything this interpreter is graded on lives in these two calls. `resolveTarget` decides which
 * node - if any - the run is allowed to touch, and `classify` decides what the screen in front of
 * it means. Sequencing, budgets, the settle loop and the journal are around them; correctness is
 * inside them.
 *
 * They are injectable for exactly one reason, and it is not extensibility. `@crr/conformance` must
 * be able to run a DELIBERATELY WEAKENED engine - first-match locators, no checkpoint verification,
 * no outcome classifier - through this same interpreter, this same lease, these same budgets and
 * this same journal, so that "the suite discriminates" is a claim about the real engine rather than
 * about a re-implementation of it that shares none of its code. A mutant that is a stub proves
 * nothing; a mutant that is this engine with one pure function replaced proves everything.
 *
 * NOT a production extension point. `replay()` defaults to `REFERENCE_DECISIONS` and no shipping
 * call site passes anything else; a host that substituted its own classifier would be running an
 * engine that the conformance suite has never graded, which is the whole hazard this field exists
 * to measure rather than to create.
 */
export interface DecisionFunctions {
  readonly classify: (input: ClassifierInput) => Verdict;
  readonly resolveTarget: (input: ResolveTargetInput) => TargetResolutionResult;
}

/** `@crr/core`'s own. The only value any shipping call site passes, and the default. */
export const REFERENCE_DECISIONS: DecisionFunctions = { classify, resolveTarget };

export interface InterpreterOptions {
  readonly program: LinkedProgram;
  readonly surface: Surface;
  readonly broker: SessionBroker;
  readonly sessionId: string;
  readonly lease: LeaseAuthority;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly journal: Journal;
  readonly evidence: EvidenceSink;
  readonly ledger: RunLedger;
  readonly allowlist: Allowlist;
  /** `replay` demands an approved artifact at the chokepoint; `discovery` does not. */
  readonly mode: PolicyContext["mode"];
  readonly args: Readonly<Record<string, unknown>>;
  readonly tenant: { readonly tenantId: string; readonly appInstanceId: string };
  readonly idempotencyKey?: string | null;
  readonly approval: ApprovalGrant | null;
  readonly invocationApproval?: InvocationApprovalGrant | null;
  readonly approvalPolicyVersion?: string;
  /** Goes in the lease and in the journal, so a run's actions are attributable. */
  readonly actorId: string;
  /** Ceiling on ONE `perceive`, distinct from any settle budget. */
  readonly perceiveDeadlineMs?: number;
  /** What to do when a remedy escalates. `suspend` hands control to a human and returns a
   *  non-terminal result; `fail` is for a headless run with nobody to escalate to. */
  readonly onIntervention?: "suspend" | "fail";
  /**
   * Present only for a `replay-dry` verification (or a production dry-run). Absent or `null` runs
   * the whole program, which is what `replay-full`, `replay-reset` and every production invocation
   * do.
   */
  readonly dryRun?: DryRunPolicy | null;
  /**
   * Present only when this machine is continuing a run a human held (SPEC section 7.4 step 7).
   *
   * The step is re-run from the TOP of its cycle, which is why this is a program counter and a set
   * of carried bindings rather than a saved position inside `#turn`. A machine that could be
   * resumed mid-cycle would have to serialize a half-finished dispatch, and there is no honest way
   * to say what a half-finished dispatch did.
   */
  readonly resumeFrom?: InterpreterResumeState | null;
  /** Defaults to `REFERENCE_DECISIONS`. See `DecisionFunctions` for why this is here at all. */
  readonly decisions?: DecisionFunctions | null;
  /**
   * Freeze an observation at EVERY step regardless of what the step's `evidence.captureOn`
   * declares. A RUNTIME OPTION, never an artifact edit - see `#captureIf` for why that distinction
   * is the whole point of the field.
   *
   * This is what `crr probe --capture-every` sets. It changes no decision, reaches no model and
   * spends no budget; what it changes is how much member data lands on disk, which is why a probe
   * runs against an obviously synthetic member into a directory the redaction canary covers.
   */
  readonly captureEvery?: boolean;
}

/** What survives a handoff: where to restart, what has already been read, and the fact that a
 *  person touched this run - which `RunEnvelope.attribution.by` carries for the rest of its life. */
export interface InterpreterResumeState {
  readonly pc: number;
  readonly bindings: ResolvedBindings;
  readonly outputs: readonly ExtractedOutput[];
}

export interface RunResultOk {
  readonly kind: "ok";
  readonly outputs: readonly ExtractedOutput[];
}

export interface RunResultOutcome {
  readonly kind: "outcome";
  readonly code: string;
  readonly data: readonly ExtractedOutput[];
  readonly priority: number;
  readonly alsoMatched: readonly { readonly code: string; readonly priority: number }[];
  readonly detectedAt: { readonly stepId: string; readonly stepIndex: number };
  /** Everything extracted before the outcome was detected. A caller that gets MEMBER_RESTRICTED can
   *  still say something true about what was found. */
  readonly partialOutputs: readonly ExtractedOutput[];
}

export interface RunResultFailed {
  readonly kind: "failed";
  readonly failure: FailureClass;
  readonly detail: FailureDetail;
  readonly atStep: string | null;
  readonly stepIndex: number | null;
  readonly observationRef: EvidenceRef | null;
  readonly partialOutputs: readonly ExtractedOutput[];
}

export interface RunResultSuspended {
  readonly kind: "suspended";
  readonly interventionId: string;
  /** SPEC section 7.2's closed list, not free text: a `SuspensionReason` is raised only where a
   *  human at a terminal could plausibly finish the job. */
  readonly reason: SuspensionReason;
  readonly atStep: string;
  readonly stepIndex: number;
  readonly summary: string;
  readonly expected: ExpectationTrace;
  /** The redacted screen, as an operator's brief shows it. On the suspended arm rather than
   *  reconstructed later, because reconstructing it means observing again - and the screen a human
   *  is shown must be the screen the run stopped on, not the one it drifted to while parked. */
  readonly observed: ObservedSummary;
  readonly observationRef: EvidenceRef | null;
  readonly resumeToken: string;
  readonly partialOutputs: readonly ExtractedOutput[];
  /** The lease grant the automation was holding when it released, so the resume re-check can ask
   *  the authority about the OLD one and get `handoff-resume` rather than `lost`. */
  readonly heldBefore: { readonly token: LeaseToken; readonly epoch: number };
}

/** Not a jump. The supervisor discards this machine and builds a new one at pc 0 with the same
 *  arguments, `attempt + 1` and a FRESHLY BROKERED SESSION - which is the whole reason a restart
 *  is not just a `goto`. */
export interface RunResultRestart {
  readonly kind: "restart";
  readonly fromPc: number;
  readonly reason: string;
}

export type RunResult =
  | RunResultOk
  | RunResultOutcome
  | RunResultFailed
  | RunResultSuspended
  | RunResultRestart;

export interface InterpreterRun {
  readonly result: RunResult;
  readonly steps: readonly StepTrace[];
  readonly stepsExecuted: number;
  readonly recoveriesApplied: readonly {
    readonly stepId: string;
    readonly name: string;
    readonly attempts: number;
    readonly result: "cleared" | "exhausted";
  }[];
  readonly warnings: readonly RunWarning[];
  readonly transfers: readonly ControlTransfer[];
  readonly attribution: "automation" | "human-assisted";
  /**
   * Where a dry run stopped, or `null` when the program ran to its end.
   *
   * This rides on the RUN rather than on the `ReplayResultDocument` deliberately. The four arms are
   * the contract a calling agent switches on, and adding a fifth for an operational mode the agent
   * never asks for would make every caller handle a case it can never receive. A dry run that
   * reached its declared boundary did what it was asked to do, so it reports `ok`; the envelope's
   * `stepsExecuted < stepsTotal` and this field are where the partial coverage is legible.
   */
  readonly dryStoppedAt: { readonly stepId: string; readonly stepIndex: number } | null;
  readonly dryBoundary: DryRunBoundaryReport | null;
}

const DEFAULT_PERCEIVE_DEADLINE_MS = 15_000;

// ---------------------------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------------------------

export class Interpreter {
  readonly #o: InterpreterOptions;
  readonly #deadlineMs: number;
  /** Read on every classification and every resolution, so a weakened engine is weakened for the
   *  whole run rather than only where a test remembered to look. */
  readonly #decide: DecisionFunctions;
  #bindings: ResolvedBinding[];
  #outputs: ExtractedOutput[] = [];
  #traces: StepTrace[] = [];
  #warnings: RunWarning[] = [];
  #recoveries: {
    stepId: string;
    name: string;
    attempts: number;
    result: "cleared" | "exhausted";
  }[] = [];
  #stepsExecuted = 0;
  readonly #startPc: number;
  #humanAssisted = false;
  #dryStoppedAt: { readonly stepId: string; readonly stepIndex: number } | null = null;
  #dryBoundary: DryRunBoundaryReport | null = null;

  constructor(options: InterpreterOptions) {
    this.#o = options;
    this.#deadlineMs = options.perceiveDeadlineMs ?? DEFAULT_PERCEIVE_DEADLINE_MS;
    this.#decide = options.decisions ?? REFERENCE_DECISIONS;
    const resume = options.resumeFrom ?? null;
    // A resumed machine carries the earlier attempt's bindings, not just the linker's: the outputs
    // the first half of the flow extracted are bound by name, and a step after the handoff that
    // names one would otherwise resolve it to nothing.
    this.#bindings = [...(resume?.bindings ?? options.program.bindings)];
    this.#outputs = [...(resume?.outputs ?? [])];
    this.#startPc = resume?.pc ?? 0;
    // A run a human touched is never reported as a purely automated success (SPEC section 7.4).
    this.#humanAssisted = resume !== null;
  }

  async run(): Promise<InterpreterRun> {
    const result = await this.#drive();
    return {
      result,
      steps: this.#traces,
      stepsExecuted: this.#stepsExecuted,
      recoveriesApplied: this.#recoveries,
      warnings: this.#warnings,
      transfers: this.#o.lease.transfers(),
      attribution: this.#humanAssisted ? "human-assisted" : "automation",
      dryStoppedAt: this.#dryStoppedAt,
      dryBoundary: this.#dryBoundary,
    };
  }

  async #drive(): Promise<RunResult> {
    const steps = this.#o.program.steps;
    let pc = this.#startPc;
    // Guards a `restart-from-checkpoint` loop that the run remediation ledger would otherwise be
    // the only thing bounding. Both bounds are real; this one produces a better message.
    let jumps = 0;
    while (pc < steps.length) {
      const step = steps[pc] as ResolvedStep;
      const outcome = await this.#runStep(step);
      switch (outcome.kind) {
        case "advance":
          this.#stepsExecuted += 1;
          pc += 1;
          break;
        case "jump": {
          jumps += 1;
          if (jumps > steps.length * 2) {
            return this.#internal(step, "a checkpoint restart is not making progress");
          }
          pc = outcome.toPc;
          break;
        }
        default:
          return outcome.result;
      }
    }
    return { kind: "ok", outputs: this.#outputs };
  }

  // -- one step -------------------------------------------------------------------------------

  async #runStep(
    step: ResolvedStep,
  ): Promise<
    | { readonly kind: "advance" }
    | { readonly kind: "jump"; readonly toPc: number }
    | { readonly kind: "stop"; readonly result: RunResult }
  > {
    const stepLedger = new StepLedger();
    let attempt = 1;
    let irreversibleDispatched = false;

    this.#o.journal.append({
      type: "step.entered",
      stepId: step.id,
      index: step.index,
      attempt,
      effect: step.effect,
    });

    // The step's own re-verify loop. Every excursion from it is charged to a ledger that nothing
    // refills, which is what bounds it; `afterRemedy` is the literal `reverify` and a remedy can
    // never set the program counter.
    for (;;) {
      const turn = await this.#turn(step, stepLedger, attempt, irreversibleDispatched);
      irreversibleDispatched = turn.irreversibleDispatched;

      if (turn.disposition.kind === "advance") return { kind: "advance" };
      if (turn.disposition.kind === "stop")
        return { kind: "stop", result: turn.disposition.result };

      const applied = await this.#applyRemedy(step, stepLedger, turn.disposition);
      if (applied.kind === "stop") return { kind: "stop", result: applied.result };
      if (applied.kind === "jump") return { kind: "jump", toPc: applied.toPc };
      attempt += 1;
      this.#o.journal.append({
        type: "step.entered",
        stepId: step.id,
        index: step.index,
        attempt,
        effect: step.effect,
      });
    }
  }

  // -- one turn of the cycle -------------------------------------------------------------------

  async #turn(
    step: ResolvedStep,
    stepLedger: StepLedger,
    attempt: number,
    irreversibleDispatchedOnEntry: boolean,
  ): Promise<{
    readonly disposition: TurnDisposition;
    readonly irreversibleDispatched: boolean;
  }> {
    let irreversibleDispatched = irreversibleDispatchedOnEntry;
    const startedAt = this.#o.clock.elapsedMs();

    // ---- 1  LEASE ----------------------------------------------------------------------------
    const leaseState = this.#o.lease.state({
      token: this.#o.lease.token,
      epoch: this.#o.lease.epoch,
    });

    // ---- 2  OBSERVE --------------------------------------------------------------------------
    //
    // One poll, not a settle loop. The pre-act question is "what is on screen right now" - a
    // half-painted page is a fact band B0 has a verdict for, and waiting for quiescence before we
    // have even checked the precondition would wait out an interstitial we are about to dismiss.
    const before = await this.#perceiveOnce();
    if (before.ledgerExhausted) {
      return {
        irreversibleDispatched,
        disposition: this.#stopWithBudget(step, before.observation, stepLedger, attempt),
      };
    }
    const preActDigest = before.observation?.skeletonDigest ?? null;
    this.#journalObserved(step, before.observation);

    // ---- 3  CLASSIFY (pre) -------------------------------------------------------------------
    const preInput = this.#classifierInput({
      step,
      stepLedger,
      observation: before.observation,
      window: before.observation === null ? [] : [before.observation.skeletonDigest],
      preActDigest: null,
      phase: "pre",
      gate: { lease: leaseState, policy: null, target: null },
      perceiveFault: before.fault,
      irreversibleDispatched: false,
      settleElapsedMs: 0,
    });
    if (preInput === null) return { irreversibleDispatched, disposition: this.#noScreen(step) };

    const pre = this.#decide.classify(preInput);
    this.#journalClassified(step, "pre", pre);
    const preDisposition = this.#dispose(step, pre, preInput, startedAt, attempt, {
      allowAdvance: false,
    });
    if (preDisposition !== null) return { irreversibleDispatched, disposition: preDisposition };

    const observation = before.observation as Observation;
    const ctx = this.#ctxOf(observation);

    // ---- 5-8  RESOLVE, LOWER, POLICY, ACT ----------------------------------------------------
    //
    // Skipped entirely for `read`, `readTable` and `assert`: they dispatch nothing, so they go from
    // the precondition straight to settle. `navigate` resolves a ROUTE rather than a node.
    let resolution: TargetResolutionResult | null = null;
    let actFault: ActFault | undefined;
    let settleWindow: readonly string[] = before.observation
      ? [before.observation.skeletonDigest]
      : [];
    let settled: Observation | null = observation;
    let settleElapsedMs = 0;

    if (instructionActs(step.instruction.kind)) {
      let node: UINode | null = null;

      if (step.target !== null) {
        resolution = this.#decide.resolveTarget({
          target: step.target as TargetRef,
          ctx,
          capabilities: this.#o.surface.capabilities(),
          disabledDescriptors: this.#disabledFor(step.id),
        });
        this.#journalResolved(step, resolution);
        for (const warning of resolution.warnings) {
          this.#warnings.push({ ...warning, stepId: step.id });
        }
        if (resolution.status !== "resolved") {
          const input = { ...preInput, gate: gateWith(preInput.gate, { target: resolution }) };
          const verdict = this.#decide.classify(input);
          this.#journalClassified(step, "pre", verdict);
          const stop = this.#dispose(step, verdict, input, startedAt, attempt, {
            allowAdvance: false,
            resolution,
          });
          if (stop !== null) return { irreversibleDispatched, disposition: stop };
        } else {
          node = resolution.resolvedNode as UINode;
        }
      }

      const location = this.#locationFor(step);
      const lowered = lowerInstruction({
        step,
        node,
        bindings: this.#bindings,
        capabilities: this.#o.surface.capabilities(),
        ctx,
        location,
      });
      if (!lowered.ok) {
        return {
          irreversibleDispatched,
          disposition: this.#internalDisposition(step, lowered.reason, observation),
        };
      }

      // ---- THE DRY-RUN BOUNDARY (SPEC section 6.6) ---------------------------------------------
      //
      // Everything above this line has already happened for this step: the lease was checked, the
      // screen was observed, the precondition and every declared outcome and recovery were
      // classified against it, the descriptors were resolved independently and compared under
      // quorum, the target `assert` ran, and the instruction was lowered to a concrete `Action`
      // with its parameter bound. What has not happened is the dispatch, and in a dry run it never
      // will.
      //
      // It sits BEFORE the policy check rather than after, and that ordering is load-bearing twice
      // over. First, `check` would deny: an irreversible action needs an approval token (policy
      // rule 8) and a verification replay runs an artifact nobody has approved yet - so asking the
      // chokepoint about an action we have already decided not to dispatch would turn a successful
      // dry run into an `approval-required` failure. Second, it keeps `check` and `act` adjacent:
      // the chokepoint contract test proves no action is dispatched without an authorizing decision
      // by reading the source, and an early return between the two is exactly the shape that makes
      // that unprovable.
      if (this.#dryRunStopsAt(step)) {
        return {
          irreversibleDispatched,
          disposition: this.#dryStop(
            step,
            observation,
            pre,
            resolution,
            lowered.action.kind,
            attempt,
            startedAt,
          ),
        };
      }

      // ---- 7  POLICY, then ---- 8  ACT ---------------------------------------------------------
      //
      // THE DECISION AND THE DISPATCH ARE WRITTEN AS ONE UNIT, and everything that would sit between
      // them - the journal line, the refusal path, the ledger charge - is a one-line call out to a
      // helper. That is not style. `@crr/core`'s chokepoint contract test reads every shipped source
      // in this repo and fails when a `.act(` is not preceded, within a short window, by a `check(`
      // on THE SAME action expression whose result is then READ. Keeping these lines adjacent is
      // what lets a scan PROVE "no action is dispatched that a policy decision did not authorize"
      // rather than leave it as a claim in a design document.
      const moment: PolicyMoment = { now: this.#o.clock.now(), epoch: this.#o.lease.epoch };
      const gateAt = { startedAt, attempt, resolution };
      const authorization = this.#authorizeStep(step);
      if (!authorization.ok) {
        const decision = this.#approvalRefusalDecision(authorization.verdict);
        this.#journalDecision(step, decision, lowered.action.kind);
        const refused = this.#refuse(step, decision, preInput, gateAt);
        if (refused !== null) return { irreversibleDispatched, disposition: refused };
        return {
          irreversibleDispatched,
          disposition: this.#internalDisposition(
            step,
            `approval refusal ${authorization.verdict.reason} did not classify as a stopping verdict`,
            observation,
          ),
        };
      }
      const policy = this.#policyContext(step, location, observation, authorization.policyGrant);
      const decision = check(lowered.action, policy, moment);
      this.#journalDecision(step, decision, lowered.action.kind);
      // Consulted INLINE and not inside the helper: `check(a, ctx, at); await s.act(a, lease)`
      // type-checks, passes a naive scan, and enforces nothing at all.
      const refused = decision.allow ? null : this.#refuse(step, decision, preInput, gateAt);
      if (refused !== null) return { irreversibleDispatched, disposition: refused };
      if (step.effect === "WRITE_IRREVERSIBLE") irreversibleDispatched = true;
      this.#chargeAction();
      const actResult = await this.#o.surface.act(lowered.action, this.#o.lease.token);
      this.#o.journal.append({
        type: "acted",
        stepId: step.id,
        actionKind: lowered.action.kind,
        targetTitle: step.target === null ? step.title : renderTarget(step.target as TargetRef),
        valueRef: valueHandleOf(step, this.#bindings),
        valueLength: lowered.action.kind === "type" ? lowered.action.text.length : null,
        result: actResult.ok ? "dispatched" : actResult.fault.kind,
      });
      if (!actResult.ok) actFault = actResult.fault;

      // ---- 9  SETTLE ---------------------------------------------------------------------------
      const outcome = await settle({
        surface: this.#o.surface,
        policy: step.settle,
        clock: this.#o.clock,
        chargeObservation: () => this.#chargeObservation(),
        program: this.#o.program.facts,
        bindings: this.#bindings,
        perceiveDeadlineMs: this.#deadlineMs,
      });
      this.#o.journal.append({
        type: "settled",
        stepId: step.id,
        polls: outcome.polls,
        elapsedMs: outcome.elapsedMs,
        settled: outcome.settled,
      });
      if (outcome.ledgerExhausted) {
        return {
          irreversibleDispatched,
          disposition: this.#stopWithBudget(step, outcome.observation, stepLedger, attempt),
        };
      }
      settled = outcome.observation;
      settleWindow = outcome.window;
      settleElapsedMs = outcome.elapsedMs;
      this.#journalObserved(step, settled);

      // ---- 10  CLASSIFY (post) -----------------------------------------------------------------
      const postInput = this.#classifierInput({
        step,
        stepLedger,
        // When every post-act poll faulted there is no post-act screen, and `classify` is total over
        // an Observation rather than over the absence of one. The PRE-act observation stands in, with
        // the fault attached: band B0 then answers the question that actually matters - "was there a
        // dialog on screen when perception stopped working" - and returns `undeclared-dialog` rather
        // than a bare `surface-error`. Substituting a screen we did see is honest; fabricating an
        // empty one would not be.
        observation: settled ?? observation,
        window: settleWindow,
        preActDigest,
        phase: "post",
        gate: { lease: leaseState, policy: decision, target: resolution },
        perceiveFault: outcome.fault ?? undefined,
        actFault,
        irreversibleDispatched,
        settleElapsedMs,
      });
      if (postInput === null) {
        return { irreversibleDispatched, disposition: this.#noScreen(step, outcome.fault) };
      }
      const verdict = this.#decide.classify(postInput);
      this.#journalClassified(step, "post", verdict);
      const disposition =
        this.#dispose(step, verdict, postInput, startedAt, attempt, { resolution }) ??
        this.#unreachable(step);
      return { irreversibleDispatched, disposition };
    }

    // ---- the non-acting instructions: precondition straight to settle -------------------------
    const outcome = await settle({
      surface: this.#o.surface,
      policy: step.settle,
      clock: this.#o.clock,
      chargeObservation: () => this.#chargeObservation(),
      program: this.#o.program.facts,
      bindings: this.#bindings,
      perceiveDeadlineMs: this.#deadlineMs,
    });
    this.#o.journal.append({
      type: "settled",
      stepId: step.id,
      polls: outcome.polls,
      elapsedMs: outcome.elapsedMs,
      settled: outcome.settled,
    });
    if (outcome.ledgerExhausted) {
      return {
        irreversibleDispatched,
        disposition: this.#stopWithBudget(step, outcome.observation, stepLedger, attempt),
      };
    }
    settled = outcome.observation;
    this.#journalObserved(step, settled);

    const postInput = this.#classifierInput({
      step,
      stepLedger,
      observation: settled,
      window: outcome.window,
      // A read dispatches nothing, so the pre-act digest is the digest before the settle poll. A
      // `read` step declares `delta.mustChange: false`, which is the one place that field is
      // correctly false and the reason it is a boolean rather than an engine constant.
      preActDigest,
      phase: "post",
      gate: { lease: leaseState, policy: null, target: null },
      perceiveFault: outcome.fault ?? undefined,
      irreversibleDispatched: false,
      settleElapsedMs: outcome.elapsedMs,
    });
    if (postInput === null) return { irreversibleDispatched, disposition: this.#noScreen(step) };
    const verdict = this.#decide.classify(postInput);
    this.#journalClassified(step, "post", verdict);
    const disposition =
      this.#dispose(step, verdict, postInput, startedAt, attempt, {}) ?? this.#unreachable(step);
    return { irreversibleDispatched, disposition };
  }

  // -- turning a verdict into what the machine does next ---------------------------------------

  /**
   * One verdict, one disposition. `null` means "nothing to do here, carry on with the cycle",
   * which is only ever returned for an `advance` in the pre phase.
   */
  #dispose(
    step: ResolvedStep,
    verdict: Verdict,
    input: ClassifierInput,
    startedAt: number,
    attempt: number,
    options: {
      readonly allowAdvance?: boolean;
      readonly resolution?: TargetResolutionResult | null;
    },
  ): TurnDisposition | null {
    const observation = input.observation;
    const trace = (ref: EvidenceRef | null): void => {
      this.#traces.push({
        stepId: step.id,
        attempt,
        verdict,
        skeletonDigest: observation.skeletonDigest,
        observationRef: ref,
        elapsedMs: this.#o.clock.elapsedMs() - startedAt,
        ...(options.resolution == null ? {} : { resolution: resolutionRows(options.resolution) }),
      } as StepTrace);
    };

    switch (verdict.kind) {
      case "advance": {
        if (options.allowAdvance === false) return null;

        // SPEC section 3's per-instruction postcondition, checked AFTER the classifier so that an
        // outcome, an environment condition or a declared recovery still wins, and only on a
        // verdict that was otherwise going to advance.
        const opcode = verifyInstructionPostcondition({
          step,
          ctx: this.#ctxOf(observation),
          bindings: this.#bindings,
          capabilities: this.#o.surface.capabilities(),
          disabledDescriptors: this.#disabledFor(step.id),
          resolve: this.#decide.resolveTarget,
        });
        if (!opcode.ok) {
          this.#o.journal.append({
            type: "checkpoint",
            stepId: step.id,
            passed: false,
            trace: { rendered: opcode.note, clauses: [] },
          });
          trace(this.#captureIf(step, observation, "failure", input.phase));
          return {
            kind: "stop",
            result: this.#failedResult(step, observation, "checkpoint-failed", [opcode.note]),
          };
        }

        // The outputs the checkpoint's own observation yielded, bound so a later step can name
        // them and recorded for the caller.
        for (const output of verdict.outputs) {
          this.#outputs.push(output);
          this.#bindings.push({
            name: outputBindingName(step.id, output.output),
            origin: "output",
            value: valueAsString(output.value),
            sensitivity: output.sensitivity,
            handle: null,
          });
          this.#o.journal.append({
            type: "extracted",
            stepId: step.id,
            output: output.output,
            sensitivity: output.sensitivity,
            present: output.value !== null,
          });
        }
        // The opcode postcondition's own note rides on the checkpoint trace rather than on
        // `RunEnvelope.warnings`, because `RunWarningSchema`'s code list is closed and has no
        // member for "a declared check could not be evaluated". Adding one is a one-line change to
        // `@crr/core`'s `diagnostics.ts` and it is REPORTED rather than made here - core is
        // complete and verified, and unit 11 does not get to edit it on its way past.
        const passedTrace = renderVerdict(step.expect.predicate, this.#ctxOf(observation));
        this.#o.journal.append({
          type: "checkpoint",
          stepId: step.id,
          passed: true,
          trace:
            opcode.warning === undefined
              ? passedTrace
              : { ...passedTrace, rendered: `${passedTrace.rendered} - NOTE: ${opcode.warning}` },
        });
        trace(this.#captureIf(step, observation, "always", input.phase));
        return { kind: "advance" };
      }

      case "pending":
        // The settle loop already spent the budget; a `pending` here means the classifier and the
        // loop disagree about quiescence, which is an invariant break rather than a reason to wait
        // again in a second place.
        return this.#internalDisposition(
          step,
          "the classifier reported `pending` after the settle budget was spent",
          observation,
        );

      case "outcome": {
        const ref = this.#captureIf(step, observation, "outcome", input.phase);
        trace(ref);
        return {
          kind: "stop",
          result: {
            kind: "outcome",
            code: verdict.code,
            data: verdict.data,
            priority: verdict.priority,
            alsoMatched: verdict.alsoMatched,
            detectedAt: { stepId: step.id, stepIndex: step.index },
            partialOutputs: this.#outputs,
          },
        };
      }

      case "recover":
        trace(this.#captureIf(step, observation, "never", input.phase));
        return { kind: "recover", verdict, observation, phase: input.phase };

      case "fail": {
        const ref = this.#captureIf(step, observation, "failure", input.phase);
        trace(ref);
        if (escalatesRegardlessOfCaller(verdict.failure)) {
          // Row 33, and SPEC section 7.2's one unconditional row. An intervention is raised even
          // when the caller asked for `onIntervention: "fail"`: the action did not fail and it did
          // not succeed, and nobody gets to say "fail and go home" on behalf of the member whose
          // account it touched.
          //
          // The ARM is still `failed`, and deliberately so - `effect-in-doubt` is a failure class
          // and `sideEffects: "in-doubt"` is what the caller must be told, because the one thing
          // that must not happen is a retry. So this raises a reconciliation intervention beside a
          // failed run rather than a resumable suspension.
          //
          // NAMED GAP: that intervention is journaled but is NOT parked on the control plane, so it
          // does not appear in the operator console's queue. Parking it needs a second kind of
          // parked run - one with a live session a human may look at and may never hand back, since
          // there is nothing to resume into - and that is a deliberate cut rather than an oversight.
          // The seam is exactly here: `replay` has the desk, this arm has the intervention id, and
          // the missing piece is a `reconcile-only` entry in `ControlPlane`.
          this.#raiseIntervention(step, "effect-in-doubt", verdict.detail.expected.rendered, ref);
        }
        return {
          kind: "stop",
          result: {
            kind: "failed",
            failure: verdict.failure,
            detail: verdict.detail,
            atStep: step.id,
            stepIndex: step.index,
            observationRef: ref,
            partialOutputs: this.#outputs,
          },
        };
      }
    }
  }

  // -- remedies --------------------------------------------------------------------------------

  async #applyRemedy(
    step: ResolvedStep,
    stepLedger: StepLedger,
    disposition: Extract<TurnDisposition, { kind: "recover" }>,
  ): Promise<
    | { readonly kind: "reverify" }
    | { readonly kind: "jump"; readonly toPc: number }
    | { readonly kind: "stop"; readonly result: RunResult }
  > {
    const verdict = disposition.verdict;
    const rule = [...step.recoveries, ...this.#o.program.ambient].find(
      (r) => r.name === verdict.recoveryName,
    );
    if (rule === undefined) {
      return {
        kind: "stop",
        result: this.#failedResult(step, disposition.observation, "internal-invariant", [
          `the classifier named recovery ${verdict.recoveryName} and no rule carries that name`,
        ]),
      };
    }

    const attempt = stepLedger.chargeRemedy(rule.name);
    const charge = this.#o.ledger.chargeRemediation();
    this.#o.journal.append({ type: "budget.charged", ...charge });
    this.#o.journal.append({
      type: "recovery.applied",
      stepId: step.id,
      name: rule.name,
      attempt,
      remedy: verdict.remedy.kind,
    });
    this.#note(rule.name, step.id, attempt, "cleared");

    switch (verdict.remedy.kind) {
      case "escalate": {
        const ref = this.#captureIf(step, disposition.observation, "failure", disposition.phase);
        if (this.#o.onIntervention === "fail") {
          return {
            kind: "stop",
            result: this.#failedResult(step, disposition.observation, "entitlement-denied", [
              verdict.remedy.reason,
            ]),
          };
        }
        const id = this.#raiseIntervention(step, "recovery-exhausted", verdict.remedy.brief, ref);
        this.#humanAssisted = true;
        // Captured BEFORE the lease moves. Everything after this line is about who holds the
        // session; this is the last moment at which "the grant the automation was running under" is
        // still readable, and the resume re-check needs it to tell `handoff-resume` from `lost`.
        const heldBefore = { token: this.#o.lease.token, epoch: this.#o.lease.epoch };
        // The lease goes to the human here and not when they pick it up. Releasing it is what makes
        // the automation's token stop validating AT THE PORT, and an operator clicking on a session
        // the automation still holds is the race this control exists to prevent.
        this.#o.lease.handToHuman(`operator:${id}`, id as never);
        return {
          kind: "stop",
          result: {
            kind: "suspended",
            interventionId: id,
            reason: "recovery-exhausted",
            atStep: step.id,
            stepIndex: step.index,
            summary: verdict.remedy.reason,
            expected: renderVerdict(step.expect.predicate, this.#ctxOf(disposition.observation)),
            observed: observedSummaryOf(disposition.observation, this.#bindings),
            observationRef: ref,
            resumeToken: this.#o.lease.token,
            partialOutputs: this.#outputs,
            heldBefore,
          },
        };
      }

      case "reauthenticate": {
        // Delegated to the session broker: the program never logs in, and there is no field in the
        // artifact a credential could be written into even by accident.
        const state = await this.#o.broker.refresh(this.#o.sessionId);
        if (state === "failed") {
          this.#note(rule.name, step.id, attempt, "exhausted");
          return {
            kind: "stop",
            result: this.#failedResult(
              step,
              disposition.observation,
              "session-expired-unrecoverable",
              ["the session broker could not re-establish the session"],
            ),
          };
        }
        break;
      }

      case "dismiss-native-dialog": {
        const applied = await this.#dispatchRemedyAction(
          step,
          disposition.observation,
          verdict.remedy.accept ? { kind: "acceptDialog", text: null } : { kind: "dismissDialog" },
        );
        if (applied !== null) return { kind: "stop", result: applied };
        break;
      }

      case "actions": {
        for (const instruction of verdict.remedy.instructions) {
          const applied = await this.#dispatchRemedyInstruction(
            step,
            disposition.observation,
            instruction,
          );
          if (applied !== null) return { kind: "stop", result: applied };
        }
        break;
      }
    }

    // `afterRemedy` has one legal value and the schema says so: a remedy can never set the program
    // counter. `resume` decides where the RE-VERIFICATION happens, and only these three arms can be
    // reached - `escalate` returned above.
    switch (rule.resume) {
      case "retry-step":
        return { kind: "reverify" };
      case "restart-from-checkpoint": {
        const toPc = this.#o.program.steps.findIndex((s) => s.id === rule.resumeAt);
        if (toPc < 0) {
          return {
            kind: "stop",
            result: this.#failedResult(step, disposition.observation, "internal-invariant", [
              `recovery ${rule.name} resumes at ${String(rule.resumeAt)}, which is not a step`,
            ]),
          };
        }
        return { kind: "jump", toPc };
      }
      case "restart-program": {
        // The gate is checked BEFORE the ledger is charged, and the order is not cosmetic: charging
        // first makes the FIRST restart of a run with `maxProgramAttempts: 1` refuse itself, which
        // is a budget that permits nothing while claiming to permit one.
        const ledger = this.#o.ledger.view().programAttempts;
        const gate =
          step.index <= this.#o.program.facts.restartSafeUpToPc && ledger.used < ledger.limit;
        if (gate) {
          const attemptCharge = this.#o.ledger.chargeProgramAttempt();
          this.#o.journal.append({ type: "budget.charged", ...attemptCharge });
        }
        this.#o.journal.append({
          type: "restart.requested",
          fromPc: step.index,
          gate: gate ? "passed" : "refused",
          restartSafeUpToPc: this.#o.program.facts.restartSafeUpToPc,
        });
        if (!gate) {
          return {
            kind: "stop",
            result: this.#failedResult(step, disposition.observation, "app-error", [
              "a program restart was the declared remedy and the restart gate refused it",
            ]),
          };
        }
        return { kind: "stop", result: { kind: "restart", fromPc: step.index, reason: rule.name } };
      }
      default:
        return { kind: "reverify" };
    }
  }

  async #dispatchRemedyInstruction(
    step: ResolvedStep,
    observation: Observation,
    instruction: RemedyInstruction,
  ): Promise<RunResult | null> {
    const ctx = this.#ctxOf(observation);
    let node: UINode | null = null;
    if (
      "target" in instruction &&
      instruction.target !== null &&
      instruction.target !== undefined
    ) {
      const resolution = this.#decide.resolveTarget({
        target: instruction.target as TargetRef,
        ctx,
        capabilities: this.#o.surface.capabilities(),
      });
      this.#journalResolved(step, resolution);
      if (resolution.status !== "resolved") {
        // A remedy that cannot find its own control is a remedy that did not happen. Reporting the
        // resolution failure is better than dispatching nothing and reverifying into the same
        // condition until the budget runs out.
        return this.#failedResult(step, observation, resolution.failure, [resolution.reason]);
      }
      node = resolution.resolvedNode as UINode;
    }
    const lowered = lowerInstruction({
      // A remedy shares the step's identity for policy purposes: it acts inside the step's declared
      // effect class, which is why an irreversible step may only carry a `dismiss-native-dialog`
      // remedy and the schema refuses anything else.
      step: { ...step, instruction: instruction as ResolvedStep["instruction"] } as ResolvedStep,
      node,
      bindings: this.#bindings,
      capabilities: this.#o.surface.capabilities(),
      ctx,
      location: instruction.kind === "navigate" ? this.#locationForRoute(instruction.route) : null,
    });
    if (!lowered.ok) {
      return this.#failedResult(step, observation, "internal-invariant", [lowered.reason]);
    }
    return this.#dispatchRemedyAction(step, observation, lowered.action);
  }

  /** Every remedy action goes through the SAME chokepoint as a step action. A remedy is not an
   *  exemption from policy; it is the place an exemption would be least visible. */
  async #dispatchRemedyAction(
    step: ResolvedStep,
    observation: Observation,
    action: Action,
  ): Promise<RunResult | null> {
    const moment: PolicyMoment = { now: this.#o.clock.now(), epoch: this.#o.lease.epoch };
    const ctx = this.#policyContext(step, actionLocation(action), observation);
    const decision = check(action, ctx, moment);
    this.#journalDecision(step, decision, action.kind);
    if (!decision.allow) {
      return this.#failedResult(step, observation, "policy-denied", [decision.detail]);
    }
    this.#chargeAction();
    const result = await this.#o.surface.act(action, this.#o.lease.token);
    this.#o.journal.append({
      type: "acted",
      stepId: step.id,
      actionKind: action.kind,
      targetTitle: `remedy on ${step.title}`,
      valueRef: null,
      valueLength: null,
      result: result.ok ? "dispatched" : result.fault.kind,
    });
    if (!result.ok) {
      return this.#failedResult(step, observation, "action-rejected", [result.fault.kind]);
    }
    return null;
  }

  // -- plumbing ---------------------------------------------------------------------------------

  /**
   * Whether this step is the dry run's boundary.
   *
   * Read off the step's DECLARED effect, which is the same field the policy chokepoint, the restart
   * gate and the approval blast radius all read. SPEC section 12.3's first accepted limit applies
   * in full: `effect` is declared by the recorder and never proven, so a step marked `READ` that
   * posts an audit row is invisible here exactly as it is invisible to every other control. The
   * mitigation is that this reads the same field they do rather than a second, weaker notion of
   * what a write is.
   */
  #dryRunStopsAt(step: ResolvedStep): boolean {
    const policy = this.#o.dryRun;
    if (policy === undefined || policy === null) return false;
    // "at or above" is the negation of "the boundary exceeds this step".
    return !effectExceeds(policy.stopBeforeEffect, step.effect);
  }

  /**
   * Stop at the boundary, reporting what the boundary step proved before it was reached.
   *
   * The trace is written by hand here rather than through `#dispose`, because `#dispose` traces a
   * DISPOSITION and there is none: the step neither advanced nor failed. What the trace has to
   * carry is the resolution rows - the evidence that every descriptor agreed on one node at the
   * step this run deliberately did not perform - because that is the whole claim a
   * `partial-up-to-irreversible` grade is making.
   *
   * There is no journal event for this and none is invented. `@crr/core`'s `JournalEventType` is a
   * closed union and unit 15 does not get to widen it on its way past; what a reader needs is
   * already there and is stronger for being an absence: the boundary step has `step.entered`,
   * `observed`, `classified` and `resolved` lines, and NO `acted` line after them.
   */
  #dryStop(
    step: ResolvedStep,
    observation: Observation,
    verdict: Verdict,
    resolution: TargetResolutionResult | null,
    actionKind: ActionKind,
    attempt: number,
    startedAt: number,
  ): TurnDisposition {
    this.#dryStoppedAt = { stepId: step.id, stepIndex: step.index };
    this.#dryBoundary = {
      stepId: step.id,
      stepIndex: step.index,
      effect: step.effect,
      expectedAction: actionKind,
      requiresApproval: step.effect === "WRITE_IRREVERSIBLE",
    };
    this.#traces.push({
      stepId: step.id,
      attempt,
      verdict,
      skeletonDigest: observation.skeletonDigest,
      observationRef: this.#captureIf(step, observation, "always", "pre"),
      elapsedMs: this.#o.clock.elapsedMs() - startedAt,
      ...(resolution === null ? {} : { resolution: resolutionRows(resolution) }),
    } as StepTrace);
    return { kind: "stop", result: { kind: "ok", outputs: this.#outputs } };
  }

  #ctxOf(observation: Observation): EvalContext {
    return { observation, program: this.#o.program.facts, bindings: this.#bindings };
  }

  #disabledFor(stepId: string): readonly string[] {
    return this.#o.program.disabledDescriptors
      .filter((d) => d.stepId === stepId)
      .map((d) => d.descriptorId);
  }

  /** The journal line that proves an action was authorized, beside the action it authorized. */
  #journalDecision(step: ResolvedStep, decision: PolicyDecision, actionKind: ActionKind): void {
    this.#o.journal.append({
      type: "policy.decided",
      decision,
      actionKind,
      effect: step.effect,
    });
  }

  #authorizeStep(
    step: ResolvedStep,
  ):
    | { readonly ok: true; readonly policyGrant: ApprovalGrant | null }
    | { readonly ok: false; readonly verdict: Extract<ApprovalVerdict, { readonly ok: false }> } {
    if (step.effect !== "WRITE_IRREVERSIBLE") {
      return { ok: true, policyGrant: this.#o.approval };
    }

    const grant = this.#o.invocationApproval ?? null;
    if (grant === null) {
      const verdict: Extract<ApprovalVerdict, { readonly ok: false }> = {
        ok: false,
        reason: "request-binding-missing",
        detail:
          "an irreversible action needs an invocation approval document bound to this tenant, artifact, contract, arguments and idempotency key",
        approvalId: this.#o.approval?.token ?? "missing",
        keyId: null,
      };
      this.#journalApprovalRefused(step, verdict);
      return { ok: false, verdict };
    }

    const narrowed = irreversibleApprovalOf(grant.approval);
    if (!narrowed.ok) {
      this.#journalApprovalRefused(step, narrowed.verdict);
      return { ok: false, verdict: narrowed.verdict };
    }

    const demand: ApprovalDemand & { readonly requiredAuthority: readonly [string, ...string[]] } =
      {
        subject: "invocation",
        capability: {
          name: this.#o.program.contract.name,
          version: this.#o.program.contract.version,
        },
        artifactDigest: this.#o.program.artifact.digest,
        contractDigest: this.#o.program.contract.digest,
        effect: step.effect,
        artifactMaxEffect: this.#o.program.effects.maxEffect,
        tenantId: this.#o.tenant.tenantId,
        appInstanceId: this.#o.tenant.appInstanceId,
        policyVersion: this.#o.approvalPolicyVersion ?? APPROVAL_POLICY_VERSION,
        requiredAuthority: grant.requiredAuthority,
        argsHash: approvalArgsHash(grant.approval.approvalId, this.#o.args),
        idempotencyKey: this.#o.idempotencyKey ?? null,
      };
    const verdict = authorizeIrreversibleWrite({
      approval: narrowed.approval,
      demand,
      trust: grant.trust,
      now: this.#o.clock.now(),
    });

    if (!verdict.ok) {
      this.#journalApprovalRefused(step, verdict);
      return { ok: false, verdict };
    }

    this.#o.journal.append({
      type: "approval.accepted",
      approvalId: verdict.approvalId,
      subject: verdict.subject,
      ceiling: verdict.ceiling,
      signerId: verdict.signerId,
      keyId: verdict.keyId,
      over: verdict.over,
      expiresAt: verdict.expiresAt,
      stepId: step.id,
      effect: step.effect,
    });
    return { ok: true, policyGrant: approvalGrant(this.#o.program.artifact.digest, verdict.approvalId) };
  }

  #journalApprovalRefused(
    step: ResolvedStep,
    verdict: Extract<ApprovalVerdict, { readonly ok: false }>,
  ): void {
    this.#o.journal.append({
      type: "approval.refused",
      approvalId: verdict.approvalId,
      reason: verdict.reason,
      detail: verdict.detail,
      keyId: verdict.keyId,
      stepId: step.id,
      effect: step.effect,
    });
  }

  #approvalRefusalDecision(
    verdict: Extract<ApprovalVerdict, { readonly ok: false }>,
  ): PolicyDecision {
    return {
      allow: false,
      reason: "irreversible-requires-approval",
      ruleId: `approval:${verdict.reason}`,
      detail: verdict.detail,
    };
  }

  #chargeAction(): void {
    const charge = this.#o.ledger.chargeAction();
    this.#o.journal.append({ type: "budget.charged", ...charge });
  }

  /**
   * Classify a refusal.
   *
   * A denial is not turned into a failure here: it is handed to `classify` as `GateFacts.policy`,
   * which is what makes `approval-required` and `policy-denied` two different rows of one taxonomy
   * rather than two `throw`s in an executor.
   */
  #refuse(
    step: ResolvedStep,
    decision: PolicyDecision,
    preInput: ClassifierInput,
    where: {
      readonly startedAt: number;
      readonly attempt: number;
      readonly resolution: TargetResolutionResult | null;
    },
  ): TurnDisposition | null {
    const input = { ...preInput, gate: gateWith(preInput.gate, { policy: decision }) };
    const verdict = this.#decide.classify(input);
    this.#journalClassified(step, "pre", verdict);
    return this.#dispose(step, verdict, input, where.startedAt, where.attempt, {
      allowAdvance: false,
      resolution: where.resolution,
    });
  }

  #chargeObservation(): boolean {
    const charge = this.#o.ledger.chargeObservation();
    this.#o.journal.append({ type: "budget.charged", ...charge });
    return charge.used > charge.limit;
  }

  async #perceiveOnce(): Promise<{
    readonly observation: Observation | null;
    readonly fault: ClassifierInput["perceiveFault"];
    readonly ledgerExhausted: boolean;
  }> {
    if (this.#chargeObservation()) {
      return { observation: null, fault: undefined, ledgerExhausted: true };
    }
    const result = await this.#o.surface.perceive({ deadlineMs: this.#deadlineMs });
    return result.ok
      ? { observation: result.observation, fault: undefined, ledgerExhausted: false }
      : { observation: null, fault: result.fault, ledgerExhausted: false };
  }

  #classifierInput(args: {
    readonly step: ResolvedStep;
    readonly stepLedger: StepLedger;
    readonly observation: Observation | null;
    readonly window: readonly string[];
    readonly preActDigest: string | null;
    readonly phase: "pre" | "post";
    readonly gate: GateFacts;
    readonly perceiveFault: ClassifierInput["perceiveFault"];
    readonly actFault?: ActFault;
    readonly irreversibleDispatched: boolean;
    readonly settleElapsedMs: number;
  }): ClassifierInput | null {
    if (args.observation === null) return null;
    return {
      observation: args.observation,
      recentDigests: args.window,
      preActDigest: args.preActDigest,
      step: args.step,
      ambient: this.#o.program.ambient,
      phase: args.phase,
      bindings: this.#bindings,
      counters: this.#o.ledger.counters(args.stepLedger),
      program: this.#o.program.facts,
      elapsedMs: this.#o.ledger.elapsedMs,
      settleElapsedMs: args.settleElapsedMs,
      gate: args.gate,
      ...(args.actFault === undefined ? {} : { actFault: args.actFault }),
      ...(args.perceiveFault === undefined ? {} : { perceiveFault: args.perceiveFault }),
      irreversibleDispatched: args.irreversibleDispatched,
    };
  }

  #policyContext(
    step: ResolvedStep,
    location: RouteLocation | null,
    observation: Observation,
    approval: ApprovalGrant | null = this.#o.approval,
  ): PolicyContext {
    // Where the action LANDS, not where we are: a navigate goes somewhere else, and checking the
    // page you are on while the action goes elsewhere is a check of the wrong thing - the shape an
    // open redirect takes on a surface with no address bar.
    const route =
      location !== null
        ? { originAlias: location.originAlias, path: location.path }
        : observation.route !== null
          ? { originAlias: observation.route.originAlias, path: observation.route.path }
          : null;
    return {
      mode: this.#o.mode,
      allowlist: this.#o.allowlist,
      step,
      route,
      effect: step.effect,
      lease: this.#o.lease.snapshot(),
      approval: approval?.token ?? null,
      artifact: {
        lifecycle: this.#o.program.artifact.lifecycle.status,
        // The digest is re-derived from the document by `parseArtifact` on the way in, and `link`
        // refuses at check 2 when it disagrees, so reaching here means it verified.
        digestVerified: true,
      },
      taint: this.#bindings.flatMap((b) => (b.handle === null ? [] : [b.handle])),
      approvedDigest: approval?.digest ?? null,
    };
  }

  #locationFor(step: ResolvedStep): RouteLocation | null {
    if (step.instruction.kind !== "navigate") return null;
    return this.#locationForRoute(step.instruction.route);
  }

  /**
   * The concrete location a route id names, with every `:param` bound.
   *
   * Substitution is by NAME from the bindings, so the artifact still stores `/member/:memberId` and
   * the member number exists only in memory for the length of one dispatch. A placeholder nothing
   * binds is left in place: `navigationTargetOf` refuses an uncanonicalized path, which is a better
   * failure than silently navigating to a literal `:memberId`.
   */
  #locationForRoute(routeId: string): RouteLocation | null {
    const pattern = this.#o.program.facts.routes.find((r) => r.id === routeId);
    if (pattern === undefined) return null;
    const path = pattern.path
      .split("/")
      .map((segment) => {
        if (!segment.startsWith(":")) return segment;
        const binding = bindingFor({ from: "param", param: segment.slice(1) }, this.#bindings);
        return binding === null ? segment : encodeURIComponent(binding.value);
      })
      .join("/");
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(pattern.query ?? {})) {
      if (value === ":any") continue;
      const binding = bindingFor(value as never, this.#bindings);
      if (binding !== null) query[key] = binding.value;
    }
    return {
      originAlias: pattern.originAlias,
      path,
      query,
      ...(pattern.frame === undefined ? {} : { frame: pattern.frame }),
    } as RouteLocation;
  }

  /**
   * Freeze this screen if the step's recording policy asks for it - or if the RUN was told to
   * capture everything.
   *
   * `captureEvery` is a RUNTIME OPTION and never an artifact edit, and the distinction is the whole
   * reason it is expressed here. `evidence.captureOn` is a recording policy that lives inside the
   * digest an approval signs; overriding it from a command line must not move the program's content
   * address, and it does not, because it never touches the document.
   *
   * WHY IT EXISTS AT ALL. Every step of every shipped artifact declares `captureOn: ["failure"]`,
   * which is the right default in production - freezing every screen of every run writes regulated
   * data to disk at a rate nobody wants - and the consequence is that A GREEN RUN FREEZES NOTHING.
   * So the one observation an outcome promotion cannot do without, a happy-path capture at the step
   * the detector is declared for, is the one observation the system never keeps. `crr probe
   * --capture-every` is where that trade is deliberately reversed, for one run, against an
   * obviously synthetic member, into a directory the redaction canary covers.
   *
   * `never` still means never: it is how a `recover` disposition says "this screen is on its way to
   * being fixed, do not file it as evidence", and a blanket capture flag must not turn a transient
   * interstitial into a corpus member that a later proof then has to be silent on.
   */
  #captureIf(
    step: ResolvedStep,
    observation: Observation,
    when: "failure" | "outcome" | "always" | "never",
    phase: "pre" | "post",
  ): EvidenceRef | null {
    if (when === "never") return null;
    const declared =
      step.evidence.captureOn.includes("always") ||
      (when !== "always" && step.evidence.captureOn.includes(when));
    if (!declared && this.#o.captureEvery !== true) return null;
    const ref = this.#o.evidence.putObservation(observation, this.#bindings);
    this.#o.journal.append({
      type: "evidence.captured",
      ref,
      kind: "observation",
      maskedRegions: observation.nodes.filter((n) => n.masked).length,
      // The binding from a frozen screen to the step and phase it was taken at. It used to be
      // positional - read off whichever `observed` line came before - and a discrimination proof
      // that trusted line ordering for a security-relevant fact would be exactly the quiet
      // wrongness this repository refuses everywhere else.
      stepId: step.id,
      phase,
    });
    return ref;
  }

  #journalObserved(step: ResolvedStep, observation: Observation | null): void {
    if (observation === null) return;
    this.#o.journal.append({
      type: "observed",
      stepId: step.id,
      obsSeq: observation.seq,
      skeletonDigest: observation.skeletonDigest,
      settled: observation.stability.settled,
      nodeCount: observation.nodes.length,
      observationRef: null,
    });
  }

  #journalClassified(step: ResolvedStep, phase: "pre" | "post", verdict: Verdict): void {
    this.#o.journal.append({
      type: "classified",
      stepId: step.id,
      phase,
      verdict: redactJournalVerdict(verdict, this.#bindings),
      alsoMatched: verdict.kind === "outcome" ? verdict.alsoMatched.map((m) => m.code) : [],
    });
  }

  #journalResolved(step: ResolvedStep, resolution: TargetResolutionResult): void {
    this.#o.journal.append({
      type: "resolved",
      stepId: step.id,
      descriptors: resolution.candidates.map((c) => ({
        id: c.descriptorId,
        kind: c.kind,
        evidenceSource: c.evidenceSource,
        verdict: c.verdict,
        nodeId: c.nodeId,
      })),
      agreed: resolution.status === "resolved",
      distinctSources: resolution.status === "resolved" ? resolution.independentSources : 0,
    });
  }

  #note(name: string, stepId: string, attempts: number, result: "cleared" | "exhausted"): void {
    const existing = this.#recoveries.find((r) => r.stepId === stepId && r.name === name);
    if (existing === undefined) {
      this.#recoveries.push({ stepId, name, attempts, result });
      return;
    }
    existing.attempts = attempts;
    existing.result = result;
  }

  /**
   * Mint the intervention id and journal that a human is being asked for.
   *
   * The BRIEF is not built here, and that is deliberate. Everything on it that a person needs -
   * the capability title, the goal template, the masked capture, the step title - is either the
   * host's (`replay` holds the contract and the artifact's provenance) or already on the suspended
   * arm. Building it in two places would give an operator one story and the result document
   * another. This function owns the id and the journal line; `escalation.ts` owns the words.
   */
  #raiseIntervention(
    step: ResolvedStep,
    reason: SuspensionReason,
    summary: string,
    ref: EvidenceRef | null,
  ): string {
    const id = this.#o.ids.interventionId();
    this.#o.journal.append({ type: "intervention.raised", interventionId: id, reason });
    void step;
    void summary;
    void ref;
    return id;
  }

  #failedResult(
    step: ResolvedStep,
    observation: Observation,
    failure: FailureClass,
    notes: readonly string[],
  ): RunResultFailed {
    const ref = this.#o.evidence.putObservation(observation, this.#bindings);
    return {
      kind: "failed",
      failure,
      detail: {
        // Built here rather than by `classify` because these are conditions the interpreter itself
        // detected - a remedy that could not find its control, a broker that could not refresh -
        // and inventing a `ClassifierInput` for them would be pretending a pure function decided
        // something it did not see.
        sideEffects: this.#o.ledger.view().actions.used === 0 ? "none-guaranteed" : "possible",
        expected: { rendered: notes.join("; "), clauses: [] },
        observed: observedSummaryOf(observation, this.#bindings),
        attempts: [],
        retriable: "after-human-action",
        operatorAction: notes.join("; "),
      },
      atStep: step.id,
      stepIndex: step.index,
      observationRef: ref,
      partialOutputs: this.#outputs,
    };
  }

  #stopWithBudget(
    step: ResolvedStep,
    observation: Observation | null,
    _stepLedger: StepLedger,
    _attempt: number,
  ): TurnDisposition {
    const result: RunResultFailed =
      observation === null
        ? {
            kind: "failed",
            failure: "budget-exhausted",
            detail: emptyDetail("the run's observation ledger was spent"),
            atStep: step.id,
            stepIndex: step.index,
            observationRef: null,
            partialOutputs: this.#outputs,
          }
        : this.#failedResult(step, observation, "budget-exhausted", [
            "the run's observation ledger was spent",
          ]);
    return { kind: "stop", result };
  }

  #noScreen(step: ResolvedStep, fault?: ClassifierInput["perceiveFault"] | null): TurnDisposition {
    // Every poll faulted and there is no observation to classify against. `classify` is total over
    // an Observation and there is not one, so the interpreter says so in its own voice rather than
    // fabricating an empty screen for a pure function to draw a conclusion from.
    return {
      kind: "stop",
      result: {
        kind: "failed",
        failure: "surface-error",
        detail: emptyDetail(
          `the driver could not report what the screen looks like${
            fault == null ? "" : ` (${fault.kind})`
          }`,
        ),
        atStep: step.id,
        stepIndex: step.index,
        observationRef: null,
        partialOutputs: this.#outputs,
      },
    };
  }

  #internalDisposition(
    step: ResolvedStep,
    note: string,
    observation: Observation,
  ): TurnDisposition {
    return {
      kind: "stop",
      result: this.#failedResult(step, observation, "internal-invariant", [note]),
    };
  }

  #internal(step: ResolvedStep, note: string): RunResultFailed {
    return {
      kind: "failed",
      failure: "internal-invariant",
      detail: emptyDetail(note),
      atStep: step.id,
      stepIndex: step.index,
      observationRef: null,
      partialOutputs: this.#outputs,
    };
  }

  #unreachable(step: ResolvedStep): TurnDisposition {
    return {
      kind: "stop",
      result: this.#internal(step, "a post-act verdict produced no disposition"),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

type TurnDisposition =
  | { readonly kind: "advance" }
  | { readonly kind: "stop"; readonly result: RunResult }
  | {
      readonly kind: "recover";
      readonly verdict: Extract<Verdict, { kind: "recover" }>;
      readonly observation: Observation;
      /** Carried so the remedy's own capture can say which phase the screen was taken in, rather
       *  than a reader inferring it from where the line landed. */
      readonly phase: "pre" | "post";
    };

function gateWith(gate: GateFacts | undefined, patch: Partial<GateFacts>): GateFacts {
  return { lease: "held", policy: null, target: null, ...gate, ...patch };
}

function resolutionRows(resolution: TargetResolutionResult): StepTrace["resolution"] {
  return resolution.candidates.map((c) => ({
    descriptorId: c.descriptorId,
    kind: c.kind,
    evidenceSource: c.evidenceSource,
    verdict: c.verdict,
    resolvedNodeId: c.nodeId,
  })) as StepTrace["resolution"];
}

/** A handle, never the text: the journal has to be able to say WHICH value an action carried
 *  without ever holding it. */
function valueHandleOf(step: ResolvedStep, bindings: ResolvedBindings) {
  if (step.instruction.kind !== "fill") return null;
  return bindingFor(step.instruction.value, bindings)?.handle ?? null;
}

function valueAsString(value: unknown): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function redactJournalVerdict(verdict: Verdict, bindings: ResolvedBindings): Verdict {
  switch (verdict.kind) {
    case "advance":
      return {
        ...verdict,
        outputs: verdict.outputs.map((output) => redactJournalOutput(output, bindings)),
      };
    case "outcome":
      return {
        ...verdict,
        data: verdict.data.map((output) => redactJournalOutput(output, bindings)),
      };
    default:
      return verdict;
  }
}

function redactJournalOutput(output: ExtractedOutput, bindings: ResolvedBindings): ExtractedOutput {
  const redactString = (text: string): string => redactTaint(text, bindings).text;
  if (typeof output.value === "string") {
    return { ...output, value: redactString(output.value) };
  }
  if (Array.isArray(output.value)) {
    return {
      ...output,
      value: output.value.map((row) => {
        const entries = Object.entries(row as Readonly<Record<string, string>>);
        return Object.fromEntries(entries.map(([key, value]) => [key, redactString(value)]));
      }),
    };
  }
  return output;
}

function actionLocation(action: Action): RouteLocation | null {
  return action.kind === "navigate" ? action.route : null;
}

function emptyDetail(rendered: string): FailureDetail {
  return {
    sideEffects: "possible",
    expected: { rendered, clauses: [] },
    observed: {
      route: null,
      settled: false,
      pendingReason: null,
      // Not an empty string: `ObservedSummary` requires a non-empty digest, and "there was no
      // screen" is a fact worth spelling out rather than a blank a reader has to interpret.
      skeletonDigest: "no-observation",
      nodeCount: 0,
      nativeDialog: null,
      inputIntercepted: false,
      salient: [],
      redactionsApplied: 0,
    },
    attempts: [],
    retriable: "after-human-action",
    operatorAction: rendered,
  } as FailureDetail;
}

export type { ActionKind, PolicyDecision };
