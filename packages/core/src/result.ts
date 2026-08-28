// SPEC sections 2.6 and 2.7 - the load-bearing agent-facing type, in two forms.
//
// This file is deliberately half zod and half hand-written generics, and the split is the design.
//
//   · The GENERIC types are how a calling PROGRAM sees a result: `switch (r.status)` gives four
//     arms, and inside the `outcome` arm `switch (r.outcome)` narrows `r.data` to that outcome's
//     own payload. Adding an `OutcomeDecl` to a contract then becomes a compile error at every
//     existing call site, which is correct - a new possible answer IS a breaking change for the
//     caller. None of that is expressible in a runtime validator, because it is a statement about
//     literal types that only exist after codegen.
//   · The SCHEMAS are how a result is written to a journal, read back by the conformance suite, and
//     validated at the host boundary. They erase the generic parameter and validate the shape.
//
// The one rule both halves obey: `invoke` NEVER REJECTS. No thrown outcome, no thrown failure, no
// thrown validation error - a rejected promise from `invoke` is a bug in the host. The caller is
// frequently an LLM harness, and a thrown exception at a tool boundary is a crash the model cannot
// see, cannot reason about, and cannot report honestly to a member.

import { z } from "zod";
import type { CapabilityContract, FieldSpec, OutcomeDecl } from "./contract.js";
import {
  DescriptorKindSchema,
  DescriptorVerdictSchema,
  EvidenceSourceSchema,
} from "./descriptor-kinds.js";
import {
  DriftSignalSchema,
  ExpectationTraceSchema,
  ExtractedValueSchema,
  FailureClassSchema,
  ObservedSummarySchema,
  RetriableSchema,
  RunWarningSchema,
  SideEffectsSchema,
  SuspensionReasonSchema,
  TargetCandidateSchema,
  VerdictSchema,
} from "./diagnostics.js";
import {
  AppInstanceIdSchema,
  type ApprovalTokenSchema,
  ArtifactIdSchema,
  CapabilityNameSchema,
  ContractVersionSchema,
  type Decimal,
  type DeepReadonly,
  DigestSchema,
  EvidenceRefSchema,
  InterventionIdSchema,
  LeaseTokenSchema,
  type Money,
  NodeIdSchema,
  RunIdSchema,
  StepIdSchema,
  SurfaceKindSchema,
  TenantIdSchema,
  TimestampSchema,
  type ValueType,
} from "./primitives.js";
import type { SchemaIdentity } from "./schema-identity.js";
import { ControlTransferSchema } from "./session.js";

// ---------------------------------------------------------------------------------------------
// The type mappers (SPEC section 2.6)
//
// `pnpm codegen` emits, per approved contract, a `.d.ts` declaring the contract `as const` plus its
// digest, so these resolve to literal types at the call site. The digest pin in `Invocation` is
// what makes the mechanism fail LOUDLY rather than silently when that generated file is stale.
// ---------------------------------------------------------------------------------------------

export type TsTypeOf<T extends ValueType> = T extends { kind: "string" }
  ? string
  : T extends { kind: "integer" }
    ? number
    : T extends { kind: "boolean" }
      ? boolean
      : T extends { kind: "enum"; values: readonly (infer V)[] }
        ? V
        : T extends { kind: "money" }
          ? Money
          : T extends { kind: "decimal" }
            ? Decimal
            : T extends { kind: "date" }
              ? string
              : T extends { kind: "table" }
                ? readonly Readonly<Record<string, string>>[]
                : never;

export type FieldsOf<S extends readonly FieldSpec[]> = {
  readonly [F in S[number] as F["name"]]: F["required"] extends true
    ? TsTypeOf<F["type"]>
    : TsTypeOf<F["type"]> | null;
};

export type ArgsOf<C extends CapabilityContract> = FieldsOf<C["inputs"]>;
export type OutputsOf<C extends CapabilityContract> = FieldsOf<C["outputs"]>;

