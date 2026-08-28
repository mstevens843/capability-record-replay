// SPEC section 6.1 - the five tools, and the three things the model cannot do because no tool
// exists for them.
//
// The absences are the design. There is no `read_page`, so the model never sees markup. There is
// no `wait`, so the model cannot invent a timeout - waiting is the interpreter's quiescence loop
// and it is declared data, not a model decision. And there is no tool that takes a locator of any
// kind: `act` takes a `nodeRef`, which is an index into the projection the model was just shown
// (SPEC section 6.2), so the model picks from what it saw and deterministic synthesis derives the
// descriptors afterwards. BRIEF section 3.2 is the whole argument and this file is where it is
// either true or not.
//
// Every tool carries `strict: true`, which BRIEF section 9 places at the TOP LEVEL of the tool
// definition (not inside `tool_choice`) and which requires `additionalProperties: false` plus a
// `required` array. We want it: every `act` and `go` input is lowered into an `Action` that goes
// through `PolicyEngine.check`, and a gate is easier to reason about when the thing arriving at it
// has already been validated exactly rather than defensively.
//
// OPTIONAL FIELDS ARE NULLABLE, NOT ABSENT. Under strict tool use every property is listed in
// `required`, so "no value" is spelled `null`. That is why `act.value` is `["string", "null"]` and
// not an omitted key, and it is why the zod parsers below accept `null` rather than `undefined`.

import { ArtifactKeySchema } from "@crr/core";
import { z } from "zod";
import type { StrictTool } from "./model-port.js";

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

export const TOOL_NAMES = ["observe", "act", "go", "note_output", "finish"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** The acting verbs SPEC section 6.1 gives `act`. Deliberately NOT `Action["kind"]`: these are the
 *  intents a person would name, and lowering one onto a driver action (`activate` becomes a click
 *  on a browser and an F-key on a green screen) is the loop's job, not the model's. */
export const TOOL_ACTIONS = ["activate", "fill", "select", "setToggle", "pressKey"] as const;
export type ToolActionName = (typeof TOOL_ACTIONS)[number];

// ---------------------------------------------------------------------------------------------
// Input validators
//
// zod, because the input arrives as `unknown` from the SDK and BRIEF section 9 is explicit that it
// must be parsed rather than string-matched. `strictObject` refuses an extra key, which under
// `strict: true` should be impossible - so if one ever appears, the assumption that strict mode is
// on has stopped being true and we want to hear about it here rather than at the policy gate.
// ---------------------------------------------------------------------------------------------

/** `n<k>`: an index into THIS TURN's observation. Never a NodeId, never stable across turns. */
export const NODE_REF_PATTERN = /^n(0|[1-9][0-9]{0,4})$/;

const nodeRef = z
  .string()
  .regex(NODE_REF_PATTERN, { error: "a nodeRef is n<k>, taken from the list you were just shown" });

/** Human-only prose. Becomes `Step.intent`, which SPEC section 6.4 says no executable path reads. */
const why = z.string().min(1).max(400);

export const ObserveInputSchema = z.strictObject({});
export type ObserveInput = z.infer<typeof ObserveInputSchema>;

export const ActInputSchema = z.strictObject({
  nodeRef,
  action: z.enum(TOOL_ACTIONS),
  value: z.string().max(512).nullable(),
  key: ArtifactKeySchema.nullable(),
  why,
});
export type ActInput = z.infer<typeof ActInputSchema>;

export const GoInputSchema = z.strictObject({
  /** An absolute path. Not a URL: the origin comes from the tenant's target, never from the model,
   *  which is what stops a discovery run from being talked into navigating off the allowlist. */
  routeHint: z.string().min(1).max(512),
  why,
});
export type GoInput = z.infer<typeof GoInputSchema>;

export const NoteOutputInputSchema = z.strictObject({
  nodeRef,
  /** The name the CALLER will see on the typed result. */
  outputName: z
    .string()
    .regex(/^[a-z][A-Za-z0-9_]*$/, { error: "an output name is a lowerCamelCase identifier" })
    .max(64),
  meaning: z.string().min(1).max(400),
});
export type NoteOutputInput = z.infer<typeof NoteOutputInputSchema>;

export const OutcomeCandidateSchema = z.strictObject({
  /** SCREAMING_SNAKE, the vocabulary a contract's `OutcomeDecl` uses. */
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, { error: "an outcome code is SCREAMING_SNAKE_CASE" })
    .max(64),
  title: z.string().min(1).max(200),
  why: z.string().min(1).max(400),
});
export type OutcomeCandidate = z.infer<typeof OutcomeCandidateSchema>;

export const FinishInputSchema = z.strictObject({
  status: z.enum(["reached-goal", "stuck"]),
  summary: z.string().min(1).max(2000),
  outcomeCandidates: z.array(OutcomeCandidateSchema).max(16).nullable(),
});
export type FinishInput = z.infer<typeof FinishInputSchema>;

// ---------------------------------------------------------------------------------------------
// The definitions sent to the provider
// ---------------------------------------------------------------------------------------------

const str = (description: string, extra: Record<string, unknown> = {}) => ({
  type: "string",
  description,
  ...extra,
});

