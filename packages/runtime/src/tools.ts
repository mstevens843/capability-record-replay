// The tool-definition projection: a saved artifact, seen by an AI agent as a callable capability.
//
// This is the far end of the whole system. A model discovered a flow once; deterministic synthesis
// turned that run into a contract and an artifact; and this module turns the CONTRACT - never the
// artifact - into the thing an agent's tool loop discovers by name and invokes with typed args.
//
// THE PROJECTION READS THE CONTRACT AND NOTHING ELSE, and that is the payoff of SPEC section 0.4's
// three-documents-three-readers split rather than a stylistic preference. The contract carries no
// step id, no descriptor, no route, no detector and no container path - the schema is a
// `strictObject`, so those fields cannot be smuggled in - which means "the tool definition leaks no
// surface detail" is a STRUCTURAL property here, not a filter that has to be maintained. A test
// asserts it anyway (`test/tools.test.ts`), because the day somebody widens the contract schema is
// the day the property quietly stops holding.
//
// WHY THE SHAPE IS PROVIDER-SHAPED BUT NOT PROVIDER-TYPED. `ToolDefinition` below is deliberately
// the Anthropic Messages API tool shape - `name`, `description`, `input_schema`, and `strict` as a
// TOP-LEVEL field on the tool definition (BRIEF section 9; `strict` is not a `tool_choice` option,
// and it requires `additionalProperties: false` plus `required`, both of which this emits). It is
// declared structurally rather than as `Anthropic.Tool` because `@crr/discovery` is the only
// package permitted to import a model SDK, and a runtime that depended on one to describe its own
// catalog would have put a provider in the production replay path. The adapter that hands these to
// a provider lives where the SDK does.
//
// WHAT IS DELIBERATELY NOT ADVERTISED. An output whose `agentDisclosure` is `withhold` does not
// appear in the description at all. Advertising a field the model will never receive is worse than
// useless: it is an invitation to ask for it, to work around not having it, or to hallucinate it.
// `mask` outputs are advertised as masked, because a model that knows it holds an unreadable member
// name can say something true about it; see `agent-view.ts` for the delivery half of the same rule.

import type { CapabilityContract, FieldSpec, OutcomeDecl, ParamSpec, ValueType } from "@crr/core";

/**
 * A JSON Schema subset, written out rather than imported.
 *
 * Only the constructs `strict: true` accepts appear here. There is no `anyOf`, no `$ref` and no
 * `oneOf`, because a strict tool schema may not contain them and a projection that can emit one is
 * a projection that fails at the provider boundary instead of at the type boundary.
 */
