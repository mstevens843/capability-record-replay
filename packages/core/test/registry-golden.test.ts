// Golden vectors for every registered normalizer, extractor and parser.
//
// This is the human-readable half of the registry freeze. `registry-stability.test.ts` proves that
// nothing changed; this file says what these functions actually do, in a form the person approving
// an artifact that names `std.label@1` can read.
//
// The vectors are chosen from the two surface spikes and from what a legacy back-office screen
// actually prints: non-breaking spaces, a decomposed umlaut, accounting parentheses, a trailing
// COBOL minus, a tenant's branding word in the middle of a label. Each one is a case where a
// plausible simpler implementation gives a different, wrong answer.

import { describe, expect, it } from "vitest";
import { type ExtractorSource, extract } from "../src/extractors.js";
import { normalize } from "../src/normalizers.js";
import { type ParseOutcome, parse } from "../src/parsers.js";
import {
  type ExtractorId,
  ExtractorIdSchema,
  type NormalizerId,
  NormalizerIdSchema,
  type ParserId,
  ParserIdSchema,
} from "../src/primitives.js";
import {
  REGISTRY,
  entryMajorIsConsistent,
  isRegisteredId,
  lookupRegistryEntry,
} from "../src/registry.js";

interface NormalizerVector {
  readonly id: NormalizerId;
  readonly input: string;
  readonly brandingTokens?: readonly string[];
  readonly expected: string;
  readonly why: string;
}

const NORMALIZER_VECTORS: readonly NormalizerVector[] = [
  { id: "std.text@1", input: "", expected: "", why: "empty stays empty" },
  { id: "std.text@1", input: "   ", expected: "", why: "whitespace-only collapses to empty" },
  {
    id: "std.text@1",
    input: "  Member   ID  ",
    expected: "member id",
    why: "runs of space fold to one",
  },
  { id: "std.text@1", input: "SEARCH", expected: "search", why: "case is folded" },
  {
    id: "std.text@1",
    input: "Member\u00A0ID",
    expected: "member id",
    why: "a non-breaking space is a space; a legacy page emits them constantly",
  },
  {
    id: "std.text@1",
    input: "Account\u200BNumber_",
    expected: "accountnumber_",
    why: "a zero-width space is removed, not turned into a word break",
  },
  {
    id: "std.text@1",
    input: "\uFEFFSearch",
    expected: "search",
    why: "a byte-order mark is removed before the whitespace pass, so it cannot split a word",
  },
  {
    id: "std.text@1",
    input: "Männer",
    expected: "männer",
    why: "decomposed and precomposed forms of one label must normalize alike",
  },
  {
    id: "std.text@1",
    input: "Männer",
    expected: "männer",
    why: "the precomposed half of the pair",
  },
  {
    id: "std.text@1",
    input: "Member ID:",
    expected: "member id:",
    why: "std.text does NOT strip label decoration",
  },

  { id: "std.label@1", input: "Member ID:", expected: "member id", why: "std.label does strip it" },
  {
    id: "std.label@1",
    input: "Balance ._:",
    expected: "balance",
    why: "all three trailing characters, repeatedly",
  },
  {
    id: "std.label@1",
    input: "Riverbend Search",
    brandingTokens: ["Riverbend"],
    expected: "search",
    why: "the tenant's branding word comes from the overlay and is removed",
  },
  {
    id: "std.label@1",
    input: "Search Riverbend Member",
    brandingTokens: ["riverbend"],
    expected: "search member",
    why: "the token is matched after normalization, so its own casing does not matter",
  },
  {
    id: "std.label@1",
    input: "River Bend Bank Balance",
    brandingTokens: ["River Bend Bank"],
    expected: "balance",
    why: "a multi-word token removes that word sequence and nothing else",
  },
  {
    id: "std.label@1",
    input: "Summit Summary",
    brandingTokens: ["Summit"],
    expected: "summary",
    why: "whole words only - substring removal would eat the start of 'summary'",
  },
  {
    id: "std.label@1",
    input: "Riverbend Riverbend Search",
    brandingTokens: ["Riverbend"],
    expected: "search",
    why: "every occurrence, not just the first",
  },
  {
    id: "std.label@1",
    input: "Member ID: Riverbend",
    brandingTokens: ["Riverbend"],
    expected: "member id",
    why: "removing a trailing token exposes decoration, which the second strip then removes",
  },
  {
    id: "std.label@1",
    input: "Balance - Riverbend",
    brandingTokens: ["Riverbend"],
    expected: "balance -",
    why: "a hyphen is NOT stripped: it carries meaning inside a label, as in Sub-Account",
  },

  {
    id: "std.money@1",
    input: "$1,234.56",
    expected: "1234.56",
    why: "symbol and grouping removed",
  },
  {
    id: "std.money@1",
    input: "( 1,234.56 )",
    expected: "-1234.56",
    why: "accounting parentheses are a negative",
  },
  {
    id: "std.money@1",
    input: "1234.56-",
    expected: "-1234.56",
    why: "a trailing minus is how a green screen prints a debit",
  },
  {
    id: "std.money@1",
    input: "USD 10.00",
    expected: "10.00",
    why: "a leading USD marker is removed",
  },
  {
    id: "std.money@1",
    input: "10.00 usd",
    expected: "10.00",
    why: "and a trailing one, in either case",
  },
  { id: "std.money@1", input: "+0.5", expected: "0.5", why: "an explicit plus is dropped" },
  { id: "std.money@1", input: "-$0.00", expected: "-0.00", why: "sign and symbol in either order" },
  {
    id: "std.money@1",
    input: "EUR 10,00",
    expected: "EUR10,00",
    why: "a foreign currency marker survives, so the parser refuses instead of relabelling it USD",
  },
  {
    id: "std.money@1",
    input: "10,00",
    expected: "10,00",
    why: "an incorrectly grouped comma is left alone rather than read as a thousands separator",
  },
  { id: "std.money@1", input: "n/a", expected: "n/a", why: "normalizing is not validating" },

  {
    id: "std.identity@1",
    input: "  Member ID:  ",
    expected: "  Member ID:  ",
    why: "exact comparison has to be sayable, including the spaces",
  },
];

