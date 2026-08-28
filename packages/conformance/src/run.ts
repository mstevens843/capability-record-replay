// The runner and the reports. Returns data; throws nothing.
//
// Runner-agnostic on purpose. Assert on the report in vitest, print it in CI, diff two engines. Two
// rules make the verdict trustworthy: a FRESH surface, clock, journal and lease per scenario -
// `runFlow` builds one every time, so nothing leaks between scenarios - and a thrown scenario is
// recorded as a FAILURE with its message, never as a skip, because an engine that makes a scenario
// crash has not passed it.

import { ALL_SCENARIOS } from "./scenarios/index.js";
import { gradeScenario, isFalseSuccess } from "./support.js";
import type {
  CheckResult,
  ConformanceReport,
  ReplayEngine,
  Scenario,
  ScenarioObservation,
  ScenarioResult,
} from "./types.js";

export interface RunConformanceOptions {
  readonly engine: ReplayEngine;
  /**
   * Restrict the run. Each selector matches a scenario id ("03", or "3") or part of its title. A
   * selector matching nothing is reported as such rather than silently narrowing the run to zero
   * scenarios, which would otherwise look like a clean pass.
   */
  readonly only?: readonly string[];
  /**
   * The corpus to grade. Defaults to the browser scenarios, which is what every existing caller
   * means by "the suite".
   *
   * Present because build unit 21 added a SECOND corpus - `TERMINAL_SCENARIOS`, a live 80x24 green
   * screen behind the same port - and the whole point of that unit is that the runner, the grader
   * and the mutants are the same objects for both. A second runner would have made "the same
   * conformance scenarios" a claim about two things that merely resembled each other.
   */
  readonly scenarios?: readonly Scenario[];
}

const describeError = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

export function matchesSelector(scenario: Scenario, selector: string): boolean {
  const needle = selector.trim().toLowerCase();
  if (needle.length === 0) return false;
  if (needle === scenario.id.toLowerCase()) return true;
  if (needle === scenario.id.replace(/^0+/, "")) return true;
  return scenario.title.toLowerCase().includes(needle);
}

export function selectScenarios(
  only?: readonly string[],
  corpus: readonly Scenario[] = ALL_SCENARIOS,
): readonly Scenario[] {
  if (only === undefined || only.length === 0) return corpus;
  return corpus.filter((s) => only.some((sel) => matchesSelector(s, sel)));
}

async function runOne(scenario: Scenario, engine: ReplayEngine): Promise<ScenarioResult> {
  let checks: readonly CheckResult[] = [];
  let falseSuccess = false;
  let error: string | undefined;
  let observation: ScenarioObservation | undefined;
  try {
    const seen = await scenario.run(engine);
    observation = seen;
    checks = gradeScenario(scenario.expect, seen);
    falseSuccess = isFalseSuccess(scenario.expect, seen.result);
  } catch (cause) {
    error = describeError(cause);
  }
  const passed = error === undefined && checks.length > 0 && checks.every((c) => c.passed);
  return {
    id: scenario.id,
    title: scenario.title,
    passed,
    checks,
    falseSuccess,
    ...(error === undefined ? {} : { error }),
    ...(observation === undefined ? {} : { observation }),
  };
}

/**
 * Grade one engine over the whole corpus.
 *
 * Serial and in order. Parallelism would trade a reproducible verdict for a few milliseconds on a
 * suite that already runs in about a second, and several scenarios assert on a shared manual clock.
 */
export async function runConformance(options: RunConformanceOptions): Promise<ConformanceReport> {
  const scenarios = selectScenarios(options.only, options.scenarios);
  const results: ScenarioResult[] = [];

  if (scenarios.length === 0) {
    results.push({
      id: "--",
      title: `no scenario matched [${(options.only ?? []).join(", ")}]`,
      passed: false,
      checks: [],
      falseSuccess: false,
      error: "the `only` filter selected nothing; an empty run is not a passing run",
    });
  }

  for (const scenario of scenarios) results.push(await runOne(scenario, options.engine));

  const passedCount = results.filter((r) => r.passed).length;
  return {
    engine: options.engine.id,
    passed: results.every((r) => r.passed),
    scenarios: results,
    summary: {
      total: results.length,
      passed: passedCount,
      failed: results.length - passedCount,
      falseSuccesses: results.filter((r) => r.falseSuccess).length,
    },
  };
}

const pad = (value: string, width: number): string =>
  value.length >= width ? value : value + " ".repeat(width - value.length);

/** A readable table. Failing checks print what was observed underneath, because a report that says
 *  only FAIL sends the reader back to the source - which is the moment a suite stops being used. */
