// Pure evaluation of the declared language against one frozen `Observation` (SPEC section 4.1).
//
// Everything the classifier needs to *look at a screen* lives here: text matching, container
// scoping, node queries, the predicate language, continuity, and `ExtractSpec` reads. `classify.ts`
// owns the band order and the taxonomy; this file owns "is that true of this screen".
//
// Three properties are load-bearing and are the reason this is a separate module from the bands:
//
//   1. TOTAL. Nothing here throws. A malformed reference - a token with no vocabulary entry, a
//      continuity id with no definition, an unbound template hole - evaluates to FALSE rather than
//      to an exception, because a detector that cannot be evaluated has not been satisfied. Every
//      such refusal fails CLOSED, away from a business outcome.
//   2. NO CLOCK, NO I/O, NO SURFACE. The only inputs are the observation, the program's declared
//      vocabulary, and the caller's bindings. That is what makes SPEC section 4.8 true: a
//      production failure becomes a unit test by saving one JSON file.
//   3. NO VALUE EVER LEAVES. A bound value may be COMPARED against the screen; it is never copied
//      into a rendered string. `renderMatcher` renders a `ValueRef` by name and a template hole
//      unresolved, which is SPEC section 4.7's rule and the reason a hard failure report can be
//      journaled without a redaction pass.

import type { InstructionKind } from "./artifact.js";
import type { ContinuityDef, ExtractSpec } from "./artifact.js";
import type {
  ExpectationTrace,
  ExtractedOutput,
  ExtractedValue,
  ObservedSummary,
} from "./diagnostics.js";
import { extract as extractField } from "./extractors.js";
import type {
  ContainerMatcher,
  ContainerSegmentMatcher,
  NodeQuery,
  Predicate,
  RowKey,
} from "./matchers.js";
import { normalize } from "./normalizers.js";
import type { ContainerSegment, Observation, RouteLocation, UINode } from "./observation.js";
import { parse } from "./parsers.js";
import type { TaintHandle } from "./policy.js";
import type {
  EffectClass,
  NormalizerId,
  Role,
  RoutePattern,
  Sensitivity,
  StepId,
  TextMatcher,
  ValueRef,
  ValueType,
} from "./primitives.js";

// ---------------------------------------------------------------------------------------------
// Bindings — the input that lets the classifier tell SPEC section 4.2 row 4 from row 5
// ---------------------------------------------------------------------------------------------

/**
 * Where a bound value came from.
 *
 * This is the whole mechanism behind rows 4-vs-5. "Member ID must be 5 digits" is a legitimate
 * business answer when the value the app rejected was the CALLER's, and a hard failure when it was
 * a literal baked into the artifact - because then no caller can fix it, and telling an agent
 * "retry with different input" sends it into a loop it can never exit.
 */
export type BindingOrigin = "param" | "literal" | "output" | "credential";

/**
 * One resolved value, with its provenance.
 *
 * `value` exists FOR COMPARISON ONLY. Nothing in this package may copy it into a rendered string,
 * a trace, or a verdict; `handle` is what a trace carries when the value is tainted, and
 * `test/classifier.test.ts` asserts by grep that no verdict ever contains a bound value.
 */
export interface ResolvedBinding {
  readonly name: string;
  readonly origin: BindingOrigin;
  readonly value: string;
  readonly sensitivity: Sensitivity;
  /** Non-null exactly when the value is tainted. The opaque stand-in a log may hold. */
  readonly handle: TaintHandle | null;
}

/** Every value the run has bound so far: the caller's arguments, and any earlier step's outputs. */
export type ResolvedBindings = readonly ResolvedBinding[];

/** The key an `output` binding is stored under, so one flat list can hold both kinds. */
export function outputBindingName(step: StepId, output: string): string {
  return `${step}.${output}`;
}

/** The binding a `ValueRef` names, or `null` when nothing has been bound to it. */
export function bindingFor(ref: ValueRef, bindings: ResolvedBindings): ResolvedBinding | null {
  switch (ref.from) {
    case "param":
      return bindings.find((b) => b.origin === "param" && b.name === ref.param) ?? null;
    case "output":
      return (
        bindings.find(
          (b) => b.origin === "output" && b.name === outputBindingName(ref.step, ref.output),
        ) ?? null
      );
    case "credential":
      return bindings.find((b) => b.origin === "credential" && b.name === ref.key) ?? null;
    case "literal":
      // A literal needs no lookup: the artifact carries it, and its sensitivity is `public` by
      // construction (a non-public literal is not expressible in `ValueRef`).
      return {
        name: ref.value,
        origin: "literal",
        value: ref.value,
        sensitivity: "public",
        handle: null,
      };
  }
}

/**
 * True when the value the app would have rejected is the CALLER's to fix.
 *
 * Fail-closed on purpose: only `param` counts. An `output` came off the application's own screen,
 * a `credential` came from the session broker, and a `literal` came from the artifact - a caller
 * who changes their argument fixes none of those, so promoting such a rejection to
 * `retry-different-input` would be a lie the agent cannot detect.
 */
