// Route canonicalization - SPEC section 6.3 step 4, and the "stretch goal" BRIEF section 3.6 says
// falls out of parameterization rather than being built beside it.
//
// `/member/12345` becomes `/members/:memberId`. Two problems die at once, which is the whole
// argument for doing it here: a literal path in an artifact is PERSISTED MEMBER DATA, and a literal
// origin makes an artifact accidentally single-tenant. The `RoutePattern` type refuses both by
// construction - it holds an origin ALIAS the overlay resolves per tenant and a path PATTERN - and
// this file is what turns what the run actually visited into one.
//
// The rule that matters most is the one for a segment that looks like an identifier and matched NO
// parameter. It is tempting to keep it: it is concrete, it is what the run saw, and the route would
// replay. It is also, in a back office, almost certainly an account number - so it is replaced by a
// hole that names nothing and the report says a person has to decide where that value comes from.
// A route pattern that is slightly too general fails loudly at the checkpoint; a route pattern with
// a member's account number in it fails a compliance audit two years later.

import {
  type RouteId,
  RouteIdSchema,
  type RouteLocation,
  type RoutePattern,
  type ValueRef,
  piiShapeOf,
} from "@crr/core";
import type { SynthesisNote } from "./report.js";
import { type ValueBinding, fieldNameOf, slugOf, uniqueName } from "./values.js";

/** All digits and long enough to be a record key rather than a page number or a version. */
const IDENTIFIER_DIGITS = /^[0-9]{3,}$/;

/** A path segment already written as a pattern hole. A driver may have canonicalized before us. */
const ALREADY_A_HOLE = /^:[A-Za-z][A-Za-z0-9_]*$/;

export interface CanonicalRoute {
  readonly id: RouteId;
  readonly pattern: RoutePattern;
}

/**
 * The set of route patterns a program touches, built as the run is walked.
 *
 * Stateful on purpose: a route id has to be the SAME id every time the same canonical path is
 * visited, or `route-matches` in one step's checkpoint would name a different pattern from the
 * `navigate` that produced it, and the flow would fail to link for a reason nobody could see.
 */
export class RouteTable {
  private readonly byKey = new Map<string, CanonicalRoute>();
  private readonly takenIds = new Set<string>();
  private readonly takenHoles: Set<string>;
  private readonly collected: SynthesisNote[] = [];

  /**
   * `takenNames` is the set of parameter names already spoken for.
   *
   * A hole minted for an unbound path segment is derived from the segment before it - `/accounts/x`
   * becomes `:accountId` - and nothing stops that name colliding with a real parameter of the same
   * spelling. A collision would read as though the route were addressed by the caller's argument
   * when it is not, which is the sort of thing a reviewer takes at face value.
   */
  constructor(
    private readonly bindings: readonly ValueBinding[],
    takenNames: ReadonlySet<string> = new Set(),
  ) {
    this.takenHoles = new Set(takenNames);
  }