describe("normalizer golden vectors", () => {
  for (const v of NORMALIZER_VECTORS) {
    it(`${v.id} maps ${JSON.stringify(v.input)} to ${JSON.stringify(v.expected)} - ${v.why}`, () => {
      expect(normalize(v.id, v.input, { brandingTokens: v.brandingTokens })).toBe(v.expected);
    });
  }

  it("is idempotent: normalizing an already normalized value changes nothing", () => {
    // Detectors compare a normalized screen value against a normalized matcher value, and an
    // artifact author may have normalized by hand. A second pass must not move the answer.
    for (const v of NORMALIZER_VECTORS) {
      const once = normalize(v.id, v.input, { brandingTokens: v.brandingTokens });
      expect(normalize(v.id, once, { brandingTokens: v.brandingTokens })).toBe(once);
    }
  });
});

interface ExtractorVector {
  readonly id: ExtractorId;
  readonly source: ExtractorSource;
  readonly expected: string | null;
  readonly why: string;
}

const EXTRACTOR_VECTORS: readonly ExtractorVector[] = [
  {
    id: "text@1",
    source: { name: "Share Balance", value: null, text: "$1,234.56" },
    expected: "$1,234.56",
    why: "the text the element shows, verbatim - interpreting it is the parser's job",
  },
  {
    id: "text@1",
    source: { name: "Share Balance", value: null, text: "  " },
    expected: null,
    why: "a whitespace-only cell is missing, not empty",
  },
  {
    id: "text@1",
    source: { name: "Share Balance", value: null, text: null },
    expected: null,
    why: "an absent field is missing",
  },
  {
    id: "value@1",
    source: { name: "Member ID", value: "12345", text: "ignored" },
    expected: "12345",
    why: "a control's value, not the text around it",
  },
  {
    id: "value@1",
    source: { name: "Member ID", value: "", text: "12345" },
    expected: null,
    why: "an empty field does not silently fall through to the surrounding text",
  },
  {
    id: "name@1",
    source: { name: "Status", value: null, text: null },
    expected: "Status",
    why: "the label, which is all a green screen has for some fields",
  },
  {
    id: "name@1",
    source: { name: "", value: "x", text: "y" },
    expected: null,
    why: "an unnamed node has no name to extract",
  },
  {
    id: "cell@1",
    source: { name: "Share Balance", value: "1234.56", text: "$1,234.56" },
    expected: "1234.56",
    why: "a reported value beats rendered text",
  },
  {
    id: "cell@1",
    source: { name: "Share Balance", value: null, text: "$1,234.56" },
    expected: "$1,234.56",
    why: "and falls back to the text when the surface reports no value",
  },
  {
    id: "cell@1",
    source: { name: "Share Balance", value: " ", text: "12345" },
    expected: "12345",
    why: "a blank value is missing, so the fallback still applies",
  },
  {
    id: "cell@1",
    source: { name: "Share Balance", value: null, text: null },
    expected: null,
    why: "NEVER the accessible name: on a layout table that is the column header, so this would return the string 'Share Balance' where a balance was asked for",
  },
];

