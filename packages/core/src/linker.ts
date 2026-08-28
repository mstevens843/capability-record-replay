// SPEC section 10 - the linker.
//
//     link(contract, artifact, overlay, surfaceCapabilities, args) -> LinkedProgram | LinkError[]
//
// It runs before a browser is launched or a pty is spawned, and it performs ZERO actions. That is
// the whole reason `link-error` and `argument-invalid` may say `sideEffects: "none-guaranteed"` as a
// fact rather than as a hope: a caller's bad member number costs no clicks, and a misconfigured
// artifact is a bad artifact rather than a half-applied one.
//
// Three things about the shape of this file are deliberate.
//
//   1. ALL TWENTY-EIGHT CHECKS ARE IMPLEMENTED HERE, including the ones the schema already enforces.
//      SPEC section 10 numbers them so that a link report can be diffed against the spec, and a
//      linker that delegated two thirds of them to zod would answer twenty questions with one
//      sentence. The schema is the BACKSTOP, reported under check 1 when nothing more specific
//      fired: "unknown constructs are refused, never ignored".
//   2. THE CHECKS RUN OVER THE MERGED PROGRAM. SPEC section 9.2 requires it, and the merged program
//      is a document no validator has ever seen. That is also what makes an overlay that disabled
//      one descriptor too many a `link-error` at load with a clear message instead of a
//      `target-underdetermined` at step six in production.
//   3. EVERY ERROR IS COLLECTED, not the first. An operator fixing an artifact wants the list.
//
// What the linker deliberately does NOT do: resolve a target, read a screen, or decide anything
// about the run. It resolves the DOCUMENTS against each other and against the surface's own
// advertisement, and hands the interpreter a `LinkedProgram` plus the `ProgramFacts` the classifier
// takes as plain data.

import {
  type CapabilityArtifact,
  type EffectSummary,
  type Flow,
  type RecoveryRule,
  type ResolvedStep,
  ResolvedStepSchema,
  SCHEMA_VERSION_ARTIFACT,
} from "./artifact.js";
import { canonicalJson } from "./canonical-json.js";
import { type CapabilityContract, SCHEMA_VERSION_CONTRACT } from "./contract.js";
import { isDecimal } from "./decimal.js";
import { DESCRIPTOR_RANK, type DescriptorKind } from "./descriptor-kinds.js";
import type { LinkError } from "./diagnostics.js";
import {
  type JsonObject,
  asArray,
  asInteger,
  asObject,
  asObjects,
  asString,
  asStrings,
  cloneJson,
  joinPath,
  walkRecords,
} from "./document-walk.js";
import {
  artifactDigestIsIntact,
  contractDigestIsIntact,
  effectiveDigestOf,
  explainValidationError,
  overlayDigestIsIntact,
  safeParseArtifact,
  safeParseContract,
  safeParseOverlay,
} from "./documents.js";
import {
  type EffectFlowInput,
  type StepEffect,
  analyzeEffects,
  restartSafeUpToPc,
} from "./effects.js";
import type { ProgramFacts, ResolvedBinding, ResolvedBindings } from "./evaluate.js";
import { MAX_PREDICATE_DEPTH } from "./matchers.js";
import type { SurfaceCapabilities, SurfaceFeature } from "./observation.js";
import { type MergedProgram, mergeOverlay } from "./overlay-merge.js";
import { type CapabilityOverlay, SCHEMA_VERSION_OVERLAY } from "./overlay.js";
import { matchRoute, pathIsCanonicalShape } from "./policy-engine.js";
import type { Allowlist } from "./policy.js";
import type { Digest, EffectClass, Sensitivity, ValueType } from "./primitives.js";
import { lookupRegistryEntry } from "./registry.js";
import { mintTaintHandle } from "./taint.js";
import { locatorShapeOf, piiShapeOf } from "./text-safety.js";

/** Part of `effectiveDigest`, so "which bytes actually ran" includes which merger produced them.
 *  Bumping it is a deliberate act: it changes the effective digest of every run. */
export const LINKER_VERSION = "crr-linker/1";

export const LINK_CHECK_COUNT = 28;

/**
 * Why the linker was asked.
 *
 * Only `replay` demands an approved, signed artifact (check 27). `verification` is the immediate
 * self-replay that decides whether a `proposed` artifact may become a draft at all - requiring an
 * approval there would make the lifecycle unreachable - and `discovery` links a program that is
 * still being written.
 */
export type LinkMode = "replay" | "verification" | "discovery";

/**
 * The approver trust store.
 *
 * `verifySignature` is INJECTED rather than implemented here, and that is the honest seam: ed25519
 * verification is arithmetic `@crr/core` does not own, and importing a crypto library into the
 * package whose entire claim is that it has no ambient dependencies would trade the architecture for
 * one function. What core owns is the part that is a document question - which digest was signed,
 * and whether the key that signed it is one this deployment trusts.
 */
export interface ApprovalTrust {
  readonly trustedKeyIds: readonly string[];
  readonly verifySignature: (signed: {
    readonly over: string;
    readonly keyId: string;
    readonly alg: string;
    readonly signature: string;
  }) => boolean;
}

/** What the caller pinned when its tool definitions were generated (SPEC section 2.6). */
export interface ContractPin {
  readonly name: string;
  readonly version: string;
  readonly contractDigest: string;
}

export interface LinkRequest {
  readonly contract: unknown;
  readonly artifact: unknown;
  /** `null` or absent for a tenant with no overrides - the base artifact is runnable on its own. */
  readonly overlay?: unknown;
  readonly capabilities: SurfaceCapabilities;
  readonly args?: Readonly<Record<string, unknown>>;
  /** Absent when the linker is called by a recorder rather than by an invocation. Check 4 is then
   *  vacuous: there is no caller whose generated types could be stale. */
  readonly invocation?: ContractPin | null;
  readonly mode: LinkMode;
  /** Absent when the caller has no allowlist of its own; the artifact's own origin aliases are still
   *  checked. Supplying one is what closes check 26. */
  readonly allowlist?: Allowlist | null;
  readonly trust?: ApprovalTrust | null;
}

/** The four failure classes that are decided before the surface is touched. All of them carry
 *  `sideEffects: "none-guaranteed"`, which `PRE_FLIGHT_FAILURES` asserts. */
export type PreFlightFailure =
  | "link-error"
  | "argument-invalid"
  | "contract-stale"
  | "artifact-invalid";

export interface LinkedProgram {
  readonly linkerVersion: string;
  readonly contract: CapabilityContract;
  /** The artifact as it was stored, before the overlay. Kept because the approval signature is over
   *  this document's digest and a postmortem has to be able to re-verify it. */
  readonly artifact: CapabilityArtifact;
  readonly overlay: CapabilityOverlay | null;
  /** Post-overlay. This is the program the interpreter runs. */
  readonly merged: CapabilityArtifact;
  readonly flow: Flow;
  readonly steps: readonly ResolvedStep[];
  readonly ambient: readonly RecoveryRule[];
  /** Whole-run facts, in the shape `classify` takes as plain data. */
  readonly facts: ProgramFacts;
  /** The caller's arguments, bound and typed, with a taint handle on every sensitive one. */
  readonly bindings: ResolvedBindings;
  readonly effects: EffectSummary;
  readonly perStepEffects: readonly StepEffect[];
  readonly originBindings: Readonly<Record<string, string>>;
  readonly disabledDescriptors: readonly {
    readonly stepId: string;
    readonly descriptorId: string;
  }[];
  /** `f(artifactDigest, overlayDigest, linkerVersion)`. Goes on every arm of every result. */
  readonly effectiveDigest: Digest;
}

export type LinkResult =
  | { readonly ok: true; readonly program: LinkedProgram }
  | {
      readonly ok: false;
      readonly failure: PreFlightFailure;
      readonly sideEffects: "none-guaranteed";
      readonly errors: readonly LinkError[];
    };

// ---------------------------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------------------------

export function link(request: LinkRequest): LinkResult {
  const errors: LinkError[] = [];
  const add = (check: number, code: string, message: string, where: string | null = null): void => {
    errors.push({ check, code, message: clip(message, 1000), where: truncate(where, 500) });
  };

  const contractDoc = asObject(request.contract);
  const artifactDoc = asObject(request.artifact);
  const overlayDoc = asObject(request.overlay ?? null);

  // ---- 1: the documents are the kind of document this engine runs ------------------------------
  checkSchemaVersions(contractDoc, artifactDoc, overlayDoc, add);
  // ---- 2: and they are the bytes they say they are ---------------------------------------------
  if (errors.length === 0) checkDigests(contractDoc, artifactDoc, overlayDoc, add);
  if (errors.length > 0 || contractDoc === null || artifactDoc === null) {
    return refuse(errors.length > 0 ? errors : [malformed()]);
  }

  const merged = mergeOverlay(artifactDoc, overlayDoc);
  const view = viewOf(contractDoc, merged.document);

  checkContractIdentity(view, request.invocation ?? null, add);
  checkReferences(view, add);
  checkOutputs(view, add);
  checkOutcomes(view, add);
  checkPriorities(view, add);
  checkText(view, merged, add);
  checkTargets(view, "after the overlay merge", add);
  // Check 11 twice, and the second one is not redundant. SPEC section 10 evaluates the quorum AFTER
  // merge, which is what catches an overlay that disabled one descriptor too many. But an overlay
  // that RESTORES a quorum the base does not have is just as wrong: the base is what every tenant
  // without an overlay runs, and a base whose evidence only reaches quorum at one tenant is a
  // capability that silently does not exist at the others. Save-time invariant 1 says so; this is
  // where it is enforced against a stored document.
  if (overlayDoc !== null) checkTargets(viewOf(contractDoc, artifactDoc), "as stored,", add);
  checkAnchors(view, add);
  checkEffects(view, add);
  checkBudgets(view, add);
  checkRemedies(view, add);
  checkSurface(view, request.capabilities, add);
  checkLanguage(view, add);
  checkRestart(view, add);
  checkOverlay(artifactDoc, merged, add);
  checkKeys(view, add);
  checkRuleShapes(view, add);
  checkTableReads(view, add);
  checkCheckpoints(view, add);
  checkRoutes(view, request.allowlist ?? null, add);
  checkApproval(artifactDoc, request.mode, request.trust ?? null, add);

  const binding = bindArguments(contractDoc, request.args ?? {}, add);

  // ---- the backstop ----------------------------------------------------------------------------
  //
  // Reported only when no numbered check fired. A precise finding plus "and the schema also refused
  // it" is one finding and one echo; the operator fixes the named field, re-links, and anything the
  // schema still objects to surfaces then with nothing louder in front of it.
  const parsedContract = safeParseContract(contractDoc);
  const parsedMerged = safeParseArtifact(merged.document);
  const parsedArtifact = overlayDoc === null ? parsedMerged : safeParseArtifact(artifactDoc);
  const parsedOverlay = overlayDoc === null ? null : safeParseOverlay(overlayDoc);
  if (errors.length === 0) {
    reportValidation("contract", parsedContract, add);
    reportValidation("artifact", parsedMerged, add);
    // With no overlay the merge is a copy, so validating it twice would say everything twice.
    if (overlayDoc !== null) reportValidation("stored artifact", parsedArtifact, add);
    if (parsedOverlay !== null) reportValidation("overlay", parsedOverlay, add);
  }
  if (errors.length > 0) return refuse(errors);
  if (!parsedContract.success || !parsedMerged.success || !parsedArtifact.success) {
    return refuse([malformed()]);
  }

  return {
    ok: true,
    program: assemble(
      parsedContract.data,
      parsedArtifact.data,
      parsedMerged.data,
      parsedOverlay?.success === true ? parsedOverlay.data : null,
      merged,
      binding,
    ),
  };
}

