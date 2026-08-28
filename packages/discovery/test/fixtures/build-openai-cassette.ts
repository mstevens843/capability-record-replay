// Builds the SYNTHETIC OpenAI HTTP CASSETTE, and the `fetch` that plays it back.
//
// READ THIS BEFORE USING ANYTHING THIS FILE PRODUCES.
//
// The model's side of these exchanges was WRITTEN BY HAND - it is the same `SCRIPT` the Anthropic
// side uses, mechanically translated into the Chat Completions response shape. No model produced
// it, no provider was called, and no tokens were spent, which is why the usage figures are what a
// hand-written script can honestly claim. It is marked `synthetic: true` in the file itself and it
// IS NOT EVIDENCE OF A DISCOVERY RUN (BRIEF section 10).
//
// WHY A SECOND CASSETTE AT ALL, WHEN THE VCR ALREADY EXISTS.
//
// `Transcript` records the PORT - `ModelTurnRequest` in, `ModelTurnResponse` out - which is exactly
// the right level for replaying a conversation and exactly the wrong level for testing an adapter,
// because an adapter's whole job is the translation on either side of that port. A port-level
// fixture would replay straight past every line of `adapters/openai.ts`.
//
// So this cassette sits one layer lower, at the HTTP boundary: it stores the response bodies the
// provider would have returned, serves them through the injected `fetch`, and RECORDS THE REQUEST
// BODIES THE ADAPTER BUILT so a test can assert on the bytes we would have put on the wire. The
// same run then also produces a port-level `Transcript`, so the VCR is shown to work through this
// adapter as well as through the other one.
//
// A note on what the cassette does NOT pin. It replays by turn index and does not require the
// request to match what was recorded, because an HTTP-level digest check would duplicate the
// port-level one the `Transcript` already performs - and the port-level check is the better of the
// two, since it is the one that catches a prompt regression regardless of which provider is in
// front of it. What this file adds is the translation, and `openai-adapter.test.ts` asserts that
// directly against the recorded request bodies.

import type { OpenAIChatCompletion, OpenAIRequestBody, ScriptedTurn } from "../../src/index.js";
import { SCRIPT } from "./build-transcript.js";

/** The model id the cassette was recorded against. Obviously not a real one: this cassette was
 *  never played against a provider, and a plausible id here would invite exactly that mistake. */
export const CASSETTE_MODEL_ID = "synthetic-openai-script";

export const CASSETTE_FILE = "corebank-member-lookup.synthetic.openai.cassette.json";

export interface CassetteExchange {
  readonly turn: number;
  /** The Chat Completion body the provider would have returned. */
  readonly response: OpenAIChatCompletion;
}

export interface Cassette {
  readonly version: 1;
  readonly synthetic: true;
  readonly provenance: {
    readonly adapter: "openai";
    readonly api: "chat.completions";
    readonly modelId: string;
    readonly note: string;
  };
  readonly exchanges: readonly CassetteExchange[];
}

/**
 * One scripted turn, in the Chat Completions response shape.
 *
 * Derived from the SAME script the Anthropic-side fixture uses, on purpose: a cassette written
 * independently could drift into testing a different conversation, and then "the same loop completes
 * against a second provider" would be true of two different loops. Translating one script is what
 * makes the cross-provider comparison in `openai-adapter.test.ts` mean anything.
 */
function toCompletion(turn: ScriptedTurn, index: number): OpenAIChatCompletion {
  const toolCalls = (turn.toolUses ?? []).map((use, nth) => ({
    id: use.id ?? `call_scripted_${index + 1}_${nth + 1}`,
    type: "function" as const,
    // The wire carries arguments as a JSON STRING, which is the single most consequential shape
    // difference between the two providers' tool calls.
    function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) },
  }));
  return {
    choices: [
      {
        message: {
          content: turn.text ?? null,
          ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
          refusal: null,
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    // Zero, like the scripted model's. A hand-written script consumed no tokens and must not report
    // any: a plausible-looking invented count is exactly how a fabricated number ends up quoted.
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}

export function buildCassette(script: readonly ScriptedTurn[] = SCRIPT): Cassette {
  return {
    version: 1,
    synthetic: true,
    provenance: {
      adapter: "openai",
      api: "chat.completions",
      modelId: CASSETTE_MODEL_ID,
      note:
        "SYNTHETIC. Translated by hand from the assistant turns in " +
        "packages/discovery/test/fixtures/build-transcript.ts into the Chat Completions response " +
        "shape. No model produced it and no provider was called, which is why every token count is " +
        "zero. It exists so the discovery loop can be driven through the openai adapter with no " +
        "credentials. It is NOT evidence of a discovery run.",
    },
    exchanges: script.map((turn, index) => ({
      turn: index + 1,
      response: toCompletion(turn, index),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------------------------

export interface CassettePlayer {
  /** Hand this to `createOpenAIModel({ fetch })`. It has no socket and cannot acquire one. */
  readonly fetch: (
    url: string,
    init: {
      readonly method: string;
      readonly headers: Record<string, string>;
      readonly body: string;
    },
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  /** The request bodies the adapter built, in order. The point of the whole file. */
  readonly requests: readonly OpenAIRequestBody[];
  readonly urls: readonly string[];
  readonly headers: readonly Record<string, string>[];
}

/**
 * Play a cassette back.
 *
 * Running past the end THROWS rather than returning a 500, and the distinction matters: a fixture
 * that runs out means the loop got further this time than the run that was recorded, which is a
 * fact about our code and must not be delivered to it disguised as a provider outage the loop might
 * then try to recover from.
 */
export function playCassette(cassette: Cassette): CassettePlayer {
  const requests: OpenAIRequestBody[] = [];
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  let index = 0;

  return {
    requests,
    urls,
    headers,
    async fetch(url, init) {
      const exchange = cassette.exchanges[index];
      if (exchange === undefined) {
        throw new Error(
          `the loop asked for turn ${index + 1} and the cassette has ${cassette.exchanges.length}; the loop got further this time than the run that was recorded`,
        );
      }
      index += 1;
      urls.push(url);
      headers.push(init.headers);
      requests.push(JSON.parse(init.body) as OpenAIRequestBody);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(exchange.response),
      };
    },
  };
}
