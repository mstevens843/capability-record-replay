// The public surface of `@crr/conformance`.
//
// Curated by hand rather than `export *`. This list IS the API: what an integrator points at their
// own engine, plus the negative controls - because the claim "this suite discriminates" is only
// checkable if the things it discriminates against ship with it.

// -- running the suite ---------------------------------------------------------------------------
export {
  buildKillMatrix,
  formatKillMatrix,
  formatReport,
  matchesSelector,
  runConformance,
  selectScenarios,
} from "./run.js";
export { formatStability, measureStability } from "./stability.js";

// -- multi-run stability and the settle measurement (SPEC section 11 unit 22) ---------------------
export {
  SWEEP_CASES,
  SWEPT_VALUES,
  TEAR_EVIDENCE,
  TEAR_WIDTHS,
  formatSettleSweep,
  sweepDigest,
  sweepStableSamples,
} from "./settle-sweep.js";

// -- reading a run's journal back, for a measurement that needs more than the arm -----------------
export { checkpointEvents, resolvedEvents, settledEvents } from "./journal-view.js";

// -- the scenarios -------------------------------------------------------------------------------
export { ALL_SCENARIOS, SCENARIOS_BY_ID } from "./scenarios/index.js";

// -- the corpus, so a scenario of your own can be written against the same screens ----------------
export { HAPPY_PATH, runFlow } from "./corpus/harness.js";
export {
  ACCOUNTS,
  ACCOUNTS_SCOPE,
  ACCOUNTS_TABLE_SCOPE,
  ABEND,
  INQUIRY,
  INQUIRY_SCOPE,
  SIGNON,
  SIGNON_SCOPE,
  ABEND_SCOPE,
  TERMINAL_ORIGIN,
  riverbendOverlay,
  summitOverlay,
  terminalAllowlist,
  terminalArtifact,
  terminalContract,
  terminalTrust,
} from "./corpus/terminal.js";
export { allowlist, artifact, contract, trust } from "./corpus/flow.js";
export { IDS, MEMBER_ID, screens } from "./corpus/screens.js";
export { exact, node, screen, token } from "./corpus/build.js";

// -- the negative controls -----------------------------------------------------------------------
export {
  ALL_MUTANTS,
  REFERENCE_ENGINE,
  checkpointFirst,
  countQuorum,
  firstMatch,
  nearestMatch,
  noAssert,
  noContinuity,
  noDelta,
  noProvenance,
  noSettleGate,
} from "./engines/mutants.js";

// -- helpers for writing your own scenarios ------------------------------------------------------
export { armOf, checkResult, gradeScenario, isFalseSuccess } from "./support.js";

// -- types ---------------------------------------------------------------------------------------
export type {
  CheckResult,
  ConformanceReport,
  Expectation,
  ReplayEngine,
  Scenario,
  ScenarioObservation,
  ScenarioResult,
} from "./types.js";
export type { HarnessOptions, HarnessRun } from "./corpus/harness.js";
export type { FlowOptions } from "./corpus/flow.js";
// The green-screen DOCUMENTS ship; the wiring that drives a real 80x24 surface does not, because
// `src/` may not import a driver (`@crr/core`'s no-locator-vocabulary contract test). The harness
// and the terminal scenarios live in `test/terminal/`.
export type { TerminalFlowOptions } from "./corpus/terminal.js";
export type { Mutant } from "./engines/mutants.js";
export type { KillMatrix, KillRow, RunConformanceOptions } from "./run.js";
export type { DescriptorRow, StabilityReport, StabilityScenarioRow } from "./stability.js";
export type {
  SettleSweepReport,
  SweepCase,
  SweepCell,
  SweepValueRow,
} from "./settle-sweep.js";
export type {
  CheckpointEvent,
  DescriptorOutcome,
  ResolvedEvent,
  SettledEvent,
} from "./journal-view.js";
