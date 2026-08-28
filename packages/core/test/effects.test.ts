// The static effect analysis, and the gate it buys.
//
// `restartSafeUpToPc` is the clearest case in the design of a refusal paying for a safety property.
// The language has no branching, so "which steps are irreversible" is answerable by reading the
// document; with one `if` it would only be answerable by running the program, and a restart gate you
// can only evaluate after the fact is not a gate. These tests are written against that claim rather
// than against the function's implementation: what matters is that a program which has already
// opened a sub-account cannot be restarted, and that the linker says so before anything runs.

import { describe, expect, it } from "vitest";
import {
  type EffectFlowInput,
  MOCK_SURFACE_CAPABILITIES,
  analyzeEffects,
  artifactDigestOf,
  link,
  restartSafeUpToPc,
} from "../src/index.js";
import { memberLookupArtifact, memberLookupContract } from "./fixtures/member-lookup.js";

type Doc = { [key: string]: unknown };

const clone = <T>(value: T): T => structuredClone(value) as T;
const stepsOf = (doc: Doc) => (doc.flow as Doc).steps as Doc[];
const stepOf = (doc: Doc, id: string) => stepsOf(doc).find((s) => s.id === id) as Doc;

function reseal(doc: Doc): Doc {
  const { digest: _stale, ...rest } = doc;
  void _stale;
  return { ...rest, digest: artifactDigestOf(rest) };
}

/** The read fixture rewritten so that opening the member record is an irreversible write - the same
 *  variant `irreversible-flow.test.ts` uses, so the two files disagree loudly if one drifts. */
function irreversibleVariant(edit: (doc: Doc) => void = () => {}): Doc {
  const doc = clone(memberLookupArtifact) as unknown as Doc;
  stepOf(doc, "open-member-row").effect = "WRITE_IRREVERSIBLE";
  doc.effects = {
    ...(doc.effects as Doc),
    maxEffect: "WRITE_IRREVERSIBLE",
    irreversibleSteps: ["open-member-row"],
    requiresApproval: true,
    restartSafeUpToPc: 3,
  };
  doc.policy = {
    ...(doc.policy as Doc),
    maxEffect: "WRITE_IRREVERSIBLE",
    requiresApprovalToken: true,
  };
  doc.lifecycle = { status: "draft", supersedes: null, approval: null };
  edit(doc);
  return reseal(doc);
}

const sensitivity = Object.fromEntries(
  memberLookupContract.outputs.map((o) => [o.name, o.sensitivity]),
);

const analyze = (doc: Doc = clone(memberLookupArtifact) as unknown as Doc) =>
  analyzeEffects(doc.flow as unknown as EffectFlowInput, sensitivity);

