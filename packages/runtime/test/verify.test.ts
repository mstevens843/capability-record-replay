// Verification replay: the three modes, the grade, and the one assertion the whole amendment is for.
//
// SPEC section 11's acceptance test for build unit 15 is two sentences: "a write flow reaches
// `partial-up-to-irreversible` and DOES NOT perform the write twice; an edited approved artifact
// fails the digest check." The first sentence is this file. The second is `approval.test.ts`.
//
// The negative assertion is the load-bearing one and it is made twice over, because a test that
// only checks "the surface never saw the click" passes just as green against a run that never got
// off the ground. So the same fixture is also run to completion under `replay-reset`, where the
// click is dispatched EXACTLY ONCE - which is what proves the dry run withheld something real
// rather than failing early.
//
// No browser, no network, no credential. The surface is `MockSurface` over a frozen corpus.

import {
  type CapabilityArtifact,
  MOCK_LEASE_TOKEN,
  MockSurface,
  type MockTransition,
  type Observation,
  sealArtifact,
} from "@crr/core";
import { describe, expect, it } from "vitest";
import { manualClock } from "../src/clock.js";
import { MemoryEvidenceSink } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { MemoryJournal } from "../src/journal.js";
import { LifecycleError } from "../src/lifecycle.js";
import { replay } from "../src/replay.js";
import { StaticSessionBroker } from "../src/session.js";
import {
  type EnvironmentReset,
  type VerifyOptions,
  chooseVerificationMode,
  gradeVerification,
  verifyAndDraft,
  verifyArtifact,
} from "../src/verify.js";
import {
  IDS,
  MOCK_MEMBER_ID,
  mockAllowlist,
  mockArtifact,
  mockContract,
  screens as readScreens,
} from "./fixtures/mock-flow.js";
import {
  WRITE_IDS,
  WRITE_MEMBER_ID,
  proposedWriteArtifact,
  writeAllowlist,
  writeContract,
  writeScreens,
  writeTransitions,
} from "./fixtures/write-flow.js";
import { invocationApprovalFixture } from "./support/invocation-approval.js";
import { eventsOf } from "./support/journal.js";

const TENANT = { tenantId: "riverbend", appInstanceId: "riverbend-mock" };

/** The read fixture as synthesis would have emitted it: proposed, and carrying only a PLAN. */
function proposedReadArtifact(): CapabilityArtifact {
  const approved = mockArtifact();
  return sealArtifact({
    ...approved,
    lifecycle: { status: "proposed", supersedes: null, approval: null },
    verification: { ...approved.verification, status: "unverified" },
  });
}

