// `DetectedScreen` -> `Observation`. The place the character grid becomes the same thing a browser
// produces, and therefore the place the `Surface` port either holds or does not.
//
// This is the falsification test for the port, written out. Four things had to be true for the port
// to survive contact with an 80x24 grid, and each one is marked below where it is honoured:
//
//   [P1] A green screen has no URL, but it does have a LOCATION, and the two are not the same
//        question. The screen-id band is that location - SPEC section 2.2 calls it "this surface's
//        URL" in as many words - and it travels two ways: in `containerPath` as a `screen` segment,
//        and, when the caller has told this driver which system it is attached to, in `route` as a
//        canonicalized path (`routeOfScreen`). The driver still does not advertise `navigate`, so
//        linker check 17 refuses a program that needs to NAVIGATE before anything is spawned;
//        reporting where you are and being able to go somewhere by name are separate capabilities
//        and the port already separated them.
//
//        This started life as a flat `route: null`, which read as the honest answer and was not.
//        `@crr/core`'s policy chokepoint refuses EVERY action when the route is null - "act
//        somewhere I cannot name" has no safe reading - so a driver that reports null cannot
//        dispatch a keystroke through the interpreter. Unit 21 found that by running the two
//        together for the first time. See `routeOfScreen` for why the screen NUMBER, and not the
//        screen name, is the path.
//   [P2] An account list is a TABLE, not a list. Emitting `list`/`listitem` would have been the
//        literal reading of a green screen and would have made both `table-cell` targeting and
//        `readTable` extraction impossible - so the block becomes `table` + `row` + `cell` with a
//        real `tablePosition`, and the SAME descriptor that reads a balance in a browser reads it
//        here. `headerProvenance` is `first-row-heuristic` and honestly so: the header row is bold
//        text above a block, not a declared column header.
//   [P3] A prompt is a NODE. `label-anchored` resolves by geometry against a label node, so a
//        driver that only emitted the labelled control could not honour a descriptor kind it
//        advertises. The prompt text becomes a `text` node with its own bounds, and the labelled
//        control points at it through `labelledBy` - which also makes the quorum honest, because
//        `role-name` and `label-anchored` are then correctly counted as ONE source of evidence
//        rather than two.
//   [P4] Confidence is per node, not per surface. `capabilities().confidenceFloor` is 0.6 and sits
//        between "read off the screen" and "inferred from position" (see `detect.ts`), so a
//        descriptor resting on a guess abstains instead of voting.
//
// What did NOT fit is recorded in the package README rather than smoothed over here.

import {
  type ContainerSegment,
  type Key,
  type NodeId,
  type Observation,
  type Role,
  type RouteLocation,
  type Stability,
  type SurfaceKind,
  type UINode,
  skeletonDigestOf,
} from "@crr/core";
import type { DetectedBounds, DetectedNode, DetectedScreen } from "./detect.js";

/** What the driver needs to remember about a node in order to act on it later. */
export interface TerminalTarget {
  readonly node: UINode;
  readonly bounds: DetectedBounds;
  /** `field` can be typed into, `control` can be activated, `row` can be selected. */
  readonly kind: "field" | "control" | "row" | "static";
  /** For a control: the key its legend binds it to, already lowered onto the port's vocabulary. */
  readonly portKey: Key | null;
  /** For a row: its index within the table, so a selection can be walked to it. */
  readonly rowIndex: number | null;
  readonly capacity: number | null;
}

export interface TerminalObservation {
  readonly observation: Observation;
  readonly detected: DetectedScreen;
  readonly targets: ReadonlyMap<NodeId, TerminalTarget>;
}

export interface ObservationContext {
  readonly seq: number;
  readonly driver: string;
  readonly surfaceKind: SurfaceKind;
  readonly stability: Stability;
  /** Node ids whose value the driver blanked because a sensitive parameter was typed into them. */
  readonly maskedIds?: ReadonlySet<string>;
  /**
   * The symbolic name of the SYSTEM this grid belongs to, e.g. `corebank-green`.
   *
   * Deployment configuration, and it has to be: nothing in an 80x24 grid says which of a credit
   * union's LPARs the transport is attached to, and a driver that guessed would be inventing the
   * one half of a location that the allowlist exists to pin down. Absent, `route` is `null` and the
   * policy chokepoint will refuse every action - correctly, and loudly.
   */
  readonly originAlias?: string | null;
}

const boundsOf = (b: DetectedBounds) =>
  ({
    x: b.col0,
    y: b.row0,
    w: b.col1 - b.col0 + 1,
    h: b.row1 - b.row0 + 1,
    unit: "cell",
  }) as const;

