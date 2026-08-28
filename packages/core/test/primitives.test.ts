// The primitives, tested at the boundary they exist to defend.
//
// Most of these are one-line regular expressions, and testing a regular expression against itself
// is worthless. What is tested here is the *refusals*: the specific wrong values that a recorder,
// a model or a hurried overlay author would plausibly produce, and that must not survive into a
// document the replay engine will trust. A literal URL in a route, a node id in a stored field, a
// tenant's display wording in a label token - each of those is a real defect this schema is shaped
// to make unrepresentable.

import { describe, expect, it } from "vitest";
import {
  AppInstanceIdSchema,
  ApprovalTokenSchema,
  ArtifactIdSchema,
  CapabilityNameSchema,
  ContractVersionSchema,
  DigestSchema,
  EffectClassSchema,
  EvidenceRefSchema,
  InterventionIdSchema,
  LabelTokenSchema,
  LeaseTokenSchema,
  MoneySchema,
  NodeIdSchema,
  RoleSchema,
  type RouteId,
  RouteIdSchema,
  RoutePatternSchema,
  RunIdSchema,
  ScalarValueTypeSchema,
  SensitivitySchema,
  type StepId,
  StepIdSchema,
  SurfaceKindSchema,
  TenantIdSchema,
  TextMatcherSchema,
  TimestampSchema,
  ValueRefSchema,
  ValueTypeSchema,
  looksLikeNodeId,
  registryMajor,
} from "../src/primitives.js";

const accepts = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  values: readonly unknown[],
) => {
  for (const v of values)
    expect(schema.safeParse(v).success, `should accept ${JSON.stringify(v)}`).toBe(true);
};
const refuses = (
  schema: { safeParse: (v: unknown) => { success: boolean } },
  values: readonly unknown[],
) => {
  for (const v of values)
    expect(schema.safeParse(v).success, `should refuse ${JSON.stringify(v)}`).toBe(false);
};

/**
 * Compile-time only. Nothing calls it; `tsc --noEmit` over `test/` is what runs it, and the
 * `@ts-expect-error` fails the build if the brands ever collapse back into plain strings.
 *
 * This is the whole reason these are branded. `journal(runId, stepId)` with the arguments reversed
 * is a mistake that costs an afternoon at 2am and compiles perfectly against `type StepId = string`.
 */
function brandsAreNominal(step: StepId, route: RouteId): void {
  // @ts-expect-error a RouteId is not a StepId, however similar the strings look
  const wrong: StepId = route;
  void wrong;
  void step;
}
void brandsAreNominal;

describe("CapabilityName", () => {
  it("accepts a dotted lowercase path", () => {
    accepts(CapabilityNameSchema, [
      "corebank.member.read_savings_balance",
      "corebank.member_search",
    ]);
  });

  it("refuses a single segment, uppercase, spaces and path separators", () => {
    refuses(CapabilityNameSchema, [
      "corebank",
      "Corebank.Member",
      "corebank member",
      "corebank/member",
      "",
      ".leading",
      "trailing.",
    ]);
  });
});

describe("ContractVersion", () => {
  it("accepts an exact three-part version", () => {
    accepts(ContractVersionSchema, ["0.0.0", "1.2.0", "10.20.30"]);
  });

  it("refuses anything that could mean more than one version", () => {
    // A range would defeat the digest pin in SPEC section 2.6 before it started: the caller's
    // generated types were built against one contract, not against a set of them.
    refuses(ContractVersionSchema, ["1.2", "v1.2.0", "^1.2.0", "1.2.x", "1.2.0-rc.1", "01.2.0"]);
  });
});

describe("identifier slugs", () => {
  it("accept lowercase slugs across every id that a human writes", () => {
    for (const schema of [
      ArtifactIdSchema,
      StepIdSchema,
      RouteIdSchema,
      TenantIdSchema,
      AppInstanceIdSchema,
    ]) {
      accepts(schema, ["search", "open-account", "member.detail", "riverbend_2"]);
      refuses(schema, ["", "Search", "open account", "-leading", "step/one"]);
    }
  });
});

