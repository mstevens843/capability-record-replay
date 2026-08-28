// The substitution table, and the scan that proves it worked.
//
// BRIEF section 3.6 is the load-bearing claim of this whole unit: THE ARTIFACT STORES SHAPES,
// NEVER VALUES. Discovery notices that a concrete value in the flow came from the goal, binds it
// as a typed parameter, and everything downstream refers to the parameter instead. One mechanism
// satisfies "reusable capability", "never persist regulated data", and route canonicalization.
//
// This module is the mechanical half of it, and it is deliberately three small functions rather
// than a policy sprinkled through the emitter:
//
//   · `parameterizeText`  - the only way a recorded string becomes a document string;
//   · `containsBoundValue`- the predicate the emitter asks before it tokenizes any wording;
//   · `findBoundValues`   - an EXHAUSTIVE walk of the finished document, run by the emitter on its
//                           own output before it returns.
//
// The third one is the point. A substitution applied at forty call sites is a substitution somebody
// forgets at the forty-first, and the field it is forgotten at will be the one nobody looks at -
// a fingerprint's accessible name, a step's model-authored prose, a container matcher built from a
// landmark that happens to be labelled with the member number. So the emitter does not trust
// itself: it serializes what it built, walks every key and every string, and refuses to return a
// document in which a recorded value survives. The acceptance test SPEC section 11 asks for is then
// the same function, called by a test rather than by the emitter.
//
// Nothing here ever puts a value in a message. A leak report names the PARAMETER and the JSON path,
// because a report that quoted the value would persist it in the log that reported the persistence.

import type { Sensitivity } from "@crr/core";

/**
 * One concrete value observed during discovery, and the parameter it was bound to.
 *
 * `value` is the only field that must never leave this process. It exists so the emitter can find
 * and replace it; it is never written into a document, a note, or an error message.
 */
export interface ValueBinding {
  readonly param: string;
  readonly value: string;
  /** `{memberId}` - the `template` matcher hole and the substitution's replacement text. */
  readonly placeholder: string;
  readonly sensitivity: Sensitivity;
}

/**
 * The shortest value this module will chase through a document.
 *
 * A one-character value cannot be substituted safely: replacing every "5" in an artifact with
 * `{memberId}` would corrupt a column header, a route and a normalizer id, and the leak scan would
 * report a false positive on every document that ever contains that digit. A parameter that short
 * is reported as unparameterizable by the caller rather than mangled here.
 */
export const MIN_PARAMETERIZABLE_LENGTH = 2;

export function isParameterizable(value: string): boolean {
  return value.trim().length >= MIN_PARAMETERIZABLE_LENGTH;
}

/**
 * Case-insensitive substring search, written as a scan rather than an expression.
 *
 * Two reasons it is not a regular expression. The needle is a value that came off a legacy screen
 * and may contain any punctuation, so it would have to be escaped, and an escaping bug in the
 * function whose entire job is to find regulated data is a silent leak. And SPEC section 5.6 refuses
 * regular expressions over model-supplied text everywhere else in this system for the
 * denial-of-service reason; the module that enforces that rule should not be the exception to it.
 *
 * Case-insensitive because a value typed as `abc123` may be echoed by the application as `ABC123`,
 * and a scan that missed the echo would pass a document that still carries the value.
 */
function indexOfFold(haystack: string, needle: string, from: number): number {
  return haystack.toLowerCase().indexOf(needle.toLowerCase(), from);
}

/** True when `text` contains this binding's value anywhere, in any case. */
export function containsValue(text: string, value: string): boolean {
  if (!isParameterizable(value)) return false;
  return indexOfFold(text, value, 0) >= 0;
}

/** The first binding whose value appears in `text`, or `null`. */
export function bindingIn(text: string, bindings: readonly ValueBinding[]): ValueBinding | null {
  for (const binding of longestFirst(bindings)) {
    if (containsValue(text, binding.value)) return binding;
  }
  return null;
}

/** True when any bound value appears in `text`. The predicate the emitter asks before it turns a
 *  piece of screen wording into a vocabulary token. */
export function containsBoundValue(text: string, bindings: readonly ValueBinding[]): boolean {
  return bindingIn(text, bindings) !== null;
}

/**
 * Longest value first.
 *
 * Without it a binding whose value is a prefix of another's ("5000" and "50001") would consume the
 * shorter match and leave a stray digit behind, and the stray digit is precisely the residue the
 * scan exists to catch.
 */
function longestFirst(bindings: readonly ValueBinding[]): readonly ValueBinding[] {
  return [...bindings].sort((a, b) => b.value.length - a.value.length);
}

/**
 * Every occurrence of every bound value replaced by its parameter hole.
 *
 * This is the ONLY route by which a string observed during discovery becomes a string in a
 * document. Model prose (`Step.intent`, `Step.title`, the goal template), screen wording that
 * becomes a vocabulary synonym, a recorded route, and a recorded node's accessible name all pass
 * through it.
 */
export function parameterizeText(text: string, bindings: readonly ValueBinding[]): string {
  let out = text;
  for (const binding of longestFirst(bindings)) {
    if (!isParameterizable(binding.value)) continue;
    out = replaceAllFold(out, binding.value, binding.placeholder);
  }
  return out;
}

function replaceAllFold(text: string, needle: string, replacement: string): string {
  let out = "";
  let cursor = 0;
  for (;;) {
    const at = indexOfFold(text, needle, cursor);
    if (at < 0) break;
    out += text.slice(cursor, at) + replacement;
    cursor = at + needle.length;
  }
  return out + text.slice(cursor);
}

