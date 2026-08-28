// THE SEAM. A SYNTHESIZED ARTIFACT, EXECUTED.
//
// FINAL-STATUS section 7.2 named the one gap that cost this submission most: a synthesized artifact
// LINKED (28 checks, verified) and a hand-authored artifact REPLAYED (real interpreter, real browser
// driver, real hostile fixture), and no test had ever done both to the same document. The headline
// claim - "the model discovers, the artifact becomes a reusable capability, deterministic replay is
// how the agent invokes it in production" - was the one thing the repository did not demonstrate.
//
// This file demonstrates it, and it walks the whole ladder in SPEC section 1.1 rather than just the
// bottom rung:
//
//   1. READ IT AS DATA.        `corebank-web.capability.json`, off disk, through `parseContract` /
//                              `parseArtifact`. No import of `@crr/discovery`, no shared type, no
//                              function call across the boundary. BRIEF section 3.9 says the
//                              artifact is data and not code; this is that claim being cashed.
//   2. VERIFY IT.              `verifyAndDraft` - BRIEF section 3.4's "replay your own artifact with
//                              the model out of the loop, and save it as draft only if that
//                              succeeds" - against the live application. `proposed -> draft`.
//   3. APPROVE IT.            A real ed25519 signature over the real digest. `draft -> approved`.
//   4. INVOKE IT IN PRODUCTION, for a member the recording never saw, and get that member's data
//                              back typed. This is the step that makes it a CAPABILITY rather than
//                              a recording of one session.
//
// WHY A FILE AND NOT A FUNCTION CALL. `@crr/runtime` does not depend on `@crr/discovery` and should
// not: the interpreter has no business importing a model SDK, and the package that owns the model
// loop has no business importing an interpreter. The two halves meet where the design says they
// meet - at a document with a content address that either parses or does not. Making them meet at
// an import would have hidden exactly the failure this test exists to catch, because a shared type
// makes structural incompatibility impossible while leaving SEMANTIC incompatibility - a descriptor
// the resolver cannot resolve, a checkpoint that can never hold, a budget of zero - untouched.
//
// WHAT BREAKS THE BUILD, AND WHEN. Change synthesis and forget to re-emit, and
// `packages/discovery/test/synthesis-corebank-web.test.ts` fails on the bytes. Re-emit something the
// interpreter cannot execute, and THIS fails. Change the fixture's markup, and this fails too,
// because the descriptors were derived from observations of it. There is no path from "synthesis
// emits something unrunnable" to a green board.
//
// It drives a real Chromium against a local fixture on an ephemeral port. It reaches nothing on the
// internet, needs no credential, and makes no model call.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Allowlist,
  type CapabilityArtifact,
  type CapabilityContract,
  type SurfaceCapabilities,
  artifactDigestIsIntact,
  link,
  parseArtifact,
  parseContract,
} from "@crr/core";
import { describe, expect, it } from "vitest";
import { ed25519Trust, generateApprovalKeyPair } from "../src/approval.js";
import { MemoryEvidenceSink } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { MemoryJournal } from "../src/journal.js";
import { approve } from "../src/lifecycle.js";
import { replay } from "../src/replay.js";
import { verifyAndDraft } from "../src/verify.js";
import { chromiumAvailable, openCorebankSession } from "./support/corebank.js";
import type { CorebankSession } from "./support/corebank.js";
import { eventsOf, journalText } from "./support/journal.js";

// ---------------------------------------------------------------------------------------------
// 1. Read it as data
// ---------------------------------------------------------------------------------------------

/**
 * By PATH, deliberately.
 *
 * `@crr/runtime` cannot import `@crr/discovery` - nothing in the workspace may hold both, and the
 * architecture contract tests are what say so. A production catalog reads an artifact out of a
 * store; this reads one out of a directory. The mechanism is the same and the coupling is the same:
 * none, beyond a schema both ends validate against.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CAPABILITY_FILE = resolve(
  HERE,
  "..",
  "..",
  "discovery",
  "test",
  "fixtures",
  "corebank-web.capability.json",
);

interface EmittedFile {
  readonly _readme: string;
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly capabilities: SurfaceCapabilities;
  readonly contract: unknown;
  readonly artifact: unknown;
  readonly report: { readonly notes: readonly { readonly code: string }[] };
}

const emitted = JSON.parse(readFileSync(CAPABILITY_FILE, "utf8")) as EmittedFile;

/** Parsed, not cast. The schema is the only contract between the two halves of this system, so the
 *  test that connects them has to go through it. */