// ---------------------------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------------------------

export interface Invocation<C extends CapabilityContract> {
  /**
   * An exact pin, INCLUDING the contract digest the caller's generated types were built from.
   *
   * This closes the one silent-degradation hole in the typed-outcome mechanism. If the generated
   * declaration is stale, or the contract's `outcomes` widened to `readonly OutcomeDecl[]` instead
   * of a literal tuple, the exhaustive switch quietly decays into a string comparison and the host
   * can hand a caller an outcome its types have never heard of. Comparing the digest turns that
   * into `failed / contract-stale` at exactly the moment the type-level mechanism would otherwise
   * fail without a sound.
   */
  readonly capability: {
    readonly name: C["name"];
    readonly version: ContractVersion;
    readonly contractDigest: Digest;
  };
  readonly tenant: { readonly tenantId: TenantId; readonly appInstanceId: AppInstanceId };
  readonly args: ArgsOf<C>;

  /** A caller-supplied dedupe key. The host returns the PRIOR RESULT for a repeat key rather than
   *  re-driving the UI, because retries at the agent layer are inevitable and a retried write
   *  against a legacy screen is how a member gets two sub-accounts. */
  readonly idempotencyKey?: string;

  /**
   * What THIS caller can tolerate when the run gets stuck. A batch job says "fail" and goes home; a
   * live conversational turn says "suspend" and picks the run back up. The engine must not guess
   * it, because the right answer depends entirely on who is waiting.
   */
  readonly onIntervention: "suspend" | "fail";

  readonly budget?: { readonly wallClockMs: number; readonly maxRemediations: number };
  readonly correlation: {
    readonly agentSessionId: string;
    readonly requestedBy: "agent" | "human" | "schedule";
  };
}

/** The approval token is required BY THE TYPE when the capability is irreversible, and forbidden
 *  when it is not. You cannot forget it, and you cannot smuggle one onto a read to look important. */
export type WithApproval<C extends CapabilityContract> = C["requiresApproval"] extends true
  ? Invocation<C> & { readonly approval: ApprovalToken }
  : Invocation<C> & { readonly approval?: never };

type ContractVersion = z.infer<typeof ContractVersionSchema>;
type Digest = z.infer<typeof DigestSchema>;
type TenantId = z.infer<typeof TenantIdSchema>;
type AppInstanceId = z.infer<typeof AppInstanceIdSchema>;
type ApprovalToken = z.infer<typeof ApprovalTokenSchema>;

// ---------------------------------------------------------------------------------------------
// The run envelope
// ---------------------------------------------------------------------------------------------

const stepTraceSchemaImpl = z.strictObject({
  stepId: StepIdSchema,
  attempt: z.int().positive(),
  /** The classifier's own output, verbatim. Not a summary of it: a summary is a second opinion. */
  verdict: VerdictSchema,
  skeletonDigest: z.string().min(1).max(128),
  observationRef: EvidenceRefSchema.nullable(),
  elapsedMs: z.int().nonnegative(),
  /** Which descriptors resolved to what, and by which evidence source. PRESENT EVEN ON SUCCESS -
   *  a silently degrading descriptor is only visible here, and only before it becomes an incident. */
  resolution: z
    .array(
      z.strictObject({
        descriptorId: z.string().max(64),
        kind: DescriptorKindSchema,
        evidenceSource: EvidenceSourceSchema,
        verdict: DescriptorVerdictSchema,
        resolvedNodeId: NodeIdSchema.nullable(),
      }),
    )
    .max(32)
    .readonly()
    .optional(),
});
export interface StepTraceSchemaType extends SchemaIdentity<typeof stepTraceSchemaImpl> {}
export const StepTraceSchema: StepTraceSchemaType = stepTraceSchemaImpl;

export type StepTrace = DeepReadonly<z.infer<typeof StepTraceSchema>>;