/**
 * Which pre-flight class a set of link errors is.
 *
 * The order is the order of what the reader can act on. A document that will not parse makes "your
 * generated types are stale" bad advice, so `artifact-invalid` outranks `contract-stale`; and
 * `argument-invalid` is reserved for the case where the ONLY thing wrong is the call, because
 * telling an agent to retry with a different member number when the artifact is broken sends it
 * into a loop it can never exit.
 */
export function failureClassOf(errors: readonly LinkError[]): PreFlightFailure {
  if (errors.some((e) => e.check === 1 || e.check === 2)) return "artifact-invalid";
  if (errors.some((e) => e.check === 4)) return "contract-stale";
  if (errors.length > 0 && errors.every((e) => e.check === 28)) return "argument-invalid";
  return "link-error";
}

function refuse(errors: readonly LinkError[]): LinkResult {
  const ordered = [...errors].sort((a, b) => a.check - b.check);
  return {
    ok: false,
    failure: failureClassOf(ordered),
    sideEffects: "none-guaranteed",
    errors: ordered,
  };
}

const malformed = (): LinkError => ({
  check: 1,
  code: "document-invalid",
  message:
    "a document is not the shape this engine runs and no numbered check could say why; this is the backstop, and reaching it silently means a check is missing",
  where: null,
});

// ---------------------------------------------------------------------------------------------
// A view over the merged program
// ---------------------------------------------------------------------------------------------

type Report = (check: number, code: string, message: string, where?: string | null) => void;

interface View {
  readonly contract: JsonObject;
  readonly artifact: JsonObject;
  readonly flow: JsonObject;
  readonly steps: readonly JsonObject[];
  readonly stepIds: readonly string[];
  readonly indexOfStep: ReadonlyMap<string, number>;
  readonly routes: readonly JsonObject[];
  readonly ambient: readonly JsonObject[];
  readonly policy: JsonObject;
  readonly inputs: readonly JsonObject[];
  readonly outputs: readonly JsonObject[];
  readonly outcomes: readonly JsonObject[];
}

function viewOf(contract: JsonObject, artifact: JsonObject): View {
  const flow = asObject(artifact.flow) ?? {};
  const steps = asObjects(flow.steps);
  const stepIds = steps.map((s) => asString(s.id) ?? "");
  return {
    contract,
    artifact,
    flow,
    steps,
    stepIds,
    indexOfStep: new Map(stepIds.map((id, i) => [id, i])),
    routes: asObjects(flow.routes),
    ambient: asObjects(flow.ambient),
    policy: asObject(artifact.policy) ?? {},
    inputs: asObjects(contract.inputs),
    outputs: asObjects(contract.outputs),
    outcomes: asObjects(contract.outcomes),
  };
}

const stepPath = (i: number): string => `flow.steps.${i}`;

/** Every recovery the program declares, with where it came from. Overlay-added recoveries are
 *  already inside `step.recoveries` by the time this runs, which is the point: they get every check
 *  a base recovery gets. */
function recoveriesOf(
  view: View,
): readonly { rule: JsonObject; where: string; step: number | null }[] {
  const out: { rule: JsonObject; where: string; step: number | null }[] = [];
  view.steps.forEach((step, i) => {
    asObjects(step.recoveries).forEach((rule, j) => {
      out.push({ rule, where: `${stepPath(i)}.recoveries.${j}`, step: i });
    });
  });
  view.ambient.forEach((rule, j) => out.push({ rule, where: `flow.ambient.${j}`, step: null }));
  return out;
}

// ---------------------------------------------------------------------------------------------
// 1 and 2 - is this the kind of document we run, and is it the bytes it claims to be
// ---------------------------------------------------------------------------------------------

function checkSchemaVersions(
  contract: JsonObject | null,
  artifact: JsonObject | null,
  overlay: JsonObject | null,
  add: Report,
): void {
  const expect = (doc: JsonObject | null, want: string, kind: string): void => {
    if (doc === null) return;
    const got = asString(doc.schemaVersion);
    if (got === want) return;
    add(
      1,
      "schema-version-unknown",
      `this engine runs ${want}; the ${kind} says ${got ?? "nothing"}. An unknown construct is refused, never ignored`,
      "schemaVersion",
    );
  };
  expect(contract, SCHEMA_VERSION_CONTRACT, "contract");
  expect(artifact, SCHEMA_VERSION_ARTIFACT, "artifact");
  expect(overlay, SCHEMA_VERSION_OVERLAY, "overlay");
}

