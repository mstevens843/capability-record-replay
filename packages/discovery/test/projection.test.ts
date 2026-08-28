// SPEC section 6.2 - what the model is shown, and what it is not.
//
// Three of these tests are about ABSENCE, which is the interesting half: a structural node must not
// appear, an invisible node must not appear, and a bound value must not appear. A projection that
// leaks any of those is a projection that lets the model reason about something the recording
// cannot express, or about a value nobody may see.

import { bindSensitive } from "@crr/core";
import type { NodeId, Observation, UINode } from "@crr/core";
import { describe, expect, it } from "vitest";
import { projectObservation, resolveNodeRef } from "../src/index.js";
import { IDS, detail, results, searchForm } from "./fixtures/corebank.js";

const lines = (observation: Observation): readonly string[] =>
  projectObservation(observation).text.split("\n");

const lineFor = (observation: Observation, ref: string): string => {
  const found = lines(observation).find((line) => line.startsWith(`[${ref}]`));
  if (found === undefined) throw new Error(`no line for ${ref}`);
  return found;
};

describe("the filter", () => {
  it("shows only nodes with a role that are visible", () => {
    const projection = projectObservation(searchForm);
    // The fixture's fourth node is a layout table cell with `ariaRole: null`. On these screens that
    // is most of the tree, and showing it is how a model ends up clicking a wrapper.
    expect(searchForm.nodes).toHaveLength(4);
    expect(projection.shown).toBe(3);
    expect(projection.text).not.toContain("layout-wrapper");
  });

  it("hides an invisible node even when it has a role", () => {
    const hidden: Observation = {
      ...searchForm,
      nodes: searchForm.nodes.map((node) =>
        node.id === IDS.search ? { ...node, state: { ...node.state, visible: false } } : node,
      ),
    };
    expect(projectObservation(hidden).text).not.toContain('"Search"');
  });

  it("numbers a ref by its index in THIS observation, not in the filtered list", () => {
    // SPEC 6.2 says `n<k>` is an index into this turn's Observation. The gaps that leaves are the
    // structural nodes, and they are informative: a reader of a transcript can see that nodes were
    // filtered out between n5 and n9.
    const projection = projectObservation(results);
    expect(resolveNodeRef(projection, "n7")).toBe(IDS.selectLink);
    expect(resolveNodeRef(projection, "n99")).toBeNull();
  });

  it("truncates a very large screen and says that it did", () => {
    const projection = projectObservation(results, { maxNodes: 3 });
    expect(projection.shown).toBe(3);
    expect(projection.hidden).toBe(5);
    expect(projection.text).toContain("5 more control(s) not shown");
  });
});

describe("the rendering", () => {
  it("reads like SPEC 6.2's example for a form field", () => {
    expect(lineFor(searchForm, "n1")).toBe(
      '[n1]  textbox  "Member ID"  value=""  required  capacity=12  frame=content',
    );
  });

  it("gives a grid cell its table and its column, marking a guessed header", () => {
    expect(lineFor(results, "n4")).toContain(
      "table[Member ID,Member Name,Status,Actions] col=Member ID?",
    );
  });

  it("gives a control inside a row the row's own key columns", () => {
    expect(lineFor(results, "n7")).toContain(
      "row: Member ID=50001 | Member Name=AVERY SYNTHETIC | Status=ACTIVE",
    );
  });

  it("shows a readonly value, because that is what a legacy detail screen displays", () => {
    expect(lineFor(detail, "n2")).toContain('value="1204.55"');
    expect(lineFor(detail, "n2")).toContain("readonly");
  });

  it("puts the route and the settled state where the model reads them first", () => {
    expect(lines(searchForm)[0]).toBe("screen: settled  route=corebank/members/search");
  });

  it("announces a native dialog as a separate channel, not as a node", () => {
    const withDialog: Observation = {
      ...searchForm,
      nativeDialog: { type: "confirm", message: "Leave this page?", defaultValue: null },
    };
    const text = projectObservation(withDialog).text;
    expect(text).toContain('dialog: confirm "Leave this page?" (blocks every other action)');
  });

  it("says when the screen has not settled, and why", () => {
    const moving: Observation = {
      ...searchForm,
      stability: { settled: false, generation: 1, pendingReason: "navigating" },
    };
    expect(projectObservation(moving).text).toContain("not-settled(navigating)");
  });
});

describe("masking", () => {
  const secret = bindSensitive("password", "hunter2-synthetic", 1);

  const filled: Observation = {
    ...searchForm,
    nodes: searchForm.nodes.map((node: UINode) =>
      node.id === IDS.memberId ? { ...node, value: "hunter2-synthetic" } : node,
    ),
  };

  it("replaces a bound value with its length and never the value", () => {
    const text = projectObservation(filled, {
      masked: new Map<NodeId, typeof secret>([[IDS.memberId as NodeId, secret]]),
    }).text;
    expect(text).toContain("value=<masked:17>");
    expect(text).not.toContain("hunter2-synthetic");
  });

  it("honours the driver's own mask even with no binding in scope", () => {
    const driverMasked: Observation = {
      ...filled,
      nodes: filled.nodes.map((node) =>
        node.id === IDS.memberId ? { ...node, masked: true } : node,
      ),
    };
    const text = projectObservation(driverMasked).text;
    expect(text).toContain("value=<masked>");
    expect(text).not.toContain("hunter2-synthetic");
  });
});

describe("what the projection cannot express", () => {
  it("carries no markup, no attribute and no id of any kind", () => {
    const text = [searchForm, results, detail].map((o) => projectObservation(o).text).join("\n");
    for (const forbidden of ["<", "id=", "class=", "ctl00"]) {
      expect(text.includes(forbidden)).toBe(false);
    }
  });

  it("never shows a NodeId, which is what stops one reaching an artifact", () => {
    const text = [searchForm, results, detail].map((o) => projectObservation(o).text).join("\n");
    for (const nodeId of Object.values(IDS)) expect(text).not.toContain(nodeId);
  });
});
