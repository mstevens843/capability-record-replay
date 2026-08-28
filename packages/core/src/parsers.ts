// The parser registry (SPEC section 2.1, used by `ExtractSpec` in section 2.4).
//
// A parser turns the text an extractor pulled off a screen into the typed value a calling agent
// was promised. Every one of them is total - it returns an outcome and never throws - because the
// alternative is an exception thrown from inside a pure function that the classifier, the linker
// and the conformance suite all call, and an exception is a control-flow path nothing declared.
//
// The pipeline `ExtractSpec` runs is: extract, then normalize, then parse. Each parser here is
// nonetheless tolerant of the un-normalized form of its own grammar, because an artifact may
// legitimately pair `moneyUSD@1` with `std.identity@1` and a parser that only works downstream of
// one specific normalizer is a coupling the schema does not express.
//
// The bias throughout is refusal. A value that cannot be read exactly becomes
// `output-extraction-failed`, which is a loud, debuggable event, rather than a rounded or guessed
// number that reaches a member.

import { canonicalizeDecimalText, usd } from "./decimal.js";
import { stdMoney, stdText } from "./normalizers.js";
import type { Money, ParserId } from "./primitives.js";

/**
 * Everything a parser may need beyond the text.
 *
 * `enumValues` comes from the declared `ValueType` of the output being extracted, so the set of
 * acceptable answers is a property of the contract a caller generated types from, not of the
 * engine.
 */
export interface ParserContext {
  readonly enumValues?: readonly string[];
}

/** A calendar day is returned as a `YYYY-MM-DD` string; there is no calendar object here. */
export type ParsedValue = string | number | Money;

export type ParseFailureReason =
  | "empty"
  | "not-an-integer"
  | "out-of-range"
  | "not-a-money-amount"
  | "not-a-date"
  | "not-in-enum"
  | "ambiguous-enum"
  | "enum-values-not-declared";

export type ParseOutcome =
  | { readonly ok: true; readonly value: ParsedValue }
  | { readonly ok: false; readonly reason: ParseFailureReason };

export type ParserFn = (input: string, ctx: ParserContext) => ParseOutcome;

const ok = (value: ParsedValue): ParseOutcome => ({ ok: true, value });
const no = (reason: ParseFailureReason): ParseOutcome => ({ ok: false, reason });

/** Calendar validity, including the full Gregorian leap rule. */
function isCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (lengths[month - 1] as number);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export const PARSERS: Readonly<Record<ParserId, ParserFn>> = {
  /**
   * The text, unchanged. Never fails: an empty string is a value, and whether an *absent* value is
   * acceptable is `ExtractSpec.onMissing`'s decision, made one layer up where the extractor
   * already returned `null`.
   */
  "string@1": (input) => ok(input),

  /**
   * A plain signed integer. No thousands separators, no exponent, no leading `+`, no leading
   * zeros, no `-0`.
   *
   * The strictness is deliberate: an artifact that needs to read `1,234` should say so by pairing
   * this with `std.money@1`, in the document, where a reviewer sees it. A parser that quietly
   * accepted separators would also quietly accept `1,2,3`.
   *
   * Values outside the exactly-representable integer range are refused rather than rounded. This
   * parser returns a JavaScript number, and a rounded account number is a wrong answer that looks
   * like a right one.
   */
  "integer@1": (input) => {
    const t = input.trim();
    if (t.length === 0) return no("empty");
    if (!/^-?(0|[1-9]\d*)$/.test(t) || t === "-0") return no("not-an-integer");
    const n = Number(t);
    if (!Number.isSafeInteger(n)) return no("out-of-range");
    return ok(n);
  },

  /**
   * A USD amount, tolerant of what a banking screen prints - `$1,234.56`, `(1,234.56)` for a
   * credit, `1234.56-` off a green screen - and intolerant of anything ambiguous.
   *
   * The scale that was printed is preserved: `10.00` stays `10.00`. Two screens that disagree
   * about how many decimals to show are still comparable through `compareDecimal`, and throwing
   * away the printed scale would throw away the only evidence of which screen it came from.
   */
  "moneyUSD@1": (input) => {
    if (input.trim().length === 0) return no("empty");
    const amount = canonicalizeDecimalText(stdMoney(input));
    if (amount === null) return no("not-a-money-amount");
    return ok(usd(amount));
  },

  /**
   * `MM/DD/YYYY`, with single-digit month and day allowed because legacy screens print both.
   * Returns the ISO form.
   *
   * A two-digit year is refused. There is no rule that recovers the century from `01/31/26` which
   * is not a guess, and a date is exactly the kind of value that will be used to decide whether
   * something has expired.
   */
  "dateUS@1": (input) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input.trim());
    if (m === null) return no("not-a-date");
    const month = Number(m[1]);
    const day = Number(m[2]);
    const year = Number(m[3]);
    if (!isCalendarDay(year, month, day)) return no("not-a-date");
    return ok(`${year}-${pad2(month)}-${pad2(day)}`);
  },

  /** `YYYY-MM-DD`, calendar-validated, returned as-is. */
  "dateISO@1": (input) => {
    const t = input.trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (m === null) return no("not-a-date");
    if (!isCalendarDay(Number(m[1]), Number(m[2]), Number(m[3]))) return no("not-a-date");
    return ok(t);
  },

  /**
   * One of the values declared on the output's `ValueType`, returned in the *declared* spelling.
   *
   * Exact match first. If nothing matches exactly, the declared values are compared after
   * `std.text@1` - otherwise pairing this parser with a case-folding normalizer, which is the
   * obvious thing to do for a status column, could never match a declared `"Active"`.
   *
   * If that loose pass matches more than one declared value, the answer is a refusal and not a
   * pick. Ambiguity is a detected condition, never a coin flip (SPEC section 0.5): two declared
   * values that differ only by case are an artifact bug, and silently choosing one of them is how
   * a closed account gets reported as open.
   */
  "enum@1": (input, ctx) => {
    const values = ctx.enumValues;
    if (values === undefined || values.length === 0) return no("enum-values-not-declared");
    if (values.includes(input)) return ok(input);
    const folded = stdText(input);
    const matches = values.filter((v) => stdText(v) === folded);
    if (matches.length === 0) return no("not-in-enum");
    if (matches.length > 1) return no("ambiguous-enum");
    return ok(matches[0] as string);
  },
};

/** Apply a registered parser. Total: every id in the union has an implementation, and no parser
 *  throws. */
export function parse(id: ParserId, input: string, ctx: ParserContext = {}): ParseOutcome {
  return PARSERS[id](input, ctx);
}
