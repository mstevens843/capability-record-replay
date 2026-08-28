import { RoleSchema } from "@crr/core";
import { describe, expect, it } from "vitest";
import { ARIA_ROLE_MAP, BROWSER_SUPPORTED_ROLES, normalizeRole } from "../src/roles.js";

describe("normalizeRole", () => {
  it("refuses every Chromium-internal role, whatever it is spelled", () => {
    for (const internal of [
      "RootWebArea",
      "LayoutTable",
      "LayoutTableRow",
      "LayoutTableCell",
      "StaticText",
      "InlineTextBox",
      "LineBreak",
      "Iframe",
    ]) {
      expect(normalizeRole("internalRole", internal)).toBeNull();
    }
  });

  it("refuses an internal role even when it shares a spelling with an ARIA one", () => {
    // The type is checked BEFORE the table, which is what makes driver rule D2 total rather than a
    // list of names somebody has to keep complete.
    expect(normalizeRole("internalRole", "table")).toBeNull();
    expect(normalizeRole("role", "table")).toBe("table");
  });

  it("refuses an ARIA role outside the closed vocabulary", () => {
    for (const structural of ["generic", "none", "presentation", "paragraph", "menuitem"]) {
      expect(normalizeRole("role", structural)).toBeNull();
    }
  });

  it("has no mapping onto `text`, and that is deliberate", () => {
    // A run of page text is the internal role `StaticText`, so this driver never emits `text`. It is
    // not lost information: such a node keeps its `name` and its `text`, and `text-present` scans
    // both on every node. What is given up is making a text run an action target.
    expect(BROWSER_SUPPORTED_ROLES).not.toContain("text");
  });
});

describe("the role table", () => {
  it("maps only onto roles that exist in the cross-surface vocabulary", () => {
    for (const role of Object.values(ARIA_ROLE_MAP)) {
      expect(() => RoleSchema.parse(role)).not.toThrow();
    }
  });

  it("advertises exactly the roles it can produce, sorted and de-duplicated", () => {
    // Derived rather than declared: adding a row to the table updates the capability, so the
    // linker's load-time refusal is checked against what the driver really emits.
    const expected = [...new Set(Object.values(ARIA_ROLE_MAP))].sort();
    expect([...BROWSER_SUPPORTED_ROLES]).toEqual(expected);
  });
});
