// The cross-tenant divergence report, over frozen screens and nothing running (SPEC section 9.4).
//
// Two properties are worth more than the rest and both have a test with their name on it:
//
//   1. THE METRIC IS PINNED, AND ITS DEPARTURE FROM THE TERMINAL SPIKE'S IS PINNED WITH IT. The
//      spike reported `shared 3/8 -> 63%`; this ships Jaccard, which makes the same two screens
//      `shared 3/13 -> 77%`. `divergence.ts` says why (the spike's arithmetic reports zero when one
//      tenant is a strict superset of the other). The spike's own worked example is reproduced here
//      as a test, with BOTH numbers, so nobody has to rediscover the difference by hand.
//   2. NO THRESHOLD SHIPS. `needsSpecialization` is `null` and the TYPE says `null` - not `boolean`
//      defaulted to false, which is a verdict wearing the costume of an absence of one.
//
// Everything here is a pure function over two `Observation`s. No browser, no clock, no I/O.

import { describe, expect, it } from "vitest";
import {
  INTERACTIVE_ROLES,
  type Observation,
  type UINode,
  compareKeys,
  compareSurfaces,
  crossTenantDivergence,
  divergenceKeyOf,
  renderDivergence,
  surfaceKeysOf,
} from "../src/index.js";
import { detail, results, searchForm } from "./fixtures/corebank-observations.js";

/** The same screen with a set of accessible names rewritten - which is what a second tenant of one
 *  vendor product looks like from the accessibility tree's point of view. */
const renamed = (obs: Observation, words: Readonly<Record<string, string>>): Observation =>
  ({
    ...obs,
    nodes: obs.nodes.map((n) => (words[n.name] === undefined ? n : { ...n, name: words[n.name] })),
  }) as Observation;

const withNode = (obs: Observation, patch: (n: UINode) => UINode): Observation =>
  ({ ...obs, nodes: obs.nodes.map(patch) }) as Observation;

describe("the key a comparison is taken over", () => {
  it("is the node's role and its folded name, and nothing that moves on its own", () => {
    const [first] = searchForm.nodes.filter((n) => n.ariaRole === "button");
    expect(first).toBeDefined();
    if (first === undefined) return;
    const key = divergenceKeyOf(first);
    // Folded, so a tenant that shouts its buttons is not reported as a different application.
    expect(divergenceKeyOf({ ...first, name: first.name.toUpperCase() } as UINode)).toBe(key);
    // The id is a per-observation handle: comparing it would report on the driver.
    expect(divergenceKeyOf({ ...first, id: "node:something-else" } as UINode)).toBe(key);
    // Geometry moves with a font, and a value moves with the member.
    expect(divergenceKeyOf({ ...first, bounds: null, value: "changed" } as UINode)).toBe(key);
    // The role does not.
    expect(divergenceKeyOf({ ...first, ariaRole: "link" } as UINode)).not.toBe(key);
  });

  it("skips a live node, whose text changes without the application changing", () => {
    const withClock = withNode(searchForm, (n) =>
      n.ariaRole === "text" ? ({ ...n, live: true } as UINode) : n,
    );
    expect(surfaceKeysOf(withClock, "all").length).toBeLessThan(
      surfaceKeysOf(searchForm, "all").length,
    );
  });

  it("counts a MULTISET, so a grid with four Open links differs from one with two", () => {
    const doubled = { ...results, nodes: [...results.nodes, ...results.nodes] } as Observation;
    expect(surfaceKeysOf(doubled, "all").length).toBe(surfaceKeysOf(results, "all").length * 2);
    expect(compareSurfaces(results, doubled, "all").divergence).toBeGreaterThan(0);
  });

  it("restricts the interactive band to the roles a person can act on", () => {
    const keys = surfaceKeysOf(results, "interactive");
    const interactive = results.nodes.filter(
      (n) => !n.live && n.ariaRole !== null && INTERACTIVE_ROLES.has(n.ariaRole),
    );
    expect(keys).toHaveLength(interactive.length);
    expect(keys.length).toBeLessThan(surfaceKeysOf(results, "all").length);
    // The structural roles a rebrand moves are the ones that are absent.
    for (const role of ["heading", "text", "row", "cell", "table", "region"] as const) {
      expect(INTERACTIVE_ROLES.has(role)).toBe(false);
    }
  });
});

