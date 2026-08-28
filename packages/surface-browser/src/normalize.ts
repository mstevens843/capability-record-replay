// Per-frame accessibility trees in, one flat `UINode[]` out. No I/O: this is the pure half of the
// driver and it is where every decision that has to be RIGHT lives, so it can be tested from a
// frozen array of `AxNode`s with no browser running - the same argument SPEC section 4.8 makes for
// the classifier.
//
// Four things happen here that are not obvious from the type signature.
//
//   1. STITCHING. `Accessibility.getFullAXTree` fetches "the entire accessibility tree for the root
//      Document" - singular. On a frameset it returns SEVEN nodes and every `Iframe` node has
//      `childIds: []`. The whole screen is 126 nodes across four documents. The edge that joins them
//      is `DOM.describeNode({backendNodeId}).node.frameId`, resolved by the caller and handed in
//      here as `childFrameOfIframeBackendId`.
//
//   2. DROPPING `InlineTextBox`. Those nodes carry no `backendDOMNodeId`, which means they cannot be
//      measured, cannot be acted on, and have no identity to key anything to. They are also a
//      character-level re-run of text their parent `StaticText` already carries, so keeping them
//      would double every `count` predicate over text. They are dropped and their children are
//      re-parented, so the tree stays connected.
//
//   3. DOCUMENT ORDER. Nodes come back per frame in an order that is not the reading order, and
//      `ordinal-in-container` descriptors index into `Observation.nodes` directly. So the output is
//      re-sorted depth-first from the roots: the order a person reads the screen in.
//
//   4. TABLE POSITION FROM THE NEAREST ANCESTOR. `rowIndex`/`colIndex` are computed against the
//      nearest ancestor row and the nearest ancestor table, never against any ancestor. Using "any"
//      is precisely the bug that makes "the row whose Member ID is X" match both the data row and
//      the layout row wrapping the entire page (browser spike section 1.4).

import type { ContainerSegment, NodeId, Role, TablePosition, UINode } from "@crr/core";
import { type AxNode, axProperty, axString, axTristate } from "./cdp.js";
import type { FrameInfo } from "./frames.js";
import { IFRAME_ROLE, LANDMARK_ROLES, STATIC_TEXT_ROLE, normalizeRole } from "./roles.js";

/** Roles that can carry a `tablePosition`. `columnheader` and `rowheader` are included so a grid
 *  that DOES mark its headers is described the same way as one that does not. */
const CELL_ROLES: ReadonlySet<Role> = new Set<Role>(["cell", "columnheader", "rowheader"]);

/** The schema's ceilings, applied here rather than discovered as a validation error three packages
 *  away. An accessible name long enough to hit this is an aggregate one computed over a whole
 *  layout table - never an identity anything targets - so truncating it loses nothing a descriptor
 *  could have used. */
const MAX_NAME = 1024;
const MAX_TEXT = 4096;
const MAX_VALUE = 4096;
const MAX_DESCRIPTION = 1024;
const MAX_CONTAINER_SEGMENTS = 16;

/** A `UINode` plus the two things the driver needs to act on it and nothing above the port may see. */
export interface BrowserNode {
  readonly node: UINode;
  /** Globally unique across the page, and the identity geometry and actions are keyed on. */
  readonly backendId: number;
  /** Which document it lives in, as an index into the flattened frame list. */
  readonly frameIndex: number;
}

export interface NormalizeInput {
  readonly frames: readonly FrameInfo[];
  /** One accessibility tree per frame, indexed by the same index as `frames`. */
  readonly trees: readonly (readonly AxNode[])[];
  /** The stitch edges: the backend id of an `Iframe` node -> the frame index it embeds. */
  readonly childFrameOfIframeBackendId: ReadonlyMap<number, number>;
  /** Backend ids whose value the driver has blanked because a sensitive parameter was typed into
   *  them. Perception, not policy: the driver reports what it did, the taint model decided it. */
  readonly sensitiveBackendIds: ReadonlySet<number>;
}

export interface NormalizeResult {
  readonly nodes: readonly BrowserNode[];
  readonly roots: readonly NodeId[];
}

