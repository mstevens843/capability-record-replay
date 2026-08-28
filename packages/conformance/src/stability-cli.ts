// `pnpm -F @crr/conformance stability [runs]` - the suite, the kill matrix, the flake rate and the
// `stableSamples` measurement, printed with the command that produced them. No credentials, no
// network, no browser.
//
// Exits non-zero when the reference engine fails a scenario, when any mutant survives the whole
// suite, or when a scenario was FLAKY across the N runs, because all three mean the same thing to a
// reviewer: the numbers above are not trustworthy. A non-deterministic result document is included
// in that - it is the stricter of the two stability measures and the one the README's determinism
// claim rests on.
//
// The settle sweep does NOT gate the exit code. It is a measurement that produces a recommendation,
// not an assertion about the engine, and a measurement that can fail a build is a measurement
// somebody will eventually tune until it passes.

import { ALL_MUTANTS, REFERENCE_ENGINE } from "./engines/mutants.js";
import { buildKillMatrix, formatKillMatrix, formatReport, runConformance } from "./run.js";
import { formatSettleSweep, sweepStableSamples } from "./settle-sweep.js";
import { formatStability, measureStability } from "./stability.js";

const DEFAULT_RUNS = 20;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = Number.parseInt(argv[0] ?? String(DEFAULT_RUNS), 10);
  const runs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUNS;

  const report = await runConformance({ engine: REFERENCE_ENGINE });
  process.stdout.write(`${formatReport(report)}\n\n`);

  const matrix = await buildKillMatrix(ALL_MUTANTS);
  process.stdout.write(`${formatKillMatrix(matrix)}\n\n`);

  const stability = await measureStability(REFERENCE_ENGINE, runs);
  process.stdout.write(`${formatStability(stability)}\n\n`);

  const sweep = await sweepStableSamples(REFERENCE_ENGINE);
  process.stdout.write(`${formatSettleSweep(sweep)}\n`);

  const clean =
    report.passed &&
    matrix.survivors.length === 0 &&
    stability.flakeRate === 0 &&
    stability.nonDeterministic.length === 0 &&
    stability.unstableDescriptors.length === 0;
  return clean ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
