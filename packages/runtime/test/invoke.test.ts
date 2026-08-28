// `invoke`, the digest pin, and the four arms - the production door under test.
//
// The stale-digest case is the reason this file exists. Everything else here is a property the
// interpreter suite already exercises through `replay`; the pin is new, and it is the mechanism
// that turns a silently-degraded type-level guarantee into a loud pre-flight failure.

import { sealContract } from "@crr/core";
import { describe, expect, it } from "vitest";
import { renderForAgent } from "../src/agent-view.js";
import { Catalog } from "../src/catalog.js";
import { manualClock } from "../src/clock.js";
import { MemoryIdempotencyStore, idempotencyKeyOf } from "../src/invoke.js";
import type { BrokeredSession, SessionBroker, TenantRef } from "../src/session.js";
import {
  DISCLOSURE_NOT_FOUND_TRANSITIONS,
  DISCLOSURE_TRANSITIONS,
  disclosureArtifact,
  disclosureContract,
  disclosureScreens,
} from "./fixtures/disclosure.js";
import { mockAllowlist, mockTrust } from "./fixtures/mock-flow.js";
import { host, invocation } from "./support/host.js";

const MEMBER_ID = "50001";

function fixture(overrides: Parameters<typeof host>[0] | null = null) {
  return host(
    overrides ?? {
      contract: disclosureContract,
      artifact: disclosureArtifact(),
      screens: disclosureScreens,
      transitions: DISCLOSURE_TRANSITIONS as never,
    },
  );
}

