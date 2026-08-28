// SPEC section 2.4 - the artifact document: the program the interpreter runs.
//
// This is the focal point of the design. Three things about it are load-bearing and are enforced
// here rather than described:
//
//   1. DETECTORS LIVE ON STEPS. `OutcomeRule` is a member of `Step`, and `OutcomeDecl` (on the
//      contract) has no slot for a predicate. One contract, two programs - a browser one and a
//      green-screen one - is only possible because of that split.
//   2. THE PROGRAM IS A STRAIGHT LINE. No branching, no loops, no conditionals. That refusal is
//      what buys the static effect analysis, `restartSafeUpToPc` and the dry-run verification
//      mode, and it is why a human reviewer can read an artifact and know what it will do.
//   3. NO FIELD HAS A PARSE-TIME DEFAULT. The artifact is content-addressed and an approval
//      signature is taken over that address; a schema that filled in `stableSamples: 2` on parse
//      would give the same file two digests depending on which side of the validator you stood on.
//      Documented defaults live in `SETTLE_POLICY_DEFAULTS` and friends, for a recorder to apply
//      once when it writes the document.

import { z } from "zod";
import { TargetRefSchema } from "./descriptors.js";
import { BoundedPredicateSchema, ContainerMatcherSchema, NodeQuerySchema } from "./matchers.js";
import { OriginAliasSchema, SurfaceFeatureSchema } from "./observation.js";
import {
  AppInstanceIdSchema,
  ArtifactIdSchema,
  CapabilityNameSchema,
  ContractVersionSchema,
  type DeepReadonly,
  DigestSchema,
  type EffectClass,
  EffectClassSchema,
  ExtractorIdSchema,
  LabelTokenSchema,
  NormalizerIdSchema,
  ParserIdSchema,
  type RouteId,
  RouteIdSchema,
  RoutePatternSchema,
  RunIdSchema,
  SensitivitySchema,
  type StepId,
  StepIdSchema,
  SurfaceKindSchema,
  TenantIdSchema,
  TimestampSchema,
  ValueTypeSchema,
} from "./primitives.js";
import type { SchemaIdentity } from "./schema-identity.js";
import { SafeTextMatcherSchema, SafeValueRefSchema, piiShapeOf } from "./text-safety.js";

export const SCHEMA_VERSION_ARTIFACT = "capability.artifact/v1";

// ---------------------------------------------------------------------------------------------
// The instruction set (SPEC section 3)
//
// Ten instructions. The admission criterion is that each has a DISTINCT POSTCONDITION the
// interpreter can verify, which is why `fill` / `select` / `setToggle` are not collapsed into one
// `setValue`: an opcode with three different postconditions is an opcode that cannot be checked.
// ---------------------------------------------------------------------------------------------

/**
 * The ARTIFACT's key vocabulary. Note what is absent: the function keys.
 *
 * The action port has them, because the terminal driver emits them. The program does not, because
 * the terminal spike measured the Exit control bound to F3 at one tenant and F12 at the next while
 * the synthesized node was identical across both. A program that hardcodes F3 is correct at one
 * tenant and wrong at the next, and no overlay should be needed to repair a difference the driver
 * can absorb on its own. `PageUp` / `PageDown` lower to the paging keys on a character grid.
 */
export const ArtifactKeySchema = z.enum([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
export type ArtifactKey = z.infer<typeof ArtifactKeySchema>;

export const InstructionKindSchema = z.enum([
  "navigate",
  "activate",
  "fill",
  "select",
  "setToggle",
  "pressKey",
  "read",
  "readTable",
  "assert",
  "dialog",
]);
export type InstructionKind = z.infer<typeof InstructionKindSchema>;

const instructionSchemaImpl = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("navigate"), route: RouteIdSchema }),
  /** Not `click`. The artifact says what the operator MEANT; the surface says how that is done
   *  here - a click on a browser, a function key read off the legend line on a character grid.
   *  This one rename is the whole cross-surface claim. */
  z.strictObject({ kind: z.literal("activate") }),
  /** Replaces; it does not append. Appending depends on the field's prior content, which is
   *  exactly the hidden input a deterministic language must not have. `mode` exists so that a
   *  future "append" is a schema change rather than a surprise. */
  z.strictObject({
    kind: z.literal("fill"),
    value: SafeValueRefSchema,
    mode: z.literal("replace"),
  }),
  z.strictObject({ kind: z.literal("select"), option: SafeTextMatcherSchema }),
  /** Sets a state; it does not toggle. `toggle` is order-dependent and therefore not replayable:
   *  replaying it against a screen that remembered the last choice produces the opposite result. */
  z.strictObject({ kind: z.literal("setToggle"), checked: z.boolean() }),
  z.strictObject({ kind: z.literal("pressKey"), key: ArtifactKeySchema }),
  z.strictObject({ kind: z.literal("read") }),
  /** Bounded iteration, and that is why it is allowed: an observation holds finitely many nodes,
   *  and this walks that finite set once without acting or re-observing. Iteration over
   *  OBSERVATIONS - "for each row, click it and come back" - is refused, because it is unbounded in
   *  actions and destroys the static effect analysis. */
  z.strictObject({ kind: z.literal("readTable") }),
  z.strictObject({ kind: z.literal("assert") }),
  z.strictObject({
    kind: z.literal("dialog"),
    accept: z.boolean(),
    text: z.string().max(1024).nullable(),
  }),
]);
export interface InstructionSchemaType extends SchemaIdentity<typeof instructionSchemaImpl> {}
export const InstructionSchema: InstructionSchemaType = instructionSchemaImpl;

export type Instruction = DeepReadonly<z.infer<typeof InstructionSchema>>;

const ACTING_INSTRUCTIONS: ReadonlySet<InstructionKind> = new Set([
  "navigate",
  "activate",
  "fill",
  "select",
  "setToggle",
  "pressKey",
  "dialog",
]);

/** True for the instructions that dispatch something at the surface. Used for budget derivation
 *  and by the linker's action-count check. */
export function instructionActs(kind: InstructionKind): boolean {
  return ACTING_INSTRUCTIONS.has(kind);
}

/** Which target each instruction demands. SPEC section 3's table, as data. */
const TARGET_REQUIREMENT: Readonly<Record<InstructionKind, "required" | "forbidden" | "optional">> =
  {
    navigate: "forbidden",
    activate: "required",
    fill: "required",
    select: "required",
    setToggle: "required",
    pressKey: "optional",
    read: "forbidden",
    readTable: "forbidden",
    assert: "forbidden",
    dialog: "forbidden",
  };

/** The roles each value-setting instruction is allowed to act on. */
const TARGET_ROLES: Partial<Record<InstructionKind, readonly string[]>> = {
  fill: ["textbox", "combobox"],
  select: ["combobox", "listbox"],
  setToggle: ["checkbox", "radio"],
};

// ---------------------------------------------------------------------------------------------
// Waiting, budgets, extraction
// ---------------------------------------------------------------------------------------------

const settlePolicyBaseSchemaImpl = z.strictObject({
  stableSamples: z.int().min(1).max(10),
  pollIntervalMs: z.int().min(10).max(5_000),
  maxWaitMs: z.int().min(100).max(120_000),
  /** Declared busy indicators: while any matches, we are not settled regardless of the digest.
   *  A legacy app that swaps a frame's contents can be digest-stable for one poll interval
   *  mid-swap, and the torn read that follows is the thing rule 3 of section 0 exists to stop. */
  busyWhen: BoundedPredicateSchema.optional(),
});
/**
 * The field shapes, without the coherence check.
 *
 * An overlay may override a settle policy field by field, and a `Partial<SettlePolicy>` cannot
 * satisfy a cross-field rule about three values when only one of them is present. So the shape and
 * the rule are separated: the base is what a partial override is built from, and the linker
 * re-applies the rule to the MERGED policy, which is the only place it is meaningful anyway.
 */
