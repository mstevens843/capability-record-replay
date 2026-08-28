// The pure half of the driver, tested with no browser running.
//
// Every case below is a miniature of something that was measured against Chromium and recorded in
// `docs/design/spike-browser-surface.md`. The reason they are written as frozen arrays rather than
// as browser assertions is the reason `@crr/core` is pure: a decision that has to be right should be
// exercisable a thousand times a second by anyone, on any machine, with nothing installed.

import type { NodeId, UINode } from "@crr/core";
import { describe, expect, it } from "vitest";
import type { FrameInfo } from "../src/frames.js";
import { normalizeObservationNodes } from "../src/normalize.js";
import { ax, text } from "./support/ax.js";

const TOP: FrameInfo = { id: "F0", name: "", url: "http://x/", path: ["top"], parent: null };
const CONTENT: FrameInfo = {
  id: "F1",
  name: "content",
  url: "http://x/search",
  path: ["top", "content"],
  parent: 0,
};

const run = (
  trees: readonly (readonly ReturnType<typeof ax>[])[],
  frames: readonly FrameInfo[] = [TOP],
  options: {
    readonly stitch?: ReadonlyMap<number, number>;
    readonly sensitive?: ReadonlySet<number>;
  } = {},
) =>
  normalizeObservationNodes({
    frames,
    trees,
    childFrameOfIframeBackendId: options.stitch ?? new Map(),
    sensitiveBackendIds: options.sensitive ?? new Set(),
  });

const nodeMap = (result: ReturnType<typeof run>): ReadonlyMap<NodeId, UINode> =>
  new Map(result.nodes.map((each) => [each.node.id, each.node]));

// ---------------------------------------------------------------------------------------------

describe("driver rule D2 - only role.type === 'role' becomes a target", () => {
  it("carries Chromium's internal roles as structure", () => {
    const result = run([
      [
        ax({ id: "1", role: "RootWebArea", type: "internalRole", frameId: "F0", children: ["2"] }),
        ax({ id: "2", role: "LayoutTable", type: "internalRole", parent: "1", children: ["3"] }),
        ax({ id: "3", role: "button", name: "Search", parent: "2" }),
      ],
    ]);
    const byId = nodeMap(result);
    expect(byId.get("structure:f0-2" as NodeId)?.ariaRole).toBeNull();
    expect(byId.get("structure:f0-2" as NodeId)?.rawRole).toBe("LayoutTable");
    expect(byId.get("button:f0-3" as NodeId)?.ariaRole).toBe("button");
  });

  it("refuses an ARIA role that is not in the closed vocabulary", () => {
    // `generic` and `none` arrive as type "role" and are still structure. Passing D2 is necessary
    // and not sufficient: the closed vocabulary is the second half of the rule.
    const result = run([
      [
        ax({
          id: "1",
          role: "RootWebArea",
          type: "internalRole",
          frameId: "F0",
          children: ["2", "3"],
        }),
        ax({ id: "2", role: "generic", parent: "1" }),
        ax({ id: "3", role: "none", parent: "1" }),
      ],
    ]);
    for (const each of result.nodes) expect(each.node.ariaRole).toBeNull();
  });

  it("folds the aliases that mean the same thing to a program", () => {
    const result = run([
      [
        ax({
          id: "1",
          role: "RootWebArea",
          type: "internalRole",
          frameId: "F0",
          children: ["2", "3", "4", "5"],
        }),
        ax({ id: "2", role: "img", name: "logo", parent: "1" }),
        ax({ id: "3", role: "alertdialog", name: "Confirm", parent: "1" }),
        ax({ id: "4", role: "gridcell", name: "10041", parent: "1" }),
        ax({ id: "5", role: "searchbox", parent: "1" }),
      ],
    ]);
    const roles = result.nodes.map((each) => each.node.ariaRole);
    expect(roles).toEqual([null, "image", "dialog", "cell", "textbox"]);
  });
});