// ---------------------------------------------------------------------------------------------
// The working record
// ---------------------------------------------------------------------------------------------

interface Working {
  readonly id: NodeId;
  readonly ax: AxNode;
  readonly backendId: number;
  readonly frameIndex: number;
  readonly rawRole: string;
  readonly ariaRole: Role | null;
  readonly isFrameRoot: boolean;
  parent: NodeId | null;
  children: NodeId[];
}

export function normalizeObservationNodes(input: NormalizeInput): NormalizeResult {
  const working: Working[] = [];
  const byId = new Map<NodeId, Working>();
  const byBackendId = new Map<number, Working>();
  /** Per frame: the surviving AX nodes by their document-local `nodeId`. */
  const perFrameSurvivors: Map<string, AxNode>[] = [];

  // -- pass 1: survivors, ids, roles -----------------------------------------------------------
  for (const [frameIndex, tree] of input.trees.entries()) {
    const survivors = new Map<string, AxNode>();
    perFrameSurvivors.push(survivors);
    for (const ax of tree) {
      if (ax.backendDOMNodeId === undefined) continue;
      if (ax.role === undefined) continue;
      survivors.set(ax.nodeId, ax);
    }
    for (const ax of survivors.values()) {
      const rawRole = axString(ax.role);
      const ariaRole = normalizeRole(ax.role?.type, rawRole);
      const id = nodeIdOf(ariaRole, frameIndex, ax.nodeId);
      const record: Working = {
        id,
        ax,
        backendId: ax.backendDOMNodeId as number,
        frameIndex,
        rawRole,
        ariaRole,
        isFrameRoot: ax.frameId !== undefined,
        parent: null,
        children: [],
      };
      working.push(record);
      byId.set(id, record);
      if (!byBackendId.has(record.backendId)) byBackendId.set(record.backendId, record);
    }
  }

  // -- pass 2: parent and child links, climbing over dropped nodes ------------------------------
  //
  // A dropped node is not a hole. Its children are re-attached to its nearest surviving ancestor and
  // appear in the parent's child list exactly where the dropped node was, so document order and the
  // ancestor walks that `tablePosition` depends on both survive the drop.
  for (const [frameIndex, survivors] of perFrameSurvivors.entries()) {
    const tree = input.trees[frameIndex] as readonly AxNode[];
    const all = new Map<string, AxNode>(tree.map((ax) => [ax.nodeId, ax]));
    for (const ax of survivors.values()) {
      const record = byId.get(nodeIdOfAx(ax, frameIndex));
      if (record === undefined) continue;
      record.parent = surviving(ax.parentId, all, survivors, frameIndex);
      record.children = survivingChildren(ax, all, survivors, frameIndex);
    }
  }

  // -- pass 3: the stitch ----------------------------------------------------------------------
  const stitchedFrames = new Set<number>();
  for (const record of working) {
    if (record.rawRole !== IFRAME_ROLE) continue;
    const childFrameIndex = input.childFrameOfIframeBackendId.get(record.backendId);
    if (childFrameIndex === undefined || stitchedFrames.has(childFrameIndex)) continue;
    const childRoot = working.find(
      (candidate) => candidate.frameIndex === childFrameIndex && candidate.parent === null,
    );
    if (childRoot === undefined) continue;
    childRoot.parent = record.id;
    record.children = [...record.children, childRoot.id];
    stitchedFrames.add(childFrameIndex);
  }

  // -- pass 4: document order ------------------------------------------------------------------
  const roots = working.filter((record) => record.parent === null).map((record) => record.id);
  const ordered = depthFirst(roots, byId, working);

  // -- pass 5: derived text, then tables, then everything a `UINode` carries --------------------
  const text = new Map<NodeId, string | null>();
  for (const record of ordered) text.set(record.id, displayTextOf(record, byId));
  const tables = analyseTables(ordered, byId, text);

  const nodes: BrowserNode[] = ordered.map((record) => ({
    node: toUINode(record, byId, byBackendId, text, tables, input),
    backendId: record.backendId,
    frameIndex: record.frameIndex,
  }));
  return { nodes, roots };
}

