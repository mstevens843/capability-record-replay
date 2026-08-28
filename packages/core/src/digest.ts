// Content addressing. `sha256:` over the JCS form of a document.
//
// This is the mechanism SPEC section 3.9 rests on: an approved artifact cannot be silently edited,
// because approval signs the digest and the linker recomputes it (section 10 check 2). Everything
// in this file is a pure function of its argument, so a reviewer can reproduce any digest in
// `evidence/` from the document alone.

import { canonicalJson } from "./canonical-json.js";
import { sha256 } from "./hash/sha256.js";
import { DIGEST_PATTERN, type Digest } from "./primitives.js";

export const DIGEST_PREFIX = "sha256:";

/**
 * The fields a document's own digest is taken *over the absence of*.
 *
 * A document carries its digest inside itself, so the digest cannot be computed over the document
 * including that field - it would have to contain its own hash. Signatures are excluded for the
 * same reason plus a stronger one: they are taken over the digest, so including them would make
 * the digest change every time another approver signs, invalidating the first signature.
 */
export const SELF_REFERENTIAL_FIELDS: readonly string[] = ["digest", "signatures"];

export function isDigest(value: string): value is Digest {
  return DIGEST_PATTERN.test(value);
}

/** The digest of any JSON value. Throws `CanonicalJsonError` if the value is not canonicalizable. */
export function digestOf(value: unknown): Digest {
  return `${DIGEST_PREFIX}${sha256(canonicalJson(value))}` as Digest;
}

/**
 * The digest of a document as it will be written to disk: computed with the self-referential
 * fields removed, at the top level only.
 *
 * Top level only, and deliberately. A nested `digest` field is a *reference to another document* -
 * `implements.contractDigest`, `provenance.transcriptRef.digest` - and those must contribute,
 * because "which contract does this artifact implement" is exactly the kind of edit the signature
 * exists to catch.
 */
export function documentDigest(document: Readonly<Record<string, unknown>>): Digest {
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (SELF_REFERENTIAL_FIELDS.includes(key)) continue;
    stripped[key] = value;
  }
  return digestOf(stripped);
}

/** True when a document's stored `digest` field matches its content. */
export function documentDigestMatches(document: Readonly<Record<string, unknown>>): boolean {
  const stored = document.digest;
  return typeof stored === "string" && stored === documentDigest(document);
}

/**
 * Combine several digests into one, for `effectiveDigest = f(artifactDigest, overlayDigest,
 * linkerVersion)` (SPEC section 9.2).
 *
 * The spec writes that as concatenation. This hashes the canonical JSON of the *array* instead,
 * which is a deliberate tightening: `a || b || c` has no delimiter, so a different split of the
 * same character sequence produces the same input, and "which bytes actually ran" is precisely the
 * question this value exists to answer in a postmortem. An array has an unambiguous encoding.
 *
 * `null` is accepted as a member because an artifact may legitimately have no overlay, and
 * `[a, null, v]` must not collide with a two-element combination.
 */
export function combineDigests(parts: readonly (string | null)[]): Digest {
  return digestOf(parts);
}
