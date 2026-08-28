// JCS (RFC 8785) canonical JSON serialization.
//
// WHY a canonical form at all: the artifact is content-addressed and an approval signature is
// taken over that address (SPEC section 3.9, section 10 check 2). "The approver signed these
// bytes" is only a useful claim if two honest parties who agree about the document also agree
// about the bytes. `JSON.stringify` does not give that - key order follows insertion order, so a
// document that round-tripped through a different tool serializes differently and the signature
// stops verifying for no semantic reason.
//
// JCS was chosen over "JSON.stringify with sorted keys" because it is a published specification
// with published test vectors, so a reviewer in another language can reproduce our digests without
// reading our code. That matters here: the digest crosses a trust boundary.
//
// The implementation is deliberately narrower than RFC 8785 requires in one place - it refuses
// lone surrogates rather than escaping them - and that refusal is explained at `escapeString`.

/** The JSON value domain. Exported for callers that want to be explicit about the input. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Depth ceiling. The deepest thing in this schema is a `Predicate`, which the linker caps at 4
 * (SPEC section 10 check 18), so 64 is far past anything legitimate. It exists so a malformed or
 * hostile document cannot turn canonicalization into a stack overflow - a model authors these
 * documents, which makes them untrusted input to everything downstream.
 */
export const MAX_CANONICAL_DEPTH = 64;

export class CanonicalJsonError extends Error {
  /** Where in the value the problem is, as a `$.a.b[0]` path. Included because these errors are
   *  read while staring at a 400-line artifact, and "not canonicalizable" alone is useless. */
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path})`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

/**
 * RFC 8785 section 3.2.2.2 string escaping.
 *
 * Only the two mandatory escapes (`"` and `\`), the five short control escapes, and `\u00xx` for
 * the remaining C0 controls. Everything else - including U+007F, non-ASCII, and astral characters
 * - is emitted literally as UTF-8. That is the whole rule; there is no ASCII-safe mode, because a
 * canonical form with an option is not a canonical form.
 *
 * Lone surrogates throw instead of being escaped. RFC 8785's input domain is valid Unicode, and
 * our UTF-8 encoder (like every other one) maps a lone surrogate to U+FFFD - so two distinct
 * ill-formed strings would hash to the same digest. A canonicalizer whose job is to make equality
 * of documents decidable must not make two different documents equal.
 */
function escapeString(s: string, path: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);

    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalJsonError(
          `unpaired high surrogate U+${c.toString(16).toUpperCase()}`,
          path,
        );
      }
      out += s[i] as string;
      out += s[i + 1] as string;
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      throw new CanonicalJsonError(
        `unpaired low surrogate U+${c.toString(16).toUpperCase()}`,
        path,
      );
    }

    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += s[i] as string;
  }
  return `${out}"`;
}

/**
 * RFC 8785 section 3.2.2.3 number serialization: the ECMAScript `Number::toString` form, which is
 * the shortest representation that round-trips. `String(n)` is that algorithm, and it already
 * folds -0 to "0".
 *
 * Non-finite values throw rather than becoming `null` the way `JSON.stringify` does. `NaN` and
 * `Infinity` in a bank artifact are a defect upstream, and silently writing `null` into the bytes
 * an approval is signed over is the worst available way to report it.
 */
function serializeNumber(n: number, path: string): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalJsonError(`non-finite number ${String(n)}`, path);
  }
  return String(n);
}

