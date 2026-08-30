// SPEC section 2.3 - the contract document: what the calling agent and the product owner see.
//
// THE CONTRACT IS SURFACE-FREE AND TENANT-FREE. It carries outcome NAMES and their payload types.
// It carries no detector, no container path, no frame name, no step id, no descriptor. That single
// factoring is what lets one contract be implemented by two artifacts - a browser program and a
// green-screen program - and it is what stops re-recording a flow from dangling every reference in
// the caller's public API.
//
// The rule is enforced structurally, not by convention: every object here is a `strictObject`, so a
// `detect` field on an `OutcomeDecl` is a parse error rather than a review comment. Detectors are
// `OutcomeRule`s on the artifact's steps and are linked to these declarations by `code` alone.

import { z } from "zod";
import {
  CapabilityNameSchema,
  ContractVersionSchema,
  type DeepReadonly,
  DigestSchema,
  EffectClassSchema,
  OutcomeOriginSchema,
  SensitivitySchema,
  ValueTypeSchema,
} from "./primitives.js";
import type { SchemaIdentity } from "./schema-identity.js";
import { piiShapeOf } from "./text-safety.js";

export const SCHEMA_VERSION_CONTRACT = "capability.contract/v1";

/** Parameter, output and payload field names. They become TypeScript property names in generated
 *  types, so the grammar is the intersection of "a person can read it" and "it needs no quoting". */
export const FieldNameSchema = z
  .string()
  .regex(/^[a-z][A-Za-z0-9_]*$/, {
    error: "a field name starts lowercase and contains only letters, digits and underscore",
  })
  .max(64);

/** SCREAMING_SNAKE, because an outcome code is public API a caller switches on. Renaming one is a
 *  breaking change, and the shouting is a reminder of that. */
export const OutcomeCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, { error: "an outcome code is SCREAMING_SNAKE_CASE" })
  .max(64);

const fieldSpecShape = {
  name: FieldNameSchema,
  type: ValueTypeSchema,
  required: z.boolean(),
  /** Model-facing. This is the text a routing decision is made from, so it is required and not
   *  allowed to be empty. */
  description: z.string().min(1).max(1000),
  sensitivity: SensitivitySchema,
  /**
   * A synthetic example for the catalog. MUST be absent when the field is sensitive: "here is an
   * example member number" in a committed schema file is exactly the failure mode the taint model
   * exists to prevent, and it is one of the easiest to commit by accident.
   */
  example: z.string().max(200).optional(),
} as const;

function checkExample(
  spec: { readonly sensitivity: string; readonly example?: string | undefined },
  ctx: { addIssue: (message: string) => void },
): void {
  if (spec.example === undefined) return;
  if (spec.sensitivity === "sensitive") {
    ctx.addIssue("a sensitive field may not carry an example; the example would be the leak");
  }
  const pii = piiShapeOf(spec.example);
  if (pii !== null) {
    ctx.addIssue(
      `the example ${JSON.stringify(spec.example)} has the shape of regulated data (${pii}); use an obviously synthetic one`,
    );
  }
}

const fieldSpecSchemaImpl = z.strictObject(fieldSpecShape).superRefine(checkExample);
export interface FieldSpecSchemaType extends SchemaIdentity<typeof fieldSpecSchemaImpl> {}
export const FieldSpecSchema: FieldSpecSchemaType = fieldSpecSchemaImpl;

export type FieldSpec = DeepReadonly<z.infer<typeof FieldSpecSchema>>;

