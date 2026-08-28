// BUILD UNIT 19'S ACCEPTANCE TEST: one artifact, two tenants, no re-recording.
//
// The claim this file exists to make, in one sentence: **an artifact recorded against riverbend
// replays green against summit through a per-tenant overlay that changes twelve label strings, a
// mount path and two wait budgets - and nothing else.** That is assignment section 3.7's answer and
// the canonicalization stretch goal in the same run, and it is worth exactly as much as the
// negative control beside it, which is why that control is here too.
//
// FOUR TESTS, and the third is the one that makes the first two mean something:
//
//   1. riverbend, NO overlay          -> ok. The base artifact is genuinely single-tenant and runs
//                                        at the tenant it was recorded on with nothing added.
//   2. summit, WITH the overlay       -> ok, same nine steps, same typed outputs, ZERO drift, and
//                                        an ARTIFACT DIGEST IDENTICAL to run 1. Only the effective
//                                        digest moves, which is what tells a postmortem which bytes
//                                        ran.
//   3. summit, overlay MINUS the      -> `failed`. Not a lucky pass: the routing half of the overlay
//      vocabulary                        is kept so the run is genuinely pointed at summit, and only
//                                        the words are taken away. It fails at the FIRST step whose
//                                        target is named by a label, with `target-underdetermined` -
//                                        the engine REFUSING because two descriptors disagreed,
//                                        rather than clicking whichever one matched.
//   4. the cross-tenant divergence report, measured over the same four screens at both tenants and
//      reported with a number and NO THRESHOLD (OPEN-QUESTIONS-RESOLVED Q4).
//
// THIS TEST DRIVES A REAL BROWSER AGAINST A LOCAL FIXTURE ON AN EPHEMERAL PORT. It reaches nothing
// on the internet, needs no credential and makes no model call.

import {
  type Observation,
  type RoutePattern,
  crossTenantDivergence,
  mergeOverlay,
  renderDivergence,
} from "@crr/core";
import { describe, expect, it } from "vitest";
import { ed25519Trust } from "../src/approval.js";
import { MemoryEvidenceSink } from "../src/evidence.js";
import { sequentialIds } from "../src/ids.js";
import { MemoryJournal } from "../src/journal.js";
import { replay } from "../src/replay.js";
import {
  CROSS_TENANT_SCREENS,
  RIVERBEND_TENANT,
  SUMMIT_BASE_PATH,
  SUMMIT_TENANT,
  summitAllowlist,
  summitOverlay,
  summitRoutingOnlyOverlay,
} from "./fixtures/corebank-summit.js";
import {
  APPROVER_KEY_ID,
  FIXTURE_MEMBER_ID,
  approverPublicKey,
  corebankAllowlist,
  sharePositionArtifact,
  sharePositionContract,
} from "./fixtures/corebank.js";
import type { CorebankSession } from "./support/corebank.js";
import { chromiumAvailable, openCorebankSession } from "./support/corebank.js";

const TRUST = () => ed25519Trust([{ keyId: APPROVER_KEY_ID, publicKey: approverPublicKey }]);
const BASE_ROUTES = sharePositionArtifact.flow.routes;

/**
 * An origin used ONLY to shape the merged route list before the fixture has bound a port.
 *
 * The routes come out of the merge the linker will run, and `routeBasePath` is what shapes them;
 * the origin binding plays no part in that. The overlay that actually runs is re-sealed against the
 * real origin, so no run is ever driven by a document that names this address - `.invalid` is
 * reserved by RFC 2606 precisely so that a placeholder cannot resolve if one ever escaped.
 */
const PLACEHOLDER_ORIGIN = "http://placeholder.invalid";

/**
 * The routes the driver is configured with, taken from the SAME merge the linker will run.
 *
 * Deriving them a second time in the test - "just prepend /cb" - would be a second implementation
 * of `routeBasePath`, and a test that reimplements the thing it is testing passes when both copies
 * are wrong together.
 */
function mergedRoutes(overlay: unknown): readonly RoutePattern[] {
  const merged = mergeOverlay(sharePositionArtifact, overlay);
  expect(merged.problems).toEqual([]);
  const flow = merged.document.flow as { readonly routes: readonly RoutePattern[] };
  return flow.routes;
}

