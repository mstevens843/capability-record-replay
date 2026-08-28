// A frozen `Observation` corpus for the riverbend member-lookup flow.
//
// This is the other half of `member-lookup.ts`: that file is the three DOCUMENTS, this one is the
// SCREENS they were recorded against. Together they are what lets the classifier, the resolver, the
// extractor and the interpreter be tested with no browser anywhere - which is the testability claim
// the whole design rests on, and it is worthless if the corpus is a toy.
//
// So the screens are deliberately hostile in the ways the browser spike measured:
//
//   · the page is built out of nested layout tables, and every one of them carries `ariaRole: null`
//     while keeping its raw Chromium role. That single field is the difference between "the row
//     whose Member ID is X" resolving to one element and resolving to three.
//   · the results grid has no `<th>` and no `scope=`, so every cell in row zero is `role: "cell"`
//     and the column headers are `headerProvenance: "first-row-heuristic"` - a guess, recorded as
//     a guess, so a per-tenant overlay has something to correct.
//   · member data is displayed in READONLY TEXTBOXES, which is what a server-rendered back office
//     from 2004 actually does, and it is why the artifact extracts with `value@1`.
//   · the detail route is canonicalized to `/members/:memberId`. An observation on disk never
//     carries a member number in a path, which is what makes this corpus safe to commit.
//
// ALL DATA IS OBVIOUSLY SYNTHETIC. Member 50001, "AVERY SYNTHETIC".

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
  tearObservation,
} from "../../src/index.js";

// ---------------------------------------------------------------------------------------------
// Containers, spelled once
// ---------------------------------------------------------------------------------------------

export const CONTENT: ContainerSegment = { kind: "frame", name: "content" };
export const SEARCH_FORM: ContainerSegment = {
  kind: "landmark",
  role: "form",
  name: "Member Search",
};
export const RESULTS_TABLE: ContainerSegment = {
  kind: "table",
  headers: ["Member ID", "Member Name", "Status", "Actions"],
};
export const DETAIL_REGION: ContainerSegment = {
  kind: "landmark",
  role: "region",
  name: "Member Detail",
};
export const SHARES_TABLE: ContainerSegment = {
  kind: "table",
  headers: ["Share Type", "Current Balance", "Status"],
};
export const NOTICE_DIALOG: ContainerSegment = {
  kind: "landmark",
  role: "dialog",
  name: "System Notice",
};

const SEARCH_ROUTE: RouteLocation = {
  originAlias: "corebank",
  path: "/members/search",
  query: {},
  frame: "content",
};
const DETAIL_ROUTE: RouteLocation = {
  originAlias: "corebank",
  path: "/members/:memberId",
  query: { tab: "shares" },
  frame: "content",
};

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

