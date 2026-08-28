// Two tenants of one vendor product, and what survives the difference.
//
// This is the terminal half of BRIEF section 3.8, and it is the strongest single piece of evidence
// this package produces for REPORT section 4. Between `riverbend` and `summit` the branding, the
// screen names, the field labels, the field widths, the field positions and the exit key all
// change, and NOT ONE COORDINATE MATCHES - yet the detector recovers the same two fields, the same
// three controls, the same roles, and a `button:exit` whose id is identical on both.
//
// The numbers below are measured off the committed grids, not asserted from memory, and the point
// of measuring two of them is that WHAT YOU FINGERPRINT DECIDES WHAT YOU CONCLUDE: include the
// branding band and these look like two different applications; exclude it and they look like one
// application with a vocabulary overlay, which is what they are.

import { describe, expect, it } from "vitest";
import type { DetectedNode } from "../src/detect.js";
import { screen } from "./support/corpus.js";

const riverbend = screen("initial");
const summit = screen("summitInitial");

const ids = (nodes: readonly DetectedNode[]) => new Set(nodes.map((n) => n.id));
const interactive = (s: ReturnType<typeof screen>) =>
  s.nodes.filter((n) => n.role === "textbox" || n.role === "button");

/** The spike's measure: the share of the larger tenant's nodes the two do NOT have in common. */
const divergence = (a: Set<string>, b: Set<string>): number => {
  const shared = [...a].filter((id) => b.has(id)).length;
  return Math.round((1 - shared / Math.max(a.size, b.size)) * 100);
};

describe("the same vendor product, two credit unions", () => {
  it("shares no field position at all", () => {
    const rb = riverbend.nodes.find((n) => n.role === "textbox");
    const sm = summit.nodes.find((n) => n.role === "textbox");
    expect(rb?.bounds).not.toEqual(sm?.bounds);
    expect(rb?.capacity).toBe(12);
    expect(sm?.capacity).toBe(10);
  });

  it("recovers the same STRUCTURE anyway: two fields and three controls on each", () => {
    for (const s of [riverbend, summit]) {
      expect(s.nodes.filter((n) => n.role === "textbox")).toHaveLength(2);
      expect(s.nodes.filter((n) => n.role === "button")).toHaveLength(3);
    }
  });

  it("gives Exit the SAME node id on both, and a different key", () => {
    // The whole multi-tenant argument in one assertion. A step that says "activate the control
    // named Exit" replays unmodified at both credit unions; a step that said `pressKey(F3)` would
    // be correct at one and wrong at the next. That is a per-tenant difference needing NO OVERLAY.
    const rb = riverbend.nodes.find((n) => n.id === "button:exit");
    const sm = summit.nodes.find((n) => n.id === "button:exit");
    expect(rb).toBeDefined();
    expect(sm).toBeDefined();
    expect(rb?.key).toBe("F3");
    expect(sm?.key).toBe("F12");
    expect(rb?.portKey).toBe("F3");
    expect(sm?.portKey).toBe("F12");
  });

  it("changes the two field labels - which is exactly what an overlay is for", () => {
    expect(riverbend.nodes.map((n) => n.name)).toContain("Account Number");
    expect(summit.nodes.map((n) => n.name)).toContain("Acct #");
    expect(riverbend.nodes.map((n) => n.name)).toContain("Name Search");
    expect(summit.nodes.map((n) => n.name)).toContain("Search Name");
  });

  it("changes the screen id, which the checkpoint anchors on", () => {
    expect(riverbend.screenId).toBe("MEMBER INQUIRY 01");
    expect(summit.screenId).toBe("MBR INQ 01");
  });

  it("measures a much smaller divergence once the branding band is excluded", () => {
    // 63% over all nodes and 40% over interactive ones only - the same two numbers the spike
    // measured, reproduced by the ported detector against the rebuilt fixture. The RELATION is the
    // finding: a fingerprint that includes the branding band reports these as two applications,
    // and one that covers interactive nodes plus the screen id reports them as one application
    // with a vocabulary overlay, which is what they are.
    const all = divergence(ids(riverbend.nodes), ids(summit.nodes));
    const onlyInteractive = divergence(ids(interactive(riverbend)), ids(interactive(summit)));
    expect(all).toBe(63);
    expect(onlyInteractive).toBe(40);
  });

  it("reads the same account grid on both detail screens", () => {
    // The data half does not diverge at all: same columns, same rows, same balances, and neither
    // balance is truncated. One `readTable` step serves both tenants.
    for (const name of ["detail", "summitDetail"]) {
      const list = screen(name).nodes.find((n) => n.role === "list");
      expect(list?.columns).toEqual(["SUFFIX", "DESCRIPTION", "BALANCE"]);
      expect(list?.children?.map((row) => row.cells?.BALANCE)).toEqual([
        "1,204.55",
        "310.00",
        "2,880.13",
      ]);
    }
  });
});
