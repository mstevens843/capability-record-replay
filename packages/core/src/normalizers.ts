// The normalizer registry (SPEC section 2.1).
//
// A normalizer decides when two pieces of text off a screen mean the same thing. That makes it a
// security-relevant function, not a string utility: it is what stands between "the banner says
// NO MEMBER ON FILE" and the caller being told `MEMBER_NOT_FOUND`, and between one tenant's
// "Search" and another's "Riverbend Search". Loosen one of these and a detector starts firing on
// text it was never meant to match; tighten one and an approved artifact silently stops matching
// at a tenant it used to work at.
//
// So they are named, versioned, and frozen. `test/registry-stability.test.ts` fails if the
// behaviour of any function here changes without the major in its id changing.

import type { NormalizerId } from "./primitives.js";

/**
 * Extra inputs a normalizer may need that are not part of the text.
 *
 * `brandingTokens` comes from the tenant's overlay, never from the registry. Baking "riverbend"
 * into `std.label@1` would make the engine's behaviour tenant-specific, which is exactly the thing
 * SPEC section 9 puts in an overlay so that it is reviewable per tenant and diffable in isolation.
 */
export interface NormalizerContext {
  readonly brandingTokens?: readonly string[];
}

export type NormalizerFn = (input: string, ctx: NormalizerContext) => string;

/**
 * Zero-width and word-joiner characters, removed before whitespace handling.
 *
 * These arrive from copy-pasted labels and from legacy templates, they are invisible to the person
 * approving the artifact, and they are not matched by `\s` (except U+FEFF). Removing them first
 * matters: leaving U+FEFF to be caught by the whitespace pass would turn a byte-order mark in the
 * middle of a word into a word break.
 */
const INVISIBLE = /\u200B|\u200C|\u200D|\u2060|\uFEFF/g;

/** Remove the invisible formatting characters above. Shared so there is one definition of
 *  "characters that are not really there" across every text-handling function in this package. */
export function stripInvisible(input: string): string {
  return input.replace(INVISIBLE, "");
}

/**
 * `std.text@1`: NFC, drop invisibles, fold every run of whitespace to one space, trim, lowercase.
 *
 * NFC is here because the same visible label reaches us in two encodings from two drivers - an
 * accessibility tree may report a precomposed U+00F6 where a character grid reports o + U+0308 -
 * and without it a token match succeeds at one surface and fails at the other with nothing to see
 * in the diff.
 *
 * The whitespace fold treats U+00A0 as a space (it is in `\s`), which is not cosmetic: a legacy
 * server-rendered app emits non-breaking spaces constantly, and "Member ID" with one of them in
 * the middle is the same label to every human who will ever review this artifact.
 *
 * "Case-fold" here is `toLowerCase`, i.e. Unicode *simple* lowercase. Full case folding would map
 * the German sharp s to "ss"; we do not, because full folding needs a table this package would
 * have to vendor and pin, and simple lowercase is what every surface driver will also have applied
 * if it applies anything.
 */
export function stdText(input: string): string {
  return stripInvisible(input.normalize("NFC")).replace(/\s+/g, " ").trim().toLowerCase();
}

/** Trailing label decoration: the colon, period and underscore SPEC section 2.1 names. */
const TRAILING_LABEL_CHARS = new Set([":", ".", "_", " "]);

function stripTrailingLabelChars(s: string): string {
  let end = s.length;
  while (end > 0 && TRAILING_LABEL_CHARS.has(s[end - 1] as string)) end--;
  return s.slice(0, end);
}

/**
 * Remove every contiguous run of words equal to a branding token.
 *
 * Word-sequence removal rather than substring removal, and that choice has teeth: `"summit"`
 * removed as a substring from `"summit account summary"` also eats the word it is a prefix of in
 * some tenant's vocabulary, and the failure mode is a label that normalizes to something no
 * detector matches, at one tenant, at replay time. Whole words can only remove whole words.
 *
 * Multi-word tokens work by the same rule, which is why this operates on an array rather than a
 * string: "river bend bank" removes those three words in that order and nothing else.
 */
