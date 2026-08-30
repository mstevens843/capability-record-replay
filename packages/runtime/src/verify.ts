// Verification replay (SPEC section 6.6) - the step that turns a recording into a claim.
//
// BRIEF section 3.4 asks for this in one line: after a discovery run the system immediately replays
// its own artifact with the model out of the loop, and only saves it as `draft` if that succeeds.
// SPEC section 12.2 then AMENDS that line, and the amendment is the whole reason this file has
// three modes instead of one:
//
//   > The verification replay runs against a surface the discovery run just mutated. For a read
//   > capability that is fine. For `corebank.member.open-subaccount`, verification OPENS A SECOND
//   > SUB-ACCOUNT - the mechanism that proves the artifact is faithful is itself an unapproved,
//   > unattended, duplicated irreversible write against a bank system, which is the thing the safety
//   > model exists to prevent.
//
// So:
//
//   | mode           | what runs                                     | grade                        |
//   | replay-full    | the whole flow; the run's maxEffect is READ   | full                         |
//   | replay-dry     | up to the first irreversible step, then       | partial-up-to-irreversible   |
//   |                | everything except the dispatch                |                              |
//   | replay-reset   | the whole flow, then the environment's reset  | full                         |
//   | (none)         | nothing                                       | stays `proposed`, for ever   |
//
// The GRADE is not a decoration and it is not derived from the mode. It is derived from what the
// run actually covered, so a `replay-dry` against a flow with no irreversible step in it grades
// `full` (nothing was withheld) and a `replay-full` that stopped early does not exist, because a
// run that did not reach the end does not verify anything. An approver has to tick the grade before
// the artifact can be approved (`lifecycle.ts`), because `partial-up-to-irreversible` is a
// DIFFERENT CLAIM from `full` and flattening the two into a boolean `verified` would hide exactly
// the risk the approval gate exists to weigh. SPEC section 12.3's twelfth accepted limit says the
// quiet part out loud: if an approver treats the partial grade as "verified", this whole fix is
// decorative.

import type {
  CapabilityArtifact,
  CapabilityContract,
  CapabilityOverlay,
  ReplayResultDocument,
  RunId,
  StepId,
  Timestamp,
  Verification,
} from "@crr/core";
import { VerificationSchema } from "@crr/core";
import type { ApprovalGrant, InvocationApprovalGrant } from "./approval.js";
import type { Clock } from "./clock.js";
import type { EvidenceSink } from "./evidence.js";
import type { IdSource } from "./ids.js";
import type { DryRunBoundaryReport, DryRunPolicy } from "./interpreter.js";
import type { Journal } from "./journal.js";
import { LifecycleError, recordVerification } from "./lifecycle.js";
import { type ReplayOptions, replay } from "./replay.js";
import type { SessionBroker } from "./session.js";

export type VerificationMode = Verification["mode"];
export type VerificationGrade = Verification["grade"];
export type ResetOutcome = "reset" | "unavailable";

/**
 * An environment that can be put back the way it was.
 *
 * OUR FIXTURE HAS ONE AND REAL CORE BANKING DOES NOT, and that asymmetry is the honest operational
 * cost of the whole design rather than a gap in it: a write capability needs a resettable
 * environment to reach a `full` grade, and an institution that cannot provide one gets
 * `partial-up-to-irreversible` and an approver who has to read it. Naming that is worth more than
 * pretending a dry run and a reset run make the same claim.
 *
 * `unavailable` is a first-class answer rather than an exception, because "the reset endpoint is
 * not enabled on this instance" is an ordinary fact about a tenant and the right response is to
 * report an unverified artifact, not to crash a discovery run.
 */
export interface EnvironmentReset {
  /** Recorded in the report so the evidence says WHICH reset was used. */
  readonly id: string;
  reset(tenant: {
    readonly tenantId: string;
    readonly appInstanceId: string;
  }): Promise<ResetOutcome>;
}

