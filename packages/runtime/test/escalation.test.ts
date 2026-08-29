// SPEC section 7, end to end, over a scripted surface. NO BROWSER ANYWHERE.
//
// The whole point of build unit 16 is that the escalation path is a MECHANISM rather than a TODO, so
// these tests are arranged around the three claims that make it one:
//
//   1. exactly one controller, enforced by three independent gates that each refuse a different
//      caller (the desk, the policy chokepoint, and the driver itself);
//   2. an intervention brief that a person could act on with nothing else open, and which contains
//      no value the caller supplied;
//   3. a hand-back that RE-VERIFIES rather than continuing - and, the interesting half, correctly
//      refuses when the human left the session somewhere else.
//
// The last one is the acceptance criterion the build order names, and it is written three ways: the
// human wanders off to another route (`precondition-not-met`), the human investigates a different
// member (`continuity-broken`), and the human clears the hold properly (`ok`, human-assisted).

import {
  type Action,
  type Allowlist,
  FAILURE_GUIDANCE,
  FailureClassSchema,
  MOCK_LEASE_TOKEN,
  MockSurface,
  type MockTransition,
  type NodeId,
  type Observation,
  check,
} from "@crr/core";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "../src/clock.js";
import { type OperatorConsole, startOperatorConsole } from "../src/console.js";
import {
  ESCALATION,
  escalatesRegardlessOfCaller,
  escalationFor,
  isEscalatable,
} from "../src/escalation.js";
import { MemoryEvidenceSink } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { ControlPlane, OPERATOR_ACTION_EFFECT } from "../src/intervention.js";
import { MemoryJournal } from "../src/journal.js";
import { replay } from "../src/replay.js";
import { StaticSessionBroker } from "../src/session.js";
import {
  EIDS,
  MEMBER_ID,
  OTHER_MEMBER_ID,
  escalationArtifact,
  escalationContract,
  escalationScreens,
} from "./fixtures/escalation-flow.js";
import { mockAllowlist, mockTrust } from "./fixtures/mock-flow.js";
import { eventsOf, journalText } from "./support/journal.js";

// ---------------------------------------------------------------------------------------------
// The scripted world
// ---------------------------------------------------------------------------------------------

/** The automation walks to the hold screen and can go no further; every other transition is a HUMAN
 *  acting through the console, which is exactly the division the fixture is arranged to make
 *  visible. */