const NEUTRAL_STATE = {
  disabled: false,
  focused: false,
  visible: true,
  checked: null,
  expanded: null,
  selected: null,
  required: null,
  invalid: null,
  readonly: null,
} as const;

interface NodeSeed {
  readonly id: string;
  readonly rawRole: string;
  readonly ariaRole: Role;
  readonly name: string;
  readonly value: string | null;
  readonly text: string | null;
  readonly state?: Partial<UINode["state"]>;
  readonly bounds: DetectedBounds;
  readonly containerPath: readonly ContainerSegment[];
  readonly parent?: string | null;
  readonly children?: readonly string[];
  readonly labelledBy?: readonly string[];
  readonly tablePosition?: UINode["tablePosition"];
  readonly capacity?: number | null;
  readonly confidence: number;
}

function toUINode(seed: NodeSeed, masked: boolean): UINode {
  return {
    id: seed.id as NodeId,
    rawRole: seed.rawRole,
    ariaRole: seed.ariaRole,
    name: seed.name,
    value: masked ? "" : seed.value,
    text: seed.text,
    description: null,
    state: { ...NEUTRAL_STATE, ...seed.state },
    bounds: boundsOf(seed.bounds),
    containerPath: seed.containerPath,
    parent: (seed.parent ?? null) as NodeId | null,
    children: (seed.children ?? []) as readonly NodeId[],
    labelledBy: (seed.labelledBy ?? []) as readonly NodeId[],
    tablePosition: seed.tablePosition ?? null,
    capacity: seed.capacity ?? null,
    confidence: seed.confidence,
    // Nothing on an inquiry screen repaints on its own. A clock in the branding band would be
    // `live: true` and would drop out of the skeleton digest; this fixture has none, and inventing
    // one to exercise the flag would be a fixture that lies.
    live: false,
    masked,
  };
}

/**
 * The screen-id band, lowered onto a canonicalized route path.
 *
 * `MEMBER INQUIRY 01` and `MBR INQ 01` are the SAME SCREEN at two credit unions running one vendor
 * product, and the half that is the same is the number. On a 3270 or a 5250 the trailing number is
 * the program id - it is what an operator dials and what a vendor's manual indexes - while the
 * words in front of it are branding, the same branding band the divergence report already excludes.
 * So the path is built from the number when there is one:
 *
 *   riverbend  "MEMBER INQUIRY 01" -> /screen/01
 *   summit     "MBR INQ 01"        -> /screen/01     <- one allowlist, one artifact, no overlay
 *
 * and from the whole band, slugged, when there is not - which is the conservative direction: two
 * unnumbered screens that really are different get different paths, and the allowlist sees both.
 *
 * A torn read has no band at all. That returns `null`, the policy chokepoint then refuses the
 * action, and refusing to act on a screen you cannot identify is the correct answer rather than an
 * inconvenience.
 */
export function routeOfScreen(
  screenId: string | null,
  originAlias: string | null | undefined,
): RouteLocation | null {
  if (screenId === null || originAlias === null || originAlias === undefined) return null;
  const trimmed = screenId.trim();
  if (trimmed === "") return null;
  const numbered = /^(.*\S)\s+(\d{1,4})$/.exec(trimmed);
  const tail = numbered !== null ? (numbered[2] as string) : SLUG(trimmed);
  return { originAlias, path: `/screen/${tail}`, query: {} };
}

const SLUG = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "anon";

/**
 * Build an `Observation` from one detected screen.
 *
 * Pure: it reads no clock, opens nothing and consults no terminal. Everything time-dependent
 * (`seq`, `stability`) arrives as an argument, which is what lets the whole mapping be asserted
 * against committed JSON grids.
 */
