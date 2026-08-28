// SPEC section 4.2, row by row, against frozen observations. No browser, no fixture server, no
// session, milliseconds.
//
// This file is the evidence for the single claim the whole design rests on: that the mapping from
// what a screen shows to what a caller is told is DECLARED, ORDERED and TESTABLE, rather than
// emergent. Every row of the enumeration has a case here, each asserting the exact `Verdict` -
// including the eight rows SPEC section 4.2 names as the ones a happy-path design silently gets
// wrong (4-vs-5, 7-vs-8, 15, 23, 25, 26, 30, 33).
//
// Read the `describe` blocks as the argument:
//
//   · "the enumeration"            - one case per row, in row order.
//   · "the band order"             - the four precedence calls that are load-bearing, each written
//                                    as the screen that would be misclassified without it.
//   · "failing closed"             - the screens that must NOT become a business outcome. These are
//                                    the tests that would catch the nearest-string-match,
//                                    empty-page-means-not-found class of bug.
//   · "the six purity conditions"  - totality, determinism, no mutation, and the redaction canary.

import { describe, expect, it } from "vitest";
import {
  type ClassifierInput,
  type FailureClass,
  type ResolvedBinding,
  type TargetCandidate,
  type Verdict,
  classify,
  preFlightVerdict,
} from "../src/index.js";
import {
  AMBIENT_NATIVE_DIALOG,
  APP_ERROR,
  ARTIFACT_LITERAL_ID,
  CALLER_MEMBER_ID,
  DISMISS_KEEPALIVE_NUDGE,
  FRESH_COUNTERS,
  INVALID_MEMBER_ID,
  ROLE_NOT_ENTITLED,
  SEARCH_RETURNED_NOTHING,
  SESSION_EXPIRED_RESUME,
  appErrorPage,
  detailUnreadableBalance,
  entitlementDenied,
  inputFor,
  notFoundBanner,
  notFoundBehindModal,
  notFoundUnsettled,
  notFoundWithKeepAliveNudge,
  program,
  readSharesStep,
  resolvedStep,
  restrictedDetail,
  restrictedDetailNoCode,
  sessionExpired,
  sessionExpiredOverNotFound,
  validationError,
  wrongMemberDetail,
} from "./fixtures/classifier-screens.js";
import {
  detail,
  results,
  resultsNotice,
  resultsTorn,
  searchForm,
  searchNativeConfirm,
  searching,
} from "./fixtures/corebank-observations.js";

// ---------------------------------------------------------------------------------------------
// Assertions that say what they mean
// ---------------------------------------------------------------------------------------------

function expectFail(verdict: Verdict, failure: FailureClass) {
  expect(verdict.kind, `expected a fail(${failure}), got ${describeVerdict(verdict)}`).toBe("fail");
  if (verdict.kind !== "fail") throw new Error("unreachable");
  expect(verdict.failure).toBe(failure);
  return verdict.detail;
}

function expectOutcome(verdict: Verdict, code: string) {
  expect(verdict.kind, `expected outcome ${code}, got ${describeVerdict(verdict)}`).toBe("outcome");
  if (verdict.kind !== "outcome") throw new Error("unreachable");
  expect(verdict.code).toBe(code);
  return verdict;
}

function expectRecover(verdict: Verdict, name: string) {
  expect(verdict.kind, `expected recover ${name}, got ${describeVerdict(verdict)}`).toBe("recover");
  if (verdict.kind !== "recover") throw new Error("unreachable");
  expect(verdict.recoveryName).toBe(name);
  return verdict;
}

function expectAdvance(verdict: Verdict) {
  expect(verdict.kind, `expected advance, got ${describeVerdict(verdict)}`).toBe("advance");
  if (verdict.kind !== "advance") throw new Error("unreachable");
  return verdict;
}

/** So a wrong verdict names itself in the failure message rather than printing a whole object. */
function describeVerdict(v: Verdict): string {
  switch (v.kind) {
    case "fail":
      return `fail(${v.failure}) - ${v.detail.expected.rendered}`;
    case "outcome":
      return `outcome(${v.code})`;
    case "recover":
      return `recover(${v.recoveryName})`;
    case "pending":
      return "pending";
    case "advance":
      return `advance(${v.outputs.map((o) => o.output).join(", ")})`;
  }
}

const candidate = (id: string, verdict: TargetCandidate["verdict"]): TargetCandidate => ({
  descriptorId: id,
  kind: "role-name",
  evidenceSource: "accessibleName",
  verdict,
  nodeId: null,
  fingerprint: null,
  rendered: `the button named <${id}>`,
});

