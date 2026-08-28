// The tool-schema regression test SPEC section 11 unit 13 requires.
//
// Two things are pinned and they are pinned for different reasons.
//
//   · THE DIGEST. The tool definitions and the system prompt are the cacheable prefix. A change to
//     either invalidates every cached prefix in flight and changes what the model is being asked to
//     do, so it must be a deliberate diff somebody looked at - not a wording tweak that quietly
//     halves the cache hit rate and alters behaviour on the next live run.
//   · THE SHAPE RULES. `strict: true`, `additionalProperties: false` and a `required` array naming
//     EVERY property are what BRIEF section 9 says strict tool use needs. They are asserted
//     structurally rather than by digest, because the digest tells you that something changed and
//     these tell you what was broken.
//
// If a change here is intentional: run `pnpm -F @crr/discovery fixtures:digests`, paste the new
// values, and re-record the VCR fixture with `pnpm -F @crr/discovery fixtures:synthetic`.

import { digestOf } from "@crr/core";
import { describe, expect, it } from "vitest";
import {
  ActInputSchema,
  DISCOVERY_SYSTEM_PROMPT,
  DISCOVERY_TOOLS,
  FinishInputSchema,
  GoInputSchema,
  NoteOutputInputSchema,
  TOOL_NAMES,
  toolsWithCacheBreakpoint,
} from "../src/index.js";

// Updated 2026-08-27 for the `act.key` schema change, and the update is the point: the pin failed,
// which is what it is for. The tool surface is judged by a provider we do not control and cannot
// test against for free, so a silent change to it is the one regression that costs money to find.
//
// What moved: `key` went from `{ type: ["string","null"], enum: [...KEYS, null] }` to
// `{ anyOf: [{ type: "string", enum: [...KEYS] }, { type: "null" }] }`. The old form is valid JSON
// Schema and the Anthropic API rejects it under `strict: true` — "Enum value 'Enter' does not match
// declared type '['string', 'null']'" (req_011CeUK5RB1g, first live run, turn 1). A union `type`
// array is accepted on its own; combined with an `enum` it is not.
const TOOLS_DIGEST = "sha256:d8f508034ed6861a5677e37763580f7b6f2ba4a21b3dee897fc85b035fb75732";
const PROMPT_DIGEST = "sha256:43ce7bfbe5cc9c3d5e32295309c704dd0d87070b7eed797792953dc8b08ca52e";

