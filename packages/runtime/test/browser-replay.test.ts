// BUILD UNIT 11'S ACCEPTANCE TEST, against the real hostile surface.
//
// "The happy-path 9-step flow returns `ok` with typed outputs against the fixture; three fault
// scenarios return the right arm." The three were chosen to hit all three classes of the taxonomy
// exactly once, because a suite that proves three variations of one class proves one thing:
//
//   · `not-found`   -> an EXPECTED BUSINESS OUTCOME. `MEMBER_NOT_FOUND` arrives on the `outcome`
//                      arm with its declared caller guidance, and no `catch` block anywhere in the
//                      engine can observe it. This is the distinction the brief calls "the most
//                      common design mistake here".
//   · `interstitial`-> a RECOVERABLE CONDITION. A blocking modal the artifact declared, dismissed
//                      inside a budget, and the run still returns `ok` with every output.
//   · `app-error`   -> a HARD FAILURE. A 500 page that is recovered from ONCE - the restart the
//                      taxonomy permits for a READ run - and then, when the restart budget is
//                      spent, reported as `failed / app-error` with the step, the expectation and
//                      the observation.
//
// THIS TEST DRIVES A REAL BROWSER AGAINST A LOCAL FIXTURE ON AN EPHEMERAL PORT. It reaches nothing
// on the internet, needs no credential, and makes no model call. It is separated from the hermetic
// suite by file so that `pnpm test` on a machine with no Chromium still runs everything else and
// says loudly what it skipped.

import { describe, expect, it } from "vitest";
import { ed25519Trust } from "../src/approval.js";
import { MemoryEvidenceSink } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { MemoryJournal } from "../src/journal.js";
import { replay } from "../src/replay.js";
import {
  ABSENT_MEMBER_ID,
  APPROVER_KEY_ID,
  FIXTURE_MEMBER_ID,
  approverPublicKey,
  corebankAllowlist,
  sharePositionArtifact,
  sharePositionContract,
} from "./fixtures/corebank.js";
import { chromiumAvailable, openCorebankSession } from "./support/corebank.js";
import type { CorebankSession } from "./support/corebank.js";
import { eventsOf, journalText } from "./support/journal.js";

const ROUTES = sharePositionArtifact.flow.routes;
const TRUST = () => ed25519Trust([{ keyId: APPROVER_KEY_ID, publicKey: approverPublicKey }]);

async function runAgainstFixture(
  session: CorebankSession,
  args: Readonly<Record<string, unknown>>,
) {
  const evidence = new MemoryEvidenceSink();
  return replay({
    contract: sharePositionContract,
    artifact: sharePositionArtifact,
    args,
    tenant: { tenantId: "riverbend", appInstanceId: "riverbend-corebank-fixture" },
    allowlist: corebankAllowlist,
    broker: session.broker,
    trust: TRUST(),
    ids: sequentialIds("browser"),
    evidence,
    journal: (runId, clock) => new MemoryJournal({ runId, clock }),
    perceiveDeadlineMs: 15_000,
    onIntervention: "fail",
  });
}

const describeBrowser = chromiumAvailable() ? describe : describe.skip;