const READ_TRANSITIONS: readonly MockTransition[] = [
  { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
  { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-typed" },
  { from: "search-typed", on: { kind: "click", target: IDS.searchButton }, to: "results" },
];

interface Rig {
  readonly surface: MockSurface;
  readonly options: VerifyOptions;
}

function rig(args: {
  readonly artifact: CapabilityArtifact;
  readonly contract: VerifyOptions["contract"];
  readonly screens: Readonly<Record<string, Observation>>;
  readonly transitions: readonly MockTransition[];
  readonly allowlist: VerifyOptions["allowlist"];
  readonly args: Readonly<Record<string, unknown>>;
  readonly reset?: EnvironmentReset | null;
  readonly approval?: VerifyOptions["approval"];
  readonly invocationApproval?: VerifyOptions["invocationApproval"];
  readonly approvalPolicyVersion?: VerifyOptions["approvalPolicyVersion"];
  readonly idempotencyKey?: string;
  readonly mode?: VerifyOptions["mode"];
}): Rig {
  const surface = new MockSurface({
    screens: args.screens,
    start: "blank",
    transitions: args.transitions,
    lease: MOCK_LEASE_TOKEN,
  });
  const clock = manualClock();
  return {
    surface,
    options: {
      contract: args.contract,
      artifact: args.artifact,
      args: args.args,
      tenant: TENANT,
      allowlist: args.allowlist,
      broker: new StaticSessionBroker(surface),
      clock,
      ids: sequentialIds("verify"),
      evidence: new MemoryEvidenceSink(),
      journal: (runId) => new MemoryJournal({ runId, clock }),
      ...(args.reset === undefined ? {} : { reset: args.reset }),
      ...(args.approval === undefined ? {} : { approval: args.approval }),
      ...(args.invocationApproval === undefined
        ? {}
        : { invocationApproval: args.invocationApproval }),
      ...(args.approvalPolicyVersion === undefined
        ? {}
        : { approvalPolicyVersion: args.approvalPolicyVersion }),
      ...(args.idempotencyKey === undefined ? {} : { idempotencyKey: args.idempotencyKey }),
      ...(args.mode === undefined ? {} : { mode: args.mode }),
    },
  };
}

const readRig = (transitions: readonly MockTransition[] = READ_TRANSITIONS): Rig =>
  rig({
    artifact: proposedReadArtifact(),
    contract: mockContract,
    screens: readScreens,
    transitions,
    allowlist: mockAllowlist,
    args: { memberId: MOCK_MEMBER_ID },
  });

const writeRig = (over: Partial<Parameters<typeof rig>[0]> = {}): Rig =>
  rig({
    artifact: proposedWriteArtifact(),
    contract: writeContract,
    screens: writeScreens,
    transitions: writeTransitions as unknown as readonly MockTransition[],
    allowlist: writeAllowlist(),
    args: { memberId: WRITE_MEMBER_ID },
    ...over,
  });

const confirmClicks = (surface: MockSurface): number =>
  surface.dispatched.filter(
    (d) => d.action.kind === "click" && d.action.target === WRITE_IDS.confirmButton,
  ).length;

// ---------------------------------------------------------------------------------------------

describe("choosing the mode", () => {
  it("plans replay-full for a read capability", () => {
    expect(chooseVerificationMode(proposedReadArtifact(), { reset: false })).toBe("replay-full");
  });

  it("plans replay-dry for a write capability with no way to undo it", () => {
    expect(chooseVerificationMode(proposedWriteArtifact(), { reset: false })).toBe("replay-dry");
  });

  it("upgrades to replay-reset only when the environment can actually be put back", () => {
    expect(chooseVerificationMode(proposedWriteArtifact(), { reset: true })).toBe("replay-reset");
  });
});

describe("replay-full", () => {
  it("replays a read capability end to end and grades it full", async () => {
    const { options } = readRig();
    const report = await verifyArtifact(options);

    expect(report.mode).toBe("replay-full");
    expect(report.status).toBe("verified");
    expect(report.grade).toBe("full");
    expect(report.coveredThroughStep).toBe("submit-search");
    expect(report.stoppedBeforeStep).toBeNull();
    expect(report.result?.status).toBe("ok");
    expect(report.verification).toMatchObject({
      mode: "replay-full",
      status: "verified",
      grade: "full",
    });
  });

  it("is refused outright for an artifact that writes", async () => {
    const { options } = writeRig({ mode: "replay-full" });
    await expect(verifyArtifact(options)).rejects.toBeInstanceOf(LifecycleError);
    await expect(verifyArtifact(options)).rejects.toThrow(/perform the write a second time/);
  });

  it("promotes the artifact to draft, and the draft's digest covers the verification", async () => {
    const { options } = readRig();
    const { report, artifact } = await verifyAndDraft(options);

    expect(report.status).toBe("verified");
    expect(artifact?.lifecycle.status).toBe("draft");
    expect(artifact?.verification.status).toBe("verified");
    // The verification record is inside the digest, so the draft is a different content address
    // from the proposal - which is what makes an approval over it an approval of the CLAIM.
    expect(artifact?.digest).not.toBe(options.artifact.digest);
  });
});

describe("replay-dry - the write flow", () => {
  it("grades partial-up-to-irreversible and names both the boundary and the coverage", async () => {
    const { options } = writeRig();
    const report = await verifyArtifact(options);

    expect(report.mode).toBe("replay-dry");
    expect(report.status).toBe("verified");
    expect(report.grade).toBe("partial-up-to-irreversible");
    expect(report.coveredThroughStep).toBe("open-new-subaccount");
    expect(report.stoppedBeforeStep).toBe("confirm-open");
    expect(report.result?.status).toBe("ok");
  });

  it("DOES NOT PERFORM THE WRITE: the confirm control is never dispatched", async () => {
    const { surface, options } = writeRig();
    const report = await verifyArtifact(options);

    expect(report.status).toBe("verified");
    expect(confirmClicks(surface)).toBe(0);
    // And the surface never moved on, which is the same fact stated from the app's side.
    expect(surface.screen).toBe("new-subaccount");
    expect(surface.dispatched.map((d) => d.action.kind)).toEqual([
      "navigate",
      "type",
      "click",
      "click",
    ]);
  });

  it("DOES NOT PERFORM THE WRITE TWICE: one run wrote, the verification that follows does not", async () => {
    // The acceptance test as SPEC section 11 words it, against ONE surface. The first run stands in
    // for the discovery run - the same program, run to completion, performing the write once. The
    // verification replay then follows it immediately, exactly as BRIEF section 3.4 describes, and
    // the assertion is that the count does not go to two.
    const artifact = proposedWriteArtifact();
    const surface = new MockSurface({
      screens: writeScreens,
      start: "blank",
      transitions: writeTransitions as unknown as readonly MockTransition[],
      lease: MOCK_LEASE_TOKEN,
    });
    const broker = new StaticSessionBroker(surface);
    const shared = {
      contract: writeContract,
      artifact,
      args: { memberId: WRITE_MEMBER_ID },
      tenant: TENANT,
      allowlist: writeAllowlist("WRITE_IRREVERSIBLE"),
      broker,
      clock: manualClock(),
      ids: sequentialIds("twice"),
      evidence: new MemoryEvidenceSink(),
    } as const;

    const discovery = await replay({
      ...shared,
      trust: { trustedKeyIds: [], verifySignature: () => false },
      mode: "verification",
      invocationApproval: invocationApprovalFixture({
        approvalId: "approval-verify-discovery-1",
        artifact,
        contract: writeContract,
        args: { memberId: WRITE_MEMBER_ID },
        idempotencyKey: "verify-discovery-write-1",
      }).grant,
      idempotencyKey: "verify-discovery-write-1",
    });
    expect(discovery.result.status).toBe("ok");
    expect(confirmClicks(surface)).toBe(1);

    const report = await verifyArtifact({ ...shared, mode: "replay-dry" });

    expect(report.status).toBe("verified");
    expect(report.grade).toBe("partial-up-to-irreversible");
    expect(report.stoppedBeforeStep).toBe("confirm-open");
    // ONE. Not two.
    expect(confirmClicks(surface)).toBe(1);
  });

  it("still proves the boundary step's locators: quorum was reached and no action followed", async () => {
    const { options } = writeRig();
    const report = await verifyArtifact(options);
    const journal = report.journal;
    if (journal === null) throw new Error("a run that reached the surface has a journal");

    const resolved = eventsOf(journal, "resolved").filter((e) => e.stepId === "confirm-open");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.agreed).toBe(true);
    expect(resolved[0]?.distinctSources).toBeGreaterThanOrEqual(2);

    // The audit evidence for "it did not act" is an ABSENCE, and it is a stronger record than any
    // event this could have invented: the boundary step was entered, observed, classified and
    // resolved, and nothing was dispatched at it.
    expect(eventsOf(journal, "step.entered").map((e) => e.stepId)).toContain("confirm-open");
    expect(eventsOf(journal, "acted").map((e) => e.stepId)).not.toContain("confirm-open");
  });

  it("needs no approval token, because the action that would require one is never attempted", async () => {
    const { options } = writeRig();
    expect(options.approval).toBeUndefined();
    const report = await verifyArtifact(options);
    expect(report.status).toBe("verified");
  });

  it("saves the draft with the partial grade, so an approver has to read it", async () => {
    const { options } = writeRig();
    const { artifact } = await verifyAndDraft(options);

    expect(artifact?.lifecycle.status).toBe("draft");
    expect(artifact?.verification).toMatchObject({
      mode: "replay-dry",
      status: "verified",
      grade: "partial-up-to-irreversible",
      coveredThroughStep: "open-new-subaccount",
    });
  });

  it("moves the boundary with the effect class rather than with a hard-coded step id", async () => {
    // The same flow with the irreversible marking one step earlier. Nothing else changes, so a
    // different boundary here can only have come from reading `Step.effect`.
    const { surface, options } = writeRig({
      artifact: proposedWriteArtifact({ irreversibleAt: "open" }),
    });
    const report = await verifyArtifact(options);

    expect(report.grade).toBe("partial-up-to-irreversible");
    expect(report.coveredThroughStep).toBe("submit-search");
    expect(report.stoppedBeforeStep).toBe("open-new-subaccount");
    expect(surface.screen).toBe("results");
    expect(confirmClicks(surface)).toBe(0);
  });

  it("claims nothing at all when the flow's first step is the irreversible one", async () => {
    // A dry run against such a flow has no prior step whose locators, checkpoint and parameter
    // binding it exercised, so `partial-up-to-irreversible` would be claiming coverage of an empty
    // set. Graded directly, because no valid artifact in this corpus has that shape - which is
    // itself the point: the branch has to be right without ever having been reached.
    const artifact = proposedWriteArtifact();
    const ok = (await verifyArtifact(readRig().options)).result;
    if (ok === null) throw new Error("the read verification returns a result document");

    const graded = gradeVerification(artifact, ok, { stepId: "open-search", stepIndex: 0 });
    expect(graded.grade).toBeNull();
    expect(graded.coveredThroughStep).toBeNull();
    expect(graded.stoppedBeforeStep).toBe("open-search");
    expect(graded.reason).toMatch(/covers nothing/);
  });
});

describe("replay-reset - the control that proves the dry run withheld something", () => {
  function resetHook(): { readonly hook: EnvironmentReset; readonly calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      hook: {
        id: "corebank-fixture-reset",
        reset: async (tenant) => {
          calls.push(tenant.tenantId);
          return "reset";
        },
      },
    };
  }

  it("runs the whole flow, performs the write EXACTLY ONCE, and grades full", async () => {
    const { hook, calls } = resetHook();
    const artifact = proposedWriteArtifact();
    const idempotencyKey = "verify-reset-write-1";
    const { surface, options } = writeRig({
      artifact,
      reset: hook,
      // Two deliberate acts, both required, and that is the point: the deployment has to permit a
      // write during a verification run, and a human has to have minted an invocation approval.
      allowlist: writeAllowlist("WRITE_IRREVERSIBLE"),
      invocationApproval: invocationApprovalFixture({
        approvalId: "approval-verify-reset-1",
        artifact,
        contract: writeContract,
        args: { memberId: WRITE_MEMBER_ID },
        idempotencyKey,
      }).grant,
      idempotencyKey,
    });

    const report = await verifyArtifact(options);

    expect(report.mode).toBe("replay-reset");
    expect(report.status).toBe("verified");
    expect(report.grade).toBe("full");
    expect(report.coveredThroughStep).toBe("confirm-open");
    expect(confirmClicks(surface)).toBe(1);
    expect(surface.screen).toBe("subaccount-done");
    // Before the run and after it. Before, because the discovery run left the environment mutated
    // and replaying from that state verifies the artifact against a screen it never recorded.
    expect(calls).toEqual(["riverbend", "riverbend"]);
    expect(report.reset).toMatchObject({ before: "reset", after: "reset" });
  });

  it("is refused when the deployment does not permit a write during verification", async () => {
    const { hook } = resetHook();
    const artifact = proposedWriteArtifact();
    const idempotencyKey = "verify-reset-policy-1";
    const { surface, options } = writeRig({
      artifact,
      reset: hook,
      invocationApproval: invocationApprovalFixture({
        approvalId: "approval-verify-policy-1",
        artifact,
        contract: writeContract,
        args: { memberId: WRITE_MEMBER_ID },
        idempotencyKey,
      }).grant,
      idempotencyKey,
    });

    const report = await verifyArtifact(options);
    expect(report.status).toBe("unverified");
    expect(report.result?.status).toBe("failed");
    expect(confirmClicks(surface)).toBe(0);
  });

  it("is refused when no approval token was minted for it", async () => {
    const { hook } = resetHook();
    const { surface, options } = writeRig({
      reset: hook,
      allowlist: writeAllowlist("WRITE_IRREVERSIBLE"),
    });

    const report = await verifyArtifact(options);
    expect(report.status).toBe("unverified");
    expect(report.reason).toMatch(/approval|policy/i);
    expect(confirmClicks(surface)).toBe(0);
  });

  it("does not silently downgrade the claim when the reset is unavailable", async () => {
    const { surface, options } = writeRig({
      reset: {
        id: "corebank-fixture-reset",
        reset: async () => "unavailable",
      },
    });

    const report = await verifyArtifact(options);
    expect(report.mode).toBe("replay-reset");
    expect(report.status).toBe("unverified");
    expect(report.grade).toBeNull();
    expect(report.reason).toMatch(/unavailable/);
    // Nothing ran at all: no session, no action, no half-verified artifact.
    expect(report.result).toBeNull();
    expect(surface.dispatched).toHaveLength(0);
  });

  it("is refused outright when the mode is asked for and no reset exists", async () => {
    const { options } = writeRig({ mode: "replay-reset" });
    await expect(verifyArtifact(options)).rejects.toBeInstanceOf(LifecycleError);
  });
});

