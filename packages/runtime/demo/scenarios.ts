// The five replay exhibits, and what each one is in the bundle to prove.
//
// The set is chosen the same way build unit 11's acceptance test chose its three: to hit every arm
// of the result contract at least once, because a bundle that shows three variations of one arm
// shows one thing. The assignment asks for "at least one replay that hits an exceptional state";
// four of these five are exceptional, and they are exceptional in three DIFFERENT ways, which is
// the distinction BRIEF section 2 calls the most common design mistake in this problem:
//
//   green      - the run succeeds and returns typed outputs.
//   outcome    - MEMBER_NOT_FOUND. A legitimate typed ANSWER, not an error. No catch block in the
//                engine can observe it and the caller is told what to do about it.
//   recovered  - a declared interstitial, dismissed inside a budget, still `ok` - and REPORTED,
//                because a condition that is silently recovered from is a condition nobody fixes.
//   failed     - an application error page, and an expired session. Two different failure classes,
//                both hard, both naming the step, the expectation and the observation.
//
// WHAT IS NOT HERE, and why. The fixture can also deny a write by record and by role (SPEC section
// 4.2 rows 7 and 8, the "permission denied" pair). Both are served on the COMMIT route, and this
// capability is READ-only: it stops at the prepared sub-account form and never posts. Rather than
// arm a fault the flow cannot reach and present the resulting checkpoint failure as a permission
// denial, the two rows are exercised where they can be exercised honestly - over frozen
// observations in `@crr/conformance`'s corpus, with no browser and no ambiguity about what was
// actually shown. The gap is named in `evidence/README.md` rather than papered over.

import type { ReplayResultDocument } from "@crr/core";

export interface FaultSpec {
  readonly id: string;
  /** The flow screen the fault fires on. `sticky` faults keep firing; `once` faults clear. */
  readonly at: string;
  readonly mode: "once" | "sticky";
}

export interface Scenario {
  /** Directory name under `evidence/`. */
  readonly id: string;
  readonly title: string;
  readonly arm: ReplayResultDocument["status"];
  /** The three-way split this exhibit lands in, in the brief's own vocabulary. */
  readonly taxonomy:
    | "green"
    | "expected business outcome"
    | "recoverable condition"
    | "hard failure";
  /** One line: what a reader should take away from this directory. */
  readonly proves: string;
  readonly fault: FaultSpec | null;
  /**
   * What this deployment's session broker can do when a recovery asks it to re-establish the
   * session. A restart - which the app-error remedy performs - always re-brokers, so this is not
   * only about session expiry: a broker that answers `failed` turns EVERY restart into
   * `session-expired-unrecoverable`, which is why the two hard-failure exhibits below declare
   * different deployments rather than sharing one and reporting the same class twice.
   */
  readonly broker: "can-reauthenticate" | "cannot-reauthenticate";
  readonly args: Readonly<Record<string, unknown>>;
  /** Asserted after the run. The demo exits non-zero if any of these is false, so a bundle that
   *  was committed is a bundle whose claims were checked. */
  readonly check: (result: ReplayResultDocument) => readonly string[];
}

const expect = (condition: boolean, complaint: string): readonly string[] =>
  condition ? [] : [complaint];

