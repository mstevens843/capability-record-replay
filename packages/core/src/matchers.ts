// Container matchers, node queries and the predicate language (SPEC section 2.4).
//
// The predicate language is non-Turing-complete by construction: no loops, no arithmetic beyond a
// count comparison, no user-defined functions, and a depth ceiling checked at save time. Four
// criteria decided its membership, and the fourth is the one that actually settled arguments: it
// must be diffable in a pull request, reviewable by someone who is not an engineer, cost-bounded so
// a malformed document cannot hang a replay, and RENDERABLE INTO PROSE - because the interpreter
// has to explain a refusal to a human at 2am, and every construct that was kept was kept partly
// because it can be explained.

import { z } from "zod";
import {
  HeadingLevelSchema,
  LandmarkRoleSchema,
  NodeStateKeySchema,
  NodeStateSchema,
} from "./observation.js";
import {
  type DeepReadonly,
  RoleSchema,
  type RouteId,
  RouteIdSchema,
  type TextMatcher,
} from "./primitives.js";
import type { SchemaIdentity } from "./schema-identity.js";
import { SafeTextMatcherSchema, SafeValueRefSchema } from "./text-safety.js";

// ---------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------

const containerSegmentMatcherSchemaImpl = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("frame"), name: SafeTextMatcherSchema }),
  z.strictObject({
    kind: z.literal("landmark"),
    role: LandmarkRoleSchema,
    name: SafeTextMatcherSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("heading-section"),
    heading: SafeTextMatcherSchema,
    level: HeadingLevelSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("table"),
    headers: z.array(SafeTextMatcherSchema).min(1).max(64).readonly(),
  }),
  z.strictObject({ kind: z.literal("screen"), id: SafeTextMatcherSchema }),
]);
export interface ContainerSegmentMatcherSchemaType
  extends SchemaIdentity<typeof containerSegmentMatcherSchemaImpl> {}
export const ContainerSegmentMatcherSchema: ContainerSegmentMatcherSchemaType =
  containerSegmentMatcherSchemaImpl;

export type ContainerSegmentMatcher = DeepReadonly<z.infer<typeof ContainerSegmentMatcherSchema>>;

const containerMatcherSchemaImpl = z.strictObject({
  path: z.array(ContainerSegmentMatcherSchema).min(1).max(8).readonly(),
});
/**
 * A breadcrumb, not a locator. Every segment must match.
 *
 * This is the unit of SCOPE for both target resolution and detector evaluation, and it is the
 * reason "the Search button in the nav frame" and "the Search button in the content frame" are
 * different things rather than an ambiguity nobody noticed. An empty path would scope to the whole
 * observation, which is precisely what control C3 exists to forbid, so the minimum is one segment.
 */
export interface ContainerMatcherSchemaType
  extends SchemaIdentity<typeof containerMatcherSchemaImpl> {}
export const ContainerMatcherSchema: ContainerMatcherSchemaType = containerMatcherSchemaImpl;

export type ContainerMatcher = DeepReadonly<z.infer<typeof ContainerMatcherSchema>>;

// ---------------------------------------------------------------------------------------------
// Node queries
// ---------------------------------------------------------------------------------------------

const rowKeySchemaImpl = z.strictObject({
  columnHeader: SafeTextMatcherSchema,
  value: SafeValueRefSchema,
});
/**
 * Row addressing keyed by a VALUE, never an index.
 *
 * Without it, reading a cell on a legacy accounts grid degrades to "some cell in this table", which
 * is how a checking balance gets reported as a savings balance to a member on the phone.
 */
export interface RowKeySchemaType extends SchemaIdentity<typeof rowKeySchemaImpl> {}
export const RowKeySchema: RowKeySchemaType = rowKeySchemaImpl;

export type RowKey = DeepReadonly<z.infer<typeof RowKeySchema>>;

