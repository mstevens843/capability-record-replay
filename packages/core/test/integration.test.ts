// One turn of the replay cycle, composed from every unit in the package.
//
// Seven units were built in parallel against SPEC section 11's build order, and each shipped its
// own tests. Those tests prove each unit is right about its own job. None of them proves the units
// FIT: that the linker's `ProgramFacts` are the ones the classifier reads, that the resolver's
// result drops into `GateFacts.target` with no adapter, that an `Observation` the mock hands out
// satisfies the validator that the browser driver's output will have to satisfy, and that the
// action the policy engine authorized is the one the surface is then given.
//
// Those four seams are where parallel work actually breaks, and every one of them is a place where
// two agents wrote to the same spec sentence from opposite sides. So this file walks the cycle SPEC
// section 1.1 lists - observe → classify(pre) → resolve → policy → act → settle → classify(post) -
// over the scripted mock, using nothing but the package's public barrel.
//
// WHAT THIS IS NOT. It is not the interpreter. There is no settle CLOCK here, no retry loop, no
// journal and no lease authority; those are `@crr/runtime`'s and they need the things this package
// refuses to have. Where the interpreter would own a few lines, this file writes them out in the
// open and says so, because the point is to exercise the seams rather than to grow a second
// executor inside the pure package.

import { describe, expect, it } from "vitest";
import {
  type Action,
  type Allowlist,
  type ClassifierInput,
  type EvalContext,
  type GateFacts,
  type LeaseSnapshot,
  type LinkedProgram,
  MOCK_LEASE_TOKEN,
  MOCK_SURFACE_CAPABILITIES,
  MockSurface,
  type MockTransition,
  type NodeId,
  type Observation,
  type PolicyContext,
  type PolicyMoment,
  type ResolvedStep,
  type TargetOutcome,
  type TargetResolutionResult,
  type Verdict,
  bindingFor,
  check,
  classify,
  link,
  parseObservation,
  renderTarget,
  resolveTarget,
  skeletonDigestOf,
} from "../src/index.js";
import { IDS, SUBJECT_MEMBER_ID, corebankScreens } from "./fixtures/corebank-observations.js";
import { memberLookupArtifact, memberLookupContract } from "./fixtures/member-lookup.js";

// ---------------------------------------------------------------------------------------------
// The seam that has no runtime, asserted at compile time
// ---------------------------------------------------------------------------------------------

/**
 * The resolver's whole union is what the classifier's gate takes - not just the resolved arm.
 *
 * This line is the assertion; it has no runtime behaviour and is not supposed to. `tsc --noEmit`
 * fails on it the moment unit 4 and unit 5 disagree again about the name of the discriminant or
 * about which of the five statuses exist, which is a failure this file can produce in a second
 * rather than one that waits for the interpreter to be written.
 */
const seam: (result: TargetResolutionResult) => TargetOutcome = (result) => result;

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

const allowlist: Allowlist = {
  originAliases: ["corebank"],
  routes: [
    { originAlias: "corebank", pathPattern: "/members/search", maxEffect: "READ" },
    { originAlias: "corebank", pathPattern: "/members/:memberId", maxEffect: "READ" },
  ],
  actionKinds: ["click", "type", "navigate", "pressKey", "acceptDialog", "dismissDialog"],
  maxEffect: "READ",
  discoveryMaxEffect: "READ",
};

/** The base artifact, not the Summit overlay: the mock is scripted as the Riverbend tenant, which
 *  mounts the product at `/members/...`. Linking the overlay here would be linking one tenant's
 *  program against another tenant's screens, which no test should ever pass. */
function linkedProgram(): LinkedProgram {
  const result = link({
    contract: memberLookupContract,
    artifact: memberLookupArtifact,
    overlay: null,
    capabilities: MOCK_SURFACE_CAPABILITIES,
    args: { memberId: SUBJECT_MEMBER_ID },
    invocation: {
      name: memberLookupContract.name,
      version: memberLookupContract.version,
      contractDigest: memberLookupContract.digest,
    },
    mode: "replay",
    allowlist,
    trust: {
      trustedKeyIds: ["ops-approval-key-1"],
      // Whether the ed25519 bytes verify is injected (SPEC section 10 check 27); WHICH digest was
      // signed is the document question, and the linker still owns that half.
      verifySignature: () => true,
    },
  });
  if (!result.ok) throw new Error(`the fixture does not link: ${JSON.stringify(result.errors)}`);
  return result.program;
}

