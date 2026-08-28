// SPEC section 6.2 - the filtered projection the model is shown.
//
// This is the token cost centre of the whole system and it is also the safety boundary, and those
// two facts push the same way. The browser spike measured a 205-node observation serialising to
// 50 KB and the same observation filtered to `ariaRole !== null && visible` at 14 KB, so filtering
// is worth roughly a 3.5x on every turn of every discovery run. It is also what keeps the model
// away from markup: there is no field here that could carry an element, an attribute or an id, so
// "the model never authors a locator" is a property of the projection rather than a rule the
// prompt asks the model to follow.
//
// THREE INVARIANTS THIS FILE HOLDS:
//
//   1. `nodeRef` is `n<k>` where k is the index into THIS TURN's `observation.nodes`. It is not a
//      NodeId, it is not stable across turns, and it never reaches an artifact. The map is built
//      per turn and thrown away with the turn (SPEC section 6.2).
//   2. A node the driver masked is rendered as `<masked:N>` and its value never appears. The
//      length is deliberate and is not a leak worth worrying about: SPEC section 8.3 keeps it on
//      the taint box precisely because "the field truncated what we typed" is a real failure that
//      is invisible without it.
//   3. Table cells carry their row-key and column-header context, because that is the vocabulary
//      the descriptor deriver will emit and the model should be reasoning in the same terms the
//      recording will be written in.

import { type Observation, type UINode, maskedLabel } from "@crr/core";
import type { NodeId, TaintedValue } from "@crr/core";

export interface ProjectionOptions {
  /** Hard cap on rendered nodes. A screen with more is truncated and SAYS SO - a silent truncation
   *  is a model reasoning confidently about a screen it was only shown half of. */
  readonly maxNodes?: number;
  readonly maxNameLength?: number;
  /** Nodes carrying a value bound to a sensitive parameter, by node id. */
  readonly masked?: ReadonlyMap<NodeId, TaintedValue>;
}

export interface Projection {
  readonly text: string;
  /** `n<k>` to `NodeId`, valid for this observation only. */
  readonly refs: ReadonlyMap<string, NodeId>;
  readonly shown: number;
  readonly hidden: number;
  readonly obsSeq: number;
}

const DEFAULTS = { maxNodes: 200, maxNameLength: 80 } as const;

/** The roles whose CONTENT is the value a caller wants, so `value=` is worth its tokens. */
const VALUE_ROLES = new Set(["textbox", "combobox", "listbox", "option"]);

/** The roles that are cells of a grid rather than things inside one. */
const CELL_ROLES = new Set(["cell", "columnheader", "rowheader"]);

/** What a truncated string ends with. Named rather than inlined so the marker is one character in
 *  one place: a projection that truncated with "..." would be indistinguishable from a screen whose
 *  label really ends in three dots, which is common on a menu. */
const ELLIPSIS = "…";

// ---------------------------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------------------------

export function projectObservation(
  observation: Observation,
  options: ProjectionOptions = {},
): Projection {
  const maxNodes = options.maxNodes ?? DEFAULTS.maxNodes;
  const maxName = options.maxNameLength ?? DEFAULTS.maxNameLength;
  const masked = options.masked ?? new Map<NodeId, TaintedValue>();

  const candidates: { readonly ref: string; readonly node: UINode }[] = [];
  observation.nodes.forEach((node, index) => {
    // SPEC section 6.2's filter, and nothing else. A structural node (`ariaRole === null`) is what
    // a layout table degrades into on this fixture, and showing them is how a model ends up
    // choosing a wrapper cell instead of the link inside it.
    if (node.ariaRole === null || !node.state.visible) return;
    candidates.push({ ref: `n${index}`, node });
  });

  const kept = candidates.slice(0, maxNodes);
  const refs = new Map<string, NodeId>();
  const lines: string[] = [header(observation)];

  for (const { ref, node } of kept) {
    refs.set(ref, node.id);
    lines.push(renderNode(ref, node, observation, masked, maxName));
  }

  const hidden = candidates.length - kept.length;
  if (hidden > 0) {
    lines.push(
      `... ${hidden} more control(s) not shown (limit ${maxNodes}). Narrow the screen before acting.`,
    );
  }
  if (candidates.length === 0) {
    lines.push("(no controls or readable values are visible on this screen)");
  }

  return {
    text: lines.join("\n"),
    refs,
    shown: kept.length,
    hidden: Math.max(0, hidden),
    obsSeq: observation.seq,
  };
}

/** `n<k>` to the node id it named in that observation, or `null`. A stale ref returns null and the
 *  loop refuses the action - it does not guess at what the model meant on a screen that moved. */