export function formatReport(report: ConformanceReport): string {
  const lines: string[] = [];
  lines.push(`conformance: ${report.engine}`);
  lines.push("-".repeat(104));
  for (const scenario of report.scenarios) {
    const passedChecks = scenario.checks.filter((c) => c.passed).length;
    const tally = `${passedChecks}/${scenario.checks.length}`;
    const verdict = scenario.falseSuccess ? "FALSE+" : scenario.passed ? "PASS  " : "FAIL  ";
    lines.push(`${verdict} ${pad(scenario.id, 3)} ${pad(scenario.title, 84)} ${tally}`);
    if (scenario.error !== undefined) lines.push(`         ! ${scenario.error}`);
    for (const c of scenario.checks) {
      if (c.passed) continue;
      lines.push(`         x ${c.name}`);
      if (c.detail !== undefined) lines.push(`           ${c.detail}`);
    }
  }
  lines.push("-".repeat(104));
  lines.push(
    `${report.summary.total} scenarios: ${report.summary.passed} passed, ` +
      `${report.summary.failed} failed, ${report.summary.falseSuccesses} FALSE SUCCESSES`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// The kill matrix
// ---------------------------------------------------------------------------------------------

export interface KillRow {
  readonly mutant: string;
  readonly description: string;
  /** Scenario ids this engine failed. Empty means it SURVIVED the whole suite. */
  readonly killedBy: readonly string[];
  /** The subset of those where it reported `ok` or an outcome it had not earned. */
  readonly falseSuccesses: readonly string[];
  /** Ids from the mutant's own `mustKill` floor that it nevertheless passed. */
  readonly escaped: readonly string[];
}

export interface KillMatrix {
  readonly scenarioIds: readonly string[];
  readonly rows: readonly KillRow[];
  /** The engines no scenario caught. A non-empty list is a REAL FINDING about a gap in the suite. */
  readonly survivors: readonly string[];
}

/**
 * Grade every mutant and report which scenario killed which.
 *
 * `survivors` is the number the meta-test turns into a failure. A suite that stops discriminating
 * looks exactly like a suite with a correct implementation under it - both are green - and the only
 * way to tell them apart is to point the suite at things known to be wrong and require it to say so.
 */
export async function buildKillMatrix(
  mutants: readonly (ReplayEngine & { readonly mustKill: readonly string[] })[],
  /** Which corpus to grade against. Defaults to the browser scenarios; the terminal suite passes
   *  its own, so "these mutants die on a green screen too" is the same matrix over a live grid. */
  corpus: readonly Scenario[] = ALL_SCENARIOS,
): Promise<KillMatrix> {
  const rows: KillRow[] = [];
  for (const mutant of mutants) {
    const report = await runConformance({ engine: mutant, scenarios: corpus });
    const failed = report.scenarios.filter((s) => !s.passed);
    const killedBy = failed.map((s) => s.id);
    rows.push({
      mutant: mutant.id,
      description: mutant.description,
      killedBy,
      falseSuccesses: failed.filter((s) => s.falseSuccess).map((s) => s.id),
      // A `mustKill` floor names ids in the BROWSER corpus. Against another corpus those ids are
      // simply absent, and an absent id is not an escape - so the floor is only checked over
      // scenarios this corpus actually contains.
      escaped: mutant.mustKill.filter(
        (id) => corpus.some((s) => s.id === id) && !killedBy.includes(id),
      ),
    });
  }
  return {
    scenarioIds: corpus.map((s) => s.id),
    rows,
    survivors: rows.filter((r) => r.killedBy.length === 0).map((r) => r.mutant),
  };
}

export function formatKillMatrix(matrix: KillMatrix): string {
  const lines: string[] = [];
  lines.push(`kill matrix: ${matrix.rows.length} mutants x ${matrix.scenarioIds.length} scenarios`);
  lines.push("-".repeat(104));
  lines.push(`${pad("mutant", 17)} ${pad("killed by", 34)} ${pad("of which false successes", 30)}`);
  for (const row of matrix.rows) {
    lines.push(
      `${pad(row.mutant, 17)} ${pad(row.killedBy.join(",") || "SURVIVED", 34)} ${pad(
        row.falseSuccesses.join(",") || "-",
        30,
      )}`,
    );
    if (row.escaped.length > 0) {
      lines.push(`${" ".repeat(17)} ! escaped its own floor: ${row.escaped.join(",")}`);
    }
  }
  lines.push("-".repeat(104));
  lines.push(
    matrix.survivors.length === 0
      ? "every mutant was killed by at least one scenario"
      : `SURVIVORS (a gap in the suite): ${matrix.survivors.join(", ")}`,
  );
  return lines.join("\n");
}
