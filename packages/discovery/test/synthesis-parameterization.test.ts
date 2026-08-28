// THE ACCEPTANCE TEST SPEC section 11 unit 14 names second, and the one BRIEF section 3.6 exists
// for: THE RECORDED VALUE APPEARS NOWHERE IN THE EMITTED ARTIFACT.
//
// "Nowhere" is meant literally, and it is the reason this file does not simply check the fields it
// expects the value to have been in. A substitution applied at forty call sites is one somebody
// forgets at the forty-first, and the forty-first will be a field nobody reads - a recorded node's
// accessible name, a step's model-authored prose, a vocabulary entry, a route segment, an object
// KEY in a fingerprint map. So the assertion is over the whole serialized document, twice, by two
// independent means:
//
//   1. `findBoundValues` walks the parsed document - every string, every number, every KEY - and
//      reports a path. That is the same function the emitter runs on its own output before it
//      returns, so this test is also the test of that guard.
//   2. A raw `indexOf` over `JSON.stringify(document)`. Cruder, blind to structure, and impossible
//      to fool by a bug in the walker. If the walker ever stops walking, this catches it.
//
// And because a check that passes because it stopped checking is worth nothing, there is a
// DISCRIMINATION suite: the same scanners are pointed at a document that deliberately does contain
// the value, in each of the positions above, and are required to find it.

import { FieldNameSchema, MOCK_SURFACE_CAPABILITIES } from "@crr/core";
import { describe, expect, it } from "vitest";
import {
  RouteTable,
  type ValueBinding,
  findBoundValues,
  inferParameters,
  mentionedInGoal,
  parameterizeText,
} from "../src/index.js";
import { GOAL } from "./fixtures/corebank.js";
import { RECORDED_MEMBER_ID, recordedRun, synthesized } from "./fixtures/synthesis-run.js";

const bindings: readonly ValueBinding[] = [
  {
    param: "memberId",
    value: RECORDED_MEMBER_ID,
    placeholder: "{memberId}",
    sensitivity: "sensitive",
  },
];

// ---------------------------------------------------------------------------------------------
// The acceptance
// ---------------------------------------------------------------------------------------------

