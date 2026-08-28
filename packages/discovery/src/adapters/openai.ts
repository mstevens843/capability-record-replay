// SPEC section 11 unit 23 / BRIEF section 10 - the `openai` adapter. Optional, and the proof that
// the loop is not provider-coupled.
//
// NOTHING HERE IMPORTS AN SDK. The adapter speaks the Chat Completions HTTP shape directly through
// an INJECTED `fetch`, for three reasons, in order of how much they matter:
//
//   1. It keeps the package hermetic. `@crr/discovery` has no `openai` dependency, so `pnpm install`
//      pulls nothing new and there is no second vendor client that could read `OPENAI_API_KEY` out
//      of the environment on construction. BRIEF section 11's no-spend rule is a property of the
//      code here, not a promise about how it is called.
//   2. It makes the whole adapter testable with no network. The seam a test stands in front of is
//      the same seam a reviewer reads to see the exact bytes we would send.
//   3. Chat Completions is the widest-compatibility shape there is. The same adapter, pointed at a
//      different `baseUrl`, drives Azure OpenAI, vLLM, and every OpenAI-compatible gateway - which
//      makes "not provider-coupled" a stronger claim than a second vendor SDK would have.
//
// THE PORT IS ANTHROPIC-SHAPED, AND WRITING THIS IS WHAT MADE THAT VISIBLE. `ModelTurnRequest`
// carries `Anthropic.MessageParam[]` and `Anthropic.Tool`, so this file is a TRANSLATOR rather than
// a peer implementation. That is a real finding about the port and it is recorded in REPORT rather
// than hidden behind a tidy interface: the port is provider-neutral in its SHAPE - one method,
// request in, response out, the loop owns everything else - and provider-flavoured in its
// VOCABULARY. The first property is the one the design's claims rest on and it survived; the second
// is a wart, and the translation below is exactly the size of that wart.
//
// FOUR THINGS THE TWO DIALECTS DO NOT AGREE ABOUT, each handled explicitly and each tested:
//
//   · CACHE BREAKPOINTS. Anthropic takes an explicit `cache_control` marker; OpenAI's prompt cache
//     is automatic and prefix-based with no marker to send. The markers are DROPPED. The discipline
//     that put the stable system prompt and tool definitions first still pays off - an automatic
//     prefix cache rewards exactly the same ordering - but there is no breakpoint to honour, and
//     `cacheCreationInputTokens` therefore has no counterpart and is reported as 0 rather than
//     invented.
//   · TOOL RESULTS. Anthropic returns them as blocks inside ONE user message; OpenAI wants one
//     `role: "tool"` message per result. One user message with three results becomes three
//     messages, in order.
//   · `is_error`. Anthropic has a flag; Chat Completions has no field for it, so a refused tool
//     call is rendered into the message text with an explicit prefix. The model must be able to
//     tell "the tool ran and said no" from "the tool ran and said yes", and on this provider the
//     only channel for that is the text.
//   · THINKING BLOCKS. Anthropic's signed reasoning has no counterpart and cannot be forwarded.
//     They are dropped, and a run through this adapter therefore does not carry reasoning across
//     turns the way an Anthropic run does. Said out loud because it is a behavioural difference
//     between the two providers, not an implementation detail.
//
// NOTE FOR ANY AGENT OR CI JOB READING THIS: constructing this object performs no request. Calling
// `turn` on it with a real `fetch` and a real key DOES, and it is billed. BRIEF section 11 forbids
// that outside an explicitly approved run. Every test in this package injects a `fetch` that
// answers from a fixture.

import type Anthropic from "@anthropic-ai/sdk";
import {
  type AssistantBlock,
  type DiscoveryModel,
  DiscoveryModelError,
  type ModelTurnRequest,
  type ModelTurnResponse,
  type ModelUsage,
  type StrictTool,
} from "../model-port.js";

// ---------------------------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------------------------

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** BRIEF section 9's sibling requirement on this side: one action per turn. */
export interface OpenAIFunctionTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    /** The tool's JSON Schema, forwarded unchanged from `DISCOVERY_TOOLS`. */
    readonly parameters: unknown;
    /**
     * Strict function calling. Requires `additionalProperties: false` and every property listed in
     * `required`, with optional values spelled as a nullable type - which is exactly what
     * `tools.ts` already emits, because Anthropic's strict tool use requires the same three things.
     * The schemas cross unchanged; `test/openai-adapter.test.ts` asserts that rather than assuming
     * it, because it is the kind of coincidence that stops being true quietly.
     */
    readonly strict: true;
  };
}

