// THE GREEN-SCREEN SCENARIOS.
//
// In `test/` because it drives a real `TerminalSurface` through `./harness.js`, and `src/` may not
// import a driver - see that file's header. The grading machinery it uses (`Scenario`,
// `gradeScenario`, `runConformance`, the nine mutants) is all `src/`, unchanged and shared. Every fault `fixtures/corebank-tui` can inject, crossed with the
// replay engine, graded by the SAME `gradeScenario` the browser corpus is graded by.
//
// The reuse is the claim. `Scenario`, `Expectation`, `gradeScenario` and `isFalseSuccess` were
// written for a frameset web app over `MockSurface`; nothing in them mentions a browser, and nothing
// here had to widen them. What changes between the two files is the harness one line down - a real
// `TerminalSurface` over a real 80x24 fixture instead of frozen observations - and the fault names.
// If the taxonomy were browser-shaped, this file is where that would have shown up.
//
// TWO STRUCTURAL DIFFERENCES FROM `index.ts`, both real rather than cosmetic:
//
//   · These runs drive a LIVE surface. The browser corpus scripts a state machine and can therefore
//     manufacture conditions no server can be asked for (two descriptors that disagree; a control
//     that dispatches and does nothing). Here the fixture has to actually produce the condition, so
//     the wrong-target sub-cases of SPEC section 4.5 are absent - they are properties of a locator
//     and belong to the corpus that can script one.
//   · Every fault here is caught by TARGET RESOLUTION or by the CHECKPOINT, and not one by the
//     settle loop. That is not a gap in the scenarios; it is the measurement. On a surface whose
//     only readiness signal is silence, an application that has not answered yet and an application
//     that has finished answering look identical, and `T05`/`T06` are what that costs.

import type { JournalEvent } from "@crr/core";
import { checkResult } from "../../src/support.js";
import type { ReplayEngine, Scenario, ScenarioObservation } from "../../src/types.js";
import { MEMBER_NOT_ON_FILE, MEMBER_RESTRICTED, runTerminalFlow } from "./harness.js";

/**
 * A journal event with its own fields visible.
 *
 * `JournalEvent` is a discriminated union whose discriminant widens to `string`, because the helper
 * that builds each member takes `type: string` instead of a generic literal - so `e.type ===
 * "settled"` narrows nothing. `docs/design/RUNTIME-STATUS.md` section 7.3 reports the one-line fix in
 * `@crr/core`; until it lands, this cast is where the loss of narrowing is admitted, once, rather
 * than at each of the three places below that read a field off an event.
 */
type Narrowed = { readonly type: string } & Readonly<Record<string, unknown>>;
const eventsOf = (events: readonly JournalEvent[], type: string): readonly Narrowed[] =>
  (events as unknown as readonly Narrowed[]).filter((e) => e.type === type);

/**
 * What the green screen returns when nothing is wrong.
 *
 * `balance` comes back as the string the grid printed rather than as a typed `money`, because
 * `readTable` rows are `Record<string, string>` by construction and the per-column `ValueType` a
 * contract declares is not yet coerced (`docs/design/RUNTIME-STATUS.md` section 7.6). The scalar
 * `shareBalance` read on the next step IS typed, which is why the flow reads the share balance
 * twice-over rather than trusting the table for the number a caller acts on.
 */
const HAPPY_OUTPUTS = {
  accounts: [
    { suffix: "S0001", description: "REGULAR SAVINGS", balance: "1,204.55" },
    { suffix: "S0010", description: "VACATION CLUB", balance: "310.00" },
    { suffix: "D0001", description: "FREE CHECKING", balance: "2,880.13" },
  ],
  shareBalance: { amount: "1204.55", currency: "USD" },
} as unknown as Extract<Scenario["expect"], { kind: "ok" }>["outputs"];

type Run = Awaited<ReturnType<typeof runTerminalFlow>>;

