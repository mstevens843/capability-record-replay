// The shipping adapter, tested without spending a cent.
//
// NOTHING IN THIS FILE MAKES A LIVE CALL. `buildRequestBody` is pure, and every test that needs a
// `turn()` injects a fake `messages.create`. BRIEF section 11 forbids an agent or a CI job from
// reaching a provider, and the way that rule survives is by the adapter having a seam a test can
// stand in front of - which is the same seam a reviewer uses to see the request body without
// running anything.
//
// The assertions are, deliberately, BRIEF section 9's verified API facts restated as tests:
// `budget_tokens` must not appear anywhere; thinking is `{ type: "adaptive" }`; effort lives in
// `output_config`; `disable_parallel_tool_use` is on `tool_choice`; `strict` is top-level on each
// tool; the model id carries no date suffix. Those are the facts a stale training prior gets wrong,
// so they are the ones worth pinning.

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL_ID,
  DISCOVERY_SYSTEM_PROMPT,
  DiscoveryModelError,
  type ModelTurnRequest,
  buildRequestBody,
  createAnthropicModel,
  toolsWithCacheBreakpoint,
} from "../src/index.js";

const REQUEST: ModelTurnRequest = {
  system: [{ type: "text", text: DISCOVERY_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  tools: toolsWithCacheBreakpoint(),
  messages: [{ role: "user", content: "TASK: look up a member" }],
};

const body = () =>
  buildRequestBody(REQUEST, {
    modelId: DEFAULT_MODEL_ID,
    effort: "high",
    maxTokens: DEFAULT_MAX_TOKENS,
  });

const usage = (over: Partial<Anthropic.Usage> = {}): Anthropic.Usage => ({
  input_tokens: 100,
  output_tokens: 20,
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  server_tool_use: null,
  service_tier: "standard",
  ...over,
});

const message = (over: Partial<Anthropic.Message> = {}): Anthropic.Message =>
  ({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: DEFAULT_MODEL_ID,
    content: [{ type: "text", text: "hello", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: usage(),
    ...over,
  }) as Anthropic.Message;

const fakeClient = (
  reply: Anthropic.Message | Error,
  seen?: { request?: unknown },
): { create: (params: unknown) => Promise<Anthropic.Message> } => ({
  create: async (params: unknown) => {
    if (seen !== undefined) seen.request = params;
    if (reply instanceof Error) throw reply;
    return reply;
  },
});

// ---------------------------------------------------------------------------------------------
// The request body
// ---------------------------------------------------------------------------------------------

describe("the request body follows the current API, not a stale prior", () => {
  it("sets thinking to adaptive and carries no budget_tokens anywhere", () => {
    // `budget_tokens` is REMOVED and returns HTTP 400 on Opus 5 (BRIEF section 9). The negative
    // assertion is over the whole serialized body, because the way this regresses is somebody
    // adding it back in a nested config object rather than at the top level.
    expect(body().thinking).toEqual({ type: "adaptive" });
    expect(JSON.stringify(body())).not.toContain("budget_tokens");
  });

  it("puts effort in output_config and not at the top level", () => {
    const built = body();
    expect(built.output_config).toEqual({ effort: "high" });
    expect(built).not.toHaveProperty("effort");
  });

  it("disables parallel tool use, because the recorded step order is the artifact", () => {
    expect(body().tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("marks the stable prefix cacheable and puts it FIRST", () => {
    const built = body();
    const keys = Object.keys(built);
    expect(keys.indexOf("system")).toBeLessThan(keys.indexOf("messages"));
    expect(keys.indexOf("tools")).toBeLessThan(keys.indexOf("messages"));
    expect(built.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(built.tools.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("sets strict at the top level of every tool definition", () => {
    for (const tool of body().tools) expect(tool.strict).toBe(true);
    expect(JSON.stringify(body().tool_choice)).not.toContain("strict");
  });

  it("uses a model id with no date suffix", () => {
    expect(DEFAULT_MODEL_ID).toBe("claude-opus-5");
    expect(body().model).toBe("claude-opus-5");
    expect(body().model).not.toMatch(/\d{8}$/);
  });

  it("bounds the response", () => {
    expect(body().max_tokens).toBe(16000);
  });
});

// ---------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------

describe("constructing the adapter", () => {
  it("refuses with a message that names the alternative when there is no key", () => {
    expect(() => createAnthropicModel({ env: {} })).toThrow(DiscoveryModelError);
    expect(() => createAnthropicModel({ env: {} })).toThrow(/createReplayModel/);
  });

  it("reads the model id from CRR_MODEL and falls back to the default", () => {
    const custom = createAnthropicModel({
      env: { ANTHROPIC_API_KEY: "not-a-real-key" },
      client: fakeClient(message()),
      modelId: undefined,
    });
    expect(custom.modelId).toBe(DEFAULT_MODEL_ID);

    const overridden = createAnthropicModel({
      env: { CRR_MODEL: "claude-sonnet-5" },
      client: fakeClient(message()),
    });
    expect(overridden.modelId).toBe("claude-sonnet-5");
    expect(overridden.adapter).toBe("anthropic");
  });

  it("needs no key at all when a client is injected, so a test can never call out", () => {
    expect(() => createAnthropicModel({ env: {}, client: fakeClient(message()) })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------------------------

describe("the response mapping", () => {
  it("sends the body this adapter built", async () => {
    const seen: { request?: unknown } = {};
    const model = createAnthropicModel({ env: {}, client: fakeClient(message(), seen) });
    await model.turn(REQUEST);
    expect(seen.request).toMatchObject({
      model: DEFAULT_MODEL_ID,
      thinking: { type: "adaptive" },
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
  });

  it("surfaces cache_read_input_tokens so the hit rate can be reported as a real number", async () => {
    const model = createAnthropicModel({
      env: {},
      client: fakeClient(
        message({
          usage: usage({ cache_read_input_tokens: 4200, cache_creation_input_tokens: 0 }),
        }),
      ),
    });
    const response = await model.turn(REQUEST);
    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 4200,
    });
  });

  it("treats a null cache count as zero rather than as NaN", async () => {
    const model = createAnthropicModel({ env: {}, client: fakeClient(message()) });
    const response = await model.turn(REQUEST);
    expect(response.usage.cacheReadInputTokens).toBe(0);
    expect(response.usage.cacheCreationInputTokens).toBe(0);
  });

  it("keeps thinking and tool_use blocks, which the next turn has to send back", async () => {
    const model = createAnthropicModel({
      env: {},
      client: fakeClient(
        message({
          stop_reason: "tool_use",
          content: [
            { type: "thinking", thinking: "considering", signature: "sig" },
            { type: "tool_use", id: "toolu_1", name: "observe", input: {} },
          ] as Anthropic.ContentBlock[],
        }),
      ),
    });
    const response = await model.turn(REQUEST);
    expect(response.stopReason).toBe("tool_use");
    expect(response.content.map((block) => block.type)).toEqual(["thinking", "tool_use"]);
  });

  it("refuses a block this loop never asked for, rather than filtering it away", async () => {
    // A server tool result here means the request carried a tool we did not put in it. Filtering it
    // out would leave a message history that no longer matches what the provider saw.
    const model = createAnthropicModel({
      env: {},
      client: fakeClient(
        message({
          content: [{ type: "web_search_tool_result" }] as unknown as Anthropic.ContentBlock[],
        }),
      ),
    });
    await expect(model.turn(REQUEST)).rejects.toThrow(/only the five tools/);
  });
});

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

describe("provider errors are typed, most specific first", () => {
  const headers = new Headers();

  it("distinguishes a rate limit from a bad request", async () => {
    const limited = createAnthropicModel({
      env: {},
      client: fakeClient(new Anthropic.RateLimitError(429, {}, "slow down", headers)),
    });
    await expect(limited.turn(REQUEST)).rejects.toThrow(/rate limited/);

    const bad = createAnthropicModel({
      env: {},
      client: fakeClient(new Anthropic.BadRequestError(400, {}, "bad body", headers)),
    });
    // The two mean opposite things to whoever reads the failure: one is "wait", the other is "the
    // request you are building is wrong".
    await expect(bad.turn(REQUEST)).rejects.toThrow(/rejected the request body/);
  });

  it("wraps anything else without losing the cause", async () => {
    const cause = new Error("socket hang up");
    const model = createAnthropicModel({ env: {}, client: fakeClient(cause) });
    await expect(model.turn(REQUEST)).rejects.toMatchObject({
      name: "DiscoveryModelError",
      adapter: "anthropic",
      cause,
    });
  });
});
