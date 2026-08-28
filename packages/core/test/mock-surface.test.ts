// The port, and the driver that makes everything above it testable.
//
// Two kinds of test live here. The first kind asserts the mock is a real driver rather than a
// puppet: it refuses a disabled node, refuses a stale lease, refuses to click through a native
// dialog, and truncates at the field's capacity. Every one of those is a refusal a browser would
// have made, and a mock that skipped them would let a downstream unit prove something no surface
// would ever have permitted.
//
// The second kind is the nine-step run. It is written as the interpreter's cycle in miniature -
// observe, act, settle - because the thing being proved is not that a mock returns objects, it is
// that a settle loop driven only by this port can walk a whole flow through a native dialog, an
// unsettled screen, a torn read and an interstitial modal and arrive at the right record.

import { describe, expect, it } from "vitest";
import {
  type ActFault,
  type Action,
  LeaseTokenSchema,
  MOCK_LEASE_TOKEN,
  MockSurface,
  MockSurfaceScriptError,
  type MockTransition,
  type NodeId,
  type Observation,
  type Surface,
  skeletonDigestOf,
  tearObservation,
} from "../src/index.js";
import {
  IDS,
  SUBJECT_MEMBER_ID,
  corebankScreens,
  results,
  resultsTorn,
  searchForm,
} from "./fixtures/corebank-observations.js";

const DEADLINE = { deadlineMs: 5_000 } as const;

// ---------------------------------------------------------------------------------------------
// A settle loop, written here rather than in `src` because waiting belongs to the runtime
// ---------------------------------------------------------------------------------------------

interface SettleOutcome {
  readonly settled: boolean;
  readonly observation: Observation | null;
  readonly polls: number;
  /** Every skeleton the loop looked at, so a test can assert what it saw AND did not believe. */
  readonly perceived: readonly string[];
}

/**
 * Poll until `stableSamples` consecutive observations carry the same skeleton and the surface says
 * it has settled, or the poll budget is spent.
 *
 * There is no sleep here and there is none in the interpreter either: a recorded delay encodes the
 * recording machine's load into the artifact forever. Waiting is a budget, not an instruction.
 */
async function settle(
  surface: Surface,
  { stableSamples = 2, maxPolls = 12 }: { stableSamples?: number; maxPolls?: number } = {},
): Promise<SettleOutcome> {
  const perceived: string[] = [];
  let previous: Observation | null = null;
  let run = 0;
  for (let poll = 1; poll <= maxPolls; poll++) {
    const result = await surface.perceive(DEADLINE);
    if (!result.ok) {
      previous = null;
      run = 0;
      continue;
    }
    const observation = result.observation;
    perceived.push(observation.skeletonDigest);
    run = previous !== null && previous.skeletonDigest === observation.skeletonDigest ? run + 1 : 1;
    previous = observation;
    if (run >= stableSamples && observation.stability.settled) {
      return { settled: true, observation, polls: poll, perceived };
    }
  }
  return { settled: false, observation: previous, polls: maxPolls, perceived };
}

const click = (target: NodeId): Action => ({ kind: "click", target });

// ---------------------------------------------------------------------------------------------
// The scripted nine-step run
// ---------------------------------------------------------------------------------------------

const RIVERBEND_TRANSITIONS: readonly MockTransition[] = [
  { from: "blank", on: { kind: "navigate", path: "/members/search" }, to: "search-form" },
  { from: "search-form", on: { kind: "focus", target: IDS.memberIdField } },
  { from: "search-form", on: { kind: "type", target: IDS.memberIdField } },
  // The legacy app confirms before it submits, natively. The tree does not change; the dialog
  // channel does.
  { from: "search-form", on: { kind: "click", target: IDS.searchButton }, to: "search-confirm" },
  {
    from: "search-confirm",
    on: { kind: "dismissDialog" },
    to: "results-notice",
    // One unsettled frame, then one TORN frame that claims to be settled, then the real screen.
    // `stableSamples: 2` is the whole defence against the middle one.
    via: [
      { kind: "screen", screen: "searching" },
      { kind: "screen", screen: "results-torn" },
    ],
  },
  { from: "results-notice", on: { kind: "click", target: IDS.noticeOk }, to: "results" },
  {
    from: "results",
    on: { kind: "click", target: IDS.selectLink },
    to: "detail",
    via: [{ kind: "screen", screen: "detail-loading", times: 2 }],
  },
  { from: "detail", on: { kind: "setChecked", target: IDS.includeClosed, checked: false } },
  { from: "detail", on: { kind: "click", target: IDS.applyButton }, to: "detail-open-shares" },
];