export interface SettlePolicyBaseSchemaType
  extends SchemaIdentity<typeof settlePolicyBaseSchemaImpl> {}
export const SettlePolicyBaseSchema: SettlePolicyBaseSchemaType = settlePolicyBaseSchemaImpl;

const settlePolicySchemaImpl = SettlePolicyBaseSchema.refine(
  (s) => s.pollIntervalMs * s.stableSamples <= s.maxWaitMs,
  {
    error:
      "maxWaitMs is too small to collect stableSamples at pollIntervalMs, so this step can never settle",
  },
);
export interface SettlePolicySchemaType extends SchemaIdentity<typeof settlePolicySchemaImpl> {}
export const SettlePolicySchema: SettlePolicySchemaType = settlePolicySchemaImpl;

export type SettlePolicy = DeepReadonly<z.infer<typeof SettlePolicySchema>>;

/**
 * Documented defaults, applied by a RECORDER when it writes a document - never by the validator.
 * SPEC section 2.4 rule 3 forbids parse-time defaults, so nothing here can move an existing
 * artifact's digest or its approval signature; the sole consumer is
 * `packages/discovery/src/synthesis/emit.ts`, and it applies them at emission.
 *
 * `stableSamples` WAS a placeholder pending measurement (OPEN-QUESTIONS-RESOLVED Q6). It is not any
 * more. The measurement is `packages/conformance/src/settle-sweep.ts`, printed by
 *
 *     pnpm -F @crr/conformance stability
 *
 * which sweeps n = 1..4 over a ladder of quiescence faults and reports, for each value, which
 * control cases it gets right and what it costs:
 *
 *     value  controls  happy-path cost               rejects tears up to
 *     n=1     4/4      7p  / 7 settles = 1.0/step    0 consecutive polls
 *     n=2     4/4      14p / 7 settles = 2.0/step    1 consecutive polls
 *     n=3     4/4      21p / 7 settles = 3.0/step    2 consecutive polls
 *     n=4     4/4      28p / 7 settles = 4.0/step    3 consecutive polls
 *
 * THE LAW THE SWEEP MEASURED, obeyed by all four values: `stableSamples = n` rejects a torn read
 * that persists for up to n-1 consecutive polls, and accepts one that persists for n. The only torn
 * read this project has measured against a real surface is in
 * `docs/design/spike-terminal-surface.md` section 4 - a repaint delivered 55% complete, then 120 ms
 * of silence against a 60 ms quiet window - and it is TWO consecutive polls wide. `n = 2` accepts
 * it: the sweep's `tear-2` row returns `failed:checkpoint-failed` at n=2 where the correct answer is
 * `ok`. `n = 3` is the smallest value that is correct on all four control cases AND rejects a tear
 * as wide as the one actually observed; above it, the default would be defending a width nobody
 * here has seen, at one extra `perceive()` and one extra observation-ledger charge per settled step.
 *
 * WHAT THE NUMBER DOES NOT BUY, also measured: the sweep's `tear-persistent` row returns
 * `failed:checkpoint-failed` at EVERY value of n. A tear that never clears is accepted by every
 * setting of `stableSamples` and is caught by the CHECKPOINT. Raising this number narrows a window;
 * it does not make quiescence a readiness signal, and no value of it would.
 */
export const SETTLE_POLICY_DEFAULTS = {
  stableSamples: 3,
  pollIntervalMs: 150,
  maxWaitMs: 8_000,
} as const;

const stepBudgetsSchemaImpl = z.strictObject({
  perRecoveryMaxAttempts: z.record(z.string().min(1).max(64), z.int().min(1).max(10)),
  /** Total remedies applied to THIS step across all recoveries. Separate from the per-recovery
   *  budget because two recoveries can ping-pong - dismiss dialog, which triggers a reload, which
   *  triggers the dialog - with neither one exceeding its own. */
  maxRemediationCycles: z.int().min(0).max(20),
});
export interface StepBudgetsSchemaType extends SchemaIdentity<typeof stepBudgetsSchemaImpl> {}
export const StepBudgetsSchema: StepBudgetsSchemaType = stepBudgetsSchemaImpl;

export type StepBudgets = DeepReadonly<z.infer<typeof StepBudgetsSchema>>;

const runBudgetsSchemaImpl = z.strictObject({
  maxActions: z.int().min(1).max(1_000),
  maxObservations: z.int().min(1).max(10_000),
  maxTotalRemediations: z.int().min(0).max(100),
  /** Default 1: restart is off unless somebody turned it on deliberately. */
  maxProgramAttempts: z.int().min(1).max(5),
  deadlineMs: z.int().min(1_000).max(3_600_000),
});
export interface RunBudgetsSchemaType extends SchemaIdentity<typeof runBudgetsSchemaImpl> {}
export const RunBudgetsSchema: RunBudgetsSchemaType = runBudgetsSchemaImpl;

export type RunBudgets = DeepReadonly<z.infer<typeof RunBudgetsSchema>>;

const extractSpecSchemaImpl = z
  .strictObject({
    /** Must name a declared contract output or outcome payload field. The linker owns that check,
     *  because it is the one that needs the contract in hand. */
    output: z
      .string()
      .regex(/^[a-z][A-Za-z0-9_]*$/, { error: "an output name is a field name" })
      .max(64),
    from: ExtractorIdSchema,
    where: NodeQuerySchema,
    parse: ParserIdSchema,
    normalize: NormalizerIdSchema,
    /**
     * Returning `{ balance: null }` to an agent is how a member gets told their balance is nothing.
     * A missing required output is `output-extraction-failed`, not a partial success, so "fail" is
     * the documented default and "null" has to be asked for.
     */
    onMissing: z.enum(["fail", "null"]),
    /**
     * `readTable` only: the SURFACE half of a table read, keyed by the CONTRACT's column name.
     *
     * The contract declares a table output's columns by the names the CALLER's generated types use
     * - `Share Account`, `Opened`. Without this field, `readTable` matches those names directly
     * against the strings the grid prints above its columns, which quietly makes the contract carry
     * surface vocabulary and breaks SPEC section 0's fourth decision: a contract is types and
     * outcome names with ZERO surface detail, precisely so that one contract can be implemented by
     * a browser program and a green-screen one.
     *
     * The concrete failure it existed to cause, found by build unit 19 against the real fixture:
     * `fixtures/corebank-web`'s second tenant prints `Savings Account` and `Savings Balance` where
     * the first prints `Share Account` and `Share Balance`. That is a per-tenant label change - the
     * single most common one there is, and the exact case SPEC section 9.3 makes the vocabulary
     * token the hinge for - and it was UNREACHABLE by an overlay, because an overlay may not touch
     * a contract and nothing on the artifact stood between the two. The whole flow replayed green
     * at the second tenant except this one read.
     *
     * So the mapping lives here, on the artifact, expressed as a `TextMatcher` like every other
     * piece of surface vocabulary in this document - which means it can be a `token`, which means a
     * nine-line overlay reaches it. A column the map does not name keeps matching by its declared
     * name, so this is additive and every artifact written before it still links.
     */
    columnHeaders: z.record(z.string().min(1).max(128), SafeTextMatcherSchema).optional(),
    /** `readTable` only. Silent truncation of a member's share list is exactly the quiet wrongness
     *  this design exists to prevent, so `onTruncate` has one legal value. */
    rows: z
      .strictObject({
        minRows: z.int().min(1).max(10_000),
        maxRows: z.int().min(1).max(10_000),
        onTruncate: z.literal("fail"),
      })
      .optional(),
  })
  .refine((e) => e.rows === undefined || e.rows.maxRows >= e.rows.minRows, {
    error: "maxRows must be at least minRows",
  });