function removeBrandingRuns(words: readonly string[], tokens: readonly string[]): string[] {
  let current = [...words];
  for (const token of tokens) {
    const needle = stdText(token)
      .split(" ")
      .filter((w) => w.length > 0);
    if (needle.length === 0) continue;
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i + needle.length <= current.length; i++) {
        if (needle.every((w, k) => current[i + k] === w)) {
          current = [...current.slice(0, i), ...current.slice(i + needle.length)];
          changed = true;
          break;
        }
      }
    }
  }
  return current;
}

/**
 * `std.label@1`: `std.text@1`, then strip trailing `:` `.` `_`, then strip the tenant's branding
 * tokens, then strip trailing decoration again.
 *
 * The second strip is not redundant: removing a trailing branding word exposes punctuation that
 * was in the middle of the string a moment ago, so "Member ID: Riverbend" ends as "member id"
 * rather than "member id:".
 *
 * Only the three characters SPEC section 2.1 names are stripped. A trailing hyphen is left alone,
 * so "Balance - Riverbend" normalizes to "balance -", and that is on purpose: a hyphen carries
 * meaning inside a label ("Sub-Account") and a normalizer that eats punctuation on suspicion is a
 * normalizer that makes two different labels equal.
 */
export function stdLabel(input: string, ctx: NormalizerContext): string {
  const base = stripTrailingLabelChars(stdText(input));
  const words = base.length === 0 ? [] : base.split(" ");
  const kept = removeBrandingRuns(words, ctx.brandingTokens ?? []);
  return stripTrailingLabelChars(kept.join(" "));
}

/**
 * `std.money@1`: strip whitespace, the dollar sign and a `USD` marker, thousands separators, and
 * translate the three ways a banking screen writes a negative into a leading minus.
 *
 * Two refusals worth naming, both fail-closed:
 *
 *   - Only `$` and `USD` are stripped. A euro sign is left in place, so `EUR 10,00` normalizes to
 *     something `moneyUSD@1` refuses rather than to a `10` this schema would label USD. The
 *     currency is not a formatting detail.
 *   - Commas are removed only from a string that is *entirely* a correctly grouped number:
 *     `1,234.56` yes, `10,00` no. A comma-decimal locale and a comma-thousands locale disagree
 *     about what `10,00` means by a factor of a hundred, and nothing in the string says which one
 *     produced it - so the comma is left in place and `moneyUSD@1` refuses the value rather than
 *     reporting a balance a hundred times too large.
 *
 * This function normalizes; it does not validate. `std.money@1` applied to "n/a" returns "n/a",
 * and it is `moneyUSD@1` that refuses it.
 */
export function stdMoney(input: string): string {
  const compact = stripInvisible(input.normalize("NFC")).replace(/\s+/g, "");
  let s = compact;
  let negative = false;

  // Accounting parentheses. Any negative marker makes the value negative; they never cancel.
  if (s.length >= 2 && s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/^usd/i.test(s)) s = s.slice(3);
  if (/usd$/i.test(s)) s = s.slice(0, -3);
  s = s.split("$").join("");

  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  // A trailing minus is how COBOL-era reports and green screens print a debit.
  if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1);
  }
  // Only a fully and correctly grouped number gives up its commas; see the doc comment.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.split(",").join("");

  return negative && s.length > 0 ? `-${s}` : s;
}

/**
 * `std.identity@1`: the input, byte for byte.
 *
 * It exists so that "compare these exactly" is something an artifact can *say*, rather than
 * something it gets by omitting a field. A confirmation code or a case-sensitive account
 * designator must not be folded, and an author who leaves `normalize` off a matcher should be
 * making that choice on purpose.
 */
export function stdIdentity(input: string): string {
  return input;
}

export const NORMALIZERS: Readonly<Record<NormalizerId, NormalizerFn>> = {
  "std.text@1": (input) => stdText(input),
  "std.label@1": (input, ctx) => stdLabel(input, ctx),
  "std.money@1": (input) => stdMoney(input),
  "std.identity@1": (input) => stdIdentity(input),
};

/** Apply a registered normalizer. Total: every id in the union has an implementation. */
export function normalize(id: NormalizerId, input: string, ctx: NormalizerContext = {}): string {
  return NORMALIZERS[id](input, ctx);
}
