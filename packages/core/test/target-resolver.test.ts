// The target resolver, against frozen screens and nothing else running.
//
// The five cases SPEC section 11 unit 5 requires are here - resolve, not-found, ambiguous,
// underdetermined, assert-failed - and the one worth reading twice is
// "two descriptors that agree, on one piece of evidence". It is the case that looks safe from every
// angle a naive implementation can see: two descriptors resolved, they resolved to the SAME node,
// and they declare two different `EvidenceSource` values. A quorum that counts descriptors passes
// it. A quorum that counts DECLARED sources passes it too. It is still one label, and the day the
// vendor renames that label both descriptors die together and the "quorum" that was protecting the
// step never fires.
//
// The other thing these tests are careful about: every observation is either the shared corpus or a
// named, minimal edit of it. A screen invented to make a test pass proves nothing about a screen.

import { describe, expect, it } from "vitest";
import {
  MOCK_SURFACE_CAPABILITIES,
  type NodeId,
  type Observation,
  type ResolutionEvidence,
  type ResolvedBinding,
  type SurfaceCapabilities,
  type TargetCandidate,
  type TargetRef,
  TargetRefSchema,
  type UINode,
  describeDescriptor,
  fingerprintOf,
  isResolved,
  resolveTarget,
  skeletonDigestOf,
} from "../src/index.js";
import { CALLER_MEMBER_ID, bindings, program } from "./fixtures/classifier-screens.js";
import { IDS, results, searchForm, searching } from "./fixtures/corebank-observations.js";
import { memberLookupArtifact } from "./fixtures/member-lookup.js";

// ---------------------------------------------------------------------------------------------
// The real targets, taken out of the real artifact rather than written for the test
// ---------------------------------------------------------------------------------------------

function targetOf(stepId: string): TargetRef {
  const step = memberLookupArtifact.flow.steps.find((candidate) => candidate.id === stepId);
  if (step?.target === undefined || step.target === null) {
    throw new Error(`step ${stepId} has no target`);
  }
  return step.target;
}

const memberIdField = targetOf("enter-member-id");
const searchButton = targetOf("submit-search");
const selectRowLink = targetOf("open-member-row");

// ---------------------------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------------------------

interface ResolveOptions {
  readonly capabilities?: SurfaceCapabilities;
  readonly disabledDescriptors?: readonly string[];
  readonly bindings?: readonly ResolvedBinding[];
}

function resolve(target: TargetRef, observation: Observation, options: ResolveOptions = {}) {
  return resolveTarget({
    target,
    ctx: { observation, program, bindings: options.bindings ?? bindings },
    capabilities: options.capabilities ?? MOCK_SURFACE_CAPABILITIES,
    ...(options.disabledDescriptors === undefined
      ? {}
      : { disabledDescriptors: options.disabledDescriptors }),
  });
}

function withNodes(base: Observation, nodes: readonly UINode[]): Observation {
  return { ...base, nodes, skeletonDigest: skeletonDigestOf(nodes) };
}

function patch(base: Observation, id: string, change: Partial<UINode>): Observation {
  return withNodes(
    base,
    base.nodes.map((candidate) => (candidate.id === id ? { ...candidate, ...change } : candidate)),
  );
}

function insertBefore(base: Observation, id: string, extra: UINode): Observation {
  const nodes: UINode[] = [];
  for (const candidate of base.nodes) {
    if (candidate.id === id) nodes.push(extra);
    nodes.push(candidate);
  }
  return withNodes(base, nodes);
}

