// `replay` - LINK, then SESSION, then RUN, then RESULT (SPEC section 1.1).
//
// This is the host the interpreter runs inside, and it owns the three things the interpreter must
// not: the pre-flight failures that are decided before the surface is ever touched, the supervisor
// that services a `restart-program` by discarding the machine and brokering a FRESH session, and
// the assembly of the `RunEnvelope` that every arm of the result carries identically.
//
// That last point is worth defending because the temptation runs the other way. The obvious design
// makes failures verbose and successes terse. But the run you most want a trace for is the one that
// returned `ok` and should not have, and a descriptor that has quietly started abstaining shows up
// in `steps[].resolution` on a GREEN run months before it shows up as a failure. So `ok` carries
// the same envelope as `failed`, including the drift signal.
//
// The four arms are returned, never thrown. There is no code path in this module where a business
// outcome can be observed by a `catch` block - which is the property that makes `MEMBER_NOT_FOUND`
// an answer rather than an exception, and it is the single most common design mistake this project
// exists to avoid.

import {
  type Allowlist,
  type ApprovalTrust,
  type CapabilityArtifact,
  type CapabilityContract,
  type CapabilityOverlay,
  type Digest,
  type DriftSignal,
  type EvidenceRef,
  FAILURE_GUIDANCE,
  type Intervention,
  type InterventionId,
  LINK_CHECK_COUNT,
  type LinkError,
  type LinkedProgram,
  type ReplayResultDocument,
  ReplayResultSchema,
  type ResolvedStep,
  type RunEnvelope,
  RunEnvelopeSchema,
  type RunId,
  type StepTrace,
  type Surface,
  type SurfaceKind,
  digestOf,
  failureClassOf,
  fingerprintsEqual,
  link,
  observedSummaryOf,
  preFlightVerdict,
} from "@crr/core";
import type { ApprovalGrant } from "./approval.js";
import type { InvocationApprovalGrant } from "./approval.js";
import { RunLedger } from "./budgets.js";
import { type Clock, systemClock } from "./clock.js";
import { interventionBrief } from "./escalation.js";
import { type EvidenceSink, MemoryEvidenceSink } from "./evidence.js";
import { type IdSource, evidenceRefOf, randomIds } from "./ids.js";
import {
  type DecisionFunctions,
  type DryRunBoundaryReport,
  type DryRunPolicy,
  Interpreter,
  type InterpreterResumeState,
  type InterpreterRun,
  type RunResult,
  type RunResultFailed,
} from "./interpreter.js";
import type { ControlPlane } from "./intervention.js";
import { type Journal, MemoryJournal } from "./journal.js";
import { LeaseAuthority, leaseSinkOf } from "./lease.js";
import type { SessionBroker, TenantRef } from "./session.js";

export const ENGINE_VERSION = "crr-runtime/0.1.0";

