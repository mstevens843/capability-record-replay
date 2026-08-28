// The result contract: four arms, and the one distinction the brief names three times.
//
// A business outcome and a failure are DIFFERENT ARMS of the union, with different discriminants and
// no shared `error` field, because conflating them is - in the glossary's own words - the most
// common design mistake in this problem. `MEMBER_NOT_FOUND` is an answer the caller needs, not an
// exception it has to catch, and the type is what makes that true rather than aspirational.
//
// There are two kinds of test here. The runtime ones validate the shapes a journal and a conformance
// corpus read back. The compile-time ones at the bottom are the actual product: they run under
// `tsc --noEmit` and they are what a call site's exhaustive `switch` depends on.

import { describe, expect, it } from "vitest";
import {
  AgentToolResultSchema,
  type ApprovalToken,
  type CapabilityContract,
  FAILURE_GUIDANCE,
  FailureClassSchema,
  type FieldsOf,
  type Invocation,
  type Money,
  type OutcomeDecl,
  PRE_FLIGHT_FAILURES,
  type ReplayResult,
  ReplayResultSchema,
  RunEnvelopeSchema,
  type TsTypeOf,
  type WithApproval,
  parseReplayResult,
  safeParseReplayResult,
} from "../src/index.js";
import {
  failedResult,
  okResult,
  outcomeResult,
  runEnvelope,
  suspendedResult,
} from "./fixtures/run-envelope.js";

describe("the run envelope", () => {
  it("parses", () => {
    const parsed = RunEnvelopeSchema.safeParse(runEnvelope);
    expect(parsed.success ? null : JSON.stringify(parsed.error.issues, null, 2)).toBeNull();
  });
});

