// THE `stableSamples` MEASUREMENT, as tests (OPEN-QUESTIONS-RESOLVED Q6).
//
// This file does not pin the recommendation. It asserts the LAW the matrix demonstrates -
// `stableSamples = n` rejects a tear of up to n-1 consecutive polls and no more - plus the two
// facts that stop the law from being read as more than it is: every control case is correct at
// every value, and the tear that never clears is caught at every value by the checkpoint rather
// than by the settle loop.
//
// Pinning "the answer is 3" would be pinning a conclusion. Asserting the law and the evidence the
// conclusion is derived from means the conclusion moves when the evidence does, which is the only
// version of this that is worth having in a repository that will outlive the afternoon it was
// measured on.

import { SETTLE_POLICY_DEFAULTS, SettlePolicySchema } from "@crr/core";
import { describe, expect, it } from "vitest";
import { ALL_MUTANTS, REFERENCE_ENGINE } from "../src/engines/mutants.js";
import {
  SWEEP_CASES,
  SWEPT_VALUES,
  TEAR_EVIDENCE,
  TEAR_WIDTHS,
  formatSettleSweep,
  sweepDigest,
  sweepStableSamples,
} from "../src/settle-sweep.js";

const sweep = await sweepStableSamples(REFERENCE_ENGINE);

const cell = (caseId: string, stableSamples: number) => {
  const found = sweep.cells.find((c) => c.caseId === caseId && c.stableSamples === stableSamples);
  if (found === undefined) throw new Error(`no cell for ${caseId} at n=${stableSamples}`);
  return found;
};

describe("the matrix covers what SPEC section 13 Q6 said would decide the number", () => {
  it("runs the slow-load and torn-read cases the open question names, at four values", () => {
    const ids = SWEEP_CASES.map((c) => c.id);
    expect(ids).toContain("slow-load");
    expect(ids).toContain("never-settles");
    expect(ids).toContain("tear-persistent");
    for (const width of TEAR_WIDTHS) expect(ids).toContain(`tear-${width}`);
    expect(sweep.cells).toHaveLength(SWEEP_CASES.length * SWEPT_VALUES.length);
  });

  it("separates the control cases from the tear ladder, so the answer is not circular", () => {
    // The tear widths were chosen by this file. If they counted toward "correct on every case", the
    // recommendation would be "one wider than the widest tear I decided to test", which is a fact
    // about the test author rather than about the system.
    const controls = SWEEP_CASES.filter((c) => c.role === "control");
    const ladder = SWEEP_CASES.filter((c) => c.role === "tear-ladder");
    expect(controls.length).toBeGreaterThan(0);
    expect(ladder.map((c) => c.id).sort()).toEqual(TEAR_WIDTHS.map((w) => `tear-${w}`).sort());
    for (const v of sweep.perValue) expect(v.controlsTotal).toBe(controls.length);
  });
});

describe("what the matrix says", () => {
  it("gets every CONTROL case right at every value", () => {
    // The precondition for reading anything else off the table. If a value broke the slow load or
    // let a screen that never arrives look like it had, the tear column would be irrelevant.
    for (const v of sweep.perValue) {
      expect(`n=${v.stableSamples}: ${v.controlsCorrect}/${v.controlsTotal}`).toBe(
        `n=${v.stableSamples}: ${v.controlsTotal}/${v.controlsTotal}`,
      );
    }
  });

  it("THE LAW: stableSamples = n rejects a tear of up to n-1 consecutive polls, and no more", () => {
    expect(sweep.ladderIsLinear).toBe(true);
    for (const v of sweep.perValue) {
      const ceiling = Math.min(v.stableSamples - 1, Math.max(...TEAR_WIDTHS));
      expect(`n=${v.stableSamples} rejects up to ${v.rejectsTearsUpTo}`).toBe(
        `n=${v.stableSamples} rejects up to ${ceiling}`,
      );
    }
  });

  it("shows the credulous setting accepting even a one-poll tear", () => {
    // `stableSamples: 1` turns "settled" into "observed once". `@crr/core`'s own mock-surface suite
    // already shows a single sample believing a torn read; this is the same fact measured through
    // the whole engine and priced.
    expect(cell("tear-1", 1).correct).toBe(false);
    expect(cell("tear-1", 1).arm).toBe("failed:checkpoint-failed");
    expect(cell("tear-1", 2).correct).toBe(true);
  });

  it("shows the SHIPPING placeholder accepting the tear width that was actually measured", () => {
    // This is the finding. `stableSamples: 2` is what SPEC section 13 shipped as a placeholder, and
    // it accepts a two-poll tear - which is the width of the only torn read this project has
    // observed against a real surface (see TEAR_EVIDENCE).
    expect(sweep.measuredTearWidth).toBe(2);
    expect(cell(`tear-${sweep.measuredTearWidth}`, 2).correct).toBe(false);
    expect(cell(`tear-${sweep.measuredTearWidth}`, 3).correct).toBe(true);
    expect(TEAR_EVIDENCE).toContain("spike-terminal-surface.md");
  });

  it("recommends the smallest value that clears the measured width, and nothing wider", () => {
    expect(sweep.supportedByEvidence).toBe(sweep.measuredTearWidth + 1);
    // Derived, not written down: it is one more than the measured tear because of the law above,
    // and if either the law or the evidence changed the recommendation would move with them.
    expect(sweep.supportedByEvidence).toBe(3);
  });
});