export interface VerifyOptions {
  readonly contract: CapabilityContract;
  /** The `proposed` document synthesis just emitted. Unapproved, by definition. */
  readonly artifact: CapabilityArtifact;
  readonly overlay?: CapabilityOverlay | null;
  /** The same arguments the discovery run was given, so the replay retraces the same path. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly tenant: { readonly tenantId: string; readonly appInstanceId: string };
  readonly allowlist: ReplayOptions["allowlist"];
  readonly broker: SessionBroker;
  /** Present only for `replay-reset`. Its absence is what makes `replay-dry` the default for a
   *  write flow. */
  readonly reset?: EnvironmentReset | null;
  /**
   * Forced mode. Omitted, the mode is chosen by `chooseVerificationMode`, which honours the plan
   * synthesis already wrote into `artifact.verification.mode`.
   */
  readonly mode?: VerificationMode;
  /**
   * The dry boundary. Defaults to `WRITE_IRREVERSIBLE`, which is SPEC section 6.6's literal
   * reading; a deployment may tighten it to `WRITE_REVERSIBLE`.
   */
  readonly stopBeforeEffect?: DryRunPolicy["stopBeforeEffect"];
  /** Required only when a `replay-reset` run will really dispatch an irreversible action: policy
   *  rule 8 is uniform across modes and a token is a human's explicit act. */
  readonly approval?: ApprovalGrant | null;
  readonly invocationApproval?: InvocationApprovalGrant | null;
  readonly approvalPolicyVersion?: string;
  readonly idempotencyKey?: string | null;
  readonly clock?: Clock;
  readonly ids?: IdSource;
  readonly journal?: ReplayOptions["journal"];
  readonly evidence?: EvidenceSink;
  readonly actorId?: string;
  readonly perceiveDeadlineMs?: number;
}

export interface VerificationReport {
  readonly mode: VerificationMode;
  readonly status: "verified" | "unverified";
  /** `null` when unverified: there is no grade for a claim that was not established. */
  readonly grade: VerificationGrade | null;
  readonly coveredThroughStep: StepId | null;
  /** `replay-dry` only: the step the run refused to perform. */
  readonly stoppedBeforeStep: StepId | null;
  /** `replay-dry` only: the concrete write boundary report the interpreter emitted. */
  readonly dryBoundary: DryRunBoundaryReport | null;
  /** Prose for a human. On an unverified report this is the whole point of the report. */
  readonly reason: string;
  /** `null` only when the replay could not be attempted at all - see `reset`. */
  readonly result: ReplayResultDocument | null;
  readonly journal: Journal | null;
  readonly evidence: EvidenceSink | null;
  readonly reset: {
    readonly id: string;
    readonly before: ResetOutcome;
    readonly after: ResetOutcome | null;
  } | null;
  /** The record `recordVerification` stamps onto the artifact. `null` unless verified. */
  readonly verification: Verification | null;
}

/**
 * Which mode this artifact should be verified in.
 *
 * DERIVED FROM THE EFFECT SUMMARY, not read out of `artifact.verification.mode`. Synthesis writes a
 * plan into that field and this reaches the same answer for every document it emits, so the
 * duplication buys something specific: a mode read out of the document is a mode the document's
 * AUTHOR chose, and a hand-edited artifact asking to be verified by `replay-full` while declaring a
 * `WRITE_IRREVERSIBLE` step is asking this system to perform an unapproved, unattended write. The
 * effect summary is re-derived by the schema and re-derived again by linker check 13, so deriving
 * from it is deriving from the one field in the document that is checked rather than believed.
 *
 * The one thing synthesis could not know is whether the environment exposes a reset, which is why
 * that is an argument: with one, a write capability can be verified end to end and graded `full`;
 * without one, `replay-dry` and a grade that says so.
 */
export function chooseVerificationMode(
  artifact: CapabilityArtifact,
  options: { readonly reset: boolean },
): VerificationMode {
  if (artifact.effects.maxEffect === "READ") return "replay-full";
  return options.reset ? "replay-reset" : "replay-dry";
}

/**
 * Replay the artifact with the model out of the loop, and report what that establishes.
 *
 * This never mutates the artifact. Promoting it to `draft` is `recordVerification`'s job and
 * `verifyAndDraft` below is the two of them wired together - separated because the report is worth
 * having on the failure path too, and a function that returns `null` for "it did not verify" throws
 * away the reason it did not.
 */
