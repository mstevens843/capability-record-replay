// Parameterization - SPEC section 6.3, and the mechanism BRIEF section 3.6 calls the privacy
// control.
//
// Deterministic, after the run, with no model involved. The five steps of SPEC section 6.3 are the
// five sections below: COLLECT every literal the model typed and every concrete route segment,
// MATCH them against the goal text, TYPE them from the surface, CLASSIFY their sensitivity, and
// REFUSE to store the value.
//
// The reason this is the mechanism rather than a lint is that one decision buys four things:
//
//   · a REUSABLE capability - the artifact works for any member, not the one it was recorded on;
//   · regulated data is NEVER PERSISTED - the value is replaced, not redacted, so there is nothing
//     to leak from the file, the digest, the signature or a diff;
//   · route CANONICALIZATION falls out for free (`routes.ts` consumes what this file produces);
//   · and, per SPEC section 4.3, it is what makes a validation error CLASSIFIABLE at all - the
//     classifier can only say "the app rejected the CALLER's value, and the caller can fix it"
//     because the value has a provenance, and a literal baked into the artifact does not.
//
// THE LIMIT, STATED RATHER THAN HIDDEN. Whether a value SHOULD have been a parameter is a
// recorder-side judgement made from the goal text. It will miss and it will over-trigger: a member
// number the goal never mentions is not caught here, and a status filter that happens to look like
// an identifier is flagged when it should not be. The shape-based lint in `@crr/core`'s validator is
// the backstop, not the mechanism, and neither is a substitute for a human reading the report.

import {
  type Observation,
  type ParamSpec,
  type Sensitivity,
  type SurfaceCapabilities,
  type UINode,
  type ValueType,
  piiShapeOf,
  taintParamOf,
  unsafeTextReason,
} from "@crr/core";
import type { RecordedStep } from "../loop.js";
import { labelAnchorsOf } from "./descriptors.js";
import type { SynthesisNote } from "./report.js";
import {
  type ValueBinding,
  containsValue,
  fieldNameOf,
  isParameterizable,
  parameterizeText,
  uniqueName,
} from "./values.js";

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------

export interface InferredParameters {
  readonly params: readonly ParamSpec[];
  /** The substitution table every other module works from. */
  readonly bindings: readonly ValueBinding[];
  /** Taint handle to parameter name, so a step that typed a bound value can name the parameter
   *  without ever having seen the value. */
  readonly byHandle: ReadonlyMap<string, string>;
  readonly notes: readonly SynthesisNote[];
  /** Names already spoken for, so route canonicalization can mint holes that do not collide. */
  readonly taken: Set<string>;
  /** Which rung of the naming chain each parameter's name came off. Carried into the synthesis
   *  report so a reviewer can see the provenance of every argument a caller will be offered - and,
   *  for a `positional` one, that there is no provenance at all. */
  readonly naming: readonly ParameterNaming[];
}

export interface ParameterNaming {
  readonly param: string;
  readonly source: ParameterNameSource;
}

export interface InferParametersInput {
  readonly goal: string;
  readonly steps: readonly RecordedStep[];
  /**
   * What the recording driver advertises. Optional, and the only thing it decides here is whether
   * the SPATIAL rung of the naming chain is available: a label association by adjacency is a
   * geometric claim, and a surface that reports no `boundsUnit` has no geometry to make it with.
   * Absent, the chain simply stops one rung earlier and says so - it never guesses a unit.
   */
  readonly capabilities?: SurfaceCapabilities | null;
}

interface Candidate {
  readonly param: string;
  readonly value: string;
  readonly node: UINode | null;
  readonly type: ValueType;
  readonly sensitivity: Sensitivity;
  readonly origin: "goal" | "operator";
  readonly handle: string | null;
  readonly label: string;
  readonly nameSource: ParameterNameSource;
}

