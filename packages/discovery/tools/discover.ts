// `pnpm discover` - the live discovery runner. The one command in this repository that spends money.
//
//   pnpm discover --dry-run              rehearse the whole thing; no API call, no cent
//   pnpm discover --yes                  perform it, against the live Anthropic Messages API
//   pnpm discover --help                 every flag, with its default
//
// WHAT IT IS. The composition root FINAL-STATUS section 7.1 says is missing: the script that joins
// `createAnthropicModel` -> `createRecordingModel` -> `runDiscoveryLoop` -> synthesis ->
// `verifyAndDraft` -> `writeFileSync`, boots `fixtures/corebank-web`, drives it through
// `@crr/surface-browser`, and leaves `evidence/discovery-live/` holding a real recording of a real
// model doing the task for the first time. Every piece it uses is built and tested; nothing joined
// them, so there was no command for the author to approve and the money could not be spent even
// deliberately. This is that command.
//
// WHAT IT REFUSES TO DO, in the order the refusals fire:
//
//   1. NOTHING HAPPENS WITHOUT `--yes`. The run prints one screen - model, goal, allowlist, budget,
//      destination - and stops. There is no way to reach the provider by fat-fingering a flag.
//   2. IT WILL NOT PRICE A MODEL IT DOES NOT KNOW THE PRICE OF. `--model` outside `MODEL_RATES`
//      is refused rather than run un-budgeted, because a spend guard that guesses the rate is not
//      a spend guard.
//   3. A CUMULATIVE BUDGET IS ENFORCED BETWEEN TURNS, from the `usage` the provider actually
//      returned, and the next turn is PROJECTED before it is taken. When the projection would cross
//      the cap the run stops cleanly with status `budget-exhausted`, and everything it has - the
//      transcript, the journal, the steps - is written down. See `TurnBudgetProbe` in `src/loop.ts`
//      for why that guard lives inside the loop and not around the model.
//   4. THE RECORDING IS NOT A CLAIM UNTIL IT REPLAYS. Synthesis runs, and then the artifact is
//      replayed against the same application with the model out of the loop (BRIEF section 3.4).
//      The document is saved as `draft` only if that passes; otherwise it stays `proposed` and the
//      report says why.
//   5. A SYNTHETIC TRANSCRIPT NEVER REACHES `evidence/`. `assertRealRecording` is called before the
//      first byte is written there, so a `--dry-run` rehearsal cannot be mistaken for evidence even
//      by a person who copies the directory by hand. The rehearsal writes to `.scratch/`.
//   6. THE BUNDLE IS GREPPED BEFORE IT IS PUBLISHED - four scoped passes, three of which gate the
//      exit code. See `runCanaries()` for what each pass searches for and why the scopes differ.
//
// THE MEMBER NUMBER IS A LITERAL IN THE GOAL, NOT A BOUND SECRET, and `tools/live-run.ts` argues
// that choice at length at `LIVE_GOAL`. The short version is that the sensitive binding was built
// first and rejected on measurement: it made the ARTIFACT worse (`table-cell` addressing becomes
// underivable, and the fallback descriptors fold the cell's own accessible name - recorded member
// data - into `flow.vocabulary`), and it did not even keep the value out of the recording, because
// the application prints the member number back in the results grid and in its own query string.
// So the value IS in `transcript.json`, `discovery.log` and `journal.jsonl`; canary pass 4 reports
// every occurrence with its line number rather than pretending otherwise, and passes 1 and 2 gate
// on the places it genuinely must not be - the synthesized documents, and everything the
// verification replay wrote, where the same number IS a bound value and the taint model holds.
//
// FOUR IMPORTS BY PATH, AND THEY ARE DELIBERATE. `@crr/discovery` declares neither `playwright`,
// nor `@crr/surface-browser`, nor the fixture, nor `@crr/runtime`, and it must not: the package that
// owns the model loop has no business depending on a driver or on an interpreter, and
// `packages/core/test/no-locator-vocabulary.test.ts` reads `packages/discovery/src` off disk to say
// so. Resolving them by path from a script OUTSIDE `src/` is the precedent `tools/preflight.ts` and
// `test/fixtures/capture-corebank-web.ts` already set, with the same reasoning written at the same
// kind of site. The consequence is that the `@crr/runtime` slice below is a hand-written structural
// type rather than the real one - so the seam is checked by RUNNING it, which is exactly what
// `--dry-run` is for.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type {
  Allowlist,
  CapabilityArtifact,
  CapabilityContract,
  EvidenceRef,
  JournalEvent,
  LeaseToken,
  Observation,
  PerceiveResult,
  ReplayResultDocument,
  RouteId,
  RoutePattern,
  RunId,
  Surface,
  SurfaceCapabilities,
  Timestamp,
} from "@crr/core";
import { digestOf } from "@crr/core";
import { DEFAULT_MAX_TOKENS, createAnthropicModel } from "../src/adapters/anthropic.js";
import type { DiscoveryEvent } from "../src/journal.js";
import {
  DEFAULT_LIMITS,
  type DiscoveryRun,
  type TurnBudgetProbe,
  runDiscoveryLoop,
} from "../src/loop.js";
import {
  DEFAULT_MODEL_ID,
  type DiscoveryModel,
  type ModelEffort,
  type ModelUsage,
} from "../src/model-port.js";
import { createScriptedModel } from "../src/scripted-model.js";
import { type SynthesisResult, synthesizeCapability } from "../src/synthesis/emit.js";
import {
  type RecordingModel,
  type Transcript,
  assertRealRecording,
  createRecordingModel,
  createReplayModel,
} from "../src/transcript.js";
import {
  type SpendSnapshot,
  type TurnCost,
  discoveryExitCode,
  writeCoreBundle,
  writeJson,
  writeText,
} from "./bundle.js";
import {
  ALLOWLIST,
  CONTROL,
  DISCOVER_MAX_OUTPUT_TOKENS,
  DISCOVER_MAX_USD,
  ENTRY_ROUTE,
  LIVE_CAPABILITY,
  LIVE_GOAL,
  LIVE_MEMBER_ID,
  LIVE_TENANT,
  LIVE_VENDOR,
  MODEL_RATES,
  type ModelRate,
  SPEND_CAP_USD,
  billedTokens,
  costOf,
  rateFor,
  rehearsalScript,
} from "./live-run.js";

// ---------------------------------------------------------------------------------------------
// Where things are
// ---------------------------------------------------------------------------------------------

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGES = resolve(HERE, "..", "..");
const REPO = resolve(PACKAGES, "..");
const RUNTIME = resolve(PACKAGES, "runtime");
const SURFACE_BROWSER = resolve(PACKAGES, "surface-browser");
const FIXTURE_SERVER = resolve(REPO, "fixtures", "corebank-web", "src", "server.js");
const ENV_FILE = resolve(REPO, ".env");

/** Where a REAL run's evidence lands. Named in `evidence/discovery-live/PENDING.md`, which this
 *  script deletes on success because the hole it documents is then closed. */
const LIVE_OUT = resolve(REPO, "evidence", "discovery-live");
/** Where a REHEARSAL's output lands. Gitignored, biome-ignored, and not `evidence/` - a rehearsal
 *  is not evidence and must not be one directory rename away from looking like it. */
const DRY_OUT = resolve(REPO, ".scratch", "discovery-dry-run");

// ---------------------------------------------------------------------------------------------
// Defaults that exist to keep a run cheap
// ---------------------------------------------------------------------------------------------

/**
 * The absolute cumulative token ceiling, independent of any price.
 *
 * It exists because the money guard has one input this repository cannot check: the published
 * rates. If `MODEL_RATES` is stale or wrong, the dollar guard is wrong in the same direction and
 * silently. This one is arithmetic-free. 750,000 billed tokens is $3.75 of input on claude-opus-5,
 * which is above what a $2.00 run can consume and well below the $10 cap - so in normal operation
 * the money guard binds first and this never fires, and if it ever does fire that is a finding
 * about the rate table.
 */
const DEFAULT_MAX_TOTAL_TOKENS = 750_000;

/**
 * The allowance for the tool result the next turn will carry, before one has been measured.
 *
 * Only used for the first two turns; after that the runner uses the growth it has MEASURED between
 * consecutive turns, which is the true size of a projection on this application. 2,000 is
 * deliberately generous - the entry screen's projection is 124 tokens - because an under-estimate
 * here is an over-spend and an over-estimate is only an early stop.
 */
