// Multi-run stability: the flake rate and the per-descriptor degradation report (SPEC section 11
// unit 22).
//
// A conformance suite answers "is this engine right". A stability run answers a different and
// equally operational question: "is it right EVERY time, and by the same route". They share a
// harness because the second is the first repeated, and repeating it is cheap - every scenario is a
// frozen corpus over a mock surface with a manual clock, so N runs cost N milliseconds rather than
// N browser launches.
//
// THREE MEASUREMENTS, IN INCREASING STRICTNESS. Each one catches something the one above it misses,
// which is the only reason to have three:
//
//   1. FLAKE RATE. Did every scenario reach the same PASS/FAIL verdict on all N runs? This is the
//      number the assignment asks for and the weakest of the three: an engine that returns a
//      different failure class every run, or reads a different balance every run, can still be
//      flake-free by this measure as long as the grade lands the same way.
//   2. RESULT DETERMINISM. Was the result DOCUMENT byte-identical across the N runs? Same arm, same
//      outputs, same failure class, same rendered prose, same step index. This is the claim the
//      README is entitled to make about replay, and it is strictly stronger than the flake rate.
//   3. DESCRIPTOR DEGRADATION. Of the descriptors the artifact declares, which ones actually
//      carried a resolution, and which have gone quiet? A target resolves on a QUORUM, so a
//      descriptor can rot completely without a single run turning red - the other two carry it, the
//      engine is right, and the evidence underneath the answer has silently thinned from two
//      independent sources to one. That is the failure this report exists to make visible BEFORE
//      the next vendor upgrade takes the second one out and the target starts refusing.
//
// WHAT THIS MEASURES AND WHAT IT DOES NOT. It measures the ENGINE's own determinism over a fixed
// corpus. It cannot measure flake caused by a real browser, a real network or a real legacy core,
// because none of those is present. A non-zero flake rate here would mean the engine has hidden
// state; a zero flake rate here says nothing about a Tuesday morning against a real Symitar box.
// Saying that plainly is the point of measuring it at all.

import { type DescriptorVerdict, type JournalEvent, digestOf } from "@crr/core";
import { resolvedEvents } from "./journal-view.js";
import { runConformance } from "./run.js";
import type { ReplayEngine, ScenarioResult } from "./types.js";

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

const ZERO_VERDICTS = (): Record<DescriptorVerdict, number> => ({
  resolved: 0,
  abstained: 0,
  "non-unique": 0,
  disabled: 0,
  disagreed: 0,
});

export interface StabilityScenarioRow {
  readonly id: string;
  readonly title: string;
  /** How many of the N runs this scenario passed. */
  readonly passed: number;
  /**
   * INCONSISTENT, not failing. A scenario that fails all N times is a bug with a stable
   * reproduction, which is the good kind and belongs to the conformance report, not to this one.
   */
  readonly flaky: boolean;
  /**
   * How many distinct result documents the N runs produced. `1` means byte-identical every time.
   *
   * Counted over a digest of the whole document rather than over the arm, because "returned
   * `failed` every time" and "returned the same failure, at the same step, with the same operator
   * action every time" are different claims and only the second one is worth printing.
   */
  readonly distinctResults: number;
}

/**
 * One descriptor, across every run and every scenario that consulted it.
 *
 * Keyed by descriptor id because that is the identifier a person edits: a degradation report whose
 * rows a reader cannot look up in the artifact is a report nobody acts on.
 */
export interface DescriptorRow {
  readonly id: string;
  readonly kind: string;
  readonly evidenceSource: string;
  /** How many times the resolver consulted it, across all runs and scenarios. */
  readonly consultations: number;
  readonly byVerdict: Readonly<Record<DescriptorVerdict, number>>;
  /** `resolved / consultations`. NOT a quality score: several scenarios break a descriptor on
   *  purpose, so a rate below 1 is a prompt to read the next two fields, never a verdict. */
  readonly contributionRate: number;
  /**
   * Scenario ids where this descriptor did not return the same verdict on every run.
   *
   * THE REAL FLAKE SIGNAL. Aggregating verdicts across scenarios conflates "this descriptor is
   * unreliable" with "scenario 16 deliberately made it disagree"; comparing a descriptor against
   * ITSELF within one scenario does not.
   */
  readonly unstableIn: readonly string[];
  /** Scenario ids where it was consulted and never once resolved. The drift-review list. */
  readonly silentIn: readonly string[];
}