  /** The canonical pattern for a location the run actually visited. */
  routeFor(location: RouteLocation): CanonicalRoute {
    const path = this.canonicalPath(location.path);
    const key = `${location.originAlias}|${path}|${location.frame ?? ""}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;

    const id = RouteIdSchema.parse(uniqueName(routeIdOf(path), this.takenIds));
    const query = this.canonicalQuery(location.query);
    const base = { id, originAlias: location.originAlias, path };
    const withFrame = location.frame === undefined ? base : { ...base, frame: location.frame };
    const pattern: RoutePattern = query === null ? withFrame : { ...withFrame, query };
    const route: CanonicalRoute = { id, pattern };
    this.byKey.set(key, route);
    return route;
  }

  /** Declared in visit order, which is the order a reviewer reads the flow in. */
  patterns(): readonly RoutePattern[] {
    return [...this.byKey.values()].map((route) => route.pattern);
  }

  notes(): readonly SynthesisNote[] {
    return this.collected;
  }

  private canonicalPath(path: string): string {
    const segments = path.split("/");
    const out: string[] = [];
    segments.forEach((segment, index) => {
      out.push(this.canonicalSegment(segment, segments[index - 1] ?? ""));
    });
    const joined = out.join("/");
    return joined.startsWith("/") ? joined : `/${joined}`;
  }

  private canonicalSegment(segment: string, previous: string): string {
    if (segment.length === 0 || ALREADY_A_HOLE.test(segment)) return segment;

    // A segment that IS, or merely CONTAINS, a bound value becomes that parameter's hole. Whole
    // segment either way: `/m50001` reduced to `/m:memberId` would be a pattern no route matcher
    // can read, and the point is to remove the value, not to preserve the spelling around it.
    for (const binding of this.bindings) {
      if (binding.value.length === 0) continue;
      if (segment.toLowerCase().includes(binding.value.toLowerCase())) {
        this.collected.push({
          code: "route-canonicalized",
          severity: "info",
          detail: `a path segment was replaced by :${binding.param}`,
        });
        return `:${binding.param}`;
      }
    }

    if (!looksLikeIdentifier(segment)) return segment;

    const hole = uniqueName(holeNameOf(previous), this.takenHoles, "_");
    this.collected.push({
      code: "route-segment-unbound",
      severity: "review",
      detail: `a path segment under "${previous}" has the shape of a record identifier but matched no parameter; it was replaced by :${hole} and a person must say where a caller gets that value`,
    });
    return `:${hole}`;
  }

  /**
   * Query values, by the same rule as path segments.
   *
   * `:any` rather than a hole for an unbound identifier: a query parameter is far more often a
   * page cursor or a session nonce than something a caller supplies, and `routeMatches` treats
   * `:any` as "present, contents not compared" - which is exactly the claim we can defend.
   */
  private canonicalQuery(
    query: Readonly<Record<string, string>>,
  ): Readonly<Record<string, ValueRef | ":any">> | null {
    const entries = Object.entries(query);
    if (entries.length === 0) return null;
    const built: Record<string, ValueRef | ":any"> = {};
    for (const [key, value] of entries) {
      const bound = this.bindings.find(
        (binding) =>
          binding.value.length > 0 && value.toLowerCase() === binding.value.toLowerCase(),
      );
      if (bound !== undefined) {
        built[key] = { from: "param", param: bound.param };
        continue;
      }
      built[key] = ":any";
      if (looksLikeIdentifier(value)) {
        this.collected.push({
          code: "route-segment-unbound",
          severity: "review",
          detail: `the query parameter "${key}" carried an identifier-shaped value that matched no parameter; the pattern requires it to be present but never compares it`,
        });
      }
    }
    return built;
  }
}

/** Conservative on purpose. A false positive costs a slightly-too-general route pattern; a false
 *  negative persists an account number in a committed file. */
export function looksLikeIdentifier(segment: string): boolean {
  if (IDENTIFIER_DIGITS.test(segment)) return true;
  return piiShapeOf(segment) !== null;
}

/** `/members/:x` from `members` becomes `memberId` - the name a person would have chosen. */
function holeNameOf(previous: string): string {
  const singular = previous.endsWith("s") ? previous.slice(0, -1) : previous;
  const base = fieldNameOf(singular, "id");
  return base === "id" ? "id" : `${base}Id`;
}

/**
 * A route id a person can read in a diff: `/members/:memberId` becomes `members-by-memberid`.
 *
 * The id is derived from the CANONICAL path, so it can never carry the value the canonicalization
 * just removed - which is the mistake a naive "slugify the URL" would make.
 */
function routeIdOf(path: string): string {
  const parts = path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => (segment.startsWith(":") ? `by-${segment.slice(1)}` : segment));
  const joined = parts.length === 0 ? "root" : parts.join("-");
  return slugOf(joined, "route");
}
