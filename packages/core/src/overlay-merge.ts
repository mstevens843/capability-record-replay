// Deterministic overlay merge (SPEC section 9.2).
//
// `resolve(base, overlay)` is total, pure, and its output is re-checked by the linker - every check,
// including the quorum one, so an overlay that disabled one descriptor too many is a `link-error` at
// load with a clear message rather than a `target-underdetermined` at step six in production.
//
// The invariant this file exists to keep is one sentence: AN OVERLAY MAY NOT CHANGE WHAT A
// CAPABILITY MEANS. `overlay.ts` enforces most of it by having no slot for the dangerous fields.
// What is left to enforce here is the part that needs both documents in hand - "the ids you patched
// exist" - plus the part that needs the merge's own OUTPUT: the linker compares the semantic spine
// of every merged step against the base (check 20), so a bug in this file is caught by the same
// check that catches a malicious overlay.
//
// One merge rule the spec leaves open, decided here and written down rather than left implicit:
// `StepOverride.tableHeaders` keys a table container by the TOKEN (or literal) of its first declared
// header, and replaces that container's whole header set with the tenant's literal headers. A
// per-tenant file is the one document where a literal label is the right thing to write, and the
// first header is how a person names a grid when they talk about it.

import {
  type JsonObject,
  asArray,
  asObject,
  asObjects,
  asString,
  cloneJson,
} from "./document-walk.js";

export interface OverlayProblem {
  readonly code: string;
  readonly message: string;
  readonly where: string | null;
}

export interface DescriptorNote {
  readonly stepId: string;
  readonly descriptorId: string;
}

export interface MergedProgram {
  /** The merged artifact, still plain JSON: it is about to be checked, not trusted. */
  readonly document: JsonObject;
  /** Symbolic alias to real origin. Empty when no overlay bound one - the base artifact is
   *  deliberately runnable on its own, against the tenant it was recorded on. */
  readonly originBindings: Readonly<Record<string, string>>;
  /** Branding words the label normalizer strips for this tenant. */
  readonly stripTokens: readonly string[];
  readonly disabledDescriptors: readonly DescriptorNote[];
  readonly addedDescriptors: readonly DescriptorNote[];
  readonly problems: readonly OverlayProblem[];
}

/** The only fields a step override may carry. Listed here as well as in the schema because the
 *  linker's check 20 needs a value it can compare a hand-written overlay against, and a strict
 *  object's refusal is not one. */
export const STEP_OVERRIDE_FIELDS: readonly string[] = [
  "addDescriptors",
  "disableDescriptors",
  "settle",
  "budgets",
  "tableHeaders",
];

