// Observations, the journal, the lease, and the policy chokepoint's vocabulary.
//
// The journal tests are the ones that matter. Two of the project's rules are stated in SPEC section
// 2.10 as tests rather than conventions - no journal event may carry a value bound to a sensitive
// field, and every dispatched action must have been preceded by a policy decision - and the first of
// those is enforceable right here, in the shape of the events. An event type with a `value` field is
// an event type somebody will eventually populate.

import { describe, expect, it } from "vitest";
import {
  ActFaultSchema,
  ActionSchema,
  AllowlistSchema,
  InterventionSchema,
  JOURNAL_EVENT_TYPES,
  JournalEventSchema,
  LeaseSchema,
  LeaseSnapshotSchema,
  ObservationSchema,
  PolicyDecisionSchema,
  TaintHandleSchema,
  parseObservation,
  safeParseJournalEvent,
} from "../src/index.js";

const node = {
  id: "textbox:member-id",
  rawRole: "LayoutTableCell",
  ariaRole: "textbox",
  name: "Member ID",
  value: null,
  text: null,
  description: null,
  state: {
    disabled: false,
    focused: true,
    visible: true,
    checked: null,
    expanded: null,
    selected: null,
    required: true,
    invalid: false,
    readonly: false,
  },
  bounds: { x: 220, y: 96, w: 160, h: 22, unit: "px" },
  containerPath: [
    { kind: "frame", name: "content" },
    { kind: "landmark", role: "form", name: "Member Search" },
  ],
  parent: null,
  children: [],
  labelledBy: [],
  tablePosition: null,
  capacity: null,
  confidence: 1,
  live: false,
  masked: false,
};

const observation = {
  seq: 12,
  surface: { kind: "web-legacy", driver: "surface-browser@0.1.0" },
  route: { originAlias: "corebank", path: "/members/search", query: {}, frame: "content" },
  nodes: [node],
  roots: ["frame:content"],
  skeletonDigest: "sk:8f21c4",
  stability: { settled: true, generation: 4, pendingReason: null },
  nativeDialog: null,
  inputIntercepted: false,
};

describe("an observation", () => {
  it("round-trips, which is what makes a production failure a unit test", () => {
    expect(parseObservation(observation).seq).toBe(12);
  });

  it("carries a monotonic sequence rather than a clock", () => {
    // The classifier is a pure function and gets no clock. If an observation carried a timestamp,
    // the first thing somebody would do is compare two of them.
    expect(
      ObservationSchema.safeParse({ ...observation, at: "2026-02-12T09:14:02.000Z" }).success,
    ).toBe(false);
  });

  it("keeps a native dialog on its own channel, not among the nodes", () => {
    // A native confirm is invisible to the accessibility tree entirely, and a boolean "input is
    // intercepted" cannot carry the message text - which is exactly what you need in order to
    // decide accept versus dismiss.
    const withDialog = {
      ...observation,
      nativeDialog: { type: "confirm", message: "Post this transaction?", defaultValue: null },
    };
    expect(ObservationSchema.safeParse(withDialog).success).toBe(true);
  });

  it("distinguishes the driver's raw role from the normalized one", () => {
    // On a page of nested layout tables, folding them together makes "the row whose Member ID is X"
    // resolve to three elements. Only nodes with a non-null normalized role are candidate targets.
    expect(parseObservation(observation).nodes[0]?.rawRole).toBe("LayoutTableCell");
    expect(
      ObservationSchema.safeParse({
        ...observation,
        nodes: [{ ...node, ariaRole: null }],
      }).success,
    ).toBe(true);
    expect(
      ObservationSchema.safeParse({
        ...observation,
        nodes: [{ ...node, ariaRole: "unknown" }],
      }).success,
    ).toBe(false);
  });
});

