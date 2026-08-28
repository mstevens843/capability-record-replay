// Character grid -> typed structure. A PURE function of a frozen `Grid`.
//
// Ported from the terminal spike's `detect.mjs`, which shipped 31 assertions over frozen grids; the
// heuristic below is the same one, typed, with the confidence numbers and the port key lowering
// added. Where the spike guessed, this file says so in a `confidence` field rather than in a
// comment, because a quorum that cannot tell a read label from an inferred one is not a quorum.
//
// THE ONE RULE THAT IS NOT A HEURISTIC (driver rule D9): this file reports STRUCTURE and never
// business meaning. `*** NO MEMBER ON FILE FOR 77777` becomes `{ role: "status", value: "...",
// name: null }` and stops. Deciding that means MEMBER_NOT_FOUND belongs to the artifact's declared
// outcome detector, where it can be reviewed, versioned, diffed in a pull request and overridden
// per tenant. A detector that classified business meaning would have put the error taxonomy inside
// a driver, which is the one place in this system it can never be audited.
//
// The order below is the order it runs in, and step 5 is the one that is easy to get wrong:
//
//   1  segment each row into maximal runs of identical attributes
//   2  DERIVE which attribute means "plain" - never hardcode it
//   3  reverse video => writable field or selected row; bold/underline => emphasis
//   4  anchor each marked run to the nearest label left of it, else the text above it
//   5  a wide reverse run is a field OR a list row - decide STRUCTURALLY, never by width
//   6  focus is the hardware cursor, because a VT screen has no other focus signal
//   7  column boundaries come from the DATA's blank gutters, never from the header's width
//   8  the F-key legend becomes activatable controls
//   9  the bottom band is the screen id - this surface's URL
//  10  the status band is reported verbatim and never interpreted
//  11  ids are name-derived; a grid coordinate is this surface's CSS selector and is forbidden

import type { Key } from "@crr/core";
import { type Grid, type GridCell, attributeKey, cellAt, cleanLabel, rowText } from "./grid.js";

// ---------------------------------------------------------------------------------------------
// What a detection produces
// ---------------------------------------------------------------------------------------------

export type DetectedRole =
  | "heading"
  | "textbox"
  | "text"
  | "button"
  | "list"
  | "listitem"
  | "status";

export interface DetectedBounds {
  readonly row0: number;
  readonly row1: number;
  readonly col0: number;
  readonly col1: number;
}

/**
 * Where a node's accessible name came from.
 *
 * `bounds` is here because the label is a REAL THING ON THE SCREEN with a position, and the
 * `label-anchored` descriptor resolves by asking "which control is to the right of the label whose
 * text is X". Without the label's own extent that descriptor cannot be evaluated on this surface at
 * all, and the terminal driver would advertise a descriptor kind it cannot honour.
 */
export type DetectedAnchor =
  | {
      readonly kind: "label";
      readonly text: string;
      readonly at: "left" | "above";
      readonly bounds: DetectedBounds;
    }
  | { readonly kind: "none" };

export interface DetectedState {
  readonly focused: boolean;
  readonly selected: boolean | null;
  readonly empty: boolean | null;
}

export interface DetectedRow {
  readonly index: number;
  readonly text: string;
  /** Column name -> cell text, sliced on the block's blank gutters. `null` if no columns emerged. */
  readonly cells: Readonly<Record<string, string>> | null;
  readonly state: { readonly selected: boolean; readonly focused: boolean };
  readonly bounds: DetectedBounds;
}

export interface DetectedNode {
  readonly id: string;
  readonly role: DetectedRole;
  readonly name: string | null;
  readonly value: string | null;
  /** The legend token as the app printed it: `F3`, `ENTER`, `PF12`. Buttons only. */
  readonly key: string | null;
  /** The same control, lowered onto the port's key vocabulary. `null` if the port has no such key. */
  readonly portKey: Key | null;
  /** Declared field width in cells. This is where a typed parameter's `maxLength` comes from. */
  readonly capacity: number | null;
  readonly columns: readonly string[] | null;
  readonly children: readonly DetectedRow[] | null;
  readonly state: DetectedState;
  readonly anchor: DetectedAnchor;
  readonly bounds: DetectedBounds;
  /**
   * How much of this node was READ versus INFERRED, on the same 0..1 scale the browser driver
   * reports 1.0 on. A textbox with a label to its left is nearly certain; the same reverse-video
   * run with nothing anchoring it is a guess, and the difference has to survive as far as the
   * quorum check or the two will be counted as equal evidence.
   */
  readonly confidence: number;
}