describe("nodes with no backend id", () => {
  it("drops them and re-parents their children so the tree stays connected", () => {
    // `InlineTextBox` is the real case: it carries no `backendDOMNodeId`, so it can be neither
    // measured nor acted on, and it is a character-level re-run of its parent's text.
    const result = run([
      [
        ax({ id: "1", role: "RootWebArea", type: "internalRole", frameId: "F0", children: ["2"] }),
        ax({
          id: "2",
          role: "InlineTextBox",
          type: "internalRole",
          backend: null,
          parent: "1",
          children: ["3"],
        }),
        ax({ id: "3", role: "button", name: "Search", parent: "2" }),
      ],
    ]);
    expect(result.nodes).toHaveLength(2);
    const button = nodeMap(result).get("button:f0-3" as NodeId);
    expect(button?.parent).toBe("structure:f0-1");
    expect(nodeMap(result).get("structure:f0-1" as NodeId)?.children).toEqual(["button:f0-3"]);
  });
});

describe("the stitch", () => {
  it("makes an Iframe leaf the parent of the embedded document's root", () => {
    // `getFullAXTree` returns SEVEN nodes on a frameset and every Iframe node has `childIds: []`.
    // The edge is supplied by `DOM.describeNode`, which is what the map below stands for.
    const result = run(
      [
        [
          ax({
            id: "1",
            role: "RootWebArea",
            type: "internalRole",
            frameId: "F0",
            children: ["2"],
          }),
          ax({ id: "2", role: "Iframe", type: "internalRole", parent: "1" }),
        ],
        [
          ax({
            id: "5",
            role: "RootWebArea",
            type: "internalRole",
            frameId: "F1",
            children: ["6"],
          }),
          ax({ id: "6", role: "button", name: "Search", parent: "5" }),
        ],
      ],
      [TOP, CONTENT],
      { stitch: new Map([[2, 1]]) },
    );
    expect(result.roots).toEqual(["structure:f0-1"]);
    const byId = nodeMap(result);
    expect(byId.get("structure:f1-5" as NodeId)?.parent).toBe("structure:f0-2");
    expect(byId.get("structure:f0-2" as NodeId)?.children).toEqual(["structure:f1-5"]);
  });

  it("leaves an unstitched document as its own root rather than dropping it", () => {
    const result = run(
      [
        [ax({ id: "1", role: "RootWebArea", type: "internalRole", frameId: "F0" })],
        [ax({ id: "5", role: "RootWebArea", type: "internalRole", frameId: "F1" })],
      ],
      [TOP, CONTENT],
    );
    expect(result.roots).toEqual(["structure:f0-1", "structure:f1-5"]);
  });
});

describe("containerPath", () => {
  it("is the frame NAME chain, interleaved with landmarks and tables", () => {
    const result = run(
      [
        [
          ax({
            id: "1",
            role: "RootWebArea",
            type: "internalRole",
            frameId: "F0",
            children: ["2"],
          }),
          ax({ id: "2", role: "Iframe", type: "internalRole", parent: "1" }),
        ],
        [
          ax({
            id: "5",
            role: "RootWebArea",
            type: "internalRole",
            frameId: "F1",
            children: ["6"],
          }),
          ax({ id: "6", role: "form", name: "Member Search", parent: "5", children: ["7"] }),
          ax({ id: "7", role: "table", parent: "6", children: ["8"] }),
          ax({ id: "8", role: "row", parent: "7", children: ["9"] }),
          ax({ id: "9", role: "cell", name: "Member ID", parent: "8" }),
        ],
      ],
      [TOP, CONTENT],
      { stitch: new Map([[2, 1]]) },
    );
    const cell = nodeMap(result).get("cell:f1-9" as NodeId);
    expect(cell?.containerPath).toEqual([
      { kind: "frame", name: "top" },
      { kind: "frame", name: "content" },
      { kind: "landmark", role: "form", name: "Member Search" },
      { kind: "table", headers: ["Member ID"] },
    ]);
  });
});