// ---------------------------------------------------------------------------------------------
// 0. What the parameter is CALLED
//
// A capability is invoked by an agent that reads the contract and fills the arguments by name, so
// the name is part of the interface and not a cosmetic. `value1` is a routing hazard: it tells a
// caller nothing about what to put there, and a catalog of `value1`, `value2` is a catalog nobody
// can route on. It is also the ONE thing about this artifact a person cannot fix by re-recording,
// because the field genuinely has no accessible name - which is the legacy-app reality this whole
// project is about.
//
// THE CHAIN, in order, every rung read off evidence the system already has. Nothing is asked of a
// model, nothing is guessed from the shape of the value (a name derived from a value would put a
// member number in the caller's public API), and nothing about any particular application is
// special-cased:
//
//   1. `accessible-name` - the control's own accessible name. What the application says it is.
//   2. `labelled-by`     - the wording the MARKUP associates with the control. The application
//                          again, one step removed.
//   3. `adjacent-label`  - the nearest adjacent label text within the same reach bound that a
//                          `label-anchored` descriptor uses. On a `<font>`-tag frameset this is the
//                          only association there is, and it is precisely the anchor
//                          `deriveDescriptors` has already computed for this same node: rungs 2 and
//                          3 come from `labelAnchorsOf`, the function the descriptor builder calls,
//                          so a parameter cannot be named after a label the locator does not use.
//   4. `taint-handle`    - for an operator-supplied secret, the parameter name the HOST chose when
//                          it minted the taint handle. Never a value; a handle names the binding.
//   5. `positional`      - `value1`. Honest, and FLAGGED: a `parameter-name-underived` note at
//                          `review` severity, which is the severity that means "this artifact
//                          cannot be approved until a person has read this". Silence would be the
//                          bug; `value1` on a field with no name anywhere is the correct answer.
//
// A rung is skipped, not taken, when its wording carries a recorded value or a regulated shape
// (the same `unsafeTextReason` guard `Vocabulary.matcher` applies to a label before it becomes a
// vocabulary token), or when it does not spell a legal identifier. `fieldNameOf` enforces the
// `FieldNameSchema` grammar and `uniqueName` enforces distinctness against every name already
// minted, so a derived name is always callable and never collides with another parameter or with a
// hole route canonicalization goes on to mint.
//
// The value-carrying check is a belt on top of braces: the emitter re-walks its own finished
// documents with `findBoundValues` and refuses to return one in which a recorded value survived -
// KEYS included, which is where a parameter name would land. That backstop catches a label
// carrying a value some LATER step bound, which this per-step check cannot see. What the check
// here buys is that the failure is a differently-named parameter and a note, rather than a
// `SynthesisError` at the end of a run somebody paid for.
// ---------------------------------------------------------------------------------------------

export type ParameterNameSource =
  | "accessible-name"
  | "labelled-by"
  | "adjacent-label"
  | "taint-handle"
  | "positional";

interface NameEvidence {
  readonly text: string;
  readonly source: ParameterNameSource;
}

interface DerivedName {
  readonly param: string;
  /** The wording the name was spelled from, for the parameter's description. Empty when the chain
   *  reached its last rung, because there was no wording. */
  readonly label: string;
  readonly source: ParameterNameSource;
}

/** Rungs 1-3, in order. Read-only over the frozen observation; no vocabulary token is minted. */
function nameEvidenceOf(
  node: UINode,
  observation: Observation,
  unit: "px" | "cell" | null,
): readonly NameEvidence[] {
  const evidence: NameEvidence[] = [];
  const own = node.name.trim();
  if (own.length > 0) evidence.push({ text: own, source: "accessible-name" });
  for (const anchor of labelAnchorsOf(node, observation, unit)) {
    evidence.push({
      text: anchor.text,
      source: anchor.relation === "labelled-by" ? "labelled-by" : "adjacent-label",
    });
  }
  return evidence;
}

