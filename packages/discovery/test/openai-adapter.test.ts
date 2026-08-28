// THE ACCEPTANCE TEST SPEC section 11 unit 23 names: the same loop completes against a second
// provider.
//
// NOTHING IN THIS FILE MAKES A LIVE CALL, and it cannot. `createOpenAIModel` takes its transport as
// a parameter, and every test here injects one that answers out of a committed cassette; the first
// test asserts that explicitly by deleting every credential from the environment for the duration
// of the run. BRIEF section 11 forbids an agent or a CI job from reaching a provider, and the way
// that rule survives contact with a busy afternoon is by the adapter having a seam - which is the
// same seam a reviewer uses to read the exact bytes we would send without running anything.
//
// THE ASSERTION THAT MATTERS IS THE LAST DESCRIBE BLOCK. Everything before it checks the
// translation in isolation; that one drives the WHOLE discovery loop over the OpenAI adapter and
// requires it to reach the same status, the same recorded steps and the same noted outputs as the
// Anthropic-shaped scripted run over the same script. "The loop is not provider-coupled" is either
// that comparison or it is a sentence in a README.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MockSurface } from "@crr/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISCOVERY_SYSTEM_PROMPT,
  DISCOVERY_TOOLS,
  DiscoveryModelError,
  type ModelTurnRequest,
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_TOOL_ERROR_PREFIX,
  buildOpenAIRequestBody,
  createOpenAIModel,
  createRecordingModel,
  createScriptedModel,
  parseTranscript,
  runDiscoveryLoop,
  toModelUsage,
  toOpenAIMessages,
  toStopReason,
  toolsWithCacheBreakpoint,
} from "../src/index.js";
import {
  CASSETTE_FILE,
  CASSETTE_MODEL_ID,
  type Cassette,
  playCassette,
} from "./fixtures/build-openai-cassette.js";
import { SCRIPT } from "./fixtures/build-transcript.js";
import {
  ALLOWLIST,
  CONTROL,
  FROZEN_NOW,
  GOAL,
  frozenClockMs,
  screens,
  transitions,
} from "./fixtures/corebank.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const CASSETTE = JSON.parse(
  readFileSync(join(HERE, "fixtures", CASSETTE_FILE), "utf8"),
) as Cassette;

const MODEL_ID = "gpt-test-only-never-sent";
const TARGET = {
  tenantId: "riverbend",
  originAlias: "corebank",
  entryRoute: "/members/search",
} as const;

