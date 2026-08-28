// SPEC section 2.7 - what the MODEL is shown, and everything it is not.
//
// The acceptance test for build unit 12 is "no step id, no descriptor, and no `withhold` output
// appears in what the agent is shown". Asserting three named absences would pass a projection that
// leaked a fourth thing, so the shape of this file is: run the real flow, take the real result, and
// then assert over the SERIALISED agent view that every diagnostic token the run document contains
// is missing from it. A new field on `RunEnvelope` is caught by that without anyone editing a list.

import { MockSurface, type ReplayResultDocument, ReplayResultSchema } from "@crr/core";
import { describe, expect, it } from "vitest";
import { MASKED_PLACEHOLDER, agentRetryable, renderForAgent } from "../src/agent-view.js";
import {
  DISCLOSURE_NOT_FOUND_TRANSITIONS,
  DISCLOSURE_RESTRICTED_TRANSITIONS,
  DISCLOSURE_TRANSITIONS,
  disclosureArtifact,
  disclosureContract,
  disclosureScreens,
} from "./fixtures/disclosure.js";
import { host, invocation } from "./support/host.js";

const MEMBER_ID = "50001";

async function run(transitions: readonly (typeof DISCLOSURE_TRANSITIONS)[number][]) {
  const h = host({
    contract: disclosureContract,
    artifact: disclosureArtifact(),
    screens: disclosureScreens,
    transitions: transitions as never,
  });
  const out = await h.catalog.invokeDetailed(
    disclosureContract,
    invocation(disclosureContract, { memberId: MEMBER_ID }),
  );
  return out.document;
}