export interface StabilityReport {
  readonly engine: string;
  readonly runs: number;
  readonly perScenario: readonly StabilityScenarioRow[];
  /** Scenarios that did not reach the same verdict on every run, over total scenarios. */
  readonly flakeRate: number;
  /** Scenario ids whose result document was not byte-identical on every run. Stricter than
   *  `flakeRate`, and the number the determinism claim rests on. */
  readonly nonDeterministic: readonly string[];
  readonly descriptors: readonly DescriptorRow[];
  /** Descriptor ids with a non-empty `unstableIn`. Zero is the only acceptable value for a
   *  deterministic engine over a frozen corpus, so it gets its own field. */
  readonly unstableDescriptors: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Reading the journal
// ---------------------------------------------------------------------------------------------

interface ResolvedRecord {
  readonly descriptorId: string;
  readonly kind: string;
  readonly evidenceSource: string;
  readonly verdict: DescriptorVerdict;
}

/**
 * Every descriptor consultation in one run, in order.
 *
 * Order matters: two runs are compared position by position, so "descriptor `open-link-by-name`
 * abstained on the SECOND of its two consultations this run and on the first the next run" is
 * visible as instability rather than averaged into a rate that looks the same both times.
 */
function resolvedRecords(events: readonly JournalEvent[]): readonly ResolvedRecord[] {
  const out: ResolvedRecord[] = [];
  for (const event of resolvedEvents(events)) {
    for (const d of event.descriptors) {
      out.push({
        descriptorId: d.id,
        kind: d.kind,
        evidenceSource: d.evidenceSource,
        verdict: d.verdict,
      });
    }
  }
  return out;
}

/** The per-scenario key a descriptor's stability is judged on: its verdicts, in order, as one
 *  string. Two runs that produce different strings for the same descriptor disagreed. */
function verdictTrace(records: readonly ResolvedRecord[], descriptorId: string): string {
  return records
    .filter((r) => r.descriptorId === descriptorId)
    .map((r) => r.verdict)
    .join(",");
}

// ---------------------------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------------------------

interface ScenarioTally {
  title: string;
  passed: number;
  /** Result-document digests, one per run. A Set of size 1 is byte-identical replay. */
  readonly resultDigests: Set<string>;
  /** Per descriptor id, the verdict traces seen across runs. Size > 1 means it varied. */
  readonly traces: Map<string, Set<string>>;
}

interface DescriptorTally {
  kind: string;
  evidenceSource: string;
  consultations: number;
  readonly byVerdict: Record<DescriptorVerdict, number>;
  /** Scenario ids where it resolved at least once. */
  readonly resolvedIn: Set<string>;
  readonly seenIn: Set<string>;
}

function tallyRun(
  result: ScenarioResult,
  scenarios: Map<string, ScenarioTally>,
  descriptors: Map<string, DescriptorTally>,
): void {
  const row = scenarios.get(result.id) ?? {
    title: result.title,
    passed: 0,
    resultDigests: new Set<string>(),
    traces: new Map<string, Set<string>>(),
  };
  row.passed += result.passed ? 1 : 0;

  const observation = result.observation;
  if (observation === undefined) {
    // A scenario that THREW produced no document to digest. Recorded as its own bucket rather than
    // skipped, so "it threw on run 7 and returned a result on the other 19" reads as two distinct
    // results, which is what it is.
    row.resultDigests.add(`threw:${result.error ?? "unknown"}`);
  } else {
    row.resultDigests.add(digestOf(observation.result));
  }
  scenarios.set(result.id, row);

  const records = resolvedRecords(observation?.journal ?? []);
  const idsThisRun = new Set(records.map((r) => r.descriptorId));
  for (const id of idsThisRun) {
    const traces = row.traces.get(id) ?? new Set<string>();
    traces.add(verdictTrace(records, id));
    row.traces.set(id, traces);
  }

  for (const record of records) {
    const tally = descriptors.get(record.descriptorId) ?? {
      kind: record.kind,
      evidenceSource: record.evidenceSource,
      consultations: 0,
      byVerdict: ZERO_VERDICTS(),
      resolvedIn: new Set<string>(),
      seenIn: new Set<string>(),
    };
    tally.consultations += 1;
    tally.byVerdict[record.verdict] += 1;
    tally.seenIn.add(result.id);
    if (record.verdict === "resolved") tally.resolvedIn.add(result.id);
    descriptors.set(record.descriptorId, tally);
  }
}

/**
 * Replay the whole corpus N times and report what varied.
 *
 * Serial, and every run builds a fresh surface, clock, journal and lease - `runFlow` does that per
 * scenario, so nothing leaks between runs any more than it leaks between scenarios. Running them in
 * parallel would trade the reproducibility of the number for a few milliseconds on a measurement
 * whose entire subject is reproducibility.
 */
export async function measureStability(
  engine: ReplayEngine,
  runs: number,
): Promise<StabilityReport> {
  if (!Number.isInteger(runs) || runs < 1) throw new RangeError("runs must be a positive integer");

  const scenarios = new Map<string, ScenarioTally>();
  const descriptors = new Map<string, DescriptorTally>();

  for (let i = 0; i < runs; i++) {
    const report = await runConformance({ engine });
    for (const result of report.scenarios) tallyRun(result, scenarios, descriptors);
  }

  const perScenario: StabilityScenarioRow[] = [...scenarios].map(([id, row]) => ({
    id,
    title: row.title,
    passed: row.passed,
    flaky: row.passed !== 0 && row.passed !== runs,
    distinctResults: row.resultDigests.size,
  }));

  const unstableByDescriptor = new Map<string, string[]>();
  for (const [scenarioId, row] of scenarios) {
    for (const [descriptorId, traces] of row.traces) {
      if (traces.size <= 1) continue;
      const list = unstableByDescriptor.get(descriptorId) ?? [];
      list.push(scenarioId);
      unstableByDescriptor.set(descriptorId, list);
    }
  }

  const descriptorRows: DescriptorRow[] = [...descriptors]
    .map(([id, tally]): DescriptorRow => {
      const resolved = tally.byVerdict.resolved;
      return {
        id,
        kind: tally.kind,
        evidenceSource: tally.evidenceSource,
        consultations: tally.consultations,
        byVerdict: { ...tally.byVerdict },
        contributionRate: tally.consultations === 0 ? 0 : resolved / tally.consultations,
        unstableIn: (unstableByDescriptor.get(id) ?? []).slice().sort(),
        silentIn: [...tally.seenIn].filter((s) => !tally.resolvedIn.has(s)).sort(),
      };
    })
    .sort((a, b) => a.contributionRate - b.contributionRate || a.id.localeCompare(b.id));

  const flaky = perScenario.filter((s) => s.flaky).length;
  return {
    engine: engine.id,
    runs,
    perScenario,
    flakeRate: perScenario.length === 0 ? 0 : flaky / perScenario.length,
    nonDeterministic: perScenario.filter((s) => s.distinctResults > 1).map((s) => s.id),
    descriptors: descriptorRows,
    unstableDescriptors: [...unstableByDescriptor.keys()].sort(),
  };
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

const pad = (value: string, width: number): string =>
  value.length >= width ? value : value + " ".repeat(width - value.length);
const padLeft = (value: string, width: number): string =>
  value.length >= width ? value : " ".repeat(width - value.length) + value;

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;

/**
 * The whole report, including the descriptors that did NOT degrade.
 *
 * Printing every descriptor rather than only the interesting ones is deliberate: this table is
 * meant to be diffed between two commits, and a table that omits its healthy rows makes a
 * descriptor's disappearance look identical to its recovery.
 */
export function formatStability(report: StabilityReport): string {
  const lines: string[] = [];
  lines.push(`stability: ${report.engine} over ${report.runs} runs`);
  lines.push("-".repeat(104));

  for (const s of report.perScenario) {
    if (!s.flaky && s.distinctResults === 1) continue;
    const why = s.flaky
      ? `FLAKY  passed ${s.passed}/${report.runs}`
      : `VARIED ${s.distinctResults} distinct result documents`;
    lines.push(`  ${pad(s.id, 3)} ${pad(s.title, 84)} ${why}`);
  }
  lines.push(
    `${report.perScenario.length} scenarios x ${report.runs} runs: ` +
      `flake rate ${pct(report.flakeRate)}, ` +
      `${report.nonDeterministic.length} with a result document that was not byte-identical`,
  );

  lines.push("");
  lines.push("per-descriptor degradation");
  lines.push("-".repeat(104));
  lines.push(
    `${pad("descriptor", 26)} ${pad("kind", 21)} ${pad("evidence", 16)} ` +
      `${padLeft("used", 6)} ${padLeft("carried", 8)} ${pad("", 6)} silent in`,
  );
  for (const d of report.descriptors) {
    const flag = d.unstableIn.length > 0 ? "UNSTABLE" : "";
    lines.push(
      `${pad(d.id, 26)} ${pad(d.kind, 21)} ${pad(d.evidenceSource, 16)} ` +
        `${padLeft(String(d.consultations), 6)} ${padLeft(pct(d.contributionRate), 8)} ` +
        `${pad(flag, 6)} ${d.silentIn.join(",") || "-"}`,
    );
  }
  lines.push("-".repeat(104));
  lines.push(
    report.unstableDescriptors.length === 0
      ? "no descriptor changed its verdict between runs of the same scenario"
      : `UNSTABLE DESCRIPTORS: ${report.unstableDescriptors.join(", ")}`,
  );
  // The sentence that keeps the number honest. It is printed with the number rather than kept in a
  // README because the number is what gets copied out of a terminal into a slide.
  lines.push(
    "NOTE: this measures the engine over a FROZEN corpus on a manual clock. A fixture you control " +
      "cannot surprise you the way a real vendor app does; it bounds hidden state in the engine, " +
      "not flake in production.",
  );
  return lines.join("\n");
}
