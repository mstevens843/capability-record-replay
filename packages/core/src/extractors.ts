// The extractor registry (SPEC section 2.1, used by `ExtractSpec` in section 2.4).
//
// An extractor says *which field of a resolved node* carries the value. It does not search - the
// node has already been chosen by `NodeQuery`, with a quorum behind it - and it does not interpret;
// that is the parser's job. Keeping the three apart is what makes "we read the wrong cell" and "we
// misread the right cell" two different bugs with two different fixes.
//
// Reading is a pure function over an `Observation`, which is why there is no `read` action on the
// `Surface` port: extraction never touches the surface and is testable from a frozen snapshot.

import { stripInvisible } from "./normalizers.js";
import type { ExtractorId } from "./primitives.js";

/**
 * The fields of a resolved node an extractor may read.
 *
 * A structural subset of `UINode` rather than the node itself, so this registry does not depend on
 * the port types - and so the registry's behaviour digest is a function of a small, stable shape
 * instead of every field a driver might add later.
 */
export interface ExtractorSource {
  readonly name: string;
  readonly value: string | null;
  readonly text: string | null;
}

/** `null` means "this node has no such value", which `ExtractSpec.onMissing` then decides about. */
export type ExtractorFn = (source: ExtractorSource) => string | null;

/**
 * Blank is missing.
 *
 * A whitespace-only cell is not a value, and reporting `""` as a balance is how a member gets told
 * their savings account holds nothing. `onMissing: "null"` exists for the case where absence is a
 * legitimate answer; the default is `"fail"`, and this is what routes there.
 */
function blankToNull(v: string | null): string | null {
  if (v === null) return null;
  const trimmed = stripInvisible(v).trim();
  return trimmed.length === 0 ? null : v;
}

export const EXTRACTORS: Readonly<Record<ExtractorId, ExtractorFn>> = {
  /** The node's own text content. */
  "text@1": (s) => blankToNull(s.text),
  /** A form control's current value. */
  "value@1": (s) => blankToNull(s.value),
  /** The accessible name - the label, on a browser; the detected caption, on a character grid. */
  "name@1": (s) => blankToNull(s.name),
  /**
   * A table cell's content: its value if the surface reports one, otherwise its text.
   *
   * Deliberately never the accessible name. On a table-based legacy layout a cell's computed name
   * is frequently its column header, so a `name` fallback here would return the string "Share
   * Balance" where a balance was asked for - a value that is the right type, the right shape, and
   * completely wrong. Returning `null` instead sends it to `output-extraction-failed`.
   */
  "cell@1": (s) => blankToNull(s.value) ?? blankToNull(s.text),
};

/** Apply a registered extractor. Total: every id in the union has an implementation. */
export function extract(id: ExtractorId, source: ExtractorSource): string | null {
  return EXTRACTORS[id](source);
}
