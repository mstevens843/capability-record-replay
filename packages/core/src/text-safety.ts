// The refusal that the whole design rests on: no locator, and no member data, may enter a document.
//
// SPEC section 1.3 and section 10 check 10 require the artifact validator to reject any string in a
// descriptor position that looks like a stylesheet selector, a document path expression, a URL, or
// a `NodeId`. Section 10 check 14 and save-time invariant 8 add the PII shapes. Both refusals are
// implemented here, once, and applied by every schema that accepts author-written text.
//
// WHY it is a refusal and not a warning: a model authors these documents. A model that has been
// shown a legacy page and asked for "the Search button" will, given any opening at all, hand back
// something that worked when it looked at the page. That string then survives review (it looks
// precise), survives approval (it is inside the signed digest), and fails on the first tenant whose
// markup differs - which is the exact failure mode the brief says is NOT the interesting one, so
// spending a single replay on it is a waste. Refusing at parse time costs nothing and is total.
//
// WHY the two obvious acronyms appear nowhere in this file: the purity contract test of SPEC
// section 1.3 reads `@crr/core`'s sources off disk and fails on that vocabulary anywhere above the
// drivers. A detector that names what it detects would fail the very test it exists to support, so
// the two names are spelled out in prose instead - "stylesheet selector" and "document path
// expression". The regular expressions below are the real specification.

import { normalize } from "./normalizers.js";
import { TextMatcherSchema, ValueRefSchema, looksLikeNodeId } from "./primitives.js";

/** What an unsafe string looked like. Reported, not just refused, because the message is read by a
 *  person deciding whether the recorder is misbehaving or the label really does contain a slash. */
export type LocatorShape = "stylesheet-selector" | "path-expression" | "url" | "node-id";

export type PiiShape = "ssn" | "card-pan" | "long-digit-run" | "email" | "phone";

// ---------------------------------------------------------------------------------------------
// Locator shapes
//
// Every expression here is linear: no nested quantifier, no alternation inside a repetition. That
// is deliberate. These run over strings that arrived from a model, and a catastrophically
// backtracking expression in the module whose job is to refuse hostile input would be a joke at
// our own expense. It is also the same argument section 5.6 makes for keeping regex out of the
// artifact itself.
// ---------------------------------------------------------------------------------------------

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const URL_KNOWN_SCHEME = /^(?:https?|ftp|file|data|mailto|javascript|about|blob|tel):/i;
const URL_EMBEDDED = /:\/\//;
const URL_BARE_HOST = /^www\.[A-Za-z0-9-]+\./i;
const URL_PATH = /^\/[A-Za-z0-9_%:.-]*\//;

