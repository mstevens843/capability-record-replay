// Builders for the frozen Observation corpus.
//
// Every screen in this package is a plain JSON `Observation`, built here and validated by
// `MockSurface`'s own constructor. That is the whole reason the conformance suite runs in
// milliseconds with no browser, no socket and no credential: SPEC section 4.8 item 3 says the
// corpus IS the test case, and a corpus that needs a server to exist is a corpus nobody runs.
//
// PROVENANCE, stated plainly because the evidence bar in BRIEF section 5 demands it: these screens
// are HAND-AUTHORED to mirror what `fixtures/corebank-web` serves for each of its ten injectable
// faults. They were not captured from a live `perceive()`. Capturing the real thing is SPEC section
// 4.8 item 2's job (`evidence/observations/<runId>/<seq>.json`) and belongs to the evidence unit;
// what this file gives up in fidelity it buys back in the ability to script conditions a browser
// cannot be asked for on demand - a half-painted grid that claims to be settled, a control that
// dispatches and does nothing, two descriptors that name different nodes.

import {
  type ContainerMatcher,
  type NativeDialog,
  type NodeId,
  type Observation,
  type TablePosition,
  type TextMatcher,
  type UINode,
  skeletonDigestOf,
} from "@crr/core";

// ---------------------------------------------------------------------------------------------
// Containers. The fixture is a frameset: a `nav` frame and a `content` frame, and the same
// accessible name appears in both, which is control C3's whole reason for existing.
// ---------------------------------------------------------------------------------------------

export const CONTENT = { kind: "frame", name: "content" } as const;
export const SEARCH_FORM = { kind: "landmark", role: "form", name: "Member Search" } as const;
export const RESULTS_REGION = { kind: "landmark", role: "region", name: "Search Results" } as const;
export const DETAIL_REGION = { kind: "landmark", role: "region", name: "Member Detail" } as const;
export const NOTICE_DIALOG = { kind: "landmark", role: "dialog", name: "System Notice" } as const;
export const RESULTS_TABLE = {
  kind: "table",
  headers: ["Member ID", "Name", "Share Balance", "Status", "Action"],
} as const;

export const QUICK_FORM = { kind: "landmark", role: "form", name: "Quick Lookup" } as const;

export type Where = "search" | "quick" | "results" | "results-row" | "detail" | "dialog";

const PATHS: Readonly<Record<Where, UINode["containerPath"]>> = {
  search: [CONTENT, SEARCH_FORM],
  quick: [CONTENT, QUICK_FORM],
  results: [CONTENT, RESULTS_REGION],
  "results-row": [CONTENT, RESULTS_REGION, RESULTS_TABLE],
  detail: [CONTENT, DETAIL_REGION],
  dialog: [CONTENT, NOTICE_DIALOG],
};

export interface NodeSpec {
  readonly id: string;
  readonly role: UINode["ariaRole"];
  readonly where: Where;
  readonly name?: string;
  readonly value?: string | null;
  readonly text?: string | null;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly selected?: boolean;
  readonly masked?: boolean;
  readonly capacity?: number | null;
  readonly table?: {
    readonly rowIndex: number;
    readonly colIndex: number;
    readonly colHeader: string;
  };
  readonly children?: readonly string[];
  readonly parent?: string | null;
  /**
   * The nodes that PROVIDE this node's accessible name.
   *
   * Load-bearing rather than decorative: when the label's text equals the node's name, a
   * `role-name` descriptor and a `label-anchored` descriptor anchored on that label are reading the
   * same words off the same screen, and the resolver collapses them into ONE piece of evidence.
   * That collapse is what the correlated-descriptor scenario exists to exercise.
   */
  readonly labelledBy?: readonly string[];
}

