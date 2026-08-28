// SPEC section 8.3 - the taint model.
//
// Redaction is not a log filter applied at the end. A filter has to be remembered at every sink,
// and the one sink somebody forgets is the one that ends up in evidence. This is the other
// approach: the value is boxed at bind time and the box is what everything downstream holds, so
// forgetting is the SAFE direction. `String(handle)`, `${handle}`, `JSON.stringify(handle)`,
// `console.log(handle)` and `{...handle}` all yield an opaque `taint:<param>-<n>` and nothing else;
// getting the value out requires naming a sink, and two sinks out of nine accept one.
//
// That inversion is the whole design. SPEC section 8.3 says the value reaches exactly two places -
// the driver's `Action.type.text` (with `sensitive: true`, so the driver masks its region) and the
// caller's typed `ReplayOk.outputs` - and reaches none of the artifact, the journal, an evidence
// capture, a classifier trace, a VCR transcript or a model-facing tool result. Here those nine
// destinations are a table rather than a paragraph, and `revealTainted` is the only door.
//
// The redaction canary test (a run with a distinctive value, then a grep of the whole evidence
// tree) is the empirical half of this claim and is unit 18's. This file is what makes the canary
// likely to stay green as the code grows: a new sink has to be added to `TAINT_SINKS` and argued
// for in a comment before a value can reach it.

import { type TaintHandle, TaintHandleSchema } from "./policy.js";

// ---------------------------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------------------------

/** `taint:` + the parameter name + `-` + an ordinal. The parameter name is safe to carry: it is
 *  schema vocabulary, authored by whoever wrote the contract, and it is what makes a journal line
 *  or a policy denial legible without carrying a member number. Field names cannot contain `-`
 *  (see `FieldNameSchema`), so the last `-` is an unambiguous separator. */
const HANDLE_PARAM = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Mint a handle for the n-th binding of `param` in a run.
 *
 * The ordinal is an argument rather than a counter in this module because `@crr/core` has no
 * clock, no randomness and no mutable run state; the interpreter owns the sequence. Two bindings
 * of the same parameter in one run therefore get distinguishable handles without this file
 * remembering anything.
 */
export function mintTaintHandle(param: string, ordinal: number): TaintHandle {
  if (!HANDLE_PARAM.test(param)) {
    throw new TaintViolationError(
      `"${param}" is not a parameter name; a taint handle names the binding, never the value`,
    );
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new TaintViolationError(`a taint ordinal is a positive integer, not ${ordinal}`);
  }
  return TaintHandleSchema.parse(`taint:${param}-${ordinal}`);
}

/** The parameter a handle names. The policy engine uses this to answer "is the value this step is
 *  about to type one of the tainted ones?" without ever holding a value. */
export function taintParamOf(handle: TaintHandle): string {
  const body = handle.slice("taint:".length);
  const cut = body.lastIndexOf("-");
  return cut === -1 ? body : body.slice(0, cut);
}

// ---------------------------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------------------------

/**
 * Every destination a bound value could plausibly reach, and whether it may.
 *
 * Written as data with a reason attached because the reason is the part that gets lost. A boolean
 * table invites "surely the journal is fine, it's internal"; a table that has to be edited, with a
 * sentence explaining why the entry says what it says, does not.
 */
export const TAINT_SINKS = {
  /** SPEC 8.3, sink 1 of 2. The driver needs the text to type it, and is told `sensitive: true` so
   *  it masks the field's region before any bytes exist. */
  "surface-action": { allowed: true, why: "the driver types it and masks the field's region" },
  /** SPEC 8.3, sink 2 of 2. The calling PROGRAM asked for this value; withholding it from the
   *  typed result would make the capability useless. The MODEL's view is a different sink. */
  "caller-output": { allowed: true, why: "the calling program's own typed outputs" },

  "agent-result": {
    allowed: false,
    // A tool result is itself a persisted artifact: it lands in the provider transcript and in the
    // agent's conversation history. `OutputSpec.agentDisclosure` governs what the model sees, and
    // `renderForAgent` applies it - reading it out of the box here would route around that.
    why: "a tool result is a third-party transcript; OutputSpec.agentDisclosure governs it",
  },
  journal: { allowed: false, why: "the journal is the audit trail, and it is kept" },
  artifact: { allowed: false, why: "an artifact stores shapes, never values (SPEC 3.6)" },
  overlay: { allowed: false, why: "an overlay is a committed per-tenant document" },
  "evidence-capture": {
    allowed: false,
    why: "a capture is written to disk and shipped in evidence",
  },
  "classifier-trace": {
    allowed: false,
    // An ExpectationTrace is rendered into an intervention brief and into a failure report, both of
    // which a human reads in a console and a log aggregator keeps.
    why: "an expectation trace is rendered into briefs, reports and logs",
  },
  "vcr-transcript": { allowed: false, why: "a recorded transcript is a committed fixture" },
  log: { allowed: false, why: "a log line is the sink nobody remembers to audit" },
} as const satisfies Readonly<Record<string, { readonly allowed: boolean; readonly why: string }>>;

export type TaintSink = keyof typeof TAINT_SINKS;

/** Raised when a tainted value is asked for by a sink that may not have it, or when a handle is
 *  minted from something that is not a parameter name. Loud on purpose: this is a control failing,
 *  not a condition to classify, and it must not be mistaken for one. */
export class TaintViolationError extends Error {
  override readonly name = "TaintViolationError";
}

// ---------------------------------------------------------------------------------------------
// The box
// ---------------------------------------------------------------------------------------------

