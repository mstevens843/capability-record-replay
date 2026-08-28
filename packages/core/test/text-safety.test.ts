// The refusal the whole design rests on, tested from both sides.
//
// Both sides matter equally here, and the second one more than is comfortable. A guard that refuses
// every string is trivially "safe" and completely useless: it would refuse `[Search]`, which is what
// a button looks like on a green screen, and the terminal surface would never record a single
// artifact. So each accept case below is a real value off one of the two fixture surfaces.

import { describe, expect, it } from "vitest";
import {
  SafeTextMatcherSchema,
  locatorShapeOf,
  piiShapeOf,
  unsafeTextReason,
} from "../src/index.js";

describe("locatorShapeOf", () => {
  it("refuses the things a model reaches for when it has just seen the markup", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["#ctl00_ctl32_g_9a1", "stylesheet-selector"],
      [".grid-row", "stylesheet-selector"],
      ["table.results td:nth-child(3) a", "stylesheet-selector"],
      ['input[name="memberId"]', "stylesheet-selector"],
      ["div > span", "stylesheet-selector"],
      ["a::after", "stylesheet-selector"],
      ["//table[@id='results']//a", "path-expression"],
      [".//tr[3]/td[2]", "path-expression"],
      ["ancestor::table", "path-expression"],
      ["contains(text(), 'Search')", "path-expression"],
      ["https://riverbend-cb.example.invalid/members/search", "url"],
      ["/members/12345/accounts", "url"],
      ["www.example.invalid/x", "url"],
      ["textbox:account-number", "node-id"],
      ["button:exit", "node-id"],
    ];
    for (const [value, shape] of cases) {
      expect(locatorShapeOf(value), `${value} should read as ${shape}`).toBe(shape);
    }
  });

  it("accepts the words that are actually on these screens", () => {
    const realLabels = [
      "Member ID",
      "Member ID:",
      "Search",
      "[Search]", // a green-screen button - bracket-only, no attribute test
      "Find Member",
      "No member found",
      "Share Balance",
      "Current Balance",
      "Account restricted - contact branch",
      "F3=Exit  F5=Search  F12=Cancel",
      "Balance > 0",
      "Savings / Share",
      "No member found for {memberId}",
      "Member Detail",
      "OK",
    ];
    for (const label of realLabels) {
      expect(locatorShapeOf(label), `${label} is a real label and must survive`).toBeNull();
    }
  });
});

describe("piiShapeOf", () => {
  it("refuses the shapes a detector must never be written with", () => {
    // All obviously synthetic, and none of them belongs in a document that gets committed,
    // approved, copied to every tenant, and read by a model.
    expect(piiShapeOf("No member found for 000-00-0000")).toBe("ssn");
    expect(piiShapeOf("Contact 800-555-0199")).toBe("phone");
    expect(piiShapeOf("Card 4000 0000 0000 0002 declined")).toBe("card-pan");
    expect(piiShapeOf("Account 000000000000 closed")).toBe("long-digit-run");
    expect(piiShapeOf("nobody@example.invalid")).toBe("email");
  });

  it("accepts short numbers, versions and dates that are not identifiers", () => {
    for (const value of [
      "Page 1 of 4",
      "Version 7.2.1",
      "2026-01-31",
      "Balance as of 12/31/2025",
      "Screen 04",
      "F12=Cancel",
    ]) {
      expect(piiShapeOf(value), `${value} must survive`).toBeNull();
    }
  });
});

describe("SafeTextMatcher", () => {
  const ok = (m: unknown) => SafeTextMatcherSchema.safeParse(m).success;

  it("guards every mode that carries free text", () => {
    expect(ok({ mode: "exact", value: "Member ID", normalize: "std.label@1" })).toBe(true);
    expect(ok({ mode: "exact", value: "#member-id", normalize: "std.label@1" })).toBe(false);
    expect(ok({ mode: "contains", value: "No member found", normalize: "std.text@1" })).toBe(true);
    expect(ok({ mode: "contains", value: "//div[@id='x']", normalize: "std.text@1" })).toBe(false);
    expect(
      ok({ mode: "template", value: "No member found for {memberId}", normalize: "std.text@1" }),
    ).toBe(true);
    expect(
      ok({ mode: "template", value: "No member found for 400123456", normalize: "std.text@1" }),
    ).toBe(false);
  });

  it("lets the token mode through untouched, because it carries no text at all", () => {
    // Not an oversight: the token form is the one the multi-tenant design wants authors to reach
    // for, and it is safe by construction - the words live in the tenant's vocabulary.
    expect(ok({ mode: "token", token: "member-id-field", normalize: "std.label@1" })).toBe(true);
  });
});

describe("unsafeTextReason", () => {
  it("says what to do instead, not just what is wrong", () => {
    expect(unsafeTextReason("#member-id")).toContain("its role and its visible name");
    expect(unsafeTextReason("member 400123456")).toContain("{memberId}");
    expect(unsafeTextReason("/members/search")).toContain("flow.routes");
    expect(unsafeTextReason("Member ID")).toBeNull();
  });
});