// ---------------------------------------------------------------------------------------------
// The exhaustive scan
// ---------------------------------------------------------------------------------------------

/** Where a value survived, named without quoting it. */
export interface ValueLeak {
  /**
   * A dotted path into the document: `flow.steps.1.target.recordedNode.name`.
   *
   * PARAMETERIZED, like everything else. When the leak is an object KEY the value IS part of the
   * path, and a report that quoted it would persist the value in the log that reported the
   * persistence - which is the same mistake, one level up. The discrimination suite asserts this.
   */
  readonly path: string;
  /** The parameter whose value was found. The value itself is deliberately absent. */
  readonly param: string;
  /** `key` when the value appeared as an object KEY rather than as a string value - a record keyed
   *  by a member number is a leak the obvious walk misses. */
  readonly position: "key" | "value";
}

/**
 * Every place a bound value survives in a JSON document, keys included.
 *
 * Deliberately structural rather than a scan of the serialized text: a text scan would report the
 * same leak once per occurrence with no way to say WHERE, and the path is what makes the report
 * actionable. Keys are walked because `Record<LabelToken, string[]>` and
 * `SurfaceFingerprint.perStep` are both keyed maps, and a key is exactly the kind of position a
 * substitution written for values forgets about.
 *
 * Numbers are checked too, by their decimal spelling. A member number that reached the document as
 * an integer is still a member number.
 */
export function findBoundValues(
  document: unknown,
  bindings: readonly ValueBinding[],
): readonly ValueLeak[] {
  const leaks: ValueLeak[] = [];
  const relevant = bindings.filter((b) => isParameterizable(b.value));
  if (relevant.length === 0) return leaks;
  walk(document, "", relevant, leaks);
  return leaks.map((leak) => ({ ...leak, path: parameterizeText(leak.path, relevant) }));
}

function walk(
  value: unknown,
  path: string,
  bindings: readonly ValueBinding[],
  leaks: ValueLeak[],
): void {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value);
    const hit = bindingIn(text, bindings);
    if (hit !== null) leaks.push({ path, param: hit.param, position: "value" });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, join(path, String(index)), bindings, leaks));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = join(path, key);
    const hit = bindingIn(key, bindings);
    if (hit !== null) leaks.push({ path: here, param: hit.param, position: "key" });
    walk(child, here, bindings, leaks);
  }
}

function join(prefix: string, segment: string): string {
  return prefix.length === 0 ? segment : `${prefix}.${segment}`;
}

// ---------------------------------------------------------------------------------------------
// Identifier spelling
//
// Two derivations, both from what a person reads on the screen, because that is the only name a
// reviewer of the generated contract will recognise. Neither may ever be derived from a VALUE:
// a parameter called `p50001` would put the member number in the caller's public API.
// ---------------------------------------------------------------------------------------------

const WORD_BOUNDARY = /[^A-Za-z0-9]+/;

function words(label: string): readonly string[] {
  return label
    .split(WORD_BOUNDARY)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * A screen label as a field name: "Member ID" becomes `memberId`, "Share Balance" becomes
 * `shareBalance`. The grammar is `FieldNameSchema`'s, so the result is a legal property name in the
 * types generated for the calling agent.
 */
export function fieldNameOf(label: string, fallback: string): string {
  const parts = words(label);
  if (parts.length === 0) return fallback;
  const head = (parts[0] as string).toLowerCase();
  const tail = parts
    .slice(1)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
  const joined = head + tail.join("");
  const cleaned = joined.replace(/[^A-Za-z0-9_]/g, "");
  if (cleaned.length === 0 || !/^[a-z]/.test(cleaned)) return fallback;
  return cleaned.slice(0, 64);
}

/**
 * A screen label as a `LabelToken`: "Member ID" becomes `member-id`.
 *
 * The token is the multi-tenant hinge (SPEC section 9.3). It is a SYMBOLIC name - the tenant's
 * actual wording lives in `flow.vocabulary` and an overlay replaces it - so the token grammar is
 * deliberately narrower than the wording it stands for.
 */
export function labelTokenOf(label: string, fallback: string): string {
  const parts = words(label).map((part) => part.toLowerCase());
  if (parts.length === 0) return fallback;
  const joined = parts.join("-");
  if (!/^[a-z]/.test(joined)) return `t-${joined}`.slice(0, 64);
  return joined.slice(0, 64);
}

/** A lowercase slug for an identifier a person will read in a diff: a step id, a route id. */
export function slugOf(text: string, fallback: string): string {
  const parts = words(text).map((part) => part.toLowerCase());
  if (parts.length === 0) return fallback;
  const joined = parts.join("-");
  return /^[a-z0-9]/.test(joined) ? joined.slice(0, 64) : `s-${joined}`.slice(0, 64);
}

/** `name`, `name-2`, `name-3`... The caller owns the set, so two derivations that collapse to the
 *  same spelling stay distinguishable instead of silently overwriting one another. */
export function uniqueName(candidate: string, taken: Set<string>, separator = "-"): string {
  if (!taken.has(candidate)) {
    taken.add(candidate);
    return candidate;
  }
  for (let n = 2; n < 1000; n += 1) {
    const next = `${candidate}${separator}${n}`;
    if (!taken.has(next)) {
      taken.add(next);
      return next;
    }
  }
  throw new Error(`cannot find a free spelling for ${candidate}`);
}
