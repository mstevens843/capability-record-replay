// Frozen observations for the descriptor derivation tests.
//
// ALL DATA IS OBVIOUSLY SYNTHETIC. Member 50001, "AVERY SYNTHETIC", branch 0042. Nothing here is,
// or resembles, a real member, a real balance or a real credential.
//
// This corpus is deliberately RICHER than `corebank.ts`'s, in the three ways that decide whether a
// descriptor can be derived at all, because `corebank.ts` exists to exercise the LOOP and gives
// every node the same bounding box:
//
//   · separate LABEL nodes beside their fields, so `label-anchored` and `geometric` have something
//     to anchor to;
//   · distinct GEOMETRY, so "to the right of" and "below" mean something;
//   · a results grid whose cells are real `cell` nodes with a `link` nested INSIDE the Actions
//     cell, which is what a `table-cell` descriptor with a `childRole` addresses - and which is
//     also exactly how a legacy grid is actually built.
//
// It is hostile in the way the fixture application is: every column header is
// `first-row-heuristic` (the grid has no header row the driver could read a `columnheader` role
// off), and member data is displayed in readonly textboxes.

import {
  type Bounds,
  type ContainerSegment,
  type NodeId,
  type NodeState,
  type Observation,
  type Role,
  type RouteLocation,
  type TablePosition,
  type UINode,
  skeletonDigestOf,
} from "@crr/core";

const CONTENT: ContainerSegment = { kind: "frame", name: "content" };
const SEARCH_FORM: ContainerSegment = { kind: "landmark", role: "form", name: "Member Search" };
const RESULTS_TABLE: ContainerSegment = {
  kind: "table",
  headers: ["Member ID", "Member Name", "Status", "Actions"],
};

export const SEARCH_ROUTE: RouteLocation = {
  originAlias: "corebank",
  path: "/members/search",
  query: {},
  frame: "content",
};

const STATE: NodeState = {
  disabled: false,
  focused: false,
  visible: true,
  checked: null,
  expanded: null,
  selected: null,
  required: null,
  invalid: null,
  readonly: null,
};

interface Spec {
  readonly id: string;
  readonly role: Role | null;
  readonly rawRole?: string;
  readonly name?: string;
  readonly value?: string | null;
  readonly text?: string | null;
  readonly path: readonly ContainerSegment[];
  readonly bounds?: Bounds | null;
  readonly capacity?: number | null;
  readonly table?: TablePosition | null;
  readonly parent?: string | null;
  readonly children?: readonly string[];
  readonly labelledBy?: readonly string[];
  readonly state?: Partial<NodeState>;
}

function node(spec: Spec): UINode {
  return {
    id: spec.id as NodeId,
    rawRole: spec.rawRole ?? spec.role ?? "GenericContainer",
    ariaRole: spec.role,
    name: spec.name ?? "",
    value: spec.value ?? null,
    text: spec.text ?? null,
    description: null,
    state: { ...STATE, ...spec.state },
    bounds: spec.bounds === undefined ? null : spec.bounds,
    containerPath: spec.path,
    parent: (spec.parent ?? null) as NodeId | null,
    children: (spec.children ?? []) as readonly NodeId[],
    labelledBy: (spec.labelledBy ?? []) as readonly NodeId[],
    tablePosition: spec.table ?? null,
    capacity: spec.capacity ?? null,
    confidence: 1,
    live: false,
    masked: false,
  };
}

function observation(seq: number, nodes: readonly UINode[]): Observation {
  return {
    seq,
    surface: { kind: "web-legacy", driver: "frozen-fixture@0.1.0" },
    route: SEARCH_ROUTE,
    nodes,
    roots: [],
    skeletonDigest: skeletonDigestOf(nodes),
    stability: { settled: true, generation: seq, pendingReason: null },
    nativeDialog: null,
    inputIntercepted: false,
  };
}

const px = (x: number, y: number, w: number, h: number): Bounds => ({ x, y, w, h, unit: "px" });

// ---------------------------------------------------------------------------------------------
// A labelled search form
// ---------------------------------------------------------------------------------------------

export const LABELLED_IDS = {
  label: "text:member-id-label",
  field: "textbox:member-id",
  search: "button:search",
  unnamed: "textbox:unnamed",
} as const;

