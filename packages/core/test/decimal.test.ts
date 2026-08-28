// Money handling, and the reasons it is a string.
//
// The tests that matter here are the ones that would pass if `Decimal` were a float and be wrong
// anyway: comparing amounts whose sum a float cannot hold, distinguishing a printed scale, and
// refusing to round. Anything that silently rounds a member's balance produces a number that is
// the right type, the right magnitude and not their money.

import { describe, expect, it } from "vitest";
import {
  canonicalizeDecimalText,
  compareDecimal,
  decimalEquals,
  decimalIsNegative,
  decimalIsZero,
  decimalScale,
  isDecimal,
  rescaleDecimal,
  tryDecimal,
  usd,
} from "../src/decimal.js";
import { type Decimal, DecimalSchema } from "../src/primitives.js";

/** Parse through the schema, so the canonical grammar is exercised on every fixture. */
const dec = (s: string): Decimal => DecimalSchema.parse(s);

describe("the canonical decimal grammar", () => {
  it("accepts the forms an artifact may contain", () => {
    for (const s of ["0", "1", "-1", "1234", "0.5", "10.00", "-1234.5678", "9007199254740993"]) {
      expect(isDecimal(s)).toBe(true);
    }
  });

  it("refuses every non-canonical spelling", () => {
    const refused = [
      "",
      " 1",
      "1 ",
      "+1",
      "007",
      "1.",
      ".5",
      "1e3",
      "1E3",
      "1,234",
      "$1",
      "NaN",
      "Infinity",
      "1.2.3",
      "--1",
      "1-",
    ];
    for (const s of refused) expect(isDecimal(s)).toBe(false);
  });

  it("refuses negative zero in every spelling", () => {
    // Two ways of writing one value would be two digests for one artifact, and the difference
    // would be invisible in review.
    for (const s of ["-0", "-0.0", "-0.00"]) expect(isDecimal(s)).toBe(false);
    expect(isDecimal("0.00")).toBe(true);
  });

  it("tryDecimal returns null rather than throwing, so parsers stay total", () => {
    expect(tryDecimal("1.5")).toBe("1.5");
    expect(tryDecimal("$1.50")).toBeNull();
  });
});

describe("compareDecimal", () => {
  it("orders values a float comparison would get wrong", () => {
    // 0.1 + 0.2 is not 0.3 in binary floating point; here the digits are the value.
    expect(compareDecimal(dec("0.3"), dec("0.30000000000000004"))).toBe(-1);
    // Beyond the exactly representable integer range, two distinct amounts must stay distinct.
    expect(compareDecimal(dec("9007199254740993"), dec("9007199254740992"))).toBe(1);
  });

  it("ignores trailing fractional zeros without discarding them from the value", () => {
    expect(decimalEquals(dec("10.00"), dec("10.0"))).toBe(true);
    expect(decimalEquals(dec("10.00"), dec("10"))).toBe(true);
    // The strings still differ, so the digest of an observation that saw "10.00" is not the
    // digest of one that saw "10".
    expect(dec("10.00")).not.toBe(dec("10"));
    expect(decimalScale(dec("10.00"))).toBe(2);
    expect(decimalScale(dec("10"))).toBe(0);
  });

  it("orders across the sign correctly", () => {
    expect(compareDecimal(dec("-1"), dec("1"))).toBe(-1);
    expect(compareDecimal(dec("-100"), dec("-99.99"))).toBe(-1);
    expect(compareDecimal(dec("-0.01"), dec("0"))).toBe(-1);
    expect(compareDecimal(dec("0"), dec("0.00"))).toBe(0);
  });

  it("compares by magnitude, not by string length", () => {
    expect(compareDecimal(dec("9"), dec("10"))).toBe(-1);
    expect(compareDecimal(dec("100"), dec("99.9999"))).toBe(1);
  });

  it("is a total order over a shuffled set", () => {
    const values = ["-1000", "-1", "-0.5", "0", "0.5", "1", "1.0000001", "1000"].map(dec);
    const shuffled = [...values].reverse();
    shuffled.sort(compareDecimal);
    expect(shuffled).toEqual(values);
  });
});

describe("decimal predicates", () => {
  it("recognises zero in every scale, and never calls a negative value zero", () => {
    expect(decimalIsZero(dec("0"))).toBe(true);
    expect(decimalIsZero(dec("0.0000"))).toBe(true);
    expect(decimalIsZero(dec("0.0001"))).toBe(false);
    expect(decimalIsNegative(dec("-0.01"))).toBe(true);
    expect(decimalIsNegative(dec("0.01"))).toBe(false);
  });
});

describe("rescaleDecimal", () => {
  it("pads to a wider scale exactly", () => {
    expect(rescaleDecimal(dec("10"), 2)).toBe("10.00");
    expect(rescaleDecimal(dec("-1.5"), 3)).toBe("-1.500");
  });

  it("narrows only when nothing is lost", () => {
    expect(rescaleDecimal(dec("10.00"), 0)).toBe("10");
    expect(rescaleDecimal(dec("10.5000"), 1)).toBe("10.5");
  });

  it("refuses rather than rounds", () => {
    // A declared scale of 2 against a screen showing four places is a contract mismatch, and the
    // caller needs to hear about it rather than receive a rounded number that looks correct.
    expect(rescaleDecimal(dec("1.2345"), 2)).toBeNull();
    expect(rescaleDecimal(dec("0.5"), 0)).toBeNull();
  });

  it("never produces a negative zero", () => {
    expect(rescaleDecimal(dec("-0.001"), 3)).toBe("-0.001");
    expect(rescaleDecimal(dec("0.000"), 0)).toBe("0");
  });
});

describe("canonicalizeDecimalText", () => {
  it("accepts what a screen prints and returns the canonical form", () => {
    const cases: readonly [string, string][] = [
      ["1234", "1234"],
      ["  12.50  ", "12.50"],
      ["+3", "3"],
      ["007", "7"],
      ["0007.50", "7.50"],
      [".5", "0.5"],
      ["1234.", "1234"],
      ["-0", "0"],
      ["-0.00", "0.00"],
      ["-12.5", "-12.5"],
    ];
    for (const [input, expected] of cases) {
      expect(canonicalizeDecimalText(input)).toBe(expected);
    }
  });

  it("refuses anything it would have to guess about", () => {
    // "-" is how a legacy report writes "no value". Reading it as zero would report an empty
    // field as an empty account.
    for (const s of ["", "   ", "-", ".", "1,234", "$5", "1e3", "n/a", "12 34", "1.2.3"]) {
      expect(canonicalizeDecimalText(s)).toBeNull();
    }
  });

  it("round-trips every canonical value unchanged", () => {
    for (const s of ["0", "0.00", "1234.5678", "-9.9"]) {
      expect(canonicalizeDecimalText(s)).toBe(s);
    }
  });
});

describe("usd", () => {
  it("wraps an amount with the only currency this schema admits", () => {
    expect(usd(dec("1234.56"))).toEqual({ amount: "1234.56", currency: "USD" });
  });
});