describeBrowser("replaying the nine-step share-position flow against corebank-web", () => {
  it("returns ok with every declared output typed", async () => {
    const session = await openCorebankSession(ROUTES);
    try {
      const { result, journal } = await runAgainstFixture(session, {
        memberId: FIXTURE_MEMBER_ID,
      });
      if (result.status !== "ok") {
        // Printed rather than swallowed: a failing acceptance test should say WHY on the first run.
        console.error(JSON.stringify(result, null, 2));
      }
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;

      // Typed outputs, all four, from the observation each checkpoint verified.
      // TYPED, not stringly. `money` arrives as an amount plus a currency because the contract
      // declared `{ kind: "money", currency: "USD" }`, and `enum` arrives as one of the declared
      // members because `enum@1` refused anything else - which is what "typed outputs" has to mean
      // if the caller's generated types are to be worth anything.
      expect(result.outputs.memberName).toBe("ALVAREZ, DANA (SYNTHETIC)");
      expect(result.outputs.shareBalance).toEqual({ amount: "1204.55", currency: "USD" });
      expect(result.outputs.accountStatus).toBe("ACTIVE");
      expect(result.outputs.shareAccounts).toEqual([
        {
          Acct: "0001",
          "Share Account": "Share Account - Regular",
          "Share Balance": "1,204.55",
          Opened: "2019-03-11",
        },
      ]);

      // All nine steps ran, in order, and every one of them was journaled.
      expect(result.run.stepsTotal).toBe(9);
      expect(result.run.stepsExecuted).toBe(9);
      expect(result.run.steps.map((s) => s.stepId)).toEqual([
        "open-search",
        "enter-member-id",
        "submit-search",
        "read-member-summary",
        "open-member-record",
        "verify-member-record",
        "read-share-accounts",
        "open-subaccount-form",
        "confirm-form-ready",
      ]);

      // Drift is reported on the GREEN arm too. A descriptor that has quietly started abstaining
      // shows up here months before it shows up as a failure, and that is the only warning there is.
      expect(result.run.drift.needsSpecialization).toBe(false);
      expect(result.run.drift.divergence).toBe(0);

      // THE CHOKEPOINT, as a property of the journal rather than of the architecture diagram: every
      // action that was dispatched was preceded by a policy decision that named a rule.
      const acted = eventsOf(journal, "acted");
      const decided = eventsOf(journal, "policy.decided");
      expect(acted.length).toBeGreaterThan(0);
      expect(decided.length).toBe(acted.length);
      expect(decided.every((e) => (e.decision as { allow: boolean }).allow)).toBe(true);

      // And the taint model, end to end: the one action that carried the caller's value declared it
      // sensitive and journaled a HANDLE rather than the value.
      const typed = acted.filter((e) => e.actionKind === "type");
      expect(typed).toHaveLength(1);
      expect(typed[0]).toMatchObject({ valueRef: expect.stringMatching(/^taint:/) });
      expect(journalText(journal)).not.toContain(FIXTURE_MEMBER_ID);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("returns the MEMBER_NOT_FOUND outcome - not an error - when the core has no such member", async () => {
    const session = await openCorebankSession(ROUTES);
    try {
      // The FAULT rather than a bad argument, deliberately: it proves the detector reads the
      // screen and not the caller's input. `99999` would also produce this organically.
      await session.arm("not-found", { at: "results", mode: "sticky" });
      const { result } = await runAgainstFixture(session, { memberId: ABSENT_MEMBER_ID });

      expect(result.status).toBe("outcome");
      if (result.status !== "outcome") return;
      expect(result.outcome).toBe("MEMBER_NOT_FOUND");
      expect(result.terminal).toBe(true);
      // Copied verbatim from the reviewed contract, never generated at render time.
      expect(result.callerAction).toBe("retry-different-input");
      expect(result.retryable).toBe("with_different_inputs");
      expect(result.guidance).toContain("not on file");
      expect(result.detectedAt.stepId).toBe("submit-search");
      // Terminal at step 3: the four steps after it never ran.
      expect(result.run.stepsExecuted).toBe(2);
      // An outcome is an ANSWER. There is no failure object on this arm to read.
      expect("failure" in result).toBe(false);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("recovers from a declared blocking interstitial and still returns ok", async () => {
    const session = await openCorebankSession(ROUTES);
    try {
      // The same modal widget the product uses for its confirmation step, raised on the results
      // screen. `once`, so a correct recovery clears it and an incorrect one loops.
      await session.arm("interstitial", { at: "results", mode: "once" });
      const { result, journal } = await runAgainstFixture(session, {
        memberId: FIXTURE_MEMBER_ID,
      });

      if (result.status !== "ok") console.error(JSON.stringify(result, null, 2));
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.outputs.memberName).toBe("ALVAREZ, DANA (SYNTHETIC)");

      // The recovery is REPORTED, not silent. An interstitial that appears on 3% of runs today
      // appears on 40% next quarter, and nobody notices if the runs just pass.
      expect(result.run.recoveriesApplied).toEqual([
        { stepId: "submit-search", name: "DISMISS_SYSTEM_NOTICE", attempts: 1, result: "cleared" },
      ]);
      expect(result.run.budgets.remediations.used).toBe(1);
      expect(
        eventsOf(journal, "recovery.applied").some((e) => e.name === "DISMISS_SYSTEM_NOTICE"),
      ).toBe(true);
      // It cost a re-walk of the flow, which is visible: more step attempts than steps.
      expect(result.run.steps.length).toBeGreaterThan(9);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("reports an application error page as a hard failure once the restart budget is spent", async () => {
    const session = await openCorebankSession(ROUTES);
    try {
      // STICKY, so the one restart SPEC 4.2 row 16 allows a READ run does not paper over it. The
      // first occurrence is a bounded recovery; the second is the answer.
      await session.arm("app-error", { at: "detail", mode: "sticky" });
      const { result, journal } = await runAgainstFixture(session, {
        memberId: FIXTURE_MEMBER_ID,
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      expect(result.failure.class).toBe("app-error");
      expect(result.failure.atStep).toBe("open-member-record");
      // The whole point of the failed arm: what step, what was expected, what was observed.
      expect(result.failure.expected.rendered.length).toBeGreaterThan(0);
      expect(result.failure.observed.route?.path).toBe("/member/:memberId");
      expect(result.failure.operatorAction.length).toBeGreaterThan(0);
      // `sideEffects: "possible"` is the honest answer for a run that dispatched actions, and it
      // is a run of a READ capability so `retriable: "same-inputs"` is too - the application may
      // well be serving its own pages again in a minute. Both come from the per-class guidance
      // table, written once by a person and copied verbatim, so two runs of the same failure never
      // explain themselves differently.
      expect(result.failure.sideEffects).toBe("possible");
      expect(result.failure.retriable).toBe("same-inputs");

      // The restart was ATTEMPTED exactly once, and the journal says the gate passed. There is no
      // SECOND `restart.requested`, and its absence is the mechanism working rather than a gap: on
      // the next occurrence the CLASSIFIER's own restart gate refuses before it will even emit a
      // `recover`, so the interpreter is never asked to restart again. The refusal is visible as
      // the spent ledger next to a terminal `app-error`.
      const restarts = eventsOf(journal, "restart.requested");
      expect(restarts.map((e) => e.gate)).toEqual(["passed"]);
      expect(result.run.budgets.programAttempts).toEqual({ used: 1, limit: 1 });
      // Both attempts are in the envelope. A restart discards the machine, not the audit trail.
      expect(result.run.steps.filter((s) => s.stepId === "open-member-record").length).toBe(2);

      // The frozen observation that produced the verdict. THIS is what turns a production failure
      // into a `classify()` unit test with no reproduction step.
      expect(result.failure.observationRef).toMatch(/^obs:/);
      // And it carries no member number, because the taint model applies to evidence too.
      expect(JSON.stringify(result)).not.toContain(FIXTURE_MEMBER_ID);
    } finally {
      await session.close();
    }
  }, 180_000);
});