describe("what the matrix refuses to say", () => {
  it("a tear that never clears is accepted by EVERY value - the checkpoint is what catches it", () => {
    // The honesty control. Without this row, "we raised stableSamples to 3" reads as "torn reads
    // are handled", and they are not: quiescence is a cheap trigger for taking an observation and
    // readiness is the checkpoint. No setting of this number changes that.
    for (const v of SWEPT_VALUES) {
      const c = cell("tear-persistent", v);
      expect(`n=${v}: ${c.arm}`).toBe(`n=${v}: failed:checkpoint-failed`);
      expect(c.correct).toBe(true);
    }
    expect(formatSettleSweep(sweep)).toContain("caught at EVERY value, by the checkpoint");
  });

  it("the slow load is decided by the DRIVER's settled flag, not by stableSamples", () => {
    // The other half of the same point. `results-loading` reports `settled: false`, so band B0 has
    // already refused it before the sample count is consulted - which is why every value passes and
    // why "we raised it and the slow-load case still passes" proves nothing about the change.
    for (const v of SWEPT_VALUES) expect(cell("slow-load", v).correct).toBe(true);
    for (const v of SWEPT_VALUES) expect(cell("never-settles", v).correct).toBe(true);
  });
});

describe("what it costs", () => {
  it("charges exactly stableSamples polls per settled step on the happy path", () => {
    for (const v of sweep.perValue) {
      expect(
        `n=${v.stableSamples}: ${v.happyPathPolls} polls / ${v.happyPathSettles} settles`,
      ).toBe(
        `n=${v.stableSamples}: ${v.stableSamples * v.happyPathSettles} polls / ${v.happyPathSettles} settles`,
      );
    }
  });

  it("prices the recommended increment against the placeholder", () => {
    const at2 = sweep.perValue.find((v) => v.stableSamples === 2);
    const at3 = sweep.perValue.find((v) => v.stableSamples === 3);
    if (at2 === undefined || at3 === undefined) throw new Error("the sweep lost a value");
    // One extra `perceive()` per settled step, and one extra charge against the observation ledger.
    expect(at3.happyPathPolls - at2.happyPathPolls).toBe(at2.happyPathSettles);
  });
});

describe("the sweep is measuring the settle loop and not something correlated with it", () => {
  it("moves when the engine's settle gate is removed", async () => {
    // Pointed at `noSettleGate` - the mutant that classifies against whatever is on screen - the
    // matrix must come out DIFFERENT. If it did not, the sweep would be measuring something other
    // than quiescence and its recommendation would be about the wrong knob.
    const mutant = ALL_MUTANTS.find((m) => m.id === "noSettleGate");
    if (mutant === undefined) throw new Error("the noSettleGate mutant is gone");
    const weakened = await sweepStableSamples(mutant);
    expect(sweepDigest(weakened)).not.toBe(sweepDigest(sweep));
  });

  it("is itself deterministic: two sweeps of the same engine produce the same matrix", async () => {
    const again = await sweepStableSamples(REFERENCE_ENGINE);
    expect(sweepDigest(again)).toBe(sweepDigest(sweep));
  });
});

describe("the printed sweep", () => {
  it("prints the matrix, the law, the evidence and the recommendation", () => {
    const text = formatSettleSweep(sweep);
    expect(text).toContain("tear-persistent");
    expect(text).toContain("LAW: stableSamples = n rejects a tear of up to n-1");
    expect(text).toContain("spike-terminal-surface.md");
    expect(text).toContain("THE EVIDENCE SUPPORTS stableSamples = 3");
  });
});

// ---------------------------------------------------------------------------------------------
// The shipped default, against the live measurement
// ---------------------------------------------------------------------------------------------

/**
 * This does NOT contradict the policy at the top of this file. Pinning "the answer is 3" would pin
 * a conclusion; this pins the AGREEMENT between the shipped constant and whatever the matrix
 * currently derives. `supportedByEvidence` is computed from the cells, so if somebody changes a
 * scenario and the answer moves, this test demands the default move with it rather than freezing
 * either one.
 *
 * IT EXISTS BECAUSE THE NUMBER WAS ALREADY LOST ONCE. `SETTLE_POLICY_DEFAULTS.stableSamples` was
 * raised 2 -> 3 when the sweep was written, and a concurrent rewrite of `packages/core/src/artifact.ts`
 * (the declaration-size refactor, which re-emitted every schema constant) silently restored the
 * placeholder. Nothing failed: the constant is applied by a RECORDER at emission and never by the
 * validator, so no digest moved and no test noticed - the whole deliverable of SPEC section 11
 * unit 22 was a `2` in one file, and it went back to being a `2`. This is the guard that was
 * missing; `docs/design/FINAL-STATUS.md` records the incident.
 */
describe("the default `@crr/core` ships", () => {
  it("is the value this matrix derives, so the measurement cannot be silently reverted again", () => {
    expect(sweep.supportedByEvidence).not.toBeNull();
    expect(SETTLE_POLICY_DEFAULTS.stableSamples).toBe(sweep.supportedByEvidence);
  });

  it("is a value the sweep actually visited, so the agreement above is not vacuous", () => {
    expect(SWEPT_VALUES).toContain(SETTLE_POLICY_DEFAULTS.stableSamples);
  });

  it("is applied by a recorder and never by the validator, which is why the change was digest-safe", () => {
    // SPEC section 2.4 rule 3. If parsing ever started filling this in, every artifact recorded
    // before the change would re-address to a different digest and its approval signature would
    // stop verifying - so the property is worth an assertion rather than a comment.
    const withoutSettle = {
      pollIntervalMs: 150,
      maxWaitMs: 8_000,
    };
    expect(SettlePolicySchema.safeParse(withoutSettle).success).toBe(false);
  });
});
