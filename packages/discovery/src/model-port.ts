// SPEC section 6.5 - the `DiscoveryModel` provider port.
//
// One method. A turn goes in, a turn comes out, and the LOOP owns everything else: the message
// history, the tool dispatch, the policy chokepoint, the journal and the stopping condition. That
// division is the whole reason this port exists in the shape it does - SPEC section 6.5 says the
// manual tool-use loop is one of the things being evaluated, and a port that owned the loop would
// have moved the evaluated artifact inside a vendor SDK.
//
// It is also what makes the VCR possible. A port whose single method is `(request) -> response` can
// be recorded and served back byte for byte; a port that hands the SDK a callback and waits cannot,
// because the interesting state lives on the SDK's stack.
//
// WHAT IS DELIBERATELY NOT HERE: `thinking`, `output_config`, `max_tokens`, `tool_choice` and the
// model id. Those are provider dialect and they live in the adapter, because `replay` has no
// opinion about any of them and a port that carried them would be the Anthropic Messages API with
// extra steps.

import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------------------------

/**
 * The adapters named in SPEC section 6.5, plus `scripted`.
 *
 * `scripted` is a hand-authored model used to build VCR fixtures and to exercise the loop's
 * stopping conditions. It is in the vocabulary rather than hidden in a test folder for one reason:
 * BRIEF section 10 requires every file in `/evidence/` to state which adapter produced it, and a
 * transcript that came from a script has to be able to SAY so in the same field a real one does.
 * A provenance field that can only spell honest values is not a provenance field.
 */
export const DISCOVERY_ADAPTERS = [
  "anthropic",
  "replay",
  "agent-sdk",
  "openai",
  "scripted",
] as const;
export type DiscoveryAdapterName = (typeof DISCOVERY_ADAPTERS)[number];

/** BRIEF section 9: the default model id, never with a date suffix. */
export const DEFAULT_MODEL_ID = "claude-opus-5";

/**
 * BRIEF section 9: effort goes in `output_config`, NOT at the top level, and the default is
 * `high`. The installed SDK (0.71.2) types `BetaOutputConfig.effort` as `low | medium | high`
 * only, and `output_config` does not appear on the stable Messages params at all - so this union
 * is written here rather than imported. It is a request field the SDK has not caught up with, not
 * a re-declaration of a type the SDK owns.
 */
export const MODEL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ModelEffort = (typeof MODEL_EFFORTS)[number];

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

/**
 * A tool definition with BRIEF section 9's `strict: true`, which is a TOP-LEVEL field on the tool
 * and not a member of `tool_choice`.
 *
 * The intersection is deliberate and narrow: `Anthropic.Tool` stays the source of truth for `name`,
 * `description`, `input_schema` and `cache_control`, and exactly one field is added, because the
 * stable `Tool` type in SDK 0.71.2 predates strict tool use (its `BetaTool` has it). When the
 * stable type gains the field this alias collapses to `Anthropic.Tool` and nothing else changes.
 *
 * Strict matters here more than it usually does: every `act` and `go` input becomes an `Action`
 * that goes through the policy chokepoint, so an input that does not validate exactly is an input
 * the gate would have to reason about defensively.
 */
export type StrictTool = Anthropic.Tool & { readonly strict: true };

/** The cacheable system prefix. A plain text block, optionally carrying a cache breakpoint. */
export type SystemBlock = Anthropic.TextBlockParam;

// ---------------------------------------------------------------------------------------------
// A turn
// ---------------------------------------------------------------------------------------------

/**
 * What one request to the model contains.
 *
 * The order of the fields is the order they appear on the wire, and that ordering is load-bearing
 * rather than cosmetic: BRIEF section 9 requires the stable system prompt and tool definitions to
 * come FIRST so they can carry the cache breakpoint, because the observation payload changes every
 * turn and a prefix that changes is a prefix that never hits.
 */
export interface ModelTurnRequest {
  readonly system: readonly SystemBlock[];
  readonly tools: readonly StrictTool[];
  readonly messages: readonly Anthropic.MessageParam[];
}