const nodeQuerySchemaImpl = z
  .strictObject({
    scope: ContainerMatcherSchema.optional(),
    role: RoleSchema.optional(),
    name: SafeTextMatcherSchema.optional(),
    text: SafeTextMatcherSchema.optional(),
    state: NodeStateSchema.partial().optional(),
    cell: z
      .strictObject({
        table: ContainerMatcherSchema,
        rowKey: RowKeySchema,
        columnHeader: SafeTextMatcherSchema,
      })
      .optional(),
  })
  .refine(
    (q) =>
      q.role !== undefined ||
      q.name !== undefined ||
      q.text !== undefined ||
      q.cell !== undefined ||
      (q.state !== undefined && Object.keys(q.state).length > 0),
    {
      error:
        "a node query must constrain something about the node - a scope alone matches every node in the container",
    },
  );
/**
 * `NodeQuery` is EXISTENTIAL and has no quorum: it is how a detector asks "is something like this
 * on screen". It is a DIFFERENT TYPE from `TargetRef`, which requires a quorum and is how a step
 * says "act on exactly this". Keeping the two apart is what stops a detector's looseness leaking
 * into an action.
 *
 * At least one node-level constraint is required. A query that constrains only its scope matches
 * every node in that container, which makes `node-exists` trivially true and `node-absent`
 * trivially false - and a detector that is trivially true is a machine for emitting a business
 * outcome that was never observed.
 */
export interface NodeQuerySchemaType extends SchemaIdentity<typeof nodeQuerySchemaImpl> {}
export const NodeQuerySchema: NodeQuerySchemaType = nodeQuerySchemaImpl;

export type NodeQuery = DeepReadonly<z.infer<typeof NodeQuerySchema>>;

// ---------------------------------------------------------------------------------------------
// Predicates
//
// The one recursive type in the schema, and the one place a TypeScript type is written by hand.
// zod cannot infer a recursive UNION without an annotation, and the annotation has to name a type.
// The alternative - flattening the boolean connectives out of the language - would cost more than
// the duplication: `all` is what makes a checkpoint say "the heading is right AND the member is
// the one we asked about". The drift risk is contained two ways: the annotation makes any arm
// whose output is not a `Predicate` a compile error, and `test/predicate.test.ts` parses one
// example of every arm, which is what catches an arm that was added to the type and forgotten in
// the schema.
// ---------------------------------------------------------------------------------------------

export type Predicate =
  | { readonly all: readonly Predicate[] }
  | { readonly any: readonly Predicate[] }
  | { readonly not: Predicate }
  | { readonly kind: "node-exists"; readonly where: NodeQuery }
  | { readonly kind: "node-absent"; readonly where: NodeQuery }
  | { readonly kind: "text-present"; readonly scope?: ContainerMatcher; readonly text: TextMatcher }
  | {
      readonly kind: "node-state";
      readonly where: NodeQuery;
      readonly state: z.infer<typeof NodeStateKeySchema>;
      readonly equals: boolean;
    }
  | { readonly kind: "value-matches"; readonly where: NodeQuery; readonly matcher: TextMatcher }
  | {
      readonly kind: "count";
      readonly where: NodeQuery;
      readonly op: "eq" | "gte" | "lte";
      readonly n: number;
    }
  | { readonly kind: "route-matches"; readonly route: RouteId }
  | { readonly kind: "settled" }
  | { readonly kind: "native-dialog"; readonly dialogType?: "alert" | "confirm" | "prompt" }
  | { readonly kind: "continuity"; readonly ref: string; readonly scope?: ContainerMatcher };

