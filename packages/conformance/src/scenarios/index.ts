// THE SCENARIOS. Every fault `fixtures/corebank-web` can inject, crossed with the replay engine.
//
// The fixture's own registry (`fixtures/corebank-web/src/faults.js`) declares ten faults and states
// per fault which row of SPEC section 4.2 it exists to produce. `mirrors` on each scenario below
// names the fault id verbatim, and `test/conformance.test.ts` compares that set against the
// fixture's registry - so "we cover every fault" is a mechanical check rather than a promise.
//
// Beyond the ten, this file adds the wrong-target sub-cases of SPEC section 4.5. Those are not
// injectable over HTTP because they are properties of a LOCATOR rather than of a response: no
// fixture server can make two independently-computed descriptors disagree about which node is
// "the Open link on the member's row". They are the cases that make the difference between an
// engine that handles errors and an engine that notices it is about to click the wrong thing.

import type { ExtractedValue, MockTransition } from "@crr/core";
import { HAPPY_PATH, runFlow } from "../corpus/harness.js";
import { IDS } from "../corpus/screens.js";
import { checkResult } from "../support.js";
import type { ReplayEngine, Scenario, ScenarioObservation } from "../types.js";

/**
 * What the flow returns when nothing is wrong.
 *
 * The branded `Decimal` is asserted here and nowhere else in this package. Branding is a claim about
 * validation performed at a document boundary; an expected-value table in a test corpus is not that
 * boundary, and spreading the cast across every scenario would make it look like one.
 */
const HAPPY_OUTPUTS = {
  shareBalance: { amount: "1204.55", currency: "USD" },
  memberName: "Dale Rivera",
} as unknown as Readonly<Record<string, ExtractedValue>>;

/** Swap one transition of the happy path, leaving the rest alone. */
const swap = (
  from: string,
  on: MockTransition["on"],
  patch: Omit<MockTransition, "from" | "on">,
): readonly MockTransition[] => [
  { from, on, ...patch },
  ...HAPPY_PATH.filter(
    (t) => !(t.from === from && t.on.kind === on.kind && t.on.target === on.target),
  ),
];

const OPEN_MEMBER = { kind: "click", target: IDS.openLink } as const;
const SUBMIT = { kind: "click", target: IDS.searchButton } as const;
const OPEN_TAB = { kind: "click", target: IDS.sharesTab } as const;
const TYPE_MEMBER = { kind: "type", target: IDS.memberIdField } as const;
const TYPE_BRANCH = { kind: "type", target: IDS.branchField } as const;

const observed = (
  out: Awaited<ReturnType<typeof runFlow>>["out"],
  extra?: readonly ReturnType<typeof checkResult>[],
): ScenarioObservation => ({
  result: out.result,
  recoveries: out.result.run.recoveriesApplied.map((r) => r.name),
  // Carried on every scenario so the stability report can read per-descriptor and per-settle
  // behaviour out of the SAME runs the suite grades, rather than from a second corpus that could
  // drift away from the one the verdicts came from.
  journal: out.journal.events,
  ...(extra === undefined ? {} : { extra }),
});