// ---------------------------------------------------------------------------------------------
// The enumeration - SPEC section 4.2, in row order
// ---------------------------------------------------------------------------------------------

describe("SPEC 4.2 the enumeration", () => {
  // -- rows 1-3: decided before the surface is touched at all -------------------------------

  it("row 1: a caller argument that fails a declared constraint is a FAILURE, not an outcome", () => {
    const verdict = preFlightVerdict(
      "argument-invalid",
      "memberId is 5 to 10 digits, and the supplied value is not",
    );
    const detail = expectFail(verdict, "argument-invalid");
    // "We definitely did not touch anything" is a materially different answer from "we stopped
    // partway", and it is said out loud rather than inferred from the class.
    expect(detail.sideEffects).toBe("none-guaranteed");
    expect(detail.retriable).toBe("same-inputs");
  });

  it("row 2: a linker refusal is a pre-flight failure with zero actions performed", () => {
    const detail = expectFail(preFlightVerdict("link-error", "check 12"), "link-error");
    expect(detail.sideEffects).toBe("none-guaranteed");
    expect(detail.retriable).toBe("after-human-action");
  });

  it("row 3: a stale pinned contract digest is a pre-flight failure", () => {
    const detail = expectFail(preFlightVerdict("contract-stale", "digest pin"), "contract-stale");
    expect(detail.sideEffects).toBe("none-guaranteed");
  });

  it("refuses to dress a mid-run failure up as a pre-flight one", () => {
    // `sideEffects: "none-guaranteed"` is a claim about the world, so the set of classes that may
    // make it is closed and enforced here rather than trusted to the caller.
    expectFail(preFlightVerdict("checkpoint-failed", "n/a"), "internal-invariant");
  });

  // -- rows 4 and 5: the same red banner, two different answers -------------------------------

  it("row 4: a validation error on the CALLER's value is a business outcome", () => {
    const step = resolvedStep("enter-member-id", { outcomes: [INVALID_MEMBER_ID] });
    const verdict = classify(inputFor(step, validationError));
    const outcome = expectOutcome(verdict, "INVALID_MEMBER_ID");
    expect(outcome.alsoMatched).toEqual([]);
  });

  it("row 5: the IDENTICAL screen is a hard failure when the rejected value was baked into the artifact", () => {
    // Nothing about the observation changed. The only difference is where the value came from -
    // which is the second, unadvertised return on parameterization, and the reason
    // `ResolvedBindings` is a classifier input at all.
    const step = resolvedStep("enter-member-id", {
      outcomes: [INVALID_MEMBER_ID],
      instruction: {
        kind: "fill",
        value: { from: "literal", value: "00000", sensitivity: "public" },
        mode: "replace",
      },
    });
    const verdict = classify(
      inputFor(step, validationError, { bindings: [CALLER_MEMBER_ID, ARTIFACT_LITERAL_ID] }),
    );
    const detail = expectFail(verdict, "checkpoint-failed");
    // Telling an agent "retry with different input" for an artifact bug sends it into a loop it
    // can never exit, so the guidance must be the one that reaches a person.
    expect(detail.retriable).toBe("after-human-action");
  });

  // -- rows 6, 7, 8: the answers, and the one that only looks like one ------------------------

  it("row 6: a declared not-found detector returns MEMBER_NOT_FOUND", () => {
    expectOutcome(
      classify(inputFor(resolvedStep("submit-search"), notFoundBanner)),
      "MEMBER_NOT_FOUND",
    );
  });

  it("row 7: a permission denial scoped to the RECORD is an outcome, and carries its payload", () => {
    const verdict = classify(inputFor(resolvedStep("open-member-row"), restrictedDetail));
    const outcome = expectOutcome(verdict, "MEMBER_RESTRICTED");
    expect(outcome.data).toEqual([
      { output: "restrictionCode", value: "LEGAL_HOLD", sensitivity: "internal" },
    ]);
  });

  it("row 8: a permission denial scoped to the SESSION'S ROLE is a hard failure", () => {
    // It will fail identically for every input forever, retrying is pointless, and the fix is a
    // person changing an entitlement. Note it renders almost the same screen as row 7.
    const verdict = classify(
      inputFor(resolvedStep("open-member-row"), entitlementDenied, {
        ambient: [ROLE_NOT_ENTITLED],
      }),
    );
    const detail = expectFail(verdict, "entitlement-denied");
    expect(detail.retriable).toBe("after-human-action");
  });

  // -- rows 9 and 10: interception ------------------------------------------------------------

  it("row 9: a declared native dialog is recoverable, budgeted", () => {
    const verdict = classify(inputFor(resolvedStep("submit-search"), searchNativeConfirm));
    const recover = expectRecover(verdict, "DISMISS_KEEPALIVE_DIALOG");
    expect(recover.remedy).toEqual({ kind: "dismiss-native-dialog", accept: false });
    expect(recover.attempt).toBe(1);
  });

  it("row 10: an UNDECLARED blocking overlay is a hard failure, never a guess at the button", () => {
    // Answering a prompt nobody declared is how an automation clicks "Yes, delete" for a member.
    expectFail(
      classify(inputFor(resolvedStep("submit-search"), notFoundBehindModal)),
      "undeclared-dialog",
    );
  });

  // -- rows 11, 12, 13: session expiry, and the two gates ------------------------------------

  it("row 11: session expiry with a resume point and no irreversible step crossed is recoverable", () => {
    const step = resolvedStep("submit-search", { recoveries: [SESSION_EXPIRED_RESUME] });
    const verdict = classify(inputFor(step, sessionExpired, { ambient: [] }));
    expect(expectRecover(verdict, "SESSION_EXPIRED_RESUME").remedy).toEqual({
      kind: "reauthenticate",
    });
  });

  it("row 12: session expiry restarts the program when the restart gate passes at pc", () => {
    expectRecover(
      classify(inputFor(resolvedStep("submit-search"), sessionExpired)),
      "SESSION_EXPIRED",
    );
  });

  it("row 13: session expiry with neither gate passing is session-expired-unrecoverable", () => {
    // The program-attempt ledger is spent. A restart into the same expired session would burn the
    // budget and fail, so the run stops and says why.
    const verdict = classify(
      inputFor(resolvedStep("submit-search"), sessionExpired, {
        counters: {
          ...FRESH_COUNTERS,
          run: { ...FRESH_COUNTERS.run, programAttempts: { used: 2, limit: 2 } },
        },
      }),
    );
    expectFail(verdict, "session-expired-unrecoverable");
  });

  // -- rows 14 and 15: waiting, and giving up ------------------------------------------------

  it("row 14: transient slowness is `pending` and needs no remedy", () => {
    const verdict = classify(inputFor(resolvedStep("submit-search"), searching));
    expect(verdict).toEqual({ kind: "pending", reason: "not-settled", settleElapsedMs: 400 });
  });

  it("row 15: a surface that never settles inside its budget is did-not-settle, not not-found", () => {
    const verdict = classify(
      inputFor(resolvedStep("submit-search"), searching, { settleElapsedMs: 12_000 }),
    );
    expectFail(verdict, "did-not-settle");
  });

  // -- row 16: the application's own error page ----------------------------------------------

  it("row 16: an app error page gets ONE restart when the whole run is a READ", () => {
    const verdict = classify(
      inputFor(resolvedStep("submit-search"), appErrorPage, { ambient: [APP_ERROR] }),
    );
    expectRecover(verdict, "APP_ERROR");
  });

  it("row 16: the same app error page is a hard failure when the run can write", () => {
    // Gate 2 of SPEC 3.6: a program that could already have opened a sub-account cannot be
    // restarted, and the linker knows that statically before anything runs.
    const verdict = classify(
      inputFor(resolvedStep("submit-search"), appErrorPage, {
        ambient: [APP_ERROR],
        program: { ...program, maxEffect: "WRITE_IRREVERSIBLE" },
      }),
    );
    expectFail(verdict, "app-error");
  });

  // -- rows 17-20: targeting. Disagreement is a detected condition, not a fallback chain. -----

  it("row 17: descriptors that resolve to DIFFERENT nodes refuse to act", () => {
    const detail = expectFail(
      classify(
        inputFor(resolvedStep("open-member-row"), results, {
          phase: "pre",
          gate: {
            lease: "held",
            policy: null,
            target: {
              status: "ambiguous",
              candidates: [candidate("by-name", "resolved"), candidate("by-geometry", "disagreed")],
            },
          },
        }),
      ),
      "target-ambiguous",
    );
    // The report has to say WHICH descriptors disagreed and on what evidence, or an ambiguous
    // refusal looks like an inexplicable one.
    expect(detail.candidates?.map((c) => c.descriptorId)).toEqual(["by-name", "by-geometry"]);
  });

  it("row 18: too little independent evidence is target-underdetermined", () => {
    expectFail(
      classify(
        inputFor(resolvedStep("open-member-row"), results, {
          phase: "pre",
          gate: {
            lease: "held",
            policy: null,
            target: { status: "underdetermined", candidates: [candidate("by-name", "resolved")] },
          },
        }),
      ),
      "target-underdetermined",
    );
  });

  it("row 19: no descriptor resolving is target-not-found", () => {
    expectFail(
      classify(
        inputFor(resolvedStep("open-member-row"), results, {
          phase: "pre",
          gate: {
            lease: "held",
            policy: null,
            target: { status: "not-found", candidates: [candidate("by-name", "abstained")] },
          },
        }),
      ),
      "target-not-found",
    );
  });

  it("row 20: a resolved node that fails its own pre-act assertion is target-assert-failed", () => {
    // Control C1, the wrong-row killer. You cannot click the wrong member's row when the row is
    // selected by the member id the caller asked about.
    expectFail(
      classify(
        inputFor(resolvedStep("open-member-row"), results, {
          phase: "pre",
          gate: {
            lease: "held",
            policy: null,
            target: {
              status: "assert-failed",
              candidates: [candidate("select-by-row-key", "resolved")],
            },
          },
        }),
      ),
      "target-assert-failed",
    );
  });

  // -- rows 21 and 22: the driver's own faults ------------------------------------------------

  it("row 21: a perceive deadline with a dialog on the channel is reported as the DIALOG", () => {
    // A native dialog blocks the renderer and the accessibility tree never returns. "Perception
    // timed out" is true and useless; "an undeclared dialog is up" is what a person can act on.
    expectFail(
      classify(
        inputFor(resolvedStep("read-savings-balance"), searchNativeConfirm, {
          ambient: [],
          perceiveFault: { kind: "perceive-timeout", elapsedMs: 2_000 },
        }),
      ),
      "undeclared-dialog",
    );
  });

  it("row 21: a perceive fault with no dialog known is surface-error", () => {
    expectFail(
      classify(
        inputFor(resolvedStep("submit-search"), results, {
          perceiveFault: { kind: "surface-error", message: "the driver lost its transport" },
        }),
      ),
      "surface-error",
    );
  });

  it("row 22: a driver refusal is action-rejected, and the mechanism is named", () => {
    const detail = expectFail(
      classify(
        inputFor(resolvedStep("submit-search"), searchForm, {
          actFault: { kind: "not-actionable", nodeId: "button:search" as never, why: "disabled" },
        }),
      ),
      "action-rejected",
    );
    expect(detail.expected.rendered).toContain("not-actionable");
  });

  // -- rows 23-26: the checkpoint, and the four ways it can be wrong --------------------------

  it("row 23: an action that dispatched and changed nothing is no-observable-effect", () => {
    // SPEC 4.5 W6. Otherwise indistinguishable from success on a page that looks similar before
    // and after, and the only control that catches it is the delta assertion.
    expectFail(
      classify(
        inputFor(resolvedStep("submit-search"), searchForm, {
          preActDigest: searchForm.skeletonDigest,
        }),
      ),
      "no-observable-effect",
    );
  });

  it("row 24: a torn read fails the checkpoint rather than reporting an empty result", () => {
    // Quiescence proposed and was wrong: this snapshot says `settled: true` and the grid had not
    // painted. The checkpoint is the real readiness gate.
    expectFail(classify(inputFor(resolvedStep("submit-search"), resultsTorn)), "checkpoint-failed");
  });

  it("row 25: landing on the WRONG member is continuity-broken, not success", () => {
    // Control C2. Everything else about this screen is right; the app's own search silently
    // corrected the number. Nothing but continuity catches that.
    const detail = expectFail(
      classify(inputFor(resolvedStep("read-savings-balance"), wrongMemberDetail)),
      "continuity-broken",
    );
    expect(detail.retriable).toBe("no");
  });

  it("row 26: a required output that cannot be typed is a failure, not a partial success", () => {
    // Returning `{ balance: null }` to an agent is how a member gets told their balance is
    // nothing. There is no partial success.
    expectFail(
      classify(inputFor(resolvedStep("read-savings-balance"), detailUnreadableBalance)),
      "output-extraction-failed",
    );
  });

  it("row 26: a table read that exceeds its declared bounds is TRUNCATED, never silently short", () => {
    // Reading nine of a member's ten shares and reporting them as ten is a wrong answer that looks
    // like a right one, which is why `onTruncate` has exactly one legal value.
    expectFail(classify(inputFor(readSharesStep(2), detail)), "output-extraction-failed");
  });

  it("row 26: the same read inside its bounds returns the rows, header row excluded", () => {
    const verdict = expectAdvance(classify(inputFor(readSharesStep(10), detail)));
    expect(verdict.outputs[0]?.value).toEqual([
      { "Share Type": "savings", "Current Balance": "1,284.55", Status: "open" },
      { "Share Type": "checking", "Current Balance": "210.00", Status: "open" },
      { "Share Type": "holiday club", "Current Balance": "0.00", Status: "closed" },
    ]);
  });

  it("row 26: an OUTCOME with a missing payload field is also a failure", () => {
    // A MEMBER_RESTRICTED with a typed hole in it is not a complete answer.
    expectFail(
      classify(inputFor(resolvedStep("open-member-row"), restrictedDetailNoCode)),
      "output-extraction-failed",
    );
  });

  // -- rows 27-29: the gates ------------------------------------------------------------------

  it("row 27: an action outside the allowlist is policy-denied", () => {
    expectFail(
      classify(
        inputFor(resolvedStep("submit-search"), searchForm, {
          phase: "pre",
          gate: {
            lease: "held",
            policy: {
              allow: false,
              reason: "route-not-allowed",
              ruleId: "allowlist/routes",
              detail: "/admin/config is not in the allowlist",
            },
            target: null,
          },
        }),
      ),
      "policy-denied",
    );
  });

  it("row 27: an irreversible action with no approval token is approval-required, a different class", () => {
    expectFail(
      classify(
        inputFor(resolvedStep("submit-search"), searchForm, {
          phase: "pre",
          gate: {
            lease: "held",
            policy: {
              allow: false,
              reason: "irreversible-requires-approval",
              ruleId: "policy/approval",
              detail: "no approval token accompanied this invocation",
            },
            target: null,
          },
        }),
      ),
      "approval-required",
    );
  });

  it("row 28: a human taking the lease mid-run stops the run", () => {
    expectFail(
      classify(
        inputFor(resolvedStep("submit-search"), results, {
          gate: { lease: "lost", policy: null, target: null },
        }),
      ),
      "lease-lost",
    );
  });

  it("row 28: a handoff resume is not a lost lease", () => {
    expectAdvance(
      classify(
        inputFor(resolvedStep("submit-search"), results, {
          gate: { lease: "handoff-resume", policy: null, target: null },
        }),
      ),
    );
  });

  it("row 29: a false precondition stops the step before it acts", () => {
    const detail = expectFail(
      classify(inputFor(resolvedStep("open-member-row"), searchForm, { phase: "pre" })),
      "precondition-not-met",
    );
    // The trace names the clause, generated by a fold over the predicate rather than authored.
    expect(detail.expected.rendered).toContain("a row");
  });

  // -- rows 30-32: taxonomy and budget --------------------------------------------------------

  it("row 30: two rules matching in one band with no total order is a REFUSAL", () => {
    // The tie reaches the step through an ambient rule colliding with a step rule - neither
    // document is wrong by itself, which is exactly why the linker cannot catch it.
    const detail = expectFail(
      classify(
        inputFor(resolvedStep("submit-search"), searchNativeConfirm, {
          ambient: [AMBIENT_NATIVE_DIALOG],
        }),
      ),
      "ambiguous-classification",
    );
    expect(detail.expected.rendered).toContain("DISMISS_KEEPALIVE_DIALOG");
    expect(detail.expected.rendered).toContain("AMBIENT_NATIVE_DIALOG");
  });

  it("row 30: a rule that matched but lost on priority is REPORTED, not dropped", () => {
    // Empty `alsoMatched` is normal; non-empty is a quiet warning that this step's taxonomy is
    // getting muddy, and it is visible on a run that succeeded rather than only on one that broke.
    const step = resolvedStep("submit-search", {
      outcomes: [...resolvedStep("submit-search").outcomes, SEARCH_RETURNED_NOTHING],
    });
    const outcome = expectOutcome(classify(inputFor(step, notFoundBanner)), "MEMBER_NOT_FOUND");
    expect(outcome.alsoMatched).toEqual([{ code: "SEARCH_RETURNED_NOTHING", priority: 20 }]);
  });

  it("row 31: a recovery that keeps recurring past its budget is recovery-exhausted", () => {
    const detail = expectFail(
      classify(
        inputFor(resolvedStep("submit-search"), searchNativeConfirm, {
          counters: { ...FRESH_COUNTERS, recoveryAttempts: { DISMISS_KEEPALIVE_DIALOG: 2 } },
        }),
      ),
      "recovery-exhausted",
    );
    // Exhaustion is a classification and not a timeout: it carries which recovery and how often.
    expect(detail.attempts).toEqual([
      {
        recoveryId: "DISMISS_KEEPALIVE_DIALOG",
        attempts: 2,
        lastSkeletonDigest: searchNativeConfirm.skeletonDigest,
      },
    ]);
  });

  it("row 32: a spent run ledger stops the run before it acts again", () => {
    expectFail(
      classify(
        inputFor(resolvedStep("submit-search"), searchForm, {
          phase: "pre",
          counters: {
            ...FRESH_COUNTERS,
            run: { ...FRESH_COUNTERS.run, actions: { used: 40, limit: 40 } },
          },
        }),
      ),
      "budget-exhausted",
    );
  });

  it("row 32: a spent wall-clock deadline is refused before a recovery is granted", () => {
    expectFail(
      classify(
        inputFor(resolvedStep("submit-search"), searchNativeConfirm, { elapsedMs: 120_000 }),
      ),
      "budget-exhausted",
    );
  });

  // -- rows 33 and 34 -------------------------------------------------------------------------

  it("row 33: an irreversible action whose result was never observed is effect-in-doubt", () => {
    const detail = expectFail(
      classify(
        inputFor(resolvedStep("submit-search"), results, {
          irreversibleDispatched: true,
          perceiveFault: { kind: "surface-error", message: "the session died" },
        }),
      ),
      "effect-in-doubt",
    );
    // It did not fail and it did not succeed. A replay engine that retries here opens two
    // sub-accounts, so the answer says so in the two fields a caller reads first.
    expect(detail.sideEffects).toBe("in-doubt");
    expect(detail.retriable).toBe("no");
  });

  it("row 33: after an irreversible dispatch a recovery is unreachable, and collapses to effect-in-doubt", () => {
    // SPEC 3.5: a recovery implies a retry, and a retry implies knowing the action did not take
    // effect - which is precisely what is unknown.
    const detail = expectFail(
      classify(
        inputFor(resolvedStep("submit-search"), searchNativeConfirm, {
          irreversibleDispatched: true,
        }),
      ),
      "effect-in-doubt",
    );
    expect(detail.retriable).toBe("no");
  });

  it("row 34: a step that quietly disabled `requiresSettled` is an ENGINE bug, and says so", () => {
    // The schema makes this literal non-configurable. A step assembled by hand that got past it
    // would turn "not yet" into "not so" with nothing in the journal to say so.
    const tampered = resolvedStep("submit-search", {
      outcomes: [{ ...resolvedStep("submit-search").outcomes[0], requiresSettled: false }] as never,
    });
    expectFail(classify(inputFor(tampered, notFoundUnsettled)), "internal-invariant");
  });
});