describe("restartSafeUpToPc", () => {
  it("is the whole program when nothing is irreversible", () => {
    expect(restartSafeUpToPc([{ effect: "READ" }, { effect: "WRITE_REVERSIBLE" }])).toBe(2);
    expect(analyze().summary.restartSafeUpToPc).toBe(5);
  });

  it("stops at the first irreversible step, not after it", () => {
    expect(
      restartSafeUpToPc([
        { effect: "READ" },
        { effect: "WRITE_IRREVERSIBLE" },
        { effect: "READ" },
        { effect: "WRITE_IRREVERSIBLE" },
      ]),
    ).toBe(1);
    expect(analyze(irreversibleVariant()).summary.restartSafeUpToPc).toBe(3);
  });

  it("is zero when the very first step is irreversible", () => {
    expect(restartSafeUpToPc([{ effect: "WRITE_IRREVERSIBLE" }, { effect: "READ" }])).toBe(0);
  });

  it("is what the linker refuses a restart against", () => {
    // Gate 2 of SPEC section 3.6, said at load time. If the gate fails, the recovery degrades to
    // escalate - a human, not a retry.
    const beyond = irreversibleVariant((d) => {
      const step = stepOf(d, "read-savings-balance");
      step.recoveries = [
        {
          name: "START_OVER",
          band: "recoverable",
          detect: { kind: "settled" },
          priority: 10,
          phase: "post",
          remedy: { kind: "escalate", reason: "lost the record", brief: "start again by hand" },
          maxAttempts: 1,
          allowUnsettled: false,
          afterRemedy: "reverify",
          resume: "restart-program",
        },
      ];
      (step.budgets as Doc).perRecoveryMaxAttempts = { START_OVER: 1 };
    });
    const result = link({
      contract: memberLookupContract,
      artifact: beyond,
      capabilities: MOCK_SURFACE_CAPABILITIES,
      args: { memberId: "400123" },
      mode: "verification",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const restart = result.errors.filter((e) => e.check === 19);
    expect(restart.map((e) => e.code)).toContain("restart-beyond-safe-pc");
    expect(restart[0]?.message).toContain("restartSafeUpToPc is 3");
  });
});

describe("analyzeEffects", () => {
  it("collects every route the program can reach, from all three places one can hide", () => {
    // A `navigate` instruction, a remedy's navigate, and a declared navigation delta. A projection
    // of the steps would quietly lose two of the three.
    expect([...analyze().summary.routesTouched].sort()).toEqual(["member-detail", "member-search"]);
  });

  it("pairs each read field with the sensitivity the CONTRACT declares", () => {
    expect(analyze().summary.reads).toEqual([
      { field: "memberName", sensitivity: "sensitive" },
      { field: "savingsBalance", sensitivity: "internal" },
      { field: "accountStatus", sensitivity: "internal" },
    ]);
  });

  it("assumes the worst about a field no contract declares", () => {
    // The direction a missing sensitivity should be wrong in is never "assume it is safe to log".
    const analysis = analyzeEffects(
      clone(memberLookupArtifact).flow as unknown as EffectFlowInput,
      {},
    );
    expect(analysis.summary.reads.every((r) => r.sensitivity === "sensitive")).toBe(true);
  });

  it("derives requiresApproval from the steps rather than from a boolean somebody set", () => {
    expect(analyze().summary.requiresApproval).toBe(false);
    const irreversible = analyze(irreversibleVariant()).summary;
    expect(irreversible.maxEffect).toBe("WRITE_IRREVERSIBLE");
    expect(irreversible.irreversibleSteps).toEqual(["open-member-row"]);
    expect(irreversible.requiresApproval).toBe(true);
  });

  it("keeps the declared class and the derived one apart, and lets the higher win", () => {
    const doc = clone(memberLookupArtifact) as unknown as Doc;
    // A `read` instruction dispatches nothing at the surface, so it cannot write. Declaring
    // otherwise is a claim the instruction contradicts.
    stepOf(doc, "read-savings-balance").effect = "WRITE_REVERSIBLE";
    const analysis = analyze(doc);
    expect(analysis.disagreements.map((s) => s.stepId)).toEqual(["read-savings-balance"]);
    const [disagreement] = analysis.disagreements;
    expect(disagreement?.declared).toBe("WRITE_REVERSIBLE");
    expect(disagreement?.derived).toBe("READ");
    expect(disagreement?.effective).toBe("WRITE_REVERSIBLE");
    expect(analysis.summary.maxEffect).toBe("WRITE_REVERSIBLE");
  });

  it("proves nothing about an instruction that could be either", () => {
    // `activate` on a Search button is a read and `activate` on Close Account is not, and no pure
    // function over the artifact can tell them apart. SPEC section 8.2's accepted limit, stated as a
    // test rather than hidden: effect is declared, not proven.
    const activate = analyze().perStep.find((s) => s.stepId === "submit-search");
    expect(activate?.derived).toBeNull();
    expect(activate?.agreed).toBe(true);
  });

  it("is total on a half-formed program, because the linker calls it on one", () => {
    const analysis = analyzeEffects(
      { entry: {}, steps: [{}, { effect: "WRITE_IRREVERSIBLE" }] } as unknown as EffectFlowInput,
      {},
    );
    expect(analysis.summary.maxEffect).toBe("WRITE_IRREVERSIBLE");
    expect(analysis.summary.restartSafeUpToPc).toBe(1);
    expect(analysis.summary.routesTouched).toEqual([]);
  });
});
