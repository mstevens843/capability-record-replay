// A compact, LOSSLESS on-disk form for a `Grid`.
//
// SPEC section 4.8 makes a promise this codec is what keeps affordable: a production failure becomes
// a `classify()` unit test by saving the observation that produced it, with no reproduction step.
// On this surface the thing worth saving is one layer lower - the grid - because everything above
// it is a pure function.
//
// The naive form (one JSON object per cell) is 80 x 24 x six fields, and the spike's nine-grid
// corpus came to 1.28 MB. That is a file nobody reviews and a diff nobody reads. This form is two
// strings per row - the text, and one attribute digit per column - plus a sparse map for the cells
// that carry a non-default colour, which on a monochrome green screen is none of them. Same
// information, about 4 KB per grid, and a diff a person can actually read.
//
// LOSSLESS IS THE WHOLE POINT and it is asserted rather than claimed: `test/grid-codec.test.ts`
// round-trips every committed grid and compares cell by cell. A "compact" fixture format that
// quietly dropped an attribute would corrupt the detector's inputs and every assertion built on
// them would still be green.

import { BLANK_CELL, type Grid, type GridCell } from "./grid.js";

export interface EncodedGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cursor: readonly [number, number];
  /** One string per row, exactly `cols` characters. */
  readonly text: readonly string[];
  /** One string per row: a digit per column, bit 0 inverse, bit 1 bold, bit 2 underline. */
  readonly attrs: readonly string[];
  /** `"y,x": [fg, bg]` for the cells that are not at the terminal default. Usually absent. */
  readonly colors?: Readonly<Record<string, readonly [number, number]>>;
}

const attrDigit = (cell: GridCell): string =>
  String((cell.inverse ? 1 : 0) | (cell.bold ? 2 : 0) | (cell.underline ? 4 : 0));

export function encodeGrid(grid: Grid): EncodedGrid {
  const text: string[] = [];
  const attrs: string[] = [];
  const colors: Record<string, readonly [number, number]> = {};
  for (let y = 0; y < grid.rows; y++) {
    let line = "";
    let attr = "";
    for (let x = 0; x < grid.cols; x++) {
      const cell = grid.cells[y]?.[x] ?? BLANK_CELL;
      line += cell.ch;
      attr += attrDigit(cell);
      if (cell.fg !== -1 || cell.bg !== -1) colors[`${y},${x}`] = [cell.fg, cell.bg];
    }
    text.push(line);
    attrs.push(attr);
  }
  const encoded: EncodedGrid = {
    cols: grid.cols,
    rows: grid.rows,
    cursor: [grid.cursor.x, grid.cursor.y],
    text,
    attrs,
  };
  return Object.keys(colors).length === 0 ? encoded : { ...encoded, colors };
}

export function decodeGrid(encoded: EncodedGrid): Grid {
  const cells: GridCell[][] = [];
  for (let y = 0; y < encoded.rows; y++) {
    const line = encoded.text[y] ?? "";
    const attr = encoded.attrs[y] ?? "";
    const row: GridCell[] = [];
    for (let x = 0; x < encoded.cols; x++) {
      const bits = Number.parseInt(attr[x] ?? "0", 10);
      const color = encoded.colors?.[`${y},${x}`];
      row.push({
        ch: line[x] ?? " ",
        inverse: (bits & 1) !== 0,
        bold: (bits & 2) !== 0,
        underline: (bits & 4) !== 0,
        fg: color?.[0] ?? -1,
        bg: color?.[1] ?? -1,
      });
    }
    cells.push(row);
  }
  return {
    cols: encoded.cols,
    rows: encoded.rows,
    cells,
    cursor: { x: encoded.cursor[0], y: encoded.cursor[1] },
  };
}

/** A named corpus of frozen grids, as committed to `test/fixtures/`. */
export type GridCorpus = Readonly<Record<string, EncodedGrid>>;

export const decodeCorpus = (corpus: GridCorpus): Readonly<Record<string, Grid>> =>
  Object.fromEntries(Object.entries(corpus).map(([name, grid]) => [name, decodeGrid(grid)]));
