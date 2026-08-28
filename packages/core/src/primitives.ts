// SPEC section 2.1 - the primitives every other document is written in.
//
// The zod schema is the single definition and the TypeScript type is inferred from it. A
// hand-written type next to a hand-written validator is two definitions of one thing, and the
// interesting bugs in a system like this live in the gap between them: the validator accepts a
// document the type says is impossible, or rejects one the type says is fine, and nobody notices
// until a replay refuses an artifact that a recorder just wrote.

import { z } from "zod";
import type { SchemaIdentity } from "./schema-identity.js";

/**
 * `readonly` throughout, applied once instead of at three hundred field declarations.
 *
 * The primitive arm has to come first: a branded id is `string & { brand }`, which satisfies
 * `extends object`, and without the guard the mapped-type arm would rewrite it into an object type
 * and quietly destroy every brand in the schema.
 */
export type DeepReadonly<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

// ---------------------------------------------------------------------------------------------
// Branded ids
//
// Branded rather than aliased because these are the arguments that get swapped. `StepId` and
// `RouteId` are both lowercase slugs; `ArtifactId` and `RunId` are both opaque handles. A plain
// `type StepId = string` makes `journalStep(runId, stepId)` compile with the arguments reversed,
// and the failure surfaces as a journal that describes the wrong step, hours later, in evidence.
//
// The brand comes from zod's `.brand()` so that `z.infer` carries it and there is still exactly
// one definition. That is a deliberate departure from the `declare const BRAND: unique symbol`
// sketch in SPEC section 2.1 - same nominal-typing effect, minus the second source of truth the
// spec's own opening paragraph argues against.
// ---------------------------------------------------------------------------------------------

/** Lowercase dotted path: `corebank.member.read_savings_balance`. Names a capability contract. */
export const CapabilityNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, {
    error:
      "a capability name is a lowercase dotted path with at least two segments, e.g. corebank.member.read_savings_balance",
  })
  .max(200)
  .brand<"CapabilityName">();
export type CapabilityName = z.infer<typeof CapabilityNameSchema>;

/**
 * Strict `major.minor.patch`. No pre-release, no build metadata, no range syntax.
 *
 * A range is not expressible on purpose: SPEC section 2.6 pins an invocation to an exact contract
 * version *and* its digest, so a caller can never be handed an outcome its generated types have
 * never heard of. A version that can mean two things defeats that pin before it starts.
 */
export const ContractVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, {
    error: "a contract version is an exact major.minor.patch, with no range or pre-release",
  })
  .brand<"ContractVersion">();
export type ContractVersion = z.infer<typeof ContractVersionSchema>;

/** The shape shared by every human-authored identifier in the documents: a reviewable slug. */
const slug = (max: number) =>
  z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/, {
      error: "an identifier is a lowercase slug of letters, digits, dot, underscore and hyphen",
    })
    .max(max);

export const ArtifactIdSchema = slug(128).brand<"ArtifactId">();
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;

export const StepIdSchema = slug(64).brand<"StepId">();
export type StepId = z.infer<typeof StepIdSchema>;

/**
 * The multi-tenant hinge (SPEC section 9.3). A label token is a *symbolic* name for a label - the
 * artifact says `token: "search-button"` and the tenant's overlay says what that reads as here.
 * The whole point is that no tenant's wording ever appears in the base artifact, so the token
 * vocabulary is deliberately narrower than the label vocabulary: no spaces, no punctuation a
 * screen would show.
 */
export const LabelTokenSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, {
    error: "a label token is a lowercase symbolic name, never the words a screen displays",
  })
  .max(64)
  .brand<"LabelToken">();
export type LabelToken = z.infer<typeof LabelTokenSchema>;

export const RouteIdSchema = slug(64).brand<"RouteId">();
export type RouteId = z.infer<typeof RouteIdSchema>;

export const TenantIdSchema = slug(64).brand<"TenantId">();
export type TenantId = z.infer<typeof TenantIdSchema>;

export const AppInstanceIdSchema = slug(64).brand<"AppInstanceId">();
export type AppInstanceId = z.infer<typeof AppInstanceIdSchema>;

/** Minted by the runtime, opaque to core. */
const opaqueHandle = (max: number) =>
  z.string().min(1).max(max).regex(/^\S+$/, { error: "an opaque handle contains no whitespace" });

export const RunIdSchema = opaqueHandle(128).brand<"RunId">();
export type RunId = z.infer<typeof RunIdSchema>;

