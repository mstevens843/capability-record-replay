// Does the `Surface` port actually fit a character grid?
//
// This is the falsification test the terminal driver exists for. Everything below is `@crr/core`'s
// code - its validator, its resolver, its extractor, its evaluator - run against observations that
// came off an 80x24 green screen. Nothing here is terminal-specific except the fixture that
// produced the grids, and that is the claim: the engine cannot tell which surface it is driving.
//
// Four things had to hold, and each has a test:
//   the observation VALIDATES (the obligation every driver has);
//   a `table-cell` descriptor resolves a balance on a green screen the same way it does in a table;
//   a `label-anchored` descriptor resolves against a prompt that is only text on a grid;
//   the quorum counts a control's name and its label as ONE source of evidence, not two.
//
// The two places the port did NOT fit are asserted here too, as facts rather than as complaints:
// there is nothing to navigate to, and there is no native dialog channel. A LOCATION is a third
// thing and this surface does have one; `[P1] the screen-id band IS the route` below is where that
// is pinned down, and it is the fact the policy chokepoint turns out to depend on.

import {
  type Descriptor,
  type ExtractSpec,
  NodeIdSchema,
  type TargetRef,
  TargetRefSchema,
  type UINode,
  boundsBucketOf,
  isResolved,
  parseObservation,
  readExtractSpec,
  resolveCell,
  resolveTarget,
  surfaceFeaturesOf,
} from "@crr/core";
import { describe, expect, it } from "vitest";
import { detect } from "../src/detect.js";
import { observationOf, routeOfScreen } from "../src/observe.js";
import { TERMINAL_DRIVER, TERMINAL_SUPPORTED_ROLES, TerminalSurface } from "../src/surface.js";
import { createMemoryTransport } from "../src/transport.js";
import { grid } from "./support/corpus.js";
import { contextFor } from "./support/eval.js";

const stability = { settled: true, generation: 3, pendingReason: null } as const;

const observe = (name: string) =>
  observationOf(detect(grid(name)), {
    seq: 7,
    driver: TERMINAL_DRIVER,
    surfaceKind: "terminal",
    stability,
  });

const detailObs = observe("detail").observation;
const inquiryObs = observe("initial").observation;

const byId = (nodes: readonly UINode[], id: string): UINode | undefined =>
  nodes.find((n) => n.id === id);

const SCREEN_SCOPE = (id: string) => ({
  path: [
    {
      kind: "screen" as const,
      id: { mode: "exact" as const, value: id, normalize: "std.text@1" as const },
    },
  ],
});

const TABLE_SCOPE = {
  path: [
    {
      kind: "screen" as const,
      id: { mode: "exact" as const, value: "ACCOUNT LIST 02", normalize: "std.text@1" as const },
    },
    {
      kind: "table" as const,
      headers: [
        { mode: "exact" as const, value: "SUFFIX", normalize: "std.text@1" as const },
        { mode: "exact" as const, value: "BALANCE", normalize: "std.text@1" as const },
      ],
    },
  ],
};

const QUORUM = {
  min: 2,
  distinctEvidenceSources: 2,
  requireIdentical: true,
  onUnderQuorum: "fail",
  expectUnique: true,
} as const;

describe("the observation this driver emits is a legal Observation", () => {
  it("round-trips through the schema every driver is validated by", () => {
    expect(() => parseObservation(detailObs)).not.toThrow();
    expect(() => parseObservation(inquiryObs)).not.toThrow();
  });

  it("mints node ids in the format the artifact validator refuses to store", () => {
    // Every driver emits `<kind>:<local>`, and `looksLikeNodeId` is what lets the artifact
    // validator reject one that got written into a descriptor position.
    for (const node of detailObs.nodes) expect(() => NodeIdSchema.parse(node.id)).not.toThrow();
  });

  it("reports geometry in CELLS, and every node has some", () => {
    for (const node of detailObs.nodes) expect(node.bounds?.unit).toBe("cell");
  });

  it("uses only roles it advertises", () => {
    const advertised = new Set<string>(TERMINAL_SUPPORTED_ROLES);
    for (const node of detailObs.nodes) expect(advertised).toContain(node.ariaRole);
  });

  it("links every parent and child it claims", () => {
    const ids = new Set(detailObs.nodes.map((n) => n.id));
    for (const node of detailObs.nodes) {
      if (node.parent !== null) expect(ids).toContain(node.parent);
      for (const child of node.children) expect(ids).toContain(child);
    }
    expect(detailObs.roots.length).toBeGreaterThan(0);
  });
});