/**
 * Canonicalize a JSON value to its RFC 8785 form.
 *
 * Accepts `unknown` rather than `JsonValue` on purpose: every caller here hands it a validated
 * document whose optional fields are typed `T | undefined`, which is not assignable to `JsonValue`
 * without a cast at every call site. The value is fully validated at runtime anyway - that is what
 * this function is for - so a compile-time type that only forces casts buys nothing.
 *
 * Rejected: `undefined` and holes inside arrays, `bigint`, functions, symbols, non-finite numbers,
 * class instances (including dates, maps and sets), cycles, and lone surrogates.
 *
 * Accepted with a documented rule: an object property whose value is `undefined` is omitted,
 * matching `JSON.stringify`, so `{ frame: undefined }` and `{}` are the same document. An
 * `undefined` inside an *array* is refused instead, because `JSON.stringify` turns it into `null`
 * and that would make a hole and an explicit null collide.
 */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();

  const walk = (v: unknown, depth: number, path: string): string => {
    if (depth > MAX_CANONICAL_DEPTH) {
      throw new CanonicalJsonError(`nests deeper than ${MAX_CANONICAL_DEPTH} levels`, path);
    }

    if (v === null) return "null";

    const t = typeof v;
    if (t === "string") return escapeString(v as string, path);
    if (t === "number") return serializeNumber(v as number, path);
    if (t === "boolean") return v === true ? "true" : "false";
    if (t === "bigint") throw new CanonicalJsonError("bigint: serialize it as a string", path);
    if (t === "undefined") throw new CanonicalJsonError("undefined", path);
    if (t === "function" || t === "symbol") throw new CanonicalJsonError(t, path);

    const obj = v as object;
    if (seen.has(obj)) throw new CanonicalJsonError("circular reference", path);
    seen.add(obj);
    try {
      if (Array.isArray(v)) {
        const parts: string[] = [];
        for (let i = 0; i < v.length; i++) {
          const item = v[i];
          if (item === undefined) {
            // Covers both an explicit `undefined` and a sparse hole; `JSON.stringify` writes
            // `null` for both, which would make three distinct inputs share one digest.
            throw new CanonicalJsonError("undefined or hole in an array", `${path}[${i}]`);
          }
          parts.push(walk(item, depth + 1, `${path}[${i}]`));
        }
        return `[${parts.join(",")}]`;
      }

      const proto = Object.getPrototypeOf(obj) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        // A class instance may define `toJSON`, which means its serialization is decided somewhere
        // this function cannot see. That is precisely the drift a canonical form exists to remove.
        const name = (obj.constructor as { name?: string } | undefined)?.name ?? "unknown";
        throw new CanonicalJsonError(`non-plain object (${name}): use a plain JSON value`, path);
      }

      const rec = v as Record<string, unknown>;
      // RFC 8785 section 3.2.3 sorts property names by their UTF-16 code units, which is exactly
      // what the default `Array.prototype.sort` comparator does for strings. Note the consequence
      // the RFC calls out and test/canonical-json.test.ts pins: an astral character sorts by its
      // leading surrogate (0xD800..0xDBFF) and therefore lands *before* U+E000..U+FFFF, not after.
      const keys = Object.keys(rec).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const child = rec[k];
        if (child === undefined) continue;
        parts.push(`${escapeString(k, path)}:${walk(child, depth + 1, `${path}.${k}`)}`);
      }
      return `{${parts.join(",")}}`;
    } finally {
      seen.delete(obj);
    }
  };

  return walk(value, 0, "$");
}

/**
 * Find the first non-integer number anywhere in a value, returning its path, or `null`.
 *
 * Enforcement arm of the schema's flat prohibition on IEEE-754 (SPEC section 2.1): money is a
 * `Decimal` string and every other number in the schema is an integer - milliseconds, counts,
 * indices, cells, pixels. The type system states that; this makes it checkable at a boundary,
 * which is what the linker and the artifact validator need for a document a model authored.
 *
 * Kept separate from `canonicalJson` deliberately. Canonicalization must stay a faithful RFC 8785
 * implementation so our digests are reproducible by any other conforming implementation; a
 * schema-specific rejection belongs in the validator that owns the schema, not in the shared
 * serializer.
 */
export function findNonIntegerNumber(value: unknown): string | null {
  const walk = (v: unknown, depth: number, path: string): string | null => {
    if (depth > MAX_CANONICAL_DEPTH || v === null) return null;
    if (typeof v === "number") return Number.isInteger(v) ? null : path;
    if (typeof v !== "object") return null;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const hit = walk(v[i], depth + 1, `${path}[${i}]`);
        if (hit !== null) return hit;
      }
      return null;
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const hit = walk(child, depth + 1, `${path}.${k}`);
      if (hit !== null) return hit;
    }
    return null;
  };
  return walk(value, 0, "$");
}