const REQUEST: ModelTurnRequest = {
  system: [{ type: "text", text: DISCOVERY_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  tools: toolsWithCacheBreakpoint(),
  messages: [{ role: "user", content: "TASK: look up a member" }],
};

const body = () => buildOpenAIRequestBody(REQUEST, { modelId: MODEL_ID, maxTokens: 16000 });

/** A transport that answers once with whatever is given. Never a socket. */
const stub = (
  reply: { status?: number; json?: unknown; text?: string },
  seen?: { request?: unknown; url?: string; headers?: Record<string, string> },
) =>
  async function fetchStub(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) {
    if (seen !== undefined) {
      seen.request = JSON.parse(init.body);
      seen.url = url;
      seen.headers = init.headers;
    }
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => reply.text ?? JSON.stringify(reply.json ?? {}),
    };
  };

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

describe("construction", () => {
  it("refuses to invent a model id", () => {
    // The repository's rule is that a model id may not be written from memory (BRIEF section 9), and
    // there is no OpenAI equivalent of the `claude-api` skill that supplies them. A default here
    // would be an unsourceable fact that also decides what a run costs, so the adapter refuses.
    expect(() => createOpenAIModel({ env: {}, fetch: stub({ json: {} }) })).toThrow(
      DiscoveryModelError,
    );
    expect(() => createOpenAIModel({ env: {}, fetch: stub({ json: {} }) })).toThrow(
      /CRR_OPENAI_MODEL/,
    );
  });

  it("takes the model id from CRR_OPENAI_MODEL when the option is absent", () => {
    const model = createOpenAIModel({
      env: { CRR_OPENAI_MODEL: MODEL_ID },
      fetch: stub({ json: {} }),
    });
    expect(model.modelId).toBe(MODEL_ID);
    expect(model.adapter).toBe("openai");
  });

  it("demands a key ONLY when it would reach a real network", () => {
    // An injected transport waives the key requirement, which is the property BRIEF section 11 rests
    // on: demanding a credential from a caller that supplied its own transport would push every
    // test into setting a fake one, and that is how a real key ends up in a test environment.
    expect(() =>
      createOpenAIModel({ modelId: MODEL_ID, env: {}, fetch: stub({ json: {} }) }),
    ).not.toThrow();
    expect(() => createOpenAIModel({ modelId: MODEL_ID, env: {} })).toThrow(/OPENAI_API_KEY/);
  });
});

// ---------------------------------------------------------------------------------------------
// The request body
// ---------------------------------------------------------------------------------------------

describe("the request body", () => {
  it("disables parallel tool calls, which is the one action per turn rule", () => {
    // The mirror of the Anthropic adapter's `disable_parallel_tool_use`. Interleaved actions make
    // the recorded step order meaningless, and the recorded step order IS the artifact.
    expect(body().parallel_tool_calls).toBe(false);
    expect(body().tool_choice).toBe("auto");
  });

  it("puts the system prompt first, because this provider's cache is prefix-based too", () => {
    const first = body().messages[0];
    expect(first?.role).toBe("system");
    expect(first?.content).toContain(DISCOVERY_SYSTEM_PROMPT.slice(0, 40));
  });

  it("carries the tool schemas UNCHANGED, strict flag and all", () => {
    // The finding worth pinning: the schemas in `tools.ts` were authored for Anthropic's strict tool
    // use, which demands `additionalProperties: false`, every property in `required`, and optional
    // values spelled as nullable types. OpenAI strict function calling demands the same three
    // things, so the schemas cross without a single edit. This test is here because that is the kind
    // of coincidence that stops being true quietly.
    const tools = body().tools;
    expect(tools).toHaveLength(DISCOVERY_TOOLS.length);
    for (const [index, tool] of tools.entries()) {
      const source = DISCOVERY_TOOLS[index];
      expect(tool.type).toBe("function");
      expect(tool.function.strict).toBe(true);
      expect(tool.function.name).toBe(source?.name);
      expect(tool.function.parameters).toEqual(source?.input_schema);
      const schema = tool.function.parameters as {
        additionalProperties: boolean;
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required.slice().sort()).toEqual(Object.keys(schema.properties).sort());
    }
  });

  it("drops the cache breakpoints, because there is nothing here to receive them", () => {
    // Dropped rather than translated. This API's prompt cache is automatic and prefix-based; there
    // is no marker to send. The ORDERING discipline still pays off, which is why the system message
    // is still first - but the breakpoint itself has no counterpart and is not invented into one.
    expect(JSON.stringify(body())).not.toContain("cache_control");
    expect(JSON.stringify(body())).not.toContain("ephemeral");
  });
});

// ---------------------------------------------------------------------------------------------
// Message translation
// ---------------------------------------------------------------------------------------------

describe("message translation", () => {
  it("splits one user message of tool results into one tool message each, in order", () => {
    // The shape difference that would silently corrupt a conversation if it were got wrong.
    const messages = toOpenAIMessages([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "first" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "second" },
        ],
      },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "first" });
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: "toolu_2", content: "second" });
  });

  it("renders is_error into the text, because this API has no field for it", () => {
    // A refused tool call has to stay distinguishable from a successful one, and on this provider
    // the only channel is the message body. Losing the distinction would let the model treat a
    // policy refusal as a result.
    const messages = toOpenAIMessages([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "off the allowlist",
            is_error: true,
          },
        ],
      },
    ]);
    expect(messages[0]).toMatchObject({
      role: "tool",
      content: `${OPENAI_TOOL_ERROR_PREFIX}off the allowlist`,
    });
  });

  it("serialises tool_use input as a JSON STRING, which is what the wire wants", () => {
    const messages = toOpenAIMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "opening the record" },
          { type: "tool_use", id: "toolu_9", name: "act", input: { nodeRef: "n1" } },
        ],
      },
    ]);
    expect(messages).toEqual([
      {
        role: "assistant",
        content: "opening the record",
        tool_calls: [
          {
            id: "toolu_9",
            type: "function",
            function: { name: "act", arguments: '{"nodeRef":"n1"}' },
          },
        ],
      },
    ]);
  });

  it("drops thinking blocks, which is a behavioural difference and not a detail", () => {
    // Signed reasoning is the other provider's and has no field here. Re-sending the prose as
    // assistant text would present one provider's reasoning as another's, so it is dropped - and a
    // run through this adapter therefore does not carry reasoning across turns the way the other
    // one does. Pinned so the difference is a decision somebody made rather than a bug.
    const messages = toOpenAIMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", signature: "sig" },
          { type: "text", text: "visible" },
        ],
      },
    ]);
    expect(messages).toEqual([{ role: "assistant", content: "visible" }]);
  });

  it("throws on a block it has no counterpart for, rather than filtering it away", () => {
    // A silently dropped block is a conversation the provider saw and our transcript did not.
    expect(() =>
      toOpenAIMessages([
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
          ],
        },
      ]),
    ).toThrow(DiscoveryModelError);
  });
});

