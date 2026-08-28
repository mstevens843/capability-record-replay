// The same suite, pointed at a green screen.
//
// SPEC section 11 unit 21 asks for a recorded terminal artifact driven "through the same engine and
// the same conformance scenarios" as the browser. This file is the second half of that: `runConformance`,
// `gradeScenario`, `isFalseSuccess`, `buildKillMatrix` and all nine mutants are the OBJECTS the
// browser suite uses, not copies of them, and the only thing that changes is which corpus they are
// handed. `heterogeneity.test.ts` is the first half - the artifact, the two tenants and the lowering.
//
// Everything here runs a live `TerminalSurface` over the real `fixtures/corebank-tui`: real
// keystrokes, real ANSI frames, a real VT parser, a real detector. No credential, no network, no
// child process, no browser.

import { describe, expect, it } from "vitest";
import { ALL_MUTANTS, REFERENCE_ENGINE } from "../src/engines/mutants.js";
import { buildKillMatrix, formatKillMatrix, formatReport, runConformance } from "../src/run.js";
import { ALL_SCENARIOS } from "../src/scenarios/index.js";
import { isFalseSuccess } from "../src/support.js";
import { TERMINAL_SCENARIOS } from "./terminal/scenarios.js";

describe("the green-screen corpus", () => {
  it("passes the reference engine on every scenario", async () => {
    const report = await runConformance({
      engine: REFERENCE_ENGINE,
      scenarios: TERMINAL_SCENARIOS,
    });
    expect(report.summary.failed, formatReport(report)).toBe(0);
    expect(report.summary.total).toBe(TERMINAL_SCENARIOS.length);
  }, 60_000);

  it("reports ZERO FALSE SUCCESSES - the assertion the whole suite exists to make", async () => {
    const report = await runConformance({
      engine: REFERENCE_ENGINE,
      scenarios: TERMINAL_SCENARIOS,
    });
    expect(report.summary.falseSuccesses, formatReport(report)).toBe(0);
  }, 60_000);

  it("covers every fault the TUI fixture can inject, checked against its own registry", async () => {
    // Mechanical rather than promised, exactly as `conformance.test.ts` does it for the web fixture:
    // adding a fault to the fixture without a scenario here fails this test.
    const { FAULT_IDS } = (await import("@crr/fixture-corebank-tui/faults")) as {
      FAULT_IDS: readonly string[];
    };
    const mirrored = TERMINAL_SCENARIOS.map((s) => s.mirrors).join(" | ");
    for (const id of FAULT_IDS) {
      expect(mirrored, `no terminal scenario mirrors the ${id} fault`).toContain(id);
    }
    expect(FAULT_IDS.length).toBe(4);
  });

  it("exercises all three arms and both families, not just the ones that are easy to produce", () => {
    const kinds = TERMINAL_SCENARIOS.map((s) => s.expect.kind);
    expect(kinds).toContain("ok");
    expect(kinds).toContain("recovered");
    expect(kinds).toContain("outcome");
    expect(kinds).toContain("failure");
    // The delivery family is the one a browser driver has no analogue for. If these two ever
    // disappear, the green screen has stopped earning its place in this repository.
    const mirrors = TERMINAL_SCENARIOS.map((s) => s.mirrors).join(" ");
    expect(mirrors).toContain("torn-repaint");
    expect(mirrors).toContain("slow-repaint");
  });

  it("gives every scenario a distinct id that does not collide with the browser corpus", () => {
    const ids = TERMINAL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const browser = new Set(ALL_SCENARIOS.map((s) => s.id));
    for (const id of ids)
      expect(browser.has(id), `${id} collides with a browser scenario`).toBe(false);
  });
});

