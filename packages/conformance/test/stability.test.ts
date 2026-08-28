// Multi-run stability (SPEC section 11 unit 22): the flake rate, result determinism, and the
// per-descriptor degradation report.
//
// TWO THINGS THIS FILE IS CAREFUL ABOUT.
//
// First, a stability suite that only asserts "the number is zero" is a suite that would still pass
// if the measurement had stopped measuring. So the zeros here are paired with NEGATIVE CONTROLS -
// engines that really do change behaviour between one pass over the corpus and the next - and each
// control is aimed at a different one of the three measures, because the point of having three is
// that each sees something the others cannot. A zero is worth exactly what its control makes it
// worth.
//
// Second, the run count is small on purpose. The corpus is frozen and the clock is manual, so N
// runs of a deterministic engine are N identical runs; the interesting question is whether the
// REPORT distinguishes stable from unstable, and that is answered at N=3 as well as at N=200. The
// CLI's default of 20 is for the evidence bundle, not for CI.

import {
  type TargetCandidate,
  type TargetResolutionResult,
  classify,
  resolveTarget,
} from "@crr/core";
import type { DecisionFunctions } from "@crr/runtime";
import { describe, expect, it } from "vitest";
import { runFlow } from "../src/corpus/harness.js";
import { ALL_MUTANTS, REFERENCE_ENGINE, firstMatch } from "../src/engines/mutants.js";
import { runConformance } from "../src/run.js";
import { ALL_SCENARIOS } from "../src/scenarios/index.js";
import { formatStability, measureStability } from "../src/stability.js";
import type { ReplayEngine } from "../src/types.js";

const RUNS = 3;

/** The `firstMatch` mutant AS AN ENGINE. `firstMatch` itself is the bare pair of decision
 *  functions, which is what a control substitutes; `ALL_MUTANTS` is where they are named. */
const FIRST_MATCH_ENGINE = (() => {
  const found = ALL_MUTANTS.find((m) => m.id === "firstMatch");
  if (found === undefined) throw new Error("the firstMatch mutant is gone from ALL_MUTANTS");
  return found;
})();

// ---------------------------------------------------------------------------------------------
// Building an engine that really is different on the second pass
// ---------------------------------------------------------------------------------------------

/**
 * How many `resolveTarget` calls ONE pass over the corpus makes.
 *
 * Measured rather than written down, so a control built on it cannot go stale when a scenario is
 * added. This is what lets a control switch behaviour exactly at a run boundary without
 * `measureStability` having to expose one.
 */
async function callsPerPass(): Promise<number> {
  let calls = 0;
  const counting: ReplayEngine = {
    id: "counting",
    description: "the reference engine, counting how often the resolver is consulted",
    decisions: {
      classify,
      resolveTarget: (input) => {
        calls += 1;
        return resolveTarget(input);
      },
    },
  };
  await runConformance({ engine: counting });
  return calls;
}

/** An engine that is the reference for the first pass and `decisions` thereafter. */
function switchesAfterFirstPass(
  id: string,
  perPass: number,
  after: DecisionFunctions["resolveTarget"],
): ReplayEngine {
  let calls = 0;
  return {
    id,
    description: "the reference engine for one pass over the corpus, then something else",
    decisions: {
      classify,
      resolveTarget: (input) => {
        calls += 1;
        return calls <= perPass ? resolveTarget(input) : after(input);
      },
    },
  };
}

/**
 * The rot this whole report exists to catch: one descriptor stops contributing, and NOTHING ELSE
 * CHANGES.
 *
 * The resolution still succeeds - the quorum is met by the other two - so the run returns the same
 * arm, the same outputs and the same document. The only trace is that a descriptor which used to
 * resolve now abstains, which is the state a target sits in for weeks before a vendor upgrade takes
 * out one of the survivors and it starts refusing outright.
 */
const rotOneDescriptor =
  (descriptorId: string): DecisionFunctions["resolveTarget"] =>
  (input): TargetResolutionResult => {
    const base = resolveTarget(input);
    return {
      ...base,
      candidates: base.candidates.map((c: TargetCandidate) =>
        c.descriptorId === descriptorId && c.verdict === "resolved"
          ? { ...c, verdict: "abstained", nodeId: null }
          : c,
      ),
    } as TargetResolutionResult;
  };

// ---------------------------------------------------------------------------------------------
// The flake rate
// ---------------------------------------------------------------------------------------------

