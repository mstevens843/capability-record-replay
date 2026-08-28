// Message quality for the section 10 checks the schema owns.
//
// A refusal that says "Invalid input" is a refusal somebody works around. These documents are
// authored by a model and reviewed by an operations person, and neither of them can act on a
// message that does not name the field and the mistake - so the message is part of the contract,
// not a nicety, and it is worth a test that fails when it regresses.

import { describe, expect, it } from "vitest";
import { explainValidationError, safeParseArtifact, safeParseOverlay } from "../src/index.js";
import { SPEC_10_REJECTIONS, buildRejection } from "./fixtures/spec-10-rejections.js";

const explain = (check: number): readonly string[] => {
  const c = SPEC_10_REJECTIONS.find((x) => x.check === check);
  if (c === undefined) throw new Error(`no fixture for check ${check}`);
  const doc = buildRejection(c);
  const parsed = c.document === "overlay" ? safeParseOverlay(doc) : safeParseArtifact(doc);
  if (parsed.success) throw new Error(`check ${check} was not refused`);
  return explainValidationError(parsed.error);
};

describe("a refused document explains itself", () => {
  const expectations: readonly (readonly [number, string, string])[] = [
    [5, "the step whose value cannot resolve", "does not run earlier"],
    [6, "the output written twice", "savingsBalance"],
    [9, "the priority that ties", "duplicate step submit-search outcome priority"],
    [10, "what the string looked like", "looks like a stylesheet selector"],
    [11, "why one descriptor is not enough", "descriptors"],
    [13, "what the steps actually add up to", "the steps add up to READ"],
    [14, "the fix, not just the refusal", "use a template hole"],
    [15, "the arithmetic behind the budget refusal", "remedy actions"],
    [18, "the depth limit by number", "deeper than 4 levels"],
    [19, "which resume point is missing", "not declared in flow.resumePoints"],
    [23, "which band the recovery is actually in", "is in band interception"],
    [24, "which extraction lacks bounds", "must declare row bounds"],
    [26, "the alias the policy does not permit", "does not permit"],
  ];

  for (const [check, what, needle] of expectations) {
    it(`check ${check} names ${what}`, () => {
      expect(explain(check).join("\n")).toContain(needle);
    });
  }

  it("names a path into the document, not just a complaint", () => {
    // The path is what turns a refusal into an edit. A model that regenerates the whole artifact
    // because it cannot tell which of four hundred lines was wrong is a model burning tokens on
    // our behalf.
    const [first] = explain(10);
    expect(first).toMatch(/^flow\.steps\.\d+\.target\.descriptors\.\d+\.name: /);
  });
});