export interface DetectedScreen {
  /** The bottom band, verbatim. `null` when the band is blank - which is what a torn read looks
   *  like, and is exactly the signal a checkpoint anchored on the screen id needs. */
  readonly screenId: string | null;
  readonly cursor: { readonly x: number; readonly y: number };
  readonly nodes: readonly DetectedNode[];
}

export interface DetectOptions {
  /** Rows at the top that are branding, not content. */
  readonly titleRows?: number;
  /** Rows at the bottom that are the status band plus the screen-id band. */
  readonly statusRows?: number;
  /** Minimum width at which a reverse run is even a CANDIDATE list row. */
  readonly wideCols?: number;
  /** How far left of a run a label may sit and still be its label. */
  readonly labelGap?: number;
}

// ---------------------------------------------------------------------------------------------
// Confidence: what was read, and what was guessed
// ---------------------------------------------------------------------------------------------

/**
 * These numbers are the driver's own account of its evidence, and the surface's `confidenceFloor`
 * (0.6) is set between the two clusters below on purpose: a control whose identity was READ off the
 * screen counts toward a descriptor quorum, and one whose identity was INFERRED from position does
 * not. A single number would have made "the reverse-video run at row 5" and "the field labelled
 * Account Number" the same quality of evidence, and the whole point of section 5 is that they are
 * not.
 */
export const CONFIDENCE = Object.freeze({
  /** `F3=Exit` - the application printed the control's name and its key. Nothing is inferred. */
  legendControl: 0.95,
  /** A field with a label immediately to its left: the layout convention every green screen uses. */
  labelledLeft: 0.9,
  /** The status band: positionally certain, and its text is read verbatim. */
  statusBand: 0.9,
  /** A `LABEL: value` pair in plain text - read, but the pairing is punctuation-based. */
  labelledPair: 0.8,
  /** A field labelled only by the text above it. Common, and wrong often enough to rank lower. */
  labelledAbove: 0.75,
  /** The branding band, split on runs of spaces. Real text, invented boundaries. */
  bannerHeading: 0.7,
  /** A list and its rows: structure inferred from a block of aligned text. */
  inferredList: 0.7,
  /** A marked run with nothing anchoring it. Below the floor, and deliberately so. */
  unanchored: 0.5,
} as const);

// ---------------------------------------------------------------------------------------------
// Step 1-2: runs, and what "plain" means on THIS screen
// ---------------------------------------------------------------------------------------------

interface Run {
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
  readonly w: number;
  readonly attr: GridCell;
  readonly text: string;
}

/** Maximal runs of identical attributes, row by row. A run is the atomic unit; nothing below this
 *  line ever looks at an individual cell again. */
function segmentRuns(grid: Grid): Run[] {
  const out: Run[] = [];
  for (let y = 0; y < grid.rows; y++) {
    const text = rowText(grid, y);
    let start = 0;
    for (let x = 1; x <= grid.cols; x++) {
      if (
        x === grid.cols ||
        attributeKey(cellAt(grid, y, x)) !== attributeKey(cellAt(grid, y, start))
      ) {
        out.push({
          y,
          x0: start,
          x1: x - 1,
          w: x - start,
          attr: cellAt(grid, y, start),
          text: text.slice(start, x),
        });
        start = x;
      }
    }
  }
  return out;
}

/**
 * "Plain" is the attribute covering the most cells, DERIVED and never hardcoded.
 *
 * An application that marks its fields with underline, or with a colour pair, instead of reverse
 * video needs no change here to be segmented correctly - only step 3's classification would need an
 * overlay hint. Hardcoding `inverse === false` would have made the segmenter itself tenant-specific.
 */
function plainAttributeKey(grid: Grid): string {
  const tally = new Map<string, number>();
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      const key = attributeKey(cellAt(grid, y, x));
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  let bestKey = "";
  let bestCount = -1;
  for (const [key, count] of tally) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  return bestKey;
}

// ---------------------------------------------------------------------------------------------
// Step 3: attribute semantics - the one VT convention this file assumes, stated openly
// ---------------------------------------------------------------------------------------------

