// Artifact emission - SPEC section 1.1's SYNTHESIS box, with no model in it.
//
// A `DiscoveryRun` is a recording: what the model did, on which screens, with which values. A
// `CapabilityArtifact` is a PROGRAM: a straight line of typed steps whose targets are derived,
// whose values are parameters, whose routes are patterns and whose effects are analysed statically.
// This file is the function between them, and everything it does is deterministic - same run, same
// documents, byte for byte, including the digest.
//
// FOUR PROPERTIES THIS FILE IS RESPONSIBLE FOR.
//
//   1. NO RECORDED VALUE SURVIVES. Every string that reaches a document passes through
//      `parameterizeText`, and then the finished documents are walked exhaustively and refused if a
//      value is found anyway (`values.ts`). The emitter does not trust its own discipline; a
//      substitution applied at forty call sites is one somebody forgets at the forty-first.
//   2. EVERY CHECKPOINT DEMONSTRABLY HELD AT RECORD TIME. Each candidate postcondition is evaluated
//      by `@crr/core`'s own `evaluatePredicate` against the observation the step actually produced,
//      and a conjunct that did not hold is dropped rather than shipped. A recorder that emits a
//      checkpoint which was already false is a recorder that manufactures a red replay.
//   3. EVERY EXTRACTION WAS TRIED. `readExtractSpec` is run against the recorded observation, so a
//      spec whose query is ambiguous or whose parser refuses the value is a blocking problem here
//      rather than an `output-extraction-failed` on the caller's first real invocation.
//   4. NOTHING IS INFERRED INTO AN OUTCOME. SPEC section 0.2. The model's outcome candidates go to
//      the report; no `detect` predicate is written for a screen the run never saw.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not sign, approve, or verify: a synthesized artifact is
// `proposed` and `unverified`, and it reaches `draft` only by replaying itself with the model out of
// the loop (SPEC section 6.6, build unit 15). It does not read a clock - every timestamp is passed
// in - so a fixture run produces a byte-identical artifact every time.

import {
  type ArtifactKey,
  ArtifactKeySchema,
  type CapabilityArtifact,
  type CapabilityContract,
  type Checkpoint,
  type ContinuityDef,
  type Draft,
  type EffectClass,
  type EvalContext,
  type ExtractSpec,
  type Instruction,
  type NodeQuery,
  type Observation,
  type OutputSpec,
  type ParamSpec,
  type Predicate,
  type RecoveryRule,
  type ResolvedBinding,
  type RouteId,
  type RoutePattern,
  SETTLE_POLICY_DEFAULTS,
  type Sensitivity,
  type Step,
  type StepId,
  StepIdSchema,
  type SurfaceCapabilities,
  type SurfaceFeature,
  type TargetRef,
  type Timestamp,
  type UINode,
  type ValueRef,
  type ValueType,
  analyzeEffects,
  artifactDigestIsIntact,
  evaluatePredicate,
  explainValidationError,
  instructionActs,
  readExtractSpec,
  safeParseArtifact,
  safeParseContract,
  sealArtifact,
  sealContract,
} from "@crr/core";
import type { DiscoveryRun, RecordedStep } from "../loop.js";
import {
  type DescriptorDerivation,
  Vocabulary,
  containerMatcherOf,
  deriveDescriptors,
  targetRefOf,
} from "./descriptors.js";
import { surfaceFingerprintOf } from "./fingerprint.js";
import { type DerivedOutput, deriveOutputs } from "./outputs.js";
import { inferParameters } from "./parameters.js";
import { SynthesisError, type SynthesisNote, type SynthesisReport } from "./report.js";
import { RouteTable } from "./routes.js";
import {
  type ValueBinding,
  findBoundValues,
  parameterizeText,
  slugOf,
  uniqueName,
} from "./values.js";

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

export interface SynthesizeInput {
  readonly run: DiscoveryRun;
  /** Names and prose a person owns. Synthesis derives the program; it does not name the product. */
  readonly capability: {
    readonly name: string;
    readonly version?: string;
    readonly title: string;
    readonly summary: string;
    readonly whenToUse?: readonly string[];
    readonly whenNotToUse?: readonly string[];
  };
  readonly vendor: {
    /** The vendor PRODUCT, not the tenant. This is the unit of reuse across hundreds of tenants. */
    readonly product: string;
    readonly productVersionRange: string;
    /** A named credential profile. The artifact names it; it never carries material. */
    readonly sessionProfile: string;
  };
  /** What the driver that recorded the run advertises. Descriptor kinds it cannot resolve are never
   *  recorded as evidence it will never supply. */
  readonly capabilities: SurfaceCapabilities;
  readonly tenantId: string;
  readonly appInstanceId: string;
  readonly runId: string;
  /** Injected. This module reads no clock, so a fixture run is byte-reproducible. */
  readonly recordedAt: Timestamp;
  readonly promptVersion: string;
  /** A POINTER to the transcript, never the transcript. */
  readonly transcriptRef?: { readonly digest: string; readonly uri: string } | null;
  readonly artifactVersion?: number;
}

export interface SynthesisResult {
  readonly contract: CapabilityContract;
  readonly artifact: CapabilityArtifact;
  readonly report: SynthesisReport;
}

/**
 * Routing prose synthesis will not write.
 *
 * SPEC section 2.3: models mis-route far more often than they mis-fill arguments, so `whenToUse`
 * and `whenNotToUse` are the highest-leverage prose in the whole system. A generated line there is
 * a generated routing decision, and the report says so rather than the catalog pretending somebody
 * thought about it.
 */
export const PROSE_PLACEHOLDER =
  "NEEDS AN AUTHOR: a person must write this before the capability is published.";

// ---------------------------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------------------------

