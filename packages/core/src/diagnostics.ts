// The vocabulary of "what went wrong, and what a human should do about it".
//
// Everything here is shared by the result contract (section 2.6), the intervention brief
// (section 2.9) and the journal (section 2.10), which is why it is its own module: the three would
// otherwise import each other in a ring.
//
// The centre of it is `FailureClass`. It is CLOSED, and the admission test for a member is that it
// implies a DIFFERENT HUMAN ACTION from every other member. That is why there is no UNKNOWN_ERROR:
// a class nobody can act on is a class that exists to make an engine feel complete.

import { z } from "zod";
import { RemedySchema } from "./artifact.js";
import {
  DescriptorKindSchema,
  DescriptorVerdictSchema,
  EvidenceSourceSchema,
} from "./descriptor-kinds.js";
import { NodeFingerprintSchema } from "./descriptors.js";
import { RouteLocationSchema } from "./observation.js";
import {
  type DeepReadonly,
  MoneySchema,
  NodeIdSchema,
  RoleSchema,
  SensitivitySchema,
  StepIdSchema,
} from "./primitives.js";
import type { SchemaIdentity } from "./schema-identity.js";

export const ReplayStatusSchema = z.enum(["ok", "outcome", "suspended", "failed"]);
export type ReplayStatus = z.infer<typeof ReplayStatusSchema>;

export const FailureClassSchema = z.enum([
  // zero actions performed, guaranteed
  "link-error",
  "argument-invalid",
  "contract-stale",
  "artifact-invalid",
  // pre-act gates
  "precondition-not-met",
  "policy-denied",
  "approval-required",
  "lease-lost",
  // targeting
  "target-not-found",
  "target-ambiguous",
  "target-underdetermined",
  "target-assert-failed",
  // acting and verifying
  "action-rejected",
  "no-observable-effect",
  "checkpoint-failed",
  "continuity-broken",
  "output-extraction-failed",
  // environment
  "undeclared-dialog",
  "session-expired-unrecoverable",
  "entitlement-denied",
  "app-error",
  "did-not-settle",
  "surface-error",
  // taxonomy and budget
  "ambiguous-classification",
  "recovery-exhausted",
  "budget-exhausted",
  // the one that must never be retried
  "effect-in-doubt",
  // "a system that cannot say 'I am broken' says 'you are' instead"
  "internal-invariant",
]);
export type FailureClass = z.infer<typeof FailureClassSchema>;

export const SuspensionReasonSchema = z.enum([
  "unclassified-state",
  "recovery-exhausted",
  "approval-required",
  "target-ambiguous",
  "target-underdetermined",
  "session-lost",
  "effect-in-doubt",
]);
export type SuspensionReason = z.infer<typeof SuspensionReasonSchema>;

/**
 * THE FIELD A CALLER SHOULD NOT HAVE TO INFER.
 *
 * In a regulated environment "we definitely did not touch anything" is a materially different
 * answer from "we stopped partway", and "an irreversible action was dispatched and we never saw its
 * result" is a third thing again - the one where somebody has to go and reconcile against the
 * system of record, and where a retry is the worst available move.
 */
export const SideEffectsSchema = z.enum(["none-guaranteed", "possible", "in-doubt"]);
export type SideEffects = z.infer<typeof SideEffectsSchema>;

export const RetriableSchema = z.enum(["same-inputs", "after-human-action", "no"]);
export type Retriable = z.infer<typeof RetriableSchema>;

/**
 * The classes that are decided before the surface is touched at all, and therefore carry
 * `sideEffects: "none-guaranteed"` as a fact rather than as a hope. A caller's bad member number
 * costs zero actions, and this set is why it can be said out loud.
 */
export const PRE_FLIGHT_FAILURES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  "link-error",
  "argument-invalid",
  "contract-stale",
  "artifact-invalid",
]);

/**
 * The static per-class table. Written once, by a person, and copied verbatim - never generated at
 * render time by the component most likely to get it wrong.
 *
 * `operatorAction` is one line telling a human what to actually do, and it is derived from the
 * class rather than free text, so two runs of the same failure never explain themselves
 * differently. `agentGuidance` is the model's half: no step ids, no descriptors, nothing that
 * invites an agent to route around the engine.
 */
export interface FailureGuidance {
  readonly operatorAction: string;
  readonly retriable: Retriable;
  readonly agentGuidance: string;
}