/** Reverse video: an operator-writable field, or the selected row of a list. */
const isFieldAttr = (cell: GridCell): boolean => cell.inverse;
/** Bold or underline: emphasis - a column header, a screen title, a read-only value. */
const isEmphasisAttr = (cell: GridCell): boolean => !cell.inverse && (cell.bold || cell.underline);

// ---------------------------------------------------------------------------------------------
// Step 4: label anchoring
// ---------------------------------------------------------------------------------------------

interface Label {
  readonly text: string;
  readonly at: "left" | "above";
  readonly bounds: DetectedBounds;
}

function labelFor(grid: Grid, run: Run, gap: number): Label | null {
  const left = rowText(grid, run.y).slice(0, run.x0).replace(/\s+$/, "");
  if (left !== "" && run.x0 - left.length <= gap) {
    const m = /([A-Za-z][A-Za-z0-9 /#&'.-]*[:.]?)\s*$/.exec(left);
    const cleaned = m ? cleanLabel(m[1] ?? "") : "";
    if (m !== undefined && m !== null && cleaned !== "") {
      return {
        text: cleaned,
        at: "left",
        bounds: {
          row0: run.y,
          row1: run.y,
          col0: m.index,
          col1: m.index + (m[1] ?? "").length - 1,
        },
      };
    }
  }
  if (run.y > 0) {
    const above = rowText(grid, run.y - 1).slice(run.x0, run.x1 + 1);
    const cleaned = cleanLabel(above);
    if (cleaned !== "") {
      return {
        text: cleaned,
        at: "above",
        bounds: { row0: run.y - 1, row1: run.y - 1, col0: run.x0, col1: run.x1 },
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Step 8: the F-key legend
// ---------------------------------------------------------------------------------------------

/**
 * `F3=Exit`, `PF12=Cancel`, `ENTER=Open Suffix`.
 *
 * The name may contain single spaces but not double ones, which is why the legend line must
 * separate its entries with two or more. That is not a fixture convention we invented: it is how
 * every 3270 and VT legend line is laid out, because an operator reads them the same way.
 */
const legendPattern = () =>
  /\b(F\d{1,2}|PF\d{1,2}|ENTER|TAB|ESC|CLEAR)\s*=\s*([A-Za-z][A-Za-z/-]*(?: [A-Za-z/-]+)*)/g;

/**
 * The legend token, lowered onto the PORT's key vocabulary.
 *
 * This function is the whole reason F1-F12 live at the port and not in the artifact. `button:exit`
 * is the same node at both tenants of this vendor product; the key behind it is `F3` at one and
 * `F12` at the other. The program says what the operator MEANT; this says how that is done here.
 */
export function portKeyOf(legendToken: string): Key | null {
  const token = legendToken.toUpperCase();
  const fkey = /^P?F(\d{1,2})$/.exec(token);
  if (fkey) {
    const n = Number.parseInt(fkey[1] ?? "", 10);
    return n >= 1 && n <= 12 ? (`F${n}` as Key) : null;
  }
  switch (token) {
    case "ENTER":
      return "Enter";
    case "TAB":
      return "Tab";
    case "ESC":
      return "Escape";
    // CLEAR has no member in the port's key set. Reporting `null` is the honest answer, and the
    // linker refuses a program that needs a key this surface does not advertise (check 17) rather
    // than mapping it to something nearby and pressing the wrong thing.
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Step 7: columns from the DATA, not from the header
// ---------------------------------------------------------------------------------------------

interface Column {
  readonly name: string;
  readonly col0: number;
  readonly col1: number;
}

/**
 * Column spans, computed from the columns that are blank in EVERY row of the block.
 *
 * Slicing by the header's own width instead is the obvious implementation and it is wrong: a
 * right-aligned numeric column overflows its header, and the spike measured exactly that -
 * `BALANCE: "1,2"` before this function existed and `BALANCE: "1,204.55"` after it. On an account
 * list a truncated balance is not a cosmetic defect; it is a wrong number read to a member.
 */
function columnsFromBlock(
  grid: Grid,
  ys: readonly number[],
  x0: number,
  x1: number,
  headerY: number | null,
): Column[] | null {
  const blank: boolean[] = [];
  for (let x = x0; x <= x1; x++) blank.push(ys.every((y) => cellAt(grid, y, x).ch === " "));

  const spans: [number, number][] = [];
  let start: number | null = null;
  for (let i = 0; i < blank.length; i++) {
    // A gutter is two or more blank columns. One blank column is a space inside a value.
    const gutter = blank[i] === true && blank[i + 1] === true;
    if (!gutter && start === null) start = i;
    if (gutter && start !== null) {
      spans.push([x0 + start, x0 + i - 1]);
      start = null;
    }
  }
  if (start !== null) spans.push([x0 + start, x1]);

  const textOf = (y: number, a: number, b: number): string => {
    let out = "";
    for (let x = a; x <= b; x++) out += cellAt(grid, y, x).ch;
    return out;
  };
  const nonEmpty = spans.filter(([a, b]) => ys.some((y) => textOf(y, a, b).trim() !== ""));
  if (nonEmpty.length < 2) return null;

  return nonEmpty.map(([a, b], i) => {
    const name = headerY === null ? "" : textOf(headerY, a, b).trim();
    return { name: name === "" ? `col${i + 1}` : name, col0: a, col1: b };
  });
}

const sliceByColumns = (line: string, columns: readonly Column[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const column of columns) out[column.name] = line.slice(column.col0, column.col1 + 1).trim();
  return out;
};

// ---------------------------------------------------------------------------------------------
// Step 11: ids
// ---------------------------------------------------------------------------------------------

type Draft = Omit<DetectedNode, "id">;

const slugOf = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "anon";

/**
 * `textbox:account-number`, never `textbox:5,21`.
 *
 * A grid coordinate is this surface's CSS selector: it is stable exactly until somebody moves a
 * field, which the spike measured happening between two tenants of one vendor product. Coordinates
 * survive in `bounds`, where they are only ever the lowest-ranked descriptor at resolve time.
 */
function assignId(node: Draft, earlier: readonly Draft[], index: number): string {
  const identity = node.name ?? node.value ?? "anon";
  const base = `${node.role}:${slugOf(identity)}`;
  let duplicates = 0;
  for (let i = 0; i < index; i++) {
    const other = earlier[i];
    if (other === undefined) continue;
    if (other.role === node.role && (other.name ?? other.value ?? "anon") === identity) {
      duplicates += 1;
    }
  }
  return duplicates === 0 ? base : `${base}#${duplicates}`;
}

// ---------------------------------------------------------------------------------------------
// detect()
// ---------------------------------------------------------------------------------------------

export function detect(grid: Grid, options: DetectOptions = {}): DetectedScreen {
  const titleRows = options.titleRows ?? 1;
  const statusRows = options.statusRows ?? 2;
  const wide = options.wideCols ?? Math.max(24, Math.floor(grid.cols * 0.35));
  const labelGap = options.labelGap ?? 12;

  const plain = plainAttributeKey(grid);
  const all = segmentRuns(grid);
  const marked = all.filter((r) => attributeKey(r.attr) !== plain && r.w >= 2);
  const inBody = (r: Run): boolean => r.y >= titleRows && r.y < grid.rows - statusRows;
  const drafts: Draft[] = [];

  const boundsOf = (r: Run): DetectedBounds => ({ row0: r.y, row1: r.y, col0: r.x0, col1: r.x1 });
  // Inclusive of one column past the end, because the operator types AT the end of a field and the
  // cursor sits there. Off by one here and a filled field is never reported as focused.
  const cursorIn = (r: Run): boolean =>
    grid.cursor.y === r.y && grid.cursor.x >= r.x0 && grid.cursor.x <= r.x1 + 1;

  // --- step 9: screen identity, this surface's URL.
  let screenId: string | null = null;
  for (let y = grid.rows - 1; y >= grid.rows - statusRows; y--) {
    const text = rowText(grid, y).trim();
    if (text !== "") {
      screenId = text;
      break;
    }
  }

  // --- the branding band. Split on two-or-more spaces so one banner row yields separate headings.
  for (const run of all) {
    if (run.y >= titleRows || !isEmphasisAttr(run.attr)) continue;
    for (const segment of run.text.split(/\s{2,}/)) {
      const name = cleanLabel(segment);
      if (name === "") continue;
      drafts.push({
        role: "heading",
        name,
        value: null,
        key: null,
        portKey: null,
        capacity: null,
        columns: null,
        children: null,
        state: { focused: false, selected: null, empty: null },
        anchor: { kind: "none" },
        bounds: boundsOf(run),
        confidence: CONFIDENCE.bannerHeading,
      });
    }
  }

  const emphasisRuns = marked.filter((r) => inBody(r) && isEmphasisAttr(r.attr));

  // --- step 5. A wide reverse run is EITHER a wide input field OR the selected row of a list, and
  //     they look identical: a 28-column field and a 45-column selected row are both "wide reverse".
  //     Width alone gets `Name Search` wrong. Structure does not: a list row has no label to its
  //     left and has at least one sibling row of data at the same column extent.
  const siblingRows = (r: Run): number => {
    let n = 0;
    for (const dy of [-1, 1]) {
      const y = r.y + dy;
      if (y < titleRows || y >= grid.rows - statusRows) continue;
      if (
        rowText(grid, y)
          .slice(r.x0, r.x1 + 1)
          .trim() !== ""
      )
        n += 1;
    }
    return n;
  };
  const leftLabel = (r: Run) => {
    const label = labelFor(grid, r, labelGap);
    return label !== null && label.at === "left" ? label : null;
  };
  const looksLikeListRow = (r: Run): boolean =>
    r.w >= wide && leftLabel(r) === null && siblingRows(r) >= 1;

  const inverseRuns = marked.filter((r) => inBody(r) && isFieldAttr(r.attr));
  const selectionRuns = inverseRuns.filter(looksLikeListRow);
  const fieldRuns = inverseRuns.filter((r) => !looksLikeListRow(r));

  // --- input fields
  for (const run of fieldRuns) {
    const label = labelFor(grid, run, labelGap);
    drafts.push({
      role: "textbox",
      name: label?.text ?? null,
      value: run.text.trim(),
      key: null,
      portKey: null,
      // Capacity falls straight out of the grid: the run IS the field, so its width IS the field's
      // declared length. The browser surface has to work for this number.
      capacity: run.w,
      columns: null,
      children: null,
      state: { focused: cursorIn(run), selected: null, empty: run.text.trim() === "" },
      anchor: label
        ? { kind: "label", text: label.text, at: label.at, bounds: label.bounds }
        : { kind: "none" },
      bounds: boundsOf(run),
      confidence:
        label === null
          ? CONFIDENCE.unanchored
          : label.at === "left"
            ? CONFIDENCE.labelledLeft
            : CONFIDENCE.labelledAbove,
    });
  }

  // --- emphasised runs: a column header if a block of data hangs under it, otherwise a read-only
  //     value the app is asserting ("Member:  12345").
  const headerRows = new Set<number>();
  for (const run of emphasisRuns) {
    const below = run.y + 1 < grid.rows ? rowText(grid, run.y + 1).slice(run.x0, run.x1 + 1) : "";
    if (run.w >= wide && below.trim() !== "") {
      headerRows.add(run.y);
      continue;
    }
    const label = labelFor(grid, run, labelGap);
    drafts.push({
      role: "text",
      name: label?.text ?? null,
      value: run.text.trim(),
      key: null,
      portKey: null,
      capacity: null,
      columns: null,
      children: null,
      state: { focused: cursorIn(run), selected: null, empty: null },
      anchor: label
        ? { kind: "label", text: label.text, at: label.at, bounds: label.bounds }
        : { kind: "none" },
      bounds: boundsOf(run),
      confidence: label === null ? CONFIDENCE.unanchored : CONFIDENCE.labelledPair,
    });
  }

  // --- lists. The reverse-video run is the SELECTED row; its siblings are the contiguous rows above
  //     and below it at the same column extent, stopping at the header or at a blank row.
  for (const run of selectionRuns) {
    const ys: number[] = [run.y];
    for (let y = run.y - 1; y >= titleRows; y--) {
      if (
        headerRows.has(y) ||
        rowText(grid, y)
          .slice(run.x0, run.x1 + 1)
          .trim() === ""
      )
        break;
      ys.unshift(y);
    }
    for (let y = run.y + 1; y < grid.rows - statusRows; y++) {
      if (
        headerRows.has(y) ||
        rowText(grid, y)
          .slice(run.x0, run.x1 + 1)
          .trim() === ""
      )
        break;
      ys.push(y);
    }
    const headerY = (ys[0] ?? run.y) - 1;
    const headerRun = headerRows.has(headerY)
      ? emphasisRuns.find((e) => e.y === headerY)
      : undefined;
    const columns = columnsFromBlock(
      grid,
      headerRun ? [headerY, ...ys] : ys,
      run.x0,
      run.x1,
      headerRun ? headerY : null,
    );
    drafts.push({
      role: "list",
      name: headerRun ? cleanLabel(headerRun.text) : null,
      value: null,
      key: null,
      portKey: null,
      capacity: null,
      columns: columns?.map((c) => c.name) ?? null,
      children: ys.map((y, i) => ({
        index: i,
        text: rowText(grid, y)
          .slice(run.x0, run.x1 + 1)
          .trim(),
        cells: columns ? sliceByColumns(rowText(grid, y), columns) : null,
        state: { selected: y === run.y, focused: grid.cursor.y === y },
        bounds: { row0: y, row1: y, col0: run.x0, col1: run.x1 },
      })),
      state: { focused: false, selected: null, empty: null },
      anchor: { kind: "none" },
      bounds: {
        row0: ys[0] ?? run.y,
        row1: ys[ys.length - 1] ?? run.y,
        col0: run.x0,
        col1: run.x1,
      },
      confidence: CONFIDENCE.inferredList,
    });
  }

  // --- step 8: the legend -> activatable controls.
  for (const run of all) {
    if (!inBody(run)) continue;
    const pattern = legendPattern();
    let m = pattern.exec(run.text);
    while (m !== null) {
      const token = m[1] ?? "";
      drafts.push({
        role: "button",
        name: cleanLabel(m[2] ?? ""),
        value: null,
        key: token,
        portKey: portKeyOf(token),
        capacity: null,
        columns: null,
        children: null,
        state: { focused: false, selected: null, empty: null },
        anchor: { kind: "none" },
        bounds: {
          row0: run.y,
          row1: run.y,
          col0: run.x0 + m.index,
          col1: run.x0 + m.index + m[0].length - 1,
        },
        confidence: CONFIDENCE.legendControl,
      });
      m = pattern.exec(run.text);
    }
  }

  // --- plain-text `LABEL: value` pairs. Green screens print read-only values with no attribute at
  //     all often enough that an attribute-only detector would miss half of what is on the screen.
  const covered = (y: number, a: number, b: number): boolean =>
    drafts.some(
      (n) => n.bounds.row0 <= y && n.bounds.row1 >= y && !(n.bounds.col1 < a || n.bounds.col0 > b),
    );
  for (let y = titleRows; y < grid.rows - statusRows; y++) {
    const line = rowText(grid, y);
    // A value ends at a double space: on a fixed-width screen that is the gutter between two
    // fields, and consuming past it merges the next column into this value.
    const pattern = /([A-Za-z][A-Za-z0-9 /#&'.-]{1,28}):\s{1,10}(\S(?:[^\s]| (?! ))*)/g;
    let m = pattern.exec(line);
    while (m !== null) {
      const label = m[1] ?? "";
      const value = m[2] ?? "";
      const a = m.index + label.length + 1 + (m[0].length - label.length - 1 - value.length);
      const b = a + value.length - 1;
      if (!covered(y, a, b)) {
        drafts.push({
          role: "text",
          name: cleanLabel(label),
          value: value.trim(),
          key: null,
          portKey: null,
          capacity: null,
          columns: null,
          children: null,
          state: { focused: false, selected: null, empty: null },
          anchor: {
            kind: "label",
            text: cleanLabel(label),
            at: "left",
            bounds: { row0: y, row1: y, col0: m.index, col1: m.index + label.length - 1 },
          },
          bounds: { row0: y, row1: y, col0: a, col1: b },
          confidence: CONFIDENCE.labelledPair,
        });
      }
      m = pattern.exec(line);
    }
  }

  // --- step 10: the status band. TEXT ONLY. See driver rule D9 at the top of this file.
  for (let y = grid.rows - statusRows; y < grid.rows; y++) {
    const text = rowText(grid, y).trim();
    if (text === "" || text === screenId) continue;
    drafts.push({
      role: "status",
      name: null,
      value: text,
      key: null,
      portKey: null,
      capacity: null,
      columns: null,
      children: null,
      state: { focused: false, selected: null, empty: null },
      anchor: { kind: "none" },
      bounds: { row0: y, row1: y, col0: 0, col1: grid.cols - 1 },
      confidence: CONFIDENCE.statusBand,
    });
  }

  return {
    screenId,
    cursor: { x: grid.cursor.x, y: grid.cursor.y },
    nodes: drafts.map((draft, i) => ({ id: assignId(draft, drafts, i), ...draft })),
  };
}
