// THE ACCEPTANCE TEST SPEC section 11 unit 14 names first: frozen-Observation derivation.
//
// Nothing here runs a browser, a loop, a provider or a clock. Every case is a function of one
// `Observation` on disk and one node id, which is the property SPEC section 5.2 requires of
// `deriveDescriptors` and the reason it can be tested at all.
//
// The suite is organised around the two rules of SPEC section 5.2 and the refusals of section 5.6:
// a descriptor is emitted only if it resolves UNIQUELY to the node the model picked; the emitted
// set must rest on TWO INDEPENDENT evidence sources; and no locator vocabulary, no node id and no
// recorded value may appear in what comes out.

import {
  MOCK_SURFACE_CAPABILITIES,
  type NodeId,
  type SurfaceCapabilities,
  TargetRefSchema,
  resolveTarget,
} from "@crr/core";
import { describe, expect, it } from "vitest";
import { type ValueBinding, Vocabulary, deriveDescriptors, targetRefOf } from "../src/index.js";
import { GRID_IDS, LABELLED_IDS, labelledForm, resultsGrid } from "./fixtures/frozen-screens.js";

const MEMBER_ID: ValueBinding = {
  param: "memberId",
  value: "50001",
  placeholder: "{memberId}",
  sensitivity: "sensitive",
};

function derive(
  observation: typeof labelledForm,
  nodeId: string,
  options: {
    readonly bindings?: readonly ValueBinding[];
    readonly capabilities?: SurfaceCapabilities;
    readonly vocabulary?: Vocabulary;
  } = {},
) {
  const bindings = options.bindings ?? [MEMBER_ID];
  const vocabulary = options.vocabulary ?? new Vocabulary(bindings);
  const derivation = deriveDescriptors({
    observation,
    nodeId: nodeId as NodeId,
    capabilities: options.capabilities ?? MOCK_SURFACE_CAPABILITIES,
    bindings,
    vocabulary,
  });
  return { derivation, vocabulary, bindings };
}

const kindsOf = (derivation: { descriptors: readonly { kind: string }[] } | null) =>
  derivation === null ? [] : derivation.descriptors.map((descriptor) => descriptor.kind);

// ---------------------------------------------------------------------------------------------
// Rule 1 - uniqueness, verified with the replay resolver
// ---------------------------------------------------------------------------------------------

