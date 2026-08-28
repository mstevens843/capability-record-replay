// `pnpm preflight` - the live-run readiness check.
//
//   pnpm preflight                    (from the repo root)
//   pnpm -F @crr/discovery preflight
//
// WHAT THIS IS FOR. BRIEF section 11 forbids every agent on this repository from making a live
// model call, and FINAL-STATUS section 7.1 records the consequence: `evidence/discovery-live/` is
// empty and the only thing that can fill it is the author, spending the author's own money against
// a $10 cap. This script exists so that the decision to spend it is made with the numbers in front
// of you rather than after the invoice: what request would go out, how big it is, what it would
// cost on two models, what the safety gate would permit while it ran, and where the recording
// would land.
//
// THIS SCRIPT MAKES NO MODEL CALL. That is not a promise, it is a property, and there are three
// separate reasons it holds:
//
//   1. It never constructs `createAnthropicModel`. It reads `ANTHROPIC_API_KEY` only to check its
//      SHAPE, and the value is never printed, never logged, and never handed to a client.
//   2. Token counting is done LOCALLY from character counts. `messages.countTokens` would be
//      exact, and it is a network round trip to the provider - so it is not used, and every token
//      figure below is labelled as the estimate it is, with a band rather than a false point value.
//   3. The only sockets it opens are to 127.0.0.1: the fixture server it boots itself, and (if a
//      Chromium build is present) a local browser driving it.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not run discovery, and it cannot: there is no runner.
// Section 6 below reports that as the blocking finding rather than papering over it, because the
// readiness check saying "you cannot spend money yet, and here is the exact reason" is the check
// working, not the check failing.
//
// IMPORTS BY PATH, AND THEY ARE DELIBERATE. `@crr/discovery` declares neither `playwright` nor
// `@crr/surface-browser` nor the fixture, and it must not: `packages/core/test/no-locator-vocabulary.test.ts`
// reads `packages/discovery/src` off disk to say that the package owning the model loop depends on
// no driver, and adding a dependency needs a `pnpm install`. Resolving them by path from a script
// outside `src/` is the precedent `test/fixtures/capture-corebank-web.ts` already sets, with the
// same reasoning written at the same kind of site.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  Action,
  Allowlist,
  LeaseToken,
  Observation,
  PerceiveResult,
  PolicyContext,
  PolicyMoment,
  RouteId,
  RoutePattern,
  Surface,
  Timestamp,
} from "@crr/core";
import { check } from "@crr/core";
import { DEFAULT_MAX_TOKENS, buildRequestBody } from "../src/adapters/anthropic.js";
import { DEFAULT_LIMITS } from "../src/loop.js";
import { DEFAULT_MODEL_ID, type ModelEffort, type ModelTurnRequest } from "../src/model-port.js";
import { projectObservation } from "../src/projection.js";
import { DISCOVERY_SYSTEM_PROMPT, renderTaskMessage } from "../src/prompt.js";
import { DISCOVERY_TOOLS, toolsWithCacheBreakpoint } from "../src/tools.js";
import { createRecordingModel } from "../src/transcript.js";
import { loadCorpus } from "../test/fixtures/corebank-web.js";
// The run's own configuration, imported from the module `tools/discover.ts` imports. Everything
// this report prices - the goal, the member, the allowlist, the ceilings, the published rates - is
// therefore the configuration the runner will use, rather than a second copy of it that is right
// until the afternoon somebody edits one of them.
import {
  ALLOWLIST,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  CONTROL,
  DISCOVER_MAX_OUTPUT_TOKENS,
  DISCOVER_MAX_USD,
  ENTRY_ROUTE,
  LIVE_GOAL,
  LIVE_MEMBER_ID,
  MODEL_RATES as RATES,
  SPEND_CAP_USD,
} from "./live-run.js";

// ---------------------------------------------------------------------------------------------
// Constants a reader has to be able to check
// ---------------------------------------------------------------------------------------------

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PACKAGES = resolve(HERE, "..", "..");
const REPO = resolve(PACKAGES, "..");
const SURFACE_BROWSER = resolve(PACKAGES, "surface-browser");
const FIXTURE_SERVER = resolve(REPO, "fixtures", "corebank-web", "src", "server.js");
const TRANSCRIPT_DIR = resolve(REPO, "evidence", "discovery-live");
/** The runner this report exists to be read before. Checked by reading, not by existing. */
const RUNNER = resolve(HERE, "discover.ts");

/**
 * The character-per-token band. This is an ESTIMATOR, not a tokenizer.
 *
 * The low divisor produces the HIGHER token count and is the one every headline figure and every
 * cost ceiling below is computed from, because a readiness check that under-quotes is worse than
 * useless. English prose and JSON tool schemas both sit inside this band on every Claude tokenizer;
 * the exact answer needs `messages.countTokens`, which is a billed network call to the provider and
 * is therefore not made here. Treat every token number in this report as +/- 20%.
 */
const CHARS_PER_TOKEN_HIGH_ESTIMATE = 3.3;
const CHARS_PER_TOKEN_LOW_ESTIMATE = 4.0;