describe("actions", () => {
  it("has no instruction that would open a hole through the surface abstraction", () => {
    for (const forbidden of [
      { kind: "evaluate", script: "document.forms[0].submit()" },
      { kind: "scroll", target: "textbox:member-id", by: 200 },
      { kind: "wait", ms: 500 },
      { kind: "screenshot" },
    ]) {
      expect(ActionSchema.safeParse(forbidden).success, JSON.stringify(forbidden)).toBe(false);
    }
    expect(ActionSchema.safeParse({ kind: "click", target: "button:search" }).success).toBe(true);
  });

  it("keeps the function keys at the port, where a driver can choose one", () => {
    expect(ActionSchema.safeParse({ kind: "pressKey", target: null, key: "F5" }).success).toBe(
      true,
    );
  });

  it("reports mechanical faults and never a business meaning", () => {
    expect(ActFaultSchema.safeParse({ kind: "node-gone", nodeId: "button:search" }).success).toBe(
      true,
    );
    expect(ActFaultSchema.safeParse({ kind: "member-not-found" }).success).toBe(false);
  });
});

describe("the journal", () => {
  const base = { seq: 4, runId: "run-2026-02-12-7c1d", at: "2026-02-12T09:14:03.100Z" };

  it("declares a schema for every event type it names", () => {
    const declared = JournalEventSchema.options.map((o) => o.shape.type.value);
    expect([...declared].sort()).toEqual([...JOURNAL_EVENT_TYPES].sort());
  });

  it("records what was typed as a handle and a length, never as text", () => {
    const acted = {
      ...base,
      type: "acted",
      stepId: "enter-member-id",
      actionKind: "type",
      targetTitle: "the Member ID box in the Member Search form",
      valueRef: "taint:memberId-1",
      valueLength: 5,
      result: "dispatched",
    };
    expect(safeParseJournalEvent(acted).success).toBe(true);
    // There is nowhere to put it, which is the point: a field that existed would be populated.
    expect(safeParseJournalEvent({ ...acted, value: "10042" }).success).toBe(false);
    expect(safeParseJournalEvent({ ...acted, text: "10042" }).success).toBe(false);
  });

  it("records that an output was extracted, not what it was", () => {
    const extracted = {
      ...base,
      type: "extracted",
      stepId: "read-savings-balance",
      output: "savingsBalance",
      sensitivity: "internal",
      present: true,
    };
    expect(safeParseJournalEvent(extracted).success).toBe(true);
    expect(safeParseJournalEvent({ ...extracted, value: "1284.55" }).success).toBe(false);
  });

  it("records argument SHAPES when a run starts", () => {
    const started = {
      ...base,
      type: "run.started",
      mode: "replay",
      capability: "corebank.member.read_savings_balance",
      artifactDigest: `sha256:${"0".repeat(64)}`,
      effectiveDigest: `sha256:${"0".repeat(64)}`,
      tenantId: "riverbend",
      argsShape: { memberId: "digits(5)" },
    };
    expect(safeParseJournalEvent(started).success).toBe(true);
    expect(safeParseJournalEvent({ ...started, args: { memberId: "10042" } }).success).toBe(false);
  });

  it("counts distinct evidence sources on a resolution, not just descriptors", () => {
    const resolved = {
      ...base,
      type: "resolved",
      stepId: "submit-search",
      descriptors: [
        {
          id: "search-by-name",
          kind: "role-name",
          evidenceSource: "accessibleName",
          verdict: "resolved",
          nodeId: "button:search",
        },
      ],
      agreed: true,
      distinctSources: 1,
    };
    expect(safeParseJournalEvent(resolved).success).toBe(true);
  });
});

describe("the lease", () => {
  const lease = {
    sessionId: "sess-7c1d",
    token: "lease-7c1d-1",
    holder: "automation",
    actorId: "run:run-2026-02-12-7c1d",
    acquiredAt: "2026-02-12T09:14:02.000Z",
    expiresAt: "2026-02-12T09:19:02.000Z",
    epoch: 3,
  };

  it("parses, and carries an epoch so a replayed token string is still dead", () => {
    expect(LeaseSchema.safeParse(lease).success).toBe(true);
    expect(LeaseSchema.safeParse({ ...lease, epoch: undefined }).success).toBe(false);
  });

  it("shows the policy engine the holder without showing it the token", () => {
    // A pure predicate has no business holding a credential, and it does not need one to answer
    // "does this actor hold the lease". The snapshot is strict, so handing the whole lease across
    // that boundary is refused rather than tolerated - which is the difference between a rule and
    // a habit.
    const { holder, actorId, epoch, expiresAt } = lease;
    expect(LeaseSnapshotSchema.safeParse({ holder, actorId, epoch, expiresAt }).success).toBe(true);
    expect(LeaseSnapshotSchema.safeParse(lease).success).toBe(false);
  });
});

