// SPEC section 6.5 - the VCR.
//
// Every run through ANY adapter records its full transcript; the `replay` adapter serves one back
// deterministically. BRIEF section 10 calls this load-bearing and it is: it makes `pnpm test` pass
// with no credentials, it makes the loop exercisable hundreds of times during development at zero
// marginal cost, and it turns "the prompt changed" from something you find out on a live run into
// a red test.
//
// FOUR DECISIONS IN THE FILE FORMAT, EACH OF WHICH IS THE ANSWER TO A REAL PROBLEM.
//
// 1. THE STABLE PREFIX IS STORED ONCE. The system prompt and the tool definitions are byte
//    identical on every turn - that is the entire point of the cache breakpoint - so storing them
//    per turn would multiply the fixture by the turn count for no information. They are stored
//    once, with a digest, and every turn is checked against that digest.
//
// 2. TURNS STORE WHAT WAS APPENDED, NOT THE WHOLE HISTORY. A ten-turn run's tenth request contains
//    the previous nine, so storing full histories is quadratic in a file a human is meant to read
//    in a diff. Each turn stores the messages appended since the previous one, plus a digest of
//    the FULL history it was sent with. Replay rebuilds the history and compares the digest, which
//    is strictly stronger than storing it: it proves the loop reconstructed the same conversation
//    rather than merely that the bytes were on disk.
//
// 3. A MISMATCH IS AN ERROR, NOT A FALLBACK. If the reconstructed history does not match, the
//    replay adapter throws. That is the prompt/tool-schema regression detector SPEC section 6.5
//    asks for, and it only works if it is fatal - a VCR that shrugs and serves the next response
//    anyway is a VCR that certifies a prompt nobody has ever sent.
//
// 4. PROVENANCE IS A REQUIRED FIELD AND `synthetic` IS A BOOLEAN. BRIEF section 10: a transcript
//    replayed from a fixture is never presented as a live model run. A hand-authored fixture must
//    say so in the file, not in a README somebody may not have read, and `assertRealRecording`
//    exists so the evidence bundler can refuse a synthetic one by construction.

import type Anthropic from "@anthropic-ai/sdk";
import { type Digest, DigestSchema, TimestampSchema, digestOf, redactDeep } from "@crr/core";
import type { DeepReadonly } from "@crr/core";
import { z } from "zod";
import {
  DISCOVERY_ADAPTERS,
  type DiscoveryAdapterName,
  type DiscoveryModel,
  DiscoveryModelError,
  type ModelTurnRequest,
  type ModelTurnResponse,
  type ModelUsage,
  ZERO_USAGE,
  addUsage,
  cacheHitRate,
} from "./model-port.js";
import { TOOL_NAMES } from "./tools.js";

// ---------------------------------------------------------------------------------------------
// Wire shapes
//
// These validate a FILE, not the SDK. A transcript is read back off disk months later, possibly
// hand-edited, and possibly written by a version of this loop that no longer exists; the SDK's
// types say nothing at runtime about any of that. The subset is the same one `AssistantBlock`
// names, because a block outside it means the request was not the request we think we sent.
// ---------------------------------------------------------------------------------------------

/**
 * A text block as it comes BACK from a provider. `citations` is carried because the SDK's
 * `TextBlock` requires the field, and dropping it here would make a replayed block fail to satisfy
 * the type the adapter returns. We declare no citable documents, so in practice it is always null -
 * which is why it defaults, letting a hand-written fixture omit the noise.
 */
const ResponseTextBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
  citations: z.array(z.unknown()).nullable().default(null),
});

/** A text block as it goes OUT in a message. `toParamBlocks` never emits citations, so a citation
 *  appearing here would mean the history no longer matches what was sent. */