export interface ReplayOptions {
  readonly contract: CapabilityContract;
  readonly artifact: CapabilityArtifact;
  readonly overlay?: CapabilityOverlay | null;
  readonly args: Readonly<Record<string, unknown>>;
  readonly tenant: { readonly tenantId: string; readonly appInstanceId: string };
  readonly allowlist: Allowlist;
  readonly broker: SessionBroker;
  readonly trust: ApprovalTrust;
  readonly approval?: ApprovalGrant | null;
  readonly invocationApproval?: InvocationApprovalGrant | null;
  readonly approvalPolicyVersion?: string;
  readonly idempotencyKey?: string | null;
  readonly clock?: Clock;
  readonly ids?: IdSource;
  readonly journal?: (runId: RunId, clock: Clock) => Journal;
  readonly evidence?: EvidenceSink;
  /** `replay` is the production path and demands an approved, signed artifact; `verification` is
   *  the immediate self-replay that decides whether a proposed artifact may become a draft at all,
   *  and requiring an approval there would make the lifecycle unreachable. */
  readonly mode?: "replay" | "verification";
  readonly actorId?: string;
  readonly perceiveDeadlineMs?: number;
  readonly onIntervention?: "suspend" | "fail";
  /**
   * Run every step up to the first one at or above `stopBeforeEffect`, then do everything except
   * dispatch at that step and stop (SPEC section 6.6's `replay-dry`).
   *
   * Exposed on `replay` rather than hidden inside `verifyArtifact` because it is independently
   * useful in production: it is how a deployment checks an artifact against a tenant after a vendor
   * upgrade without touching their data.
   */
  readonly dryRun?: DryRunPolicy | null;
  /**
   * The CALLER's own budget, from `Invocation.budget`.
   *
   * It can only TIGHTEN. A caller with forty seconds of conversational patience must be able to say
   * so; a caller must never be able to raise a ceiling an approver signed over, because the
   * artifact's budgets are part of the document the approval signature covers and "how much of a
   * legacy core this run may spend" is exactly the kind of thing an approver was agreeing to. Hence
   * `Math.min` rather than an override.
   */
  readonly budgetCeiling?: {
    readonly wallClockMs?: number;
    readonly maxRemediations?: number;
  } | null;
  /** What the caller pinned when its tool definitions were generated. Absent means "no generated
   *  types to be stale", and check 4 is then vacuous. */
  readonly invocation?: {
    readonly name: string;
    readonly version: string;
    readonly contractDigest: string;
  } | null;
  /**
   * The desk that takes custody of a suspended run (SPEC section 7).
   *
   * OPTIONAL, and its absence is a real configuration rather than an oversight: a headless batch
   * host with nobody to escalate to passes `onIntervention: "fail"` and no control plane, and gets
   * a `failed` arm. A host that has an operator console passes one, and a suspension becomes a live
   * session parked behind an intervention id instead of a browser nobody closes.
   */
  readonly control?: ControlPlane | null;
  /**
   * The engine's two pure decision functions. Defaults to `REFERENCE_DECISIONS`.
   *
   * Present so `@crr/conformance` can drive a deliberately weakened engine through this exact host
   * - the same linker, lease, budgets, session broker and journal - and so the claim "the suite
   * discriminates" is about the shipping engine rather than about a copy of it. Not a production
   * extension point; see `DecisionFunctions`.
   */
  readonly decisions?: DecisionFunctions | null;
  /**
   * Freeze an observation at every step, whatever the steps declare. What `crr probe
   * --capture-every` sets.
   *
   * A RUNTIME OPTION, NOT AN ARTIFACT EDIT: `evidence.captureOn` is a recording policy inside the
   * digest an approval signs, so overriding it from a command line must not move the program's
   * content address - and it does not, because nothing here touches the document. The probe's
   * result, its journal and its `effectiveDigest` are the same ones an ordinary replay would
   * produce; only the number of files on disk differs.
   */
  readonly captureEvery?: boolean;
}

export interface ReplayOutput {
  readonly result: ReplayResultDocument;
  readonly journal: Journal;
  readonly evidence: EvidenceSink;
  /** Present unless the run failed pre-flight. Exposed so a caller can re-check the digest that
   *  actually ran without re-linking. */
  readonly program: LinkedProgram | null;
  /** Where a `dryRun` stopped, or `null` when the program ran to its end (including every run that
   *  did not ask for a dry run at all). */
  readonly dryStoppedAt: { readonly stepId: string; readonly stepIndex: number } | null;
  readonly dryBoundary: DryRunBoundaryReport | null;
}

