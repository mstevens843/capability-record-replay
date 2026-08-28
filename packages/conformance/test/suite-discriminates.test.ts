// THE MOST IMPORTANT TEST IN THIS REPOSITORY.
//
// A conformance suite that passes everything proves nothing. The failure mode of a test suite is not
// that it rejects good implementations, it is that it ACCEPTS BAD ONES - and that is invisible from
// a green run: a suite with no teeth and a suite with a correct engine under it produce identical
// output. The only way to tell them apart is to point the suite at engines that are known to be
// wrong and require it to say so.
//
// So this file asserts two things, and the second is the load-bearing one:
//
//   1. The reference engine passes every scenario.
//   2. EVERY mutant is killed by at least one scenario, and every mutant fails every id on its own
//      `mustKill` floor.
//
// Without (2), (1) is a statement about the engine and not about the suite. With both, "your replay
// engine passed" carries a claim: it is at least not wrong in any of the nine ways SPEC section 4.8
// enumerates.
//
// What makes these mutants worth anything is that they are not stubs. Each one is `@crr/runtime`'s
// real `replay()` - same linker, same lease, same budgets, same journal - with exactly one of the
// two pure decision functions replaced. A suite that can tell a real engine from a stub has proved
// nothing; this one is required to tell a real engine from a subtly wrong one.

// `@crr/core`'s own decision functions, by identity: the last test requires every mutant to share
// the exact function object for the half it does not weaken, which is what makes "one decision
// replaced, nothing stubbed" checkable rather than a comment.
import { classify as REFERENCE_CLASSIFY, resolveTarget as REFERENCE_RESOLVE } from "@crr/core";
import { describe, expect, it } from "vitest";
import { ALL_MUTANTS, REFERENCE_ENGINE } from "../src/engines/mutants.js";
import { buildKillMatrix, formatKillMatrix, formatReport, runConformance } from "../src/run.js";
import { ALL_SCENARIOS } from "../src/scenarios/index.js";

describe("the suite discriminates", () => {
  it("passes the reference engine on every scenario", async () => {
    const report = await runConformance({ engine: REFERENCE_ENGINE });
    expect(report.summary.failed, formatReport(report)).toBe(0);
    expect(report.summary.total).toBe(ALL_SCENARIOS.length);
  });

  it("FAILS IF ANY MUTANT SURVIVES THE WHOLE SUITE", async () => {
    // The meta-assertion. If somebody deletes the scenario that catches `noContinuity`, this is what
    // notices - not a code review, and not production.
    const matrix = await buildKillMatrix(ALL_MUTANTS);
    expect(matrix.survivors, formatKillMatrix(matrix)).toEqual([]);
    expect(matrix.rows.length).toBe(9);
  });

  it("names a scenario that exists, for every mutant", () => {
    // A `mustKill` entry pointing at a renamed scenario would silently assert nothing, which is the
    // exact failure this file exists to catch.
    const known = new Set(ALL_SCENARIOS.map((s) => s.id));
    for (const mutant of ALL_MUTANTS) {
      expect(mutant.mustKill.length, `${mutant.id} names no scenario`).toBeGreaterThan(0);
      for (const id of mutant.mustKill) {
        expect(known.has(id), `${mutant.id} names unknown scenario ${id}`).toBe(true);
      }
    }
  });

  for (const mutant of ALL_MUTANTS) {
    it(`kills ${mutant.id}: ${mutant.description}`, async () => {
      const report = await runConformance({ engine: mutant });
      const failed = new Set(report.scenarios.filter((s) => !s.passed).map((s) => s.id));
      const escaped = mutant.mustKill.filter((id) => !failed.has(id));
      expect(
        escaped,
        `mutant ${mutant.id} passed scenarios it must fail: [${escaped.join(", ")}]\n${formatReport(report)}`,
      ).toEqual([]);
      expect(report.passed, `mutant ${mutant.id} passed the whole suite`).toBe(false);
    });
  }

  it("does not kill a mutant by crashing instead of by grading it", async () => {
    // A scenario that throws is reported as a failure, which is right - but a mutant whose failures
    // are ALL crashes would mean the suite is catching a broken fixture rather than the injected
    // bug. Every named kill must be a genuine failed CHECK, so the corpus is scripted far enough
    // past each wrong decision that the engine gets to give its wrong answer out loud.
    for (const mutant of ALL_MUTANTS) {
      const report = await runConformance({ engine: mutant, only: [...mutant.mustKill] });
      const graded = report.scenarios.filter(
        (s) => !s.passed && s.error === undefined && s.checks.some((c) => !c.passed),
      );
      expect(
        graded.length,
        `every named failure for ${mutant.id} was a crash, not a check\n${formatReport(report)}`,
      ).toBeGreaterThan(0);
    }
  });

  it("catches most of them by the answer they give a caller, not by the class they report", async () => {
    // The distinction that matters operationally. A mutant caught on the failure CLASS is a
    // taxonomy bug; a mutant caught on a FALSE SUCCESS handed a caller a balance, a member's name,
    // or a typed business outcome that nothing on the screen supported. The second is what reaches
    // a member on the phone, and the suite has to be able to catch it, not merely to be green.
    const matrix = await buildKillMatrix(ALL_MUTANTS);
    const byFalseSuccess = matrix.rows.filter((r) => r.falseSuccesses.length > 0);
    expect(byFalseSuccess.length, formatKillMatrix(matrix)).toBeGreaterThanOrEqual(6);
  });

  it("kills each of SPEC section 4.8's nine weakened engines, and no more than nine exist", () => {
    // The list is the spec's, not ours. If SPEC section 4.8 grows a tenth, this fails until somebody
    // writes it - which is the point of pinning the roster rather than counting whatever is present.
    expect(ALL_MUTANTS.map((m) => m.id).sort()).toEqual([
      "checkpointFirst",
      "countQuorum",
      "firstMatch",
      "nearestMatch",
      "noAssert",
      "noContinuity",
      "noDelta",
      "noProvenance",
      "noSettleGate",
    ]);
  });

  it("uses the REAL engine for every mutant - one decision function replaced, nothing stubbed", () => {
    // The structural claim behind the whole file. A mutant is `DecisionFunctions`, so there is no
    // place for it to hide a re-implementation: whatever it does, it does inside the shipping
    // interpreter, under the shipping lease, against the shipping budget ledgers.
    for (const mutant of ALL_MUTANTS) {
      expect(typeof mutant.decisions.classify).toBe("function");
      expect(typeof mutant.decisions.resolveTarget).toBe("function");
      // Exactly one of the two is weakened; the other is `@crr/core`'s own, shared by reference.
      const weakened =
        (mutant.decisions.classify === REFERENCE_CLASSIFY ? 0 : 1) +
        (mutant.decisions.resolveTarget === REFERENCE_RESOLVE ? 0 : 1);
      expect(weakened, `${mutant.id} weakens ${weakened} decision functions, expected 1`).toBe(1);
    }
  });
});
