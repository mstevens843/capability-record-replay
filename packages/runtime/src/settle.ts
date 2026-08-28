// SETTLE - step 9 of the cycle, and the only place in this package that waits.
//
// Three rules from SPEC section 3.2/3.3, and each one is a decision somebody will otherwise undo:
//
//   1. THERE IS NO SLEEP. A fixed delay encodes the recording machine's load into the artifact
//      forever and is the largest single source of both flake and wasted wall clock in recorded
//      automation. Waiting is a property of a checkpoint: poll until the screen stops moving or the
//      budget is spent.
//   2. QUIESCENCE PROPOSES; THE CHECKPOINT DISPOSES. What comes back from here is "a good moment to
//      take an observation", never "the screen is ready". Readiness is `expect.predicate` plus
//      continuity, checked by the classifier. The terminal spike measured why: 55% of a repaint
//      followed by 120 ms of silence - twice the quiet window - produced a torn read that claimed
//      to be settled and had three nodes where the screen has eight.
//   3. A NATIVE DIALOG IS NOT A SETTLE QUESTION, AND AN IN-PAGE MODAL IS. The driver knows about a
//      native dialog synchronously and reports it on its own channel, so polling for quiescence
//      behind an open `confirm()` is waiting for a renderer that is blocked precisely because we
//      have not answered yet: one poll, then hand it to band B2. An IN-PAGE modal blocks nothing.
//      It is nodes in a document that is still rendering, and it goes through the ordinary
//      quiescence loop like every other screen.
//
//      That distinction used to not exist - any `inputIntercepted` ended the loop on the first poll
//      - and it was harmless only while every interception was a hard failure, because a torn read
//      and a settled one produce the same verdict when the verdict is "stop". It stopped being
//      harmless when `Checkpoint.dialog` (SPEC section 4.4) made a declared dialog a POSTCONDITION,
//      because a postcondition is checked against a settled screen. MEASURED, against the real
//      `fixtures/corebank-web` through `@crr/surface-browser`: 18 ms after the click that raises
//      the confirmation panel, one `perceive` returned the accessibility tree of the NEW document
//      (137 nodes, the panel among them) stitched to the frame tree of the OLD one - `Page
//      .getFrameTree` is read before `Accessibility.getFullAXTree` and the navigation committed in
//      between - so `route` said `/subaccount/new` on the `/subaccount/confirm` screen and the
//      checkpoint failed a step that had in fact succeeded. That is the browser's instance of the
//      torn read the terminal spike measured on a character grid, and it is caught by the same
//      mechanism: `stableSamples` consecutive identical skeletons.
//
// Every poll charges an observation against the run ledger. That is what makes "a spinner forever"
// terminate as `budget-exhausted` rather than as a stalled process even if a `maxWaitMs` were ever
// mis-set.

import type {
  Observation,
  PerceiveFault,
  Predicate,
  ProgramFacts,
  ResolvedBindings,
  SettlePolicy,
  Surface,
} from "@crr/core";
import { evaluatePredicate } from "@crr/core";
import type { Clock } from "./clock.js";

export interface SettleInput {
  readonly surface: Surface;
  readonly policy: SettlePolicy;
  readonly clock: Clock;
  /** Charged once per poll. Returns true when the ledger is spent, which ends the loop. */
  readonly chargeObservation: () => boolean;
  readonly program: ProgramFacts;
  readonly bindings: ResolvedBindings;
  /** Ceiling on ONE `perceive`, distinct from the settle budget: an open native dialog makes a
   *  single call hang forever, and a hang has no failure class. */
  readonly perceiveDeadlineMs: number;
}

export interface SettleOutcome {
  /** The last observation taken, or `null` when every poll faulted. */
  readonly observation: Observation | null;
  /** The last fault, when the final poll faulted. The classifier turns it into a class. */
  readonly fault: PerceiveFault | null;
  /** The poll window: skeleton digests, oldest first, current last. This is what band B0
   *  corroborates the driver's own `settled` flag against, and it is NOT the run's history. */
  readonly window: readonly string[];
  readonly polls: number;
  readonly elapsedMs: number;
  /** Our judgement, not the driver's: enough identical samples AND the driver agrees AND nothing
   *  the artifact declared as a busy indicator is showing. */
  readonly settled: boolean;
  /** True when the loop stopped because the run ledger ran out rather than the settle budget. */
  readonly ledgerExhausted: boolean;
}

