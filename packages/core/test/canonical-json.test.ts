// Conformance and refusal tests for the JCS (RFC 8785) canonicalizer.
//
// Two independent checks run here, because "my serializer agrees with my serializer" proves
// nothing:
//
//   1. The property-ordering example from RFC 8785 section 3.2.3, with its expected output written
//      out by hand. It is the one case in the specification where the obvious implementation is
//      wrong: sorting is over UTF-16 code units, so an astral character sorts by its leading
//      surrogate (0xD800-0xDBFF) and lands *before* U+FB33, not after it.
//   2. A differential test against the engine's own `JSON.stringify` over a corpus, with keys
//      pre-sorted. `JSON.stringify` is an independent implementation of exactly the string-escaping
//      and number-formatting rules RFC 8785 defers to, so agreement across the corpus is real
//      evidence about the parts of the format most likely to be got subtly wrong.
//
// The refusal tests carry as much weight as the conformance tests. This function decides when two
// documents are the same document, and every rejected input is an input that two different values
// could otherwise have shared a digest through.

import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson, findNonIntegerNumber } from "../src/canonical-json.js";

describe("canonicalJson: RFC 8785 conformance", () => {
  it("orders properties by UTF-16 code unit, not by code point", () => {
    // RFC 8785 section 3.2.3. Note "1" is an array-index-shaped key, which `Object.keys` reports
    // first regardless of insertion order - so this also proves the sort is not just luck.
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "\u000a": "Newline",
      "1": "One",
      "\u0080": "Control\u007f",
      "\u{1F602}": "Smiley",
      ö: "Latin Small Letter O With Diaeresis",
      דּ: "Hebrew Letter Dalet With Dagesh",
      "</script>": "Browser Challenge",
    };

    const expected =
      '{"\\n":"Newline","\\r":"Carriage Return","1":"One","</script>":"Browser Challenge",' +
      '"\u0080":"Control\u007f","\u00f6":"Latin Small Letter O With Diaeresis",' +
      '"€":"Euro Sign","\u{1F602}":"Smiley","דּ":"Hebrew Letter Dalet With Dagesh"}';

    expect(canonicalJson(input)).toBe(expected);
  });

  it("escapes only what RFC 8785 section 3.2.2.2 requires", () => {
    expect(canonicalJson('"')).toBe('"\\""');
    expect(canonicalJson("\\")).toBe('"\\\\"');
    expect(canonicalJson("\b\t\n\f\r")).toBe('"\\b\\t\\n\\f\\r"');
    expect(canonicalJson("\u0000\u0001\u001f")).toBe('"\\u0000\\u0001\\u001f"');
    // U+007F is not a C0 control and is emitted literally; so is everything above it.
    expect(canonicalJson("\u007f\u0080\u00e9\u{1F602}")).toBe('"\u007f\u0080\u00e9\u{1F602}"');
    // The forward slash is not escaped, unlike some JSON emitters.
    expect(canonicalJson("a/b")).toBe('"a/b"');
  });

  it("serializes numbers in the ECMAScript shortest round-trip form", () => {
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(1)).toBe("1");
    expect(canonicalJson(-42)).toBe("-42");
    expect(canonicalJson(1e21)).toBe("1e+21");
    expect(canonicalJson(1e-7)).toBe("1e-7");
    expect(canonicalJson(0.1)).toBe("0.1");
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
  });

  it("emits arrays in order and objects with no insignificant whitespace", () => {
    expect(canonicalJson({ b: 1, a: [3, 2, 1], c: { z: null, y: true } })).toBe(
      '{"a":[3,2,1],"b":1,"c":{"y":true,"z":null}}',
    );
  });
});

/**
 * An independent canonicalizer built on the engine's own `JSON.stringify`, used to cross-check the
 * two parts of RFC 8785 that are easiest to get subtly wrong: string escaping and number
 * formatting. Both are delegated here, so agreement is evidence from a second implementation.
 *
 * Property *ordering* is done here rather than delegated, and that is not laziness. Rebuilding an
 * object with sorted keys and handing it to `JSON.stringify` does not work: JavaScript reorders
 * array-index-shaped property names ahead of everything else regardless of insertion order, so
 * `{ "": 3, "1": 4 }` comes back out as `1` first. RFC 8785 says the empty string sorts first.
 * That mismatch is the whole argument for not delegating a canonical form to `JSON.stringify`.
 */
function independentCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(independentCanonical).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${independentCanonical(record[k])}`);
  return `{${members.join(",")}}`;
}

describe("canonicalJson: differential against an independent serializer", () => {
  const corpus: readonly unknown[] = [
    null,
    true,
    false,
    0,
    -0,
    1,
    -1,
    12345678901234,
    0.1,
    -0.000001,
    1e21,
    1e-7,
    "",
    "plain",
    'quotes " and \\ backslash',
    "controls \u0000\u0001\b\n\r\u001f",
    "unicode \u00e9 \u20ac \u{1F602} \ufb33 \u0080 \u007f",
    "non-breaking\u00a0space and zero\u200bwidth",
    [],
    {},
    [1, "two", null, true, [], {}],
    { z: 1, a: 2, "": 3, "1": 4, é: 5, "\u{1F602}": 6 },
    {
      capability: "corebank.member.read_savings_balance",
      version: "1.2.0",
      steps: [
        { id: "search", budgets: { maxWaitMs: 15000, stableSamples: 2 } },
        { id: "open-account", outcomes: [{ code: "MEMBER_NOT_FOUND", priority: 10 }] },
      ],
      nested: { a: { b: { c: { d: { e: [1, 2, 3] } } } } },
    },
  ];

  for (const [i, value] of corpus.entries()) {
    it(`agrees with the independent serializer on corpus entry ${i}`, () => {
      expect(canonicalJson(value)).toBe(independentCanonical(value));
    });
  }
});

describe("canonicalJson: refusals", () => {
  const refused: readonly { readonly name: string; readonly value: unknown }[] = [
    { name: "undefined at the top level", value: undefined },
    { name: "undefined inside an array", value: [1, undefined, 3] },
    // The hole IS the case under test: JSON.stringify writes `null` for it, which would collide
    // with an explicit null and give two different documents one digest.
    // biome-ignore lint/suspicious/noSparseArray: deliberate, see above
    { name: "a hole inside an array", value: [1, , 3] },
    { name: "a bigint", value: { n: 10n } },
    { name: "a function", value: { f: () => 1 } },
    { name: "a symbol", value: { s: Symbol("s") } },
    { name: "NaN", value: { n: Number.NaN } },
    { name: "Infinity", value: { n: Number.POSITIVE_INFINITY } },
    { name: "a Map", value: new Map([["a", 1]]) },
    { name: "a Set", value: new Set([1]) },
    { name: "a class instance", value: new (class Thing {})() },
    { name: "an unpaired high surrogate", value: "lead \ud83d end" },
    { name: "an unpaired low surrogate", value: "trail \ude02 end" },
    { name: "an unpaired surrogate in a property name", value: { "\ud83d": 1 } },
  ];

  for (const c of refused) {
    it(`refuses ${c.name}`, () => {
      expect(() => canonicalJson(c.value)).toThrow(CanonicalJsonError);
    });
  }

  it("refuses a cycle rather than recursing forever", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/circular reference/);
  });

  it("refuses a value nested past the depth ceiling", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 200; i++) deep = { deep };
    expect(() => canonicalJson(deep)).toThrow(/nests deeper/);
  });

  it("names the path of the offending value", () => {
    expect(() => canonicalJson({ steps: [{ budget: Number.NaN }] })).toThrow(
      /at \$\.steps\[0\]\.budget/,
    );
  });

  it("re-permits a shape once the offending member is removed, so the error is about the value", () => {
    expect(canonicalJson({ steps: [{ budget: 1 }] })).toBe('{"steps":[{"budget":1}]}');
  });
});

describe("canonicalJson: undefined properties", () => {
  it("treats an absent optional field and an explicit undefined as the same document", () => {
    expect(canonicalJson({ frame: undefined, path: "/members" })).toBe(
      canonicalJson({ path: "/members" }),
    );
  });

  it("still distinguishes an explicit null from an absent field", () => {
    expect(canonicalJson({ frame: null })).not.toBe(canonicalJson({}));
  });
});

describe("findNonIntegerNumber", () => {
  it("passes a document whose every number is an integer", () => {
    expect(findNonIntegerNumber({ ms: 15000, rows: 0, bounds: [1, 2, 3, -4] })).toBeNull();
  });

  it("finds a float at any depth and names where it is", () => {
    expect(findNonIntegerNumber({ a: { b: [{ amount: 1234.56 }] } })).toBe("$.a.b[0].amount");
  });

  it("does not object to a decimal carried as a string, which is how money is written", () => {
    expect(findNonIntegerNumber({ amount: "1234.56", currency: "USD" })).toBeNull();
  });
});
