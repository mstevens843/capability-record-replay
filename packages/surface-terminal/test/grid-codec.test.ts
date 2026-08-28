// The committed corpus is compressed. This file is why that is allowed.
//
// A fixture format that quietly dropped an attribute would corrupt the detector's inputs and every
// assertion built on them would still be green - the worst kind of test failure, the one that never
// happens. So the codec is round-tripped over every grid in the corpus, cell by cell, and the
// discrimination cases below prove the comparison can actually fail.

import { describe, expect, it } from "vitest";
import { decodeGrid, encodeGrid } from "../src/grid-codec.js";
import {
  BLANK_CELL,
  type Grid,
  attributeKey,
  cleanLabel,
  renderGridText,
  rowText,
} from "../src/grid.js";
import { GRIDS, RAW_CORPUS } from "./support/corpus.js";

describe("the grid codec is lossless over the whole committed corpus", () => {
  it("round-trips every grid cell for cell", () => {
    for (const [name, grid] of Object.entries(GRIDS)) {
      const again = decodeGrid(encodeGrid(grid));
      expect(again, name).toEqual(grid);
    }
  });

  it("re-encodes to the exact bytes on disk", () => {
    for (const [name, grid] of Object.entries(GRIDS)) {
      expect(encodeGrid(grid), name).toEqual(RAW_CORPUS[name]);
    }
  });

  it("preserves the cursor, which is this surface's only focus signal", () => {
    for (const [name, grid] of Object.entries(GRIDS)) {
      expect(decodeGrid(encodeGrid(grid)).cursor, name).toEqual(grid.cursor);
    }
  });
});

describe("the round-trip comparison can fail - proved, not assumed", () => {
  const base = (): Grid => ({
    cols: 2,
    rows: 1,
    cursor: { x: 0, y: 0 },
    cells: [
      [
        { ...BLANK_CELL, ch: "A", inverse: true },
        { ...BLANK_CELL, ch: "B", bold: true },
      ],
    ],
  });

  it("notices a dropped inverse bit", () => {
    const grid = base();
    const encoded = encodeGrid(grid);
    const broken = { ...encoded, attrs: ["02"] };
    expect(decodeGrid(broken)).not.toEqual(grid);
  });

  it("notices a changed character", () => {
    const grid = base();
    const broken = { ...encodeGrid(grid), text: ["AC"] };
    expect(decodeGrid(broken)).not.toEqual(grid);
  });

  it("carries a non-default colour through the sparse map", () => {
    const coloured: Grid = {
      ...base(),
      cells: [[{ ...BLANK_CELL, ch: "A", fg: 2, bg: 7 }, BLANK_CELL]],
    };
    const encoded = encodeGrid(coloured);
    expect(encoded.colors).toEqual({ "0,0": [2, 7] });
    expect(decodeGrid(encoded)).toEqual(coloured);
  });

  it("omits the colour map entirely on a monochrome screen", () => {
    expect(encodeGrid(base()).colors).toBeUndefined();
  });
});

describe("the grid helpers", () => {
  it("reads a row as exactly `cols` characters", () => {
    const grid = GRIDS.initial as Grid;
    expect(rowText(grid, 0)).toHaveLength(80);
    expect(rowText(grid, 0).trim()).toContain("RIVERBEND CU");
  });

  it("returns a blank cell out of bounds rather than throwing", () => {
    expect(rowText(GRIDS.initial as Grid, 999).trim()).toBe("");
  });

  it("segments on the attribute signature, not on the character", () => {
    expect(attributeKey({ ...BLANK_CELL, ch: "A" })).toBe(attributeKey({ ...BLANK_CELL, ch: "B" }));
    expect(attributeKey({ ...BLANK_CELL, inverse: true })).not.toBe(attributeKey(BLANK_CELL));
  });

  it("folds a prompt the way a person reads it", () => {
    expect(cleanLabel("  Account  Number :  ")).toBe("Account Number");
    expect(cleanLabel("Acct #:")).toBe("Acct #");
  });

  it("dumps the grid as 24 lines of 80 characters", () => {
    const text = renderGridText(GRIDS.initial as Grid);
    const lines = text.split("\n").slice(0, 24);
    expect(lines).toHaveLength(24);
    for (const line of lines) expect(line).toHaveLength(80);
  });
});