describe("a descriptor is emitted only if it resolves uniquely to the node the model picked", () => {
  it("derives four independent descriptions of a labelled field", () => {
    const { derivation } = derive(labelledForm, LABELLED_IDS.field);
    expect(derivation).not.toBeNull();
    expect(kindsOf(derivation)).toEqual([
      "role-name",
      "label-anchored",
      "ordinal-in-container",
      "geometric",
    ]);
    expect(derivation?.independent).toBe(true);
  });

  it("emits them in rank order, so the strongest identity is the first thing a reviewer reads", () => {
    const { derivation } = derive(labelledForm, LABELLED_IDS.search);
    const ranks = {
      "role-name": 1,
      "label-anchored": 2,
      "table-cell": 3,
      "ordinal-in-container": 4,
      geometric: 5,
    };
    const seen = kindsOf(derivation).map((kind) => ranks[kind as keyof typeof ranks]);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it("the whole derived target resolves back to the node it was derived from", () => {
    for (const nodeId of [LABELLED_IDS.field, LABELLED_IDS.search]) {
      const { derivation, vocabulary, bindings } = derive(labelledForm, nodeId);
      const node = labelledForm.nodes.find((one) => one.id === nodeId);
      if (derivation === null || node === undefined) throw new Error("no derivation");
      const resolution = resolveTarget({
        target: targetRefOf(derivation, node, vocabulary),
        ctx: {
          observation: labelledForm,
          program: {
            routes: [],
            vocabulary: vocabulary.record(),
            continuity: [],
            outputs: {},
            brandingTokens: [],
            maxEffect: "READ",
            restartSafeUpToPc: 0,
            resumePoints: [],
          },
          bindings: bindings.map((binding) => ({
            name: binding.param,
            origin: "param" as const,
            value: binding.value,
            sensitivity: binding.sensitivity,
            handle: null,
          })),
        },
        capabilities: MOCK_SURFACE_CAPABILITIES,
      });
      expect(resolution.status).toBe("resolved");
      expect(resolution.nodeId).toBe(nodeId);
    }
  });

  it("records why each candidate it discarded did not survive", () => {
    const { derivation } = derive(resultsGrid, GRID_IDS.selectLink);
    // Two rows carry a "Select" link, so the accessible name alone is NOT unique on this screen and
    // the rank-1 descriptor is discarded rather than shipped as a coin flip.
    const rejected = derivation?.rejected.map((one) => one.kind) ?? [];
    expect(rejected).toContain("role-name");
    expect(derivation?.rejected.find((one) => one.kind === "role-name")?.reason).toMatch(
      /not-found|non-unique|abstained/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Rule 2 - two INDEPENDENT sources, and layout is only ever one of them
// ---------------------------------------------------------------------------------------------

describe("the emitted set must rest on two independent evidence sources", () => {
  it("refuses a node whose only evidence is where it sits", () => {
    const { derivation } = derive(labelledForm, LABELLED_IDS.unnamed);
    expect(derivation).not.toBeNull();
    expect(derivation?.independent).toBe(false);
    // Position, and nothing else. The recorder says so and does not invent a sixth strategy.
    expect(derivation?.evidenceSources.every((source) => source === "ordinal")).toBe(true);
  });

  it("counts geometry and ordinal as one source between them, never as two", () => {
    const { derivation } = derive(labelledForm, LABELLED_IDS.field);
    const sources: readonly string[] = derivation?.evidenceSources ?? [];
    const layout = new Set(["ordinal", "geometry"]);
    expect(sources.filter((source) => layout.has(source)).length).toBeGreaterThan(1);
    // ...and yet the independence claim rests on the NON-layout sources.
    expect(sources.filter((source) => !layout.has(source)).length).toBeGreaterThanOrEqual(1);
  });

  it("does not record a descriptor kind the surface says it cannot resolve", () => {
    const narrowed: SurfaceCapabilities = {
      ...MOCK_SURFACE_CAPABILITIES,
      resolvableDescriptors: ["role-name", "ordinal-in-container"],
    };
    const { derivation } = derive(labelledForm, LABELLED_IDS.field, { capabilities: narrowed });
    expect(kindsOf(derivation)).toEqual(["role-name", "ordinal-in-container"]);
    expect(derivation?.rejected.map((one) => one.reason)).toContain(
      "this surface does not resolve descriptors of that kind",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The wrong-row killer
// ---------------------------------------------------------------------------------------------

describe("a row is addressed by a value the caller supplied, never by its index", () => {
  it("derives a table-cell descriptor keyed on the bound parameter", () => {
    const { derivation } = derive(resultsGrid, GRID_IDS.selectLink);
    const cell = derivation?.descriptors.find((one) => one.kind === "table-cell");
    expect(cell).toBeDefined();
    if (cell === undefined || cell.kind !== "table-cell") throw new Error("shape");
    expect(cell.rowKey.value).toEqual({ from: "param", param: "memberId" });
    expect(cell.childRole).toBe("link");
    expect(cell.headerProvenance).toBe("first-row-heuristic");
  });

  it("carries the row key into the pre-act assertion, so the wrong row cannot be clicked", () => {
    const { derivation, vocabulary } = derive(resultsGrid, GRID_IDS.selectLink);
    const node = resultsGrid.nodes.find((one) => one.id === GRID_IDS.selectLink);
    if (derivation === null || node === undefined) throw new Error("no derivation");
    const target = targetRefOf(derivation, node, vocabulary);
    expect(target.assert.rowKeyEquals?.value).toEqual({ from: "param", param: "memberId" });
  });

  it("derives no table-cell descriptor when no column in the row holds a bound value", () => {
    const { derivation } = derive(resultsGrid, GRID_IDS.selectLink, { bindings: [] });
    expect(kindsOf(derivation)).not.toContain("table-cell");
    expect(derivation?.rejected.find((one) => one.kind === "table-cell")?.reason).toBe(
      "the node is not in a table row addressable by a bound value",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// What may never come out of here
// ---------------------------------------------------------------------------------------------

describe("what a derived locator may never contain", () => {
  const everyString = (value: unknown, out: string[] = []): string[] => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) for (const item of value) everyString(item, out);
    else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        out.push(key);
        everyString(child, out);
      }
    }
    return out;
  };

  // The enforcement is the SCHEMA, not this test: `SafeTextMatcherSchema` refuses a stylesheet
  // selector, a document path expression, a URL or a node-id shape in every author-written text
  // position of a target. What the test asserts is that a DERIVED target survives that refusal -
  // and separately that no per-observation node id rides along, because a document carrying one
  // replays perfectly exactly once.
  it("survives the artifact validator's refusal of locator-shaped text", () => {
    for (const [observation, nodeId] of [
      [labelledForm, LABELLED_IDS.field],
      [resultsGrid, GRID_IDS.selectLink],
    ] as const) {
      const { derivation, vocabulary } = derive(observation, nodeId);
      const node = observation.nodes.find((one) => one.id === nodeId);
      if (derivation === null || node === undefined) throw new Error("no derivation");
      expect(() => TargetRefSchema.parse(targetRefOf(derivation, node, vocabulary))).not.toThrow();
    }
  });

  it("stores no node id from the observation it was derived against", () => {
    for (const [observation, nodeId] of [
      [labelledForm, LABELLED_IDS.field],
      [resultsGrid, GRID_IDS.selectLink],
    ] as const) {
      const { derivation, vocabulary } = derive(observation, nodeId);
      const node = observation.nodes.find((one) => one.id === nodeId);
      if (derivation === null || node === undefined) throw new Error("no derivation");
      const strings = everyString(targetRefOf(derivation, node, vocabulary));
      for (const one of observation.nodes) {
        expect(strings).not.toContain(one.id as string);
      }
    }
  });

  it("replaces a bound value in the recorded fingerprint with its parameter hole", () => {
    // The cell whose ACCESSIBLE NAME is the member number. Nothing else in the document would have
    // caught this: `NodeFingerprint.name` is a plain string, compared rather than matched.
    const { derivation } = derive(resultsGrid, GRID_IDS.memberIdCell);
    expect(derivation?.recordedNode.name).toBe("{memberId}");
    expect(JSON.stringify(derivation?.recordedNode)).not.toContain("50001");
  });

  it("puts screen wording in the vocabulary as a token, never inline", () => {
    const { derivation, vocabulary } = derive(labelledForm, LABELLED_IDS.field);
    const roleName = derivation?.descriptors.find((one) => one.kind === "role-name");
    if (roleName === undefined || roleName.kind !== "role-name") throw new Error("shape");
    expect(roleName.name.mode).toBe("token");
    expect(Object.values(vocabulary.record()).flat()).toContain("Member ID");
  });
});

// ---------------------------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------------------------

describe("derivation is a pure function of the observation", () => {
  it("produces byte-identical output for the same input", () => {
    const first = derive(labelledForm, LABELLED_IDS.field).derivation;
    const second = derive(labelledForm, LABELLED_IDS.field).derivation;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("returns null rather than throwing for a structural node or an unknown id", () => {
    expect(derive(labelledForm, "cell:wrapper").derivation).toBeNull();
    expect(derive(labelledForm, "textbox:does-not-exist").derivation).toBeNull();
  });
});
