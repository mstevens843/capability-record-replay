// A frozen `Observation` corpus and a `MockSurface` script for the riverbend member-lookup flow.
//
// ALL DATA IS OBVIOUSLY SYNTHETIC. Member 50001, "AVERY SYNTHETIC". Nothing here is, or resembles,
// a real member, a real balance or a real credential.
//
// It is small on purpose - four screens - because what these tests are about is the LOOP, not the
// corpus. It is nonetheless hostile in the two ways that matter to the projection: the results grid
// has no header row that the driver could read a `columnheader` role off (so every column header is
// `first-row-heuristic`, a guess recorded as a guess), and member data is displayed in READONLY
// TEXTBOXES, which is what a server-rendered back office from 2004 actually does.
//
// `@crr/core`'s own corpus (`packages/core/test/fixtures/corebank-observations.ts`) is richer, and
// this one deliberately does not import it: a package cannot import a sibling package's test folder
// without reaching through a build boundary, and CORE-STATUS section 7 flags that as an open item
// rather than something to solve here.

import {
  type Allowlist,
  type Bounds,
  type ContainerSegment,
  type LeaseSnapshot,
  MOCK_LEASE_TOKEN,
  type MockTransition,
  type NodeId,
  type NodeState,
  type Observation,
  type Role,
  type RouteLocation,
  type TablePosition,
  type UINode,
  skeletonDigestOf,
} from "@crr/core";

// ---------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------

const CONTENT: ContainerSegment = { kind: "frame", name: "content" };
const SEARCH_FORM: ContainerSegment = { kind: "landmark", role: "form", name: "Member Search" };
const RESULTS: ContainerSegment = {
  kind: "table",
  headers: ["Member ID", "Member Name", "Status", "Actions"],
};
const DETAIL: ContainerSegment = { kind: "landmark", role: "region", name: "Member Detail" };

export const SEARCH_ROUTE: RouteLocation = {
  originAlias: "corebank",
  path: "/members/search",
  query: {},
  frame: "content",
};
export const DETAIL_ROUTE: RouteLocation = {
  originAlias: "corebank",
  path: "/members/:memberId",
  query: {},
  frame: "content",
};

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

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

const BOUNDS: Bounds = { x: 10, y: 10, w: 120, h: 20, unit: "px" };

interface NodeSpec {
  readonly id: string;
  readonly role: Role | null;
  readonly rawRole?: string;
  readonly name?: string;
  readonly value?: string | null;
  readonly text?: string | null;
  readonly path: readonly ContainerSegment[];
  readonly capacity?: number | null;
  readonly table?: TablePosition | null;
  readonly state?: Partial<NodeState>;
}

function node(spec: NodeSpec): UINode {
  return {
    id: spec.id as NodeId,
    rawRole: spec.rawRole ?? spec.role ?? "GenericContainer",
    ariaRole: spec.role,
    name: spec.name ?? "",
    value: spec.value ?? null,
    text: spec.text ?? null,
    description: null,
    state: { ...STATE, ...spec.state },
    bounds: BOUNDS,
    containerPath: spec.path,
    parent: null,
    children: [],
    labelledBy: [],
    tablePosition: spec.table ?? null,
    capacity: spec.capacity ?? null,
    confidence: 1,
    live: false,
    masked: false,
  };
}

function observation(input: {
  readonly seq: number;
  readonly route: RouteLocation | null;
  readonly nodes: readonly UINode[];
  readonly generation: number;
}): Observation {
  return {
    seq: input.seq,
    surface: { kind: "web-legacy", driver: "mock-surface@0.1.0" },
    route: input.route,
    nodes: input.nodes,
    roots: [],
    skeletonDigest: skeletonDigestOf(input.nodes),
    stability: { settled: true, generation: input.generation, pendingReason: null },
    nativeDialog: null,
    inputIntercepted: false,
  };
}

const cell = (
  id: string,
  text: string,
  rowIndex: number,
  colIndex: number,
  colHeader: string,
): UINode =>
  node({
    id,
    role: "cell",
    rawRole: "LayoutTableCell",
    name: text,
    text,
    path: [CONTENT, RESULTS],
    table: {
      rowIndex,
      colIndex,
      rowHeader: null,
      colHeader,
      headerProvenance: "first-row-heuristic",
    },
  });

// ---------------------------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------------------------

export const IDS = {
  memberId: "textbox:member-id",
  search: "button:search",
  selectLink: "link:select-row1",
  memberName: "textbox:detail-name",
  shareBalance: "textbox:detail-share-balance",
  notFound: "status:no-member",
} as const;

const searchNodes: readonly UINode[] = [
  node({
    id: "heading:search",
    role: "heading",
    name: "Member Search",
    path: [CONTENT, SEARCH_FORM],
  }),
  node({
    id: IDS.memberId,
    role: "textbox",
    name: "Member ID",
    value: "",
    path: [CONTENT, SEARCH_FORM],
    capacity: 12,
    state: { required: true },
  }),
  node({ id: IDS.search, role: "button", name: "Search", path: [CONTENT, SEARCH_FORM] }),
  // A layout wrapper with no accessible role. It must NOT appear in the projection; that is the
  // single field that decides whether the model picks a link or the cell that contains it.
  node({ id: "cell:layout-wrapper", role: null, rawRole: "LayoutTableCell", path: [CONTENT] }),
];

