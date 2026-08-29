// Which file each redaction pass covers, and which class of value it looks for there.
//
// WHY THIS IS A MODULE AND NOT SIXTY LINES INSIDE `discover.ts`.
//
// The same reason `bundle.ts` is one. The runner is a script with top-level `await` and
// `process.exit` in it, so nothing can import it, so nothing could assert which files the canary
// actually reads. That is not an abstract worry: FINAL-STATUS section 7.2 records a real gap that
// survived precisely because the scopes were four opaque `skip` closures in the middle of a script
// - `provenance.json` was in the credential pass and in no other, and the only way to find that out
// was to read the closures and hold the bundle's file list in your head at the same time.
//
// A pass is DATA here: an id, a scope predicate, a needle class, and whether it gates. That makes
// the one question worth asking - "which gating pass would catch a member's name in THIS file?" -
// something a test can answer for every file in a bundle, which is what `test/canary-scopes.test.ts`
// does. The scan itself stays in `@crr/runtime`; this module only decides where it points.
//
// -------------------------------------------------------------------------------------------
// THE FIVE SCOPES, AND WHY THEY DIFFER
// -------------------------------------------------------------------------------------------
//
// A single whole-bundle grep for the member number is the check everybody reaches for first, and on
// this deliverable it is unanswerable: the model had to be TOLD which member to look up, it typed
// the number, and the application printed it back in the results grid and in its own query string.
// A discovery recording that did not contain the member number would be a recording of a different
// conversation. So the question is not "does this value appear" but "does it appear anywhere it was
// promised not to", and the five scopes below are that question asked five ways.
//
// There are exactly TWO classes of value in play and keeping them apart is the whole design:
//
//   THE CALLER'S ARGUMENT - the member number the goal supplied. It is legitimately present in the
//   recording (pass 4), and legitimately printed as a plain field by `provenance.json` and the
//   bundle README, which is why passes 4 and 5 do not gate on it and pass 5 does not search for it
//   at all. It must not be in a synthesized document (pass 1) or in anything the verification
//   replay wrote (pass 2), where it is a bound `TaintedValue` and SPEC 8.3's sink table applies.
//
//   RECORDED MEMBER DATA - a member's name, their balance, their status: values the run read OFF
//   THE SCREEN. These were never arguments, so parameterization has nothing to substitute and the
//   taint model has no opinion about them (`prose.ts` argues this at length). They are legitimate
//   in exactly two places, both of which say so in the bundle's own README: the RECORDING, because
//   the model was shown the screen, and the REPLAY RESULT, because they are the outputs the caller
//   asked the capability for. They are legitimate in NO document the system writes ABOUT the run.
//
// PASS 1 - THE SYNTHESIZED DOCUMENTS. `synthesized/` only. Needles: BOTH classes. GATES. This is
// BRIEF section 3.6 - "the artifact stores shapes, never values" - and it is the pass that catches
// the class of defect FINAL-STATUS records twice: `deriveOutputs` folding a cell's accessible name
// into the query it derived, which put a member's name and balance into `flow.vocabulary`, the one
// document that is committed, diffed and SIGNED; and the synthesis report quoting the model's
// closing prose verbatim. Parameterization could not have caught either - the name was never in the
// goal, so it was never bound - which is exactly why this pass searches for values the taint model
// has no opinion about.
//
// PASS 2 - THE REPLAY. Everything the verification replay wrote. Needles: the caller's argument.
// GATES. At REPLAY time that number is an argument the interpreter binds as a `TaintedValue`, so
// SPEC section 8.3's table applies in full: it reaches the driver and the caller's typed outputs,
// and it reaches the journal, the evidence captures and the result document never. Unlike the
// discovery half, this claim is total, and this pass is what makes it checkable. It deliberately
// does NOT search for recorded member data: a replay RESULT is the outputs the caller asked for, so
// `verification.json` holds the member's name and balance by design and always will.
//
// PASS 3 - CREDENTIAL SHAPES, over the whole bundle, with no value needles at all. GATES. A key in
// an evidence file is a finding regardless of what any parameter was bound to, and this is the one
// pass that covers `transcript.json` - the file most likely to hold a stray header - completely.
//
// PASS 4 - THE DISCOVERY RECORDING. `transcript.json`, `discovery.log`, `journal.jsonl`. Needles:
// the caller's argument. REPORTED WITH EVERY LINE, AND DELIBERATELY NOT GATED. Every hit here is
// the model being told, or typing, or being shown, the member number it was asked about. Listing
// them with their line numbers is what makes that claim checkable by a reader rather than asserted
// by a comment; gating on them would make the check unpassable and therefore meaningless.
//
// PASS 5 - THE RUN'S OWN ACCOUNT OF ITSELF. Everything else: `provenance.json`, `spend.json` and
// the bundle README today, and anything added beside them tomorrow, because the scope is the
// COMPLEMENT of the other four rather than a list somebody has to remember to extend. Needles:
// recorded member data. GATES.
//
// This pass exists because of FINAL-STATUS section 7.2, and the gap it closes is worth stating
// exactly. `provenance.json` was in pass 3's scope and no other, so it was checked for credential
// shapes and never for member data. That exemption was designed around the CALLER'S ARGUMENT - the
// file states the member number the goal supplied as a plain field, deliberately, and gating on it
// would make the pass unpassable for the same reason pass 4 is not gated. It was never meant to
// cover the member's NAME AND BALANCE, which is exactly what a `finish.summary` like "the results
// table returned one match: <name>, share balance <amount>" puts there. The writer was fixed -
// `bundle.ts` puts `run.summary` through `scrubProse` - and this is the gate that says so, rather
// than a fix nothing checks.
//
// Two things this pass does NOT do, both deliberate:
//
//   It does not search for the caller's argument. `provenance.json` prints it as `memberId` and
//   inside `goal`, and the bundle README names it in a sentence explaining where it is and is not.
//   Gating on a value three files state on purpose is how a canary gets switched off.
//
//   It does not cover `canary/`. Those files are the canary's own report on the OTHER passes, and
//   they do not exist yet when the passes run - the runner writes them afterwards, from the results.
//   Their content is excerpts of the files pass 4 covers, so they belong to pass 4's scope and its
//   argument, not to this one. `KNOWN_UNSCANNED` names the exclusion so it is ledgered rather than
//   silent, and `test/canary-scopes.test.ts` fails if any other path ever falls through all five.