describe("extractor golden vectors", () => {
  for (const v of EXTRACTOR_VECTORS) {
    it(`${v.id} on ${JSON.stringify(v.source)} yields ${JSON.stringify(v.expected)} - ${v.why}`, () => {
      expect(extract(v.id, v.source)).toBe(v.expected);
    });
  }
});

interface ParserVector {
  readonly id: ParserId;
  readonly input: string;
  readonly enumValues?: readonly string[];
  readonly expected: ParseOutcome;
  readonly why: string;
}

const ok = (value: string | number | { amount: string; currency: "USD" }): ParseOutcome =>
  ({ ok: true, value }) as ParseOutcome;
const no = (reason: string): ParseOutcome => ({ ok: false, reason }) as ParseOutcome;

const PARSER_VECTORS: readonly ParserVector[] = [
  {
    id: "string@1",
    input: "",
    expected: ok(""),
    why: "an empty string is a value; absence was decided upstream",
  },
  {
    id: "string@1",
    input: "  Active  ",
    expected: ok("  Active  "),
    why: "unchanged, including spacing",
  },

  { id: "integer@1", input: "1234", expected: ok(1234), why: "the ordinary case" },
  { id: "integer@1", input: "-1234", expected: ok(-1234), why: "negatives are integers" },
  { id: "integer@1", input: "0", expected: ok(0), why: "zero" },
  { id: "integer@1", input: "", expected: no("empty"), why: "nothing to read" },
  {
    id: "integer@1",
    input: "007",
    expected: no("not-an-integer"),
    why: "leading zeros have two spellings and one meaning",
  },
  {
    id: "integer@1",
    input: "-0",
    expected: no("not-an-integer"),
    why: "negative zero, same reason",
  },
  {
    id: "integer@1",
    input: "1,234",
    expected: no("not-an-integer"),
    why: "separators belong to a normalizer the artifact must name",
  },
  { id: "integer@1", input: "1e3", expected: no("not-an-integer"), why: "no exponent form" },
  {
    id: "integer@1",
    input: "9007199254740993",
    expected: no("out-of-range"),
    why: "beyond exact representation this parser would return a different number than the screen showed",
  },

  {
    id: "moneyUSD@1",
    input: "$1,234.56",
    expected: ok({ amount: "1234.56", currency: "USD" }),
    why: "the ordinary case, scale preserved",
  },
  {
    id: "moneyUSD@1",
    input: "12.50",
    expected: ok({ amount: "12.50", currency: "USD" }),
    why: "the printed scale is kept: 12.50 does not become 12.5",
  },
  {
    id: "moneyUSD@1",
    input: "(1,234.56)",
    expected: ok({ amount: "-1234.56", currency: "USD" }),
    why: "accounting parentheses",
  },
  {
    id: "moneyUSD@1",
    input: "1234.56-",
    expected: ok({ amount: "-1234.56", currency: "USD" }),
    why: "trailing minus",
  },
  {
    id: "moneyUSD@1",
    input: ".5",
    expected: ok({ amount: "0.5", currency: "USD" }),
    why: "a bare leading dot is canonicalized",
  },
  { id: "moneyUSD@1", input: "", expected: no("empty"), why: "nothing to read" },
  {
    id: "moneyUSD@1",
    input: "n/a",
    expected: no("not-a-money-amount"),
    why: "a legacy app's way of writing 'no value' is not zero",
  },
  {
    id: "moneyUSD@1",
    input: "EUR 10,00",
    expected: no("not-a-money-amount"),
    why: "another currency is refused rather than relabelled USD",
  },
  {
    id: "moneyUSD@1",
    input: "10,00",
    expected: no("not-a-money-amount"),
    why: "ambiguous grouping is refused rather than read as ten thousand",
  },

  { id: "dateUS@1", input: "01/31/2026", expected: ok("2026-01-31"), why: "the ordinary case" },
  {
    id: "dateUS@1",
    input: "1/3/2026",
    expected: ok("2026-01-03"),
    why: "single-digit month and day, as legacy screens print them",
  },
  { id: "dateUS@1", input: "02/29/2024", expected: ok("2024-02-29"), why: "a real leap day" },
  { id: "dateUS@1", input: "02/29/2023", expected: no("not-a-date"), why: "not a leap year" },
  { id: "dateUS@1", input: "02/30/2024", expected: no("not-a-date"), why: "not a day that exists" },
  {
    id: "dateUS@1",
    input: "01/31/26",
    expected: no("not-a-date"),
    why: "a two-digit year has no non-guessed century",
  },
  {
    id: "dateUS@1",
    input: "2026-01-31",
    expected: no("not-a-date"),
    why: "the other format is a different parser",
  },

  { id: "dateISO@1", input: "2026-01-31", expected: ok("2026-01-31"), why: "the ordinary case" },
  {
    id: "dateISO@1",
    input: "2000-02-29",
    expected: ok("2000-02-29"),
    why: "a century year divisible by 400 IS a leap year",
  },
  {
    id: "dateISO@1",
    input: "1900-02-29",
    expected: no("not-a-date"),
    why: "a century year not divisible by 400 is not",
  },
  {
    id: "dateISO@1",
    input: "2026-1-31",
    expected: no("not-a-date"),
    why: "the ISO form is zero-padded",
  },

  {
    id: "enum@1",
    input: "Active",
    enumValues: ["Active", "Closed"],
    expected: ok("Active"),
    why: "an exact match",
  },
  {
    id: "enum@1",
    input: "active",
    enumValues: ["Active", "Closed"],
    expected: ok("Active"),
    why: "a case-folded match returns the DECLARED spelling, so the caller's types still hold",
  },
  {
    id: "enum@1",
    input: "active",
    enumValues: ["Active", "ACTIVE"],
    expected: no("ambiguous-enum"),
    why: "two declared values that differ only by case is an artifact bug; picking one is how a closed account gets reported open",
  },
  {
    id: "enum@1",
    input: "Frozen",
    enumValues: ["Active", "Closed"],
    expected: no("not-in-enum"),
    why: "a value the contract never declared",
  },
  {
    id: "enum@1",
    input: "Active",
    expected: no("enum-values-not-declared"),
    why: "without a declared set there is nothing to be one of",
  },
];