export const ALL_SCENARIOS: readonly Scenario[] = [
  // -------------------------------------------------------------------------------------------
  // The baseline. A suite whose only green run is the happy path is a suite that grades nothing,
  // but a suite without one cannot tell "correct" from "refuses everything".
  // -------------------------------------------------------------------------------------------
  {
    id: "01",
    title: "the whole flow succeeds and returns typed outputs",
    mirrors: "(no fault)",
    row: "-",
    expect: { kind: "ok", outputs: HAPPY_OUTPUTS },
    async run(engine: ReplayEngine) {
      const { out } = await runFlow(engine, {});
      return observed(out);
    },
  },

  // -------------------------------------------------------------------------------------------
  // Business outcomes. The arm that is an ANSWER, not an exception.
  // -------------------------------------------------------------------------------------------
  {
    id: "02",
    title: "an empty results grid is MEMBER_NOT_FOUND, not an error",
    mirrors: "not-found",
    row: "6",
    expect: { kind: "outcome", code: "MEMBER_NOT_FOUND" },
    async run(engine) {
      const { out } = await runFlow(engine, {
        transitions: swap("search-ready", SUBMIT, { to: "results-empty" }),
      });
      return observed(out);
    },
  },
  {
    id: "03",
    title: "a validation error on the CALLER's own value is INVALID_MEMBER_ID",
    mirrors: "validation-error (param-bound half)",
    row: "4",
    expect: { kind: "outcome", code: "INVALID_MEMBER_ID" },
    async run(engine) {
      const { out } = await runFlow(engine, {
        transitions: swap("search", TYPE_MEMBER, { to: "search-member-rejected" }),
      });
      return observed(out);
    },
  },
  {
    id: "04",
    title:
      "the SAME banner over an artifact literal is a hard failure, never retry-different-input",
    mirrors: "validation-error",
    row: "5",
    expect: { kind: "failure", failure: "checkpoint-failed" },
    async run(engine) {
      // The detector for INVALID_BRANCH_CODE is declared and it MATCHES. The only reason this must
      // not be promoted is that the rejected value came from the artifact, so no caller can fix it
      // and telling an agent "retry with different input" sends it into a loop it cannot exit.
      const { out } = await runFlow(engine, {
        transitions: swap("search-member", TYPE_BRANCH, { to: "search-branch-rejected" }),
      });
      return observed(out, [
        checkResult(
          "the caller is NOT told to retry with a different input",
          out.result.status !== "outcome" || out.result.callerAction !== "retry-different-input",
          "an artifact bug was reported as something the caller could fix",
        ),
      ]);
    },
  },
  {
    id: "05",
    title: "a denial scoped to the RECORD is MEMBER_RESTRICTED",
    mirrors: "permission-denied-record",
    row: "7",
    expect: { kind: "outcome", code: "MEMBER_RESTRICTED" },
    async run(engine) {
      // The restricted record renders, so an engine that gets the precedence wrong does not simply
      // stop - it reads the balance off a screen that says a specialist has to handle this member.
      const { out } = await runFlow(engine, {
        transitions: [
          { from: "detail-restricted", on: OPEN_TAB, to: "detail-restricted-shares" },
          ...swap("results", OPEN_MEMBER, { to: "detail-restricted" }),
        ],
      });
      return observed(out);
    },
  },
  {
    id: "06",
    title: "a denial scoped to the SESSION ROLE is entitlement-denied, a hard failure",
    mirrors: "permission-denied-role",
    row: "8",
    expect: { kind: "failure", failure: "entitlement-denied" },
    async run(engine) {
      // The two screens are almost identical. What separates them is which detector the author
      // declared, and an UNDECLARED denial defaults to this one - fail-closed in its most
      // consequential instance.
      const { out } = await runFlow(engine, {
        transitions: swap("results", OPEN_MEMBER, { to: "detail-role-denied" }),
      });
      return observed(out);
    },
  },

  // -------------------------------------------------------------------------------------------
  // Recoverable conditions. Bounded, budgeted, and they still have to finish the job.
  // -------------------------------------------------------------------------------------------
  {
    id: "07",
    title: "a DECLARED interstitial is dismissed and the run finishes",
    mirrors: "interstitial",
    row: "9",
    expect: { kind: "recovered", outputs: HAPPY_OUTPUTS, recovery: "DISMISS_SYSTEM_NOTICE" },
    async run(engine) {
      const { out } = await runFlow(engine, {
        transitions: [
          { from: "search-member", on: TYPE_BRANCH, to: "search-notice", once: true },
          {
            from: "search-notice",
            on: { kind: "click", target: IDS.noticeAck },
            to: "search-ready",
          },
          { from: "search-ready", on: TYPE_BRANCH, to: "search-ready" },
          ...HAPPY_PATH,
        ],
      });
      return observed(out);
    },
  },
  {
    id: "08",
    title: "an UNDECLARED interstitial is undeclared-dialog, never answered on a guess",
    mirrors: "interstitial (undeclared half)",
    row: "10",
    expect: { kind: "failure", failure: "undeclared-dialog" },
    async run(engine) {
      const { out } = await runFlow(engine, {
        transitions: swap("results", OPEN_MEMBER, { to: "detail-undeclared-notice" }),
      });
      return observed(out);
    },
  },
  {
    id: "09",
    title: "a native dialog blocks the run rather than being answered",
    mirrors: "native-dialog",
    row: "10/21",
    expect: { kind: "failure", failure: "undeclared-dialog" },
    async run(engine) {
      const { out } = await runFlow(engine, {
        transitions: swap("results", OPEN_MEMBER, { to: "detail-native-dialog" }),
      });
      return observed(out);
    },
  },
  {
    id: "10",
    title: "an expired session is re-authenticated by the BROKER and the run finishes",
    mirrors: "session-timeout",
    row: "11",
    expect: { kind: "recovered", outputs: HAPPY_OUTPUTS, recovery: "SESSION_EXPIRED" },
    async run(engine) {
      // The program never logs in. The remedy calls the broker, and the broker is what knows how.
      const { out } = await runFlow(engine, {
        refresh: async () => "refreshed",
        transitions: [
          { from: "results", on: OPEN_MEMBER, to: "signin", once: true },
          { from: "signin", on: { kind: "navigate", path: "/teller/search" }, to: "search" },
          ...HAPPY_PATH,
        ],
      });
      return observed(out);
    },
  },
  {
    id: "11",
    title: "an expired session a broker cannot refresh is session-expired-unrecoverable",
    mirrors: "session-timeout (unrecoverable half)",
    row: "13",
    expect: { kind: "failure", failure: "session-expired-unrecoverable" },
    async run(engine) {
      const { out } = await runFlow(engine, {
        refresh: async () => "failed",
        transitions: [
          { from: "signin", on: { kind: "navigate", path: "/teller/search" }, to: "search" },
          ...swap("results", OPEN_MEMBER, { to: "signin" }),
        ],
      });
      return observed(out);
    },
  },

  // -------------------------------------------------------------------------------------------
  // Quiescence. "Not yet" is not "not so" - the single most important precedence call here.
  // -------------------------------------------------------------------------------------------
  {
    id: "12",
    title: "a slow grid is waited out and the run finishes",
    mirrors: "slow-load",
    row: "14",
    expect: { kind: "ok", outputs: HAPPY_OUTPUTS },
    async run(engine) {
      const { out } = await runFlow(engine, {
        transitions: swap("search-ready", SUBMIT, {
          to: "results",
          // Two polls of the flushed shell - which says "0 records found" and means "not yet".
          via: [{ kind: "screen", screen: "results-loading", times: 2 }],
        }),
      });
      return observed(out);
    },
  },
  {
    id: "13",
    title: "a grid that never settles is did-not-settle, NOT MEMBER_NOT_FOUND",
    mirrors: "slow-load (beyond the settle budget)",
    row: "15",
    expect: { kind: "failure", failure: "did-not-settle" },
    async run(engine) {
      // THE scenario band B0 exists for. The shell says "0 records found" for as long as anyone
      // looks at it. An engine that classifies against it tells a member their account is not on
      // file because a downstream service is slow.
      const { out } = await runFlow(engine, {
        transitions: swap("search-ready", SUBMIT, {
          to: "results",
          via: [{ kind: "stall", screen: "results-loading" }],
        }),
      });
      return observed(out);
    },
  },
  {
    id: "14",
    title: "a torn read is caught by the checkpoint even though the driver called it settled",
    mirrors: "torn-render",
    row: "24 (SPEC 4.4 B0)",
    expect: { kind: "failure", failure: "checkpoint-failed" },
    async run(engine) {
      const { out } = await runFlow(engine, {
        transitions: swap("search-ready", SUBMIT, { to: "results-torn" }),
      });
      return observed(out);
    },
  },

  // -------------------------------------------------------------------------------------------
  // Environment. It beats every declared outcome, because an error page is a fact about whether we
  // are looking at the application at all.
  // -------------------------------------------------------------------------------------------
  {
    id: "15",
    title: "an application error page is app-error once the restart budget is spent",
    mirrors: "app-error",
    row: "16",
    expect: { kind: "failure", failure: "app-error" },
    async run(engine) {
      const { out } = await runFlow(engine, {
        maxProgramAttempts: 1,
        refresh: async () => "refreshed",
        transitions: [
          { from: "app-error", on: { kind: "navigate", path: "/teller/search" }, to: "search" },
          ...swap("results", OPEN_MEMBER, { to: "app-error" }),
        ],
      });
      return observed(out);
    },
  },

  // -------------------------------------------------------------------------------------------
  // The wrong-target sub-cases of SPEC section 4.5. Not injectable over HTTP: these are properties
  // of a locator, and they are what "the model never authors a locator" buys.
  // -------------------------------------------------------------------------------------------
  {
    id: "16",
    title: "descriptors that name DIFFERENT nodes refuse to act (target-ambiguous)",
    mirrors: "SPEC 4.5 W1/W3 - two members, three descriptors, no agreement",
    row: "17",
    expect: { kind: "failure", failure: "target-ambiguous" },
    async run(engine) {
      // Row 0 is Kim Alvarez with an "Open" link; row 1 is ours, and the vendor renders its link as
      // "Open Account" because the member holds more than one share. Name says row 0, the row key
      // says row 1, the ordinal says row 0. A ranking would pick one and click it.
      const { out } = await runFlow(engine, {
        transitions: [
          { from: "search-ready", on: SUBMIT, to: "results-two-rows" },
          {
            from: "results-two-rows",
            on: { kind: "click", target: IDS.otherLink },
            to: "detail-other",
          },
          { from: "detail-other", on: OPEN_TAB, to: "detail-other-shares" },
          ...HAPPY_PATH,
        ],
      });
      return observed(out);
    },
  },
  {
    id: "17",
    title: "two agreeing descriptors resting on ONE piece of evidence are underdetermined",
    mirrors: "SPEC 4.5 C4 - the correlated-descriptor case",
    row: "18",
    expect: { kind: "failure", failure: "target-underdetermined" },
    async run(engine) {
      // The vendor's 8.3 release added a second form. `ordinal-in-container` now names a textbox in
      // each of two forms and abstains; what is left is a `role-name` and a `label-anchored`
      // descriptor reading the SAME words off the SAME label. Two descriptors, one piece of
      // evidence, and one rename would kill both.
      const { out } = await runFlow(engine, {
        transitions: [
          {
            from: "blank",
            on: { kind: "navigate", path: "/teller/search" },
            to: "search-two-forms",
          },
          // Scripted through to the end on purpose: an engine that wrongly commits to the field
          // must be allowed to RUN, so the suite grades the answer it gives rather than the crash
          // it caused. A mutant killed by a thrown fixture error proves nothing about the engine.
          { from: "search-two-forms", on: TYPE_MEMBER, to: "search-two-forms" },
          { from: "search-two-forms", on: TYPE_BRANCH, to: "search-two-forms-ready" },
          { from: "search-two-forms-ready", on: SUBMIT, to: "results" },
          ...HAPPY_PATH,
        ],
      });
      return observed(out);
    },
  },
  {
    id: "18",
    title: "a row that is not the member's fails the pre-act assertion (target-assert-failed)",
    mirrors: "SPEC 4.5 W1 - the core widened the search and returned somebody else",
    row: "20",
    expect: { kind: "failure", failure: "target-assert-failed" },
    async run(engine) {
      const { out } = await runFlow(engine, {
        transitions: [
          { from: "search-ready", on: SUBMIT, to: "results-wrong-row" },
          { from: "results-wrong-row", on: OPEN_MEMBER, to: "detail-other" },
          { from: "detail-other", on: OPEN_TAB, to: "detail-other-shares" },
          ...HAPPY_PATH,
        ],
      });
      return observed(out);
    },
  },
  {
    id: "19",
    title: "no descriptor resolves at all (target-not-found)",
    mirrors: "SPEC 4.5 - the action column never rendered",
    row: "19",
    expect: { kind: "failure", failure: "target-not-found" },
    async run(engine) {
      const { out } = await runFlow(engine, {
        transitions: swap("search-ready", SUBMIT, { to: "results-no-link" }),
      });
      return observed(out);
    },
  },
  {
    id: "20",
    title:
      "a control that dispatched and did nothing is no-observable-effect, NOT a balance of 0.00",
    mirrors: "SPEC 4.5 W6 - the dead control",
    row: "23",
    expect: { kind: "failure", failure: "no-observable-effect" },
    async run(engine) {
      // The tab panel renders `0.00` before the tab loads, and the checkpoint - settled, on route,
      // a status is present - is satisfied by the screen that was already there. Every control in
      // the system says yes except the delta.
      const { out } = await runFlow(engine, {
        transitions: swap("detail", OPEN_TAB, { bumpsGeneration: false }),
      });
      return observed(out, [
        checkResult(
          "NO WRONG BALANCE: the pre-click placeholder is not returned as the answer",
          out.result.status !== "ok" || JSON.stringify(out.result.outputs).includes("1204.55"),
          `outputs were ${JSON.stringify(out.result.status === "ok" ? out.result.outputs : {})}`,
        ),
      ]);
    },
  },
  {
    id: "21",
    title: "landing on the wrong member is continuity-broken, even when the click was unambiguous",
    mirrors: "SPEC 4.5 C2 - the app's own search silently corrected the id",
    row: "25",
    expect: { kind: "failure", failure: "continuity-broken" },
    async run(engine) {
      // The grid row IS ours - the row key matches, the assertion passes, the link is unique. The
      // application simply navigated somewhere else. Nothing but continuity can know.
      const { out } = await runFlow(engine, {
        transitions: [
          { from: "results", on: OPEN_MEMBER, to: "detail-other" },
          { from: "detail-other", on: OPEN_TAB, to: "detail-other-shares" },
          ...HAPPY_PATH,
        ],
      });
      return observed(out, [
        checkResult(
          "NO WRONG MEMBER: another member's balance is not returned",
          out.result.status !== "ok" || !JSON.stringify(out.result.outputs).includes("88.10"),
          "the run returned a balance belonging to a different member",
        ),
      ]);
    },
  },

  // -------------------------------------------------------------------------------------------
  // The gates that are decided before, or regardless of, what the screen says.
  // -------------------------------------------------------------------------------------------
  {
    id: "22",
    title: "a route outside the allowlist is refused before any action is dispatched",
    mirrors: "(the safety gate, not a fixture fault)",
    row: "2/27",
    expect: { kind: "failure", failure: "link-error" },
    async run(engine) {
      const { out, surface } = await runFlow(engine, {
        allowlist: {
          originAliases: ["corebank"],
          routes: [
            { originAlias: "corebank", pathPattern: "/teller/search", maxEffect: "READ" },
            { originAlias: "corebank", pathPattern: "/teller/results", maxEffect: "READ" },
          ],
          actionKinds: ["click", "type", "navigate", "pressKey", "acceptDialog", "dismissDialog"],
          maxEffect: "READ",
          discoveryMaxEffect: "READ",
        },
      });
      // The gate that fires is the LINKER's, not the chokepoint's, and the difference matters: the
      // linker runs 29 checks with zero actions performed, so a capability whose flow leaves the
      // allowlist is refused before a browser is ever pointed at anything. The chokepoint is the
      // second line and `@crr/core`'s policy suite is where each of its denial reasons is proved.
      return observed(out, [
        checkResult(
          "zero actions reached the surface",
          surface.dispatched.length === 0,
          `${surface.dispatched.length} actions were dispatched`,
        ),
      ]);
    },
  },
  {
    id: "23",
    title: "an interstitial that will not clear exhausts its budget and stops",
    mirrors: "interstitial (sticky)",
    row: "31",
    expect: { kind: "failure", failure: "recovery-exhausted" },
    async run(engine) {
      // Every remedy re-verifies into the same condition. A budget is what makes "every program
      // terminates" checkable rather than hoped.
      const { out } = await runFlow(engine, {
        noticeMaxAttempts: 2,
        transitions: [
          { from: "search-member", on: TYPE_BRANCH, to: "search-notice" },
          {
            from: "search-notice",
            on: { kind: "click", target: IDS.noticeAck },
            to: "search-notice",
          },
          { from: "search-notice", on: TYPE_BRANCH, to: "search-notice" },
          ...HAPPY_PATH,
        ],
      });
      return observed(out);
    },
  },
  {
    id: "24",
    title: "an argument that fails its declared constraint never touches the surface",
    mirrors: "(pre-flight, not a fixture fault)",
    row: "1",
    expect: { kind: "failure", failure: "argument-invalid" },
    async run(engine) {
      const { out, surface } = await runFlow(engine, { args: { memberId: "abc" } });
      return observed(out, [
        checkResult(
          "zero actions were dispatched",
          surface.dispatched.length === 0,
          `${surface.dispatched.length} actions reached the surface`,
        ),
        checkResult(
          "side effects are reported as none-guaranteed",
          out.result.status === "failed" && out.result.failure.sideEffects === "none-guaranteed",
        ),
      ]);
    },
  },
  {
    id: "25",
    title: "KNOWN GAP: an interstitial that appears AFTER the step acted cannot be resumed today",
    mirrors: "interstitial (post-action placement)",
    row: "9, unreachable",
    expect: { kind: "failure", failure: "target-not-found" },
    async run(engine) {
      // This scenario asserts a WART, deliberately, and the title says so. The recovery runs, the
      // modal is dismissed, and the run then fails - because `resume: "retry-step"` re-resolves a
      // target the search has already navigated away from and SPEC section 3 offers no
      // "re-verify without re-dispatching" mode. Pinning it means the day that mode arrives, this
      // test fails and somebody has to come back here; leaving it out means the gap lives only in a
      // comment nobody re-reads.
      const { out } = await runFlow(engine, {
        transitions: [
          { from: "search-ready", on: SUBMIT, to: "results-notice", once: true },
          { from: "results-notice", on: { kind: "click", target: IDS.noticeAck }, to: "results" },
          ...HAPPY_PATH,
        ],
      });
      return observed(out, [
        checkResult(
          "the recovery itself did run and did clear the modal",
          out.result.run.recoveriesApplied.some(
            (r) => r.name === "DISMISS_SYSTEM_NOTICE" && r.result === "cleared",
          ),
          "the gap is in the RESUMPTION, not in the detection",
        ),
      ]);
    },
  },
];

export const SCENARIOS_BY_ID: ReadonlyMap<string, Scenario> = new Map(
  ALL_SCENARIOS.map((s) => [s.id, s]),
);