export type OpenAIMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly OpenAIToolCall[];
    }
  | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

export interface OpenAIToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface OpenAIRequestBody {
  readonly model: string;
  readonly messages: readonly OpenAIMessage[];
  readonly tools: readonly OpenAIFunctionTool[];
  readonly tool_choice: "auto";
  /**
   * The single most consequential line in the file, and the mirror of the Anthropic adapter's
   * `disable_parallel_tool_use`. A computer-use loop must observe the consequence of each action
   * before choosing the next; interleaved actions make the recorded step order meaningless, and the
   * recorded step order IS the artifact. The loop enforces it a second time on our side, because a
   * provider-side flag is a request, not a guarantee.
   */
  readonly parallel_tool_calls: false;
  readonly max_completion_tokens: number;
}

/** The subset of a Chat Completion this adapter reads. Written out rather than imported because
 *  there is no SDK here to import it from, and because a narrow declaration is the documentation
 *  of what we actually depend on. */
export interface OpenAIChatCompletion {
  readonly choices: readonly {
    readonly message: {
      readonly content?: string | null;
      readonly tool_calls?: readonly OpenAIToolCall[] | null;
      readonly refusal?: string | null;
    };
    readonly finish_reason: string | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number } | null;
  } | null;
}

// ---------------------------------------------------------------------------------------------
// Request translation - pure, and never a network call
// ---------------------------------------------------------------------------------------------

/** The prefix an `is_error: true` tool result carries on this provider. See the file header. */
export const OPENAI_TOOL_ERROR_PREFIX = "TOOL CALL REFUSED: ";

/**
 * System blocks become one `system` message.
 *
 * Joined rather than sent as several messages: multiple leading system messages are accepted but
 * their treatment is not specified anywhere we can point at, and a prompt whose behaviour depends
 * on an unspecified detail is a prompt that changes under us. The `cache_control` markers are
 * dropped - there is nothing on this API to receive them.
 */
export function toOpenAISystemMessage(system: readonly Anthropic.TextBlockParam[]): OpenAIMessage {
  return { role: "system", content: system.map((block) => block.text).join("\n\n") };
}

export function toOpenAITools(tools: readonly StrictTool[]): readonly OpenAIFunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.input_schema,
      strict: true,
    },
  }));
}

const textOfContent = (content: string | readonly Anthropic.ContentBlockParam[]): string =>
  typeof content === "string"
    ? content
    : content
        .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
        .map((b) => b.text)
        .join("\n");

/**
 * One Anthropic message becomes one or more OpenAI messages.
 *
 * Returns an array because the mapping genuinely is not one to one: a user message carrying three
 * tool results is three `role: "tool"` messages here. Every unhandled block type throws rather than
 * being filtered, because a silently dropped block is a conversation the provider saw and our
 * transcript did not.
 */