const contract: CapabilityContract = parseContract(emitted.contract);
const proposed: CapabilityArtifact = parseArtifact(emitted.artifact);

/**
 * The parameter synthesis derived - `memberId`, and that is a real result rather than a fixture
 * quirk. This product's search inputs have NO ACCESSIBLE NAME AT ALL, so the obvious derivation
 * ("name it after the field") has nothing to work with and used to produce `value1`. The naming
 * chain in `packages/discovery/src/synthesis/parameters.ts` falls through to the label anchor
 * `deriveDescriptors` computes for the same node, which on riverbend is the wording "Member ID"
 * sitting in the neighbouring layout cell.
 *
 * Read off the contract rather than written as a literal, because reading it off the contract is
 * exactly what a calling agent has to do - and asserted below, because a constant that agrees with
 * whatever the document says would not notice the day it says `value1` again.
 */
const PARAM = contract.inputs[0]?.name ?? "";

/** The member the recording was taken on. */
const RECORDED_MEMBER_ID = "10041";
/** A member the recording NEVER SAW, with a different name, balance and status. Replaying for this
 *  one is what separates "the artifact is a capability" from "the artifact is a macro". */
const OTHER_MEMBER_ID = "10045";
/** A member number the fixture holds no record for. */
const ABSENT_MEMBER_ID = "99999";

/**
 * The deployment's allowlist, and it is NOT the discovery run's.
 *
 * `WRITE_REVERSIBLE`, where the hand-authored artifact's allowlist says `READ`, and the difference
 * is synthesis being honest rather than the fixture being different: `defaultEffectOf` cannot prove
 * that clicking a button labelled "Search" is a read (SPEC section 8.2 - effect is DECLARED, not
 * proven), so the emitted artifact declares `maxEffect: "WRITE_REVERSIBLE"` and a deployment that
 * ran it under a READ ceiling would be refused at the chokepoint. That refusal is the system
 * working; loosening the ceiling here is the deployment agreeing to what the document declares.
 */
const ALLOWLIST: Allowlist = {
  originAliases: ["corebank"],
  routes: [
    { originAlias: "corebank", pathPattern: "/search", maxEffect: "WRITE_REVERSIBLE" },
    { originAlias: "corebank", pathPattern: "/search/results", maxEffect: "WRITE_REVERSIBLE" },
    { originAlias: "corebank", pathPattern: "/member/:memberId", maxEffect: "WRITE_REVERSIBLE" },
  ],
  actionKinds: ["click", "type", "navigate", "pressKey", "acceptDialog", "dismissDialog"],
  maxEffect: "WRITE_REVERSIBLE",
  discoveryMaxEffect: "WRITE_REVERSIBLE",
};

const TENANT = { tenantId: "riverbend", appInstanceId: "riverbend-corebank-fixture" };
const ROUTES = proposed.flow.routes;