async function runAgainst(args: {
  readonly session: CorebankSession;
  readonly tenant: { readonly tenantId: string; readonly appInstanceId: string };
  readonly overlay: ReturnType<typeof summitOverlay> | null;
  readonly allowlist: typeof corebankAllowlist;
}) {
  const evidence = new MemoryEvidenceSink();
  return replay({
    contract: sharePositionContract,
    artifact: sharePositionArtifact,
    overlay: args.overlay,
    args: { memberId: FIXTURE_MEMBER_ID },
    tenant: args.tenant,
    allowlist: args.allowlist,
    broker: args.session.broker,
    trust: TRUST(),
    ids: sequentialIds("overlay"),
    evidence,
    journal: (runId, clock) => new MemoryJournal({ runId, clock }),
    perceiveDeadlineMs: 15_000,
    onIntervention: "fail",
  });
}

/** Every screen of one tenant, perceived outside the interpreter. */
async function perceiveScreens(session: CorebankSession): Promise<readonly Observation[]> {
  const out: Observation[] = [];
  for (const screen of CROSS_TENANT_SCREENS) {
    await session.gotoContent(screen.path);
    const perceived = await session.surface.perceive({ deadlineMs: 15_000 });
    expect(perceived.ok).toBe(true);
    if (!perceived.ok) throw new Error(`perceive failed at ${screen.screen}`);
    out.push(perceived.observation);
  }
  return out;
}

const describeBrowser = chromiumAvailable() ? describe : describe.skip;

