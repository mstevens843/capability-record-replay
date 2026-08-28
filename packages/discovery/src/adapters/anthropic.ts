// SPEC section 6.5 - the `anthropic` adapter. Primary, and the one that ships.
//
// The API facts below are BRIEF section 9's, which were verified against the `claude-api` skill and
// which override anything a model or an engineer remembers. They are restated here because the
// installed SDK (0.71.2) has not caught up with two of them, and a reader who finds that mismatch
// deserves the reason rather than a cast with no comment:
//
//   · `budget_tokens` is REMOVED and returns HTTP 400 on Opus 5. Thinking is on by default and is
//     configured as `{ type: "adaptive" }`. The SDK's `ThinkingConfigEnabled` still REQUIRES
//     `budget_tokens`, so its type cannot express the only form that works.
//   · effort goes in `output_config`, not at the top level. `output_config` exists on the SDK's
//     BETA message params only, and its effort union there is narrower than the real one.
//   · `strict: true` is a top-level field on the tool definition. The stable `Tool` type has no
//     such field; `BetaTool` does.
//
// So the body is built as a plain object by `buildRequestBody` - a PURE function with no client, no
// key and no socket, which is why it is unit-tested in a suite that never spends a cent - and
// handed to the SDK at exactly one call site with one documented widening. When the stable types
// catch up, that widening is the only thing that has to be deleted.
//
// Assistant prefill returns 400 on Opus 5, which is why the loop shapes its output through tool
// definitions and the system prompt and never by seeding an assistant turn.

import Anthropic from "@anthropic-ai/sdk";
import {
  type AssistantBlock,
  DEFAULT_MODEL_ID,
  type DiscoveryModel,
  DiscoveryModelError,
  type ModelEffort,
  type ModelTurnRequest,
  type ModelTurnResponse,
  type ModelUsage,
  type StrictTool,
  type SystemBlock,
} from "../model-port.js";

/** BRIEF section 9: about 16000 for a non-streaming request. */
export const DEFAULT_MAX_TOKENS = 16000;

/**
 * The request body, as the API takes it.
 *
 * Written out rather than derived from `Anthropic.MessageCreateParamsNonStreaming` because three of
 * its fields cannot be expressed by that type in this SDK version (see the file header). Every
 * field that CAN come from the SDK does: `messages`, `system` blocks and the tool definitions are
 * all SDK types.
 */
export interface DiscoveryRequestBody {
  readonly model: string;
  readonly max_tokens: number;
  /** First, and carrying the cache breakpoint. The observation payload changes every turn, so the
   *  cacheable prefix must precede it or it never hits. */
  readonly system: readonly SystemBlock[];
  readonly tools: readonly StrictTool[];
  /**
   * `disable_parallel_tool_use: true`, and this is the single most consequential line in the file.
   *
   * A computer-use loop must observe the consequence of each action before choosing the next.
   * Interleaved actions would make the recorded step order meaningless - and the recorded step
   * order is the artifact. SPEC section 6.1 and BRIEF section 9 both require it; the loop enforces
   * it a second time on our side, because a provider-side flag is a request, not a guarantee.
   */
  readonly tool_choice: { readonly type: "auto"; readonly disable_parallel_tool_use: true };
  readonly messages: readonly Anthropic.MessageParam[];
  /** BRIEF section 9: `budget_tokens` is removed and returns 400. */
  readonly thinking: { readonly type: "adaptive" };
  /** BRIEF section 9: effort lives here, not at the top level. Default `high`. */
  readonly output_config: { readonly effort: ModelEffort };
}

export interface AnthropicAdapterOptions {
  /** Defaults to `CRR_MODEL`, then to `claude-opus-5`. Never with a date suffix. */
  readonly modelId?: string;
  readonly effort?: ModelEffort;
  readonly maxTokens?: number;
  /** Injected so a test can prove the no-key path without touching the real environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected so nothing in a test can construct a real client by accident. */
  readonly client?: MessagesClient;
}

/**
 * The one method this adapter calls.
 *
 * Narrower than `Anthropic["messages"]` on purpose: a seam a test can stand in front of has to be
 * satisfiable by a five-line object, and `Pick<Messages, "create">` is not - it demands an
 * `APIPromise`, which is a class with private fields. Declaring `create` as a METHOD rather than a
 * function-valued property is also deliberate: method parameters are checked bivariantly, so both
 * the real client and a fake that accepts `unknown` satisfy this.
 */
export interface MessagesClient {
  create(body: Anthropic.MessageCreateParamsNonStreaming): PromiseLike<Anthropic.Message>;
}

// ---------------------------------------------------------------------------------------------
// The body - pure, testable, and never a network call
// ---------------------------------------------------------------------------------------------