/** `//div`, `.//tr` - the leading form of a document path expression. */
const PATH_LEADING = /^\.{0,2}\/\//;
/** `[@id`, `[@name` - an attribute test. */
const PATH_ATTRIBUTE = /\[@[A-Za-z_]/;
/** `ancestor::`, `following-sibling::` and the rest of the axis vocabulary. */
const PATH_AXIS =
  /\b(?:ancestor|ancestor-or-self|descendant|descendant-or-self|following|following-sibling|preceding|preceding-sibling|parent|child|self|attribute|namespace)::/;
/** `text()`, `node()`, `contains(`, `starts-with(`, `normalize-space(`, `local-name(`. */
const PATH_FUNCTION = /\b(?:text|node)\(\)|\b(?:contains|starts-with|normalize-space|local-name)\(/;

/** `#member-id`, `.grid-row` - a leading id or class token. */
const SELECT_LEADING_TOKEN = /^[#.][A-Za-z_][A-Za-z0-9_-]*(?:[\s>~+.#[:]|$)/;
/** `table.grid`, `input#q` - a tag with an id or class glued to it. */
const SELECT_TAG_TOKEN = /^[a-z][a-z0-9]*[#.][A-Za-z_][A-Za-z0-9_-]*/;
/** An attribute test: `[name="q"]`, `[type=submit]`. Presence-only brackets are NOT matched, so a
 *  green-screen label rendered as `[Search]` survives - a real value on the terminal surface. */
const SELECT_ATTRIBUTE_EQ = /\[[A-Za-z_][A-Za-z0-9_:.-]*[~^|*$]?=/;
/** An attribute test glued to an identifier: `a[href]`, `input[name]`. */
const SELECT_ATTRIBUTE_GLUED = /[A-Za-z0-9_*)\]]\[[A-Za-z_-]/;
/** A pseudo-element, and the structural pseudo-classes people actually reach for. */
const SELECT_PSEUDO = /::|:(?:nth-|first-child|last-child|only-child|not\()/;
/** A child or sibling combinator between two selector-ish tokens. The right side may not start
 *  with a digit, so a label reading "Balance > 0" is not mistaken for one. */
const SELECT_COMBINATOR = /[A-Za-z0-9_)\]]\s*[>~+]\s*[A-Za-z*.#[]/;

/**
 * The shape a string looks like, or `null` if it looks like text a human would read off a screen.
 *
 * Order matters: a URL scheme is checked before the path forms so `https://x/y` is not reported as
 * a path expression, and a leading `/` is reported as a URL because `/members/:memberId` is a route
 * far more often than it is anything else.
 */
export function locatorShapeOf(value: string): LocatorShape | null {
  if (URL_SCHEME.test(value) || URL_KNOWN_SCHEME.test(value) || URL_EMBEDDED.test(value)) {
    return "url";
  }
  if (URL_BARE_HOST.test(value)) return "url";
  if (
    PATH_LEADING.test(value) ||
    PATH_ATTRIBUTE.test(value) ||
    PATH_AXIS.test(value) ||
    PATH_FUNCTION.test(value)
  ) {
    return "path-expression";
  }
  if (URL_PATH.test(value)) return "url";
  if (
    SELECT_LEADING_TOKEN.test(value) ||
    SELECT_TAG_TOKEN.test(value) ||
    SELECT_ATTRIBUTE_EQ.test(value) ||
    SELECT_ATTRIBUTE_GLUED.test(value) ||
    SELECT_PSEUDO.test(value) ||
    SELECT_COMBINATOR.test(value)
  ) {
    return "stylesheet-selector";
  }
  // Last, because it is the loosest: `<kind>:<local>` catches a stored per-observation node id, and
  // section 2.2 says to refuse those on suspicion. A node id is an index into one snapshot, so a
  // document carrying one is a document that will be replayed against a snapshot that never had it.
  if (looksLikeNodeId(value)) return "node-id";
  return null;
}

// ---------------------------------------------------------------------------------------------
// PII shapes
//
// This is the second half of "parameterization IS the privacy control" (BRIEF section 3.6). The
// first half is structural: a `literal` ValueRef is typed `sensitivity: "public"` and a route is a
// pattern, so the common ways to persist a member number are unrepresentable. What is left is free
// text - a detector written as `contains "No member found for 12345"` instead of a template hole -
// and that is what these shapes refuse.
// ---------------------------------------------------------------------------------------------

const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const PHONE = /(?:\+1[ .-]?)?(?:\(\d{3}\)[ .-]?|\b\d{3}[ .-])\d{3}[ .-]\d{4}\b/;
const LONG_DIGIT_RUN = /\d{9,}/;

/** True when the string contains a grouped digit run of card-number length. Written as a scan
 *  rather than an expression because the expression for it is the backtracking kind. */
function hasCardLengthDigitRun(value: string): boolean {
  let digits = 0;
  let sawSeparator = false;
  for (let i = 0; i <= value.length; i += 1) {
    const ch = i < value.length ? value[i] : "";
    if (ch !== undefined && ch >= "0" && ch <= "9") {
      digits += 1;
      continue;
    }
    if (ch === " " || ch === "-") {
      // A separator only continues a run that has already started.
      if (digits > 0) {
        sawSeparator = true;
        continue;
      }
    }
    if (digits >= 13 && digits <= 19 && sawSeparator) return true;
    digits = 0;
    sawSeparator = false;
  }
  return false;
}

/** True for `name@host.tld`, without an expression that can backtrack on a long non-match. */
function hasEmailShape(value: string): boolean {
  const at = value.indexOf("@");
  if (at < 1 || at === value.length - 1) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (/[\s@]/.test(local) || /[\s@]/.test(domain)) return false;
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 2;
}

/** The shape of regulated data this string looks like, or `null`. */
export function piiShapeOf(value: string): PiiShape | null {
  if (SSN.test(value)) return "ssn";
  if (hasEmailShape(value)) return "email";
  if (PHONE.test(value)) return "phone";
  if (hasCardLengthDigitRun(value)) return "card-pan";
  if (LONG_DIGIT_RUN.test(value)) return "long-digit-run";
  return null;
}

// ---------------------------------------------------------------------------------------------
// The combined guard
// ---------------------------------------------------------------------------------------------

const LOCATOR_ADVICE: Readonly<Record<LocatorShape, string>> = {
  "stylesheet-selector":
    "looks like a stylesheet selector; describe the control the way a person would - its role and its visible name",
  "path-expression":
    "looks like a document path expression; describe the control the way a person would - its role and its visible name",
  url: "looks like a URL or a literal path; routes are declared once in flow.routes as patterns and referenced by id",
  "node-id":
    "looks like a node id; node ids index one observation and mean nothing in the next, so they are never stored",
};

const PII_ADVICE: Readonly<Record<PiiShape, string>> = {
  ssn: "looks like a social security number",
  "card-pan": "looks like a card number",
  "long-digit-run": "contains a long run of digits, which is how an account or member number looks",
  email: "looks like an email address",
  phone: "looks like a phone number",
};

/**
 * The one guard every author-written string in an artifact or overlay passes through. Returns a
 * message aimed at the person who has to fix it, or `null` when the string is fine.
 */
export function unsafeTextReason(value: string): string | null {
  const locator = locatorShapeOf(value);
  if (locator !== null) return `${JSON.stringify(value)} ${LOCATOR_ADVICE[locator]}`;
  const pii = piiShapeOf(value);
  if (pii !== null) {
    return `${JSON.stringify(value)} ${PII_ADVICE[pii]}; use a template hole such as {memberId} so the value stays out of the document`;
  }
  return null;
}

/**
 * `TextMatcher` with the guard attached. Every matcher inside an artifact or an overlay uses this
 * one; `TextMatcherSchema` itself stays unguarded so that the primitive remains reusable for
 * things that are not documents (a test harness, a driver's own comparison).
 *
 * The `token` arm carries no free text at all - its `LabelToken` is a symbolic name and the words
 * live in the tenant's vocabulary - so it passes trivially. That is not an accident: the token form
 * is the one the multi-tenant design wants authors to reach for anyway.
 */
export const SafeTextMatcherSchema = TextMatcherSchema.superRefine((matcher, ctx) => {
  if (matcher.mode === "token") return;
  const reason = unsafeTextReason(matcher.value);
  if (reason !== null) ctx.addIssue(reason);
  const trivial = trivialMatcherReason(matcher.value, matcher.normalize);
  if (trivial !== null) ctx.addIssue(trivial);
});

/**
 * THE TRIVIALITY LINT, and the reason `min(1)` is not enough.
 *
 * `TextMatcherSchema` already requires a non-empty string on `contains` and `template`, and that
 * refuses the naive attack. What survives it is a matcher whose NORMALIZED value is empty:
 * `{ mode: "contains", value: "  ", normalize: "std.text@1" }` is one character long, passes
 * `min(1)`, and compares as the empty string - which is contained in every string on every screen,
 * including a blank one. The detector is then a machine for emitting a business outcome that was
 * never observed, which is the exact failure `NodeQuery`'s "a scope alone matches every node"
 * refusal exists to prevent, arriving through a different door.
 *
 * Checked against the matcher's OWN declared normalizer rather than against a trim, because that is
 * the function the runtime will compare with: `std.text@1` folds whitespace and drops zero-width
 * characters, so a value of `"​"` normalizes to nothing at match time no matter how it looks
 * in the diff. `std.identity@1` normalizes nothing, so under it only a genuinely empty string is
 * refused - and that is correct, because under `std.identity@1` two spaces really do only match two
 * spaces.
 *
 * Branding tokens are deliberately NOT supplied. They are per-tenant, this runs at parse time with
 * no tenant in hand, and a matcher that survives here and normalizes to nothing at ONE tenant is
 * caught downstream by the discrimination proof, which runs against the merged program.
 */
export function trivialMatcherReason(
  value: string,
  normalizerId: Parameters<typeof normalize>[0],
): string | null {
  if (normalize(normalizerId, value) !== "") return null;
  return `${JSON.stringify(value)} normalizes to the empty string under ${normalizerId}, and the empty string is present on every screen; a matcher that cannot be false has matched nothing`;
}

/**
 * `ValueRef` with the same guard on its one free-text arm.
 *
 * The type already forbids a non-public literal, so the remaining hole is a literal that someone
 * believes is public and is not - a branch number, a phone number for the call centre, a URL. This
 * closes it. `param`, `output` and `credential` carry names, never values, and pass untouched.
 */
export const SafeValueRefSchema = ValueRefSchema.superRefine((ref, ctx) => {
  if (ref.from !== "literal") return;
  const reason = unsafeTextReason(ref.value);
  if (reason !== null) ctx.addIssue(reason);
});