function nodeById(observation: Observation, id: string): UINode {
  const found = observation.nodes.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no ${id} in this observation`);
  return found;
}

function candidate(result: ResolutionEvidence, id: string): TargetCandidate {
  const row = result.candidates.find((entry) => entry.descriptorId === id);
  if (row === undefined) throw new Error(`no candidate row for ${id}`);
  return row;
}

/** The member-id field, cloned into a second control the base screen does not have. */
function clonedField(base: Observation, id: string, change: Partial<UINode>): UINode {
  return {
    ...nodeById(base, "textbox:member-id"),
    id: id as NodeId,
    labelledBy: [],
    value: "",
    ...change,
  };
}

// ---------------------------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------------------------

describe("resolution", () => {
  it("resolves the member id field on three descriptors and two independent sources", () => {
    const result = resolve(memberIdField, searchForm);

    expect(result.status).toBe("resolved");
    if (!isResolved(result)) return;
    expect(result.nodeId).toBe(IDS.memberIdField);
    expect(result.agreeingDescriptors).toEqual([
      "member-id-by-name",
      "member-id-by-label",
      "member-id-by-position",
    ]);
    // Three descriptors, three declared sources - and only two independent ones, because the
    // control's accessible name is computed from the very label the second descriptor anchors on.
    expect(result.declaredSources).toEqual(["accessibleName", "labelText", "ordinal"]);
    expect(result.independentSources).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it("resolves a button whose second opinion is geometric, anchored to a different label", () => {
    const result = resolve(searchButton, searchForm);

    expect(result.status).toBe("resolved");
    if (!isResolved(result)) return;
    expect(result.nodeId).toBe(IDS.searchButton);
    // The button's own name and the member-id label are two different pieces of screen text, so
    // these two really are independent even though one of them is anchored to the other's neighbour.
    expect(result.independentSources).toBe(2);
    expect(result.assertion.clauses.every((clause) => clause.verdict)).toBe(true);
  });

  it("resolves the row link by the caller's own member number", () => {
    const result = resolve(selectRowLink, resultsWithCellGeometry);

    expect(result.status).toBe("resolved");
    if (!isResolved(result)) return;
    expect(result.nodeId).toBe(IDS.selectLink);
    expect(result.declaredSources).toEqual(["columnHeader", "geometry"]);
    expect(result.independentSources).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Not found
// ---------------------------------------------------------------------------------------------

describe("not found", () => {
  it("refuses when the container the target lives in is not on the screen", () => {
    const result = resolve(memberIdField, results);

    expect(result.status).toBe("not-found");
    expect(result.status === "not-found" && result.failure).toBe("target-not-found");
    expect(result.status === "not-found" && result.reason).toContain(
      "the container it searches is not on this screen",
    );
    expect(result.candidates.map((row) => row.verdict)).toEqual([
      "abstained",
      "abstained",
      "abstained",
    ]);
  });

  it("discards a resolution the driver does not trust as far as this surface's floor", () => {
    // A synthesized role on a character grid, or a name read off a reverse-video run. The node is
    // there; the driver is telling us it is guessing, and a guess is not evidence.
    const unsure = patch(searchForm, "textbox:member-id", { confidence: 0.6 });
    const result = resolve(memberIdField, unsure, {
      capabilities: { ...MOCK_SURFACE_CAPABILITIES, confidenceFloor: 0.8 },
    });

    expect(result.status).toBe("not-found");
    expect(result.status === "not-found" && result.reason).toContain("below this surface's floor");
  });
});

// ---------------------------------------------------------------------------------------------
// Ambiguous
// ---------------------------------------------------------------------------------------------

describe("ambiguous", () => {
  // The tenant's form gained a Branch box ahead of the member number - which is exactly what the
  // summit overlay in the fixture exists to describe. Until somebody writes that overlay, the
  // ordinal descriptor is pointing at a different control from the other two.
  const withBranchField = insertBefore(
    searchForm,
    "textbox:member-id",
    clonedField(searchForm, "textbox:branch", {
      name: "Branch",
      bounds: { x: 24, y: 140, w: 120, h: 24, unit: "px" },
    }),
  );

  it("refuses to act when two descriptors name different controls", () => {
    const result = resolve(memberIdField, withBranchField);

    expect(result.status).toBe("ambiguous");
    expect(result.status === "ambiguous" && result.failure).toBe("target-ambiguous");
    expect(result.status === "ambiguous" && result.nodeId).toBeNull();
  });

  it("records every disagreeing descriptor and what it picked, so the split is readable", () => {
    const result = resolve(memberIdField, withBranchField);

    expect(candidate(result, "member-id-by-name").verdict).toBe("disagreed");
    expect(candidate(result, "member-id-by-name").nodeId).toBe(IDS.memberIdField);
    expect(candidate(result, "member-id-by-position").verdict).toBe("disagreed");
    expect(candidate(result, "member-id-by-position").nodeId).toBe("textbox:branch");
  });
});

// ---------------------------------------------------------------------------------------------
// Underdetermined - including the correlated case
// ---------------------------------------------------------------------------------------------

describe("underdetermined", () => {
  /**
   * THE SUBTLE ONE. The overlay disabled the positional descriptor, which leaves two that both
   * resolve, both resolve to the SAME node, and declare two different evidence sources.
   *
   * Every naive quorum passes this: two descriptors agreed, and `accessibleName` is not `labelText`.
   * It is still one piece of evidence - the accessible name of the field IS the text of the label
   * the other descriptor anchors on - and the day the vendor renames it, both descriptors abstain
   * together and nothing is left to notice.
   */
  it("refuses when two agreeing descriptors are reading the same label twice", () => {
    const result = resolve(memberIdField, searchForm, {
      disabledDescriptors: ["member-id-by-position"],
    });

    expect(result.status).toBe("underdetermined");
    expect(result.status === "underdetermined" && result.failure).toBe("target-underdetermined");

    // Everything a descriptor-counting or a declared-source-counting quorum would have looked at
    // says this was fine.
    const byName = candidate(result, "member-id-by-name");
    const byLabel = candidate(result, "member-id-by-label");
    expect(byName.verdict).toBe("resolved");
    expect(byLabel.verdict).toBe("resolved");
    expect(byName.nodeId).toBe(byLabel.nodeId);
    expect(new Set([byName.evidenceSource, byLabel.evidenceSource]).size).toBe(2);

    expect(result.status === "underdetermined" && result.reason).toContain(
      "1 independent piece(s) of evidence",
    );
  });

  it("names the overlay as the reason the third opinion is missing", () => {
    const result = resolve(memberIdField, searchForm, {
      disabledDescriptors: ["member-id-by-position"],
    });

    expect(candidate(result, "member-id-by-position").verdict).toBe("disabled");
    expect(result.warnings).toContainEqual({
      code: "descriptor-disabled-by-overlay",
      stepId: null,
      detail: "member-id-by-position (ordinal-in-container) is disabled for this tenant",
    });
  });

  it("refuses when a legacy grid gives the second descriptor no geometry to work with", () => {
    // The real corpus: the results grid carries no bounds on its cells, so the geometric descriptor
    // anchored to the member-id cell cannot speak at all. One descriptor is not a quorum, and the
    // run stops instead of clicking on the strength of a single opinion.
    const result = resolve(selectRowLink, results);

    expect(result.status).toBe("underdetermined");
    expect(result.status === "underdetermined" && result.reason).toBe(
      "1 of the 2 required descriptors resolved",
    );
    expect(candidate(result, "select-by-row-key").verdict).toBe("resolved");
    expect(candidate(result, "select-right-of-member-cell").verdict).toBe("abstained");
  });

  it("refuses when the surface cannot resolve the kind the second descriptor needs", () => {
    const noGeometry: SurfaceCapabilities = {
      ...MOCK_SURFACE_CAPABILITIES,
      resolvableDescriptors: ["role-name", "label-anchored", "table-cell", "ordinal-in-container"],
    };
    const result = resolve(searchButton, searchForm, { capabilities: noGeometry });

    expect(result.status).toBe("underdetermined");
    expect(candidate(result, "search-right-of-member-id").verdict).toBe("abstained");
  });
});

// ---------------------------------------------------------------------------------------------
// The assertion (control C1)
// ---------------------------------------------------------------------------------------------

describe("the pre-act assertion", () => {
  it("stops on a control that is present, agreed, and dead", () => {
    // The search screen mid-submit: the button is still there, both descriptors still find it, and
    // it is disabled. Resolution succeeded; acting would not have.
    const result = resolve(searchButton, searching);

    expect(result.status).toBe("assert-failed");
    if (result.status === "resolved") return;
    expect(result.failure).toBe("target-assert-failed");
    expect(result.nodeId).toBe(IDS.searchButton);
    expect(result.assertion?.clauses).toContainEqual({ rendered: "is enabled", verdict: false });
    expect(result.reason).toContain("is enabled");
  });

  it("stops on the right control in the wrong member's row", () => {
    // Case W1. Both descriptors agree on a Select link, and the row it sits in belongs to somebody
    // else. Nothing about the link itself is wrong - only its row is - and `rowKeyEquals` is the
    // one control that can tell.
    const otherMember: ResolvedBinding = { ...CALLER_MEMBER_ID, value: "59999" };
    const result = resolve(selectLinkByNameAndPosition, resultsWithCellGeometry, {
      bindings: [otherMember],
    });

    expect(result.status).toBe("assert-failed");
    if (result.status === "resolved") return;
    expect(result.nodeId).toBe(IDS.selectLink);
    expect(result.assertion?.clauses.at(-1)).toEqual({
      rendered: "sits in the row whose <member-column> is param.memberId",
      verdict: false,
    });
  });

  it("never writes the caller's value into anything it produces", () => {
    const otherMember: ResolvedBinding = { ...CALLER_MEMBER_ID, value: "59999" };
    const result = resolve(selectLinkByNameAndPosition, resultsWithCellGeometry, {
      bindings: [otherMember],
    });

    // The refusal is about member 59999 and says so nowhere: a value renders by NAME. Two runs are
    // told apart by their run id, not by the number the member read off their card.
    expect(JSON.stringify(result)).not.toContain("59999");
  });
});

// ---------------------------------------------------------------------------------------------
// Synonyms, warnings and fingerprints
// ---------------------------------------------------------------------------------------------

describe("vocabulary synonyms", () => {
  it("abstains when two spellings of one token name two different controls", () => {
    // `member-id-field` is declared as ["Member ID", "Member Number"] and this tenant renders both.
    // Two synonyms resolving DIFFERENT nodes is an ambiguity, not a preference for the first.
    const twoSpellings = withNodes(searchForm, [
      ...searchForm.nodes,
      clonedField(searchForm, "textbox:member-number", {
        name: "Member Number",
        bounds: { x: 112, y: 140, w: 160, h: 24, unit: "px" },
      }),
    ]);
    const result = resolve(memberIdField, twoSpellings);

    expect(candidate(result, "member-id-by-name").verdict).toBe("non-unique");
    // The other two still agree on the original field, on two independent sources, so the step is
    // allowed to proceed - with the thinning margin recorded rather than swallowed.
    expect(result.status).toBe("resolved");
    expect(result.warnings).toContainEqual({
      code: "descriptor-abstaining",
      stepId: null,
      detail: "member-id-by-name matched 2 nodes and abstained",
    });
  });
});

describe("fingerprints", () => {
  it("describes a control the way a person would recognise it again", () => {
    expect(fingerprintOf(nodeById(searchForm, IDS.memberIdField))).toEqual({
      ariaRole: "textbox",
      name: "Member ID",
      containerPath: [
        { kind: "frame", name: "content" },
        { kind: "landmark", role: "form", name: "Member Search" },
      ],
      tablePosition: null,
      boundsBucket: "px:20x3",
    });
  });

  it("takes a link's table position from the cell it sits in", () => {
    const link = nodeById(results, IDS.selectLink);
    expect(fingerprintOf(link)?.tablePosition).toBeNull();
    expect(fingerprintOf(link, results.nodes)?.tablePosition).toEqual({
      rowHeader: null,
      colHeader: "Actions",
    });
  });

  it("has no fingerprint for a structural node, which can never be a target", () => {
    expect(fingerprintOf(nodeById(searchForm, "layouttable:page"))).toBeNull();
  });
});

describe("prose", () => {
  it("renders a descriptor as a sentence with no value in it", () => {
    const [byRowKey] = selectRowLink.descriptors;
    expect(byRowKey).toBeDefined();
    if (byRowKey === undefined) return;
    expect(describeDescriptor(byRowKey)).toBe(
      'the link in column <actions-column> of the row whose <member-column> cell equals param.memberId, inside frame exactly "content", inside the table with columns [<member-column>, <name-column>, <status-column>]',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Screens and targets this file builds
// ---------------------------------------------------------------------------------------------

/**
 * The results grid with geometry on its cells.
 *
 * The shared corpus deliberately leaves cell bounds null - a legacy grid reports geometry only on
 * the things a person can click - so this variant exists to exercise the geometric descriptor at
 * all. Everything else is the corpus.
 */
const resultsWithCellGeometry: Observation = withNodes(
  results,
  results.nodes.map((node) =>
    node.tablePosition === null
      ? node
      : {
          ...node,
          bounds: {
            x: 24 + node.tablePosition.colIndex * 160,
            y: 96 + node.tablePosition.rowIndex * 32,
            w: 120,
            h: 16,
            unit: "px" as const,
          },
        },
  ),
);

/**
 * A Select link found WITHOUT the row key - by its name and its position - so that `rowKeyEquals`
 * is the only thing standing between the run and the wrong member's row. That is the shape of case
 * W1, and it is why the assertion is not a duplicate of the descriptors.
 */
const selectLinkByNameAndPosition = TargetRefSchema.parse({
  scope: selectRowLink.scope,
  role: "link",
  descriptors: [
    {
      id: "select-by-name",
      kind: "role-name",
      evidenceSource: "accessibleName",
      role: "link",
      name: { mode: "token", token: "select-link", normalize: "std.label@1" },
    },
    {
      id: "select-by-position",
      kind: "ordinal-in-container",
      evidenceSource: "ordinal",
      container: selectRowLink.scope,
      role: "link",
      index: 0,
    },
  ],
  quorum: {
    min: 2,
    distinctEvidenceSources: 2,
    requireIdentical: true,
    onUnderQuorum: "fail",
    expectUnique: true,
  },
  assert: {
    role: "link",
    rowKeyEquals: {
      columnHeader: { mode: "token", token: "member-column", normalize: "std.label@1" },
      value: { from: "param", param: "memberId" },
    },
  },
  recordedNode: {
    ariaRole: "link",
    name: "Select",
    containerPath: [],
    tablePosition: { rowHeader: null, colHeader: "Actions" },
    boundsBucket: null,
  },
}) as TargetRef;