export interface JsonSchema {
  readonly type: "object" | "string" | "integer" | "boolean" | "array" | "number";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: false;
  readonly items?: JsonSchema;
  readonly enum?: readonly string[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly examples?: readonly string[];
}

export interface ToolDefinition {
  /** `^[a-zA-Z0-9_-]{1,128}$`. A capability name is dotted; a tool name may not be. */
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonSchema;
  /** Top-level on the tool definition, per BRIEF section 9. Every argument reaching `invoke` goes
   *  through the policy gate, so we want the provider to have already refused a malformed one. */
  readonly strict: true;
}

/** One row of a catalog listing: enough for a person or a router to choose, and nothing more. */
export interface CatalogEntry {
  readonly name: string;
  readonly toolName: string;
  readonly version: string;
  readonly title: string;
  readonly summary: string;
  readonly effect: CapabilityContract["effect"];
  readonly requiresApproval: boolean;
  readonly idempotent: boolean;
  readonly contractDigest: string;
  readonly outcomes: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/**
 * `corebank.member.read_share_position` -> `corebank_member_read_share_position`.
 *
 * The dotted capability name is the identity everywhere else in this system and stays that way; a
 * provider's tool-name grammar is a transport constraint, so the mapping is applied at the transport
 * and nowhere earlier. It is total and injective over the capability-name grammar (lowercase, dots,
 * underscores, digits, hyphens) because `.` is the only character it rewrites and `.` is not legal
 * in the target grammar - so two capabilities cannot collide into one tool name.
 */
export function toolNameOf(capabilityName: string): string {
  const mapped = capabilityName.replace(/\./g, "_");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(mapped)) {
    throw new Error(
      `${capabilityName} does not project onto a tool name; a capability name is dotted lowercase segments`,
    );
  }
  return mapped;
}

// ---------------------------------------------------------------------------------------------
// The input schema
// ---------------------------------------------------------------------------------------------

/**
 * A `ValueType` as JSON Schema.
 *
 * Two arms are worth pausing on:
 *
 *   · `money` and `decimal` are STRINGS. There is no IEEE-754 anywhere in this system (SPEC section
 *     2.1) and the tool boundary is the one place a float would be reintroduced by accident, by a
 *     provider helpfully parsing `"1204.55"` into a double and handing back `1204.5500000000002`.
 *   · `table` is an array of flat string records. A column's type is a scalar by construction, so a
 *     table cannot contain a table, and the schema says so rather than trusting it.
 */
export function jsonSchemaOf(type: ValueType): JsonSchema {
  switch (type.kind) {
    case "string": {
      const pattern =
        type.charset === "digits" ? "^[0-9]+$" : type.charset === "alnum" ? "^[A-Za-z0-9]+$" : null;
      return {
        type: "string",
        ...(pattern === null ? {} : { pattern }),
        ...(type.minLength === undefined ? {} : { minLength: type.minLength }),
        ...(type.maxLength === undefined ? {} : { maxLength: type.maxLength }),
      };
    }
    case "integer":
      return {
        type: "integer",
        ...(type.min === undefined ? {} : { minimum: type.min }),
        ...(type.max === undefined ? {} : { maximum: type.max }),
      };
    case "boolean":
      return { type: "boolean" };
    case "enum":
      return { type: "string", enum: [...type.values] };
    case "decimal":
      return {
        type: "string",
        description: `a decimal written as a string, ${type.scale} places after the point`,
        pattern: "^-?[0-9]+(\\.[0-9]+)?$",
      };
    case "money":
      return {
        type: "string",
        description: `an amount in ${type.currency}, written as a decimal string`,
        pattern: "^-?[0-9]+(\\.[0-9]+)?$",
      };
    case "date":
      return { type: "string", description: type.format, pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" };
    case "table":
      return {
        type: "array",
        description: `rows of ${type.columns.map((c) => c.name).join(", ")}`,
        items: {
          type: "object",
          properties: Object.fromEntries(
            type.columns.map((column) => [column.name, { type: "string" } as JsonSchema]),
          ),
          required: type.columns.map((column) => column.name),
          additionalProperties: false,
        },
      };
  }
}

/**
 * The tool's `input_schema`.
 *
 * `additionalProperties: false` and a `required` list naming EVERY property are what `strict: true`
 * demands, and an optional parameter therefore appears in `required` with `null` permitted rather
 * than being omitted... except that this schema subset has no union arm to express "or null". So an
 * optional parameter is simply omitted from `required`, and `strict` is still set: a provider that
 * refuses that combination is telling us something true, which is that a capability with an optional
 * argument needs a nullable-type arm here before it can be strict. No contract in this repo has one,
 * and inventing the arm against zero call sites is how a schema grows a construct nobody validates.
 */
export function inputSchemaOf(contract: CapabilityContract): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const input of contract.inputs) properties[input.name] = paramSchemaOf(input);
  return {
    type: "object",
    properties,
    required: contract.inputs.filter((i) => i.required).map((i) => i.name),
    additionalProperties: false,
  };
}

function paramSchemaOf(param: ParamSpec): JsonSchema {
  const base = jsonSchemaOf(param.type);
  const constraints = param.constraints;
  const tightened: JsonSchema =
    constraints === undefined
      ? base
      : {
          ...base,
          ...(constraints.charset === "digits"
            ? { pattern: "^[0-9]+$" }
            : constraints.charset === "alnum"
              ? { pattern: "^[A-Za-z0-9]+$" }
              : {}),
          ...(constraints.minLength === undefined ? {} : { minLength: constraints.minLength }),
          ...(constraints.maxLength === undefined ? {} : { maxLength: constraints.maxLength }),
          ...(constraints.enum === undefined ? {} : { enum: [...constraints.enum] }),
        };
  return {
    ...tightened,
    description: param.description,
    // `example` is absent on every sensitive field by the contract validator's own rule - "here is
    // an example member number" in a committed schema file is exactly the leak the taint model
    // exists to prevent. Re-checked here rather than trusted, because this is the projection that
    // ships the value to a third party.
    ...(param.example === undefined || param.sensitivity === "sensitive"
      ? {}
      : { examples: [param.example] }),
  };
}