/** Output tokens assumed per model turn, thinking included. Override with
 *  `CRR_PREFLIGHT_OUTPUT_TOKENS=<n> pnpm preflight`. There is no measured value for this in the
 *  repository and there cannot be one until a live run happens, so it is an input to the estimate
 *  rather than a result of it - and it is printed as such. */
const DEFAULT_ASSUMED_OUTPUT_TOKENS = 800;

/** Turn counts the cost table is evaluated at. 8 is the length of the hand-authored `SCRIPT` that
 *  reaches this goal through the same loop; 24 is `DEFAULT_LIMITS.maxTurns`, the hard budget. */
const TURN_POINTS = [8, 16, DEFAULT_LIMITS.maxTurns] as const;

// ---------------------------------------------------------------------------------------------
// Report printing
// ---------------------------------------------------------------------------------------------

type Verdict = "OK" | "WARN" | "BLOCK";

interface Finding {
  readonly verdict: Verdict;
  readonly section: string;
  readonly text: string;
}

const findings: Finding[] = [];

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

const rule = (title: string): void => {
  out();
  out(`── ${title} ${"─".repeat(Math.max(0, 92 - title.length))}`);
  out();
};

function record(verdict: Verdict, section: string, text: string): void {
  findings.push({ verdict, section, text });
  const badge = verdict === "OK" ? "  ok  " : verdict === "WARN" ? " warn " : "BLOCK ";
  out(`  [${badge}] ${text}`);
}

const money = (usd: number): string => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
const num = (n: number): string => n.toLocaleString("en-US");

// ---------------------------------------------------------------------------------------------
// Local token estimation
// ---------------------------------------------------------------------------------------------

interface TokenEstimate {
  readonly chars: number;
  /** The pessimistic (larger) count. Every cost figure is computed from this. */
  readonly high: number;
  readonly low: number;
}

function estimate(text: string): TokenEstimate {
  const chars = text.length;
  return {
    chars,
    high: Math.ceil(chars / CHARS_PER_TOKEN_HIGH_ESTIMATE),
    low: Math.ceil(chars / CHARS_PER_TOKEN_LOW_ESTIMATE),
  };
}

const showEstimate = (e: TokenEstimate): string =>
  `${num(e.chars).padStart(8)} chars  ~${num(e.high).padStart(6)} tok  (band ${num(e.low)}-${num(e.high)})`;

// ---------------------------------------------------------------------------------------------
// 1. The credential - shape only, never the value
// ---------------------------------------------------------------------------------------------