/**
 * Token accounting, per turn.
 *
 * `cacheReadInputTokens` is surfaced all the way out to `DiscoveryRun.usage` on purpose. BRIEF
 * section 9 asks for the cache hit rate to be REPORTED AS A MEASURED NUMBER in the evidence, and a
 * number that has to be recovered from provider logs after the fact is a number nobody reports.
 */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export const ZERO_USAGE: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/**
 * The assistant blocks we accept back.
 *
 * A strict subset of `Anthropic.ContentBlock`, and the narrowness is the point: this loop declares
 * no server tools, no citations and no code execution, so a `web_search_tool_result` arriving in a
 * response means the request was not the request we think we sent. `toParamBlocks` refuses one
 * loudly instead of dropping it, because a silently dropped block is a message history that no
 * longer matches what the provider saw.
 */
export type AssistantBlock =
  | Anthropic.TextBlock
  | Anthropic.ThinkingBlock
  | Anthropic.RedactedThinkingBlock
  | Anthropic.ToolUseBlock;

export interface ModelTurnResponse {
  /** `end_turn`, `tool_use`, `max_tokens`, ... Typed as the SDK's own union plus `null`. */
  readonly stopReason: Anthropic.StopReason | null;
  readonly content: readonly AssistantBlock[];
  readonly usage: ModelUsage;
}

/**
 * The port. Three members, and two of them are provenance.
 *
 * `adapter` and `modelId` are not decoration: BRIEF section 10's honesty rules require every
 * evidence file to state which adapter produced it and with which model id, and the only way that
 * survives contact with a busy afternoon is for the value to be carried by the object that did the
 * work rather than typed into a README by hand.
 */
export interface DiscoveryModel {
  readonly adapter: DiscoveryAdapterName;
  readonly modelId: string;
  turn(request: ModelTurnRequest): Promise<ModelTurnResponse>;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * A provider or transcript failure. Loud, and never a `Verdict`.
 *
 * The distinction this class exists to hold is SPEC section 0's: a model that returned a block we
 * cannot interpret, or a transcript whose turn is missing, is a fact about OUR machinery. It is not
 * a business outcome and must never be classified into one, so it throws rather than returning a
 * value the loop could accidentally treat as a result.
 */
export class DiscoveryModelError extends Error {
  override readonly name = "DiscoveryModelError";
  readonly adapter: DiscoveryAdapterName;

  constructor(
    adapter: DiscoveryAdapterName,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.adapter = adapter;
  }
}

// ---------------------------------------------------------------------------------------------
// Response -> history
// ---------------------------------------------------------------------------------------------

/**
 * Convert the blocks the model returned into the blocks that go back on the next request.
 *
 * Every arm is written out rather than cast. The two costs of a cast here are real: a `thinking`
 * block that loses its `signature` is rejected by the API on the next turn, and a block type we
 * have never seen would pass through a cast unexamined into a message history that no longer
 * matches what the provider actually saw.
 *
 * Citations are dropped from text blocks because no tool in this loop produces a citable document;
 * that is an assertion about our own request, and if it ever stops being true the drop is the bug
 * and this comment is where it is found.
 */
export function toParamBlocks(
  blocks: readonly AssistantBlock[],
  adapter: DiscoveryAdapterName,
): Anthropic.ContentBlockParam[] {
  return blocks.map((block): Anthropic.ContentBlockParam => {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text };
      case "thinking":
        return { type: "thinking", thinking: block.thinking, signature: block.signature };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: block.data };
      case "tool_use":
        return { type: "tool_use", id: block.id, name: block.name, input: block.input };
      default: {
        const unreachable: never = block;
        throw new DiscoveryModelError(
          adapter,
          `the model returned a content block this loop did not ask for: ${JSON.stringify(unreachable)}`,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Usage arithmetic
// ---------------------------------------------------------------------------------------------

export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

/**
 * The fraction of PROMPT tokens that were served from the cache.
 *
 * The denominator is spelled out because it is the part that gets fudged: it is every input token
 * the run was billed for in any form - fresh, cache-write and cache-read - so the number cannot be
 * inflated by excluding the writes that had to happen before any read could. A run with no prompt
 * tokens at all returns 0 rather than NaN, because a rate nobody measured must not render as a
 * number somebody quotes.
 */
export function cacheHitRate(usage: ModelUsage): number {
  const total = usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  return total === 0 ? 0 : usage.cacheReadInputTokens / total;
}
