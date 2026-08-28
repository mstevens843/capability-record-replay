// THE `stableSamples` MEASUREMENT (OPEN-QUESTIONS-RESOLVED Q6, SPEC section 13 item 6).
//
// The spec shipped `SettlePolicy.stableSamples = 2` as an explicit PLACEHOLDER and refused to
// defend it, on the grounds that the slow-load and torn-read scenarios should decide it. This file
// is that decision procedure: it runs the same flow at several values of `stableSamples` against a
// ladder of quiescence faults, and reports which values are correct on which fault and what each
// one costs. It does not argue; it prints a matrix.
//
// WHAT `stableSamples` CAN AND CANNOT DO - the thing the matrix makes visible and prose does not.
//
// A settle loop accepts a screen when the driver says settled AND the last `stableSamples`
// skeleton digests are identical. Two very different faults get confused with each other here:
//
//   · THE SLOW LOAD. The grid frame is flushed with its banner before the rows exist, so the page
//     says "0 records found" and means "not yet". The DRIVER already knows - `settled: false` -
//     so no value of `stableSamples` is load-bearing for this case. It is in the sweep precisely to
//     show that, because "we raised stableSamples and the slow-load case still passes" is the kind
//     of evidence that gets misread as "raising it fixed something".
//   · THE TORN READ. A snapshot taken mid-repaint that claims `settled: true` and is internally
//     consistent. Nothing about it announces itself. `stableSamples = N` rejects a tear that
//     persists for at most N-1 consecutive polls and ACCEPTS one that persists for N. That is a
//     ladder, not a fix, and the `tear-persistent` row is in the sweep to keep it honest: a tear
//     that never clears is accepted at every value, and what catches it is the CHECKPOINT.
//
// So the question the sweep actually answers is narrow and answerable: HOW WIDE A TEAR SHOULD THE
// DEFAULT DEFEND AGAINST, given a measured tear width and a measured cost per increment. The
// widths in `TEAR_WIDTHS` are not invented - see `TEAR_EVIDENCE` below.
//
// COST IS COUNTED IN POLLS, NOT MILLISECONDS. The harness runs on a manual clock, so wall-clock
// elapsed time here is an arithmetic restatement of the poll count and would be a fake measurement
// dressed as a real one. A poll is a real `perceive()` and a real charge against the run's
// observation ledger, so the poll count is the honest unit - and on a real browser it is also the
// unit that multiplies out to seconds.

import { type MockTransition, type SettlePolicy, digestOf } from "@crr/core";
import { type HarnessOptions, runFlow } from "./corpus/harness.js";
import { IDS } from "./corpus/screens.js";
import { settledEvents } from "./journal-view.js";
import { armOf } from "./support.js";
import type { ReplayEngine } from "./types.js";

// ---------------------------------------------------------------------------------------------
// The evidence the tear widths come from
// ---------------------------------------------------------------------------------------------

/**
 * Where the tear widths in this sweep come from. Quoted, with its source, because a sweep over
 * invented widths would answer an invented question.
 *
 * `docs/design/spike-terminal-surface.md` section 4 records the ONLY torn read this project has
 * measured against a real surface. A repaint was delivered 55% complete and then the transport went
 * silent for 120 ms - TWICE the 60 ms quiet window the spike used as its quiescence signal. The
 * snapshot taken in that gap reported `screenId: null` and three nodes where the settled screen has
 * eight, and it claimed to be settled.
 *
 * Mapped onto a polling settle loop whose `pollIntervalMs` is one quiet window, that tear was
 * digest-stable across TWO consecutive polls. `stableSamples: 2` accepts it. That single measured
 * observation is the whole reason `tear-2` is in this matrix, and it is why the sweep's answer is
 * not the placeholder.
 */
export const TEAR_EVIDENCE =
  "docs/design/spike-terminal-surface.md section 4: a repaint delivered 55% complete then 120 ms of " +
  "silence - two 60 ms quiet windows - produced a snapshot claiming settled with 3 nodes where the " +
  "screen has 8. A tear that survives two consecutive quiet windows is digest-stable across two " +
  "consecutive polls, which stableSamples=2 accepts.";

/** The tear widths swept, in consecutive polls. 1 and 3 bracket the measured 2. */
export const TEAR_WIDTHS = [1, 2, 3] as const;

/** The values of `stableSamples` swept. 1 is the credulous engine `@crr/core`'s own mock-surface
 *  test already shows is fooled; 4 is one past the measured tear, to price the next increment. */
export const SWEPT_VALUES = [1, 2, 3, 4] as const;

// ---------------------------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------------------------

const SUBMIT = { kind: "click", target: IDS.searchButton } as const;