describe("table position - the layout-table trap in miniature", () => {
  // The measured bug: `filter({ has })` over folded roles matched TWO ancestor rows for every member
  // id, because a page of nested layout tables always wraps the data grid in another "row". Here the
  // same shape is built explicitly - a LayoutTableRow / LayoutTableCell wrapping a real grid - and
  // the assertion is that exactly one node is a row and the cell is indexed against THAT one.
  const tree = [
    ax({ id: "1", role: "RootWebArea", type: "internalRole", frameId: "F0", children: ["2"] }),
    ax({ id: "2", role: "LayoutTable", type: "internalRole", parent: "1", children: ["3"] }),
    ax({ id: "3", role: "LayoutTableRow", type: "internalRole", parent: "2", children: ["4"] }),
    ax({ id: "4", role: "LayoutTableCell", type: "internalRole", parent: "3", children: ["10"] }),
    ax({ id: "10", role: "table", parent: "4", children: ["11", "20"] }),
    ax({ id: "11", role: "row", parent: "10", children: ["12", "13"] }),
    ax({ id: "12", role: "cell", name: "Member ID", parent: "11" }),
    ax({ id: "13", role: "cell", name: "Share Balance", parent: "11" }),
    ax({ id: "20", role: "row", parent: "10", children: ["21", "22"] }),
    ax({ id: "21", role: "cell", name: "10042", parent: "20" }),
    ax({ id: "22", role: "cell", name: "88.10", parent: "20" }),
  ];

  it("makes the layout row structure, so exactly one node is a row per grid row", () => {
    const result = run([tree]);
    const rows = result.nodes.filter((each) => each.node.ariaRole === "row");
    expect(rows).toHaveLength(2);
    const ancestorRows = ancestorsOf(result, "cell:f0-21" as NodeId).filter(
      (each) => each.ariaRole === "row",
    );
    expect(ancestorRows.map((each) => each.id)).toEqual(["row:f0-20"]);
  });

  it("indexes the cell against the nearest row and the nearest table", () => {
    const byId = nodeMap(run([tree]));
    expect(byId.get("cell:f0-22" as NodeId)?.tablePosition).toEqual({
      rowIndex: 1,
      colIndex: 1,
      colHeader: "Share Balance",
      rowHeader: null,
      headerProvenance: "first-row-heuristic",
    });
  });

  it("records that the header row was a guess", () => {
    const byId = nodeMap(run([tree]));
    expect(byId.get("cell:f0-21" as NodeId)?.tablePosition?.headerProvenance).toBe(
      "first-row-heuristic",
    );
  });

  it("records that the header row was declared, when it was", () => {
    const declared = tree.map((node) =>
      node.nodeId === "12" || node.nodeId === "13"
        ? ax({
            id: node.nodeId,
            role: "columnheader",
            name: node.nodeId === "12" ? "Member ID" : "Share Balance",
            parent: "11",
          })
        : node,
    );
    const byId = nodeMap(run([declared]));
    expect(byId.get("cell:f0-22" as NodeId)?.tablePosition).toEqual({
      rowIndex: 1,
      colIndex: 1,
      colHeader: "Share Balance",
      rowHeader: null,
      headerProvenance: "columnheader-role",
    });
  });

  it("reports no column header rather than a wrong one when the header row is shorter", () => {
    // The known gap: the accessibility tree exposes no `colindex` at all, so column mapping is
    // positional and a `colspan` in the header row desynchronises it. A missing header is the
    // honest signal; a confidently wrong one is the failure this whole design refuses.
    const short = [
      ...tree.filter((node) => node.nodeId !== "11" && node.nodeId !== "13"),
      ax({ id: "11", role: "row", parent: "10", children: ["12"] }),
    ];
    const byId = nodeMap(run([short]));
    expect(byId.get("cell:f0-22" as NodeId)?.tablePosition?.colHeader).toBeNull();
  });
});