describe("the synthesized capability, read back as a document", () => {
  it("parses as a contract and an artifact with no help from the package that wrote it", () => {
    // The whole of the coupling between the two halves of this system, in three lines.
    expect(contract.name).toBe("corebank.member.read_share_position");
    expect(proposed.implements.contractDigest).toBe(contract.digest);
    expect(artifactDigestIsIntact(JSON.parse(JSON.stringify(proposed)))).toBe(true);
  });

  it("offers a caller an argument named after the screen, not a positional placeholder", () => {
    // The one property of this contract a person cannot fix by re-recording, and the one an agent
    // routes on. `memberId` is derived - the field has no accessible name, so the name comes off
    // the label anchor in the neighbouring layout cell - and this assertion is what makes the
    // `PARAM` constant above a claim rather than an echo of the file it was read from.
    expect(PARAM).toBe("memberId");
    expect(contract.inputs[0]?.description).not.toContain("NEEDS A NAME");
    expect(emitted.report.notes.some((note) => note.code === "parameter-name-underived")).toBe(
      false,
    );
  });

  it("arrives `proposed` and `unverified`, because a recording is not a claim", () => {
    expect(proposed.lifecycle.status).toBe("proposed");
    expect(proposed.verification.status).toBe("unverified");
    expect(emitted.provenance.synthetic).toBe(true);
    expect(emitted.provenance.adapter).toBe("replay");
  });

  it("declares a program of four steps over three routes of the fixture", () => {
    expect(proposed.flow.steps.map((step) => step.instruction.kind)).toEqual([
      "fill",
      "activate",
      "read",
      "activate",
    ]);
    expect(ROUTES.map((route) => route.path)).toEqual([
      "/search",
      "/search/results",
      "/member/:memberId",
    ]);
  });

  it("is refused by the linker in production mode until somebody has approved it", () => {
    // Check 27, and the reason the rest of this file is a ladder rather than a single call: the
    // production path runs APPROVED artifacts, and the only way a proposed document earns that
    // label is by replaying itself with the model out of the loop.
    const result = link({
      contract,
      artifact: proposed,
      capabilities: emitted.capabilities,
      args: { [PARAM]: RECORDED_MEMBER_ID },
      mode: "replay",
      allowlist: ALLOWLIST,
      trust: { trustedKeyIds: [], verifySignature: () => false },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.code)).toContain("artifact-not-approved");
  });
});

// ---------------------------------------------------------------------------------------------
// 2-4. Against the real application
// ---------------------------------------------------------------------------------------------

const CHROMIUM = chromiumAvailable();
if (!CHROMIUM) {
  // The generic warning in `support/corebank.ts` says "every browser replay test". This one is
  // worth naming on its own: without a browser the four assertions above still run - the document
  // parses, it is proposed, and production refuses it - but nothing has EXECUTED it, and the claim
  // this file exists to make is about execution.
  process.stderr.write(
    "[@crr/runtime] SKIPPING the discovery -> replay seam (synthesized-replay.test.ts): no " +
      "Chromium build. The synthesized artifact was parsed and linked but never executed. " +
      "Run `pnpm exec playwright install chromium`.\n",
  );
}
const describeBrowser = CHROMIUM ? describe : describe.skip;

async function verifyAgainstFixture(session: CorebankSession, args: Record<string, unknown>) {
  return verifyAndDraft({
    contract,
    artifact: proposed,
    args,
    tenant: TENANT,
    allowlist: ALLOWLIST,
    broker: session.broker,
    ids: sequentialIds("verify"),
    evidence: new MemoryEvidenceSink(),
    journal: (runId, clock) => new MemoryJournal({ runId, clock }),
    perceiveDeadlineMs: 15_000,
  });
}