const TextBlockSchema = z.strictObject({ type: z.literal("text"), text: z.string() });
// The three blocks below are LOOSE, and the ones we author stay STRICT. That asymmetry is the
// point: we own the shape of our own documents and may forbid a stray key in them, but we do not
// own the provider's response schema and cannot forbid it growing a field.
//
// Found on the second live run: Anthropic returned a `tool_use` block carrying a `caller` key
// (programmatic tool calling) and `z.strictObject` rejected it AFTER the turn had been paid for.
// Strict-validating someone else's schema converts their additive, backwards-compatible change
// into our outage - and it fails on a path where the money is already spent. Unknown keys are
// recorded as they arrived; the redaction canary greps the bundle either way, so tolerating a new
// field does not weaken the data-handling claim.
const ThinkingBlockSchema = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string(),
});
const RedactedThinkingBlockSchema = z.looseObject({
  type: z.literal("redacted_thinking"),
  data: z.string(),
});
const ToolUseBlockSchema = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});
const ToolResultBlockSchema = z.strictObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  content: z.string(),
  is_error: z.boolean().optional(),
});

/** What may appear in an assistant block on the way back. */
export const AssistantBlockSchema = z.discriminatedUnion("type", [
  ResponseTextBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ToolUseBlockSchema,
]);

/** What may appear in a message on the way out. Adds `tool_result`, which only we produce. */
const MessageBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
]);

const MessageSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  content: z.union([z.string(), z.array(MessageBlockSchema)]),
});

const SystemBlockSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
  cache_control: z
    .strictObject({ type: z.literal("ephemeral") })
    .nullable()
    .optional(),
});

export const TranscriptUsageSchema = z.strictObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheCreationInputTokens: z.int().nonnegative(),
  cacheReadInputTokens: z.int().nonnegative(),
});

export const TranscriptTurnSchema = z.strictObject({
  index: z.int().positive(),
  /** The messages appended since the previous turn. Turn 1 carries the whole opening history. */
  appended: z.array(MessageSchema).readonly(),
  /** Digest of the FULL message array this turn was sent with. The regression detector. */
  messagesDigest: DigestSchema,
  response: z.strictObject({
    stopReason: z.string().max(64).nullable(),
    content: z.array(AssistantBlockSchema).readonly(),
    usage: TranscriptUsageSchema,
  }),
  latencyMs: z.int().nonnegative(),
});
export type TranscriptTurn = DeepReadonly<z.infer<typeof TranscriptTurnSchema>>;

export const TranscriptToolCallSchema = z.strictObject({
  turn: z.int().positive(),
  toolUseId: z.string().min(1).max(128),
  name: z.string().max(64),
  /** Redacted: `redactDeep` has already replaced every bound value with its opaque handle. */
  input: z.unknown(),
  outcome: z.enum(["ok", "refused"]),
  detail: z.string().max(1000),
  latencyMs: z.int().nonnegative(),
});
export type TranscriptToolCall = DeepReadonly<z.infer<typeof TranscriptToolCallSchema>>;