const TRANSITIONS: readonly MockTransition[] = [
  { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
  { from: "search", on: { kind: "type", target: EIDS.memberIdField }, to: "search-hold" },
  // -- the human's moves --
  { from: "search-hold", on: { kind: "click", target: EIDS.authorizeButton }, to: "search-typed" },
  { from: "search-hold", on: { kind: "click", target: EIDS.menuLink }, to: "menu" },
  // Retyping stays on the hold screen: the mock echoes the value into the field, which is exactly
  // what a legacy form does and is what makes the continuity check fire rather than the route one.
  { from: "search-hold", on: { kind: "type", target: EIDS.memberIdField } },
  // -- the automation, once the hold is cleared --
  { from: "search-typed", on: { kind: "click", target: EIDS.searchButton }, to: "results" },
];

const OPERATOR = "operator:pat";

interface Stuck {
  readonly control: ControlPlane;
  readonly surface: MockSurface;
  readonly clock: ReturnType<typeof manualClock>;
  readonly journal: MemoryJournal;
  readonly interventionId: string;
  readonly suspended: Awaited<ReturnType<typeof replay>>["result"];
}

async function stuck(overrides: { readonly allowlist?: Allowlist } = {}): Promise<Stuck> {
  const surface = new MockSurface({
    screens: escalationScreens,
    start: "blank",
    transitions: TRANSITIONS,
    lease: MOCK_LEASE_TOKEN,
  });
  const clock = manualClock();
  const control = new ControlPlane({ clock, interventionTtlMs: 600_000 });
  let journal!: MemoryJournal;

  const out = await replay({
    contract: escalationContract,
    artifact: escalationArtifact(),
    args: { memberId: MEMBER_ID },
    tenant: { tenantId: "riverbend", appInstanceId: "riverbend-mock" },
    allowlist: overrides.allowlist ?? mockAllowlist,
    broker: new StaticSessionBroker(surface),
    trust: mockTrust,
    clock,
    ids: sequentialIds("esc"),
    evidence: new MemoryEvidenceSink(),
    journal: (runId) => {
      journal = new MemoryJournal({ runId, clock });
      return journal;
    },
    onIntervention: "suspend",
    control,
  });

  if (out.result.status !== "suspended") {
    throw new Error(`expected a suspension, got ${out.result.status}`);
  }
  return {
    control,
    surface,
    clock,
    journal,
    interventionId: out.result.intervention.id,
    suspended: out.result,
  };
}

const click = (target: NodeId): Action => ({ kind: "click", target }) as Action;

let openConsole: OperatorConsole | null = null;
afterEach(async () => {
  await openConsole?.close();
  openConsole = null;
});

// ---------------------------------------------------------------------------------------------
// 1. What is escalatable at all
// ---------------------------------------------------------------------------------------------

describe("what counts as stuck (SPEC 7.2)", () => {
  it("decides for EVERY failure class, so a new one cannot arrive undecided", () => {
    for (const failure of FailureClassSchema.options) {
      expect(Object.hasOwn(ESCALATION, failure)).toBe(true);
    }
    expect(Object.keys(ESCALATION).length).toBe(FailureClassSchema.options.length);
  });

  it("never escalates the six failures a human at the app cannot fix by clicking", () => {
    for (const failure of [
      "link-error",
      "argument-invalid",
      "contract-stale",
      "artifact-invalid",
      "policy-denied",
      "internal-invariant",
    ] as const) {
      expect(isEscalatable(failure)).toBe(false);
      expect(escalationFor(failure)).toBeNull();
    }
  });

  it("escalates the conditions a person at a terminal could actually finish", () => {
    expect(escalationFor("recovery-exhausted")).toBe("recovery-exhausted");
    expect(escalationFor("target-ambiguous")).toBe("target-ambiguous");
    expect(escalationFor("session-expired-unrecoverable")).toBe("session-lost");
    expect(escalationFor("checkpoint-failed")).toBe("unclassified-state");
    expect(escalationFor("undeclared-dialog")).toBe("unclassified-state");
  });

  it("escalates effect-in-doubt regardless of what the caller asked for", () => {
    expect(escalatesRegardlessOfCaller("effect-in-doubt")).toBe(true);
    expect(escalatesRegardlessOfCaller("checkpoint-failed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Suspension, and the brief
// ---------------------------------------------------------------------------------------------

describe("suspension", () => {
  it("returns the suspended arm rather than a failure, and parks a live session", async () => {
    const { suspended, control } = await stuck();
    expect(suspended.status).toBe("suspended");
    if (suspended.status !== "suspended") return;
    expect(suspended.intervention.reason).toBe("recovery-exhausted");
    expect(suspended.intervention.atStep).toBe("submit-search");
    // Not terminal: the caller is told when to look again, not that the job failed.
    expect(suspended.resume.pollAfterMs).toBeGreaterThan(0);
    expect(control.stateOf(suspended.intervention.id)).toBe("HUMAN_OFFERED");
  });

  it("carries a brief a person could act on with nothing else open", async () => {
    const { control, interventionId } = await stuck();
    const intervention = control.get(interventionId);
    expect(intervention).not.toBeNull();
    const brief = intervention?.brief;
    expect(brief?.capabilityTitle).toContain("Find a member");
    expect(brief?.stepTitle).toBe("Run the search");
    expect(brief?.stepIndex).toBe(2);
    expect(brief?.whyStopped).toContain("declared recovery");
    // The artifact author's own sentence about THIS condition, beside the table's generic one.
    expect(brief?.whyStopped).toContain("manual review hold");
    expect(brief?.suggestedAction.length).toBeGreaterThan(0);
    expect(brief?.whatWasExpected.rendered.length).toBeGreaterThan(0);
    expect(brief?.whatWasObserved.nodeCount).toBeGreaterThan(0);
  });

  it("puts the GOAL TEMPLATE on the brief and the member number nowhere", async () => {
    const { control, interventionId, journal } = await stuck();
    const intervention = control.get(interventionId);
    expect(intervention?.brief.goalTemplate).toBe("find member {memberId}");
    expect(JSON.stringify(intervention)).not.toContain(MEMBER_ID);
    expect(journalText(journal)).not.toContain(MEMBER_ID);
  });

  it("journals the intervention it raised", async () => {
    const { journal, interventionId } = await stuck();
    const raised = eventsOf(journal, "intervention.raised");
    expect(raised).toHaveLength(1);
    expect(raised[0]?.interventionId).toBe(interventionId);
    expect(raised[0]?.reason).toBe("recovery-exhausted");
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Exactly one controller - three gates, three different callers refused
// ---------------------------------------------------------------------------------------------

describe("the lease is enforcement, not convention", () => {
  it("refuses an action from an operator who has not claimed - NOBODY may act while it is offered", async () => {
    const { control, interventionId } = await stuck();
    const refused = await control.inject(interventionId, OPERATOR, click(EIDS.authorizeButton));
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("wrong-state");
    expect(refused.detail).toContain("claim it before acting");
  });

  it("refuses a SECOND operator once the first has claimed", async () => {
    const { control, interventionId } = await stuck();
    expect((await control.claim(interventionId, OPERATOR)).ok).toBe(true);
    const refused = await control.inject(
      interventionId,
      "operator:chris",
      click(EIDS.authorizeButton),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("not-holder");
  });

  it("refuses AT THE PORT the token the caller was handed on the suspended arm", async () => {
    const { control, interventionId, surface, suspended } = await stuck();
    if (suspended.status !== "suspended") return;
    const before = await surface.act(click(EIDS.authorizeButton), suspended.resume.token);
    // Before the claim that token is the live grant, so the driver would accept it. That is the
    // whole reason the claim bumps the epoch.
    expect(before.ok).toBe(true);

    await control.claim(interventionId, OPERATOR);
    const after = await surface.act(click(EIDS.authorizeButton), suspended.resume.token);
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.fault.kind).toBe("lease-not-held");
  });

  it("refuses AT THE CHOKEPOINT an automation acting while a human holds the session", async () => {
    const { control, interventionId } = await stuck();
    const claimed = await control.claim(interventionId, OPERATOR);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;

    // The same `check`, the same rule 1, asked from the automation's side: `mode: "replay"` expects
    // an `automation` holder and the lease says `human`.
    const decision = check(
      click(EIDS.searchButton),
      {
        mode: "replay",
        allowlist: mockAllowlist,
        step: null,
        route: { originAlias: "corebank", path: "/search" },
        effect: "READ",
        lease: {
          holder: "human",
          actorId: OPERATOR,
          epoch: claimed.view.epoch,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        approval: null,
        artifact: { lifecycle: "approved", digestVerified: true },
        taint: [],
        approvedDigest: null,
      } as never,
      { now: "2026-02-11T14:00:00.000Z", epoch: claimed.view.epoch } as never,
    );
    expect(decision.allow).toBe(false);
    if (decision.allow) return;
    expect(decision.reason).toBe("lease-not-held");
    expect(decision.ruleId).toBe("lease:holder");
  });

  it("refuses an irreversible action through the console, because the desk carries no token", async () => {
    const permissive: Allowlist = {
      ...mockAllowlist,
      maxEffect: "WRITE_IRREVERSIBLE",
      routes: mockAllowlist.routes.map((r) => ({ ...r, maxEffect: "WRITE_IRREVERSIBLE" as const })),
    };
    const { control, interventionId } = await stuck({ allowlist: permissive });
    await control.claim(interventionId, OPERATOR);
    const refused = await control.inject(interventionId, OPERATOR, {
      kind: "acceptDialog",
      text: null,
    } as Action);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("policy-denied");
    expect(refused.decision?.allow).toBe(false);
    if (refused.decision?.allow !== false) return;
    expect(refused.decision.reason).toBe("irreversible-requires-approval");
    expect(OPERATOR_ACTION_EFFECT.acceptDialog).toBe("WRITE_IRREVERSIBLE");
  });

  it("clamps an operator's declared effect upward only, never downward", async () => {
    const { control, interventionId } = await stuck();
    await control.claim(interventionId, OPERATOR);
    // `type` is WRITE_REVERSIBLE by the table; declaring READ must not lower it below the READ-only
    // allowlist's ceiling... which it already exceeds, so the refusal is the proof.
    const refused = await control.inject(
      interventionId,
      OPERATOR,
      {
        kind: "type",
        target: EIDS.memberIdField,
        text: "1",
        mode: "replace",
        sensitive: false,
      } as Action,
      "READ",
    );
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.decision?.allow !== false) return;
    expect(refused.decision.reason).toBe("effect-exceeds-allowlist");
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The human acts, in the same live session, attributed
// ---------------------------------------------------------------------------------------------

describe("the human's actions", () => {
  it("go through the policy chokepoint and are journaled by TITLE, never by value", async () => {
    const { control, interventionId, journal, surface } = await stuck();
    await control.claim(interventionId, OPERATOR);
    const acted = await control.inject(interventionId, OPERATOR, click(EIDS.authorizeButton));
    expect(acted.ok).toBe(true);
    if (!acted.ok) return;

    // It landed in the SAME live session: the surface really moved.
    expect(surface.screen).toBe("search-typed");

    const human = eventsOf(journal, "human.acted");
    expect(human).toHaveLength(1);
    expect(human[0]?.actorId).toBe(OPERATOR);
    expect(human[0]?.actionKind).toBe("click");
    expect(human[0]?.targetTitle).toBe("Authorize");

    // One policy decision per action, human or automation - the chokepoint does not have a bypass
    // for a person.
    const decided = eventsOf(journal, "policy.decided");
    expect(decided.length).toBeGreaterThan(0);
    expect(journalText(journal)).not.toContain(MEMBER_ID);
  });

  it("shows the operator a masked live view built from the PORT, not from a browser", async () => {
    const { control, interventionId } = await stuck();
    const claimed = await control.claim(interventionId, OPERATOR);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const view = claimed.view;

    expect(view.surface).toBe("web-legacy");
    // The surface's own first advertised format. The console never asks for a screenshot by name.
    expect(view.captureFormat).toBe("image");
    // Masked BEFORE the bytes existed: the member-id field is bound to a sensitive parameter, so its
    // rectangle is in the request the driver was given.
    expect(view.capture).not.toBeNull();
    expect(view.capture?.maskedRegions).toBeGreaterThan(0);
    expect(view.captureRefused).toEqual([]);
    expect(view.observed.route?.path).toBe("/search");
    expect(view.nodes.some((n) => n.id === EIDS.authorizeButton && n.actionable)).toBe(true);
    // The member number was typed into the field; the view must not print it back.
    expect(JSON.stringify(view)).not.toContain(MEMBER_ID);
  });

  it("takes NO capture at all when a sensitive region cannot be masked", async () => {
    // A surface that reports no geometry cannot be blanked, and `deriveMaskRegions` cannot tell
    // "this surface has no pixels" from "we failed to find the pixels of a member number". The
    // conservative reading wins: no capture is taken, and the refusal is reported with the node ids
    // that caused it. A screenshot that was ever unmasked in memory is a screenshot that can leak.
    const hold = escalationScreens["search-hold"] as Observation;
    const surface = new MockSurface({
      screens: {
        ...escalationScreens,
        "search-hold": {
          ...hold,
          nodes: hold.nodes.map((n) => ({ ...n, bounds: null })),
        },
      } as typeof escalationScreens,
      start: "blank",
      transitions: TRANSITIONS,
      lease: MOCK_LEASE_TOKEN,
    });
    const clock = manualClock();
    const control = new ControlPlane({ clock });
    const out = await replay({
      contract: escalationContract,
      artifact: escalationArtifact(),
      args: { memberId: MEMBER_ID },
      tenant: { tenantId: "riverbend", appInstanceId: "riverbend-mock" },
      allowlist: mockAllowlist,
      broker: new StaticSessionBroker(surface),
      trust: mockTrust,
      clock,
      ids: sequentialIds("esc"),
      evidence: new MemoryEvidenceSink(),
      journal: (runId) => new MemoryJournal({ runId, clock }),
      onIntervention: "suspend",
      control,
    });
    if (out.result.status !== "suspended") throw new Error("expected a suspension");
    const claimed = await control.claim(out.result.intervention.id, OPERATOR);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.view.capture).toBeNull();
    expect(claimed.view.captureRefused.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Hand-back: the seven-step re-check
// ---------------------------------------------------------------------------------------------

describe("hand-back re-verifies where the run is (SPEC 7.4)", () => {
  it("resumes and finishes when the human cleared the hold properly", async () => {
    const { control, interventionId, journal } = await stuck();
    await control.claim(interventionId, OPERATOR);
    await control.inject(interventionId, OPERATOR, click(EIDS.authorizeButton));

    const handed = await control.handBack(interventionId, OPERATOR);
    expect(handed.ok).toBe(true);
    if (!handed.ok) return;

    expect(handed.result.status).toBe("ok");
    if (handed.result.status !== "ok") return;
    expect(handed.result.outputs).toEqual({ resultCount: "1 record" });

    // A run a person touched is never reported as a purely automated success.
    expect(handed.result.run.attribution.by).toBe("human-assisted");
    const transfers = handed.result.run.attribution.transfers;
    expect(transfers.map((t) => `${t.from}->${t.to}`)).toContain("human->automation");
    const back = transfers.find((t) => t.to === "automation");
    expect(back?.actorId).toBe(OPERATOR);
    expect(back?.actionsPerformed).toEqual([{ kind: "click", targetTitle: "Authorize" }]);

    // All seven checks, and the seventh says the step re-ran from the top rather than the middle.
    expect(handed.checks.map((c) => c.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(handed.checks.every((c) => c.passed)).toBe(true);
    expect(handed.checks[0]?.note).toContain("handoff-resume");
    expect(handed.checks[6]?.note).toContain("from the top of the cycle");

    expect(eventsOf(journal, "intervention.resolved")[0]?.disposition).toBe("resume");
  });

  it("REFUSES when the human navigated away - the acceptance case", async () => {
    const { control, interventionId } = await stuck();
    await control.claim(interventionId, OPERATOR);
    // The operator goes off to look something up and forgets to come back to the search screen.
    const wandered = await control.inject(interventionId, OPERATOR, click(EIDS.menuLink));
    expect(wandered.ok).toBe(true);

    const handed = await control.handBack(interventionId, OPERATOR);
    expect(handed.ok).toBe(true);
    if (!handed.ok) return;

    expect(handed.result.status).toBe("failed");
    if (handed.result.status !== "failed") return;
    expect(handed.result.failure.class).toBe("precondition-not-met");
    // Naming the step is the requirement: "it returns `failed / precondition-not-met` naming the
    // step".
    expect(handed.result.failure.atStep).toBe("submit-search");
    expect(handed.result.failure.expected.rendered).toContain("submit-search");
    expect(handed.result.failure.operatorAction).toBe(
      FAILURE_GUIDANCE["precondition-not-met"].operatorAction,
    );

    // The re-check stopped AT step 4, having passed 1 to 3 - which is what makes the report a
    // diagnosis rather than a shrug.
    expect(handed.checks.map((c) => c.step)).toEqual([1, 2, 3, 4]);
    expect(handed.checks.filter((c) => c.passed).map((c) => c.step)).toEqual([1, 2, 3]);
    const failed = handed.checks.at(-1);
    expect(failed?.passed).toBe(false);
    expect(failed?.name).toBe("step precondition re-verified");

    // And nothing resumed: the run is over, and the desk holds no session.
    expect(control.stateOf(interventionId)).toBe("TERMINATED");
  });

  it("REFUSES on continuity when the human left the session on a different member", async () => {
    const permissive: Allowlist = {
      ...mockAllowlist,
      maxEffect: "WRITE_REVERSIBLE",
      routes: mockAllowlist.routes.map((r) => ({ ...r, maxEffect: "WRITE_REVERSIBLE" as const })),
    };
    const { control, interventionId } = await stuck({ allowlist: permissive });
    await control.claim(interventionId, OPERATOR);
    const retyped = await control.inject(interventionId, OPERATOR, {
      kind: "type",
      target: EIDS.memberIdField,
      text: OTHER_MEMBER_ID,
      mode: "replace",
      sensitive: false,
    } as Action);
    expect(retyped.ok).toBe(true);

    const handed = await control.handBack(interventionId, OPERATOR);
    expect(handed.ok).toBe(true);
    if (!handed.ok) return;
    expect(handed.result.status).toBe("failed");
    if (handed.result.status !== "failed") return;
    expect(handed.result.failure.class).toBe("continuity-broken");
    expect(handed.checks.map((c) => c.step)).toEqual([1, 2, 3, 4, 5]);
    expect(handed.checks.at(-1)?.passed).toBe(false);
    expect(handed.checks.at(-1)?.name).toBe("continuity re-verified");
  });

  it("refuses to resume into a screen that has not settled, and keeps the human in control", async () => {
    const { control, interventionId, surface } = await stuck();
    await control.claim(interventionId, OPERATOR);
    // Out of band, because a repaint is not something the operator did: the screen is mid-render
    // when they press Hand back.
    surface.goto("search-hold-loading");

    const handed = await control.handBack(interventionId, OPERATOR);
    expect(handed.ok).toBe(false);
    if (handed.ok) return;
    expect(handed.code).toBe("not-settled");
    // NOT a failure, and NOT a resume. The run is still parked and the operator still holds it, so
    // they can simply press the button again.
    expect(control.stateOf(interventionId)).toBe("HUMAN_HELD");
    expect(control.resultOf(interventionId)).toBeNull();
  });

  it("terminates on a declared business outcome rather than resuming into it", async () => {
    const { control, interventionId, surface } = await stuck();
    await control.claim(interventionId, OPERATOR);
    // The operator ran the search by hand and it came back empty. That is an ANSWER, and resuming
    // into it would re-run the search and report the answer as if the automation had found it.
    surface.goto("results-empty");

    const handed = await control.handBack(interventionId, OPERATOR);
    expect(handed.ok).toBe(true);
    if (!handed.ok) return;
    expect(handed.result.status).toBe("outcome");
    if (handed.result.status !== "outcome") return;
    expect(handed.result.outcome).toBe("MEMBER_NOT_FOUND");
    // The caller is told the declared guidance from the CONTRACT, not something generated here.
    expect(handed.result.guidance).toContain("not on file");
    expect(handed.result.run.attribution.by).toBe("human-assisted");
    // The re-check stopped at 3, twice over: the pre-phase classification found nothing to report,
    // and the business-outcome probe that follows it did. An outcome is terminal, so there is
    // nothing left to precondition.
    expect(handed.checks.map((c) => c.step)).toEqual([1, 2, 3, 3]);
    expect(handed.checks.at(-1)?.note).toContain("MEMBER_NOT_FOUND");
  });

  it("refuses a hand-back from anyone but the operator who claimed", async () => {
    const { control, interventionId } = await stuck();
    await control.claim(interventionId, OPERATOR);
    const refused = await control.handBack(interventionId, "operator:chris");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe("not-holder");
    expect(control.stateOf(interventionId)).toBe("HUMAN_HELD");
  });

  it("orphans a lease whose TTL passed and ends the run rather than holding a browser open", async () => {
    const { control, interventionId, clock } = await stuck();
    await control.claim(interventionId, OPERATOR);
    // The lease TTL (5 minutes) is shorter than this intervention's own deadline (10), so the lease
    // is what expires first - which is the orphan detector doing its job rather than the SLA.
    clock.advance(300_001);
    await control.sweep();
    expect(control.stateOf(interventionId)).toBe("TERMINATED");
    const settled = control.resultOf(interventionId);
    expect(settled?.status).toBe("failed");
    if (settled?.status !== "failed") return;
    expect(settled.failure.class).toBe("lease-lost");
  });

  it("aborting ends the run as failed rather than leaving the caller waiting", async () => {
    const { control, interventionId } = await stuck();
    await control.claim(interventionId, OPERATOR);
    const aborted = await control.abort(interventionId, OPERATOR, "the member hung up");
    expect(aborted.ok).toBe(true);
    if (!aborted.ok) return;
    expect(aborted.result.status).toBe("failed");
    if (aborted.result.status !== "failed") return;
    expect(aborted.result.failure.class).toBe("recovery-exhausted");
    expect(aborted.result.failure.expected.rendered).toContain("the member hung up");
    expect(control.stateOf(interventionId)).toBe("TERMINATED");
  });

  it("converts an expired intervention into a failure rather than holding a session forever", async () => {
    const { control, interventionId, clock } = await stuck();
    clock.advance(600_001);
    await control.sweep();
    expect(control.stateOf(interventionId)).toBe("TERMINATED");
    const settled = control.resultOf(interventionId);
    expect(settled?.status).toBe("failed");
    if (settled?.status !== "failed") return;
    expect(settled.failure.class).toBe("recovery-exhausted");
    expect(control.get(interventionId)?.state).toBe("expired");
  });
});

// ---------------------------------------------------------------------------------------------
// 6. The console: the same six routes, over HTTP, with no browser and no build step
// ---------------------------------------------------------------------------------------------

describe("the operator console", () => {
  async function json(url: string, init?: RequestInit): Promise<{ status: number; body: never }> {
    const res = await fetch(url, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json()) as never };
  }

  it("drives suspend -> claim -> act -> hand-back -> resume over its six routes", async () => {
    const { control, interventionId } = await stuck();
    openConsole = await startOperatorConsole({ control });
    const base = openConsole.url;

    // GET /interventions
    const list = await json(`${base}/interventions`);
    expect(list.status).toBe(200);
    expect((list.body as { open: { id: string }[] }).open.map((r) => r.id)).toContain(
      interventionId,
    );

    // GET /interventions/:id - the brief
    const detail = await json(`${base}/interventions/${interventionId}`);
    expect(detail.status).toBe(200);
    const shown = detail.body as { intervention: { brief: { stepTitle: string } } };
    expect(shown.intervention.brief.stepTitle).toBe("Run the search");

    const post = (verb: string, body: unknown) =>
      json(`${base}/interventions/${interventionId}/${verb}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // POST claim
    const claimed = await post("claim", { operatorId: OPERATOR });
    expect(claimed.status).toBe(200);

    // POST act - into the SAME live session
    const acted = await post("act", {
      operatorId: OPERATOR,
      action: { kind: "click", target: EIDS.authorizeButton },
    });
    expect(acted.status).toBe(200);

    // POST handback
    const handed = await post("handback", { operatorId: OPERATOR });
    expect(handed.status).toBe(200);
    expect((handed.body as { result: { status: string } }).result.status).toBe("ok");
  });

  it("puts its own URL on the intervention, so the brief is a link a person can open", async () => {
    const { control, interventionId } = await stuck();
    openConsole = await startOperatorConsole({ control });
    expect(control.get(interventionId)?.consoleUrl).toBe(
      `${openConsole.url}/interventions/${interventionId}`,
    );
  });

  it("serves a page with no script, no stylesheet and no build step", async () => {
    const { control, interventionId } = await stuck();
    openConsole = await startOperatorConsole({ control });
    const res = await fetch(`${openConsole.url}/interventions/${interventionId}`);
    const html = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).not.toContain("<script");
    expect(html).toContain("Run the search");
    expect(html).toContain("Hand back");
    // The masked capture's content address, not bytes - and the page says so.
    expect(html).toContain("content address");
    expect(html).not.toContain(MEMBER_ID);
  });

  it("refuses a POST with no operator id, because the console has no identity of its own", async () => {
    const { control, interventionId } = await stuck();
    openConsole = await startOperatorConsole({ control });
    const res = await json(`${openConsole.url}/interventions/${interventionId}/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("binds to the loopback interface by default", async () => {
    const { control } = await stuck();
    openConsole = await startOperatorConsole({ control });
    expect(openConsole.url.startsWith("http://127.0.0.1:")).toBe(true);
  });
});