function checkDigests(
  contract: JsonObject | null,
  artifact: JsonObject | null,
  overlay: JsonObject | null,
  add: Report,
): void {
  const intact = (doc: JsonObject | null, isIntact: (d: JsonObject) => boolean): boolean | null => {
    if (doc === null) return null;
    try {
      return isIntact(doc);
    } catch {
      // A document that cannot be canonicalized cannot be addressed, which is the same answer.
      return false;
    }
  };
  if (intact(artifact, artifactDigestIsIntact) === false) {
    add(
      2,
      "digest-mismatch",
      "the artifact's stored digest is not the digest of its content: it has been edited since it was sealed, and an approval signs the digest",
      "digest",
    );
  }
  if (intact(overlay, overlayDigestIsIntact) === false) {
    add(
      2,
      "digest-mismatch",
      "the overlay's stored digest is not the digest of its content",
      "digest",
    );
  }
  if (intact(contract, contractDigestIsIntact) === false) {
    add(
      2,
      "digest-mismatch",
      "the contract's stored digest is not the digest of its content",
      "digest",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 3 and 4 - the artifact implements THIS contract, and the caller was compiled against it
// ---------------------------------------------------------------------------------------------

function checkContractIdentity(view: View, pin: ContractPin | null, add: Report): void {
  const implement = asObject(view.artifact.implements) ?? {};
  const want = {
    name: asString(view.contract.name),
    version: asString(view.contract.version),
    digest: asString(view.contract.digest),
  };
  if (asString(implement.name) !== want.name) {
    add(
      3,
      "contract-name-mismatch",
      `the artifact implements ${asString(implement.name) ?? "nothing"} and the contract loaded is ${want.name ?? "nothing"}`,
      "implements.name",
    );
  }
  if (asString(implement.version) !== want.version) {
    add(
      3,
      "contract-version-mismatch",
      `the artifact implements version ${asString(implement.version) ?? "nothing"} and the contract loaded is ${want.version ?? "nothing"}`,
      "implements.version",
    );
  }
  if (asString(implement.contractDigest) !== want.digest) {
    add(
      3,
      "contract-digest-mismatch",
      "the artifact was recorded against a different contract document than the one loaded",
      "implements.contractDigest",
    );
  }

  // Check 4 is vacuous with no invocation: a recorder linking its own draft has no caller whose
  // generated types could be stale.
  if (pin === null) return;
  if (pin.name !== want.name || pin.version !== want.version) {
    add(
      4,
      "contract-stale",
      `the caller invoked ${pin.name}@${pin.version} and the contract loaded is ${want.name}@${want.version}`,
      "capability.version",
    );
  }
  if (pin.contractDigest !== want.digest) {
    add(
      4,
      "contract-stale",
      "the caller's generated types were built from a different revision of this contract; regenerate them before invoking",
      "capability.contractDigest",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 5 and 6 - every reference resolves, and every output is written once
// ---------------------------------------------------------------------------------------------

interface OutputRef {
  readonly step: string;
  readonly output: string;
}

function valueRefsIn(value: unknown, base: string): readonly { ref: JsonObject; where: string }[] {
  const out: { ref: JsonObject; where: string }[] = [];
  walkRecords(value, (record, path) => {
    if (typeof record.from === "string" && !("output" in record && "parse" in record)) {
      out.push({ ref: record, where: joinPath(base, path) });
    }
  });
  return out;
}

function checkReferences(view: View, add: Report): void {
  const params = new Set(view.inputs.map((i) => asString(i.name)).filter(nonNull));

  const resolveRef = (ref: JsonObject, where: string, atStep: number | null): void => {
    const from = asString(ref.from);
    if (from === "param") {
      const name = asString(ref.param);
      if (name !== null && !params.has(name)) {
        add(5, "value-ref-unresolved", `nothing declares a parameter named ${name}`, where);
      }
      return;
    }
    if (from !== "output") return;
    const producer = asString(ref.step);
    const output = asString(ref.output);
    if (producer === null || output === null) return;
    const at = view.indexOfStep.get(producer);
    if (at === undefined) {
      add(5, "value-ref-unresolved", `no step named ${producer} writes ${output}`, where);
      return;
    }
    if (atStep !== null && at >= atStep) {
      add(
        5,
        "value-ref-not-earlier",
        `${output} is read from step ${producer}, which does not run strictly earlier`,
        where,
      );
    }
    const declared = asObjects(view.steps[at]?.extract).some((e) => asString(e.output) === output);
    if (!declared) {
      const captured = asObjects(view.steps[at]?.outcomes).some((o) =>
        asObjects(o.capture).some((c) => asString(c.output) === output),
      );
      add(
        captured ? 6 : 5,
        captured ? "outcome-capture-referenced" : "value-ref-unresolved",
        captured
          ? `${output} is captured by an outcome at step ${producer}; an outcome's bindings live in a terminal namespace no step may read`
          : `step ${producer} does not write an output named ${output}`,
        where,
      );
    }
  };

  view.steps.forEach((step, i) => {
    for (const { ref, where } of valueRefsIn(step, stepPath(i))) resolveRef(ref, where, i);
  });
  // Everything outside a step - a route's query, a continuity source - has no "current step", so
  // only existence is required.
  const outsideSteps = { ...view.artifact, flow: { ...view.flow, steps: [] } };
  for (const { ref, where } of valueRefsIn(outsideSteps, "")) resolveRef(ref, where, null);

  const written: OutputRef[] = [];
  view.steps.forEach((step, i) => {
    asObjects(step.extract).forEach((spec, j) => {
      const name = asString(spec.output);
      if (name === null) return;
      const first = written.find((w) => w.output === name);
      if (first !== undefined) {
        add(
          6,
          "output-written-twice",
          `${name} is written by step ${first.step} and again by step ${view.stepIds[i]}; two screens racing for what the caller is told`,
          `${stepPath(i)}.extract.${j}.output`,
        );
      }
      written.push({ step: view.stepIds[i] ?? "", output: name });
    });
  });
}

// ---------------------------------------------------------------------------------------------
// 7 - every declared output has exactly one producer, of the right type
// ---------------------------------------------------------------------------------------------

/** What a registered parser yields, as the `ValueType.kind` a contract would declare for it. The
 *  linker is the only place these two vocabularies meet, so the table lives here. */
const PARSER_YIELDS: Readonly<Record<string, ValueType["kind"]>> = {
  "string@1": "string",
  "integer@1": "integer",
  "moneyUSD@1": "money",
  "dateUS@1": "date",
  "dateISO@1": "date",
  "enum@1": "enum",
};

function checkOutputs(view: View, add: Report): void {
  const producers = new Map<
    string,
    { readonly spec: JsonObject; readonly step: number; readonly where: string }
  >();
  view.steps.forEach((step, i) => {
    asObjects(step.extract).forEach((spec, j) => {
      const name = asString(spec.output);
      if (name === null || producers.has(name)) return;
      producers.set(name, { spec, step: i, where: `${stepPath(i)}.extract.${j}` });
    });
  });

  view.outputs.forEach((output, i) => {
    const name = asString(output.name);
    if (name === null) return;
    const producer = producers.get(name);
    if (producer === undefined) {
      add(
        7,
        "output-unproduced",
        `the contract promises ${name} and no step extracts it, so a successful run could not be total`,
        `outputs.${i}.name`,
      );
      return;
    }
    checkTypeAgreement(output, producer.spec, view.steps[producer.step], producer.where, add);
  });

  const declared = new Set(view.outputs.map((o) => asString(o.name)).filter(nonNull));
  for (const [name, producer] of producers) {
    if (declared.has(name)) continue;
    add(
      7,
      "output-undeclared",
      `step ${view.stepIds[producer.step]} extracts ${name}, which the contract does not declare as an output`,
      `${producer.where}.output`,
    );
  }

  // An outcome's capture writes into that outcome's own payload, and the same agreement applies.
  const payloads = new Map<string, readonly JsonObject[]>();
  for (const outcome of view.outcomes) {
    const code = asString(outcome.code);
    if (code !== null) payloads.set(code, asObjects(outcome.payload));
  }
  view.steps.forEach((step, i) => {
    asObjects(step.outcomes).forEach((rule, j) => {
      const fields = payloads.get(asString(rule.code) ?? "");
      if (fields === undefined) return;
      asObjects(rule.capture).forEach((spec, k) => {
        const where = `${stepPath(i)}.outcomes.${j}.capture.${k}`;
        const name = asString(spec.output);
        const field = fields.find((f) => asString(f.name) === name);
        if (field === undefined) {
          add(
            7,
            "output-undeclared",
            `outcome ${asString(rule.code)} captures ${name}, which its declared payload does not contain`,
            `${where}.output`,
          );
          return;
        }
        checkTypeAgreement(field, spec, step, where, add);
      });
    });
  });
}

function checkTypeAgreement(
  field: JsonObject,
  spec: JsonObject,
  step: JsonObject | undefined,
  where: string,
  add: Report,
): void {
  const name = asString(field.name);
  const wanted = asString(asObject(field.type)?.kind);
  if (wanted === null) return;
  const isTable = asString(asObject(step?.instruction)?.kind) === "readTable";
  if (isTable) {
    if (wanted !== "table") {
      add(
        7,
        "output-type-mismatch",
        `${name} is read from a table and the contract declares it as ${wanted}`,
        `${where}.parse`,
      );
      return;
    }
    checkColumnHeaders(field, spec, name, where, add);
    return;
  }
  // A scalar read has no columns, so a header map on one is a document that means nothing - and a
  // key nobody consults is exactly how a per-tenant correction gets written, reviewed, merged and
  // silently ignored.
  if (asObject(spec.columnHeaders) !== null) {
    add(
      7,
      "output-type-mismatch",
      `${name} declares columnHeaders and is not read by a readTable step, so nothing would consult them`,
      `${where}.columnHeaders`,
    );
  }
  const parser = asString(spec.parse);
  const yields = parser === null ? undefined : PARSER_YIELDS[parser];
  if (yields === undefined || yields === wanted) return;
  add(
    7,
    "output-type-mismatch",
    `${name} is declared as ${wanted} and is parsed with ${parser}, which yields ${yields}`,
    `${where}.parse`,
  );
}

/**
 * `ExtractSpec.columnHeaders` names columns the contract actually declares.
 *
 * A typo here is the worst kind of quiet: an unknown key is simply never consulted, so the read
 * falls back to matching the contract's own column name against the screen, works perfectly at the
 * tenant the artifact was recorded on, and fails at the next one with `missing-column` - which is
 * the failure the map was added to prevent. Caught at link, in front of the surface, with the name
 * that was misspelled.
 */
function checkColumnHeaders(
  field: JsonObject,
  spec: JsonObject,
  name: string | null,
  where: string,
  add: Report,
): void {
  const map = asObject(spec.columnHeaders);
  if (map === null) return;
  const declared = new Set(
    asObjects(asObject(field.type)?.columns)
      .map((c) => asString(c.name))
      .filter(nonNull),
  );
  for (const key of Object.keys(map)) {
    if (declared.has(key)) continue;
    add(
      7,
      "output-type-mismatch",
      `${name} maps a screen header onto column ${JSON.stringify(key)}, which its declared table type does not have; the mapping would never be consulted`,
      `${where}.columnHeaders.${key}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 8 - the outcome vocabulary is closed in both directions
// ---------------------------------------------------------------------------------------------

function checkOutcomes(view: View, add: Report): void {
  const declared = new Set(view.outcomes.map((o) => asString(o.code)).filter(nonNull));
  const detected = new Set<string>();

  view.steps.forEach((step, i) => {
    asObjects(step.outcomes).forEach((rule, j) => {
      const code = asString(rule.code);
      if (code === null) return;
      detected.add(code);
      if (declared.has(code)) return;
      add(
        8,
        "outcome-undeclared",
        `step ${view.stepIds[i]} detects ${code}, which the pinned contract does not declare; a caller compiled against this contract has never heard of it`,
        `${stepPath(i)}.outcomes.${j}.code`,
      );
    });
  });

  // The mitigation OPEN-QUESTIONS-RESOLVED Q2 attaches to per-step scoping. Scoping is what catches
  // "MEMBER_NOT_FOUND was detected at a step where it is impossible"; this is what catches the cost
  // of it - a scoping mistake that silently disabled a detector, leaving a declared outcome that no
  // run can ever produce.
  view.outcomes.forEach((outcome, i) => {
    const code = asString(outcome.code);
    if (code === null || detected.has(code)) return;
    add(
      8,
      "outcome-unreachable",
      `the contract declares ${code} and no step can detect it; a caller is promised an answer this program cannot give`,
      `outcomes.${i}.code`,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// 9 - no tie inside one step's own declared set
// ---------------------------------------------------------------------------------------------

function checkPriorities(view: View, add: Report): void {
  const collide = (
    label: string,
    where: string,
    rules: readonly JsonObject[],
    key: (r: JsonObject) => string | null,
  ): void => {
    const seen = new Map<string, string>();
    for (const rule of rules) {
      const priority = asInteger(rule.priority);
      const name = key(rule);
      if (priority === null || name === null) continue;
      const first = seen.get(String(priority));
      if (first !== undefined) {
        add(
          9,
          "priority-collision",
          `${label}: ${first} and ${name} both declare priority ${priority}, which would be a coin flip at runtime`,
          where,
        );
        continue;
      }
      seen.set(String(priority), name);
    }
  };
  const names = (
    label: string,
    where: string,
    rules: readonly JsonObject[],
    key: (r: JsonObject) => string | null,
  ): void => {
    const seen = new Set<string>();
    for (const rule of rules) {
      const name = key(rule);
      if (name === null) continue;
      if (seen.has(name)) {
        add(9, "duplicate-rule-name", `${label}: ${name} is declared twice`, where);
      }
      seen.add(name);
    }
  };

  view.steps.forEach((step, i) => {
    const id = view.stepIds[i];
    collide(`step ${id} outcomes`, `${stepPath(i)}.outcomes`, asObjects(step.outcomes), (r) =>
      asString(r.code),
    );
    names(`step ${id} outcomes`, `${stepPath(i)}.outcomes`, asObjects(step.outcomes), (r) =>
      asString(r.code),
    );
    collide(`step ${id} recoveries`, `${stepPath(i)}.recoveries`, asObjects(step.recoveries), (r) =>
      asString(r.name),
    );
    names(`step ${id} recoveries`, `${stepPath(i)}.recoveries`, asObjects(step.recoveries), (r) =>
      asString(r.name),
    );
  });
  // Ambient rules are their own declared set. A collision between an ambient rule and a step rule is
  // a RUNTIME `ambiguous-classification`, not a link error: the two sets are declared in different
  // places by different people, and refusing every artifact whose ambient priority happens to equal
  // some step's would make the ambient mechanism unusable.
  collide("ambient recoveries", "flow.ambient", view.ambient, (r) => asString(r.name));
  names("ambient recoveries", "flow.ambient", view.ambient, (r) => asString(r.name));
}

// ---------------------------------------------------------------------------------------------
// 10 and 14 - no locator, and no member data, anywhere in the documents
// ---------------------------------------------------------------------------------------------

function checkText(view: View, merged: MergedProgram, add: Report): void {
  const seen = (value: string, where: string): void => {
    const shape = locatorShapeOf(value);
    if (shape !== null) {
      add(
        10,
        "locator-shaped-string",
        `${JSON.stringify(value)} looks like a ${shape}; describe the control the way a person would - its role and its visible name`,
        where,
      );
      return;
    }
    const pii = piiShapeOf(value);
    if (pii !== null) {
      add(
        14,
        "pii-shaped-text",
        `${JSON.stringify(value)} has the shape of regulated data (${pii}); use a template hole such as {memberId} so the value stays out of the document`,
        where,
      );
    }
  };

  walkRecords(view.flow, (record, path) => {
    // A text matcher: the only author-written free text a resolver or a detector ever compares.
    const mode = asString(record.mode);
    const value = asString(record.value);
    if (value !== null && (mode === "exact" || mode === "contains" || mode === "template")) {
      seen(value, joinPath("flow", `${path}.value`));
    }
    // A literal value, which the type already pins to `public` - re-checked because that is the one
    // place a real value could still be written down on purpose.
    if (record.from === "literal") {
      const literal = asString(record.value);
      if (literal !== null) seen(literal, joinPath("flow", `${path}.value`));
      if (record.sensitivity !== "public") {
        add(
          14,
          "sensitive-literal",
          "a literal value in a program is public by construction; a non-public one would be a persisted secret",
          joinPath("flow", `${path}.sensitivity`),
        );
      }
    }
  });

  // The tenant's own words. These become matcher values through the token mechanism, so they get the
  // same refusal - and a per-tenant file is exactly where somebody writes a real label with a real
  // number in it.
  for (const [tokenName, synonyms] of Object.entries(asObject(view.flow.vocabulary) ?? {})) {
    asStrings(synonyms).forEach((word, i) => seen(word, `flow.vocabulary.${tokenName}.${i}`));
  }
  merged.stripTokens.forEach((word, i) => seen(word, `stripTokens.${i}`));

  // Recorded fingerprints are diagnostics, never lookups - but they are persisted, so the PII half
  // still applies.
  walkRecords(view.flow, (record, path) => {
    if (!("ariaRole" in record)) return;
    const name = asString(record.name);
    if (name === null) return;
    const pii = piiShapeOf(name);
    if (pii !== null) {
      add(
        14,
        "pii-shaped-text",
        `the recorded node name ${JSON.stringify(name)} has the shape of regulated data (${pii})`,
        joinPath("flow", `${path}.name`),
      );
    }
  });
}

// ---------------------------------------------------------------------------------------------
// 11 and 12 - enough independent evidence, and no cycle in it
// ---------------------------------------------------------------------------------------------

const DESCRIPTOR_KINDS = new Set<string>(Object.keys(DESCRIPTOR_RANK));

function targetsOf(view: View): readonly { target: JsonObject; where: string }[] {
  const out: { target: JsonObject; where: string }[] = [];
  walkRecords(view.flow, (record, path) => {
    if (!Array.isArray(record.descriptors) || asObject(record.quorum) === null) return;
    out.push({ target: record, where: joinPath("flow", path) });
  });
  return out;
}

function checkTargets(view: View, when: string, add: Report): void {
  for (const { target, where } of targetsOf(view)) {
    const descriptors = asObjects(target.descriptors);
    const quorum = asObject(target.quorum) ?? {};
    const kinds = descriptors.map((d) => asString(d.kind)).filter(nonNull);
    const sources = new Set(descriptors.map((d) => asString(d.evidenceSource)).filter(nonNull));

    if (descriptors.length < 2) {
      add(
        11,
        "quorum-insufficient",
        `${when} this target has ${descriptors.length} descriptor(s); with nothing to disagree with it, an ambiguity becomes a confident wrong click`,
        `${where}.descriptors`,
      );
    }
    const wantSources = asInteger(quorum.distinctEvidenceSources);
    if (wantSources !== null && sources.size < wantSources) {
      add(
        11,
        "quorum-insufficient",
        `${when} the quorum requires ${wantSources} distinct evidence sources and only ${sources.size} survives: ${[...sources].join(", ") || "none"}`,
        `${where}.descriptors`,
      );
    }
    const wantMin = asInteger(quorum.min);
    if (wantMin !== null && descriptors.length < wantMin) {
      add(
        11,
        "quorum-insufficient",
        `${when} the quorum requires ${wantMin} agreeing descriptors and only ${descriptors.length} survives`,
        `${where}.descriptors`,
      );
    }

    const ranks = kinds
      .map((k) => DESCRIPTOR_RANK[k as DescriptorKind])
      .filter((r) => r !== undefined);
    const best = ranks.length === 0 ? null : Math.min(...ranks);
    if (best === null || best > 3) {
      add(
        11,
        "quorum-insufficient",
        `${when} no descriptor of rank 3 or better survives (role-name, label-anchored or table-cell); position alone is not an identity`,
        `${where}.descriptors`,
      );
    }
    const ordinals = kinds.filter((k) => k === "ordinal-in-container").length;
    if (
      ordinals > 0 &&
      (ordinals === kinds.length || best === DESCRIPTOR_RANK["ordinal-in-container"])
    ) {
      add(
        11,
        "quorum-insufficient",
        `${when} ordinal-in-container is this target's only or highest-ranked descriptor, which is the positional targeting this design exists to avoid`,
        `${where}.descriptors`,
      );
    }
  }
}

/** A geometric descriptor says "the control to the right of THAT one". If THAT one is itself
 *  geometric, nothing in the chain is anchored to an identity and the whole target is a direction
 *  with no origin. `descriptors.ts` makes the cycle unrepresentable; this is the JSON-level
 *  re-check, which is what the merged program needs. */
function checkAnchors(view: View, add: Report): void {
  walkRecords(view.flow, (record, path) => {
    if (asString(record.kind) !== "geometric") return;
    const anchor = asObject(record.anchor);
    if (anchor === null || asString(anchor.kind) !== "geometric") return;
    add(
      12,
      "geometric-anchor-geometric",
      "a geometric descriptor is anchored to another geometric descriptor, so nothing in the chain is anchored to an identity",
      joinPath("flow", `${path}.anchor`),
    );
  });
}

// ---------------------------------------------------------------------------------------------
// 13 - the effect summary is recomputed, not believed
// ---------------------------------------------------------------------------------------------

function checkEffects(view: View, add: Report): void {
  const sensitivity: Record<string, Sensitivity> = {};
  for (const output of view.outputs) {
    const name = asString(output.name);
    const s = asString(output.sensitivity);
    if (name !== null && s !== null) sensitivity[name] = s as Sensitivity;
  }

  // The REAL flow object, not a projection of it: `routesTouched` is collected by walking the whole
  // program - a `navigate` instruction, a remedy's navigate, a declared navigation delta - and a
  // projection would quietly lose two of the three.
  const analysis = analyzeEffects(view.flow as unknown as EffectFlowInput, sensitivity);

  for (const step of analysis.disagreements) {
    add(
      13,
      "effect-class-disagrees",
      `step ${step.stepId} declares ${step.declared} and its instruction derives ${step.derived}; the higher class wins and the run is treated as ${step.effective}`,
      `${stepPath(step.index)}.effect`,
    );
  }

  const stored = asObject(view.artifact.effects) ?? {};
  const expected = analysis.summary;
  const compare = (field: string, got: unknown, want: unknown): void => {
    if (canonicalOrNull(got) === canonicalOrNull(want)) return;
    add(
      13,
      "effects-mismatch",
      `effects.${field} says ${JSON.stringify(got)} and the steps add up to ${JSON.stringify(want)}`,
      `effects.${field}`,
    );
  };
  compare("maxEffect", stored.maxEffect, expected.maxEffect);
  compare("irreversibleSteps", asStrings(stored.irreversibleSteps), [
    ...expected.irreversibleSteps,
  ]);
  compare(
    "routesTouched",
    [...asStrings(stored.routesTouched)].sort(),
    [...expected.routesTouched].sort(),
  );
  compare("reads", stored.reads, expected.reads);
  compare("requiresApproval", stored.requiresApproval, expected.requiresApproval);
  compare("restartSafeUpToPc", stored.restartSafeUpToPc, expected.restartSafeUpToPc);

  if (asString(view.policy.maxEffect) !== expected.maxEffect) {
    add(
      13,
      "effects-mismatch",
      `policy.maxEffect says ${asString(view.policy.maxEffect)} and the steps add up to ${expected.maxEffect}`,
      "policy.maxEffect",
    );
  }
  if (view.policy.requiresApprovalToken !== expected.requiresApproval) {
    add(
      13,
      "effects-mismatch",
      `policy.requiresApprovalToken is derived from the steps and should be ${expected.requiresApproval}`,
      "policy.requiresApprovalToken",
    );
  }
  if (asString(view.contract.effect) !== expected.maxEffect) {
    add(
      13,
      "contract-effect-mismatch",
      `the contract declares effect ${asString(view.contract.effect)} and this program's steps add up to ${expected.maxEffect}`,
      "effect",
    );
  }
  if (view.contract.requiresApproval !== expected.requiresApproval) {
    add(
      13,
      "contract-effect-mismatch",
      `the contract declares requiresApproval ${String(view.contract.requiresApproval)} and this program requires ${expected.requiresApproval}`,
      "requiresApproval",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 15 - a budget that cannot cover the program's own declared recoveries
// ---------------------------------------------------------------------------------------------

function checkBudgets(view: View, add: Report): void {
  const budgets = asObject(view.artifact.budgets) ?? {};
  const positive = ["maxActions", "maxObservations", "maxProgramAttempts", "deadlineMs"] as const;
  for (const field of positive) {
    const value = asInteger(budgets[field]);
    if (value === null || value <= 0) {
      add(
        15,
        "budget-not-finite",
        `budgets.${field} must be a finite positive integer, and is ${JSON.stringify(budgets[field])}`,
        `budgets.${field}`,
      );
    }
  }
  const remediations = asInteger(budgets.maxTotalRemediations);
  if (remediations === null || remediations < 0) {
    add(
      15,
      "budget-not-finite",
      `budgets.maxTotalRemediations must be a finite non-negative integer, and is ${JSON.stringify(budgets.maxTotalRemediations)}`,
      "budgets.maxTotalRemediations",
    );
  }

  const acting = view.steps.filter((s) =>
    actsAtSurface(asString(asObject(s.instruction)?.kind)),
  ).length;
  let remedyActions = 0;
  let declaredRecoveries = 0;
  for (const step of view.steps) {
    for (const rule of asObjects(step.recoveries)) {
      declaredRecoveries += 1;
      remedyActions += remedyCost(rule);
    }
  }
  for (const rule of view.ambient) {
    declaredRecoveries += 1;
    // An ambient rule is evaluated at EVERY step, so its worst case is its cost times the program.
    remedyActions += remedyCost(rule) * view.steps.length;
  }

  const maxActions = asInteger(budgets.maxActions);
  if (maxActions !== null && maxActions < acting + remedyActions) {
    add(
      15,
      "budget-cannot-cover-recoveries",
      `budgets.maxActions is ${maxActions} and the program declares ${acting} acting steps plus up to ${remedyActions} remedy actions; a budget that cannot cover its own recoveries is a link error, not a runtime surprise`,
      "budgets.maxActions",
    );
  }
  if (declaredRecoveries > 0 && remediations === 0) {
    add(
      15,
      "budget-not-finite",
      "the program declares recoveries and budgets.maxTotalRemediations is zero, so none of them could ever be applied",
      "budgets.maxTotalRemediations",
    );
  }
}

function remedyCost(rule: JsonObject): number {
  const remedy = asObject(rule.remedy);
  if (remedy === null || asString(remedy.kind) !== "actions") return 0;
  return asArray(remedy.instructions).length * (asInteger(rule.maxAttempts) ?? 1);
}

const ACTING_KINDS = new Set([
  "navigate",
  "activate",
  "fill",
  "select",
  "setToggle",
  "pressKey",
  "dialog",
]);
const actsAtSurface = (kind: string | null): boolean => kind !== null && ACTING_KINDS.has(kind);

// ---------------------------------------------------------------------------------------------
// 16 - a remedy may clear an obstacle and hand control back, and nothing else
// ---------------------------------------------------------------------------------------------

const FORBIDDEN_IN_REMEDY = new Set(["read", "readTable", "assert"]);

function checkRemedies(view: View, add: Report): void {
  for (const { rule, where } of recoveriesOf(view)) {
    if (asString(rule.afterRemedy) !== "reverify") {
      add(
        16,
        "remedy-not-reverify",
        `recovery ${asString(rule.name)} sets afterRemedy to ${asString(rule.afterRemedy) ?? "nothing"}; a remedy can never set the program counter`,
        `${where}.afterRemedy`,
      );
    }
    const remedy = asObject(rule.remedy);
    if (remedy === null || asString(remedy.kind) !== "actions") continue;
    const instructions = asObjects(remedy.instructions);
    if (instructions.length > 4) {
      add(
        16,
        "remedy-too-long",
        `recovery ${asString(rule.name)} declares ${instructions.length} remedy instructions; a remedy that needs five steps is a flow, and a flow belongs in the program where a reviewer can see it`,
        `${where}.remedy.instructions`,
      );
    }
    instructions.forEach((instruction, i) => {
      const kind = asString(instruction.kind);
      if (kind !== null && FORBIDDEN_IN_REMEDY.has(kind)) {
        add(
          16,
          "remedy-instruction-forbidden",
          `recovery ${asString(rule.name)} remedies with ${kind}; a remedy cannot bind a value or classify`,
          `${where}.remedy.instructions.${i}.kind`,
        );
      }
      if ("recoveries" in instruction || "detect" in instruction) {
        add(
          16,
          "remedy-instruction-forbidden",
          `recovery ${asString(rule.name)} nests a recovery inside its own remedy`,
          `${where}.remedy.instructions.${i}`,
        );
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------
// 17 - this surface can run this program, said at LOAD time
// ---------------------------------------------------------------------------------------------

/**
 * The features a surface can offer, derived from what it advertises it can DO.
 *
 * `SurfaceCapabilities` lists mechanisms - actions, roles, descriptor kinds, container kinds, a
 * bounds unit. `SurfaceFeature` is the vocabulary a program uses to say what it needs. Deriving one
 * from the other rather than adding a self-declared `features` field is deliberate: a driver that
 * simply asserted `geometry` while advertising no bounds unit would be believed, and the whole point
 * of check 17 is to catch that before a browser is launched.
 */
export function surfaceFeaturesOf(capabilities: SurfaceCapabilities): readonly SurfaceFeature[] {
  const has = <T>(list: readonly T[], value: T): boolean => list.includes(value);
  const features: SurfaceFeature[] = [];
  if (capabilities.kind !== "terminal") features.push("accessibility-tree");
  if (capabilities.kind === "terminal" || capabilities.boundsUnit === "cell") {
    features.push("character-grid");
  }
  if (has(capabilities.resolvableDescriptors, "table-cell")) features.push("table-position");
  if (capabilities.containerKinds.length > 0) features.push("containers");
  if (capabilities.boundsUnit !== null && has(capabilities.resolvableDescriptors, "geometric")) {
    features.push("geometry");
  }
  if (has(capabilities.supportedActions, "navigate")) features.push("route");
  if (
    has(capabilities.supportedActions, "acceptDialog") &&
    has(capabilities.supportedActions, "dismissDialog")
  ) {
    features.push("native-dialog-channel");
  }
  return features;
}

/** What each instruction asks the driver to dispatch. `read`, `readTable` and `assert` ask for
 *  nothing, which is why they are absent. */
function actionKindsFor(instruction: JsonObject): readonly string[] {
  switch (asString(instruction.kind)) {
    case "navigate":
      return ["navigate"];
    case "activate":
      return ["click"];
    case "fill":
      return ["type"];
    case "select":
      return ["select"];
    case "setToggle":
      return ["setChecked"];
    case "pressKey":
      return ["pressKey"];
    case "dialog":
      return [instruction.accept === true ? "acceptDialog" : "dismissDialog"];
    default:
      return [];
  }
}

const CONTAINER_KINDS = new Set(["frame", "landmark", "heading-section", "table", "screen"]);

function checkSurface(view: View, capabilities: SurfaceCapabilities, add: Report): void {
  const target = asObject(view.artifact.target) ?? {};
  const available = new Set<string>(surfaceFeaturesOf(capabilities));
  asStrings(target.requires).forEach((feature, i) => {
    if (available.has(feature)) return;
    add(
      17,
      "surface-missing-feature",
      `this program requires the ${feature} feature and the ${capabilities.driver} surface does not offer it; refused at load rather than as a mysterious target-not-found at step six`,
      `target.requires.${i}`,
    );
  });

  const actions = new Set<string>(capabilities.supportedActions);
  const keys = new Set<string>(capabilities.supportedKeys);
  const roles = new Set<string>(capabilities.supportedRoles);
  const descriptors = new Set<string>(capabilities.resolvableDescriptors);
  const containers = new Set<string>(capabilities.containerKinds);

  const checkInstruction = (instruction: JsonObject, where: string): void => {
    for (const action of actionKindsFor(instruction)) {
      if (actions.has(action)) continue;
      add(
        17,
        "surface-missing-action",
        `this program uses ${asString(instruction.kind)}, which needs the ${action} action, and the ${capabilities.driver} surface does not offer it`,
        where,
      );
    }
    const key = asString(instruction.key);
    if (key !== null && !keys.has(key)) {
      add(
        17,
        "surface-missing-key",
        `the ${capabilities.driver} surface cannot press ${key}`,
        `${where}.key`,
      );
    }
  };

  view.steps.forEach((step, i) => {
    const instruction = asObject(step.instruction);
    if (instruction !== null) checkInstruction(instruction, `${stepPath(i)}.instruction`);
  });
  for (const { rule, where } of recoveriesOf(view)) {
    const remedy = asObject(rule.remedy);
    if (remedy === null) continue;
    if (asString(remedy.kind) === "dismiss-native-dialog") {
      const action = remedy.accept === true ? "acceptDialog" : "dismissDialog";
      if (!actions.has(action)) {
        add(
          17,
          "surface-missing-action",
          `recovery ${asString(rule.name)} dismisses a native dialog and the ${capabilities.driver} surface has no dialog channel`,
          `${where}.remedy`,
        );
      }
    }
    asObjects(remedy.instructions).forEach((instruction, i) => {
      checkInstruction(instruction, `${where}.remedy.instructions.${i}`);
    });
  }

  walkRecords(view.flow, (record, path) => {
    const at = (suffix: string) => joinPath("flow", `${path}.${suffix}`);
    for (const field of ["role", "childRole"] as const) {
      const role = asString(record[field]);
      if (role !== null && !roles.has(role)) {
        add(
          17,
          "surface-missing-role",
          `this program names the ${role} role and the ${capabilities.driver} surface does not synthesize it`,
          at(field),
        );
      }
    }
    const kind = asString(record.kind);
    if (kind === null) return;
    if (
      record.evidenceSource !== undefined &&
      DESCRIPTOR_KINDS.has(kind) &&
      !descriptors.has(kind)
    ) {
      add(
        17,
        "surface-missing-descriptor",
        `this program uses a ${kind} descriptor and the ${capabilities.driver} surface cannot resolve one`,
        at("kind"),
      );
    }
    if (CONTAINER_KINDS.has(kind) && record.columns === undefined && !containers.has(kind)) {
      add(
        17,
        "surface-missing-container",
        `this program scopes to a ${kind} container and the ${capabilities.driver} surface has none`,
        at("kind"),
      );
    }
  });
}

// ---------------------------------------------------------------------------------------------
// 18 - the declared language stays inside its own bounds
// ---------------------------------------------------------------------------------------------

const PREDICATE_FIELDS: readonly string[] = ["predicate", "precondition", "detect", "busyWhen"];

function checkLanguage(view: View, add: Report): void {
  walkRecords(view.flow, (record, path) => {
    for (const field of PREDICATE_FIELDS) {
      const predicate = asObject(record[field]);
      if (predicate === null) continue;
      const depth = depthOf(predicate);
      if (depth > MAX_PREDICATE_DEPTH) {
        add(
          18,
          "predicate-too-deep",
          `a predicate nests ${depth} levels and the language allows ${MAX_PREDICATE_DEPTH}; past that the prose renderer produces a sentence nobody can follow`,
          joinPath("flow", `${path}.${field}`),
        );
      }
    }

    const at = (suffix: string) => joinPath("flow", `${path}.${suffix}`);
    registryField(record, "normalize", "normalizer", at, add);
    registryField(record, "via", "normalizer", at, add);
    if ("output" in record && "parse" in record) {
      registryField(record, "from", "extractor", at, add);
      registryField(record, "parse", "parser", at, add);
    }
  });
}

function registryField(
  record: JsonObject,
  field: string,
  kind: "normalizer" | "extractor" | "parser",
  at: (suffix: string) => string,
  add: Report,
): void {
  const id = asString(record[field]);
  if (id === null) return;
  const entry = lookupRegistryEntry(id);
  if (entry === undefined) {
    add(
      18,
      "registry-id-unknown",
      `${id} is not a registered ${kind}; discovering at replay that it was never implemented would surface as a step that silently did nothing`,
      at(field),
    );
    return;
  }
  if (entry.kind !== kind) {
    add(
      18,
      "registry-id-unknown",
      `${id} is a ${entry.kind}, and a ${kind} belongs here`,
      at(field),
    );
  }
}

/**
 * `predicateDepth` made total.
 *
 * `matchers.ts` owns the definition and assumes a document that parsed; the linker sees documents no
 * validator has accepted yet, where `{ all: "oops" }` is representable. This mirrors the same rule -
 * a leaf is depth 1, each connective adds one - and treats anything it does not recognise as a leaf,
 * leaving the node itself to the schema backstop. The boundary the two share is pinned by a test
 * that links a predicate exactly at the ceiling and refuses one past it.
 */
function depthOf(value: unknown): number {
  const record = asObject(value);
  if (record === null) return 1;
  if (Array.isArray(record.all)) return 1 + deepest(record.all);
  if (Array.isArray(record.any)) return 1 + deepest(record.any);
  if ("not" in record) return 1 + depthOf(record.not);
  return 1;
}

function deepest(values: readonly unknown[]): number {
  let best = 0;
  for (const value of values) {
    const depth = depthOf(value);
    if (depth > best) best = depth;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// 19 - a restart may never cross an irreversible step
// ---------------------------------------------------------------------------------------------

function checkRestart(view: View, add: Report): void {
  const resumePoints = new Set(asStrings(view.flow.resumePoints));
  for (const point of resumePoints) {
    if (view.indexOfStep.has(point)) continue;
    add(
      19,
      "resume-point-unknown",
      `flow.resumePoints names ${point}, which is not a step in this flow`,
      "flow.resumePoints",
    );
  }

  const safePc = restartSafeUpToPc(
    view.steps.map((s) => ({ effect: (asString(s.effect) ?? "READ") as EffectClass })),
  );

  for (const { rule, where, step } of recoveriesOf(view)) {
    const resume = asString(rule.resume);
    const name = asString(rule.name);
    if (resume === "restart-from-checkpoint") {
      const at = asString(rule.resumeAt);
      if (at === null || !view.indexOfStep.has(at)) {
        add(
          19,
          "resume-point-unknown",
          `recovery ${name} restarts at ${at ?? "nothing"}, which is not a step in this flow`,
          `${where}.resumeAt`,
        );
        continue;
      }
      if (!resumePoints.has(at)) {
        add(
          19,
          "resume-point-unknown",
          `recovery ${name} restarts at ${at}, which flow.resumePoints does not declare as a safe idempotent re-entry point`,
          `${where}.resumeAt`,
        );
      }
      const from = view.indexOfStep.get(at) as number;
      const to = step ?? view.steps.length;
      if (from > to) {
        add(
          19,
          "resume-point-unknown",
          `recovery ${name} restarts at ${at}, which runs after the step it is declared on`,
          `${where}.resumeAt`,
        );
        continue;
      }
      for (let k = from; k < to; k += 1) {
        if (asString(view.steps[k]?.effect) !== "WRITE_IRREVERSIBLE") continue;
        add(
          19,
          "restart-crosses-irreversible",
          `recovery ${name} would restart across irreversible step ${view.stepIds[k]}; this is how a retry opens two sub-accounts`,
          `${where}.resumeAt`,
        );
      }
    }
    if (resume === "restart-program" && step !== null && step > safePc) {
      add(
        19,
        "restart-beyond-safe-pc",
        `recovery ${name} restarts the program from step ${step}, and restartSafeUpToPc is ${safePc}; past that gate the only correct move is a person, not a retry`,
        `${where}.resume`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 20 - the overlay changed how a control is found, and nothing else
// ---------------------------------------------------------------------------------------------

function checkOverlay(base: JsonObject, merged: MergedProgram, add: Report): void {
  for (const problem of merged.problems) add(20, problem.code, problem.message, problem.where);

  // The comparison runs over the merge's OUTPUT rather than over the overlay's input, so a bug in
  // the merger is caught by the same check that catches a hostile overlay.
  const before = asObjects(asObject(base.flow)?.steps);
  const after = asObjects(asObject(merged.document.flow)?.steps);
  const ids = (steps: readonly JsonObject[]) => steps.map((s) => asString(s.id)).join(",");
  if (ids(before) !== ids(after)) {
    add(
      20,
      "overlay-changes-meaning",
      "the merge changed the step list; an overlay adds no step and removes none",
      "flow.steps",
    );
    return;
  }
  before.forEach((step, i) => {
    const was = spineOf(step);
    const now = spineOf(after[i] ?? {});
    if (was === now) return;
    add(
      20,
      "overlay-changes-meaning",
      `step ${asString(step.id)} means something different after the overlay; an overlay may change how a control is found, never the effect class, the instruction, the checkpoint predicate or an outcome code`,
      `${stepPath(i)}`,
    );
  });
  const ambientBefore = canonicalOrNull(asObject(base.flow)?.ambient);
  const ambientAfter = canonicalOrNull(asObject(merged.document.flow)?.ambient);
  if (ambientBefore !== ambientAfter) {
    add(
      20,
      "overlay-changes-meaning",
      "the merge changed the flow's ambient rules, which an overlay may not address",
      "flow.ambient",
    );
  }
}

/**
 * The part of a step an overlay may not touch.
 *
 * Descriptors, settle, budgets and recoveries are excluded because those are exactly what an overlay
 * exists to change. Table header SETS are blanked because `tableHeaders` legitimately rewrites them
 * wherever the grid is named - the predicate around them still has to be identical.
 */
function spineOf(step: JsonObject): string {
  const outcomes = asObjects(step.outcomes).map((o) => ({
    code: o.code,
    detect: o.detect,
    priority: o.priority,
    phase: o.phase,
    requiresSettled: o.requiresSettled,
    capture: o.capture,
  }));
  return (
    canonicalOrNull(
      blankTableHeaders({
        id: step.id,
        effect: step.effect,
        instruction: step.instruction,
        precondition: step.precondition,
        expect: step.expect,
        extract: step.extract,
        evidence: step.evidence,
        outcomes,
        assert: asObject(step.target)?.assert ?? null,
      }),
    ) ?? ""
  );
}

function blankTableHeaders(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(blankTableHeaders);
  const record = asObject(value);
  if (record === null) return value;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(record)) {
    out[key] =
      key === "headers" && record.kind === "table" ? "<headers>" : blankTableHeaders(child);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 21 to 25 - the small refusals that each close one specific quiet failure
// ---------------------------------------------------------------------------------------------

const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;

function checkKeys(view: View, add: Report): void {
  const look = (instruction: JsonObject, where: string): void => {
    const key = asString(instruction.key);
    if (key === null || !FUNCTION_KEY.test(key)) return;
    add(
      21,
      "function-key-in-artifact",
      `this program presses ${key}; the terminal spike measured the same Exit control bound to F3 at one tenant and F12 at the next, so the artifact says what the operator MEANT and the driver chooses the key`,
      where,
    );
  };
  view.steps.forEach((step, i) => {
    const instruction = asObject(step.instruction);
    if (instruction !== null) look(instruction, `${stepPath(i)}.instruction`);
  });
  for (const { rule, where } of recoveriesOf(view)) {
    asObjects(asObject(rule.remedy)?.instructions).forEach((instruction, i) => {
      look(instruction, `${where}.remedy.instructions.${i}`);
    });
  }
}

function checkRuleShapes(view: View, add: Report): void {
  view.steps.forEach((step, i) => {
    asObjects(step.outcomes).forEach((rule, j) => {
      const where = `${stepPath(i)}.outcomes.${j}`;
      if (asString(rule.phase) !== "post") {
        add(
          22,
          "outcome-rule-phase",
          `outcome ${asString(rule.code)} is declared at phase ${asString(rule.phase)}; a detector that fires before the step that would produce it is reading a stale banner`,
          `${where}.phase`,
        );
      }
      if (rule.requiresSettled !== true) {
        add(
          22,
          "outcome-rule-unsettled",
          `outcome ${asString(rule.code)} does not require a settled surface; against a half-painted screen "no member found" is indistinguishable from "not painted yet"`,
          `${where}.requiresSettled`,
        );
      }
      if ("allowUnsettled" in rule) {
        add(
          22,
          "outcome-rule-unsettled",
          `outcome ${asString(rule.code)} carries allowUnsettled; no business outcome may be classified against a surface that has not demonstrably settled`,
          `${where}.allowUnsettled`,
        );
      }
    });
  });

  for (const { rule, where } of recoveriesOf(view)) {
    if (rule.allowUnsettled !== true) continue;
    if (asString(rule.band) === "environment") continue;
    add(
      23,
      "unsettled-outside-environment",
      `recovery ${asString(rule.name)} is in band ${asString(rule.band)} and claims allowUnsettled; only an environment condition explains WHY a surface will never settle`,
      `${where}.allowUnsettled`,
    );
  }
}

function checkTableReads(view: View, add: Report): void {
  view.steps.forEach((step, i) => {
    const isTable = asString(asObject(step.instruction)?.kind) === "readTable";
    const specs: { spec: JsonObject; where: string }[] = [];
    asObjects(step.extract).forEach((spec, j) =>
      specs.push({ spec, where: `${stepPath(i)}.extract.${j}` }),
    );
    asObjects(step.outcomes).forEach((rule, j) =>
      asObjects(rule.capture).forEach((spec, k) =>
        specs.push({ spec, where: `${stepPath(i)}.outcomes.${j}.capture.${k}` }),
      ),
    );
    for (const { spec, where } of specs) {
      const rows = asObject(spec.rows);
      if (!isTable) {
        if (rows !== null) {
          add(
            24,
            "table-read-unbounded",
            `${asString(spec.output)} declares row bounds and this step does not read a table`,
            `${where}.rows`,
          );
        }
        continue;
      }
      if (rows === null) {
        add(
          24,
          "table-read-unbounded",
          `${asString(spec.output)} is read from a table and declares no row bounds; silent truncation of a member's share list is exactly the quiet wrongness this design exists to prevent`,
          where,
        );
        continue;
      }
      if (asString(rows.onTruncate) !== "fail") {
        add(
          24,
          "table-read-unbounded",
          `${asString(spec.output)} does not fail on truncation`,
          `${where}.rows.onTruncate`,
        );
      }
      const min = asInteger(rows.minRows);
      const max = asInteger(rows.maxRows);
      if (min === null || min < 1 || max === null || max < min) {
        add(
          24,
          "table-read-unbounded",
          `${asString(spec.output)} declares row bounds of ${JSON.stringify(rows.minRows)}..${JSON.stringify(rows.maxRows)}`,
          `${where}.rows`,
        );
      }
    }
  });
}

/**
 * 25 - every step has a postcondition, and a step that declared a DIALOG is held to what declaring
 * one costs.
 *
 * The second half is the linker check SPEC section 4.4's `expect.dialog` amendment needs to stay
 * honest. The clause tells band B2 to stand down for the dialog a step declared, and B2 is the band
 * that stops an automation answering a prompt nobody modelled - so the licence has to be paid for
 * at load time, before a browser is launched, rather than trusted at runtime.
 *
 * Three obligations, and each closes a specific way the clause could be turned back into a hole.
 */
function checkCheckpoints(view: View, add: Report): void {
  const lastIndex = view.steps.length - 1;
  view.steps.forEach((step, i) => {
    const expect = asObject(step.expect);
    if (expect === null) {
      add(
        25,
        "checkpoint-missing",
        `step ${view.stepIds[i]} declares no postcondition; a step with nothing to verify is a step that proceeds blindly, and it costs one required field to make that unrepresentable`,
        `${stepPath(i)}.expect`,
      );
      return;
    }

    const dialog = asObject(expect.dialog);
    if (dialog === null) return;
    const at = `${stepPath(i)}.expect.dialog`;
    const stepId = view.stepIds[i];

    // (a) THE QUERY HAS TO NAME A DIALOG. Band B2 stands down only when every open dialog node is
    //     one this query selects, so a query that cannot select a dialog at all silently never
    //     stands down - a step that looks declared and behaves undeclared. Refusing it here turns a
    //     mysterious `undeclared-dialog` at step six into a message at load.
    if (asString(asObject(dialog.where)?.role) !== "dialog") {
      add(
        25,
        "checkpoint-dialog-not-a-dialog",
        `step ${stepId} expects a dialog and its query does not constrain \`role: "dialog"\`; the interception band stands down only for open dialog nodes this query selects, so a query that cannot select one would leave the step declared on paper and undeclared in fact`,
        `${at}.where.role`,
      );
    }

    if (dialog.present !== true) return;

    // (b) A STEP BEHIND ITS OWN DIALOG MAY DECLARE NO BUSINESS OUTCOME AND READ NO VALUE.
    //     This is the half of "B2 before B3" that is TRUE and that the amendment must not spend:
    //     what is visible behind a modal is the state before whatever raised it, so an outcome
    //     classified there, or a value delivered to a caller from there, is history. The classifier
    //     enforces the outcome half structurally as well; this makes it a document error rather
    //     than a rule that silently does nothing.
    for (const [field, why] of [
      ["outcomes", "a terminal business outcome read off the screen behind a modal is history"],
      ["extract", "a value read off the screen behind a modal is the value before it was raised"],
    ] as const) {
      const count = asArray(step[field]).length;
      if (count === 0) continue;
      add(
        25,
        "checkpoint-dialog-shadows-declarations",
        `step ${stepId} expects a dialog to be OPEN at its checkpoint and declares ${count} ${field}; ${why}. Declare them on the step that answers the dialog instead`,
        `${stepPath(i)}.${field}`,
      );
    }

    // (c) A PROGRAM MAY NOT END WITH A DIALOG OPEN. The last step's postcondition is the state the
    //     automation hands back - to a caller, or to a human through the operator console - and a
    //     blocked screen is not a state anybody can be handed. Whatever raised the dialog has to be
    //     answered inside the program that raised it.
    if (i === lastIndex) {
      add(
        25,
        "checkpoint-dialog-left-open",
        `step ${stepId} is the last step and its postcondition is that a dialog is OPEN; a program may not finish on a blocked screen, so the step that answers this dialog belongs inside the flow that raised it`,
        at,
      );
    }
  });
}

// ---------------------------------------------------------------------------------------------
// 26 - every route this program can reach is permitted, twice over
// ---------------------------------------------------------------------------------------------

function checkRoutes(view: View, allowlist: Allowlist | null, add: Report): void {
  const byId = new Map<string, JsonObject>();
  for (const route of view.routes) {
    const id = asString(route.id);
    if (id !== null) byId.set(id, route);
  }
  const declaredAliases = new Set(asStrings(view.policy.originAliases));

  const reachable = new Set<string>();
  const entry = asString(asObject(view.flow.entry)?.route);
  if (entry !== null) reachable.add(entry);
  walkRecords(view.flow, (record) => {
    if (asString(record.kind) === "navigate") {
      const id = asString(record.route);
      if (id !== null) reachable.add(id);
    }
    const navigated = asString(record.navigatedTo);
    if (navigated !== null) reachable.add(navigated);
  });

  for (const id of reachable) {
    const route = byId.get(id);
    if (route === undefined) {
      add(
        26,
        "route-undeclared",
        `route ${id} is referenced and flow.routes does not declare it`,
        "flow.routes",
      );
      continue;
    }
    const alias = asString(route.originAlias);
    const path = asString(route.path);
    if (alias === null || path === null) continue;
    if (!declaredAliases.has(alias)) {
      add(
        26,
        "route-origin-not-allowed",
        `route ${id} uses origin alias ${alias}, which policy.originAliases does not permit`,
        "policy.originAliases",
      );
    }
    if (!pathIsCanonicalShape(path)) {
      add(
        26,
        "route-not-canonical",
        `route ${id} has path ${path}, which is not a canonical shape`,
        "flow.routes",
      );
    }
    if (allowlist === null) continue;
    if (!allowlist.originAliases.includes(alias)) {
      add(
        26,
        "route-not-in-allowlist",
        `the caller's allowlist does not permit origin alias ${alias}`,
        "flow.routes",
      );
      continue;
    }
    if (matchRoute(allowlist, alias, path) === null) {
      add(
        26,
        "route-not-in-allowlist",
        `the caller's allowlist has no entry covering ${alias}${path}, and this program can navigate there`,
        "flow.routes",
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 27 - replay runs an approved artifact, signed by a key this deployment trusts
// ---------------------------------------------------------------------------------------------

function checkApproval(
  artifact: JsonObject,
  mode: LinkMode,
  trust: ApprovalTrust | null,
  add: Report,
): void {
  if (mode !== "replay") return;
  const lifecycle = asObject(artifact.lifecycle) ?? {};
  const status = asString(lifecycle.status);
  if (status !== "approved") {
    add(
      27,
      "artifact-not-approved",
      `replay runs approved artifacts and this one is ${status ?? "unlabelled"}; verification replay is how a draft earns that label`,
      "lifecycle.status",
    );
    return;
  }
  const approval = asObject(lifecycle.approval);
  if (approval === null) {
    add(
      27,
      "artifact-not-approved",
      "the artifact claims approval and carries none; the signature is the approval",
      "lifecycle.approval",
    );
    return;
  }
  const digest = asString(artifact.digest);
  if (asString(approval.over) !== digest) {
    add(
      27,
      "signature-invalid",
      "the approval signs a digest other than this document's own",
      "lifecycle.approval.over",
    );
  }
  if (trust === null) {
    add(
      27,
      "no-trust-store",
      "replay was asked for with no approver trust store, so no signature could be verified; an unverifiable approval is not an approval",
      "lifecycle.approval",
    );
    return;
  }
  const keyId = asString(approval.keyId);
  if (keyId === null || !trust.trustedKeyIds.includes(keyId)) {
    add(
      27,
      "signing-key-untrusted",
      `the approval was signed by key ${keyId ?? "nothing"}, which this deployment does not trust`,
      "lifecycle.approval.keyId",
    );
    return;
  }
  const ok = trust.verifySignature({
    over: asString(approval.over) ?? "",
    keyId,
    alg: asString(approval.alg) ?? "",
    signature: asString(approval.signature) ?? "",
  });
  if (!ok) {
    add(
      27,
      "signature-invalid",
      "the approval signature does not verify over this artifact's digest",
      "lifecycle.approval.signature",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// 28 - the arguments bind
// ---------------------------------------------------------------------------------------------

interface Binding {
  readonly bindings: ResolvedBindings;
}

/** The grammar `mintTaintHandle` accepts. Checked before calling rather than caught after, so the
 *  linker never depends on an exception for control flow. */
const HANDLE_SAFE_PARAM = /^[A-Za-z_][A-Za-z0-9_]*$/;

function bindArguments(
  contract: JsonObject,
  args: Readonly<Record<string, unknown>>,
  add: Report,
): Binding {
  const inputs = asObjects(contract.inputs);
  const declared = new Set(inputs.map((i) => asString(i.name)).filter(nonNull));
  const bindings: ResolvedBinding[] = [];
  let taintOrdinal = 0;

  for (const name of Object.keys(args)) {
    if (declared.has(name)) continue;
    add(28, "argument-unknown", `${name} is not a parameter of this capability`, `args.${name}`);
  }

  for (const spec of inputs) {
    const name = asString(spec.name);
    if (name === null) continue;
    const supplied = args[name];
    const required = spec.required === true;
    if (supplied === undefined || supplied === null) {
      if (required)
        add(28, "argument-missing", `${name} is required and was not supplied`, `args.${name}`);
      continue;
    }
    const reason = argumentProblem(supplied, spec);
    if (reason !== null) {
      add(28, "argument-invalid", `${name} ${reason}`, `args.${name}`);
      continue;
    }
    const sensitivity = (asString(spec.sensitivity) ?? "internal") as Sensitivity;
    let handle: ResolvedBinding["handle"] = null;
    if (sensitivity === "sensitive") {
      taintOrdinal += 1;
      // A handle names the BINDING, never the value, so minting one refuses a parameter name that is
      // not a field name. A malformed contract can still be in front of us here - the schema
      // backstop runs after this - and a pre-flight gate that throws is the one failure a caller
      // cannot see, cannot classify and cannot report honestly.
      handle = HANDLE_SAFE_PARAM.test(name) ? mintTaintHandle(name, taintOrdinal) : null;
      if (handle === null) {
        add(28, "argument-invalid", `${name} is not a usable parameter name`, `args.${name}`);
        continue;
      }
    }
    bindings.push({ name, origin: "param", value: comparableText(supplied), sensitivity, handle });
  }

  return { bindings };
}

/** Why this argument does not satisfy its parameter, or `null`. Prose, because the message goes to a
 *  model that has to ask a person for the value again. */
function argumentProblem(value: unknown, spec: JsonObject): string | null {
  const type = asObject(spec.type) ?? {};
  const kind = asString(type.kind);
  const constraints = asObject(spec.constraints) ?? {};

  switch (kind) {
    case "string": {
      if (typeof value !== "string") return `must be text, and a ${typeof value} was supplied`;
      return stringProblem(value, { ...type, ...constraints });
    }
    case "integer": {
      if (!Number.isSafeInteger(value)) return "must be a whole number";
      const min = asInteger(type.min);
      const max = asInteger(type.max);
      if (min !== null && (value as number) < min) return `must be at least ${min}`;
      if (max !== null && (value as number) > max) return `must be at most ${max}`;
      return null;
    }
    case "decimal":
      return typeof value === "string" && isDecimal(value)
        ? null
        : "must be a decimal written as a plain string, with no exponent and no separators";
    case "money": {
      const money = asObject(value);
      const amount = asString(money?.amount);
      if (money === null || amount === null || !isDecimal(amount)) {
        return "must be an amount and a currency, with the amount written as a plain decimal string";
      }
      return money.currency === "USD" ? null : "must be in USD";
    }
    case "date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? null
        : "must be a date written as YYYY-MM-DD";
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "enum": {
      if (typeof value !== "string") return "must be one of the declared values";
      const values = asStrings(type.values);
      return values.includes(value) ? null : `must be one of ${values.join(", ")}`;
    }
    case "table":
      return Array.isArray(value) ? null : "must be a list of rows";
    default:
      return null;
  }
}

function stringProblem(value: string, rules: JsonObject): string | null {
  const charset = asString(rules.charset);
  if (charset === "digits" && !/^[0-9]+$/.test(value)) return "must be digits only";
  if (charset === "alnum" && !/^[0-9A-Za-z]+$/.test(value))
    return "must be letters and digits only";
  const min = asInteger(rules.minLength);
  const max = asInteger(rules.maxLength);
  if (min !== null && value.length < min) return `must be at least ${min} characters`;
  if (max !== null && value.length > max) return `must be at most ${max} characters`;
  const allowed = asStrings(rules.enum);
  if (allowed.length > 0 && !allowed.includes(value)) return `must be one of ${allowed.join(", ")}`;
  return null;
}

/**
 * The text form a bound value is COMPARED against a screen in.
 *
 * `ResolvedBinding.value` is a string because every comparison it takes part in - a row key, a
 * continuity assertion, a value read back out of a field - happens against text a surface produced.
 * Nothing renders it: the classifier's own tests assert by grep that no verdict ever contains one.
 */
function comparableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const money = asObject(value);
  const amount = asString(money?.amount);
  if (amount !== null) return amount;
  return canonicalOrNull(value) ?? "";
}

// ---------------------------------------------------------------------------------------------
// Assembling what the interpreter gets
// ---------------------------------------------------------------------------------------------

function assemble(
  contract: CapabilityContract,
  artifact: CapabilityArtifact,
  merged: CapabilityArtifact,
  overlay: CapabilityOverlay | null,
  mergedProgram: MergedProgram,
  binding: Binding,
): LinkedProgram {
  const sensitivity: Record<string, Sensitivity> = {};
  for (const output of contract.outputs) sensitivity[output.name] = output.sensitivity;

  const analysis = analyzeEffects(merged.flow, sensitivity);

  const outputs: Record<string, { readonly type: ValueType; readonly sensitivity: Sensitivity }> =
    {};
  for (const output of contract.outputs) {
    outputs[output.name] = { type: output.type, sensitivity: output.sensitivity };
  }
  // Outcome payload fields are read by the same extractor as a contract output, so the classifier
  // needs their declared types too. A contract output wins a name collision: it is the one a
  // caller's generated types are built from.
  for (const outcome of contract.outcomes) {
    for (const field of outcome.payload) {
      if (outputs[field.name] === undefined) {
        outputs[field.name] = { type: field.type, sensitivity: field.sensitivity };
      }
    }
  }

  const routeById = new Map(merged.flow.routes.map((r) => [r.id as string, r]));
  const steps = merged.flow.steps.map((step, index) => {
    const route =
      step.instruction.kind === "navigate"
        ? routeById.get(step.instruction.route as string)
        : undefined;
    return ResolvedStepSchema.parse({
      ...cloneJson(step),
      index,
      route: route === undefined ? null : { originAlias: route.originAlias, path: route.path },
    }) as ResolvedStep;
  });

  const facts: ProgramFacts = {
    routes: merged.flow.routes,
    vocabulary: merged.flow.vocabulary as Readonly<Record<string, readonly string[]>>,
    continuity: merged.continuity,
    outputs,
    brandingTokens: mergedProgram.stripTokens,
    maxEffect: analysis.summary.maxEffect,
    restartSafeUpToPc: analysis.summary.restartSafeUpToPc,
    resumePoints: merged.flow.resumePoints,
  };

  return {
    linkerVersion: LINKER_VERSION,
    contract,
    artifact,
    overlay,
    merged,
    flow: merged.flow,
    steps,
    ambient: merged.flow.ambient,
    facts,
    bindings: binding.bindings,
    effects: analysis.summary,
    perStepEffects: analysis.perStep,
    originBindings: mergedProgram.originBindings,
    disabledDescriptors: mergedProgram.disabledDescriptors,
    effectiveDigest: effectiveDigestOf(artifact.digest, overlay?.digest ?? null, LINKER_VERSION),
  };
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

interface ValidationFailure {
  readonly success: false;
  readonly error: { readonly issues: readonly ValidationIssue[] };
}
interface ValidationIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly errors?: readonly (readonly ValidationIssue[])[];
}

function reportValidation(kind: string, parsed: { readonly success: boolean }, add: Report): void {
  if (parsed.success) return;
  const failure = parsed as unknown as ValidationFailure;
  for (const problem of explainValidationError(failure.error)) {
    add(
      1,
      "document-invalid",
      `the ${kind} carries a construct this engine does not recognise: ${problem}`,
    );
  }
}

function canonicalOrNull(value: unknown): string | null {
  try {
    return canonicalJson(value);
  } catch {
    return null;
  }
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function truncate(value: string | null, max: number): string | null {
  return value === null ? null : clip(value, max);
}

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}