export async function verifyArtifact(options: VerifyOptions): Promise<VerificationReport> {
  const artifact = options.artifact;
  const hasReset = options.reset !== undefined && options.reset !== null;
  const mode = options.mode ?? chooseVerificationMode(artifact, { reset: hasReset });

  // Refused loudly and BEFORE anything is opened, because both of these are a caller asking for a
  // claim the inputs cannot support - not an outcome a run could have had.
  if (mode === "replay-full" && artifact.effects.maxEffect !== "READ") {
    throw new LifecycleError("this artifact cannot be verified by replay-full", [
      `its maximum effect is ${artifact.effects.maxEffect}, so replaying the whole flow would perform the write a second time - use replay-dry, or supply a reset`,
    ]);
  }
  if (mode === "replay-reset" && !hasReset) {
    throw new LifecycleError("this artifact cannot be verified by replay-reset", [
      "replay-reset runs the whole flow and then puts the environment back; no reset hook was supplied",
    ]);
  }

  // ---- the reset, before -------------------------------------------------------------------
  //
  // Before as well as after. The discovery run left the environment mutated, and a verification
  // that starts from that state is verifying the artifact against a screen the recording never saw:
  // the member already has the sub-account, so the confirmation the checkpoint expects never
  // appears. Resetting first is what makes `replay-reset` a re-run rather than a second run.
  let resetState: VerificationReport["reset"] = null;
  if (mode === "replay-reset" && options.reset != null) {
    const before = await options.reset.reset(options.tenant);
    resetState = { id: options.reset.id, before, after: null };
    if (before === "unavailable") {
      return {
        mode,
        status: "unverified",
        grade: null,
        coveredThroughStep: null,
        stoppedBeforeStep: null,
        dryBoundary: null,
        reason: `the environment reset "${options.reset.id}" reported itself unavailable, so the flow could not be replayed from the state the recording started in; verify with replay-dry instead`,
        result: null,
        journal: null,
        evidence: null,
        reset: resetState,
        verification: null,
      };
    }
  }

  const dryRun: DryRunPolicy | null =
    mode === "replay-dry"
      ? { stopBeforeEffect: options.stopBeforeEffect ?? "WRITE_IRREVERSIBLE" }
      : null;

  const output = await replay({
    contract: options.contract,
    artifact,
    overlay: options.overlay ?? null,
    args: options.args,
    tenant: options.tenant,
    allowlist: options.allowlist,
    broker: options.broker,
    // A verification replay presents no trust store and needs none: check 27 is skipped in
    // `verification` mode, because requiring an approved artifact to produce the verification that
    // an approval is granted on the strength of would make the lifecycle's first step unreachable.
    trust: { trustedKeyIds: [], verifySignature: () => false },
    mode: "verification",
    approval: options.approval ?? null,
    invocationApproval: options.invocationApproval ?? null,
    ...(options.approvalPolicyVersion === undefined
      ? {}
      : { approvalPolicyVersion: options.approvalPolicyVersion }),
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    dryRun,
    // A verification replay has nobody to escalate to. It runs unattended, immediately after
    // discovery, and a suspension would park a live session waiting for an operator who was never
    // told to expect one.
    onIntervention: "fail",
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.ids === undefined ? {} : { ids: options.ids }),
    ...(options.journal === undefined ? {} : { journal: options.journal }),
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
    ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
    ...(options.perceiveDeadlineMs === undefined
      ? {}
      : { perceiveDeadlineMs: options.perceiveDeadlineMs }),
  });

  if (resetState !== null && options.reset != null) {
    // AFTER the run, and its failure does not change the grade. The flow was replayed end to end,
    // which is what `full` claims; an environment left dirty is an operational problem for the
    // person reading the report, and saying so is more use than downgrading a claim that is true.
    resetState = { ...resetState, after: await options.reset.reset(options.tenant) };
  }

  const graded = gradeVerification(artifact, output.result, output.dryStoppedAt);
  const runId = output.result.run.runId as RunId;
  const at = output.result.run.endedAt as Timestamp;

  const verification =
    graded.grade === null || graded.coveredThroughStep === null
      ? null
      : (VerificationSchema.parse({
          mode,
          status: "verified",
          coveredThroughStep: graded.coveredThroughStep,
          grade: graded.grade,
          runId,
          at,
        }) as Verification);

  return {
    mode,
    status: verification === null ? "unverified" : "verified",
    grade: graded.grade,
    coveredThroughStep: graded.coveredThroughStep,
    stoppedBeforeStep: graded.stoppedBeforeStep,
    dryBoundary: output.dryBoundary,
    reason: graded.reason,
    result: output.result,
    journal: output.journal,
    evidence: output.evidence,
    reset: resetState,
    verification,
  };
}