describe("[P2] the account block is a real table, not a list", () => {
  it("emits table, row and cell nodes with a table container segment", () => {
    const table = detailObs.nodes.filter((n) => n.ariaRole === "table");
    const rows = detailObs.nodes.filter((n) => n.ariaRole === "row");
    const cells = detailObs.nodes.filter((n) => n.ariaRole === "cell");
    expect(table).toHaveLength(1);
    expect(rows).toHaveLength(3);
    expect(cells).toHaveLength(9);
    expect(cells[0]?.containerPath.map((s) => s.kind)).toEqual(["screen", "table"]);
  });

  it("records the header provenance HONESTLY as a heuristic", () => {
    // A bold run above a block of aligned text is not a declared column header, and a guess that
    // was never labelled as one cannot be corrected by an overlay.
    const cell = detailObs.nodes.find((n) => n.ariaRole === "cell");
    expect(cell?.tablePosition?.headerProvenance).toBe("first-row-heuristic");
  });

  it("addresses a cell by ROW KEY and column header, the way the browser surface does", () => {
    const cell = resolveCell(
      {
        table: TABLE_SCOPE,
        rowKey: {
          columnHeader: { mode: "exact", value: "SUFFIX", normalize: "std.text@1" },
          rowKey: undefined,
          value: { from: "literal", value: "D0001", sensitivity: "public" },
        } as never,
        columnHeader: { mode: "exact", value: "BALANCE", normalize: "std.text@1" },
      },
      contextFor(detailObs),
    );
    expect(cell?.value).toBe("2,880.13");
  });

  it("reads the whole grid through the contract's declared table type", () => {
    const spec: ExtractSpec = {
      output: "accounts",
      where: { scope: TABLE_SCOPE, role: "cell" },
      from: "cell@1",
      // `std.identity@1`, not `std.text@1`: an account suffix is a code, and the general text fold
      // lowercases it. Reading "d0001" back to a member is not wrong enough to notice and not right.
      normalize: "std.identity@1",
      parse: "string@1",
      onMissing: "fail",
      rows: { minRows: 1, maxRows: 10 },
    } as never;
    const outcome = readExtractSpec(spec, "readTable", {
      ...contextFor(detailObs),
      program: {
        ...contextFor(detailObs).program,
        outputs: {
          accounts: {
            type: {
              kind: "table",
              columns: [
                { name: "SUFFIX", type: { kind: "string" } },
                { name: "BALANCE", type: { kind: "string" } },
              ],
            },
            sensitivity: "internal",
          },
        } as never,
      },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.output.value).toEqual([
        { SUFFIX: "S0001", BALANCE: "1,204.55" },
        { SUFFIX: "S0010", BALANCE: "310.00" },
        { SUFFIX: "D0001", BALANCE: "2,880.13" },
      ]);
    }
  });
});

