// The two directions a location travels across this port, and they are deliberately not symmetric.
//
//   PERCEIVE:  a real url  ->  a CANONICALIZED `RouteLocation`.  `/member/10041` becomes
//              `/member/:memberId`, because an `Observation` is a document that gets written to an
//              evidence directory and a member number in a path is persisted member data. This is
//              the same move SPEC section 3.6 makes about parameters: canonicalization IS the
//              privacy control, not a tidying pass.
//
//   ACT:       a CONCRETE `RouteLocation`  ->  a real url.  The runtime has already substituted the
//              caller's arguments into the route by the time a `navigate` action reaches the driver,
//              so a path still carrying a `:placeholder` is a bug upstairs - and navigating to the
//              literal string `/member/:memberId` would produce a 404 page that then gets classified
//              as an application error. That is refused as `navigation-blocked` instead.
//
// The origin table is the other half. An artifact names an origin ALIAS - `corebank` - and never a
// host, so one artifact runs at every tenant; the alias is resolved here, from configuration the
// runtime supplies per tenant. A base may carry a path prefix (`https://host/cb`), which is how the
// same vendor product deployed under a different mount point at the next credit union stays one
// artifact.

import { type RouteLocation, type RoutePattern, routePatternMatches } from "@crr/core";

export interface RouteConfig {
  /** Origin alias -> the base url it resolves to at this tenant. May include a path prefix. */
  readonly origins: Readonly<Record<string, string>>;
  /** The routes this capability declares. Nothing outside this list is canonicalizable, and an
   *  un-canonicalizable location is reported as no location at all - see `canonicalizeLocation`. */
  readonly routes: readonly RoutePattern[];
}

interface ResolvedOrigin {
  readonly alias: string;
  readonly origin: string;
  /** Normalized with no trailing slash, so `""` and `"/cb"` are the only two shapes. */
  readonly basePath: string;
}

/** Parse the origin table once. A malformed base is dropped rather than thrown on: the driver's job
 *  is to report what it can see, and a typo in one tenant's configuration should not stop the
 *  others from resolving. */
export function resolveOrigins(
  origins: Readonly<Record<string, string>>,
): readonly ResolvedOrigin[] {
  const out: ResolvedOrigin[] = [];
  for (const [alias, base] of Object.entries(origins)) {
    const parsed = tryUrl(base);
    if (parsed === null) continue;
    out.push({
      alias,
      origin: parsed.origin,
      basePath: parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, ""),
    });
  }
  // Longest prefix first, so `https://host/cb` wins over `https://host` for a summit url.
  return out.sort((a, b) => b.basePath.length - a.basePath.length);
}

/**
 * A real url, canonicalized against the declared routes, or `null`.
 *
 * `null` when the url is at an origin this capability does not know, or on a path no declared route
 * matches. FAIL CLOSED IS THE POINT: the tempting alternative is to pass the raw path through when
 * nothing matches, and the raw path is exactly where a member number lives. A `null` route makes
 * `route-matches` false, which is both true and safe; a leaked path is neither.
 */
export function canonicalizeLocation(
  rawUrl: string,
  frameName: string,
  config: RouteConfig,
  origins: readonly ResolvedOrigin[] = resolveOrigins(config.origins),
): RouteLocation | null {
  const url = tryUrl(rawUrl);
  if (url === null) return null;
  const origin = origins.find(
    (candidate) =>
      candidate.origin === url.origin &&
      (candidate.basePath === "" ||
        url.pathname === candidate.basePath ||
        url.pathname.startsWith(`${candidate.basePath}/`)),
  );
  if (origin === undefined) return null;

  const path = url.pathname.slice(origin.basePath.length) || "/";
  const candidates = config.routes.filter(
    (route) =>
      route.originAlias === origin.alias &&
      (route.frame === undefined || route.frame === frameName) &&
      routePatternMatches(route.path, path),
  );
  if (candidates.length === 0) return null;
  // Most specific wins, and ties break on the path text so the same url always canonicalizes the
  // same way. Two patterns that differ only in placeholder names are the same route twice.
  const pattern = [...candidates].sort(
    (a, b) => placeholders(a.path) - placeholders(b.path) || (a.path < b.path ? -1 : 1),
  )[0] as RoutePattern;

  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  return frameName.length > 0
    ? { originAlias: origin.alias, path: pattern.path, query, frame: frameName }
    : { originAlias: origin.alias, path: pattern.path, query };
}

/** Why a `navigate` cannot be turned into a url, or `null` when it can. */
export type NavigationRefusal = "unknown-origin" | "uncanonicalized-path";

export interface NavigationTarget {
  readonly url: string;
  /** The frame to navigate, by name, or `null` for the top document. */
  readonly frame: string | null;
}

/** A concrete `RouteLocation` as a url, or the reason it is refused. */
export function navigationTargetOf(
  route: RouteLocation,
  config: RouteConfig,
  origins: readonly ResolvedOrigin[] = resolveOrigins(config.origins),
): NavigationTarget | NavigationRefusal {
  const origin = origins.find((candidate) => candidate.alias === route.originAlias);
  if (origin === undefined) return "unknown-origin";
  if (placeholders(route.path) > 0) return "uncanonicalized-path";
  const url = new URL(`${origin.origin}${origin.basePath}${route.path}`);
  for (const [key, value] of Object.entries(route.query)) url.searchParams.set(key, value);
  return { url: url.toString(), frame: route.frame ?? null };
}

function placeholders(path: string): number {
  let count = 0;
  for (const segment of path.split("/")) if (segment.startsWith(":") || segment === "*") count += 1;
  return count;
}

function tryUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
