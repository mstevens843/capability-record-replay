// Grading helpers, and the one definition the whole suite turns on.
//
// `isFalseSuccess` is deliberately not folded into `passed`. A misclassified failure and a false
// success are not the same severity: the first is a bug in a taxonomy, and the second is a member
// being told their balance is nothing, or that their account is not on file, on the strength of a
// screen the engine never really read. SPEC section 4.8 makes it the specific assertion the whole
// suite exists to make, so it gets its own field, its own count and its own test.

import type { ReplayResultDocument } from "@crr/core";
import type { CheckResult, Expectation, ScenarioObservation } from "./types.js";

/**
 * One graded assertion inside a scenario.
 *
 * NAMED `checkResult`, NOT `check`, and the reason is a contract test rather than taste. `check` is
 * the name of `@crr/core`'s POLICY CHOKEPOINT - the single gate every `Surface.act` in the workspace
 * must pass, per SPEC section 1.2 and section 8.1 - and the scanner that enforces it
 * (`packages/core/test/chokepoint-scan.ts`) is lexical: `CHECK_CALL = /(?<![\w$?.])check\s*\(/`
 * treats ANY bare `check(` within twelve lines of a dispatch as the gate. A second exported `check`
 * in a package that already imports `@crr/core` is therefore an alibi waiting to be handed to the
 * one test the architecture leans on hardest. Two names, two meanings, and nothing that imports both
 * - the same shape as the `ReplayOptions` collision recorded in RUNTIME-STATUS section 3.1.
 */
export const checkResult = (name: string, passed: boolean, detail?: string): CheckResult =>
  passed ? { name, passed } : { name, passed, ...(detail === undefined ? {} : { detail }) };

const show = (value: unknown): string => JSON.stringify(value);

/** What arm the run came back on, as one word, for a failure report. */
export function armOf(result: ReplayResultDocument): string {
  switch (result.status) {
    case "ok":
      return "ok";
    case "outcome":
      return `outcome:${result.outcome}`;
    case "suspended":
      return `suspended:${result.intervention.reason}`;
    case "failed":
      return `failed:${result.failure.class}`;
  }
}

/**
 * The engine claimed to have done the job, and it had not.
 *
 * Two shapes, and they are the same mistake pointed at two different readers:
 *
 *   · `ok` where the correct answer was a hard failure OR a business outcome. The caller is handed
 *     outputs - a balance, a name - read off a screen the engine never established it was entitled
 *     to read. Returning `ok` for a restricted record is the worst of these, because the data is
 *     real and the answer is still wrong.
 *   · a business `outcome` where the correct answer was a hard failure. The engine invented a typed
 *     answer for a run that broke, and a typed answer is exactly what a calling agent will act on
 *     without hesitating.
 *
 * Note what is NOT here. An engine that returns the wrong failure CLASS has misclassified, and one
 * that returns a failure where an outcome was correct has been over-cautious. Both are graded and
 * both are bugs; neither reaches a member as a confident wrong answer, and conflating them with
 * this would make the headline number mean less than it does.
 */
export function isFalseSuccess(expect: Expectation, result: ReplayResultDocument): boolean {
  if (expect.kind === "ok" || expect.kind === "recovered") return false;
  if (result.status === "ok") return true;
  return expect.kind === "failure" && result.status === "outcome";
}

export function gradeScenario(
  expect: Expectation,
  observed: ScenarioObservation,
): readonly CheckResult[] {
  const { result } = observed;
  const checks: CheckResult[] = [...(observed.extra ?? [])];

  switch (expect.kind) {
    case "ok":
    case "recovered": {
      checks.push(
        checkResult("the run returns ok", result.status === "ok", `arm was ${armOf(result)}`),
      );
      if (result.status === "ok") {
        checks.push(
          checkResult(
            "every declared output is present and typed",
            show(result.outputs) === show(expect.outputs),
            `expected ${show(expect.outputs)}, observed ${show(result.outputs)}`,
          ),
        );
      }
      if (expect.kind === "recovered") {
        // An engine that "passes" by never meeting the condition it was supposed to recover from
        // has not passed. The remedy has to have actually run.
        checks.push(
          checkResult(
            `the ${expect.recovery} recovery actually ran`,
            observed.recoveries.includes(expect.recovery),
            `recoveries applied: ${show(observed.recoveries)}`,
          ),
        );
      }
      break;
    }
    case "outcome": {
      checks.push(
        checkResult(
          `the run returns the ${expect.code} outcome, not an error`,
          result.status === "outcome" && result.outcome === expect.code,
          `arm was ${armOf(result)}`,
        ),
      );
      if (result.status === "outcome") {
        checks.push(
          checkResult(
            "the outcome is terminal and carries caller guidance",
            result.terminal && result.guidance.length > 0,
          ),
        );
      }
      break;
    }
    case "failure": {
      checks.push(
        checkResult(
          `the run fails with ${expect.failure}`,
          result.status === "failed" && result.failure.class === expect.failure,
          `arm was ${armOf(result)}`,
        ),
      );
      // Stated separately from the class, and on EVERY hard-failure scenario, because this is the
      // assertion the suite is for. A wrong class is a bug; this is a wrong answer to a member.
      checks.push(
        checkResult(
          "NO FALSE SUCCESS: the run does not report ok or a business outcome",
          !isFalseSuccess(expect, result),
          `arm was ${armOf(result)} for a condition whose correct answer is ${expect.failure}`,
        ),
      );
      if (result.status === "failed") {
        checks.push(
          checkResult(
            "the failure is debuggable: an operator action, and what was expected where a step ran",
            result.failure.operatorAction.length > 0 &&
              (result.failure.atStep === null
                ? // A pre-flight failure has no step BECAUSE it performed no action, and saying
                  // "we definitely did not touch anything" out loud is the point of that arm.
                  result.failure.sideEffects === "none-guaranteed"
                : result.failure.expected.rendered.length > 0),
            `atStep=${String(result.failure.atStep)} sideEffects=${result.failure.sideEffects}`,
          ),
        );
      }
      break;
    }
  }
  return checks;
}