export const FAILURE_GUIDANCE: Readonly<Record<FailureClass, FailureGuidance>> = {
  "link-error": {
    operatorAction:
      "Fix the artifact, overlay or surface mismatch the link report names; nothing ran.",
    retriable: "after-human-action",
    agentGuidance:
      "This capability is misconfigured. Nothing was changed. Tell the user you cannot do this right now.",
  },
  "argument-invalid": {
    operatorAction: "No action needed; the caller supplied a value the capability does not accept.",
    retriable: "same-inputs",
    agentGuidance:
      "The value you supplied is not the right shape. Ask the user for it again and retry.",
  },
  "contract-stale": {
    operatorAction: "Regenerate the caller's types from the current contract and redeploy.",
    retriable: "after-human-action",
    agentGuidance:
      "This capability has changed since your tools were built. Nothing was changed. Escalate.",
  },
  "artifact-invalid": {
    operatorAction: "The stored artifact failed validation or its digest; re-record or restore it.",
    retriable: "after-human-action",
    agentGuidance: "This capability is unavailable. Nothing was changed.",
  },
  "precondition-not-met": {
    operatorAction:
      "Check the session landed where the program expected; the run stopped before acting.",
    retriable: "same-inputs",
    agentGuidance: "The system was not in the expected state. You may try once more.",
  },
  "policy-denied": {
    operatorAction:
      "Review the allowlist entry the denial names; the action was refused before dispatch.",
    retriable: "no",
    agentGuidance: "This action is not permitted. Nothing was changed. Do not retry.",
  },
  "approval-required": {
    operatorAction: "This capability needs an approval token for this invocation.",
    retriable: "after-human-action",
    agentGuidance: "This action needs a person to approve it first. Nothing was changed.",
  },
  "lease-lost": {
    operatorAction: "A human took the session; re-run once the session is free.",
    retriable: "same-inputs",
    agentGuidance: "Someone else is using this session. You may try again shortly.",
  },
  "target-not-found": {
    operatorAction:
      "The control the step acts on is no longer present; compare against the drift report.",
    retriable: "after-human-action",
    agentGuidance: "The system did not look the way this capability expects. Escalate to a person.",
  },
  "target-ambiguous": {
    operatorAction:
      "Two descriptors selected different nodes; add or disable a descriptor in the tenant overlay.",
    retriable: "after-human-action",
    agentGuidance: "The system was ambiguous and the run refused to guess. Escalate to a person.",
  },
  "target-underdetermined": {
    operatorAction:
      "Too little independent evidence to act; the surviving descriptors share one source.",
    retriable: "after-human-action",
    agentGuidance:
      "The system could not be identified with enough confidence to act. Escalate to a person.",
  },
  "target-assert-failed": {
    operatorAction: "The resolved control failed its own assertion - most often the wrong row.",
    retriable: "after-human-action",
    agentGuidance:
      "A safety check refused to act on what was found. Nothing was changed. Escalate.",
  },
  "action-rejected": {
    operatorAction: "The surface refused the action; the fault detail says which mechanism.",
    retriable: "same-inputs",
    agentGuidance: "The system would not accept the action. You may try once more.",
  },
  "no-observable-effect": {
    operatorAction:
      "The action dispatched and nothing changed on screen; check for a swallowed error.",
    retriable: "same-inputs",
    agentGuidance: "The system did not respond to the action. You may try once more.",
  },
  "checkpoint-failed": {
    operatorAction: "The postcondition did not hold; the expectation trace says which clause.",
    retriable: "after-human-action",
    agentGuidance: "The system did not end up where it should have. Escalate to a person.",
  },
  "continuity-broken": {
    operatorAction:
      "The run was no longer on the record it started with; stop and investigate before retrying.",
    retriable: "no",
    agentGuidance: "The system may have moved to a different record, so the run stopped. Escalate.",
  },
  "output-extraction-failed": {
    operatorAction: "A required output could not be read or parsed; there is no partial success.",
    retriable: "after-human-action",
    agentGuidance:
      "The answer could not be read reliably, so none was returned. Escalate to a person.",
  },
  "undeclared-dialog": {
    operatorAction: "An unmodelled native dialog appeared; add a declared recovery for it.",
    retriable: "after-human-action",
    agentGuidance: "An unexpected prompt appeared and the run stopped rather than answering it.",
  },
  "session-expired-unrecoverable": {
    operatorAction: "Re-authentication did not restore the session; check the session profile.",
    retriable: "after-human-action",
    agentGuidance: "The connection to the system expired and could not be restored.",
  },
  "entitlement-denied": {
    operatorAction: "The automation's own account lacks the entitlement for this screen.",
    retriable: "after-human-action",
    agentGuidance: "This capability does not have permission to do that. Escalate to a person.",
  },
  "app-error": {
    operatorAction:
      "The application returned its own error page; capture and report to the vendor.",
    retriable: "same-inputs",
    agentGuidance: "The system reported an error of its own. You may try once more.",
  },
  "did-not-settle": {
    operatorAction:
      "The surface never quiesced within the settle budget; check for a stuck request.",
    retriable: "same-inputs",
    agentGuidance: "The system did not finish loading in time. You may try once more.",
  },
  "surface-error": {
    operatorAction: "The driver itself failed; check the driver log rather than the application.",
    retriable: "same-inputs",
    agentGuidance: "A technical problem stopped the run. You may try once more.",
  },
  "ambiguous-classification": {
    operatorAction: "Two rules matched at one step; make the priorities or the detectors disjoint.",
    retriable: "after-human-action",
    agentGuidance: "The result was ambiguous and the run refused to guess. Escalate to a person.",
  },
  "recovery-exhausted": {
    operatorAction: "A known condition kept recurring past its attempt budget.",
    retriable: "after-human-action",
    agentGuidance: "A recurring problem could not be cleared. Escalate to a person.",
  },
  "budget-exhausted": {
    operatorAction: "The run hit an action, observation or wall-clock ledger; check for a loop.",
    retriable: "after-human-action",
    agentGuidance: "The run took too long and was stopped. Escalate to a person.",
  },
  "effect-in-doubt": {
    operatorAction:
      "AN IRREVERSIBLE ACTION WAS DISPATCHED AND ITS RESULT WAS NEVER OBSERVED. Reconcile against the system of record. Never retry.",
    retriable: "no",
    agentGuidance:
      "This may or may not have completed. Do not try again. Tell the user a person will confirm and follow up.",
  },
  "internal-invariant": {
    operatorAction: "The engine violated one of its own invariants; this is a bug in the engine.",
    retriable: "no",
    agentGuidance: "A technical fault stopped the run. Escalate to a person. Do not retry.",
  },
};

