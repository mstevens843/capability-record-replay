// Targets and the quorum.
//
// The tests worth reading here are the ones about EVIDENCE SOURCES. A target with three descriptors
// that all read the same label is a target with one opinion wearing three hats: when the vendor
// renames that label all three fail together, the "quorum" never fires, and the resolver reports
// "not found" for something plainly on screen. Counting sources rather than descriptors is the only
// thing that makes the agreement check mean anything, and it is cheap to get subtly wrong.

import { describe, expect, it } from "vitest";
import {
  type ContainerMatcher,
  DESCRIPTOR_EVIDENCE_SOURCE,
  DESCRIPTOR_RANK,
  type Descriptor,
  DescriptorSchema,
  type LabelToken,
  TargetRefSchema,
  type TextMatcher,
  bestRank,
} from "../src/index.js";

const token = (t: string): TextMatcher => ({
  mode: "token",
  token: t as LabelToken,
  normalize: "std.label@1",
});

const scope: ContainerMatcher = {
  path: [
    { kind: "frame", name: { mode: "exact", value: "content", normalize: "std.text@1" } },
    { kind: "landmark", role: "form", name: token("search-form") },
  ],
};

const byName: Descriptor = {
  id: "by-name",
  kind: "role-name",
  evidenceSource: "accessibleName",
  role: "textbox",
  name: token("member-id-field"),
};
const byLabel: Descriptor = {
  id: "by-label",
  kind: "label-anchored",
  evidenceSource: "labelText",
  label: token("member-id-field"),
  role: "textbox",
  relation: "right-of",
  maxDistance: { unit: "px", value: 300 },
};
const byPosition: Descriptor = {
  id: "by-position",
  kind: "ordinal-in-container",
  evidenceSource: "ordinal",
  container: scope,
  role: "textbox",
  index: 0,
};

const quorum = {
  min: 2,
  distinctEvidenceSources: 2,
  requireIdentical: true,
  onUnderQuorum: "fail",
  expectUnique: true,
} as const;

const target = (descriptors: readonly Descriptor[], overrides: Record<string, unknown> = {}) => ({
  scope,
  role: "textbox",
  descriptors,
  quorum,
  assert: { role: "textbox", enabled: true },
  recordedNode: {
    ariaRole: "textbox",
    name: "Member ID",
    containerPath: [{ kind: "frame", name: "content" }],
    tablePosition: null,
    boundsBucket: "px:16x4",
  },
  ...overrides,
});

describe("a target", () => {
  it("accepts two independently sourced descriptors", () => {
    expect(TargetRefSchema.safeParse(target([byName, byLabel])).success).toBe(true);
  });

  it("refuses a single descriptor, because nothing can disagree with one opinion", () => {
    expect(TargetRefSchema.safeParse(target([byName])).success).toBe(false);
  });

  it("refuses a quorum the declared descriptors cannot supply", () => {
    const threeDescriptorsTwoSources = target([byName, byLabel, byPosition], {
      quorum: { ...quorum, distinctEvidenceSources: 4 },
    });
    expect(TargetRefSchema.safeParse(threeDescriptorsTwoSources).success).toBe(false);
  });

  it("refuses a target whose best evidence is where the control SITS", () => {
    // Position is not an identity. A nav bar that gains one tab moves everything after it, and a
    // target that only knew the index would then click confidently on the wrong control.
    const alsoPositional: Descriptor = { ...byPosition, id: "by-position-2", index: 1 };
    const positionalOnly = target([byPosition, alsoPositional]);
    expect(TargetRefSchema.safeParse(positionalOnly).success).toBe(false);
  });

  it("refuses two descriptors that share an id, since an overlay disables by id", () => {
    expect(TargetRefSchema.safeParse(target([byName, { ...byLabel, id: "by-name" }])).success).toBe(
      false,
    );
  });

  it("refuses an assertion about a different kind of node than the one being resolved", () => {
    const mismatched = target([byName, byLabel], { assert: { role: "button", enabled: true } });
    expect(TargetRefSchema.safeParse(mismatched).success).toBe(false);
  });
});

describe("the quorum", () => {
  it("has no majority-vote mode and no first-match mode", () => {
    // Both are spelled as literals in the schema rather than as documentation, because both are
    // exactly the settings somebody reaches for at 4pm on a Friday when a flow will not resolve.
    for (const loosened of [
      { ...quorum, onUnderQuorum: "best-effort" },
      { ...quorum, requireIdentical: false },
      { ...quorum, expectUnique: false },
      { ...quorum, min: 1, distinctEvidenceSources: 1 },
    ]) {
      expect(
        TargetRefSchema.safeParse(target([byName, byLabel], { quorum: loosened })).success,
      ).toBe(false);
    }
  });
});

describe("descriptor kinds", () => {
  it("pins each kind to the evidence it is actually made of", () => {
    // A descriptor free to declare any source could manufacture independence that does not exist,
    // which would turn the quorum into decoration.
    expect(DescriptorSchema.safeParse({ ...byName, evidenceSource: "columnHeader" }).success).toBe(
      false,
    );
    for (const [kind, source] of Object.entries(DESCRIPTOR_EVIDENCE_SOURCE)) {
      expect(typeof DESCRIPTOR_RANK[kind as keyof typeof DESCRIPTOR_RANK]).toBe("number");
      expect(typeof source).toBe("string");
    }
  });

  it("keeps rank out of the artifact entirely", () => {
    // If rank were a field, a tenant overlay could promote positional targeting - in the one
    // document reviewed to a config file's standard.
    expect(DescriptorSchema.safeParse({ ...byName, rank: 1 }).success).toBe(false);
    expect(bestRank(["ordinal-in-container", "role-name"])).toBe(1);
    expect(bestRank([])).toBeNull();
  });

  it("makes a cycle of geometric anchors impossible by construction", () => {
    const geometric = {
      id: "by-geometry",
      kind: "geometric",
      evidenceSource: "geometry",
      anchor: byLabel,
      role: "button",
      direction: "right-of",
      maxDistance: { unit: "px", value: 240 },
    };
    expect(DescriptorSchema.safeParse(geometric).success).toBe(true);
    expect(DescriptorSchema.safeParse({ ...geometric, anchor: geometric }).success).toBe(false);
  });
});
