// One scenario, one fresh engine, one run. Returns data; throws nothing the caller cannot grade.
//
// The engine under test is `@crr/runtime`'s real `replay()` in every case, including for the
// mutants. What a mutant substitutes is one of the two PURE DECISION FUNCTIONS the engine consults
// (`DecisionFunctions`), so a weakened engine still goes through the same linker, the same session
// broker, the same control lease, the same budget ledgers and the same journal as the shipping one.
// A mutant that were a stub would prove that the suite can tell a real engine from a stub; a mutant
// that is the real engine with one function replaced proves the suite can tell a real engine from a
// SUBTLY WRONG one, which is the only version of the claim worth making.

import { MOCK_LEASE_TOKEN, MockSurface, type MockTransition, type Observation } from "@crr/core";
import {
  MemoryEvidenceSink,
  MemoryJournal,
  type ReplayOutput,
  StaticSessionBroker,
  manualClock,
  replay,
  sequentialIds,
} from "@crr/runtime";
import type { ReplayEngine } from "../types.js";
import { type FlowOptions, allowlist, artifact, contract, trust } from "./flow.js";
import { IDS, MEMBER_ID, screens } from "./screens.js";

/** The happy path, and the baseline every fault scenario is a one-transition edit away from. */
export const HAPPY_PATH: readonly MockTransition[] = [
  { from: "blank", on: { kind: "navigate", path: "/teller/search" }, to: "search" },
  { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-member" },
  { from: "search-member", on: { kind: "type", target: IDS.branchField }, to: "search-ready" },
  { from: "search-ready", on: { kind: "click", target: IDS.searchButton }, to: "results" },
  { from: "results", on: { kind: "click", target: IDS.openLink }, to: "detail" },
  { from: "detail", on: { kind: "click", target: IDS.sharesTab }, to: "detail-shares" },
  // LAST, and unscoped: navigating to /teller/search shows the search screen from wherever you are.
  // It is what the fixture does, and it is what makes `restart-program` and the APP_ERROR remedy
  // reachable from the screen the fault left the session on.
  { on: { kind: "navigate", path: "/teller/search" }, to: "search" },
];

export interface HarnessOptions extends FlowOptions {
  readonly transitions?: readonly MockTransition[];
  readonly extraScreens?: Readonly<Record<string, Observation>>;
  readonly start?: string;
  readonly args?: Readonly<Record<string, unknown>>;
  /** Swapped out for the policy-denied scenario, which is the only one that narrows the gate. */
  readonly allowlist?: typeof allowlist;
  /** What the session broker says when the `reauthenticate` remedy calls it. A broker that cannot
   *  really re-authenticate must answer `failed`, or `session-expired-unrecoverable` is unreachable
   *  and a dead session looks recoverable forever. */
  readonly refresh?: () => Promise<"refreshed" | "reopened" | "failed">;
}

export interface HarnessRun {
  readonly out: ReplayOutput;
  readonly surface: MockSurface;
  readonly clock: ReturnType<typeof manualClock>;
}

export async function runFlow(engine: ReplayEngine, options: HarnessOptions): Promise<HarnessRun> {
  const surface = new MockSurface({
    screens: { ...screens, ...(options.extraScreens ?? {}) },
    start: options.start ?? "blank",
    transitions: options.transitions ?? HAPPY_PATH,
    lease: MOCK_LEASE_TOKEN,
  });
  const clock = manualClock();
  const out = await replay({
    contract,
    artifact: artifact(options),
    args: options.args ?? { memberId: MEMBER_ID },
    tenant: { tenantId: "riverbend", appInstanceId: "riverbend-teller" },
    allowlist: options.allowlist ?? allowlist,
    broker: new StaticSessionBroker(surface, {
      ...(options.refresh === undefined ? {} : { onRefresh: options.refresh }),
    }),
    trust,
    clock,
    ids: sequentialIds("cfm"),
    evidence: new MemoryEvidenceSink(),
    journal: (runId) => new MemoryJournal({ runId, clock }),
    // A headless conformance run has nobody to escalate to, so a suspension is graded as the
    // failure it is for this host rather than left parked on a desk no test is watching.
    onIntervention: "fail",
    ...(engine.decisions === undefined ? {} : { decisions: engine.decisions }),
  });
  return { out, surface, clock };
}