describe("the four arms", () => {
  it("all parse, and each is reached by its own discriminant", () => {
    for (const [name, result] of [
      ["ok", okResult],
      ["outcome", outcomeResult],
      ["suspended", suspendedResult],
      ["failed", failedResult],
    ] as const) {
      const parsed = safeParseReplayResult(result);
      expect(
        parsed.success ? null : `${name}: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      ).toBeNull();
      expect(parseReplayResult(result).status).toBe(name);
    }
  });

  it("gives a business outcome no error field to read", () => {
    expect(Object.keys(outcomeResult)).not.toContain("error");
    expect(Object.keys(outcomeResult)).not.toContain("failure");
    expect(safeParseReplayResult({ ...outcomeResult, error: "MEMBER_NOT_FOUND" }).success).toBe(
      false,
    );
  });

  it("carries the same envelope on success as on failure", () => {
    // Including `steps[].resolution`. A silently degrading descriptor is only visible on the runs
    // that still pass, which is precisely why the successful arm is not allowed to be terser.
    expect(okResult.run.steps[0]?.resolution).toBeDefined();
    expect(okResult.run.drift).toBeDefined();
  });
});

describe("the failed arm", () => {
  it("makes the caller state what it knows about side effects", () => {
    const { sideEffects, ...withoutSideEffects } = failedResult.failure;
    void sideEffects;
    expect(safeParseReplayResult({ ...failedResult, failure: withoutSideEffects }).success).toBe(
      false,
    );
    for (const value of ["none-guaranteed", "possible", "in-doubt"]) {
      const arm = { ...failedResult, failure: { ...failedResult.failure, sideEffects: value } };
      expect(ReplayResultSchema.safeParse(arm).success, value).toBe(true);
    }
  });

  it("refuses to describe an in-doubt effect as retriable", () => {
    // The single worst thing a caller could do with this arm is try again: the first attempt may
    // already have posted. Making it unrepresentable costs one refinement.
    const contradiction = {
      ...failedResult,
      failure: {
        ...failedResult.failure,
        class: "effect-in-doubt",
        sideEffects: "in-doubt",
        retriable: "same-inputs",
      },
    };
    expect(safeParseReplayResult(contradiction).success).toBe(false);
  });

  it("refuses a pre-flight failure that admits to side effects", () => {
    // No step means nothing was driven. "link-error with side effects possible" is either a lie or
    // a bug, and either way the caller must not be shown it.
    const contradiction = {
      ...failedResult,
      failure: { ...failedResult.failure, class: "link-error", atStep: null, stepIndex: null },
    };
    expect(safeParseReplayResult(contradiction).success).toBe(false);
    expect(
      safeParseReplayResult({
        ...contradiction,
        failure: { ...contradiction.failure, sideEffects: "none-guaranteed" },
      }).success,
    ).toBe(true);
  });
});

describe("the failure-class table", () => {
  it("has reviewed guidance for every class", () => {
    for (const cls of FailureClassSchema.options) {
      const guidance = FAILURE_GUIDANCE[cls];
      expect(guidance, cls).toBeDefined();
      expect(guidance.operatorAction.length, cls).toBeGreaterThan(0);
      expect(guidance.agentGuidance.length, cls).toBeGreaterThan(0);
    }
  });

  it("never tells an agent to retry something that may already have happened", () => {
    expect(FAILURE_GUIDANCE["effect-in-doubt"].retriable).toBe("no");
    expect(FAILURE_GUIDANCE["effect-in-doubt"].agentGuidance).toContain("Do not try again");
    expect(FAILURE_GUIDANCE["continuity-broken"].retriable).toBe("no");
  });

  it("knows which classes performed zero actions", () => {
    expect([...PRE_FLIGHT_FAILURES].sort()).toEqual([
      "argument-invalid",
      "artifact-invalid",
      "contract-stale",
      "link-error",
    ]);
  });

  it("has no UNKNOWN_ERROR", () => {
    // The admission test for a class is that it implies a different human action. A class nobody
    // can act on exists to make an engine feel complete.
    expect(FailureClassSchema.options).not.toContain("unknown");
    expect(FailureClassSchema.options).not.toContain("UNKNOWN_ERROR");
  });
});

describe("the agent-facing projection", () => {
  it("speaks the model's vocabulary, not the engine's", () => {
    // `suspended` becomes `pending`: the model has no session, so from its side the run has simply
    // not finished. Same fact, and it stops an agent apologising for something about to succeed.
    const statuses = AgentToolResultSchema.shape.status.options;
    expect(statuses).toEqual(["ok", "outcome", "pending", "error"]);
    expect(statuses).not.toContain("suspended");
    expect(statuses).not.toContain("failed");
  });

  it("has nowhere to put a step id, a descriptor or a drift report", () => {
    const base = {
      status: "outcome",
      outcome: "MEMBER_NOT_FOUND",
      guidance: "Ask the member to read the number again.",
      retryable: "with_different_inputs",
      runId: "run-2026-02-12-7c1d",
    };
    expect(AgentToolResultSchema.safeParse(base).success).toBe(true);
    for (const leak of [
      { atStep: "submit-search" },
      { descriptors: [] },
      { drift: {} },
      { run: {} },
    ]) {
      expect(AgentToolResultSchema.safeParse({ ...base, ...leak }).success).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Compile-time only. Nothing calls these; `tsc --noEmit` over `test/` is what runs them, and each
// `@ts-expect-error` fails the build if the mechanism it guards ever stops working.
// ---------------------------------------------------------------------------------------------

type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

type _money = Assert<Equals<TsTypeOf<{ kind: "money"; currency: "USD" }>, Money>>;
type _enum = Assert<
  Equals<TsTypeOf<{ kind: "enum"; values: readonly ["OPEN", "FROZEN"] }>, "OPEN" | "FROZEN">
>;
type _table = Assert<
  Equals<
    TsTypeOf<{ kind: "table"; columns: readonly [] }>,
    readonly Readonly<Record<string, string>>[]
  >
>;

/** An optional field is nullable in the mapped result, so a caller cannot forget to handle it. */
type _optionalIsNullable = Assert<
  Equals<
    FieldsOf<
      readonly [
        {
          name: "a";
          type: { kind: "string" };
          required: true;
          description: string;
          sensitivity: "public";
        },
        {
          name: "b";
          type: { kind: "integer" };
          required: false;
          description: string;
          sensitivity: "public";
        },
      ]
    >,
    { readonly a: string; readonly b: number | null }
  >
>;

interface NotFound extends OutcomeDecl {
  readonly code: "MEMBER_NOT_FOUND";
  readonly payload: readonly [];
  readonly callerAction: "retry-different-input";
}
interface Restricted extends OutcomeDecl {
  readonly code: "MEMBER_RESTRICTED";
  readonly payload: readonly [
    {
      readonly name: "restrictionCode";
      readonly type: { readonly kind: "string" };
      readonly required: true;
      readonly description: string;
      readonly sensitivity: "internal";
    },
  ];
  readonly callerAction: "refer-to-specialist";
}
interface DemoContract extends CapabilityContract {
  readonly outcomes: readonly [NotFound, Restricted];
  readonly requiresApproval: false;
}
interface IrreversibleContract extends CapabilityContract {
  readonly requiresApproval: true;
}

/** The mechanism the whole result contract exists for: an exhaustive switch over the outcome codes,
 *  where `data` narrows to that outcome's own payload and adding a third code is a compile error at
 *  every existing call site. */
declare const result: ReplayResult<DemoContract>;
function narrowing(): void {
  if (result.status !== "outcome") return;
  switch (result.outcome) {
    case "MEMBER_NOT_FOUND": {
      // @ts-expect-error MEMBER_NOT_FOUND declares an empty payload
      const nothing: string = result.data.restrictionCode;
      void nothing;
      return;
    }
    case "MEMBER_RESTRICTED": {
      const code: string = result.data.restrictionCode;
      void code;
      return;
    }
    default: {
      // If a third outcome is added to the contract, `result` stops being `never` here and this
      // line is a compile error - at this call site and at every other one, which is exactly
      // right: a new possible answer IS a breaking change for the caller.
      const exhaustive: never = result;
      void exhaustive;
      return;
    }
  }
}
void narrowing;

declare const irreversible: Invocation<IrreversibleContract>;
declare const token: ApprovalToken;
function approvalIsRequiredByTheType(): void {
  // @ts-expect-error an irreversible capability cannot be invoked without an approval token
  const missing: WithApproval<IrreversibleContract> = irreversible;
  const present: WithApproval<IrreversibleContract> = { ...irreversible, approval: token };
  void missing;
  void present;
}
void approvalIsRequiredByTheType;

declare const read: Invocation<DemoContract>;
function approvalCannotBeSmuggledOntoARead(): void {
  // @ts-expect-error a read capability has no approval to present
  const smuggled: WithApproval<DemoContract> = { ...read, approval: token };
  void smuggled;
}
void approvalCannotBeSmuggledOntoARead;

// The four `Assert<...>` aliases above emit no runtime code and are never referenced. That is the
// whole point: each resolves only if its mapper is exact, so a regression in `TsTypeOf` or
// `FieldsOf` fails `tsc --noEmit` with no test having to run.