describe("the ok arm", () => {
  it("delivers a `deliver` output, masks a `mask` output, and drops a `withhold` output", async () => {
    const document = await run(DISCLOSURE_TRANSITIONS);
    expect(document.status).toBe("ok");
    if (document.status !== "ok") return;

    // The calling PROGRAM gets everything. That is the half of the rule people forget.
    expect(Object.keys(document.outputs).sort()).toEqual([
      "internalRef",
      "memberName",
      "resultCount",
    ]);
    expect(document.outputs.memberName).toContain("alvarez");

    const view = renderForAgent(document, disclosureContract);
    expect(view.status).toBe("ok");
    expect(view.data).toEqual({
      resultCount: "1 record",
      memberName: MASKED_PLACEHOLDER,
    });
    expect(JSON.stringify(view)).not.toContain("alvarez");
    expect(JSON.stringify(view)).not.toContain("ir-77");
    expect(view.data).not.toHaveProperty("internalRef");
  });

  it("shows the model no step id, no descriptor and no diagnostic from the run envelope", async () => {
    const document = await run(DISCLOSURE_TRANSITIONS);
    if (document.status !== "ok") throw new Error(document.status);
    const text = JSON.stringify(renderForAgent(document, disclosureContract));

    // Every step id the run really executed. Not a hard-coded list: a step added to the fixture is
    // covered without editing this test.
    for (const trace of document.run.steps) {
      expect(text).not.toContain(trace.stepId);
      expect(text).not.toContain(trace.skeletonDigest);
      for (const row of trace.resolution ?? []) expect(text).not.toContain(row.descriptorId);
    }
    // And the whole diagnostic vocabulary, by key rather than by value.
    for (const forbidden of [
      "stepId",
      "descriptorId",
      "resolution",
      "skeletonDigest",
      "drift",
      "budgets",
      "evidence",
      "journalRef",
      "effectiveDigest",
      "expected",
      "observed",
      "warnings",
      "attribution",
      "artifactId",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    // The run id survives, because it is the one string a member can quote to a human.
    expect(text).toContain(document.run.runId);
  });

  it("says nothing about how many steps ran or how long they took", async () => {
    const document = await run(DISCLOSURE_TRANSITIONS);
    if (document.status !== "ok") throw new Error(document.status);
    const view = renderForAgent(document, disclosureContract);
    expect(Object.keys(view).sort()).toEqual(["data", "guidance", "retryable", "runId", "status"]);
  });
});

describe("the outcome arm", () => {
  it("is `outcome` and not `error`, and quotes the reviewed guidance verbatim", async () => {
    const document = await run(DISCLOSURE_NOT_FOUND_TRANSITIONS);
    expect(document.status).toBe("outcome");
    const view = renderForAgent(document, disclosureContract);

    expect(view.status).toBe("outcome");
    expect(view.status).not.toBe("error");
    expect(view.outcome).toBe("MEMBER_NOT_FOUND");
    // Verbatim from the contract, character for character. If this ever needs `toContain` instead
    // of `toBe`, something started generating prose at render time.
    const declared = disclosureContract.outcomes.find((o) => o.code === "MEMBER_NOT_FOUND");
    expect(view.guidance).toBe(declared?.agentGuidance);
    expect(view.retryable).toBe("with_different_inputs");
  });

  it("carries each outcome's own reviewed guidance, not the first one's", async () => {
    const document = await run(DISCLOSURE_RESTRICTED_TRANSITIONS);
    const view = renderForAgent(document, disclosureContract);
    expect(view.outcome).toBe("MEMBER_RESTRICTED");
    expect(view.guidance).toContain("a person at the credit union");
    expect(view.retryable).toBe("never");
  });

  it("does not tell the model which step or which rule produced the outcome", async () => {
    const document = await run(DISCLOSURE_NOT_FOUND_TRANSITIONS);
    if (document.status !== "outcome") throw new Error(document.status);
    const text = JSON.stringify(renderForAgent(document, disclosureContract));
    expect(document.detectedAt.stepId).toBe("submit-search");
    expect(text).not.toContain("submit-search");
    expect(text).not.toContain("detectedAt");
    expect(text).not.toContain("alsoMatched");
    expect(text).not.toContain("priority");
  });
});

describe("the suspended arm", () => {
  // Built from a REAL envelope rather than a hand-made one: the projection's job is to drop fields,
  // so a synthetic envelope with few fields would be a test that cannot fail.
  async function suspended(): Promise<ReplayResultDocument> {
    const ok = await run(DISCLOSURE_TRANSITIONS);
    return ReplayResultSchema.parse({
      status: "suspended",
      intervention: {
        id: "iv-77",
        reason: "unclassified-state",
        atStep: "submit-search",
        summary: "The results screen did not match any declared rule.",
        consoleUrl: "crr://intervention/iv-77",
        expiresAt: ok.run.endedAt,
      },
      resume: { token: "lease-abc", pollAfterMs: 5_000 },
      partialOutputs: { resultCount: "1 record", memberName: "alvarez, dana (synthetic)" },
      run: ok.run,
    }) as ReplayResultDocument;
  }

  it("becomes `pending`, because from the model's side the run has not finished", async () => {
    const view = renderForAgent(await suspended(), disclosureContract);
    expect(view.status).toBe("pending");
    expect(view.retryable).toBe("after_delay");
  });

  it("hands over the partial outputs, still gated by disclosure", async () => {
    const view = renderForAgent(await suspended(), disclosureContract);
    expect(view.data).toEqual({ resultCount: "1 record", memberName: MASKED_PLACEHOLDER });
    expect(JSON.stringify(view)).not.toContain("alvarez");
  });

  it("gives the model the intervention id to quote, and not the console url or the step", async () => {
    const view = renderForAgent(await suspended(), disclosureContract);
    expect(view.reference).toBe("iv-77");
    const text = JSON.stringify(view);
    expect(text).not.toContain("crr://");
    expect(text).not.toContain("submit-search");
    expect(text).not.toContain("lease-abc");
  });
});

describe("the failed arm", () => {
  async function failed(failureClass: string, retriable: string): Promise<ReplayResultDocument> {
    const ok = await run(DISCLOSURE_TRANSITIONS);
    return ReplayResultSchema.parse({
      status: "failed",
      failure: {
        class: failureClass,
        atStep: "submit-search",
        stepIndex: 2,
        sideEffects: "possible",
        expected: {
          rendered: "the heading Member Detail is present and the balance cell is present",
          clauses: [],
        },
        observed: {
          route: { originAlias: "corebank", path: "/results", query: {} },
          settled: true,
          pendingReason: null,
          skeletonDigest: "sk:deadbeef",
          nodeCount: 3,
          nativeDialog: null,
          inputIntercepted: false,
          salient: [],
          redactionsApplied: 0,
        },
        attempts: [],
        retriable,
        operatorAction: "Compare the results screen against the drift report.",
        observationRef: "obs:1",
      },
      run: ok.run,
    }) as ReplayResultDocument;
  }

  it("gives the model core's reviewed per-class guidance, never the expectation trace", async () => {
    const view = renderForAgent(await failed("checkpoint-failed", "no"), disclosureContract);
    expect(view.status).toBe("error");
    expect(view.guidance.length).toBeGreaterThan(0);
    const text = JSON.stringify(view);
    expect(text).not.toContain("Member Detail");
    expect(text).not.toContain("sk:deadbeef");
    expect(text).not.toContain("checkpoint-failed");
    expect(text).not.toContain("Compare the results screen");
  });

  it("hands back the run id as the reference a member can quote", async () => {
    const document = await failed("app-error", "same-inputs");
    const view = renderForAgent(document, disclosureContract);
    expect(view.reference).toBe(document.run.runId);
  });
});

describe("the retryable mapping", () => {
  // The agent's vocabulary is finer than the operator's on one axis - whether the fix is in the
  // caller's own hands - and `argument-invalid` is the only class where it is.
  it("says `with_different_inputs` for a bad argument and nothing else does", () => {
    expect(agentRetryable("argument-invalid", "same-inputs")).toBe("with_different_inputs");
    expect(agentRetryable("argument-invalid", "no")).toBe("with_different_inputs");
    expect(agentRetryable("app-error", "same-inputs")).toBe("after_delay");
    expect(agentRetryable("entitlement-denied", "after-human-action")).toBe("never");
    expect(agentRetryable("effect-in-doubt", "no")).toBe("never");
  });

  it("never invites a retry of an effect that is in doubt", async () => {
    const ok = await run(DISCLOSURE_TRANSITIONS);
    const document = ReplayResultSchema.parse({
      status: "failed",
      failure: {
        class: "effect-in-doubt",
        atStep: "submit-search",
        stepIndex: 2,
        sideEffects: "in-doubt",
        expected: { rendered: "the confirmation screen", clauses: [] },
        observed: {
          route: null,
          settled: false,
          pendingReason: null,
          skeletonDigest: "sk:x",
          nodeCount: 0,
          nativeDialog: null,
          inputIntercepted: false,
          salient: [],
          redactionsApplied: 0,
        },
        attempts: [],
        retriable: "no",
        operatorAction: "Reconcile against the system of record.",
        observationRef: "obs:1",
      },
      run: ok.run,
    }) as ReplayResultDocument;
    const view = renderForAgent(document, disclosureContract);
    expect(view.retryable).toBe("never");
  });
});

describe("what the projection refuses to invent", () => {
  it("drops an output the contract never declared, rather than passing it through", async () => {
    const ok = await run(DISCLOSURE_TRANSITIONS);
    if (ok.status !== "ok") throw new Error(ok.status);
    const smuggled = ReplayResultSchema.parse({
      ...ok,
      outputs: { ...ok.outputs, surpriseField: "1234567890" },
    }) as ReplayResultDocument;
    const view = renderForAgent(smuggled, disclosureContract);
    expect(view.data).not.toHaveProperty("surpriseField");
    expect(JSON.stringify(view)).not.toContain("1234567890");
  });

  it("masks a sensitive outcome payload field even though payloads carry no disclosure flag", async () => {
    const ok = await run(DISCLOSURE_TRANSITIONS);
    const withPayload = ReplayResultSchema.parse({
      status: "outcome",
      outcome: "MEMBER_NOT_FOUND",
      data: { searchedFor: "50001", attemptedAt: "2026-02-11" },
      terminal: true,
      callerAction: "retry-different-input",
      retryable: "with_different_inputs",
      guidance: "Ask them to read the number again.",
      detectedAt: { stepId: "submit-search", stepIndex: 2, priority: 10 },
      alsoMatched: [],
      run: ok.run,
    }) as ReplayResultDocument;

    const contract = {
      ...disclosureContract,
      outcomes: [
        {
          ...disclosureContract.outcomes[0],
          payload: [
            {
              name: "searchedFor",
              type: { kind: "string" },
              required: true,
              description: "The number that was searched for.",
              sensitivity: "sensitive",
            },
            {
              name: "attemptedAt",
              type: { kind: "date", format: "YYYY-MM-DD" },
              required: true,
              description: "When the search ran.",
              sensitivity: "internal",
            },
          ],
        },
      ],
    } as unknown as typeof disclosureContract;

    const view = renderForAgent(withPayload, contract);
    expect(view.data).toEqual({
      searchedFor: MASKED_PLACEHOLDER,
      attemptedAt: "2026-02-11",
    });
    expect(JSON.stringify(view)).not.toContain("50001");
  });
});

describe("the mock surface is the only surface any of this touches", () => {
  it("never launches a browser", async () => {
    const h = host({
      contract: disclosureContract,
      artifact: disclosureArtifact(),
      screens: disclosureScreens,
      transitions: DISCLOSURE_TRANSITIONS as never,
    });
    expect(h.surface).toBeInstanceOf(MockSurface);
  });
});