describe("LabelToken", () => {
  it("accepts a symbolic name", () => {
    accepts(LabelTokenSchema, ["search-button", "member-id", "exit"]);
  });

  it("refuses anything that looks like the words on a screen", () => {
    // The token is the multi-tenant hinge: if a tenant's wording can be written as a token, the
    // base artifact stops being tenant-neutral and the overlay stops being the only place the
    // wording lives.
    refuses(LabelTokenSchema, ["Search", "Member ID:", "search button", "", "Riverbend Search"]);
  });
});

describe("NodeId", () => {
  it("accepts the driver-assigned form", () => {
    // Driver rule D10: name-derived, never coordinate-derived.
    accepts(NodeIdSchema, ["textbox:account-number", "button:search", "ax:f2#417"]);
  });

  it("refuses a bare index or anything with whitespace", () => {
    refuses(NodeIdSchema, ["417", "", "textbox: account number", "Textbox:x"]);
  });

  it("recognises a node id wherever one has been stored, which is what the validator asks", () => {
    expect(looksLikeNodeId("textbox:account-number")).toBe(true);
    expect(looksLikeNodeId("ax:f2#417")).toBe(true);
    // A descriptor's accessible name is not node-id shaped, so a legitimate descriptor survives.
    expect(looksLikeNodeId("Search")).toBe(false);
    expect(looksLikeNodeId("Member ID")).toBe(false);
  });
});

describe("Digest", () => {
  it("accepts the exact form and refuses the spec's synthetic placeholder", () => {
    accepts(DigestSchema, [`sha256:${"0".repeat(64)}`]);
    refuses(DigestSchema, [
      "sha256:<synthetic>",
      `sha256:${"0".repeat(63)}`,
      `SHA256:${"0".repeat(64)}`,
      "0".repeat(64),
    ]);
  });
});

describe("Timestamp", () => {
  it("accepts UTC with a trailing Z", () => {
    accepts(TimestampSchema, ["2026-01-31T09:15:00Z", "2026-01-31T09:15:00.123Z"]);
  });

  it("refuses a local offset, so two tenants' journals merge by string comparison", () => {
    refuses(TimestampSchema, [
      "2026-01-31T09:15:00-05:00",
      "2026-01-31 09:15:00Z",
      "2026-01-31",
      "",
    ]);
  });
});

describe("opaque runtime handles", () => {
  it("accept any non-empty whitespace-free string", () => {
    for (const schema of [
      RunIdSchema,
      LeaseTokenSchema,
      ApprovalTokenSchema,
      InterventionIdSchema,
      EvidenceRefSchema,
    ]) {
      accepts(schema, ["01JABCDEF", "lease-7f3a", "blob/sha256/aa"]);
      refuses(schema, ["", "two words"]);
    }
  });
});

describe("closed vocabularies", () => {
  it("have no escape hatch member", () => {
    // A node the driver cannot classify carries `ariaRole: null`; it never becomes "unknown", or
    // the classifier would have to decide what an unknown role means.
    refuses(RoleSchema, ["unknown", "widget", "div", ""]);
    accepts(RoleSchema, ["button", "textbox", "cell", "dialog"]);
    refuses(EffectClassSchema, ["write", "READ_ONLY"]);
    accepts(EffectClassSchema, ["READ", "WRITE_REVERSIBLE", "WRITE_IRREVERSIBLE"]);
    refuses(SensitivitySchema, ["secret"]);
    refuses(SurfaceKindSchema, ["web", "tui"]);
  });
});

describe("Money", () => {
  it("accepts a canonical decimal amount in USD", () => {
    accepts(MoneySchema, [{ amount: "1234.56", currency: "USD" }]);
  });

  it("refuses a float amount, a non-canonical string, and any other currency", () => {
    refuses(MoneySchema, [
      { amount: 1234.56, currency: "USD" },
      { amount: "$1,234.56", currency: "USD" },
      { amount: "1234.56", currency: "EUR" },
    ]);
  });
});

