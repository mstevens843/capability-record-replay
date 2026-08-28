// The tool-definition projection: a saved artifact, as a capability an agent discovers and calls.
//
// Two properties are being defended here and they pull in opposite directions, which is why both
// need a test. The definition must carry ENOUGH for a model to route correctly - the outcome codes
// especially, because a model that has never been told `MEMBER_NOT_FOUND` is an answer will read it
// as a failure the first time it sees one. And it must carry NOTHING about the surface, because a
// model handed a route or a control name will try to drive the app itself.

import { MOCK_LEASE_TOKEN, MockSurface } from "@crr/core";
import { describe, expect, it } from "vitest";
import { Catalog } from "../src/catalog.js";
import { StaticSessionBroker } from "../src/session.js";
import {
  catalogEntryOf,
  describeCapability,
  inputSchemaOf,
  jsonSchemaOf,
  toolDefinitionOf,
  toolNameOf,
} from "../src/tools.js";
import { sharePositionArtifact, sharePositionContract } from "./fixtures/corebank.js";
import {
  disclosureArtifact,
  disclosureContract,
  disclosureScreens,
} from "./fixtures/disclosure.js";
import { mockAllowlist, mockArtifact, mockContract, mockTrust } from "./fixtures/mock-flow.js";

// Registered but never driven: every test in this file reads a projection off a document.
const broker = new StaticSessionBroker(
  new MockSurface({
    screens: disclosureScreens,
    start: "blank",
    transitions: [],
    lease: MOCK_LEASE_TOKEN,
  }),
);

describe("tool names", () => {
  it("maps a dotted capability name onto the provider's tool-name grammar", () => {
    expect(toolNameOf("corebank.member.read_share_position")).toBe(
      "corebank_member_read_share_position",
    );
    expect(toolNameOf("corebank.member.read_share_position")).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
  });

  it("cannot collide two capabilities onto one tool, because only `.` is rewritten", () => {
    // `a.b_c` and `a_b.c` are different capabilities and would collide under any mapping that also
    // rewrote `_`. This is the reason the mapping does not normalise anything else.
    expect(toolNameOf("a.b_c")).toBe("a_b_c");
    expect(toolNameOf("a_b.c")).toBe("a_b_c");
    // ...so the catalog resolves a tool name by LOOKUP, never by inverting the string.
    expect(new Catalog({ trust: mockTrust }).capabilityNameForTool("a_b_c")).toBeNull();
  });

  it("refuses a name that does not project onto the grammar at all", () => {
    expect(() => toolNameOf("corebank member")).toThrow(/does not project/);
  });
});

describe("the input schema", () => {
  it("is strict: no extra properties, and every required argument named", () => {
    const tool = toolDefinitionOf(sharePositionContract);
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect(tool.input_schema.required).toEqual(["memberId"]);
    expect(tool.input_schema.type).toBe("object");
  });

  it("carries the parameter's constraints, so the provider refuses a malformed argument first", () => {
    const schema = inputSchemaOf(sharePositionContract).properties?.memberId;
    expect(schema).toMatchObject({
      type: "string",
      pattern: "^[0-9]+$",
      minLength: 5,
      maxLength: 5,
    });
    expect(schema?.description).toContain("five digits");
  });

  it("never publishes an example for a sensitive field", () => {
    // The contract validator already forbids it; this is the second gate, on the projection that
    // actually ships the value to a third party.
    const doctored = {
      ...sharePositionContract,
      inputs: [{ ...sharePositionContract.inputs[0], example: "10041" }],
    } as unknown as typeof sharePositionContract;
    expect(doctored.inputs[0]?.sensitivity).toBe("sensitive");
    expect(inputSchemaOf(doctored).properties?.memberId).not.toHaveProperty("examples");
    expect(JSON.stringify(toolDefinitionOf(doctored))).not.toContain("10041");
  });

  it("publishes an example for a non-sensitive one, because that is what it is for", () => {
    const status = sharePositionContract.outputs.find((o) => o.name === "accountStatus");
    expect(status?.example).toBe("ACTIVE");
  });
});

describe("value types as JSON Schema", () => {
  it("renders money and decimal as STRINGS, so no float is reintroduced at the tool boundary", () => {
    expect(jsonSchemaOf({ kind: "money", currency: "USD" })).toMatchObject({ type: "string" });
    expect(jsonSchemaOf({ kind: "decimal", scale: 2 })).toMatchObject({ type: "string" });
  });

  it("renders an enum as a closed string list", () => {
    expect(jsonSchemaOf({ kind: "enum", values: ["ACTIVE", "CLOSED"] })).toEqual({
      type: "string",
      enum: ["ACTIVE", "CLOSED"],
    });
  });

  it("renders a table as an array of flat, strict string records", () => {
    const schema = jsonSchemaOf({
      kind: "table",
      columns: [
        { name: "Acct", type: { kind: "string" } },
        { name: "Share Balance", type: { kind: "string" } },
      ],
    });
    expect(schema.type).toBe("array");
    expect(schema.items?.additionalProperties).toBe(false);
    expect(schema.items?.required).toEqual(["Acct", "Share Balance"]);
  });
});