describeBrowser("replaying a SYNTHESIZED artifact against corebank-web", () => {
  it("verifies itself with the model out of the loop, and only then becomes a draft", async () => {
    const session = await openCorebankSession(ROUTES);
    try {
      const { report, artifact: drafted } = await verifyAgainstFixture(session, {
        [PARAM]: RECORDED_MEMBER_ID,
      });
      if (report.status !== "verified") console.error(report.reason, report.result?.status);

      expect(report.status).toBe("verified");
      // `replay-dry`, chosen from the EFFECT SUMMARY rather than read out of the document's own
      // plan (synthesis wrote `replay-full` there, and `chooseVerificationMode` declines to take a
      // document's word for what it is entitled to). The grade is then derived from what the run
      // actually covered, not from the mode - so a dry run against a flow with no irreversible step
      // grades `full`, because nothing was withheld.
      expect(report.mode).toBe("replay-dry");
      expect(report.grade).toBe("full");
      expect(report.stoppedBeforeStep).toBeNull();
      expect(report.coveredThroughStep).toBe(proposed.flow.steps.at(-1)?.id);

      // The run underneath it: a real result arm, with the outputs typed the way the CONTRACT
      // declares them rather than the way the screen printed them.
      expect(report.result?.status).toBe("ok");
      if (report.result?.status !== "ok") return;
      expect(report.result.outputs.memberName).toBe("ALVAREZ, DANA (SYNTHETIC)");
      expect(report.result.outputs.shareBalance).toEqual({ amount: "1204.55", currency: "USD" });
      expect(report.result.outputs.accountStatus).toBe("ACTIVE");

      // proposed -> draft, and the promotion is the RESULT of the replay rather than a field
      // somebody set. BRIEF section 3.4 in one assertion.
      expect(drafted).not.toBeNull();
      expect(drafted?.lifecycle.status).toBe("draft");
      expect(drafted?.verification.status).toBe("verified");
      expect(drafted?.verification.grade).toBe("full");
    } finally {
      await session.close();
    }
  }, 180_000);

  it("executes every descriptor, checkpoint, budget and effect synthesis derived", async () => {
    // FINAL-STATUS section 7.2 names exactly this as what was unproved. Each assertion below is one
    // clause of it, checked against the JOURNAL of a run against the live application rather than
    // against the document that describes one.
    const session = await openCorebankSession(ROUTES);
    try {
      const { report } = await verifyAgainstFixture(session, { [PARAM]: RECORDED_MEMBER_ID });
      expect(report.status).toBe("verified");
      const result = report.result;
      const journal = report.journal;
      expect(result?.status).toBe("ok");
      if (result === null || result.status !== "ok" || journal === null) return;

      // DESCRIPTORS. Three targets, each derived from a frozen observation of this application, each
      // resolved here by the real resolver against a live one. `divergence: 0` is the load-bearing
      // number: it means no derived descriptor ABSTAINED, so every quorum was met by descriptors
      // that independently agreed rather than by one that happened to be the only one left.
      const resolved = eventsOf(journal, "resolved");
      expect(resolved).toHaveLength(3);
      for (const event of resolved) {
        // `agreed` is the boolean "every descriptor that spoke selected the same node"; the count
        // that makes it mean something is `distinctSources`, because a quorum of three descriptors
        // sharing one evidence source is a quorum of one.
        expect(event.agreed, String(event.stepId)).toBe(true);
        expect(event.distinctSources as number).toBeGreaterThanOrEqual(2);
        const spoke = (event.descriptors as readonly { verdict: string }[]).filter(
          (descriptor) => descriptor.verdict === "resolved",
        );
        expect(spoke.length, String(event.stepId)).toBeGreaterThanOrEqual(2);
        // Nothing disagreed and nothing was ambiguous. SPEC section 5.4: disagreement is a DETECTED
        // CONDITION, never a fallback chain, so a descriptor that selected a different node would
        // have stopped the run rather than been quietly out-voted.
        expect(
          (event.descriptors as readonly { verdict: string }[]).map((d) => d.verdict),
        ).not.toContain("disagreed");
      }
      expect(result.run.drift.divergence).toBe(0);
      expect(result.run.drift.needsSpecialization).toBe(false);

      // CHECKPOINTS. One per step, all four, every one derived by evaluating candidate
      // postconditions against the observation the recorded step actually produced - and every one
      // holding here against a screen this process rendered a second ago.
      const checkpoints = eventsOf(journal, "checkpoint");
      expect(checkpoints).toHaveLength(proposed.flow.steps.length);
      expect(checkpoints.every((event) => event.passed === true)).toBe(true);
      // And the extractions the checkpoint's own screen supplied - three, all present.
      const extracted = eventsOf(journal, "extracted");
      expect(extracted.map((event) => event.output)).toEqual([
        "memberName",
        "shareBalance",
        "accountStatus",
      ]);
      expect(extracted.every((event) => event.present === true)).toBe(true);
      expect(result.run.stepsTotal).toBe(4);
      expect(result.run.stepsExecuted).toBe(4);
      expect(result.run.steps.map((step) => step.stepId)).toEqual(
        proposed.flow.steps.map((step) => step.id),
      );

      // BUDGETS. The settle policy synthesis wrote onto every step is the one the settle loop spent
      // - `stableSamples: 3`, the value the conformance sweep derived - and the run needed none of
      // the remediation budget, because nothing went wrong. A budget of zero that made recovery
      // impossible would show up as an exhausted ledger next to a failure, not as a green run.
      for (const step of proposed.flow.steps) {
        expect(step.settle.stableSamples, step.id).toBe(3);
        // A remediation budget of zero makes a recovery INERT, so the budget and the rules have to
        // agree - FINAL-STATUS section 7.7 names the linker check that would enforce that pairing in
        // general and records that it was never added. Here they do agree, in the trivial direction:
        // the run saw no interstitial, so synthesis derived no ambient rule and no step declares
        // one, and a cycle budget of zero is the honest ceiling for a flow with nothing to spend it
        // on. A step that DID declare a recovery and carried this budget would be a step whose
        // recovery could never run, and that is the case worth catching.
        const declared = step.recoveries.length + proposed.flow.ambient.length;
        if (declared === 0) expect(step.budgets.maxRemediationCycles, step.id).toBe(0);
        else expect(step.budgets.maxRemediationCycles, step.id).toBeGreaterThan(0);
      }
      expect(proposed.flow.ambient).toEqual([]);
      expect(result.run.budgets.remediations).toEqual({ used: 0, limit: 0 });
      expect(result.run.budgets.observations.used).toBeGreaterThan(0);
      expect(result.run.budgets.observations.used).toBeLessThanOrEqual(
        result.run.budgets.observations.limit,
      );
      expect(result.run.budgets.actions.used).toBe(3);
      expect(result.run.recoveriesApplied).toEqual([]);

      // THE EFFECT SUMMARY. Statically analysed before anything ran, and it is what the chokepoint
      // measured every dispatch against: three actions, three policy decisions, every one allowed,
      // and none of them needing an approval token because no step is irreversible.
      const acted = eventsOf(journal, "acted");
      const decided = eventsOf(journal, "policy.decided");
      expect(acted).toHaveLength(3);
      expect(decided).toHaveLength(acted.length);
      expect(decided.every((event) => (event.decision as { allow: boolean }).allow)).toBe(true);
      expect(proposed.effects.requiresApproval).toBe(false);
      expect(proposed.effects.irreversibleSteps).toEqual([]);

      // AND THE TAINT MODEL, end to end on a document nobody hand-wrote: the one action carrying
      // the caller's value declared it sensitive, journaled a HANDLE, and the member number appears
      // nowhere in anything this run wrote down.
      const typed = acted.filter((event) => event.actionKind === "type");
      expect(typed).toHaveLength(1);
      expect(typed[0]).toMatchObject({ valueRef: expect.stringMatching(/^taint:/) });
      expect(journalText(journal)).not.toContain(RECORDED_MEMBER_ID);
      expect(JSON.stringify(result)).not.toContain(RECORDED_MEMBER_ID);
    } finally {
      await session.close();
    }
  }, 180_000);

  it("is a capability, not a macro: approved, then invoked for a member the recording never saw", async () => {
    // THE POINT OF THE WHOLE EXERCISE. The recording was taken on member 10041. Nothing about 10041
    // survived into the artifact - the value is a parameter, the route is a pattern, the row is
    // addressed by the caller's own argument - so the same program, unedited and now signed, answers
    // a question about a different member with that member's data.
    const verifySession = await openCorebankSession(ROUTES);
    let approved: CapabilityArtifact;
    const keys = generateApprovalKeyPair("ops-approval-key-1");
    try {
      const { report, artifact: drafted } = await verifyAgainstFixture(verifySession, {
        [PARAM]: RECORDED_MEMBER_ID,
      });
      expect(report.status).toBe("verified");
      if (drafted === null)
        throw new Error(`verification did not produce a draft: ${report.reason}`);

      // draft -> approved. The approver TICKS the grade and the effect classes, and `approve`
      // refuses if either disagrees with the document - so the tick cannot be a formality.
      approved = approve(drafted, {
        signer: keys.signer,
        approvedBy: "ops-approver-4",
        approvedAt: "2026-02-14T11:00:00.000Z" as never,
        acknowledgedGrade: "full",
        acknowledgedEffects: ["WRITE_REVERSIBLE"],
      });
      expect(approved.lifecycle.status).toBe("approved");
      // The signature is over the DIGEST, which excludes `lifecycle` - so attaching the approval
      // did not move the value it signs, and any edit to the program would.
      expect(approved.lifecycle.approval?.over).toBe(drafted.digest);
    } finally {
      await verifySession.close();
    }

    const session = await openCorebankSession(ROUTES);
    try {
      const { result, journal } = await replay({
        contract,
        artifact: approved,
        args: { [PARAM]: OTHER_MEMBER_ID },
        tenant: TENANT,
        allowlist: ALLOWLIST,
        broker: session.broker,
        trust: ed25519Trust([keys.trustedKey]),
        ids: sequentialIds("prod"),
        evidence: new MemoryEvidenceSink(),
        journal: (runId, clock) => new MemoryJournal({ runId, clock }),
        perceiveDeadlineMs: 15_000,
        onIntervention: "fail",
      });

      if (result.status !== "ok") console.error(JSON.stringify(result, null, 2));
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;

      // A DIFFERENT member's data, off the same unedited program.
      expect(result.outputs.memberName).toBe("PARKER, JAMIE (SYNTHETIC)");
      expect(result.outputs.shareBalance).toEqual({ amount: "7415.28", currency: "USD" });
      expect(result.outputs.accountStatus).toBe("ACTIVE");
      // And nothing of the member the recording was taken on.
      expect(JSON.stringify(result)).not.toContain(RECORDED_MEMBER_ID);
      expect(JSON.stringify(result)).not.toContain("ALVAREZ");
      expect(journalText(journal)).not.toContain(OTHER_MEMBER_ID);
    } finally {
      await session.close();
    }
  }, 240_000);

  it("reports a member the core has no record of as a hard failure, because nobody declared an outcome", async () => {
    // FAIL CLOSED, and this is the arm that proves it end to end on a synthesized document.
    //
    // SPEC section 0.2 forbids synthesis from inventing a detector, so `contract.outcomes` came out
    // EMPTY and the report says a person has to declare one. The consequence, which a reviewer
    // should see rather than be told about: an absent member is a `failed` with a step, an
    // expectation and an observation - NOT a confident `MEMBER_NOT_FOUND`. A false
    // `MEMBER_NOT_FOUND` is the worst thing this system can emit, and refusing to guess one is what
    // "the model discovers, deterministic code decides" costs.
    expect(contract.outcomes).toEqual([]);
    expect(emitted.report.notes.some((n) => n.code === "outcome-candidate-needs-detector")).toBe(
      true,
    );

    const session = await openCorebankSession(ROUTES);
    try {
      const { report } = await verifyAgainstFixture(session, { [PARAM]: ABSENT_MEMBER_ID });

      expect(report.result?.status).toBe("failed");
      if (report.result?.status !== "failed") return;
      // The step that could not be satisfied, and what was expected there. That is what a caller
      // gets instead of a fabricated business answer.
      // The READ step, not the search click - and the distinction is the taxonomy working. The
      // search itself succeeded: the application navigated to its results route and rendered a grid.
      // What could not be satisfied is the checkpoint on the step that reads the member's row,
      // because there is no row keyed by the number the caller supplied. "The grid is empty" is not
      // an outcome unless somebody declared a detector for it, so this is a hard failure that names
      // the step and the expectation instead of a business answer nobody authorised.
      expect(report.result.failure.atStep).toBe(proposed.flow.steps[2]?.id);
      expect(report.result.failure.expected.rendered.length).toBeGreaterThan(0);
      expect(report.result.failure.operatorAction.length).toBeGreaterThan(0);
      // A failed verification does NOT produce a draft. The artifact stays proposed.
      expect(report.status).toBe("unverified");
      expect(report.verification).toBeNull();
    } finally {
      await session.close();
    }
  }, 180_000);
});
