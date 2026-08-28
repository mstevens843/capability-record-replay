// Locator descriptors and the target reference (SPEC section 5.1).
//
// The starting constraint is NOT "selectors drift" - the brief deliberately removed that problem.
// It is "assume no clean document tree, no test ids, and possibly no document at all", plus "the
// model must never author a locator". So this is not self-healing lookup. It is: pick the
// identities a human would use, compute several of them INDEPENDENTLY, and treat disagreement as
// information rather than as a reason to try the next one.

import { z } from "zod";
import {
  DESCRIPTOR_RANK,
  type DescriptorKindSchema,
  type EvidenceSourceSchema,
  bestRank,
} from "./descriptor-kinds.js";
import { ContainerMatcherSchema, RowKeySchema } from "./matchers.js";
import { ContainerPathSchema } from "./observation.js";
import { type DeepReadonly, RoleSchema } from "./primitives.js";
import type { SchemaIdentity } from "./schema-identity.js";
import { SafeTextMatcherSchema } from "./text-safety.js";

/** Descriptor ids are referenced by overlays (`disableDescriptors`) and by drift reports, so they
 *  are slugs a person can type, not opaque handles. */
export const DescriptorIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, { error: "a descriptor id is a lowercase slug" })
  .max(64);

export const DistanceSchema = z.strictObject({
  unit: z.enum(["px", "cell"]),
  value: z.int().positive().max(10_000),
});

const roleNameShape = {
  id: DescriptorIdSchema,
  kind: z.literal("role-name"),
  evidenceSource: z.literal("accessibleName"),
  role: RoleSchema,
  name: SafeTextMatcherSchema,
} as const;

const labelAnchoredShape = {
  id: DescriptorIdSchema,
  kind: z.literal("label-anchored"),
  evidenceSource: z.literal("labelText"),
  label: SafeTextMatcherSchema,
  role: RoleSchema,
  relation: z.enum(["labelled-by", "right-of", "below", "left-of", "above", "same-cell"]),
  maxDistance: DistanceSchema,
} as const;

const tableCellShape = {
  id: DescriptorIdSchema,
  kind: z.literal("table-cell"),
  evidenceSource: z.literal("columnHeader"),
  table: ContainerMatcherSchema,
  rowKey: RowKeySchema,
  columnHeader: SafeTextMatcherSchema,
  childRole: RoleSchema.optional(),
  /** Recorded, compared at replay, and correctable by an overlay. The header row of a legacy grid
   *  is frequently a guess, and a guess that was never labelled as one cannot be corrected. */
  headerProvenance: z.enum(["columnheader-role", "first-row-heuristic"]),
} as const;

const ordinalShape = {
  id: DescriptorIdSchema,
  kind: z.literal("ordinal-in-container"),
  evidenceSource: z.literal("ordinal"),
  container: ContainerMatcherSchema,
  role: RoleSchema,
  index: z.int().nonnegative().max(1000),
} as const;

const nonGeometricDescriptorSchemaImpl = z.discriminatedUnion("kind", [
  z.strictObject(roleNameShape),
  z.strictObject(labelAnchoredShape),
  z.strictObject(tableCellShape),
  z.strictObject(ordinalShape),
]);
/**
 * The four kinds a `geometric` descriptor may anchor to.
 *
 * The anchor is INLINE rather than a reference to a sibling descriptor, and that is not a
 * convenience: the other descriptors in a target all resolve the SAME node, so there is no sibling
 * that resolves the anchor. Excluding `geometric` from the anchor's own kinds makes a cycle
 * impossible by construction rather than by a graph check that someone has to remember to run -
 * SPEC section 10 check 12, discharged by the type.
 */
export interface NonGeometricDescriptorSchemaType
  extends SchemaIdentity<typeof nonGeometricDescriptorSchemaImpl> {}
export const NonGeometricDescriptorSchema: NonGeometricDescriptorSchemaType =
  nonGeometricDescriptorSchemaImpl;

export type NonGeometricDescriptor = DeepReadonly<z.infer<typeof NonGeometricDescriptorSchema>>;