export interface ExtractSpecSchemaType extends SchemaIdentity<typeof extractSpecSchemaImpl> {}
export const ExtractSpecSchema: ExtractSpecSchemaType = extractSpecSchemaImpl;

export type ExtractSpec = DeepReadonly<z.infer<typeof ExtractSpecSchema>>;

// ---------------------------------------------------------------------------------------------
// Outcomes, recoveries, remedies
// ---------------------------------------------------------------------------------------------

export const PrioritySchema = z.int().nonnegative().max(1000);

const outcomeRuleSchemaImpl = z.strictObject({
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, { error: "an outcome code is SCREAMING_SNAKE_CASE" })
    .max(64),
  detect: BoundedPredicateSchema,
  /** Lower wins, unique within a step's own declared rules. A tie that survives - because an
   *  ambient rule or an overlay-added rule reached this step - is `ambiguous-classification` and a
   *  hard stop, never a coin flip. */
  priority: PrioritySchema,
  /**
   * Literal `post`, not configurable. A MEMBER_NOT_FOUND detector must not fire BEFORE the search
   * that would produce it, and a stale banner from a previous submit must not be read as this
   * step's answer.
   */
  phase: z.literal("post"),
  /**
   * Literal `true`, not configurable. Rule 3 of section 0: no negative business outcome may be
   * classified against a surface that has not demonstrably settled. The terminal spike measured
   * the torn read that vindicates it - a snapshot taken after 120ms of silence mid-repaint yielded
   * a null screen id and three nodes instead of eight. Against that screen, "no member found" is
   * indistinguishable from "not painted yet", and one of those answers is a compliance incident.
   */
  requiresSettled: z.literal(true),
  /** Extraction for the outcome's OWN payload, read from the SAME observation that matched. */
  capture: z.array(ExtractSpecSchema).max(16).readonly(),
});
/** The step's half of an outcome: the detector, linked to a contract declaration by `code`. */
export interface OutcomeRuleSchemaType extends SchemaIdentity<typeof outcomeRuleSchemaImpl> {}
export const OutcomeRuleSchema: OutcomeRuleSchemaType = outcomeRuleSchemaImpl;

export type OutcomeRule = DeepReadonly<z.infer<typeof OutcomeRuleSchema>>;

const remedyInstructionSchemaImpl = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("activate"), target: TargetRefSchema }),
  z.strictObject({
    kind: z.literal("pressKey"),
    target: TargetRefSchema.nullable(),
    key: ArtifactKeySchema,
  }),
  z.strictObject({ kind: z.literal("setToggle"), target: TargetRefSchema, checked: z.boolean() }),
  z.strictObject({
    kind: z.literal("select"),
    target: TargetRefSchema,
    option: SafeTextMatcherSchema,
  }),
  z.strictObject({ kind: z.literal("fill"), target: TargetRefSchema, value: SafeValueRefSchema }),
  z.strictObject({ kind: z.literal("navigate"), route: RouteIdSchema }),
]);
export interface RemedyInstructionSchemaType
  extends SchemaIdentity<typeof remedyInstructionSchemaImpl> {}
export const RemedyInstructionSchema: RemedyInstructionSchemaType = remedyInstructionSchemaImpl;

export type RemedyInstruction = DeepReadonly<z.infer<typeof RemedyInstructionSchema>>;

const remedySchemaImpl = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("actions"),
    instructions: z.array(RemedyInstructionSchema).min(1).max(4).readonly(),
  }),
  z.strictObject({ kind: z.literal("dismiss-native-dialog"), accept: z.boolean() }),
  /** Delegated to the session broker: the program never logs in. */
  z.strictObject({ kind: z.literal("reauthenticate") }),
  z.strictObject({
    kind: z.literal("escalate"),
    reason: z.string().min(1).max(200),
    brief: z.string().min(1).max(2000),
  }),
]);
/**
 * THERE IS NO `wait` REMEDY.
 *
 * Transient slowness needs no remedy - it is the settle budget doing its job. "Wait and retry" is
 * the degenerate recovery rule that becomes an unbounded retry loop in every system that permits
 * it, and stacking a five-second wait on a step that already declares a twelve-second settle budget
 * gives one step two independent waiting knobs and twenty-two seconds of stall. `SettlePolicy` is
 * the only way to express waiting.
 *
 * A remedy may only clear an obstacle and hand control back. Note what is absent from the
 * instruction list: no read, no extract, no assert, no nested recovery, no outcome. A remedy cannot
 * bind a value, cannot classify, and cannot recurse.
 */
export interface RemedySchemaType extends SchemaIdentity<typeof remedySchemaImpl> {}
export const RemedySchema: RemedySchemaType = remedySchemaImpl;

export type Remedy = DeepReadonly<z.infer<typeof RemedySchema>>;

const recoveryRuleSchemaImpl = z
  .strictObject({
    name: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, { error: "a recovery name is SCREAMING_SNAKE_CASE" })
      .max(64),
    band: z.enum(["environment", "interception", "recoverable"]),
    detect: BoundedPredicateSchema,
    priority: PrioritySchema,
    /** Recoveries commonly need `both`: a session-expiry banner already on screen when the step
     *  begins must be handled, not clicked through. */
    phase: z.enum(["pre", "post", "both"]),
    remedy: RemedySchema,
    maxAttempts: z.int().min(1).max(10),
    /** Only an `environment` recovery may set this. An error page is WHY the surface will never
     *  settle, so an environment detector has to be able to fire on an unsettled screen - and
     *  nothing else does, because everything else would then be reading a half-painted page. */
    allowUnsettled: z.boolean(),
    /** The ONLY legal value, present as a field so the constraint is visible in the artifact a
     *  human reviews rather than buried in engine source: a remedy can never set the program
     *  counter. */
    afterRemedy: z.literal("reverify"),
    resume: z.enum(["retry-step", "restart-from-checkpoint", "restart-program", "escalate"]),
    resumeAt: StepIdSchema.optional(),
  })
  .superRefine((r, ctx) => {
    if (r.allowUnsettled && r.band !== "environment") {
      ctx.addIssue(
        `allowUnsettled is only available to an environment recovery; ${r.name} is in band ${r.band}`,
      );
    }
    if (r.resume === "restart-from-checkpoint" && r.resumeAt === undefined) {
      ctx.addIssue(`${r.name} restarts from a checkpoint but names no resumeAt step`);
    }
    if (r.resume !== "restart-from-checkpoint" && r.resumeAt !== undefined) {
      ctx.addIssue(`${r.name} names a resumeAt step but its resume mode is ${r.resume}`);
    }
  });
export interface RecoveryRuleSchemaType extends SchemaIdentity<typeof recoveryRuleSchemaImpl> {}
export const RecoveryRuleSchema: RecoveryRuleSchemaType = recoveryRuleSchemaImpl;

export type RecoveryRule = DeepReadonly<z.infer<typeof RecoveryRuleSchema>>;

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