describe("what a node carries", () => {
  const tree = [
    ax({
      id: "1",
      role: "RootWebArea",
      type: "internalRole",
      frameId: "F0",
      children: ["2", "5", "8"],
    }),
    ax({
      id: "2",
      role: "textbox",
      value: "10041",
      parent: "1",
      properties: { disabled: true, invalid: "false", required: true, readonly: false },
      labelledBy: [5],
    }),
    ax({ id: "5", role: "heading", name: "Member ID", parent: "1" }),
    ax({ id: "8", role: "status", parent: "1", children: ["9"], properties: { live: "polite" } }),
    text("9", "No members matched the search criteria.", "8"),
  ];

  it("reads the state properties Chromium reports, tristates included", () => {
    const byId = nodeMap(run([tree]));
    expect(byId.get("textbox:f0-2" as NodeId)?.state).toEqual({
      disabled: true,
      focused: false,
      visible: true,
      checked: null,
      expanded: null,
      selected: null,
      required: true,
      // The string "false", not the boolean. Truth-testing it marks every field on the page invalid.
      invalid: false,
      readonly: false,
    });
  });

  it("resolves labelledby through backend ids", () => {
    const byId = nodeMap(run([tree]));
    expect(byId.get("textbox:f0-2" as NodeId)?.labelledBy).toEqual(["heading:f0-5"]);
  });

  it("marks live regions so the skeleton digest can ignore them", () => {
    const byId = nodeMap(run([tree]));
    expect(byId.get("status:f0-8" as NodeId)?.live).toBe(true);
    expect(byId.get("heading:f0-5" as NodeId)?.live).toBe(false);
  });

  it("gives a control the text it displays and not the label it is called", () => {
    const byId = nodeMap(run([tree]));
    expect(byId.get("textbox:f0-2" as NodeId)?.text).toBeNull();
    expect(byId.get("status:f0-8" as NodeId)?.text).toBe("No members matched the search criteria.");
    expect(byId.get("structure:f0-9" as NodeId)?.text).toBe(
      "No members matched the search criteria.",
    );
  });

  it("blanks a value the driver was told is sensitive, and says that it did", () => {
    const byId = nodeMap(run([tree], [TOP], { sensitive: new Set([2]) }));
    const field = byId.get("textbox:f0-2" as NodeId);
    expect(field?.masked).toBe(true);
    expect(field?.value).toBeNull();
    expect(byId.get("heading:f0-5" as NodeId)?.masked).toBe(false);
  });

  it("reports a browser as having no field capacity and full confidence", () => {
    const byId = nodeMap(run([tree]));
    expect(byId.get("textbox:f0-2" as NodeId)?.capacity).toBeNull();
    expect(byId.get("textbox:f0-2" as NodeId)?.confidence).toBe(1);
  });

  it("truncates at the schema's ceilings instead of failing validation three packages away", () => {
    const long = "x".repeat(5000);
    const byId = nodeMap(
      run([
        [
          ax({
            id: "1",
            role: "RootWebArea",
            type: "internalRole",
            frameId: "F0",
            children: ["2"],
          }),
          ax({ id: "2", role: "cell", name: long, value: long, description: long, parent: "1" }),
        ],
      ]),
    );
    const cell = byId.get("cell:f0-2" as NodeId);
    expect(cell?.name).toHaveLength(1024);
    expect(cell?.value).toHaveLength(4096);
    expect(cell?.description).toHaveLength(1024);
  });
});

describe("ordering", () => {
  it("is document order, because ordinal descriptors index straight into it", () => {
    const result = run([
      [
        ax({
          id: "1",
          role: "RootWebArea",
          type: "internalRole",
          frameId: "F0",
          children: ["4", "2"],
        }),
        ax({ id: "2", role: "button", name: "second", parent: "1" }),
        ax({ id: "4", role: "button", name: "first", parent: "1" }),
      ],
    ]);
    expect(result.nodes.map((each) => each.node.name)).toEqual(["", "first", "second"]);
  });
});

// ---------------------------------------------------------------------------------------------

function ancestorsOf(result: ReturnType<typeof run>, id: NodeId): readonly UINode[] {
  const byId = nodeMap(result);
  const out: UINode[] = [];
  let cursor = byId.get(id)?.parent ?? null;
  while (cursor !== null) {
    const node = byId.get(cursor);
    if (node === undefined) break;
    out.push(node);
    cursor = node.parent;
  }
  return out;
}