const descriptorSchemaImpl = z.discriminatedUnion("kind", [
  /** Rank 1. The accessible name is the identity a HUMAN uses; it survives markup churn. */
  z.strictObject(roleNameShape),
  /** Rank 2. "the box next to Member ID", including spatial association on a legacy table. */
  z.strictObject(labelAnchoredShape),
  /** Rank 3. "the Select link on the row whose Member ID is the member we were asked about". */
  z.strictObject(tableCellShape),
  /** Rank 4. Positional, and never the only or highest-ranked descriptor. */
  z.strictObject(ordinalShape),
  /** Rank 5. Last resort. Always anchored, always scoped, never absolute. */
  z.strictObject({
    id: DescriptorIdSchema,
    kind: z.literal("geometric"),
    evidenceSource: z.literal("geometry"),
    anchor: NonGeometricDescriptorSchema,
    role: RoleSchema,
    direction: z.enum(["right-of", "below", "left-of", "above"]),
    maxDistance: DistanceSchema,
  }),
]);
export interface DescriptorSchemaType extends SchemaIdentity<typeof descriptorSchemaImpl> {}
export const DescriptorSchema: DescriptorSchemaType = descriptorSchemaImpl;

export type Descriptor = DeepReadonly<z.infer<typeof DescriptorSchema>>;

const quorumSchemaImpl = z
  .strictObject({
    min: z.int().min(2).max(8),
    distinctEvidenceSources: z.int().min(2).max(5),
    /** Literal `true`. Disagreement is a signal, never a fallback chain - a fallback chain is a
     *  machine for converting an ambiguity into a confident wrong click. */
    requireIdentical: z.literal(true),
    /** Literal `"fail"`. There is no majority-vote mode, on read steps or any other: reading the
     *  wrong member's balance and speaking it to a member on the phone is a compliance incident,
     *  not a soft signal. */
    onUnderQuorum: z.literal("fail"),
    /** Literal `true`. A descriptor that matches several nodes ABSTAINS; it never picks the first. */
    expectUnique: z.literal(true),
  })
  .refine((q) => q.distinctEvidenceSources <= q.min, {
    error:
      "a quorum cannot require more distinct evidence sources than the number of agreeing descriptors it requires",
  });
/**
 * How much agreement is enough.
 *
 * `distinctEvidenceSources` is the field that makes the rest of it mean anything. A quorum of three
 * descriptors that all derive from the same underlying evidence is a quorum of one: on an
 * accessibility tree, `role-name` and `label-anchored` usually come from the same label element,
 * so if the vendor renames it both fail together and the "quorum" never fires. On a character grid
 * it is worse - role synthesis, name synthesis and label anchoring all derive from the same label
 * token on the same row, which is three descriptors that look independent and are perfectly
 * correlated. Counting SOURCES rather than descriptors is the whole control.
 */
export interface QuorumSchemaType extends SchemaIdentity<typeof quorumSchemaImpl> {}
export const QuorumSchema: QuorumSchemaType = quorumSchemaImpl;

export type Quorum = DeepReadonly<z.infer<typeof QuorumSchema>>;

const targetAssertionSchemaImpl = z.strictObject({
  role: RoleSchema,
  name: SafeTextMatcherSchema.optional(),
  enabled: z.boolean().optional(),
  visible: z.boolean().optional(),
  rowKeyEquals: RowKeySchema.optional(),
});
/**
 * Control C1. The identity of the thing we act on, re-derived from data we already know rather
 * than from where it sits.
 *
 * `rowKeyEquals` is the wrong-row killer: you cannot click the wrong member's row when the row is
 * selected by the member id the caller asked about. It costs one predicate evaluation and converts
 * two otherwise-silent failure modes into loud ones.
 */
export interface TargetAssertionSchemaType
  extends SchemaIdentity<typeof targetAssertionSchemaImpl> {}
export const TargetAssertionSchema: TargetAssertionSchemaType = targetAssertionSchemaImpl;

export type TargetAssertion = DeepReadonly<z.infer<typeof TargetAssertionSchema>>;

const nodeFingerprintSchemaImpl = z.strictObject({
  ariaRole: RoleSchema,
  name: z.string().max(1024).nullable(),
  containerPath: ContainerPathSchema,
  tablePosition: z
    .strictObject({
      rowHeader: z.string().max(256).nullable(),
      colHeader: z.string().max(256).nullable(),
    })
    .nullable(),
  boundsBucket: z.string().max(64).nullable(),
});
/**
 * For COMPARISON and DIAGNOSTICS only, never for lookup. Two descriptors "agree" exactly when they
 * select nodes with equal fingerprints.
 *
 * `boundsBucket` is quantised on purpose: it should survive a font rendering difference between two
 * machines and should not survive a redesign. It is evidence for a drift report, not an identity.
 */
