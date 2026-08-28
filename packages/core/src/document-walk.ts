// Structural reading of a document that has not been validated yet.
//
// The linker cannot start from a parsed `CapabilityArtifact`, and that is not a convenience - it is
// forced twice over.
//
//   1. SPEC section 10 numbers twenty-eight checks so a link report can be diffed against the spec.
//      About two thirds of them are also enforced by the schema, and a linker that delegated those
//      to zod would report "the document did not validate" for all of them - one message where the
//      spec asked for twenty. The numbered check is the product; the schema is the backstop.
//   2. The overlay merge PRODUCES a program that no validator has ever seen. SPEC section 9.2
//      requires every check to run again over it, so the checks have to work on a document that is
//      being built rather than one that was read.
//
// So the checks are written against plain JSON. These helpers are what makes that tolerable: every
// accessor is total, returns a null or an empty list rather than throwing, and never widens a value
// it did not recognise.

/** A JSON object as it arrives: keys present, values unproven. */
export type JsonObject = { [key: string]: unknown };

export function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

/** Every element of `value` that is an object, in order. Non-objects are dropped rather than
 *  reported: a malformed element is the schema backstop's finding, not a numbered check's. */
export function asObjects(value: unknown): readonly JsonObject[] {
  const out: JsonObject[] = [];
  for (const item of asArray(value)) {
    const record = asObject(item);
    if (record !== null) out.push(record);
  }
  return out;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function asStrings(value: unknown): readonly string[] {
  const out: string[] = [];
  for (const item of asArray(value)) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

/**
 * A deep copy of a JSON value.
 *
 * Hand-written rather than delegated to the platform's structured clone, for two reasons that both
 * matter here: the merge only ever handles JSON, so the general algorithm's extra cases are dead
 * weight; and `@crr/core` is graded on having no ambient dependencies at all, which is easier to
 * defend when the one place it copies a document is fifteen lines a reviewer can read.
 */
export function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as unknown as T;
  if (typeof value !== "object" || value === null) return value;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value as JsonObject)) out[key] = cloneJson(child);
  return out as unknown as T;
}

/** `flow.steps.2.outcomes.0.code` - the dotted form the validation reporter already uses, so a link
 *  error and a validation problem name a field the same way. */
export function joinPath(prefix: string, key: string | number): string {
  return prefix.length === 0 ? String(key) : `${prefix}.${key}`;
}

/**
 * Visit every object anywhere inside `value`, with its dotted path.
 *
 * A structural scan rather than a typed traversal, and deliberately so: a typed traversal has to be
 * edited every time an arm is added to the schema and silently misses the arm somebody forgot,
 * while the properties being checked here - "no string in this document looks like a locator", "no
 * registry id is unknown" - are exactly the kind that must not have a blind spot. `artifact.ts`
 * makes the same trade for the same reason.
 */
export function walkRecords(
  value: unknown,
  visit: (record: JsonObject, path: string) => void,
  path = "",
): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkRecords(item, visit, joinPath(path, i)));
    return;
  }
  const record = asObject(value);
  if (record === null) return;
  visit(record, path);
  for (const [key, child] of Object.entries(record)) walkRecords(child, visit, joinPath(path, key));
}