describe("the four arms, typed", () => {
  it("returns ok with every declared output when the flow completes", async () => {
    const { catalog } = fixture();
    const result = await catalog.invoke(
      disclosureContract,
      invocation(disclosureContract, { memberId: MEMBER_ID }),
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.outputs).toMatchObject({ resultCount: "1 record" });
  });

  it("returns the outcome arm - not an error - when the core has no such member", async () => {
    const { catalog } = fixture({
      contract: disclosureContract,
      artifact: disclosureArtifact(),
      screens: disclosureScreens,
      transitions: DISCLOSURE_NOT_FOUND_TRANSITIONS as never,
    });
    const result = await catalog.invoke(
      disclosureContract,
      invocation(disclosureContract, { memberId: MEMBER_ID }),
    );
    expect(result.status).toBe("outcome");
    if (result.status !== "outcome") return;
    expect(result.outcome).toBe("MEMBER_NOT_FOUND");
    expect(result.terminal).toBe(true);
    // The property the whole project turns on: no `error` field to read, on a different arm of the
    // union, reached by a return and never by a throw.
    expect(result).not.toHaveProperty("failure");
    expect(result).not.toHaveProperty("error");
  });

  it("returns argument-invalid, with zero actions guaranteed, for a malformed argument", async () => {
    const { catalog, opens } = fixture();
    const result = await catalog.invoke(
      disclosureContract,
      invocation(disclosureContract, { memberId: "abcde" }),
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("argument-invalid");
    expect(result.failure.sideEffects).toBe("none-guaranteed");
    expect(result.failure.atStep).toBeNull();
    // The cheapest classification touches nothing. No session was ever opened for the run.
    expect(opens()).toBe(0);
    expect(renderForAgent(result, disclosureContract).retryable).toBe("with_different_inputs");
  });
});

describe("the contract digest pin", () => {
  /** The same capability at the same version, with one line of reviewed prose changed - which is
   *  exactly the `patch` bump SPEC section 2.3 permits, and which changes the digest. */
  const revised = sealContract({
    ...disclosureContract,
    summary: "Reads three values about a member, one at each agent-disclosure level. (revised)",
  });

  it("changes the digest when the document changes at all", () => {
    expect(revised.digest).not.toBe(disclosureContract.digest);
    expect(revised.name).toBe(disclosureContract.name);
    expect(revised.version).toBe(disclosureContract.version);
  });

  it("returns `contract-stale` when the caller's generated types were built from another revision", async () => {
    const { catalog, opens } = fixture();
    const result = await catalog.invoke(revised, invocation(revised, { memberId: MEMBER_ID }));
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("contract-stale");
    // The whole point of catching it here: nothing ran, and the caller can be told so.
    expect(result.failure.sideEffects).toBe("none-guaranteed");
    expect(result.failure.atStep).toBeNull();
    expect(opens()).toBe(0);
    expect(result.failure.operatorAction).toMatch(/[Rr]egenerate/);
  });

  it("returns `contract-stale` when the caller pinned a different VERSION", async () => {
    const { catalog } = fixture();
    const result = await catalog.invoke(
      disclosureContract,
      invocation(
        disclosureContract,
        { memberId: MEMBER_ID },
        {
          capability: {
            name: disclosureContract.name,
            version: "2.0.0",
            contractDigest: disclosureContract.digest,
          },
        },
      ),
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("contract-stale");
  });

  it("tells the MODEL to escalate rather than to try again", async () => {
    const { catalog } = fixture();
    const result = await catalog.invoke(revised, invocation(revised, { memberId: MEMBER_ID }));
    const view = renderForAgent(result, disclosureContract);
    expect(view.status).toBe("error");
    expect(view.retryable).toBe("never");
    expect(view.guidance).toContain("changed since your tools were built");
    // And it is not told which document, which digest, or which check number.
    expect(JSON.stringify(view)).not.toContain(revised.digest);
  });

  it("links the CATALOG's contract and not the caller's, or the pin would compare a document to itself", async () => {
    // The proof: the run that came back stale used the same arguments and the same artifact as the
    // run that came back ok. The only difference is which contract the caller's types were built
    // from - so the comparison must be against the registered document.
    const okRun = await fixture().catalog.invoke(
      disclosureContract,
      invocation(disclosureContract, { memberId: MEMBER_ID }),
    );
    const staleRun = await fixture().catalog.invoke(
      revised,
      invocation(revised, { memberId: MEMBER_ID }),
    );
    expect(okRun.status).toBe("ok");
    expect(staleRun.status).toBe("failed");
  });
});

describe("invoke never rejects", () => {
  /** A broker that throws where a real one would fail to reach the app. */
  const brokenBroker: SessionBroker = {
    async open(): Promise<BrokeredSession> {
      throw new Error("ECONNREFUSED corebank.internal:8443");
    },
    async refresh() {
      return "failed";
    },
    async close() {},
  };

  it("converts a thrown host error into `failed / internal-invariant`", async () => {
    const catalog = new Catalog({ trust: mockTrust, clock: manualClock() }).register({
      contract: disclosureContract,
      artifact: disclosureArtifact(),
      allowlist: mockAllowlist,
      broker: brokenBroker,
    });

    const result = await catalog.invoke(
      disclosureContract,
      invocation(disclosureContract, { memberId: MEMBER_ID }),
    );
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    // "A system that cannot say 'I am broken' says 'you are' instead."
    expect(result.failure.class).toBe("internal-invariant");
    expect(result.failure.operatorAction).toContain("ECONNREFUSED");
    // A throw from inside a run cannot prove nothing was dispatched.
    expect(result.failure.sideEffects).toBe("possible");
  });

  it("does not leak the host's error text to the model", async () => {
    const catalog = new Catalog({ trust: mockTrust, clock: manualClock() }).register({
      contract: disclosureContract,
      artifact: disclosureArtifact(),
      allowlist: mockAllowlist,
      broker: brokenBroker,
    });
    const view = await catalog.callTool(
      "mock_member_disclose",
      { memberId: MEMBER_ID },
      {
        tenant: { tenantId: "riverbend", appInstanceId: "riverbend-mock" },
        onIntervention: "fail",
        correlation: { agentSessionId: "t1", requestedBy: "agent" },
      },
    );
    expect(view.status).toBe("error");
    expect(JSON.stringify(view)).not.toContain("ECONNREFUSED");
  });

  it("answers a tool nobody registered instead of throwing at the tool boundary", async () => {
    const catalog = new Catalog({ trust: mockTrust, clock: manualClock() });
    const view = await catalog.callTool(
      "corebank_does_not_exist",
      {},
      {
        tenant: { tenantId: "riverbend", appInstanceId: "riverbend-mock" },
        onIntervention: "fail",
        correlation: { agentSessionId: "t1", requestedBy: "agent" },
      },
    );
    expect(view.status).toBe("error");
    expect(view.retryable).toBe("never");
  });
});

describe("idempotency", () => {
  it("returns the prior result for a repeat key without driving the UI again", async () => {
    const store = new MemoryIdempotencyStore();
    const { catalog, opens } = host({
      contract: disclosureContract,
      artifact: disclosureArtifact(),
      screens: disclosureScreens,
      transitions: DISCLOSURE_TRANSITIONS as never,
      idempotency: store,
    });
    const inv = invocation(
      disclosureContract,
      { memberId: MEMBER_ID },
      { idempotencyKey: "agent-turn-9" },
    );

    const first = await catalog.invokeDetailed(disclosureContract, inv);
    const second = await catalog.invokeDetailed(disclosureContract, inv);

    expect(opens()).toBe(1);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.document).toEqual(first.document);
    expect(store.size).toBe(1);
  });

  it("de-duplicates a CONCURRENT repeat, which a value cache cannot", async () => {
    const store = new MemoryIdempotencyStore();
    const { catalog, opens } = host({
      contract: disclosureContract,
      artifact: disclosureArtifact(),
      screens: disclosureScreens,
      transitions: DISCLOSURE_TRANSITIONS as never,
      idempotency: store,
    });
    const inv = invocation(
      disclosureContract,
      { memberId: MEMBER_ID },
      { idempotencyKey: "agent-turn-9" },
    );

    const [a, b] = await Promise.all([
      catalog.invokeDetailed(disclosureContract, inv),
      catalog.invokeDetailed(disclosureContract, inv),
    ]);
    // One run of the UI. This is the assertion that stops a member getting two sub-accounts.
    expect(opens()).toBe(1);
    expect(a.document).toEqual(b.document);
  });

  it("scopes the key by capability, so two tools in one agent turn cannot read each other", () => {
    expect(idempotencyKeyOf({ name: "a.b", version: "1.0.0" }, "turn-1")).not.toBe(
      idempotencyKeyOf({ name: "a.c", version: "1.0.0" }, "turn-1"),
    );
    expect(idempotencyKeyOf({ name: "a.b", version: "1.0.0" }, "turn-1")).not.toBe(
      idempotencyKeyOf({ name: "a.b", version: "1.1.0" }, "turn-1"),
    );
  });

  it("does nothing at all when the host was given nowhere to remember", async () => {
    const { catalog, opens } = fixture();
    const inv = invocation(
      disclosureContract,
      { memberId: MEMBER_ID },
      { idempotencyKey: "agent-turn-9" },
    );
    await catalog.invokeDetailed(disclosureContract, inv);
    await catalog.invokeDetailed(disclosureContract, inv);
    expect(opens()).toBe(2);
  });
});

describe("the caller's budget", () => {
  it("tightens the artifact's ceiling and never raises it", async () => {
    const { catalog } = fixture();
    const raised = await catalog.invoke(
      disclosureContract,
      invocation(
        disclosureContract,
        { memberId: MEMBER_ID },
        {
          budget: { wallClockMs: 999_000_000, maxRemediations: 999 },
        },
      ),
    );
    expect(raised.status).toBe("ok");
    if (raised.status !== "ok") return;
    // The artifact declares 60_000 / 4. An approver signed over those; a caller cannot widen them.
    expect(raised.run.budgets.wallClockMs.limit).toBe(60_000);
    expect(raised.run.budgets.remediations.limit).toBe(4);

    const tightened = await fixture().catalog.invoke(
      disclosureContract,
      invocation(
        disclosureContract,
        { memberId: MEMBER_ID },
        {
          budget: { wallClockMs: 5_000, maxRemediations: 1 },
        },
      ),
    );
    if (tightened.status !== "ok") throw new Error(tightened.status);
    expect(tightened.run.budgets.wallClockMs.limit).toBe(5_000);
    expect(tightened.run.budgets.remediations.limit).toBe(1);
  });
});

describe("the model's door", () => {
  it("runs the same path and returns the poorer projection", async () => {
    const { catalog } = fixture();
    const view = await catalog.callTool(
      "mock_member_disclose",
      { memberId: MEMBER_ID },
      {
        tenant: { tenantId: "riverbend", appInstanceId: "riverbend-mock" },
        onIntervention: "fail",
        correlation: { agentSessionId: "t1", requestedBy: "agent" },
      },
    );
    expect(view.status).toBe("ok");
    expect(view.data).toEqual({ resultCount: "1 record", memberName: "<masked>" });
  });

  it("honours a harness that pinned a digest when it fetched its tool list", async () => {
    const { catalog } = fixture();
    const view = await catalog.callTool(
      "mock_member_disclose",
      { memberId: MEMBER_ID },
      {
        tenant: { tenantId: "riverbend", appInstanceId: "riverbend-mock" },
        onIntervention: "fail",
        correlation: { agentSessionId: "t1", requestedBy: "agent" },
        pinnedContractDigest: `sha256:${"0".repeat(64)}`,
      },
    );
    expect(view.status).toBe("error");
    expect(view.guidance).toContain("changed since your tools were built");
  });

  it("passes the model's raw arguments straight to the linker, which is the validator", async () => {
    const { catalog } = fixture();
    const view = await catalog.callTool(
      "mock_member_disclose",
      { memberId: 50001, extra: "not in the schema" },
      {
        tenant: { tenantId: "riverbend", appInstanceId: "riverbend-mock" },
        onIntervention: "fail",
        correlation: { agentSessionId: "t1", requestedBy: "agent" },
      },
    );
    expect(view.status).toBe("error");
    expect(view.retryable).toBe("with_different_inputs");
  });
});