// ---------------------------------------------------------------------------------------------
// The band order - SPEC section 4.4
// ---------------------------------------------------------------------------------------------

describe("SPEC 4.4 the four orderings that are load-bearing", () => {
  it("B0 before everything: an unsettled screen showing the not-found banner is PENDING", () => {
    // Rule 3 of SPEC section 0, in one assertion. Against a half-painted page, "no member found"
    // and "not painted yet" are the same picture, and one of those answers is a compliance
    // incident.
    const verdict = classify(inputFor(resolvedStep("submit-search"), notFoundUnsettled));
    expect(verdict.kind).toBe("pending");
  });

  it("B0 corroborates the driver: `settled` with a moving digest window is still PENDING", () => {
    // `stability.settled` is one driver's opinion. The terminal spike measured what that opinion is
    // worth mid-repaint, so the digest window is an independent check and it costs a comparison.
    const verdict = classify(
      inputFor(resolvedStep("submit-search"), results, {
        recentDigests: [searchForm.skeletonDigest, results.skeletonDigest],
      }),
    );
    expect(verdict.kind).toBe("pending");
  });

  it("B1 before B3: a session-expiry banner over a not-found banner is a RECOVERY, not MEMBER_NOT_FOUND", () => {
    // The single most important precedence call in the problem. A logged-out page and an error
    // page both render text that trips content detectors, and a session-expiry screen often has an
    // empty content region that looks exactly like "no results".
    const verdict = classify(inputFor(resolvedStep("submit-search"), sessionExpiredOverNotFound));
    expectRecover(verdict, "SESSION_EXPIRED");
  });

  it("B2 before B3: a not-found banner behind a modal is not read as an answer", () => {
    // What is visible behind a modal is stale by construction - it is the state BEFORE whatever
    // prompted the modal. Reading an outcome off it is reading history.
    const verdict = classify(inputFor(resolvedStep("submit-search"), notFoundBehindModal));
    expect(verdict.kind).not.toBe("outcome");
    expectFail(verdict, "undeclared-dialog");
  });

  it("B3 before B4: a page that has given the final answer is not sent round a recovery", () => {
    // SPEC 4.4's own example: a results page showing both "no member found" and a "your session
    // will expire in 2 minutes" nudge returns MEMBER_NOT_FOUND. The nudge is a real recovery for a
    // step that has not finished; this step has.
    const step = resolvedStep("submit-search", {
      recoveries: [...resolvedStep("submit-search").recoveries, DISMISS_KEEPALIVE_NUDGE],
    });
    expectOutcome(classify(inputFor(step, notFoundWithKeepAliveNudge)), "MEMBER_NOT_FOUND");
  });

  it("an ambient rule is never a business outcome", () => {
    // Session expiry is not an ambient OUTCOME: the caller cannot act on it and the member should
    // not hear about it. The keep-alive dialog is an ambient recovery, and that distinction is the
    // taxonomy doing real work.
    const verdict = classify(inputFor(resolvedStep("submit-search"), sessionExpired));
    expect(verdict.kind).toBe("recover");
  });
});