export function isCallerSupplied(binding: ResolvedBinding | null): boolean {
  return binding !== null && binding.origin === "param";
}

// ---------------------------------------------------------------------------------------------
// Program facts — what the linker resolved, handed to the classifier as plain data
// ---------------------------------------------------------------------------------------------

/**
 * The whole-program facts a per-step classification needs, resolved by the linker before the run.
 *
 * They are handed IN rather than read from the artifact for the same reason `elapsedMs` is a
 * number: the classifier's input has to be a value you can write to disk and load back, and an
 * artifact plus an overlay plus a contract is three documents and a merge. The linker does the
 * merge once; the classifier sees the result.
 */
export interface ProgramFacts {
  /** Post-overlay route patterns, so `route-matches` compares canonicalized paths. */
  readonly routes: readonly RoutePattern[];
  /** Post-overlay label synonyms. A `token` matcher resolves through this and nothing else. */
  readonly vocabulary: Readonly<Record<string, readonly string[]>>;
  readonly continuity: readonly ContinuityDef[];
  /** The declared type and sensitivity of every output and outcome-payload field, from the
   *  CONTRACT - so `enum@1` refuses a value the caller's generated types could not hold. */
  readonly outputs: Readonly<
    Record<string, { readonly type: ValueType; readonly sensitivity: Sensitivity }>
  >;
  /** The tenant's branding tokens, for `std.label@1`. From the overlay, never from the registry. */
  readonly brandingTokens: readonly string[];
  /** `EffectSummary.maxEffect` - gates the one restart row 16 allows. */
  readonly maxEffect: EffectClass;
  /** `EffectSummary.restartSafeUpToPc` - gate 2 of SPEC section 3.6. */
  readonly restartSafeUpToPc: number;
  readonly resumePoints: readonly StepId[];
}

export interface EvalContext {
  readonly observation: Observation;
  readonly program: ProgramFacts;
  readonly bindings: ResolvedBindings;
}

const normalizerContext = (ctx: EvalContext) => ({ brandingTokens: ctx.program.brandingTokens });

const norm = (id: NormalizerId, text: string, ctx: EvalContext): string =>
  normalize(id, text, normalizerContext(ctx));

// ---------------------------------------------------------------------------------------------
// Text matching
// ---------------------------------------------------------------------------------------------

/**
 * How a matcher is compared against its subject, decided by the POSITION the matcher is used in
 * rather than by the matcher itself.
 *
 * `identity` — "is this the control called X". A node's accessible name, a container's name, a
 * column header, a form control's value. Equality after normalization.
 * `containment` — "is this text present". A node's text content, the text of a banner. Substring
 * after normalization.
 *
 * The distinction is not cosmetic. A `token` matcher that meant "equals" everywhere could never
 * detect a banner reading "No member found for that number", and a `token` matcher that meant
 * "contains" everywhere would let a control named "Search Results" satisfy a target that asked for
 * the button named "Search".
 */
export type MatchMode = "identity" | "containment";

/** Every spelling a `token` matcher accepts, or `[]` when the vocabulary does not declare it. */
export function synonymsOf(token: string, ctx: EvalContext): readonly string[] {
  return ctx.program.vocabulary[token] ?? [];
}

/**
 * Fill a template's holes with the values their parameters are bound to.
 *
 * Returns `null` when a hole names something unbound - which makes the matcher FALSE rather than
 * making it match a screen that happens to contain the literal text `{memberId}`.
 */
function fillTemplate(template: string, ctx: EvalContext): string | null {
  let unresolved = false;
  const filled = template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_whole, name: string) => {
    const binding = bindingFor({ from: "param", param: name }, ctx.bindings);
    if (binding === null) {
      unresolved = true;
      return "";
    }
    return binding.value;
  });
  return unresolved ? null : filled;
}

