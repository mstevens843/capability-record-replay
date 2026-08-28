// The three pieces of the cycle that are worth testing on their own: the settle loop, the lowering,
// and the per-instruction postconditions.
//
// Each of them is exercised end to end by `test/interpreter.test.ts` and by the browser suite, and
// each of them has behaviour those two cannot reach - a surface that never settles, a driver that
// cannot click, a field the taint model has blanked. A conformance corpus of whole runs would need
// a scenario apiece; a unit test needs three lines.

import {
  type EvalContext,
  MOCK_LEASE_TOKEN,
  MOCK_SURFACE_CAPABILITIES,
  MockSurface,
  type Observation,
  type PerceiveFault,
  type Predicate,
  type ProgramFacts,
  type ResolvedStep,
  type SettlePolicy,
  type Surface,
  type SurfaceCapabilities,
  type UINode,
  link,
} from "@crr/core";
import { describe, expect, it } from "vitest";
import { manualClock } from "../src/clock.js";
import { lowerInstruction } from "../src/lower.js";
import { verifyInstructionPostcondition } from "../src/postcondition.js";
import { settle } from "../src/settle.js";
import {
  IDS,
  MOCK_MEMBER_ID,
  mockAllowlist,
  mockArtifact,
  mockContract,
  mockTrust,
  screens,
} from "./fixtures/mock-flow.js";