export const TranscriptSchema = z.strictObject({
  version: z.literal(1),
  /**
   * TRUE means the model's side of this conversation was written by a person, not produced by a
   * model. BRIEF section 10 forbids presenting such a file as evidence of a discovery run, and a
   * flag in the file is the only form of that rule that survives being copied into a directory.
   */
  synthetic: z.boolean(),
  provenance: z.strictObject({
    adapter: z.enum(DISCOVERY_ADAPTERS),
    modelId: z.string().min(1).max(128),
    recordedAt: TimestampSchema.nullable(),
    /** One line a human wrote about where this came from. Required, and required to be non-empty:
     *  an optional provenance note is a provenance note that is empty on the file that matters. */
    note: z.string().min(1).max(2000),
  }),
  prefix: z.strictObject({
    system: z.array(SystemBlockSchema).readonly(),
    tools: z.array(z.unknown()).readonly(),
    digest: DigestSchema,
  }),
  turns: z.array(TranscriptTurnSchema).readonly(),
  toolCalls: z.array(TranscriptToolCallSchema).readonly(),
  usage: TranscriptUsageSchema,
  /** Stored rather than derived so a reader of the file sees the number without doing arithmetic,
   *  and `parseTranscript` re-derives it and refuses a file where the two disagree. */
  cacheHitRate: z.number().min(0).max(1),
});
export type Transcript = DeepReadonly<z.infer<typeof TranscriptSchema>>;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export class TranscriptMismatchError extends Error {
  override readonly name = "TranscriptMismatchError";
  readonly turn: number;

  constructor(turn: number, message: string) {
    super(message);
    this.turn = turn;
  }
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/** Parse and re-check. The stored `cacheHitRate` is recomputed rather than trusted: it is the one
 *  number in the file a reader is likely to quote, and a hand-edited fixture is exactly how a
 *  quoted number stops matching the run it came from. */
export function parseTranscript(value: unknown): Transcript {
  const transcript = TranscriptSchema.parse(value) as Transcript;
  const derived = cacheHitRate(transcript.usage);
  if (Math.abs(derived - transcript.cacheHitRate) > 1e-9) {
    throw new TranscriptMismatchError(
      0,
      `the file states a cache hit rate of ${transcript.cacheHitRate} and its own token counts give ${derived}`,
    );
  }
  return transcript;
}

/**
 * Refuse a transcript that may not be used as evidence of a discovery run.
 *
 * Called by anything that writes into `/evidence/`. BRIEF section 10 states the rule three
 * different ways; this is the one that executes.
 */
export function assertRealRecording(transcript: Transcript): void {
  if (transcript.synthetic) {
    throw new DiscoveryModelError(
      "replay",
      "this transcript is marked synthetic: its model turns were authored by hand, so it is not evidence of a discovery run",
    );
  }
  if (transcript.provenance.adapter === "replay" || transcript.provenance.adapter === "scripted") {
    throw new DiscoveryModelError(
      transcript.provenance.adapter,
      `a transcript recorded through the "${transcript.provenance.adapter}" adapter is a replay of a recording, not a model run`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------------------------

/** The digest a turn is matched on. Taken over the FULL message history as sent. */
export function messagesDigestOf(messages: readonly Anthropic.MessageParam[]): Digest {
  return digestOf(redactDeep(messages));
}

/** The digest of the cacheable prefix: system blocks plus tool definitions, exactly as sent. */
export function prefixDigestOf(request: ModelTurnRequest): Digest {
  return digestOf({ system: request.system, tools: request.tools });
}

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

export interface RecorderOptions {
  /** Injected so a fixture build is byte-reproducible. Defaults to the wall clock. */
  readonly nowMs?: () => number;
  readonly recordedAt?: string | null;
  readonly synthetic?: boolean;
  readonly note: string;
}

export interface RecordingModel extends DiscoveryModel {
  /** The transcript so far. Safe to call mid-run; the loop calls it once at the end. */
  transcript(): Transcript;
  /** Called by the loop after it has dispatched a tool call, so the file records what OUR side of
   *  the conversation did with the model's request - which is half of what makes a transcript
   *  worth reading when a run went wrong. */
  recordToolCall(call: {
    readonly turn: number;
    readonly toolUseId: string;
    readonly name: string;
    readonly input: unknown;
    readonly outcome: "ok" | "refused";
    readonly detail: string;
    readonly latencyMs: number;
  }): void;
}

/**
 * Wrap any adapter so that every turn through it is recorded.
 *
 * Wrapping rather than building the recorder into each adapter is what makes SPEC section 6.5's
 * "every run through ANY adapter records" true by construction instead of by three copies of the
 * same code that drift.
 */
export function createRecordingModel(
  inner: DiscoveryModel,
  options: RecorderOptions,
): RecordingModel {
  const nowMs = options.nowMs ?? (() => Date.now());
  const turns: TranscriptTurn[] = [];
  const toolCalls: TranscriptToolCall[] = [];
  let prefix: Transcript["prefix"] | null = null;
  let previousMessageCount = 0;
  let usage: ModelUsage = ZERO_USAGE;

  return {
    adapter: inner.adapter,
    modelId: inner.modelId,

    async turn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
      if (prefix === null) {
        prefix = {
          system: SystemBlockSchema.array().parse(request.system) as Transcript["prefix"]["system"],
          tools: request.tools as readonly unknown[],
          digest: prefixDigestOf(request),
        };
      }

      const started = nowMs();
      const response = await inner.turn(request);
      const latencyMs = Math.max(0, Math.round(nowMs() - started));

      const appended = request.messages.slice(previousMessageCount);
      previousMessageCount = request.messages.length;
      usage = addUsage(usage, response.usage);

      turns.push(
        TranscriptTurnSchema.parse({
          index: turns.length + 1,
          appended: redactDeep(appended),
          messagesDigest: messagesDigestOf(request.messages),
          response: {
            stopReason: response.stopReason,
            content: redactDeep(response.content),
            usage: response.usage,
          },
          latencyMs,
        }) as TranscriptTurn,
      );

      return response;
    },

    recordToolCall(call) {
      toolCalls.push(
        TranscriptToolCallSchema.parse({
          turn: call.turn,
          toolUseId: call.toolUseId,
          name: call.name,
          input: redactDeep(call.input),
          outcome: call.outcome,
          detail: call.detail,
          latencyMs: call.latencyMs,
        }) as TranscriptToolCall,
      );
    },

    transcript(): Transcript {
      if (prefix === null) {
        throw new DiscoveryModelError(inner.adapter, "nothing was recorded: no turn was taken");
      }
      return TranscriptSchema.parse({
        version: 1,
        synthetic: options.synthetic ?? inner.adapter === "scripted",
        provenance: {
          adapter: inner.adapter,
          modelId: inner.modelId,
          recordedAt: options.recordedAt ?? null,
          note: options.note,
        },
        prefix,
        turns,
        toolCalls,
        usage,
        cacheHitRate: cacheHitRate(usage),
      }) as Transcript;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Replaying
// ---------------------------------------------------------------------------------------------

/**
 * Options for replaying a recorded TRANSCRIPT - not for replaying a capability artifact.
 *
 * The `Transcript` prefix is load-bearing rather than decorative. `@crr/runtime` exports a
 * `ReplayOptions` of its own, and it is the argument to `replay()` - the artifact interpreter that
 * is the whole point of this system. Two different `ReplayOptions` in one workspace is the shape
 * that reads correctly in each file and wrongly in the one place that imports both, so the narrower
 * concept takes the longer name.
 */
export interface TranscriptReplayOptions {
  /**
   * Default `true`. Every turn's reconstructed message history must digest to the recorded value,
   * and the cacheable prefix must digest to the recorded one.
   *
   * Turning it off is for exactly one situation - deliberately re-running an old fixture against a
   * changed prompt to see how far the loop still gets - and it is named `strict: false` rather than
   * `lenient: true` so that switching it off is visible in the call site's diff.
   */
  readonly strict?: boolean;
}

/**
 * The `replay` adapter. No client, no key, no socket.
 *
 * There is nothing in this function that could reach a network even by accident, and that is the
 * property BRIEF section 11 needs: a test suite that runs the entire discovery loop end to end
 * cannot spend the author's money, because the object driving it has no way to.
 */
export function createReplayModel(
  transcript: Transcript,
  options: TranscriptReplayOptions = {},
): DiscoveryModel {
  const strict = options.strict ?? true;
  let index = 0;

  return {
    adapter: "replay",
    modelId: transcript.provenance.modelId,

    async turn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
      const turn = transcript.turns[index];
      if (turn === undefined) {
        throw new TranscriptMismatchError(
          index + 1,
          `the loop asked for turn ${index + 1} and the transcript has ${transcript.turns.length}; the loop got further this time than the run that was recorded`,
        );
      }
      index += 1;

      if (strict) {
        const prefixDigest = prefixDigestOf(request);
        if (prefixDigest !== transcript.prefix.digest) {
          throw new TranscriptMismatchError(
            turn.index,
            `the system prompt or the tool definitions have changed since this transcript was recorded (prefix ${prefixDigest} vs recorded ${transcript.prefix.digest}); re-record it rather than replaying a conversation that was never had`,
          );
        }
        const digest = messagesDigestOf(request.messages);
        if (digest !== turn.messagesDigest) {
          throw new TranscriptMismatchError(
            turn.index,
            `turn ${turn.index} was recorded against a different conversation (${digest} vs recorded ${turn.messagesDigest}); the loop is building a history the recorded model never saw`,
          );
        }
      }

      return {
        stopReason: turn.response.stopReason as ModelTurnResponse["stopReason"],
        content: turn.response.content as ModelTurnResponse["content"],
        usage: turn.response.usage,
      };
    },
  };
}

/** The tool names a transcript exercised, for a test that wants to assert coverage rather than
 *  eyeball a fixture. */
export function toolNamesIn(transcript: Transcript): readonly string[] {
  const seen = new Set<string>();
  for (const call of transcript.toolCalls) {
    if ((TOOL_NAMES as readonly string[]).includes(call.name)) seen.add(call.name);
  }
  return [...seen].sort();
}