// ---------------------------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------------------------

/**
 * `<role>:f<frame>-<axNodeId>`, matching `@crr/core`'s `<kind>:<local>` node-id shape.
 *
 * The role is in the id because a journal full of `structure:f0-13` and `button:f2-44` is readable
 * at 2am and a journal full of opaque handles is not. It is emphatically NOT an identity: an AX
 * `nodeId` is unique only within one document and only within one snapshot, which is why the frame
 * index is in there too and why the artifact validator refuses any string of this shape.
 */
export function nodeIdOf(ariaRole: Role | null, frameIndex: number, axNodeId: string): NodeId {
  const kind = ariaRole ?? "structure";
  return `${kind}:f${frameIndex}-${axNodeId}` as NodeId;
}

/** The same id, recomputed from an `AxNode` when only the node is in hand. */
function nodeIdOfAx(ax: AxNode, frameIndex: number): NodeId {
  return nodeIdOf(normalizeRole(ax.role?.type, axString(ax.role)), frameIndex, ax.nodeId);
}

// ---------------------------------------------------------------------------------------------
// Tree surgery
// ---------------------------------------------------------------------------------------------

function surviving(
  parentId: string | undefined,
  all: ReadonlyMap<string, AxNode>,
  survivors: ReadonlyMap<string, AxNode>,
  frameIndex: number,
): NodeId | null {
  let cursor = parentId;
  // Bounded rather than `while (true)`: a cyclic parent chain is impossible in a real AX tree and
  // an infinite loop in a driver is a hang, which has no failure class.
  for (let depth = 0; depth < 512 && cursor !== undefined; depth += 1) {
    const found = survivors.get(cursor);
    if (found !== undefined) return nodeIdOfAx(found, frameIndex);
    cursor = all.get(cursor)?.parentId;
  }
  return null;
}

function survivingChildren(
  ax: AxNode,
  all: ReadonlyMap<string, AxNode>,
  survivors: ReadonlyMap<string, AxNode>,
  frameIndex: number,
): NodeId[] {
  const out: NodeId[] = [];
  const visit = (childIds: readonly string[], depth: number): void => {
    if (depth > 512) return;
    for (const childId of childIds) {
      const survivor = survivors.get(childId);
      if (survivor !== undefined) {
        out.push(nodeIdOfAx(survivor, frameIndex));
        continue;
      }
      const dropped = all.get(childId);
      if (dropped !== undefined) visit(dropped.childIds ?? [], depth + 1);
    }
  };
  visit(ax.childIds ?? [], 0);
  return out;
}

/** Reading order. Anything unreachable from a root is appended rather than lost - a node that is
 *  not in the output is a node no detector can ever see, and silence is the wrong report. */
function depthFirst(
  roots: readonly NodeId[],
  byId: ReadonlyMap<NodeId, Working>,
  all: readonly Working[],
): readonly Working[] {
  const seen = new Set<NodeId>();
  const out: Working[] = [];
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const id = stack.pop() as NodeId;
    if (seen.has(id)) continue;
    const record = byId.get(id);
    if (record === undefined) continue;
    seen.add(id);
    out.push(record);
    for (let i = record.children.length - 1; i >= 0; i -= 1) {
      stack.push(record.children[i] as NodeId);
    }
  }
  for (const record of all) if (!seen.has(record.id)) out.push(record);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/**
 * What the node DISPLAYS, as distinct from what it is called.
 *
 * For a run of page text they are the same thing. For a control they are not: a legacy field's
 * accessible name is the label beside it, and its displayed content is its value - so a textbox
 * gets `text: null` and a cell gets the text a person reads in that box. `@crr/core`'s extractor
 * reads `text ?? value ?? name`, in that order, and the whole point of computing this separately is
 * that the first of those three is the honest one.
 *
 * Only computed for text runs and for real targets. A structural wrapper gets `null` rather than a
 * copy of the page, which keeps an observation small enough to write to disk without ceremony.
 */