describe("the mutants, on a character grid", () => {
  // WHAT THIS CORPUS CAN AND CANNOT KILL, as a ledger rather than as a hope.
  //
  // The nine weakened engines model bugs in a TAXONOMY and a RESOLVER, not bugs in a DOM, so the
  // interesting question is not "do they all die here" - they cannot, and pretending otherwise
  // would be the false success this package exists to refuse. It is: does each one die here for the
  // same reason it dies there, and is every survivor's escape explained by something about the
  // SURFACE rather than by a gap somebody forgot to fill?
  //
  // Both halves of that are asserted below, and the ledger is exact in both directions: a mutant
  // that stops dying fails this test, and so does a mutant that starts dying, because a survivor
  // becoming a casualty means somebody found a way to reach a condition this file says is out of
  // reach - which is news worth reading rather than a green run.
  const KILLED_BY_THE_GREEN_SCREEN: Readonly<Record<string, string>> = {
    firstMatch:
      "T13: the name says Search and the ordinal says Exit. A ranking presses one of ENTER or F3.",
    countQuorum:
      "T14: a grid field's accessible name IS its prompt, so role-name and label-anchored are one " +
      "piece of evidence. Counting descriptors makes every terminal target look corroborated.",
    checkpointFirst:
      "T03/T04: the status band carries the outcome while the screen is still the inquiry screen, " +
      "so verifying the checkpoint first turns MEMBER_NOT_FOUND into a checkpoint failure.",
    noDelta:
      "T08: a repaint that never arrived leaves the previous screen in place. Without the delta " +
      "the checkpoint has nothing to notice.",
    nearestMatch:
      "T06/T08: a torn read and a stale screen both share words with a declared outcome code.",
  };

  /** Not reachable from THIS corpus, and why. Each reason is a fact about the fixture or about the
   *  surface - never 'we did not get to it'. */
  const OUT_OF_REACH: Readonly<Record<string, string>> = {
    noAssert:
      "needs a target that resolves correctly and is still the wrong thing. On this fixture the " +
      "account list is keyed by suffix and every row is the member's own, so there is no row whose " +
      "pre-act assertion can fail while its descriptors agree. The browser corpus scripts one.",
    noSettleGate:
      "THE INTERESTING ONE. This mutant classifies against a screen the driver called unsettled. A " +
      "green screen's readiness signal is silence, and the torn repaint is silent - the driver " +
      "reports settled: true on a half-painted frame. So there is no observation where the settle " +
      "flag is false and a verdict hangs on it, and the mutant behaves identically to the reference " +
      "engine. That is the same measurement T06 makes from the other side: on this surface band B0 " +
      "cannot be the gate, which is why the checkpoint has to be.",
    noContinuity:
      "needs the application to land on a different member's record. The fixture echoes back the " +
      "account number it was given, always; producing the divergence would mean a fixture that " +
      "lies about which member it looked up.",
    noProvenance:
      "needs the SAME validation banner over a caller's argument and over an artifact literal " +
      "(SPEC 4.2 rows 4 vs 5). This flow fills exactly one field and it is the caller's, so the " +
      "two rows collapse into one and there is no pair to tell apart.",
  };

  it("kills exactly the mutants it can reach, and no fewer", async () => {
    const matrix = await buildKillMatrix(ALL_MUTANTS, TERMINAL_SCENARIOS);
    const killed = matrix.rows
      .filter((r) => r.killedBy.length > 0)
      .map((r) => r.mutant)
      .sort();
    expect(killed, formatKillMatrix(matrix)).toEqual(
      Object.keys(KILLED_BY_THE_GREEN_SCREEN).sort(),
    );
    expect(matrix.survivors.slice().sort(), formatKillMatrix(matrix)).toEqual(
      Object.keys(OUT_OF_REACH).sort(),
    );
    expect(matrix.rows.length).toBe(9);
  }, 180_000);

  it("accounts for all nine, so a mutant cannot be quietly dropped from the ledger", () => {
    const accounted = new Set([
      ...Object.keys(KILLED_BY_THE_GREEN_SCREEN),
      ...Object.keys(OUT_OF_REACH),
    ]);
    expect(accounted.size).toBe(ALL_MUTANTS.length);
    for (const mutant of ALL_MUTANTS) {
      expect(accounted.has(mutant.id), `${mutant.id} is on neither list`).toBe(true);
    }
    // And every entry says WHY in a sentence somebody can disagree with.
    for (const reason of [
      ...Object.values(KILLED_BY_THE_GREEN_SCREEN),
      ...Object.values(OUT_OF_REACH),
    ]) {
      expect(reason.length).toBeGreaterThan(60);
    }
  });

  it("kills most of the reachable ones by the ANSWER they give a caller, not by the class they report", async () => {
    // A mutant that returns a wrong failure class is a bug a developer sees. A mutant that returns
    // `ok`, or a business outcome, for a run that broke is a bug a MEMBER sees. Counting them
    // separately is why `falseSuccess` is its own field.
    const matrix = await buildKillMatrix(ALL_MUTANTS, TERMINAL_SCENARIOS);
    const withFalseSuccess = matrix.rows.filter((r) => r.falseSuccesses.length > 0);
    expect(withFalseSuccess.length, formatKillMatrix(matrix)).toBeGreaterThan(0);
  }, 180_000);

  it("still kills every one of the nine on the browser corpus, so nothing here weakened that", async () => {
    // The generalisation of `runConformance`/`buildKillMatrix` to a second corpus must not have
    // changed what the first one does. Cheap insurance against a default argument going wrong.
    const matrix = await buildKillMatrix(ALL_MUTANTS, ALL_SCENARIOS);
    expect(matrix.survivors, formatKillMatrix(matrix)).toEqual([]);
  }, 180_000);

  it("never records a false success for the reference engine on any scenario", async () => {
    const report = await runConformance({
      engine: REFERENCE_ENGINE,
      scenarios: TERMINAL_SCENARIOS,
    });
    for (const scenario of report.scenarios) {
      const declared = TERMINAL_SCENARIOS.find((s) => s.id === scenario.id);
      expect(declared, `scenario ${scenario.id} vanished`).toBeDefined();
      if (declared === undefined || scenario.observation === undefined) continue;
      expect(
        isFalseSuccess(declared.expect, scenario.observation.result),
        `${scenario.id} ${scenario.title}`,
      ).toBe(false);
    }
  }, 60_000);
});