// ---------------------------------------------------------------------------------------------
// Failing closed - the tests that catch the whole class of "helpful" classifier
// ---------------------------------------------------------------------------------------------

describe("failing closed toward `failed`", () => {
  it("an empty search form is never MEMBER_NOT_FOUND", () => {
    // "The page looks empty" is not a detector. Nothing is inferred into an outcome.
    const verdict = classify(
      inputFor(resolvedStep("submit-search"), searchForm, {
        preActDigest: results.skeletonDigest,
      }),
    );
    expect(verdict.kind).not.toBe("outcome");
    expectFail(verdict, "checkpoint-failed");
  });

  it("a torn read is never MEMBER_NOT_FOUND", () => {
    expect(classify(inputFor(resolvedStep("submit-search"), resultsTorn)).kind).not.toBe("outcome");
  });

  it("an undeclared permission-denial screen defaults to the FAILURE, never to an outcome", () => {
    // SPEC 4.3: "an undeclared denial defaults to row 8, the failure - never to row 7. That is
    // fail-closed in its most consequential instance." Here no detector is declared at all, so the
    // screen falls all the way through to B6 - which is a legitimate answer, not a gap.
    const verdict = classify(
      inputFor(resolvedStep("submit-search"), entitlementDenied, { ambient: [] }),
    );
    expect(verdict.kind).not.toBe("outcome");
    expectFail(verdict, "checkpoint-failed");
  });

  it("a screen whose banner merely LOOKS like a declared one is not promoted", () => {
    // The nearest-string-match mutant of SPEC 4.8. "Your session will expire in 2 minutes" shares
    // most of its words with the session-expiry token and matches neither synonym.
    const step = resolvedStep("read-savings-balance");
    const verdict = classify(
      inputFor(step, notFoundWithKeepAliveNudge, {
        preActDigest: detail.skeletonDigest,
      }),
    );
    expect(verdict.kind).not.toBe("outcome");
    expect(verdict.kind).not.toBe("recover");
  });

  it("a detector whose vocabulary token is undeclared evaluates FALSE rather than throwing", () => {
    // Totality with a bias: a detector that cannot be evaluated has not been satisfied.
    const verdict = classify(
      inputFor(resolvedStep("submit-search"), notFoundBanner, {
        program: { ...program, vocabulary: {} },
      }),
    );
    expect(verdict.kind).not.toBe("outcome");
  });
});

