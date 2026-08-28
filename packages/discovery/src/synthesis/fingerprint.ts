// `SurfaceFingerprint` - SPEC section 2.4, and the input to the drift signal of section 9.4.
//
// One digest per step of the structural skeleton the step ran against, recorded at discovery and
// compared at replay. It is not a locator, it is not read by the decision path, and it never
// decides anything: SPEC section 5.5 is explicit that drift is a signal on success and never a
// verdict. Its job is to let an operator see a margin thinning before the day it reaches zero.
//
// WHAT YOU FINGERPRINT IS ITSELF A DESIGN DECISION, and writing it down is worth more than the
// number. The terminal spike measured the same two tenants of one vendor product diverging 63% over
// all nodes and 40% over interactive nodes only, so this uses INTERACTIVE NODES ONLY - a rebrand
// changes headings, footers and helper text, and a fingerprint that screams at every rebrand is a
// fingerprint people learn to ignore.
//
// TWO DEPARTURES FROM THE LITERAL WORDING OF SPEC 2.4, both deliberate:
//
//   1. It says "name-shape". This uses the PARAMETERIZED NAME instead: the real accessible name
//      where it carries no bound value, and `{memberId}` where it does. The reason the spec reaches
//      for a shape is that a raw name can carry a member number, and a hash of a five-digit member
//      number is not a one-way function in any useful sense - the search space is a hundred
//      thousand entries. Substituting the parameter hole removes the value completely while
//      keeping the discrimination a coarse shape would throw away, and it is the same substitution
//      every other field in the document already gets.
//   2. It says "excluding the branding band". No `Observation` field marks one. The honest
//      approximation is interactive nodes only, and the seam is named rather than papered over: a
//      driver that can identify its own branding band should mark those nodes `live`, which this
//      already excludes, and then this comment can be deleted.

import { INTERACTIVE_ROLES, type Observation, type Role, type UINode, digestOf } from "@crr/core";
import { type ValueBinding, parameterizeText } from "./values.js";

/**
 * The roles a person can act on - `@crr/core`'s `INTERACTIVE_ROLES`, not a second list.
 *
 * `text`, `heading`, `image`, `region` and the structural roles are absent on purpose: they are
 * exactly the band a rebrand moves. `alert` and `status` are absent for a different reason - they
 * carry a transient message, so including them would make the fingerprint change between two runs
 * of the same unchanged screen.
 *
 * IMPORTED RATHER THAN DECLARED. The cross-tenant divergence report in `@crr/core` compares two
 * tenants over the same band, and this fingerprint is what a run is compared against; two copies of
 * "what counts as interactive" that must agree, in two packages, with no test that would notice
 * them drifting apart, is the exact shape of the `TargetOutcome.kind` / `.status` bug this
 * repository has already paid for once.
 */
const INTERACTIVE: ReadonlySet<Role> = INTERACTIVE_ROLES;

interface SkeletonEntry {
  readonly role: Role;
  readonly name: string;
  readonly containerPath: readonly unknown[];
  readonly disabled: boolean;
}

/**
 * The digest of one screen's interactive skeleton, plus where the screen was.
 *
 * Sorted rather than kept in document order: two drivers that walk a frameset in a different order
 * describe the same screen, and a fingerprint that changed because the traversal changed would be
 * reporting on the driver rather than on the application. It is a MULTISET, per SPEC section 2.4.
 */
export function surfaceFingerprintOf(
  observation: Observation,
  bindings: readonly ValueBinding[],
): string {
  const skeleton: SkeletonEntry[] = [];
  for (const node of observation.nodes) {
    if (node.ariaRole === null || node.live) continue;
    if (!INTERACTIVE.has(node.ariaRole)) continue;
    skeleton.push(entryOf(node, bindings));
  }
  skeleton.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  return digestOf({
    route:
      observation.route === null
        ? null
        : { originAlias: observation.route.originAlias, path: observation.route.path },
    surface: observation.surface.kind,
    skeleton,
  });
}

function entryOf(node: UINode, bindings: readonly ValueBinding[]): SkeletonEntry {
  return {
    role: node.ariaRole as Role,
    name: parameterizeText(node.name, bindings),
    containerPath: node.containerPath as readonly unknown[],
    disabled: node.state.disabled,
  };
}

function keyOf(entry: SkeletonEntry): string {
  return JSON.stringify([entry.role, entry.name, entry.containerPath, entry.disabled]);
}