const TRANSITIONS: readonly MockTransition[] = [
  { from: "blank", on: { kind: "navigate", path: "/members/search" }, to: "search-form" },
  { from: "search-form", on: { kind: "type", target: IDS.memberIdField } },
  // The legacy app confirms natively before it submits. The tree does not change; the dialog
  // channel does - which is exactly what the step's declared `native-dialog` recovery is for.
  { from: "search-form", on: { kind: "click", target: IDS.searchButton }, to: "search-confirm" },
];

const surface = (): MockSurface =>
  new MockSurface({ screens: corebankScreens, start: "blank", transitions: TRANSITIONS });

// ---------------------------------------------------------------------------------------------
// The four lines the interpreter owns, written out here because it does not exist yet
// ---------------------------------------------------------------------------------------------

/** Poll until two consecutive skeletons agree and the driver says it has settled. No sleep: a
 *  recorded delay would encode the recording machine's load into the artifact forever. */
async function settle(
  s: MockSurface,
): Promise<{ observation: Observation; window: readonly string[] }> {
  const window: string[] = [];
  for (let poll = 0; poll < 12; poll++) {
    const result = await s.perceive({ deadlineMs: 5_000 });
    if (!result.ok) continue;
    window.push(result.observation.skeletonDigest);
    const stable = window.length >= 2 && window.at(-1) === window.at(-2);
    if (stable && result.observation.stability.settled) {
      return { observation: result.observation, window };
    }
  }
  throw new Error("the mock never settled");
}

/** The step's instruction plus the node resolution chose, as one dispatchable action. */
function actionFor(step: ResolvedStep, node: NodeId | null, program: LinkedProgram): Action {
  switch (step.instruction.kind) {
    case "navigate": {
      const route = step.route;
      if (route === null) throw new Error("a navigate step must carry a route");
      return {
        kind: "navigate",
        route: { originAlias: route.originAlias, path: route.path, query: {}, frame: "content" },
      };
    }
    case "fill": {
      const binding = bindingFor(step.instruction.value, program.bindings);
      if (binding === null) throw new Error("the fill step's value is unbound");
      if (node === null) throw new Error("a fill step must have resolved a node");
      return {
        kind: "type",
        target: node,
        text: binding.value,
        mode: "replace",
        sensitive: binding.handle !== null,
      };
    }
    case "activate": {
      if (node === null) throw new Error("an activate step must have resolved a node");
      return { kind: "click", target: node };
    }
    default:
      throw new Error(`this test drives no ${step.instruction.kind} step`);
  }
}

/** One frozen moment and one lease. `check` has no clock and no session of its own, which is why a
 *  policy decision in this file needs no fakes and no timers. */
const NOW: PolicyMoment = { now: "2026-02-11T14:05:00.000Z", epoch: 4 };
const LEASE: LeaseSnapshot = {
  holder: "automation",
  actorId: "run:integration",
  epoch: 4,
  expiresAt: "2026-02-11T14:10:00.000Z",
};

function policyContext(step: ResolvedStep, program: LinkedProgram): PolicyContext {
  return {
    mode: "replay",
    allowlist,
    step,
    route: step.route ?? { originAlias: "corebank", path: "/members/search" },
    effect: step.effect,
    lease: LEASE,
    approval: null,
    artifact: { lifecycle: "approved", digestVerified: true },
    // Handles, never values: the engine can tell that this action carries regulated text without
    // ever holding the text.
    taint: program.bindings.flatMap((b) => (b.handle === null ? [] : [b.handle])),
    approvedDigest: null,
  };
}