const paramSpecSchemaImpl = z
  .strictObject({
    ...fieldSpecShape,
    /**
     * Evaluated BEFORE any surface is touched.
     *
     * The cheapest classification touches nothing: driving four steps of a legacy UI to learn that
     * "abc" is not a member id is slower, flakier, and gives a worse message than rejecting it in a
     * nanosecond. A failure here is `argument-invalid` with `sideEffects: "none-guaranteed"` - it
     * is emphatically NOT a business outcome, because it is a fact about the call and not about
     * the record.
     */
    constraints: z
      .strictObject({
        charset: z.enum(["digits", "alnum", "any"]).optional(),
        minLength: z.int().nonnegative().max(4096).optional(),
        maxLength: z.int().positive().max(4096).optional(),
        enum: z.array(z.string().min(1)).min(1).max(256).readonly().optional(),
      })
      .optional(),
    /**
     * Evidence the parameter was DISCOVERED from the goal rather than invented, which is what makes
     * "parameterization is the privacy control" auditable rather than asserted.
     *
     * The span is itself PARAMETERIZED - "member {memberId}", not the words the operator actually
     * typed. It is a trap otherwise: the field whose entire purpose is to record where a member
     * number came from is the field most likely to end up holding one.
     */
    discoveredFrom: z.union([
      z.strictObject({ goalSpan: z.string().min(1).max(500) }),
      z.strictObject({ operator: z.literal(true) }),
    ]),
  })
  .superRefine((spec, ctx) => {
    checkExample(spec, ctx);
    if ("goalSpan" in spec.discoveredFrom) {
      const pii = piiShapeOf(spec.discoveredFrom.goalSpan);
      if (pii !== null) {
        ctx.addIssue(
          `discoveredFrom.goalSpan has the shape of regulated data (${pii}); record the span parameterized, e.g. "member {memberId}"`,
        );
      }
    }
    const c = spec.constraints;
    if (c === undefined) return;
    if (c.minLength !== undefined && c.maxLength !== undefined && c.minLength > c.maxLength) {
      ctx.addIssue("minLength exceeds maxLength, so no argument can ever satisfy this parameter");
    }
    const isString = spec.type.kind === "string";
    if (
      !isString &&
      (c.charset !== undefined || c.minLength !== undefined || c.maxLength !== undefined)
    ) {
      ctx.addIssue(
        `charset and length constraints only apply to a string parameter, and this one is ${spec.type.kind}`,
      );
    }
    if (c.enum !== undefined) {
      if (spec.type.kind !== "enum" && !isString) {
        ctx.addIssue(
          `an enum constraint only applies to a string or enum parameter, not ${spec.type.kind}`,
        );
      } else if (spec.type.kind === "enum") {
        const declared = new Set(spec.type.values);
        const stray = c.enum.filter((v) => !declared.has(v));
        if (stray.length > 0) {
          ctx.addIssue(
            `the enum constraint allows values the parameter's type does not declare: ${stray.join(", ")}`,
          );
        }
      }
    }
  });
export interface ParamSpecSchemaType extends SchemaIdentity<typeof paramSpecSchemaImpl> {}
export const ParamSpecSchema: ParamSpecSchemaType = paramSpecSchemaImpl;

export type ParamSpec = DeepReadonly<z.infer<typeof ParamSpecSchema>>;

const outputSpecSchemaImpl = z
  .strictObject({
    ...fieldSpecShape,
    /**
     * How much of this output the MODEL is allowed to see, which is a different question from
     * `sensitivity` - that one governs persistence.
     *
     * A tool result is itself a persisted artifact: it lands in the provider transcript and in the
     * agent's conversation history. So "taint controls persistence, not delivery" is not sufficient
     * on its own, and this field is what stops it quietly meaning "regulated data leaves the
     * perimeter". `deliver` is the balance where reading the value is the point of the call; a
     * member name is often `mask`. The typed outputs handed to the calling PROGRAM are never masked.
     */
    agentDisclosure: z.enum(["deliver", "mask", "withhold"]),
  })
  .superRefine(checkExample);
export interface OutputSpecSchemaType extends SchemaIdentity<typeof outputSpecSchemaImpl> {}
export const OutputSpecSchema: OutputSpecSchemaType = outputSpecSchemaImpl;

export type OutputSpec = DeepReadonly<z.infer<typeof OutputSpecSchema>>;

