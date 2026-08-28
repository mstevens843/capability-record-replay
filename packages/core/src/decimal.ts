// Decimal-as-string arithmetic, for the one place this system handles money.
//
// Every function here works on digit strings and never converts to a JavaScript number. That is
// not fastidiousness: `Number("0.1") + Number("0.2")` is `0.30000000000000004`, and the value this
// package compares is a member's share balance read off a screen and reported to an agent that
// will tell a person what their money is. The comparison also feeds `ContinuityDef`, which is what
// decides whether the balance on screen belongs to the member we were asked about - so a
// comparison that is wrong at the last digit is a comparison that can attach one member's balance
// to another member's name.
//
// Scale is preserved, never normalized away. `10.00` off a browser and `10.0` off a green screen
// are the same amount and different observations; `compareDecimal` says they are equal and the
// strings stay distinguishable.

import { type Decimal, DecimalSchema, type Money } from "./primitives.js";

/** True when the string is already in the canonical decimal form. */
export function isDecimal(value: string): value is Decimal {
  return DecimalSchema.safeParse(value).success;
}

/** The canonical form, or `null`. Never throws: callers here are parsers that must stay total. */
export function tryDecimal(value: string): Decimal | null {
  return isDecimal(value) ? value : null;
}

interface Parts {
  readonly negative: boolean;
  readonly int: string;
  readonly frac: string;
}

function parts(d: Decimal): Parts {
  const negative = d.startsWith("-");
  const body = negative ? d.slice(1) : d;
  const dot = body.indexOf(".");
  return dot === -1
    ? { negative, int: body, frac: "" }
    : { negative, int: body.slice(0, dot), frac: body.slice(dot + 1) };
}

/** Number of fractional digits. `"10"` is 0, `"10.00"` is 2. */
export function decimalScale(d: Decimal): number {
  return parts(d).frac.length;
}

export function decimalIsNegative(d: Decimal): boolean {
  return d.startsWith("-");
}

export function decimalIsZero(d: Decimal): boolean {
  const p = parts(d);
  return /^0*$/.test(p.int) && /^0*$/.test(p.frac);
}

/** Compare magnitudes of two same-signed values, digits only. */
function compareMagnitude(a: Parts, b: Parts): -1 | 0 | 1 {
  // Canonical form has no leading zeros, so a longer integer part is a larger magnitude.
  if (a.int.length !== b.int.length) return a.int.length < b.int.length ? -1 : 1;
  if (a.int !== b.int) return a.int < b.int ? -1 : 1;
  const width = Math.max(a.frac.length, b.frac.length);
  const af = a.frac.padEnd(width, "0");
  const bf = b.frac.padEnd(width, "0");
  if (af === bf) return 0;
  return af < bf ? -1 : 1;
}

/**
 * Numeric ordering. Trailing fractional zeros do not affect the answer, so `10.00` and `10.0`
 * compare equal while remaining distinct strings and distinct digests.
 */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const pa = parts(a);
  const pb = parts(b);
  if (pa.negative !== pb.negative) return pa.negative ? -1 : 1;
  const magnitude = compareMagnitude(pa, pb);
  if (magnitude === 0) return 0;
  return pa.negative ? ((magnitude * -1) as -1 | 1) : magnitude;
}

export function decimalEquals(a: Decimal, b: Decimal): boolean {
  return compareDecimal(a, b) === 0;
}

/**
 * Re-express at a fixed scale, or `null` if that would lose a digit.
 *
 * Refusing rather than rounding is the point. A `ValueType` of `{ kind: "decimal", scale: 2 }` is a
 * claim about what the caller's types can hold; if the screen showed four decimal places, quietly
 * rounding to two produces a number that is wrong and looks right. `null` sends that to
 * `output-extraction-failed`, which is a debuggable event.
 */
export function rescaleDecimal(d: Decimal, scale: number): Decimal | null {
  if (!Number.isInteger(scale) || scale < 0) return null;
  const p = parts(d);
  if (p.frac.length > scale) {
    const dropped = p.frac.slice(scale);
    if (!/^0*$/.test(dropped)) return null;
  }
  const frac = p.frac.slice(0, scale).padEnd(scale, "0");
  const body = scale === 0 ? p.int : `${p.int}.${frac}`;
  const allZero = /^0*$/.test(p.int) && /^0*$/.test(frac);
  return `${p.negative && !allZero ? "-" : ""}${body}` as Decimal;
}

/**
 * Tolerantly read a decimal out of text that is already free of currency symbols and separators,
 * returning the canonical form or `null`.
 *
 * Accepts what a screen actually prints and a canonical form forbids: a leading `+`, leading
 * zeros, a bare `.5`, a trailing `1234.`, and `-0`. Everything else is refused rather than
 * guessed at - this is the boundary between "the app showed us something" and "we believe it is a
 * number", and a lenient boundary here is how `-` (a legacy app's way of writing "no value")
 * becomes a zero balance.
 */
export function canonicalizeDecimalText(raw: string): Decimal | null {
  const t = raw.trim();
  if (t.length === 0) return null;

  const negative = t.startsWith("-");
  const unsigned = negative || t.startsWith("+") ? t.slice(1) : t;
  if (!/^\d*(\.\d*)?$/.test(unsigned)) return null;

  const dot = unsigned.indexOf(".");
  const rawInt = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const rawFrac = dot === -1 ? "" : unsigned.slice(dot + 1);
  if (rawInt.length === 0 && rawFrac.length === 0) return null;

  const int = rawInt.replace(/^0+(?=\d)/, "") || "0";
  const body = rawFrac.length > 0 ? `${int}.${rawFrac}` : int;
  const allZero = /^0*$/.test(int) && /^0*$/.test(rawFrac);
  const canonical = `${negative && !allZero ? "-" : ""}${body}`;
  return tryDecimal(canonical);
}

/** Wrap an amount as USD. The only currency this schema admits (SPEC section 2.1). */
export function usd(amount: Decimal): Money {
  return { amount, currency: "USD" };
}