export function node(spec: NodeSpec): UINode {
  const tablePosition: TablePosition | null =
    spec.table === undefined
      ? null
      : {
          rowIndex: spec.table.rowIndex,
          colIndex: spec.table.colIndex,
          rowHeader: null,
          colHeader: spec.table.colHeader,
          // The fixture's grid is a `<table>` with a real header row, so the driver reads the
          // headers off `columnheader` cells rather than guessing from row zero. The descriptors
          // record that, and a surface that later reports `first-row-heuristic` raises a warning
          // rather than silently resolving against a guess.
          headerProvenance: "columnheader-role",
        };
  return {
    id: spec.id as NodeId,
    rawRole: spec.role ?? "generic",
    ariaRole: spec.role,
    name: spec.name ?? "",
    value: spec.value ?? null,
    text: spec.text ?? null,
    description: null,
    state: {
      disabled: spec.disabled ?? false,
      focused: false,
      visible: true,
      checked: null,
      expanded: null,
      selected: spec.selected ?? null,
      required: null,
      invalid: spec.invalid ?? false,
      readonly: false,
    },
    bounds: null,
    containerPath: PATHS[spec.where],
    parent: (spec.parent ?? null) as NodeId | null,
    children: (spec.children ?? []) as readonly NodeId[],
    labelledBy: (spec.labelledBy ?? []) as readonly NodeId[],
    tablePosition,
    capacity: spec.capacity ?? null,
    confidence: 1,
    live: false,
    masked: spec.masked ?? false,
  } as UINode;
}

export interface ScreenSpec {
  readonly path: string;
  readonly nodes: readonly UINode[];
  /** `false` is the loading shell: the driver says the page is still moving. */
  readonly settled?: boolean;
  readonly intercepted?: boolean;
  readonly dialog?: NativeDialog | null;
}

/**
 * One frozen screen.
 *
 * `seq` is the observation sequence number the driver stamps. It is an argument rather than a
 * counter because two screens that differ only by `seq` must still be reproducible byte for byte
 * across runs - the whole suite compares digests.
 */
export function screen(seq: number, spec: ScreenSpec): Observation {
  const settled = spec.settled ?? true;
  return {
    seq,
    surface: { kind: "web-legacy", driver: "mock-surface@0.1.0" },
    route: { originAlias: "corebank", path: spec.path, query: {}, frame: "content" },
    nodes: spec.nodes,
    roots: [],
    skeletonDigest: skeletonDigestOf(spec.nodes),
    stability: { settled, generation: seq, pendingReason: settled ? null : "network" },
    nativeDialog: spec.dialog ?? null,
    inputIntercepted: spec.intercepted ?? spec.dialog != null,
  } as Observation;
}

// ---------------------------------------------------------------------------------------------
// Matchers, shared by descriptors, detectors and checkpoints
// ---------------------------------------------------------------------------------------------

/** A vocabulary token. THE multi-tenant hinge: one declaration, forty call sites. */
export const token = (t: string): TextMatcher =>
  ({ mode: "token", token: t, normalize: "std.label@1" }) as TextMatcher;

export const exact = (v: string): TextMatcher =>
  ({ mode: "exact", value: v, normalize: "std.text@1" }) as TextMatcher;

export const scopeOf = (...path: readonly unknown[]): ContainerMatcher =>
  ({ path }) as unknown as ContainerMatcher;

export const FRAME_CONTENT = { kind: "frame", name: exact("content") } as const;
export const SEARCH_SCOPE: ContainerMatcher = scopeOf(FRAME_CONTENT, {
  kind: "landmark",
  role: "form",
});
export const RESULTS_SCOPE: ContainerMatcher = scopeOf(FRAME_CONTENT, {
  kind: "landmark",
  role: "region",
  name: token("results-region"),
});
export const RESULTS_TABLE_SCOPE: ContainerMatcher = scopeOf(
  FRAME_CONTENT,
  { kind: "landmark", role: "region", name: token("results-region") },
  { kind: "table", headers: [token("member-id-column"), token("name-column")] },
);
export const DETAIL_SCOPE: ContainerMatcher = scopeOf(FRAME_CONTENT, {
  kind: "landmark",
  role: "region",
  name: token("detail-region"),
});
export const DIALOG_SCOPE: ContainerMatcher = scopeOf(FRAME_CONTENT, {
  kind: "landmark",
  role: "dialog",
  name: token("notice-dialog"),
});