const BudgetLedgerSchema = z.strictObject({
  used: z.int().nonnegative(),
  limit: z.int().nonnegative(),
});

const runEnvelopeSchemaImpl = z.strictObject({
  runId: RunIdSchema,
  capability: z.strictObject({ name: CapabilityNameSchema, version: ContractVersionSchema }),
  artifact: z.strictObject({
    artifactId: ArtifactIdSchema,
    version: z.int().positive(),
    digest: DigestSchema,
    overlayDigest: DigestSchema.nullable(),
    /** Derived from the artifact digest, the overlay digest and the linker version. THIS, not the
     *  base digest, is what a postmortem needs: in a regulated environment "which bytes actually
     *  ran" must be answerable after the fact, and base-plus-overlay means the base alone does not
     *  answer it. */
    effectiveDigest: DigestSchema,
  }),
  tenant: z.strictObject({ tenantId: TenantIdSchema, appInstanceId: AppInstanceIdSchema }),
  surface: SurfaceKindSchema,
  engineVersion: z.string().min(1).max(64),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  durationMs: z.int().nonnegative(),
  stepsExecuted: z.int().nonnegative(),
  stepsTotal: z.int().nonnegative(),

  budgets: z.strictObject({
    actions: BudgetLedgerSchema,
    observations: BudgetLedgerSchema,
    remediations: BudgetLedgerSchema,
    programAttempts: BudgetLedgerSchema,
    wallClockMs: BudgetLedgerSchema,
  }),

  /** Every recovery that fired, whether or not it helped. Silent recoveries are how a system rots
   *  quietly: the interstitial that appears on 3% of runs today appears on 40% next quarter, and
   *  nobody notices because the runs still pass. */
  recoveriesApplied: z
    .array(
      z.strictObject({
        stepId: StepIdSchema,
        name: z.string().max(64),
        attempts: z.int().positive(),
        result: z.enum(["cleared", "exhausted"]),
      }),
    )
    .max(128)
    .readonly(),

  attribution: z.strictObject({
    by: z.enum(["automation", "human-assisted"]),
    transfers: z.array(ControlTransferSchema).max(32).readonly(),
  }),

  /** One entry per step ATTEMPT, including retried attempts. */
  steps: z.array(StepTraceSchema).max(512).readonly(),

  /** Present on EVERY arm including `ok`. Drift is a signal, never a verdict. */
  drift: DriftSignalSchema,

  evidence: z.array(EvidenceRefSchema).max(128).readonly(),
  journalRef: EvidenceRefSchema,
  warnings: z.array(RunWarningSchema).max(64).readonly(),
});
/**
 * Carried IDENTICALLY by all four arms.
 *
 * The temptation is to make failures verbose and successes terse. But the run you most want a trace
 * for is the one that returned `ok` and should not have, and a descriptor that has quietly started
 * abstaining shows up in `steps[].resolution` on a green run months before it shows up as a
 * failure.
 */
export interface RunEnvelopeSchemaType extends SchemaIdentity<typeof runEnvelopeSchemaImpl> {}
export const RunEnvelopeSchema: RunEnvelopeSchemaType = runEnvelopeSchemaImpl;

export type RunEnvelope = DeepReadonly<z.infer<typeof RunEnvelopeSchema>>;

// ---------------------------------------------------------------------------------------------
// The four arms, as generics for a caller
// ---------------------------------------------------------------------------------------------

export interface ReplayOk<C extends CapabilityContract> {
  readonly status: "ok";
  /**
   * TOTAL, or it is not `ok`.
   *
   * There is no partial success: a run that reached its checkpoint but could not extract a required
   * output is `failed / output-extraction-failed`. A caller that receives `ok` must be able to use
   * the outputs without checking each one, or the type has bought nothing.
   */
  readonly outputs: OutputsOf<C>;
  readonly run: RunEnvelope;
}

