// The character grid: this surface's entire perceptual input.
//
// A `Grid` is plain, frozen, serializable data - no terminal handle, no emulator, no clock. That is
// not tidiness, it is the property the rest of the package is built on: `detect()` is a PURE
// function of a `Grid`, so every assertion about what this driver sees can be written against a
// JSON file with nothing running. It is the same property the browser driver's accessibility-tree
// normalizer has, reached by a completely different road, and it is why a production misread here
// becomes a unit test by saving one file.
//
// Note what a cell carries and what it does not. There is no font, no colour name, no "is a field"
// flag. There are five attributes and a character, because that is all a VT screen has - and the
// detector must derive everything else from them, or it is not a driver for a surface with no clean
// DOM, it is a driver for a surface we secretly annotated.

/** One character cell. `fg`/`bg` are xterm's palette indices, or -1 for the terminal default. */
export interface GridCell {
  readonly ch: string;
  readonly inverse: boolean;
  readonly bold: boolean;
  readonly underline: boolean;
  readonly fg: number;
  readonly bg: number;
}

/** The hardware cursor: on a character surface, the ONLY signal there is about focus. */
export interface GridCursor {
  readonly x: number;
  readonly y: number;
}

export interface Grid {
  readonly cols: number;
  readonly rows: number;
  /** Row-major, `rows` entries of `cols` cells. */
  readonly cells: readonly (readonly GridCell[])[];
  readonly cursor: GridCursor;
}

/** What an unwritten cell looks like. Returned rather than `undefined` so every read is total. */
export const BLANK_CELL: GridCell = Object.freeze({
  ch: " ",
  inverse: false,
  bold: false,
  underline: false,
  fg: -1,
  bg: -1,
});

/** Total cell access. Out of bounds is blank, never a throw: a torn frame is a normal input here. */
export function cellAt(grid: Grid, y: number, x: number): GridCell {
  return grid.cells[y]?.[x] ?? BLANK_CELL;
}

/** The attribute signature a run is segmented on. Any change here changes what a "run" is. */
export function attributeKey(cell: GridCell): string {
  return `${cell.inverse ? 1 : 0}${cell.bold ? 1 : 0}${cell.underline ? 1 : 0}:${cell.fg}:${cell.bg}`;
}

/** One row as text, always exactly `cols` characters long. */
export function rowText(grid: Grid, y: number): string {
  const row = grid.cells[y];
  if (row === undefined) return " ".repeat(grid.cols);
  let out = "";
  for (let x = 0; x < grid.cols; x++) out += row[x]?.ch ?? " ";
  return out;
}

/**
 * Label text, folded the way a person reads it: collapse runs of whitespace, drop the punctuation a
 * green screen decorates a prompt with. `Account Number:` and `Account  Number :` are the same
 * label, and a driver that disagreed would make the two tenants of one vendor product look like two
 * different applications.
 */
export function cleanLabel(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[\s:._>-]+|[\s:._>-]+$/g, "")
    .trim();
}

/**
 * The grid as text, one row per line, trailing blanks kept.
 *
 * This is what `capture()` returns for the `text-grid` format - this surface's screenshot. Nothing
 * in the decision path is allowed to read it (SPEC section 2.2), and keeping the dump on `capture`
 * rather than on `perceive` is what makes that enforceable instead of aspirational.
 */
export function renderGridText(grid: Grid): string {
  const lines: string[] = [];
  for (let y = 0; y < grid.rows; y++) lines.push(rowText(grid, y));
  return `${lines.join("\n")}\n`;
}

/** A deep, frozen copy. Used when a grid is about to be stored or compared. */
export function freezeGrid(grid: Grid): Grid {
  return Object.freeze({
    cols: grid.cols,
    rows: grid.rows,
    cursor: Object.freeze({ x: grid.cursor.x, y: grid.cursor.y }),
    cells: Object.freeze(
      grid.cells.map((row) => Object.freeze(row.map((cell) => Object.freeze({ ...cell })))),
    ),
  });
}