// ---------------------------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------------------------

/**
 * The prose an agent routes on.
 *
 * Assembled from reviewed fields and NOTHING ELSE - `title`, `summary`, `whenToUse`,
 * `whenNotToUse`, each output's `description`, and each outcome's `summary`. Nothing is generated
 * here, in the same sense and for the same reason `guidance` is never generated in `agent-view.ts`:
 * a person wrote these once, calmly, and a router deciding whether to call a banking capability
 * should be reading that person's words rather than this function's paraphrase of them.
 *
 * The outcome list is the part most tool catalogues get wrong. A model that has never been told
 * `MEMBER_NOT_FOUND` is a possible ANSWER will read it as an error the first time it sees one, and
 * apologise for a system that worked perfectly.
 */
export function describeCapability(contract: CapabilityContract): string {
  const lines: string[] = [contract.title, "", contract.summary, ""];

  lines.push("Use this when:");
  for (const when of contract.whenToUse) lines.push(`  - ${when}`);
  lines.push("Do NOT use this when:");
  for (const when of contract.whenNotToUse) lines.push(`  - ${when}`);

  const disclosed = contract.outputs.filter((o) => o.agentDisclosure !== "withhold");
  if (disclosed.length > 0) {
    lines.push("", "On success you receive:");
    for (const output of disclosed) {
      const masked =
        output.agentDisclosure === "mask"
          ? " (value withheld from you for privacy; it was still read and returned to the system)"
          : "";
      const optional = output.required ? "" : " (may be null)";
      lines.push(`  - ${output.name}: ${output.description}${optional}${masked}`);
    }
  }

  if (contract.outcomes.length > 0) {
    lines.push(
      "",
      "This capability can also return a business OUTCOME. An outcome is an answer, not an error:",
    );
    for (const outcome of contract.outcomes) {
      lines.push(`  - ${outcome.code}: ${outcome.summary}`);
    }
  }

  if (contract.requiresApproval) {
    lines.push(
      "",
      "This capability performs an IRREVERSIBLE action and cannot run without a human approval token.",
    );
  }

  return lines.join("\n");
}

/** The whole projection: one contract, one callable tool. */
export function toolDefinitionOf(contract: CapabilityContract): ToolDefinition {
  return {
    name: toolNameOf(contract.name),
    description: describeCapability(contract),
    input_schema: inputSchemaOf(contract),
    strict: true,
  };
}

/** The listing row. Cheap enough to build for every capability in a store on every request. */
export function catalogEntryOf(contract: CapabilityContract): CatalogEntry {
  return {
    name: contract.name,
    toolName: toolNameOf(contract.name),
    version: contract.version,
    title: contract.title,
    summary: contract.summary,
    effect: contract.effect,
    requiresApproval: contract.requiresApproval,
    idempotent: contract.idempotent,
    contractDigest: contract.digest,
    outcomes: contract.outcomes.map((o) => o.code),
  };
}

/**
 * The payload schema of one outcome, for a caller that wants to document what it can receive.
 *
 * Not part of `ToolDefinition`: a provider tool definition describes the INPUT, and a payload
 * schema in the description would be read by a model as something it may supply. It is exported
 * because the codegen path and a human-facing catalogue both want it.
 */
export function outcomePayloadSchemaOf(outcome: OutcomeDecl): JsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(
      outcome.payload.map((field: FieldSpec) => [
        field.name,
        { ...jsonSchemaOf(field.type), description: field.description } as JsonSchema,
      ]),
    ),
    required: outcome.payload.filter((f) => f.required).map((f) => f.name),
    additionalProperties: false,
  };
}