/**
 * A DECLARED business outcome, distributive over the contract's outcome tuple so that
 * `switch (r.outcome)` narrows `r.data` to that outcome's own payload.
 *
 * Four properties, each of which had to be true before this counted as "not an error":
 *   · it is a different ARM of the union than `failed`, with a different discriminant;
 *   · there is no `error` field anywhere on it to read;
 *   · the engine reaches it by a RETURN, never a throw, so no catch block can ever observe it;
 *   · its code is a literal type from the contract, so the switch is exhaustive.
 */
export type ReplayOutcomeArm<C extends CapabilityContract> = C["outcomes"][number] extends infer O
  ? O extends OutcomeDecl
    ? {
        readonly status: "outcome";
        readonly outcome: O["code"];
        readonly data: FieldsOf<O["payload"]>;
        readonly terminal: true;
        readonly callerAction: O["callerAction"];
        readonly retryable: O["retryable"];
        /** Copied verbatim from the reviewed declaration. The agent may quote it; it did not invent
         *  it, and it was not generated at render time. */
        readonly guidance: string;
        /** Which step produced it and which rule matched, so a WRONG outcome is debuggable. */
        readonly detectedAt: {
          readonly stepId: StepId;
          readonly stepIndex: number;
          readonly priority: number;
        };
        readonly alsoMatched: readonly {
          readonly code: string;
          readonly priority: number;
        }[];
        readonly run: RunEnvelope;
      }
    : never
  : never;

/** Automation stopped and a human was asked to take the live session. NOT TERMINAL - telling an
 *  agent `failed` about a run a human is forty seconds from finishing makes it apologise for
 *  something that is about to succeed. */
export interface ReplaySuspended<C extends CapabilityContract> {
  readonly status: "suspended";
  readonly intervention: {
    readonly id: InterventionId;
    readonly reason: SuspensionReason;
    readonly atStep: StepId;
    /** One sentence an operator can triage from without opening anything. */
    readonly summary: string;
    readonly consoleUrl: string;
    /** After this the lease expires and the run converts to `failed`. Sessions do not wait forever. */
    readonly expiresAt: Timestamp;
  };
  readonly resume: { readonly token: LeaseToken; readonly pollAfterMs: number };
  /** Everything already extracted and validated. Usually enough for the agent to say something TRUE
   *  - "I found your account, I'm checking the balance" - instead of something vague. */
  readonly partialOutputs: Partial<OutputsOf<C>>;
  readonly run: RunEnvelope;
}

export interface ReplayFailed {
  readonly status: "failed";
  readonly failure: {
    readonly class: FailureClass;
    readonly atStep: StepId | null;
    readonly stepIndex: number | null;
    readonly sideEffects: SideEffects;
    readonly expected: ExpectationTrace;
    readonly observed: ObservedSummary;
    readonly candidates?: readonly TargetCandidate[];
    readonly attempts: readonly {
      readonly recoveryId: string;
      readonly attempts: number;
      readonly lastSkeletonDigest: string;
    }[];
    readonly retriable: Retriable;
    readonly operatorAction: string;
    readonly escalation?: {
      readonly interventionId: InterventionId;
      readonly raisedAt: Timestamp;
      readonly state: "open" | "resolved" | "abandoned";
    };
    /** The frozen observation that produced this verdict, by reference. This is the file that turns
     *  a production failure into a `classify()` unit test with no reproduction step. */
    readonly observationRef: EvidenceRef;
  };
  readonly run: RunEnvelope;
}

export type ReplayResult<C extends CapabilityContract> =
  | ReplayOk<C>
  | ReplayOutcomeArm<C>
  | ReplaySuspended<C>
  | ReplayFailed;