/**
 * Walk the chain and mint the name.
 *
 * `recorded` is every concrete value this run has typed so far, including the one being bound now.
 * A rung whose wording contains one of them is skipped rather than used: naming an argument after
 * a label that echoes the member number would publish the member number in the contract.
 */
function nameParameter(
  node: UINode | null,
  observation: Observation | null,
  unit: "px" | "cell" | null,
  fallback: DerivedName,
  taken: Set<string>,
  recorded: readonly string[],
): DerivedName {
  if (node !== null && observation !== null) {
    for (const evidence of nameEvidenceOf(node, observation, unit)) {
      if (recorded.some((value) => containsValue(evidence.text, value))) continue;
      if (unsafeTextReason(evidence.text) !== null) continue;
      const spelled = fieldNameOf(evidence.text, "");
      if (spelled.length === 0) continue;
      return {
        param: uniqueName(spelled, taken, "_"),
        label: evidence.text,
        source: evidence.source,
      };
    }
  }
  return { ...fallback, param: uniqueName(fallback.param, taken, "_") };
}

/** The wording a note should use when it points at a field, or the control's role when the field
 *  has no wording at all. Never a recorded value - a note is a log line. */
function wordingOf(
  node: UINode | null,
  observation: Observation | null,
  unit: "px" | "cell" | null,
  recorded: readonly string[],
): string {
  if (node === null || observation === null) return kindOf(node);
  for (const evidence of nameEvidenceOf(node, observation, unit)) {
    if (recorded.some((value) => containsValue(evidence.text, value))) continue;
    if (unsafeTextReason(evidence.text) !== null) continue;
    return evidence.text;
  }
  return kindOf(node);
}

/** How a note refers to a control that has no wording: by its role. */
function kindOf(node: UINode | null): string {
  return node === null ? "field" : (node.ariaRole ?? "field");
}

/** The `review` note rung 5 owes a reviewer. Named without quoting anything the run typed. */
function underivedNote(param: string, kind: string): SynthesisNote {
  return {
    code: "parameter-name-underived",
    severity: "review",
    detail: `${param} could not be named from the surface: the ${kind} it was typed into has no accessible name, no label associated by markup, and no adjacent label text, so the parameter is named positionally. A calling agent routes on this name - a person must rename it in the contract before this capability is approved`,
  };
}

// ---------------------------------------------------------------------------------------------
// 1-2. Collect, and match against the goal
// ---------------------------------------------------------------------------------------------