function checkCredential(): void {
  rule("1. CREDENTIAL - checked for SHAPE only. The value is never printed and never used.");

  const key = process.env.ANTHROPIC_API_KEY;

  if (key === undefined || key === "") {
    record(
      "BLOCK",
      "credential",
      "ANTHROPIC_API_KEY is not set in this shell. `createAnthropicModel` throws without it.",
    );
    out();
    out("      THIS CHECK IS ABOUT THE SHELL YOU ARE IN, and it deliberately does not fix it.");
    out("      `pnpm discover` DOES load `<repo>/.env` for you (see `loadDotEnv` in");
    out("      tools/discover.ts) and announces which variables it set, never their values - so a");
    out(
      "      key sitting in `.env` will reach the runner even though this line says it is not in",
    );
    out(
      "      your shell. A readiness check that silently improved the environment it was auditing",
    );
    out("      would be answering a different question than the one it was asked.");
    out();
    out("      To make it true here as well:");
    out();
    out("          set -a; . ./.env; set +a        # or: export ANTHROPIC_API_KEY=sk-ant-...");
    out();
    out("      An `ant auth login` profile does NOT satisfy this adapter either. A bare");
    out("      `new Anthropic()` would resolve one, but `adapters/anthropic.ts` reads");
    out("      `env.ANTHROPIC_API_KEY` and throws BEFORE the client is constructed.");
    return;
  }

  // Shape, and nothing that could reconstruct the value: a prefix that is public by construction,
  // a length, and a character-class verdict.
  const prefixOk = key.startsWith("sk-ant-");
  const charsetOk = /^[A-Za-z0-9_-]+$/.test(key);
  const plausibleLength = key.length >= 40 && key.length <= 256;

  out("      present   yes");
  out(`      shape     sk-ant-… + ${key.length - 7} more characters (${key.length} total)`);
  out(
    `      charset   ${charsetOk ? "[A-Za-z0-9_-] throughout" : "CONTAINS UNEXPECTED CHARACTERS"}`,
  );
  out();

  if (prefixOk && charsetOk && plausibleLength) {
    record(
      "OK",
      "credential",
      "ANTHROPIC_API_KEY is present and well-formed (prefix, charset, length).",
    );
  } else {
    const why = [
      prefixOk ? null : 'does not start with "sk-ant-"',
      charsetOk ? null : "contains characters outside [A-Za-z0-9_-]",
      plausibleLength ? null : `is ${key.length} characters, outside the plausible 40-256`,
    ]
      .filter((s): s is string => s !== null)
      .join("; ");
    record("BLOCK", "credential", `ANTHROPIC_API_KEY is set but malformed: it ${why}.`);
  }

  if (key.trim() !== key) {
    record("BLOCK", "credential", "ANTHROPIC_API_KEY has leading or trailing whitespace.");
  }

  const base = process.env.ANTHROPIC_BASE_URL;
  if (base !== undefined && base !== "") {
    record(
      "WARN",
      "credential",
      `ANTHROPIC_BASE_URL is set to ${base} - the run would NOT go to the first-party API.`,
    );
  }

  const override = process.env.CRR_MODEL;
  if (override !== undefined && override !== "") {
    record(
      "WARN",
      "credential",
      `CRR_MODEL is set to "${override}" - it overrides the default model id.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 2. The target - the fixture is booted and the entry route is fetched
// ---------------------------------------------------------------------------------------------

interface Fixture {
  readonly origin: string;
  close(): Promise<unknown>;
}

async function bootFixture(): Promise<Fixture | null> {
  rule("2. TARGET - the fixture is booted on loopback and the entry route is fetched.");

  let fixture: Fixture;
  try {
    const mod = (await import(pathToFileURL(FIXTURE_SERVER).href)) as {
      startFixtureServer(opts: { port?: number }): Promise<Fixture>;
    };
    fixture = await mod.startFixtureServer({ port: 0 });
  } catch (cause) {
    record("BLOCK", "target", `fixtures/corebank-web would not boot: ${String(cause)}`);
    return null;
  }

  out(`      goal      ${LIVE_GOAL}`);
  out(`      tenant    riverbend        member ${LIVE_MEMBER_ID} (synthetic, fixture-only)`);
  out(`      origin    ${fixture.origin}   (alias "corebank")`);
  out(`      entry     ${ENTRY_ROUTE}`);
  out();

  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(fixture.origin)) {
    record("BLOCK", "target", `the fixture bound ${fixture.origin}, which is not loopback.`);
  }

  // Every route the allowlist names, fetched. `/member/:memberId` is a PATTERN, so it is probed
  // with the recorded member - the one value that is in the goal and therefore parameterized.
  const probes = ALLOWLIST.routes.map((route) => ({
    pattern: route.pathPattern,
    path: route.pathPattern.replace(":memberId", LIVE_MEMBER_ID),
  }));

  for (const probe of [{ pattern: "/", path: "/" }, ...probes]) {
    let status: number | string;
    try {
      const response = await fetch(`${fixture.origin}${probe.path}`, { redirect: "manual" });
      status = response.status;
      await response.text();
    } catch (cause) {
      status = `unreachable (${String(cause)})`;
    }
    const reachable = status === 200;
    const label =
      probe.pattern === probe.path ? probe.pattern : `${probe.pattern} -> ${probe.path}`;
    out(`      ${reachable ? "ok  " : "FAIL"}  GET ${label.padEnd(44)} ${status}`);
    if (!reachable && probe.path === ENTRY_ROUTE) {
      record(
        "BLOCK",
        "target",
        `the goal's entry route ${ENTRY_ROUTE} answered ${status}, not 200.`,
      );
    }
  }
  out();
  record("OK", "target", `the fixture is up on ${fixture.origin} and ${ENTRY_ROUTE} answers 200.`);
  return fixture;
}

// ---------------------------------------------------------------------------------------------
// 3. The first observation - live through the real driver if a browser exists
// ---------------------------------------------------------------------------------------------

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

interface FirstScreen {
  readonly observation: Observation;
  readonly provenance: string;
}

/**
 * Perceive the entry screen the way the run will, or fall back to the committed corpus.
 *
 * The live path is worth the sixty lines it costs. The whole value of this report is "what will
 * actually happen when you spend the money", and a token count taken off a frozen file that the
 * application has since drifted away from is exactly the wrong number to authorise a payment on.
 * When Chromium is absent the fallback is honest rather than silent: the corpus was captured from
 * THIS fixture through THIS driver, and the report says which of the two it used.
 */