type StepId = z.infer<typeof StepIdSchema>;
type InterventionId = z.infer<typeof InterventionIdSchema>;
type LeaseToken = z.infer<typeof LeaseTokenSchema>;
type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
type Timestamp = string;
type FailureClass = z.infer<typeof FailureClassSchema>;
type SuspensionReason = z.infer<typeof SuspensionReasonSchema>;
type SideEffects = z.infer<typeof SideEffectsSchema>;
type Retriable = z.infer<typeof RetriableSchema>;
type ExpectationTrace = DeepReadonly<z.infer<typeof ExpectationTraceSchema>>;
type ObservedSummary = DeepReadonly<z.infer<typeof ObservedSummarySchema>>;
type TargetCandidate = DeepReadonly<z.infer<typeof TargetCandidateSchema>>;

// ---------------------------------------------------------------------------------------------
// The same four arms, as schemas for a journal and a conformance corpus
// ---------------------------------------------------------------------------------------------

const OutputBagSchema = z.record(z.string().min(1).max(64), ExtractedValueSchema);

const replayOkResultSchemaImpl = z.strictObject({
  status: z.literal("ok"),
  outputs: OutputBagSchema,
  run: RunEnvelopeSchema,
});
export interface ReplayOkResultSchemaType extends SchemaIdentity<typeof replayOkResultSchemaImpl> {}
export const ReplayOkResultSchema: ReplayOkResultSchemaType = replayOkResultSchemaImpl;

const replayOutcomeResultSchemaImpl = z.strictObject({
  status: z.literal("outcome"),
  outcome: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .max(64),
  data: OutputBagSchema,
  terminal: z.literal(true),
  callerAction: z.enum(["inform-user", "retry-different-input", "refer-to-specialist"]),
  retryable: z.enum(["never", "after_delay", "with_different_inputs"]),
  guidance: z.string().min(1).max(2000),
  detectedAt: z.strictObject({
    stepId: StepIdSchema,
    stepIndex: z.int().nonnegative(),
    priority: z.int().nonnegative(),
  }),
  alsoMatched: z
    .array(z.strictObject({ code: z.string().max(64), priority: z.int().nonnegative() }))
    .max(16)
    .readonly(),
  run: RunEnvelopeSchema,
});
export interface ReplayOutcomeResultSchemaType
  extends SchemaIdentity<typeof replayOutcomeResultSchemaImpl> {}
export const ReplayOutcomeResultSchema: ReplayOutcomeResultSchemaType =
  replayOutcomeResultSchemaImpl;

const replaySuspendedResultSchemaImpl = z.strictObject({
  status: z.literal("suspended"),
  intervention: z.strictObject({
    id: InterventionIdSchema,
    reason: SuspensionReasonSchema,
    atStep: StepIdSchema,
    summary: z.string().min(1).max(500),
    consoleUrl: z.string().min(1).max(1024),
    expiresAt: TimestampSchema,
  }),
  resume: z.strictObject({
    token: LeaseTokenSchema,
    pollAfterMs: z.int().nonnegative(),
  }),
  partialOutputs: OutputBagSchema,
  run: RunEnvelopeSchema,
});
export interface ReplaySuspendedResultSchemaType
  extends SchemaIdentity<typeof replaySuspendedResultSchemaImpl> {}
export const ReplaySuspendedResultSchema: ReplaySuspendedResultSchemaType =
  replaySuspendedResultSchemaImpl;

