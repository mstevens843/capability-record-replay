// The four files a run must not lose, written by one named function.
//
// WHY THIS IS A MODULE AND NOT FORTY LINES INSIDE `discover.ts`.
//
// `docs/design/LIVE-RUN-READINESS.md` section 5.2 described the defect this file closes: a mid-run
// provider error propagated out of `runDiscoveryLoop`, `discover.ts`'s outer catch printed FAILED
// and exited 1, and at that point `transcript.json`, `spend.json`, `provenance.json` and
// `README.md` had never been written - because every one of them is written after the loop
// returns. The turns had been paid for and the conversation was gone.
//
// `src/loop.ts` fixes the throwing half (see `onUnexpectedError`). This module fixes the half that
// could not otherwise be checked: the runner is a script with top-level `await` and `process.exit`
// in it, so nothing can import it and nothing can assert that the bytes reach the disk. A function
// can be imported, so `test/loop-failure.test.ts` runs a real failing discovery loop and then
// asserts these files exist, with these contents, in a temporary directory - which is the whole
// claim section 5.2 asks for. A recovery path with no test is not a recovery path.
//
// It is deliberately only the FOUR. `synthesized/`, `verification.json` and the canary reports are
// written by the runner where they are produced, because they only exist on a run that reached the
// goal - a failed run has nothing to put in them, and a function that took eight nullable
// arguments to write two files would be harder to check than the thing it replaced.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DiscoveryRun } from "../src/loop.js";
import type { Transcript } from "../src/transcript.js";
import { LIVE_GOAL, LIVE_MEMBER_ID, type ModelRate, SPEND_CAP_USD } from "./live-run.js";

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

export function writeText(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** One turn's cost, as the ledger recorded it. Lives here because `spend.json` is its file. */
export interface TurnCost {
  readonly turn: number;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheCreationInputTokens: number;
    readonly cacheReadInputTokens: number;
  };
  readonly turnUsd: number;
  readonly runUsd: number;
  readonly stopReason: string | null;
  readonly latencyMs: number;
}

/**
 * What the ledger knows, as this module needs it.
 *
 * Structural rather than the `SpendLedger` class itself, so that the ledger stays in the runner
 * next to the guard that consults it and this module cannot accidentally start doing arithmetic
 * with money. `SpendLedger` satisfies this by having the three members; nothing had to be changed
 * to make it fit.
 */
export interface SpendSnapshot {
  readonly spentUsd: number;
  readonly billed: number;
  readonly turns: readonly TurnCost[];
}

/** The flags this module reads. A subset of the runner's `Flags`, which satisfies it structurally. */
export interface BundleFlags {
  readonly dryRun: boolean;
  readonly effort: string;
  readonly maxUsd: number;
  readonly maxOutputTokens: number;
  readonly maxTotalTokens: number;
}

/** What the verification replay concluded, as the README needs it. `null` if it never ran. */
export interface VerificationSummary {
  readonly status: string;
  readonly grade: string | null;
}

export interface CoreBundleInput {
  readonly outDir: string;
  readonly flags: BundleFlags;
  readonly run: DiscoveryRun;
  /** `null` when nothing was recorded - the budget guard refused turn 1, or the very first call
   *  threw before a request was built. */
  readonly transcript: Transcript | null;
  /** Why there is no transcript, when the recorder refused to produce one. */
  readonly transcriptProblem: string | null;
  readonly recordedAt: string;
  readonly adapter: string;
  readonly modelId: string;
  readonly tenantId: string;
  readonly entryRoute: string;
  readonly driver: string;
  readonly rate: ModelRate;
  readonly spend: SpendSnapshot;
  readonly verification: VerificationSummary | null;
  /** The artifact's lifecycle after verification, or `null` if there is no artifact. */
  readonly lifecycle: string | null;
}

// ---------------------------------------------------------------------------------------------
// The four files
// ---------------------------------------------------------------------------------------------

/**
 * Write everything the run accumulated, whatever ended it.
 *
 * Returns the file names written, in the order they were written, so the caller can print them and
 * a test can assert on them rather than on a `void`.
 *
 * There is no early return and no status check anywhere in here on purpose. `reached-goal`,
 * `stuck`, `budget-exhausted`, `model-stopped` and `failed` all produce the same four files; what
 * differs between them is what `provenance.json` SAYS, which is a field rather than a branch. A
 * writer that skipped files on the unhappy path would be the same defect as the one this module
 * exists to close, one directory further along.
 */