export function resolveNodeRef(projection: Projection, ref: string): NodeId | null {
  return projection.refs.get(ref) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

function header(observation: Observation): string {
  const parts: string[] = [];
  parts.push(
    observation.stability.settled
      ? "settled"
      : `not-settled(${observation.stability.pendingReason ?? "unknown"})`,
  );
  if (observation.route !== null) {
    const query = Object.entries(observation.route.query)
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    const suffix = query === "" ? "" : `?${query}`;
    parts.push(`route=${observation.route.originAlias}${observation.route.path}${suffix}`);
  }
  if (observation.inputIntercepted) parts.push("input-intercepted");

  const lines = [`screen: ${parts.join("  ")}`];
  if (observation.nativeDialog !== null) {
    // A native dialog is a separate channel, not a node, so it cannot be projected as one - and a
    // model that cannot see it will keep clicking at a screen whose renderer is blocked.
    const dialog = observation.nativeDialog;
    lines.push(
      `dialog: ${dialog.type} ${JSON.stringify(dialog.message)} (blocks every other action)`,
    );
  }
  return lines.join("\n");
}

function renderNode(
  ref: string,
  node: UINode,
  observation: Observation,
  masked: ReadonlyMap<NodeId, TaintedValue>,
  maxName: number,
): string {
  const parts: string[] = [
    `[${ref}]`,
    node.ariaRole ?? "",
    JSON.stringify(truncate(label(node), maxName)),
  ];

  const value = renderValue(node, masked, maxName);
  if (value !== null) parts.push(value);

  const state = renderState(node);
  if (state !== null) parts.push(state);

  if (node.capacity !== null) parts.push(`capacity=${node.capacity}`);

  const frame = frameOf(node);
  if (frame !== null) parts.push(`frame=${frame}`);

  const table = renderTableContext(node, observation, maxName);
  if (table !== null) parts.push(table);

  return parts.filter((part) => part !== "").join("  ");
}

/** What a person would call this control. `name` first because that is the accessible name and it
 *  is what a descriptor will be built from; `text` is the fallback for a grid cell with no name. */
function label(node: UINode): string {
  if (node.name !== "") return node.name;
  if (node.text !== null && node.text !== "") return node.text;
  return "";
}

function renderValue(
  node: UINode,
  masked: ReadonlyMap<NodeId, TaintedValue>,
  maxName: number,
): string | null {
  const tainted = masked.get(node.id);
  if (tainted !== undefined) return `value=${maskedLabel(tainted)}`;
  // The driver's own masking wins over everything: it blanked the field before we saw it, so there
  // is nothing here to render even if this loop has no binding for it.
  if (node.masked) return "value=<masked>";
  if (node.value === null) return null;
  if (!VALUE_ROLES.has(node.ariaRole ?? "")) return null;
  return `value=${JSON.stringify(truncate(node.value, maxName))}`;
}

function renderState(node: UINode): string | null {
  const flags: string[] = [];
  if (node.state.disabled) flags.push("disabled");
  if (node.state.readonly === true) flags.push("readonly");
  if (node.state.required === true) flags.push("required");
  if (node.state.invalid === true) flags.push("invalid");
  if (node.state.checked !== null) flags.push(node.state.checked ? "checked" : "unchecked");
  if (node.state.expanded !== null) flags.push(node.state.expanded ? "expanded" : "collapsed");
  if (node.state.selected === true) flags.push("selected");
  if (node.state.focused) flags.push("focused");
  return flags.length === 0 ? null : flags.join(",");
}

function frameOf(node: UINode): string | null {
  for (const segment of node.containerPath) {
    if (segment.kind === "frame") return segment.name;
  }
  return null;
}

/**
 * The grid vocabulary, per SPEC section 6.2.
 *
 * A CELL says which table and which column it is in. Anything else that lives inside a row - the
 * "Select" link that is the entire point of a results grid - says which ROW it is in, keyed by the
 * row's own leading columns. That asymmetry is not a rendering preference: "the Select link in the
 * row whose Member ID is 50001" is exactly the table-cell-relative descriptor the deriver will
 * emit, so this is the model being shown the sentence its choice will be recorded as.
 */
function renderTableContext(
  node: UINode,
  observation: Observation,
  maxName: number,
): string | null {
  if (node.tablePosition === null) return null;
  const headers = tableHeadersOf(node);
  if (CELL_ROLES.has(node.ariaRole ?? "")) {
    const column = node.tablePosition.colHeader ?? `col#${node.tablePosition.colIndex}`;
    // A `?` marks a column header the driver GUESSED from row zero rather than read off a
    // columnheader role. The model should weight "col=Share Balance?" less than a real header,
    // and hiding the guess would be the same mistake the observation schema refuses to make.
    const provenance = node.tablePosition.headerProvenance === "first-row-heuristic" ? "?" : "";
    return `table[${headers.join(",")}] col=${column}${provenance}`;
  }
  const row = rowSummary(node, observation, maxName);
  return row === null ? `table[${headers.join(",")}]` : `row: ${row}`;
}

function tableHeadersOf(node: UINode): readonly string[] {
  for (const segment of node.containerPath) {
    if (segment.kind === "table") return segment.headers;
  }
  return [];
}

const ROW_COLUMNS = 3;

function rowSummary(node: UINode, observation: Observation, maxName: number): string | null {
  const container = tableKeyOf(node);
  const rowIndex = node.tablePosition?.rowIndex;
  if (container === null || rowIndex === undefined) return null;

  const cells: string[] = [];
  for (const other of observation.nodes) {
    if (other.tablePosition === null || other.tablePosition.rowIndex !== rowIndex) continue;
    if (!CELL_ROLES.has(other.ariaRole ?? "")) continue;
    if (tableKeyOf(other) !== container) continue;
    const column = other.tablePosition.colHeader;
    if (column === null) continue;
    const text = label(other);
    if (text === "") continue;
    cells.push(`${column}=${truncate(text, maxName)}`);
    if (cells.length === ROW_COLUMNS) break;
  }
  return cells.length === 0 ? null : cells.join(" | ");
}

/** Identity of the grid a node sits in: its frame plus its column header set. There is no id worth
 *  trusting on these screens, which is the premise of the whole assignment. */
function tableKeyOf(node: UINode): string | null {
  const segment = node.containerPath.find((candidate) => candidate.kind === "table");
  if (segment === undefined || segment.kind !== "table") return null;
  return `${frameOf(node) ?? ""}::${segment.headers.join("")}`;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replaceAll(/\s+/gu, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}${ELLIPSIS}`;
}