const replayFailedResultSchemaImpl = z
  .strictObject({
    status: z.literal("failed"),
    failure: z.strictObject({
      class: FailureClassSchema,
      /** null for pre-flight, which is the case where zero actions were performed. */
      atStep: StepIdSchema.nullable(),
      stepIndex: z.int().nonnegative().nullable(),
      sideEffects: SideEffectsSchema,
      expected: ExpectationTraceSchema,
      observed: ObservedSummarySchema,
      candidates: z.array(TargetCandidateSchema).max(16).readonly().optional(),
      attempts: z
        .array(
          z.strictObject({
            recoveryId: z.string().max(64),
            attempts: z.int().nonnegative(),
            lastSkeletonDigest: z.string().max(128),
          }),
        )
        .max(32)
        .readonly(),
      retriable: RetriableSchema,
      operatorAction: z.string().min(1).max(500),
      escalation: z
        .strictObject({
          interventionId: InterventionIdSchema,
          raisedAt: TimestampSchema,
          state: z.enum(["open", "resolved", "abandoned"]),
        })
        .optional(),
      observationRef: EvidenceRefSchema,
    }),
    run: RunEnvelopeSchema,
  })
  .superRefine((r, ctx) => {
    // The one cross-field rule that is a safety property rather than a consistency one: an
    // irreversible action whose result was never observed must never be retried, and the arm that
    // carries that fact must not simultaneously invite a retry.
    if (r.failure.class === "effect-in-doubt") {
      if (r.failure.sideEffects !== "in-doubt") {
        ctx.addIssue("effect-in-doubt is exactly the case where side effects are in doubt");
      }
      if (r.failure.retriable !== "no") {
        ctx.addIssue(
          "effect-in-doubt is never retriable; retrying it is how a member is charged twice",
        );
      }
    }
    if (r.failure.atStep === null && r.failure.sideEffects !== "none-guaranteed") {
      ctx.addIssue(
        "a failure with no step is a pre-flight failure, and a pre-flight failure performed zero actions",
      );
    }
  });
export interface ReplayFailedResultSchemaType
  extends SchemaIdentity<typeof replayFailedResultSchemaImpl> {}
export const ReplayFailedResultSchema: ReplayFailedResultSchemaType = replayFailedResultSchemaImpl;

const replayResultSchemaImpl = z.discriminatedUnion("status", [
  ReplayOkResultSchema,
  ReplayOutcomeResultSchema,
  ReplaySuspendedResultSchema,
  ReplayFailedResultSchema,
]);
export interface ReplayResultSchemaType extends SchemaIdentity<typeof replayResultSchemaImpl> {}
export const ReplayResultSchema: ReplayResultSchemaType = replayResultSchemaImpl;

export type ReplayResultDocument = DeepReadonly<z.infer<typeof ReplayResultSchema>>;

// ---------------------------------------------------------------------------------------------
// SPEC section 2.7 - the agent-facing projection
// ---------------------------------------------------------------------------------------------

/**
 * `ReplayResult` is for a PROGRAM. A model does not receive a discriminated union; it receives
 * text. So the host renders a second, deliberately POORER view.
 *
 * What it removes and why: step ids, descriptors, expectation traces, observation digests, drift
 * and budgets, because a model handed a locator will try to route around it and a model handed
 * "expected heading Member Detail" will try to navigate there directly. `suspended` becomes
 * `pending`, because from the model's side the run has not finished - same fact, the model's
 * vocabulary. Outputs whose disclosure is `mask` or `withhold` are dropped, because a tool result
 * lands in a third-party transcript and that is the control which stops "taint governs persistence,
 * not delivery" from quietly meaning "regulated data leaves the perimeter".
 *
 * And nothing is ADDED. `guidance` is copied, never generated at render time. The playbook for "the
 * member does not exist" was reviewed by a person once; it is not re-derived on every call by the
 * component most likely to get it wrong.
 */
export const AgentToolResultSchema = z.strictObject({
  /** Four values, and "outcome" is not a synonym for "error". The model reads this first. */
  status: z.enum(["ok", "outcome", "pending", "error"]),
  outcome: z.string().max(64).optional(),
  data: z.record(z.string().min(1).max(64), ExtractedValueSchema).optional(),
  guidance: z.string().min(1).max(2000),
  retryable: z.enum(["never", "after_delay", "with_different_inputs"]),
  runId: z.string().min(1).max(128),
  /** For "error" and "pending": the string a member can quote to a human. */
  reference: z.string().max(128).optional(),
});
export type AgentToolResult = DeepReadonly<z.infer<typeof AgentToolResultSchema>>;