export function buildRequestBody(
  request: ModelTurnRequest,
  options: { readonly modelId: string; readonly effort: ModelEffort; readonly maxTokens: number },
): DiscoveryRequestBody {
  return {
    model: options.modelId,
    max_tokens: options.maxTokens,
    system: request.system,
    tools: request.tools,
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: request.messages,
    thinking: { type: "adaptive" },
    output_config: { effort: options.effort },
  };
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

/**
 * Build the shipping adapter.
 *
 * The key is resolved from the environment by the SDK itself (`new Anthropic()`), and the absence
 * of one is turned into a message that names the alternative, because the failure a reviewer will
 * actually hit is running the demo with no credentials - and "401" is a worse answer than "use the
 * replay adapter, here is how".
 *
 * NOTE FOR ANY AGENT OR CI JOB READING THIS: constructing this object performs no request, but
 * calling `turn` DOES, and it is billed. BRIEF section 11 forbids that outside an explicitly
 * approved run. Every test in this package uses `replay` or `scripted`.
 */
export function createAnthropicModel(options: AnthropicAdapterOptions = {}): DiscoveryModel {
  const env = options.env ?? process.env;
  const modelId = options.modelId ?? env.CRR_MODEL ?? DEFAULT_MODEL_ID;
  const effort: ModelEffort = options.effort ?? "high";
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  const messages =
    options.client ??
    (() => {
      const apiKey = env.ANTHROPIC_API_KEY;
      if (apiKey === undefined || apiKey === "") {
        throw new DiscoveryModelError(
          "anthropic",
          "ANTHROPIC_API_KEY is not set. The anthropic adapter is the only one that calls a live model; " +
            "to run the loop with no credentials, use createReplayModel() with a recorded transcript.",
        );
      }
      return new Anthropic({ apiKey }).messages;
    })();

  return {
    adapter: "anthropic",
    modelId,

    async turn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
      const body = buildRequestBody(request, { modelId, effort, maxTokens });
      let message: Anthropic.Message;
      try {
        // THE ONE WIDENING. `thinking: {type:"adaptive"}`, `output_config` and the tools' `strict`
        // flag are current API, and this SDK version's stable params type predates all three. The
        // shape is `DiscoveryRequestBody`, which is checked; the cast only tells the compiler that
        // we know more about the wire than its types do.
        message = await messages.create(
          body as unknown as Anthropic.MessageCreateParamsNonStreaming,
        );
      } catch (cause) {
        throw describe(cause);
      }
      return {
        stopReason: message.stop_reason,
        content: message.content.map((block) => assistantBlock(block)),
        usage: usageOf(message.usage),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------------------------

/**
 * Narrow one response block to the subset this loop declared.
 *
 * A `server_tool_use` or a `web_search_tool_result` here would mean the request carried a tool we
 * did not put in it, which is a fact worth a loud failure rather than a filtered array: the whole
 * safety argument is that the model's only levers are the five in `tools.ts`.
 */
function assistantBlock(block: Anthropic.ContentBlock): AssistantBlock {
  switch (block.type) {
    case "text":
    case "thinking":
    case "redacted_thinking":
    case "tool_use":
      return block;
    default:
      throw new DiscoveryModelError(
        "anthropic",
        `the response contained a "${block.type}" block; this loop declares only the five tools in tools.ts`,
      );
  }
}

/** `cache_read_input_tokens` is null when no cache was involved; a null is 0 tokens read, and the
 *  cache hit rate must not be computed from a NaN. */
function usageOf(usage: Anthropic.Usage): ModelUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/**
 * Typed errors, most specific first, never string-matched (BRIEF section 9).
 *
 * The rate-limit and bad-request arms are separated because they mean opposite things to whoever is
 * reading the failure: one is "wait", the other is "the request you are building is wrong", and a
 * discovery run that reports the first when it means the second wastes an afternoon.
 */
function describe(cause: unknown): DiscoveryModelError {
  if (cause instanceof Anthropic.RateLimitError) {
    return new DiscoveryModelError("anthropic", "rate limited by the provider", { cause });
  }
  if (cause instanceof Anthropic.BadRequestError) {
    return new DiscoveryModelError(
      "anthropic",
      `the provider rejected the request body (${cause.status}): ${cause.message}`,
      { cause },
    );
  }
  if (cause instanceof Anthropic.APIError) {
    return new DiscoveryModelError(
      "anthropic",
      `provider error ${cause.status}: ${cause.message}`,
      {
        cause,
      },
    );
  }
  return new DiscoveryModelError("anthropic", "the request failed before a response arrived", {
    cause,
  });
}
