// A run that dies mid-flight keeps everything it paid for, and the bytes reach the disk.
//
// This is the test `docs/design/LIVE-RUN-READINESS.md` section 5.2 asks for. The defect it pins:
// `runDiscoveryLoop` did not catch a `DiscoveryModelError`, so a rate limit, a 400 or a dropped
// connection on turn 3 of a paid run propagated to `tools/discover.ts`'s outer catch, which printed
// FAILED and exited 1 - at which point `transcript.json`, `spend.json`, `provenance.json` and
// `README.md` had never been written, because every one of them is written after the loop returns.
// The turns had been billed and the conversation was gone. Only `journal.jsonl` survived.
//
// So the shape of this file is the shape of the failure:
//
//   1. the loop catches it, ends `failed`, and hands back every step, event and token it had;
//   2. it still THROWS by default, because the VCR's strict digest check has to stay loud for
//      callers whose runs cost nothing - the keeping is opt-in and the runner opts in;
//   3. the four files land on disk, containing the turns that were answered, with a status that
//      says what happened and a spend ledger for exactly those turns;
//   4. the exit code is still non-zero, because a run that stopped on an error is not a run that
//      reached the goal however clean the bundle it left behind;
//   5. a value bound to a sensitive parameter does not escape through the new failure fields.
//
// Nothing here can reach a provider: the model is an array with a `throw` in it, and the only
// directory written to is one `mkdtemp` made.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockSurface, bindSensitive } from "@crr/core";
import type { TaintedValue } from "@crr/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  type DiscoveryModel,
  DiscoveryModelError,
  type DiscoveryRun,
  type ModelTurnRequest,
  type ModelTurnResponse,
  type ModelUsage,
  type ScriptedTurn,
  type Transcript,
  createRecordingModel,
  createScriptedModel,
  runDiscoveryLoop,
} from "../src/index.js";
import {
  type SpendSnapshot,
  type TurnCost,
  discoveryExitCode,
  writeCoreBundle,
} from "../tools/bundle.js";
import { type ModelRate, billedTokens, costOf, rateFor } from "../tools/live-run.js";
import {
  ALLOWLIST,
  CONTROL,
  FROZEN_NOW,
  GOAL,
  frozenClockMs,
  screens,
  transitions,
} from "./fixtures/corebank.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const TARGET = {
  tenantId: "riverbend",
  originAlias: "corebank",
  entryRoute: "/members/search",
} as const;

/** `claude-opus-5`, from the one rate table in the repository - never a price written here. */
const RATE: ModelRate = (() => {
  const rate = rateFor("claude-opus-5");
  if (rate === null) throw new Error("claude-opus-5 is missing from MODEL_RATES");
  return rate;
})();

/**
 * Invented provider numbers, and they are allowed to be invented HERE and nowhere else.
 *
 * `createScriptedModel` reports `ZERO_USAGE` by design so that a synthetic fixture's cache hit rate
 * can never be mistaken for a measurement - see its header. This test needs non-zero usage for a
 * different reason: with a zero ledger, `spend.json` would say `$0` whether the writer worked or
 * not, and "the spend ledger is written" would be an assertion that cannot fail. The transcript
 * these numbers produce is `synthetic: true`, it is written into a `mkdtemp` directory and deleted
 * at the end of the file, and it is never presented as evidence of anything.
 */
const TURN_USAGE: readonly ModelUsage[] = [
  { inputTokens: 2100, outputTokens: 210, cacheCreationInputTokens: 2034, cacheReadInputTokens: 0 },
  { inputTokens: 260, outputTokens: 180, cacheCreationInputTokens: 0, cacheReadInputTokens: 2034 },
];

const usageOf = (turn: number): ModelUsage => {
  const usage = TURN_USAGE[turn - 1];
  if (usage === undefined) throw new Error(`no usage scripted for turn ${turn}`);
  return usage;
};

/** Turn 1 looks; turn 2 types the member number into the search field. Turn 3 never answers. */
const SCRIPT: readonly ScriptedTurn[] = [
  { toolUses: [{ name: "observe", input: {} }], usage: usageOf(1) },
  {
    toolUses: [
      {
        name: "act",
        input: {
          nodeRef: "n1",
          action: "fill",
          value: "50001",
          key: null,
          why: "the task names this member",
        },
      },
    ],
    usage: usageOf(2),
  },
];