export function mergeOverlay(artifact: unknown, overlay: unknown): MergedProgram {
  const base = asObject(artifact) ?? {};
  const document = cloneJson(base);
  const problems: OverlayProblem[] = [];
  const disabledDescriptors: DescriptorNote[] = [];
  const addedDescriptors: DescriptorNote[] = [];

  const patch = asObject(overlay);
  if (patch === null) {
    return {
      document,
      originBindings: {},
      stripTokens: [],
      disabledDescriptors,
      addedDescriptors,
      problems,
    };
  }

  const problem = (code: string, message: string, where: string | null = null): void => {
    problems.push({ code, message, where });
  };

  const flow = asObject(document.flow) ?? {};
  const steps = asObjects(flow.steps);
  const stepById = new Map<string, JsonObject>();
  for (const step of steps) {
    const id = asString(step.id);
    if (id !== null) stepById.set(id, step);
  }

  // ---- applicability -------------------------------------------------------------------------
  const appliesTo = asObject(patch.appliesTo);
  const targetId = asString(appliesTo?.artifactId);
  const artifactId = asString(document.artifactId);
  if (targetId !== null && artifactId !== null && targetId !== artifactId) {
    problem(
      "overlay-unknown-id",
      `the overlay applies to artifact ${targetId}, and this artifact is ${artifactId}`,
      "appliesTo.artifactId",
    );
  }
  const range = asObject(appliesTo?.version);
  const version = document.version;
  if (range !== null && typeof version === "number") {
    const min = range.min;
    const max = range.max;
    if (typeof min === "number" && version < min) {
      problem(
        "overlay-unknown-id",
        `the overlay applies from artifact version ${min} and this artifact is version ${version}`,
        "appliesTo.version.min",
      );
    }
    if (typeof max === "number" && version > max) {
      problem(
        "overlay-unknown-id",
        `the overlay applies up to artifact version ${max} and this artifact is version ${version}`,
        "appliesTo.version.max",
      );
    }
  }

  // ---- origin aliases: the overlay replaces per alias -----------------------------------------
  const policy = asObject(document.policy) ?? {};
  const declaredAliases = new Set(
    asArray(policy.originAliases).filter((a) => typeof a === "string"),
  );
  const originBindings: Record<string, string> = {};
  for (const [alias, origin] of Object.entries(asObject(patch.originAliases) ?? {})) {
    if (typeof origin !== "string") continue;
    if (!declaredAliases.has(alias)) {
      problem(
        "overlay-unknown-id",
        `the overlay binds origin alias ${alias}, which this artifact does not declare`,
        `originAliases.${alias}`,
      );
      continue;
    }
    originBindings[alias] = origin;
  }

  // ---- route base paths: a prefix, never the template -----------------------------------------
  const routes = asObjects(flow.routes);
  const routeById = new Map<string, JsonObject>();
  for (const route of routes) {
    const id = asString(route.id);
    if (id !== null) routeById.set(id, route);
  }
  for (const [routeId, prefix] of Object.entries(asObject(patch.routeBasePath) ?? {})) {
    if (typeof prefix !== "string") continue;
    const route = routeById.get(routeId);
    if (route === undefined) {
      problem(
        "overlay-unknown-id",
        `the overlay sets a base path for route ${routeId}, which this artifact does not declare`,
        `routeBasePath.${routeId}`,
      );
      continue;
    }
    const path = asString(route.path);
    if (path === null) continue;
    const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    route.path = `${trimmed}${path}`;
  }

  // ---- vocabulary: replaces a token's list wholesale -------------------------------------------
  const vocabulary = asObject(flow.vocabulary) ?? {};
  for (const [tokenName, synonyms] of Object.entries(asObject(patch.vocabulary) ?? {})) {
    if (!Object.hasOwn(vocabulary, tokenName)) {
      // A token absent from the base has nothing to replace, so the overlay's synonyms would
      // silently never be consulted - the exact quiet failure the token mechanism exists to avoid.
      problem(
        "overlay-unknown-id",
        `the overlay replaces the synonyms of label token ${tokenName}, which the base flow does not declare`,
        `vocabulary.${tokenName}`,
      );
      continue;
    }
    vocabulary[tokenName] = cloneJson(synonyms);
  }
  flow.vocabulary = vocabulary;

  // ---- per-step overrides ----------------------------------------------------------------------
  for (const [stepId, rawOverride] of Object.entries(asObject(patch.steps) ?? {})) {
    const override = asObject(rawOverride);
    const step = stepById.get(stepId);
    if (override === null) continue;
    if (step === undefined) {
      problem(
        "overlay-unknown-id",
        `the overlay overrides step ${stepId}, which this artifact does not declare`,
        `steps.${stepId}`,
      );
      continue;
    }
    for (const field of Object.keys(override)) {
      if (STEP_OVERRIDE_FIELDS.includes(field)) continue;
      problem(
        "overlay-changes-meaning",
        `the overlay sets ${field} on step ${stepId}; an overlay may change how a control is found, never what the step does`,
        `steps.${stepId}.${field}`,
      );
    }

    const target = asObject(step.target);
    const added = asObjects(override.addDescriptors);
    const disabled = asArray(override.disableDescriptors).filter((d) => typeof d === "string");

    if ((added.length > 0 || disabled.length > 0) && target === null) {
      problem(
        "overlay-unknown-id",
        `the overlay changes the descriptors of step ${stepId}, which acts on no node`,
        `steps.${stepId}`,
      );
    } else if (target !== null) {
      const descriptors = asObjects(target.descriptors).map((d) => cloneJson(d));
      const present = new Set(descriptors.map((d) => asString(d.id)).filter((id) => id !== null));
      for (const id of disabled) {
        if (!present.has(id)) {
          problem(
            "overlay-unknown-id",
            `the overlay disables descriptor ${id} at step ${stepId}, which the base target does not declare`,
            `steps.${stepId}.disableDescriptors`,
          );
          continue;
        }
        disabledDescriptors.push({ stepId, descriptorId: id });
      }
      const surviving = descriptors.filter((d) => {
        const id = asString(d.id);
        return id === null || !disabled.includes(id);
      });
      for (const descriptor of added) {
        const id = asString(descriptor.id);
        if (id !== null && present.has(id)) {
          problem(
            "overlay-changes-meaning",
            `the overlay adds descriptor ${id} at step ${stepId}, but the base target already declares that id; an overlay adds evidence, it never edits it`,
            `steps.${stepId}.addDescriptors`,
          );
          continue;
        }
        surviving.push(cloneJson(descriptor));
        if (id !== null) addedDescriptors.push({ stepId, descriptorId: id });
      }
      target.descriptors = surviving;
    }

    // Field-wise: a value the overlay omits keeps the base's.
    const settleOverride = asObject(override.settle);
    if (settleOverride !== null) {
      step.settle = { ...(asObject(step.settle) ?? {}), ...cloneJson(settleOverride) };
    }
    const budgetOverride = asObject(override.budgets);
    if (budgetOverride !== null) {
      step.budgets = { ...(asObject(step.budgets) ?? {}), ...cloneJson(budgetOverride) };
    }

    const headerOverride = asObject(override.tableHeaders);
    if (headerOverride !== null) applyTableHeaders(step, headerOverride, stepId, problem);
  }

  // ---- added recoveries ------------------------------------------------------------------------
  for (const [stepId, rawRecoveries] of Object.entries(asObject(patch.addRecoveries) ?? {})) {
    const step = stepById.get(stepId);
    if (step === undefined) {
      problem(
        "overlay-unknown-id",
        `the overlay adds a recovery to step ${stepId}, which this artifact does not declare`,
        `addRecoveries.${stepId}`,
      );
      continue;
    }
    step.recoveries = [...asArray(step.recoveries), ...cloneJson(asArray(rawRecoveries))];
  }

  const stripTokens = [
    ...new Set(asArray(patch.stripTokens).filter((t): t is string => typeof t === "string")),
  ];

  return { document, originBindings, stripTokens, disabledDescriptors, addedDescriptors, problems };
}