/** Total. An unresolvable matcher is `false`, never an exception and never a match. */
export function matchText(
  matcher: TextMatcher,
  subject: string,
  how: MatchMode,
  ctx: EvalContext,
): boolean {
  const actual = norm(matcher.normalize, subject, ctx);
  switch (matcher.mode) {
    case "exact":
      return actual === norm(matcher.normalize, matcher.value, ctx);
    case "contains": {
      const needle = norm(matcher.normalize, matcher.value, ctx);
      return needle.length > 0 && actual.includes(needle);
    }
    case "template": {
      const filled = fillTemplate(matcher.value, ctx);
      if (filled === null) return false;
      const needle = norm(matcher.normalize, filled, ctx);
      return needle.length > 0 && actual.includes(needle);
    }
    case "token": {
      const synonyms = synonymsOf(matcher.token, ctx);
      for (const synonym of synonyms) {
        const candidate = norm(matcher.normalize, synonym, ctx);
        if (candidate.length === 0) continue;
        if (how === "identity" ? actual === candidate : actual.includes(candidate)) return true;
      }
      return false;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------

function segmentMatches(
  matcher: ContainerSegmentMatcher,
  segment: ContainerSegment,
  ctx: EvalContext,
): boolean {
  if (matcher.kind !== segment.kind) return false;
  switch (matcher.kind) {
    case "frame":
      return matchText(matcher.name, segment.kind === "frame" ? segment.name : "", "identity", ctx);
    case "landmark": {
      if (segment.kind !== "landmark") return false;
      if (matcher.role !== segment.role) return false;
      if (matcher.name === undefined) return true;
      return matchText(matcher.name, segment.name ?? "", "identity", ctx);
    }
    case "heading-section": {
      if (segment.kind !== "heading-section") return false;
      if (matcher.level !== undefined && matcher.level !== segment.level) return false;
      return matchText(matcher.heading, segment.heading, "identity", ctx);
    }
    case "table": {
      if (segment.kind !== "table") return false;
      // Every declared header must appear, IN ORDER, among the observed ones. Extra observed
      // columns are allowed - a tenant that added an "Actions" column has not changed which table
      // this is - but a reordering has, because a row read by column position would then be wrong.
      let cursor = 0;
      for (const wanted of matcher.headers) {
        let found = -1;
        for (let i = cursor; i < segment.headers.length; i++) {
          if (matchText(wanted, segment.headers[i] as string, "identity", ctx)) {
            found = i;
            break;
          }
        }
        if (found === -1) return false;
        cursor = found + 1;
      }
      return true;
    }
    case "screen": {
      if (segment.kind !== "screen") return false;
      return matchText(matcher.id, segment.id, "identity", ctx);
    }
  }
}

/**
 * A breadcrumb match: every segment of the matcher must appear in the node's container path, in
 * order. Extra levels between them are allowed.
 *
 * Subsequence rather than prefix, deliberately. A tenant that wraps its content frame in one more
 * landmark has not moved the results table out of the content frame, and a prefix rule would say
 * it had - which is the "fragile locator" failure this design exists to refuse.
 */
export function containerMatches(
  matcher: ContainerMatcher,
  path: readonly ContainerSegment[],
  ctx: EvalContext,
): boolean {
  let cursor = 0;
  for (const wanted of matcher.path) {
    let found = -1;
    for (let i = cursor; i < path.length; i++) {
      if (segmentMatches(wanted, path[i] as ContainerSegment, ctx)) {
        found = i;
        break;
      }
    }
    if (found === -1) return false;
    cursor = found + 1;
  }
  return true;
}

/** The nodes inside a container, or every node when the scope is omitted. */
export function nodesInScope(
  scope: ContainerMatcher | undefined,
  ctx: EvalContext,
): readonly UINode[] {
  if (scope === undefined) return ctx.observation.nodes;
  return ctx.observation.nodes.filter((n) => containerMatches(scope, n.containerPath, ctx));
}

// ---------------------------------------------------------------------------------------------
// Table cells
// ---------------------------------------------------------------------------------------------

/** A cell's content for comparison purposes: what a person reads in that box. */
const cellText = (n: UINode): string => n.value ?? n.text ?? n.name;

/**
 * The one cell a `RowKey` plus a column header names, or `null`.
 *
 * Row addressing by VALUE, never by index (SPEC section 2.4). Without it, reading a cell on a
 * legacy accounts grid degrades to "some cell in this table", which is how a checking balance gets
 * reported as a savings balance to a member on the phone.
 */
export function resolveCell(
  cell: {
    readonly table: ContainerMatcher;
    readonly rowKey: RowKey;
    readonly columnHeader: TextMatcher;
  },
  ctx: EvalContext,
): UINode | null {
  const cells = nodesInScope(cell.table, ctx).filter(
    (n) => n.ariaRole === "cell" && n.tablePosition !== null,
  );
  const keyBinding = bindingFor(cell.rowKey.value, ctx.bindings);
  if (keyBinding === null) return null;

  const keyCells = cells.filter(
    (n) =>
      matchText(cell.rowKey.columnHeader, n.tablePosition?.colHeader ?? "", "identity", ctx) &&
      // The row key's value has no normalizer of its own, so the comparison uses `std.text@1`:
      // the same fold a human applies when they read "50001" off a screen.
      norm("std.text@1", cellText(n), ctx) === norm("std.text@1", keyBinding.value, ctx),
  );
  // Two rows carrying the same key is an ambiguity, not a preference. Refuse rather than pick.
  if (keyCells.length !== 1) return null;
  const rowIndex = (keyCells[0] as UINode).tablePosition?.rowIndex;
  if (rowIndex === undefined) return null;

  const matches = cells.filter(
    (n) =>
      n.tablePosition?.rowIndex === rowIndex &&
      matchText(cell.columnHeader, n.tablePosition?.colHeader ?? "", "identity", ctx),
  );
  return matches.length === 1 ? (matches[0] as UINode) : null;
}

// ---------------------------------------------------------------------------------------------
// Node queries
// ---------------------------------------------------------------------------------------------

/**
 * Every node a query selects. Existential and quorum-free by design: this is how a DETECTOR asks
 * "is something like this on screen", and it is a different type from `TargetRef`, which is how a
 * step says "act on exactly this".
 */
export function queryNodes(query: NodeQuery, ctx: EvalContext): readonly UINode[] {
  if (query.cell !== undefined) {
    const cell = resolveCell(query.cell, ctx);
    if (cell === null) return [];
    return matchesNodeConstraints(cell, query, ctx) ? [cell] : [];
  }
  return nodesInScope(query.scope, ctx).filter((n) => matchesNodeConstraints(n, query, ctx));
}

function matchesNodeConstraints(n: UINode, query: NodeQuery, ctx: EvalContext): boolean {
  if (query.role !== undefined && n.ariaRole !== (query.role as Role)) return false;
  if (query.name !== undefined && !matchText(query.name, n.name, "identity", ctx)) return false;
  if (query.text !== undefined && !matchText(query.text, n.text ?? "", "containment", ctx)) {
    return false;
  }
  if (query.state !== undefined) {
    for (const [key, wanted] of Object.entries(query.state)) {
      if (wanted === undefined) continue;
      if (n.state[key as keyof UINode["state"]] !== wanted) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/** Does the observation's canonicalized location match the named route pattern? */
export function routeMatches(routeId: string, ctx: EvalContext): boolean {
  const pattern = ctx.program.routes.find((r) => r.id === routeId);
  const location: RouteLocation | null = ctx.observation.route;
  if (pattern === undefined || location === null) return false;
  if (pattern.originAlias !== location.originAlias) return false;
  if (pattern.path !== location.path) return false;
  if (pattern.frame !== undefined && pattern.frame !== location.frame) return false;
  for (const [key, expected] of Object.entries(pattern.query ?? {})) {
    const actual = location.query[key];
    if (actual === undefined) return false;
    if (expected === ":any") continue;
    const binding = bindingFor(expected as ValueRef, ctx.bindings);
    if (binding === null || binding.value !== actual) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Continuity
// ---------------------------------------------------------------------------------------------

/**
 * Is the named subject still the one on screen?
 *
 * This is control C2 of SPEC section 4.5, and it is what turns "a member detail page loaded" into
 * "THE member detail page for the member we were asked about". Comparison is normalized rather
 * than identity - "50001" in the search box and "Member Detail #50001" in the heading are the same
 * subject - which is exactly why the digit-boundary guard below exists: a naive substring test
 * would also call "150001" a match.
 */
export function continuityHolds(
  ref: string,
  scope: ContainerMatcher | undefined,
  ctx: EvalContext,
): boolean {
  const def = ctx.program.continuity.find((c) => c.id === ref);
  if (def === undefined) return false;
  const binding = bindingFor(def.source, ctx.bindings);
  if (binding === null) return false;
  const needle = norm(def.compare.via, binding.value, ctx);
  if (needle.length === 0) return false;
  const digits = def.compare.type.kind === "string" && def.compare.type.charset === "digits";

  for (const node of nodesInScope(scope, ctx)) {
    for (const raw of [node.name, node.text, node.value]) {
      if (raw === null) continue;
      const haystack = norm(def.compare.via, raw, ctx);
      if (containsAt(haystack, needle, digits)) return true;
    }
  }
  return false;
}

/** Substring, plus a digit-boundary guard so `50001` does not match inside `150001`. */
function containsAt(haystack: string, needle: string, digitBoundary: boolean): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    if (!digitBoundary) return true;
    const before = at === 0 ? "" : haystack[at - 1];
    const after = haystack[at + needle.length] ?? "";
    if (!/\d/.test(before ?? "") && !/\d/.test(after)) return true;
    from = at + 1;
  }
}

// ---------------------------------------------------------------------------------------------
// The predicate language
// ---------------------------------------------------------------------------------------------

/** Total over every arm. An unresolvable reference is `false`; nothing here throws. */
export function evaluatePredicate(p: Predicate, ctx: EvalContext): boolean {
  if ("all" in p) return p.all.every((q) => evaluatePredicate(q, ctx));
  if ("any" in p) return p.any.some((q) => evaluatePredicate(q, ctx));
  if ("not" in p) return !evaluatePredicate(p.not, ctx);
  switch (p.kind) {
    case "node-exists":
      return queryNodes(p.where, ctx).length > 0;
    case "node-absent":
      return queryNodes(p.where, ctx).length === 0;
    case "text-present": {
      for (const node of nodesInScope(p.scope, ctx)) {
        for (const raw of [node.text, node.name]) {
          if (raw !== null && matchText(p.text, raw, "containment", ctx)) return true;
        }
      }
      return false;
    }
    case "node-state": {
      const nodes = queryNodes(p.where, ctx);
      // A state claim about a node that is not there is not true. Fail closed.
      return nodes.length > 0 && nodes.every((n) => n.state[p.state] === p.equals);
    }
    case "value-matches": {
      const nodes = queryNodes(p.where, ctx);
      return (
        nodes.length > 0 && nodes.every((n) => matchText(p.matcher, n.value ?? "", "identity", ctx))
      );
    }
    case "count": {
      const n = queryNodes(p.where, ctx).length;
      return p.op === "eq" ? n === p.n : p.op === "gte" ? n >= p.n : n <= p.n;
    }
    case "route-matches":
      return routeMatches(p.route, ctx);
    case "settled":
      return ctx.observation.stability.settled;
    case "native-dialog": {
      const dialog = ctx.observation.nativeDialog;
      if (dialog === null) return false;
      return p.dialogType === undefined || dialog.type === p.dialogType;
    }
    case "continuity":
      return continuityHolds(p.ref, p.scope, ctx);
  }
}

// ---------------------------------------------------------------------------------------------
// Extraction — SPEC section 4.1: `advance` carries the outputs
// ---------------------------------------------------------------------------------------------

/**
 * Why a declared read could not be performed. Eleven reasons and not one `unknown`, because each
 * one implies a different fix: a different query, a different bound, a different column name, a
 * different parser, or a corrected contract. `output-extraction-failed` is the class; this is the
 * line under it that tells an on-call engineer which.
 */
export type ExtractFailureReason =
  /** The query selected nothing, or the node it selected is blank, and `onMissing` says fail. */
  | "missing"
  /** The query selected more than one node. Picking one of them is a guess with a balance on it. */
  | "ambiguous"
  /** The text is on screen and is not the type the caller was promised. */
  | "unparseable"
  /** More rows than the declared maximum: returning the first `maxRows` of them would be a wrong
   *  answer that looks like a right one. */
  | "truncated"
  /** Fewer rows than the declared minimum. */
  | "too-few-rows"
  /** The output names nothing the contract declares, so nothing knows what type it should be. */
  | "type-not-declared"
  /** A table output read by a step that is not a `readTable`, or row bounds on a scalar output. */
  | "type-mismatch"
  /** A `readTable` with no row bounds. Unbounded iteration is not in this language. */
  | "bounds-not-declared"
  /** A `readTable` with no container scope, which would blend every grid on the screen into one. */
  | "scope-not-declared"
  /** The container the read is scoped to is not on this screen at all. */
  | "scope-absent"
  /** A column the contract declares is absent from the grid, or from one of its rows. */
  | "missing-column";

export type ExtractOutcome =
  | { readonly ok: true; readonly output: ExtractedOutput }
  | {
      readonly ok: false;
      readonly output: string;
      readonly reason: ExtractFailureReason;
      /** Which column, which row, which bound. Names and numbers only - never a cell's contents,
       *  because this string is journaled and a cell on a member screen holds member data. */
      readonly detail?: string;
    };

const unread = (
  spec: ExtractSpec,
  reason: ExtractFailureReason,
  detail?: string,
): ExtractOutcome =>
  detail === undefined
    ? { ok: false, output: spec.output, reason }
    : { ok: false, output: spec.output, reason, detail };

/**
 * One declared read, from the SAME observation the checkpoint verified.
 *
 * Extraction is a pure read, not a surface operation, which is why there is no `read` action on the
 * `Surface` port and why `output-extraction-failed` is testable from a frozen snapshot. The bias
 * throughout is refusal: a value that cannot be read exactly is a loud, debuggable failure rather
 * than a guessed number that reaches a member.
 *
 * The declared TYPE decides which read this is, not the instruction. An outcome's payload is
 * captured by this same function on whatever step detected the outcome, so dispatching on the
 * instruction would make a scalar payload field unreadable on a `readTable` step.
 */
export function readExtractSpec(
  spec: ExtractSpec,
  instruction: InstructionKind,
  ctx: EvalContext,
): ExtractOutcome {
  const declared = ctx.program.outputs[spec.output];
  if (declared === undefined) return unread(spec, "type-not-declared");

  if (declared.type.kind === "table") {
    // Re-checked here rather than left to linker check 7, because `classify` is also called by the
    // conformance suite and by hand-assembled steps, and a grid read out of a single-cell step is
    // the kind of wrongness that reads as a plausible answer.
    if (instruction !== "readTable") {
      return unread(spec, "type-mismatch", `${spec.output} is a table and needs a readTable step`);
    }
    return readTable(spec, declared.type.columns, declared.sensitivity, ctx);
  }
  if (spec.rows !== undefined) {
    return unread(spec, "type-mismatch", `${spec.output} is ${declared.type.kind}, not a table`);
  }

  const nodes = queryNodes(spec.where, ctx);
  if (nodes.length > 1) return unread(spec, "ambiguous", `${nodes.length} nodes matched`);
  const raw = nodes.length === 1 ? extractField(spec.from, sourceOf(nodes[0] as UINode)) : null;
  if (raw === null) {
    if (spec.onMissing === "fail") return unread(spec, "missing");
    return {
      ok: true,
      output: { output: spec.output, value: null, sensitivity: declared.sensitivity },
    };
  }

  const normalized = norm(spec.normalize, raw, ctx);
  const parsed = parse(spec.parse, normalized, { enumValues: enumValuesOf(declared.type) });
  if (!parsed.ok) return unread(spec, "unparseable", `${spec.parse} refused it: ${parsed.reason}`);
  return {
    ok: true,
    output: {
      output: spec.output,
      value: parsed.value as ExtractedValue,
      sensitivity: declared.sensitivity,
    },
  };
}

const sourceOf = (n: UINode) => ({ name: n.name, value: n.value, text: n.text });

function enumValuesOf(type: ValueType): readonly string[] | undefined {
  return type.kind === "enum" ? type.values : undefined;
}

type DeclaredColumns = readonly { readonly name: string; readonly type: ValueType }[];

/**
 * A bounded table read.
 *
 * Four refusals, each of which is a quiet wrong answer somewhere else:
 *
 *   - No scope is a refusal, because the rows of every grid on the screen concatenated into one
 *     result is a coherent-looking table that is a blend of two.
 *   - A column the contract declares and the grid does not have is a refusal, not a row with a
 *     hole in it. A share row with no balance in it is a typed hole the caller was promised would
 *     not exist.
 *   - Two screen columns that read as the same declared column is a refusal, not a preference.
 *   - `onTruncate` has exactly one legal value: reading nine of a member's ten shares and
 *     reporting them as ten is a wrong answer that looks like a right one.
 *
 * The rows are keyed by the CONTRACT's column names, not by the strings on the screen, so two
 * tenants that spell a header differently produce the same typed rows and the difference stays in
 * the one place a per-tenant difference belongs.
 *
 * The cells stay text. The declared column types are checked for presence and used for naming and
 * are deliberately NOT coerced: an `ExtractedValue` row is `Record<string, string>` by
 * construction, and a per-column coercion would need a per-column parser id that `ExtractSpec` does
 * not carry - so the engine would have to guess one, and guessing between a US and an ISO date is
 * exactly the fallback this design refuses. Named as a limit rather than papered over.
 */
function readTable(
  spec: ExtractSpec,
  columns: DeclaredColumns,
  sensitivity: Sensitivity,
  ctx: EvalContext,
): ExtractOutcome {
  const bounds = spec.rows;
  if (bounds === undefined) return unread(spec, "bounds-not-declared");
  if (bounds.maxRows < bounds.minRows) {
    return unread(spec, "bounds-not-declared", "maxRows is below minRows");
  }
  const scope = spec.where.scope;
  if (scope === undefined) return unread(spec, "scope-not-declared");

  const inScope = nodesInScope(scope, ctx);
  if (inScope.length === 0) return unread(spec, "scope-absent");
  const cells = inScope.filter((n) => n.ariaRole === "cell" && n.tablePosition !== null);

  // What this grid prints above each column, keyed by the column's own index. Indexed rather than
  // collected into a set of strings, because two DIFFERENT columns that print the same header is
  // the case that has to stay visible: a set would silently merge them and the read would come
  // back with one of the two, chosen by position.
  const headerByColumn = new Map<number, string>();
  for (const cell of cells) {
    const position = cell.tablePosition;
    if (position === null || position.colHeader === null) continue;
    headerByColumn.set(position.colIndex, position.colHeader);
  }

  // Declared name -> the column index carrying it.
  //
  // TWO ROUTES, and which one applies is the artifact's choice, not the engine's. When the step
  // declares `columnHeaders[name]` the header is matched through the ordinary `TextMatcher` path -
  // so a `token` matcher resolves through `flow.vocabulary` and a tenant overlay reaches it, which
  // is what lets one artifact read a grid headed "Share Balance" at one tenant and "Savings
  // Balance" at the next. When it does not, the CONTRACT's declared column name is matched
  // directly after `std.text@1`, the same fold a person applies when they read a header off a
  // screen. The second route is the one that was there first; it is kept because it is right
  // whenever the header is genuinely tenant-invariant ("Acct", "Opened"), and because every
  // artifact written before `columnHeaders` existed still has to link.
  const columnFor = new Map<string, number>();
  for (const column of columns) {
    const matcher = spec.columnHeaders?.[column.name];
    const hits = [...headerByColumn.entries()]
      .filter(([, header]) =>
        matcher === undefined
          ? norm("std.text@1", header, ctx) === norm("std.text@1", column.name, ctx)
          : matchText(matcher, header, "identity", ctx),
      )
      .map(([index]) => index);
    if (hits.length === 0) return unread(spec, "missing-column", column.name);
    if (hits.length > 1) return unread(spec, "ambiguous", `two columns read as ${column.name}`);
    columnFor.set(column.name, hits[0] as number);
  }

  const byRow = new Map<number, UINode[]>();
  for (const cell of cells) {
    const index = cell.tablePosition?.rowIndex ?? 0;
    const bucket = byRow.get(index) ?? [];
    bucket.push(cell);
    byRow.set(index, bucket);
  }

  const rows: Record<string, string>[] = [];
  for (const index of [...byRow.keys()].sort((a, b) => a - b)) {
    const bucket = byRow.get(index) as UINode[];
    // On a grid with no header markup the headers were read off row zero, so row zero is the
    // header row and not data. Detected rather than assumed: a row every one of whose cells reads
    // as its own column header is a header row on any surface, including one printed again
    // halfway down a long grid, which legacy screens do.
    const isHeaderRow = bucket.every(
      (c) =>
        norm("std.text@1", cellText(c), ctx) ===
        norm("std.text@1", c.tablePosition?.colHeader ?? " ", ctx),
    );
    if (isHeaderRow) continue;

    const row: Record<string, string> = {};
    for (const [name, column] of columnFor) {
      const inColumn = bucket.filter((c) => c.tablePosition?.colIndex === column);
      if (inColumn.length !== 1) return unread(spec, "missing-column", `${name} in row ${index}`);
      const raw = extractField(spec.from, sourceOf(inColumn[0] as UINode));
      if (raw === null) {
        if (spec.onMissing === "fail") return unread(spec, "missing", `${name} in row ${index}`);
        row[name] = "";
        continue;
      }
      row[name] = norm(spec.normalize, raw, ctx);
    }
    rows.push(row);
  }

  if (rows.length > bounds.maxRows) {
    return unread(spec, "truncated", `${rows.length} rows, declared maximum ${bounds.maxRows}`);
  }
  if (rows.length < bounds.minRows) {
    return unread(spec, "too-few-rows", `${rows.length} rows, declared minimum ${bounds.minRows}`);
  }
  return { ok: true, output: { output: spec.output, value: rows, sensitivity } };
}

// ---------------------------------------------------------------------------------------------
// Prose — generated, never authored (SPEC section 4.7)
// ---------------------------------------------------------------------------------------------

/**
 * A matcher rendered for a human, with the two rules that close a real privacy hole: a `ValueRef`
 * renders BY NAME and a template hole renders UNRESOLVED. Neither half of a failure report ever
 * carries a member number, and two runs are told apart by their run id.
 */
export function renderMatcher(matcher: TextMatcher): string {
  switch (matcher.mode) {
    case "exact":
      return `exactly "${matcher.value}"`;
    case "contains":
      return `containing "${matcher.value}"`;
    case "template":
      return `matching "${matcher.value}"`;
    case "token":
      // The token alone. It reads as a placeholder in every position a matcher appears in - "in
      // column <actions-column>", "named <search-button>", "text <not-found-banner> is present" -
      // whereas spelling out "the label" produced "the row whose the label <member-column> cell",
      // and prose a person stumbles over at 2am is prose they stop reading.
      return `<${matcher.token}>`;
  }
}

export function renderValueRef(ref: ValueRef): string {
  switch (ref.from) {
    case "param":
      return `param.${ref.param}`;
    case "output":
      return `${ref.step}.${ref.output}`;
    case "credential":
      return `credential.${ref.key}`;
    case "literal":
      return `"${ref.value}"`;
  }
}

function renderScope(scope: ContainerMatcher | undefined): string {
  if (scope === undefined) return "";
  const parts = scope.path.map((segment) => {
    switch (segment.kind) {
      case "frame":
        return `frame ${renderMatcher(segment.name)}`;
      case "landmark":
        return segment.name === undefined
          ? `the ${segment.role}`
          : `the ${segment.role} named ${renderMatcher(segment.name)}`;
      case "heading-section":
        return `the section headed ${renderMatcher(segment.heading)}`;
      case "table":
        return `the table with columns [${segment.headers.map(renderMatcher).join(", ")}]`;
      case "screen":
        return `screen ${renderMatcher(segment.id)}`;
    }
  });
  return ` inside ${parts.join(", inside ")}`;
}

function renderQuery(query: NodeQuery): string {
  if (query.cell !== undefined) {
    return `the cell in column ${renderMatcher(query.cell.columnHeader)} of the row whose ${renderMatcher(query.cell.rowKey.columnHeader)} cell equals ${renderValueRef(query.cell.rowKey.value)}${renderScope(query.cell.table)}`;
  }
  const bits: string[] = [];
  bits.push(query.role === undefined ? "a node" : `a ${query.role}`);
  if (query.name !== undefined) bits.push(`named ${renderMatcher(query.name)}`);
  if (query.text !== undefined) bits.push(`whose text is ${renderMatcher(query.text)}`);
  if (query.state !== undefined) {
    for (const [key, value] of Object.entries(query.state)) {
      if (value !== undefined) bits.push(`with ${key}=${String(value)}`);
    }
  }
  return `${bits.join(" ")}${renderScope(query.scope)}`;
}

/** One clause of an expectation, in the words a person would use at 2am. */
export function renderPredicate(p: Predicate): string {
  if ("all" in p) return p.all.map(renderPredicate).join(" and ");
  if ("any" in p) return p.any.map(renderPredicate).join(" or ");
  if ("not" in p) return `not (${renderPredicate(p.not)})`;
  switch (p.kind) {
    case "node-exists":
      return `${renderQuery(p.where)} is present`;
    case "node-absent":
      return `${renderQuery(p.where)} is absent`;
    case "text-present":
      return `text ${renderMatcher(p.text)} is present${renderScope(p.scope)}`;
    case "node-state":
      return `${renderQuery(p.where)} has ${p.state}=${String(p.equals)}`;
    case "value-matches":
      return `${renderQuery(p.where)} holds a value ${renderMatcher(p.matcher)}`;
    case "count":
      return `${renderQuery(p.where)} occurs ${p.op === "eq" ? "exactly" : p.op === "gte" ? "at least" : "at most"} ${p.n} time(s)`;
    case "route-matches":
      return `the surface is on route ${p.route}`;
    case "settled":
      return "the surface has settled";
    case "native-dialog":
      return `a native ${p.dialogType ?? ""} dialog is open`.replace("  ", " ");
    case "continuity":
      return `the run is still on the record bound to \`${p.ref}\`${renderScope(p.scope)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// What was actually there
// ---------------------------------------------------------------------------------------------

const SALIENT_ROLES: ReadonlySet<string> = new Set([
  "heading",
  "alert",
  "status",
  "dialog",
  "button",
  "link",
]);

/**
 * Replace every occurrence of a TAINTED bound value with its opaque handle.
 *
 * This is the second line of the taint model and it is not belt-and-braces. The first line is the
 * driver, which blanks a node it knows is bound to a sensitive parameter - but a legacy app prints
 * the member number back at you in a page heading the driver never associated with the field, and
 * `heading` is exactly the role a failure summary is most likely to quote. So the substitution
 * happens once more, here, on the way into the only structure that reaches a journal.
 */
export function redactTaint(
  text: string,
  bindings: ResolvedBindings,
): { text: string; redactions: number } {
  let out = text;
  let redactions = 0;
  for (const binding of bindings) {
    // Every non-literal binding, not only the tainted ones. A parameter value that is merely
    // `internal` is still the caller's, and SPEC section 4.7's rule is that a failure report
    // carries no parameter value at all: two runs are told apart by their `runId`, never by the
    // value they were asked about. An artifact literal is typed `public` by construction and is
    // the artifact's own text, so it stays - blanking it would remove the one thing that makes a
    // row-5 failure ("the value baked into this step was rejected") readable.
    if (binding.origin === "literal" || binding.value.length === 0) continue;
    const parts = out.split(binding.value);
    if (parts.length === 1) continue;
    redactions += parts.length - 1;
    out = parts.join(`<${binding.handle ?? binding.name}>`);
  }
  return { text: out, redactions };
}

/**
 * The redacted summary that goes into a journal, a tool result and an operator's screen.
 *
 * Deliberately a SUMMARY and not an observation: names only, never values, because all three of
 * those places are somewhere a member's account number must not appear by accident. The count of
 * redactions is reported rather than hidden - non-zero is normal on a member screen, and zero on a
 * screen that should have had some is worth noticing.
 */
export function observedSummaryOf(
  observation: Observation,
  bindings: ResolvedBindings,
): ObservedSummary {
  let redactions = observation.nodes.filter((n) => n.masked).length;
  const salient = observation.nodes
    .filter((n) => n.ariaRole !== null && SALIENT_ROLES.has(n.ariaRole))
    .slice(0, 32)
    .map((n) => {
      const redacted = redactTaint(n.name.slice(0, 500), bindings);
      redactions += redacted.redactions;
      return {
        role: n.ariaRole,
        name: redacted.text,
        disabled: n.state.disabled,
        visible: n.state.visible,
      };
    });

  let nativeDialog: ObservedSummary["nativeDialog"] = null;
  if (observation.nativeDialog !== null) {
    const redacted = redactTaint(observation.nativeDialog.message.slice(0, 1024), bindings);
    redactions += redacted.redactions;
    nativeDialog = { type: observation.nativeDialog.type, message: redacted.text };
  }

  // THE ROUTE'S QUERY IS A PLACE A CALLER'S ARGUMENT LIVES, and it used to travel through here in
  // clear. A legacy GET form puts the value the caller supplied in the url, synthesis records that
  // as a `query` binding on the route pattern, and the driver then reports the OBSERVED query
  // beside the canonicalized path - so a failure verdict's `observed` block carried the member
  // number into the journal, into the result document's failure trace and onto the operator's
  // screen, while the frozen observation beside it had the same field blanked. Measured on the
  // live artifact, whose route table declares such a binding; the hand-authored demo artifact
  // declares none, which is why five `pnpm demo` canary runs were clean over the same code.
  //
  // The path needs no pass of its own - it is canonicalized against the artifact's route patterns
  // before it reaches here, so a value in it is already `:memberId` - but the query values are the
  // raw ones and are redacted here, by the same substitution every other field goes through.
  let route = observation.route;
  if (route !== null && Object.keys(route.query).length > 0) {
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(route.query)) {
      const redacted = redactTaint(value, bindings);
      redactions += redacted.redactions;
      query[key] = redacted.text;
    }
    route = { ...route, query };
  }

  return {
    route,
    settled: observation.stability.settled,
    pendingReason: observation.stability.pendingReason,
    skeletonDigest: observation.skeletonDigest,
    nodeCount: observation.nodes.length,
    nativeDialog,
    inputIntercepted: observation.inputIntercepted,
    salient,
    redactionsApplied: redactions,
  };
}