export async function replay(options: ReplayOptions): Promise<ReplayOutput> {
  const clock = options.clock ?? systemClock();
  const ids = options.ids ?? randomIds();
  const evidence = options.evidence ?? new MemoryEvidenceSink();
  const runId = ids.runId();
  const journal = options.journal?.(runId, clock) ?? new MemoryJournal({ runId, clock });
  const startedAt = clock.now();
  const mode = options.mode ?? "replay";

  journal.append({
    type: "run.started",
    mode: mode === "verification" ? "verify" : "replay",
    capability: options.contract.name,
    artifactDigest: options.artifact.digest,
    effectiveDigest: options.artifact.digest,
    tenantId: tenantRef(options.tenant).tenantId,
    // SHAPES, never values. The single most likely place for a member number to end up in a log is
    // the line that says which arguments a run started with.
    argsShape: shapeOf(options.args),
  });

  // ---- LINK: 29 checks, zero actions performed -------------------------------------------------
  const linked = link({
    contract: options.contract,
    artifact: options.artifact,
    overlay: options.overlay ?? null,
    capabilities: (await peekCapabilities(options.broker, options.tenant)) ?? undefined,
    args: options.args,
    invocation: options.invocation ?? null,
    mode,
    // Check 29 is tenant-scoped: a reviewer-authored detector reads a vocabulary token an overlay
    // overrides per tenant, so a proof at riverbend says nothing about summit. The run knows which
    // tenant it is at even when there is no overlay to read one off, so it says so.
    tenant: tenantRef(options.tenant).tenantId,
    allowlist: options.allowlist,
    trust: options.trust,
  });
  journal.append({
    type: "link.completed",
    checksRun: LINK_CHECK_COUNT,
    errors: linked.ok ? [] : (linked.errors as readonly LinkError[]),
  });

  if (!linked.ok) {
    return {
      program: null,
      journal,
      evidence,
      dryStoppedAt: null,
      dryBoundary: null,
      result: preFlightResult({
        runId,
        startedAt,
        endedAt: clock.now(),
        options,
        errors: linked.errors,
        journal,
        evidence,
      }),
    };
  }

  const program = linked.program;

  // ---- SESSION: the program never logs in -----------------------------------------------------
  const session = await options.broker.open(
    program.merged.target.sessionProfile,
    tenantRef(options.tenant),
  );
  journal.append({
    type: "session.opened",
    sessionId: session.sessionId,
    sessionProfile: program.merged.target.sessionProfile,
  });

  const ledger = new RunLedger(tightened(program.merged.budgets, options.budgetCeiling), clock);
  const actorId = options.actorId ?? `run:${runId}`;

  // ---- RUN, with the supervisor that services a restart ---------------------------------------
  let surface: Surface = session.surface;
  let sessionId = session.sessionId;
  let run: InterpreterRun;
  let attempt = 0;
  // The authority the CURRENT machine is running under. A restart builds a new one, and a hand-back
  // needs the one that was live when the run parked - which is why this is a variable the closures
  // read rather than a value the loop keeps to itself.
  // Definitely assigned by `drive` before anything reads it; TypeScript cannot see an assignment
  // that happens inside a closure, and a `| null` here would put a null check on a path that has
  // none.
  let leaseNow!: LeaseAuthority;
  // Sticky across attempts. SPEC section 7.4: a run a human touched is never reported as a purely
  // automated success, and a restart after a handoff must not launder that away.
  let humanAssisted = false;
  // Traces from EVERY attempt, concatenated. A restart discards the machine, not the audit trail:
  // the run envelope has to be able to answer "what did the attempt that failed actually do", and
  // an envelope that only carries the last attempt answers it with silence.
  const tracesAcrossAttempts: StepTrace[] = [];
  const recoveriesAcrossAttempts: InterpreterRun["recoveriesApplied"][number][] = [];
  const warningsAcrossAttempts: InterpreterRun["warnings"][number][] = [];

  /**
   * One pass of the supervisor: build a machine, run it, and service a `restart-program`.
   *
   * A local function rather than a straight loop because a HAND-BACK re-enters it. Every fact the
   * envelope needs - the traces from every attempt, the ledgers, the session that may have been
   * re-brokered - is already closed over here, so a resumed run is assembled from the same
   * material as the turn that parked it and cannot drift into reporting a different story.
   *
   * `resumeFrom` applies to the FIRST attempt only. A restart discards the machine and starts at pc
   * 0 with a fresh session, which is exactly the semantics a resumed run should get too: whatever a
   * human did, a restart is a restart.
   */
  const drive = async (resumeFrom: InterpreterResumeState | null): Promise<InterpreterRun> => {
    let carried = resumeFrom;
    for (;;) {
      attempt += 1;
      // A RESUMED first attempt keeps the authority it suspended under. Building a fresh one would
      // reset the epoch to 1 - so a token minted before the handoff would start validating again -
      // and would throw away the `ControlTransfer` that records which human held this session and
      // what they did. Both of those are the audit trail this whole section exists to produce.
      const resumed = carried !== null;
      const lease = resumed
        ? leaseNow
        : new LeaseAuthority({ sessionId, clock, ids, sink: leaseSinkOf(surface) });
      if (!resumed) {
        lease.grantToAutomation(actorId);
        journal.append({
          type: "lease.acquired",
          holder: "automation",
          actorId,
          epoch: lease.epoch,
        });
      }
      leaseNow = lease;

      const interpreter = new Interpreter({
        program,
        surface,
        broker: options.broker,
        sessionId,
        lease,
        clock,
        ids,
        journal,
        evidence,
        ledger,
        allowlist: options.allowlist,
        args: options.args,
        tenant: options.tenant,
        ...(options.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
        // THE POLICY MODE IS NOT THE REPLAY MODE, and this is the one line where they part company.
        //
        // A verification replay runs an artifact nobody has approved yet - that is the whole point of
        // it, since approval is downstream of the verification it produces. Policy rule 7 refuses to
        // let an unapproved artifact drive a surface in `replay`, so a verification run presenting
        // itself as `replay` would be denied at its first action and the lifecycle would have no
        // reachable first step.
        //
        // `discovery` is the honest answer rather than a convenient one: the verification replay is
        // the TAIL OF THE DISCOVERY RUN (SPEC section 6.6 - "immediately, same session boundary"), so
        // it is bounded by the deployment's `allowlist.discoveryMaxEffect` and, for an irreversible
        // action, still requires an explicit approval token at the moment the action is attempted
        // (policy rule 8, which is uniform across modes). The consequence is deliberate and is the
        // reason `replay-dry` is the default for a write flow: a `replay-reset` verification that
        // really performs the write needs a deployment that permits it AND a human-minted token, and
        // gets neither by accident.
        mode: mode === "verification" ? "discovery" : "replay",
        approval: options.approval ?? null,
        invocationApproval: options.invocationApproval ?? null,
        ...(options.approvalPolicyVersion === undefined
          ? {}
          : { approvalPolicyVersion: options.approvalPolicyVersion }),
        actorId,
        ...(options.dryRun === undefined || options.dryRun === null
          ? {}
          : { dryRun: options.dryRun }),
        ...(options.perceiveDeadlineMs === undefined
          ? {}
          : { perceiveDeadlineMs: options.perceiveDeadlineMs }),
        ...(options.onIntervention === undefined ? {} : { onIntervention: options.onIntervention }),
        ...(carried === null ? {} : { resumeFrom: carried }),
        ...(options.decisions == null ? {} : { decisions: options.decisions }),
        ...(options.captureEvery === true ? { captureEvery: true } : {}),
      });
      carried = null;
      const attemptRun = await interpreter.run();
      tracesAcrossAttempts.push(...attemptRun.steps);
      recoveriesAcrossAttempts.push(...attemptRun.recoveriesApplied);
      warningsAcrossAttempts.push(...attemptRun.warnings);
      if (attemptRun.attribution === "human-assisted") humanAssisted = true;

      if (attemptRun.result.kind !== "restart") return attemptRun;

      // A restart is not a jump: the machine is discarded and a new one built at pc 0, with the same
      // arguments and a FRESHLY BROKERED session. Reusing the session is the bug this exists to
      // avoid - restarting into the same expired session burns the budget and fails identically.
      const refreshed = await options.broker.refresh(sessionId);
      if (refreshed === "failed") return attemptRun;
      if (refreshed === "reopened") {
        const next = await options.broker.open(
          program.merged.target.sessionProfile,
          tenantRef(options.tenant),
        );
        surface = next.surface;
        sessionId = next.sessionId;
        journal.append({
          type: "session.opened",
          sessionId,
          sessionProfile: program.merged.target.sessionProfile,
        });
      }
      journal.append({ type: "lease.released", holder: "automation", reason: "program restart" });
    }
  };

  /**
   * Turn a stopped machine into the document the caller switches on.
   *
   * `run.finished` is written HERE and nowhere else. The interpreter can stop for five different
   * reasons and a turn has exactly one ending; emitting it from each stopping point is how a journal
   * ends up with two of them, or none on the arm nobody remembered.
   *
   * A run that is PARKED writes one of these too, with `status: "suspended"`. That is a second
   * `run.finished` in the journal of a run that is later resumed, and it is the honest reading: a
   * suspension ends a TURN, not a run, and the alternative - withholding an ending until a human
   * acts - leaves a journal with no ending at all for a run nobody ever comes back to.
   */
  const finish = (
    finished: InterpreterRun,
    closeJournal: boolean,
    parked: Intervention | null = null,
  ): ReplayOutput => {
    journal.append({ type: "run.finished", ...finishedFields(finished.result) });
    const endedAt = clock.now();
    const journalRef = evidence.putJson("journal", journal.events);
    const envelope = buildEnvelope({
      runId,
      program,
      options,
      run: {
        ...finished,
        steps: tracesAcrossAttempts,
        recoveriesApplied: recoveriesAcrossAttempts,
        warnings: warningsAcrossAttempts,
        attribution: humanAssisted ? "human-assisted" : finished.attribution,
        transfers: leaseNow.transfers(),
      },
      ledger,
      startedAt,
      endedAt,
      surfaceKind: surface.capabilities().kind,
      evidence,
      journalRef,
    });
    if (closeJournal) journal.close();
    return {
      program,
      journal,
      evidence,
      dryStoppedAt: finished.dryStoppedAt,
      dryBoundary: finished.dryBoundary,
      result: armOf(finished.result, envelope, program, parked),
    };
  };

  run = await drive(null);

  // ---- PARK: a suspension is not an ending ----------------------------------------------------
  const control = options.control ?? null;
  if (run.result.kind === "suspended" && control !== null) {
    const suspended = run.result;
    const step = program.steps.find((s) => s.id === suspended.atStep) as ResolvedStep;
    const lease = leaseNow;
    const parkedRun = run;

    const parkedIntervention = control.park({
      interventionId: suspended.interventionId as InterventionId,
      reason: suspended.reason,
      resumeToken: suspended.resumeToken,
      brief: interventionBrief({
        capabilityTitle: program.contract.title,
        // The GOAL TEMPLATE, parameterized. A brief that carried the member number would put one on
        // an operator's screen at exactly the moment the system was being careful about everything
        // else.
        goalTemplate: program.merged.provenance.goalTemplate,
        stepIndex: suspended.stepIndex,
        stepTitle: step.title,
        expected: suspended.expected,
        observed: suspended.observed,
        evidence: suspended.observationRef,
        reason: suspended.reason,
        failure: null,
        note: suspended.summary,
      }),
      parked: {
        runId: runId as RunId,
        sessionId,
        tenantId: options.tenant.tenantId,
        program,
        step,
        surface,
        lease,
        journal,
        evidence,
        ledger,
        clock,
        allowlist: options.allowlist,
        approval: options.approval ?? null,
        invocationApproval: options.invocationApproval ?? null,
        args: options.args,
        tenant: options.tenant,
        ...(options.approvalPolicyVersion === undefined
          ? {}
          : { approvalPolicyVersion: options.approvalPolicyVersion }),
        ...(options.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
        bindings: program.bindings,
        perceiveDeadlineMs: options.perceiveDeadlineMs ?? 15_000,
        heldBefore: suspended.heldBefore,
      },
      // The desk decides WHAT happened; this closure is the only thing that knows how to say it.
      continuation: async (disposition) => {
        humanAssisted = true;
        if (disposition.kind === "resume") {
          const resumed = await drive({
            pc: step.index,
            bindings: program.bindings,
            outputs: suspended.partialOutputs,
          });
          return finish(resumed, true).result;
        }
        if (disposition.kind === "outcome") {
          const declared = disposition.verdict;
          return finish(
            {
              ...parkedRun,
              result: {
                kind: "outcome",
                code: declared.code,
                data: declared.data,
                priority: declared.priority,
                alsoMatched: declared.alsoMatched,
                detectedAt: { stepId: step.id, stepIndex: step.index },
                partialOutputs: suspended.partialOutputs,
              },
            },
            true,
          ).result;
        }
        return finish(
          {
            ...parkedRun,
            result: {
              kind: "failed",
              failure: disposition.failure,
              detail: {
                // A refused hand-back performed no action of its own. Whether the RUN has side
                // effects is a question about what it did before it suspended, and the action
                // ledger is the only honest witness to that.
                sideEffects: ledger.view().actions.used === 0 ? "none-guaranteed" : "possible",
                expected: {
                  rendered: disposition.notes.join("; "),
                  clauses: [],
                },
                observed:
                  disposition.observation === null
                    ? suspended.observed
                    : observedSummaryOf(disposition.observation, program.bindings),
                attempts: [],
                retriable: "after-human-action",
                operatorAction: FAILURE_GUIDANCE[disposition.failure].operatorAction,
              },
              atStep: step.id,
              stepIndex: step.index,
              observationRef: suspended.observationRef,
              partialOutputs: suspended.partialOutputs,
            },
          },
          true,
        ).result;
      },
    });
    // The journal stays OPEN: this run has a live session, a lease and a human on the way.
    return finish(run, false, parkedIntervention);
  }

  return finish(run, true);
}

// ---------------------------------------------------------------------------------------------
// The four arms
// ---------------------------------------------------------------------------------------------

function armOf(
  result: RunResult,
  run: RunEnvelope,
  program: LinkedProgram,
  parked: Intervention | null = null,
): ReplayResultDocument {
  switch (result.kind) {
    case "ok":
      return ReplayResultSchema.parse({
        status: "ok",
        outputs: bagOf(result.outputs),
        run,
      }) as ReplayResultDocument;

    case "outcome": {
      // The declaration on the CONTRACT is what the caller is told - the guidance a reviewer wrote,
      // copied verbatim, never generated at render time. The artifact's rule only decided that this
      // screen means that code.
      const declared = program.contract.outcomes.find((o) => o.code === result.code);
      return ReplayResultSchema.parse({
        status: "outcome",
        outcome: result.code,
        data: bagOf(result.data),
        terminal: true,
        callerAction: declared?.callerAction ?? "escalate-to-human",
        retryable: declared?.retryable ?? "never",
        guidance: declared?.agentGuidance ?? "No guidance was declared for this outcome.",
        detectedAt: {
          stepId: result.detectedAt.stepId,
          stepIndex: result.detectedAt.stepIndex,
          priority: result.priority,
        },
        alsoMatched: result.alsoMatched,
        run,
      }) as ReplayResultDocument;
    }

    case "suspended":
      return ReplayResultSchema.parse({
        status: "suspended",
        intervention: {
          id: result.interventionId,
          reason: result.reason,
          atStep: result.atStep,
          summary: result.summary,
          // The desk's own URL and deadline when a control plane took custody. Without one there is
          // no console to link to and no operator clock, and the caller is told exactly that rather
          // than being handed a link that goes nowhere.
          consoleUrl: parked?.consoleUrl ?? `crr://intervention/${result.interventionId}`,
          expiresAt: parked?.expiresAt ?? run.endedAt,
        },
        resume: { token: result.resumeToken, pollAfterMs: 5_000 },
        partialOutputs: bagOf(result.partialOutputs),
        run,
      }) as ReplayResultDocument;

    case "failed":
      return ReplayResultSchema.parse({
        status: "failed",
        failure: {
          class: result.failure,
          atStep: result.atStep,
          stepIndex: result.stepIndex,
          sideEffects: result.detail.sideEffects,
          expected: result.detail.expected,
          observed: result.detail.observed,
          ...(result.detail.candidates === undefined
            ? {}
            : { candidates: result.detail.candidates }),
          attempts: result.detail.attempts,
          retriable: result.detail.retriable,
          operatorAction: result.detail.operatorAction,
          observationRef: result.observationRef ?? evidenceRefOf("obs", digestOf(null)),
        },
        run,
      }) as ReplayResultDocument;

    case "restart":
      // The supervisor's loop only exits on a restart when the session could not be re-established,
      // so this is that: a run that asked to start over and had nowhere to start over into.
      //
      // `atStep` NAMES THE STEP, and that is not cosmetic. `ReplayFailedResultSchema` refines that a
      // failure with no step is a pre-flight failure and therefore performed zero actions; this one
      // performed several, so a null here made the document fail its own schema and `replay` THREW a
      // ZodError instead of returning the `failed` arm - on the one path where an operator most
      // needs an answer. Found by `@crr/conformance` scenario 15 (an application error page whose
      // restart the broker could not service).
      return ReplayResultSchema.parse({
        status: "failed",
        failure: {
          class: "session-expired-unrecoverable",
          atStep: program.merged.flow.steps[result.fromPc]?.id ?? null,
          stepIndex: result.fromPc,
          sideEffects: "possible",
          expected: {
            rendered: "a fresh session could be brokered for the program restart",
            clauses: [],
          },
          observed: {
            route: null,
            settled: false,
            pendingReason: null,
            skeletonDigest: "no-observation",
            nodeCount: 0,
            nativeDialog: null,
            inputIntercepted: false,
            salient: [],
            redactionsApplied: 0,
          },
          attempts: [],
          retriable: "after-human-action",
          operatorAction:
            "Re-establish the session profile for this tenant, then re-invoke the capability.",
          observationRef: evidenceRefOf("obs", digestOf(null)),
        },
        run,
      }) as ReplayResultDocument;
  }
}

/** The one ending, as the journal records it. */
function finishedFields(result: RunResult): {
  readonly status: "ok" | "outcome" | "suspended" | "failed";
  readonly failureClass?: RunResultFailed["failure"];
  readonly outcomeCode?: string;
} {
  switch (result.kind) {
    case "ok":
      return { status: "ok" };
    case "outcome":
      return { status: "outcome", outcomeCode: result.code };
    case "suspended":
      return { status: "suspended" };
    case "failed":
      return { status: "failed", failureClass: result.failure };
    case "restart":
      // The supervisor only leaves the loop on a restart it could not service.
      return { status: "failed", failureClass: "session-expired-unrecoverable" };
  }
}

function bagOf(
  outputs: readonly { readonly output: string; readonly value: unknown }[],
): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  for (const output of outputs) bag[output.output] = output.value;
  return bag;
}

// ---------------------------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------------------------

function buildEnvelope(args: {
  readonly runId: string;
  readonly program: LinkedProgram;
  readonly options: ReplayOptions;
  readonly run: InterpreterRun;
  readonly ledger: RunLedger;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly surfaceKind: SurfaceKind;
  readonly evidence: EvidenceSink;
  readonly journalRef: EvidenceRef;
}): RunEnvelope {
  const { program, run } = args;
  return RunEnvelopeSchema.parse({
    runId: args.runId,
    capability: { name: program.contract.name, version: program.contract.version },
    artifact: {
      artifactId: program.artifact.artifactId,
      version: program.artifact.version,
      digest: program.artifact.digest,
      overlayDigest: program.overlay?.digest ?? null,
      effectiveDigest: program.effectiveDigest,
    },
    tenant: args.options.tenant,
    surface: args.surfaceKind,
    engineVersion: ENGINE_VERSION,
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    durationMs: Math.max(0, Date.parse(args.endedAt) - Date.parse(args.startedAt)),
    stepsExecuted: run.stepsExecuted,
    stepsTotal: program.steps.length,
    budgets: args.ledger.view(),
    recoveriesApplied: run.recoveriesApplied,
    attribution: { by: run.attribution, transfers: run.transfers },
    steps: run.steps,
    drift: driftOf(program, run.steps),
    evidence: args.evidence.refs(),
    journalRef: args.journalRef,
    warnings: run.warnings,
  }) as RunEnvelope;
}

/**
 * Drift, computed against the fingerprint the ARTIFACT recorded, and reported on every arm
 * including `ok`.
 *
 * SPEC section 5.5: drift is a signal on success, never a verdict. A descriptor that has started
 * abstaining still resolves the target under quorum today and will not tomorrow, and this is the
 * only place that shows up before it becomes an incident.
 *
 * The baseline: at record time every declared descriptor of a target resolved to the node the
 * recorder saw - that is what synthesis guarantees and what the linker's quorum check re-verifies -
 * so `was` is `resolved` for every row. `now` is what this run saw. A row that disagrees is real
 * evidence; the count of them is the divergence.
 *
 * NO THRESHOLD SHIPS. `needsSpecialization` is always false and stays false until the number has
 * been measured against the conformance corpus (OPEN-QUESTIONS-RESOLVED Q4). Inventing one and
 * defending it in a write-up is exactly the unearned precision this project does not do.
 */
function driftOf(program: LinkedProgram, steps: readonly StepTrace[]): DriftSignal {
  const changed: DriftSignal["changed"][number][] = [];
  let rows = 0;

  for (const trace of steps) {
    for (const row of trace.resolution ?? []) {
      rows += 1;
      if (row.verdict === "resolved") continue;
      changed.push({
        stepId: trace.stepId,
        descriptorId: row.descriptorId,
        was: "resolved",
        now: row.verdict,
      } as DriftSignal["changed"][number]);
    }
  }

  const recorded = program.merged.provenance.recordedAgainst.fingerprint.perStep;
  const observed: Record<string, string> = {};
  for (const step of program.steps) {
    if (step.target === null) continue;
    const trace = steps.find((t) => t.stepId === step.id);
    const rowsHere = trace?.resolution ?? [];
    observed[step.id] = rowsHere.map((r) => `${r.descriptorId}:${r.verdict}`).join(",");
  }

  return {
    fingerprint: digestOf(observed).slice(0, 71),
    expected: digestOf(recorded).slice(0, 71),
    divergence: rows === 0 ? 0 : Number((changed.length / rows).toFixed(4)),
    changed: changed.slice(0, 256),
    needsSpecialization: false,
  } as DriftSignal;
}

/**
 * Whether two recorded and resolved fingerprints describe the same node.
 *
 * Re-exported through here rather than used inline so the comparison stays the resolver's, and so
 * the day this report grows a per-step "the node moved" row it is not a second definition of what
 * "the same node" means.
 */
export const sameNode = fingerprintsEqual;

// ---------------------------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------------------------

function preFlightResult(args: {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly options: ReplayOptions;
  readonly errors: readonly LinkError[];
  readonly journal: Journal;
  readonly evidence: EvidenceSink;
}): ReplayResultDocument {
  const failure = failureClassOf(args.errors);
  const verdict = preFlightVerdict(
    failure,
    args.errors.map((e) => `check ${e.check}: ${e.message}`).join("; ") ||
      "the documents did not link",
  );
  if (verdict.kind !== "fail") throw new Error("a pre-flight verdict is always a failure");
  const journalRef = args.evidence.putJson("journal", args.journal.events);

  // `sideEffects: "none-guaranteed"` is a FACT here, not a hope: the decision was made before
  // `perceive()` was called, before a session was brokered, and before the surface existed.
  return ReplayResultSchema.parse({
    status: "failed",
    failure: {
      class: failure,
      atStep: null,
      stepIndex: null,
      sideEffects: "none-guaranteed",
      expected: verdict.detail.expected,
      observed: verdict.detail.observed,
      attempts: [],
      retriable: verdict.detail.retriable,
      operatorAction: verdict.detail.operatorAction,
      observationRef: evidenceRefOf("obs", digestOf(null)),
    },
    run: RunEnvelopeSchema.parse({
      runId: args.runId,
      capability: {
        name: args.options.contract.name,
        version: args.options.contract.version,
      },
      artifact: {
        artifactId: args.options.artifact.artifactId,
        version: args.options.artifact.version,
        digest: args.options.artifact.digest,
        overlayDigest: args.options.overlay?.digest ?? null,
        effectiveDigest: args.options.artifact.digest,
      },
      tenant: args.options.tenant,
      surface: args.options.artifact.target.surfaceKind,
      engineVersion: ENGINE_VERSION,
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      durationMs: Math.max(0, Date.parse(args.endedAt) - Date.parse(args.startedAt)),
      stepsExecuted: 0,
      stepsTotal: 0,
      budgets: {
        actions: { used: 0, limit: args.options.artifact.budgets.maxActions },
        observations: { used: 0, limit: args.options.artifact.budgets.maxObservations },
        remediations: { used: 0, limit: args.options.artifact.budgets.maxTotalRemediations },
        programAttempts: { used: 0, limit: args.options.artifact.budgets.maxProgramAttempts },
        wallClockMs: { used: 0, limit: args.options.artifact.budgets.deadlineMs },
      },
      recoveriesApplied: [],
      attribution: { by: "automation", transfers: [] },
      steps: [],
      drift: {
        fingerprint: "fp:not-run",
        expected: "fp:not-run",
        divergence: 0,
        changed: [],
        needsSpecialization: false,
      },
      evidence: args.evidence.refs(),
      journalRef,
      warnings: [],
    }),
  }) as ReplayResultDocument;
}

/**
 * What the linker is told the surface can do, before a session exists.
 *
 * `capabilities()` is synchronous and is a DESCRIPTION rather than a probe, which is exactly what
 * makes a load-time refusal possible: the linker can say "this program needs a `table-cell`
 * descriptor and this surface cannot resolve one" before a browser is launched. Getting it out of
 * the broker requires opening a session, which is the one asymmetry - so the session is opened
 * once and the linker is handed the description.
 */
async function peekCapabilities(
  broker: SessionBroker,
  tenant: { readonly tenantId: string; readonly appInstanceId: string },
) {
  const session = await broker.open("__capabilities__", tenantRef(tenant));
  return session.surface.capabilities();
}

/** The branded `TenantId` the port takes. Branding is checked at the document boundary, not here:
 *  a tenant id that reaches this function has already come off a validated invocation. */
function tenantRef(tenant: {
  readonly tenantId: string;
  readonly appInstanceId: string;
}): TenantRef {
  return {
    tenantId: tenant.tenantId as TenantRef["tenantId"],
    appInstanceId: tenant.appInstanceId,
  };
}

/**
 * The artifact's budgets, narrowed by the caller's - never widened.
 *
 * Written as a fold over the two ledgers the invocation can speak about rather than a spread, so a
 * caller supplying `wallClockMs: 600_000` against a 60-second artifact gets 60 seconds and not ten
 * minutes. The other three ledgers have no invocation-level counterpart and are passed through.
 */
function tightened(
  budgets: CapabilityArtifact["budgets"],
  ceiling: ReplayOptions["budgetCeiling"],
): CapabilityArtifact["budgets"] {
  if (ceiling === undefined || ceiling === null) return budgets;
  return {
    ...budgets,
    deadlineMs:
      ceiling.wallClockMs === undefined
        ? budgets.deadlineMs
        : Math.min(budgets.deadlineMs, ceiling.wallClockMs),
    maxTotalRemediations:
      ceiling.maxRemediations === undefined
        ? budgets.maxTotalRemediations
        : Math.min(budgets.maxTotalRemediations, ceiling.maxRemediations),
  };
}

/** `{ memberId: "digits(5)" }` and never `{ memberId: "10041" }`. */
function shapeOf(args: Readonly<Record<string, unknown>>): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      shape[key] = /^\d+$/.test(value) ? `digits(${value.length})` : `string(${value.length})`;
      continue;
    }
    shape[key] = typeof value;
  }
  return shape;
}

export type { Digest };