export function synthesizeCapability(input: SynthesizeInput): SynthesisResult {
  const { run } = input;
  const notes: SynthesisNote[] = [];

  // BRIEF section 10's provenance honesty rules, enforced one layer down by a type: the artifact's
  // `Provenance.model.adapter` has no spelling for a hand-authored script, and inventing one -
  // "call it replay, nobody will look" - is the exact dishonesty those rules exist to stop.
  if (run.adapter === "scripted") {
    throw new SynthesisError(
      "a run driven by a hand-authored script is a debugging aid, not a discovery run, and the artifact's provenance vocabulary has no spelling for it; replay the recorded transcript through the `replay` adapter, or use a real one",
    );
  }

  // `capabilities` is passed for one reason: it decides whether the parameter namer may use the
  // ADJACENT-LABEL rung of its chain, which is a geometric claim and needs a bounds unit. On a
  // frameset whose search fields have no accessible name, that rung is the difference between an
  // argument called `memberId` and one called `value1`.
  const inferred = inferParameters({
    goal: run.goal,
    steps: run.steps,
    capabilities: input.capabilities,
  });
  notes.push(...inferred.notes);
  const bindings = inferred.bindings;
  const vocabulary = new Vocabulary(bindings);
  const routes = new RouteTable(bindings, inferred.taken);

  const walked = walkSteps(run, input, bindings, vocabulary, routes, inferred.byHandle);
  notes.push(...walked.notes);

  const outputs = deriveOutputs({ outputs: run.outputs, bindings, vocabulary });
  notes.push(...outputs.notes);

  const ordered = interleave(walked.acted, outputs.outputs, routes, bindings);
  if (ordered.steps.length === 0) {
    throw new SynthesisError("the run dispatched nothing that can be expressed as a step", {
      notes,
    });
  }

  const entry = entryRouteOf(run, routes);
  if (entry === null) {
    throw new SynthesisError(
      "the run's first observation carries no route, so the program has no entry point",
      { notes },
    );
  }

  // The effect analysis runs on the DRAFT steps, before the contract is sealed, because the
  // contract's own `effect` is rolled up from the artifact's steps and not the other way round.
  // `analyzeEffects` reads only the id, the declared class, the instruction kind and the extracted
  // field names, all of which are already final.
  const effects = analyzeEffects(
    { entry: { route: entry.id }, steps: ordered.steps },
    sensitivityByOutput(outputs.outputs),
  );

  const contract = seal(
    "contract",
    contractDraftOf(input, inferred.params, outputs.outputs, effects.summary.maxEffect, notes),
    notes,
  );

  const continuity = continuityOf(bindings, inferred.params, ordered.steps);
  const facts = programFactsOf(routes.patterns(), vocabulary, continuity, contract, effects);
  const steps = finishSteps({
    steps: ordered.steps,
    continuity,
    ambient: walked.ambient,
    facts,
    bindings,
    notes,
  });

  const flow = {
    entry: { route: entry.id, precondition: entryPreconditionOf(run, entry.id, facts, bindings) },
    routes: routes.patterns(),
    vocabulary: vocabulary.record(),
    resumePoints: resumePointsOf(steps),
    steps,
    ambient: walked.ambient,
  };
  notes.push(...routes.notes());

  const blocking = notes.filter((note) => note.severity === "blocking");
  if (blocking.length > 0) {
    throw new SynthesisError("the recording cannot be expressed as a faithful artifact", {
      notes,
      problems: blocking.map((note) => note.detail),
    });
  }

  const artifact = seal(
    "artifact",
    artifactDraftOf({
      input,
      contract,
      flow,
      continuity,
      effects: effects.summary,
      params: inferred.params,
      bindings,
      fingerprint: fingerprintOf(steps, ordered.observationOf, bindings),
    }),
    notes,
  );

  // The emitter checking its own output. See the header, property 1.
  const leaks = [...findBoundValues(artifact, bindings), ...findBoundValues(contract, bindings)];
  if (leaks.length > 0) {
    throw new SynthesisError(
      `a recorded value survived into the emitted documents at ${leaks.length} place(s); the artifact stores shapes, never values`,
      { notes, leaks },
    );
  }
  if (!artifactDigestIsIntact(artifact as unknown as Draft)) {
    throw new SynthesisError(
      "the sealed artifact's digest does not address its own content, which means validation changed the document after it was hashed",
      { notes },
    );
  }

  notes.push({
    code: "outcome-candidate-needs-detector",
    severity: run.outcomeCandidates.length === 0 ? "info" : "review",
    detail:
      run.outcomeCandidates.length === 0
        ? "the run proposed no business outcomes, so this capability answers only ok or failed until a person declares one"
        : `the model proposed ${run.outcomeCandidates.length} business outcome(s); no detector was written for any of them, because a detector for a screen the run never observed is exactly how a false MEMBER_NOT_FOUND is emitted`,
  });

  return {
    contract,
    artifact,
    report: {
      notes,
      outcomeCandidates: run.outcomeCandidates,
      parameters: inferred.params.map((param) => ({
        name: param.name,
        sensitivity: param.sensitivity,
        discoveredFrom: "goalSpan" in param.discoveredFrom ? "goal" : "operator",
        namedFrom: inferred.naming.find((one) => one.param === param.name)?.source ?? "positional",
      })),
      descriptors: walked.descriptorsByStep,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pass A - the recorded actions become instructions and targets
// ---------------------------------------------------------------------------------------------

/** A step before its checkpoint has been verified, with the observations it was derived from. */
interface DraftStep {
  readonly id: StepId;
  readonly title: string;
  readonly intent: string;
  readonly effect: EffectClass;
  readonly instruction: Instruction;
  readonly target: TargetRef | null;
  readonly precondition: Predicate | null;
  readonly extract: readonly ExtractSpec[];
  /** Candidate postconditions, each verified against `after` before it is kept. */
  readonly candidates: readonly Predicate[];
  readonly mustChange: boolean;
  readonly navigatedTo: RouteId | null;
  readonly before: Observation;
  readonly after: Observation;
  /** Excluded from continuity assertions: reading back what we just typed is not evidence that the
   *  application agrees about the subject. */
  readonly isFill: boolean;
}

interface WalkResult {
  readonly acted: readonly DraftStep[];
  readonly ambient: readonly RecoveryRule[];
  readonly notes: readonly SynthesisNote[];
  readonly descriptorsByStep: Readonly<Record<string, readonly string[]>>;
}

function walkSteps(
  run: DiscoveryRun,
  input: SynthesizeInput,
  bindings: readonly ValueBinding[],
  vocabulary: Vocabulary,
  routes: RouteTable,
  byHandle: ReadonlyMap<string, string>,
): WalkResult {
  const notes: SynthesisNote[] = [];
  const acted: DraftStep[] = [];
  const ambient: RecoveryRule[] = [];
  const ambientNames = new Set<string>();
  const descriptorsByStep: Record<string, readonly string[]> = {};
  const takenIds = new Set<string>();

  for (const step of run.steps) {
    if (!step.dispatched) {
      notes.push({
        code: "step-not-dispatched",
        severity: "info",
        detail: `a recorded ${step.tool} did not reach the surface (${step.faultKind ?? "refused"}) and is not part of the program`,
      });
      continue;
    }
    const after = step.after;
    if (after === null) {
      notes.push({
        code: "instruction-not-representable",
        severity: "info",
        detail: `a recorded ${step.tool} has no following observation, so no postcondition can be derived for it and it is not part of the program`,
      });
      continue;
    }

    // An optional interstitial is a RECOVERY, not a step. OPEN-QUESTIONS-RESOLVED Q3: the language
    // has no branch, and a dialog that may or may not appear, with a bounded remedy, is precisely
    // what a recovery is. Emitting it as a straight-line step would make replay REQUIRE the dialog.
    if (step.action.kind === "acceptDialog" || step.action.kind === "dismissDialog") {
      const rule = dialogRecoveryOf(step, ambient.length);
      if (rule !== null && !ambientNames.has(rule.name)) {
        ambientNames.add(rule.name);
        ambient.push(rule);
        notes.push({
          code: "dialog-lifted-to-recovery",
          severity: "info",
          detail: `a native dialog the run dismissed became the ambient recovery ${rule.name}, so replay handles it if it appears and does not require it`,
        });
      }
      continue;
    }

    const lowered = instructionOf(step, bindings, byHandle, vocabulary, routes, notes);
    if (lowered === null) continue;

    // The step id is minted BEFORE the locator is derived, so that every note the derivation
    // produces can name the step it belongs to. A rejection report that does not say which step it
    // is about is a report nobody reads twice.
    const node =
      step.nodeId === null
        ? null
        : (step.observation.nodes.find((one) => one.id === step.nodeId) ?? null);
    const id = StepIdSchema.parse(
      uniqueName(slugOf(`${lowered.kind} ${labelOf(node, lowered, bindings)}`, "step"), takenIds),
    );

    const derived = targetOf(step, id, input.capabilities, bindings, vocabulary, notes);
    if (derived === "blocked") continue;

    const target = derived?.target ?? null;
    descriptorsByStep[id] =
      target === null ? [] : target.descriptors.map((descriptor) => descriptor.id);

    const beforeRoute =
      step.observation.route === null ? null : routes.routeFor(step.observation.route);
    const afterRoute = after.route === null ? null : routes.routeFor(after.route);
    const navigated =
      afterRoute !== null && (beforeRoute === null || afterRoute.id !== beforeRoute.id);

    acted.push({
      id,
      title: titleOf(lowered, node, bindings),
      intent: parameterizeText(step.intent, bindings).slice(0, 1000),
      effect: step.effect,
      instruction: lowered,
      target,
      precondition: beforeRoute === null ? null : { kind: "route-matches", route: beforeRoute.id },
      extract: [],
      candidates: postconditionsOf(
        step,
        after,
        afterRoute?.id ?? null,
        target,
        bindings,
        vocabulary,
      ),
      // Derived from the recording, never asserted: the skeleton digest excludes a control's VALUE,
      // so a `fill` genuinely changes nothing structural, and an unconditional `mustChange: true`
      // would make every fill step classify as `no-observable-effect`.
      mustChange: step.observation.skeletonDigest !== after.skeletonDigest,
      navigatedTo: navigated ? (afterRoute?.id ?? null) : null,
      before: step.observation,
      after,
      isFill: lowered.kind === "fill",
    });
  }

  return { acted, ambient, notes, descriptorsByStep };
}

interface DerivedTarget {
  readonly node: UINode;
  readonly target: TargetRef;
  readonly derivation: DescriptorDerivation;
}

/** `null` for a step that acts on no node, `"blocked"` when a locator could not be derived. */
function targetOf(
  step: RecordedStep,
  stepId: StepId,
  capabilities: SurfaceCapabilities,
  bindings: readonly ValueBinding[],
  vocabulary: Vocabulary,
  notes: SynthesisNote[],
): DerivedTarget | null | "blocked" {
  if (step.nodeId === null) return null;
  const node = step.observation.nodes.find((one) => one.id === step.nodeId) ?? null;
  const derivation =
    node === null
      ? null
      : deriveDescriptors({
          observation: step.observation,
          nodeId: step.nodeId,
          capabilities,
          bindings,
          vocabulary,
        });
  if (node === null || derivation === null) {
    notes.push({
      code: "target-underdetermined",
      severity: "blocking",
      detail: `no locator could be derived for the node a recorded ${step.action.kind} acted on`,
      stepId,
    });
    return "blocked";
  }
  for (const rejection of derivation.rejected) {
    notes.push({
      code: "descriptor-rejected",
      severity: "info",
      detail: `${rejection.kind}: ${rejection.reason}`,
      stepId,
    });
  }
  if (!derivation.independent) {
    notes.push({
      code: "target-underdetermined",
      severity: "blocking",
      detail: `the node a recorded ${step.action.kind} acted on yields ${derivation.descriptors.length} descriptor(s) over ${derivation.evidenceSources.length} evidence source(s); SPEC section 5.2 requires two independent ones, and the recorder does not invent a sixth strategy`,
      stepId,
    });
    return "blocked";
  }
  return { node, target: targetRefOf(derivation, node, vocabulary), derivation };
}

/**
 * The verbs the port speaks, as the instructions the artifact speaks.
 *
 * `focus` has no artifact form on purpose: resolution names the node, so "put the caret there first"
 * is the driver's business and not a step of the program. A FUNCTION KEY has no artifact form for a
 * stronger reason - the terminal spike measured the same Exit control bound to F3 at one tenant and
 * F12 at the next, so a program that hardcodes one is correct at one tenant and wrong at the other.
 * The artifact says `activate` and the driver reads the legend line.
 */
function instructionOf(
  step: RecordedStep,
  bindings: readonly ValueBinding[],
  byHandle: ReadonlyMap<string, string>,
  vocabulary: Vocabulary,
  routes: RouteTable,
  notes: SynthesisNote[],
): Instruction | null {
  const action = step.action;
  const refuse = (detail: string): null => {
    notes.push({ code: "instruction-not-representable", severity: "blocking", detail });
    return null;
  };
  switch (action.kind) {
    case "navigate":
      return { kind: "navigate", route: routes.routeFor(action.route).id };
    case "click":
      return { kind: "activate" };
    case "type": {
      const value = valueRefOf(step, bindings, byHandle);
      return value === null
        ? refuse("a recorded fill carries no value the artifact can refer to")
        : { kind: "fill", value, mode: "replace" };
    }
    case "select": {
      const option = vocabulary.matcher(action.option);
      return option === null
        ? refuse("a recorded select names no option the artifact can match on")
        : { kind: "select", option };
    }
    case "setChecked":
      return { kind: "setToggle", checked: action.checked };
    case "pressKey": {
      const key = artifactKeyOf(action.key);
      if (key !== null) return { kind: "pressKey", key };
      if (action.target !== null) {
        notes.push({
          code: "instruction-not-representable",
          severity: "review",
          detail: `a recorded ${action.key} press became an \`activate\` on the same control, because the artifact vocabulary excludes the function keys: the same control is F3 at one tenant and F12 at the next, and the driver is where that difference belongs`,
        });
        return { kind: "activate" };
      }
      return refuse(
        `a recorded ${action.key} press has no target and no artifact-level spelling, so the program cannot be written down faithfully`,
      );
    }
    case "focus":
      notes.push({
        code: "instruction-not-representable",
        severity: "info",
        detail:
          "a recorded focus is not part of the program: resolution names the node, so making it actionable is the driver's obligation before it acts",
      });
      return null;
    default:
      return refuse(`a recorded ${action.kind} has no representation in the instruction set`);
  }
}

function artifactKeyOf(key: string): ArtifactKey | null {
  const parsed = ArtifactKeySchema.safeParse(key);
  return parsed.success ? parsed.data : null;
}

/**
 * Where a filled value comes from - and the reason `ValueRef` carries a provenance at all.
 *
 * SPEC section 4.2 rows 4 and 5: "Member ID must be 5 digits" is a legitimate business answer when
 * the value the app rejected was the CALLER's, and a hard failure when it was a literal baked into
 * the artifact, because then no caller can fix it. That distinction is only available if the
 * artifact records where the value came from, which is what this returns.
 */
function valueRefOf(
  step: RecordedStep,
  bindings: readonly ValueBinding[],
  byHandle: ReadonlyMap<string, string>,
): ValueRef | null {
  const recorded = step.value;
  if (recorded === null) return null;
  if (recorded.kind === "sensitive") {
    const param = byHandle.get(recorded.handle);
    return param === undefined ? null : { from: "param", param };
  }
  const bound = bindings.find((binding) => binding.value === recorded.value);
  if (bound !== undefined) return { from: "param", param: bound.param };
  // A residual literal survives only because it is safe to persist: the `literal` arm of `ValueRef`
  // is TYPED `sensitivity: "public"`, so a value that looks like regulated data is not expressible
  // here at all - `inferParameters` has already turned any such value into a parameter.
  return { from: "literal", value: recorded.value, sensitivity: "public" };
}

/**
 * Candidate postconditions for one acted step. Each is verified later against the observation the
 * step actually produced, and dropped if it did not hold.
 *
 * A `fill` bound to a SENSITIVE parameter gets no read-back assertion. The taint model blanks the
 * value of a field bound to a sensitive parameter before any bytes exist, so `value-matches` on
 * such a field would compare the caller's argument against a deliberately empty string and fail
 * every time. Naming the limit is better than shipping a checkpoint that cannot pass.
 */
function postconditionsOf(
  step: RecordedStep,
  after: Observation,
  afterRoute: RouteId | null,
  target: TargetRef | null,
  bindings: readonly ValueBinding[],
  vocabulary: Vocabulary,
): readonly Predicate[] {
  const candidates: Predicate[] = [];
  if (afterRoute !== null) candidates.push({ kind: "route-matches", route: afterRoute });

  const recorded = step.value;
  if (step.action.kind === "type" && target !== null) {
    const bound =
      recorded?.kind === "literal"
        ? bindings.find((binding) => binding.value === recorded.value)
        : undefined;
    if (recorded?.kind === "literal" && bound === undefined) {
      candidates.push({
        kind: "value-matches",
        where: queryOf(target),
        matcher: { mode: "exact", value: recorded.value, normalize: "std.text@1" },
      });
    } else if (bound !== undefined && bound.sensitivity !== "sensitive") {
      candidates.push({
        kind: "value-matches",
        where: queryOf(target),
        matcher: { mode: "template", value: bound.placeholder, normalize: "std.text@1" },
      });
    }
    candidates.push({ kind: "node-exists", where: queryOf(target) });
  }

  for (const arrival of newlyPresent(step.observation, after)) {
    const query = queryForNode(arrival, vocabulary);
    if (query !== null) candidates.push({ kind: "node-exists", where: query });
  }
  if (after.stability.settled) candidates.push({ kind: "settled" });
  return candidates;
}

/** The step's own target, as an existential query. A `NodeQuery` has no quorum and is a different
 *  type from a `TargetRef` on purpose - this is "is something like this on screen", not "act on
 *  exactly this" - and reusing the target's scope and role keeps the two scoped the same way. */
function queryOf(target: TargetRef): NodeQuery {
  const named = target.assert.name;
  return named === undefined
    ? { scope: target.scope, role: target.role }
    : { scope: target.scope, role: target.role, name: named };
}

function queryForNode(node: UINode, vocabulary: Vocabulary): NodeQuery | null {
  if (node.ariaRole === null) return null;
  const scope = containerMatcherOf(node.containerPath, vocabulary);
  const name = vocabulary.matcher(node.name);
  if (scope === null || name === null) return null;
  return { scope, role: node.ariaRole, name };
}

/** Nodes on the later screen that were not on the earlier one, by an identity a human would use.
 *  The highest-signal postcondition available from a recording: "the thing that appeared". */
function newlyPresent(before: Observation, after: Observation): readonly UINode[] {
  const seen = new Set(before.nodes.map(identityKey));
  const arrived = after.nodes.filter(
    (node) => node.ariaRole !== null && node.name.trim().length > 0 && !seen.has(identityKey(node)),
  );
  // Headings first: a screen announces itself with one, and a heading survives a rebrand better
  // than a button whose label a tenant edits.
  return [...arrived].sort((a, b) => rankRole(a) - rankRole(b)).slice(0, 2);
}

function identityKey(node: UINode): string {
  return JSON.stringify([node.ariaRole, node.name, node.containerPath]);
}

function rankRole(node: UINode): number {
  if (node.ariaRole === "heading") return 0;
  if (node.ariaRole === "table" || node.ariaRole === "region") return 1;
  return 2;
}

function labelOf(
  node: UINode | null,
  instruction: Instruction,
  bindings: readonly ValueBinding[],
): string {
  if (node !== null && node.name.trim().length > 0) {
    return parameterizeText(node.name, bindings);
  }
  return instruction.kind === "navigate" ? instruction.route : instruction.kind;
}

const VERB: Readonly<Record<Instruction["kind"], string>> = {
  navigate: "Go to",
  activate: "Activate",
  fill: "Fill in",
  select: "Choose in",
  setToggle: "Set",
  pressKey: "Press a key in",
  read: "Read",
  readTable: "Read the table in",
  assert: "Check",
  dialog: "Answer the dialog on",
};

function titleOf(
  instruction: Instruction,
  node: UINode | null,
  bindings: readonly ValueBinding[],
): string {
  return `${VERB[instruction.kind]} ${labelOf(node, instruction, bindings)}`.slice(0, 200);
}

/**
 * A native dialog the run answered, as an ambient recovery.
 *
 * `band: "interception"` because an open dialog stands between the program and the screen rather
 * than being an application error; `allowUnsettled: false` because only an environment recovery may
 * read a half-painted screen; `resume: "retry-step"` because the step it interrupted has not run.
 */
function dialogRecoveryOf(step: RecordedStep, ordinal: number): RecoveryRule | null {
  const dialog = step.observation.nativeDialog;
  if (dialog === null) return null;
  const accept = step.action.kind === "acceptDialog";
  const detect: Predicate =
    dialog.type === "beforeunload"
      ? { kind: "native-dialog" }
      : { kind: "native-dialog", dialogType: dialog.type };
  return {
    name: accept ? "ACCEPT_NATIVE_DIALOG" : "DISMISS_NATIVE_DIALOG",
    band: "interception",
    detect,
    priority: 10 + ordinal,
    phase: "both",
    remedy: { kind: "dismiss-native-dialog", accept },
    maxAttempts: 2,
    allowUnsettled: false,
    afterRemedy: "reverify",
    resume: "retry-step",
  };
}

// ---------------------------------------------------------------------------------------------
// Pass B - reads are placed on the screen they were read from
// ---------------------------------------------------------------------------------------------

interface Ordered {
  readonly steps: readonly DraftStep[];
  readonly observationOf: ReadonlyMap<string, Observation>;
}

/**
 * A `note_output` becomes a `read` step, placed after the action that produced the screen it was
 * noted on - not appended at the end.
 *
 * Placement is correctness, not tidiness. Extraction reads the SAME observation the checkpoint
 * verified (SPEC section 4.2 row 26); a read step floated to the end of the program would verify one
 * screen and read whichever one the program happened to be on, which is a race that is invisible in
 * a demo and produces a wrong balance in production.
 */
function interleave(
  acted: readonly DraftStep[],
  outputs: readonly DerivedOutput[],
  routes: RouteTable,
  bindings: readonly ValueBinding[],
): Ordered {
  const observationOf = new Map<string, Observation>();
  const positioned: { readonly at: number; readonly step: DraftStep }[] = acted.map(
    (step, index) => {
      observationOf.set(step.id, step.after);
      return { at: index, step };
    },
  );

  const bySeq = new Map<number, ExtractSpec[]>();
  for (const output of outputs) {
    const list = bySeq.get(output.observationSeq);
    if (list === undefined) bySeq.set(output.observationSeq, [output.extract]);
    else list.push(output.extract);
  }

  const taken = new Set(acted.map((step) => step.id as string));
  for (const [seq, specs] of [...bySeq.entries()].sort((a, b) => a[0] - b[0])) {
    let host = -1;
    acted.forEach((step, index) => {
      if (step.after.seq <= seq) host = index;
    });
    const screen = acted[host]?.after ?? acted[0]?.after;
    if (screen === undefined) continue;
    const id = StepIdSchema.parse(
      uniqueName(slugOf(`read ${specs.map((spec) => spec.output).join(" ")}`, "read"), taken),
    );
    const route = screen.route === null ? null : routes.routeFor(screen.route);
    observationOf.set(id, screen);
    positioned.push({
      at: host + 0.5,
      step: {
        id,
        title: `Read ${specs.map((spec) => spec.output).join(", ")}`.slice(0, 200),
        intent: parameterizeText(
          "Read the values the caller asked for off the screen the run reached.",
          bindings,
        ),
        effect: "READ",
        instruction: { kind: "read" },
        target: null,
        precondition: route === null ? null : { kind: "route-matches", route: route.id },
        extract: specs,
        candidates: [
          ...(route === null
            ? []
            : [{ kind: "route-matches", route: route.id } satisfies Predicate]),
          ...specs.map((spec): Predicate => ({ kind: "node-exists", where: spec.where })),
        ],
        // A `read` dispatches nothing, so there is no pre-act digest to compare against and
        // `mustChange` would fail closed on a step that is correct.
        mustChange: false,
        navigatedTo: null,
        before: screen,
        after: screen,
        isFill: false,
      },
    });
  }

  positioned.sort((a, b) => a.at - b.at);
  return { steps: positioned.map((entry) => entry.step), observationOf };
}

// ---------------------------------------------------------------------------------------------
// Pass C - checkpoints, verified against the observations they were derived from
// ---------------------------------------------------------------------------------------------

type ProgramFacts = EvalContext["program"];

interface FinishInput {
  readonly steps: readonly DraftStep[];
  readonly continuity: readonly ContinuityDef[];
  readonly ambient: readonly RecoveryRule[];
  readonly facts: ProgramFacts;
  readonly bindings: readonly ValueBinding[];
  readonly notes: SynthesisNote[];
}

function finishSteps(input: FinishInput): readonly Step[] {
  const budgets = stepBudgetsOf(input.ambient);
  return input.steps.map((draft) => {
    const ctx = contextOf(draft.after, input.facts, input.bindings);
    const held = draft.candidates.filter((predicate) => evaluatePredicate(predicate, ctx));
    if (held.length === 0) {
      input.notes.push({
        code: "instruction-not-representable",
        severity: "blocking",
        detail:
          "no postcondition could be derived that demonstrably held on the screen this step produced; a step with no checkpoint cannot be recorded",
        stepId: draft.id,
      });
    }

    const refs = draft.isFill
      ? []
      : input.continuity
          .filter((def) => evaluatePredicate({ kind: "continuity", ref: def.id }, ctx))
          .map((def) => def.id);

    for (const spec of draft.extract) {
      const read = readExtractSpec(spec, draft.instruction.kind, ctx);
      if (!read.ok) {
        input.notes.push({
          code: "instruction-not-representable",
          severity: "blocking",
          detail: `the extraction of "${spec.output}" could not be performed against the screen it was recorded on`,
          stepId: draft.id,
        });
      }
    }

    const expect: Checkpoint = {
      predicate: combine(held),
      delta:
        draft.navigatedTo === null
          ? { mustChange: draft.mustChange }
          : { mustChange: draft.mustChange, navigatedTo: draft.navigatedTo },
      continuity: refs,
    };

    const precondition =
      draft.precondition !== null &&
      evaluatePredicate(draft.precondition, contextOf(draft.before, input.facts, input.bindings))
        ? draft.precondition
        : null;

    const step: Step = {
      id: draft.id,
      title: draft.title,
      intent: draft.intent.length === 0 ? draft.title : draft.intent,
      effect: draft.effect,
      instruction: draft.instruction,
      target: draft.target,
      precondition,
      settle: { ...SETTLE_POLICY_DEFAULTS },
      expect,
      outcomes: [],
      recoveries: [],
      extract: draft.extract,
      budgets,
      evidence: { captureOn: ["failure"] },
    };
    return step;
  });
}

function combine(held: readonly Predicate[]): Predicate {
  if (held.length === 1) return held[0] as Predicate;
  if (held.length === 0) return { kind: "settled" };
  return { all: held.slice(0, 16) };
}

/**
 * Budgets a step may spend on remediation.
 *
 * Zero when the flow declares no ambient recoveries, and non-zero when it does. A step with
 * `maxRemediationCycles: 0` can never spend one, so an ambient rule declared beside steps that
 * cannot afford it is inert - and an inert rule reads in the document exactly like a working one.
 * Deriving the budget from the rules rather than hardcoding a zero is the fix on this side.
 */
function stepBudgetsOf(ambient: readonly RecoveryRule[]): Step["budgets"] {
  const perRecoveryMaxAttempts: Record<string, number> = {};
  for (const rule of ambient) perRecoveryMaxAttempts[rule.name] = rule.maxAttempts;
  return {
    perRecoveryMaxAttempts,
    maxRemediationCycles: ambient.length === 0 ? 0 : Math.min(20, ambient.length * 2),
  };
}

function contextOf(
  observation: Observation,
  program: ProgramFacts,
  bindings: readonly ValueBinding[],
): EvalContext {
  return { observation, program, bindings: resolvedBindingsOf(bindings) };
}

function resolvedBindingsOf(bindings: readonly ValueBinding[]): readonly ResolvedBinding[] {
  return bindings.map((binding) => ({
    name: binding.param,
    origin: "param" as const,
    value: binding.value,
    sensitivity: binding.sensitivity,
    handle: null,
  }));
}

function programFactsOf(
  routes: readonly RoutePattern[],
  vocabulary: Vocabulary,
  continuity: readonly ContinuityDef[],
  contract: CapabilityContract,
  effects: ReturnType<typeof analyzeEffects>,
): ProgramFacts {
  const outputs: Record<string, { readonly type: ValueType; readonly sensitivity: Sensitivity }> =
    {};
  for (const output of contract.outputs) {
    outputs[output.name] = { type: output.type, sensitivity: output.sensitivity };
  }
  return {
    routes,
    vocabulary: vocabulary.record(),
    continuity,
    outputs,
    // Empty at record time. Branding tokens are a TENANT's, supplied by the overlay, and baking the
    // recording tenant's into the base artifact is how one tenant's wording becomes everybody's.
    brandingTokens: [],
    maxEffect: effects.summary.maxEffect,
    restartSafeUpToPc: effects.summary.restartSafeUpToPc,
    resumePoints: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Continuity - control C2
// ---------------------------------------------------------------------------------------------

/**
 * A named value that must still be on screen at declared waypoints.
 *
 * This is what turns "a member detail page loaded" into "THE member detail page for the member we
 * were asked about", and it is the control that catches the application's own search silently
 * correcting the id. It is derived rather than declared: a parameter is a continuity candidate, and
 * `finishSteps` assigns the waypoints by asking `continuityHolds` which screens still showed it.
 *
 * A `fill` step is never a waypoint. Reading back the value we just typed into the box is not
 * evidence that the application agrees about the subject; it is evidence that typing works.
 */
function continuityOf(
  bindings: readonly ValueBinding[],
  params: readonly ParamSpec[],
  steps: readonly DraftStep[],
): readonly ContinuityDef[] {
  const defs: ContinuityDef[] = [];
  for (const binding of bindings) {
    if (binding.value.length === 0) continue;
    const spec = params.find((param) => param.name === binding.param);
    if (spec === undefined) continue;
    if (!steps.some((step) => !step.isFill && displays(step.after, binding.value))) continue;
    defs.push({
      id: binding.param,
      source: { from: "param", param: binding.param },
      // Normalized rather than identity: "50001" in the search box and "Member #50001" in the
      // detail heading are the same subject.
      compare: { via: "std.text@1", type: spec.type },
    });
  }
  return defs.slice(0, 16);
}

function displays(observation: Observation, value: string): boolean {
  const needle = value.toLowerCase();
  for (const node of observation.nodes) {
    for (const raw of [node.name, node.text, node.value]) {
      if (raw?.toLowerCase().includes(needle) === true) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------------------------

function entryRouteOf(run: DiscoveryRun, routes: RouteTable): { readonly id: RouteId } | null {
  const first = run.observations[0] ?? run.steps[0]?.observation ?? null;
  if (first === null || first.route === null) return null;
  return routes.routeFor(first.route);
}

function entryPreconditionOf(
  run: DiscoveryRun,
  entry: RouteId,
  facts: ProgramFacts,
  bindings: readonly ValueBinding[],
): Predicate {
  const first = run.observations[0] ?? run.steps[0]?.observation ?? null;
  const candidate: Predicate = { kind: "route-matches", route: entry };
  if (first === null) return candidate;
  return evaluatePredicate(candidate, contextOf(first, facts, bindings))
    ? candidate
    : { kind: "settled" };
}

/** Idempotent re-entry points: the steps that only navigate, and only before anything irreversible
 *  has happened. A restart across an irreversible step is how a retry opens two sub-accounts. */
function resumePointsOf(steps: readonly Step[]): readonly StepId[] {
  const points: StepId[] = [];
  for (const step of steps) {
    if (step.effect === "WRITE_IRREVERSIBLE") break;
    if (step.instruction.kind === "navigate") points.push(step.id);
  }
  return points.slice(0, 32);
}

function fingerprintOf(
  steps: readonly Step[],
  observationOf: ReadonlyMap<string, Observation>,
  bindings: readonly ValueBinding[],
): Readonly<Record<string, string>> {
  const perStep: Record<string, string> = {};
  for (const step of steps) {
    const observation = observationOf.get(step.id);
    if (observation === undefined) continue;
    perStep[step.id] = surfaceFingerprintOf(observation, bindings);
  }
  return perStep;
}

function sensitivityByOutput(
  outputs: readonly DerivedOutput[],
): Readonly<Record<string, Sensitivity>> {
  const out: Record<string, Sensitivity> = {};
  for (const output of outputs) out[output.spec.name] = output.spec.sensitivity;
  return out;
}

function contractDraftOf(
  input: SynthesizeInput,
  params: readonly ParamSpec[],
  outputs: readonly DerivedOutput[],
  effect: EffectClass,
  notes: SynthesisNote[],
): Draft {
  if (input.capability.whenToUse === undefined || input.capability.whenNotToUse === undefined) {
    notes.push({
      code: "prose-needs-author",
      severity: "review",
      detail:
        "whenToUse / whenNotToUse were not supplied and were filled with a placeholder; models mis-route far more often than they mis-fill arguments, so this is the highest-leverage prose in the contract and synthesis will not write it",
    });
  }
  const specs: readonly OutputSpec[] = outputs.map((output) => output.spec);
  return {
    schemaVersion: "capability.contract/v1",
    name: input.capability.name,
    version: input.capability.version ?? "1.0.0",
    title: input.capability.title,
    summary: input.capability.summary,
    whenToUse: input.capability.whenToUse ?? [PROSE_PLACEHOLDER],
    whenNotToUse: input.capability.whenNotToUse ?? [PROSE_PLACEHOLDER],
    inputs: params,
    outputs: specs,
    // EMPTY, deliberately. A business outcome needs a declared detector, and a detector for a
    // screen the run never observed would be inferred rather than declared. See `report.ts`.
    outcomes: [],
    effect,
    requiresApproval: effect === "WRITE_IRREVERSIBLE",
    idempotent: effect === "READ",
  };
}

interface ArtifactDraftInput {
  readonly input: SynthesizeInput;
  readonly contract: CapabilityContract;
  readonly flow: {
    readonly entry: { readonly route: RouteId; readonly precondition: Predicate };
    readonly routes: readonly RoutePattern[];
    readonly vocabulary: Readonly<Record<string, readonly string[]>>;
    readonly resumePoints: readonly StepId[];
    readonly steps: readonly Step[];
    readonly ambient: readonly RecoveryRule[];
  };
  readonly continuity: readonly ContinuityDef[];
  readonly effects: ReturnType<typeof analyzeEffects>["summary"];
  readonly params: readonly ParamSpec[];
  readonly bindings: readonly ValueBinding[];
  readonly fingerprint: Readonly<Record<string, string>>;
}

function artifactDraftOf(args: ArtifactDraftInput): Draft {
  const { input, contract, flow, effects } = args;
  const version = input.artifactVersion ?? 1;
  const surfaceKind = input.capabilities.kind;
  const irreversible = effects.maxEffect === "WRITE_IRREVERSIBLE";

  return {
    schemaVersion: "capability.artifact/v1",
    artifactId: `${input.capability.name}.${surfaceKind}.v${version}`,
    implements: {
      name: contract.name,
      version: contract.version,
      contractDigest: contract.digest,
    },
    version,
    target: {
      product: input.vendor.product,
      productVersionRange: input.vendor.productVersionRange,
      surfaceKind,
      requires: requiredFeaturesOf(flow, input.capabilities),
      sessionProfile: input.vendor.sessionProfile,
    },
    // Proposed, never draft. An artifact reaches `draft` only by replaying itself with the model
    // out of the loop, and that is build unit 15's job, not this one's (SPEC section 6.6).
    lifecycle: { status: "proposed", supersedes: null, approval: null },
    flow,
    continuity: args.continuity,
    provenance: {
      discoveryRunId: input.runId,
      // The goal, PARAMETERIZED. One of the easiest places in the whole system to persist a member
      // number by accident, and structurally incapable of holding one once this line has run.
      goalTemplate: parameterizeText(input.run.goal, args.bindings).slice(0, 2000),
      model: {
        adapter: input.run.adapter,
        modelId: input.run.modelId,
        promptVersion: input.promptVersion,
      },
      transcriptRef: input.transcriptRef ?? null,
      recordedAt: input.recordedAt,
      recordedAgainst: {
        tenantId: input.tenantId,
        appInstanceId: input.appInstanceId,
        fingerprint: { perStep: args.fingerprint },
      },
    },
    verification: {
      // The PLAN, not a result: `status: "unverified"` until unit 15 runs it. A write flow is
      // planned as `replay-dry`, because verifying it by running it again would open a second
      // sub-account - the mechanism that proves the artifact faithful would itself be the harm.
      mode: irreversible ? "replay-dry" : "replay-full",
      status: "unverified",
      coveredThroughStep: coveredThroughOf(flow.steps, irreversible),
      grade: irreversible ? "partial-up-to-irreversible" : "full",
      runId: input.runId,
      at: input.recordedAt,
    },
    policy: {
      originAliases: [...new Set(flow.routes.map((route) => route.originAlias))],
      maxEffect: effects.maxEffect,
      requiresApprovalToken: effects.requiresApproval,
      redaction: {
        taintedParams: args.params
          .filter((param) => param.sensitivity === "sensitive")
          .map((param) => param.name),
        maskScreenshotRegions: true,
      },
    },
    effects,
    budgets: runBudgetsOf(flow.steps, flow.ambient),
    signatures: [],
  };
}

function coveredThroughOf(steps: readonly Step[], irreversible: boolean): StepId {
  const last = steps[steps.length - 1] as Step;
  if (!irreversible) return last.id;
  const at = steps.findIndex((step) => step.effect === "WRITE_IRREVERSIBLE");
  if (at <= 0) return (steps[0] as Step).id;
  return (steps[at - 1] as Step).id;
}

/** Surface features this PROGRAM needs, derived from what it actually does - so the linker's
 *  load-time refusal names a real requirement rather than everything the recording driver happened
 *  to advertise. */
function requiredFeaturesOf(
  flow: ArtifactDraftInput["flow"],
  capabilities: SurfaceCapabilities,
): readonly SurfaceFeature[] {
  const features = new Set<SurfaceFeature>();
  features.add(capabilities.kind === "terminal" ? "character-grid" : "accessibility-tree");
  features.add("containers");
  if (flow.steps.some((step) => step.instruction.kind === "navigate")) features.add("route");
  for (const step of flow.steps) {
    for (const descriptor of step.target?.descriptors ?? []) {
      if (descriptor.kind === "table-cell") features.add("table-position");
      if (descriptor.kind === "geometric") features.add("geometry");
      if (descriptor.kind === "label-anchored" && descriptor.relation !== "labelled-by") {
        features.add("geometry");
      }
    }
  }
  if (flow.ambient.some((rule) => rule.remedy.kind === "dismiss-native-dialog")) {
    features.add("native-dialog-channel");
  }
  return [...features].slice(0, 8);
}

/**
 * Run budgets, with round numbers and headroom.
 *
 * Not derived from what the recording took: SPEC section 5.6 refuses recorded timings as replay
 * budgets, because "the page took 840 ms so the timeout is 840 ms" is the classic way to manufacture
 * flake. These are ceilings a well-behaved run never approaches, and the numbers a conformance
 * corpus would tune are the SETTLE policy's, not these.
 */
function runBudgetsOf(steps: readonly Step[], ambient: readonly RecoveryRule[]): Draft {
  const acting = steps.filter((step) => instructionActs(step.instruction.kind)).length;
  let remedyActions = 0;
  for (const rule of ambient) {
    if (rule.remedy.kind === "actions") {
      remedyActions += rule.remedy.instructions.length * rule.maxAttempts * steps.length;
    }
  }
  return {
    maxActions: Math.min(1000, acting + remedyActions + 10),
    maxObservations: Math.min(10_000, steps.length * 8 + 16),
    maxTotalRemediations: Math.min(100, ambient.length === 0 ? 0 : steps.length * 2),
    maxProgramAttempts: 1,
    deadlineMs: Math.min(3_600_000, Math.max(60_000, steps.length * 30_000)),
  };
}

// ---------------------------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------------------------

const PLACEHOLDER_DIGEST = `sha256:${"0".repeat(64)}`;

function seal(kind: "contract", draft: Draft, notes: readonly SynthesisNote[]): CapabilityContract;
function seal(kind: "artifact", draft: Draft, notes: readonly SynthesisNote[]): CapabilityArtifact;
function seal(
  kind: "contract" | "artifact",
  draft: Draft,
  notes: readonly SynthesisNote[],
): CapabilityContract | CapabilityArtifact {
  try {
    return kind === "contract" ? sealContract(draft) : sealArtifact(draft);
  } catch {
    // Re-parsed rather than caught-and-rethrown, because `explainIssues` turns a union failure into
    // the message that names the real problem - which in this schema is frequently the one saying a
    // detector was written with a member number in it.
    const parsed =
      kind === "contract"
        ? safeParseContract({ ...draft, digest: PLACEHOLDER_DIGEST })
        : safeParseArtifact({ ...draft, digest: PLACEHOLDER_DIGEST });
    const problems = parsed.success
      ? ["the document validated on a second attempt, so the digest computation is what failed"]
      : [...explainValidationError(parsed.error)];
    throw new SynthesisError(`the synthesized ${kind} is not a valid document`, {
      notes,
      problems,
    });
  }
}
