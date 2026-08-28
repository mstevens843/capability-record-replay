// The SPEC section 3.1 cycle, driven end to end over a scripted surface. NO BROWSER ANYWHERE.
//
// Each test puts exactly one thing wrong and asserts the arm, the class and the trace. That is the
// same discipline the classifier's own suite follows and it is why this file is worth having beside
// the browser one: the browser proves the engine works against a real hostile surface, and this
// proves it does the RIGHT thing when the surface misbehaves in a way you cannot ask a real one to.

import { MOCK_LEASE_TOKEN, MockSurface, type MockTransition } from "@crr/core";
import { describe, expect, it } from "vitest";
import { manualClock } from "../src/clock.js";
import { MemoryEvidenceSink } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { MemoryJournal } from "../src/journal.js";
import { replay } from "../src/replay.js";
import { StaticSessionBroker } from "../src/session.js";
import {
  IDS,
  MOCK_MEMBER_ID,
  type MockFlowOptions,
  mockAllowlist,
  mockArtifact,
  mockContract,
  mockTrust,
  screens,
} from "./fixtures/mock-flow.js";
import { eventsOf, journalText } from "./support/journal.js";

const HAPPY: readonly MockTransition[] = [
  { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
  { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-typed" },
  { from: "search-typed", on: { kind: "click", target: IDS.searchButton }, to: "results" },
];

interface RunOptions extends MockFlowOptions {
  readonly transitions?: readonly MockTransition[];
  readonly start?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly refresh?: () => Promise<"refreshed" | "reopened" | "failed">;
}

async function run(options: RunOptions = {}) {
  const surface = new MockSurface({
    screens,
    start: options.start ?? "blank",
    transitions: options.transitions ?? HAPPY,
    lease: MOCK_LEASE_TOKEN,
  });
  const clock = manualClock();
  const evidence = new MemoryEvidenceSink();
  const out = await replay({
    contract: mockContract,
    artifact: mockArtifact(options),
    args: options.args ?? { memberId: MOCK_MEMBER_ID },
    tenant: { tenantId: "riverbend", appInstanceId: "riverbend-mock" },
    allowlist: mockAllowlist,
    // The mock accepts one well-known token, so the lease sink is a no-op here and the port's
    // enforcement is exercised by `test/lease.test.ts` instead. What this proves is the OTHER two
    // placements: the gate at band G and the chokepoint's epoch comparison.
    broker: new StaticSessionBroker(surface, {
      ...(options.refresh === undefined ? {} : { onRefresh: options.refresh }),
    }),
    trust: mockTrust,
    clock,
    ids: sequentialIds("mock"),
    evidence,
    journal: (runId) => new MemoryJournal({ runId, clock }),
    onIntervention: "fail",
  });
  return { ...out, surface, evidence, clock };
}

describe("the happy path", () => {
  it("walks every step and returns ok with the extracted output", async () => {
    const { result, journal } = await run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.outputs).toEqual({ resultCount: "1 record" });
    expect(result.run.stepsExecuted).toBe(3);
    expect(result.run.steps.map((s) => s.stepId)).toEqual([
      "open-search",
      "enter-member-id",
      "submit-search",
    ]);
    // The cycle, in the journal, in order. This is the assertion that would catch a refactor that
    // quietly moved extraction before the checkpoint.
    const types = journal.events.map((e) => e.type);
    expect(types.indexOf("link.completed")).toBeLessThan(types.indexOf("session.opened"));
    expect(types.indexOf("session.opened")).toBeLessThan(types.indexOf("lease.acquired"));
    expect(types.lastIndexOf("checkpoint")).toBeLessThan(types.lastIndexOf("run.finished"));
  });

  it("charges a ledger for every action and every observation, and refills none of them", async () => {
    const { result } = await run();
    if (result.status !== "ok") throw new Error(result.status);
    // Three acting steps, three actions. Nothing in the engine may dispatch without charging.
    expect(result.run.budgets.actions.used).toBe(3);
    expect(result.run.budgets.observations.used).toBeGreaterThan(3);
    expect(result.run.budgets.remediations.used).toBe(0);
    expect(result.run.budgets.wallClockMs.limit).toBe(60_000);
  });

  it("puts a policy decision that names a rule in front of every dispatched action", async () => {
    const { journal } = await run();
    const acted = eventsOf(journal, "acted");
    const decided = eventsOf(journal, "policy.decided");
    expect(decided).toHaveLength(acted.length);
    for (const decision of decided) {
      expect((decision.decision as { ruleId: string }).ruleId).toMatch(/^route:/);
    }
  });

  it("never writes the caller's value into the journal", async () => {
    const { journal } = await run();
    expect(journalText(journal)).not.toContain(MOCK_MEMBER_ID);
    // But it does say WHICH value it was, by handle.
    expect(journalText(journal)).toContain("taint:");
  });

  it("freezes no evidence on a clean run, because every step captures only on failure", async () => {
    const { result, evidence } = await run();
    if (result.status !== "ok") throw new Error(result.status);
    // The journal itself is the only blob. `captureOn: ["failure"]` means a green run writes no
    // observation, which is what keeps an evidence directory readable.
    expect(evidence.refs().filter((r) => r.startsWith("obs:"))).toHaveLength(0);
  });
});

describe("a declared business outcome", () => {
  it("returns the outcome arm, terminally, with the contract's own guidance", async () => {
    const { result } = await run({
      transitions: [
        ...HAPPY.slice(0, 2),
        {
          from: "search-typed",
          on: { kind: "click", target: IDS.searchButton },
          to: "results-empty",
        },
      ],
    });
    expect(result.status).toBe("outcome");
    if (result.status !== "outcome") return;
    expect(result.outcome).toBe("MEMBER_NOT_FOUND");
    expect(result.terminal).toBe(true);
    expect(result.callerAction).toBe("retry-different-input");
    expect(result.detectedAt).toEqual({ stepId: "submit-search", stepIndex: 2, priority: 10 });
    // The run stopped there. `stepsExecuted` counts steps that ADVANCED, and this one did not.
    expect(result.run.stepsExecuted).toBe(2);
  });

  it("is a different arm from a failure, with no error object anywhere on it", async () => {
    const { result } = await run({
      transitions: [
        ...HAPPY.slice(0, 2),
        {
          from: "search-typed",
          on: { kind: "click", target: IDS.searchButton },
          to: "results-empty",
        },
      ],
    });
    // The property the whole result contract exists for: a caller cannot mistake this for an error,
    // and no `catch` block in the engine can observe it, because it arrived by a return.
    expect("failure" in result).toBe(false);
    expect(result.status).not.toBe("failed");
  });
});

describe("a declared recoverable condition", () => {
  it("dismisses an interception, re-walks from the declared resume point, and still returns ok", async () => {
    const { result, journal } = await run({
      noticeResume: "restart-from-checkpoint",
      transitions: [
        { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
        { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-typed" },
        // The notice arrives with the results, the first time only.
        {
          from: "search-typed",
          on: { kind: "click", target: IDS.searchButton },
          to: "results-notice",
          once: true,
        },
        // The remedy clears it in place, and the recovery then resumes at the declared entry point.
        { from: "results-notice", on: { kind: "click", target: IDS.noticeOk }, to: "results" },
        { from: "results", on: { kind: "navigate", path: "/search" }, to: "search" },
        { from: "search-typed", on: { kind: "click", target: IDS.searchButton }, to: "results" },
      ],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.run.recoveriesApplied).toEqual([
      { stepId: "submit-search", name: "DISMISS_SYSTEM_NOTICE", attempts: 1, result: "cleared" },
    ]);
    // The re-walk is visible: more step attempts than steps, which is the honest cost of a
    // recovery whose resume point is earlier than the step that raised it.
    expect(result.run.steps.length).toBeGreaterThan(3);
    expect(result.run.budgets.remediations.used).toBe(1);
    expect(eventsOf(journal, "recovery.applied")).toHaveLength(1);
  });

  it("refuses to spend a remedy on a step whose remediation budget is zero", async () => {
    // The trap `@crr/core`'s own status notes flagged: a step declaring `maxRemediationCycles: 0`
    // can never recover, so the flow's ambient rules are inert exactly where they were wanted.
    const { result } = await run({
      maxRemediationCycles: 0,
      transitions: [
        { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
        { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-notice" },
        { from: "search-notice", on: { kind: "click", target: IDS.noticeOk }, to: "search-typed" },
        { from: "search-typed", on: { kind: "click", target: IDS.searchButton }, to: "results" },
      ],
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("recovery-exhausted");
  });

  it("treats an interception nobody declared as a hard failure rather than dismissing it", async () => {
    // Fail-closed in one of its more consequential instances: answering a dialog nobody declared is
    // how an automation clicks "Yes, delete" on a member's behalf.
    const { result } = await run({
      transitions: [
        { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
        { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-dialog" },
      ],
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("undeclared-dialog");
    expect(result.failure.atStep).toBe("enter-member-id");
  });
});

describe("hard failures", () => {
  it("reports an app error page as app-error once the restart budget is spent", async () => {
    const { result, journal } = await run({
      transitions: [
        ...HAPPY.slice(0, 2),
        {
          from: "search-typed",
          on: { kind: "click", target: IDS.searchButton },
          to: "results-error",
        },
        // The remedy navigates back to the entry route; the restarted machine navigates there
        // again, gets there, and walks straight back into the same broken screen.
        { from: "results-error", on: { kind: "navigate", path: "/search" }, to: "search" },
        { from: "search", on: { kind: "navigate", path: "/search" }, bumpsGeneration: false },
      ],
      refresh: async () => "refreshed",
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("app-error");
    expect(eventsOf(journal, "restart.requested").map((e) => e.gate)).toEqual(["passed"]);
    expect(result.run.budgets.programAttempts).toEqual({ used: 1, limit: 1 });
  });

  it("stops with checkpoint-failed when a step lands somewhere nobody declared", async () => {
    const { result } = await run({
      transitions: [
        ...HAPPY.slice(0, 2),
        // Dispatches, changes the screen, and lands on a results page with no row on it - which
        // no declared outcome describes and the checkpoint refuses.
        {
          from: "search-typed",
          on: { kind: "click", target: IDS.searchButton },
          to: "results-nolink",
        },
      ],
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("checkpoint-failed");
    expect(result.failure.atStep).toBe("submit-search");
    // The clause-by-clause trace an operator reads at 2am, generated from the predicate rather than
    // authored beside it.
    expect(result.failure.expected.clauses.length).toBeGreaterThan(1);
    expect(result.failure.expected.clauses.some((c) => c.verdict === false)).toBe(true);
  });

  it("catches an action that dispatched and changed nothing", async () => {
    const { result } = await run({
      transitions: [
        ...HAPPY.slice(0, 2),
        {
          from: "search-typed",
          on: { kind: "click", target: IDS.searchButton },
          bumpsGeneration: false,
        },
      ],
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    // Otherwise indistinguishable from success on a page that looks similar before and after, which
    // is precisely why the weakest form of the delta assertion is still worth its keep.
    expect(result.failure.class).toBe("no-observable-effect");
  });

  it("freezes the observation that produced the verdict, so the failure becomes a unit test", async () => {
    const { result, evidence } = await run({
      transitions: [
        ...HAPPY.slice(0, 2),
        {
          from: "search-typed",
          on: { kind: "click", target: IDS.searchButton },
          to: "results-nolink",
        },
      ],
    });
    if (result.status !== "failed") throw new Error(result.status);
    const ref = result.failure.observationRef;
    expect(ref).toMatch(/^obs:/);
    const frozen = evidence.get(ref) as { nodes: unknown[] } | null;
    expect(frozen).not.toBeNull();
    expect(Array.isArray(frozen?.nodes)).toBe(true);
  });

  it("refuses the whole run before touching the surface when an argument is invalid", async () => {
    const { result, surface } = await run({ args: { memberId: "abc" } });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("argument-invalid");
    // The claim that makes this arm worth its own class: we did not touch anything, said as a FACT.
    expect(result.failure.sideEffects).toBe("none-guaranteed");
    expect(result.failure.atStep).toBeNull();
    expect(surface.dispatched).toHaveLength(0);
  });

  it("stops on budget-exhausted rather than running forever", async () => {
    const { result } = await run({ maxObservations: 4 });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.failure.class).toBe("budget-exhausted");
  });
});