describe("parser golden vectors", () => {
  for (const v of PARSER_VECTORS) {
    it(`${v.id} on ${JSON.stringify(v.input)} yields ${JSON.stringify(v.expected)} - ${v.why}`, () => {
      expect(parse(v.id, v.input, { enumValues: v.enumValues })).toEqual(v.expected);
    });
  }

  it("never throws, for any registered parser on any of the vector inputs", () => {
    // Totality is the property the classifier and the linker depend on: an exception thrown from
    // inside a pure function is a control-flow path nothing declared.
    const inputs = PARSER_VECTORS.map((v) => v.input);
    for (const id of ParserIdSchema.options) {
      for (const input of inputs) {
        expect(() => parse(id, input)).not.toThrow();
      }
    }
  });
});

describe("the registry itself", () => {
  it("has an entry for every id in every registry union, and nothing else", () => {
    const declared = [
      ...NormalizerIdSchema.options,
      ...ExtractorIdSchema.options,
      ...ParserIdSchema.options,
    ];
    expect(REGISTRY.map((e) => e.id).sort()).toEqual([...declared].sort());
  });

  it("declares a major that agrees with the suffix of its own id", () => {
    for (const entry of REGISTRY) expect(entryMajorIsConsistent(entry)).toBe(true);
  });

  it("gives every entry a summary written to drop into a sentence for a reviewer", () => {
    for (const entry of REGISTRY) {
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.summary).toBe(entry.summary.trim());
    }
  });

  it("refuses an id at a major that does not exist, which is linker check 18", () => {
    expect(isRegisteredId("std.label@1")).toBe(true);
    expect(isRegisteredId("std.label@2")).toBe(false);
    expect(isRegisteredId("std.label")).toBe(false);
    expect(isRegisteredId("regex@1")).toBe(false);
    expect(lookupRegistryEntry("std.label@2")).toBeUndefined();
  });
});