describe("TextMatcher", () => {
  it("accepts the four declared modes", () => {
    accepts(TextMatcherSchema, [
      { mode: "exact", value: "Search", normalize: "std.label@1" },
      { mode: "contains", value: "no member", normalize: "std.text@1" },
      { mode: "template", value: "No member found for {memberId}", normalize: "std.text@1" },
      { mode: "token", token: "search-button", normalize: "std.label@1" },
    ]);
  });

  it("has no regex mode, and no way to smuggle one in", () => {
    refuses(TextMatcherSchema, [
      { mode: "regex", value: "^No member", normalize: "std.text@1" },
      { mode: "exact", value: "Search", normalize: "std.regex@1" },
      { mode: "exact", value: "Search" },
      { mode: "token", token: "Search Button", normalize: "std.label@1" },
    ]);
  });
});

describe("ValueRef", () => {
  it("accepts the four provenances", () => {
    accepts(ValueRefSchema, [
      { from: "param", param: "memberId" },
      { from: "literal", value: "Savings", sensitivity: "public" },
      { from: "output", step: "search", output: "memberName" },
      { from: "credential", key: "corebank.operator" },
    ]);
  });

  it("makes a non-public literal unrepresentable", () => {
    // This is the type-level half of "the artifact stores shapes, never values". The linker
    // re-checks it, but a document carrying a sensitive literal cannot even parse.
    refuses(ValueRefSchema, [
      { from: "literal", value: "123456789", sensitivity: "sensitive" },
      { from: "literal", value: "123456789", sensitivity: "internal" },
      { from: "literal", value: "123456789" },
    ]);
  });
});

describe("ValueType", () => {
  it("accepts the scalar kinds and a table of scalars", () => {
    accepts(ValueTypeSchema, [
      { kind: "string", charset: "digits", maxLength: 10 },
      { kind: "integer", min: 0 },
      { kind: "decimal", scale: 2 },
      { kind: "money", currency: "USD" },
      { kind: "date", format: "YYYY-MM-DD" },
      { kind: "boolean" },
      { kind: "enum", values: ["Active", "Closed"] },
      { kind: "table", columns: [{ name: "account", type: { kind: "string" } }] },
    ]);
  });

  it("refuses a table nested inside a table", () => {
    // A bounded read whose bound is not statically knowable is not a bounded read.
    refuses(ValueTypeSchema, [
      {
        kind: "table",
        columns: [
          {
            name: "sub",
            type: { kind: "table", columns: [{ name: "a", type: { kind: "string" } }] },
          },
        ],
      },
    ]);
    refuses(ScalarValueTypeSchema, [
      { kind: "table", columns: [{ name: "a", type: { kind: "string" } }] },
    ]);
  });

  it("refuses an empty enum and an empty column list", () => {
    refuses(ValueTypeSchema, [
      { kind: "enum", values: [] },
      { kind: "table", columns: [] },
    ]);
  });
});

describe("RoutePattern", () => {
  it("accepts a canonicalized route with a parameter hole", () => {
    accepts(RoutePatternSchema, [
      { id: "member-detail", originAlias: "corebank", path: "/members/:memberId/accounts" },
      {
        id: "member-search",
        originAlias: "corebank",
        path: "/search",
        query: { q: { from: "param", param: "memberId" }, session: ":any" },
        frame: "content",
      },
    ]);
  });

  it("refuses an absolute URL, an origin in the alias, and a relative path", () => {
    // A literal origin makes an artifact accidentally single-tenant; a literal path segment makes
    // it carry a member number.
    refuses(RoutePatternSchema, [
      { id: "member-detail", originAlias: "corebank", path: "https://riverbend.example/members" },
      { id: "member-detail", originAlias: "https://riverbend.example", path: "/members" },
      { id: "member-detail", originAlias: "corebank", path: "members/12345" },
    ]);
  });
});

describe("registryMajor", () => {
  it("reads the major out of a registry id", () => {
    expect(registryMajor("std.text@1")).toBe(1);
    expect(registryMajor("moneyUSD@12")).toBe(12);
  });

  it("returns null for anything that is not a versioned id", () => {
    for (const s of ["std.text", "std.text@", "std.text@0", "std.text@01", "@1", "std.text@1.0"]) {
      expect(registryMajor(s)).toBeNull();
    }
  });
});