// ---------------------------------------------------------------------------------------------
// What was expected, and what was there
// ---------------------------------------------------------------------------------------------

const expectationTraceSchemaImpl = z.strictObject({
  rendered: z.string().max(4000),
  clauses: z
    .array(
      z.strictObject({
        rendered: z.string().max(1000),
        verdict: z.boolean(),
        descriptorId: z.string().max(64).optional(),
        evidenceSource: EvidenceSourceSchema.optional(),
        /**
         * A rendered description of the matched node - never a node id, and never its value.
         *
         * SPEC section 4.7 names this field `node`. Renamed here because the purity contract test
         * of section 1.3 scans this package for the Node.js import prefix, and a property named
         * `node` is spelled with the same two characters after it - a false positive waiting to
         * happen in the one test that guards the architecture. The longer name is also more
         * accurate: this field holds prose, not a node.
         */
        nodeSummary: z.string().max(500).optional(),
      }),
    )
    .max(64)
    .readonly(),
});
/**
 * GENERATED by a fold over the declared predicate and target - never hand-authored.
 *
 * Two rules the renderer obeys, and together they close a real privacy hole: a `ValueRef` renders
 * BY NAME (`param.memberId`, never the value), and a template hole renders UNRESOLVED
 * (`{memberId}`). So neither half of a failure report carries a member number, and two runs are
 * told apart by their run id rather than by the value they were asked about.
 */
export interface ExpectationTraceSchemaType
  extends SchemaIdentity<typeof expectationTraceSchemaImpl> {}
export const ExpectationTraceSchema: ExpectationTraceSchemaType = expectationTraceSchemaImpl;

export type ExpectationTrace = DeepReadonly<z.infer<typeof ExpectationTraceSchema>>;