/** What the provider does on turn 3. A 429 is the one the SDK surfaces after its own two retries. */
const RATE_LIMIT = new DiscoveryModelError(
  "anthropic",
  "the provider rate limited this request (429) after the SDK's own retries",
);

/**
 * A model that answers from the script until turn `n`, and then throws.
 *
 * Deliberately a wrapper rather than a `throw` written into `createScriptedModel`: the turns before
 * the failure have to go through the real scripted model and the real recorder, or the transcript
 * this test asserts on would not be the transcript a run produces.
 */
function failingAt(n: number, error: Error): DiscoveryModel {
  const inner = createScriptedModel(SCRIPT, { modelId: "synthetic-script" });
  let turn = 0;
  return {
    adapter: inner.adapter,
    modelId: inner.modelId,
    async turn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
      turn += 1;
      if (turn === n) throw error;
      return inner.turn(request);
    },
  };
}

interface Failed {
  readonly run: DiscoveryRun;
  readonly transcript: Transcript | null;
  readonly transcriptProblem: string | null;
}

/** The runner's own sequence: record around the model, run the loop, then ask for the transcript. */
async function runUntilItFails(failAt = 3, error: Error = RATE_LIMIT): Promise<Failed> {
  const model = createRecordingModel(failingAt(failAt, error), {
    nowMs: frozenClockMs(),
    recordedAt: null,
    synthetic: true,
    note: "SYNTHETIC. Built inside test/loop-failure.test.ts. No provider was called.",
  });
  const run = await runDiscoveryLoop({
    goal: GOAL,
    target: TARGET,
    model,
    surface: new MockSurface({ screens, start: "searchForm", transitions }),
    allowlist: ALLOWLIST,
    control: CONTROL,
    now: () => FROZEN_NOW,
    nowMs: frozenClockMs(),
    onUnexpectedError: "keep-the-run",
  });
  try {
    return { run, transcript: model.transcript(), transcriptProblem: null };
  } catch (cause) {
    return {
      run,
      transcript: null,
      transcriptProblem: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** The ledger the runner would have, rebuilt from the journal the way `discover.ts` builds it. */
function ledgerOf(run: DiscoveryRun): SpendSnapshot {
  const turns: TurnCost[] = [];
  let total: ModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  for (const event of run.events) {
    if (event.type !== "turn.responded") continue;
    const usage = event.usage as ModelUsage;
    const before = costOf(total, RATE);
    total = {
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      cacheCreationInputTokens: total.cacheCreationInputTokens + usage.cacheCreationInputTokens,
      cacheReadInputTokens: total.cacheReadInputTokens + usage.cacheReadInputTokens,
    };
    turns.push({
      turn: event.turn,
      usage,
      turnUsd: costOf(total, RATE) - before,
      runUsd: costOf(total, RATE),
      stopReason: event.stopReason,
      latencyMs: event.latencyMs,
    });
  }
  return { spentUsd: costOf(total, RATE), billed: billedTokens(total), turns };
}

const FLAGS = {
  dryRun: false,
  effort: "high",
  maxUsd: 2,
  maxOutputTokens: 2000,
  maxTotalTokens: 750_000,
} as const;

const temps: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "crr-loop-failure-"));
  temps.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Write the bundle the way the runner writes it, into a directory that is not `evidence/`. */
function bundleOf(failed: Failed): { readonly dir: string; readonly written: readonly string[] } {
  const dir = scratch();
  const written = writeCoreBundle({
    outDir: dir,
    flags: FLAGS,
    run: failed.run,
    transcript: failed.transcript,
    transcriptProblem: failed.transcriptProblem,
    recordedAt: FROZEN_NOW,
    adapter: failed.transcript?.provenance.adapter ?? "scripted",
    modelId: failed.transcript?.provenance.modelId ?? "synthetic-script",
    tenantId: TARGET.tenantId,
    entryRoute: TARGET.entryRoute,
    driver: "mock",
    rate: RATE,
    spend: ledgerOf(failed.run),
    verification: null,
    lifecycle: null,
  });
  return { dir, written };
}

const readJson = (dir: string, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// 1. The loop keeps the run
// ---------------------------------------------------------------------------------------------

describe("a provider error mid-run ends the run instead of destroying it", () => {
  it("reports `failed`, naming the error, the adapter and the turn it died on", async () => {
    const { run } = await runUntilItFails(3);
    expect(run.status).toBe("failed");
    expect(run.failure).not.toBeNull();
    expect(run.failure?.name).toBe("DiscoveryModelError");
    expect(run.failure?.adapter).toBe("anthropic");
    expect(run.failure?.turn).toBe(3);
    expect(run.failure?.message).toContain("rate limited");
    expect(run.summary).toContain("during turn 3");
  });

  it("keeps every step the run had recorded before it died", async () => {
    const { run } = await runUntilItFails(3);
    // Turn 2 typed the member number in. That step is what synthesis would have been built from,
    // and it is the thing the old exception path threw away.
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]?.tool).toBe("act");
    expect(run.steps[0]?.value).toEqual({ kind: "literal", value: "50001" });
    expect(run.observations.length).toBeGreaterThan(0);
  });

  it("keeps the measured usage of the turns the provider did answer", async () => {
    const { run } = await runUntilItFails(3);
    expect(run.turns).toBe(3);
    // Two answered turns, and turn 3 contributes nothing: a request that errored returned no
    // usage, so it is not in the total and the caller is not billed for it here either.
    expect(run.usage.inputTokens).toBe(usageOf(1).inputTokens + usageOf(2).inputTokens);
    expect(run.usage.outputTokens).toBe(usageOf(1).outputTokens + usageOf(2).outputTokens);
    expect(run.cacheHitRate).toBeGreaterThan(0);
  });

  it("journals the failure and still closes the journal with loop.finished", async () => {
    const { run } = await runUntilItFails(3);
    const types = run.events.map((event) => event.type);
    expect(types.at(-2)).toBe("loop.failed");
    expect(types.at(-1)).toBe("loop.finished");
    const failed = run.events.find((event) => event.type === "loop.failed");
    expect(failed?.type === "loop.failed" && failed.errorName).toBe("DiscoveryModelError");
    expect(failed?.type === "loop.failed" && failed.turn).toBe(3);
    const finished = run.events.find((event) => event.type === "loop.finished");
    expect(finished?.type === "loop.finished" && finished.status).toBe("failed");
  });

  it("keeps the run whatever was thrown, including things that are not Errors", async () => {
    // A taxonomy of throwables written into the loop would be a list that is wrong the first time
    // something new is thrown, so the catch is total and the label is read off the throwable.
    const { run } = await runUntilItFails(2, new TypeError("cannot read properties of undefined"));
    expect(run.status).toBe("failed");
    expect(run.failure?.name).toBe("TypeError");
    expect(run.failure?.adapter).toBeNull();
    expect(run.failure?.turn).toBe(2);
  });

  it("still ends `reached-goal` when nothing throws, so the catch changed no working path", async () => {
    const model = createScriptedModel([
      ...SCRIPT,
      {
        toolUses: [
          {
            name: "finish",
            input: { status: "reached-goal", summary: "found them", outcomeCandidates: null },
          },
        ],
      },
    ]);
    const run = await runDiscoveryLoop({
      goal: GOAL,
      target: TARGET,
      model,
      surface: new MockSurface({ screens, start: "searchForm", transitions }),
      allowlist: ALLOWLIST,
      control: CONTROL,
      now: () => FROZEN_NOW,
      nowMs: frozenClockMs(),
      onUnexpectedError: "keep-the-run",
    });
    expect(run.status).toBe("reached-goal");
    expect(run.failure).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// 2. The keeping is opt-in, and the caller that pays for the turns opts in
// ---------------------------------------------------------------------------------------------

describe("keeping a failed run is a decision the call site makes", () => {
  it("still throws by default, so a VCR digest mismatch stays loud", async () => {
    await expect(
      runDiscoveryLoop({
        goal: GOAL,
        target: TARGET,
        model: failingAt(3, RATE_LIMIT),
        surface: new MockSurface({ screens, start: "searchForm", transitions }),
        allowlist: ALLOWLIST,
        control: CONTROL,
        now: () => FROZEN_NOW,
        nowMs: frozenClockMs(),
      }),
    ).rejects.toThrow(DiscoveryModelError);
  });

  it("is opted into by `pnpm discover`, which is the run with money on it", () => {
    // Read off disk because `tools/discover.ts` is a script with top-level `await` and
    // `process.exit` in it: importing it would run it. The assertion is narrow on purpose - it says
    // the one call to the loop in the one command that spends money passes the option - and the
    // three checks under it are what stop this passing because it read the wrong file or nothing.
    const source = readFileSync(join(HERE, "..", "tools", "discover.ts"), "utf8");
    expect(source.length).toBeGreaterThan(10_000);
    expect(source.split("runDiscoveryLoop({").length - 1).toBe(2);
    expect(source).toContain('onUnexpectedError: "keep-the-run"');
  });
});

// ---------------------------------------------------------------------------------------------
// 3. The bytes reach the disk
// ---------------------------------------------------------------------------------------------

describe("the bundle a failed run leaves behind", () => {
  it("writes the transcript, the ledger, the provenance and the README", async () => {
    const { dir, written } = bundleOf(await runUntilItFails(3));
    expect([...written]).toEqual(["provenance.json", "transcript.json", "spend.json", "README.md"]);
    for (const file of written) expect(existsSync(join(dir, file)), file).toBe(true);
  });

  it("puts the turns that were answered in transcript.json, in order", async () => {
    const failed = await runUntilItFails(3);
    const { dir } = bundleOf(failed);
    const transcript = readJson(dir, "transcript.json") as unknown as Transcript;
    // Turns 1 and 2 were answered and billed; turn 3 raised before a response existed, so there is
    // nothing to record for it and nothing was charged for it. `run.turns` counts the attempt, the
    // transcript counts the answers, and provenance.json below carries both so the difference is
    // visible rather than inferred.
    expect(transcript.turns.map((turn) => turn.index)).toEqual([1, 2]);
    expect(transcript.turns[0]?.response.usage).toEqual(usageOf(1));
    expect(transcript.turns[1]?.response.usage).toEqual(usageOf(2));
    expect(JSON.stringify(transcript)).toContain("50001");
    expect(failed.run.turns).toBe(3);
  });

  it("writes a spend ledger for exactly the turns that were billed", async () => {
    const failed = await runUntilItFails(3);
    const { dir } = bundleOf(failed);
    const spend = readJson(dir, "spend.json") as {
      totalUsd: number;
      capUsd: number;
      turns: readonly TurnCost[];
    };
    const expected = costOf(failed.run.usage, RATE);
    expect(expected).toBeGreaterThan(0);
    // Rounded to the microdollar on the way out, which is the writer's own decision and is asserted
    // as such rather than approximated around.
    expect(spend.totalUsd).toBe(Number(expected.toFixed(6)));
    expect(spend.turns.map((turn) => turn.turn)).toEqual([1, 2]);
    expect(spend.capUsd).toBe(FLAGS.maxUsd);
  });

  it("says in provenance.json that the run failed, and why, without a stack", async () => {
    const { dir } = bundleOf(await runUntilItFails(3));
    const provenance = readJson(dir, "provenance.json") as {
      run: { status: string; turns: number; steps: number; failure: Record<string, unknown> };
      transcript: { present: boolean; turns: number };
      spend: { measuredUsd: number };
    };
    expect(provenance.run.status).toBe("failed");
    expect(provenance.run.turns).toBe(3);
    expect(provenance.run.steps).toBe(1);
    expect(provenance.run.failure.name).toBe("DiscoveryModelError");
    expect(provenance.run.failure.turn).toBe(3);
    expect(provenance.transcript).toEqual({ present: true, turns: 2 });
    expect(provenance.spend.measuredUsd).toBeGreaterThan(0);
    // A committed file must not carry absolute paths from the machine the run happened on.
    expect(JSON.stringify(provenance)).not.toContain("stack");
    expect(readFileSync(join(dir, "provenance.json"), "utf8")).not.toContain(HERE);
  });

  it("says on the first screen of the README that the run stopped on an error", async () => {
    const { dir } = bundleOf(await runUntilItFails(3));
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("This run ended on an error");
    expect(readme).toContain("DiscoveryModelError");
    expect(readme).toContain("| status | `failed` |");
    expect(readme).toContain("2 of them");
  });

  it("writes a transcript with no turns, but with the prompt, when turn 1 itself failed", async () => {
    // The recorder stamps the cacheable prefix from the REQUEST, before the model is called, so a
    // run that died on its first call still leaves the exact system prompt and tool definitions it
    // was about to send. That is worth keeping: it is what a prompt regression is diffed against,
    // and it costs nothing because the turn was never answered.
    const failed = await runUntilItFails(1);
    expect(failed.transcript?.turns).toEqual([]);
    expect(failed.transcript?.prefix.tools.length).toBeGreaterThan(0);
    const { dir, written } = bundleOf(failed);
    expect([...written]).toContain("transcript.json");
    const provenance = readJson(dir, "provenance.json") as {
      run: { status: string; turns: number };
      transcript: { present: boolean; turns: number };
      spend: { measuredUsd: number };
    };
    expect(provenance.run.status).toBe("failed");
    expect(provenance.run.turns).toBe(1);
    expect(provenance.transcript).toEqual({ present: true, turns: 0 });
    expect(provenance.spend.measuredUsd).toBe(0);
  });

  it("still writes the ledger and the provenance when there is no transcript at all", async () => {
    // The other shape: the budget guard refused turn 1, so no request was ever built and
    // `model.transcript()` throws rather than hand back an empty one - it is right to, and the
    // runner catches it. That refusal happens AFTER the loop returned, on the path whose whole job
    // is to write down what the run had, so it must not be the thing that loses the bundle either.
    const empty = createRecordingModel(createScriptedModel([]), {
      nowMs: frozenClockMs(),
      recordedAt: null,
      synthetic: true,
      note: "SYNTHETIC. Built inside test/loop-failure.test.ts. No provider was called.",
    });
    let problem = "";
    try {
      empty.transcript();
    } catch (cause) {
      problem = cause instanceof Error ? cause.message : String(cause);
    }
    expect(problem).toContain("nothing was recorded");

    const failed = await runUntilItFails(1);
    const { dir, written } = bundleOf({
      run: failed.run,
      transcript: null,
      transcriptProblem: problem,
    });
    expect([...written]).toEqual(["provenance.json", "spend.json", "README.md"]);
    expect(existsSync(join(dir, "transcript.json"))).toBe(false);
    const provenance = readJson(dir, "provenance.json") as {
      run: { status: string };
      transcript: { present: boolean; why: string };
    };
    expect(provenance.run.status).toBe("failed");
    expect(provenance.transcript.present).toBe(false);
    expect(provenance.transcript.why).toContain("nothing was recorded");
    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("NO TURN WAS RECORDED");
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The exit code
// ---------------------------------------------------------------------------------------------

describe("a failed run is never a successful command", () => {
  it("exits non-zero even with a clean canary and a verification that passed", async () => {
    const { run } = await runUntilItFails(3);
    expect(discoveryExitCode({ run, verified: true, canaryClean: true })).toBe(1);
  });

  it("exits zero only for a run that reached the goal, verified, with a clean bundle", async () => {
    const { run } = await runUntilItFails(3);
    const reached: DiscoveryRun = { ...run, status: "reached-goal", failure: null };
    expect(discoveryExitCode({ run: reached, verified: true, canaryClean: true })).toBe(0);
    expect(discoveryExitCode({ run: reached, verified: false, canaryClean: true })).toBe(1);
    expect(discoveryExitCode({ run: reached, verified: true, canaryClean: false })).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. The failure path is under the taint model too
// ---------------------------------------------------------------------------------------------

describe("a bound value does not escape through the new failure fields", () => {
  const CANARY = "CANARY-40771";
  const PLACEHOLDER = "{{secret:memberId}}";

  it("appears in neither the run, the transcript nor any file the bundle writes", async () => {
    const secret: TaintedValue = bindSensitive("memberId", CANARY, 1);
    const model = createRecordingModel(failingAt(3, new Error(`upstream said: ${PLACEHOLDER}`)), {
      nowMs: frozenClockMs(),
      recordedAt: null,
      synthetic: true,
      note: "SYNTHETIC. Built inside test/loop-failure.test.ts. No provider was called.",
    });
    const run = await runDiscoveryLoop({
      goal: "Look up the member whose number was withheld.",
      target: TARGET,
      model,
      surface: new MockSurface({ screens, start: "searchForm", transitions }),
      allowlist: ALLOWLIST,
      control: CONTROL,
      secrets: new Map([[PLACEHOLDER, secret]]),
      now: () => FROZEN_NOW,
      nowMs: frozenClockMs(),
      onUnexpectedError: "keep-the-run",
    });
    expect(run.status).toBe("failed");
    expect(JSON.stringify(run)).not.toContain(CANARY);

    const { dir, written } = bundleOf({
      run,
      transcript: model.transcript(),
      transcriptProblem: null,
    });
    for (const file of written) {
      expect(readFileSync(join(dir, file), "utf8"), file).not.toContain(CANARY);
    }
  });
});