interface JsonSchema {
  readonly type: string;
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

const schemaOf = (name: string): JsonSchema => {
  const tool = DISCOVERY_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool called ${name}`);
  return tool.input_schema as unknown as JsonSchema;
};

describe("the model-facing surface is pinned", () => {
  it("has exactly the five tools SPEC 6.1 names, in a fixed order", () => {
    expect(DISCOVERY_TOOLS.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    expect(TOOL_NAMES).toEqual(["observe", "act", "go", "note_output", "finish"]);
  });

  it("digests to the pinned tool definitions", () => {
    expect(digestOf(DISCOVERY_TOOLS)).toBe(TOOLS_DIGEST);
  });

  it("digests to the pinned system prompt", () => {
    expect(digestOf(DISCOVERY_SYSTEM_PROMPT)).toBe(PROMPT_DIGEST);
  });

  it("keeps the goal, the tenant and the route OUT of the cacheable prefix", () => {
    // The prefix is shared across runs, not merely across turns. A tenant name in here would make
    // every tenant a separate cache entry and would leak one run's target into another's prompt.
    for (const needle of ["riverbend", "50001", "/members/", "corebank"]) {
      expect(DISCOVERY_SYSTEM_PROMPT).not.toContain(needle);
    }
  });
});

describe("every tool satisfies strict tool use", () => {
  it("sets strict at the TOP LEVEL of the definition, not on tool_choice", () => {
    for (const tool of DISCOVERY_TOOLS) expect(tool.strict).toBe(true);
  });

  it("refuses extra properties", () => {
    for (const tool of DISCOVERY_TOOLS) {
      const schema = tool.input_schema as unknown as JsonSchema;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it("lists EVERY property in required, so an optional field is spelled null", () => {
    for (const tool of DISCOVERY_TOOLS) {
      const schema = tool.input_schema as unknown as JsonSchema;
      const properties = Object.keys(schema.properties ?? {});
      expect([...(schema.required ?? [])].sort()).toEqual([...properties].sort());
    }
  });

  it("gives every tool a description", () => {
    for (const tool of DISCOVERY_TOOLS) {
      expect((tool.description ?? "").length).toBeGreaterThan(40);
    }
  });
});

describe("the tools do not give the model a locator", () => {
  it("has no field anywhere that could carry a selector, an id or markup", () => {
    const serialized = JSON.stringify(DISCOVERY_TOOLS).toLowerCase();
    for (const forbidden of ["selector", "xpath", "html", "element", "attribute"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("has no INPUT FIELD that could set a wait or a timeout", () => {
    // Scoped to field names on purpose. The word "timeouts" appears in `finish`'s description,
    // where it is telling the model that a timeout is NOT a business outcome - which is the rule
    // from OPEN-QUESTIONS-RESOLVED Q1 and is exactly the sentence we want in there. What must not
    // exist is a field the model could set, because waiting is declared data the interpreter owns.
    const fields = DISCOVERY_TOOLS.flatMap((tool) =>
      Object.keys((tool.input_schema as unknown as JsonSchema).properties ?? {}),
    ).map((name) => name.toLowerCase());
    for (const forbidden of ["timeout", "wait", "delay", "sleep", "retries", "budget"]) {
      expect(fields.some((field) => field.includes(forbidden))).toBe(false);
    }
  });

  it("names a node the same way the projection does", () => {
    expect(schemaOf("act").properties).toHaveProperty("nodeRef");
    expect(schemaOf("note_output").properties).toHaveProperty("nodeRef");
  });
});

describe("the cache breakpoint", () => {
  it("sits on the LAST tool, so system + tools are one cached segment", () => {
    const tools = toolsWithCacheBreakpoint();
    expect(tools.slice(0, -1).every((tool) => tool.cache_control === undefined)).toBe(true);
    expect(tools.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("does not mutate the pinned definitions", () => {
    toolsWithCacheBreakpoint();
    expect(digestOf(DISCOVERY_TOOLS)).toBe(TOOLS_DIGEST);
  });
});

describe("the input validators match the published schemas", () => {
  it("accepts a well-formed act call", () => {
    const parsed = ActInputSchema.parse({
      nodeRef: "n7",
      action: "fill",
      value: "50001",
      key: null,
      why: "the task names this member",
    });
    expect(parsed.action).toBe("fill");
  });

  it("refuses a nodeRef that is a node id, a selector or anything else", () => {
    for (const bad of ["textbox:member-id", "#ctl00", "n", "7", "N7"]) {
      expect(
        ActInputSchema.safeParse({
          nodeRef: bad,
          action: "activate",
          value: null,
          key: null,
          why: "x",
        }).success,
      ).toBe(false);
    }
  });

  it("refuses an extra key, which strict mode should have made impossible", () => {
    const result = ActInputSchema.safeParse({
      nodeRef: "n1",
      action: "activate",
      value: null,
      key: null,
      why: "x",
      selector: "#ctl00",
    });
    expect(result.success).toBe(false);
  });

  it("requires an absolute path shape for go and a lowerCamelCase output name", () => {
    expect(GoInputSchema.safeParse({ routeHint: "/members/search", why: "x" }).success).toBe(true);
    expect(
      NoteOutputInputSchema.safeParse({ nodeRef: "n1", outputName: "Share Balance", meaning: "x" })
        .success,
    ).toBe(false);
    expect(
      NoteOutputInputSchema.safeParse({ nodeRef: "n1", outputName: "shareBalance", meaning: "x" })
        .success,
    ).toBe(true);
  });

  it("takes outcome codes in the vocabulary a contract uses", () => {
    const good = FinishInputSchema.safeParse({
      status: "stuck",
      summary: "no such member",
      outcomeCandidates: [{ code: "MEMBER_NOT_FOUND", title: "No such member", why: "banner" }],
    });
    expect(good.success).toBe(true);
    const bad = FinishInputSchema.safeParse({
      status: "stuck",
      summary: "no such member",
      outcomeCandidates: [{ code: "member_not_found", title: "x", why: "y" }],
    });
    expect(bad.success).toBe(false);
  });
});