/**
 * Replace a table container's header set, everywhere inside one step.
 *
 * "Everywhere inside one step" is the point: the same grid is named by a descriptor, a row key, a
 * checkpoint predicate and an extraction, and a correction that reached only one of them would
 * leave the step half-retargeted - which is worse than not correcting it, because it would resolve.
 */
function applyTableHeaders(
  step: JsonObject,
  headerOverride: JsonObject,
  stepId: string,
  problem: (code: string, message: string, where?: string | null) => void,
): void {
  const applied = new Set<string>();
  visitTables(step, (table) => {
    const key = tableKeyOf(table);
    if (key === null) return;
    const replacement = headerOverride[key];
    if (replacement === undefined) return;
    const normalize = firstNormalizerOf(table) ?? "std.label@1";
    table.headers = asArray(replacement)
      .filter((h): h is string => typeof h === "string")
      .map((value) => ({ mode: "exact", value, normalize }));
    applied.add(key);
  });
  for (const key of Object.keys(headerOverride)) {
    if (applied.has(key)) continue;
    problem(
      "overlay-unknown-id",
      `the overlay corrects the headers of table ${key} at step ${stepId}, and no container there is named by that header`,
      `steps.${stepId}.tableHeaders.${key}`,
    );
  }
}

function visitTables(value: unknown, visit: (table: JsonObject) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visitTables(item, visit);
    return;
  }
  const record = asObject(value);
  if (record === null) return;
  // A container segment matcher, not a `table` value type: the latter carries `columns`, not
  // `headers`.
  if (record.kind === "table" && Array.isArray(record.headers)) visit(record);
  for (const child of Object.values(record)) visitTables(child, visit);
}

/** How a person names a grid: by its first column. A token when the base used one, the literal
 *  otherwise. */
function tableKeyOf(table: JsonObject): string | null {
  const first = asObject(asArray(table.headers)[0]);
  if (first === null) return null;
  return asString(first.token) ?? asString(first.value);
}

function firstNormalizerOf(table: JsonObject): string | null {
  const first = asObject(asArray(table.headers)[0]);
  return first === null ? null : asString(first.normalize);
}