const riverbend = (): MockSurface =>
  new MockSurface({
    screens: corebankScreens,
    start: "blank",
    transitions: RIVERBEND_TRANSITIONS,
  });

interface ScriptedStep {
  readonly title: string;
  readonly action: Action;
  readonly screen: string;
  readonly check?: (observation: Observation) => void;
}

const nameOf = (observation: Observation, id: NodeId): string | undefined =>
  observation.nodes.find((node) => node.id === id)?.name;
const valueIn = (observation: Observation, id: NodeId): string | null | undefined =>
  observation.nodes.find((node) => node.id === id)?.value;
const rowsOf = (observation: Observation, table: string): number =>
  observation.nodes.filter((node) => node.ariaRole === "row" && node.parent === (table as NodeId))
    .length;

const NINE_STEPS: readonly ScriptedStep[] = [
  {
    title: "open the member search screen",
    action: {
      kind: "navigate",
      route: { originAlias: "corebank", path: "/members/search", query: {}, frame: "content" },
    },
    screen: "search-form",
    check: (o) => expect(o.route?.path).toBe("/members/search"),
  },
  {
    title: "focus the member id field",
    action: { kind: "focus", target: IDS.memberIdField },
    screen: "search-form",
    check: (o) => expect(o.nodes.find((n) => n.id === IDS.memberIdField)?.state.focused).toBe(true),
  },
  {
    title: "type the member number",
    action: {
      kind: "type",
      target: IDS.memberIdField,
      text: SUBJECT_MEMBER_ID,
      mode: "replace",
      sensitive: true,
    },
    screen: "search-form",
    check: (o) => expect(valueIn(o, IDS.memberIdField)).toBe(SUBJECT_MEMBER_ID),
  },
  {
    title: "run the search, which raises a native confirm",
    action: click(IDS.searchButton),
    screen: "search-confirm",
    check: (o) => {
      expect(o.nativeDialog?.type).toBe("confirm");
      expect(o.inputIntercepted).toBe(true);
      // The typed value survived the interruption: it is the same field, on the same screen.
      expect(valueIn(o, IDS.memberIdField)).toBe(SUBJECT_MEMBER_ID);
    },
  },
  {
    title: "dismiss the confirm and wait out the load",
    action: { kind: "dismissDialog" },
    screen: "results-notice",
    check: (o) => {
      expect(o.nativeDialog).toBeNull();
      expect(rowsOf(o, "table:results")).toBe(2);
      expect(nameOf(o, IDS.noticeOk)).toBe("OK");
    },
  },
  {
    title: "dismiss the interstitial system notice",
    action: click(IDS.noticeOk),
    screen: "results",
    check: (o) => expect(o.nodes.some((n) => n.id === IDS.noticeDialog)).toBe(false),
  },
  {
    title: "open the matching member's record",
    action: click(IDS.selectLink),
    screen: "detail",
    check: (o) => {
      // Canonicalized: an observation never carries a member number in a path.
      expect(o.route?.path).toBe("/members/:memberId");
      expect(nameOf(o, IDS.detailHeading)).toContain(SUBJECT_MEMBER_ID);
      expect(rowsOf(o, "table:shares")).toBe(4);
    },
  },
  {
    title: "untick include-closed-shares",
    action: { kind: "setChecked", target: IDS.includeClosed, checked: false },
    screen: "detail",
    check: (o) =>
      expect(o.nodes.find((n) => n.id === IDS.includeClosed)?.state.checked).toBe(false),
  },
  {
    title: "apply the filter and read the savings balance",
    action: click(IDS.applyButton),
    screen: "detail-open-shares",
    check: (o) => {
      expect(rowsOf(o, "table:shares")).toBe(3);
      expect(valueIn(o, IDS.memberNameField)).toBe("AVERY SYNTHETIC");
      const savings = o.nodes.find((n) => n.id === IDS.savingsBalanceCell);
      expect(savings?.tablePosition?.colHeader).toBe("Current Balance");
      expect(savings?.name).toBe("1,284.55");
    },
  },
];