const observedSummarySchemaImpl = z.strictObject({
  route: RouteLocationSchema.nullable(),
  settled: z.boolean(),
  pendingReason: z.enum(["navigating", "network", "animating", "pty-active", "unknown"]).nullable(),
  skeletonDigest: z.string().min(1).max(128),
  nodeCount: z.int().nonnegative(),
  nativeDialog: z
    .strictObject({
      type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
      message: z.string().max(1024),
    })
    .nullable(),
  inputIntercepted: z.boolean(),
  /** The handful of nodes a person would look at first: headings, alerts, statuses, and the
   *  controls the step cared about. Names only, never values. */
  salient: z
    .array(
      z.strictObject({
        role: RoleSchema.nullable(),
        name: z.string().max(500),
        disabled: z.boolean(),
        visible: z.boolean(),
      }),
    )
    .max(32)
    .readonly(),
  /** How many fields the taint model blanked on the way here. Non-zero is normal on a member
   *  screen; zero on a screen that should have had some is worth noticing. */
  redactionsApplied: z.int().nonnegative(),
});
/**
 * What was actually there, redacted per taint before it is written anywhere.
 *
 * SPEC section 2.6 names this type and does not define it; this is the definition. It is
 * deliberately a SUMMARY and not an observation: an observation is captured separately, by
 * reference, and the summary is the part that goes into a journal, a tool result and an operator's
 * screen - all three of which are places a member's name must not appear by accident.
 */
export interface ObservedSummarySchemaType
  extends SchemaIdentity<typeof observedSummarySchemaImpl> {}
export const ObservedSummarySchema: ObservedSummarySchemaType = observedSummarySchemaImpl;

export type ObservedSummary = DeepReadonly<z.infer<typeof ObservedSummarySchema>>;

const targetCandidateSchemaImpl = z.strictObject({
  descriptorId: z.string().max(64),
  kind: DescriptorKindSchema,
  evidenceSource: EvidenceSourceSchema,
  verdict: DescriptorVerdictSchema,
  /** Per-observation only, and present here purely so two rows can be compared within one report. */
  nodeId: NodeIdSchema.nullable(),
  fingerprint: NodeFingerprintSchema.nullable(),
  /** The descriptor rendered into prose, so an operator does not have to read the document. */
  rendered: z.string().max(1000),
});
/**
 * One descriptor's account of itself, for the ambiguous and underdetermined failures.
 *
 * The `evidenceSource` is on every row for the reason section 5.1 gives: three candidates that
 * agree are not three pieces of evidence if they all read the same label, and a report that omitted
 * the source would make an underdetermined refusal look like an inexplicable one.
 */
export interface TargetCandidateSchemaType
  extends SchemaIdentity<typeof targetCandidateSchemaImpl> {}
export const TargetCandidateSchema: TargetCandidateSchemaType = targetCandidateSchemaImpl;

export type TargetCandidate = DeepReadonly<z.infer<typeof TargetCandidateSchema>>;

const runWarningSchemaImpl = z.strictObject({
  code: z.enum([
    "descriptor-abstaining",
    "descriptor-disabled-by-overlay",
    "outcome-also-matched",
    "header-provenance-changed",
    "drift-above-baseline",
    "budget-near-limit",
    "recovery-fired",
  ]),
  stepId: StepIdSchema.nullable(),
  detail: z.string().max(1000),
});
/**
 * Non-fatal integrity warnings. Closed, like every other vocabulary here, because a free-text
 * warning is a warning nobody can count - and the whole value of this type is that a descriptor
 * which has been abstaining for a month is countable.
 */
export interface RunWarningSchemaType extends SchemaIdentity<typeof runWarningSchemaImpl> {}
export const RunWarningSchema: RunWarningSchemaType = runWarningSchemaImpl;

export type RunWarning = DeepReadonly<z.infer<typeof RunWarningSchema>>;

const driftSignalSchemaImpl = z.strictObject({
  fingerprint: z.string().min(1).max(128),
  expected: z.string().min(1).max(128),
  /** 0..1, the share of descriptor verdicts that changed. */
  divergence: z.number().min(0).max(1),
  changed: z
    .array(
      z.strictObject({
        stepId: StepIdSchema,
        descriptorId: z.string().max(64),
        was: DescriptorVerdictSchema,
        now: DescriptorVerdictSchema,
      }),
    )
    .max(256)
    .readonly(),
  /**
   * Crossing the threshold means "this tenant has diverged enough to need its own overlay", NOT
   * "this run failed". Nothing automatically acts on it, and no threshold ships until one has been
   * measured against the conformance corpus - inventing a number and defending it in a write-up is
   * exactly the unearned precision this project does not do.
   */
  needsSpecialization: z.boolean(),
});
export interface DriftSignalSchemaType extends SchemaIdentity<typeof driftSignalSchemaImpl> {}
export const DriftSignalSchema: DriftSignalSchemaType = driftSignalSchemaImpl;