const program = (() => {
  const result = link({
    contract: mockContract,
    artifact: mockArtifact(),
    capabilities: MOCK_SURFACE_CAPABILITIES,
    args: { memberId: MOCK_MEMBER_ID },
    mode: "replay",
    allowlist: mockAllowlist,
    trust: mockTrust,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.program;
})();

const facts: ProgramFacts = program.facts;
const ctxOf = (observation: Observation): EvalContext => ({
  observation,
  program: facts,
  bindings: program.bindings,
});
const POLICY: SettlePolicy = { stableSamples: 2, pollIntervalMs: 50, maxWaitMs: 500 };

/** A driver that can only fault. Simpler than scripting `MockSurface` into never describing a
 *  screen, and it is the settle LOOP under test here rather than the mock. */
async function settleFault(fault: PerceiveFault) {
  const clock = manualClock();
  const surface: Surface = {
    perceive: async () => ({ ok: false, fault }),
    act: async () => ({ ok: true, dispatched: true }),
    capture: async () => {
      throw new Error("not used");
    },
    capabilities: () => MOCK_SURFACE_CAPABILITIES,
  };
  return settle({
    surface,
    policy: POLICY,
    clock,
    chargeObservation: () => false,
    program: facts,
    bindings: program.bindings,
    perceiveDeadlineMs: 5_000,
  });
}

function settleOver(
  config: ConstructorParameters<typeof MockSurface>[0],
  policy: SettlePolicy = POLICY,
) {
  const clock = manualClock();
  return settle({
    surface: new MockSurface(config),
    policy,
    clock,
    chargeObservation: () => false,
    program: facts,
    bindings: program.bindings,
    perceiveDeadlineMs: 5_000,
  });
}

// ---------------------------------------------------------------------------------------------

describe("the settle loop", () => {
  it("returns as soon as enough consecutive skeletons agree and the driver agrees too", async () => {
    const outcome = await settleOver({ screens, start: "search" });
    expect(outcome.settled).toBe(true);
    expect(outcome.polls).toBe(2);
    expect(outcome.window).toHaveLength(2);
    expect(outcome.window[0]).toBe(outcome.window[1]);
  });

  it("spends its budget and gives up rather than waiting forever", async () => {
    // A surface that says it has not settled, forever. NOTHING here ends it except the budget,
    // which is the only honest way to model a spinner: waiting is a property of a checkpoint, and
    // the checkpoint has a budget.
    const unsettled = {
      ...screens.search,
      stability: { settled: false, generation: 1, pendingReason: "network" },
    } as Observation;
    const outcome = await settleOver({ screens: { ...screens, stuck: unsettled }, start: "stuck" });
    expect(outcome.settled).toBe(false);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(POLICY.maxWaitMs);
    // And it is bounded in polls too, not merely in claimed milliseconds.
    expect(outcome.polls).toBeLessThanOrEqual(POLICY.maxWaitMs / POLICY.pollIntervalMs + 2);
  });

  it("stops on the first poll when a NATIVE dialog is open", async () => {
    // A native dialog blocks the renderer, so polling for quiescence is waiting on a renderer that
    // is blocked precisely because we have not answered yet. The driver knows synchronously.
    const outcome = await settleOver({ screens, start: "search-dialog" });
    expect(outcome.polls).toBe(1);
    expect(outcome.observation?.nativeDialog?.type).toBe("confirm");
  });

  it("does NOT stop on the first poll for an in-page modal, which blocks nothing", async () => {
    // The other half of rule 3, and the half that used to be missing. An in-page panel is nodes in
    // a document that is still rendering; short-circuiting on it hands the classifier a screen that
    // has not settled, which was harmless while every interception was a hard failure and stopped
    // being harmless when `Checkpoint.dialog` made a declared dialog a POSTCONDITION. Measured
    // against the real fixture: 18 ms after the click that raises the confirmation panel, one
    // `perceive` returned the accessibility tree of the new document stitched to the frame tree of
    // the old one, and the checkpoint failed a step that had succeeded (SPEC section 3.3).
    const outcome = await settleOver({ screens, start: "search-notice" });
    expect(outcome.observation?.nativeDialog).toBeNull();
    expect(outcome.observation?.inputIntercepted).toBe(true);
    // It went through the ordinary quiescence loop, so `stableSamples` consecutive identical
    // skeletons were required before the classifier was handed anything.
    expect(outcome.polls).toBeGreaterThanOrEqual(POLICY.stableSamples);
    expect(outcome.settled).toBe(true);
  });

  it("refuses to call a screen settled while a declared busy indicator is showing", async () => {
    const busyWhen: Predicate = {
      kind: "node-exists",
      where: {
        role: "status",
        text: { mode: "exact", value: "1 record", normalize: "std.text@1" },
      },
    };
    const outcome = await settleOver({ screens, start: "results" }, { ...POLICY, busyWhen });
    // The digest is stable and the driver says settled; the artifact says otherwise and wins,
    // because a legacy app can be digest-stable for one poll interval in the middle of a swap.
    expect(outcome.settled).toBe(false);
  });

  it("ends immediately when the run's observation ledger is spent", async () => {
    const clock = manualClock();
    const outcome = await settle({
      surface: new MockSurface({ screens, start: "search" }),
      policy: POLICY,
      clock,
      chargeObservation: () => true,
      program: facts,
      bindings: program.bindings,
      perceiveDeadlineMs: 5_000,
    });
    expect(outcome.ledgerExhausted).toBe(true);
    expect(outcome.polls).toBe(0);
  });

  it("retries a transient perception fault inside the budget, and reports it when the budget runs out", async () => {
    // A frame that is on the page and not in the driver's tree. Transient in the real world - it is
    // what a frameset does for one poll interval mid-navigation, measured against the fixture - and
    // permanent here, so the loop has to be seen giving up rather than seen succeeding.
    const outcome = await settleFault({ kind: "unperceivable-container", detail: "subacct" });
    expect(outcome.fault?.kind).toBe("unperceivable-container");
    expect(outcome.polls).toBeGreaterThan(1);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(POLICY.maxWaitMs);
  });

  it("does not retry a perception timeout, because its own deadline already elapsed", async () => {
    // The condition behind one is a renderer blocked by an unanswered dialog, which does not clear
    // by waiting - so polling again spends the settle budget twice to reach the same answer.
    const outcome = await settleFault({ kind: "perceive-timeout", elapsedMs: 15_000 });
    expect(outcome.fault?.kind).toBe("perceive-timeout");
    expect(outcome.polls).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

const stepById = (id: string): ResolvedStep =>
  program.steps.find((s) => s.id === id) as ResolvedStep;

const nodeById = (observation: Observation, id: string): UINode =>
  observation.nodes.find((n) => n.id === id) as UINode;

describe("lowering an instruction to an action", () => {
  const base = {
    bindings: program.bindings,
    capabilities: MOCK_SURFACE_CAPABILITIES,
    ctx: ctxOf(screens.search as Observation),
    location: null,
  };

  it("lowers a fill to a type action that declares its own sensitivity from the BINDING", () => {
    const result = lowerInstruction({
      ...base,
      step: stepById("enter-member-id"),
      node: nodeById(screens.search as Observation, IDS.memberIdField),
    });
    expect(result).toEqual({
      ok: true,
      action: {
        kind: "type",
        target: IDS.memberIdField,
        text: MOCK_MEMBER_ID,
        mode: "replace",
        // Derived from the binding's taint handle, never from the step: the driver reads this to
        // blank the field's region before any screenshot bytes exist.
        sensitive: true,
      },
    });
  });

  it("lowers an activate to a click on a surface that can click", () => {
    const result = lowerInstruction({
      ...base,
      step: stepById("submit-search"),
      node: nodeById(screens.search as Observation, IDS.searchButton),
    });
    expect(result).toMatchObject({ ok: true, action: { kind: "click", target: IDS.searchButton } });
  });

  it("lowers the SAME activate to a key press on a surface that cannot click", () => {
    // The whole cross-surface claim in one assertion. The artifact says what the operator meant; the
    // surface says how that is done here, and the program does not change. A character grid
    // synthesizes its button from the F-key legend line and carries the key on the node.
    const grid: SurfaceCapabilities = {
      ...MOCK_SURFACE_CAPABILITIES,
      supportedActions: ["pressKey", "type", "navigate"],
    };
    const button = {
      ...nodeById(screens.search as Observation, IDS.searchButton),
      value: "F5",
    } as UINode;
    const result = lowerInstruction({
      ...base,
      capabilities: grid,
      step: stepById("submit-search"),
      node: button,
    });
    expect(result).toMatchObject({
      ok: true,
      action: { kind: "pressKey", target: IDS.searchButton, key: "F5" },
    });
  });

  it("refuses rather than guessing when the surface offers neither", () => {
    const nothing: SurfaceCapabilities = {
      ...MOCK_SURFACE_CAPABILITIES,
      supportedActions: ["navigate"],
    };
    const result = lowerInstruction({
      ...base,
      capabilities: nothing,
      step: stepById("submit-search"),
      node: nodeById(screens.search as Observation, IDS.searchButton),
    });
    expect(result.ok).toBe(false);
  });

  it("refuses to lower an instruction that dispatches nothing", () => {
    const read = { ...stepById("submit-search"), instruction: { kind: "read" } } as ResolvedStep;
    const result = lowerInstruction({ ...base, step: read, node: null });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.reason).toContain("dispatches nothing");
  });
});

// ---------------------------------------------------------------------------------------------

describe("the per-instruction postconditions", () => {
  const input = (step: ResolvedStep, observation: Observation) => ({
    step,
    ctx: ctxOf(observation),
    bindings: program.bindings,
    capabilities: MOCK_SURFACE_CAPABILITIES,
    disabledDescriptors: [],
  });

  it("passes when the field holds what was written", () => {
    expect(
      verifyInstructionPostcondition(
        input(stepById("enter-member-id"), screens["search-typed"] as Observation),
      ),
    ).toEqual({ ok: true });
  });

  it("catches the silent truncation a maxlength causes, which is the case it exists for", () => {
    // The failure with no error message: a five-character field takes four of six digits and the
    // flow then reports "no member found" for a member who exists.
    const result = verifyInstructionPostcondition(
      input(stepById("enter-member-id"), screens["search-truncated"] as Observation),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Lengths, never values: this string is journaled and read in an intervention brief.
    expect(result.note).toContain("4 characters and 5 were written");
    expect(result.note).not.toContain(MOCK_MEMBER_ID);
  });

  it("cannot check a masked field, passes, and says so - the taint model wins", () => {
    const result = verifyInstructionPostcondition(
      input(stepById("enter-member-id"), screens["search-typed-masked"] as Observation),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toContain("masked");
    expect(result.warning).toContain("would not be detected");
  });

  it("checks that a navigate arrived where it said it would", () => {
    expect(
      verifyInstructionPostcondition(input(stepById("open-search"), screens.search as Observation)),
    ).toEqual({ ok: true });
    const elsewhere = verifyInstructionPostcondition(
      input(stepById("open-search"), screens.results as Observation),
    );
    expect(elsewhere.ok).toBe(false);
  });

  it("has nothing to add for an activate, because only the artifact knows what a click was for", () => {
    expect(
      verifyInstructionPostcondition(
        input(stepById("submit-search"), screens.results as Observation),
      ),
    ).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------------------------

describe("the mock surface is driven the way the interpreter drives it", () => {
  it("refuses an action presented with the wrong lease token", async () => {
    const surface = new MockSurface({ screens, start: "search", lease: MOCK_LEASE_TOKEN });
    const result = await surface.act({ kind: "click", target: IDS.searchButton }, "wrong" as never);
    // The third placement of the control model, and the only one a gate upstairs cannot see: an
    // executor that skipped both other checks still cannot act.
    expect(result).toEqual({ ok: false, fault: { kind: "lease-not-held" } });
  });
});