describe("[P3] a prompt is a node, so label-anchored resolution works on a grid", () => {
  it("emits the prompt text as its own node with its own extent", () => {
    const label = inquiryObs.nodes.find(
      (n) => n.rawRole === "PromptLabel" && n.name === "Account Number",
    );
    expect(label).toBeDefined();
    expect(label?.bounds).toEqual({ x: 2, y: 5, w: 15, h: 1, unit: "cell" });
  });

  it("points the field at its prompt through labelledBy", () => {
    const field = byId(inquiryObs.nodes, "textbox:account-number");
    expect(field?.labelledBy).toHaveLength(1);
    const label = byId(inquiryObs.nodes, field?.labelledBy[0] ?? "");
    expect(label?.name).toBe("Account Number");
  });

  it("resolves the field from role+name, and independently from the label to its left", () => {
    const resolution = resolveTarget({
      target: terminalTarget(NAME_AND_LABEL),
      ctx: contextFor(inquiryObs),
      capabilities: terminalCapabilities(),
    });
    // Both descriptors DID resolve, and both picked the same node.
    const resolved = resolution.candidates.filter((c) => c.verdict === "resolved");
    expect(resolved.map((c) => c.descriptorId)).toEqual(["by-role-name", "by-label"]);
    expect(new Set(resolved.map((c) => c.nodeId))).toEqual(new Set(["textbox:account-number"]));
  });

  it("REFUSES anyway, because on a green screen those two are the same evidence", () => {
    // A finding, not a defect, and one this surface makes unavoidable. In an accessibility tree a
    // control's accessible name can come from an `aria-label` that is not the visible prompt, so
    // `role-name` and `label-anchored` can genuinely be two independent readings. On a character
    // grid there IS no name but the prompt: the detector derived the name FROM the label, so the
    // two descriptors read the same words off the same screen and one relabelling kills both.
    //
    // The quorum sees that - `evidenceKey` collapses them - and refuses rather than acting on
    // corroboration that does not exist. Refusing here is the correct answer and is exactly what
    // "disagreement is a detected condition, never a fallback chain" is supposed to buy.
    const resolution = resolveTarget({
      target: terminalTarget(NAME_AND_LABEL),
      ctx: contextFor(inquiryObs),
      capabilities: terminalCapabilities(),
    });
    expect(isResolved(resolution)).toBe(false);
    expect(resolution.status).toBe("underdetermined");
    if (!isResolved(resolution)) {
      expect(resolution.reason).toContain("1 independent piece");
    }
  });

  it("resolves once a STRUCTURALLY independent descriptor is added", () => {
    // The consequence for synthesis: a target derived on this surface needs a third descriptor
    // whose evidence is not the label - here, the field's ordinal within the screen. That is a
    // real constraint on what `deriveDescriptors` may emit for a terminal recording, and it falls
    // out of the port rather than out of a rule somebody remembered to write down.
    const resolution = resolveTarget({
      target: terminalTarget([...NAME_AND_LABEL, ORDINAL]),
      ctx: contextFor(inquiryObs),
      capabilities: terminalCapabilities(),
    });
    expect(isResolved(resolution)).toBe(true);
    if (isResolved(resolution)) {
      expect(resolution.nodeId).toBe("textbox:account-number");
      expect(resolution.agreeingDescriptors).toEqual(["by-role-name", "by-label", "by-ordinal"]);
      expect(resolution.independentSources).toBe(2);
    }
  });
});

describe("[P4] confidence is per node, and the floor excludes a guess", () => {
  it("scores a labelled field above the floor and the banner headings below the labelled ones", () => {
    const field = byId(inquiryObs.nodes, "textbox:account-number");
    const heading = byId(inquiryObs.nodes, "heading:riverbend-cu");
    const control = byId(inquiryObs.nodes, "button:exit");
    expect(field?.confidence).toBeGreaterThan(terminalCapabilities().confidenceFloor);
    expect(control?.confidence).toBeGreaterThan(field?.confidence ?? 0);
    expect(heading?.confidence).toBeGreaterThan(terminalCapabilities().confidenceFloor);
  });

  it("advertises a floor below 1.0, because every role here is inferred", () => {
    expect(terminalCapabilities().confidenceFloor).toBeLessThan(1);
  });
});

describe("[P1] what the port does NOT get on this surface, stated as a fact", () => {
  it("reports no route until it is told which system it is attached to", () => {
    // `detailObs` is built with no `originAlias`, which is the unconfigured driver. Null here is
    // not "a green screen has no location" - it is "nobody has said which host this grid is on",
    // and it is deliberately fatal: see the policy assertion in the next describe.
    expect(detailObs.route).toBeNull();
  });

  it("has no native dialog channel", () => {
    expect(detailObs.nativeDialog).toBeNull();
    expect(detailObs.inputIntercepted).toBe(false);
  });

  it("advertises character-grid, table-position, containers and geometry - and NOT route", () => {
    // The linker turns this into a load-time refusal (check 17) rather than a mysterious
    // target-not-found six steps into a run.
    const features = surfaceFeaturesOf(terminalCapabilities());
    expect(features).toContain("character-grid");
    expect(features).toContain("table-position");
    expect(features).toContain("containers");
    expect(features).toContain("geometry");
    expect(features).not.toContain("route");
    expect(features).not.toContain("native-dialog-channel");
    expect(features).not.toContain("accessibility-tree");
  });
});

