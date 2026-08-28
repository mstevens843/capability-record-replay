// SPEC section 2.9 - control transfer as a lease, not a pause.
//
// A session has EXACTLY ONE controller, held under a lease token. The executor rejects actions from
// a non-holder, and so does the DRIVER, because `Surface.act` takes the token. Two gates rather
// than one, because the interesting failure is not a human and an automation racing - it is an
// automation run that still believes it holds a session a human took forty seconds ago, and a
// single gate upstairs cannot see that.

import { z } from "zod";
import {
  ExpectationTraceSchema,
  ObservedSummarySchema,
  SuspensionReasonSchema,
} from "./diagnostics.js";
import { ActionKindSchema } from "./observation.js";
import {
  type DeepReadonly,
  EvidenceRefSchema,
  InterventionIdSchema,
  LeaseTokenSchema,
  RunIdSchema,
  TimestampSchema,
} from "./primitives.js";
import type { SchemaIdentity } from "./schema-identity.js";

export const ControllerSchema = z.enum(["automation", "human"]);
export type Controller = z.infer<typeof ControllerSchema>;

export const SessionIdSchema = z.string().min(1).max(128).regex(/^\S+$/);

const leaseSchemaImpl = z.strictObject({
  sessionId: SessionIdSchema,
  token: LeaseTokenSchema,
  holder: ControllerSchema,
  /** "run:<runId>" or "operator:<id>". Attribution is the point: the journal has to be able to say
   *  which steps a human owned. */
  actorId: z.string().min(1).max(128),
  acquiredAt: TimestampSchema,
  expiresAt: TimestampSchema,
  /**
   * Monotonic. Every acquire increments it, so a token minted under an older epoch is dead even if
   * its string were somehow replayed. Without the epoch, "the same token string" and "the same
   * grant" are indistinguishable, and a resumed run could act on a session it lost and regained.
   */
  epoch: z.int().nonnegative(),
});
export interface LeaseSchemaType extends SchemaIdentity<typeof leaseSchemaImpl> {}
export const LeaseSchema: LeaseSchemaType = leaseSchemaImpl;

export type Lease = DeepReadonly<z.infer<typeof LeaseSchema>>;

const leaseSnapshotSchemaImpl = LeaseSchema.pick({
  holder: true,
  actorId: true,
  epoch: true,
  expiresAt: true,
});
/** What the policy engine is shown. Deliberately not the token itself: a pure predicate has no
 *  business holding a credential, and it does not need one to answer "does this actor hold it". */
export interface LeaseSnapshotSchemaType extends SchemaIdentity<typeof leaseSnapshotSchemaImpl> {}
export const LeaseSnapshotSchema: LeaseSnapshotSchemaType = leaseSnapshotSchemaImpl;

export type LeaseSnapshot = DeepReadonly<z.infer<typeof LeaseSnapshotSchema>>;

const controlTransferSchemaImpl = z.strictObject({
  at: TimestampSchema,
  from: ControllerSchema,
  to: ControllerSchema,
  actorId: z.string().min(1).max(128),
  interventionId: InterventionIdSchema.nullable(),
  /** What the human did, attributed. TITLES ONLY - never values, never coordinates. An operator
   *  console that recorded what was typed would be a second copy of every member number a human
   *  ever keyed, in the audit trail, forever. */
  actionsPerformed: z
    .array(z.strictObject({ kind: ActionKindSchema, targetTitle: z.string().max(200) }))
    .max(256)
    .readonly(),
});
export interface ControlTransferSchemaType
  extends SchemaIdentity<typeof controlTransferSchemaImpl> {}
export const ControlTransferSchema: ControlTransferSchemaType = controlTransferSchemaImpl;

export type ControlTransfer = DeepReadonly<z.infer<typeof ControlTransferSchema>>;

const interventionSchemaImpl = z.strictObject({
  id: InterventionIdSchema,
  runId: RunIdSchema,
  sessionId: SessionIdSchema,
  reason: SuspensionReasonSchema,
  raisedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  state: z.enum(["open", "claimed", "resolved", "abandoned", "expired"]),

  /** EVERYTHING a human needs in order to act, on one screen, without opening anything else. This
   *  is "route an intervention request with context" made concrete: a link to a log is not context,
   *  it is a second task. */
  brief: z.strictObject({
    capabilityTitle: z.string().min(1).max(200),
    /** Parameterized, never a member number. */
    goalTemplate: z.string().min(1).max(2000),
    stepIndex: z.int().nonnegative(),
    stepTitle: z.string().min(1).max(200),
    whatWasExpected: ExpectationTraceSchema,
    whatWasObserved: ObservedSummarySchema,
    /** A masked screenshot or a masked grid dump. */
    evidence: EvidenceRefSchema.nullable(),
    /** From the failure-class table, not free text. */
    whyStopped: z.string().min(1).max(500),
    suggestedAction: z.string().min(1).max(500),
  }),

  /** Presenting this resumes THIS run at THIS step - which then RE-VERIFIES its precondition rather
   *  than blindly continuing, because the human may have navigated somewhere else entirely. */
  resumeToken: LeaseTokenSchema,
  consoleUrl: z.string().min(1).max(1024),
  resolution: z
    .strictObject({
      by: z.string().min(1).max(128),
      at: TimestampSchema,
      disposition: z.enum(["resume", "abort"]),
    })
    .nullable(),
});
export interface InterventionSchemaType extends SchemaIdentity<typeof interventionSchemaImpl> {}
export const InterventionSchema: InterventionSchemaType = interventionSchemaImpl;

export type Intervention = DeepReadonly<z.infer<typeof InterventionSchema>>;