const INITIAL_TOOL_RESULT_TOKENS = 2000;

/** A live browser is slower than a mock, and an unbounded perceive is a hang rather than an error. */
const PERCEIVE_DEADLINE_MS = 15_000;

/**
 * The shortest recorded screen value that makes a usable canary needle.
 *
 * Pass 2 greps the synthesized documents for member data the run read off the screen. A six-letter
 * status like `ACTIVE` is a word, not a fingerprint: it appears in ordinary schema vocabulary and a
 * canary with false positives is a canary somebody switches off. Values below this length are NOT
 * searched, and the runner prints which ones it skipped rather than quietly narrowing its own
 * coverage claim.
 */
const MIN_NEEDLE_LENGTH = 8;

// ---------------------------------------------------------------------------------------------
// `.env`, loaded here and nowhere else
// ---------------------------------------------------------------------------------------------

/**
 * Read `<repo>/.env` into `process.env`, without a dependency and without overriding the shell.
 *
 * FINAL-STATUS section 7.1 records the blocker this closes: nothing in the repository loaded `.env`,
 * so a funded key sitting in the file the README tells you to put it in was invisible to every
 * command. Three rules, all of them deliberate:
 *
 *   · AN ALREADY-SET VARIABLE WINS. `ANTHROPIC_API_KEY=... pnpm discover` must beat the file, or a
 *     one-off run against a different key is impossible to express.
 *   · IT IS ANNOUNCED. The runner prints the path and the NAMES of the variables it set. Never a
 *     value, never a prefix, never a length - the one thing a spend-control script must not do is
 *     put a credential on a terminal that gets pasted into a bug report.
 *   · IT IS NOT CLEVER. No `export`, no interpolation, no multi-line values. A parser with features
 *     is a parser with surprises, and this one exists to make a single flat `KEY=value` file work.
 *
 * `pnpm preflight` deliberately does NOT do this: it is a report about the shell you are in, and a
 * readiness check that silently improved the environment it was auditing would be answering a
 * different question than the one it was asked.
 */
function loadDotEnv(): { readonly path: string; readonly set: readonly string[] } | null {
  if (!existsSync(ENV_FILE)) return null;
  const set: string[] = [];
  for (const raw of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined && process.env[key] !== "") continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (value === "") continue;
    process.env[key] = value;
    set.push(key);
  }
  return { path: ENV_FILE, set };
}

// ---------------------------------------------------------------------------------------------
// The `@crr/runtime` slice, hand-typed - see the file header on why it is not imported by name
// ---------------------------------------------------------------------------------------------

interface RuntimeClock {
  now(): Timestamp;
  elapsedMs(): number;
  sleep(ms: number): Promise<void>;
}

interface RuntimeJournal {
  readonly events: readonly JournalEvent[];
  close(): void;
}

interface RuntimeEvidenceSink {
  refs(): readonly EvidenceRef[];
}

interface RuntimeIdSource {
  runId(): RunId;
  leaseToken(): LeaseToken;
}

interface BrokeredSession {
  readonly sessionId: string;
  readonly surface: Surface;
}

interface SessionBroker {
  open(
    profile: string,
    tenant: { readonly tenantId: string; readonly appInstanceId: string },
  ): Promise<BrokeredSession>;
  refresh(sessionId: string): Promise<"refreshed" | "reopened" | "failed">;
  close(sessionId: string): Promise<void>;
}

interface VerificationReport {
  readonly mode: string;
  readonly status: "verified" | "unverified";
  readonly grade: string | null;
  readonly coveredThroughStep: string | null;
  readonly stoppedBeforeStep: string | null;
  readonly reason: string;
  readonly result: ReplayResultDocument | null;
  readonly journal: RuntimeJournal | null;
  readonly evidence: RuntimeEvidenceSink | null;
  readonly verification: unknown;
}

interface CanaryHitView {
  readonly file: string;
  readonly view: string;
  readonly secret: string;
  readonly encoding: string;
  readonly line: number | null;
}

interface CanaryReportView {
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

interface RuntimeModule {
  verifyAndDraft(options: {
    readonly contract: CapabilityContract;
    readonly artifact: CapabilityArtifact;
    readonly args: Readonly<Record<string, unknown>>;
    readonly tenant: { readonly tenantId: string; readonly appInstanceId: string };
    readonly allowlist: Allowlist;
    readonly broker: SessionBroker;
    readonly ids?: RuntimeIdSource;
    readonly evidence?: RuntimeEvidenceSink;
    readonly journal?: (runId: RunId, clock: RuntimeClock) => RuntimeJournal;
    readonly perceiveDeadlineMs?: number;
  }): Promise<{
    readonly report: VerificationReport;
    readonly artifact: CapabilityArtifact | null;
  }>;
  runRedactionCanary(options: {
    readonly bundleDir: string;
    readonly secrets: readonly { readonly label: string; readonly value: string }[];
    readonly skip?: (relativePath: string) => boolean;
  }): CanaryReportView;
  renderCanaryReport(report: CanaryReportView): string;
  randomIds(): RuntimeIdSource;
  FileJournal: new (options: {
    readonly runId: RunId;
    readonly clock: RuntimeClock;
    readonly path: string;
  }) => RuntimeJournal;
  FileEvidenceSink: new (dir: string) => RuntimeEvidenceSink;
}

// ---------------------------------------------------------------------------------------------
// The driver and the fixture, also by path
// ---------------------------------------------------------------------------------------------

interface PlaywrightPage {
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
}
interface PlaywrightBrowser {
  newPage(options?: unknown): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightModule {
  chromium: {
    launch(options?: unknown): Promise<PlaywrightBrowser>;
    executablePath(): string;
  };
}

interface FixtureServer {
  readonly origin: string;
  close(): Promise<unknown>;
}

/** The route table the driver canonicalizes with. `/member/:memberId` is a PATTERN here and that is
 *  load-bearing: an `Observation` is written into the evidence bundle, and a member number in a
 *  path is persisted member data (SPEC section 3.6). */
const ROUTES: readonly RoutePattern[] = [
  { id: "search" as RouteId, originAlias: "corebank", path: "/search", frame: "content" },
  {
    id: "search-results" as RouteId,
    originAlias: "corebank",
    path: "/search/results",
    frame: "content",
  },
  {
    id: "member-by-memberid" as RouteId,
    originAlias: "corebank",
    path: "/member/:memberId",
    frame: "content",
  },
];

/** The deployment allowlist the VERIFICATION replay runs under, which is not the discovery one.
 *  Same routes and the same ceiling; the two dialog verbs are added because a replay may have to
 *  answer an interstitial the discovery run never met. */
const REPLAY_ALLOWLIST: Allowlist = {
  ...ALLOWLIST,
  actionKinds: [...ALLOWLIST.actionKinds, "acceptDialog", "dismissDialog"],
};

// ---------------------------------------------------------------------------------------------
// Output: printed and kept, because the printed thing is a deliverable
// ---------------------------------------------------------------------------------------------

const lines: string[] = [];
const out = (line = ""): void => {
  lines.push(line);
  process.stdout.write(`${line}\n`);
};
const rule = (title: string): void => {
  out();
  out(`── ${title} ${"─".repeat(Math.max(0, 92 - title.length))}`);
  out();
};
const money = (usd: number): string => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
const num = (n: number): string => n.toLocaleString("en-US");

// ---------------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------------

const HELP = `
pnpm discover - the live discovery runner (BRIEF section 11: this command spends money)

  --dry-run                  Run the ENTIRE runner against the VCR replay adapter. No API call, no
                             credential, no cent. Output goes to .scratch/discovery-dry-run/.
  --yes                      Required to make a live model call. Without it the runner prints the
                             confirmation screen and stops.
  --model <id>               Default ${DEFAULT_MODEL_ID}. Must be a model MODEL_RATES knows the
                             price of; an unknown id is refused rather than run un-budgeted.
  --effort <low|medium|high|xhigh|max>
                             Default high, which is also the API default.
  --max-usd <n>              Cumulative spend ceiling for the whole run. Default ${DISCOVER_MAX_USD.toFixed(2)}.
                             Enforced BETWEEN TURNS from the usage the provider returned, and the
                             next turn is projected before it is taken, so this is a ceiling.
  --max-output-tokens <n>    Per-turn max_tokens. Default ${DISCOVER_MAX_OUTPUT_TOKENS} (the adapter's
                             own default is ${DEFAULT_MAX_TOKENS}; see DISCOVER_MAX_OUTPUT_TOKENS).
  --max-total-tokens <n>     Absolute cumulative token ceiling, price-independent backstop.
                             Default ${num(DEFAULT_MAX_TOTAL_TOKENS)}.
  --max-turns <n>            Default ${DEFAULT_LIMITS.maxTurns} (DEFAULT_LIMITS.maxTurns).
  --out <dir>                Override the destination directory.
  --force                    Overwrite an existing transcript in the destination.
  --lenient-vcr              --dry-run only. Replay the rehearsal transcript without checking that
                             the message history digests match. See rehearse().
  --help                     This text.

Run \`pnpm preflight\` first. It prices the request this runner will send, using this runner's own
goal, allowlist and prompt, and it makes no model call.
`.trimStart();

interface Flags {
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly modelId: string;
  readonly effort: ModelEffort;
  readonly maxUsd: number;
  readonly maxOutputTokens: number;
  readonly maxTotalTokens: number;
  readonly maxTurns: number;
  readonly outDir: string;
  readonly force: boolean;
  readonly lenientVcr: boolean;
}

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

function parseFlags(): Flags | null {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      model: { type: "string" },
      effort: { type: "string", default: "high" },
      "max-usd": { type: "string" },
      "max-output-tokens": { type: "string" },
      "max-total-tokens": { type: "string" },
      "max-turns": { type: "string" },
      out: { type: "string" },
      force: { type: "boolean", default: false },
      "lenient-vcr": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help === true) {
    process.stdout.write(HELP);
    return null;
  }