/**
 * The BRIEF section 3.4 operation, end to end: replay, and save as `draft` only if that succeeded.
 *
 * `artifact` is `null` on the failure path rather than the proposed document being handed back
 * promoted-anyway, which is the entire content of "only saves it as draft if that succeeds".
 */
export async function verifyAndDraft(options: VerifyOptions): Promise<{
  readonly report: VerificationReport;
  readonly artifact: CapabilityArtifact | null;
}> {
  const report = await verifyArtifact(options);
  if (report.verification === null) return { report, artifact: null };
  return { report, artifact: recordVerification(options.artifact, report.verification) };
}

// ---------------------------------------------------------------------------------------------
// The grade
// ---------------------------------------------------------------------------------------------

export interface VerificationGrading {
  readonly grade: VerificationGrade | null;
  readonly coveredThroughStep: StepId | null;
  readonly stoppedBeforeStep: StepId | null;
  readonly reason: string;
}

/**
 * What the run established, read off the run rather than off the mode.
 *
 * Exported, and a pure function of three values, because "what does this run entitle you to claim"
 * is the single question the whole amendment turns on and it should be answerable without opening
 * a session. The conformance suite grades engines by exactly this kind of question.
 *
 * FAIL CLOSED, and note which arms that closes over. `outcome` is the interesting one: a
 * verification replay that returns `MEMBER_NOT_FOUND` did not fail - the classifier did its job and
 * the answer is a legitimate business result - but it did not verify the artifact either, because
 * the discovery run FOUND that member and this run took a different path through the flow. Treating
 * it as a pass would mean shipping an artifact whose happy path has never once been replayed.
 * `suspended` is the same argument with a human attached.
 */
export function gradeVerification(
  artifact: CapabilityArtifact,
  result: ReplayResultDocument,
  dryStoppedAt: { readonly stepId: string; readonly stepIndex: number } | null,
): VerificationGrading {
  const steps = artifact.flow.steps;
  const last = steps[steps.length - 1];
  if (last === undefined) {
    return {
      grade: null,
      coveredThroughStep: null,
      stoppedBeforeStep: null,
      reason: "the flow has no steps, so there is nothing a replay could have verified",
    };
  }

  if (result.status !== "ok") {
    return {
      grade: null,
      coveredThroughStep: null,
      stoppedBeforeStep: null,
      reason: unverifiedReasonOf(result),
    };
  }

  if (dryStoppedAt === null) {
    return {
      grade: "full",
      coveredThroughStep: last.id,
      stoppedBeforeStep: null,
      reason: `the whole flow replayed with the model out of the loop, through step ${last.id}`,
    };
  }

  const boundary = steps[dryStoppedAt.stepIndex];
  const covered = steps[dryStoppedAt.stepIndex - 1];
  if (covered === undefined || boundary === undefined) {
    // The first step is the irreversible one. A dry run then verifies nothing at all - there is no
    // prior step whose locators, checkpoint and parameter binding it exercised - and claiming
    // `partial-up-to-irreversible` for it would be claiming coverage of an empty set.
    return {
      grade: null,
      coveredThroughStep: null,
      stoppedBeforeStep: (boundary?.id ?? last.id) as StepId,
      reason:
        "the flow's first step is the irreversible one, so a dry run covers nothing; this artifact needs a resettable environment to be verified at all",
    };
  }

  return {
    grade: "partial-up-to-irreversible",
    coveredThroughStep: covered.id,
    stoppedBeforeStep: boundary.id,
    reason: `every step through ${covered.id} replayed; at ${boundary.id} (${boundary.effect}) the descriptors resolved under quorum and the instruction lowered, and the action was deliberately not dispatched`,
  };
}

function unverifiedReasonOf(result: ReplayResultDocument): string {
  switch (result.status) {
    case "outcome":
      return `the replay returned the business outcome ${result.outcome} at step ${result.detectedAt.stepId}; the recording reached the end of the flow, so the surface no longer holds the state it was recorded against`;
    case "suspended":
      return `the replay suspended at step ${result.intervention.atStep} (${result.intervention.reason}); a verification replay runs unattended and has nobody to hand control to`;
    case "failed":
      return `the replay failed ${result.failure.class}${result.failure.atStep === null ? " before the surface was touched" : ` at step ${result.failure.atStep}`}: ${result.failure.expected.rendered}`;
    default:
      return "the replay did not complete";
  }
}
