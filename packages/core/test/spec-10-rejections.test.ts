// The other half of unit 2's acceptance criterion: every rejection case in SPEC section 10 has a
// failing fixture.
//
// The test does two things that a list of assertions would not. It asserts that every one of the
// numbered checks HAS a fixture, so a check cannot be quietly dropped; and it asserts that the
// linker-owned fixtures still PARSE, which is the load-bearing claim about where the boundary
// between a validator and a linker actually falls. A "linker" case that the schema happened to
// refuse would mean the boundary was drawn in the wrong place, and this test would say so.

import { describe, expect, it } from "vitest";
import { LINK_CHECK_COUNT } from "../src/index.js";
import {
  SPEC_10_REJECTIONS,
  buildRejection,
  documentIsRefused,
} from "./fixtures/spec-10-rejections.js";

describe("SPEC section 10", () => {
  it("has a fixture for every numbered check", () => {
    const covered = [...new Set(SPEC_10_REJECTIONS.map((c) => c.check))].sort((a, b) => a - b);
    expect(covered).toEqual(Array.from({ length: LINK_CHECK_COUNT }, (_, i) => i + 1));
  });

  const schemaOwned = SPEC_10_REJECTIONS.filter((c) => c.refusedBy !== "linker");
  const linkerOwned = SPEC_10_REJECTIONS.filter((c) => c.refusedBy === "linker");

  describe("checks the schema owns outright", () => {
    for (const c of schemaOwned) {
      it(`${c.check}: ${c.what}`, () => {
        expect(documentIsRefused(c, buildRejection(c))).toBe(true);
      });
    }
  });

  describe("checks that genuinely need a second document", () => {
    for (const c of linkerOwned) {
      it(`${c.check}: ${c.what} - needs ${c.needs}`, () => {
        // Deliberately asserting the document is VALID. These fixtures are the linker's input, and
        // if the schema started refusing one of them the ownership note here would be wrong.
        expect(documentIsRefused(c, buildRejection(c))).toBe(false);
      });
    }
  });

  it("keeps most of section 10 inside the type system", () => {
    // Not a coverage metric with a number pulled from nowhere - a regression guard. If a later
    // change moves a check out of the schema and into a runtime scan, this fails and somebody has
    // to say why. The direction of travel should be toward the schema, never away from it.
    expect(schemaOwned.length).toBeGreaterThanOrEqual(19);
  });
});