const observed = (
  run: Run,
  extra?: readonly ReturnType<typeof checkResult>[],
): ScenarioObservation => ({
  result: run.out.result,
  recoveries: run.out.result.run.recoveriesApplied.map((r) => r.name),
  journal: run.out.journal.events,
  ...(extra === undefined ? {} : { extra }),
});

/** Run, observe, and always close: a green screen left open holds an emulator and a fixture. */
async function drive(
  engine: ReplayEngine,
  options: Parameters<typeof runTerminalFlow>[1],
  extra?: (run: Run) => readonly ReturnType<typeof checkResult>[],
): Promise<ScenarioObservation> {
  const run = await runTerminalFlow(engine, options);
  try {
    return observed(run, extra?.(run));
  } finally {
    await run.close();
  }
}

/**
 * The bytes a VT terminal sends for the two keys this fixture's two tenants bind Exit/Back to.
 *
 * Written as `\\u001b` escapes rather than as literal control bytes: a raw 0x1b in a source file
 * is invisible in a diff, and this is precisely the value a reader has to be able to check.
 * F1-F4 are SS3 sequences (`ESC O P`..`ESC O S`) and everything above them is `ESC [ n ~` -
 * see `@crr/surface-terminal`'s `KEY_BYTES` for why that is a table and not arithmetic.
 */
const ESC = "\u001b";
export const F3_BYTES = `${ESC}OR`;
export const F12_BYTES = `${ESC}[24~`;