export type DriftSignal = DeepReadonly<z.infer<typeof DriftSignalSchema>>;

const linkErrorSchemaImpl = z.strictObject({
  /** The numbered check from SPEC section 10 that refused. Numbered so a report can be diffed
   *  against the spec rather than against last week's wording. */
  check: z.int().min(1).max(28),
  code: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .max(64),
  message: z.string().min(1).max(1000),
  /** A JSON pointer-ish path into the document, or null for a whole-document check. */
  where: z.string().max(500).nullable(),
});
export interface LinkErrorSchemaType extends SchemaIdentity<typeof linkErrorSchemaImpl> {}
export const LinkErrorSchema: LinkErrorSchemaType = linkErrorSchemaImpl;

export type LinkError = DeepReadonly<z.infer<typeof LinkErrorSchema>>;

// ---------------------------------------------------------------------------------------------
// The classifier's output
// ---------------------------------------------------------------------------------------------

const extractedValueSchemaImpl = z.union([
  z.string(),
  z.int(),
  z.boolean(),
  MoneySchema,
  z
    .array(z.record(z.string().min(1).max(64), z.string()))
    .max(10_000)
    .readonly(),
  z.null(),
]);
/** A value read off a screen, after normalization and parsing. No IEEE-754 anywhere: an integer, a
 *  string, a boolean, money as a decimal string, or bounded table rows. */
export interface ExtractedValueSchemaType extends SchemaIdentity<typeof extractedValueSchemaImpl> {}
export const ExtractedValueSchema: ExtractedValueSchemaType = extractedValueSchemaImpl;

export type ExtractedValue = DeepReadonly<z.infer<typeof ExtractedValueSchema>>;

const extractedOutputSchemaImpl = z.strictObject({
  output: z.string().min(1).max(64),
  value: ExtractedValueSchema,
  sensitivity: SensitivitySchema,
});
export interface ExtractedOutputSchemaType
  extends SchemaIdentity<typeof extractedOutputSchemaImpl> {}
export const ExtractedOutputSchema: ExtractedOutputSchemaType = extractedOutputSchemaImpl;

export type ExtractedOutput = DeepReadonly<z.infer<typeof ExtractedOutputSchema>>;

const failureDetailSchemaImpl = z.strictObject({
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
  /** One line telling a human what to actually do, taken from `FAILURE_GUIDANCE`. */
  operatorAction: z.string().min(1).max(500),
});
export interface FailureDetailSchemaType extends SchemaIdentity<typeof failureDetailSchemaImpl> {}
export const FailureDetailSchema: FailureDetailSchemaType = failureDetailSchemaImpl;

export type FailureDetail = DeepReadonly<z.infer<typeof FailureDetailSchema>>;

const verdictSchemaImpl = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pending"),
    reason: z.literal("not-settled"),
    settleElapsedMs: z.int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("advance"),
    outputs: z.array(ExtractedOutputSchema).max(64).readonly(),
  }),
  z.strictObject({
    kind: z.literal("outcome"),
    code: z.string().max(64),
    data: z.array(ExtractedOutputSchema).max(64).readonly(),
    priority: z.int().nonnegative(),
    /** Rules that also matched but lost on priority. Empty is normal; non-empty is a quiet warning
     *  that this step's taxonomy is getting muddy. */
    alsoMatched: z
      .array(z.strictObject({ code: z.string().max(64), priority: z.int().nonnegative() }))
      .max(16)
      .readonly(),
  }),
  z.strictObject({
    kind: z.literal("recover"),
    recoveryName: z.string().max(64),
    remedy: RemedySchema,
    attempt: z.int().positive(),
  }),
  z.strictObject({
    kind: z.literal("fail"),
    failure: FailureClassSchema,
    detail: FailureDetailSchema,
  }),
]);
/**
 * The classifier's verdict - the entire runtime error taxonomy, as the output of one total
 * function over a frozen observation.
 *
 * The reason this type is worth its weight: `classify` takes plain JSON and returns plain JSON, so
 * a production failure becomes a unit test by saving one file. No browser, no fixture, no session,
 * no reproduction step. That is the practical payoff of designing the classifier for purity rather
 * than merely claiming it.
 */
export interface VerdictSchemaType extends SchemaIdentity<typeof verdictSchemaImpl> {}
export const VerdictSchema: VerdictSchemaType = verdictSchemaImpl;

export type Verdict = DeepReadonly<z.infer<typeof VerdictSchema>>;