export const searchForm: Observation = observation({
  seq: 1,
  route: SEARCH_ROUTE,
  nodes: searchNodes,
  generation: 1,
});

export const searchFormFilled: Observation = observation({
  seq: 2,
  route: SEARCH_ROUTE,
  nodes: searchNodes.map((n) => (n.id === IDS.memberId ? { ...n, value: "50001" } : n)),
  generation: 2,
});

export const results: Observation = observation({
  seq: 3,
  route: SEARCH_ROUTE,
  nodes: [
    node({ id: "heading:results", role: "heading", name: "Search Results", path: [CONTENT] }),
    cell("cell:r0c0", "Member ID", 0, 0, "Member ID"),
    cell("cell:r0c1", "Member Name", 0, 1, "Member Name"),
    cell("cell:r0c2", "Status", 0, 2, "Status"),
    cell("cell:r1c0", "50001", 1, 0, "Member ID"),
    cell("cell:r1c1", "AVERY SYNTHETIC", 1, 1, "Member Name"),
    cell("cell:r1c2", "ACTIVE", 1, 2, "Status"),
    node({
      id: IDS.selectLink,
      role: "link",
      name: "Select",
      path: [CONTENT, RESULTS],
      table: {
        rowIndex: 1,
        colIndex: 3,
        rowHeader: null,
        colHeader: "Actions",
        headerProvenance: "first-row-heuristic",
      },
    }),
  ],
  generation: 3,
});

export const detail: Observation = observation({
  seq: 4,
  route: DETAIL_ROUTE,
  nodes: [
    node({ id: "heading:detail", role: "heading", name: "Member Detail", path: [CONTENT, DETAIL] }),
    node({
      id: IDS.memberName,
      role: "textbox",
      name: "Member Name",
      value: "AVERY SYNTHETIC",
      path: [CONTENT, DETAIL],
      state: { readonly: true },
    }),
    node({
      id: IDS.shareBalance,
      role: "textbox",
      name: "Share Balance",
      value: "1204.55",
      path: [CONTENT, DETAIL],
      state: { readonly: true },
    }),
  ],
  generation: 4,
});

/** The MEMBER_NOT_FOUND screen. Present so a test can drive the loop to an honest `stuck` with an
 *  outcome candidate, which is the shape SPEC section 6.1's `finish` exists for. */
export const notFound: Observation = observation({
  seq: 5,
  route: SEARCH_ROUTE,
  nodes: [
    ...searchNodes,
    node({
      id: IDS.notFound,
      role: "status",
      name: "No member found for 99999",
      text: "No member found for 99999",
      path: [CONTENT, SEARCH_FORM],
    }),
  ],
  generation: 5,
});

export const screens = { searchForm, searchFormFilled, results, detail, notFound } as const;

// ---------------------------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------------------------

export const transitions: readonly MockTransition[] = [
  {
    from: "searchForm",
    on: { kind: "type", target: IDS.memberId as NodeId },
    to: "searchFormFilled",
  },
  { from: "searchFormFilled", on: { kind: "click", target: IDS.search as NodeId }, to: "results" },
  { from: "searchForm", on: { kind: "click", target: IDS.search as NodeId }, to: "notFound" },
  { from: "results", on: { kind: "click", target: IDS.selectLink as NodeId }, to: "detail" },
  {
    on: { kind: "navigate", path: "/members/search" },
    to: "searchForm",
  },
];

// ---------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------

export const ALLOWLIST: Allowlist = {
  originAliases: ["corebank"],
  routes: [
    { originAlias: "corebank", pathPattern: "/members/search", maxEffect: "WRITE_REVERSIBLE" },
    { originAlias: "corebank", pathPattern: "/members/:memberId", maxEffect: "WRITE_REVERSIBLE" },
  ],
  actionKinds: ["click", "type", "select", "setChecked", "pressKey", "focus", "navigate"],
  maxEffect: "WRITE_REVERSIBLE",
  discoveryMaxEffect: "WRITE_REVERSIBLE",
};

export const LEASE: LeaseSnapshot = {
  holder: "automation",
  actorId: "run:discovery-fixture",
  epoch: 0,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

export const CONTROL = { token: MOCK_LEASE_TOKEN, snapshot: LEASE } as const;

/** A frozen clock. Every timestamp in a fixture run is this one, which is what makes a rebuilt
 *  transcript byte-identical to the committed one. */
export const FROZEN_NOW = "2026-01-31T09:15:00.000Z";

/** A monotonic millisecond source with a fixed step, so recorded latencies are reproducible and
 *  visibly synthetic (every call takes exactly one millisecond). */
export function frozenClockMs(): () => number {
  let tick = 0;
  return () => {
    tick += 1;
    return tick;
  };
}

export const GOAL =
  "Look up member 50001 in the riverbend core banking back office and report their share balance.";