export function toOpenAIMessages(
  messages: readonly Anthropic.MessageParam[],
): readonly OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push(
        message.role === "assistant"
          ? { role: "assistant", content: message.content }
          : { role: "user", content: message.content },
      );
      continue;
    }

    const blocks = message.content;
    const toolResults = blocks.filter(
      (b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result",
    );

    if (message.role === "user") {
      const text = textOfContent(blocks);
      if (text.length > 0) out.push({ role: "user", content: text });
      for (const result of toolResults) {
        const body =
          typeof result.content === "string" ? result.content : textOfContent(result.content ?? []);
        out.push({
          role: "tool",
          tool_call_id: result.tool_use_id,
          // There is no `is_error` on this API. The distinction has to survive in the text or the
          // model cannot tell a refusal from a result.
          content: result.is_error === true ? `${OPENAI_TOOL_ERROR_PREFIX}${body}` : body,
        });
      }
      for (const block of blocks) {
        if (block.type === "text" || block.type === "tool_result") continue;
        throw new DiscoveryModelError(
          "openai",
          `a "${block.type}" block in a user message has no Chat Completions counterpart; this loop sends only text and tool_result`,
        );
      }
      continue;
    }

    const toolCalls: OpenAIToolCall[] = [];
    let text = "";
    for (const block of blocks) {
      switch (block.type) {
        case "text":
          text = text.length === 0 ? block.text : `${text}\n${block.text}`;
          break;
        case "tool_use":
          toolCalls.push({
            id: block.id,
            type: "function",
            // Arguments travel as a JSON STRING here, not as an object. `JSON.stringify` of the
            // same input the loop already validated, so the round trip is lossless for anything
            // the tool schemas admit.
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
          break;
        case "thinking":
        case "redacted_thinking":
          // Dropped, deliberately. Signed reasoning is Anthropic's; there is no field here that
          // could carry it and re-sending the prose as assistant text would be presenting one
          // provider's reasoning as another's. See the file header - this is a behavioural
          // difference between the two adapters, not a detail.
          break;
        default:
          throw new DiscoveryModelError(
            "openai",
            `a "${block.type}" block in an assistant message has no Chat Completions counterpart`,
          );
      }
    }
    out.push({
      role: "assistant",
      content: text.length === 0 ? null : text,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    });
  }

  return out;
}

export function buildOpenAIRequestBody(
  request: ModelTurnRequest,
  options: { readonly modelId: string; readonly maxTokens: number },
): OpenAIRequestBody {
  return {
    model: options.modelId,
    // System first, and the tools with it: this API has no cache breakpoint, but its prompt cache
    // is prefix-based, so the ordering that earns a hit is the same ordering BRIEF section 9 asks
    // for on the other provider. Same discipline, no marker.
    messages: [toOpenAISystemMessage(request.system), ...toOpenAIMessages(request.messages)],
    tools: toOpenAITools(request.tools),
    tool_choice: "auto",
    parallel_tool_calls: false,
    max_completion_tokens: options.maxTokens,
  };
}

// ---------------------------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------------------------

/**
 * `finish_reason` to the port's `stopReason`.
 *
 * An unknown value THROWS rather than defaulting to `end_turn`. The loop treats `end_turn` with no
 * tool call as "the model stopped talking to the machinery" and records that as its stopping
 * condition, so mapping an unrecognised reason onto it would put a wrong, confident cause into the
 * evidence for a run that ended for a reason nobody has read yet.
 */
export function toStopReason(finishReason: string | null): Anthropic.StopReason | null {
  switch (finishReason) {
    case null:
      return null;
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      throw new DiscoveryModelError(
        "openai",
        `the provider returned finish_reason "${finishReason}", which this adapter does not have a mapping for`,
      );
  }
}

/**
 * Token accounting, and the one place a careless mapping would silently produce a wrong number in
 * the evidence bundle.
 *
 * The two providers count the same thing differently: Anthropic's `input_tokens` EXCLUDES what came
 * from the cache and reports cache reads separately, while OpenAI's `prompt_tokens` INCLUDES
 * `prompt_tokens_details.cached_tokens`. `cacheHitRate` divides the cache reads by
 * `inputTokens + cacheCreationInputTokens + cacheReadInputTokens`, so forwarding `prompt_tokens`
 * unchanged would count the cached tokens twice in the denominator and UNDERSTATE the hit rate -
 * a number that looks plausible, is wrong, and would end up in a README. The subtraction is the fix
 * and `test/openai-adapter.test.ts` pins the arithmetic.
 *
 * `cacheCreationInputTokens` is 0 because this API has no cache-write billing line, not because
 * nothing was written. Reporting 0 for "we do not measure this" rather than guessing is the same
 * rule the scripted model follows.
 */
export function toModelUsage(usage: OpenAIChatCompletion["usage"]): ModelUsage {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: usage?.completion_tokens ?? 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cached,
  };
}

/** The assistant blocks the port accepts, rebuilt from one choice. */
export function toAssistantBlocks(
  message: OpenAIChatCompletion["choices"][number]["message"],
): readonly AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  const text = message.content ?? "";
  if (text.length > 0) blocks.push({ type: "text", text, citations: null });

  for (const call of message.tool_calls ?? []) {
    if (call.type !== "function") {
      throw new DiscoveryModelError(
        "openai",
        `the response contained a "${call.type}" tool call; this loop declares only the five function tools in tools.ts`,
      );
    }
    let input: unknown;
    try {
      // Arguments arrive as a JSON string. A model that emits invalid JSON under strict function
      // calling is a fact about the request, not a tool call we can dispatch - and the loop's zod
      // parsers expect an object, so failing here names the real cause.
      input = call.function.arguments === "" ? {} : JSON.parse(call.function.arguments);
    } catch (cause) {
      throw new DiscoveryModelError(
        "openai",
        `the model's arguments for "${call.function.name}" were not valid JSON`,
        { cause },
      );
    }
    blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }

  return blocks;
}

// ---------------------------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------------------------

/** The one capability this adapter needs from the outside world. Declared narrowly so a test can
 *  satisfy it with a three-line function and so nothing here can reach anything else. */
export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}>;

