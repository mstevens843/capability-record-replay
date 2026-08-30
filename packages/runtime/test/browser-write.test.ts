// THE IRREVERSIBLE WRITE, AGAINST A REAL BROWSER. `docs/design/FINAL-STATUS.md` section 7.3.
//
// The write path was proved against `MockSurface` - `verify.test.ts` (21 tests) and
// `escalation.test.ts` (31) cover the irreversible boundary, `partial-up-to-irreversible`, and
// "does not perform the write twice" - and never against a browser, because the fixture's
// confirmation is a MODAL and SPEC section 4.4 ran band B2 (interception) before band B5
// (checkpoint). A confirmation dialog could not be a step's postcondition, so the only expressible
// shape was an interception recovery whose remedy performed the commit, which SPEC section 3.5
// forbids. `Checkpoint.dialog` is the amendment; this file is the evidence that it works and that
// it gave nothing away.
//
// Four claims, in the order they matter:
//
//   1. THE FLOW RUNS. The click raises the confirmation, the declared dialog is accepted as the
//      postcondition, the answer commits, and the CORE holds exactly one more sub-account than it
//      did before - read from the fixture's own state endpoint, not off the screen.
//   2. THE DRY RUN STOPS AT THE BOUNDARY. Everything except the dispatch happens at
//      `commit-subaccount`, the grade is `partial-up-to-irreversible`, and the core holds exactly
//      what it held before. This is the mode that could not reach the boundary at all before the
//      amendment - the modal is up when the boundary step begins, and band B2 refused it there.
//   3. VERIFY THEN INVOKE WRITES ONCE. `verifyAndDraft` followed by an approved replay opens ONE
//      account, which is SPEC section 6.6's whole point against a flow that really does something.
//   4. AN UNDECLARED DIALOG IS STILL AN INTERCEPTION. The fixture raises its maintenance
//      interstitial with the SAME modal widget as the confirmation. Armed on the confirmation
//      screen it is a hard failure, and nothing is posted.
//
// This drives a real browser against a local fixture on an ephemeral port. It reaches nothing on
// the internet, needs no credential, and makes no model call.

import { describe, expect, it } from "vitest";
import { ed25519Trust } from "../src/approval.js";
import { MemoryEvidenceSink } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { MemoryJournal } from "../src/journal.js";
import { replay } from "../src/replay.js";
import { verifyAndDraft, verifyArtifact } from "../src/verify.js";
import {
  WRITE_APPROVER_KEY_ID,
  WRITE_DEPOSIT,
  WRITE_MEMBER_ID,
  openSubAccountAllowlist,
  openSubAccountArtifact,
  openSubAccountContract,
  openSubAccountDraft,
  writeApproverPublicKey,
} from "./fixtures/corebank-write.js";
import {
  type CorebankSession,
  chromiumAvailable,
  openCorebankSession,
} from "./support/corebank.js";
import { invocationApprovalFixture } from "./support/invocation-approval.js";
import { eventsOf, journalText } from "./support/journal.js";

const ROUTES = openSubAccountArtifact.flow.routes;
const TRUST = () =>
  ed25519Trust([{ keyId: WRITE_APPROVER_KEY_ID, publicKey: writeApproverPublicKey }]);
const ARGS = { memberId: WRITE_MEMBER_ID, openingDeposit: WRITE_DEPOSIT } as const;
const TENANT = { tenantId: "riverbend", appInstanceId: "riverbend-corebank-fixture" };
const IDEMPOTENCY_KEY = "browser-open-subaccount-1";

/** How many sub-accounts the CORE holds for our member. The system of record, read outside the
 *  interpreter, which is the only thing that can tell a single post from a double one. */
async function accountsHeld(session: CorebankSession): Promise<number> {
  const state = await session.state();
  return state.members.find((m) => m.memberId === WRITE_MEMBER_ID)?.subAccounts ?? -1;
}