import type { DiscoveryRun } from "../src/loop.js";

// ---------------------------------------------------------------------------------------------
// The scan, as this module needs it
// ---------------------------------------------------------------------------------------------

/** A hit, as the report prints it. The LABEL of the secret, never its value. */
export interface CanaryHitView {
  readonly file: string;
  readonly view: string;
  readonly secret: string;
  readonly encoding: string;
  readonly line: number | null;
}

export interface CanaryReportView {
  readonly clean: boolean;
  readonly filesScanned: number;
  readonly bytesScanned: number;
  readonly needles: number;
  readonly skippedEncodings: readonly string[];
  readonly hits: readonly CanaryHitView[];
  readonly suppressed: readonly CanaryHitView[];
  readonly forbidden: readonly { readonly file: string; readonly name: string }[];
  readonly selfTest: { readonly ok: boolean; readonly planted: number; readonly found: number };
}

/**
 * `@crr/runtime`'s `runRedactionCanary`, structurally.
 *
 * Injected rather than imported for the reason `discover.ts`'s header gives: `@crr/discovery`
 * declares no dependency on `@crr/runtime` and must not, so the runner resolves it by path at
 * startup and hands it in. The seam is also what lets a test run these scopes over a bundle it
 * built itself.
 */
export type CanaryScan = (options: {
  readonly bundleDir: string;
  readonly secrets: readonly CanarySecretView[];
  readonly skip?: (relativePath: string) => boolean;
}) => CanaryReportView;

export interface CanarySecretView {
  readonly label: string;
  readonly value: string;
}

