// SPEC section 2.10 - the append-only run journal.
//
// One JSONL file per run, written by the runtime, ordered by `seq` rather than by wall clock, so
// two replays of the same program produce comparable journals modulo the timing fields. It is the
// input to the evidence bundle and to the conformance corpus.
//
// TWO RULES HERE ARE TESTS, NOT CONVENTIONS.
//   1. No journal event may contain a value bound to a sensitive parameter or output. The schema
//      helps - `acted` records a taint handle and a LENGTH, `extracted` records presence and not
//      the value - and a redaction test replays a run with a known canary and greps the whole
//      journal, the evidence directory and the artifact for it.
//   2. Every `acted` event has a matching preceding `policy.decided` with the same action kind at
//      the same step. That is how "one chokepoint" becomes a proven property rather than an
//      architectural assertion, and it is checked by a contract test over the journal plus a
//      runtime assertion.

import { z } from "zod";
import {
  DescriptorKindSchema,
  DescriptorVerdictSchema,
  EvidenceSourceSchema,
} from "./descriptor-kinds.js";
import {
  ExpectationTraceSchema,
  FailureClassSchema,
  LinkErrorSchema,
  ReplayStatusSchema,
  SuspensionReasonSchema,
  VerdictSchema,
} from "./diagnostics.js";
import { ActFaultKindSchema, ActionKindSchema } from "./observation.js";
import { PolicyDecisionSchema, TaintHandleSchema } from "./policy.js";
import {
  CapabilityNameSchema,
  type DeepReadonly,
  DigestSchema,
  EffectClassSchema,
  EvidenceRefSchema,
  InterventionIdSchema,
  NodeIdSchema,
  RunIdSchema,
  SensitivitySchema,
  StepIdSchema,
  TenantIdSchema,
  TimestampSchema,
} from "./primitives.js";
import type { SchemaIdentity } from "./schema-identity.js";
import { ControllerSchema, SessionIdSchema } from "./session.js";

export const RemedyKindSchema = z.enum([
  "actions",
  "dismiss-native-dialog",
  "reauthenticate",
  "escalate",
]);
export type RemedyKind = z.infer<typeof RemedyKindSchema>;

/** Every event carries these, so a journal line is self-describing even when read out of order. */
const envelope = {
  seq: z.int().nonnegative(),
  runId: RunIdSchema,
  at: TimestampSchema,
} as const;

const event = <T extends z.core.$ZodShape>(type: string, shape: T) =>
  z.strictObject({ ...envelope, type: z.literal(type), ...shape });