/**
 * A field with a label to its left, a submit button to the right of the field, and - the case that
 * must FAIL derivation - a nameless textbox in the corner with nothing beside it.
 */
export const labelledForm: Observation = observation(1, [
  node({
    id: LABELLED_IDS.label,
    role: "text",
    name: "Member ID",
    text: "Member ID",
    path: [CONTENT, SEARCH_FORM],
    bounds: px(0, 0, 80, 20),
  }),
  node({
    id: LABELLED_IDS.field,
    role: "textbox",
    name: "Member ID",
    value: "",
    path: [CONTENT, SEARCH_FORM],
    bounds: px(100, 0, 120, 20),
    capacity: 12,
    state: { required: true },
  }),
  node({
    id: LABELLED_IDS.search,
    role: "button",
    name: "Search",
    path: [CONTENT, SEARCH_FORM],
    bounds: px(240, 0, 80, 20),
  }),
  node({
    id: LABELLED_IDS.unnamed,
    role: "textbox",
    name: "",
    value: "",
    path: [CONTENT, SEARCH_FORM],
    bounds: px(0, 400, 120, 20),
  }),
  // A layout wrapper with no accessible role: structure, never a target.
  node({ id: "cell:wrapper", role: null, rawRole: "LayoutTableCell", path: [CONTENT] }),
]);

// ---------------------------------------------------------------------------------------------
// A results grid, built the way a legacy grid is actually built
// ---------------------------------------------------------------------------------------------

const HEADERS = ["Member ID", "Member Name", "Status", "Actions"] as const;

function gridCell(row: number, col: number, text: string, extra: Partial<Spec> = {}): UINode {
  return node({
    id: `cell:r${row}c${col}`,
    role: "cell",
    rawRole: "LayoutTableCell",
    name: text,
    text,
    path: [CONTENT, RESULTS_TABLE],
    bounds: px(col * 140, row * 24, 130, 20),
    table: {
      rowIndex: row,
      colIndex: col,
      rowHeader: null,
      colHeader: HEADERS[col] as string,
      // Every header is a GUESS on this grid, recorded as a guess so an overlay can correct it.
      headerProvenance: "first-row-heuristic",
    },
    ...extra,
  });
}

export const GRID_IDS = {
  selectLink: "link:select-r1",
  actionsCell: "cell:r1c3",
  memberIdCell: "cell:r1c0",
  memberNameCell: "cell:r1c1",
} as const;

export const resultsGrid: Observation = observation(2, [
  node({
    id: "heading:results",
    role: "heading",
    name: "Search Results",
    path: [CONTENT],
    bounds: px(0, 0, 300, 24),
  }),
  gridCell(0, 0, "Member ID"),
  gridCell(0, 1, "Member Name"),
  gridCell(0, 2, "Status"),
  gridCell(0, 3, "Actions"),
  gridCell(1, 0, "50001"),
  gridCell(1, 1, "AVERY SYNTHETIC"),
  gridCell(1, 2, "ACTIVE"),
  gridCell(1, 3, "", { children: [GRID_IDS.selectLink] }),
  node({
    id: GRID_IDS.selectLink,
    role: "link",
    name: "Select",
    path: [CONTENT, RESULTS_TABLE],
    bounds: px(3 * 140 + 4, 24, 60, 16),
    parent: GRID_IDS.actionsCell,
  }),
  // A second row, so a row addressed by INDEX would be ambiguous and a row addressed by VALUE is
  // not. This is the whole argument for `rowKey`.
  gridCell(2, 0, "50002"),
  gridCell(2, 1, "BLAKE SYNTHETIC"),
  gridCell(2, 2, "ACTIVE"),
  gridCell(2, 3, "", { children: ["link:select-r2"] }),
  node({
    id: "link:select-r2",
    role: "link",
    name: "Select",
    path: [CONTENT, RESULTS_TABLE],
    bounds: px(3 * 140 + 4, 48, 60, 16),
    parent: "cell:r2c3",
  }),
]);

/** A cell whose ACCESSIBLE NAME is the member number. The fingerprint of a node like this is the
 *  easiest place in the document to persist regulated data by accident. */
export const memberIdCellId = GRID_IDS.memberIdCell as unknown as NodeId;