async function perceiveEntryScreen(fixture: Fixture): Promise<FirstScreen> {
  try {
    const { chromium } = createRequire(`${SURFACE_BROWSER}/package.json`)(
      "playwright",
    ) as PlaywrightModule;
    if (!existsSync(chromium.executablePath())) throw new Error("no Chromium build is installed");

    const { attachBrowserSurface } = (await import(
      pathToFileURL(resolve(SURFACE_BROWSER, "src", "index.ts")).href
    )) as {
      attachBrowserSurface(options: {
        page: unknown;
        origins: Readonly<Record<string, string>>;
        routes: readonly RoutePattern[];
        primaryFrame: string;
        geometry: string;
        lease: LeaseToken;
      }): Promise<Surface>;
    };

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${fixture.origin}/`, { waitUntil: "load" });
      const surface = await attachBrowserSurface({
        page,
        origins: { corebank: fixture.origin },
        routes: ROUTES,
        primaryFrame: "content",
        geometry: "actionable",
        lease: CONTROL.token,
      });

      // Two consecutive agreeing snapshots, the same law `settle()` applies. A half-painted frame
      // would under-count the projection and therefore under-quote the run.
      const deadline = Date.now() + 8000;
      let previous: string | null = null;
      let last: PerceiveResult = await surface.perceive({ deadlineMs: 5000 });
      while (Date.now() < deadline) {
        const key = last.ok
          ? `${last.observation.route?.path ?? "-"}|${last.observation.skeletonDigest}|${last.observation.stability.settled}`
          : `fault:${last.fault.kind}`;
        if (key === previous && last.ok && last.observation.stability.settled) break;
        previous = key;
        await new Promise((r) => setTimeout(r, 80));
        last = await surface.perceive({ deadlineMs: 5000 });
      }
      if (!last.ok) throw new Error(`perceive returned ${last.fault.kind}`);
      return {
        observation: last.observation,
        provenance: "PERCEIVED LIVE, just now, through @crr/surface-browser (CDP AX tree)",
      };
    } finally {
      await browser.close();
    }
  } catch (cause) {
    const corpus = loadCorpus();
    return {
      observation: corpus.screens.search,
      provenance: `frozen corpus corebank-web.observations.json, captured ${corpus.capture.capturedAt} (live perceive unavailable: ${String(cause).slice(0, 120)})`,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// 3b. The request the loop would send
// ---------------------------------------------------------------------------------------------

interface RequestSizes {
  readonly system: TokenEstimate;
  readonly tools: TokenEstimate;
  readonly task: TokenEstimate;
  readonly projection: TokenEstimate;
  readonly prefix: TokenEstimate;
  readonly turnOne: TokenEstimate;
  readonly modelId: string;
  readonly effort: ModelEffort;
  readonly projectionText: string;
  readonly shown: number;
  readonly hidden: number;
}

function buildAndSize(screen: FirstScreen): RequestSizes {
  rule("3. THE REQUEST - built here, exactly as the loop builds it. Nothing is sent.");

  const modelId = process.env.CRR_MODEL ?? DEFAULT_MODEL_ID;
  const effort: ModelEffort = "high";

  const system = [
    {
      type: "text" as const,
      text: DISCOVERY_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" as const },
    },
  ];
  const tools = toolsWithCacheBreakpoint(DISCOVERY_TOOLS);
  const taskText = renderTaskMessage({
    goal: LIVE_GOAL,
    tenantId: "riverbend",
    originAlias: "corebank",
    entryRoute: ENTRY_ROUTE,
    allowedRoutes: ALLOWLIST.routes
      .filter((route) => route.originAlias === "corebank")
      .map((route) => route.pathPattern),
  });

  const request: ModelTurnRequest = {
    system,
    tools,
    messages: [{ role: "user", content: taskText }],
  };
  const body = buildRequestBody(request, {
    modelId,
    effort,
    maxTokens: DISCOVER_MAX_OUTPUT_TOKENS,
  });

  const projection = projectObservation(screen.observation);

  const sizes: RequestSizes = {
    system: estimate(DISCOVERY_SYSTEM_PROMPT),
    tools: estimate(JSON.stringify(tools)),
    task: estimate(taskText),
    projection: estimate(projection.text),
    prefix: estimate(DISCOVERY_SYSTEM_PROMPT + JSON.stringify(tools)),
    turnOne: estimate(DISCOVERY_SYSTEM_PROMPT + JSON.stringify(tools) + taskText),
    modelId,
    effort,
    projectionText: projection.text,
    shown: projection.shown,
    hidden: projection.hidden,
  };

  out(
    "      The body, field by field (this object was constructed; `messages.create` was not called):",
  );
  out();
  out(`        model                              ${body.model}`);
  out(`        max_tokens                         ${num(body.max_tokens)}`);
  out(`        thinking                           { type: "${body.thinking.type}" }`);
  out(`        output_config.effort               "${body.output_config.effort}"`);
  out(
    `        tool_choice                        { type: "${body.tool_choice.type}", disable_parallel_tool_use: ${body.tool_choice.disable_parallel_tool_use} }`,
  );
  out(`        system[0].cache_control            { type: "${system[0]?.cache_control.type}" }`);
  out(
    `        tools                              ${tools.length} (${tools.map((t) => t.name).join(", ")}), all strict:true`,
  );
  out(`        tools[last].cache_control          { type: "ephemeral" }   <- the cache breakpoint`);
  out("        messages                           1 (role user, the task block)");
  out();
  out("      SIZE. Estimated LOCALLY from character counts - `messages.countTokens` is a network");
  out("      call to the provider and is not used. Treat every figure as +/- 20%.");
  out();
  out(`        system prompt          ${showEstimate(sizes.system)}`);
  out(`        tool definitions       ${showEstimate(sizes.tools)}`);
  out(`        ─ cacheable prefix     ${showEstimate(sizes.prefix)}`);
  out(`        task message           ${showEstimate(sizes.task)}   (after the breakpoint)`);
  out(`        ═ TURN 1 INPUT         ${showEstimate(sizes.turnOne)}`);
  out();
  out(`        first observation      ${showEstimate(sizes.projection)}   (arrives on turn 2)`);
  out(
    `                               ${sizes.shown} of ${screen.observation.nodes.length} nodes shown, ${sizes.hidden} withheld`,
  );
  out(`                               ${screen.provenance}`);
  out();
  out('      Turn 1 carries NO observation: the system prompt ends "Call observe first", so the');
  out("      projection above is the tool_result appended to turn 2 and to every turn after it.");
  out();
  out("      The first 18 lines of what the model will be shown:");
  out();
  for (const line of sizes.projectionText.split("\n").slice(0, 18)) {
    out(`        │ ${line.slice(0, 96)}`);
  }
  const total = sizes.projectionText.split("\n").length;
  if (total > 18) out(`        │ … ${total - 18} more line(s)`);
  out();

  if (sizes.projection.high === 0) {
    record(
      "BLOCK",
      "request",
      "the first observation projected to nothing - the model would see an empty screen.",
    );
  } else {
    record(
      "OK",
      "request",
      `the turn-1 request is ~${num(sizes.turnOne.high)} tokens; the first screen adds ~${num(sizes.projection.high)}.`,
    );
  }
  if (sizes.hidden > 0) {
    record(
      "WARN",
      "request",
      `${sizes.hidden} control(s) exceed the projection cap and are withheld from the model.`,
    );
  }
  return sizes;
}

// ---------------------------------------------------------------------------------------------
// 4. Budget and cost
// ---------------------------------------------------------------------------------------------

function costReport(sizes: RequestSizes): void {
  rule("4. BUDGET AND COST - the arithmetic is printed so you can check it by hand.");

  const assumedOutput = Number.parseInt(
    process.env.CRR_PREFLIGHT_OUTPUT_TOKENS ?? String(DEFAULT_ASSUMED_OUTPUT_TOKENS),
    10,
  );
  const P = sizes.prefix.high;
  const T = sizes.task.high;
  const O = sizes.projection.high;

  out(
    `      model id                 ${sizes.modelId}          (CRR_MODEL overrides; default ${DEFAULT_MODEL_ID})`,
  );
  out(`      effort                   ${sizes.effort}`);
  out(`      max turns                ${DEFAULT_LIMITS.maxTurns}          DEFAULT_LIMITS.maxTurns`);
  out(
    `      max dispatched actions   ${DEFAULT_LIMITS.maxActions}          DEFAULT_LIMITS.maxActions`,
  );
  out(
    `      per-turn output ceiling  ${num(DISCOVER_MAX_OUTPUT_TOKENS)}        max_tokens, as \`pnpm discover\` sends it`,
  );
  out(
    `                               (${num(DEFAULT_MAX_TOKENS)} is the adapter's own default; the runner lowers it - see`,
  );
  out(
    "                               DISCOVER_MAX_OUTPUT_TOKENS in tools/live-run.ts for the arithmetic)",
  );
  out(
    `      run spend ceiling        ${money(DISCOVER_MAX_USD)}        --max-usd, enforced between turns from real usage`,
  );
  out(
    `      consecutive refusals     ${DEFAULT_LIMITS.maxConsecutiveRefusals}           before the loop abandons the model`,
  );
  out();
  out("      THE MODEL OF A RUN, and every symbol in it is measured above except U:");
  out();
  out(`        P = cacheable prefix       ${num(P)} tok   (system + tools, unchanged every turn)`);
  out(`        T = task message           ${num(T)} tok`);
  out(
    `        O = one observation        ${num(O)} tok   (the tool_result an observe call returns)`,
  );
  out(`        U = output per turn        ${num(assumedOutput)} tok   ASSUMED - see below`);
  out();
  out("        turn 1 input   = P + T");
  out("        turn t input   = P + T + Σ(U + O) over the t-1 turns before it");
  out("        billed input   = Σ over all turns  (the history is re-sent every turn)");
  out("        with caching   = the same, except P is billed at 1.25x once and 0.1x thereafter");
  out("        billed output  = turns x U");
  out();
  out("      O IS CHARGED ON EVERY TURN, WHICH IS PESSIMISTIC ON PURPOSE. Only an `observe` call");
  out("      returns a projection; an `act` returns one short line and a `finish` ends the run. A");
  out("      real run alternates, so its true input sits below every input figure in the table.");
  out();
  out("      U IS AN ASSUMPTION, NOT A MEASUREMENT. No live run has ever happened in this");
  out(
    "      repository, so there is no measured output-per-turn to use. Thinking is on by default",
  );
  out(
    `      on ${DEFAULT_MODEL_ID} at effort "${sizes.effort}" and thinking tokens bill as output, so U is the`,
  );
  out("      figure most likely to be wrong and it is the one the output cost is linear in.");
  out("      Re-run with a different value:  CRR_PREFLIGHT_OUTPUT_TOKENS=3000 pnpm preflight");
  out();

  const runCost = (turns: number, U: number, rate: (typeof RATES)[number], cached: boolean) => {
    let variableInput = 0;
    let history = T;
    for (let t = 1; t <= turns; t += 1) {
      variableInput += history;
      history += U + O;
    }
    const prefixTokens = cached
      ? P * CACHE_WRITE_MULTIPLIER + P * CACHE_READ_MULTIPLIER * (turns - 1)
      : P * turns;
    const inputUsd = ((variableInput + prefixTokens) * rate.input) / 1_000_000;
    const outputUsd = (turns * U * rate.output) / 1_000_000;
    return {
      inputUsd,
      outputUsd,
      total: inputUsd + outputUsd,
      inputTokens: variableInput + prefixTokens,
    };
  };

  for (const rate of RATES) {
    out(`      ${rate.id}   $${rate.input}/Mtok in, $${rate.output}/Mtok out`);
    out();
    out(
      "        turns   scenario                    input tok    input $    output $     TOTAL   % of $10 cap",
    );
    for (const turns of TURN_POINTS) {
      for (const [label, U] of [
        ["typical (U assumed)", assumedOutput],
        ["ceiling (U = max_tokens)", DISCOVER_MAX_OUTPUT_TOKENS],
        ["if max_tokens were 16,000", DEFAULT_MAX_TOKENS],
      ] as const) {
        const c = runCost(turns, U, rate, true);
        out(
          `        ${String(turns).padStart(5)}   ${label.padEnd(26)} ${num(Math.round(c.inputTokens)).padStart(9)}  ${money(c.inputUsd).padStart(9)}  ${money(c.outputUsd).padStart(9)}  ${money(c.total).padStart(8)}   ${((c.total / SPEND_CAP_USD) * 100).toFixed(1)}%`,
        );
      }
    }
    const worst = runCost(DEFAULT_LIMITS.maxTurns, DISCOVER_MAX_OUTPUT_TOKENS, rate, true);
    const unlowered = runCost(DEFAULT_LIMITS.maxTurns, DEFAULT_MAX_TOKENS, rate, true);
    const typical = runCost(DEFAULT_LIMITS.maxTurns, assumedOutput, rate, true);
    const uncached = runCost(DEFAULT_LIMITS.maxTurns, assumedOutput, rate, false);
    out();
    out(
      `        caching saves ${money(uncached.total - typical.total)} on a full-budget typical run (${num(P)}-token prefix, ${DEFAULT_LIMITS.maxTurns} turns).`,
    );
    out(
      `        ABSOLUTE WORST ONE RUN CAN COST on this model: ${money(worst.total)} - every turn to the budget, every`,
    );
    out(
      `        turn's output at max_tokens. It would have been ${money(unlowered.total)} at the adapter's own 16,000,`,
    );
    out(
      `        and the --max-usd guard stops the run at ${money(DISCOVER_MAX_USD)} long before either.`,
    );
    out();

    if (P < rate.minCachePrefix) {
      record(
        "WARN",
        "cost",
        `the ${num(P)}-token prefix is BELOW ${rate.id}'s ${rate.minCachePrefix}-token cache minimum - the breakpoint would silently do nothing.`,
      );
    } else {
      record(
        "OK",
        "cost",
        `the ${num(P)}-token prefix clears ${rate.id}'s ${rate.minCachePrefix}-token cache minimum.`,
      );
    }
    if (worst.total > SPEND_CAP_USD) {
      record(
        "WARN",
        "cost",
        `one worst-case run on ${rate.id} (${money(worst.total)}) would exceed the whole $${SPEND_CAP_USD} cap.`,
      );
    } else {
      record(
        "OK",
        "cost",
        `the worst a full-budget run on ${rate.id} can cost is ${money(worst.total)}, and --max-usd caps it at ${money(DISCOVER_MAX_USD)}.`,
      );
    }
  }

  out();
  out("      WHAT CACHING DOES NOT SAVE, and it is the larger number. Only the system prompt and");
  out("      the tool definitions carry a breakpoint. The message history does not, so every");
  out("      observation and every assistant turn is re-sent at full input price on every");
  out(
    "      subsequent turn - which is why the input column grows quadratically in the turn count.",
  );
}