/** Replace the search-submit transition, leaving the rest of the happy path alone. */
const onSubmit = (patch: Omit<MockTransition, "from" | "on">): HarnessOptions["transitions"] => [
  { from: "search-ready", on: SUBMIT, ...patch },
  { from: "blank", on: { kind: "navigate", path: "/teller/search" }, to: "search" },
  { from: "search", on: { kind: "type", target: IDS.memberIdField }, to: "search-member" },
  { from: "search-member", on: { kind: "type", target: IDS.branchField }, to: "search-ready" },
  { from: "results", on: { kind: "click", target: IDS.openLink }, to: "detail" },
  { from: "detail", on: { kind: "click", target: IDS.sharesTab }, to: "detail-shares" },
  { on: { kind: "navigate", path: "/teller/search" }, to: "search" },
];

export interface SweepCase {
  readonly id: string;
  readonly title: string;
  /** The arm a correct engine returns, spelled the way `armOf` spells it. */
  readonly expect: string;
  /** What real condition this stands for. Printed with the matrix so a reader is not asked to
   *  reverse-engineer the fault from a transition list. */
  readonly standsFor: string;
  /**
   * `control` cases must be correct at ANY candidate value; `tear-ladder` cases must not be, and
   * treating them as a pass/fail floor would make the sweep circular.
   *
   * This distinction is the whole methodology. The tear ladder's widths were CHOSEN by this file,
   * so "the value that is correct on every case" would only ever mean "wider than the widest tear I
   * decided to put in the matrix" - a number derived from my own choice of test, dressed up as a
   * measurement. The ladder is here to establish the mechanical RELATIONSHIP between the setting
   * and the tear width it rejects; which tear width to actually defend against comes from
   * `TEAR_EVIDENCE`, which is a measurement of a real surface and not of this file.
   */
  readonly role: "control" | "tear-ladder";
  readonly transitions: HarnessOptions["transitions"];
}

/**
 * The ladder.
 *
 * `happy` is not padding: it is where the COST of a higher `stableSamples` is read off, because it
 * is the only case in which every step settles normally and the extra poll per step is pure tax.
 */
export const SWEEP_CASES: readonly SweepCase[] = [
  {
    id: "happy",
    title: "no fault - the tax every step pays",
    expect: "ok",
    role: "control",
    standsFor: "the baseline. Cost, not correctness.",
    transitions: undefined,
  },
  {
    id: "slow-load",
    role: "control",
    title: "the grid shell says '0 records found' for two polls and means 'not yet'",
    expect: "ok",
    standsFor:
      "fixtures/corebank-web fault `slow-load`. The DRIVER reports settled:false, so this case " +
      "is decided before stableSamples is consulted.",
    transitions: onSubmit({
      to: "results",
      via: [{ kind: "screen", screen: "results-loading", times: 2 }],
    }),
  },
  {
    id: "never-settles",
    role: "control",
    title: "the grid never settles at all",
    expect: "failed:did-not-settle",
    standsFor:
      "fault `slow-load` beyond the settle budget. The control for the whole sweep: a higher " +
      "stableSamples must not turn a screen that never arrives into one that did.",
    transitions: onSubmit({ to: "results", via: [{ kind: "stall", screen: "results-loading" }] }),
  },
  ...TEAR_WIDTHS.map(
    (width): SweepCase => ({
      id: `tear-${width}`,
      role: "tear-ladder",
      title: `a torn read that claims settled, for ${width} consecutive poll${width === 1 ? "" : "s"}`,
      expect: "ok",
      standsFor:
        width === 2
          ? "THE MEASURED WIDTH. See TEAR_EVIDENCE - the one torn read this project observed " +
            "against a real surface was digest-stable for two consecutive quiet windows."
          : `a tear ${width < 2 ? "narrower" : "wider"} than the measured one, to bracket it.`,
      transitions: onSubmit({
        to: "results",
        via: [{ kind: "screen", screen: "results-torn", times: width }],
      }),
    }),
  ),
  {
    id: "tear-persistent",
    role: "control",
    title: "a torn read that never clears",
    expect: "failed:checkpoint-failed",
    standsFor:
      "fault `torn-render`. THE HONESTY CONTROL: no value of stableSamples rescues this, and a " +
      "sweep that did not include it would let 'we raised it to 3' read as 'torn reads are solved'.",
    transitions: onSubmit({ to: "results-torn" }),
  },
];

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------

export interface SweepCell {
  readonly caseId: string;
  readonly stableSamples: number;
  readonly arm: string;
  readonly correct: boolean;
  /** Total `perceive()` calls charged by every settle loop in the run. The cost unit. */
  readonly polls: number;
  /** How many settle loops ran. `polls / settles` is the per-step cost. */
  readonly settles: number;
  /** Set when the run threw rather than returning an arm. */
  readonly error?: string;
}