const deltaAssertionSchemaImpl = z.strictObject({
  /**
   * Deliberately the WEAKEST useful assertion: something observable must have changed. A strict
   * delta overfits the recording and turns benign rendering differences into failures. Weak as it
   * is, this is the only thing that catches "the click dispatched and nothing happened", which is
   * otherwise indistinguishable from success on a page that looks similar before and after.
   */
  mustChange: z.boolean(),
  navigatedTo: RouteIdSchema.optional(),
  changedContainers: z.array(ContainerMatcherSchema).max(8).readonly().optional(),
  focusMovedInto: ContainerMatcherSchema.optional(),
});
export interface DeltaAssertionSchemaType extends SchemaIdentity<typeof deltaAssertionSchemaImpl> {}
export const DeltaAssertionSchema: DeltaAssertionSchemaType = deltaAssertionSchemaImpl;

export type DeltaAssertion = DeepReadonly<z.infer<typeof DeltaAssertionSchema>>;

const expectedDialogSchemaImpl = z.strictObject({
  /**
   * WHICH dialog. A `NodeQuery`, not a `TargetRef`: this names a thing to be RECOGNISED, not a
   * thing to be acted on, so it is existential and carries no quorum - the same distinction
   * `OutcomeRule.detect` makes. Linker check 25 requires it to constrain `role: "dialog"`, so the
   * clause can never be widened into "any node I can name excuses any interception".
   */
  where: NodeQuerySchema,
  /**
   * `true` when this step's action RAISES the dialog - the dialog is this step's postcondition.
   * `false` when this step's action ANSWERS it - its ABSENCE is the postcondition, and the
   * declaration exists so that the dialog already on screen when the step BEGINS is not read as an
   * interception.
   *
   * The licence and the obligation are one field on purpose. A clause that only told band B2 to
   * stand down would let a step declare a dialog and then never check it, which is a step that
   * walks past a modal; a clause that only told band B5 what to assert would still be refused by
   * B2 before B5 ever ran. Both halves have to move together or the field is a hole.
   */
  present: z.boolean(),
});
/**
 * A DECLARED, EXPECTED dialog - SPEC section 4.4's amendment, and the resolution of what
 * `docs/design/FINAL-STATUS.md` section 7.3 called the highest-value open design question in the
 * repo. It is the clause that document names `expectDialog`.
 *
 * The band order runs B2 (interception) before B5 (checkpoint), so a confirmation dialog could not
 * be a step's expected postcondition and the fixture's write flow was unreachable. That ordering is
 * still right for what it was defending - what is visible BEHIND a modal is stale by construction -
 * but it proved one thing too many. "Every dialog is an interruption" is false: a confirmation
 * dialog is the postcondition of the click that raised it, and an interruption is by definition
 * something nobody declared.
 *
 * So B2 stands down for the dialog THIS STEP DECLARED and for nothing else, and B5 adjudicates. The
 * fail-closed guarantee is untouched, and is untouched STRUCTURALLY rather than by discipline:
 * every open dialog in the observation must be the declared one, so an undeclared dialog - alone,
 * or alongside the declared one - is still `undeclared-dialog`.
 *
 * The clause is deliberately confined to the IN-PAGE channel: `Observation.nativeDialog` blocks the
 * renderer, so a `window.confirm` has no post-act observation to check a postcondition against and
 * a postcondition that cannot be checked is not a postcondition. A native dialog therefore remains
 * exactly what it is today - an interception - and the classifier refuses to apply this clause when
 * one is open. That is a property of the channel and not a gap in the effort; the site is
 * `declaredInterception` in `classify.ts`.
 */
export interface ExpectedDialogSchemaType extends SchemaIdentity<typeof expectedDialogSchemaImpl> {}
export const ExpectedDialogSchema: ExpectedDialogSchemaType = expectedDialogSchemaImpl;

export type ExpectedDialog = DeepReadonly<z.infer<typeof ExpectedDialogSchema>>;

const checkpointSchemaImpl = z.strictObject({
  predicate: BoundedPredicateSchema,
  delta: DeltaAssertionSchema,
  /** Continuity ids that must hold here. */
  continuity: z.array(z.string().min(1).max(64)).max(8).readonly(),
  /**
   * The dialog this step transacts with, when it has one. OPTIONAL, and that is the one place this
   * schema's "no optional fields" instinct is wrong: the artifact is content-addressed and an
   * approval signs the address, so a required `dialog: null` would move the digest of every
   * artifact ever recorded in order to say the thing their absence already says. Absent means what
   * it has always meant - this step expects no dialog, and any dialog is an interception.
   */
  dialog: ExpectedDialogSchema.optional(),
});
/**
 * Note there is no `describes` string. Failure prose is GENERATED by a fold over the predicate and
 * the target. Authored prose drifts from the predicate it claims to describe - it is written once
 * and the predicate is edited twice - and a fold cannot.
 */
export interface CheckpointSchemaType extends SchemaIdentity<typeof checkpointSchemaImpl> {}
export const CheckpointSchema: CheckpointSchemaType = checkpointSchemaImpl;

export type Checkpoint = DeepReadonly<z.infer<typeof CheckpointSchema>>;