  const positive = (name: string, raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number, not "${raw}"`);
    }
    return value;
  };

  const effort = values.effort ?? "high";
  if (!EFFORTS.includes(effort)) {
    throw new Error(`--effort must be one of ${EFFORTS.join(", ")}, not "${effort}"`);
  }

  const dryRun = values["dry-run"] === true;
  return {
    dryRun,
    yes: values.yes === true,
    modelId: values.model ?? process.env.CRR_MODEL ?? DEFAULT_MODEL_ID,
    effort: effort as ModelEffort,
    maxUsd: positive("--max-usd", values["max-usd"], DISCOVER_MAX_USD),
    maxOutputTokens: Math.floor(
      positive("--max-output-tokens", values["max-output-tokens"], DISCOVER_MAX_OUTPUT_TOKENS),
    ),
    maxTotalTokens: Math.floor(
      positive("--max-total-tokens", values["max-total-tokens"], DEFAULT_MAX_TOTAL_TOKENS),
    ),
    maxTurns: Math.floor(positive("--max-turns", values["max-turns"], DEFAULT_LIMITS.maxTurns)),
    outDir: values.out !== undefined ? resolve(values.out) : dryRun ? DRY_OUT : LIVE_OUT,
    force: values.force === true,
    lenientVcr: values["lenient-vcr"] === true,
  };
}

// ---------------------------------------------------------------------------------------------
// The spend ledger
// ---------------------------------------------------------------------------------------------

/**
 * Everything the runner knows about what the run has cost, and what the next turn would cost.
 *
 * The ledger is fed from the loop's own journal (`turn.responded` carries the provider's `usage`),
 * so the numbers printed live and the numbers the guard decides on come from the same place: the
 * response. Nothing here is an estimate except `projectNext`, which is labelled as one and is
 * deliberately pessimistic in the only direction that is safe.
 */
class SpendLedger implements SpendSnapshot {
  readonly turns: TurnCost[] = [];
  #usage: ModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  #lastPromptTokens = 0;
  #lastOutputTokens = 0;
  #measuredToolResultTokens = INITIAL_TOOL_RESULT_TOKENS;

  constructor(
    private readonly rate: ModelRate,
    private readonly maxOutputTokens: number,
    private readonly firstTurnPromptTokens: number,
  ) {}

  get usage(): ModelUsage {
    return this.#usage;
  }

  get spentUsd(): number {
    return costOf(this.#usage, this.rate);
  }

  get billed(): number {
    return billedTokens(this.#usage);
  }

  /** One turn's provider-reported usage, folded in. Returns the row for printing. */
  record(turn: number, usage: ModelUsage, stopReason: string | null, latencyMs: number): TurnCost {
    const prompt = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
    if (this.#lastPromptTokens > 0) {
      // The measured size of the tool result that was appended between the previous turn and this
      // one. Clamped at zero: a shrinking prompt means the history was rebuilt, not that a tool
      // result had negative size.
      const growth = prompt - this.#lastPromptTokens - this.#lastOutputTokens;
      if (growth > 0) this.#measuredToolResultTokens = growth;
    }
    this.#lastPromptTokens = prompt;
    this.#lastOutputTokens = usage.outputTokens;

    const before = this.spentUsd;
    this.#usage = {
      inputTokens: this.#usage.inputTokens + usage.inputTokens,
      outputTokens: this.#usage.outputTokens + usage.outputTokens,
      cacheCreationInputTokens:
        this.#usage.cacheCreationInputTokens + usage.cacheCreationInputTokens,
      cacheReadInputTokens: this.#usage.cacheReadInputTokens + usage.cacheReadInputTokens,
    };
    const row: TurnCost = {
      turn,
      usage,
      turnUsd: this.spentUsd - before,
      runUsd: this.spentUsd,
      stopReason,
      latencyMs,
    };
    this.turns.push(row);
    return row;
  }

  /**
   * What the NEXT turn would cost, at worst.
   *
   * Pessimistic on purpose, in three separate ways, because this number is the thing standing
   * between a confused model and the author's card:
   *   · the whole next prompt is charged at the FULL input rate, ignoring the cache discount that
   *     will in fact apply to the 2,034-token prefix;
   *   · the next output is charged at `max_tokens`, not at what the model has been emitting;
   *   · the tool result is charged at the largest growth measured so far.
   */
  projectNext(): { readonly promptTokens: number; readonly usd: number } {
    const promptTokens =
      this.#lastPromptTokens === 0
        ? this.firstTurnPromptTokens
        : this.#lastPromptTokens + this.#lastOutputTokens + this.#measuredToolResultTokens;
    const usd =
      (promptTokens * this.rate.input + this.maxOutputTokens * this.rate.output) / 1_000_000;
    return { promptTokens, usd };
  }
}

// ---------------------------------------------------------------------------------------------
// Booting the target
// ---------------------------------------------------------------------------------------------

async function startFixture(): Promise<FixtureServer> {
  const module = (await import(pathToFileURL(FIXTURE_SERVER).href)) as {
    startFixtureServer(opts: { port?: number }): Promise<FixtureServer>;
  };
  return module.startFixtureServer({ port: 0 });
}

const playwright = createRequire(`${SURFACE_BROWSER}/package.json`)(
  "playwright",
) as PlaywrightModule;

const browserDriver = (await import(
  pathToFileURL(resolve(SURFACE_BROWSER, "src", "index.ts")).href
)) as {
  attachBrowserSurface(options: {
    page: unknown;
    origins: Readonly<Record<string, string>>;
    routes: readonly RoutePattern[];
    primaryFrame: string;
    geometry: string;
    lease?: LeaseToken;
  }): Promise<Surface & { capabilities(): SurfaceCapabilities }>;
};

const runtime = (await import(
  pathToFileURL(resolve(RUNTIME, "src", "index.ts")).href
)) as RuntimeModule;

/**
 * A page on the fixture, with a `Surface` over it.
 *
 * `lease` is passed for the discovery surface and withheld for the verification one, and the
 * difference is not cosmetic: during discovery the LOOP holds the lease (BRIEF section 3.5 - the
 * executor rejects actions from a non-holder), while a replay's `LeaseAuthority` mints its own
 * token and installs it on the surface itself. Handing the interpreter a pre-leased surface would
 * make its first dispatch fail `lease-not-held`.
 */
async function openSurface(
  browser: PlaywrightBrowser,
  origin: string,
  options: { readonly lease?: LeaseToken } = {},
): Promise<Surface & { capabilities(): SurfaceCapabilities }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // The frameset first: `banner`, `nav` and `content` only exist once the top document has loaded,
  // and every route this program names lands in `content`. The content frame's own default src is
  // `/search`, which is why the emitted flow has no opening `navigate` step.
  await page.goto(`${origin}/`, { waitUntil: "load" });
  return browserDriver.attachBrowserSurface({
    page,
    origins: { corebank: origin },
    routes: ROUTES,
    primaryFrame: "content",
    geometry: "actionable",
    ...(options.lease === undefined ? {} : { lease: options.lease }),
  });
}

/**
 * A `Surface` whose `perceive` waits for two consecutive agreeing snapshots.
 *
 * `Surface.act` dispatches and returns; it does not wait for a navigation, because waiting is a
 * POLICY and the port is a mechanism (`@crr/runtime`'s `settle()` owns it at replay time, with a
 * budget and a ledger). The discovery loop has no settle loop of its own by design - SPEC section
 * 6.1 leaves readiness to the model's next `observe` - so a click on Search, perceived immediately,
 * returns the screen the browser has not navigated away from yet, and the model is charged a turn
 * to look at a screen that no longer exists. `test/fixtures/capture-corebank-web.ts` measured
 * exactly that and this is the same wrapper, for the same reason and with the same law.
 */
function settling(surface: Surface, budgetMs = 8000): Surface {
  return {
    perceive: async (opts): Promise<PerceiveResult> => {
      const deadline = Date.now() + budgetMs;
      let previous: string | null = null;
      let last = await surface.perceive(opts);
      while (Date.now() < deadline) {
        const key = last.ok
          ? `${last.observation.route?.path ?? "-"}|${last.observation.skeletonDigest}|${last.observation.stability.settled}`
          : `fault:${last.fault.kind}`;
        if (key === previous && last.ok && last.observation.stability.settled) return last;
        previous = key;
        await new Promise((r) => setTimeout(r, 80));
        last = await surface.perceive(opts);
      }
      return last;
    },
    act: surface.act.bind(surface),
    capture: surface.capture.bind(surface),
    capabilities: surface.capabilities.bind(surface),
  };
}

// ---------------------------------------------------------------------------------------------
// The confirmation screen
// ---------------------------------------------------------------------------------------------

function confirm(
  flags: Flags,
  rate: ModelRate,
  origin: string,
  env: ReturnType<typeof loadDotEnv>,
) {
  rule("WHAT THIS RUN WILL DO - read it, then decide");

  const worstTurn =
    ((rate.input * INITIAL_TOOL_RESULT_TOKENS + rate.output * flags.maxOutputTokens) / 1_000_000) *
    1;

  out(
    `      mode            ${flags.dryRun ? "DRY RUN - no API call will be made" : "LIVE - THIS SPENDS REAL MONEY"}`,
  );
  out(
    `      adapter         ${flags.dryRun ? "replay (VCR), fed by a rehearsal recorded here" : "anthropic (Messages API)"}`,
  );
  out(`      model           ${flags.modelId}   $${rate.input}/Mtok in, $${rate.output}/Mtok out`);
  out(`      effort          ${flags.effort}`);
  out();
  out(`      goal            ${LIVE_GOAL}`);
  out(
    `      member          ${LIVE_MEMBER_ID}, synthetic, and deliberately NOT the member \`pnpm demo\` uses`,
  );
  out(`      tenant          ${LIVE_TENANT.tenantId} / ${LIVE_TENANT.appInstanceId}`);
  out(`      target          ${origin}   (alias "corebank", loopback fixture)`);
  out(`      entry           ${ENTRY_ROUTE}`);
  out();
  out("      ALLOWLIST - this is everything the model may do while it drives");
  for (const route of ALLOWLIST.routes) {
    out(`        ${`${route.originAlias}${route.pathPattern}`.padEnd(44)} ${route.maxEffect}`);
  }
  out(`        action kinds            ${ALLOWLIST.actionKinds.join(", ")}`);
  out(
    `        discoveryMaxEffect      ${ALLOWLIST.discoveryMaxEffect}   <- no irreversible action can be dispatched`,
  );
  out("        approval token          none (the loop is given approval: null)");
  out();
  out("      BUDGET - enforced between turns from the usage the provider returns");
  out(
    `        max spend, whole run    ${money(flags.maxUsd)}   (${((flags.maxUsd / SPEND_CAP_USD) * 100).toFixed(0)}% of the $${SPEND_CAP_USD} project cap)`,
  );
  out(
    `        max_tokens per turn     ${num(flags.maxOutputTokens)}   (adapter default is ${num(DEFAULT_MAX_TOKENS)}; lowered - see DISCOVER_MAX_OUTPUT_TOKENS)`,
  );
  out(`        max turns               ${flags.maxTurns}`);
  out(`        max billed tokens       ${num(flags.maxTotalTokens)}   price-independent backstop`);
  out(
    `        one turn's ceiling      ~${money(worstTurn)} at max_tokens with a ${num(INITIAL_TOOL_RESULT_TOKENS)}-token prompt`,
  );
  out();
  out("      THE GUARD IS A CEILING, NOT A TARGET. Before every turn the runner projects that");
  out("      turn's worst case - the whole prompt at full input rate, the output at max_tokens -");
  out("      and stops the run cleanly if it would cross the cap. Nothing is thrown away when it");
  out("      does: the transcript, the journal and the recorded steps are all written down.");
  out();
  out(`      destination     ${flags.outDir.replace(`${REPO}/`, "")}`);
  out(
    `      credential      ${env === null ? "no .env file" : `${env.set.length === 0 ? "nothing set from" : `${env.set.join(", ")} loaded from`} .env`}`,
  );
  out();
}

// ---------------------------------------------------------------------------------------------
// The rehearsal model (--dry-run)
// ---------------------------------------------------------------------------------------------

/**
 * Record a transcript from the hand-authored script against the live application, then serve it
 * back through the VCR adapter.
 *
 * WHY TWO PASSES RATHER THAN A COMMITTED FIXTURE. The committed transcript
 * (`corebank-member-lookup.synthetic.transcript.json`) was recorded against frozen observations. A
 * VCR replay checks that the message history the loop is building digests to the recorded one, and
 * a history built from a LIVE browser is not the history built from a file - so replaying the
 * committed fixture against a real Chromium would fail on the first turn for a reason that has
 * nothing to do with the runner. Recording the rehearsal here, against this browser, in this
 * process, is what makes the digests comparable and therefore what makes `strict` mean something.
 *
 * WHAT THE REHEARSAL DOES AND DOES NOT PROVE. It exercises every line of this runner: the fixture
 * boot, the driver, the loop, the policy chokepoint, the secret substitution, the budget guard, the
 * recorder, synthesis, the verification replay, the bundle writer and both canary passes. It does
 * NOT exercise the Anthropic adapter's request body or its error mapping - those are hermetic unit
 * tests in `test/anthropic-adapter.test.ts` - and it cannot tell you whether a real model can do
 * this task, which is the entire reason the live run is worth paying for.
 */
async function rehearse(
  browser: PlaywrightBrowser,
  origin: string,
  flags: Flags,
): Promise<DiscoveryModel> {
  out("      pass 1 of 2: recording a rehearsal transcript from the hand-authored script");
  const surface = settling(await openSurface(browser, origin, { lease: CONTROL.token }));
  const recorder = createRecordingModel(
    createScriptedModel(rehearsalScript(), { modelId: `${flags.modelId} (REHEARSAL, not called)` }),
    {
      synthetic: true,
      recordedAt: null,
      note:
        "SYNTHETIC REHEARSAL. The assistant turns were authored by hand in " +
        "packages/discovery/test/fixtures/corebank-web.ts; no provider was called and no token was " +
        "spent. NOT evidence of a discovery run.",
    },
  );
  const run = await runDiscoveryLoop({
    goal: LIVE_GOAL,
    target: {
      tenantId: LIVE_TENANT.tenantId,
      originAlias: "corebank",
      entryRoute: ENTRY_ROUTE,
    },
    model: recorder,
    surface,
    allowlist: ALLOWLIST,
    control: CONTROL,
    limits: { maxTurns: flags.maxTurns, perceiveDeadlineMs: PERCEIVE_DEADLINE_MS },
  });
  if (run.status !== "reached-goal") {
    throw new Error(
      [
        `the rehearsal recording ended "${run.status}" (${run.summary}); the fixture's markup has`,
        "probably moved under the node references in REFS. Re-run",
        "`pnpm -F @crr/discovery fixtures:capture` and re-choose them.",
      ].join(" "),
    );
  }
  out(`      pass 1 done: ${run.turns} turns, ${run.steps.length} steps recorded`);
  out(
    `      pass 2 of 2: replaying that transcript through the VCR adapter, strict=${!flags.lenientVcr}`,
  );
  out();
  return createReplayModel(recorder.transcript(), { strict: !flags.lenientVcr });
}

// ---------------------------------------------------------------------------------------------
// The canaries
// ---------------------------------------------------------------------------------------------

interface CanaryPass {
  readonly id: string;
  readonly title: string;
  readonly why: string;
  readonly gates: boolean;
  readonly report: CanaryReportView;
}

interface CanaryOutcome {
  readonly clean: boolean;
  readonly passes: readonly CanaryPass[];
  readonly notSearched: readonly string[];
}

/** The recording of the discovery conversation, as opposed to everything the system derived from
 *  it. The distinction is the whole basis of pass 4's scope. */
const RECORDING_FILES = new Set(["transcript.json", "discovery.log", "journal.jsonl"]);

/**
 * Four passes over what was just written, three of them gating, and the scopes are the argument.
 *
 * A single whole-bundle grep for the member number is the check everybody reaches for first, and on
 * this deliverable it is unanswerable: the model had to be TOLD which member to look up, it typed
 * the number, and the application printed it back in the results grid and in its own query string.
 * A discovery recording that did not contain the member number would be a recording of a different
 * conversation. So the question is not "does this value appear" but "does it appear anywhere it was
 * promised not to", and the four scopes below are that question asked four ways.
 *
 * PASS 1 - THE SYNTHESIZED DOCUMENTS. `synthesized/` only. Needles: the caller's value AND every
 * member datum the run read off the screen. GATES. This is BRIEF section 3.6 - "the artifact stores
 * shapes, never values" - and it is the pass that catches the class of defect FINAL-STATUS section
 * 7.2 records: `deriveOutputs` folding a cell's accessible name into the query it derived, which put
 * "ALVAREZ, DANA (SYNTHETIC)" and "1,204.55" into `flow.vocabulary`, in the one document that is
 * committed, diffed and SIGNED. Parameterization could not have caught that - the member's name was
 * never in the goal, so it was never bound to anything - which is exactly why this pass searches for
 * values the taint model has no opinion about.
 *
 * PASS 2 - THE REPLAY. Everything the verification replay wrote. Needles: the caller's value. GATES.
 * At REPLAY time that number is an argument the interpreter binds as a `TaintedValue`, so SPEC
 * section 8.3's table applies in full: it reaches the driver and the caller's typed outputs, and it
 * reaches the journal, the evidence captures and the result document never. Unlike the discovery
 * half, this claim is total, and this pass is what makes it checkable.
 *
 * PASS 3 - CREDENTIAL SHAPES, over the whole bundle, with no value needles at all. GATES. A key in
 * an evidence file is a finding regardless of what any parameter was bound to, and this is the one
 * pass that covers `transcript.json` - the file most likely to hold a stray header - completely.
 *
 * PASS 4 - THE DISCOVERY RECORDING. `transcript.json`, `discovery.log`, `journal.jsonl`. Needles:
 * the caller's value. REPORTED WITH EVERY LINE, AND DELIBERATELY NOT GATED. Every hit here is the
 * model being told, or typing, or being shown, the member number it was asked about. Listing them
 * with their line numbers is what makes that claim checkable by a reader rather than asserted by
 * this comment; gating on them would make the check unpassable and therefore meaningless.
 */
function runCanaries(outDir: string, run: DiscoveryRun): CanaryOutcome {
  const callerValue = [
    { label: "the goal's member number (the caller's argument)", value: LIVE_MEMBER_ID },
  ];

  const notSearched: string[] = [];
  const memberData: { label: string; value: string }[] = [];
  for (const output of run.outputs) {
    const node = output.observation.nodes.find((candidate) => candidate.id === output.nodeId);
    const value = node === undefined ? "" : (node.value ?? node.name ?? node.text ?? "");
    if (value.length < MIN_NEEDLE_LENGTH) {
      notSearched.push(
        `${output.outputName}: ${value.length} characters, under the ${MIN_NEEDLE_LENGTH}-character floor for a distinctive needle`,
      );
      continue;
    }
    memberData.push({
      label: `recorded member datum / ${output.outputName} (read off the screen)`,
      value,
    });
  }

  const passes: CanaryPass[] = [
    {
      id: "1 documents",
      title: "the synthesized documents",
      why: "BRIEF 3.6: an artifact stores shapes, never values - neither the caller's nor the member's",
      gates: true,
      report: runtime.runRedactionCanary({
        bundleDir: outDir,
        secrets: [...callerValue, ...memberData],
        skip: (path) => !path.startsWith("synthesized/"),
      }),
    },
    {
      id: "2 replay",
      title: "everything the verification replay wrote",
      why: "SPEC 8.3: at replay time the caller's argument is a bound value, and this claim is total",
      gates: true,
      report: runtime.runRedactionCanary({
        bundleDir: outDir,
        secrets: callerValue,
        skip: (path) => !path.startsWith("verification"),
      }),
    },
    {
      id: "3 credentials",
      title: "the whole bundle, credential shapes only",
      why: "a key in an evidence file is a finding whatever any parameter was bound to",
      gates: true,
      report: runtime.runRedactionCanary({ bundleDir: outDir, secrets: [] }),
    },
    {
      id: "4 recording",
      title: "the discovery recording (reported, not gated)",
      why: "the model was told the number, typed it, and was shown it; every hit below is one of those",
      gates: false,
      report: runtime.runRedactionCanary({
        bundleDir: outDir,
        secrets: callerValue,
        skip: (path) => !RECORDING_FILES.has(path),
      }),
    },
  ];

  return {
    clean: passes.every((pass) => !pass.gates || pass.report.clean),
    passes,
    notSearched,
  };
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

const env = loadDotEnv();

let flags: Flags | null;
try {
  flags = parseFlags();
} catch (cause) {
  process.stderr.write(`${String(cause instanceof Error ? cause.message : cause)}\n\n${HELP}`);
  process.exit(2);
}
if (flags === null) process.exit(0);
const options: Flags = flags;

out();
out(
  "  ╔══════════════════════════════════════════════════════════════════════════════════════════╗",
);
out(
  "  ║  capability-record-replay - LIVE DISCOVERY RUNNER                                         ║",
);
out(
  "  ║  The model discovers once. The recording becomes a capability. Replay needs no model.     ║",
);
out(
  "  ╚══════════════════════════════════════════════════════════════════════════════════════════╝",
);
out();
if (env === null) {
  out("      no .env file at the repository root; the shell's environment is the only source");
} else if (env.set.length === 0) {
  out(
    `      .env read (${env.path.replace(`${REPO}/`, "")}); every variable in it was already set in this shell`,
  );
} else {
  out(`      .env loaded (${env.path.replace(`${REPO}/`, "")}); set here: ${env.set.join(", ")}`);
  out("      values are never printed, and an already-set variable always wins");
}

const rate = rateFor(options.modelId);
if (rate === null) {
  process.stderr.write(
    [
      "",
      `  REFUSED. "${options.modelId}" is not in MODEL_RATES, so this runner does not know what a`,
      "  token of it costs, so it cannot enforce a spend cap on it. A budget guard that guesses the",
      "  rate is not a budget guard.",
      "",
      `  Known: ${MODEL_RATES.map((r) => r.id).join(", ")}`,
      "  Add the model to MODEL_RATES in packages/discovery/tools/live-run.ts, with the published",
      "  price verified against the `claude-api` skill rather than written from memory.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

if (!options.dryRun && (process.env.ANTHROPIC_API_KEY ?? "") === "") {
  process.stderr.write(
    [
      "",
      "  ANTHROPIC_API_KEY is not set, and this runner already tried to load `.env` for you.",
      "",
      "  Either put it in the repository-root `.env` (see `.env.example`):",
      "",
      "      ANTHROPIC_API_KEY=sk-ant-...",
      "",
      "  or export it for this shell:",
      "",
      "      export ANTHROPIC_API_KEY=sk-ant-...",
      "",
      "  To rehearse the entire runner with no credential and no cost:",
      "",
      "      pnpm discover --dry-run",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

const transcriptPath = join(options.outDir, "transcript.json");
if (existsSync(transcriptPath) && !options.force) {
  process.stderr.write(
    [
      "",
      `  ${transcriptPath.replace(`${REPO}/`, "")} already exists.`,
      "",
      "  A live transcript is the one file in this repository that cannot be regenerated for free,",
      "  so it is not overwritten by accident. Move it aside, or pass --force.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

const fixture = await startFixture();
let exitCode = 1;
let browser: PlaywrightBrowser | null = null;

try {
  confirm(options, rate, fixture.origin, env);

  if (!options.dryRun && !options.yes) {
    out("      NOT PROCEEDING. This run would spend the author's money and `--yes` was not given.");
    out();
    out("        pnpm discover --dry-run     rehearse all of it, free");
    out("        pnpm discover --yes         perform it");
    out();
    exitCode = 2;
  } else {
    if (!existsSync(playwright.chromium.executablePath())) {
      throw new Error(
        "no Chromium build was found. Run `pnpm exec playwright install chromium`; this runner " +
          "drives the fixture through a real browser and there is no useful fallback.",
      );
    }
    browser = await playwright.chromium.launch();

    // -----------------------------------------------------------------------------------------
    // 1. The discovery run
    // -----------------------------------------------------------------------------------------

    rule("1. DISCOVERY - the model drives, and every action passes the policy chokepoint");

    const inner: DiscoveryModel = options.dryRun
      ? await rehearse(browser, fixture.origin, options)
      : createAnthropicModel({
          modelId: options.modelId,
          effort: options.effort,
          maxTokens: options.maxOutputTokens,
        });

    const recordedAt = new Date().toISOString();
    const model: RecordingModel = createRecordingModel(inner, {
      synthetic: options.dryRun,
      recordedAt,
      note: options.dryRun
        ? [
            "REHEARSAL. `pnpm discover --dry-run`: the turns were served by the VCR replay adapter",
            "from a transcript recorded moments earlier by a hand-authored script. No provider was",
            "called. NOT evidence of a discovery run.",
          ].join(" ")
        : [
            "LIVE. Recorded by `pnpm discover --yes` from the `anthropic` adapter against the",
            `Anthropic Messages API on ${recordedAt}, driving fixtures/corebank-web on loopback`,
            "through @crr/surface-browser. The member number is a LITERAL in the goal, not a bound",
            "secret - the model was told it, typed it, and was shown it in the application's own",
            "output - so it appears in this transcript. See LIVE_GOAL in tools/live-run.ts for why",
            "that is the deliberate choice, and canary/recording.json for every occurrence. What it",
            "must NOT appear in is the synthesized documents and anything the verification replay",
            "wrote; canary passes 1 and 2 gate the exit code on exactly that.",
          ].join(" "),
    });

    // The prompt this runner will send, sized the way `pnpm preflight` sizes it, so the first
    // turn's projection is not a guess. Character count over 3.3 is the same pessimistic estimator
    // preflight uses and is labelled an estimate there for the same reason: `messages.countTokens`
    // is itself a billed round trip.
    const firstTurnPromptTokens = Math.ceil((2265 + 4447 + LIVE_GOAL.length + 400) / 3.3);
    const ledger = new SpendLedger(rate, options.maxOutputTokens, firstTurnPromptTokens);

    const journalPath = join(options.outDir, "journal.jsonl");
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, "");

    const discoverySurface = settling(
      await openSurface(browser, fixture.origin, { lease: CONTROL.token }),
    );
    const capabilities = discoverySurface.capabilities();

    const run: DiscoveryRun = await runDiscoveryLoop({
      goal: LIVE_GOAL,
      target: {
        tenantId: LIVE_TENANT.tenantId,
        originAlias: "corebank",
        entryRoute: ENTRY_ROUTE,
      },
      model,
      surface: discoverySurface,
      allowlist: ALLOWLIST,
      control: CONTROL,
      limits: { maxTurns: options.maxTurns, perceiveDeadlineMs: PERCEIVE_DEADLINE_MS },
      journal: (event: DiscoveryEvent) => {
        writeFileSync(journalPath, `${JSON.stringify(event)}\n`, { flag: "a" });
        if (event.type === "turn.responded") {
          const row = ledger.record(
            event.turn,
            event.usage as ModelUsage,
            event.stopReason,
            event.latencyMs,
          );
          out(
            `      turn ${String(row.turn).padStart(2)}  ` +
              `in ${num(row.usage.inputTokens).padStart(7)}  ` +
              `cache w/r ${num(row.usage.cacheCreationInputTokens)}/${num(row.usage.cacheReadInputTokens)}  ` +
              `out ${num(row.usage.outputTokens).padStart(6)}  ` +
              `${String(row.stopReason ?? "-").padEnd(10)} ` +
              `turn ${money(row.turnUsd)}   RUN ${money(row.runUsd)} / ${money(options.maxUsd)}`,
          );
        }
        if (event.type === "policy.decided" && !event.decision.allow) {
          out(
            `              POLICY DENIED  ${event.actionKind} (${event.effect}) - ${event.decision.reason}`,
          );
        }
      },
      // KEEP WHAT THE RUN PAID FOR, WHATEVER ENDS IT. Without this the loop rethrows, and a rate
      // limit on turn 9 would reach the outer catch below with `transcript.json`, `spend.json`,
      // `provenance.json` and `README.md` still unwritten - nine paid turns discarded to report an
      // error that fits on one line. See `onUnexpectedError` in src/loop.ts: it is opt-in because
      // the VCR's strict digest check has to stay loud for callers whose runs cost nothing, and
      // this is the caller whose run costs money.
      onUnexpectedError: "keep-the-run",
      // THE SPEND GATE. See `TurnBudgetProbe` in src/loop.ts for why it is a loop option rather
      // than a wrapper around the model.
      stopBeforeTurn: (probe: TurnBudgetProbe): string | null => {
        const projected = ledger.projectNext();
        const spent = costOf(probe.usage, rate);
        if (spent + projected.usd > options.maxUsd) {
          return [
            `the spend cap stopped this run: ${money(spent)} has been billed and turn`,
            `${probe.nextTurn} projects to at most ${money(projected.usd)}`,
            `(${num(projected.promptTokens)} prompt tokens at $${rate.input}/Mtok plus`,
            `${num(options.maxOutputTokens)} output tokens at $${rate.output}/Mtok), which would`,
            `cross the ${money(options.maxUsd)} ceiling. Raise it with --max-usd if that is what`,
            "you want to do.",
          ].join(" ");
        }
        const billed = billedTokens(probe.usage);
        const wouldBe = billed + projected.promptTokens + options.maxOutputTokens;
        if (wouldBe > options.maxTotalTokens) {
          return [
            `the token backstop stopped this run: ${num(billed)} tokens have been billed and turn`,
            `${probe.nextTurn} would take it to at most ${num(wouldBe)}, past the`,
            `${num(options.maxTotalTokens)} ceiling. This guard is price-independent; if it fired`,
            "before the spend cap did, MODEL_RATES is probably wrong.",
          ].join(" ");
        }
        return null;
      },
    });

    out();
    out(`      status          ${run.status}`);
    out(`      summary         ${run.summary}`);
    if (run.failure !== null) {
      out();
      out(`      THE RUN STOPPED ON AN ERROR: ${run.failure.name}`);
      out(`      ${run.failure.message}`);
      out();
      out("      Nothing that was already paid for has been discarded. Every turn the provider");
      out("      answered is below and in transcript.json; spend.json is the measured cost of");
      out("      exactly those turns. Synthesis and the verification replay are skipped and the");
      out("      exit code is 1, because a run that stopped on an error is not a discovery run.");
      // stderr, not `out()`: the stack carries absolute paths from this machine and `discovery.log`
      // is a committed file. `provenance.json` records the name, the message and the turn.
      if (run.failure.stack !== null) process.stderr.write(`${run.failure.stack}\n`);
      out();
    }
    out(`      turns           ${run.turns}`);
    out(`      steps recorded  ${run.steps.length}`);
    out(`      outputs noted   ${run.outputs.map((o) => o.outputName).join(", ") || "(none)"}`);
    out(`      cache hit rate  ${(run.cacheHitRate * 100).toFixed(1)}%`);
    out(
      `      MEASURED SPEND  ${money(ledger.spentUsd)}  over ${num(ledger.billed)} billed tokens`,
    );

    // `null` when there is genuinely nothing to record - the budget guard refused the very first
    // turn, or the very first call threw before a request was built. `createRecordingModel` throws
    // rather than hand back an empty transcript and it is right to, but that throw must not be the
    // thing that loses the bundle: it happens AFTER the loop returned, on a path whose whole job is
    // to write down what the run had. So it is caught, the reason is kept, and it goes in the
    // provenance and the README instead of onto the floor. Everything downstream tolerates the
    // absence and the bundle is still written: a guard that fired and then destroyed the evidence
    // of firing would be worse than no guard, because nobody could see why the run stopped.
    let transcript: Transcript | null = null;
    let transcriptProblem: string | null = null;
    try {
      transcript = model.transcript();
    } catch (cause) {
      transcriptProblem = cause instanceof Error ? cause.message : String(cause);
      out(`      no transcript   ${transcriptProblem}`);
    }
    const recordedAdapter = transcript?.provenance.adapter ?? model.adapter;
    const recordedModelId = transcript?.provenance.modelId ?? model.modelId;

    // The refusal that keeps a rehearsal out of `evidence/`, and it is enforcement rather than
    // convention: BRIEF section 10 forbids presenting a replayed transcript as a discovery run, and
    // this is the line that executes that rule. It fires on the DESTINATION, not on the flag, so
    // `--dry-run --out evidence/discovery-live` is refused too.
    if (transcript !== null && options.outDir.startsWith(LIVE_OUT)) assertRealRecording(transcript);

    const truncated = (transcript?.turns ?? []).filter(
      (t) => t.response.stopReason === "max_tokens",
    );
    if (truncated.length > 0) {
      out();
      out(
        `      WARNING: ${truncated.length} turn(s) hit max_tokens (${num(options.maxOutputTokens)}) and were CUT OFF:`,
      );
      out(`               turns ${truncated.map((t) => t.index).join(", ")}`);
      out(
        "               A tool_use block truncated mid-JSON is refused by the loop's input schema,",
      );
      out("               which the model reads as its own mistake. Raise --max-output-tokens.");
    }

    // -----------------------------------------------------------------------------------------
    // 2. Synthesis
    // -----------------------------------------------------------------------------------------

    let synthesis: SynthesisResult | null = null;
    let verification: VerificationReport | null = null;
    let drafted: CapabilityArtifact | null = null;

    if (run.status !== "reached-goal") {
      rule("2. SYNTHESIS - SKIPPED");
      out(`      The run ended "${run.status}", so there is no completed flow to synthesize.`);
      out("      Everything the run did produce is written down below; nothing is thrown away.");
    } else {
      rule(
        "2. SYNTHESIS - the recording becomes a typed, parameterized, content-addressed document",
      );

      synthesis = synthesizeCapability({
        run,
        capability: LIVE_CAPABILITY,
        vendor: LIVE_VENDOR,
        capabilities,
        tenantId: LIVE_TENANT.tenantId,
        appInstanceId: LIVE_TENANT.appInstanceId,
        runId: `run:discovery-live-${recordedAt}`,
        recordedAt: recordedAt as Timestamp,
        promptVersion: "discovery/1",
        transcriptRef: {
          digest: digestOf(transcript),
          uri: `${options.outDir.replace(`${REPO}/`, "")}/transcript.json`,
        },
      });

      out(`      capability      ${synthesis.contract.name}@${synthesis.contract.version}`);
      out(`      contract digest ${synthesis.contract.digest}`);
      out(`      artifact digest ${synthesis.artifact.digest}`);
      out(
        `      steps           ${synthesis.artifact.flow.steps.map((s) => s.instruction.kind).join(" -> ")}`,
      );
      // The naming rung is printed next to each argument because a `positional` one is the single
      // thing in this document a reviewer must fix by hand before the capability is published, and
      // the run summary is the part of the bundle anybody actually reads.
      const namedFrom = new Map(
        synthesis.report.parameters.map((one) => [one.name, one.namedFrom] as const),
      );
      out(
        `      parameters      ${synthesis.contract.inputs.map((i) => `${i.name}:${i.sensitivity} (named from ${namedFrom.get(i.name) ?? "unknown"})`).join(", ") || "(none)"}`,
      );
      out(
        `      outputs         ${synthesis.contract.outputs.map((o) => o.name).join(", ") || "(none)"}`,
      );
      out(
        `      outcomes        ${synthesis.contract.outcomes.map((o) => o.code).join(", ") || "(none - synthesis will not invent a detector)"}`,
      );
      out(`      maxEffect       ${synthesis.artifact.effects.maxEffect}`);
      out(
        `      lifecycle       ${synthesis.artifact.lifecycle.status}   verification ${synthesis.artifact.verification.status}`,
      );
      out(`      report notes    ${synthesis.report.notes.length}`);
      for (const note of synthesis.report.notes) {
        out(`        ${note.severity.padEnd(8)} ${note.code}  ${note.detail}`);
      }

      // ---------------------------------------------------------------------------------------
      // 3. Verification replay - BRIEF section 3.4
      // ---------------------------------------------------------------------------------------

      rule("3. VERIFICATION - the same artifact replayed with the MODEL OUT OF THE LOOP");

      // The argument name is READ OFF THE CONTRACT rather than assumed, because that is what a
      // calling agent would have to do - and because what synthesis called it is a result of the
      // run rather than something this script decided.
      const param = synthesis.contract.inputs[0]?.name;
      if (param === undefined) {
        throw new Error(
          "synthesis derived no parameters, so there is no argument to replay the artifact with; " +
            "the recording did not bind any value from the goal.",
        );
      }

      // A FRESH session. The discovery run left the browser on the member's record, and a
      // verification that starts from that screen is verifying against a screen the recording never
      // began on. SPEC section 7.6 gives production a session broker for exactly this reason; here
      // the runner stands in for one with a second page.
      const verifySurface = await openSurface(browser, fixture.origin);
      const broker: SessionBroker = {
        open: async () => ({ sessionId: "corebank-live-verify", surface: verifySurface }),
        // `failed`, not `refreshed`, and that is honest rather than pessimistic: this broker cannot
        // re-authenticate anything, and a broker that claimed it had would make
        // `session-expired-unrecoverable` unreachable for ever.
        refresh: async () => "failed",
        close: async () => undefined,
      };

      const verifyJournalPath = join(options.outDir, "verification-journal.jsonl");
      const result = await runtime.verifyAndDraft({
        contract: synthesis.contract,
        artifact: synthesis.artifact,
        args: { [param]: LIVE_MEMBER_ID },
        tenant: LIVE_TENANT,
        allowlist: REPLAY_ALLOWLIST,
        broker,
        ids: runtime.randomIds(),
        evidence: new runtime.FileEvidenceSink(join(options.outDir, "verification-evidence")),
        journal: (runId, clock) =>
          new runtime.FileJournal({ runId, clock, path: verifyJournalPath }),
        perceiveDeadlineMs: PERCEIVE_DEADLINE_MS,
      });
      verification = result.report;
      drafted = result.artifact;

      out(`      mode            ${verification.mode}`);
      out(`      status          ${verification.status}`);
      out(`      grade           ${verification.grade ?? "(none - nothing was established)"}`);
      out(`      covered through ${verification.coveredThroughStep ?? "-"}`);
      out(
        `      replay arm      ${verification.result?.status ?? "(the replay was not attempted)"}`,
      );
      out(`      reason          ${verification.reason}`);
      if (drafted === null) {
        out();
        out(
          "      THE ARTIFACT STAYS `proposed`. A recording is not a claim until it replays, so a",
        );
        out(
          "      verification that did not pass does not produce a draft - the document that did",
        );
        out(
          "      not verify is written down exactly as synthesis emitted it, and it is refused by",
        );
        out("      the linker in production mode (check 27) until somebody approves it.");
      } else {
        out();
        out(
          `      proposed -> ${drafted.lifecycle.status}   verification ${drafted.verification.status}/${drafted.verification.grade}`,
        );
        out("      That promotion is the RESULT of a replay rather than a field somebody set.");
      }
    }

    // -----------------------------------------------------------------------------------------
    // 4. The bundle
    // -----------------------------------------------------------------------------------------

    rule("4. THE EVIDENCE BUNDLE");

    // EVERY exit writes these four, and the function that writes them has a test that a failing
    // run reaches it - see tools/bundle.ts and test/loop-failure.test.ts. LIVE-RUN-READINESS
    // section 5.2 is the defect that motivated pulling them out of this script: they used to be
    // forty lines of `writeJson` in the middle of a `try` that a provider error jumped straight
    // out of.
    for (const file of writeCoreBundle({
      outDir: options.outDir,
      flags: options,
      run,
      transcript,
      transcriptProblem,
      recordedAt,
      adapter: recordedAdapter,
      modelId: recordedModelId,
      tenantId: LIVE_TENANT.tenantId,
      entryRoute: ENTRY_ROUTE,
      driver: capabilities.driver,
      rate,
      spend: ledger,
      verification,
      lifecycle: drafted?.lifecycle.status ?? null,
    })) {
      out(`      wrote           ${file}`);
    }

    if (synthesis !== null) {
      const dir = join(options.outDir, "synthesized");
      writeJson(join(dir, "contract.json"), synthesis.contract);
      writeJson(join(dir, "artifact.json"), drafted ?? synthesis.artifact);
      writeJson(join(dir, "report.json"), {
        _provenance: {
          adapter: recordedAdapter,
          modelId: recordedModelId,
          producedBy: "@crr/discovery synthesizeCapability()",
        },
        report: synthesis.report,
      });
      writeText(
        join(dir, "README.md"),
        [
          "# synthesized/",
          "",
          `Emitted by \`@crr/discovery\`'s \`synthesizeCapability()\` from the run recorded in`,
          `\`../transcript.json\` — adapter **\`${recordedAdapter}\`**, model id`,
          `**\`${recordedModelId}\`**${options.dryRun ? " (a REHEARSAL: no provider was called)" : ""}.`,
          "",
          "No model was in the loop for this step. Synthesis is deterministic: the same recording",
          "produces the same bytes, which is why the artifact can be content-addressed at all.",
          "",
          "| file | what it is |",
          "|---|---|",
          "| `contract.json` | the typed capability contract — inputs, outputs, outcomes. Bare, so it parses. |",
          "| `artifact.json` | the flow. Bare, so its digest is intact; it states its own adapter and model id in `provenance.model`. |",
          "| `report.json` | what synthesis could not decide without a person. |",
          "",
          "`contract.json` and `artifact.json` carry no added provenance field on purpose: an",
          "approval signs over the artifact's digest, and a wrapper key would move the value being",
          "signed to say what this file already says.",
          "",
        ].join("\n"),
      );
    }

    if (verification !== null) {
      writeJson(join(options.outDir, "verification.json"), {
        _provenance: {
          producedBy: "@crr/runtime verifyAndDraft()",
          modelInTheLoop: false,
          note:
            "BRIEF section 3.4. This replay is what promotes the artifact from `proposed` to " +
            "`draft`, and it ran with no model in the decision path - which is the property the " +
            "whole system exists to establish.",
          recordingAdapter: recordedAdapter,
          recordingModelId: recordedModelId,
        },
        mode: verification.mode,
        status: verification.status,
        grade: verification.grade,
        coveredThroughStep: verification.coveredThroughStep,
        stoppedBeforeStep: verification.stoppedBeforeStep,
        reason: verification.reason,
        verification: verification.verification,
        result: verification.result,
      });
    }

    // The log goes down BEFORE the canary runs. It is the file most likely to hold a stray value,
    // and a bundle whose log was written after the grep is a bundle with an unscanned file in it.
    writeText(join(options.outDir, "discovery.log"), `${lines.join("\n")}\n`);

    // -----------------------------------------------------------------------------------------
    // 5. The canaries
    // -----------------------------------------------------------------------------------------

    rule("5. REDACTION CANARY - the bundle is grepped before it is published");

    const canary = runCanaries(options.outDir, run);
    for (const pass of canary.passes) {
      writeJson(
        join(options.outDir, "canary", `${pass.id.split(" ")[1] ?? pass.id}.json`),
        pass.report,
      );
    }
    writeText(
      join(options.outDir, "canary", "report.txt"),
      [
        ...canary.passes.flatMap((pass) => [
          `PASS ${pass.id.toUpperCase()} - ${pass.title}`,
          `  ${pass.why}`,
          `  ${pass.gates ? "GATES the exit code." : "REPORTED ONLY - see runCanaries() in tools/discover.ts for why."}`,
          "",
          runtime.renderCanaryReport(pass.report),
          "",
        ]),
        ...(canary.notSearched.length === 0
          ? []
          : ["NOT SEARCHED, and why:", ...canary.notSearched.map((line) => `  ${line}`), ""]),
      ].join("\n"),
    );

    for (const pass of canary.passes) {
      const verdict = pass.gates ? (pass.report.clean ? "CLEAN" : "FAILED") : "reported";
      out(
        `      pass ${pass.id.padEnd(14)} ${verdict.padEnd(8)} ` +
          `${pass.report.filesScanned} files, ${num(pass.report.bytesScanned)} bytes, ` +
          `${pass.report.needles} needles, ${pass.report.hits.length} hits, ` +
          `${pass.report.forbidden.length} credential shapes`,
      );
      out(`               ${pass.why}`);
      for (const hit of pass.report.hits) {
        out(
          `        ${pass.gates ? "LEAK " : "seen "} ${hit.file}${hit.view === "bytes" ? "" : ` (${hit.view})`}${hit.line === null ? "" : `:${hit.line}`}  ${hit.secret} as ${hit.encoding}`,
        );
      }
      for (const hit of pass.report.forbidden) {
        out(`        CREDENTIAL SHAPE  ${hit.file}  ${hit.name}`);
      }
    }
    for (const line of canary.notSearched) out(`      not searched  ${line}`);

    // -----------------------------------------------------------------------------------------
    // The verdict
    // -----------------------------------------------------------------------------------------

    rule("VERDICT");

    const reachedGoal = run.status === "reached-goal";
    const verified = verification?.status === "verified";
    // The rule lives in tools/bundle.ts so it can be asserted against a real failed run rather
    // than re-derived in prose. Zero requires all three; `failed` is never one of them.
    const ok = discoveryExitCode({ run, verified, canaryClean: canary.clean }) === 0;

    out(`      discovery reached the goal    ${reachedGoal ? "yes" : `NO (${run.status})`}`);
    out(`      it replayed without a model   ${verified ? "yes" : "NO"}`);
    out(
      `      the artifact is a draft       ${drafted === null ? "NO - it stays `proposed`" : "yes"}`,
    );
    out(`      the bundle is clean           ${canary.clean ? "yes" : "NO - SEE THE LEAKS ABOVE"}`);
    out(`      measured spend                ${money(ledger.spentUsd)}`);
    out();

    if (options.dryRun) {
      out(
        "      THIS WAS A REHEARSAL. No provider was called, no token was spent, and nothing here",
      );
      out(
        "      is evidence of a discovery run. The output is in .scratch/, not in evidence/, and",
      );
      out("      `assertRealRecording` would have refused it if it had been pointed at evidence/.");
      out();
      out("      To perform the real run:   pnpm discover --yes");
    } else if (ok) {
      // PENDING.md documented a hole. The hole is closed, so the file goes: leaving it would be a
      // bundle that contains both a transcript and a note saying there is no transcript.
      const pending = join(options.outDir, "PENDING.md");
      if (existsSync(pending)) {
        rmSync(pending);
        out("      removed PENDING.md - the gap it documented is closed by the files beside it.");
      }
      out("      A REAL DISCOVERY RUN IS ON DISK. Commit it, then run `pnpm demo` so the bundle's");
      out("      MANIFEST and its own whole-bundle canary cover these files too.");
    }
    out();

    exitCode = discoveryExitCode({ run, verified, canaryClean: canary.clean });

    // Rewritten, so the log on disk contains the verdict it is the log of.
    writeText(join(options.outDir, "discovery.log"), `${lines.join("\n")}\n`);
  }
} catch (cause) {
  out();
  out(`  FAILED: ${cause instanceof Error ? cause.message : String(cause)}`);
  if (cause instanceof Error && cause.stack !== undefined) {
    process.stderr.write(`${cause.stack}\n`);
  }
  exitCode = 1;
} finally {
  await browser?.close();
  await fixture.close();
}

process.exitCode = exitCode;