describeBrowser("one artifact, two tenants of one vendor product", () => {
  it("replays green at riverbend with NO overlay - the base artifact is single-tenant", async () => {
    const session = await openCorebankSession(BASE_ROUTES);
    try {
      const { result } = await runAgainst({
        session,
        tenant: RIVERBEND_TENANT,
        overlay: null,
        allowlist: corebankAllowlist,
      });
      if (result.status !== "ok") console.error(JSON.stringify(result, null, 2));
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;

      expect(result.outputs.memberName).toBe("ALVAREZ, DANA (SYNTHETIC)");
      expect(result.outputs.shareBalance).toEqual({ amount: "1204.55", currency: "USD" });
      expect(result.outputs.accountStatus).toBe("ACTIVE");
      // The table read that build unit 19 had to move onto the artifact: the ROW KEYS are the
      // contract's declared column names at both tenants, which is the property `columnHeaders`
      // exists to preserve.
      expect(result.outputs.shareAccounts).toEqual([
        {
          Acct: "0001",
          "Share Account": "Share Account - Regular",
          "Share Balance": "1,204.55",
          Opened: "2019-03-11",
        },
      ]);
      // No overlay: the effective digest is the artifact's, combined with a null overlay and the
      // linker version.
      expect(result.run.artifact.overlayDigest).toBeNull();
      expect(result.run.drift.divergence).toBe(0);
      expect(result.run.drift.needsSpecialization).toBe(false);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("replays green at SUMMIT through the overlay - same artifact, no re-recording", async () => {
    const overlay = { current: null as ReturnType<typeof summitOverlay> | null };
    const session = await openCorebankSession(
      // A placeholder merge just to shape the routes; the real overlay is sealed once the port is
      // known, immediately below.
      mergedRoutes(summitOverlay(PLACEHOLDER_ORIGIN)),
      { basePath: SUMMIT_BASE_PATH },
    );
    try {
      overlay.current = summitOverlay(session.fixture.origin);
      const { result } = await runAgainst({
        session,
        tenant: SUMMIT_TENANT,
        overlay: overlay.current,
        allowlist: summitAllowlist,
      });
      if (result.status !== "ok") console.error(JSON.stringify(result, null, 2));
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;

      // THE SAME NINE STEPS, IN THE SAME ORDER. An overlay cannot add, remove or reorder one, and
      // this is the assertion that says so against a running application rather than against a
      // schema.
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

      // THE SAME TYPED OUTPUTS, keyed by the CONTRACT's names. Summit prints "Member Name",
      // "Savings Balance", "Acct Status" and "Savings Account" on its screens; the caller sees the
      // fields it was compiled against, and the difference stays in the one document a per-tenant
      // difference belongs in.
      expect(result.outputs.memberName).toBe("ALVAREZ, DANA (SYNTHETIC)");
      expect(result.outputs.shareBalance).toEqual({ amount: "1204.55", currency: "USD" });
      expect(result.outputs.accountStatus).toBe("ACTIVE");
      expect(result.outputs.shareAccounts).toEqual([
        {
          Acct: "0001",
          "Share Account": "Savings Account - Regular",
          "Share Balance": "1,204.55",
          Opened: "2019-03-11",
        },
      ]);

      // THE ARTIFACT IS THE SAME BYTES. Not "a copy", not "a variant" - the same digest as the
      // riverbend run, which is what makes the approval signature over it still worth something at
      // this tenant.
      expect(result.run.artifact.digest).toBe(sharePositionArtifact.digest);
      expect(result.run.artifact.overlayDigest).toBe(overlay.current.digest);
      // And the effective digest is NOT the artifact digest: base (+) overlay means the base alone
      // cannot answer "which bytes ran", and in a regulated environment that has to be answerable.
      expect(result.run.artifact.effectiveDigest).not.toBe(sharePositionArtifact.digest);

      // ZERO DRIFT AT A TENANT THE ARTIFACT WAS NEVER RECORDED AGAINST. Every descriptor of every
      // step resolved, which is the whole claim: the overlay did not paper over a failure, it made
      // the same evidence available in this tenant's words. `needsSpecialization` is reported false
      // because no threshold ships, and the acceptance criterion for this unit is that it is not
      // set.
      expect(result.run.drift.divergence).toBe(0);
      expect(result.run.drift.changed).toEqual([]);
      expect(result.run.drift.needsSpecialization).toBe(false);

      // The routes the run actually used carry summit's mount point, and only that.
      expect(result.run.steps[0]?.stepId).toBe("open-search");
    } finally {
      await session.close();
    }
  }, 180_000);

  it("REFUSES at summit when the overlay's vocabulary is removed - the negative control", async () => {
    // The routing half is KEPT. Without it the program would navigate to riverbend's paths and pass
    // for the wrong reason, which would make this control prove nothing at all. What is taken away
    // is exactly the twelve label strings and the branding strip.
    const session = await openCorebankSession(mergedRoutes(summitOverlay(PLACEHOLDER_ORIGIN)), {
      basePath: SUMMIT_BASE_PATH,
    });
    try {
      const routingOnly = summitRoutingOnlyOverlay(session.fixture.origin);
      // It really is only the words that are missing: same mount path, same origin, same budgets.
      expect(routingOnly.vocabulary).toBeUndefined();
      expect(routingOnly.routeBasePath).toEqual(
        summitOverlay(session.fixture.origin).routeBasePath,
      );

      const { result } = await runAgainst({
        session,
        tenant: SUMMIT_TENANT,
        overlay: routingOnly,
        allowlist: summitAllowlist,
      });

      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;

      // WHERE it fails is the point. Step 1 navigates and counts textboxes, which is vocabulary-free
      // and passes at both tenants. Step 2 is the first step whose target is found by a LABEL, and
      // the label is the thing the overlay was carrying.
      expect(result.failure.atStep).toBe("enter-member-id");
      // AND HOW it fails is the rest of the point. One descriptor (the ordinal) still resolves and
      // one (the label anchor) abstains, so the quorum is not met - and the engine REFUSES rather
      // than acting on the single opinion that survived. A fallback chain would have typed the
      // member number into whatever the ordinal pointed at and returned `ok`.
      expect(result.failure.class).toBe("target-underdetermined");
      // The drift signal sees it too, and says exactly what happened in the words an operator
      // needs: the label-anchored descriptor was resolving and is now abstaining. THAT is the
      // sentence that turns "it broke at summit" into "summit renamed the Member ID field", and it
      // is on the `failed` arm as well as the green one.
      expect(result.run.drift.changed).toEqual([
        {
          stepId: "enter-member-id",
          descriptorId: "member-id-right-of-label",
          was: "resolved",
          now: "abstained",
        },
      ]);
      expect(result.run.drift.divergence).toBeGreaterThan(0);
      // Nothing was typed. A refusal that had already dispatched the action would be a refusal
      // after the fact.
      expect(JSON.stringify(result)).not.toContain(FIXTURE_MEMBER_ID);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("reports cross-tenant divergence with a number, and ships no threshold", async () => {
    const riverbend = await openCorebankSession(BASE_ROUTES);
    let summit: CorebankSession | null = null;
    try {
      const left = await perceiveScreens(riverbend);
      summit = await openCorebankSession(mergedRoutes(summitOverlay(PLACEHOLDER_ORIGIN)), {
        basePath: SUMMIT_BASE_PATH,
      });
      const right = await perceiveScreens(summit);

      const report = crossTenantDivergence({
        leftTenantId: RIVERBEND_TENANT.tenantId,
        rightTenantId: SUMMIT_TENANT.tenantId,
        screens: CROSS_TENANT_SCREENS.map((screen, i) => ({
          screen: screen.screen,
          left: left[i] as Observation,
          right: right[i] as Observation,
        })),
      });

      // PRINTED, not only asserted. The number is a deliverable of this unit and the command that
      // produced it is `pnpm -F @crr/runtime test browser-overlay`; a number nobody can see in the
      // output of that command is a number nobody can check.
      process.stderr.write(`\n${renderDivergence(report)}\n\n`);

      expect(report.screens).toHaveLength(4);

      // THE SHAPE OF THE RESULT, not a magic constant. Asserting the exact percentage would make
      // this test a transcription of the fixture rather than a statement about it, and the fixture
      // is allowed to gain a screen.
      const { all, interactive } = report.overall;
      expect(all.divergence).toBeGreaterThan(0);
      expect(all.divergence).toBeLessThan(1);
      expect(interactive.divergence).toBeGreaterThan(0);
      expect(interactive.divergence).toBeLessThan(1);

      // THE FINDING, AND IT IS NOT THE ONE THE TERMINAL SPIKE FOUND.
      //
      // Measured here: 33.8% over all nodes, 38.5% over interactive nodes only (506/526 nodes,
      // 411 shared, union 621; and 31/32 nodes, 24 shared, union 39). Under the terminal spike's
      // own arithmetic - shared over ONE side rather than over the union, see `divergence.ts` - the
      // same two runs read 18.8% and 22.6%. The spike measured 63% and 40%, i.e. all-nodes ABOVE
      // interactive-nodes. THE RELATIONSHIP IS INVERTED ON THIS SURFACE, under either arithmetic,
      // and the reason is the surface rather than the tenants:
      //
      //   · a character grid has eight nodes on a screen, three of them headings carrying the
      //     bank's name, so branding is a large fraction of everything there is and the all-nodes
      //     band is dominated by it;
      //   · a server-rendered DOM has five hundred, nearly all of them layout cells and data text
      //     that is IDENTICAL at both tenants because it is the same synthetic member. Branding is
      //     a rounding error in that denominator, so the all-nodes band is DILUTED, while the
      //     thirty-odd interactive nodes are exactly the ones whose labels the tenant renamed.
      //
      // What survives both measurements is the thing worth writing down: THE BAND YOU FINGERPRINT
      // CHANGES THE NUMBER BY A THIRD OR MORE, so a divergence figure quoted without its band is
      // meaningless - and a threshold set against one surface would be wrong on the other. That is
      // the second, independent reason this report ships no threshold, alongside the first one
      // (OPEN-QUESTIONS-RESOLVED Q4: nobody has measured a corpus yet).
      expect(interactive.divergence).not.toBe(all.divergence);

      // Every screen diverged, and none of them is 100% - a screen at 100% would mean the pairing
      // matched two different screens, which is the one way this report can be quietly wrong.
      for (const screen of report.screens) {
        expect(screen.all.divergence).toBeGreaterThan(0);
        expect(screen.all.divergence).toBeLessThan(1);
        expect(screen.all.shared).toBeGreaterThan(0);
      }

      // The renamed labels are IN the report, by name. A fraction with no evidence under it is a
      // number a human cannot act on, and acting on it is the whole point of shipping no threshold.
      const changedKeys = report.screens
        .flatMap((s) => s.interactive.changed)
        .map((c) => c.key)
        .join(" | ");
      expect(changedKeys).toContain("find");
      expect(changedKeys).toContain("search");

      // NO THRESHOLD SHIPS. `null`, not `false`: `false` would be a verdict, and the verdict is
      // deferred to a human until the number has been measured against a corpus.
      expect(report.needsSpecialization).toBeNull();
    } finally {
      await riverbend.close();
      await summit?.close();
    }
  }, 180_000);
});