export function inferParameters(input: InferParametersInput): InferredParameters {
  const notes: SynthesisNote[] = [];
  const taken = new Set<string>();
  const candidates: Candidate[] = [];
  const byHandle = new Map<string, string>();
  const unit = input.capabilities?.boundsUnit ?? null;

  for (const step of input.steps) {
    if (!step.dispatched || step.value === null) continue;
    const node = nodeOf(step);
    const observation = node === null ? null : step.observation;
    const seen = candidates.map((one) => one.value);

    // A value the loop never showed the model is a value nothing here has ever seen: the recorded
    // step carries the TAINT HANDLE, not the text. It is a parameter by construction - the host
    // supplied it for this run, and the artifact refers to it by name.
    if (step.value.kind === "sensitive") {
      const named = nameParameter(
        node,
        observation,
        unit,
        { param: taintParamOf(step.value.handle), label: "", source: "taint-handle" },
        taken,
        seen,
      );
      byHandle.set(step.value.handle, named.param);
      candidates.push({
        param: named.param,
        value: "",
        node,
        type: stringTypeOf(node, null),
        sensitivity: "sensitive",
        origin: "operator",
        handle: step.value.handle,
        label: named.label,
        nameSource: named.source,
      });
      continue;
    }

    const value = step.value.value;
    if (candidates.some((one) => one.value === value)) continue;

    const optionsFor = step.action.kind === "select" ? optionsOf(node, step) : null;
    const type = optionsFor === null ? stringTypeOf(node, value) : optionsFor;
    const positional = {
      param: `value${candidates.length + 1}`,
      label: "",
      source: "positional" as const,
    };

    if (mentionedInGoal(input.goal, value)) {
      if (!isParameterizable(value)) {
        notes.push({
          code: "parameter-regulated-shape",
          severity: "review",
          detail: `a value typed into "${wordingOf(node, observation, unit, [value, ...seen])}" appears in the goal but is too short to bind as a parameter, so it remains a literal`,
        });
        continue;
      }
      const named = nameParameter(node, observation, unit, positional, taken, [value, ...seen]);
      if (named.source === "positional") notes.push(underivedNote(named.param, kindOf(node)));
      candidates.push({
        param: named.param,
        value,
        node,
        type,
        sensitivity: sensitivityOf(type),
        origin: "goal",
        handle: null,
        label: named.label,
        nameSource: named.source,
      });
      continue;
    }

    // Not in the goal. It may stay a literal - but ONLY if it is safe to persist. `ValueRef`'s
    // literal arm is typed `sensitivity: "public"` and nothing else, so a value that looks like
    // regulated data is not expressible as a literal at all; it becomes an operator-supplied
    // parameter and a person is told why.
    const unsafe = unsafeTextReason(value);
    if (unsafe === null) continue;
    if (!isParameterizable(value)) continue;
    const named = nameParameter(node, observation, unit, positional, taken, [value, ...seen]);
    if (named.source === "positional") notes.push(underivedNote(named.param, kindOf(node)));
    candidates.push({
      param: named.param,
      value,
      node,
      type,
      sensitivity: "sensitive",
      origin: "operator",
      handle: null,
      label: named.label,
      nameSource: named.source,
    });
    notes.push({
      code: "parameter-regulated-shape",
      severity: "review",
      detail: `the value typed into "${named.label.length > 0 ? named.label : kindOf(node)}" is not mentioned in the goal but cannot be stored as a literal, so it became the parameter ${named.param}; a person must confirm where a caller is expected to get it`,
    });
  }

  const bindings: ValueBinding[] = candidates.map((candidate) => ({
    param: candidate.param,
    value: candidate.value,
    placeholder: `{${candidate.param}}`,
    sensitivity: candidate.sensitivity,
  }));

  const params = candidates.map((candidate) => specOf(candidate, input.goal, bindings, notes));
  const naming = candidates.map((candidate) => ({
    param: candidate.param,
    source: candidate.nameSource,
  }));
  return { params, bindings, byHandle, notes, taken, naming };
}

function nodeOf(step: RecordedStep): UINode | null {
  if (step.nodeId === null) return null;
  return step.observation.nodes.find((node) => node.id === step.nodeId) ?? null;
}

/**
 * Whole-token containment, case-insensitive.
 *
 * Whole-token because a bare substring test says the goal "look up member 1500012" mentions the
 * value "50001", and binding on that would replace three digits in the middle of a different
 * number. Case-insensitive because a goal saying `abc123` and a screen echoing `ABC123` are the
 * same value, and a case-sensitive test would quietly leave the echo in the document.
 */