describe("a scripted nine-step run", () => {
  it("walks the whole flow through a native dialog, an unsettled screen, a torn read and a modal", async () => {
    const surface = riverbend();

    const entry = await settle(surface);
    expect(entry.observation?.route?.path).toBe("/");

    const visited: string[] = [];
    for (const step of NINE_STEPS) {
      const dispatched = await surface.act(step.action, MOCK_LEASE_TOKEN);
      expect(dispatched, `step "${step.title}" was refused`).toEqual({
        ok: true,
        dispatched: true,
      });

      const outcome = await settle(surface);
      expect(outcome.settled, `step "${step.title}" never settled`).toBe(true);
      const observation = outcome.observation;
      if (observation === null) throw new Error("settled with no observation");

      expect(surface.screen).toBe(step.screen);
      step.check?.(observation);
      visited.push(step.screen);
    }

    expect(visited).toHaveLength(9);
    expect(surface.dispatched).toHaveLength(9);
    expect(surface.dispatched.every((d) => d.result.ok)).toBe(true);
    // Every perception was bounded, and the whole run stayed well inside the artifact's
    // `maxObservations: 200`. Settling is a budget, and this is what the budget is spent on.
    expect(surface.deadlines.every((ms) => ms > 0)).toBe(true);
    expect(surface.deadlines.length).toBeLessThan(200);
  });

  it("never settles on the torn frame, because a single frame cannot make a run of two", async () => {
    const surface = riverbend();
    for (const step of NINE_STEPS.slice(0, 4)) {
      await surface.act(step.action, MOCK_LEASE_TOKEN);
      await settle(surface);
    }

    // Step five: dismiss the confirm, then watch an unsettled frame, a TORN frame that claims to
    // be settled, and finally the real screen go past.
    await surface.act(NINE_STEPS[4]!.action, MOCK_LEASE_TOKEN);
    const outcome = await settle(surface);

    expect(outcome.perceived, "the torn frame was never even perceived").toContain(
      resultsTorn.skeletonDigest,
    );
    expect(outcome.settled).toBe(true);
    expect(outcome.observation?.skeletonDigest).not.toBe(resultsTorn.skeletonDigest);
    expect(outcome.observation?.nodes.some((node) => node.ariaRole === "row")).toBe(true);
  });

  it("dispatches only actions the surface advertises", async () => {
    const surface = riverbend();
    for (const step of NINE_STEPS) {
      await surface.act(step.action, MOCK_LEASE_TOKEN);
      await settle(surface);
    }
    const advertised = surface.capabilities().supportedActions;
    for (const record of surface.dispatched) {
      expect(advertised).toContain(record.action.kind);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------------------------

describe("the Surface port", () => {
  it("is satisfied by the mock", () => {
    const port: Surface = riverbend();
    expect(typeof port.perceive).toBe("function");
    expect(typeof port.act).toBe("function");
    expect(typeof port.capture).toBe("function");
    expect(port.capabilities().driver).toBe("mock-surface@0.1.0");
  });

  it("refuses to perceive without a bounded deadline", async () => {
    const surface = riverbend();
    // The deadline is not decoration. An open native dialog makes the underlying call hang rather
    // than fail, and a hang has no failure class - so a caller that forgets it is a bug, loudly.
    await expect(surface.perceive({ deadlineMs: 0 })).rejects.toBeInstanceOf(
      MockSurfaceScriptError,
    );
  });

  it("stamps a monotonic seq that no fixture can override", async () => {
    const surface = riverbend();
    const seqs: number[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await surface.perceive(DEADLINE);
      if (result.ok) seqs.push(result.observation.seq);
    }
    expect(seqs).toEqual([0, 1, 2, 3]);
  });

  it("hands out observations that cannot be mutated", async () => {
    const surface = riverbend();
    const result = await surface.perceive(DEADLINE);
    if (!result.ok) throw new Error("expected an observation");
    expect(Object.isFrozen(result.observation)).toBe(true);
    expect(Object.isFrozen(result.observation.nodes)).toBe(true);
    expect(() => {
      (result.observation as { seq: number }).seq = 99;
    }).toThrow();
  });

  it("validates the corpus it is given", () => {
    expect(
      () =>
        new MockSurface({
          screens: { bad: { ...searchForm, seq: -1 } as Observation },
          start: "bad",
        }),
    ).toThrow();
  });

  it("names the screen it cannot find", async () => {
    const surface = new MockSurface({ screens: corebankScreens, start: "blank" });
    expect(() => surface.goto("nowhere")).toThrow(/unknown screen "nowhere"/);
  });
});

// ---------------------------------------------------------------------------------------------
// The refusals a real driver makes
// ---------------------------------------------------------------------------------------------

describe("mechanical refusals", () => {
  const surfaceOn = (start: string, transitions: readonly MockTransition[] = []): MockSurface =>
    new MockSurface({ screens: corebankScreens, start, transitions });

  it("checks the lease before it looks at the action at all", async () => {
    const surface = surfaceOn("search-form");
    const stale = LeaseTokenSchema.parse("someone-elses-lease");
    // A node that does not exist, under a token that is not held: the answer must be about the
    // lease. A driver that reported `node-gone` here would have told a controller it does not
    // recognise what is and is not on the screen.
    const result = await surface.act(click("button:does-not-exist" as NodeId), stale);
    expect(result).toEqual({ ok: false, fault: { kind: "lease-not-held" } });
  });

  it("refuses every action once the lease is revoked", async () => {
    const surface = surfaceOn("search-form", [
      { on: { kind: "focus", target: IDS.memberIdField } },
    ]);
    expect(
      await surface.act({ kind: "focus", target: IDS.memberIdField }, MOCK_LEASE_TOKEN),
    ).toEqual({ ok: true, dispatched: true });
    surface.revokeLease();
    expect(
      await surface.act({ kind: "focus", target: IDS.memberIdField }, MOCK_LEASE_TOKEN),
    ).toEqual({ ok: false, fault: { kind: "lease-not-held" } });
    surface.grantLease(MOCK_LEASE_TOKEN);
    expect(
      await surface.act({ kind: "focus", target: IDS.memberIdField }, MOCK_LEASE_TOKEN),
    ).toEqual({ ok: true, dispatched: true });
  });

  it("reports node-gone for a node this observation does not have", async () => {
    const surface = surfaceOn("search-form");
    const result = await surface.act(click(IDS.applyButton), MOCK_LEASE_TOKEN);
    expect(result).toEqual({
      ok: false,
      fault: { kind: "node-gone", nodeId: IDS.applyButton },
    });
  });

  it("refuses a disabled control however the script feels about it", async () => {
    // `searching` disables the search button. The transition says the click works; the driver says
    // it does not, and the driver is the one modelling reality.
    const surface = surfaceOn("searching", [
      { on: { kind: "click", target: IDS.searchButton }, to: "results" },
    ]);
    const result = await surface.act(click(IDS.searchButton), MOCK_LEASE_TOKEN);
    expect(result).toEqual({
      ok: false,
      fault: { kind: "not-actionable", nodeId: IDS.searchButton, why: "disabled" },
    });
    expect(surface.screen).toBe("searching");
  });

  it("will not click through a native dialog", async () => {
    const surface = surfaceOn("search-confirm");
    const result = await surface.act(click(IDS.searchButton), MOCK_LEASE_TOKEN);
    expect(result).toEqual({
      ok: false,
      fault: { kind: "intercepted", nodeId: IDS.searchButton },
    });
  });

  it("closes the dialog it was asked to close, even when the screen stays put", async () => {
    // Entering a screen opens the dialog that screen declares. A dismiss that stayed on the same
    // screen and then re-entered it would silently re-raise the dialog - the remedy would run, the
    // detector would fire again, and the budget would burn down against a bug in the driver.
    const surface = surfaceOn("search-confirm", [
      { on: { kind: "dismissDialog" }, to: "search-confirm" },
    ]);
    expect(await surface.act({ kind: "dismissDialog" }, MOCK_LEASE_TOKEN)).toEqual({
      ok: true,
      dispatched: true,
    });
    const result = await surface.perceive(DEADLINE);
    if (!result.ok) throw new Error("expected an observation");
    expect(result.observation.nativeDialog).toBeNull();
    expect(result.observation.inputIntercepted).toBe(false);
  });

  it("will not accept a dialog that is not there", async () => {
    const surface = surfaceOn("search-form");
    const result = await surface.act({ kind: "acceptDialog", text: null }, MOCK_LEASE_TOKEN);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.fault.kind).toBe("surface-error");
  });

  it("truncates a fill at the field's capacity, which is how a legacy input loses a digit", async () => {
    const surface = surfaceOn("search-form", [{ on: { kind: "type", target: IDS.memberIdField } }]);
    await surface.act(
      {
        kind: "type",
        target: IDS.memberIdField,
        text: "500010000099999",
        mode: "replace",
        sensitive: true,
      },
      MOCK_LEASE_TOKEN,
    );
    const result = await surface.perceive(DEADLINE);
    if (!result.ok) throw new Error("expected an observation");
    const field = result.observation.nodes.find((node) => node.id === IDS.memberIdField);
    expect(field?.capacity).toBe(10);
    // Fifteen characters went in; ten came back. The postcondition on `fill` exists for exactly
    // this, and a mock that echoed all fifteen would have hidden it.
    expect(field?.value).toBe("5000100000");
  });

  it("throws rather than silently no-oping an action the script never anticipated", async () => {
    const surface = surfaceOn("search-form");
    await expect(surface.act(click(IDS.searchButton), MOCK_LEASE_TOKEN)).rejects.toBeInstanceOf(
      MockSurfaceScriptError,
    );
  });

  it("can be told to refuse everything instead", async () => {
    const fault: ActFault = { kind: "surface-error", message: "the app is down" };
    const surface = new MockSurface({
      screens: corebankScreens,
      start: "search-form",
      unscripted: { fault },
    });
    expect(await surface.act(click(IDS.searchButton), MOCK_LEASE_TOKEN)).toEqual({
      ok: false,
      fault,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The three conditions the mock exists to be able to reproduce
// ---------------------------------------------------------------------------------------------

describe("a step that does not settle", () => {
  const stalling = () =>
    new MockSurface({
      screens: corebankScreens,
      start: "search-form",
      transitions: [
        {
          on: { kind: "click", target: IDS.searchButton },
          via: [{ kind: "stall", screen: "searching" }],
        },
      ],
    });

  it("keeps returning an unsettled screen until the budget gives up", async () => {
    const surface = stalling();
    expect(await surface.act(click(IDS.searchButton), MOCK_LEASE_TOKEN)).toEqual({
      ok: true,
      dispatched: true,
    });

    const outcome = await settle(surface, { maxPolls: 8 });
    expect(outcome.settled).toBe(false);
    expect(outcome.polls).toBe(8);
    expect(outcome.observation?.stability.settled).toBe(false);
    expect(outcome.observation?.stability.pendingReason).toBe("network");
  });

  it("is ended by the budget and by nothing else - the digests are perfectly stable", async () => {
    const surface = stalling();
    await surface.act(click(IDS.searchButton), MOCK_LEASE_TOKEN);
    const digests = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const result = await surface.perceive(DEADLINE);
      if (result.ok) digests.add(result.observation.skeletonDigest);
    }
    // A spinner whose skeleton never changes is indistinguishable from a settled screen by digest
    // alone. `stability.settled` is the only thing that separates them, which is why the surface
    // owns that field and the program does not.
    expect(digests.size).toBe(1);
  });
});

describe("a torn read", () => {
  it("claims to be settled while missing most of the screen", () => {
    expect(results.stability.settled).toBe(true);
    expect(resultsTorn.stability.settled).toBe(true);
    expect(resultsTorn.nodes.length).toBeLessThan(results.nodes.length);
    expect(resultsTorn.nodes.some((node) => node.ariaRole === "row")).toBe(false);
    expect(resultsTorn.skeletonDigest).not.toBe(results.skeletonDigest);
  });

  it("leaves no dangling links behind, because a half-painted screen is consistent, not corrupt", () => {
    const present = new Set(resultsTorn.nodes.map((node) => node.id));
    for (const node of resultsTorn.nodes) {
      if (node.parent !== null) expect(present.has(node.parent)).toBe(true);
      for (const child of node.children) expect(present.has(child)).toBe(true);
      for (const label of node.labelledBy) expect(present.has(label)).toBe(true);
    }
    for (const root of resultsTorn.roots) expect(present.has(root)).toBe(true);
  });

  it("can drop the route too, which is what the terminal spike measured", () => {
    const torn = tearObservation(results, { keep: [IDS.root], route: "drop" });
    expect(torn.route).toBeNull();
    expect(torn.nodes).toHaveLength(1);
  });

  it("IS believed by a settle loop of one sample, which is the whole argument for two", async () => {
    // The counter-test to the nine-step run. Nothing about a torn observation announces itself:
    // it says `settled: true`, it is internally consistent, and a loop that accepts the first
    // settled frame accepts it. SPEC leaves `stableSamples` at a placeholder of 2 pending
    // measurement; this is the shape of what that measurement is measuring.
    const surface = riverbend();
    for (const step of NINE_STEPS.slice(0, 4)) {
      await surface.act(step.action, MOCK_LEASE_TOKEN);
      await settle(surface);
    }
    await surface.act(NINE_STEPS[4]!.action, MOCK_LEASE_TOKEN);

    const credulous = await settle(surface, { stableSamples: 1 });
    expect(credulous.settled).toBe(true);
    expect(credulous.observation?.skeletonDigest).toBe(resultsTorn.skeletonDigest);
    // And it would have reported zero rows for a member who plainly has one.
    expect(credulous.observation?.nodes.some((node) => node.ariaRole === "row")).toBe(false);
  });

  it("is served by the mock as an ordinary observation - nothing marks it as torn", async () => {
    const surface = new MockSurface({
      screens: corebankScreens,
      start: "results",
      transitions: [
        {
          on: { kind: "click", target: IDS.selectLink },
          to: "results",
          via: [{ kind: "screen", screen: "results-torn" }],
          bumpsGeneration: false,
        },
      ],
    });
    await surface.act(click(IDS.selectLink), MOCK_LEASE_TOKEN);
    const first = await surface.perceive(DEADLINE);
    if (!first.ok) throw new Error("expected an observation");
    expect(first.observation.stability.settled).toBe(true);
    expect(first.observation.nodes).toHaveLength(resultsTorn.nodes.length);
  });
});

describe("scripted perception faults", () => {
  it("reports the deadline it was actually given", async () => {
    const surface = new MockSurface({
      screens: corebankScreens,
      start: "search-form",
      transitions: [
        {
          on: { kind: "click", target: IDS.searchButton },
          to: "search-confirm",
          via: [{ kind: "fault", fault: { kind: "perceive-timeout", elapsedMs: 0 } }],
        },
      ],
    });
    await surface.act(click(IDS.searchButton), MOCK_LEASE_TOKEN);
    const result = await surface.perceive({ deadlineMs: 4_000 });
    expect(result).toEqual({
      ok: false,
      fault: { kind: "perceive-timeout", elapsedMs: 4_000 },
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Scripting mechanics
// ---------------------------------------------------------------------------------------------

describe("scripting", () => {
  it("fires a `once` transition exactly once and then falls through", async () => {
    const surface = new MockSurface({
      screens: corebankScreens,
      start: "search-form",
      transitions: [
        { on: { kind: "click", target: IDS.searchButton }, to: "results-notice", once: true },
        { on: { kind: "click", target: IDS.searchButton }, to: "results" },
      ],
    });
    await surface.act(click(IDS.searchButton), MOCK_LEASE_TOKEN);
    expect(surface.screen).toBe("results-notice");
    surface.goto("search-form");
    await surface.act(click(IDS.searchButton), MOCK_LEASE_TOKEN);
    expect(surface.screen).toBe("results");
  });

  it("models the click that dispatched and changed nothing", async () => {
    const surface = new MockSurface({
      screens: corebankScreens,
      start: "results",
      transitions: [{ on: { kind: "click", target: IDS.selectLink }, bumpsGeneration: false }],
    });
    const before = await surface.perceive(DEADLINE);
    await surface.act(click(IDS.selectLink), MOCK_LEASE_TOKEN);
    const after = await surface.perceive(DEADLINE);
    if (!before.ok || !after.ok) throw new Error("expected observations");
    // Same skeleton, same generation, different seq. This is the one failure that is otherwise
    // indistinguishable from success, and the only thing that catches it is the delta assertion.
    expect(after.observation.skeletonDigest).toBe(before.observation.skeletonDigest);
    expect(after.observation.stability.generation).toBe(before.observation.stability.generation);
    expect(after.observation.seq).toBeGreaterThan(before.observation.seq);
  });

  it("lets a human move the surface out of band, which is what an intervention looks like", async () => {
    const surface = new MockSurface({ screens: corebankScreens, start: "detail" });
    const before = await surface.perceive(DEADLINE);
    surface.goto("search-form");
    const after = await surface.perceive(DEADLINE);
    if (!before.ok || !after.ok) throw new Error("expected observations");
    expect(before.observation.route?.path).toBe("/members/:memberId");
    // A resume that continued blindly from here would act on the wrong screen entirely. This is
    // the whole argument for re-verifying the precondition after a handoff.
    expect(after.observation.route?.path).toBe("/members/search");
    expect(surface.dispatched).toHaveLength(0);
  });

  it("advertises a narrowed surface when the point is the narrowing", () => {
    const surface = new MockSurface({
      screens: corebankScreens,
      start: "blank",
      capabilities: { kind: "terminal", boundsUnit: "cell", resolvableDescriptors: ["role-name"] },
    });
    expect(surface.capabilities().kind).toBe("terminal");
    expect(surface.capabilities().resolvableDescriptors).toEqual(["role-name"]);
    // Everything not overridden is still there, so a narrowing test narrows one thing.
    expect(surface.capabilities().supportedActions).toContain("click");
  });
});

// ---------------------------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------------------------

describe("capture", () => {
  it("is evidence only, and masking reaches the bytes rather than the metadata", async () => {
    const surface = new MockSurface({ screens: corebankScreens, start: "detail" });
    const clean = await surface.capture({ maskRegions: [], format: "image" });
    const masked = await surface.capture({
      maskRegions: [{ x: 160, y: 96, w: 240, h: 24 }],
      format: "image",
    });
    expect(masked.maskedRegions).toBe(1);
    expect(masked.digest).not.toBe(clean.digest);
    expect(surface.captures).toHaveLength(2);
  });

  it("refuses a format it does not advertise", async () => {
    const surface = new MockSurface({
      screens: corebankScreens,
      start: "detail",
      capabilities: { canCapture: ["text-grid"] },
    });
    await expect(surface.capture({ maskRegions: [], format: "image" })).rejects.toBeInstanceOf(
      MockSurfaceScriptError,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The skeleton digest, which is a shared driver obligation rather than shared prose
// ---------------------------------------------------------------------------------------------

describe("skeletonDigestOf", () => {
  it("ignores geometry, because a reflow is not a change of state", () => {
    const moved = searchForm.nodes.map((node) =>
      node.bounds === null ? node : { ...node, bounds: { ...node.bounds, x: node.bounds.x + 7 } },
    );
    expect(skeletonDigestOf(moved)).toBe(skeletonDigestOf(searchForm.nodes));
  });

  it("ignores live nodes, so a clock in a header cannot make a surface permanently unsettled", () => {
    const withClock = [
      ...searchForm.nodes,
      { ...searchForm.nodes[0]!, id: "text:clock" as NodeId, name: "14:03:22", live: true },
    ];
    expect(skeletonDigestOf(withClock)).toBe(skeletonDigestOf(searchForm.nodes));
  });

  it("notices a raw-role change even when every accessible name is identical", () => {
    // The data grid degrading into a layout table keeps every name it had. If the skeleton could
    // not see that, the settle loop would call a structurally different screen unchanged.
    const degraded = searchForm.nodes.map((node) =>
      node.id === IDS.searchButton ? { ...node, rawRole: "LayoutTableCell" } : node,
    );
    expect(degraded.map((n) => n.name)).toEqual(searchForm.nodes.map((n) => n.name));
    expect(skeletonDigestOf(degraded)).not.toBe(skeletonDigestOf(searchForm.nodes));
  });

  it("notices a state change, which is how a field going invalid becomes visible", () => {
    const invalid = searchForm.nodes.map((node) =>
      node.id === IDS.memberIdField ? { ...node, state: { ...node.state, invalid: true } } : node,
    );
    expect(skeletonDigestOf(invalid)).not.toBe(skeletonDigestOf(searchForm.nodes));
  });
});