/** The approved production invocation: an invocation approval minted over THIS request, and a
 *  trust store holding the public half of the key that signed the artifact. */
function runOptions(session: CorebankSession): Parameters<typeof replay>[0] {
  return {
    contract: openSubAccountContract,
    artifact: openSubAccountArtifact,
    args: ARGS,
    tenant: TENANT,
    allowlist: openSubAccountAllowlist,
    broker: session.broker,
    trust: TRUST(),
    ids: sequentialIds("write"),
    evidence: new MemoryEvidenceSink(),
    journal: (runId, clock) => new MemoryJournal({ runId, clock }),
    perceiveDeadlineMs: 15_000,
    onIntervention: "fail",
    invocationApproval: invocationApprovalFixture({
      approvalId: "approval-browser-open-subaccount",
      artifact: openSubAccountArtifact,
      contract: openSubAccountContract,
      args: ARGS,
      tenant: TENANT,
      idempotencyKey: IDEMPOTENCY_KEY,
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      trustNotBefore: "2026-01-01T00:00:00.000Z",
      trustNotAfter: "2099-01-01T00:00:00.000Z",
    }).grant,
    idempotencyKey: IDEMPOTENCY_KEY,
  };
}

const describeBrowser = chromiumAvailable() ? describe : describe.skip;

// Hermetic, and OUTSIDE the browser guard on purpose. Everything below it skips silently on a
// machine with no Chromium build (FINAL-STATUS section 1), so this is the part of the write flow
// that a reviewer who has not run `playwright install` still sees fail if somebody breaks it.
describe("the documents this flow ships", () => {
  it("stores SHAPES, never the values a caller supplies", () => {
    // The same grep `test/redaction.test.ts` runs over the read capability's documents, over the
    // one that WRITES - where a member number reaching a signed, committed, widely-copied document
    // would matter more.
    const sealed = JSON.stringify([openSubAccountContract, openSubAccountArtifact]);
    expect(sealed).not.toContain(WRITE_MEMBER_ID);
    expect(sealed).not.toContain(WRITE_DEPOSIT);
  });

  it("declares the dialog on BOTH sides of the step boundary, and the same dialog", () => {
    // The clause the whole flow turns on, asserted as a property of the DOCUMENT rather than of a
    // run: the dialog outlives the step that raised it, so the step that answers it has to declare
    // it too, and the two declarations have to be about the same widget.
    const steps = openSubAccountArtifact.flow.steps;
    const raises = steps.find((s) => s.id === "submit-subaccount-form");
    const commits = steps.find((s) => s.id === "commit-subaccount");
    expect(raises?.expect.dialog?.present).toBe(true);
    expect(commits?.expect.dialog?.present).toBe(false);
    expect(JSON.stringify(raises?.expect.dialog?.where)).toBe(
      JSON.stringify(commits?.expect.dialog?.where),
    );
    // Linker check 25's first obligation, visible in the document a human reviews.
    expect(raises?.expect.dialog?.where.role).toBe("dialog");
    // And the second: nothing is concluded or read from behind the panel.
    expect(raises?.outcomes).toEqual([]);
    expect(raises?.extract).toEqual([]);
    // The irreversible boundary the dry run stops at, derived rather than declared.
    expect(openSubAccountArtifact.effects.irreversibleSteps).toEqual(["commit-subaccount"]);
    expect(openSubAccountArtifact.effects.restartSafeUpToPc).toBe(4);
  });
});