export function writeCoreBundle(input: CoreBundleInput): readonly string[] {
  const { flags, run, transcript, spend, rate } = input;
  const written: string[] = [];

  writeJson(join(input.outDir, "provenance.json"), {
    _readme:
      "Provenance for every file in this directory. BRIEF section 10 requires each one to state " +
      "which adapter produced it and with which model id; the two documents under synthesized/ " +
      "are the exceptions, because they are content-addressed and an added field would move the " +
      "digest an approval signs over - artifact.json carries the same facts in its own " +
      "`provenance` block, and synthesized/README.md carries them for contract.json.",
    producedBy: "pnpm discover",
    command: flags.dryRun ? "pnpm discover --dry-run" : "pnpm discover --yes",
    at: input.recordedAt,
    synthetic: flags.dryRun,
    isEvidenceOfADiscoveryRun: !flags.dryRun,
    adapter: input.adapter,
    modelId: input.modelId,
    effort: flags.effort,
    maxTokensPerTurn: flags.maxOutputTokens,
    promptVersion: "discovery/1",
    goal: LIVE_GOAL,
    memberId: LIVE_MEMBER_ID,
    target: {
      fixture: "fixtures/corebank-web",
      tenantId: input.tenantId,
      entryRoute: input.entryRoute,
      driver: input.driver,
    },
    run: {
      status: run.status,
      summary: run.summary,
      turns: run.turns,
      steps: run.steps.length,
      outputs: run.outputs.map((o) => o.outputName),
      // The STACK is deliberately not here. It carries absolute paths from the machine the run
      // happened on and this file is committed; the name, the message and the turn are what a
      // reader needs, and the stack went to stderr while it was still useful.
      failure:
        run.failure === null
          ? null
          : {
              name: run.failure.name,
              message: run.failure.message,
              adapter: run.failure.adapter,
              turn: run.failure.turn,
              note:
                "This run ended on an exception. Every turn the provider had already answered was " +
                "kept and is in transcript.json; spend.json is the measured cost of those turns. " +
                "The turn named here produced no response and was not billed.",
            },
    },
    transcript:
      transcript === null
        ? { present: false, why: input.transcriptProblem ?? "no turn was taken" }
        : { present: true, turns: transcript.turns.length },
    usage: run.usage,
    cacheHitRate: run.cacheHitRate,
    spend: {
      measuredUsd: Number(spend.spentUsd.toFixed(6)),
      billedTokens: spend.billed,
      capUsd: flags.maxUsd,
      projectCapUsd: SPEND_CAP_USD,
      rate: { model: rate.id, inputPerMTok: rate.input, outputPerMTok: rate.output },
      note:
        "measuredUsd is computed from the token counts the provider returned, at the published " +
        "rates in packages/discovery/tools/live-run.ts. It is this repository's arithmetic, not " +
        "an invoice; the authority is the provider's console.",
    },
  });
  written.push("provenance.json");

  if (transcript !== null) {
    writeJson(join(input.outDir, "transcript.json"), transcript);
    written.push("transcript.json");
  }

  writeJson(join(input.outDir, "spend.json"), {
    _provenance: { adapter: input.adapter, modelId: input.modelId },
    capUsd: flags.maxUsd,
    maxOutputTokens: flags.maxOutputTokens,
    maxTotalTokens: flags.maxTotalTokens,
    totalUsd: Number(spend.spentUsd.toFixed(6)),
    turns: spend.turns,
  });
  written.push("spend.json");

  writeText(join(input.outDir, "README.md"), bundleReadme(input));
  written.push("README.md");

  return written;
}

// ---------------------------------------------------------------------------------------------
// The bundle's own README
// ---------------------------------------------------------------------------------------------

const NOTHING_RECORDED =
  "The budget guard refused the very first turn, so there is no transcript in this directory - " +
  "only the journal, the provenance and the spend ledger saying why the run stopped before it " +
  "started.";

