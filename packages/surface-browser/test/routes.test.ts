import type { RouteLocation, RoutePattern } from "@crr/core";
import { describe, expect, it } from "vitest";
import { canonicalizeLocation, navigationTargetOf, resolveOrigins } from "../src/routes.js";

const routes = [
  { id: "search", originAlias: "corebank", path: "/search", frame: "content" },
  { id: "results", originAlias: "corebank", path: "/search/results", frame: "content" },
  { id: "detail", originAlias: "corebank", path: "/member/:memberId", frame: "content" },
  { id: "subaccounts", originAlias: "corebank", path: "/member/:memberId/subaccounts" },
] as unknown as readonly RoutePattern[];

const config = { origins: { corebank: "http://127.0.0.1:8731" }, routes };

describe("canonicalizeLocation", () => {
  it("replaces the data in the path with the pattern that describes it", () => {
    // This is the privacy control, not a tidying pass: an Observation is written to an evidence
    // directory, and `/member/10041` in a path is persisted member data.
    expect(canonicalizeLocation("http://127.0.0.1:8731/member/10041", "content", config)).toEqual({
      originAlias: "corebank",
      path: "/member/:memberId",
      query: {},
      frame: "content",
    });
  });

  it("keeps query values, because the classifier compares them against the caller's arguments", () => {
    expect(
      canonicalizeLocation(
        "http://127.0.0.1:8731/search/results?lastName=PARKER",
        "content",
        config,
      ),
    ).toEqual({
      originAlias: "corebank",
      path: "/search/results",
      query: { lastName: "PARKER" },
      frame: "content",
    });
  });

  it("resolves a tenant mounted under a path prefix to the same route", () => {
    const summit = { origins: { corebank: "http://127.0.0.1:8731/cb" }, routes };
    expect(
      canonicalizeLocation("http://127.0.0.1:8731/cb/member/10041", "content", summit)?.path,
    ).toBe("/member/:memberId");
  });

  it("prefers the most specific pattern and breaks ties deterministically", () => {
    expect(canonicalizeLocation("http://127.0.0.1:8731/search", "content", config)?.path).toBe(
      "/search",
    );
  });

  it("omits the frame for the top document", () => {
    const location = canonicalizeLocation(
      "http://127.0.0.1:8731/member/10041/subaccounts",
      "",
      config,
    );
    expect(location).toEqual({
      originAlias: "corebank",
      path: "/member/:memberId/subaccounts",
      query: {},
    });
  });

  it("respects a pattern that is scoped to one frame", () => {
    expect(canonicalizeLocation("http://127.0.0.1:8731/search", "banner", config)).toBeNull();
  });

  it("FAILS CLOSED on an undeclared path rather than passing the raw one through", () => {
    // The raw path is exactly where a member number lives. `null` makes `route-matches` false,
    // which is both true and safe; a leaked path is neither.
    expect(canonicalizeLocation("http://127.0.0.1:8731/admin/10041", "content", config)).toBeNull();
  });

  it("fails closed on an origin this capability was never given", () => {
    expect(canonicalizeLocation("http://evil.test/search", "content", config)).toBeNull();
    expect(canonicalizeLocation("about:blank", "content", config)).toBeNull();
  });

  it("does not confuse a prefix of a host or of a base path for a match", () => {
    const summit = { origins: { corebank: "http://127.0.0.1:8731/cb" }, routes };
    expect(canonicalizeLocation("http://127.0.0.1:8731/cbx/search", "content", summit)).toBeNull();
  });
});

describe("resolveOrigins", () => {
  it("puts the longest base path first, so a mounted tenant wins over the bare host", () => {
    const resolved = resolveOrigins({ bare: "http://h:1", mounted: "http://h:1/cb" });
    expect(resolved.map((each) => each.alias)).toEqual(["mounted", "bare"]);
    expect(resolved[1]?.basePath).toBe("");
  });

  it("drops a malformed base instead of failing the other tenants with it", () => {
    expect(resolveOrigins({ good: "http://h:1", bad: "not a url" }).map((e) => e.alias)).toEqual([
      "good",
    ]);
  });
});

describe("navigationTargetOf", () => {
  const location = (path: string, query: Record<string, string> = {}): RouteLocation =>
    ({ originAlias: "corebank", path, query }) as RouteLocation;

  it("builds a real url from a concrete location", () => {
    expect(navigationTargetOf(location("/member/10041", { tab: "share" }), config)).toEqual({
      url: "http://127.0.0.1:8731/member/10041?tab=share",
      frame: null,
    });
  });

  it("prepends the tenant's base path", () => {
    const summit = { origins: { corebank: "http://127.0.0.1:8731/cb" }, routes };
    expect(navigationTargetOf(location("/search"), summit)).toEqual({
      url: "http://127.0.0.1:8731/cb/search",
      frame: null,
    });
  });

  it("refuses a path whose arguments were never substituted", () => {
    // Navigating to the literal string `/member/:memberId` produces a 404 that then gets classified
    // as an application error, three steps from the bug.
    expect(navigationTargetOf(location("/member/:memberId"), config)).toBe("uncanonicalized-path");
  });

  it("refuses an origin alias this tenant has no host for", () => {
    expect(
      navigationTargetOf({ ...location("/search"), originAlias: "other" } as RouteLocation, config),
    ).toBe("unknown-origin");
  });

  it("carries the frame a route lands in", () => {
    const framed = { ...location("/search"), frame: "content" } as RouteLocation;
    expect(navigationTargetOf(framed, config)).toEqual({
      url: "http://127.0.0.1:8731/search",
      frame: "content",
    });
  });
});