export async function settle(input: SettleInput): Promise<SettleOutcome> {
  const { policy, clock } = input;
  const startedAt = clock.elapsedMs();
  const window: string[] = [];
  let observation: Observation | null = null;
  let fault: PerceiveFault | null = null;
  let polls = 0;

  for (;;) {
    if (input.chargeObservation()) {
      return {
        observation,
        fault,
        window,
        polls,
        elapsedMs: clock.elapsedMs() - startedAt,
        settled: false,
        ledgerExhausted: true,
      };
    }

    const result = await input.surface.perceive({ deadlineMs: input.perceiveDeadlineMs });
    polls += 1;

    if (!result.ok) {
      fault = result.fault;
      // `perceive-timeout` ends the loop and every other fault does not, and the asymmetry is the
      // point rather than a special case:
      //
      //   · A TIMEOUT has already spent a deadline of its own. The condition that produces one is a
      //     renderer blocked by an unanswered native dialog, which does not clear by waiting - so
      //     polling again spends the settle budget twice over to reach the same answer, and the
      //     answer (`undeclared-dialog`, or `surface-error`) is one the classifier can already give.
      //   · EVERY OTHER FAULT is a statement about a screen that is mid-change. Measured against the
      //     fixture: clicking a control that navigates the content frame away destroys the nested
      //     `subacct` iframe, and for one poll interval that frame is in the page's frame list and
      //     absent from CDP's - which the driver correctly refuses to describe as
      //     `unperceivable-container`. That is precisely "not yet", and "not yet" is what a settle
      //     budget is for. Retrying inside the budget is the same discipline as retrying a
      //     digest that has not stopped moving.
      //
      // If the budget runs out with a fault outstanding, the fault is what is reported.
      const spentOnFault = clock.elapsedMs() - startedAt;
      if (result.fault.kind === "perceive-timeout" || spentOnFault >= policy.maxWaitMs) {
        return {
          observation,
          fault: result.fault,
          window,
          polls,
          elapsedMs: spentOnFault,
          settled: false,
          ledgerExhausted: false,
        };
      }
      await clock.sleep(Math.min(policy.pollIntervalMs, policy.maxWaitMs - spentOnFault));
      continue;
    }

    observation = result.observation;
    fault = null;
    window.push(observation.skeletonDigest);

    // Rule 3, and only for the channel it is true of. A native dialog blocks the renderer: stop
    // here and let the classifier's interception band decide, with the dialog's MESSAGE in hand,
    // which is the fact that decides accept versus dismiss. An in-page modal falls through to the
    // quiescence test below - see rule 3 in this file's header for the torn read that costs.
    if (observation.nativeDialog !== null) {
      return {
        observation,
        fault: null,
        window,
        polls,
        elapsedMs: clock.elapsedMs() - startedAt,
        settled: observation.stability.settled,
        ledgerExhausted: false,
      };
    }

    if (quiesced(observation, window, policy, input)) {
      return {
        observation,
        fault: null,
        window,
        polls,
        elapsedMs: clock.elapsedMs() - startedAt,
        settled: true,
        ledgerExhausted: false,
      };
    }

    const spent = clock.elapsedMs() - startedAt;
    if (spent >= policy.maxWaitMs) {
      // The budget is spent and the screen is still moving. NOT a failure here: the classifier
      // re-runs its environment band with `settled: false` first, because an error page is often
      // exactly WHY a surface will never settle, and "the app is down" is a better answer than
      // "it did not settle".
      return {
        observation,
        fault: null,
        window,
        polls,
        elapsedMs: spent,
        settled: false,
        ledgerExhausted: false,
      };
    }

    await clock.sleep(Math.min(policy.pollIntervalMs, policy.maxWaitMs - spent));
  }
}

/**
 * Enough identical consecutive skeletons, the driver's own agreement, and no declared busy
 * indicator showing.
 *
 * All three, not any of them. The digest alone is not enough because a legacy app that swaps a
 * frame's contents can be digest-stable for one poll interval mid-swap; the driver's flag alone is
 * not enough because that is precisely the flag the torn read lied about.
 */
function quiesced(
  observation: Observation,
  window: readonly string[],
  policy: SettlePolicy,
  input: SettleInput,
): boolean {
  if (!observation.stability.settled) return false;
  if (window.length < policy.stableSamples) return false;
  const recent = window.slice(-policy.stableSamples);
  if (!recent.every((digest) => digest === recent[0])) return false;
  const busy: Predicate | undefined = policy.busyWhen;
  if (busy !== undefined) {
    const showing = evaluatePredicate(busy, {
      observation,
      program: input.program,
      bindings: input.bindings,
    });
    if (showing) return false;
  }
  return true;
}