export interface NodeFingerprintSchemaType
  extends SchemaIdentity<typeof nodeFingerprintSchemaImpl> {}
export const NodeFingerprintSchema: NodeFingerprintSchemaType = nodeFingerprintSchemaImpl;

export type NodeFingerprint = DeepReadonly<z.infer<typeof NodeFingerprintSchema>>;

const targetRefSchemaImpl = z
  .strictObject({
    scope: ContainerMatcherSchema,
    role: RoleSchema,
    descriptors: z.array(DescriptorSchema).min(2).max(8).readonly(),
    quorum: QuorumSchema,
    assert: TargetAssertionSchema,
    /** What was matched at record time, compared on replay to produce the drift signal. */
    recordedNode: NodeFingerprintSchema,
  })
  .superRefine((t, ctx) => {
    const ids = t.descriptors.map((d) => d.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue(
        "descriptor ids must be unique within a target, since an overlay disables by id",
      );
    }
    if (t.quorum.min > t.descriptors.length) {
      ctx.addIssue(
        `quorum.min is ${t.quorum.min} but only ${t.descriptors.length} descriptors are declared, so this target can never resolve`,
      );
    }
    const sources = new Set(t.descriptors.map((d) => d.evidenceSource));
    if (sources.size < t.quorum.distinctEvidenceSources) {
      ctx.addIssue(
        `quorum requires ${t.quorum.distinctEvidenceSources} distinct evidence sources but the declared descriptors offer only ${sources.size}`,
      );
    }
    // Save-time invariants 1 and 2, and linker check 11. A target whose best evidence is where the
    // control SITS has no evidence about what the control IS, and positional targeting is the thing
    // this section exists to avoid.
    const kinds = t.descriptors.map((d) => d.kind);
    const best = bestRank(kinds);
    if (best === null || best > 3) {
      ctx.addIssue(
        "a target needs at least one descriptor of rank 3 or better (role-name, label-anchored or table-cell); position alone is not an identity",
      );
    }
    const ordinals = kinds.filter((k) => k === "ordinal-in-container").length;
    if (ordinals === kinds.length) {
      ctx.addIssue("ordinal-in-container may not be a target's only kind of descriptor");
    }
    if (best !== null && best >= DESCRIPTOR_RANK["ordinal-in-container"] && ordinals > 0) {
      ctx.addIssue("ordinal-in-container may not be a target's highest-ranked descriptor");
    }
    if (t.assert.role !== t.role) {
      ctx.addIssue(
        `the target's role (${t.role}) and its assertion's role (${t.assert.role}) must agree, or the assertion is checking something the resolver never looked for`,
      );
    }
  });
/**
 * How a step names the thing it acts on.
 *
 * `scope` is required (control C3): resolution never searches the whole observation, which on a
 * frameset app is the difference between finding THE right "Search" button and finding A "Search"
 * button. `role` is required because it is the cheapest, most portable filter across surfaces and it
 * eliminates the most dangerous class of mis-hit - acting on a node of the wrong KIND.
 */
export interface TargetRefSchemaType extends SchemaIdentity<typeof targetRefSchemaImpl> {}
export const TargetRefSchema: TargetRefSchemaType = targetRefSchemaImpl;

export type TargetRef = DeepReadonly<z.infer<typeof TargetRefSchema>>;

/** Kinds present in a target, in declaration order. Used by the linker's check against
 *  what the driver advertises
 *  and by the drift report. */
export function descriptorKindsOf(target: {
  readonly descriptors: readonly { readonly kind: z.infer<typeof DescriptorKindSchema> }[];
}): readonly z.infer<typeof DescriptorKindSchema>[] {
  return target.descriptors.map((d) => d.kind);
}

/** Distinct evidence sources a target can currently offer. */
export function evidenceSourcesOf(target: {
  readonly descriptors: readonly {
    readonly evidenceSource: z.infer<typeof EvidenceSourceSchema>;
  }[];
}): readonly z.infer<typeof EvidenceSourceSchema>[] {
  return [...new Set(target.descriptors.map((d) => d.evidenceSource))];
}