const leafPredicateSchemaImpl = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("node-exists"), where: NodeQuerySchema }),
  z.strictObject({ kind: z.literal("node-absent"), where: NodeQuerySchema }),
  z.strictObject({
    kind: z.literal("text-present"),
    scope: ContainerMatcherSchema.optional(),
    text: SafeTextMatcherSchema,
  }),
  z.strictObject({
    kind: z.literal("node-state"),
    where: NodeQuerySchema,
    state: NodeStateKeySchema,
    equals: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("value-matches"),
    where: NodeQuerySchema,
    matcher: SafeTextMatcherSchema,
  }),
  z
    .strictObject({
      kind: z.literal("count"),
      where: NodeQuerySchema,
      op: z.enum(["eq", "gte", "lte"]),
      /** The only arithmetic in the language, and it is a comparison against a small integer. */
      n: z.int().nonnegative().max(10_000),
    })
    .refine((p) => !(p.op === "gte" && p.n === 0), {
      // `n` is `nonnegative()`, so `count >= 0` is true of every observation ever taken - including
      // one where the query selected nothing at all. It reads like a bound and is a tautology, and
      // a detector that is trivially true is a machine for emitting a business outcome that was
      // never observed. `gte 1` is what an author who wrote this actually meant.
      error:
        "a count of at least zero is true on every screen, including an empty one; a detector that cannot be false has detected nothing - use `gte` with 1, or `eq` with 0 to assert absence",
    }),
  z.strictObject({ kind: z.literal("route-matches"), route: RouteIdSchema }),
  z.strictObject({ kind: z.literal("settled") }),
  z.strictObject({
    kind: z.literal("native-dialog"),
    dialogType: z.enum(["alert", "confirm", "prompt"]).optional(),
  }),
  z.strictObject({
    kind: z.literal("continuity"),
    ref: z.string().min(1).max(64),
    scope: ContainerMatcherSchema.optional(),
  }),
]);
/** The leaf arms, exported so a test can assert the union is covered arm for arm. */
export interface LeafPredicateSchemaType extends SchemaIdentity<typeof leafPredicateSchemaImpl> {}
export const LeafPredicateSchema: LeafPredicateSchemaType = leafPredicateSchemaImpl;

export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(PredicateSchema).min(1).max(16).readonly() }),
    z.strictObject({ any: z.array(PredicateSchema).min(1).max(16).readonly() }),
    z.strictObject({ not: PredicateSchema }),
    ...LeafPredicateSchema.options,
  ]),
);

/**
 * Depth ceiling (SPEC section 10 check 18).
 *
 * Four is not arbitrary: `all[ any[ not[ leaf ] ] ]` is the deepest shape anyone has needed to
 * write, and past that the prose renderer produces a sentence nobody can follow - which defeats the
 * criterion the language was designed around.
 */
export const MAX_PREDICATE_DEPTH = 4;

/** A leaf has depth 1; each connective adds one. Total, and it terminates because the schema
 *  already bounded the arity of every connective. */
export function predicateDepth(p: Predicate): number {
  if ("all" in p) return 1 + maxDepth(p.all);
  if ("any" in p) return 1 + maxDepth(p.any);
  if ("not" in p) return 1 + predicateDepth(p.not);
  return 1;
}

function maxDepth(ps: readonly Predicate[]): number {
  let deepest = 0;
  for (const p of ps) {
    const d = predicateDepth(p);
    if (d > deepest) deepest = d;
  }
  return deepest;
}

/**
 * The predicate as every document field uses it: recursive, and bounded once at the top.
 *
 * Checking the depth at the outermost node rather than at every node is deliberate - the outermost
 * bound implies all the inner ones, and re-deriving depth at each level would make validation
 * quadratic in the depth for no additional guarantee.
 */
export const BoundedPredicateSchema = PredicateSchema.refine(
  (p) => predicateDepth(p) <= MAX_PREDICATE_DEPTH,
  { error: `a predicate may not nest deeper than ${MAX_PREDICATE_DEPTH} levels` },
);

/** Every `all` / `any` / `not` node flattened away, leaving the leaves. Used by the artifact-level
 *  checks that need to walk what a predicate actually references. */
export function predicateLeaves(p: Predicate): readonly Extract<Predicate, { kind: string }>[] {
  if ("all" in p) return p.all.flatMap(predicateLeaves);
  if ("any" in p) return p.any.flatMap(predicateLeaves);
  if ("not" in p) return predicateLeaves(p.not);
  return [p];
}