const stepSchemaImpl = z
  .strictObject({
    id: StepIdSchema,
    /** HUMAN-ONLY prose, from the model's own words at discovery. The engine must not read it; a
     *  contract test asserts `title` and `intent` are referenced nowhere outside serialization and
     *  rendering. An engine that reads prose has put the model back in the decision loop by the
     *  side door. */
    title: z.string().min(1).max(200),
    intent: z.string().min(1).max(1000),

    effect: EffectClassSchema,
    instruction: InstructionSchema,
    target: TargetRefSchema.nullable(),
    precondition: BoundedPredicateSchema.nullable(),
    settle: SettlePolicySchema,
    /**
     * NON-OPTIONAL. A step with no postcondition cannot be recorded - the recorder refuses and the
     * schema has no way to express it. It is the strongest single defence against blindly
     * proceeding that is available, and it costs one required field.
     */
    expect: CheckpointSchema,

    /** Detectors live HERE, not on the contract. */
    outcomes: z.array(OutcomeRuleSchema).max(16).readonly(),
    recoveries: z.array(RecoveryRuleSchema).max(16).readonly(),
    extract: z.array(ExtractSpecSchema).max(32).readonly(),
    budgets: StepBudgetsSchema,
    evidence: z.strictObject({
      captureOn: z
        .array(z.enum(["failure", "outcome", "always"]))
        .max(3)
        .readonly(),
    }),
  })
  .superRefine((step, ctx) => {
    const kind = step.instruction.kind;
    const requirement = TARGET_REQUIREMENT[kind];
    if (requirement === "required" && step.target === null) {
      ctx.addIssue(`step ${step.id}: a ${kind} instruction needs a target`);
    }
    if (requirement === "forbidden" && step.target !== null) {
      ctx.addIssue(
        `step ${step.id}: a ${kind} instruction acts on no node, so it may not carry a target`,
      );
    }
    const roles = TARGET_ROLES[kind];
    if (roles !== undefined && step.target !== null && !roles.includes(step.target.role)) {
      ctx.addIssue(
        `step ${step.id}: a ${kind} instruction needs a target whose role is one of ${roles.join(", ")}, not ${step.target.role}`,
      );
    }
    if ((kind === "read" || kind === "readTable" || kind === "assert") && step.effect !== "READ") {
      ctx.addIssue(
        `step ${step.id}: a ${kind} instruction performs no action, so its effect is READ`,
      );
    }

    // Linker check 24, and its converse: `rows` is meaningful for exactly one instruction, and a
    // `readTable` without bounds is an unbounded read of a member's account list.
    for (const spec of step.extract) {
      if (kind === "readTable" && spec.rows === undefined) {
        ctx.addIssue(
          `step ${step.id}: extraction of ${spec.output} from a readTable must declare row bounds`,
        );
      }
      if (kind !== "readTable" && spec.rows !== undefined) {
        ctx.addIssue(
          `step ${step.id}: extraction of ${spec.output} declares row bounds but the instruction is ${kind}`,
        );
      }
    }

    // Linker check 9. A tie inside one step's own declared set is an authoring mistake we can see
    // now, so it is a parse error rather than a runtime coin-flip nobody witnesses.
    reportDuplicates(
      ctx,
      `step ${step.id} outcome code`,
      step.outcomes.map((o) => o.code),
    );
    reportDuplicates(
      ctx,
      `step ${step.id} outcome priority`,
      step.outcomes.map((o) => String(o.priority)),
    );
    reportDuplicates(
      ctx,
      `step ${step.id} recovery name`,
      step.recoveries.map((r) => r.name),
    );
    reportDuplicates(
      ctx,
      `step ${step.id} recovery priority`,
      step.recoveries.map((r) => String(r.priority)),
    );
    reportDuplicates(
      ctx,
      `step ${step.id} extracted output`,
      step.extract.map((e) => e.output),
    );

    // Save-time invariant 3. Once an irreversible action is in flight, a remedy that presses more
    // buttons is how a member gets two sub-accounts; the only safe move is to stop and ask a human.
    if (step.effect === "WRITE_IRREVERSIBLE") {
      for (const r of step.recoveries) {
        if (r.remedy.kind === "actions") {
          ctx.addIssue(
            `step ${step.id} is irreversible, so recovery ${r.name} may not remedy by performing actions`,
          );
        }
        if (r.resume !== "escalate") {
          ctx.addIssue(
            `step ${step.id} is irreversible, so recovery ${r.name} must resume by escalating, not by ${r.resume}`,
          );
        }
      }
    }

    for (const r of step.recoveries) {
      const budget = step.budgets.perRecoveryMaxAttempts[r.name];
      if (budget !== undefined && budget < r.maxAttempts) {
        ctx.addIssue(
          `step ${step.id}: the step budget for ${r.name} (${budget}) is below the recovery's own maxAttempts (${r.maxAttempts})`,
        );
      }
    }
  });
export interface StepSchemaType extends SchemaIdentity<typeof stepSchemaImpl> {}
export const StepSchema: StepSchemaType = stepSchemaImpl;

export type Step = DeepReadonly<z.infer<typeof StepSchema>>;

const resolvedStepSchemaImpl = StepSchema.extend({
  index: z.int().nonnegative(),
  route: z
    .strictObject({
      originAlias: OriginAliasSchema,
      path: z.string().startsWith("/").max(512),
    })
    .nullable(),
});
/**
 * A step after overlay merge and argument binding, as the policy engine and the classifier see it.
 *
 * SPEC section 2.8 and section 4.1 both name `ResolvedStep` and neither defines it; this is the
 * definition, and it is deliberately the smallest one that works - the step's own document plus the
 * two facts that resolution adds. Where the step sits in the program, because a policy decision
 * about an irreversible action depends on what has already run; and where the action would land,
 * canonicalized by the driver, because an allowlist is checked against a route rather than against
 * an intention.
 */
export interface ResolvedStepSchemaType extends SchemaIdentity<typeof resolvedStepSchemaImpl> {}
export const ResolvedStepSchema: ResolvedStepSchemaType = resolvedStepSchemaImpl;

export type ResolvedStep = DeepReadonly<z.infer<typeof ResolvedStepSchema>>;

const continuityDefSchemaImpl = z.strictObject({
  id: z.string().min(1).max(64),
  source: SafeValueRefSchema,
  compare: z.strictObject({ via: NormalizerIdSchema, type: ValueTypeSchema }),
});
/**
 * A named value that flows through the run and must be RE-OBSERVED at declared waypoints. This is
 * what turns "a member detail page loaded" into "THE member detail page for the member we were
 * asked about", and it is the control that catches landing on the wrong record even when the click
 * itself was unambiguous - for instance when the app's own search silently corrected the id.
 *
 * Comparison is NORMALIZED rather than identity: "12345" in the search box and "Member #12345" in
 * the detail heading are the same subject.
 */
export interface ContinuityDefSchemaType extends SchemaIdentity<typeof continuityDefSchemaImpl> {}
export const ContinuityDefSchema: ContinuityDefSchemaType = continuityDefSchemaImpl;

export type ContinuityDef = DeepReadonly<z.infer<typeof ContinuityDefSchema>>;

// ---------------------------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------------------------

