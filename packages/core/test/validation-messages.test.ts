// `explainIssues`, and the one construct that makes it necessary.
//
// Three arms of `Predicate` are keyed by the presence of a field rather than by a discriminant, so
// the predicate language has to be a plain union - and a plain union reports "Invalid input" at the
// whole predicate while burying the real complaint several levels down in the candidate branches.
// In this schema the buried complaint is frequently the one that says a detector was written with a
// member number in it, which is not a message anyone can afford to lose.

import { describe, expect, it } from "vitest";
import { PredicateSchema, explainIssues, safeParseArtifact } from "../src/index.js";
import { SPEC_10_REJECTIONS, buildRejection } from "./fixtures/spec-10-rejections.js";

describe("explainIssues", () => {
  it("reaches the real message inside a union", () => {
    const badDetector = SPEC_10_REJECTIONS.find((c) => c.check === 14);
    if (badDetector === undefined) throw new Error("missing fixture");
    const parsed = safeParseArtifact(buildRejection(badDetector));
    if (parsed.success) throw new Error("expected a refusal");

    const explained = explainIssues(parsed.error.issues);
    expect(explained[0]?.path).toBe("flow.steps.2.outcomes.0.detect.text");
    expect(explained[0]?.message).toContain("long run of digits");
  });

  it("picks the branch the author clearly meant", () => {
    // `{ kind: "count", ... }` is unmistakably the count arm even when its `op` is wrong. Reporting
    // "expected array" from the `all` arm instead would be technically true and useless.
    const parsed = PredicateSchema.safeParse({
      kind: "count",
      where: { role: "row" },
      op: "approximately",
      n: 1,
    });
    if (parsed.success) throw new Error("expected a refusal");
    const explained = explainIssues(parsed.error.issues);
    expect(explained.map((e) => e.path)).toContain("op");
  });

  it("leaves a non-union failure exactly as it found it", () => {
    const parsed = PredicateSchema.safeParse({ kind: "count", where: { role: "row" }, op: "eq" });
    if (parsed.success) throw new Error("expected a refusal");
    expect(explainIssues(parsed.error.issues).some((e) => e.path === "n")).toBe(true);
  });
});
