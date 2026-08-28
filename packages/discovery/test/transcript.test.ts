// The VCR's mechanics, apart from the loop: recording, provenance, token arithmetic, and the
// conversion from a response back into the next request's history.

import { describe, expect, it } from "vitest";
import {
  type AssistantBlock,
  DiscoveryModelError,
  type ModelTurnRequest,
  type ModelUsage,
  type Transcript,
  ZERO_USAGE,
  addUsage,
  assertRealRecording,
  cacheHitRate,
  createRecordingModel,
  createScriptedModel,
  messagesDigestOf,
  parseTranscript,
  prefixDigestOf,
  toParamBlocks,
  toolsWithCacheBreakpoint,
} from "../src/index.js";

const request = (messages: ModelTurnRequest["messages"]): ModelTurnRequest => ({
  system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
  tools: toolsWithCacheBreakpoint(),
  messages,
});

const tick = (): (() => number) => {
  let value = 0;
  return () => {
    value += 5;
    return value;
  };
};

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

describe("the recorder", () => {
  it("stores the stable prefix once and the appended messages per turn", async () => {
    const inner = createScriptedModel([
      { text: "one", toolUses: [{ name: "observe", input: {} }] },
      { text: "two" },
    ]);
    const model = createRecordingModel(inner, { nowMs: tick(), note: "test" });

    await model.turn(request([{ role: "user", content: "first" }]));
    await model.turn(
      request([
        { role: "user", content: "first" },
        { role: "assistant", content: "one" },
        { role: "user", content: "second" },
      ]),
    );

    const transcript = model.transcript();
    expect(transcript.turns).toHaveLength(2);
    expect(transcript.turns[0]?.appended).toHaveLength(1);
    // Quadratic growth avoided: turn 2 stores the two NEW messages, not all three.
    expect(transcript.turns[1]?.appended).toHaveLength(2);
    expect(transcript.prefix.system).toHaveLength(1);
  });

  it("records a digest of the FULL history, which is what replay verifies against", async () => {
    const messages: ModelTurnRequest["messages"] = [{ role: "user", content: "first" }];
    const model = createRecordingModel(createScriptedModel([{ text: "one" }]), {
      nowMs: tick(),
      note: "test",
    });
    await model.turn(request(messages));
    expect(model.transcript().turns[0]?.messagesDigest).toBe(messagesDigestOf(messages));
    expect(model.transcript().prefix.digest).toBe(prefixDigestOf(request(messages)));
  });

  it("records timings from the injected clock, so a fixture rebuild is reproducible", async () => {
    const model = createRecordingModel(createScriptedModel([{ text: "one" }]), {
      nowMs: tick(),
      note: "test",
    });
    await model.turn(request([{ role: "user", content: "x" }]));
    expect(model.transcript().turns[0]?.latencyMs).toBe(5);
  });

  it("records the tool calls the loop made, with their outcome", async () => {
    const model = createRecordingModel(createScriptedModel([{ text: "one" }]), {
      nowMs: tick(),
      note: "test",
    });
    await model.turn(request([{ role: "user", content: "x" }]));
    model.recordToolCall({
      turn: 1,
      toolUseId: "toolu_1",
      name: "act",
      input: { nodeRef: "n1" },
      outcome: "refused",
      detail: "stale",
      latencyMs: 2,
    });
    expect(model.transcript().toolCalls).toEqual([
      {
        turn: 1,
        toolUseId: "toolu_1",
        name: "act",
        input: { nodeRef: "n1" },
        outcome: "refused",
        detail: "stale",
        latencyMs: 2,
      },
    ]);
  });

  it("refuses to produce a transcript of nothing", () => {
    const model = createRecordingModel(createScriptedModel([]), { nowMs: tick(), note: "test" });
    expect(() => model.transcript()).toThrow(/nothing was recorded/);
  });

  it("marks a scripted run synthetic by default, without being asked", async () => {
    const model = createRecordingModel(createScriptedModel([{ text: "one" }]), {
      nowMs: tick(),
      note: "test",
    });
    await model.turn(request([{ role: "user", content: "x" }]));
    expect(model.transcript().synthetic).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------------

describe("provenance is enforced, not documented", () => {
  const real: Transcript = parseTranscript({
    version: 1,
    synthetic: false,
    provenance: {
      adapter: "anthropic",
      modelId: "claude-opus-5",
      recordedAt: "2026-02-01T10:00:00.000Z",
      note: "recorded against the live API by the author",
    },
    prefix: { system: [], tools: [], digest: `sha256:${"a".repeat(64)}` },
    turns: [],
    toolCalls: [],
    usage: ZERO_USAGE,
    cacheHitRate: 0,
  });

  it("accepts a live anthropic recording as evidence", () => {
    expect(() => assertRealRecording(real)).not.toThrow();
  });

  it("refuses a synthetic one", () => {
    expect(() => assertRealRecording({ ...real, synthetic: true })).toThrow(DiscoveryModelError);
  });

  it("refuses a replay of a replay, which is a recording of a recording", () => {
    const replayed: Transcript = {
      ...real,
      provenance: { ...real.provenance, adapter: "replay" },
    };
    expect(() => assertRealRecording(replayed)).toThrow(/not a model run/);
  });

  it("requires a non-empty note, because an optional one is empty on the file that matters", () => {
    expect(() =>
      parseTranscript({ ...real, provenance: { ...real.provenance, note: "" } }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Token arithmetic
// ---------------------------------------------------------------------------------------------

describe("the cache hit rate", () => {
  const usage = (over: Partial<ModelUsage>): ModelUsage => ({ ...ZERO_USAGE, ...over });

  it("is the fraction of PROMPT tokens served from the cache", () => {
    expect(cacheHitRate(usage({ inputTokens: 100, cacheReadInputTokens: 900 }))).toBe(0.9);
  });

  it("counts the cache WRITE in the denominator, so it cannot be inflated", () => {
    // Excluding `cache_creation_input_tokens` would report the first turn of every run as a
    // perfect hit rate, which is the exact opposite of the truth.
    expect(
      cacheHitRate(
        usage({ inputTokens: 0, cacheCreationInputTokens: 1000, cacheReadInputTokens: 0 }),
      ),
    ).toBe(0);
    expect(
      cacheHitRate(
        usage({ inputTokens: 0, cacheCreationInputTokens: 500, cacheReadInputTokens: 500 }),
      ),
    ).toBe(0.5);
  });

  it("is 0 rather than NaN for a run with no prompt tokens", () => {
    // A rate nobody measured must not render as a number somebody quotes.
    expect(cacheHitRate(ZERO_USAGE)).toBe(0);
  });

  it("sums across turns", () => {
    const total = addUsage(
      usage({ inputTokens: 10, cacheReadInputTokens: 90 }),
      usage({ inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 80 }),
    );
    expect(total).toEqual({
      inputTokens: 30,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 170,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Response -> history
// ---------------------------------------------------------------------------------------------

describe("turning a response back into the next request's history", () => {
  it("keeps a thinking block's signature, which the API requires on the next turn", () => {
    const blocks: readonly AssistantBlock[] = [
      { type: "thinking", thinking: "considering", signature: "sig-1" },
    ];
    expect(toParamBlocks(blocks, "anthropic")).toEqual([
      { type: "thinking", thinking: "considering", signature: "sig-1" },
    ]);
  });

  it("drops citations, because no tool in this loop produces a citable document", () => {
    const blocks: readonly AssistantBlock[] = [{ type: "text", text: "hello", citations: null }];
    expect(toParamBlocks(blocks, "anthropic")).toEqual([{ type: "text", text: "hello" }]);
  });

  it("throws on a block it has never seen rather than dropping it silently", () => {
    const rogue = [{ type: "server_tool_use", id: "x", name: "y", input: {} }];
    expect(() => toParamBlocks(rogue as unknown as AssistantBlock[], "anthropic")).toThrow(
      DiscoveryModelError,
    );
  });
});