describe("the flake rate", () => {
  it("is zero for the reference engine over the whole corpus", async () => {
    const report = await measureStability(REFERENCE_ENGINE, RUNS);
    expect(report.runs).toBe(RUNS);
    expect(report.perScenario).toHaveLength(ALL_SCENARIOS.length);
    expect(report.flakeRate).toBe(0);
    expect(report.perScenario.filter((s) => s.flaky)).toEqual([]);
  });

  it("counts a scenario as flaky only when it is INCONSISTENT, never when it fails every time", async () => {
    // `firstMatch` fails several scenarios on every single run. That is a bug with a stable
    // reproduction, which is the conformance report's business and not this one's - and an engine
    // graded flaky for being reliably wrong would make the flake rate useless as a signal.
    const report = await measureStability(FIRST_MATCH_ENGINE, RUNS);
    const failing = report.perScenario.filter((s) => s.passed === 0);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.every((s) => !s.flaky)).toBe(true);
    expect(report.flakeRate).toBe(0);
  });

  it("IS non-zero when an engine really does change its mind between passes", async () => {
    // The control for the zero above. Reference on pass one, `firstMatch` from pass two on: the
    // scenarios that separate those two engines pass once and fail twice, which is the definition
    // of flaky and must be reported as such.
    const engine = switchesAfterFirstPass(
      "reference-then-first-match",
      await callsPerPass(),
      firstMatch.resolveTarget,
    );
    const report = await measureStability(engine, RUNS);
    expect(report.flakeRate).toBeGreaterThan(0);
    const flaky = report.perScenario.filter((s) => s.flaky);
    expect(flaky.length).toBeGreaterThan(0);
    expect(flaky.every((s) => s.passed > 0 && s.passed < RUNS)).toBe(true);
    expect(formatStability(report)).toContain("FLAKY");
  });

  it("refuses a run count that is not a positive integer", async () => {
    await expect(measureStability(REFERENCE_ENGINE, 0)).rejects.toThrow(RangeError);
    await expect(measureStability(REFERENCE_ENGINE, 2.5)).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Result determinism
// ---------------------------------------------------------------------------------------------

describe("result determinism, which is stricter than the flake rate", () => {
  it("finds every result document byte-identical across runs", async () => {
    const report = await measureStability(REFERENCE_ENGINE, RUNS);
    expect(report.nonDeterministic).toEqual([]);
    expect(report.perScenario.every((s) => s.distinctResults === 1)).toBe(true);
  });

  it("REPORTS the scenarios whose document varied, and there are more of them than flaky ones", async () => {
    // The control, and the reason this measure exists next to the flake rate: an engine can change
    // what it TELLS THE CALLER - a different failure class, a different step index, different
    // prose - on scenarios whose pass/fail grade never moves. Those scenarios are invisible to the
    // flake rate and visible here.
    const engine = switchesAfterFirstPass(
      "reference-then-first-match",
      await callsPerPass(),
      firstMatch.resolveTarget,
    );
    const report = await measureStability(engine, RUNS);
    const flaky = report.perScenario.filter((s) => s.flaky).map((s) => s.id);
    expect(report.nonDeterministic.length).toBeGreaterThanOrEqual(flaky.length);
    for (const id of flaky) expect(report.nonDeterministic).toContain(id);
  });
});

// ---------------------------------------------------------------------------------------------
// The per-descriptor degradation report
// ---------------------------------------------------------------------------------------------

describe("the per-descriptor degradation report", () => {
  it("names every descriptor the artifact declares that was ever consulted", async () => {
    const report = await measureStability(REFERENCE_ENGINE, RUNS);
    const ids = report.descriptors.map((d) => d.id);
    // One per descriptor KIND across the two most-exercised targets, so the report cannot quietly
    // stop covering a kind.
    expect(ids).toContain("member-id-field-by-name");
    expect(ids).toContain("member-id-field-by-label");
    expect(ids).toContain("member-id-field-by-ordinal");
    expect(ids).toContain("open-link-by-row");
    expect(report.descriptors.every((d) => d.consultations > 0)).toBe(true);
  });

  it("carries the kind and the evidence source, because a quorum is over SOURCES not descriptors", async () => {
    const report = await measureStability(REFERENCE_ENGINE, RUNS);
    const byRow = report.descriptors.find((d) => d.id === "open-link-by-row");
    expect(byRow?.kind).toBe("table-cell");
    expect(byRow?.evidenceSource).toBe("columnHeader");
  });

  it("reports a descriptor as SILENT in the scenario that deliberately breaks it", async () => {
    const report = await measureStability(REFERENCE_ENGINE, RUNS);
    // Scenario 17 is the correlated-descriptor case: a second form appears on the page, so the
    // ordinal descriptor abstains and the target correctly refuses. If this row ever goes quiet the
    // suite has stopped exercising the case it was written for.
    const ordinal = report.descriptors.find((d) => d.id === "member-id-field-by-ordinal");
    expect(ordinal?.silentIn).toContain("17");
    expect(ordinal?.contributionRate).toBeLessThan(1);
  });

  it("leaves a healthy descriptor at a 100% contribution rate and silent nowhere", async () => {
    const report = await measureStability(REFERENCE_ENGINE, RUNS);
    const healthy = report.descriptors.find((d) => d.id === "branch-field-by-name");
    expect(healthy?.contributionRate).toBe(1);
    expect(healthy?.silentIn).toEqual([]);
  });

  it("finds NO descriptor that changed its verdict between runs of the same scenario", async () => {
    const report = await measureStability(REFERENCE_ENGINE, RUNS);
    expect(report.unstableDescriptors).toEqual([]);
    expect(report.descriptors.every((d) => d.unstableIn.length === 0)).toBe(true);
  });

  it("CATCHES a descriptor that stops contributing without any scenario changing its grade", async () => {
    // THE CONTROL THIS REPORT EXISTS FOR.
    //
    // `branch-field-by-name` stops resolving from pass two onward. The quorum is still met by the
    // label and ordinal descriptors, so every scenario returns exactly the arm and the outputs it
    // returned before - THE FLAKE RATE STAYS ZERO - while the evidence underneath those answers has
    // halved. A report that measured only pass/fail would call this engine perfectly stable.
    const engine = switchesAfterFirstPass(
      "reference-then-rotted-descriptor",
      await callsPerPass(),
      rotOneDescriptor("branch-field-by-name"),
    );
    const report = await measureStability(engine, RUNS);

    expect(report.flakeRate).toBe(0);
    expect(report.unstableDescriptors).toContain("branch-field-by-name");

    const rotted = report.descriptors.find((d) => d.id === "branch-field-by-name");
    expect(rotted?.contributionRate).toBeLessThan(1);
    expect(rotted?.unstableIn.length).toBeGreaterThan(0);
    expect(formatStability(report)).toContain("UNSTABLE DESCRIPTORS: branch-field-by-name");

    // And it is NOT deterministic, which is worth stating because it is the design working rather
    // than a wrinkle: the run's own drift report puts the changed descriptor in the result
    // document, so a document digest moves too. See the next test - the two mechanisms agree, and
    // what the multi-run table adds is the RATE and the list of scenarios, which one run cannot
    // have.
    expect(report.nonDeterministic.length).toBeGreaterThan(0);
  });

  it("agrees with the run's own drift report, which names the same descriptor in one run", async () => {
    // The cross-check. `RunDrift.changed` is per-run and says "this descriptor no longer resolves
    // the way the recording did"; the degradation table is per-corpus and says how often, and
    // where. If these two ever disagreed, one of them would be lying about the same event.
    const { out } = await runFlow(
      {
        id: "rotted",
        description: "branch-field-by-name abstains",
        decisions: { classify, resolveTarget: rotOneDescriptor("branch-field-by-name") },
      },
      {},
    );
    expect(out.result.status).toBe("ok");
    const drift = out.result.run.drift;
    expect(drift.divergence).toBeGreaterThan(0);
    expect(drift.changed.map((c) => c.descriptorId)).toContain("branch-field-by-name");
    expect(drift.changed.map((c) => c.now)).toContain("abstained");
  });

  it("counts consultations as runs x scenarios, so the denominator is checkable by hand", async () => {
    const one = await measureStability(REFERENCE_ENGINE, 1);
    const three = await measureStability(REFERENCE_ENGINE, 3);
    const pick = (r: Awaited<ReturnType<typeof measureStability>>, id: string) =>
      r.descriptors.find((d) => d.id === id)?.consultations ?? 0;
    expect(pick(three, "open-link-by-name")).toBe(3 * pick(one, "open-link-by-name"));
    // And the rate is invariant under the run count, which is what makes it a RATE.
    const rate = (r: Awaited<ReturnType<typeof measureStability>>, id: string) =>
      r.descriptors.find((d) => d.id === id)?.contributionRate;
    expect(rate(three, "open-link-by-name")).toBeCloseTo(rate(one, "open-link-by-name") ?? -1, 12);
  });
});

// ---------------------------------------------------------------------------------------------
// The printed report
// ---------------------------------------------------------------------------------------------

describe("the printed report", () => {
  it("prints the flake rate, the descriptor table, and the caveat that keeps the number honest", async () => {
    const text = formatStability(await measureStability(REFERENCE_ENGINE, RUNS));
    expect(text).toContain("flake rate 0.0%");
    expect(text).toContain("per-descriptor degradation");
    expect(text).toContain("open-link-by-row");
    expect(text).toContain("no descriptor changed its verdict between runs of the same scenario");
    // The caveat is part of the OUTPUT, not of a README somebody may not read. A number copied out
    // of this terminal carries its own limits with it.
    expect(text).toContain("FROZEN corpus");
    expect(text).toContain("cannot surprise you the way a real vendor app does");
  });

  it("prints only the rows that varied, so a clean run is short", async () => {
    const text = formatStability(await measureStability(REFERENCE_ENGINE, RUNS));
    expect(text).not.toContain("FLAKY");
    expect(text).not.toContain("VARIED");
  });
});
