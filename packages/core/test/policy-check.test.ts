// The chokepoint, refusal by refusal.
//
// The table below is the acceptance test SPEC section 11 asks for - a refusal case per
// `PolicyDenialReason` - and the last test in that block is the part that keeps it honest: it reads
// the reasons off the zod enum and fails if a new one is added without a case. A safety enum that
// can grow a member nobody exercises is a safety enum that quietly stops meaning anything.
//
// Everything here is frozen: one moment, one lease, one allowlist. `check` has no clock and no
// session of its own, so a policy test needs no fakes, no timers and no browser - which is the same
// property the classifier tests rely on, for the same reason.

import { describe, expect, it } from "vitest";
import {
  type Action,
  type Allowlist,
  type ApprovalToken,
  type CapabilityContract,
  type Invocation,
  type LeaseSnapshot,
  type NodeId,
  type PolicyContext,
  PolicyContextSchema,
  type PolicyDecision,
  PolicyDecisionSchema,
  type PolicyDenialReason,
  PolicyDenialReasonSchema,
  type PolicyMoment,
  type ResolvedStep,
  type StepId,
  type WithApproval,
  bindSensitive,
  check,
  derivedEffectClass,
  effectExceeds,
  higherEffect,
  matchRoute,
  reconcileEffectClass,
  routePatternMatches,
  taintHandlesOf,
  timestampIsBefore,
} from "../src/index.js";
import { memberLookupArtifact } from "./fixtures/member-lookup.js";

// ---------------------------------------------------------------------------------------------
// One frozen world
// ---------------------------------------------------------------------------------------------

const NOW = "2026-02-11T14:05:00.000Z";
const AT: PolicyMoment = { now: NOW, epoch: 4 };

const LEASE: LeaseSnapshot = {
  holder: "automation",
  actorId: "run:2026-02-11-a1b2c3",
  epoch: 4,
  expiresAt: "2026-02-11T14:10:00.000Z",
};

const ALLOWLIST: Allowlist = {
  originAliases: ["corebank"],
  routes: [
    { originAlias: "corebank", pathPattern: "/members/search", maxEffect: "READ" },
    { originAlias: "corebank", pathPattern: "/members/:memberId", maxEffect: "READ" },
    {
      originAlias: "corebank",
      pathPattern: "/members/:memberId/shares/:shareId/close",
      maxEffect: "WRITE_IRREVERSIBLE",
    },
  ],
  actionKinds: ["click", "type", "navigate", "acceptDialog"],
  maxEffect: "WRITE_IRREVERSIBLE",
  discoveryMaxEffect: "WRITE_REVERSIBLE",
};

const SEARCH_ROUTE = { originAlias: "corebank", path: "/members/search" } as const;
const CLOSE_ROUTE = {
  originAlias: "corebank",
  path: "/members/:memberId/shares/:shareId/close",
} as const;

/** A canary that must never appear in a decision. It is what a real member number would be. */
const CANARY = "50001-CANARY-DO-NOT-LOG";
const MEMBER_ID = bindSensitive("memberId", CANARY, 1);

/** Steps come from the committed fixture rather than being invented here: a policy test that
 *  invents its own step can drift from the document the linker validates. */
function stepOf(id: string, index: number, route: PolicyContext["route"]): ResolvedStep {
  const step = memberLookupArtifact.flow.steps.find((s) => s.id === (id as StepId));
  if (step === undefined) throw new Error(`no step ${id} in the fixture`);
  return { ...step, index, route };
}

const SUBMIT_STEP = stepOf("submit-search", 2, SEARCH_ROUTE);
const FILL_STEP = stepOf("enter-member-id", 1, SEARCH_ROUTE);

function ctxOf(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    mode: "replay",
    allowlist: ALLOWLIST,
    step: SUBMIT_STEP,
    route: SEARCH_ROUTE,
    effect: "READ",
    lease: LEASE,
    approval: null,
    artifact: { lifecycle: "approved", digestVerified: true },
    taint: [],
    approvedDigest: null,
    ...over,
  };
}

const click: Action = { kind: "click", target: "button:search" as NodeId };
const typeMember = (sensitive: boolean): Action => ({
  kind: "type",
  target: "textbox:member-id" as NodeId,
  text: sensitive ? "<handled by the driver>" : "50001",
  mode: "replace",
  sensitive,
});

function irreversibleStep(index = 6): ResolvedStep {
  // The fixture is a read flow, so the irreversible case is one of its own steps with the effect
  // raised - the same edit `irreversible-flow.test.ts` makes, for the same reason.
  return { ...stepOf("open-member-row", index, CLOSE_ROUTE), effect: "WRITE_IRREVERSIBLE" };
}