export function observationOf(
  screen: DetectedScreen,
  ctx: ObservationContext,
): TerminalObservation {
  const masked = ctx.maskedIds ?? new Set<string>();
  // [P1] The screen-id band is this surface's URL, and it lives in the container path. A torn read
  // leaves it null, the base path is then empty, and every scoped detector and checkpoint stops
  // matching - which is the whole reason the checkpoint is the readiness gate and quiescence is not.
  const base: readonly ContainerSegment[] =
    screen.screenId === null ? [] : [{ kind: "screen", id: screen.screenId.slice(0, 64) }];

  const seeds: NodeSeed[] = [];
  const targets = new Map<string, Omit<TerminalTarget, "node">>();
  const used = new Set<string>();
  /** Ids are per-observation, so uniqueness only has to hold here - but it has to hold. */
  const unique = (candidate: string): string => {
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    for (let n = 1; ; n++) {
      const next = `${candidate}#${n}`;
      if (used.has(next)) continue;
      used.add(next);
      return next;
    }
  };

  // [P3] Prompt labels become nodes, deduplicated by position: two fields under one heading share
  // an `above` anchor and must share one node, or `label-anchored` sees two identical labels and
  // correctly refuses as ambiguous.
  const labelIdByPosition = new Map<string, string>();
  for (const node of screen.nodes) {
    if (node.anchor.kind !== "label") continue;
    const key = `${node.anchor.bounds.row0}:${node.anchor.bounds.col0}:${node.anchor.bounds.col1}`;
    if (labelIdByPosition.has(key)) continue;
    const id = unique(`text:${SLUG(node.anchor.text)}`);
    labelIdByPosition.set(key, id);
    seeds.push({
      id,
      rawRole: "PromptLabel",
      ariaRole: "text",
      name: node.anchor.text,
      value: null,
      text: node.anchor.text,
      bounds: node.anchor.bounds,
      containerPath: base,
      confidence: node.confidence,
    });
    targets.set(id, {
      bounds: node.anchor.bounds,
      kind: "static",
      portKey: null,
      rowIndex: null,
      capacity: null,
    });
  }
  const labelIdFor = (node: DetectedNode): string | null =>
    node.anchor.kind === "label"
      ? (labelIdByPosition.get(
          `${node.anchor.bounds.row0}:${node.anchor.bounds.col0}:${node.anchor.bounds.col1}`,
        ) ?? null)
      : null;

  for (const node of screen.nodes) {
    switch (node.role) {
      case "heading":
        pushSimple(node, "heading", "BannerHeading");
        break;
      case "textbox": {
        const id = unique(node.id);
        const labelId = labelIdFor(node);
        seeds.push({
          id,
          rawRole: "ReverseVideoField",
          ariaRole: "textbox",
          name: node.name ?? "",
          value: node.value ?? "",
          text: null,
          state: { focused: node.state.focused },
          bounds: node.bounds,
          containerPath: base,
          labelledBy: labelId === null ? [] : [labelId],
          capacity: node.capacity,
          confidence: node.confidence,
        });
        targets.set(id, {
          bounds: node.bounds,
          kind: "field",
          portKey: null,
          rowIndex: null,
          capacity: node.capacity,
        });
        break;
      }
      case "button": {
        const id = unique(node.id);
        seeds.push({
          id,
          rawRole: "LegendControl",
          ariaRole: "button",
          name: node.name ?? "",
          value: null,
          text: node.name,
          bounds: node.bounds,
          containerPath: base,
          confidence: node.confidence,
        });
        // The lowering that makes one artifact run at both tenants: the node is `button:exit` on
        // each, and the key behind it is whatever this tenant's legend printed.
        targets.set(id, {
          bounds: node.bounds,
          kind: "control",
          portKey: node.portKey,
          rowIndex: null,
          capacity: null,
        });
        break;
      }
      case "status":
        pushSimple(node, "status", "StatusBand");
        break;
      case "text": {
        const id = unique(node.id);
        seeds.push({
          id,
          rawRole: "ReadOnlyValue",
          ariaRole: "text",
          name: node.name ?? "",
          value: node.value,
          text: node.value,
          bounds: node.bounds,
          containerPath: base,
          labelledBy: (() => {
            const labelId = labelIdFor(node);
            return labelId === null ? [] : [labelId];
          })(),
          confidence: node.confidence,
        });
        targets.set(id, {
          bounds: node.bounds,
          kind: "static",
          portKey: null,
          rowIndex: null,
          capacity: null,
        });
        break;
      }
      case "list":
        pushTable(node);
        break;
      case "listitem":
        // Rows only ever arrive as `children` of a list; a bare listitem is not something the
        // detector emits, and inventing a node for one would be a shape no fixture can produce.
        break;
    }
  }

  function pushSimple(node: DetectedNode, role: Role, rawRole: string): void {
    const id = unique(node.id);
    seeds.push({
      id,
      rawRole,
      ariaRole: role,
      name: node.name ?? "",
      value: node.value,
      text: node.value ?? node.name,
      bounds: node.bounds,
      containerPath: base,
      confidence: node.confidence,
    });
    targets.set(id, {
      bounds: node.bounds,
      kind: "static",
      portKey: null,
      rowIndex: null,
      capacity: null,
    });
  }

  // [P2] The account block becomes a real table.
  function pushTable(node: DetectedNode): void {
    const columns = node.columns ?? [];
    const rows = node.children ?? [];
    const tableId = unique(`table:${SLUG(node.name ?? columns.join(" ") ?? "grid")}`);
    const tablePath: readonly ContainerSegment[] = [
      ...base,
      { kind: "table", headers: columns.map((c) => c.slice(0, 128)) },
    ];
    const rowIds: string[] = [];
    const cellSeeds: NodeSeed[] = [];

    rows.forEach((row, rowIndex) => {
      const cells = row.cells ?? {};
      // The row key is the FIRST column's value - the account suffix here. Naming a row by its key
      // rather than by its position is the same rule `RowKey` enforces one layer up, and it is why
      // a row id stays meaningful when the selection moves.
      const firstColumn = columns[0];
      const rowKey = firstColumn !== undefined ? (cells[firstColumn] ?? "") : row.text;
      const rowId = unique(`row:${SLUG(rowKey === "" ? `row-${rowIndex}` : rowKey)}`);
      rowIds.push(rowId);
      const cellIds: string[] = [];
      columns.forEach((column, colIndex) => {
        const cellId = unique(`cell:${SLUG(`${rowKey} ${column}`)}`);
        cellIds.push(cellId);
        cellSeeds.push({
          id: cellId,
          rawRole: "GridCell",
          ariaRole: "cell",
          name: "",
          value: cells[column] ?? "",
          text: cells[column] ?? "",
          state: { selected: row.state.selected, focused: row.state.focused },
          bounds: row.bounds,
          containerPath: tablePath,
          parent: rowId,
          tablePosition: {
            rowIndex,
            colIndex,
            rowHeader: rowKey === "" ? null : rowKey,
            colHeader: column,
            // Honest: the header is a bold run above a block of aligned text. Nothing declared it.
            headerProvenance: "first-row-heuristic",
          },
          confidence: node.confidence,
        });
        targets.set(cellId, {
          bounds: row.bounds,
          kind: "static",
          portKey: null,
          rowIndex,
          capacity: null,
        });
      });
      seeds.push({
        id: rowId,
        rawRole: "GridRow",
        ariaRole: "row",
        name: "",
        value: null,
        text: row.text,
        state: { selected: row.state.selected, focused: row.state.focused },
        bounds: row.bounds,
        containerPath: tablePath,
        parent: tableId,
        children: cellIds,
        confidence: node.confidence,
      });
      targets.set(rowId, {
        bounds: row.bounds,
        kind: "row",
        portKey: null,
        rowIndex,
        capacity: null,
      });
    });

    seeds.push({
      id: tableId,
      rawRole: "GridTable",
      ariaRole: "table",
      name: node.name ?? "",
      value: null,
      text: null,
      bounds: node.bounds,
      containerPath: base,
      children: rowIds,
      confidence: node.confidence,
    });
    targets.set(tableId, {
      bounds: node.bounds,
      kind: "static",
      portKey: null,
      rowIndex: null,
      capacity: null,
    });
    seeds.push(...cellSeeds);
  }

  const nodes = seeds.map((seed) => toUINode(seed, masked.has(seed.id)));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const resolvedTargets = new Map<NodeId, TerminalTarget>();
  for (const [id, target] of targets) {
    const node = byId.get(id as NodeId);
    if (node !== undefined) resolvedTargets.set(id as NodeId, { ...target, node });
  }

  const observation: Observation = {
    seq: ctx.seq,
    surface: { kind: ctx.surfaceKind, driver: ctx.driver },
    // [P1] Where this grid is, canonicalized by the DRIVER before anything upstream sees it - which
    // is what the port asks of a driver and the reason `@crr/core` never parses a location. Null
    // when the caller named no system, and null on a torn read, because a screen with no id band is
    // a screen nobody can name.
    route: routeOfScreen(screen.screenId, ctx.originAlias),
    nodes,
    roots: nodes.filter((node) => node.parent === null).map((node) => node.id),
    skeletonDigest: skeletonDigestOf(nodes),
    stability: ctx.stability,
    // A green screen has no native dialog channel. An interstitial on this surface is a message
    // painted into the grid like everything else, so it arrives as an ordinary node and the
    // artifact's declared recovery handles it - which is the correct answer, not a missing feature.
    nativeDialog: null,
    inputIntercepted: false,
  };

  return { observation, detected: screen, targets: resolvedTargets };
}