// ---------------------------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------------------------

describe("response translation", () => {
  it("maps every finish_reason this loop can see, and THROWS on one it cannot", () => {
    expect(toStopReason("stop")).toBe("end_turn");
    expect(toStopReason("tool_calls")).toBe("tool_use");
    expect(toStopReason("length")).toBe("max_tokens");
    expect(toStopReason("content_filter")).toBe("refusal");
    expect(toStopReason(null)).toBeNull();
    // Not defaulted to `end_turn`: the loop records `end_turn` with no tool call as "the model
    // stopped talking to the machinery", so mapping an unknown reason onto it would write a
    // confident wrong cause into the evidence for a run that ended for a reason nobody has read.
    expect(() => toStopReason("hand_of_god")).toThrow(DiscoveryModelError);
  });

  it("SUBTRACTS cached tokens from the prompt count, so the cache hit rate is not understated", () => {
    // The arithmetic that a careless mapping would get wrong invisibly. Anthropic's `input_tokens`
    // EXCLUDES cache reads; OpenAI's `prompt_tokens` INCLUDES them. `cacheHitRate` divides the reads
    // by `input + creation + read`, so forwarding `prompt_tokens` unchanged counts the cached
    // tokens twice in the denominator and reports a smaller rate than the run achieved.
    const usage = toModelUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    expect(usage).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 800,
    });
    // And the denominator now equals the prompt tokens the run was actually billed for.
    const total = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
    expect(total).toBe(1000);
  });

  it("reports 0 cache-creation tokens because this API has no such line, not because none happened", () => {
    expect(toModelUsage({ prompt_tokens: 10 }).cacheCreationInputTokens).toBe(0);
    expect(toModelUsage(null).cacheReadInputTokens).toBe(0);
  });

  it("parses the tool call arguments back into an object", async () => {
    const model = createOpenAIModel({
      modelId: MODEL_ID,
      env: {},
      fetch: stub({
        json: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "act", arguments: '{"nodeRef":"n3","action":"activate"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      }),
    });
    const response = await model.turn(REQUEST);
    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "tool_use", id: "call_1", name: "act", input: { nodeRef: "n3", action: "activate" } },
    ]);
  });

  it("fails loudly when the arguments are not valid JSON", async () => {
    const model = createOpenAIModel({
      modelId: MODEL_ID,
      env: {},
      fetch: stub({
        json: {
          choices: [
            {
              message: {
                tool_calls: [
                  { id: "c", type: "function", function: { name: "act", arguments: "{not json" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      }),
    });
    await expect(model.turn(REQUEST)).rejects.toThrow(/not valid JSON/);
  });

  it("treats a model refusal as a fact about our machinery, never as a result", async () => {
    const model = createOpenAIModel({
      modelId: MODEL_ID,
      env: {},
      fetch: stub({
        json: {
          choices: [
            {
              message: { content: null, refusal: "I cannot help with that" },
              finish_reason: "stop",
            },
          ],
        },
      }),
    });
    await expect(model.turn(REQUEST)).rejects.toThrow(DiscoveryModelError);
  });
});

// ---------------------------------------------------------------------------------------------
// Transport errors
// ---------------------------------------------------------------------------------------------

describe("transport errors", () => {
  it("separates rate limiting from a bad request, because they mean opposite things", async () => {
    const rateLimited = createOpenAIModel({
      modelId: MODEL_ID,
      env: {},
      fetch: stub({ status: 429, text: "slow down" }),
    });
    await expect(rateLimited.turn(REQUEST)).rejects.toThrow(/rate limited/);

    const bad = createOpenAIModel({
      modelId: MODEL_ID,
      env: {},
      fetch: stub({ status: 400, text: "unknown parameter" }),
    });
    await expect(bad.turn(REQUEST)).rejects.toThrow(/rejected the request body \(400\)/);

    const down = createOpenAIModel({
      modelId: MODEL_ID,
      env: {},
      fetch: stub({ status: 503, text: "overloaded" }),
    });
    await expect(down.turn(REQUEST)).rejects.toThrow(/provider error 503/);
  });

  it("posts to the configured base url, so a compatible gateway is one option away", async () => {
    // The reason this adapter is HTTP rather than an SDK: the same code drives Azure OpenAI, vLLM
    // and every OpenAI-compatible gateway, which makes "not provider-coupled" a wider claim than a
    // second vendor client would have been.
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const model = createOpenAIModel({
      modelId: MODEL_ID,
      env: { OPENAI_API_KEY: "sk-not-a-real-key" },
      baseUrl: "https://gateway.invalid/v1/",
      fetch: stub(
        { json: { choices: [{ message: { content: "hi" }, finish_reason: "stop" }] } },
        seen,
      ),
    });
    await model.turn(REQUEST);
    expect(seen.url).toBe("https://gateway.invalid/v1/chat/completions");
    expect(seen.headers?.authorization).toBe("Bearer sk-not-a-real-key");
    expect(OPENAI_DEFAULT_BASE_URL).toBe("https://api.openai.com/v1");
  });
});

// ---------------------------------------------------------------------------------------------
// THE ACCEPTANCE TEST
// ---------------------------------------------------------------------------------------------

const CREDENTIALS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

describe("THE SAME LOOP COMPLETES AGAINST A SECOND PROVIDER", () => {
  const saved = new Map<string, string | undefined>();
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  async function runThroughOpenAI() {
    const player = playCassette(CASSETTE);
    const surface = new MockSurface({ screens, start: "searchForm", transitions });
    const model = createRecordingModel(
      createOpenAIModel({
        modelId: CASSETTE_MODEL_ID,
        env: {},
        fetch: player.fetch,
      }),
      {
        nowMs: frozenClockMs(),
        recordedAt: null,
        // Marked synthetic explicitly. `createRecordingModel` only infers `synthetic` for the
        // `scripted` adapter, and a cassette played through the openai adapter would otherwise be
        // recorded as a real openai run - which is exactly the mislabelling BRIEF section 10 forbids.
        synthetic: true,
        note:
          "SYNTHETIC. Played back from test/fixtures/build-openai-cassette.ts through the openai " +
          "adapter with an injected fetch. No provider was called. NOT evidence of a discovery run.",
      },
    );
    const run = await runDiscoveryLoop({
      goal: GOAL,
      target: TARGET,
      model,
      surface,
      allowlist: ALLOWLIST,
      control: CONTROL,
      now: () => FROZEN_NOW,
      nowMs: frozenClockMs(),
    });
    return { run, player, transcript: model.transcript() };
  }

  async function runThroughScripted() {
    const surface = new MockSurface({ screens, start: "searchForm", transitions });
    return runDiscoveryLoop({
      goal: GOAL,
      target: TARGET,
      model: createScriptedModel(SCRIPT, { modelId: "synthetic-script" }),
      surface,
      allowlist: ALLOWLIST,
      control: CONTROL,
      now: () => FROZEN_NOW,
      nowMs: frozenClockMs(),
    });
  }

  it("completes the fixture goal through the openai adapter with NO credentials present", async () => {
    for (const key of CREDENTIALS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    const { run, player } = await runThroughOpenAI();
    expect(run.status).toBe("reached-goal");
    expect(run.steps.length).toBeGreaterThan(0);
    // It really went through the adapter: one HTTP request was built per turn.
    expect(player.requests).toHaveLength(run.turns);
    expect(player.urls.every((u) => u.endsWith("/chat/completions"))).toBe(true);
  });

  it("reaches the SAME status, steps and outputs as the Anthropic-shaped run of the same script", async () => {
    // This is the whole claim of unit 23, and it is a comparison rather than an assertion about one
    // run. Same goal, same surface, same script, two completely different wire dialects - and the
    // loop's own output is identical. What differs is only what the two providers cannot agree
    // about, and that lives in the adapter rather than in the loop.
    const [viaOpenAI, viaScripted] = await Promise.all([runThroughOpenAI(), runThroughScripted()]);
    expect(viaOpenAI.run.status).toBe(viaScripted.status);
    expect(viaOpenAI.run.turns).toBe(viaScripted.turns);
    expect(viaOpenAI.run.steps).toEqual(viaScripted.steps);
    expect(viaOpenAI.run.outputs).toEqual(viaScripted.outputs);
    expect(viaOpenAI.run.summary).toBe(viaScripted.summary);
  });

  it("sends the strict tool definitions and the one-action rule on EVERY turn, not just the first", async () => {
    const { player } = await runThroughOpenAI();
    expect(player.requests.length).toBeGreaterThan(1);
    for (const request of player.requests) {
      expect(request.parallel_tool_calls).toBe(false);
      expect(request.tools).toHaveLength(DISCOVERY_TOOLS.length);
      expect(request.tools.every((t) => t.function.strict)).toBe(true);
      expect(request.messages[0]?.role).toBe("system");
    }
    // And the conversation really grew, so this is a loop and not six independent calls.
    const lengths = player.requests.map((r) => r.messages.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(lengths.at(-1)).toBeGreaterThan(lengths[0] ?? 0);
  });

  it("still records a port-level VCR transcript, so the recorder is adapter-agnostic", async () => {
    // `createRecordingModel` wraps the PORT, not the provider, which is what makes SPEC section 6.5's
    // "every run through ANY adapter records" true by construction rather than by three copies of
    // the same code. Checked here rather than assumed, because this is the second adapter and the
    // first opportunity for the claim to be wrong.
    const { transcript, run } = await runThroughOpenAI();
    const parsed = parseTranscript(JSON.parse(JSON.stringify(transcript)));
    expect(parsed.provenance.adapter).toBe("openai");
    expect(parsed.provenance.modelId).toBe(CASSETTE_MODEL_ID);
    expect(parsed.synthetic).toBe(true);
    expect(parsed.turns).toHaveLength(run.turns);
    expect(parsed.toolCalls.length).toBeGreaterThan(0);
  });

  it("refuses to be presented as evidence, because the model turns were written by hand", async () => {
    const { transcript } = await runThroughOpenAI();
    // The cassette says so in the file, and the transcript recorded from it says so too. BRIEF
    // section 10 states the rule three ways; this is the one that executes.
    expect(CASSETTE.synthetic).toBe(true);
    expect(CASSETTE.provenance.note).toContain("NOT evidence of a discovery run");
    expect(transcript.synthetic).toBe(true);
  });

  it("throws rather than improvising when the loop outruns the cassette", async () => {
    const short: Cassette = { ...CASSETTE, exchanges: CASSETTE.exchanges.slice(0, 2) };
    const player = playCassette(short);
    const surface = new MockSurface({ screens, start: "searchForm", transitions });
    const failed = await runDiscoveryLoop({
      goal: GOAL,
      target: TARGET,
      model: createOpenAIModel({ modelId: CASSETTE_MODEL_ID, env: {}, fetch: player.fetch }),
      surface,
      allowlist: ALLOWLIST,
      control: CONTROL,
      now: () => FROZEN_NOW,
      nowMs: frozenClockMs(),
    }).then(
      () => null,
      (error: unknown) => error,
    );

    // A transport that cannot answer is reported as a transport failure, not as a run that ended.
    expect(failed).toBeInstanceOf(DiscoveryModelError);
    expect((failed as DiscoveryModelError).adapter).toBe("openai");
    expect((failed as Error).message).toContain("before a response arrived");
    // And the real diagnostic survives on `cause`, which is where this adapter puts it - the same
    // place the anthropic adapter puts its own. Asserted because an error whose cause is dropped is
    // an error a postmortem cannot follow, and the wrapper message alone would not name the cassette.
    const cause = (failed as DiscoveryModelError).cause;
    expect((cause as Error).message).toMatch(
      /got further this time than the run that was recorded/,
    );
  });
});