export const LeaseTokenSchema = opaqueHandle(256).brand<"LeaseToken">();
export type LeaseToken = z.infer<typeof LeaseTokenSchema>;

export const ApprovalTokenSchema = opaqueHandle(512).brand<"ApprovalToken">();
export type ApprovalToken = z.infer<typeof ApprovalTokenSchema>;

export const InterventionIdSchema = opaqueHandle(128).brand<"InterventionId">();
export type InterventionId = z.infer<typeof InterventionIdSchema>;

/** Content-addressed blob key for an evidence sink. Core never dereferences one. */
export const EvidenceRefSchema = opaqueHandle(256).brand<"EvidenceRef">();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/**
 * Per-observation only. Never stored, ever.
 *
 * The format is fixed here rather than left to each driver, and the reason is enforcement: SPEC
 * section 2.2 requires the artifact validator to reject any node-id-shaped string appearing where
 * a locator descriptor belongs, and it cannot do that against an unspecified format. So every
 * driver emits `<kind>:<local>` - the terminal driver's `textbox:account-number` (driver rule D10)
 * already complies - and `looksLikeNodeId` below is what the validator asks.
 *
 * A node id is an index into one snapshot, not an identity. Two observations of the same screen
 * may number the same control differently and both be correct.
 */
export const NODE_ID_PATTERN = /^[a-z][a-z0-9-]*:\S{1,240}$/;
export const NodeIdSchema = z
  .string()
  .regex(NODE_ID_PATTERN, {
    error: "a node id is <kind>:<local>, assigned by the driver per observation",
  })
  .brand<"NodeId">();
export type NodeId = z.infer<typeof NodeIdSchema>;

/**
 * True for any string a driver could plausibly have emitted as a node id.
 *
 * Used by the artifact validator to refuse a stored node id. It is intentionally a *shape* test
 * and not an exact-format test: the failure it guards against is a recorder writing a snapshot
 * index into a document that will be replayed against a different snapshot next week, and that is
 * worth refusing on suspicion. Anything genuinely `<kind>:<local>` shaped has no business in a
 * descriptor position anyway.
 */
export function looksLikeNodeId(value: string): boolean {
  return NODE_ID_PATTERN.test(value);
}

/** `sha256:` followed by 64 lowercase hex characters, over the JCS form of a document. */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const DigestSchema = z
  .string()
  .regex(DIGEST_PATTERN, { error: "a digest is sha256: followed by 64 lowercase hex characters" })
  .brand<"Digest">();
export type Digest = z.infer<typeof DigestSchema>;

/**
 * ISO-8601 UTC, always with a `Z`, second or millisecond precision. Set only by the runtime; core
 * never produces one, which is the whole reason it is a plain string here and not a rich type.
 *
 * A local offset is not accepted. Two journals from two tenants in two time zones have to be
 * mergeable into one timeline by string comparison, and an offset makes that quietly wrong.
 */
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
export const TimestampSchema = z.string().regex(TIMESTAMP_PATTERN, {
  error: "a timestamp is ISO-8601 UTC with a trailing Z, e.g. 2026-01-31T09:15:00.000Z",
});
export type Timestamp = string;

// ---------------------------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------------------------

/**
 * Normalized *across* surfaces, and closed.
 *
 * Closed because an open string set lets the terminal driver call a control `input` while the
 * browser driver calls it `textbox`, and then a descriptor recorded on one surface silently never
 * resolves on the other. A closed union makes that a compile error inside the driver instead of a
 * mystery at replay. There is deliberately no `unknown` member: a node the driver cannot classify
 * carries `ariaRole: null` and is structure, never a target.
 */
export const RoleSchema = z.enum([
  "button",
  "link",
  "textbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "table",
  "row",
  "cell",
  "columnheader",
  "rowheader",
  "heading",
  "dialog",
  "alert",
  "status",
  "form",
  "region",
  "navigation",
  "main",
  "group",
  "list",
  "listitem",
  "tab",
  "text",
  "image",
]);
export type Role = z.infer<typeof RoleSchema>;

export const SensitivitySchema = z.enum(["public", "internal", "sensitive"]);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const EffectClassSchema = z.enum(["READ", "WRITE_REVERSIBLE", "WRITE_IRREVERSIBLE"]);
export type EffectClass = z.infer<typeof EffectClassSchema>;

export const SurfaceKindSchema = z.enum(["web-modern", "web-legacy", "terminal", "desktop"]);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