export function bundleReadme(input: CoreBundleInput): string {
  const { flags, run, transcript, verification } = input;
  const real = transcript !== null && !transcript.synthetic;
  return [
    `# ${real ? "discovery-live" : "discovery-dry-run"}`,
    "",
    transcript === null
      ? `**NO TURN WAS RECORDED.** ${input.transcriptProblem ?? NOTHING_RECORDED}`
      : real
        ? "**A real discovery run.** A model was in the loop, it was called over the network, and the " +
          "run was billed to the author's Anthropic project."
        : "**A REHEARSAL, and not evidence of anything.** The assistant turns were served by the VCR " +
          "replay adapter from a transcript recorded seconds earlier by a hand-authored script. No " +
          "provider was called and no token was spent. BRIEF section 10 forbids presenting this as a " +
          "discovery run; `assertRealRecording()` in the runner refuses to write it into `evidence/`.",
    "",
    ...(run.failure === null
      ? []
      : [
          "## This run ended on an error, and everything before it was kept",
          "",
          `\`${run.failure.name}\` ended the run ${run.failure.turn === 0 ? "before any turn was requested" : `during turn ${run.failure.turn}`}:`,
          "",
          "```",
          run.failure.message,
          "```",
          "",
          `Every turn the provider had already answered — ${transcript?.turns.length ?? 0} of them —`,
          "is in `transcript.json`, and `spend.json` is the measured cost of exactly those turns. The",
          "turn named above produced no response and was not billed. Synthesis was skipped, the",
          "verification replay did not happen, and the exit code is non-zero: a run that stopped on an",
          "error is not a discovery run, and this bundle is the record of what it did before it",
          "stopped rather than a claim that it succeeded.",
          "",
        ]),
    "| | |",
    "|---|---|",
    `| adapter | \`${transcript?.provenance.adapter ?? "(no turn was recorded)"}\` |`,
    `| model id | \`${transcript?.provenance.modelId ?? "-"}\` |`,
    `| effort | \`${flags.effort}\` |`,
    `| max_tokens per turn | ${flags.maxOutputTokens} |`,
    `| recorded at | ${transcript?.provenance.recordedAt ?? "-"} |`,
    `| command | \`${flags.dryRun ? "pnpm discover --dry-run" : "pnpm discover --yes"}\` |`,
    `| status | \`${run.status}\` |`,
    `| turns | ${run.turns} |`,
    `| verification | ${verification === null ? "not attempted" : `${verification.status} / ${verification.grade ?? "no grade"}`} |`,
    `| artifact lifecycle | \`${input.lifecycle ?? "proposed"}\` |`,
    "",
    "## Files",
    "",
    "| file | what it is |",
    "|---|---|",
    "| `transcript.json` | the full VCR recording: every request's message digest, every response, every tool call, per-turn token usage and `cache_read_input_tokens`. |",
    "| `discovery.log` | what the runner printed, including the live spend after every turn. |",
    "| `journal.jsonl` | the discovery journal. Every tool call passed `PolicyEngine.check` and is journaled, exactly as a replay action is. |",
    "| `synthesized/` | the contract, the artifact and the synthesis report. See its own README. |",
    "| `verification.json` | the self-replay with the model out of the loop, and the result document it produced. |",
    "| `verification-journal.jsonl` | that replay's journal. |",
    "| `verification-evidence/` | the observations that replay froze, with every bound value redacted. |",
    "| `provenance.json` | adapter, model id, prompt version, measured usage, measured cache hit rate, measured spend. |",
    "| `spend.json` | the per-turn cost ledger the budget guard decided on. |",
    "| `canary/` | all four redaction passes, and what each searched for. |",
    "",
    "## Where the member number is, and where it is not",
    "",
    `Every value here is synthetic — see \`fixtures/corebank-web/src/data.js\`. Member ${LIVE_MEMBER_ID}`,
    "is deliberately **not** the member `pnpm demo` uses, so a canary hit anywhere under",
    "`evidence/` names the run that produced it without ambiguity.",
    "",
    "The number **is** in `transcript.json`, `discovery.log` and `journal.jsonl`, and that is not a",
    "leak: the model had to be told which member to look up, it typed the number, and the",
    "application printed it back in the results grid and in its own query string. A discovery",
    "recording that did not contain it would be a recording of a different conversation. The",
    "canary's fourth pass lists every one of those occurrences with its line number, so the claim",
    "is checkable rather than asserted.",
    "",
    "The number is **not** in `synthesized/`, because parameterization replaced it — including in",
    "the model's own `why` prose, which becomes `Step.intent`. It is **not** in anything the",
    "verification replay wrote, because at replay time it is an argument the interpreter binds as a",
    "`TaintedValue` and SPEC §8.3's sink table applies in full. Those two are the canary's first and",
    "second passes, and both gate the exit code.",
    "",
    "Member names and balances appear in the transcript (the model was shown the screen) and in the",
    "replay result (the caller asked for them). What they must never do is appear in `synthesized/`,",
    "and the first pass searches for them there too.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------------

/**
 * The runner's exit code, as a function rather than as three `&&`s in the middle of a script.
 *
 * Zero requires all three: the model reached the goal, the artifact replayed with the model out of
 * the loop, and the bundle was grepped clean. `run.status` is read here rather than passed in as a
 * boolean so that a status added later cannot become a success by omission - only `reached-goal`
 * is one, and `failed` is emphatically not, however clean the bundle it left behind.
 */
export function discoveryExitCode(input: {
  readonly run: DiscoveryRun;
  readonly verified: boolean;
  readonly canaryClean: boolean;
}): number {
  const reachedGoal = input.run.status === "reached-goal";
  return reachedGoal && input.verified && input.canaryClean ? 0 : 1;
}