const flowSchemaImpl = z
  .strictObject({
    entry: z.strictObject({ route: RouteIdSchema, precondition: BoundedPredicateSchema }),
    routes: z.array(RoutePatternSchema).min(1).max(64).readonly(),

    /**
     * THE MULTI-TENANT HINGE. Label synonyms declared ONCE and referenced by token from every
     * descriptor, detector, row key and checkpoint. An overlay REPLACES a token's list, so a tenant
     * that says "Member #" and "Find" needs a nine-line overlay rather than an edit at forty
     * matchers. Resolution takes the first synonym that resolves a UNIQUE node; two synonyms
     * resolving DIFFERENT nodes is an ambiguity, not a preference.
     */
    vocabulary: z.record(
      LabelTokenSchema,
      z.array(z.string().min(1).max(128)).min(1).max(16).readonly(),
    ),

    /** Steps that are safe idempotent re-entry points. */
    resumePoints: z.array(StepIdSchema).max(32).readonly(),

    /** A straight line. No branching, no loops, no conditionals. */
    steps: z.array(StepSchema).min(1).max(64).readonly(),

    /** Evaluated at EVERY step, because session expiry does not respect step boundaries. Ambient
     *  rules are recoveries and environment conditions only - the type has no slot for a business
     *  outcome, because an outcome that can fire at any step is an outcome nobody scoped. */
    ambient: z.array(RecoveryRuleSchema).max(16).readonly(),
  })
  .superRefine((flow, ctx) => {
    const stepIds = flow.steps.map((s) => s.id);
    reportDuplicates(ctx, "step id", stepIds);
    reportDuplicates(
      ctx,
      "route id",
      flow.routes.map((r) => r.id),
    );
    reportDuplicates(ctx, "resume point", flow.resumePoints);
    reportDuplicates(
      ctx,
      "ambient recovery name",
      flow.ambient.map((r) => r.name),
    );
    reportDuplicates(
      ctx,
      "ambient recovery priority",
      flow.ambient.map((r) => String(r.priority)),
    );

    const routeIds = new Set<string>(flow.routes.map((r) => r.id));
    if (!routeIds.has(flow.entry.route)) {
      ctx.addIssue(`the entry route ${flow.entry.route} is not declared in flow.routes`);
    }
    for (const route of collectRouteRefs(flow)) {
      if (!routeIds.has(route)) ctx.addIssue(`route ${route} is referenced but not declared`);
    }

    const stepIndex = new Map(stepIds.map((id, i) => [id as string, i]));
    for (const point of flow.resumePoints) {
      if (!stepIndex.has(point)) ctx.addIssue(`resume point ${point} is not a step in this flow`);
    }

    // Linker check 6, the intra-artifact half. An output written twice is a race between two
    // screens for what the caller is told, and it is invisible at review because the two writes are
    // forty lines apart. An outcome's `capture` bindings are deliberately NOT counted here: they
    // live in a terminal namespace that no step can read, so an outcome payload field and a
    // contract output may share a name without either shadowing the other.
    reportDuplicates(
      ctx,
      "written output",
      flow.steps.flatMap((s) => s.extract.map((e) => e.output)),
    );

    // Linker check 5, the intra-artifact half: a value may only come from a STRICTLY EARLIER step.
    // The straight-line rule makes "earlier" unambiguous, which is one of the quieter payoffs of
    // refusing branches.
    flow.steps.forEach((step, i) => {
      for (const ref of collectValueRefs(step)) {
        if (ref.from !== "output") continue;
        const producer = stepIndex.get(ref.step);
        if (producer === undefined) {
          ctx.addIssue(`step ${step.id} reads output ${ref.output} from unknown step ${ref.step}`);
        } else if (producer >= i) {
          ctx.addIssue(
            `step ${step.id} reads output ${ref.output} from step ${ref.step}, which does not run earlier`,
          );
        }
      }
    });

    // Linker check 19 / save-time invariant 4. Restarting across an irreversible step is how a
    // retry opens two sub-accounts, and the straight-line program makes the check a scan.
    flow.steps.forEach((step, i) => {
      for (const r of step.recoveries) {
        if (r.resume !== "restart-from-checkpoint" || r.resumeAt === undefined) continue;
        const at = stepIndex.get(r.resumeAt);
        if (at === undefined) continue;
        if (!flow.resumePoints.includes(r.resumeAt)) {
          ctx.addIssue(
            `recovery ${r.name} restarts at ${r.resumeAt}, which is not declared in flow.resumePoints`,
          );
        }
        if (at > i) {
          ctx.addIssue(
            `recovery ${r.name} restarts at ${r.resumeAt}, which runs after step ${step.id}`,
          );
        }
        for (let k = at; k < i; k += 1) {
          const between = flow.steps[k];
          if (between !== undefined && between.effect === "WRITE_IRREVERSIBLE") {
            ctx.addIssue(`recovery ${r.name} would restart across irreversible step ${between.id}`);
          }
        }
      }
    });

    // The hinge only works if every token has somewhere to resolve. An overlay REPLACES a token's
    // synonyms, so a token absent from the base has nothing to replace and would silently never
    // match at any tenant.
    const declared = new Set(Object.keys(flow.vocabulary));
    for (const token of collectLabelTokens(flow)) {
      if (!declared.has(token)) {
        ctx.addIssue(`label token ${token} is referenced but not declared in flow.vocabulary`);
      }
    }
  });
export interface FlowSchemaType extends SchemaIdentity<typeof flowSchemaImpl> {}
export const FlowSchema: FlowSchemaType = flowSchemaImpl;

export type Flow = DeepReadonly<z.infer<typeof FlowSchema>>;

// ---------------------------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------------------------

export const VendorTargetSchema = z.strictObject({
  /** The vendor PRODUCT, not the tenant. This is the unit of reuse across hundreds of tenants. */
  product: z.string().min(1).max(128),
  productVersionRange: z.string().min(1).max(64),
  surfaceKind: SurfaceKindSchema,
  /** Surface features this program REQUIRES, refused at LOAD time against the driver's own
   *  advertisement rather than dying at step six with a mysterious target-not-found. */
  requires: z.array(SurfaceFeatureSchema).max(8).readonly(),
  /** A named credential/session profile. The artifact names the profile; it never carries the
   *  material, and the program never logs in. */
  sessionProfile: z.string().min(1).max(128),
});
export type VendorTarget = DeepReadonly<z.infer<typeof VendorTargetSchema>>;

const effectSummarySchemaImpl = z.strictObject({
  maxEffect: EffectClassSchema,
  irreversibleSteps: z.array(StepIdSchema).max(64).readonly(),
  routesTouched: z.array(RouteIdSchema).max(64).readonly(),
  reads: z
    .array(z.strictObject({ field: z.string().min(1).max(64), sensitivity: SensitivitySchema }))
    .max(64)
    .readonly(),
  requiresApproval: z.boolean(),
  /**
   * The largest program counter from which a restart is still safe. Computed STATICALLY before the
   * first action, because the program is straight-line - the clearest case in the whole design of a
   * refusal (no branching) buying a safety property (a provable restart gate).
   */
  restartSafeUpToPc: z.int().nonnegative(),
});
export interface EffectSummarySchemaType extends SchemaIdentity<typeof effectSummarySchemaImpl> {}
export const EffectSummarySchema: EffectSummarySchemaType = effectSummarySchemaImpl;

export type EffectSummary = DeepReadonly<z.infer<typeof EffectSummarySchema>>;

const verificationSchemaImpl = z.strictObject({
  mode: z.enum(["replay-full", "replay-dry", "replay-reset"]),
  status: z.enum(["verified", "unverified"]),
  /** For a dry run: the last step actually executed before the irreversible boundary. */
  coveredThroughStep: StepIdSchema,
  /**
   * The grade an approver MUST read. `partial-up-to-irreversible` is not a lesser bug; it is a
   * different claim, and flattening it into a boolean `verified` would hide exactly the risk the
   * approval gate exists to weigh.
   */
  grade: z.enum(["full", "partial-up-to-irreversible"]),
  runId: RunIdSchema,
  at: TimestampSchema,
});
export interface VerificationSchemaType extends SchemaIdentity<typeof verificationSchemaImpl> {}
export const VerificationSchema: VerificationSchemaType = verificationSchemaImpl;

export type Verification = DeepReadonly<z.infer<typeof VerificationSchema>>;

export const SurfaceFingerprintSchema = z.strictObject({
  /** Per step: the multiset of (role, container path, name shape) over INTERACTIVE nodes plus the
   *  screen or route id, deliberately excluding the branding band. What you fingerprint matters -
   *  the terminal spike measured the same two tenants diverging 63% over all nodes and 40% over
   *  interactive nodes only. */
  perStep: z.record(StepIdSchema, z.string().min(1).max(128)),
});
export type SurfaceFingerprint = DeepReadonly<z.infer<typeof SurfaceFingerprintSchema>>;

const provenanceSchemaImpl = z
  .strictObject({
    discoveryRunId: RunIdSchema,
    /**
     * The goal, PARAMETERIZED: "look up member {memberId} and read their savings balance". The same
     * mechanism that makes the capability reusable makes the provenance safe to commit - a goal
     * string is one of the easiest places to persist a real member number by accident, and here it
     * structurally cannot hold one.
     */
    goalTemplate: z.string().min(1).max(2000),
    model: z.strictObject({
      adapter: z.enum(["anthropic", "openai", "agent-sdk", "replay"]),
      modelId: z.string().min(1).max(128),
      promptVersion: z.string().min(1).max(64),
    }),
    /** A POINTER, never the transcript: an embedded one is an unbounded surface for regulated data
     *  and would recouple the artifact to the raw model exchange. */
    transcriptRef: z
      .strictObject({ digest: DigestSchema, uri: z.string().min(1).max(1024) })
      .nullable(),
    recordedAt: TimestampSchema,
    recordedAgainst: z.strictObject({
      tenantId: TenantIdSchema,
      appInstanceId: AppInstanceIdSchema,
      fingerprint: SurfaceFingerprintSchema,
    }),
  })
  .superRefine((p, ctx) => {
    const pii = piiShapeOf(p.goalTemplate);
    if (pii !== null) {
      ctx.addIssue(
        `the recorded goal has the shape of regulated data (${pii}); it must be parameterized, e.g. "member {memberId}"`,
      );
    }
  });