describe("an intervention brief", () => {
  it("requires everything a human needs on one screen", () => {
    const brief = {
      capabilityTitle: "Read a member's savings balance",
      goalTemplate: "look up member {memberId} and read their savings balance",
      stepIndex: 3,
      stepTitle: "Open the matching member's record",
      whatWasExpected: { rendered: "the member detail route is loaded", clauses: [] },
      whatWasObserved: {
        route: null,
        settled: false,
        pendingReason: "navigating",
        skeletonDigest: "sk:unknown",
        nodeCount: 3,
        nativeDialog: null,
        inputIntercepted: false,
        salient: [],
        redactionsApplied: 0,
      },
      evidence: null,
      whyStopped: "The results grid rendered a layout this program has not seen before.",
      suggestedAction: "Open the console, find the member, and hand control back.",
    };
    const intervention = {
      id: "int-2026-02-12-0031",
      runId: "run-2026-02-12-7c1d",
      sessionId: "sess-7c1d",
      reason: "unclassified-state",
      raisedAt: "2026-02-12T09:14:07.000Z",
      expiresAt: "2026-02-12T09:24:07.000Z",
      state: "open",
      brief,
      resumeToken: "lease-7c1d-2",
      consoleUrl: "http://127.0.0.1:7717/interventions/int-2026-02-12-0031",
      resolution: null,
    };
    expect(InterventionSchema.safeParse(intervention).success).toBe(true);

    // A brief without the observation is a link to a log, and a link to a log is a second task.
    const { whatWasObserved, ...incomplete } = brief;
    void whatWasObserved;
    expect(InterventionSchema.safeParse({ ...intervention, brief: incomplete }).success).toBe(
      false,
    );
  });
});

describe("policy types", () => {
  it("allowlists routes as patterns, never hosts as strings", () => {
    // An alias is resolved from the tenant's own overlay rather than parsed out of wherever the page
    // navigated to, so a lookalike domain cannot satisfy the allowlist.
    const allowlist = {
      originAliases: ["corebank"],
      routes: [{ originAlias: "corebank", pathPattern: "/members/:memberId", maxEffect: "READ" }],
      actionKinds: ["click", "type", "navigate"],
      maxEffect: "READ",
      discoveryMaxEffect: "READ",
    };
    expect(AllowlistSchema.safeParse(allowlist).success).toBe(true);
    const withHost = {
      ...allowlist,
      routes: [
        {
          originAlias: "https://riverbend-cb.example.invalid",
          pathPattern: "/",
          maxEffect: "READ",
        },
      ],
    };
    expect(AllowlistSchema.safeParse(withHost).success).toBe(false);
  });

  it("makes every decision name the rule that produced it", () => {
    // An allow with no rule id is indistinguishable from a missing check, and proving "one
    // chokepoint" from the journal depends on being able to tell those apart.
    expect(
      PolicyDecisionSchema.safeParse({ allow: true, effect: "READ", ruleId: "route:member-detail" })
        .success,
    ).toBe(true);
    expect(PolicyDecisionSchema.safeParse({ allow: true, effect: "READ" }).success).toBe(false);
    expect(
      PolicyDecisionSchema.safeParse({
        allow: false,
        reason: "effect-exceeds-allowlist",
        ruleId: "allowlist:maxEffect",
        detail: "the step declares WRITE_IRREVERSIBLE and the allowlist permits READ",
      }).success,
    ).toBe(true);
  });

  it("carries tainted values as opaque handles", () => {
    expect(TaintHandleSchema.safeParse("taint:memberId-1").success).toBe(true);
    expect(TaintHandleSchema.safeParse("10042").success).toBe(false);
  });
});