describe("a verification that does not verify", () => {
  it("returns no draft when the replay reports a business outcome", async () => {
    const { report, artifact } = await verifyAndDraft(
      readRig([
        { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
        { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-typed" },
        {
          from: "search-typed",
          on: { kind: "click", target: IDS.searchButton },
          to: "results-empty",
        },
      ]).options,
    );

    expect(report.result?.status).toBe("outcome");
    expect(report.status).toBe("unverified");
    expect(report.grade).toBeNull();
    expect(report.reason).toMatch(/MEMBER_NOT_FOUND/);
    // BRIEF section 3.4, literally: only saved as a draft if the replay succeeded.
    expect(artifact).toBeNull();
  });

  it("returns no draft when the replay fails, and says where", async () => {
    const { report, artifact } = await verifyAndDraft(
      readRig([
        { from: "blank", on: { kind: "navigate", path: "/search" }, to: "search" },
        { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-typed" },
        {
          from: "search-typed",
          on: { kind: "click", target: IDS.searchButton },
          // A results grid with no link on it: the checkpoint's `node-exists` clause fails, which
          // is a HARD FAILURE rather than a business outcome and must be treated as one.
          to: "results-nolink",
        },
      ]).options,
    );

    expect(report.status).toBe("unverified");
    expect(artifact).toBeNull();
    expect(report.result?.status).toBe("failed");
    expect(report.reason).toMatch(/checkpoint-failed at step submit-search/);
  });
});