describe("[P1] the screen-id band IS the route, once the caller names the system", () => {
  const configured = (name: string) =>
    observationOf(detect(grid(name)), {
      seq: 1,
      driver: TERMINAL_DRIVER,
      surfaceKind: "terminal",
      stability,
      originAlias: "corebank-green",
    }).observation;

  it("canonicalizes the band to a path the allowlist can match", () => {
    expect(configured("initial").route).toEqual({
      originAlias: "corebank-green",
      path: "/screen/01",
      query: {},
    });
    expect(configured("detail").route).toEqual({
      originAlias: "corebank-green",
      path: "/screen/02",
      query: {},
    });
  });

  it("gives the SAME path at both tenants, because the number is the program and the words are branding", () => {
    // riverbend paints "MEMBER INQUIRY 01" and summit paints "MBR INQ 01". One allowlist entry,
    // one artifact, no overlay - the same argument the F3-vs-F12 lowering makes one layer down.
    expect(configured("summitInitial").route?.path).toBe(configured("initial").route?.path);
    expect(configured("summitDetail").route?.path).toBe(configured("detail").route?.path);
  });

  it("distinguishes the screens a fault lands on", () => {
    expect(configured("signon").route?.path).toBe("/screen/00");
    expect(configured("abend").route?.path).toBe("/screen/99");
  });

  it("REFUSES TO NAME a torn read, which is what stops the engine acting on one", () => {
    // A half-painted frame has no id band. `@crr/core`'s policy engine denies every action whose
    // route is null, so this null is the reason a torn repaint cannot be typed into by accident -
    // a second, independent gate behind the checkpoint.
    expect(detect(grid("torn")).screenId).toBeNull();
    expect(configured("torn").route).toBeNull();
  });

  it("falls back to the whole band when a screen carries no number", () => {
    expect(routeOfScreen("PAYMENT ENTRY", "corebank-green")?.path).toBe("/screen/payment-entry");
  });

  it("stays null when either half of the location is missing", () => {
    expect(routeOfScreen(null, "corebank-green")).toBeNull();
    expect(routeOfScreen("MEMBER INQUIRY 01", null)).toBeNull();
    expect(routeOfScreen("MEMBER INQUIRY 01", undefined)).toBeNull();
    expect(routeOfScreen("   ", "corebank-green")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

function terminalCapabilities() {
  const surface = new TerminalSurface({ transport: createMemoryTransport() });
  return surface.capabilities();
}

/** The two descriptors a browser recording would consider independent. */
const NAME_AND_LABEL: Descriptor[] = [
  {
    id: "by-role-name",
    kind: "role-name",
    evidenceSource: "accessibleName",
    role: "textbox",
    name: { mode: "exact", value: "Account Number", normalize: "std.label@1" },
  },
  {
    id: "by-label",
    kind: "label-anchored",
    evidenceSource: "labelText",
    label: { mode: "exact", value: "Account Number", normalize: "std.label@1" },
    role: "textbox",
    relation: "right-of",
    maxDistance: { unit: "cell", value: 10 },
  },
] as never;

/** The third one this surface turns out to need: evidence that is not the label. */
const ORDINAL: Descriptor = {
  id: "by-ordinal",
  kind: "ordinal-in-container",
  evidenceSource: "ordinal",
  container: SCREEN_SCOPE("MEMBER INQUIRY 01"),
  role: "textbox",
  index: 0,
} as never;

/** A target of the shape synthesis would derive for the account-number field. */
function terminalTarget(descriptors: readonly Descriptor[]): TargetRef {
  const field = byId(inquiryObs.nodes, "textbox:account-number") as UINode;
  return TargetRefSchema.parse({
    scope: SCREEN_SCOPE("MEMBER INQUIRY 01"),
    role: "textbox",
    descriptors,
    quorum: QUORUM,
    assert: { role: "textbox" },
    recordedNode: {
      ariaRole: "textbox",
      name: field.name,
      containerPath: field.containerPath,
      tablePosition: null,
      boundsBucket: boundsBucketOf(field.bounds),
    },
  });
}