const DEFAULT_STATE: NodeState = {
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

interface NodeSpec {
  readonly id: string;
  readonly rawRole: string;
  readonly role?: Role | null;
  readonly name?: string;
  readonly value?: string | null;
  readonly text?: string | null;
  readonly state?: Partial<NodeState>;
  readonly bounds?: Bounds | null;
  readonly path?: readonly ContainerSegment[];
  readonly parent?: string | null;
  readonly children?: readonly string[];
  readonly labelledBy?: readonly string[];
  readonly tablePosition?: TablePosition | null;
  readonly capacity?: number | null;
}

const node = (spec: NodeSpec): UINode => ({
  id: spec.id as NodeId,
  rawRole: spec.rawRole,
  ariaRole: spec.role ?? null,
  name: spec.name ?? "",
  value: spec.value ?? null,
  text: spec.text ?? null,
  description: null,
  state: { ...DEFAULT_STATE, ...spec.state },
  bounds: spec.bounds ?? null,
  containerPath: spec.path ?? [],
  parent: (spec.parent ?? null) as NodeId | null,
  children: (spec.children ?? []) as readonly NodeId[],
  labelledBy: (spec.labelledBy ?? []) as readonly NodeId[],
  tablePosition: spec.tablePosition ?? null,
  capacity: spec.capacity ?? null,
  confidence: 1,
  live: false,
  masked: false,
});

const px = (x: number, y: number, w: number, h: number): Bounds => ({ x, y, w, h, unit: "px" });

interface ObservationSpec {
  readonly route: RouteLocation | null;
  readonly nodes: readonly UINode[];
  readonly roots: readonly string[];
  readonly settled?: boolean;
  readonly pendingReason?: Observation["stability"]["pendingReason"];
  readonly nativeDialog?: Observation["nativeDialog"];
  readonly inputIntercepted?: boolean;
}

const observation = (spec: ObservationSpec): Observation => ({
  // `seq` and `generation` are stamped by whatever driver hands the observation out - the mock
  // overwrites both - so the numbers here are placeholders and never assertions.
  seq: 0,
  surface: { kind: "web-legacy", driver: "mock-surface@0.1.0" },
  route: spec.route,
  nodes: spec.nodes,
  roots: spec.roots as readonly NodeId[],
  skeletonDigest: skeletonDigestOf(spec.nodes),
  stability: {
    settled: spec.settled ?? true,
    generation: 0,
    pendingReason: spec.pendingReason ?? null,
  },
  nativeDialog: spec.nativeDialog ?? null,
  inputIntercepted: spec.inputIntercepted ?? false,
});

/**
 * The page chrome every screen shares: a root, then three levels of layout table that exist only
 * because the markup is from 2004. All four carry `ariaRole: null`, so none of them is a candidate
 * target and none of them can be mistaken for the data grid further down.
 */
const chrome = (title: string, contentChildren: readonly string[]): readonly UINode[] => [
  node({
    id: "document:content",
    rawRole: "RootWebArea",
    name: title,
    path: [CONTENT],
    children: ["layouttable:page"],
  }),
  node({
    id: "layouttable:page",
    rawRole: "LayoutTable",
    path: [CONTENT],
    parent: "document:content",
    children: ["layoutrow:page"],
  }),
  node({
    id: "layoutrow:page",
    rawRole: "LayoutTableRow",
    path: [CONTENT],
    parent: "layouttable:page",
    children: ["layoutcell:page"],
  }),
  node({
    id: "layoutcell:page",
    rawRole: "LayoutTableCell",
    path: [CONTENT],
    parent: "layoutrow:page",
    children: contentChildren,
  }),
];

/**
 * A real data grid: `role: "table"/"row"/"cell"`, headers by heuristic because the markup has no
 * `<th>`. Row zero is the header row and is itself made of cells, which is the measured shape of
 * the legacy grid rather than a simplification.
 */
const grid = (
  prefix: string,
  table: ContainerSegment,
  parent: string,
  rows: readonly (readonly string[])[],
  extraCellChildren: Readonly<Record<string, readonly string[]>> = {},
): readonly UINode[] => {
  const headers = rows[0] ?? [];
  const rowIds = rows.map((_, index) => `row:${prefix}-${index}`);
  const nodes: UINode[] = [
    node({
      id: `table:${prefix}`,
      rawRole: "table",
      role: "table",
      path: [CONTENT],
      parent,
      children: rowIds,
    }),
  ];
  rows.forEach((cells, rowIndex) => {
    const cellIds = cells.map((_, colIndex) => `cell:${prefix}-${rowIndex}-${colIndex}`);
    nodes.push(
      node({
        id: `row:${prefix}-${rowIndex}`,
        rawRole: "row",
        role: "row",
        path: [CONTENT, table],
        parent: `table:${prefix}`,
        children: cellIds,
      }),
    );
    cells.forEach((text, colIndex) => {
      const id = `cell:${prefix}-${rowIndex}-${colIndex}`;
      nodes.push(
        node({
          id,
          rawRole: "cell",
          role: "cell",
          name: text,
          text,
          path: [CONTENT, table],
          parent: `row:${prefix}-${rowIndex}`,
          children: extraCellChildren[id] ?? [],
          tablePosition: {
            rowIndex,
            colIndex,
            rowHeader: null,
            colHeader: headers[colIndex] ?? null,
            // The grid has no `<th>`, no `scope=` and no `<caption>`. We got structure for free
            // and headers only by looking at row zero, and saying so is what lets an overlay
            // correct a wrong guess instead of a human debugging a mis-read balance.
            headerProvenance: "first-row-heuristic",
          },
        }),
      );
    });
  });
  return nodes;
};

// ---------------------------------------------------------------------------------------------
// Node ids, exported so nobody has to spell one twice
// ---------------------------------------------------------------------------------------------

export const IDS = {
  root: "document:content" as NodeId,
  memberIdLabel: "text:member-id-label" as NodeId,
  memberIdField: "textbox:member-id" as NodeId,
  searchButton: "button:search" as NodeId,
  resultsTable: "table:results" as NodeId,
  memberRowCell: "cell:results-1-0" as NodeId,
  selectLink: "link:results-select" as NodeId,
  noticeDialog: "dialog:notice" as NodeId,
  noticeOk: "button:notice-ok" as NodeId,
  detailRegion: "region:member-detail" as NodeId,
  detailHeading: "heading:member-detail" as NodeId,
  memberNameField: "textbox:member-name" as NodeId,
  accountStatusField: "textbox:account-status" as NodeId,
  sharesTable: "table:shares" as NodeId,
  savingsBalanceCell: "cell:shares-1-1" as NodeId,
  includeClosed: "checkbox:include-closed" as NodeId,
  applyButton: "button:apply" as NodeId,
} as const;

// ---------------------------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------------------------

/** Before anything has been navigated to. The entry precondition must fail here. */
export const blank: Observation = observation({
  route: { originAlias: "corebank", path: "/", query: {}, frame: "content" },
  nodes: chrome("CoreBank Back Office", []),
  roots: ["document:content"],
});

const searchFormNodes = (
  searchDisabled: boolean,
  extra: readonly UINode[] = [],
): readonly UINode[] => [
  ...chrome("Member Search - CoreBank", ["form:search", ...extra.map((n) => n.id)]),
  node({
    id: "form:search",
    rawRole: "form",
    role: "form",
    name: "Member Search",
    path: [CONTENT],
    parent: "layoutcell:page",
    children: ["text:member-id-label", "textbox:member-id", "button:search"],
  }),
  node({
    id: "text:member-id-label",
    rawRole: "StaticText",
    role: "text",
    name: "Member ID",
    text: "Member ID",
    path: [CONTENT, SEARCH_FORM],
    parent: "form:search",
    bounds: px(24, 96, 72, 16),
  }),
  node({
    id: "textbox:member-id",
    rawRole: "textbox",
    role: "textbox",
    name: "Member ID",
    value: "",
    path: [CONTENT, SEARCH_FORM],
    parent: "form:search",
    labelledBy: ["text:member-id-label"],
    bounds: px(112, 92, 160, 24),
    state: { readonly: false, required: true, invalid: false },
    // The field is ten characters wide and the contract's `memberId` is `maxLength: 10`. That is
    // not a coincidence: on a surface that reports capacity, the surface is where the type came
    // from - and it is what a fill longer than ten characters silently loses.
    capacity: 10,
  }),
  node({
    id: "button:search",
    rawRole: "button",
    role: "button",
    name: "Search",
    path: [CONTENT, SEARCH_FORM],
    parent: "form:search",
    bounds: px(288, 92, 72, 24),
    state: { disabled: searchDisabled },
  }),
  ...extra,
];

export const searchForm: Observation = observation({
  route: SEARCH_ROUTE,
  nodes: searchFormNodes(false),
  roots: ["document:content"],
});

/**
 * The same screen with a native `confirm()` open, which is what the legacy app throws up when a
 * search is submitted.
 *
 * The node set is the SEARCH FORM's, not the results', and that is the measured behaviour rather
 * than laziness: a native dialog blocks the renderer, so the only tree still readable is the one
 * from before the click. The dialog itself is invisible to the accessibility tree entirely and
 * reaches the observation through its own channel, carrying the message text - which is exactly
 * what a boolean "input is intercepted" could not carry, and exactly what you need in order to
 * decide accept versus dismiss.
 */
export const searchNativeConfirm: Observation = {
  ...searchForm,
  nativeDialog: {
    type: "confirm",
    message: "Print this search to the branch printer?",
    defaultValue: null,
  },
  // Deliberately NOT set here. `inputIntercepted` on a frozen screen describes what the NODES
  // intercept - an in-page modal. A native dialog contributes to the same flag but does so through
  // the driver's own channel, so the flag drops the moment the dialog is answered rather than
  // staying true because a fixture said so.
  inputIntercepted: false,
};

/** Submitted, not yet painted. Nothing may be classified against this. */
export const searching: Observation = observation({
  route: SEARCH_ROUTE,
  nodes: searchFormNodes(true, [
    node({
      id: "status:searching",
      rawRole: "status",
      role: "status",
      name: "Searching...",
      text: "Searching...",
      path: [CONTENT],
      parent: "layoutcell:page",
    }),
  ]),
  roots: ["document:content"],
  settled: false,
  pendingReason: "network",
});

const RESULT_ROWS: readonly (readonly string[])[] = [
  ["Member ID", "Member Name", "Status", "Actions"],
  ["50001", "AVERY SYNTHETIC", "OPEN", ""],
];

const resultsNodes = (extra: readonly UINode[] = []): readonly UINode[] => [
  ...chrome("Search Results - CoreBank", [
    "heading:results",
    "table:results",
    ...extra.map((n) => n.id),
  ]),
  node({
    id: "heading:results",
    rawRole: "heading",
    role: "heading",
    name: "Search Results",
    path: [CONTENT],
    parent: "layoutcell:page",
    bounds: px(24, 56, 300, 24),
  }),
  ...grid("results", RESULTS_TABLE, "layoutcell:page", RESULT_ROWS, {
    "cell:results-1-3": ["link:results-select"],
  }),
  node({
    id: "link:results-select",
    rawRole: "link",
    role: "link",
    name: "Select",
    path: [CONTENT, RESULTS_TABLE],
    parent: "cell:results-1-3",
    bounds: px(520, 128, 48, 16),
  }),
  ...extra,
];

export const results: Observation = observation({
  route: SEARCH_ROUTE,
  nodes: resultsNodes(),
  roots: ["document:content"],
});

/**
 * A torn read of the results: the heading painted, the grid had not.
 *
 * Note what it says about itself - `settled: true`. Quiescence proposed and was wrong, and the only
 * thing standing between this snapshot and a confidently empty answer is the checkpoint.
 */
export const resultsTorn: Observation = tearObservation(results, {
  keep: [
    "document:content" as NodeId,
    "layouttable:page" as NodeId,
    "layoutrow:page" as NodeId,
    "layoutcell:page" as NodeId,
    "heading:results" as NodeId,
  ],
});

/** The results, behind an in-page modal. Unlike a native dialog this one IS perceivable, which is
 *  what the declared interstitial recovery detects it with. */
export const resultsNotice: Observation = observation({
  route: SEARCH_ROUTE,
  nodes: resultsNodes([
    node({
      id: "dialog:notice",
      rawRole: "dialog",
      role: "dialog",
      name: "System Notice",
      path: [CONTENT],
      parent: "layoutcell:page",
      children: ["text:notice-body", "button:notice-ok"],
      bounds: px(120, 180, 480, 140),
    }),
    node({
      id: "text:notice-body",
      rawRole: "StaticText",
      role: "text",
      name: "Scheduled maintenance tonight at 22:00.",
      text: "Scheduled maintenance tonight at 22:00.",
      path: [CONTENT, NOTICE_DIALOG],
      parent: "dialog:notice",
    }),
    node({
      id: "button:notice-ok",
      rawRole: "button",
      role: "button",
      name: "OK",
      path: [CONTENT, NOTICE_DIALOG],
      parent: "dialog:notice",
      bounds: px(500, 280, 64, 24),
    }),
  ]),
  roots: ["document:content"],
  inputIntercepted: true,
});

export const detailLoading: Observation = observation({
  route: DETAIL_ROUTE,
  nodes: [
    ...chrome("Member Detail - CoreBank", ["status:loading"]),
    node({
      id: "status:loading",
      rawRole: "status",
      role: "status",
      name: "Loading member record...",
      text: "Loading member record...",
      path: [CONTENT],
      parent: "layoutcell:page",
    }),
  ],
  roots: ["document:content"],
  settled: false,
  pendingReason: "navigating",
});

const SHARE_ROWS_ALL: readonly (readonly string[])[] = [
  ["Share Type", "Current Balance", "Status"],
  ["Savings", "1,284.55", "OPEN"],
  ["Checking", "210.00", "OPEN"],
  ["Holiday Club", "0.00", "CLOSED"],
];
const SHARE_ROWS_OPEN: readonly (readonly string[])[] = SHARE_ROWS_ALL.slice(0, 3);

const detailNodes = (
  rows: readonly (readonly string[])[],
  includeClosed: boolean,
): readonly UINode[] => [
  ...chrome("Member Detail - CoreBank", [
    "region:member-detail",
    "table:shares",
    "checkbox:include-closed",
    "button:apply",
  ]),
  node({
    id: "region:member-detail",
    rawRole: "region",
    role: "region",
    name: "Member Detail",
    path: [CONTENT],
    parent: "layoutcell:page",
    children: ["heading:member-detail", "textbox:member-name", "textbox:account-status"],
  }),
  // The continuity anchor. "A member detail page loaded" and "THE member detail page for the
  // member we were asked about" are different claims, and only this node can tell them apart.
  node({
    id: "heading:member-detail",
    rawRole: "heading",
    role: "heading",
    name: "Member Detail #50001",
    text: "Member Detail #50001",
    path: [CONTENT, DETAIL_REGION],
    parent: "region:member-detail",
    bounds: px(24, 56, 320, 24),
  }),
  node({
    id: "textbox:member-name",
    rawRole: "textbox",
    role: "textbox",
    name: "Member Name",
    value: "AVERY SYNTHETIC",
    path: [CONTENT, DETAIL_REGION],
    parent: "region:member-detail",
    bounds: px(160, 96, 240, 24),
    state: { readonly: true },
  }),
  node({
    id: "textbox:account-status",
    rawRole: "textbox",
    role: "textbox",
    name: "Account Status",
    value: "OPEN",
    path: [CONTENT, DETAIL_REGION],
    parent: "region:member-detail",
    bounds: px(160, 128, 120, 24),
    state: { readonly: true },
  }),
  ...grid("shares", SHARES_TABLE, "layoutcell:page", rows),
  node({
    id: "checkbox:include-closed",
    rawRole: "checkbox",
    role: "checkbox",
    name: "Include closed shares",
    path: [CONTENT],
    parent: "layoutcell:page",
    bounds: px(24, 320, 16, 16),
    state: { checked: includeClosed },
  }),
  node({
    id: "button:apply",
    rawRole: "button",
    role: "button",
    name: "Apply",
    path: [CONTENT],
    parent: "layoutcell:page",
    bounds: px(220, 316, 64, 24),
  }),
];

/** Every share, including a closed one, which is exactly the row that must not be read as savings. */
export const detail: Observation = observation({
  route: DETAIL_ROUTE,
  nodes: detailNodes(SHARE_ROWS_ALL, true),
  roots: ["document:content"],
});

/** The same record with the closed share filtered out. */
export const detailOpenShares: Observation = observation({
  route: DETAIL_ROUTE,
  nodes: detailNodes(SHARE_ROWS_OPEN, false),
  roots: ["document:content"],
});

/** Every screen, keyed the way `MockSurfaceConfig.screens` wants it. */
export const corebankScreens = {
  blank,
  "search-form": searchForm,
  "search-confirm": searchNativeConfirm,
  searching,
  results,
  "results-torn": resultsTorn,
  "results-notice": resultsNotice,
  "detail-loading": detailLoading,
  detail,
  "detail-open-shares": detailOpenShares,
} as const;

/** The obviously-synthetic member this corpus is about. */
export const SUBJECT_MEMBER_ID = "50001";