describe("the distance, and the one place it departs from the terminal spike's", () => {
  it("reproduces the spike's worked example, and pins BOTH readings of it", () => {
    // docs/design/spike-terminal-surface.md section 3.4, transcribed. Two tenants of one green
    // screen: three headings and two textboxes renamed, three buttons identical.
    const riverbend = [
      "heading:riverbend-cu",
      "heading:member-inquiry",
      "heading:teller-04",
      "textbox:account-number",
      "textbox:name-search",
      "button:exit",
      "button:next-field",
      "button:search",
    ];
    const summit = [
      "heading:summit-fcu",
      "heading:mbr-inq",
      "heading:tlr-17",
      "textbox:acct",
      "textbox:search-name",
      "button:exit",
      "button:next-field",
      "button:search",
    ];
    const all = compareKeys(riverbend, summit, "all");
    expect(all.shared).toBe(3);
    expect(all.union).toBe(13);
    // THE DEPARTURE, PINNED. The spike divided the shared count by ONE SIDE's node count and got
    // 3/8 -> 63%. This divides by the union and gets 3/13 -> 77%. Both are computed here so that
    // the relationship between the two documents is a test rather than a paragraph, and so that
    // changing the shipped metric breaks a test that names the alternative.
    expect(all.divergence).toBe(0.7692);
    expect(Number((1 - all.shared / all.leftNodes).toFixed(3))).toBe(0.625);

    // Interactive only, i.e. the five non-heading nodes: three shared of seven.
    const interactive = compareKeys(riverbend.slice(3), summit.slice(3), "interactive");
    expect(interactive.shared).toBe(3);
    expect(interactive.divergence).toBeLessThan(all.divergence);
  });

  it("is 0 for a screen against itself and 1 for two screens sharing nothing", () => {
    expect(compareSurfaces(results, results, "all").divergence).toBe(0);
    expect(compareSurfaces(results, results, "interactive").divergence).toBe(0);
    // Not "an error": a report of 100% is exactly what comparing the WRONG two screens looks like,
    // and the caller has to be able to see that rather than have it thrown at them.
    expect(compareKeys(["a"], ["b"], "all").divergence).toBe(1);
    // Two blank screens have not diverged - they have failed, which is a different report.
    expect(compareKeys([], [], "all").divergence).toBe(0);
  });

  it("names what changed, on both sides, so the fraction is never the only thing on the page", () => {
    const summit = renamed(searchForm, { Search: "Find" });
    const band = compareSurfaces(searchForm, summit, "interactive");
    const keys = band.changed.map((c) => c.key).join(" ");
    expect(keys).toContain("search");
    expect(keys).toContain("find");
    // One side has it and the other does not, and the row says which.
    const gone = band.changed.find((c) => c.key.includes("search"));
    expect(gone?.left).toBe(1);
    expect(gone?.right).toBe(0);
  });

  it("is order-independent, so two drivers walking a frameset differently agree", () => {
    const shuffled = { ...results, nodes: [...results.nodes].reverse() } as Observation;
    expect(compareSurfaces(results, shuffled, "all").divergence).toBe(0);
  });
});

describe("the report over several screens", () => {
  const report = () =>
    crossTenantDivergence({
      leftTenantId: "riverbend",
      rightTenantId: "summit",
      screens: [
        {
          screen: "member-search",
          left: searchForm,
          right: renamed(searchForm, { Search: "Find" }),
        },
        { screen: "member-results", left: results, right: renamed(results, { Select: "Open" }) },
        { screen: "member-detail", left: detail, right: detail },
      ],
    });

  it("reports every screen in both bands, and pools rather than averages", () => {
    const r = report();
    expect(r.screens.map((s) => s.screen)).toEqual([
      "member-search",
      "member-results",
      "member-detail",
    ]);
    // The unchanged screen contributes 0 and still contributes its NODES, which is the difference
    // between pooling and averaging: an average over screens weights a two-control dialog the same
    // as a five-hundred-node grid.
    expect(r.screens[2]?.all.divergence).toBe(0);
    expect(r.overall.all.union).toBe(r.screens.reduce((n, s) => n + s.all.union, 0));
    expect(r.overall.all.divergence).toBeGreaterThan(0);
  });

  it("does not let a label on one screen cancel the same label on another", () => {
    // Pooled keys are prefixed by screen. Without that, a "Search" button that MOVED from the
    // search screen to the results screen would pool as unchanged, and a control moving between
    // screens is precisely a per-tenant difference somebody wants to know about.
    const moved = crossTenantDivergence({
      leftTenantId: "a",
      rightTenantId: "b",
      screens: [
        { screen: "one", left: searchForm, right: results },
        { screen: "two", left: results, right: searchForm },
      ],
    });
    expect(moved.overall.all.divergence).toBeGreaterThan(0);
  });

  it("SHIPS NO THRESHOLD: needsSpecialization is null, and the type says null", () => {
    const r = report();
    expect(r.needsSpecialization).toBeNull();
    // A compile-time seam, not only a runtime assertion. Widening this field to a boolean is the
    // change that would let somebody hard-code a cutoff, and it stops compiling here first.
    const noVerdict: null = r.needsSpecialization;
    expect(noVerdict).toBeNull();
  });

  it("renders the same block twice for the same inputs", () => {
    const rendered = renderDivergence(report());
    expect(rendered).toBe(renderDivergence(report()));
    expect(rendered).toContain("cross-tenant divergence  riverbend -> summit");
    expect(rendered).toContain("OVERALL");
    expect(rendered).toContain("needsSpecialization: null");
  });
});