export function mentionedInGoal(goal: string, value: string): boolean {
  if (!isParameterizable(value)) return false;
  const haystack = goal.toLowerCase();
  const needle = value.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : haystack.charAt(at - 1);
    const after = haystack.charAt(at + needle.length);
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

function isWordChar(ch: string): boolean {
  return ch.length === 1 && /[a-z0-9]/i.test(ch);
}

// ---------------------------------------------------------------------------------------------
// 3. Type it from the surface
// ---------------------------------------------------------------------------------------------

const DIGITS = /^[0-9]+$/;
const ALNUM = /^[A-Za-z0-9]+$/;

/**
 * A member number is a STRING of digits, never an integer.
 *
 * An integer loses a leading zero, and a leading zero is meaningful in every account, routing and
 * member identifier a core banking system has. The `charset` constraint keeps the cheap pre-flight
 * rejection SPEC section 2.3 wants - "abc" is refused in a nanosecond rather than after four steps
 * of a legacy UI - without pretending the value is arithmetic.
 *
 * `maxLength` comes from the FIELD, not from the value: the terminal spike's `capacity` falls
 * straight out of the character grid, and a browser driver that knows the field's limit reports it
 * the same way. Deriving it from the recorded value instead would bake one member's id length into
 * every future call.
 */
function stringTypeOf(node: UINode | null, value: string | null): ValueType {
  const charset =
    value === null
      ? undefined
      : DIGITS.test(value)
        ? "digits"
        : ALNUM.test(value)
          ? "alnum"
          : "any";
  const maxLength = node?.capacity ?? undefined;
  if (charset === undefined && maxLength === undefined) return { kind: "string" };
  if (charset === undefined) return { kind: "string", maxLength };
  if (maxLength === undefined) return { kind: "string", charset };
  return { kind: "string", charset, maxLength };
}

/** An enumerated control's own options, read off the observation. A closed set the app itself
 *  published is a far better type than "some string", and it is the one case where an example is
 *  safe to publish in the catalog. */
function optionsOf(node: UINode | null, step: RecordedStep): ValueType | null {
  if (node === null) return null;
  if (node.ariaRole !== "combobox" && node.ariaRole !== "listbox") return null;
  const values = step.observation.nodes
    .filter((one) => one.ariaRole === "option" && node.children.includes(one.id))
    .map((one) => (one.name.trim().length > 0 ? one.name.trim() : (one.text ?? "").trim()))
    .filter((one) => one.length > 0);
  const distinct = [...new Set(values)];
  if (distinct.length === 0) return null;
  return { kind: "enum", values: distinct };
}

// ---------------------------------------------------------------------------------------------
// 4. Classify sensitivity
// ---------------------------------------------------------------------------------------------

/**
 * Fail closed, with exactly one exemption.
 *
 * A parameter discovered from the goal is a value the caller supplies to select a RECORD, and that
 * is the definition of an identifier: SPEC section 6.3 is explicit that a member number is
 * `sensitive` because it is what links a balance to a person, and that getting this backwards means
 * the "no example on a sensitive field" validator is not protecting the field it exists for.
 *
 * The exemption is an ENUMERATED parameter. Its legal values are a closed set the application
 * itself published on the screen - a status, an account type, a date range - so it cannot identify
 * anybody, and a catalog entry showing one of them leaks nothing. Every other shape is `sensitive`
 * until a person says otherwise, and the report says so out loud.
 */
function sensitivityOf(type: ValueType): Sensitivity {
  return type.kind === "enum" ? "internal" : "sensitive";
}

// ---------------------------------------------------------------------------------------------
// 5. Refuse to store the value
// ---------------------------------------------------------------------------------------------

function specOf(
  candidate: Candidate,
  goal: string,
  bindings: readonly ValueBinding[],
  notes: SynthesisNote[],
): ParamSpec {
  const label = parameterizeText(candidate.label, bindings).trim();
  const described = label.length > 0 ? label : candidate.param;
  const base = {
    name: candidate.param,
    type: candidate.type,
    required: true,
    description: descriptionOf(described, candidate),
    sensitivity: candidate.sensitivity,
  } as const;

  const constraints = constraintsOf(candidate.type);
  const discoveredFrom =
    candidate.origin === "goal"
      ? { goalSpan: goalSpanOf(goal, candidate, bindings) }
      : { operator: true as const };

  if (candidate.sensitivity !== "sensitive" && candidate.type.kind === "enum") {
    const example = candidate.type.values[0];
    notes.push({
      code: "parameter-bound",
      severity: "info",
      detail: `${candidate.param} is an enumerated parameter, so its catalog example is one of the application's own published options`,
    });
    return example === undefined
      ? { ...base, discoveredFrom, ...(constraints === null ? {} : { constraints }) }
      : { ...base, example, discoveredFrom, ...(constraints === null ? {} : { constraints }) };
  }

  notes.push({
    code:
      candidate.value.length > 0 && piiShapeOf(candidate.value) !== null
        ? "parameter-regulated-shape"
        : "parameter-bound",
    severity:
      candidate.value.length > 0 && piiShapeOf(candidate.value) !== null ? "review" : "info",
    detail:
      candidate.value.length > 0 && piiShapeOf(candidate.value) !== null
        ? `${candidate.param} was bound from a value with the shape of regulated data; the value is stored nowhere, and a person must confirm the parameterization before this artifact is approved`
        : `${candidate.param} was bound from the goal and is stored nowhere in the artifact`,
  });

  // No `example` on a sensitive field, ever. The schema refuses one; this is the code that would
  // otherwise have supplied it, and it is the single most likely place for "here is an example
  // member number" to enter a committed file.
  return { ...base, discoveredFrom, ...(constraints === null ? {} : { constraints }) };
}

/**
 * The one line a calling agent reads before it fills this argument.
 *
 * When the name came off no rung of the chain, the description says so IN THE CONTRACT rather than
 * only in the report. Same move, and the same wording convention, as `PROSE_PLACEHOLDER`: the
 * document a person approves is the document that should tell them what is missing from it, and an
 * agent that routes on descriptions is better served by "this argument has no real name" than by a
 * confident sentence about `value1`.
 */
function descriptionOf(label: string, candidate: Candidate): string {
  const noun = candidate.type.kind === "enum" ? "option" : "value";
  const where =
    candidate.origin === "goal"
      ? "It was named in the goal the capability was discovered from."
      : "It was supplied by the operator for the discovery run and is never stored.";
  const unnamed =
    candidate.nameSource === "positional"
      ? " NEEDS A NAME: the field it is typed into carries no accessible name, no label associated by markup and no adjacent label text, so this argument is named positionally and a person must rename it before the capability is published."
      : "";
  return `The ${noun} to use for "${label}". ${where}${unnamed}`.slice(0, 1000);
}

function constraintsOf(type: ValueType): ParamSpec["constraints"] | null {
  if (type.kind === "enum") return { enum: type.values };
  if (type.kind !== "string") return null;
  const charset = type.charset;
  const maxLength = type.maxLength;
  if (charset === undefined && maxLength === undefined) return null;
  if (charset === undefined) return { maxLength };
  if (maxLength === undefined) return { charset };
  return { charset, maxLength };
}

/** How wide a window around the match the recorded goal span keeps. Wide enough that a reviewer can
 *  see what the parameter meant, narrow enough that it is a span and not the goal. */
const GOAL_SPAN_CONTEXT = 32;

/**
 * The words around the value in the goal, with the value replaced by its hole.
 *
 * This field is the trap SPEC section 2.3 names: "the field whose entire purpose is to record where
 * a member number came from is the field most likely to end up holding one". So the span is
 * parameterized like everything else, and then checked again - if the surrounding words still carry
 * a regulated shape (a second member number the goal mentioned and this run never typed), the span
 * collapses to the hole alone rather than being published.
 */
function goalSpanOf(goal: string, candidate: Candidate, bindings: readonly ValueBinding[]): string {
  const at = goal.toLowerCase().indexOf(candidate.value.toLowerCase());
  const hole = `{${candidate.param}}`;
  if (at < 0) return hole;
  const start = Math.max(0, at - GOAL_SPAN_CONTEXT);
  const end = Math.min(goal.length, at + candidate.value.length + GOAL_SPAN_CONTEXT);
  const window = goal.slice(start, end).trim();
  const parameterized = parameterizeText(window, bindings).trim();
  if (parameterized.length === 0) return hole;
  if (piiShapeOf(parameterized) !== null) return hole;
  return parameterized.slice(0, 500);
}