// ---------------------------------------------------------------------------------------------
// The needle classes
// ---------------------------------------------------------------------------------------------

/**
 * What a pass looks for. See the header: the distinction between the two value classes is the whole
 * reason the scopes differ, so it is a type rather than a comment on a closure.
 */
export type NeedleClass =
  /** The member number the goal supplied. A bound `TaintedValue` at replay time. */
  | "caller-argument"
  /** A value the run read off the screen. Never an argument, so never substitutable. */
  | "recorded-member-data"
  /** Credential SHAPES only - no value needles at all. */
  | "credential-shapes";

/**
 * The shortest recorded screen value that makes a usable canary needle.
 *
 * A six-letter status like `ACTIVE` is a word, not a fingerprint: it appears in ordinary schema
 * vocabulary and a canary with false positives is a canary somebody switches off. Values below this
 * length are NOT searched, and the runner prints which ones it skipped rather than quietly
 * narrowing its own coverage claim.
 *
 * IT IS NOT `prose.ts`'s `MIN_OBSERVED_NEEDLE_LENGTH`, WHICH IS 4, AND THE DIFFERENCE IS LOAD-
 * BEARING RATHER THAN AN OVERSIGHT. Withholding a sentence over a coincidence costs a reader one
 * trip to the transcript, so synthesis can afford to be over-eager. Failing the build over one
 * costs the run, so this floor has to be a fingerprint.
 *
 * THE LIVE BUNDLE MAKES THE COST OF LOWERING IT MEASURABLE RATHER THAN ARGUABLE. `membershipStatus`
 * was `ACTIVE`, and `synthesized/report.json` deliberately KEEPS `MEMBER_FOUND_ACTIVE`: an observed
 * value cannot be substituted into a symbolic outcome code and leave something that is still a legal
 * code, so the code survives and an `outcome-code-carries-recorded-value` note at `review` severity
 * says so. Re-running these five passes over `evidence/discovery-live` with the floor at 4 and
 * nothing else changed:
 *
 *     pass 1 documents  FAILED  4 hits, all synthesized/report.json, all `membershipStatus`
 *                               (lines 63, 68, 73, 83 - the three review notes and the candidate's
 *                               own `code`, every one of them the string MEMBER_FOUND_ACTIVE)
 *     pass 5 metadata   CLEAN   0 hits
 *
 * So the two floors are not one judgement wearing two hats: at 4 the gating pass fails the build on
 * the subject of a note whose whole purpose is to say the value was deliberately kept. FINAL-STATUS
 * section 7.3 is still right that the gap is real in the other direction - a five-, six- or
 * seven-character observed value in a document synthesis did not scrub would ship CLEAN - and
 * closing it properly means teaching pass 1 to exempt a `SCREAMING_SNAKE` token the report already
 * flagged, not moving a number.
 */
export const MIN_NEEDLE_LENGTH = 8;

/** One value the bundle must not contain, plus the class it belongs to. */
export interface ClassifiedSecret extends CanarySecretView {
  readonly needleClass: NeedleClass;
}

/** An output whose recorded value was too short to be a needle. Named, with its length. */
export interface UnsearchedOutput {
  readonly output: string;
  readonly length: number;
  readonly why: string;
}

export interface CanaryNeedles {
  readonly callerArgument: readonly ClassifiedSecret[];
  readonly recordedMemberData: readonly ClassifiedSecret[];
  /** The honesty half: outputs no pass searches for, and why. Printed, never dropped. */
  readonly notSearched: readonly UnsearchedOutput[];
}

/**
 * The needles, derived from what the run actually recorded.
 *
 * The member data comes from the OBSERVATION each `note_output` was made against, resolved through
 * the node the model named - so these are the bytes that were on the screen, not the typed values
 * the contract later declares. That matters: the screen said `15,900.00` and the contract says
 * `15900.00`, and only the first is a needle here, because a document that leaked the datum leaked
 * what was displayed.
 */