// ---------------------------------------------------------------------------------------------
// 5. The policy allowlist
// ---------------------------------------------------------------------------------------------

function allowlistReport(fixture: Fixture): void {
  rule("5. POLICY ALLOWLIST - read it before authorising. This is everything the run may do.");

  const list: Allowlist = ALLOWLIST;

  out("      origin aliases");
  for (const alias of list.originAliases) {
    out(
      `        ${alias.padEnd(20)} -> ${alias === "corebank" ? fixture.origin : "NOT MAPPED BY THIS RUN"}`,
    );
  }
  out();
  out("      routes                                         max effect");
  for (const route of list.routes) {
    out(`        ${`${route.originAlias}${route.pathPattern}`.padEnd(44)} ${route.maxEffect}`);
  }
  out();
  out(`      action kinds             ${list.actionKinds.join(", ")}`);
  out(`      maxEffect                ${list.maxEffect}`);
  out(
    `      discoveryMaxEffect       ${list.discoveryMaxEffect}   <- the ceiling while the model is driving`,
  );
  out("      approval token           none (the loop is given approval: null)");
  out();

  // "covers the fixture origin and NOTHING else", checked rather than asserted in prose.
  const aliases = new Set(list.originAliases);
  if (aliases.size === 1 && aliases.has("corebank")) {
    record(
      "OK",
      "allowlist",
      'exactly one origin alias ("corebank"), bound to the loopback fixture.',
    );
  } else {
    record(
      "BLOCK",
      "allowlist",
      `${aliases.size} origin aliases: ${[...aliases].join(", ")}. Expected exactly "corebank".`,
    );
  }

  const foreign = list.routes.filter((r) => !aliases.has(r.originAlias));
  if (foreign.length === 0) {
    record(
      "OK",
      "allowlist",
      `all ${list.routes.length} routes belong to that alias; no route reaches any other origin.`,
    );
  } else {
    record(
      "BLOCK",
      "allowlist",
      `${foreign.length} route(s) name an origin alias that is not on the list.`,
    );
  }

  const wild = list.routes.filter((r) => r.pathPattern === "/" || r.pathPattern.includes("*"));
  if (wild.length === 0) {
    record(
      "OK",
      "allowlist",
      "no wildcard or root-of-site route pattern - each route is named explicitly.",
    );
  } else {
    record(
      "BLOCK",
      "allowlist",
      `${wild.length} route pattern(s) are wildcards: ${wild.map((r) => r.pathPattern).join(", ")}`,
    );
  }

  if (list.discoveryMaxEffect === "WRITE_IRREVERSIBLE") {
    record(
      "BLOCK",
      "allowlist",
      "discoveryMaxEffect is WRITE_IRREVERSIBLE - the model could commit an irreversible action.",
    );
  } else {
    record(
      "OK",
      "allowlist",
      `discoveryMaxEffect is ${list.discoveryMaxEffect}: no irreversible action can be dispatched.`,
    );
  }

  // The gate itself, run. Not a claim that it would deny - a decision from `@crr/core`'s `check`.
  out();
  out("      THE GATE, EXERCISED. These are real `check()` decisions from @crr/core, taken now:");
  out();
  const context = (route: { originAlias: string; path: string } | null): PolicyContext => ({
    mode: "discovery",
    allowlist: list,
    step: null,
    route,
    effect: "WRITE_REVERSIBLE",
    lease: CONTROL.snapshot,
    approval: null,
    artifact: null,
    taint: [],
    approvedDigest: null,
  });
  const moment: PolicyMoment = {
    now: new Date().toISOString() as Timestamp,
    epoch: CONTROL.snapshot.epoch,
  };
  const probe: Action = { kind: "click", target: "n0" as never };

  const cases: readonly { label: string; route: { originAlias: string; path: string } | null }[] = [
    {
      label: `on-allowlist   corebank${ENTRY_ROUTE}`,
      route: { originAlias: "corebank", path: ENTRY_ROUTE },
    },
    {
      label: "off-allowlist  corebank/admin/settings",
      route: { originAlias: "corebank", path: "/admin/settings" },
    },
    {
      label: "foreign origin anthropic/v1/messages",
      route: { originAlias: "anthropic", path: "/v1/messages" },
    },
    { label: "no route at all", route: null },
  ];
  for (const c of cases) {
    const decision = check(probe, context(c.route), moment);
    const verdict = decision.allow
      ? `ALLOW  (rule ${decision.ruleId})`
      : `DENY   ${decision.reason}`;
    out(`        ${c.label.padEnd(40)} ${verdict}`);
  }
  out();

  const offList = check(
    probe,
    context({ originAlias: "corebank", path: "/admin/settings" }),
    moment,
  );
  const foreignOrigin = check(
    probe,
    context({ originAlias: "anthropic", path: "/v1/messages" }),
    moment,
  );
  if (!offList.allow && !foreignOrigin.allow) {
    record(
      "OK",
      "allowlist",
      "the chokepoint denies an off-allowlist route and a foreign origin, checked just now.",
    );
  } else {
    record("BLOCK", "allowlist", "the chokepoint ALLOWED a route that is not on the allowlist.");
  }
}