export interface ProvenanceSchemaType extends SchemaIdentity<typeof provenanceSchemaImpl> {}
export const ProvenanceSchema: ProvenanceSchemaType = provenanceSchemaImpl;

export type Provenance = DeepReadonly<z.infer<typeof ProvenanceSchema>>;

export const SignatureSchema = z.strictObject({
  over: DigestSchema,
  by: z.string().min(1).max(128),
  alg: z.literal("ed25519"),
  sig: z.string().min(1).max(512),
  at: TimestampSchema,
});
export type Signature = DeepReadonly<z.infer<typeof SignatureSchema>>;

const lifecycleSchemaImpl = z
  .strictObject({
    status: z.enum(["proposed", "draft", "approved", "deprecated"]),
    supersedes: z.int().positive().nullable(),
    approval: z
      .strictObject({
        approvedBy: z.string().min(1).max(128),
        approvedAt: TimestampSchema,
        signature: z.string().min(1).max(512),
        keyId: z.string().min(1).max(128),
        alg: z.literal("ed25519"),
        /** Signs the DIGEST, not the file, so an approved artifact cannot be silently edited. */
        over: DigestSchema,
        /** The human ticked these. "Who approved the irreversible one" is an audit answer. */
        acknowledgedEffects: z.array(EffectClassSchema).min(1).max(3).readonly(),
        acknowledgedGrade: z.enum(["full", "partial-up-to-irreversible"]),
      })
      .nullable(),
  })
  .superRefine((l, ctx) => {
    if (l.status === "approved" && l.approval === null) {
      ctx.addIssue("an approved artifact carries its approval; the signature is the approval");
    }
    if (l.status === "proposed" && l.approval !== null) {
      ctx.addIssue("a proposed artifact has not been verified yet, so it cannot carry an approval");
    }
  });
export interface LifecycleSchemaType extends SchemaIdentity<typeof lifecycleSchemaImpl> {}
export const LifecycleSchema: LifecycleSchemaType = lifecycleSchemaImpl;

export type Lifecycle = DeepReadonly<z.infer<typeof LifecycleSchema>>;

const policyRequirementsSchemaImpl = z.strictObject({
  originAliases: z.array(OriginAliasSchema).min(1).max(16).readonly(),
  maxEffect: EffectClassSchema,
  requiresApprovalToken: z.boolean(),
  redaction: z.strictObject({
    taintedParams: z.array(z.string().min(1).max(64)).max(32).readonly(),
    maskScreenshotRegions: z.boolean(),
  }),
});
export interface PolicyRequirementsSchemaType
  extends SchemaIdentity<typeof policyRequirementsSchemaImpl> {}
export const PolicyRequirementsSchema: PolicyRequirementsSchemaType = policyRequirementsSchemaImpl;

export type PolicyRequirements = DeepReadonly<z.infer<typeof PolicyRequirementsSchema>>;

const EFFECT_ORDER: Readonly<Record<EffectClass, number>> = {
  READ: 0,
  WRITE_REVERSIBLE: 1,
  WRITE_IRREVERSIBLE: 2,
};

const EFFECT_BY_RANK: readonly EffectClass[] = ["READ", "WRITE_REVERSIBLE", "WRITE_IRREVERSIBLE"];

/**
 * The static effect analysis, derived from the steps rather than believed from the document.
 *
 * `reads` is deliberately not derived here: an output's sensitivity lives on the contract, and this
 * module does not take a contract. The linker re-derives the whole summary with the contract in
 * hand (check 13); what the schema can do alone, it does.
 */
export function deriveEffectSummary(flow: {
  readonly entry: { readonly route: RouteId };
  readonly steps: readonly {
    readonly id: StepId;
    readonly effect: EffectClass;
    readonly instruction: { readonly kind: InstructionKind };
  }[];
}): {
  readonly maxEffect: EffectClass;
  readonly irreversibleSteps: readonly StepId[];
  readonly routesTouched: readonly RouteId[];
  readonly requiresApproval: boolean;
  readonly restartSafeUpToPc: number;
} {
  const irreversibleSteps: StepId[] = [];
  let maxRank = 0;
  let restartSafeUpToPc = flow.steps.length;
  flow.steps.forEach((step, i) => {
    const rank = EFFECT_ORDER[step.effect];
    if (rank > maxRank) maxRank = rank;
    if (step.effect === "WRITE_IRREVERSIBLE") {
      irreversibleSteps.push(step.id);
      if (i < restartSafeUpToPc) restartSafeUpToPc = i;
    }
  });
  const maxEffect: EffectClass = EFFECT_BY_RANK[maxRank] ?? "READ";
  const routes = new Set<RouteId>([flow.entry.route]);
  for (const route of collectRouteRefs(flow)) routes.add(route);
  return {
    maxEffect,
    irreversibleSteps,
    routesTouched: [...routes],
    requiresApproval: maxEffect === "WRITE_IRREVERSIBLE",
    restartSafeUpToPc,
  };
}

