// The descriptor vocabulary, and the rank table that deliberately does not live in the artifact.
//
// This is a leaf module on purpose. `observation.ts` needs `DescriptorKind` to advertise what a
// surface can resolve, `descriptors.ts` needs it to define the descriptors themselves, and
// `diagnostics.ts` needs the verdicts to report on them. Putting the three vocabularies in the
// module that owns any one of those three would make the other two import it, and the cycle would
// be the kind that only shows up as an undefined export at load time.

import { z } from "zod";

export const DescriptorKindSchema = z.enum([
  "role-name",
  "label-anchored",
  "table-cell",
  "ordinal-in-container",
  "geometric",
]);
export type DescriptorKind = z.infer<typeof DescriptorKindSchema>;

/**
 * What a descriptor's conclusion is *made of*. SPEC section 5.1 calls the count of distinct
 * sources the most important field in that section, and this enum is why: three descriptors that
 * all read the same label are a quorum of one, and only the source says so.
 */
export const EvidenceSourceSchema = z.enum([
  "accessibleName",
  "labelText",
  "columnHeader",
  "ordinal",
  "geometry",
]);
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;

/**
 * What a descriptor concluded on one observation.
 *
 * `abstained` and `non-unique` are kept apart because they mean different things to the human
 * reading a drift report: the first is "this identity is gone", the second is "this identity is no
 * longer unique", and the repair differs. `disabled` is an overlay's doing and is recorded rather
 * than elided, because an overlay silently removing evidence is exactly what the fingerprint
 * exists to make visible.
 */
export const DescriptorVerdictSchema = z.enum([
  "resolved",
  "abstained",
  "non-unique",
  "disabled",
  "disagreed",
]);
export type DescriptorVerdict = z.infer<typeof DescriptorVerdictSchema>;

/**
 * Rank is a property of the KIND and lives here, never in the artifact.
 *
 * SPEC section 5.1 is explicit about why: if rank were a field on a descriptor, a tenant overlay
 * could promote `ordinal-in-container` into first place and quietly reintroduce the positional
 * targeting this design exists to avoid - and it would do so in the one document reviewed to a
 * config file's standard rather than a program's.
 */
export const DESCRIPTOR_RANK: Readonly<Record<DescriptorKind, number>> = {
  "role-name": 1,
  "label-anchored": 2,
  "table-cell": 3,
  "ordinal-in-container": 4,
  geometric: 5,
};

/** The best (numerically lowest) rank in a set of kinds, or `null` for an empty set. */
export function bestRank(kinds: readonly DescriptorKind[]): number | null {
  let best: number | null = null;
  for (const kind of kinds) {
    const rank = DESCRIPTOR_RANK[kind];
    if (best === null || rank < best) best = rank;
  }
  return best;
}

/**
 * The evidence source each kind is allowed to claim.
 *
 * The pairing is fixed rather than free because the quorum counts *sources*. A descriptor free to
 * declare any source could declare a false one and manufacture independence that does not exist,
 * which would turn the single most important safety property in section 5 into decoration.
 * `descriptors.ts` pins each arm's `evidenceSource` to a literal; this table is what a derivation
 * step checks itself against.
 */
export const DESCRIPTOR_EVIDENCE_SOURCE: Readonly<Record<DescriptorKind, EvidenceSource>> = {
  "role-name": "accessibleName",
  "label-anchored": "labelText",
  "table-cell": "columnHeader",
  "ordinal-in-container": "ordinal",
  geometric: "geometry",
};