export interface SweepValueRow {
  readonly stableSamples: number;
  /** Correct on the CONTROL cases: the ones any candidate value has to get right. */
  readonly controlsCorrect: number;
  readonly controlsTotal: number;
  /** Polls on the `happy` case: the tax a healthy run pays at this value. */
  readonly happyPathPolls: number;
  /** Settle loops on the `happy` case, so the per-step cost is a division a reader can check. */
  readonly happyPathSettles: number;
  /**
   * The widest tear this value rejected, counted CONSECUTIVELY from 1.
   *
   * Consecutively, not as a maximum: a value that rejected a 3-poll tear while accepting a 2-poll
   * one would have no coherent "rejects up to" property at all, and reporting the maximum would
   * paper over exactly that incoherence instead of surfacing it as a 0.
   */
  readonly rejectsTearsUpTo: number;
}

export interface SettleSweepReport {
  readonly engine: string;
  readonly values: readonly number[];
  readonly cases: readonly SweepCase[];
  readonly cells: readonly SweepCell[];
  readonly perValue: readonly SweepValueRow[];
  /**
   * The value the evidence supports: the smallest swept value that is correct on every CONTROL case
   * and rejects a tear at least as wide as the one `TEAR_EVIDENCE` records. `null` when none does.
   *
   * Derived here rather than written down, so the recommendation cannot drift away from the matrix
   * printed above it. If someone changes a scenario and the answer moves, the answer moves.
   */
  readonly supportedByEvidence: number | null;
  /** The measured tear width `supportedByEvidence` is anchored to. */
  readonly measuredTearWidth: number;
  /**
   * TRUE when every swept value rejected exactly `n - 1` consecutive polls of tear.
   *
   * The matrix is seven rows of data; this is the LAW it implies, and stating it as a field means a
   * test can assert the law instead of pinning the seven numbers. A false here means the sweep found
   * something more interesting than a recommendation.
   */
  readonly ladderIsLinear: boolean;
}

const MEASURED_TEAR_WIDTH = 2;

async function cell(
  engine: ReplayEngine,
  sweepCase: SweepCase,
  stableSamples: number,
): Promise<SweepCell> {
  const settle: Partial<SettlePolicy> = { stableSamples };
  try {
    const { out } = await runFlow(engine, {
      settle,
      ...(sweepCase.transitions === undefined ? {} : { transitions: sweepCase.transitions }),
    });
    const arm = armOf(out.result);
    const settles = settledEvents(out.journal.events);
    return {
      caseId: sweepCase.id,
      stableSamples,
      arm,
      correct: arm === sweepCase.expect,
      polls: settles.reduce((sum, e) => sum + e.polls, 0),
      settles: settles.length,
    };
  } catch (cause) {
    return {
      caseId: sweepCase.id,
      stableSamples,
      arm: "threw",
      correct: false,
      polls: 0,
      settles: 0,
      error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
    };
  }
}

/**
 * Run every case at every value.
 *
 * Takes the engine so the sweep can be pointed at a mutant too. That is not decoration: pointing it
 * at `noSettleGate` is how you check the sweep is measuring the settle loop and not something else
 * that happens to correlate with it.
 */