/**
 * Decimal-as-string. There is no IEEE-754 anywhere in this schema, at any depth, ever.
 *
 *   1. The artifact is content-addressed with JCS and an approval signs that address. Float
 *      serialization is not canonical across languages, so a float makes the digest - and
 *      therefore the signature - platform-dependent.
 *   2. This is money in a bank. `0.1 + 0.2` is a defect, not a rounding style.
 *
 * The grammar is the canonical form and nothing else: no exponent, no leading `+`, no leading
 * zeros, no bare `.5`, no thousands separators, and no negative zero. Trailing fractional zeros
 * *are* kept, because `10.00` and `10.0` came off different screens and the scale is information;
 * `compareDecimal` in `decimal.ts` is what says they are numerically equal.
 */
export const DECIMAL_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?$/;
export const DecimalSchema = z
  .string()
  .regex(DECIMAL_PATTERN, {
    error:
      "a decimal is a plain signed decimal string: no exponent, no separators, no leading zeros",
  })
  .refine((s) => !(s.startsWith("-") && /^-0(\.0+)?$/.test(s)), {
    error: "negative zero is not a decimal: two spellings of one value would produce two digests",
  })
  .brand<"Decimal">();
export type Decimal = z.infer<typeof DecimalSchema>;

export const MoneySchema = z.object({
  amount: DecimalSchema,
  /** USD only, and named rather than implied, so a second currency is a schema change a reviewer
   *  sees rather than a string that started arriving one day. */
  currency: z.literal("USD"),
});
export type Money = DeepReadonly<z.infer<typeof MoneySchema>>;

// ---------------------------------------------------------------------------------------------
// Registry ids
//
// Named, versioned registries instead of inline option objects. Two payoffs: an artifact stops
// repeating a four-field normalize object at forty use sites - a reviewability defect in a schema
// whose entire point is human review - and engine code cannot silently change what an approved
// artifact means while its digest keeps matching. The major is part of the id, and
// test/registry-stability.test.ts freezes each function's behaviour at that major.
// ---------------------------------------------------------------------------------------------

export const NormalizerIdSchema = z.enum([
  "std.text@1",
  "std.label@1",
  "std.money@1",
  "std.identity@1",
]);
export type NormalizerId = z.infer<typeof NormalizerIdSchema>;

export const ExtractorIdSchema = z.enum(["text@1", "value@1", "name@1", "cell@1"]);
export type ExtractorId = z.infer<typeof ExtractorIdSchema>;

export const ParserIdSchema = z.enum([
  "string@1",
  "integer@1",
  "moneyUSD@1",
  "dateUS@1",
  "dateISO@1",
  "enum@1",
]);
export type ParserId = z.infer<typeof ParserIdSchema>;

export type RegistryId = NormalizerId | ExtractorId | ParserId;

/** The major version encoded in a registry id, or `null` if the id is not well formed. */
export function registryMajor(id: string): number | null {
  const at = id.lastIndexOf("@");
  if (at < 1) return null;
  const suffix = id.slice(at + 1);
  if (!/^[1-9]\d*$/.test(suffix)) return null;
  return Number.parseInt(suffix, 10);
}

// ---------------------------------------------------------------------------------------------
// Text matching, values, routes
// ---------------------------------------------------------------------------------------------

const textMatcherSchemaImpl = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("exact"), value: z.string(), normalize: NormalizerIdSchema }),
  z.object({
    mode: z.literal("contains"),
    value: z.string().min(1),
    normalize: NormalizerIdSchema,
  }),
  /** Holes are PARAMETER NAMES, never values: "No member found for {memberId}". */
  z.object({
    mode: z.literal("template"),
    value: z.string().min(1),
    normalize: NormalizerIdSchema,
  }),
  /** The multi-tenant form. Resolved through the flow's vocabulary; an overlay replaces the list. */
  z.object({ mode: z.literal("token"), token: LabelTokenSchema, normalize: NormalizerIdSchema }),
]);
/**
 * NO REGEX ANYWHERE - see SPEC section 5.6. Three reasons, and the third is the one that decided
 * it: a regex in an artifact is not reviewable by the operations person who approves it; it is a
 * denial-of-service surface in a file that crosses a trust boundary from a model-authored
 * document; and the thing people reach for it to do here - "the message with the member number in
 * it" - is better served by `template` holes, which additionally keep the member number out of the
 * file.
 */
export interface TextMatcherSchemaType extends SchemaIdentity<typeof textMatcherSchemaImpl> {}
export const TextMatcherSchema: TextMatcherSchemaType = textMatcherSchemaImpl;