function classifierInput(
  program: LinkedProgram,
  step: ResolvedStep,
  observation: Observation,
  window: readonly string[],
  extra: Partial<ClassifierInput> = {},
): ClassifierInput {
  return {
    observation,
    recentDigests: window.slice(-2),
    preActDigest: null,
    step,
    ambient: program.ambient,
    phase: "post",
    bindings: program.bindings,
    counters: {
      recoveryAttempts: {},
      remediationCycles: 0,
      run: {
        actions: { used: 1, limit: 40 },
        observations: { used: 2, limit: 200 },
        remediations: { used: 0, limit: 8 },
        programAttempts: { used: 0, limit: 2 },
      },
      deadlineMs: 120_000,
    },
    program: program.facts,
    elapsedMs: 2_000,
    settleElapsedMs: 200,
    irreversibleDispatched: false,
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------
// The seams
// ---------------------------------------------------------------------------------------------

describe("the linker hands the classifier and the resolver what they read", () => {
  const program = linkedProgram();

  it("links the fixture the other units were written against", () => {
    expect(program.steps.map((s) => s.id)).toEqual([
      "open-search",
      "enter-member-id",
      "submit-search",
      "open-member-row",
      "read-savings-balance",
    ]);
    expect(program.effectiveDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("binds the caller's argument and taints it, because the contract says it is regulated", () => {
    const memberId = program.bindings.find((b) => b.name === "memberId");
    expect(memberId?.value).toBe(SUBJECT_MEMBER_ID);
    expect(memberId?.origin).toBe("param");
    // The taint model's first link: a handle exists, so nothing downstream needs the value in
    // order to say WHICH value it was.
    expect(memberId?.handle).not.toBeNull();
  });

  it("produces `ProgramFacts` in the shape `classify` and `renderTarget` take as plain data", () => {
    // No adapter, no re-derivation: `EvalContext` is assembled from the linker's own output plus
    // one observation. If unit 7 and unit 4 had drifted on this shape, this line would not compile.
    const ctx: EvalContext = {
      observation: corebankScreens["search-form"] as Observation,
      program: program.facts,
      bindings: program.bindings,
    };
    expect(Object.keys(ctx.program.routes).length).toBeGreaterThan(0);
    expect(renderTarget(program.steps[2]?.target as never)).toContain(
      "the button named <search-button>",
    );
  });
});

describe("an observation from the mock is one the validator accepts", () => {
  it("round-trips through `parseObservation` unchanged", async () => {
    // The mock is a driver, and this is the obligation every driver has. Asserting it HERE is what
    // makes the mock usable as evidence for units that will never see a browser: if the mock could
    // emit a document the browser driver's output would have to be refused for, every test built
    // on it would be proving something about a shape that cannot occur.
    const { observation } = await settle(surface());
    const parsed = parseObservation(observation);
    expect(parsed.nodes.length).toBe(observation.nodes.length);
    expect(parsed.skeletonDigest).toBe(skeletonDigestOf(observation.nodes));
  });
});

describe("one full turn of the cycle", () => {
  /**
   * observe → policy → act → settle → classify, for one step.
   *
   * The pre-act skeleton is read HERE rather than defaulted, because the checkpoint's delta
   * assertion is compared against it: `classify` treats a missing pre-act digest as "the change
   * cannot be shown to have happened" and fails closed, which is correct and is also the reason a
   * test that forgets it sees `no-observable-effect` on a step that worked perfectly.
   */
  async function turn(
    s: MockSurface,
    program: LinkedProgram,
    step: ResolvedStep,
    node: NodeId | null,
    options: { readonly settleAfter?: boolean } = {},
  ): Promise<{ verdict: Verdict; observation: Observation }> {
    const before = await s.perceive({ deadlineMs: 5_000 });
    const preActDigest = before.ok ? before.observation.skeletonDigest : null;

    const action = actionFor(step, node, program);
    const decision = check(action, policyContext(step, program), NOW);
    expect(decision).toMatchObject({ allow: true });
    if (!decision.allow) throw new Error(`the policy refused: ${decision.reason}`);
    expect(await s.act(action, MOCK_LEASE_TOKEN)).toEqual({ ok: true, dispatched: true });

    // A native dialog blocks the renderer, so polling for quiescence is the wrong question: the
    // driver knows synchronously and reports it on its own channel (SPEC section 2.2, band B2).
    const after =
      options.settleAfter === false
        ? await (async () => {
            const r = await s.perceive({ deadlineMs: 5_000 });
            if (!r.ok) throw new Error("the mock refused to describe the screen");
            return { observation: r.observation, window: [r.observation.skeletonDigest] };
          })()
        : await settle(s);

    const verdict = classify(
      classifierInput(program, step, after.observation, after.window, { preActDigest }),
    );
    return { verdict, observation: after.observation };
  }

  const contextAt = (program: LinkedProgram, observation: Observation): EvalContext => ({
    observation,
    program: program.facts,
    bindings: program.bindings,
  });

  it("navigates, fills, submits, and classifies the dialog the app raised", async () => {
    const program = linkedProgram();
    const s = surface();

    // ---- step 0: navigate ---------------------------------------------------------------------
    const openSearch = program.steps[0] as ResolvedStep;
    const navigated = await turn(s, program, openSearch, null);
    expect(navigated.verdict.kind).toBe("advance");
    expect(navigated.observation.route?.path).toBe("/members/search");

    // ---- step 1: fill, via the resolver -------------------------------------------------------
    const enterMemberId = program.steps[1] as ResolvedStep;
    const field: TargetResolutionResult = resolveTarget({
      target: enterMemberId.target as never,
      ctx: contextAt(program, navigated.observation),
      capabilities: MOCK_SURFACE_CAPABILITIES,
      disabledDescriptors: [],
    });
    expect(field.status).toBe("resolved");
    if (field.status !== "resolved") return;
    expect(field.nodeId).toBe(IDS.memberIdField);
    // SPEC section 5.1's quorum: independent evidence, not three readings of one label.
    expect(field.independentSources).toBeGreaterThanOrEqual(2);
    expect(field.agreeingDescriptors.length).toBeGreaterThanOrEqual(2);

    // The resolver's own result, handed to the classifier with no adapter between them. This
    // assignment IS the assertion - unit 4 and unit 5 named the discriminant and its values
    // identically on purpose, so a drift in either is a compile error on this line.
    const gate: GateFacts = {
      lease: "held",
      policy: { allow: true, effect: "READ", ruleId: "artifact:step-maxEffect" },
      target: field,
    };
    expect(gate.target?.status).toBe("resolved");
    expect(seam(field).candidates.length).toBe(field.candidates.length);

    const filled = await turn(s, program, enterMemberId, field.nodeId);
    expect(filled.verdict.kind).toBe("advance");
    // The taint model, end to end: the value the caller supplied reached the field, and the action
    // that carried it was marked sensitive because the CONTRACT said the parameter was.
    expect(actionFor(enterMemberId, field.nodeId, program)).toMatchObject({
      kind: "type",
      sensitive: true,
      text: SUBJECT_MEMBER_ID,
    });

    // ---- step 2: submit, and meet the native confirm -------------------------------------------
    const submit = program.steps[2] as ResolvedStep;
    const button = resolveTarget({
      target: submit.target as never,
      ctx: contextAt(program, filled.observation),
      capabilities: MOCK_SURFACE_CAPABILITIES,
    });
    expect(button.status).toBe("resolved");
    if (button.status !== "resolved") return;
    expect(button.nodeId).toBe(IDS.searchButton);

    const submitted = await turn(s, program, submit, button.nodeId, { settleAfter: false });
    expect(submitted.observation.nativeDialog?.type).toBe("confirm");

    // THE POINT OF THE WHOLE FILE. The artifact declared a recovery for a native dialog; the mock
    // raised one because that is what the legacy app does; and the classifier - which has heard of
    // neither - returned the declared remedy. Three units, one sentence in one document.
    expect(submitted.verdict.kind).toBe("recover");
    if (submitted.verdict.kind !== "recover") return;
    expect(submitted.verdict.recoveryName).toBe("DISMISS_KEEPALIVE_DIALOG");
    expect(submitted.verdict.remedy).toMatchObject({
      kind: "dismiss-native-dialog",
      accept: false,
    });
    expect(submitted.verdict.attempt).toBe(1);
  });
});