export async function sweepStableSamples(
  engine: ReplayEngine,
  values: readonly number[] = SWEPT_VALUES,
): Promise<SettleSweepReport> {
  const cells: SweepCell[] = [];
  for (const value of values) {
    for (const sweepCase of SWEEP_CASES) cells.push(await cell(engine, sweepCase, value));
  }

  const controls = SWEEP_CASES.filter((c) => c.role === "control").map((c) => c.id);

  const perValue: SweepValueRow[] = values.map((value) => {
    const mine = cells.filter((c) => c.stableSamples === value);
    const happy = mine.find((c) => c.caseId === "happy");
    const rejected = TEAR_WIDTHS.filter(
      (width) => mine.find((c) => c.caseId === `tear-${width}`)?.correct === true,
    );
    return {
      stableSamples: value,
      controlsCorrect: mine.filter((c) => controls.includes(c.caseId) && c.correct).length,
      controlsTotal: controls.length,
      happyPathPolls: happy?.polls ?? 0,
      happyPathSettles: happy?.settles ?? 0,
      rejectsTearsUpTo: TEAR_WIDTHS.reduce(
        (upTo, width) => (upTo === width - 1 && rejected.includes(width) ? width : upTo),
        0,
      ),
    };
  });

  const supported = perValue
    .filter(
      (v) => v.controlsCorrect === v.controlsTotal && v.rejectsTearsUpTo >= MEASURED_TEAR_WIDTH,
    )
    .map((v) => v.stableSamples);

  return {
    engine: engine.id,
    values,
    cases: SWEEP_CASES,
    cells,
    perValue,
    supportedByEvidence: supported.length === 0 ? null : Math.min(...supported),
    measuredTearWidth: MEASURED_TEAR_WIDTH,
    // Only meaningful when the sweep covers a tear at least as wide as the largest value minus one;
    // outside that range a value cannot demonstrate its own ceiling and the law is not under test.
    ladderIsLinear: perValue.every(
      (v) =>
        v.stableSamples - 1 > Math.max(...TEAR_WIDTHS) ||
        v.rejectsTearsUpTo === Math.min(v.stableSamples - 1, Math.max(...TEAR_WIDTHS)),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

const pad = (v: string, w: number): string => (v.length >= w ? v : v + " ".repeat(w - v.length));
const padLeft = (v: string, w: number): string =>
  v.length >= w ? v : " ".repeat(w - v.length) + v;

export function formatSettleSweep(report: SettleSweepReport): string {
  const lines: string[] = [];
  lines.push(`SettlePolicy.stableSamples sweep - engine: ${report.engine}`);
  lines.push("-".repeat(104));
  lines.push(
    `${pad("case", 18)} ${pad("expected", 26)} ${report.values
      .map((v) => padLeft(`n=${v}`, 16))
      .join("")}`,
  );
  for (const sweepCase of report.cases) {
    const row = report.values.map((v) => {
      const c = report.cells.find((x) => x.caseId === sweepCase.id && x.stableSamples === v);
      if (c === undefined) return padLeft("-", 16);
      return padLeft(`${c.correct ? "ok" : "WRONG"} ${c.polls}p`, 16);
    });
    lines.push(`${pad(sweepCase.id, 18)} ${pad(sweepCase.expect, 26)} ${row.join("")}`);
    for (const v of report.values) {
      const c = report.cells.find((x) => x.caseId === sweepCase.id && x.stableSamples === v);
      if (c === undefined || c.correct) continue;
      lines.push(`${" ".repeat(19)} n=${v} returned ${c.arm}${c.error ? ` (${c.error})` : ""}`);
    }
  }
  lines.push("-".repeat(104));
  lines.push(
    `${pad("value", 8)} ${pad("controls", 10)} ${pad("happy-path cost", 30)} rejects tears up to`,
  );
  for (const v of report.perValue) {
    const perStep =
      v.happyPathSettles === 0
        ? "-"
        : `${v.happyPathPolls}p / ${v.happyPathSettles} settles = ${(
            v.happyPathPolls / v.happyPathSettles
          ).toFixed(1)}/step`;
    lines.push(
      `${pad(`n=${v.stableSamples}`, 8)} ${pad(`${v.controlsCorrect}/${v.controlsTotal}`, 10)} ` +
        `${pad(perStep, 30)} ${v.rejectsTearsUpTo} consecutive polls`,
    );
  }
  lines.push("-".repeat(104));
  lines.push(
    report.ladderIsLinear
      ? "LAW: stableSamples = n rejects a tear of up to n-1 consecutive polls, and no more. Every " +
          "swept value obeyed it."
      : "the ladder is NOT linear in this run - read the matrix rather than any recommendation below.",
  );
  lines.push(`measured tear width: ${report.measuredTearWidth} consecutive polls`);
  lines.push(`  evidence: ${TEAR_EVIDENCE}`);
  lines.push(
    report.supportedByEvidence === null
      ? "NO SWEPT VALUE both passes every control case and rejects a tear of the measured width."
      : [
          `THE EVIDENCE SUPPORTS stableSamples = ${report.supportedByEvidence}:`,
          "the smallest value that is correct on every control case and rejects a tear as wide as",
          "the one that was actually measured. Values above it defend a tear width nobody here has",
          "observed.",
        ].join(" "),
  );
  lines.push(
    "AND THE LIMIT: `tear-persistent` is caught at EVERY value, by the checkpoint rather than by " +
      "the settle loop. Raising stableSamples buys one more poll of tear rejected per extra poll " +
      "per step; it does not turn quiescence into a readiness signal, and no value of it would.",
  );
  return lines.join("\n");
}

/** A digest over the matrix's decisions, so a change in the measurement is a visible diff rather
 *  than a number that quietly moved between two commits. */
export function sweepDigest(report: SettleSweepReport): string {
  return digestOf(
    report.cells.map((c) => [c.caseId, c.stableSamples, c.arm, c.polls] as const),
  ) as string;
}