export const TERMINAL_SCENARIOS: readonly Scenario[] = [
  // -------------------------------------------------------------------------------------------
  // The baseline, and the multi-tenant claim
  // -------------------------------------------------------------------------------------------
  {
    id: "T01",
    title: "the whole green-screen flow succeeds and returns typed outputs",
    mirrors: "(no fault)",
    row: "-",
    expect: { kind: "ok", outputs: HAPPY_OUTPUTS },
    async run(engine) {
      return drive(engine, {}, (run) => [
        // The acceptance assertion of SPEC section 11 unit 21, carried on the happy path so that it
        // is graded on every engine rather than only in one test.
        checkResult(
          "the activate step lowered to F3 on the grid",
          run.keystrokes.includes(F3_BYTES),
          `keystrokes were ${JSON.stringify(run.keystrokes)}`,
        ),
      ]);
    },
  },
  {
    id: "T02",
    title: "the SAME artifact replays green at the second credit union, over a nine-line overlay",
    mirrors: "(no fault, second tenant)",
    row: "-",
    expect: { kind: "ok", outputs: HAPPY_OUTPUTS },
    async run(engine) {
      return drive(engine, { tenant: "summit" }, (run) => [
        checkResult(
          "and the SAME activate step lowered to F12 there, with nothing in the overlay about keys",
          run.keystrokes.includes(F12_BYTES) && !run.keystrokes.includes(F3_BYTES),
          `keystrokes were ${JSON.stringify(run.keystrokes)}`,
        ),
      ]);
    },
  },

  // -------------------------------------------------------------------------------------------
  // Business outcomes. Facts about the ARGUMENT, reachable with nothing armed - which is why the
  // fixture does not model them as faults.
  // -------------------------------------------------------------------------------------------
  {
    id: "T03",
    title: "a NO MEMBER ON FILE status band is MEMBER_NOT_FOUND, not an error",
    mirrors: "(no fault; account number 77777)",
    row: "6",
    expect: { kind: "outcome", code: "MEMBER_NOT_FOUND" },
    async run(engine) {
      return drive(engine, { memberNumber: MEMBER_NOT_ON_FILE });
    },
  },
  {
    id: "T04",
    title: "a SECURITY VIOLATION status band is MEMBER_RESTRICTED, and outranks not-found",
    mirrors: "(no fault; account number 99999)",
    row: "7",
    expect: { kind: "outcome", code: "MEMBER_RESTRICTED" },
    async run(engine) {
      return drive(engine, { memberNumber: MEMBER_RESTRICTED });
    },
  },

  // -------------------------------------------------------------------------------------------
  // The delivery family: the bytes are wrong and the application's state is not. A browser driver
  // has no analogue, because a browser has a load event.
  // -------------------------------------------------------------------------------------------
  {
    id: "T05",
    title: "a torn repaint on the entry screen refuses BEFORE acting, with no side effects",
    mirrors: "torn-repaint",
    row: "SPEC section 4.4 band B0",
    expect: { kind: "failure", failure: "target-not-found" },
    async run(engine) {
      return drive(engine, { fault: "torn-repaint" }, (run) => [
        // The half-painted frame has no screen-id band, so the driver reports no route, so the
        // POLICY CHOKEPOINT would have refused this action even if the target had resolved. Two
        // independent gates, and the run never reached either: it could not find the field.
        checkResult(
          "it dispatched nothing at all",
          run.keystrokes === "",
          `keystrokes were ${JSON.stringify(run.keystrokes)}`,
        ),
      ]);
    },
  },
  {
    id: "T06",
    title:
      "a torn repaint AFTER the search fails the checkpoint on a surface that claims to be settled",
    mirrors: "torn-repaint (armed on the account list)",
    row: "SPEC section 3.3 - quiescence proposes, the checkpoint disposes",
    expect: { kind: "failure", failure: "checkpoint-failed" },
    async run(engine) {
      return drive(engine, { fault: "torn-repaint", faultAt: "detail" }, (run) => [
        checkResult(
          "the driver reported the half-painted screen as SETTLED, which is the point",
          eventsOf(run.out.journal.events, "settled").some((e) => e.settled === true),
          "no settle event reported settled: true",
        ),
      ]);
    },
  },
  {
    id: "T07",
    title: "a repaint that arrives inside the quiet window is absorbed and the run is green",
    mirrors: "slow-repaint (40ms delay, 120ms window)",
    row: "14",
    expect: { kind: "ok", outputs: HAPPY_OUTPUTS },
    async run(engine) {
      // The two numbers are the scenario. `quietMs` is the driver's tuning knob and `delayMs` is the
      // application's latency; inside the window the settle loop waits and the checkpoint passes.
      return drive(engine, {
        fault: "slow-repaint",
        faultAt: "detail",
        delayMs: 40,
        quietMs: 120,
      });
    },
  },
  {
    id: "T08",
    title: "a repaint that arrives outside it is no-observable-effect, never a stale read",
    mirrors: "slow-repaint (300ms delay, 120ms window)",
    row: "15",
    // NOT `did-not-settle`, and the difference is worth stating. The surface DOES settle - it is
    // perfectly quiet - it just settles on the screen that was already there. `did-not-settle` is
    // reachable on a browser, whose driver knows a request is outstanding; on a character grid the
    // only honest report is that the action produced no observable effect.
    expect: { kind: "failure", failure: "no-observable-effect" },
    async run(engine) {
      return drive(engine, {
        fault: "slow-repaint",
        faultAt: "detail",
        delayMs: 300,
        quietMs: 120,
      });
    },
  },

  // -------------------------------------------------------------------------------------------
  // The transition family: the bytes are perfect and the application went somewhere else. This is
  // the family that looks exactly like the happy path until something reads the screen-id band.
  // -------------------------------------------------------------------------------------------
  {
    id: "T09",
    title: "a session that expired mid-flow is recovered by the BROKER, and the run finishes green",
    mirrors: "session-timeout",
    row: "11",
    expect: { kind: "recovered", outputs: HAPPY_OUTPUTS, recovery: "SESSION_EXPIRED" },
    async run(engine) {
      return drive(engine, { fault: "session-timeout" }, (run) => [
        checkResult(
          "the program never typed an operator id - the broker did",
          run.refreshes > 0,
          `broker refreshes: ${run.refreshes}`,
        ),
      ]);
    },
  },
  {
    id: "T10",
    title:
      "a broker that CANNOT re-authenticate gets session-expired-unrecoverable, not a retry loop",
    mirrors: "session-timeout (broker reports failed)",
    row: "13",
    expect: { kind: "failure", failure: "session-expired-unrecoverable" },
    async run(engine) {
      return drive(engine, { fault: "session-timeout", brokerCanRefresh: false });
    },
  },
  {
    id: "T11",
    title:
      "an abend screen is recovered by activating the control the vendor printed, then restarting",
    mirrors: "app-error",
    row: "16",
    expect: { kind: "recovered", outputs: HAPPY_OUTPUTS, recovery: "APP_ERROR_SCREEN" },
    async run(engine) {
      return drive(engine, { fault: "app-error" }, (run) => [
        // The remedy is an `activate`, so it lowered to F3 exactly like the step's own does - and
        // the same linker check 21 forbids writing the key into the remedy.
        checkResult(
          "the remedy pressed the exit key the legend named, not one the artifact chose",
          run.keystrokes.includes(F3_BYTES),
          `keystrokes were ${JSON.stringify(run.keystrokes)}`,
        ),
      ]);
    },
  },
  {
    id: "T12",
    title:
      "an ambient recovery with no remediation budget is recovery-exhausted, never a false success",
    mirrors: "app-error (maxRemediationCycles: 0)",
    row: "17",
    // The trap `maxRemediationCycles: 0` sets is a declared recovery that can never spend an
    // attempt. The browser corpus pins the same hazard; it is here too because a rule that is inert
    // reads exactly like a rule that did not match, and only the failure class tells them apart.
    expect: { kind: "failure", failure: "recovery-exhausted" },
    async run(engine) {
      return drive(engine, { fault: "app-error", maxRemediationCycles: 0 });
    },
  },

  // -------------------------------------------------------------------------------------------
  // The wrong-target sub-cases of SPEC section 4.5, reached from the other side.
  //
  // The browser corpus scripts a SCREEN that makes two descriptors disagree. A live green screen
  // cannot be asked for one, so these two damage the ARTIFACT instead - which is the same failure a
  // production deployment actually sees: a recording taken before a vendor release, replayed after
  // it. What is being graded is identical either way: whether the engine refuses to act on a target
  // it cannot independently corroborate.
  // -------------------------------------------------------------------------------------------
  {
    id: "T13",
    title: "descriptors that name DIFFERENT legend controls refuse to act (target-ambiguous)",
    mirrors: "SPEC 4.5 W1/W3 - the name says Search, the ordinal says Exit",
    row: "17",
    expect: { kind: "failure", failure: "target-ambiguous" },
    async run(engine) {
      return drive(engine, { targetVariant: "disagree" }, (run) => [
        // A fallback chain would have pressed one of them. On this surface the two candidates are
        // ENTER and F3 - submit the inquiry, or leave the application - which is as vivid an
        // illustration as the design has of why a ranking is not a resolution.
        checkResult(
          "and it pressed neither key",
          !run.keystrokes.includes("\r") && !run.keystrokes.includes(F3_BYTES),
          `keystrokes were ${JSON.stringify(run.keystrokes)}`,
        ),
      ]);
    },
  },
  {
    id: "T14",
    title: "two agreeing descriptors resting on ONE prompt are underdetermined, not confident",
    mirrors: "SPEC 4.5 C4 - the correlated-descriptor case, on a grid",
    row: "18",
    expect: { kind: "failure", failure: "target-underdetermined" },
    async run(engine) {
      // A green screen field has no accessible name of its own: the driver COMPUTES one from the
      // prompt to its left. So `role-name` and `label-anchored` are reading the same characters off
      // the same row, and one relabelling by the vendor kills both at once. Counting them as two
      // would be a quorum of one wearing a disguise - and on this surface that is not an unlucky
      // coincidence, it is the default.
      return drive(engine, { targetVariant: "correlated" }, (run) => [
        checkResult(
          "it typed nothing into a field it could not corroborate",
          run.keystrokes === "",
          `keystrokes were ${JSON.stringify(run.keystrokes)}`,
        ),
      ]);
    },
  },
];

export const TERMINAL_SCENARIOS_BY_ID: ReadonlyMap<string, Scenario> = new Map(
  TERMINAL_SCENARIOS.map((s) => [s.id, s]),
);