/** `nodejs.util.inspect.custom`, spelled as a well-known symbol lookup rather than imported, so
 *  that this file stays free of any runtime import and the purity scan has nothing to find. A host
 *  that does not implement it simply never calls it - and `toString` still covers that host. */
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Set by the class's static block below; the only reader of `#value` in the program. */
let readTainted: (v: TaintedValue) => string;

/**
 * A value bound to a `sensitive` parameter, boxed.
 *
 * The four escape routes a value normally takes out of a program are all closed, and closed the
 * same way - by returning the handle:
 *
 *   · `String(v)` / `` `${v}` `` / `v + ""`  → `Symbol.toPrimitive`
 *   · `JSON.stringify(v)`                    → `toJSON`
 *   · `console.log(v)` on Node               → the inspect symbol
 *   · `{ ...v }` / `Object.keys(v)`          → the value lives in a `#private` field
 *
 * `structuredClone` does not carry a `#private` field either: it yields a plain object with the
 * handle and no value, and `isTainted` says false about it - a copy of the box is visibly not the
 * box.
 *
 * Note what this class does NOT claim. A determined caller can still call `revealTainted` with the
 * wrong sink argument, and nothing here stops a driver from writing the text it was handed to a
 * log. The claim is narrower and worth more: leaking now requires a deliberate, greppable,
 * reviewable line of code, instead of happening whenever somebody interpolates a variable.
 */
export class TaintedValue {
  /** Assigned once, from inside the class body, because `#value` is reachable from nowhere else.
   *  `revealTainted` closes over it; nothing outside this module can. */
  static {
    readTainted = (v: TaintedValue): string => v.#value;
  }

  readonly handle: TaintHandle;
  readonly param: string;
  /** The length of the value. Safe by construction and genuinely needed: the model-facing
   *  projection renders `value=<masked:12>` (SPEC 6.2), and "the field truncated what we typed" is
   *  a real failure that is invisible without it. */
  readonly length: number;
  readonly #value: string;

  private constructor(handle: TaintHandle, param: string, value: string) {
    this.handle = handle;
    this.param = param;
    this.length = value.length;
    this.#value = value;
    Object.freeze(this);
  }

  /** The only constructor. Named for what it is so that `grep -rn bindSensitive` is a complete
   *  list of the places a regulated value enters the system. */
  static bind(param: string, value: string, ordinal: number): TaintedValue {
    return new TaintedValue(mintTaintHandle(param, ordinal), param, value);
  }

  toString(): string {
    return this.handle;
  }

  toJSON(): string {
    return this.handle;
  }

  [Symbol.toPrimitive](_hint: string): string {
    // Every hint, including "number": `Number(handle)` is then NaN rather than the member number,
    // and arithmetic on a tainted value fails loudly instead of silently unwrapping it.
    return this.handle;
  }

  get [Symbol.toStringTag](): string {
    return "TaintedValue";
  }

  [INSPECT](): string {
    return `[TaintedValue ${this.handle} length=${this.length}]`;
  }
}

/** Bind a value to a sensitive parameter. This is where a regulated value enters the system and
 *  the last place a raw string is legal above the driver. */
export function bindSensitive(param: string, value: string, ordinal: number): TaintedValue {
  return TaintedValue.bind(param, value, ordinal);
}

export function isTainted(value: unknown): value is TaintedValue {
  return value instanceof TaintedValue;
}

/**
 * Take the value out, naming the sink that wants it.
 *
 * The sink is a required argument rather than an optional one because the default would be the
 * bug: an `unwrap()` with no argument is what every leak looks like in the commit that introduced
 * it. Refusal throws rather than returning a masked string - a sink that is not allowed to see a
 * value is not allowed to see a plausible-looking substitute either, and a silent substitution is
 * how "the field was filled with `<masked:5>`" reaches production.
 */
export function revealTainted(value: TaintedValue, sink: TaintSink): string {
  const rule = TAINT_SINKS[sink];
  if (!rule.allowed) {
    throw new TaintViolationError(`${value.handle} may not reach the "${sink}" sink: ${rule.why}`);
  }
  return readTainted(value);
}

/** What the model-facing projection and the operator console show instead of a value: SPEC 6.2's
 *  `value=<masked:12>`. Length only, and length is already on the box. */
export function maskedLabel(value: TaintedValue): string {
  return `<masked:${value.length}>`;
}

/** The journal's view of a binding: SPEC 8.3's `{ output, sensitivity, present }` shape, for the
 *  parameter side. Never the value, and deliberately not even the masked label - a length in an
 *  audit trail is a length in an audit trail forever. */
export function describeTainted(value: TaintedValue): {
  readonly handle: TaintHandle;
  readonly param: string;
  readonly present: boolean;
} {
  return { handle: value.handle, param: value.param, present: value.length > 0 };
}

/**
 * Replace every `TaintedValue` in a structure with its handle, recursively.
 *
 * `JSON.stringify` already does this via `toJSON`, so this exists for the sinks that do NOT go
 * through JSON: a structured log call, an object handed to a formatter, a record built for the
 * journal writer before it is validated. Cycles are refused rather than tolerated - a cyclic
 * object about to be logged is a bug of its own, and returning a partial copy would hide it.
 */
export function redactDeep(value: unknown, seen: ReadonlySet<object> = new Set()): unknown {
  if (isTainted(value)) return value.handle;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) {
    throw new TaintViolationError("cannot redact a cyclic structure; flatten it before logging");
  }
  const next = new Set(seen).add(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, next));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactDeep(item, next);
  return out;
}

/** The handles for a set of bindings, in the shape `PolicyContext.taint` wants. */
export function taintHandlesOf(values: readonly TaintedValue[]): readonly TaintHandle[] {
  return values.map((v) => v.handle);
}