export function canaryNeedlesOf(input: {
  readonly run: DiscoveryRun;
  readonly memberId: string;
}): CanaryNeedles {
  const notSearched: UnsearchedOutput[] = [];
  const recordedMemberData: ClassifiedSecret[] = [];

  for (const output of input.run.outputs) {
    const node = output.observation.nodes.find((candidate) => candidate.id === output.nodeId);
    const value = node === undefined ? "" : (node.value ?? node.name ?? node.text ?? "");
    if (value.length < MIN_NEEDLE_LENGTH) {
      notSearched.push({
        output: output.outputName,
        length: value.length,
        why: `${output.outputName}: ${value.length} characters, under the ${MIN_NEEDLE_LENGTH}-character floor for a distinctive needle`,
      });
      continue;
    }
    recordedMemberData.push({
      label: `recorded member datum / ${output.outputName} (read off the screen)`,
      value,
      needleClass: "recorded-member-data",
    });
  }

  return {
    callerArgument: [
      {
        label: "the goal's member number (the caller's argument)",
        value: input.memberId,
        needleClass: "caller-argument",
      },
    ],
    recordedMemberData,
    notSearched,
  };
}

// ---------------------------------------------------------------------------------------------
// The scopes
// ---------------------------------------------------------------------------------------------

/** The recording of the discovery conversation, as opposed to everything the system derived from
 *  it. The distinction is the whole basis of pass 4's scope. */
export const RECORDING_FILES: ReadonlySet<string> = new Set([
  "transcript.json",
  "discovery.log",
  "journal.jsonl",
]);

/** Everything the verification replay wrote. One prefix, so a new capture file is covered. */
export const REPLAY_PREFIX = "verification";

/** The synthesized documents. */
export const SYNTHESIZED_PREFIX = "synthesized/";

/**
 * The canary's own reports, and the ONLY thing pass 5's complement deliberately does not reach.
 *
 * Ledgered here rather than expressed as one more `!path.startsWith(...)` inside pass 5, because a
 * hole in a total scope has to be visible from outside it. `test/canary-scopes.test.ts` asserts
 * that the five scopes plus this one set cover every path in a bundle, so adding to this list is
 * the only way to make a file unscanned and it cannot be done quietly.
 *
 * The argument, in full: these files do not exist when the passes run - the runner writes them
 * afterwards, from the reports the passes return - so on a live run the scope would be empty and
 * the gate vacuous. And their content is context excerpts of the files pass 4 covers, which means
 * they inherit pass 4's scope and pass 4's argument rather than pass 5's.
 */
export const KNOWN_UNSCANNED: readonly { readonly prefix: string; readonly why: string }[] = [
  {
    prefix: "canary/",
    why: "written AFTER the passes run, from their own results; the excerpts in them quote the recording files pass 4 covers, so they inherit that pass's scope and its argument",
  },
];

export interface CanaryScope {
  /** `"<n> <slug>"`. The slug names `canary/<slug>.json`, so it may not contain a space. */
  readonly id: string;
  readonly title: string;
  readonly why: string;
  /** Whether a hit in this pass fails the run. See the header for why two passes do not. */
  readonly gates: boolean;
  readonly needleClasses: readonly NeedleClass[];
  /** True when this pass reads the file at `relativePath` (POSIX separators, bundle-relative). */
  readonly covers: (relativePath: string) => boolean;
}

const isRecording = (path: string): boolean => RECORDING_FILES.has(path);
const isSynthesized = (path: string): boolean => path.startsWith(SYNTHESIZED_PREFIX);
const isReplay = (path: string): boolean => path.startsWith(REPLAY_PREFIX);
const isKnownUnscanned = (path: string): boolean =>
  KNOWN_UNSCANNED.some((entry) => path.startsWith(entry.prefix));

/**
 * Everything that is not the recording, not the replay, not a synthesized document, and not the
 * canary's own report on the other four.
 *
 * A COMPLEMENT RATHER THAN A LIST, and that is the point of pass 5 rather than an implementation
 * detail. A list would have to be extended by whoever adds the next file the runner writes about
 * the run, and the failure mode of forgetting is silence - which is exactly the failure mode
 * section 7.2 describes. With a complement, forgetting means the new file is SCANNED, and the
 * person who wanted it exempt has to come here and say why in `KNOWN_UNSCANNED`.
 */