// ---------------------------------------------------------------------------------------------
// The happy path, so the suite can tell a working engine from a paranoid one
// ---------------------------------------------------------------------------------------------

describe("the happy path still advances", () => {
  it("advances through the search step", () => {
    expect(
      expectAdvance(classify(inputFor(resolvedStep("submit-search"), results))).outputs,
    ).toEqual([]);
  });

  it("advances through the row-open step, continuity satisfied", () => {
    expectAdvance(
      classify(
        inputFor(resolvedStep("open-member-row"), detail, {
          preActDigest: results.skeletonDigest,
        }),
      ),
    );
  });

  it("advances the read step carrying its typed outputs", () => {
    const verdict = expectAdvance(classify(inputFor(resolvedStep("read-savings-balance"), detail)));
    expect(verdict.outputs).toEqual([
      { output: "memberName", value: "avery synthetic", sensitivity: "sensitive" },
      {
        output: "savingsBalance",
        value: { amount: "1284.55", currency: "USD" },
        sensitivity: "internal",
      },
      { output: "accountStatus", value: "OPEN", sensitivity: "internal" },
    ]);
  });

  it("says nothing on a pre-act classification with nothing to report", () => {
    const verdict = classify(
      inputFor(resolvedStep("read-savings-balance"), detail, { phase: "pre" }),
    );
    expect(verdict).toEqual({ kind: "advance", outputs: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// SPEC section 4.1 - the six purity conditions
// ---------------------------------------------------------------------------------------------

/** One input per interesting shape, so the properties below are asserted over the whole taxonomy
 *  rather than over one convenient case. */
const CORPUS: readonly ClassifierInput[] = [
  inputFor(resolvedStep("submit-search"), results),
  inputFor(resolvedStep("submit-search"), notFoundBanner),
  inputFor(resolvedStep("submit-search"), resultsTorn),
  inputFor(resolvedStep("submit-search"), searching),
  inputFor(resolvedStep("submit-search"), searchNativeConfirm),
  inputFor(resolvedStep("submit-search"), sessionExpired),
  inputFor(resolvedStep("submit-search"), resultsNotice),
  inputFor(resolvedStep("open-member-row"), detail),
  inputFor(resolvedStep("open-member-row"), restrictedDetail),
  inputFor(resolvedStep("open-member-row"), entitlementDenied, { ambient: [ROLE_NOT_ENTITLED] }),
  inputFor(resolvedStep("read-savings-balance"), detail),
  inputFor(resolvedStep("read-savings-balance"), wrongMemberDetail),
  inputFor(resolvedStep("read-savings-balance"), detailUnreadableBalance),
  inputFor(resolvedStep("enter-member-id", { outcomes: [INVALID_MEMBER_ID] }), validationError),
];

describe("SPEC 4.1 the six purity conditions", () => {
  it("is total: every input in the corpus returns a Verdict, and none throws", () => {
    for (const input of CORPUS) {
      const verdict = classify(input);
      expect(["pending", "advance", "outcome", "recover", "fail"]).toContain(verdict.kind);
    }
  });

  it("is deterministic: classifying twice is deep-equal", () => {
    for (const input of CORPUS) {
      expect(classify(input)).toEqual(classify(input));
    }
  });

  it("does not mutate its input", () => {
    for (const input of CORPUS) {
      const before = structuredClone(input) as unknown;
      classify(input);
      expect(input as unknown).toEqual(before);
    }
  });

  it("never lets a tainted parameter value into a verdict - the redaction canary", () => {
    // A `ValueRef` renders BY NAME and a template hole renders UNRESOLVED, and the observed side is
    // redacted per taint. So neither half of a failure report carries a member number, and two runs
    // are told apart by their run id rather than by the value they were asked about.
    const tainted = (CALLER_MEMBER_ID as ResolvedBinding).value;
    for (const input of CORPUS) {
      const serialized = JSON.stringify(classify(input));
      expect(
        serialized.includes(tainted),
        `${describeVerdict(classify(input))} leaked ${tainted}`,
      ).toBe(false);
    }
  });

  it("reports how many fields the taint model blanked, rather than hiding it", () => {
    // Zero on a screen that should have had some is worth noticing, which is only possible if the
    // count is a field.
    // The detail screen prints the member number back at you in its heading - the role a failure
    // summary is most likely to quote - and the driver never associated that heading with the
    // field the value was typed into. So the substitution happens once more on the way in.
    const verdict = classify(
      inputFor(resolvedStep("read-savings-balance"), detailUnreadableBalance),
    );
    const detail = expectFail(verdict, "output-extraction-failed");
    expect(detail.observed.redactionsApplied).toBeGreaterThan(0);
    expect(detail.observed.salient.map((n) => n.name)).toContain("Member Detail #<taint:memberId>");
  });

  it("has no clock: the same screen at two elapsed times differs only where a budget says so", () => {
    const early = classify(
      inputFor(resolvedStep("submit-search"), searching, { settleElapsedMs: 0 }),
    );
    const late = classify(
      inputFor(resolvedStep("submit-search"), searching, { settleElapsedMs: 11_999 }),
    );
    expect(early.kind).toBe("pending");
    expect(late.kind).toBe("pending");
    expect(
      classify(inputFor(resolvedStep("submit-search"), searching, { settleElapsedMs: 12_000 }))
        .kind,
    ).toBe("fail");
  });
});