describeBrowser("opening a sub-account against corebank-web", () => {
  it("raises the confirmation, accepts it as the postcondition, and commits exactly once", async () => {
    const session = await openCorebankSession(ROUTES);
    try {
      const before = await accountsHeld(session);
      expect(before).toBeGreaterThanOrEqual(1);

      const { result, journal } = await replay(runOptions(session));
      if (result.status !== "ok") console.error(JSON.stringify(result, null, 2));
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;

      expect(result.run.stepsExecuted).toBe(5);
      expect(result.run.steps.map((s) => s.stepId)).toEqual([
        "open-subaccount-form",
        "choose-subaccount-type",
        "enter-opening-deposit",
        "submit-subaccount-form",
        "commit-subaccount",
      ]);

      // THE CLAIM. Not "a confirmation screen said so" - the core is holding one more account.
      expect(await accountsHeld(session)).toBe(before + 1);

      // The declared dialog was accepted as a POSTCONDITION rather than refused as an
      // interception: `undeclared-dialog` appears nowhere, and the step that raised the modal
      // advanced with the modal on screen.
      const text = journalText(journal);
      expect(text).not.toContain("undeclared-dialog");
      const classified = eventsOf(journal, "classified") as unknown as readonly {
        stepId: string;
        phase: string;
        verdict: { kind: string };
      }[];
      const post = classified.find(
        (e) => e.stepId === "submit-subaccount-form" && e.phase === "post",
      );
      expect(post?.verdict.kind).toBe("advance");

      // Every dispatched action was preceded by a policy decision that named a rule - the
      // chokepoint as a property of the journal. The two writes were authorized against DIFFERENT
      // routes with different ceilings.
      const decisions = eventsOf(journal, "policy.decided") as unknown as readonly {
        decision: { allow: boolean; ruleId: string };
      }[];
      expect(decisions).toHaveLength(5);
      expect(decisions.every((d) => d.decision.allow)).toBe(true);
      expect(eventsOf(journal, "approval.accepted")).toHaveLength(1);
      expect(eventsOf(journal, "approval.refused")).toHaveLength(0);

      // The taint model, end to end: the member number reaches the surface and appears in no
      // journal line and in no result document.
      expect(text).not.toContain(WRITE_MEMBER_ID);
      expect(JSON.stringify(result)).not.toContain(WRITE_MEMBER_ID);

      // Descriptors: every target resolved under quorum with two independent sources agreeing, on
      // a product where the two form controls have no accessible name at all.
      const resolved = eventsOf(journal, "resolved") as unknown as readonly {
        agreed: boolean;
        distinctSources: number;
      }[];
      expect(resolved).toHaveLength(4);
      expect(resolved.every((r) => r.agreed && r.distinctSources >= 2)).toBe(true);
      expect(result.run.drift.divergence).toBe(0);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("dry-runs to the irreversible boundary and does not perform it", async () => {
    const session = await openCorebankSession(ROUTES);
    try {
      const before = await accountsHeld(session);

      const report = await verifyArtifact({
        contract: openSubAccountContract,
        artifact: openSubAccountDraft,
        args: ARGS,
        tenant: { tenantId: "riverbend", appInstanceId: "riverbend-corebank-fixture" },
        allowlist: openSubAccountAllowlist,
        broker: session.broker,
        ids: sequentialIds("dry"),
        journal: (runId, clock) => new MemoryJournal({ runId, clock }),
        perceiveDeadlineMs: 15_000,
      });

      if (report.status !== "verified") console.error(report.reason);
      expect(report.mode).toBe("replay-dry");
      expect(report.status).toBe("verified");
      expect(report.grade).toBe("partial-up-to-irreversible");
      expect(report.coveredThroughStep).toBe("submit-subaccount-form");
      expect(report.stoppedBeforeStep).toBe("commit-subaccount");

      // THE CLAIM. The core holds exactly what it held before.
      expect(await accountsHeld(session)).toBe(before);

      // What the boundary step DID do, which is everything except the dispatch. It reached its
      // pre-classification at all only because `expect.dialog` stood band B2 down: the confirmation
      // panel is on screen when this step begins, and before the amendment that was
      // `undeclared-dialog` and the dry run could not reach the boundary it exists to stop at.
      const journal = report.journal;
      if (journal === null) throw new Error("a verified run has a journal");
      const events = journal.events as unknown as { type: string; stepId?: string }[];
      const atBoundary = events.filter((e) => e.stepId === "commit-subaccount");
      expect(atBoundary.map((e) => e.type)).toContain("resolved");
      expect(atBoundary.map((e) => e.type)).not.toContain("acted");
      expect(JSON.stringify(events)).not.toContain("undeclared-dialog");
    } finally {
      await session.close();
    }
  }, 120_000);

  it("verifies, drafts, and then invokes - and opens exactly ONE account across both", async () => {
    // SPEC section 6.6's amendment to BRIEF section 3.4, against a flow that really does something.
    // A verification replay of a READ capability can safely run twice; this one cannot, and the dry
    // mode is what makes the lifecycle's first step safe on it.
    const session = await openCorebankSession(ROUTES);
    try {
      const before = await accountsHeld(session);

      const drafted = await verifyAndDraft({
        contract: openSubAccountContract,
        artifact: openSubAccountDraft,
        args: ARGS,
        tenant: { tenantId: "riverbend", appInstanceId: "riverbend-corebank-fixture" },
        allowlist: openSubAccountAllowlist,
        broker: session.broker,
        ids: sequentialIds("cycle"),
        journal: (runId, clock) => new MemoryJournal({ runId, clock }),
        perceiveDeadlineMs: 15_000,
      });
      expect(drafted.report.grade).toBe("partial-up-to-irreversible");
      expect(drafted.artifact?.lifecycle.status).toBe("draft");
      expect(await accountsHeld(session)).toBe(before);

      // WHERE THE DRY RUN LEFT THE SURFACE, and the engine's answer to it. Stopping before the
      // dispatch parks the session on the confirmation panel - the interpreter deliberately does
      // not clean up after itself, for the same reason the driver's `close()` will not answer a
      // pending dialog: whether that panel is confirmed or cancelled is a decision, and a teardown
      // path is the last place to take it. A production invocation is handed a FRESHLY BROKERED
      // session (SPEC section 7.6) and never sees this screen; run against it anyway and the engine
      // refuses to act, because the modal on it is one nobody declared for step 1.
      const stale = await replay(runOptions(session));
      expect(stale.result.status).toBe("failed");
      if (stale.result.status === "failed") {
        expect(stale.result.failure.class).toBe("undeclared-dialog");
        expect(stale.result.failure.atStep).toBe("open-subaccount-form");
        expect(stale.result.failure.sideEffects).toBe("none-guaranteed");
      }
      expect(await accountsHeld(session)).toBe(before);

      // The session broker's job, stood in for by hand: put the flow back at a screen this
      // capability's entry precondition describes.
      await session.gotoContent(`/member/${WRITE_MEMBER_ID}`);

      const { result } = await replay(runOptions(session));
      if (result.status !== "ok") console.error(JSON.stringify(result, null, 2));
      expect(result.status).toBe("ok");
      // ONE account across a verification and an invocation of the same artifact.
      expect(await accountsHeld(session)).toBe(before + 1);
    } finally {
      await session.close();
    }
  }, 180_000);

  it("still refuses an UNDECLARED dialog on the same widget, and posts nothing", async () => {
    // The fixture renders its maintenance interstitial with the SAME modal machinery as the
    // confirmation - one widget, two identities - precisely so that an engine cannot classify a
    // modal by "a modal is showing". Armed on the confirmation screen, the declared panel and the
    // undeclared one are both up, and `every open dialog is the declared one` is false.
    const session = await openCorebankSession(ROUTES);
    try {
      const before = await accountsHeld(session);
      await session.arm("interstitial", { at: "confirm", mode: "sticky" });

      const { result } = await replay(runOptions(session));
      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(result.failure.class).toBe("undeclared-dialog");
      expect(result.failure.atStep).toBe("submit-subaccount-form");
      // Nothing was written, and the caller is told so as a fact rather than left to infer it.
      expect(await accountsHeld(session)).toBe(before);
    } finally {
      await session.close();
    }
  }, 120_000);
});