export type TextMatcher = DeepReadonly<z.infer<typeof TextMatcherSchema>>;

const valueRefSchemaImpl = z.discriminatedUnion("from", [
  z.object({ from: z.literal("param"), param: z.string().min(1) }),
  z.object({ from: z.literal("literal"), value: z.string(), sensitivity: z.literal("public") }),
  z.object({ from: z.literal("output"), step: StepIdSchema, output: z.string().min(1) }),
  z.object({ from: z.literal("credential"), key: z.string().min(1) }),
]);
/**
 * Where a value comes from. Provenance is not decoration: it is the input that lets the classifier
 * tell "the app rejected the CALLER's value" - a business outcome the agent can act on - from "the
 * app rejected a value baked into the ARTIFACT", which is a hard failure no caller can fix.
 *
 * The `literal` arm's sensitivity is typed `"public"` and nothing else. A non-public literal is
 * therefore not expressible, which makes the never-persist-a-real-value rule a property of the
 * type rather than a lint the linker has to remember to run. The linker re-checks it anyway.
 */
export interface ValueRefSchemaType extends SchemaIdentity<typeof valueRefSchemaImpl> {}
export const ValueRefSchema: ValueRefSchemaType = valueRefSchemaImpl;

export type ValueRef = DeepReadonly<z.infer<typeof ValueRefSchema>>;

/** Everything a typed parameter or output can be, except a table. */
export const ScalarValueTypeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("string"),
    charset: z.enum(["digits", "alnum", "any"]).optional(),
    minLength: z.int().nonnegative().optional(),
    maxLength: z.int().positive().optional(),
  }),
  z.object({ kind: z.literal("integer"), min: z.int().optional(), max: z.int().optional() }),
  z.object({ kind: z.literal("decimal"), scale: z.int().nonnegative().max(12) }),
  z.object({ kind: z.literal("money"), currency: z.literal("USD") }),
  z.object({ kind: z.literal("date"), format: z.literal("YYYY-MM-DD") }),
  z.object({ kind: z.literal("boolean") }),
  z.object({ kind: z.literal("enum"), values: z.array(z.string().min(1)).min(1) }),
]);
export type ScalarValueType = DeepReadonly<z.infer<typeof ScalarValueTypeSchema>>;

const valueTypeSchemaImpl = z.discriminatedUnion("kind", [
  ...ScalarValueTypeSchema.options,
  z.object({
    kind: z.literal("table"),
    columns: z
      .array(z.object({ name: z.string().min(1), type: ScalarValueTypeSchema }))
      .min(1)
      .max(64),
  }),
]);
/**
 * Bounded table read. Exists so `readTable` has a representable output type.
 *
 * A column's type is a *scalar* type, so a table cannot contain a table. SPEC section 2.1 wrote
 * this arm recursively; flattening it is a deliberate tightening. A nested table has no meaning on
 * a character grid or a legacy accounts grid, and an unbounded nesting depth in the one type whose
 * entire purpose is a bounded read is a contradiction the linker would then have to police.
 */
export interface ValueTypeSchemaType extends SchemaIdentity<typeof valueTypeSchemaImpl> {}
export const ValueTypeSchema: ValueTypeSchemaType = valueTypeSchemaImpl;

export type ValueType = DeepReadonly<z.infer<typeof ValueTypeSchema>>;

/**
 * Canonicalized route. Never a literal URL.
 *
 * `/member/12345` in an artifact is persisted member data, and a literal origin makes an artifact
 * accidentally single-tenant. Both problems are solved by the same move, which is the argument
 * SPEC section 3.6 makes: parameterization *is* the privacy control.
 */
export const RoutePatternSchema = z.object({
  id: RouteIdSchema,
  /** Resolved to a real origin per tenant by the overlay. Never a scheme or a host here. */
  originAlias: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, { error: "an origin alias is a symbolic name, not a URL" })
    .max(64),
  path: z
    .string()
    .startsWith("/", { error: "a route path is absolute" })
    .max(512)
    .refine((p) => !p.includes("://"), { error: "a route path is a path, never an absolute URL" }),
  query: z.record(z.string().min(1), z.union([ValueRefSchema, z.literal(":any")])).optional(),
  /** Frameset target name, when the route lands in a frame. A name, never an ordinal - driver
   *  rule D3 exists because ordinals shift when a sibling frame is removed. */
  frame: z.string().min(1).max(128).optional(),
});
export type RoutePattern = DeepReadonly<z.infer<typeof RoutePatternSchema>>;