// ---------------------------------------------------------------------------------------------
// 6. The recorder, and the runner that does not exist
// ---------------------------------------------------------------------------------------------

async function recorderReport(): Promise<void> {
  rule("6. THE RECORDING - where the transcript would land, and whether anything would write it.");

  // The VCR machinery, driven end to end over an adapter that opens no socket. This proves the
  // mechanism; it does not prove anything is wired to use it, which is the next check.
  let mechanismOk = false;
  let turns = 0;
  try {
    const stub = {
      adapter: "scripted" as const,
      modelId: "preflight-no-network",
      async turn() {
        return {
          stopReason: "end_turn" as const,
          content: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
        };
      },
    };
    const recording = createRecordingModel(stub, {
      note: "preflight self-test - no provider was contacted",
      nowMs: () => 0,
      recordedAt: null,
      synthetic: true,
    });
    await recording.turn({
      system: [{ type: "text", text: DISCOVERY_SYSTEM_PROMPT }],
      tools: toolsWithCacheBreakpoint(DISCOVERY_TOOLS),
      messages: [{ role: "user", content: "preflight" }],
    });
    const transcript = recording.transcript();
    turns = transcript.turns.length;
    mechanismOk = turns === 1 && transcript.prefix.digest.length > 0;
  } catch (cause) {
    record(
      "BLOCK",
      "recorder",
      `the VCR recorder threw during a no-network self-test: ${String(cause)}`,
    );
  }

  if (mechanismOk) {
    record(
      "OK",
      "recorder",
      `createRecordingModel works: a turn through it produced ${turns} recorded turn and a prefix digest.`,
    );
  } else if (turns !== 1) {
    record("BLOCK", "recorder", `the recorder produced ${turns} turns for one call; expected 1.`);
  }

  const present = existsSync(TRANSCRIPT_DIR) ? readdirSync(TRANSCRIPT_DIR) : null;
  out();
  out("      destination   evidence/discovery-live/");
  out(`      exists        ${present === null ? "NO" : "yes"}`);
  out(`      contents      ${present === null ? "-" : present.join(", ") || "(empty)"}`);
  out();

  if (present === null) {
    record(
      "BLOCK",
      "recorder",
      "evidence/discovery-live/ does not exist; the transcript would have nowhere to land.",
    );
  } else if (present.some((f) => f === "transcript.json")) {
    record(
      "WARN",
      "recorder",
      "evidence/discovery-live/transcript.json already exists - a run would overwrite it.",
    );
  } else {
    record("OK", "recorder", "evidence/discovery-live/ exists and holds no transcript yet.");
  }

  // The finding this script was originally written to surface, now checked rather than asserted.
  //
  // It is checked by READING THE RUNNER OFF DISK and looking for the four calls that make it one,
  // not by testing whether a file exists. A `tools/discover.ts` that had lost its call to
  // `createAnthropicModel` would still be a file, and this section would still say READY - which is
  // the failure mode of every check that tests for the presence of a name instead of the presence
  // of the thing the name promises.
  out();
  out("      IS ANYTHING ARMED TO WRITE IT?");
  out();

  const required = [
    { call: "createAnthropicModel", why: "the live adapter" },
    { call: "createRecordingModel", why: "the VCR recorder" },
    { call: "runDiscoveryLoop", why: "the observe/decide/act loop" },
    { call: "synthesizeCapability", why: "the recording becomes a document" },
    { call: "verifyAndDraft", why: "BRIEF 3.4 - it replays before it is a draft" },
    { call: "runRedactionCanary", why: "the bundle is grepped before it is published" },
  ] as const;

  let source: string | null = null;
  try {
    source = readFileSync(RUNNER, "utf8");
  } catch {
    source = null;
  }

  if (source === null) {
    out("      NO. `packages/discovery/tools/discover.ts` does not exist.");
    out();
    record(
      "BLOCK",
      "recorder",
      "no runner exists: nothing composes the adapter, the recorder and the loop into a live run.",
    );
    return;
  }

  const missing = required.filter((one) => !source.includes(one.call));
  out("      YES - `pnpm discover`, at packages/discovery/tools/discover.ts. What it composes:");
  out();
  for (const one of required) {
    out(
      `        ${source.includes(one.call) ? "ok  " : "MISSING"}  ${one.call.padEnd(22)} ${one.why}`,
    );
  }
  out();
  out("      Rehearse the whole thing, free, against the VCR replay adapter:");
  out();
  out("          pnpm discover --dry-run");
  out();
  out("      Perform it. This spends money and the flag is not optional:");
  out();
  out("          pnpm discover --yes");
  out();

  if (missing.length === 0) {
    record(
      "OK",
      "recorder",
      "`pnpm discover` exists and composes the adapter, the recorder, the loop, synthesis, the verification replay and the canary.",
    );
  } else {
    record(
      "BLOCK",
      "recorder",
      `tools/discover.ts is missing ${missing.map((one) => one.call).join(", ")} - it is not a complete runner.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------------------------

function verdict(): number {
  const blocks = findings.filter((f) => f.verdict === "BLOCK");
  const warns = findings.filter((f) => f.verdict === "WARN");

  rule("VERDICT");

  if (blocks.length === 0 && warns.length === 0) {
    out("      READY. Every check passed. Nothing here authorises the run - a person does.");
  } else {
    if (blocks.length > 0) {
      out(`      NOT READY - ${blocks.length} blocker(s):`);
      out();
      for (const f of blocks) out(`        BLOCK  [${f.section}] ${f.text}`);
      out();
    }
    if (warns.length > 0) {
      out(`      ${warns.length} warning(s) - readable, not fatal:`);
      out();
      for (const f of warns) out(`        warn   [${f.section}] ${f.text}`);
      out();
    }
  }

  out(`      ${findings.filter((f) => f.verdict === "OK").length} check(s) passed.`);
  out();
  out("      NO MODEL CALL WAS MADE BY THIS SCRIPT. The only sockets it opened were to 127.0.0.1.");
  out("      Every token figure above is a LOCAL CHARACTER-COUNT ESTIMATE, not a tokenizer result");
  out("      and not `messages.countTokens`, which would itself be a request to the provider.");
  out();
  return blocks.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------

out();
out(
  "  ╔══════════════════════════════════════════════════════════════════════════════════════════╗",
);
out(
  "  ║  capability-record-replay - LIVE DISCOVERY RUN PREFLIGHT                                  ║",
);
out(
  "  ║  Read this before spending a cent. It makes no model call and never uses your key.        ║",
);
out(
  "  ╚══════════════════════════════════════════════════════════════════════════════════════════╝",
);

checkCredential();

const fixture = await bootFixture();
let code = 1;
try {
  if (fixture !== null) {
    const screen = await perceiveEntryScreen(fixture);
    const sizes = buildAndSize(screen);
    costReport(sizes);
    allowlistReport(fixture);
  }
  await recorderReport();
  code = verdict();
} finally {
  await fixture?.close();
}

process.exitCode = code;