export function scenarios(memberId: string, absentMemberId: string): readonly Scenario[] {
  return [
    {
      id: "replay-01-green",
      title: "the nine-step share-position flow, no fault armed",
      arm: "ok",
      taxonomy: "green",
      proves:
        "A deterministic replay with no model anywhere in the decision path returns four typed outputs from a frameset-era application with no test ids.",
      fault: null,
      broker: "can-reauthenticate",
      args: { memberId },
      check: (result) => [
        ...expect(result.status === "ok", `expected the ok arm, got ${result.status}`),
        ...(result.status === "ok"
          ? [
              ...expect(
                result.outputs.memberName === "ALVAREZ, DANA (SYNTHETIC)",
                "the member name output did not arrive",
              ),
              ...expect(
                result.run.stepsExecuted === 9,
                `expected nine executed steps, got ${result.run.stepsExecuted}`,
              ),
              ...expect(
                result.run.drift.needsSpecialization === false,
                "the run reported that this tenant needs a specialized artifact",
              ),
            ]
          : []),
      ],
    },
    {
      id: "replay-02-outcome-member-not-found",
      title: "the core holds no such member",
      arm: "outcome",
      taxonomy: "expected business outcome",
      proves:
        "MEMBER_NOT_FOUND arrives on the `outcome` arm with the caller guidance copied verbatim from the reviewed contract. It is an answer, not an exception, and the run stops at the step that detected it.",
      fault: { id: "not-found", at: "results", mode: "sticky" },
      broker: "can-reauthenticate",
      args: { memberId: absentMemberId },
      check: (result) => [
        ...expect(result.status === "outcome", `expected the outcome arm, got ${result.status}`),
        ...(result.status === "outcome"
          ? [
              ...expect(
                result.outcome === "MEMBER_NOT_FOUND",
                `expected MEMBER_NOT_FOUND, got ${result.outcome}`,
              ),
              ...expect(result.terminal, "the outcome should be terminal"),
              ...expect(
                result.callerAction === "retry-different-input",
                "the caller action did not come from the contract",
              ),
              ...expect(!("failure" in result), "an outcome must carry no failure object"),
            ]
          : []),
      ],
    },
    {
      id: "replay-03-recovered-interstitial",
      title: "a declared maintenance modal, dismissed inside its budget",
      arm: "ok",
      taxonomy: "recoverable condition",
      proves:
        "A blocking dialog the artifact DECLARED is remedied, the flow re-walked, and the run still returns `ok` - with the recovery on the envelope, because a condition that is silently absorbed is a condition nobody ever fixes.",
      fault: { id: "interstitial", at: "results", mode: "once" },
      broker: "can-reauthenticate",
      args: { memberId },
      check: (result) => [
        ...expect(result.status === "ok", `expected the ok arm, got ${result.status}`),
        ...(result.status === "ok"
          ? [
              ...expect(
                result.run.recoveriesApplied.some((r) => r.name === "DISMISS_SYSTEM_NOTICE"),
                "the recovery was applied but not reported on the envelope",
              ),
              ...expect(
                result.run.budgets.remediations.used >= 1,
                "the remediation budget was not spent",
              ),
            ]
          : []),
      ],
    },
    {
      id: "replay-04-failed-app-error",
      title: "an application error page that will not clear",
      arm: "failed",
      taxonomy: "hard failure",
      proves:
        "The one restart the taxonomy allows a READ run is spent against a broker that CAN re-establish the session, and then the run STOPS. The failure names the step, what was expected, what was observed and what an operator should do - and it is never promoted into a business outcome just because the content region is empty.",
      fault: { id: "app-error", at: "detail", mode: "sticky" },
      broker: "can-reauthenticate",
      args: { memberId },
      check: (result) => [
        ...expect(result.status === "failed", `expected the failed arm, got ${result.status}`),
        ...(result.status === "failed"
          ? [
              ...expect(
                result.failure.class === "app-error",
                `expected the app-error class, got ${result.failure.class}`,
              ),
              ...expect(
                result.failure.atStep !== null,
                "a hard failure must name the step it happened at",
              ),
              ...expect(
                result.failure.expected.rendered.length > 0,
                "a hard failure must render what it expected",
              ),
            ]
          : []),
      ],
    },
    {
      id: "replay-05-failed-session-expired",
      title: "the session expires mid-flow and cannot be re-established",
      arm: "failed",
      taxonomy: "hard failure",
      proves:
        "The declared `SESSION_EXPIRED` rule delegates to the session broker rather than logging in - there is nowhere in the artifact a credential could be written down. THIS DEPLOYMENT'S BROKER CANNOT RE-AUTHENTICATE, which is the only configuration in which `session-expired-unrecoverable` is reachable at all, so the condition is reported as a hard failure instead of being retried forever.",
      fault: { id: "session-timeout", at: "detail", mode: "sticky" },
      broker: "cannot-reauthenticate",
      args: { memberId },
      check: (result) => [
        ...expect(result.status === "failed", `expected the failed arm, got ${result.status}`),
        ...(result.status === "failed"
          ? expect(
              result.failure.class.startsWith("session-expired"),
              `expected a session-expired class, got ${result.failure.class}`,
            )
          : []),
      ],
    },
  ];
}