function displayTextOf(record: Working, byId: ReadonlyMap<NodeId, Working>): string | null {
  if (record.rawRole === STATIC_TEXT_ROLE) return clamp(axString(record.ax.name), MAX_TEXT) || null;
  if (record.ariaRole === null) return null;
  let out = "";
  const visit = (id: NodeId, depth: number): void => {
    if (depth > 64 || out.length >= MAX_TEXT) return;
    const child = byId.get(id);
    if (child === undefined) return;
    if (child.rawRole === STATIC_TEXT_ROLE) {
      out += axString(child.ax.name);
      return;
    }
    for (const grandchild of child.children) visit(grandchild, depth + 1);
  };
  for (const child of record.children) visit(child, 0);
  const trimmed = clamp(out, MAX_TEXT).trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

interface TableFacts {
  readonly headers: readonly string[];
  readonly headerProvenance: TablePosition["headerProvenance"];
  /** Row id -> its index inside this table, header row included as index 0. */
  readonly rowIndex: ReadonlyMap<NodeId, number>;
}

interface TableAnalysis {
  readonly byTable: ReadonlyMap<NodeId, TableFacts>;
  readonly cellPosition: ReadonlyMap<NodeId, TablePosition>;
}

/**
 * Structure for free, headers only by heuristic.
 *
 * Chromium classifies the target application's grid as a real data table even though it has no
 * `<th>`, no `scope=` and no `<caption>` - so rows and cells are genuine. What it does NOT give us
 * is header semantics: every cell of row zero comes back as `cell`, not `columnheader`. So the
 * header row is row zero unless some cell really is a `columnheader`, and WHICH of those two
 * happened is recorded on every cell as `headerProvenance` - because a guess that was never labelled
 * as a guess cannot be corrected by a tenant overlay, and correcting it there is the design.
 */
function analyseTables(
  ordered: readonly Working[],
  byId: ReadonlyMap<NodeId, Working>,
  text: ReadonlyMap<NodeId, string | null>,
): TableAnalysis {
  const rowsByTable = new Map<NodeId, NodeId[]>();
  const cellsByRow = new Map<NodeId, NodeId[]>();
  const tableOfRow = new Map<NodeId, NodeId>();
  const rowOfCell = new Map<NodeId, NodeId>();

  for (const record of ordered) {
    if (record.ariaRole === "row") {
      const table = nearestAncestor(record, byId, (each) => each.ariaRole === "table");
      if (table === null) continue;
      tableOfRow.set(record.id, table.id);
      push(rowsByTable, table.id, record.id);
      continue;
    }
    if (record.ariaRole !== null && CELL_ROLES.has(record.ariaRole)) {
      // NEAREST, not any. Any ancestor row is the measured bug: on nested layout tables there is
      // always a second one, and it wraps the entire page.
      const row = nearestAncestor(record, byId, (each) => each.ariaRole === "row");
      if (row === null) continue;
      rowOfCell.set(record.id, row.id);
      push(cellsByRow, row.id, record.id);
    }
  }

  const byTable = new Map<NodeId, TableFacts>();
  for (const [tableId, rows] of rowsByTable) {
    const declared = rows.find((rowId) =>
      (cellsByRow.get(rowId) ?? []).some((cellId) => byId.get(cellId)?.ariaRole === "columnheader"),
    );
    const headerRow = declared ?? rows[0];
    const headers =
      headerRow === undefined
        ? []
        : (cellsByRow.get(headerRow) ?? []).map((cellId) => cellLabel(cellId, byId, text));
    byTable.set(tableId, {
      headers,
      headerProvenance: declared === undefined ? "first-row-heuristic" : "columnheader-role",
      rowIndex: new Map(rows.map((rowId, index) => [rowId, index])),
    });
  }

  const cellPosition = new Map<NodeId, TablePosition>();
  for (const [cellId, rowId] of rowOfCell) {
    const tableId = tableOfRow.get(rowId);
    if (tableId === undefined) continue;
    const facts = byTable.get(tableId);
    const rowIndex = facts?.rowIndex.get(rowId);
    if (facts === undefined || rowIndex === undefined) continue;
    const cells = cellsByRow.get(rowId) ?? [];
    const colIndex = cells.indexOf(cellId);
    if (colIndex < 0) continue;
    const rowHeaderId = cells.find((each) => byId.get(each)?.ariaRole === "rowheader");
    cellPosition.set(cellId, {
      rowIndex,
      colIndex,
      // Column mapping is POSITIONAL: the accessibility tree exposes no `colindex`, no `rowindex`
      // and no `colcount` at all. A `colspan` in the header row would desynchronise header index
      // from cell index, and the honest signal for that is a missing header rather than a
      // confidently wrong one.
      colHeader: facts.headers[colIndex] ?? null,
      rowHeader:
        rowHeaderId === undefined || rowHeaderId === cellId
          ? null
          : cellLabel(rowHeaderId, byId, text),
      headerProvenance: facts.headerProvenance,
    });
  }
  return { byTable, cellPosition };
}

function cellLabel(
  cellId: NodeId,
  byId: ReadonlyMap<NodeId, Working>,
  text: ReadonlyMap<NodeId, string | null>,
): string {
  const record = byId.get(cellId);
  if (record === undefined) return "";
  return clamp(text.get(cellId) ?? axString(record.ax.name), 128);
}

// ---------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------

/**
 * The breadcrumb, outermost first, built by walking the STITCHED ancestor chain.
 *
 * Because the chain crosses frames, one walk produces the frame name chain, the landmarks of every
 * document on the way down, and the tables a node sits inside, already interleaved in the right
 * order. A frame segment is emitted at each frame ROOT node, which is the only node that carries a
 * `frameId` - six of the seven nodes in a frameset's own tree have none, so "walk up until you find
 * a frameId" is not a way to tell documents apart.
 */
function containerPathOf(
  record: Working,
  byId: ReadonlyMap<NodeId, Working>,
  frames: readonly FrameInfo[],
  tables: TableAnalysis,
): readonly ContainerSegment[] {
  const reversed: ContainerSegment[] = [];
  let cursor = record.parent === null ? null : (byId.get(record.parent) ?? null);
  for (let depth = 0; depth < 512 && cursor !== null; depth += 1) {
    const segment = segmentFor(cursor, frames, tables);
    if (segment !== null) reversed.push(segment);
    cursor = cursor.parent === null ? null : (byId.get(cursor.parent) ?? null);
  }
  const path = reversed.reverse();
  // The ceiling is the schema's. Outermost segments are kept because the frame chain is what scopes
  // a detector to the right document, and a breadcrumb that has lost its frame is worse than one
  // that has lost a nesting level.
  return path.length > MAX_CONTAINER_SEGMENTS ? path.slice(0, MAX_CONTAINER_SEGMENTS) : path;
}

function segmentFor(
  record: Working,
  frames: readonly FrameInfo[],
  tables: TableAnalysis,
): ContainerSegment | null {
  if (record.isFrameRoot) {
    const path = frames[record.frameIndex]?.path ?? [];
    const name = path[path.length - 1];
    return name === undefined ? null : { kind: "frame", name };
  }
  if (record.ariaRole === "table") {
    return { kind: "table", headers: tables.byTable.get(record.id)?.headers ?? [] };
  }
  if (record.ariaRole !== null && LANDMARK_ROLES.has(record.ariaRole)) {
    const name = clamp(axString(record.ax.name), 256);
    return {
      kind: "landmark",
      role: record.ariaRole as "main" | "navigation" | "form" | "region" | "dialog",
      name: name.length > 0 ? name : null,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// One node
// ---------------------------------------------------------------------------------------------

function toUINode(
  record: Working,
  byId: ReadonlyMap<NodeId, Working>,
  byBackendId: ReadonlyMap<number, Working>,
  text: ReadonlyMap<NodeId, string | null>,
  tables: TableAnalysis,
  input: NormalizeInput,
): UINode {
  const masked = input.sensitiveBackendIds.has(record.backendId);
  const rawValue =
    record.ax.value === undefined ? null : clamp(axString(record.ax.value), MAX_VALUE);
  const description = clamp(axString(record.ax.description), MAX_DESCRIPTION);
  return {
    id: record.id,
    rawRole: record.rawRole,
    ariaRole: record.ariaRole,
    name: clamp(axString(record.ax.name), MAX_NAME),
    // Blanked, not redacted-in-place: there is no masked spelling of a member number that is safe
    // to write to an evidence directory, and `masked: true` beside it is what tells the executor to
    // blank the same pixels out of the screenshot.
    value: masked ? null : rawValue,
    text: masked ? null : (text.get(record.id) ?? null),
    description: description.length > 0 ? description : null,
    state: {
      disabled: axProperty(record.ax, "disabled")?.value === true,
      focused: axProperty(record.ax, "focused")?.value === true,
      // Absence from the tree is how Chromium reports `display:none` AND `visibility:hidden`, so
      // anything present is on screen unless the tree explicitly ignored it. Note that having a box
      // is NOT evidence of being visible - `visibility:hidden` returns a perfectly ordinary box -
      // which is why this is read off the tree and never off geometry.
      visible: !record.ax.ignored,
      checked: axTristate(axProperty(record.ax, "checked")),
      expanded: axTristate(axProperty(record.ax, "expanded")),
      selected: axTristate(axProperty(record.ax, "selected")),
      required: axTristate(axProperty(record.ax, "required")),
      invalid: invalidOf(record.ax),
      readonly: axTristate(axProperty(record.ax, "readonly")),
    },
    bounds: null,
    containerPath: containerPathOf(record, byId, input.frames, tables),
    parent: record.parent,
    children: record.children,
    labelledBy: labelledByOf(record.ax, byBackendId),
    tablePosition: tables.cellPosition.get(record.id) ?? null,
    // A browser knows nothing about field width in characters. It is the character grid's answer to
    // "how long may this value be", and this surface simply does not have one.
    capacity: null,
    // A real accessibility tree computes the role and the name; this driver infers neither, so it
    // has nothing to be less than certain about. The field exists for surfaces that synthesize a
    // role out of a reverse-video run, and `confidenceFloor: 1` is what says so on this one.
    confidence: 1,
    live: isLive(record.ax),
    masked,
  };
}

/** `invalid` arrives as the strings `"false"` / `"true"`, so truth-testing it marks every field on
 *  the page invalid. */
function invalidOf(ax: AxNode): boolean | null {
  const raw = axProperty(ax, "invalid")?.value;
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

/** Text that changes on its own, excluded from the skeleton digest so a clock in a page header
 *  cannot make a surface permanently unsettled. `containerLive` is checked too: the node that
 *  changes is usually a text run inside the region the author marked, not the region itself. */
function isLive(ax: AxNode): boolean {
  for (const name of ["live", "containerLive"]) {
    const raw = axProperty(ax, name)?.value;
    if (typeof raw === "string" && raw.length > 0 && raw !== "off") return true;
  }
  return false;
}

/**
 * Which nodes provide this node's accessible name.
 *
 * This is what `@crr/core` calls the correlation detector: if the name came from a label element,
 * then a `role-name` descriptor and a `label-anchored` descriptor anchored on that label are reading
 * the same words off the same screen, and the quorum that looks like two independent sources is
 * really one. Reporting it truthfully is what lets the resolver refuse.
 */
function labelledByOf(ax: AxNode, byBackendId: ReadonlyMap<number, Working>): readonly NodeId[] {
  const related = axProperty(ax, "labelledby")?.relatedNodes ?? [];
  const out: NodeId[] = [];
  for (const node of related) {
    if (node.backendDOMNodeId === undefined) continue;
    const found = byBackendId.get(node.backendDOMNodeId);
    if (found !== undefined) out.push(found.id);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------------------------

function nearestAncestor(
  record: Working,
  byId: ReadonlyMap<NodeId, Working>,
  predicate: (candidate: Working) => boolean,
): Working | null {
  let cursor = record.parent === null ? null : (byId.get(record.parent) ?? null);
  for (let depth = 0; depth < 512 && cursor !== null; depth += 1) {
    if (predicate(cursor)) return cursor;
    cursor = cursor.parent === null ? null : (byId.get(cursor.parent) ?? null);
  }
  return null;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}

const clamp = (value: string, max: number): string =>
  value.length > max ? value.slice(0, max) : value;