// ---------------------------------------------------------------------------------------------
// Allowing
// ---------------------------------------------------------------------------------------------

describe("check allows", () => {
  it("a read on an allowlisted route, naming the rule that allowed it", () => {
    const decision = check(click, ctxOf(), AT);
    expect(decision).toEqual({
      allow: true,
      effect: "READ",
      ruleId: "route:corebank/members/search",
    });
    expect(PolicyDecisionSchema.safeParse(decision).success).toBe(true);
  });

  it("a context that is itself a valid PolicyContext", () => {
    // The engine is written against the schema unit 2 shipped, not against a shape this test made
    // up. If the two drift, this fails before any refusal test does.
    const parsed = PolicyContextSchema.safeParse(ctxOf());
    expect(parsed.success ? null : JSON.stringify(parsed.error.issues, null, 2)).toBeNull();
  });

  it("an irreversible action when an approval token is presented and bound to a digest", () => {
    const decision = check(
      click,
      ctxOf({
        step: irreversibleStep(),
        route: CLOSE_ROUTE,
        effect: "WRITE_IRREVERSIBLE",
        approval: "apv_9f2c" as ApprovalToken,
        approvedDigest: memberLookupArtifact.digest,
      }),
      AT,
    );
    expect(decision.allow).toBe(true);
    expect(decision.allow && decision.effect).toBe("WRITE_IRREVERSIBLE");
  });

  it("and reports the HIGHER of what the actuator claims and what the step declared", () => {
    // SPEC 8.2: where the declaration and the derivation disagree, the higher wins. An actuator
    // that believes it is doing a READ on a step the artifact declared irreversible does not get to
    // skip the approval gate by being wrong.
    const noToken = check(
      click,
      ctxOf({ step: irreversibleStep(), route: CLOSE_ROUTE, effect: "READ" }),
      AT,
    );
    expect(noToken).toMatchObject({ allow: false, reason: "irreversible-requires-approval" });
  });

  it("a discovery action with no artifact and no step", () => {
    const decision = check(
      click,
      ctxOf({ mode: "discovery", step: null, artifact: null, effect: "READ" }),
      AT,
    );
    expect(decision.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Refusing: one case per PolicyDenialReason
// ---------------------------------------------------------------------------------------------

interface Refusal {
  readonly name: string;
  readonly reason: PolicyDenialReason;
  readonly ruleId: string;
  readonly action: Action;
  readonly ctx: PolicyContext;
  readonly at?: PolicyMoment;
}

const REFUSALS: readonly Refusal[] = [
  {
    name: "a lease minted under an older epoch - a human took control mid-run",
    reason: "lease-not-held",
    ruleId: "lease:epoch",
    action: click,
    ctx: ctxOf({ lease: { ...LEASE, epoch: 3 } }),
  },
  {
    name: "an automation acting while the human holds the lease",
    reason: "lease-not-held",
    ruleId: "lease:holder",
    action: click,
    ctx: ctxOf({ lease: { ...LEASE, holder: "human", actorId: "operator:kim" } }),
  },
  {
    name: "an expired lease",
    reason: "lease-not-held",
    ruleId: "lease:expired",
    action: click,
    ctx: ctxOf({ lease: { ...LEASE, expiresAt: "2026-02-11T14:04:59.999Z" } }),
  },
  {
    name: "an origin alias nobody allowlisted",
    reason: "origin-not-allowed",
    ruleId: "allowlist:origin",
    action: click,
    ctx: ctxOf({ route: { originAlias: "lookalike", path: "/members/search" } }),
  },
  {
    name: "an action whose destination the caller did not name",
    reason: "route-not-allowed",
    ruleId: "route:unknown",
    action: click,
    ctx: ctxOf({ route: null }),
  },
  {
    name: "a path no allowlisted pattern covers",
    reason: "route-not-allowed",
    ruleId: "allowlist:route",
    action: click,
    ctx: ctxOf({ route: { originAlias: "corebank", path: "/admin/users" } }),
  },
  {
    name: "a navigate whose own destination disagrees with the one being checked",
    reason: "route-not-allowed",
    ruleId: "route:action-mismatch",
    action: {
      kind: "navigate",
      route: { originAlias: "corebank", path: "/admin/users", query: {} },
    },
    ctx: ctxOf({ step: null }),
  },
  {
    name: "a path with a dot segment, which no allowlist can be reasoned about",
    reason: "route-not-allowed",
    ruleId: "route:path-shape",
    action: click,
    ctx: ctxOf({ route: { originAlias: "corebank", path: "/members/../admin" } }),
  },
  {
    name: "an action kind outside the allowlist",
    reason: "action-kind-not-allowed",
    ruleId: "allowlist:actionKind",
    action: { kind: "dismissDialog" },
    ctx: ctxOf({ step: null }),
  },
  {
    name: "an effect above the allowlist's ceiling",
    reason: "effect-exceeds-allowlist",
    ruleId: "allowlist:maxEffect",
    action: click,
    ctx: ctxOf({
      allowlist: { ...ALLOWLIST, maxEffect: "READ" },
      step: irreversibleStep(),
      route: CLOSE_ROUTE,
      effect: "WRITE_IRREVERSIBLE",
      approval: "apv_9f2c" as ApprovalToken,
      approvedDigest: memberLookupArtifact.digest,
    }),
  },
  {
    name: "an effect above the ceiling of the route it lands on",
    reason: "effect-exceeds-allowlist",
    ruleId: "allowlist:route-maxEffect",
    action: click,
    ctx: ctxOf({
      step: { ...SUBMIT_STEP, effect: "WRITE_REVERSIBLE" },
      effect: "WRITE_REVERSIBLE",
    }),
  },
  {
    name: "a write during discovery, where the ceiling is lower",
    reason: "effect-exceeds-allowlist",
    ruleId: "allowlist:discoveryMaxEffect",
    action: click,
    ctx: ctxOf({
      mode: "discovery",
      artifact: null,
      step: null,
      route: CLOSE_ROUTE,
      effect: "WRITE_IRREVERSIBLE",
      approval: "apv_9f2c" as ApprovalToken,
    }),
  },
  {
    name: "an actuator about to do more than the step the artifact declared",
    reason: "effect-exceeds-artifact",
    ruleId: "artifact:step-maxEffect",
    action: click,
    ctx: ctxOf({ route: CLOSE_ROUTE, effect: "WRITE_REVERSIBLE" }),
  },
  {
    name: "a replay with no artifact at all",
    reason: "artifact-not-approved",
    ruleId: "artifact:lifecycle",
    action: click,
    ctx: ctxOf({ artifact: null }),
  },
  {
    name: "a replay of a draft that was never approved",
    reason: "artifact-not-approved",
    ruleId: "artifact:lifecycle",
    action: click,
    ctx: ctxOf({ artifact: { lifecycle: "draft", digestVerified: true } }),
  },
  {
    name: "an approved artifact whose bytes no longer hash to its digest",
    reason: "artifact-digest-mismatch",
    ruleId: "artifact:digest",
    action: click,
    ctx: ctxOf({ artifact: { lifecycle: "approved", digestVerified: false } }),
  },
  {
    name: "an approval token that names no artifact digest",
    reason: "artifact-digest-mismatch",
    ruleId: "approval:digest-binding",
    action: click,
    ctx: ctxOf({
      step: irreversibleStep(),
      route: CLOSE_ROUTE,
      effect: "WRITE_IRREVERSIBLE",
      approval: "apv_9f2c" as ApprovalToken,
      approvedDigest: null,
    }),
  },
  {
    name: "an irreversible action with no approval token",
    reason: "irreversible-requires-approval",
    ruleId: "approval:irreversible",
    action: click,
    ctx: ctxOf({
      step: irreversibleStep(),
      route: CLOSE_ROUTE,
      effect: "WRITE_IRREVERSIBLE",
    }),
  },
  {
    name: "an irreversible action during discovery with no interactive approval",
    reason: "irreversible-requires-approval",
    ruleId: "approval:irreversible",
    action: click,
    ctx: ctxOf({
      mode: "discovery",
      artifact: null,
      step: null,
      route: CLOSE_ROUTE,
      effect: "WRITE_IRREVERSIBLE",
      allowlist: { ...ALLOWLIST, discoveryMaxEffect: "WRITE_IRREVERSIBLE" },
    }),
  },
  {
    name: "a tainted binding lowered into a type action that is not marked sensitive",
    reason: "tainted-value-to-disallowed-sink",
    ruleId: "taint:unmasked-dispatch",
    action: typeMember(false),
    ctx: ctxOf({ step: FILL_STEP, taint: taintHandlesOf([MEMBER_ID]) }),
  },
  {
    name: "a tainted binding lowered into a dialog reply, which no driver can mask",
    reason: "tainted-value-to-disallowed-sink",
    ruleId: "taint:unmasked-dispatch",
    action: { kind: "acceptDialog", text: "50001" },
    ctx: ctxOf({ step: FILL_STEP, taint: taintHandlesOf([MEMBER_ID]) }),
  },
  {
    name: "an action claiming sensitive text when the taint model was never engaged",
    reason: "tainted-value-to-disallowed-sink",
    ruleId: "taint:untracked-sensitive",
    action: typeMember(true),
    ctx: ctxOf({ step: SUBMIT_STEP, taint: [] }),
  },
];

describe("check refuses", () => {
  for (const refusal of REFUSALS) {
    it(refusal.name, () => {
      const decision = check(refusal.action, refusal.ctx, refusal.at ?? AT);
      expect(decision.allow).toBe(false);
      const denial = decision as Extract<PolicyDecision, { allow: false }>;
      expect(denial.reason).toBe(refusal.reason);
      expect(denial.ruleId).toBe(refusal.ruleId);
      expect(denial.detail.length).toBeGreaterThan(0);
      expect(PolicyDecisionSchema.safeParse(decision).success).toBe(true);
    });
  }

  it("has a case for every PolicyDenialReason", () => {
    // Read off the enum, not off a list maintained here: a new reason with no refusal case is a
    // control nobody has exercised, and this is the only place that fact can surface.
    const covered = new Set(REFUSALS.map((r) => r.reason));
    expect([...PolicyDenialReasonSchema.options].filter((r) => !covered.has(r))).toEqual([]);
  });

  it("returns the FIRST refusal when several rules are violated at once", () => {
    // Order is part of the contract: SPEC 8.1 evaluates the lease first, and a caller reading
    // "origin-not-allowed" when the real problem is that a human took the session would go and fix
    // the wrong thing.
    const decision = check(
      { kind: "dismissDialog" },
      ctxOf({
        lease: { ...LEASE, epoch: 1 },
        route: { originAlias: "lookalike", path: "/x" },
        artifact: null,
      }),
      AT,
    );
    expect(decision).toMatchObject({
      allow: false,
      reason: "lease-not-held",
      ruleId: "lease:epoch",
    });
  });

  it("never puts a bound value in the reason a human will read", () => {
    // Every denial detail is schema vocabulary: parameter names, routes, effect classes. The canary
    // is bound in the context of every refusal here and must appear in none of them.
    for (const refusal of REFUSALS) {
      const withTaint = { ...refusal.ctx, taint: taintHandlesOf([MEMBER_ID]) };
      const decision = check(refusal.action, withTaint, refusal.at ?? AT);
      expect(JSON.stringify(decision)).not.toContain(CANARY);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------------------------

describe("route patterns", () => {
  it("match segment by segment, with no trailing wildcard", () => {
    expect(routePatternMatches("/members/:memberId", "/members/:memberId")).toBe(true);
    expect(routePatternMatches("/members/:memberId", "/members/50001")).toBe(true);
    expect(routePatternMatches("/members/:memberId", "/members/50001/shares")).toBe(false);
    expect(routePatternMatches("/members/search", "/members/search/")).toBe(true);
    expect(routePatternMatches("/members/*", "/members/anything")).toBe(true);
    // The pattern that would make an allowlist meaningless is simply not a pattern.
    expect(routePatternMatches("/members/**", "/members/50001/shares")).toBe(false);
  });

  it("resolve overlapping entries to the STRICTEST cap, not the first one written", () => {
    const overlapping: Allowlist = {
      ...ALLOWLIST,
      routes: [
        { originAlias: "corebank", pathPattern: "/members/*", maxEffect: "WRITE_IRREVERSIBLE" },
        { originAlias: "corebank", pathPattern: "/members/:memberId", maxEffect: "READ" },
      ],
    };
    expect(matchRoute(overlapping, "corebank", "/members/50001")?.maxEffect).toBe("READ");
  });

  it("do not match across origins", () => {
    expect(matchRoute(ALLOWLIST, "othertenant", "/members/search")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Risk classes
// ---------------------------------------------------------------------------------------------

describe("the risk classes", () => {
  it("are ordered, because every effect question in the system is a comparison", () => {
    expect(higherEffect("READ", "WRITE_REVERSIBLE")).toBe("WRITE_REVERSIBLE");
    expect(higherEffect("WRITE_IRREVERSIBLE", "WRITE_REVERSIBLE")).toBe("WRITE_IRREVERSIBLE");
    expect(effectExceeds("WRITE_REVERSIBLE", "READ")).toBe(true);
    expect(effectExceeds("READ", "READ")).toBe(false);
  });

  it("derive only what an instruction actually proves", () => {
    // An instruction that dispatches nothing at the surface cannot write. Everything else is a
    // declaration the recorder made, and SPEC 8.2 accepts that limit rather than pretending to
    // infer it - `activate` on "Search" and `activate` on "Close Account" are the same opcode.
    expect(derivedEffectClass("read")).toBe("READ");
    expect(derivedEffectClass("readTable")).toBe("READ");
    expect(derivedEffectClass("assert")).toBe("READ");
    expect(derivedEffectClass("activate")).toBeNull();
    expect(derivedEffectClass("fill")).toBeNull();
  });

  it("reconcile a declaration against a derivation by taking the higher, and say so", () => {
    expect(reconcileEffectClass("READ", "READ")).toEqual({ effect: "READ", agreed: true });
    expect(reconcileEffectClass("READ", null)).toEqual({ effect: "READ", agreed: true });
    // The linker reports the disagreement; the higher class governs meanwhile.
    expect(reconcileEffectClass("WRITE_REVERSIBLE", "READ")).toEqual({
      effect: "WRITE_REVERSIBLE",
      agreed: false,
    });
  });
});

describe("the lease clock", () => {
  it("compares timestamps written with and without milliseconds", () => {
    // Lexicographic comparison gets this backwards: "Z" sorts above ".", so the second-precision
    // spelling of an instant would look LATER than the millisecond one and a dead lease would read
    // as live.
    expect(timestampIsBefore("2026-02-11T14:10:00Z", "2026-02-11T14:10:00.000Z")).toBe(false);
    expect(timestampIsBefore("2026-02-11T14:10:00.000Z", "2026-02-11T14:10:00Z")).toBe(false);
    expect(timestampIsBefore("2026-02-11T14:09:59.999Z", "2026-02-11T14:10:00Z")).toBe(true);
  });

  it("treats a lease that expires exactly now as expired", () => {
    const decision = check(click, ctxOf({ lease: { ...LEASE, expiresAt: NOW } }), AT);
    expect(decision).toMatchObject({ allow: false, reason: "lease-not-held" });
  });
});

describe("the operator console", () => {
  it("passes through the same gate, holding the lease as a human", () => {
    const human: LeaseSnapshot = { ...LEASE, holder: "human", actorId: "operator:kim" };
    expect(check(click, ctxOf({ mode: "operator", lease: human, step: null }), AT).allow).toBe(
      true,
    );
  });

  it("is not an exemption from the approval gate", () => {
    // The console exists so a human can unstick a run, not so an irreversible action can be
    // performed without the token the artifact's approver ticked.
    const human: LeaseSnapshot = { ...LEASE, holder: "human", actorId: "operator:kim" };
    expect(
      check(
        click,
        ctxOf({
          mode: "operator",
          lease: human,
          step: null,
          route: CLOSE_ROUTE,
          effect: "WRITE_IRREVERSIBLE",
        }),
        AT,
      ),
    ).toMatchObject({ allow: false, reason: "irreversible-requires-approval" });
  });
});

// ---------------------------------------------------------------------------------------------
// The approval token, at the type level
// ---------------------------------------------------------------------------------------------
//
// The runtime gate above refuses an irreversible action with no token. These are the compile-time
// half: the call site cannot even construct the invocation, so the refusal above is a backstop
// rather than the only control. They run under `tsc --noEmit` and emit no runtime code.

interface CloseShareContract extends CapabilityContract {
  readonly requiresApproval: true;
}
interface LookupContract extends CapabilityContract {
  readonly requiresApproval: false;
}

declare const closeShare: Invocation<CloseShareContract>;
declare const lookup: Invocation<LookupContract>;
declare const approval: ApprovalToken;

/** The bridge this unit adds: the token the TYPE demanded is the one the CHOKEPOINT reads. A
 *  capability whose contract says `requiresApproval` cannot reach `check` with `approval: null`
 *  unless somebody wrote a cast. */
function approvalFrom<C extends CapabilityContract>(inv: WithApproval<C>): ApprovalToken | null {
  return inv.approval ?? null;
}
void approvalFrom;

function irreversibleNeedsATokenAtCompileTime(): void {
  // @ts-expect-error a capability declared irreversible cannot be invoked without approval
  const missing: WithApproval<CloseShareContract> = closeShare;
  const present: WithApproval<CloseShareContract> = { ...closeShare, approval };
  void approvalFrom(present);
  void missing;
}
void irreversibleNeedsATokenAtCompileTime;

function aReadCannotSmuggleOneIn(): void {
  // @ts-expect-error a read capability has no approval to present, so none can be laundered
  const smuggled: WithApproval<LookupContract> = { ...lookup, approval };
  void smuggled;
}
void aReadCannotSmuggleOneIn;