export interface OpenAIAdapterOptions {
  /**
   * REQUIRED, via this option or `CRR_OPENAI_MODEL`. There is deliberately no default.
   *
   * BRIEF section 9 forbids writing a model id from memory, and the `claude-api` skill that supplies
   * them for the other provider has no counterpart here. A default written from a stale prior would
   * be a fact this repository cannot source - and unlike most wrong defaults, this one selects what
   * the author's card is charged for. Refusing to guess is the only defensible option.
   */
  readonly modelId?: string;
  readonly maxTokens?: number;
  readonly baseUrl?: string;
  /** Injected so a test can prove the no-key path without touching the real environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected so nothing in a test can reach a network by accident. Defaults to global `fetch`. */
  readonly fetch?: FetchLike;
}

export const OPENAI_DEFAULT_MAX_TOKENS = 16000;

export function createOpenAIModel(options: OpenAIAdapterOptions = {}): DiscoveryModel {
  const env = options.env ?? process.env;
  const modelId = options.modelId ?? env.CRR_OPENAI_MODEL;
  if (modelId === undefined || modelId === "") {
    throw new DiscoveryModelError(
      "openai",
      "no OpenAI model id was given. Set CRR_OPENAI_MODEL or pass { modelId }. This adapter ships no " +
        "default on purpose: a model id written from memory is a fact this repository cannot source, " +
        "and it is the field that decides what a run costs.",
    );
  }
  const maxTokens = options.maxTokens ?? OPENAI_DEFAULT_MAX_TOKENS;
  const baseUrl = (options.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, "");

  // Resolved at construction, so a missing key fails before a request is built rather than as a 401
  // halfway through a run.
  //
  // An INJECTED `fetch` waives the key requirement, and that is the seam BRIEF section 11 rests on:
  // a caller that supplied its own transport is by definition not reaching a provider, so demanding
  // a credential would only push every test into setting a fake one - which is how a real key ends
  // up in a test environment.
  const apiKey = env.OPENAI_API_KEY ?? "";
  const transport = options.fetch;
  if (transport === undefined && apiKey === "") {
    throw new DiscoveryModelError(
      "openai",
      "OPENAI_API_KEY is not set. The openai adapter reaches a live provider; to run the loop with " +
        "no credentials, use createReplayModel() with a recorded transcript, or inject a fetch.",
    );
  }
  const doFetch = transport ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (doFetch === undefined) {
    throw new DiscoveryModelError("openai", "no fetch implementation is available");
  }

  return {
    adapter: "openai",
    modelId,

    async turn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
      const body = buildOpenAIRequestBody(request, { modelId, maxTokens });

      let raw: string;
      let status: number;
      let ok: boolean;
      try {
        const response = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });
        ok = response.ok;
        status = response.status;
        raw = await response.text();
      } catch (cause) {
        throw new DiscoveryModelError("openai", "the request failed before a response arrived", {
          cause,
        });
      }

      if (!ok) {
        // Separated by class the way the Anthropic adapter separates its typed errors, because the
        // two mean opposite things to whoever reads the failure: one is "wait", the other is "the
        // request you are building is wrong", and reporting the first when it is the second wastes
        // an afternoon.
        const detail = raw.slice(0, 500);
        if (status === 429) {
          throw new DiscoveryModelError("openai", `rate limited by the provider: ${detail}`);
        }
        if (status >= 400 && status < 500) {
          throw new DiscoveryModelError(
            "openai",
            `the provider rejected the request body (${status}): ${detail}`,
          );
        }
        throw new DiscoveryModelError("openai", `provider error ${status}: ${detail}`);
      }

      let parsed: OpenAIChatCompletion;
      try {
        parsed = JSON.parse(raw) as OpenAIChatCompletion;
      } catch (cause) {
        throw new DiscoveryModelError("openai", "the provider returned a body that is not JSON", {
          cause,
        });
      }

      const choice = parsed.choices?.[0];
      if (choice === undefined) {
        throw new DiscoveryModelError("openai", "the provider returned no choices");
      }
      if (typeof choice.message.refusal === "string" && choice.message.refusal.length > 0) {
        // A refusal is a fact about OUR machinery's request, never a business outcome. It throws,
        // for the same reason `DiscoveryModelError` exists at all: a value the loop could mistake
        // for a result is the one thing this system must not produce.
        throw new DiscoveryModelError(
          "openai",
          `the model refused the request: ${choice.message.refusal}`,
        );
      }

      return {
        stopReason: toStopReason(choice.finish_reason),
        content: toAssistantBlocks(choice.message),
        usage: toModelUsage(parsed.usage),
      };
    },
  };
}