const nullableStr = (description: string, extra: Record<string, unknown> = {}) => ({
  type: ["string", "null"],
  description,
  ...extra,
});

/**
 * The five tools, frozen, in a fixed order.
 *
 * The order and the exact text are part of the cacheable prefix, so they are a REGRESSION SURFACE:
 * `test/tool-schema.test.ts` pins the digest of this array, which means a reworded description is
 * a deliberate diff a reviewer sees rather than a silent cache miss and a silently different prompt
 * on the next live run.
 */
export const DISCOVERY_TOOLS: readonly StrictTool[] = Object.freeze([
  {
    name: "observe",
    description:
      "Look at the current screen. Returns the list of controls and readable values that are " +
      "visible right now, each with a nodeRef you can act on. Call this whenever you are unsure " +
      "what the screen shows, or when the last action reported that the screen had not settled.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "act",
    description:
      "Do one thing to one control on the current screen. Choose nodeRef from the list you were " +
      "most recently shown; a nodeRef from an earlier turn is stale and will be refused. " +
      "activate = press a button or follow a link. fill = replace the text in a field (set value). " +
      "select = choose an option in a dropdown (set value). setToggle = check or uncheck " +
      '(set value to "true" or "false"). pressKey = send a key to the control (set key). ' +
      "Exactly one action per call: you must see what happened before choosing the next one.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        nodeRef: str("The n<k> reference of the control, from the list you were just shown."),
        action: {
          type: "string",
          enum: [...TOOL_ACTIONS],
          description: "What to do to it.",
        },
        value: nullableStr(
          'The text for fill, the option for select, "true"/"false" for setToggle. null otherwise.',
        ),
        // `anyOf`, not `type: ["string", "null"]` with a null in the enum. The latter is valid
        // JSON Schema and is what this was, and the Anthropic API rejects it under `strict: true`:
        //   tools.1.custom: Invalid schema: Enum value 'Enter' does not match declared type
        //   '['string', 'null']'
        // A union `type` array is accepted on its own - `value` below still uses one - but not in
        // combination with an `enum`, because the validator compares each enum member against the
        // array rather than against its members. Found on the first live run (req_011CeUK5RB1g),
        // which no local test could have caught: this shape is only ever judged by the provider.
        key: {
          anyOf: [{ type: "string", enum: [...ArtifactKeySchema.options] }, { type: "null" }],
          description: "The key for pressKey. null otherwise.",
        },
        why: str(
          "One sentence: why this action, in the words a colleague reviewing the recording would need. " +
            "This is kept as the step's intent and is read only by people.",
        ),
      },
      required: ["nodeRef", "action", "value", "key", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "go",
    description:
      "Navigate to a route on the application you were given. Give an absolute path such as " +
      "/members/search - never a full address, and never another application. The path is checked " +
      "against the allowlist before anything happens, and a path that is not on it is refused.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        routeHint: str("An absolute path on the target application, e.g. /members/search."),
        why: str("One sentence: why this route."),
      },
      required: ["routeHint", "why"],
      additionalProperties: false,
    },
  },
  {
    name: "note_output",
    description:
      "Mark a value on the current screen as something the caller of this capability should " +
      "receive back. Use it for the answer the task was asking for, not for scaffolding.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        nodeRef: str("The n<k> reference of the node holding the value."),
        outputName: str("A short lowerCamelCase name for it, e.g. shareBalance."),
        meaning: str("One sentence: what this value is, in business terms."),
      },
      required: ["nodeRef", "outputName", "meaning"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description:
      "End the run. Use reached-goal when the task is done, and stuck when it cannot be done from " +
      "here - being stuck is a useful, honest answer and is far better than guessing. If the " +
      "application reported a definite business answer (no such member, account restricted), list " +
      "it in outcomeCandidates so it can be turned into a typed result the caller can act on.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["reached-goal", "stuck"],
          description: "Whether the goal was reached.",
        },
        summary: str("What you did and what the screen showed at the end."),
        outcomeCandidates: {
          type: ["array", "null"],
          description:
            "Definite business answers the application gave, or null. Not errors, not timeouts: " +
            "an outcome is a fact about the record that would still be true on a second attempt.",
          items: {
            type: "object",
            properties: {
              code: str("SCREAMING_SNAKE_CASE, e.g. MEMBER_NOT_FOUND."),
              title: str("A short human title."),
              why: str("What on the screen said so."),
            },
            required: ["code", "title", "why"],
            additionalProperties: false,
          },
        },
      },
      required: ["status", "summary", "outcomeCandidates"],
      additionalProperties: false,
    },
  },
] satisfies readonly StrictTool[]);

/** The definitions with a cache breakpoint on the LAST tool, so the whole system+tools prefix sits
 *  inside one cached segment (BRIEF section 9). Kept separate from `DISCOVERY_TOOLS` so the digest
 *  test pins the SCHEMAS and not the provider's caching dialect. */
export function toolsWithCacheBreakpoint(
  tools: readonly StrictTool[] = DISCOVERY_TOOLS,
): readonly StrictTool[] {
  return tools.map((tool, index) =>
    index === tools.length - 1 ? { ...tool, cache_control: { type: "ephemeral" } } : tool,
  );
}