describe("the recorded value appears nowhere in the emitted documents", () => {
  it("is absent from every string, number and key of the artifact and the contract", async () => {
    const { artifact, contract } = await synthesized();
    expect(findBoundValues(artifact, bindings)).toEqual([]);
    expect(findBoundValues(contract, bindings)).toEqual([]);
  });

  it("is absent from the raw serialization, checked without walking anything", async () => {
    const { artifact, contract } = await synthesized();
    for (const document of [artifact, contract]) {
      const raw = JSON.stringify(document);
      expect(raw.includes(RECORDED_MEMBER_ID)).toBe(false);
      expect(raw.toLowerCase().includes(RECORDED_MEMBER_ID.toLowerCase())).toBe(false);
    }
  });

  it("survives the same check on the run it was synthesized from, which DOES carry the value", async () => {
    // The control that makes the assertion above mean something: the recording is full of the
    // member number - it is what the model typed and what the screen echoed - and synthesis is the
    // step that removes it. If the run were also clean, the test above would prove nothing.
    const run = await recordedRun();
    expect(JSON.stringify(run.steps).includes(RECORDED_MEMBER_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Where the value went instead
// ---------------------------------------------------------------------------------------------

describe("what replaced it", () => {
  it("binds a typed, sensitive parameter with no catalog example", async () => {
    const { contract } = await synthesized();
    const param = contract.inputs.find((one) => one.name === "memberId");
    expect(param).toBeDefined();
    expect(param?.type).toEqual({ kind: "string", charset: "digits", maxLength: 12 });
    expect(param?.sensitivity).toBe("sensitive");
    // A sensitive field may not carry an example; the example would be the leak.
    expect(param?.example).toBeUndefined();
    expect(param?.constraints).toEqual({ charset: "digits", maxLength: 12 });
  });

  it("types the field's maxLength from the SURFACE, not from the value it happened to see", async () => {
    // `capacity: 12` on the field; the recorded value is five digits long. A maxLength derived from
    // the value would bake one member's id length into every future call.
    const { contract } = await synthesized();
    const param = contract.inputs.find((one) => one.name === "memberId");
    expect(param?.constraints?.maxLength).toBe(12);
    expect(RECORDED_MEMBER_ID.length).not.toBe(12);
  });

  it("refers to the parameter by name from the instruction that fills it", async () => {
    const { artifact } = await synthesized();
    const fill = artifact.flow.steps.find((step) => step.instruction.kind === "fill");
    expect(fill?.instruction).toEqual({
      kind: "fill",
      value: { from: "param", param: "memberId" },
      mode: "replace",
    });
  });

  it("parameterizes the goal template and the model's own prose", async () => {
    const { artifact } = await synthesized();
    expect(artifact.provenance.goalTemplate).toContain("{memberId}");
    // `Step.intent` is the model's own words. It is the one place in the artifact where a value the
    // model typed into its reasoning would otherwise be persisted verbatim.
    const intents = artifact.flow.steps.map((step) => step.intent).join(" ");
    expect(intents).toContain("{memberId}");
  });

  it("records the goal SPAN parameterized, which is the field most likely to hold the value", async () => {
    const { contract } = await synthesized();
    const param = contract.inputs.find((one) => one.name === "memberId");
    const from = param?.discoveredFrom;
    expect(from !== undefined && "goalSpan" in from).toBe(true);
    if (from === undefined || !("goalSpan" in from)) throw new Error("shape");
    expect(from.goalSpan).toContain("{memberId}");
    expect(from.goalSpan).not.toContain(RECORDED_MEMBER_ID);
  });

  it("declares the parameter tainted, so replay masks the field it is typed into", async () => {
    const { artifact } = await synthesized();
    expect(artifact.policy.redaction.taintedParams).toContain("memberId");
    expect(artifact.policy.redaction.maskScreenshotRegions).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Discrimination - the scanners must be able to fail
// ---------------------------------------------------------------------------------------------

describe("the leak scanners can fail", () => {
  const positions = {
    "a plain string value": { note: RECORDED_MEMBER_ID },
    "a nested string": { a: { b: [{ c: `member ${RECORDED_MEMBER_ID} detail` }] } },
    "an object KEY": { [`row-${RECORDED_MEMBER_ID}`]: true },
    "a number": { count: Number(RECORDED_MEMBER_ID) },
    "a different case": { note: RECORDED_MEMBER_ID.toUpperCase() },
  } as const;

  for (const [where, document] of Object.entries(positions)) {
    it(`finds a value hidden in ${where}`, () => {
      const found = findBoundValues(document, bindings);
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]?.param).toBe("memberId");
      // The report names the parameter and the path, and never quotes the value: a leak report that
      // printed the value would persist it in the log that reported the persistence.
      expect(JSON.stringify(found)).not.toContain(RECORDED_MEMBER_ID);
    });
  }

  it("reports the position of a key separately from a value", () => {
    const found = findBoundValues({ [`row-${RECORDED_MEMBER_ID}`]: true }, bindings);
    expect(found[0]?.position).toBe("key");
  });

  it("is silent on a document that carries no bound value", () => {
    expect(findBoundValues({ a: "Member ID", b: ["Search", 42] }, bindings)).toEqual([]);
  });

  it("the emitter refuses to return a document a scan finds a value in", () => {
    // The guard is inside `synthesizeCapability`, so the only way to exercise it directly is to
    // confirm the scan it depends on is the one tested above. The end-to-end assertion that it
    // never fires on a real run is the first test in this file.
    expect(findBoundValues({ leaked: RECORDED_MEMBER_ID }, bindings)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Matching against the goal
// ---------------------------------------------------------------------------------------------

describe("a value becomes a parameter only when the goal actually names it", () => {
  it("matches on a whole token, not on a substring", () => {
    expect(mentionedInGoal("look up member 50001", "50001")).toBe(true);
    // The failure a bare substring test makes: binding "50001" out of the middle of "1500012" and
    // then replacing three digits of a different number everywhere in the document.
    expect(mentionedInGoal("look up member 1500012", "50001")).toBe(false);
  });

  it("matches across case, because a screen echoes what a goal typed", () => {
    expect(mentionedInGoal("open account abc123", "ABC123")).toBe(true);
  });

  it("refuses a value too short to substitute safely", () => {
    expect(mentionedInGoal("choose 5", "5")).toBe(false);
  });

  it("replaces the longest value first, so a prefix does not shadow a longer match", () => {
    const two: readonly ValueBinding[] = [
      { param: "shortId", value: "5000", placeholder: "{shortId}", sensitivity: "internal" },
      { param: "memberId", value: "50001", placeholder: "{memberId}", sensitivity: "sensitive" },
    ];
    expect(parameterizeText("member 50001", two)).toBe("member {memberId}");
  });
});

// ---------------------------------------------------------------------------------------------
// Route canonicalization - the same mechanism, applied to a path
// ---------------------------------------------------------------------------------------------

describe("routes canonicalize by the same mechanism", () => {
  const location = (path: string) => ({
    originAlias: "corebank",
    path,
    query: {} as Readonly<Record<string, string>>,
  });

  it("replaces a bound segment with its parameter hole", () => {
    const table = new RouteTable(bindings);
    const route = table.routeFor(location(`/member/${RECORDED_MEMBER_ID}`));
    expect(route.pattern.path).toBe("/member/:memberId");
    expect(route.id).toBe("member-by-memberid");
  });

  it("replaces an identifier-shaped segment that matched no parameter, and says a person must decide", () => {
    const table = new RouteTable(bindings);
    const route = table.routeFor(location("/accounts/9931007/detail"));
    expect(route.pattern.path).toBe("/accounts/:accountId/detail");
    expect(table.notes().some((note) => note.code === "route-segment-unbound")).toBe(true);
  });

  it("leaves a path a driver already canonicalized alone", () => {
    const table = new RouteTable(bindings);
    expect(table.routeFor(location("/members/:memberId")).pattern.path).toBe("/members/:memberId");
  });

  it("gives the same canonical path the same id every time it is visited", () => {
    const table = new RouteTable(bindings);
    const first = table.routeFor(location(`/member/${RECORDED_MEMBER_ID}`));
    const second = table.routeFor(location("/member/60002"));
    expect(second.id).toBe(first.id);
    expect(table.patterns()).toHaveLength(1);
  });

  it("never lets the value into the route id it mints", () => {
    const table = new RouteTable(bindings);
    const route = table.routeFor(location(`/member/${RECORDED_MEMBER_ID}/accounts`));
    expect(route.id).not.toContain(RECORDED_MEMBER_ID);
    expect(JSON.stringify(table.patterns())).not.toContain(RECORDED_MEMBER_ID);
  });
});

// ---------------------------------------------------------------------------------------------
// The literal that is allowed to stay
// ---------------------------------------------------------------------------------------------

describe("a value the goal never mentioned", () => {
  it("stays a literal when it is safe to persist", async () => {
    const run = await recordedRun();
    const inferred = inferParameters({ goal: GOAL, steps: run.steps });
    // Only the member number was bound. Nothing else the run typed reached the goal text.
    expect(inferred.params.map((param) => param.name)).toEqual(["memberId"]);
    expect(mentionedInGoal(GOAL, RECORDED_MEMBER_ID)).toBe(true);
  });

  it("becomes an operator parameter when it looks like regulated data", () => {
    // A value that is NOT in the goal and DOES have a regulated shape cannot be stored as a
    // literal - the `literal` arm of `ValueRef` is typed `sensitivity: "public"` and nothing else -
    // so it becomes a parameter and the report says a person must confirm where it comes from.
    const goal = "file the account note";
    const steps = [syntheticFill("Tax ID", "123-45-6789")];
    const inferred = inferParameters({ goal, steps });
    expect(inferred.params).toHaveLength(1);
    expect(inferred.params[0]?.sensitivity).toBe("sensitive");
    expect(inferred.notes.some((note) => note.code === "parameter-regulated-shape")).toBe(true);
    expect(JSON.stringify(inferred.params)).not.toContain("123-45-6789");
  });
});

// ---------------------------------------------------------------------------------------------
// What the parameter is CALLED
//
// A capability is invoked by an agent that fills arguments BY NAME, so the name is interface, not
// decoration. The chain in `synthesis/parameters.ts` walks four rungs of evidence the system
// already has and then stops honestly. Each rung gets a test, and so does the stopping - a fallback
// chain nobody has watched reach its end is a fallback chain that silently ships `value1`.
// ---------------------------------------------------------------------------------------------

const CAPABILITIES = MOCK_SURFACE_CAPABILITIES;

describe("naming a parameter after what the application calls the field", () => {
  it("rung 1: uses the control's own accessible name when it has one", () => {
    const inferred = inferParameters({
      goal: "look up member 50001",
      steps: [fillInto({ value: "50001", name: "Member ID" })],
      capabilities: CAPABILITIES,
    });
    expect(inferred.params.map((one) => one.name)).toEqual(["memberId"]);
    expect(inferred.naming).toEqual([{ param: "memberId", source: "accessible-name" }]);
    expect(inferred.params[0]?.description).toContain('"Member ID"');
    expect(inferred.notes.some((note) => note.code === "parameter-name-underived")).toBe(false);
  });

  it("rung 2: falls back to the label the MARKUP associates, when the field has no name", () => {
    const inferred = inferParameters({
      goal: "look up member 50001",
      steps: [fillInto({ value: "50001", labelledBy: "Member Number" })],
      capabilities: CAPABILITIES,
    });
    expect(inferred.params.map((one) => one.name)).toEqual(["memberNumber"]);
    expect(inferred.naming).toEqual([{ param: "memberNumber", source: "labelled-by" }]);
    expect(inferred.notes.some((note) => note.code === "parameter-name-underived")).toBe(false);
  });

  it("rung 3: falls back to the ADJACENT label anchor, which is the legacy-app case", () => {
    // No accessible name, no `<label for>`, just wording in the neighbouring table cell - which is
    // the only association a `<font>`-tag frameset makes. This is the rung that closes
    // LIVE-RUN-READINESS section 5.5, and it reads the same anchor `deriveDescriptors` uses for
    // this node rather than a second opinion about what the field is called.
    const inferred = inferParameters({
      goal: "look up member 50001",
      steps: [fillInto({ value: "50001", adjacent: "Member Number" })],
      capabilities: CAPABILITIES,
    });
    expect(inferred.params.map((one) => one.name)).toEqual(["memberNumber"]);
    expect(inferred.naming).toEqual([{ param: "memberNumber", source: "adjacent-label" }]);
  });

  it("prefers the earlier rung when more than one is available", () => {
    const inferred = inferParameters({
      goal: "look up member 50001",
      steps: [
        fillInto({
          value: "50001",
          name: "Member ID",
          labelledBy: "Ignore Markup",
          adjacent: "Ignore Neighbour",
        }),
      ],
      capabilities: CAPABILITIES,
    });
    expect(inferred.params.map((one) => one.name)).toEqual(["memberId"]);
  });

  it("will not reach the adjacent rung on a surface that reports no bounds unit", () => {
    // Adjacency is a geometric claim. A surface that advertises no `boundsUnit` cannot make one,
    // and the chain stops rather than guessing a unit - the same condition under which
    // `labelAnchoredOf` declines to emit a spatial descriptor. This is also the discrimination case
    // for the test above: the only difference between them is the capabilities.
    const steps = [fillInto({ value: "50001", adjacent: "Member Number" })];
    const inferred = inferParameters({ goal: "look up member 50001", steps });
    expect(inferred.params.map((one) => one.name)).toEqual(["value1"]);
    expect(inferred.naming).toEqual([{ param: "value1", source: "positional" }]);
  });
});

describe("when there is genuinely nothing to name it after", () => {
  const inferred = inferParameters({
    goal: "look up member 50001",
    steps: [fillInto({ value: "50001" })],
    capabilities: CAPABILITIES,
  });

  it("names it positionally, because that is the honest answer", () => {
    expect(inferred.params.map((one) => one.name)).toEqual(["value1"]);
    expect(inferred.naming).toEqual([{ param: "value1", source: "positional" }]);
  });

  it("RAISES THE FLAG, at the severity that blocks approval", () => {
    // The bug was never `value1`. The bug was `value1` arriving silently in a document a person is
    // about to approve, so the note is `review` - the severity SPEC section 6.6 gives to "this
    // artifact cannot be approved until somebody has read this".
    const flag = inferred.notes.find((note) => note.code === "parameter-name-underived");
    expect(flag?.severity).toBe("review");
    expect(flag?.detail).toContain("value1");
    expect(flag?.detail).toContain("rename");
    // And it names no value, like every other note in this system.
    expect(flag?.detail).not.toContain("50001");
  });

  it("says so in the CONTRACT too, not only in the report a reviewer might not open", () => {
    expect(inferred.params[0]?.description).toContain("NEEDS A NAME");
  });
});

describe("what a derived name may never be", () => {
  it("is never spelled from a recorded value, even when the label carries one", () => {
    // A grid whose label for the field is "Member 50001" would otherwise mint an argument called
    // `member50001` - a member number in the caller's public API, and in the contract's bytes. The
    // rung is skipped, the chain continues, and the flag fires because nothing else answered.
    const inferred = inferParameters({
      goal: "look up member 50001",
      steps: [fillInto({ value: "50001", name: "Member 50001" })],
      capabilities: CAPABILITIES,
    });
    expect(inferred.params.map((one) => one.name)).toEqual(["value1"]);
    expect(JSON.stringify(inferred.params)).not.toContain("50001");
    expect(inferred.notes.some((note) => note.code === "parameter-name-underived")).toBe(true);
  });

  it("is never an illegal identifier, whatever the screen said", () => {
    // "1st Account #" starts with a digit, so `FieldNameSchema` would refuse it. The chain treats
    // an unspellable rung as an absent one.
    const inferred = inferParameters({
      goal: "move 4455 across",
      steps: [fillInto({ value: "4455", name: "1st Account #" })],
      capabilities: CAPABILITIES,
    });
    for (const param of inferred.params) expect(FieldNameSchema.parse(param.name)).toBe(param.name);
    expect(inferred.params.map((one) => one.name)).toEqual(["value1"]);
  });

  it("is never a collision, when two fields on one screen carry the same label", () => {
    const inferred = inferParameters({
      goal: "transfer 4455 to 6677",
      steps: [
        fillInto({ value: "4455", name: "Account", field: "from" }),
        fillInto({ value: "6677", name: "Account", field: "to" }),
      ],
      capabilities: CAPABILITIES,
    });
    const names = inferred.params.map((one) => one.name);
    expect(names).toEqual(["account", "account_2"]);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(FieldNameSchema.parse(name)).toBe(name);
  });

  it("does not collide with a hole route canonicalization goes on to mint", () => {
    // `inferParameters` hands its `taken` set to `RouteTable`, so a route segment that wants to be
    // called `account` after a parameter already is gets a distinct spelling instead of silently
    // aliasing it.
    const inferred = inferParameters({
      goal: "open account 4455",
      steps: [fillInto({ value: "4455", name: "Account" })],
      capabilities: CAPABILITIES,
    });
    expect(inferred.taken.has("account")).toBe(true);
  });
});

/** A minimal recorded fill, for the cases the committed transcript does not contain. */
function syntheticFill(label: string, value: string) {
  return fillInto({ value, name: label });
}

interface FillShape {
  readonly value: string;
  /** The control's own accessible name - rung 1. */
  readonly name?: string;
  /** Wording the MARKUP associates with the control via `labelledBy` - rung 2. */
  readonly labelledBy?: string;
  /** Wording sitting immediately to the control's left, with real geometry - rung 3. */
  readonly adjacent?: string;
  /** A distinct node id, so two fills in one run are two nodes rather than one. */
  readonly field?: string;
}

/**
 * A recorded fill with each rung of the naming chain switchable independently.
 *
 * Geometry is real rather than nominal: the adjacent label is placed 10px to the left of a 20px
 * high control, which is inside `nearestLabel`'s reach bound of eight control-heights. A test that
 * placed it anywhere and asserted a name would be asserting that the reach bound does not exist.
 */
function fillInto(shape: FillShape) {
  const field = shape.field ?? "field";
  const markup = `static:${field}-markup`;
  const adjacent = `static:${field}-adjacent`;
  const extras = [];
  if (shape.labelledBy !== undefined) {
    extras.push(staticText(markup, shape.labelledBy, null));
  }
  if (shape.adjacent !== undefined) {
    extras.push(staticText(adjacent, shape.adjacent, { x: 20, y: 10, w: 70, h: 15, unit: "px" }));
  }
  const target = `textbox:${field}`;
  const run = {
    index: 1,
    tool: "act" as const,
    intent: "fill it in",
    nodeId: target as never,
    action: {
      kind: "type" as const,
      target: target as never,
      text: shape.value,
      mode: "replace" as const,
      sensitive: false,
    },
    effect: "WRITE_REVERSIBLE" as const,
    policyRuleId: "test",
    value: { kind: "literal" as const, value: shape.value },
    route: null,
    observation: {
      seq: 1,
      surface: { kind: "web-legacy" as const, driver: "test@0" },
      route: null,
      nodes: [
        {
          id: target as never,
          rawRole: "textbox",
          ariaRole: "textbox" as const,
          name: shape.name ?? "",
          value: null,
          text: null,
          description: null,
          state: {
            disabled: false,
            focused: false,
            visible: true,
            checked: null,
            expanded: null,
            selected: null,
            required: null,
            invalid: null,
            readonly: null,
          },
          bounds:
            shape.adjacent === undefined
              ? null
              : { x: 100, y: 10, w: 80, h: 20, unit: "px" as const },
          containerPath: [],
          parent: null,
          children: [],
          labelledBy: shape.labelledBy === undefined ? [] : [markup],
          tablePosition: null,
          capacity: null,
          confidence: 1,
          live: false,
          masked: false,
        },
        ...extras,
      ],
      roots: [],
      skeletonDigest: "sha256:0",
      stability: { settled: true, generation: 1, pendingReason: null },
      nativeDialog: null,
      inputIntercepted: false,
    },
    after: null,
    dispatched: true,
    faultKind: null,
  };
  return run as unknown as Parameters<typeof inferParameters>[0]["steps"][number];
}

/** A label node: a structural `StaticText` with wording and, optionally, geometry. `ariaRole` is
 *  `null` because that is what a driver reports for text that is not a control - and `nearestLabel`
 *  skips any candidate sharing the target's role, so a label that claimed to be a textbox would
 *  never be found. */
function staticText(
  id: string,
  name: string,
  bounds: { x: number; y: number; w: number; h: number; unit: "px" } | null,
) {
  return {
    id: id as never,
    rawRole: "StaticText",
    ariaRole: null,
    name,
    value: null,
    text: name,
    description: null,
    state: {
      disabled: false,
      focused: false,
      visible: true,
      checked: null,
      expanded: null,
      selected: null,
      required: null,
      invalid: null,
      readonly: null,
    },
    bounds,
    containerPath: [],
    parent: null,
    children: [],
    labelledBy: [],
    tablePosition: null,
    capacity: null,
    confidence: 1,
    live: false,
    masked: false,
  };
}