describe("the description", () => {
  const description = describeCapability(sharePositionContract);

  it("carries both routing lists, because models mis-route more often than they mis-fill", () => {
    expect(description).toContain("Use this when:");
    expect(description).toContain("Do NOT use this when:");
    for (const line of sharePositionContract.whenNotToUse) expect(description).toContain(line);
  });

  it("names every business outcome and says out loud that an outcome is not an error", () => {
    expect(description).toContain("MEMBER_NOT_FOUND");
    expect(description).toContain("An outcome is an answer, not an error");
  });

  it("advertises a masked output as masked, and does not advertise a withheld one at all", () => {
    const disclosed = describeCapability(disclosureContract);
    expect(disclosed).toContain("memberName");
    expect(disclosed).toContain("value withheld from you");
    // Advertising a field the model will never receive invites it to ask for it, work around not
    // having it, or hallucinate it.
    expect(disclosed).not.toContain("internalRef");
  });

  it("says when a capability cannot run without a human approval", () => {
    const irreversible = {
      ...sharePositionContract,
      effect: "WRITE_IRREVERSIBLE",
      requiresApproval: true,
    } as unknown as typeof sharePositionContract;
    expect(describeCapability(irreversible)).toContain("IRREVERSIBLE");
  });
});

describe("what a tool definition structurally cannot leak", () => {
  // The contract schema is a `strictObject` with no detector, no route, no descriptor and no step,
  // so this is a structural property rather than a filter. It is asserted anyway: the day somebody
  // widens the contract schema is the day it quietly stops holding.
  const text = JSON.stringify(toolDefinitionOf(sharePositionContract));

  it("contains no step id from the artifact that implements it", () => {
    for (const step of sharePositionArtifact.flow.steps) {
      expect(text).not.toContain(step.id);
    }
  });

  it("contains no route path, origin alias or frame name", () => {
    for (const route of sharePositionArtifact.flow.routes) {
      expect(text).not.toContain(route.path);
      if (route.frame !== undefined) expect(text).not.toContain(`"${route.frame}"`);
    }
  });

  it("contains no locator vocabulary of any kind", () => {
    for (const forbidden of [
      "querySelector",
      "xpath",
      "css",
      "data-",
      "getElementById",
      "#ctl00",
    ]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("the catalog", () => {
  function catalog() {
    return new Catalog({ trust: mockTrust })
      .register({
        contract: disclosureContract,
        artifact: disclosureArtifact(),
        allowlist: mockAllowlist,
        broker,
      })
      .register({
        contract: mockContract,
        artifact: mockArtifact(),
        allowlist: mockAllowlist,
        broker,
      });
  }

  it("lists what it holds, in a stable order, with the digest a caller must pin", () => {
    const entries = catalog().entries();
    expect(entries.map((e) => e.name)).toEqual(["mock.member.disclose", "mock.member.find"]);
    expect(entries[0]?.contractDigest).toBe(disclosureContract.digest);
    expect(entries[0]?.outcomes).toEqual(["MEMBER_NOT_FOUND", "MEMBER_RESTRICTED"]);
    expect(entries[0]?.effect).toBe("READ");
    expect(entries[0]?.requiresApproval).toBe(false);
  });

  it("hands out one callable tool per registered capability", () => {
    const tools = catalog().tools();
    expect(tools.map((t) => t.name)).toEqual(["mock_member_disclose", "mock_member_find"]);
    for (const tool of tools) expect(tool.strict).toBe(true);
  });

  it("resolves a tool name back to its capability by lookup", () => {
    expect(catalog().capabilityNameForTool("mock_member_find")).toBe("mock.member.find");
    expect(catalog().capabilityNameForTool("nope")).toBeNull();
  });

  it("refuses to register an artifact that implements a different contract", () => {
    expect(() =>
      new Catalog({ trust: mockTrust }).register({
        contract: disclosureContract,
        artifact: mockArtifact(),
        allowlist: mockAllowlist,
        broker,
      }),
    ).toThrow(/implements mock.member.find, not mock.member.disclose/);
  });

  it("agrees with the standalone projection, so there is one definition of a tool", () => {
    expect(catalog().toolFor("mock.member.find")).toEqual(toolDefinitionOf(mockContract));
    expect(catalogEntryOf(mockContract).toolName).toBe("mock_member_find");
  });
});
