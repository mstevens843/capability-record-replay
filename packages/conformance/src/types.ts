// The vocabulary: what an engine is, what a scenario expects, and what a verdict looks like.
//
// Two decisions worth stating. A scenario RETURNS checks instead of throwing, so one failed
// expectation does not hide the four behind it - a grade whose first failure masks the rest tells
// you where to start rather than what is wrong. And an engine is a NAME plus at most two pure
// functions, never a class: the reference engine passes nothing at all and gets `@crr/core`'s own,
// which is what makes "the mutants run the real engine" a fact about the type rather than a claim
// in a comment.

import type { ExtractedValue, FailureClass, JournalEvent, ReplayResultDocument } from "@crr/core";
import type { DecisionFunctions } from "@crr/runtime";

export interface ReplayEngine {
  readonly id: string;
  /** The real-world bug this models, in one line. The mutant's own file header has the argument. */
  readonly description: string;
  /** Absent for the reference engine, which uses `@crr/core`'s `classify` and `resolveTarget`. */
  readonly decisions?: DecisionFunctions;
}

/**
 * What the run must return, in the vocabulary a CALLER speaks.
 *
 * Written as the three-way split the assignment's glossary calls the most common design mistake to
 * get wrong, rather than as a raw arm: `outcome` names an expected business result, `recovered`
 * names a condition the engine was supposed to absorb and then finish anyway, and `failure` names
 * the class the caller is told about. `ok` and `recovered` differ only in whether a remedy had to
 * run, and the suite asserts that difference separately, because an engine that "passes" by never
 * hitting the condition it was supposed to recover from has not passed.
 */
export type Expectation =
  | { readonly kind: "ok"; readonly outputs: Readonly<Record<string, ExtractedValue>> }
  | {
      readonly kind: "recovered";
      readonly outputs: Readonly<Record<string, ExtractedValue>>;
      readonly recovery: string;
    }
  | { readonly kind: "outcome"; readonly code: string }
  | { readonly kind: "failure"; readonly failure: FailureClass };

/** One graded assertion. `detail` carries what was actually observed, for a failing report. */
export interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface Scenario {
  /** Stable two-digit id. Referenced by `only` filters and by every mutant's `mustKill` list. */
  readonly id: string;
  readonly title: string;
  /**
   * The `fixtures/corebank-web` fault this mirrors, or the SPEC section 4.5 wrong-target sub-case
   * it stands for. Named so the coverage claim - "every fault the fixture can inject" - is a
   * mechanical comparison against that fixture's own registry rather than a promise.
   */
  readonly mirrors: string;
  /** The SPEC section 4.2 row, for the report. */
  readonly row: string;
  readonly expect: Expectation;
  run(engine: ReplayEngine): Promise<ScenarioObservation>;
}

/** What one scenario saw. Kept separate from the grade so the grader is a pure function of it. */
export interface ScenarioObservation {
  readonly result: ReplayResultDocument;
  /** Recovery names the run actually applied, so "it recovered" is checked rather than assumed. */
  readonly recoveries: readonly string[];
  readonly extra?: readonly CheckResult[];
  /**
   * The run's journal, for a reader that wants more than the arm.
   *
   * OPTIONAL, and the grader never touches it: a scenario grade is a statement about what the
   * CALLER was told, and a grader that could reach into the journal would eventually start passing
   * a run on the strength of an internal event the caller never sees. What reads it is the
   * stability report, whose whole subject is the machinery underneath the arm - which descriptors
   * carried a resolution, how many polls a settle took - and which is a different question with a
   * different audience.
   */
  readonly journal?: readonly JournalEvent[];
}

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly passed: boolean;
  readonly checks: readonly CheckResult[];
  /**
   * TRUE when the engine reported `ok` or a business `outcome` for a scenario whose correct answer
   * is a hard failure.
   *
   * This is the single assertion the whole suite exists to make, and it is tracked as its own field
   * rather than folded into `passed` because the two are not the same severity. A misclassified
   * failure is a bug; a false success is a member being told their balance is nothing, or that
   * their account does not exist, on the strength of a screen the engine never really read.
   */
  readonly falseSuccess: boolean;
  /** Set when the scenario threw. A thrown scenario is a failure, never a silent skip. */
  readonly error?: string;
  /**
   * What the run actually saw, kept alongside the grade. Absent when the scenario threw.
   *
   * `formatReport` ignores it; the stability report is what reads it. Keeping it means a
   * multi-run measurement re-uses the SAME runs the suite graded instead of driving a second
   * corpus of its own, which is the difference between "the engine is stable" and "a corpus I
   * wrote for the stability report is stable".
   */
  readonly observation?: ScenarioObservation;
}

export interface ConformanceReport {
  readonly engine: string;
  readonly passed: boolean;
  readonly scenarios: readonly ScenarioResult[];
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly falseSuccesses: number;
  };
}
