// A hand-authored model, for building VCR fixtures and for exercising the loop's stopping
// conditions without a provider.
//
// It ships in `src/` rather than in a test folder for the same reason `MockSurface` does in
// `@crr/core`: the fixture builder, this package's tests and (later) the conformance suite all need
// it, and a double that cannot cross a package boundary is a double that gets copied.
//
// THE HONESTY RULE THIS FILE IMPLEMENTS. A scripted run consumed no tokens, so it reports NONE.
// Every `ModelUsage` it returns is zero unless the script author wrote a number in by hand, and a
// transcript recorded through it is marked `synthetic: true` by `createRecordingModel`. That means
// a synthetic fixture's cache hit rate is 0 and can never be mistaken for a measurement - which is
// the only defensible default, because a plausible-looking invented token count is exactly the kind
// of thing that ends up quoted in a README as if somebody had measured it.

import {
  type AssistantBlock,
  type DiscoveryModel,
  DiscoveryModelError,
  type ModelTurnRequest,
  type ModelTurnResponse,
  type ModelUsage,
  ZERO_USAGE,
} from "./model-port.js";

export interface ScriptedToolUse {
  readonly name: string;
  readonly input: unknown;
  /** Defaults to a deterministic `toolu_scripted_<turn>_<n>`, so a fixture rebuild is stable. */
  readonly id?: string;
}

export interface ScriptedTurn {
  /** Optional prose, the way a real assistant turn usually opens. */
  readonly text?: string;
  /** Zero or more tool calls. More than one is how a test exercises the loop's own
   *  one-action-per-turn enforcement without needing a provider that ignores the flag. */
  readonly toolUses?: readonly ScriptedToolUse[];
  readonly stopReason?: ModelTurnResponse["stopReason"];
  /** Only set this if the number came from somewhere real. See the header. */
  readonly usage?: ModelUsage;
}

export interface ScriptedModelOptions {
  /** What the fixture claims to stand in for. Recorded as `provenance.modelId`, and deliberately
   *  prefixed so nobody reads it as a model id that exists. */
  readonly modelId?: string;
}

/**
 * A model that reads from a list.
 *
 * It ignores the request entirely - which is the correct behaviour for a script and is also why a
 * transcript recorded through it still catches prompt regressions later: the RECORDER stores the
 * digest of what the loop actually built, so the fixture pins the real prompt even though the
 * scripted model never looked at it.
 */
export function createScriptedModel(
  script: readonly ScriptedTurn[],
  options: ScriptedModelOptions = {},
): DiscoveryModel {
  let index = 0;
  return {
    adapter: "scripted",
    modelId: options.modelId ?? "synthetic-script",

    async turn(_request: ModelTurnRequest): Promise<ModelTurnResponse> {
      const turn = script[index];
      if (turn === undefined) {
        throw new DiscoveryModelError(
          "scripted",
          `the loop asked for turn ${index + 1} and the script has ${script.length}; the loop went further than the script anticipated`,
        );
      }
      index += 1;

      const content: AssistantBlock[] = [];
      if (turn.text !== undefined) {
        content.push({ type: "text", text: turn.text, citations: null });
      }
      (turn.toolUses ?? []).forEach((use, nth) => {
        content.push({
          type: "tool_use",
          id: use.id ?? `toolu_scripted_${index}_${nth + 1}`,
          name: use.name,
          input: use.input,
        });
      });

      return {
        stopReason:
          turn.stopReason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
        content,
        usage: turn.usage ?? ZERO_USAGE,
      };
    },
  };
}
