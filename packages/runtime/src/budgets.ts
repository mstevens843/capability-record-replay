// The three nested ledgers of SPEC section 3.4, as monotonically decreasing integers.
//
// They are COUNTERS, not clocks, and that is the whole reason exhaustion is a classification rather
// than a timeout: `recovery-exhausted` carries which recovery, how many attempts it got, and the
// skeleton digest at each one, so "why did dismissing this dialog not work" is answerable from the
// journal with no reproduction.
//
// The rule that makes the termination argument hold, spelled out because it is the one a
// well-meaning change breaks: **no budget resets on progress within a step.** `maxRemediationCycles`
// resets only when the step's checkpoint is reached and `pc` advances; the run ledgers never reset
// at all. A budget that refills whenever "something changed" is how you build an infinite loop that
// reports progress the whole way.
//
// Wall clock is in here too, as a ledger with the same shape, because SPEC section 2.6 reports it
// beside the others on every arm of the result. It is read from the monotonic `Clock`, never from
// the wall clock: a run deadline that a machine's NTP sync can extend is not a deadline.

import type { AttemptCounters, BudgetCounter, RunBudgets } from "@crr/core";
import type { Clock } from "./clock.js";

export interface LedgerView {
  readonly actions: BudgetCounter;
  readonly observations: BudgetCounter;
  readonly remediations: BudgetCounter;
  readonly programAttempts: BudgetCounter;
  readonly wallClockMs: BudgetCounter;
}

/** One charge against one ledger, for the `budget.charged` journal event. */
export interface BudgetCharge {
  readonly ledger: string;
  readonly used: number;
  readonly limit: number;
}

/**
 * The run ledger. One per invocation, and it SURVIVES a `restart-program`: a restart is a new
 * machine, not a new budget, or "restart on session expiry" would be an unbounded retry loop with
 * an audit trail.
 */
export class RunLedger {
  readonly #budgets: RunBudgets;
  readonly #clock: Clock;
  #actions = 0;
  #observations = 0;
  #remediations = 0;
  #programAttempts = 0;

  constructor(budgets: RunBudgets, clock: Clock) {
    this.#budgets = budgets;
    this.#clock = clock;
  }

  chargeAction(): BudgetCharge {
    this.#actions += 1;
    return { ledger: "actions", used: this.#actions, limit: this.#budgets.maxActions };
  }

  chargeObservation(): BudgetCharge {
    this.#observations += 1;
    return {
      ledger: "observations",
      used: this.#observations,
      limit: this.#budgets.maxObservations,
    };
  }

  chargeRemediation(): BudgetCharge {
    this.#remediations += 1;
    return {
      ledger: "remediations",
      used: this.#remediations,
      limit: this.#budgets.maxTotalRemediations,
    };
  }

  chargeProgramAttempt(): BudgetCharge {
    this.#programAttempts += 1;
    return {
      ledger: "programAttempts",
      used: this.#programAttempts,
      limit: this.#budgets.maxProgramAttempts,
    };
  }

  get elapsedMs(): number {
    return this.#clock.elapsedMs();
  }

  get deadlineMs(): number {
    return this.#budgets.deadlineMs;
  }

  /** True once the run has spent a ledger the classifier checks at band G. Reported rather than
   *  thrown: exhaustion is `budget-exhausted`, a verdict with a trace, not an exception. */
  exhausted(): boolean {
    return (
      this.#actions >= this.#budgets.maxActions ||
      this.#observations >= this.#budgets.maxObservations ||
      this.elapsedMs >= this.#budgets.deadlineMs
    );
  }

  /** The remediation ledger is checked separately: it gates GRANTING a recovery, and a run that has
   *  spent it should stop remediating without also refusing to finish the step it is on. */
  remediationsExhausted(): boolean {
    return this.#remediations >= this.#budgets.maxTotalRemediations;
  }

  view(): LedgerView {
    return {
      actions: { used: this.#actions, limit: this.#budgets.maxActions },
      observations: { used: this.#observations, limit: this.#budgets.maxObservations },
      remediations: { used: this.#remediations, limit: this.#budgets.maxTotalRemediations },
      programAttempts: { used: this.#programAttempts, limit: this.#budgets.maxProgramAttempts },
      wallClockMs: { used: this.elapsedMs, limit: this.#budgets.deadlineMs },
    };
  }

  /** The shape `classify` reads. Everything it needs is an integer; nothing it needs is a clock. */
  counters(step: StepLedger): AttemptCounters {
    const view = this.view();
    return {
      recoveryAttempts: step.recoveryAttempts,
      remediationCycles: step.remediationCycles,
      run: {
        actions: view.actions,
        observations: view.observations,
        remediations: view.remediations,
        programAttempts: view.programAttempts,
      },
      deadlineMs: this.#budgets.deadlineMs,
    };
  }
}

/**
 * The per-step ledger: one per (step, attempt at that step).
 *
 * Two counters and not one, because two recoveries can ping-pong - dismiss a dialog, which triggers
 * a reload, which triggers the dialog - with neither one exceeding its own `maxAttempts`. The
 * per-step total is what stops that, and it is why `maxRemediationCycles` is a separate field on the
 * artifact rather than a sum somebody computes.
 */
export class StepLedger {
  #recoveryAttempts: Record<string, number> = {};
  #remediationCycles = 0;

  get recoveryAttempts(): Readonly<Record<string, number>> {
    return this.#recoveryAttempts;
  }

  get remediationCycles(): number {
    return this.#remediationCycles;
  }

  /** Spend one attempt of one recovery AND one of the step's total. Returns the attempt number,
   *  1-based, which is what the `recover` verdict and the journal both report. */
  chargeRemedy(recoveryName: string): number {
    const attempt = (this.#recoveryAttempts[recoveryName] ?? 0) + 1;
    this.#recoveryAttempts[recoveryName] = attempt;
    this.#remediationCycles += 1;
    return attempt;
  }

  attemptsOf(recoveryName: string): number {
    return this.#recoveryAttempts[recoveryName] ?? 0;
  }
}