export const isRunMetadata = (path: string): boolean =>
  !isRecording(path) && !isSynthesized(path) && !isReplay(path) && !isKnownUnscanned(path);

export const CANARY_SCOPES: readonly CanaryScope[] = [
  {
    id: "1 documents",
    title: "the synthesized documents",
    why: "BRIEF 3.6: an artifact stores shapes, never values - neither the caller's nor the member's",
    gates: true,
    needleClasses: ["caller-argument", "recorded-member-data"],
    covers: isSynthesized,
  },
  {
    id: "2 replay",
    title: "everything the verification replay wrote",
    why: "SPEC 8.3: at replay time the caller's argument is a bound value, and this claim is total",
    gates: true,
    needleClasses: ["caller-argument"],
    covers: isReplay,
  },
  {
    id: "3 credentials",
    title: "the whole bundle, credential shapes only",
    why: "a key in an evidence file is a finding whatever any parameter was bound to",
    gates: true,
    needleClasses: ["credential-shapes"],
    covers: () => true,
  },
  {
    id: "4 recording",
    title: "the discovery recording (reported, not gated)",
    why: "the model was told the number, typed it, and was shown it; every hit below is one of those",
    gates: false,
    needleClasses: ["caller-argument"],
    covers: isRecording,
  },
  {
    id: "5 metadata",
    title: "the run's own account of itself",
    why: "provenance, the ledger and this bundle's README describe the run; a value read off a member's screen belongs in none of them",
    gates: true,
    needleClasses: ["recorded-member-data"],
    covers: isRunMetadata,
  },
];

/**
 * The gating passes that would catch RECORDED MEMBER DATA in a file, by relative path.
 *
 * Exported because it is the question section 7.2 was really asking, and a test can now ask it of
 * every file in a bundle instead of a reader holding four closures in their head.
 */
export function gatingMemberDataScopesFor(relativePath: string): readonly CanaryScope[] {
  return CANARY_SCOPES.filter(
    (scope) =>
      scope.gates &&
      scope.needleClasses.includes("recorded-member-data") &&
      scope.covers(relativePath),
  );
}

// ---------------------------------------------------------------------------------------------
// Running them
// ---------------------------------------------------------------------------------------------

export interface CanaryPass {
  readonly id: string;
  readonly title: string;
  readonly why: string;
  readonly gates: boolean;
  readonly report: CanaryReportView;
}

export interface CanaryOutcome {
  readonly clean: boolean;
  readonly passes: readonly CanaryPass[];
  /** One line per output no pass searched for, and why. */
  readonly notSearched: readonly string[];
}

/**
 * Five passes over what was just written, four of them gating.
 *
 * `clean` is the publish gate and it reads only the gating passes, so pass 4's 49 expected hits
 * cannot fail a run and a hit in any of the other four always does.
 */
export function runCanaryPasses(input: {
  readonly scan: CanaryScan;
  readonly bundleDir: string;
  readonly needles: CanaryNeedles;
}): CanaryOutcome {
  const byClass: Record<NeedleClass, readonly ClassifiedSecret[]> = {
    "caller-argument": input.needles.callerArgument,
    "recorded-member-data": input.needles.recordedMemberData,
    "credential-shapes": [],
  };

  const passes = CANARY_SCOPES.map((scope) => ({
    id: scope.id,
    title: scope.title,
    why: scope.why,
    gates: scope.gates,
    report: input.scan({
      bundleDir: input.bundleDir,
      secrets: scope.needleClasses.flatMap((needleClass) => byClass[needleClass]),
      skip: (path) => !scope.covers(path),
    }),
  }));

  return {
    clean: passes.every((pass) => !pass.gates || pass.report.clean),
    passes,
    notSearched: input.needles.notSearched.map((entry) => entry.why),
  };
}