const journalEventSchemaImpl = z.discriminatedUnion("type", [
  event("run.started", {
    mode: z.enum(["discovery", "replay", "verify"]),
    capability: CapabilityNameSchema,
    artifactDigest: DigestSchema,
    effectiveDigest: DigestSchema,
    tenantId: TenantIdSchema,
    /** SHAPES, never values: `{ memberId: "digits(5)" }`. The single most likely place for a member
     *  number to end up in a log is the line that says which arguments a run started with. */
    argsShape: z.record(z.string().min(1).max(64), z.string().max(128)),
  }),
  event("link.completed", {
    checksRun: z.int().nonnegative(),
    errors: z.array(LinkErrorSchema).max(64).readonly(),
  }),
  event("session.opened", {
    sessionId: SessionIdSchema,
    sessionProfile: z.string().min(1).max(128),
  }),
  event("lease.acquired", {
    holder: ControllerSchema,
    actorId: z.string().min(1).max(128),
    epoch: z.int().nonnegative(),
  }),
  event("lease.released", {
    holder: ControllerSchema,
    reason: z.string().min(1).max(200),
  }),
  event("step.entered", {
    stepId: StepIdSchema,
    index: z.int().nonnegative(),
    attempt: z.int().positive(),
    effect: EffectClassSchema,
  }),
  event("observed", {
    stepId: StepIdSchema.nullable(),
    obsSeq: z.int().nonnegative(),
    skeletonDigest: z.string().min(1).max(128),
    settled: z.boolean(),
    nodeCount: z.int().nonnegative(),
    observationRef: EvidenceRefSchema.nullable(),
  }),
  event("classified", {
    stepId: StepIdSchema,
    phase: z.enum(["pre", "post"]),
    verdict: VerdictSchema,
    alsoMatched: z.array(z.string().max(64)).max(16).readonly(),
  }),
  event("resolved", {
    stepId: StepIdSchema,
    descriptors: z
      .array(
        z.strictObject({
          id: z.string().max(64),
          kind: DescriptorKindSchema,
          evidenceSource: EvidenceSourceSchema,
          verdict: DescriptorVerdictSchema,
          nodeId: NodeIdSchema.nullable(),
        }),
      )
      .max(32)
      .readonly(),
    agreed: z.boolean(),
    /** Counted, and journaled, because a quorum of three descriptors sharing one source is a
     *  quorum of one - and the only place that becomes visible after the fact is here. */
    distinctSources: z.int().nonnegative(),
  }),
  event("policy.decided", {
    decision: PolicyDecisionSchema,
    actionKind: ActionKindSchema,
    effect: EffectClassSchema,
  }),
  event("acted", {
    stepId: StepIdSchema,
    actionKind: ActionKindSchema,
    targetTitle: z.string().max(200),
    /** A handle, never the text. */
    valueRef: TaintHandleSchema.nullable(),
    valueLength: z.int().nonnegative().nullable(),
    result: z.union([z.literal("dispatched"), ActFaultKindSchema]),
  }),
  event("settled", {
    stepId: StepIdSchema,
    polls: z.int().nonnegative(),
    elapsedMs: z.int().nonnegative(),
    settled: z.boolean(),
  }),
  event("checkpoint", {
    stepId: StepIdSchema,
    passed: z.boolean(),
    trace: ExpectationTraceSchema,
  }),
  event("extracted", {
    stepId: StepIdSchema,
    output: z.string().min(1).max(64),
    sensitivity: SensitivitySchema,
    /** Presence, never the value. */
    present: z.boolean(),
  }),
  event("recovery.applied", {
    stepId: StepIdSchema,
    name: z.string().max(64),
    attempt: z.int().positive(),
    remedy: RemedyKindSchema,
  }),
  event("budget.charged", {
    ledger: z.string().min(1).max(64),
    used: z.int().nonnegative(),
    limit: z.int().nonnegative(),
  }),
  event("intervention.raised", {
    interventionId: InterventionIdSchema,
    reason: SuspensionReasonSchema,
  }),
  event("intervention.resolved", {
    interventionId: InterventionIdSchema,
    disposition: z.enum(["resume", "abort"]),
    by: z.string().min(1).max(128),
  }),
  event("human.acted", {
    actorId: z.string().min(1).max(128),
    actionKind: ActionKindSchema,
    targetTitle: z.string().max(200),
  }),
  event("restart.requested", {
    fromPc: z.int().nonnegative(),
    gate: z.enum(["passed", "refused"]),
    restartSafeUpToPc: z.int().nonnegative(),
  }),
  event("evidence.captured", {
    ref: EvidenceRefSchema,
    kind: z.enum(["image", "text-grid", "observation"]),
    maskedRegions: z.int().nonnegative(),
  }),
  event("run.finished", {
    status: ReplayStatusSchema,
    failureClass: FailureClassSchema.optional(),
    outcomeCode: z.string().max(64).optional(),
  }),
]);
export interface JournalEventSchemaType extends SchemaIdentity<typeof journalEventSchemaImpl> {}
export const JournalEventSchema: JournalEventSchemaType = journalEventSchemaImpl;

export type JournalEvent = DeepReadonly<z.infer<typeof JournalEventSchema>>;

export const JOURNAL_EVENT_TYPES = [
  "run.started",
  "link.completed",
  "session.opened",
  "lease.acquired",
  "lease.released",
  "step.entered",
  "observed",
  "classified",
  "resolved",
  "policy.decided",
  "acted",
  "settled",
  "checkpoint",
  "extracted",
  "recovery.applied",
  "budget.charged",
  "intervention.raised",
  "intervention.resolved",
  "human.acted",
  "restart.requested",
  "evidence.captured",
  "run.finished",
] as const;
export type JournalEventType = (typeof JOURNAL_EVENT_TYPES)[number];