const outcomeDeclSchemaImpl = z.strictObject({
  code: OutcomeCodeSchema,
  /** A literal discriminant that is never the string "error", on a type with no error field. */
  kind: z.literal("business_outcome"),
  title: z.string().min(1).max(200),
  /** Copied verbatim into the generated tool description. */
  summary: z.string().min(1).max(1000),
  /** v1: an outcome ends the run. */
  terminal: z.literal(true),
  payload: z.array(FieldSpecSchema).max(32).readonly(),

  /**
   * WHO WROTE THIS OUTCOME. Required, no default, and matched against the detector's own `origin`
   * by linker check 8 - a contract that claims a detector was derived while the artifact says a
   * human wrote it is a link error, not a warning.
   *
   * It is deliberately NOT rendered to a calling agent (`agent-view.ts`, `tools.ts`): a model
   * handed a pedigree starts weighing outcomes by it, and "in the contract, but by a human" is not
   * a third state a caller is entitled to act on. The approval gate exists to make that distinction
   * already resolved by the time a caller sees the code.
   */
  origin: OutcomeOriginSchema,

  /**
   * The Q1 assertion, and the reason it is a field rather than a doctrine.
   *
   * The governing rule is: an outcome is a fact about the request or the record that will still be
   * true on the next attempt; a failure is a fact about the system that might not be. "This
   * member's account is restricted" is stable under retry and is an answer. "The session expired"
   * is a property of this attempt and is not.
   *
   * Requiring the author to write `true` here is cheap, forces them through the rule once, and -
   * the part that matters - puts the claim in front of the reviewer. Somebody declaring a transient
   * condition as an outcome is then at least visibly wrong instead of invisibly wrong. It is
   * `z.literal(true)` because there is no such thing as an outcome that is not stable under retry:
   * that thing is a `FailureClass`.
   */
  stableUnderRetry: z.literal(true),

  /**
   * What the CALLER should do. The field that makes the three-way split actionable rather than
   * merely descriptive.
   *
   * `refer-to-specialist` is a business fact about the RECORD - "a person at the institution must
   * service this" - and never an engine escalation. Engine escalation is the `suspended` arm and
   * never travels on an outcome.
   */
  callerAction: z.enum(["inform-user", "retry-different-input", "refer-to-specialist"]),
  retryable: z.enum(["never", "after_delay", "with_different_inputs"]),

  /**
   * The reviewed playbook, written by a human at approval time and copied VERBATIM into the tool
   * result. Never generated at runtime. The whole argument for a closed outcome set is that
   * somebody thought about each member of it once, in advance, calmly.
   */
  agentGuidance: z.string().min(1).max(2000),
});
/**
 * The contract's half of an outcome: a NAME, a payload type, and reviewed prose. NO DETECTOR.
 */
export interface OutcomeDeclSchemaType extends SchemaIdentity<typeof outcomeDeclSchemaImpl> {}
export const OutcomeDeclSchema: OutcomeDeclSchemaType = outcomeDeclSchemaImpl;

export type OutcomeDecl = DeepReadonly<z.infer<typeof OutcomeDeclSchema>>;

function duplicates(names: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) dupes.add(n);
    seen.add(n);
  }
  return [...dupes];
}

const capabilityContractSchemaImpl = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION_CONTRACT),
    name: CapabilityNameSchema,
    version: ContractVersionSchema,
    title: z.string().min(1).max(200),
    /** One line, for a catalog list view. */
    summary: z.string().min(1).max(500),
    /** Routing hints. Models mis-route far more often than they mis-fill arguments, so both lists
     *  are required to be non-empty: a capability with nothing in `whenNotToUse` is a capability
     *  that will be called for the wrong reason, and writing the line is the cheap part. */
    whenToUse: z.array(z.string().min(1).max(300)).min(1).max(16).readonly(),
    whenNotToUse: z.array(z.string().min(1).max(300)).min(1).max(16).readonly(),

    inputs: z.array(ParamSpecSchema).max(32).readonly(),
    outputs: z.array(OutputSpecSchema).max(32).readonly(),
    outcomes: z.array(OutcomeDeclSchema).max(32).readonly(),

    /** Rolled up from the artifact at approval time and re-checked by the linker. */
    effect: EffectClassSchema,
    requiresApproval: z.boolean(),
    idempotent: z.boolean(),
    /** Over the canonical JSON of this document with `digest` removed. */
    digest: DigestSchema,
  })
  .superRefine((c, ctx) => {
    for (const [label, names] of [
      ["input", c.inputs.map((i) => i.name)],
      ["output", c.outputs.map((o) => o.name)],
      ["outcome", c.outcomes.map((o) => o.code)],
    ] as const) {
      const dupes = duplicates(names);
      if (dupes.length > 0) ctx.addIssue(`duplicate ${label} name(s): ${dupes.join(", ")}`);
    }
    for (const outcome of c.outcomes) {
      const dupes = duplicates(outcome.payload.map((f) => f.name));
      if (dupes.length > 0) {
        ctx.addIssue(`outcome ${outcome.code} has duplicate payload field(s): ${dupes.join(", ")}`);
      }
    }
    // Derived, and checked here so that a hand-edited contract cannot claim an irreversible
    // capability needs no approval token. The linker re-derives it from the artifact's steps as
    // well, because the contract's own copy is a claim and the steps are the evidence.
    const derived = c.effect === "WRITE_IRREVERSIBLE";
    if (c.requiresApproval !== derived) {
      ctx.addIssue(
        `requiresApproval is derived from effect: effect ${c.effect} implies requiresApproval ${derived}`,
      );
    }
  });
export interface CapabilityContractSchemaType
  extends SchemaIdentity<typeof capabilityContractSchemaImpl> {}
export const CapabilityContractSchema: CapabilityContractSchemaType = capabilityContractSchemaImpl;

export type CapabilityContract = DeepReadonly<z.infer<typeof CapabilityContractSchema>>;