const capabilityArtifactSchemaImpl = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION_ARTIFACT),
    artifactId: ArtifactIdSchema,
    implements: z.strictObject({
      name: CapabilityNameSchema,
      version: ContractVersionSchema,
      contractDigest: DigestSchema,
    }),
    /** Monotonic per (capability, surface kind). */
    version: z.int().positive(),
    /** Over the canonical JSON of this document with `digest` and `signatures` removed. */
    digest: DigestSchema,

    target: VendorTargetSchema,
    lifecycle: LifecycleSchema,
    flow: FlowSchema,
    continuity: z.array(ContinuityDefSchema).max(16).readonly(),
    provenance: ProvenanceSchema,
    verification: VerificationSchema,
    policy: PolicyRequirementsSchema,
    /** DERIVED at save time and re-derived by the linker. Stored because a reviewer reads it. */
    effects: EffectSummarySchema,
    budgets: RunBudgetsSchema,
    signatures: z.array(SignatureSchema).max(8).readonly(),
  })
  .superRefine((a, ctx) => {
    const derived = deriveEffectSummary(a.flow);
    if (derived.maxEffect !== a.effects.maxEffect) {
      ctx.addIssue(
        `effects.maxEffect says ${a.effects.maxEffect} but the steps add up to ${derived.maxEffect}`,
      );
    }
    if (!sameSet(derived.irreversibleSteps, a.effects.irreversibleSteps)) {
      ctx.addIssue(
        `effects.irreversibleSteps does not match the steps: expected [${derived.irreversibleSteps.join(", ")}]`,
      );
    }
    if (!sameSet(derived.routesTouched, a.effects.routesTouched)) {
      ctx.addIssue(
        `effects.routesTouched does not match the program: expected [${derived.routesTouched.join(", ")}]`,
      );
    }
    if (derived.requiresApproval !== a.effects.requiresApproval) {
      ctx.addIssue("effects.requiresApproval is derived from maxEffect and does not match");
    }
    if (derived.restartSafeUpToPc !== a.effects.restartSafeUpToPc) {
      ctx.addIssue(
        `effects.restartSafeUpToPc says ${a.effects.restartSafeUpToPc} but the first irreversible step is at ${derived.restartSafeUpToPc}`,
      );
    }
    if (a.policy.maxEffect !== derived.maxEffect) {
      ctx.addIssue(
        `policy.maxEffect says ${a.policy.maxEffect} but the steps add up to ${derived.maxEffect}`,
      );
    }
    // Save-time invariant 9. If these could disagree, an irreversible capability could be invoked
    // without a token by editing one boolean.
    if (a.policy.requiresApprovalToken !== derived.requiresApproval) {
      ctx.addIssue(
        `policy.requiresApprovalToken is derived from the steps and should be ${derived.requiresApproval}`,
      );
    }

    const originAliases = new Set(a.policy.originAliases);
    for (const route of a.flow.routes) {
      if (!originAliases.has(route.originAlias)) {
        ctx.addIssue(
          `route ${route.id} uses origin alias ${route.originAlias}, which policy.originAliases does not permit`,
        );
      }
    }

    reportDuplicates(
      ctx,
      "continuity id",
      a.continuity.map((c) => c.id),
    );
    const continuityIds = new Set(a.continuity.map((c) => c.id));
    for (const step of a.flow.steps) {
      for (const ref of step.expect.continuity) {
        if (!continuityIds.has(ref)) {
          ctx.addIssue(`step ${step.id} asserts continuity ${ref}, which is not declared`);
        }
      }
    }
    for (const ref of collectContinuityRefs(a.flow)) {
      if (!continuityIds.has(ref)) {
        ctx.addIssue(`a predicate references continuity ${ref}, which is not declared`);
      }
    }

    // Save-time invariant 11. A confirmation screen is usually where the app finally prints the
    // identity of what it did; if it names the record, an undetectable wrong-target write collapses
    // into a detectable one. The strongest control in the document must not be optional on exactly
    // the flows it exists to protect - and if the confirmation genuinely does not name the record,
    // the artifact cannot reach draft and a human decides, which is the correct place for that.
    for (const step of a.flow.steps) {
      if (step.effect !== "WRITE_IRREVERSIBLE") continue;
      if (a.continuity.length === 0) {
        ctx.addIssue(
          `step ${step.id} is irreversible, so the flow must declare at least one continuity value`,
        );
      }
      if (step.expect.continuity.length === 0) {
        ctx.addIssue(
          `step ${step.id} is irreversible, so its checkpoint must assert a continuity value - otherwise nothing proves it acted on the right record`,
        );
      }
    }

    if (a.lifecycle.status !== "proposed" && a.verification.status !== "verified") {
      ctx.addIssue(
        `a ${a.lifecycle.status} artifact must have been verified by a replay with the model out of the loop`,
      );
    }
    if (a.lifecycle.approval !== null) {
      if (a.lifecycle.approval.over !== a.digest) {
        ctx.addIssue("the approval signs a digest other than this document's own");
      }
      if (a.lifecycle.approval.acknowledgedGrade !== a.verification.grade) {
        ctx.addIssue(
          `the approver acknowledged grade ${a.lifecycle.approval.acknowledgedGrade} but the verification recorded ${a.verification.grade}`,
        );
      }
      if (!a.lifecycle.approval.acknowledgedEffects.includes(a.effects.maxEffect)) {
        ctx.addIssue(
          `the approver did not acknowledge this artifact's maximum effect (${a.effects.maxEffect})`,
        );
      }
    }
    for (const sig of a.signatures) {
      if (sig.over !== a.digest) {
        ctx.addIssue(`signature by ${sig.by} is over a digest other than this document's own`);
      }
    }

    const stepIds = new Set<string>(a.flow.steps.map((s) => s.id));
    if (!stepIds.has(a.verification.coveredThroughStep)) {
      ctx.addIssue(
        `verification.coveredThroughStep names ${a.verification.coveredThroughStep}, which is not a step in this flow`,
      );
    }

    // Linker check 15, the intra-artifact half. A program whose budget cannot cover its own
    // declared recoveries is a link error, not a runtime surprise.
    const actingSteps = a.flow.steps.filter((s) => instructionActs(s.instruction.kind)).length;
    let remedyActions = 0;
    for (const step of a.flow.steps) {
      for (const r of step.recoveries) {
        if (r.remedy.kind === "actions")
          remedyActions += r.remedy.instructions.length * r.maxAttempts;
      }
    }
    for (const r of a.flow.ambient) {
      if (r.remedy.kind === "actions") {
        remedyActions += r.remedy.instructions.length * r.maxAttempts * a.flow.steps.length;
      }
    }
    if (a.budgets.maxActions < actingSteps + remedyActions) {
      ctx.addIssue(
        `budgets.maxActions is ${a.budgets.maxActions} but the program declares ${actingSteps} acting steps and up to ${remedyActions} remedy actions`,
      );
    }
  });
export interface CapabilityArtifactSchemaType
  extends SchemaIdentity<typeof capabilityArtifactSchemaImpl> {}
export const CapabilityArtifactSchema: CapabilityArtifactSchemaType = capabilityArtifactSchemaImpl;

export type CapabilityArtifact = DeepReadonly<z.infer<typeof CapabilityArtifactSchema>>;

// ---------------------------------------------------------------------------------------------
// Walkers
//
// These are structural scans over a plain JSON document rather than typed traversals of forty
// distinct shapes. That is a deliberate trade: a typed traversal has to be edited every time an
// arm is added and silently misses the arm somebody forgot, and the thing being checked here - "no
// reference escapes the document" - is exactly the kind of property that must not have a blind spot.
// ---------------------------------------------------------------------------------------------

type Unknown = Record<string, unknown>;

function walk(value: unknown, visit: (record: Unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Unknown;
  visit(record);
  for (const child of Object.values(record)) walk(child, visit);
}

/** Every `RouteId` a program can reach: a `navigate` instruction, a remedy navigate, or a declared
 *  navigation delta. */
export function collectRouteRefs(flow: unknown): readonly RouteId[] {
  const out: RouteId[] = [];
  walk(flow, (r) => {
    if (r.kind === "navigate" && typeof r.route === "string") out.push(r.route as RouteId);
    if (typeof r.navigatedTo === "string") out.push(r.navigatedTo as RouteId);
  });
  return out;
}

function collectValueRefs(
  value: unknown,
): readonly { readonly from: string; readonly step: string; readonly output: string }[] {
  const out: { from: string; step: string; output: string }[] = [];
  walk(value, (r) => {
    if (r.from === "output" && typeof r.step === "string" && typeof r.output === "string") {
      out.push({ from: "output", step: r.step, output: r.output });
    }
  });
  return out;
}

export function collectLabelTokens(value: unknown): readonly string[] {
  const out: string[] = [];
  walk(value, (r) => {
    if (r.mode === "token" && typeof r.token === "string") out.push(r.token);
  });
  return out;
}

function collectContinuityRefs(value: unknown): readonly string[] {
  const out: string[] = [];
  walk(value, (r) => {
    if (r.kind === "continuity" && typeof r.ref === "string") out.push(r.ref);
  });
  return out;
}

function reportDuplicates(
  ctx: { addIssue: (message: string) => void },
  label: string,
  values: readonly string[],
): void {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dupes.add(v);
    seen.add(v);
  }
  if (dupes.size > 0) ctx.addIssue(`duplicate ${label}(s): ${[...dupes].join(", ")}`);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (new Set(b).size !== b.length) return false;
  const left = new Set<string>(a);
  const right = new Set<string>(b);
  if (left.size !== right.size) return false;
  for (const v of left) if (!right.has(v)) return false;
  return true;
}
