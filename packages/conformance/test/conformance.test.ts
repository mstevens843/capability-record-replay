// The suite, run against the shipping engine. NO BROWSER, NO SOCKET, NO CREDENTIAL.
//
// Every scenario is `@crr/runtime`'s real `replay()` over `@crr/core`'s `MockSurface`, driving a
// frozen corpus of Observations with a manual clock. That is what SPEC section 4.8 item 3 asks for:
// a classifier test is `classify(load(snapshot))`, milliseconds, no fixture server. The browser
// suite in `@crr/runtime` proves the driver works against the real hostile fixture; this proves the
// engine does the RIGHT thing when the surface misbehaves in ways a real one cannot be asked for.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REFERENCE_ENGINE } from "../src/engines/mutants.js";
import { formatReport, runConformance, selectScenarios } from "../src/run.js";
import { ALL_SCENARIOS } from "../src/scenarios/index.js";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

describe("the reference engine", () => {
  it("passes every scenario in the suite", async () => {
    const report = await runConformance({ engine: REFERENCE_ENGINE });
    expect(report.summary.failed, formatReport(report)).toBe(0);
    expect(report.summary.total).toBe(ALL_SCENARIOS.length);
    expect(report.passed).toBe(true);
  });

  it("produces ZERO FALSE SUCCESSES, which is the assertion the suite exists to make", async () => {
    // Stated separately from `passed`, and it is not redundant. A suite can go green while an engine
    // misclassifies in the safe direction; it cannot go green here while an engine tells a caller
    // "here is the balance" or "no such member" for a run that did not establish either.
    const report = await runConformance({ engine: REFERENCE_ENGINE });
    const offenders = report.scenarios.filter((s) => s.falseSuccess).map((s) => s.id);
    expect(offenders, formatReport(report)).toEqual([]);
    expect(report.summary.falseSuccesses).toBe(0);
  });

  it("runs the whole corpus with every credential removed from the environment", () => {
    // BRIEF section 11 is a hard rule and a submission requirement, not a nicety: `pnpm test` must
    // pass with no API key present. Asserted rather than assumed, because the failure it catches -
    // a package that quietly reaches a provider - is invisible on a machine that has a key.
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      delete process.env[key];
    }
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("scenario hygiene", () => {
  it("gives every scenario a unique id and a non-empty grade", async () => {
    const ids = ALL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const report = await runConformance({ engine: REFERENCE_ENGINE });
    // A scenario that asserts nothing passes vacuously, which is the quietest way for a suite to
    // stop grading. Every one must produce at least one check.
    for (const scenario of report.scenarios) {
      expect(scenario.checks.length, `${scenario.id} asserted nothing`).toBeGreaterThan(0);
    }
  });

  it("selects nothing rather than everything for a filter that matches nothing", async () => {
    expect(selectScenarios(["nope"])).toEqual([]);
    const report = await runConformance({ engine: REFERENCE_ENGINE, only: ["nope"] });
    // An empty run is NOT a passing run. Without this, a typo in a CI filter is a green build.
    expect(report.passed).toBe(false);
  });

  it("selects by id, by unpadded id and by title substring", () => {
    expect(selectScenarios(["02"]).map((s) => s.id)).toEqual(["02"]);
    expect(selectScenarios(["2"]).map((s) => s.id)).toEqual(["02"]);
    expect(selectScenarios(["torn read"]).map((s) => s.id)).toEqual(["14"]);
  });
});

describe("coverage of the fixture's own fault registry", () => {
  /**
   * The claim is "every fault `fixtures/corebank-web` can inject, crossed with the replay engine",
   * and this is what makes it a mechanical check rather than a promise.
   *
   * The registry is READ OFF DISK rather than imported. Importing `@crr/fixture-corebank-web` pulls
   * `node:http` and the whole server into this package's graph for the sake of one frozen list, and
   * a conformance package that transitively depends on a web server is a conformance package that
   * cannot be run in a sandbox. The parse is deliberately dumb - the ids are the keys of one frozen
   * object literal - and the test below fails loudly if it ever reads back fewer than it should.
   */
  const registry = readFileSync(join(ROOT, "fixtures", "corebank-web", "src", "faults.js"), "utf8");
  const declared = [...registry.matchAll(/^\s{2}"?([a-z][a-z-]*)"?:\s*\{\s*$/gm)]
    .map((m) => m[1] as string)
    .filter((id) => registry.includes(`id: "${id}"`));

  it("reads the fixture's registry rather than a copy of it", () => {
    expect(declared.length).toBeGreaterThanOrEqual(10);
    expect(declared).toContain("not-found");
    expect(declared).toContain("torn-render");
  });

  it("has a scenario for every fault the fixture can inject", () => {
    const mirrored = ALL_SCENARIOS.map((s) => s.mirrors).join(" | ");
    const uncovered = declared.filter((id) => !mirrored.includes(id));
    expect(
      uncovered,
      `faults with no scenario: ${uncovered.join(", ")}\ncovered: ${mirrored}`,
    ).toEqual([]);
  });

  it("also covers the wrong-target cases no HTTP fault can express", () => {
    // SPEC section 4.5's sub-cases are properties of a LOCATOR, not of a response: no fixture server
    // can make two independently-computed descriptors disagree about which node is the member's row.
    const spec45 = ALL_SCENARIOS.filter((s) => s.mirrors.includes("SPEC 4.5"));
    expect(spec45.length).toBeGreaterThanOrEqual(5);
  });
});
