// The target resolver (SPEC section 5.3): every descriptor against ONE snapshot, then compared.
//
// The governing decision is section 0.5, and every line here follows from it: DISAGREEMENT IS A
// DETECTED CONDITION, NEVER A FALLBACK CHAIN. There is no "try the next strategy", no rank applied
// at replay, no nearest match, no confidence score to threshold. Two independent descriptions of
// "the control" that name different controls are the only evidence we will ever get that the
// surface moved underneath us, and a fallback chain spends that evidence on a confident wrong click.
//
// Four outcomes, and the third is the one people leave out:
//
//   · nothing resolved                    -> target-not-found
//   · resolutions disagree                -> target-ambiguous        (refuse to act)
//   · one node, too little evidence       -> target-underdetermined  (refuse to act)
//   · the node fails its own C1 assertion -> target-assert-failed
//
// `target-underdetermined` earns its own class because it means something operationally different
// from "not found": we found a plausible node and did not have enough INDEPENDENT evidence to touch
// it. That is a "this tenant needs specialization" ticket, and it is exactly the case a rank-ordered
// fallback chain converts into a silent misclick.
//
// The subtle half is what INDEPENDENT means. SPEC section 5.1 calls `distinctEvidenceSources` the
// most important field in that section: three descriptors that all read the same label are a quorum
// of one, because when the vendor renames that label all three die together. Counting the sources a
// descriptor DECLARES is not enough - on an accessibility tree a control's accessible name is very
// often computed FROM the very label another descriptor anchors on, so `role-name` and
// `label-anchored` can declare two sources while reading one piece of evidence, and a naive counter
// waves them through. So this file counts both and takes the smaller: the sources declared, and the
// distinct pieces of screen evidence the agreeing descriptors actually consumed.
//
// Text, containers, row keys and bindings come from `evaluate.ts` rather than from a second copy
// here. That is not tidiness: a detector that scoped differently from the target it guards would be
// a wrong-row bug that no test in either module could see.

import { canonicalJson } from "./canonical-json.js";
import type { DescriptorKind, DescriptorVerdict, EvidenceSource } from "./descriptor-kinds.js";
import type { Descriptor, NodeFingerprint, TargetRef } from "./descriptors.js";
import type { ExpectationTrace, FailureClass, RunWarning, TargetCandidate } from "./diagnostics.js";
import {
  type EvalContext,
  bindingFor,
  containerMatches,
  matchText,
  nodesInScope,
  renderMatcher,
  renderValueRef,
  resolveCell,
  synonymsOf,
} from "./evaluate.js";
import type { ContainerMatcher, ContainerSegmentMatcher, RowKey } from "./matchers.js";
import { normalize } from "./normalizers.js";
import type { Bounds, ContainerSegment, SurfaceCapabilities, UINode } from "./observation.js";
import type { NodeId, Role, TextMatcher } from "./primitives.js";

// ---------------------------------------------------------------------------------------------
// Why a descriptor said nothing
// ---------------------------------------------------------------------------------------------

/**
 * Closed, like every other vocabulary in this package, and for the same reason: an abstention that
 * has been happening quietly for a month is only countable if it has a name. The admission test is
 * that each member implies a different repair.
 */
export type AbstainReason =
  | "unsupported-on-this-surface"
  | "disabled-by-overlay"
  | "scope-absent"
  | "no-match"
  | "role-mismatch"
  | "below-confidence-floor"
  | "unknown-token"
  | "unresolved-value"
  | "anchor-unresolved"
  | "geometry-unavailable";

export const ABSTAIN_PROSE: Readonly<Record<AbstainReason, string>> = {
  "unsupported-on-this-surface": "this surface cannot resolve descriptors of that kind",
  "disabled-by-overlay": "the tenant overlay disabled it",
  "scope-absent": "the container it searches is not on this screen",
  "no-match": "nothing in scope matched",
  "role-mismatch": "what it found is not of the role this step acts on",
  "below-confidence-floor":
    "the driver's confidence in what it found is below this surface's floor",
  "unknown-token": "the label token it uses is not in this tenant's vocabulary",
  "unresolved-value": "a value it compares against is not bound",
  "anchor-unresolved": "its anchor did not resolve to exactly one node",
  "geometry-unavailable": "the nodes carry no comparable geometry",
};

// ---------------------------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------------------------

/** The four outcomes of section 5.3 plus success. Named `status` and spelled exactly as the
 *  classifier's `TargetResolutionStatus`, so a resolution can be handed to `classify` unchanged. */
export type ResolutionStatus =
  | "resolved"
  | "not-found"
  | "ambiguous"
  | "underdetermined"
  | "assert-failed";

export interface ResolutionEvidence {
  /** One row per declared descriptor, in declaration order. Goes straight into
   *  `FailureDetail.candidates`, and is what an operator reads to see WHY. */
  readonly candidates: readonly TargetCandidate[];
  /** Non-fatal integrity notes. `stepId` is `null`: a pure function over one observation does not
   *  know where in a program it was called, so the interpreter stamps it. */
  readonly warnings: readonly RunWarning[];
}

export interface ResolvedTarget extends ResolutionEvidence {
  readonly status: "resolved";
  readonly nodeId: NodeId;
  readonly resolvedNode: UINode;
  readonly fingerprint: NodeFingerprint;
  readonly agreeingDescriptors: readonly string[];
  /** The sources those descriptors DECLARE. */
  readonly declaredSources: readonly EvidenceSource[];
  /** How many survive once descriptors that read the same words off the same screen are collapsed
   *  into one. THIS is the number the quorum was checked against. */
  readonly independentSources: number;
  /** Every clause of the C1 assertion, all of them true. Journalled on success too, because "we
   *  checked" is worth as much as "it failed". */
  readonly assertion: ExpectationTrace;
}

export interface UnresolvedTarget extends ResolutionEvidence {
  readonly status: Exclude<ResolutionStatus, "resolved">;
  readonly failure: FailureClass;
  /** Set only for `assert-failed`: there we know exactly which node refused its own assertion. */
  readonly nodeId: NodeId | null;
  readonly fingerprint: NodeFingerprint | null;
  readonly assertion: ExpectationTrace | null;
  /** One generated line, safe to journal: no parameter value, no node id. */
  readonly reason: string;
}

export type TargetResolutionResult = ResolvedTarget | UnresolvedTarget;

export function isResolved(resolution: TargetResolutionResult): resolution is ResolvedTarget {
  return resolution.status === "resolved";
}

export interface ResolveTargetInput {
  readonly target: TargetRef;
  /** The same context the classifier evaluates against: one observation, the linked program's
   *  facts, and the bindings so far. */
  readonly ctx: EvalContext;
  /** The driver's own statement about what it can resolve and how far it trusts its synthesis. */
  readonly capabilities: SurfaceCapabilities;
  /** Descriptor ids this tenant's overlay disabled at this step. They ABSTAIN rather than vanish,
   *  so the fingerprint keeps a record that the tenant removed evidence. */
  readonly disabledDescriptors?: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Fingerprints - for comparison and diagnostics only, never for lookup
// ---------------------------------------------------------------------------------------------

/**
 * Geometry, quantised hard enough to survive a font rendering difference between two machines and
 * not hard enough to survive a redesign.
 *
 * Eight pixels because sub-pixel text metrics move a control by one or two while a real layout
 * change moves it by more; one cell because a character grid is already quantised, and rounding it
 * further would throw away the only spatial signal that surface has.
 */
export function boundsBucketOf(bounds: Bounds | null): string | null {
  if (bounds === null) return null;
  const step = bounds.unit === "px" ? 8 : 1;
  return `${bounds.unit}:${Math.floor(bounds.w / step)}x${Math.floor(bounds.h / step)}`;
}

/**
 * The fingerprint of a resolved node, or `null` for a structural node - which can never be a target.
 *
 * Note what is absent: the node id (a per-observation handle), the row and column INDEX (layout,
 * i.e. the thing a tenant moves), and every value. What is present is what a human would use to
 * recognise the control again. The accessible NAME is kept raw because the recorded fingerprint is
 * compared against it; anything written to a journal, a tool result or an operator's screen passes
 * the taint model first.
 */
export function fingerprintOf(
  candidate: UINode,
  nodes?: readonly UINode[],
): NodeFingerprint | null {
  if (candidate.ariaRole === null) return null;
  // A Select link sits INSIDE the cell that carries the position, so a fingerprint that read only
  // the node itself would forget which column the control was in - which is the one thing a person
  // comparing two grids would look at first.
  const position =
    candidate.tablePosition ??
    (nodes === undefined ? null : inheritedTablePosition(candidate, nodes));
  return {
    ariaRole: candidate.ariaRole,
    name: candidate.name.length === 0 ? null : candidate.name,
    containerPath: candidate.containerPath,
    tablePosition:
      position === null ? null : { rowHeader: position.rowHeader, colHeader: position.colHeader },
    boundsBucket: boundsBucketOf(candidate.bounds),
  };
}

function inheritedTablePosition(
  candidate: UINode,
  nodes: readonly UINode[],
): UINode["tablePosition"] {
  const byId = new Map<string, UINode>();
  for (const one of nodes) byId.set(one.id, one);
  let current: UINode | null = candidate;
  for (let depth = 0; depth < 16 && current !== null; depth += 1) {
    if (current.tablePosition !== null) return current.tablePosition;
    current = current.parent === null ? null : (byId.get(current.parent) ?? null);
  }
  return null;
}

/** Two descriptors "agree" exactly when they select nodes with equal fingerprints. */
export function fingerprintsEqual(a: NodeFingerprint, b: NodeFingerprint): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// ---------------------------------------------------------------------------------------------
// Descriptors in prose
// ---------------------------------------------------------------------------------------------

const RELATION_PROSE: Readonly<Record<string, string>> = {
  "labelled-by": "labelled by",
  "right-of": "to the right of",
  "left-of": "to the left of",
  below: "below",
  above: "above",
  "same-cell": "in the same cell as",
};

function distanceProse(distance: { readonly unit: "px" | "cell"; readonly value: number }): string {
  return distance.unit === "px" ? `${distance.value}px` : `${distance.value} cells`;
}

function describeSegment(segment: ContainerSegmentMatcher): string {
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
}

/** A breadcrumb in prose, outermost first. */
export function describeContainer(matcher: ContainerMatcher): string {
  return matcher.path.map(describeSegment).join(", inside ");
}

/**
 * A descriptor as a sentence, so an operator never has to read the document.
 *
 * This is the concrete payoff of refusing a pattern language and a selector syntax: every construct
 * the language kept, it kept partly because the interpreter can explain it to a human at 2am. A
 * `ValueRef` renders by NAME and a template hole renders unresolved, so the sentence is safe to
 * journal (SPEC section 4.7).
 */
export function describeDescriptor(descriptor: Descriptor): string {
  switch (descriptor.kind) {
    case "role-name":
      return `the ${descriptor.role} named ${renderMatcher(descriptor.name)}`;
    case "label-anchored":
      return `the ${descriptor.role} ${RELATION_PROSE[descriptor.relation]} the label ${renderMatcher(descriptor.label)}, within ${distanceProse(descriptor.maxDistance)}`;
    case "table-cell":
      return `the ${descriptor.childRole ?? "cell"} in column ${renderMatcher(descriptor.columnHeader)} of the row whose ${renderMatcher(descriptor.rowKey.columnHeader)} cell equals ${renderValueRef(descriptor.rowKey.value)}, inside ${describeContainer(descriptor.table)}`;
    case "ordinal-in-container":
      return `the ${descriptor.role} at position ${descriptor.index + 1} inside ${describeContainer(descriptor.container)}`;
    case "geometric":
      return `the ${descriptor.role} ${RELATION_PROSE[descriptor.direction]} ${describeDescriptor(descriptor.anchor)}, within ${distanceProse(descriptor.maxDistance)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

type Direction = "right-of" | "below" | "left-of" | "above";

/**
 * "To the right of, and on the same line as."
 *
 * The overlap test is what makes it mean what a person means: a control three rows down and far to
 * the right is not "next to" the label, however short the horizontal gap. The same arithmetic works
 * on a character grid, where the unit is a cell.
 */
function withinDirection(
  anchor: Bounds,
  candidate: Bounds,
  direction: Direction,
  max: { readonly unit: "px" | "cell"; readonly value: number },
): boolean {
  if (anchor.unit !== candidate.unit || anchor.unit !== max.unit) return false;
  const verticallyOverlaps =
    candidate.y < anchor.y + anchor.h && anchor.y < candidate.y + candidate.h;
  const horizontallyOverlaps =
    candidate.x < anchor.x + anchor.w && anchor.x < candidate.x + candidate.w;
  const within = (gap: number): boolean => Math.max(0, gap) <= max.value;
  switch (direction) {
    case "right-of":
      return (
        verticallyOverlaps &&
        candidate.x + candidate.w > anchor.x + anchor.w &&
        within(candidate.x - (anchor.x + anchor.w))
      );
    case "left-of":
      return (
        verticallyOverlaps &&
        candidate.x < anchor.x &&
        within(anchor.x - (candidate.x + candidate.w))
      );
    case "below":
      return (
        horizontallyOverlaps &&
        candidate.y + candidate.h > anchor.y + anchor.h &&
        within(candidate.y - (anchor.y + anchor.h))
      );
    case "above":
      return (
        horizontallyOverlaps &&
        candidate.y < anchor.y &&
        within(anchor.y - (candidate.y + candidate.h))
      );
  }
}

// ---------------------------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------------------------

/**
 * The evidence key of a descriptor that identified its target by WHERE IT SITS.
 *
 * Every positional descriptor shares this one key, which is SPEC section 5.2's rule applied at
 * replay time: geometry and ordinal are both properties of LAYOUT, layout is the one thing that
 * legitimately changes when a tenant rebrands, and between them they are therefore one source and
 * not two.
 */
const LAYOUT_EVIDENCE = "layout";

interface Env {
  readonly target: TargetRef;
  readonly ctx: EvalContext;
  readonly capabilities: SurfaceCapabilities;
  readonly scopeNodes: readonly UINode[];
  readonly byId: ReadonlyMap<string, UINode>;
  readonly scopePresent: boolean;
  readonly warnings: RunWarning[];
}

interface Hit {
  readonly hit: UINode;
  /** Opaque keys naming the screen evidence this hit was identified BY. Empty means "position". */
  readonly evidence: readonly string[];
}

interface Selection {
  readonly hits: readonly Hit[];
  /** A better explanation than "nothing matched", when there is one. */
  readonly reason: AbstainReason | null;
}

interface Outcome {
  readonly descriptorId: string;
  readonly kind: DescriptorKind;
  readonly evidenceSource: EvidenceSource;
  readonly rendered: string;
  readonly verdict: DescriptorVerdict;
  readonly hit: UINode | null;
  readonly evidenceKey: string | null;
  readonly reason: AbstainReason | null;
  readonly matched: number;
}

const NOTHING: Selection = { hits: [], reason: null };

function outcomeOf(
  descriptor: Descriptor,
  verdict: DescriptorVerdict,
  extra: Partial<Outcome> = {},
): Outcome {
  return {
    descriptorId: descriptor.id,
    kind: descriptor.kind,
    evidenceSource: descriptor.evidenceSource,
    rendered: describeDescriptor(descriptor),
    verdict,
    hit: null,
    evidenceKey: null,
    reason: null,
    matched: 0,
    ...extra,
  };
}

function evidenceKeyOf(evidence: readonly string[]): string {
  if (evidence.length === 0) return LAYOUT_EVIDENCE;
  return `at:${[...new Set(evidence)].sort().join("+")}`;
}

function foldText(env: Env, value: string): string {
  return normalize("std.text@1", value, { brandingTokens: env.ctx.program.brandingTokens });
}

/** What a node calls itself: its accessible name, falling back to its own text. */
function labelTextOf(candidate: UINode): string {
  return candidate.name.length > 0 ? candidate.name : (candidate.text ?? "");
}

/** What a node DISPLAYS. A legacy back office shows member data in readonly textboxes, so the
 *  value is data as often as the text is. */
function readableTextOf(candidate: UINode): string {
  if (candidate.text !== null && candidate.text.length > 0) return candidate.text;
  if (candidate.value !== null && candidate.value.length > 0) return candidate.value;
  return candidate.name;
}

/**
 * Which nodes provide this node's accessible name.
 *
 * THE CORRELATION DETECTOR. If the name was computed from a label element, then a `role-name`
 * descriptor and a `label-anchored` descriptor anchored on that label are reading the same words
 * off the same screen, and one rename kills both. Declared sources say two; this says one, and this
 * is the one the quorum is checked against.
 *
 * The equality test is what keeps it honest: a control whose accessible name does NOT come from its
 * visible label is genuinely independent evidence and reports itself as such.
 */
function nameEvidenceOf(candidate: UINode, env: Env): readonly string[] {
  if (candidate.labelledBy.length === 0) return [candidate.id];
  const labels = candidate.labelledBy
    .map((id) => env.byId.get(id))
    .filter((found): found is UINode => found !== undefined);
  if (labels.length === 0) return [candidate.id];
  const joined = labels.map(labelTextOf).join(" ");
  return foldText(env, joined) === foldText(env, candidate.name)
    ? labels.map((label) => label.id)
    : [candidate.id];
}

function descendantsOf(root: UINode, env: Env): readonly UINode[] {
  const found: UINode[] = [];
  const seen = new Set<string>([root.id]);
  const stack: UINode[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const childId of current.children) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      const child = env.byId.get(childId);
      if (child === undefined) continue;
      found.push(child);
      stack.push(child);
    }
  }
  return found;
}

/** The node's own table position, or the nearest ancestor's - a Select link lives INSIDE the cell
 *  that carries the position, not on it. */
function tableCellOf(candidate: UINode, env: Env): UINode | null {
  let current: UINode | null = candidate;
  for (let depth = 0; depth < 16 && current !== null; depth += 1) {
    if (current.tablePosition !== null) return current;
    current = current.parent === null ? null : (env.byId.get(current.parent) ?? null);
  }
  return null;
}

/** A stable key for "the same concrete container instance". Every cell of one table shares it. */
function pathKey(path: readonly ContainerSegment[]): string {
  return canonicalJson(path);
}

/**
 * How far into `path` the breadcrumb reached: the shortest prefix the matcher still matches.
 *
 * Built out of the shared `containerMatches` rather than out of a second copy of the subsequence
 * walk, so the two can never disagree about what "inside" means. It is what lets an ordinal
 * descriptor tell two matching containers apart instead of quietly numbering across both.
 */
function containerMatchEnd(
  matcher: ContainerMatcher,
  path: readonly ContainerSegment[],
  ctx: EvalContext,
): number | null {
  for (let end = 0; end <= path.length; end += 1) {
    if (containerMatches(matcher, path.slice(0, end), ctx)) return end;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The five selectors
// ---------------------------------------------------------------------------------------------

function selectRoleName(role: Role, name: TextMatcher, env: Env): Selection {
  const hits: Hit[] = [];
  for (const candidate of env.scopeNodes) {
    if (candidate.ariaRole !== role) continue;
    if (!matchText(name, candidate.name, "identity", env.ctx)) continue;
    hits.push({ hit: candidate, evidence: nameEvidenceOf(candidate, env) });
  }
  return { hits, reason: null };
}

function selectLabelAnchored(
  descriptor: Extract<Descriptor, { kind: "label-anchored" }>,
  label: TextMatcher,
  env: Env,
): Selection {
  // A control is not its own label. Without this exclusion the field named "Member ID" is a
  // candidate label for itself and every legacy form becomes ambiguous.
  const labels = env.scopeNodes.filter(
    (candidate) =>
      candidate.ariaRole !== descriptor.role &&
      matchText(label, labelTextOf(candidate), "identity", env.ctx),
  );
  if (labels.length === 0) return NOTHING;
  let geometryMissing = false;
  const hits: Hit[] = [];
  for (const anchor of labels) {
    for (const candidate of env.scopeNodes) {
      if (candidate.ariaRole !== descriptor.role || candidate.id === anchor.id) continue;
      const related = relatedToLabel(descriptor, anchor, candidate, env);
      if (related === "no-geometry") {
        geometryMissing = true;
        continue;
      }
      if (related) hits.push({ hit: candidate, evidence: [anchor.id] });
    }
  }
  if (hits.length === 0 && geometryMissing) return { hits: [], reason: "geometry-unavailable" };
  return { hits, reason: null };
}

function relatedToLabel(
  descriptor: Extract<Descriptor, { kind: "label-anchored" }>,
  anchor: UINode,
  candidate: UINode,
  env: Env,
): boolean | "no-geometry" {
  switch (descriptor.relation) {
    case "labelled-by":
      return candidate.labelledBy.includes(anchor.id);
    case "same-cell": {
      if (candidate.parent !== null && candidate.parent === anchor.parent) return true;
      const candidateCell = tableCellOf(candidate, env);
      const anchorCell = tableCellOf(anchor, env);
      return candidateCell !== null && anchorCell !== null && candidateCell.id === anchorCell.id;
    }
    default: {
      if (anchor.bounds === null || candidate.bounds === null) return "no-geometry";
      return withinDirection(
        anchor.bounds,
        candidate.bounds,
        descriptor.relation,
        descriptor.maxDistance,
      );
    }
  }
}

/**
 * The row is addressed by a VALUE the caller supplied, never by an index, and the lookup is the
 * same `resolveCell` a detector uses. That shared implementation is the point: a detector and a
 * target that disagreed about which row is row 50001 would be a wrong-row bug invisible to both.
 */
function selectTableCell(
  descriptor: Extract<Descriptor, { kind: "table-cell" }>,
  columnHeader: TextMatcher,
  env: Env,
): Selection {
  if (bindingFor(descriptor.rowKey.value, env.ctx.bindings) === null) {
    return { hits: [], reason: "unresolved-value" };
  }
  const cell = resolveCell(
    { table: descriptor.table, rowKey: descriptor.rowKey, columnHeader },
    env.ctx,
  );
  if (cell === null || cell.tablePosition === null) return NOTHING;

  // Recorded as a guess, compared at replay, correctable by an overlay. A legacy grid gives us
  // structure for free and headers only by looking at row zero; a guess that was never labelled as
  // one cannot be corrected, and a guess that changed is worth a person's attention.
  if (cell.tablePosition.headerProvenance !== descriptor.headerProvenance) {
    env.warnings.push({
      code: "header-provenance-changed",
      stepId: null,
      detail: `${descriptor.id} recorded headers as ${descriptor.headerProvenance}; this surface reports ${cell.tablePosition.headerProvenance}`,
    });
  }

  // The column HEADER is the evidence: it is what the vendor can rename out from under us. The row
  // key is the caller's own value and cannot be renamed by anybody.
  const evidence = [
    `header:${foldText(env, cell.tablePosition.colHeader ?? "")}@${pathKey(cell.containerPath)}`,
  ];
  if (descriptor.childRole === undefined) return { hits: [{ hit: cell, evidence }], reason: null };
  const hits = descendantsOf(cell, env)
    .filter((child) => child.ariaRole === descriptor.childRole)
    .map((child) => ({ hit: child, evidence }));
  return { hits, reason: null };
}

function selectOrdinal(
  descriptor: Extract<Descriptor, { kind: "ordinal-in-container" }>,
  env: Env,
): Selection {
  // Grouped by the CONCRETE container the matcher landed on. Two dialogs that both match means the
  // ordinal names two nodes - an abstention, not a preference for whichever came first.
  const groups = new Map<string, UINode[]>();
  for (const candidate of env.scopeNodes) {
    if (candidate.ariaRole !== descriptor.role) continue;
    const end = containerMatchEnd(descriptor.container, candidate.containerPath, env.ctx);
    if (end === null) continue;
    const key = pathKey(candidate.containerPath.slice(0, end));
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [candidate]);
    else group.push(candidate);
  }
  const hits: Hit[] = [];
  for (const group of groups.values()) {
    const chosen = group[descriptor.index];
    if (chosen !== undefined) hits.push({ hit: chosen, evidence: [] });
  }
  return { hits, reason: null };
}

function selectGeometric(
  descriptor: Extract<Descriptor, { kind: "geometric" }>,
  env: Env,
): Selection {
  const anchor = resolveDescriptor(descriptor.anchor, env, null);
  if (anchor.verdict !== "resolved" || anchor.hit === null) {
    return { hits: [], reason: "anchor-unresolved" };
  }
  const anchorBounds = anchor.hit.bounds;
  if (anchorBounds === null) return { hits: [], reason: "geometry-unavailable" };
  // The anchor's evidence IS this descriptor's evidence. A geometric descriptor contributes a fixed
  // spatial relation and nothing else, so when the thing it is anchored to is renamed it dies too.
  const evidence = anchor.evidenceKey === null ? [] : [anchor.evidenceKey];
  const hits: Hit[] = [];
  let geometryMissing = false;
  for (const candidate of env.scopeNodes) {
    if (candidate.ariaRole !== descriptor.role || candidate.id === anchor.hit.id) continue;
    if (candidate.bounds === null) {
      geometryMissing = true;
      continue;
    }
    if (
      withinDirection(anchorBounds, candidate.bounds, descriptor.direction, descriptor.maxDistance)
    ) {
      hits.push({ hit: candidate, evidence });
    }
  }
  if (hits.length === 0 && geometryMissing) return { hits: [], reason: "geometry-unavailable" };
  return { hits, reason: null };
}

// ---------------------------------------------------------------------------------------------
// One descriptor
// ---------------------------------------------------------------------------------------------

/** The matcher carrying the descriptor's IDENTITY - the one whose synonyms are tried one at a time.
 *  Positional descriptors have none, and a geometric one delegates to its anchor. */
function primaryMatcherOf(descriptor: Descriptor): TextMatcher | null {
  switch (descriptor.kind) {
    case "role-name":
      return descriptor.name;
    case "label-anchored":
      return descriptor.label;
    case "table-cell":
      return descriptor.columnHeader;
    default:
      return null;
  }
}

const TEMPLATE_HOLE = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * One matcher per spelling this tenant accepts, or `null` when the matcher cannot be evaluated at
 * all - an undeclared token, or a hole with no argument bound.
 *
 * The plurality is not a convenience: SPEC section 2.4 says two synonyms resolving DIFFERENT nodes
 * is an ambiguity rather than a preference for whichever the tenant listed first, and that is only
 * expressible if the caller can put one synonym on the screen at a time.
 */
function alternativesOf(matcher: TextMatcher, env: Env): readonly TextMatcher[] | null {
  if (matcher.mode === "token") {
    const synonyms = synonymsOf(matcher.token, env.ctx);
    if (synonyms.length === 0) return null;
    return synonyms.map((value) => ({ mode: "exact", value, normalize: matcher.normalize }));
  }
  if (matcher.mode === "template") {
    for (const hole of matcher.value.matchAll(TEMPLATE_HOLE)) {
      const name = hole[1];
      if (name === undefined) continue;
      if (bindingFor({ from: "param", param: name }, env.ctx.bindings) === null) return null;
    }
  }
  return [matcher];
}

function resolveDescriptor(descriptor: Descriptor, env: Env, roleGate: Role | null): Outcome {
  if (!env.capabilities.resolvableDescriptors.includes(descriptor.kind)) {
    return outcomeOf(descriptor, "abstained", { reason: "unsupported-on-this-surface" });
  }
  if (!env.scopePresent) {
    return outcomeOf(descriptor, "abstained", { reason: "scope-absent" });
  }

  const primary = primaryMatcherOf(descriptor);
  const alternatives = primary === null ? null : alternativesOf(primary, env);
  if (primary !== null && alternatives === null) {
    return outcomeOf(descriptor, "abstained", {
      reason: primary.mode === "token" ? "unknown-token" : "unresolved-value",
    });
  }

  const selections: Selection[] = [];
  for (const alternative of alternatives ?? [null]) {
    switch (descriptor.kind) {
      case "role-name":
        selections.push(selectRoleName(descriptor.role, alternative ?? descriptor.name, env));
        break;
      case "label-anchored":
        selections.push(selectLabelAnchored(descriptor, alternative ?? descriptor.label, env));
        break;
      case "table-cell":
        selections.push(selectTableCell(descriptor, alternative ?? descriptor.columnHeader, env));
        break;
      case "ordinal-in-container":
        selections.push(selectOrdinal(descriptor, env));
        break;
      case "geometric":
        selections.push(selectGeometric(descriptor, env));
        break;
    }
  }
  return combine(descriptor, selections, roleGate, env);
}

/**
 * What the descriptor concluded once every spelling has spoken.
 *
 * The order of the three filters is SPEC section 5.3's, and every one of them fails closed: the role
 * gate first (acting on a node of the wrong KIND is the most dangerous mis-hit there is), then
 * uniqueness - several matches ABSTAIN, a descriptor never picks the first - then the driver's own
 * confidence floor.
 */
function combine(
  descriptor: Descriptor,
  selections: readonly Selection[],
  roleGate: Role | null,
  env: Env,
): Outcome {
  const byId = new Map<string, Hit>();
  let sawRoleMismatch = false;
  for (const selection of selections) {
    for (const candidate of selection.hits) {
      if (roleGate !== null && candidate.hit.ariaRole !== roleGate) {
        sawRoleMismatch = true;
        continue;
      }
      const existing = byId.get(candidate.hit.id);
      byId.set(
        candidate.hit.id,
        existing === undefined
          ? candidate
          : { hit: candidate.hit, evidence: [...existing.evidence, ...candidate.evidence] },
      );
    }
  }

  if (byId.size > 1) return outcomeOf(descriptor, "non-unique", { matched: byId.size });

  const only = [...byId.values()][0];
  if (only === undefined) {
    const specific = selections.find((selection) => selection.reason !== null)?.reason ?? null;
    const reason: AbstainReason = specific ?? (sawRoleMismatch ? "role-mismatch" : "no-match");
    return outcomeOf(descriptor, "abstained", { reason });
  }
  if (only.hit.confidence < env.capabilities.confidenceFloor) {
    return outcomeOf(descriptor, "abstained", { reason: "below-confidence-floor" });
  }
  return outcomeOf(descriptor, "resolved", {
    hit: only.hit,
    evidenceKey: evidenceKeyOf(only.evidence),
    matched: 1,
  });
}

// ---------------------------------------------------------------------------------------------
// Control C1 - the pre-act assertion
// ---------------------------------------------------------------------------------------------

interface AssertionResult {
  readonly ok: boolean;
  readonly trace: ExpectationTrace;
}

/**
 * The strongest control in the design: before dispatch, re-derive the identity of the thing we are
 * about to act on from data we already know rather than from where it sits.
 *
 * `rowKeyEquals` is the wrong-row killer (case W1 of SPEC section 4.5). You cannot click the wrong
 * member's row when the row is selected by the member id the caller asked about, and it costs one
 * comparison.
 */
function evaluateAssertion(target: TargetRef, hit: UINode, env: Env): AssertionResult {
  const assertion = target.assert;
  const clauses: {
    readonly rendered: string;
    readonly verdict: boolean;
    readonly nodeSummary?: string;
  }[] = [
    {
      rendered: `is a ${assertion.role}`,
      verdict: hit.ariaRole === assertion.role,
      nodeSummary: `${hit.ariaRole ?? "structure"} named ${JSON.stringify(hit.name)}`,
    },
  ];
  if (assertion.name !== undefined) {
    clauses.push({
      rendered: `is named ${renderMatcher(assertion.name)}`,
      verdict: matchText(assertion.name, hit.name, "identity", env.ctx),
    });
  }
  if (assertion.enabled !== undefined) {
    clauses.push({
      rendered: assertion.enabled ? "is enabled" : "is disabled",
      verdict: !hit.state.disabled === assertion.enabled,
    });
  }
  if (assertion.visible !== undefined) {
    clauses.push({
      rendered: assertion.visible ? "is visible" : "is hidden",
      verdict: hit.state.visible === assertion.visible,
    });
  }
  if (assertion.rowKeyEquals !== undefined) {
    clauses.push({
      rendered: `sits in the row whose ${renderMatcher(assertion.rowKeyEquals.columnHeader)} is ${renderValueRef(assertion.rowKeyEquals.value)}`,
      verdict: rowKeyHolds(assertion.rowKeyEquals, hit, env),
    });
  }
  return {
    ok: clauses.every((clause) => clause.verdict),
    trace: {
      rendered: `the target ${clauses.map((clause) => clause.rendered).join(" and ")}`,
      clauses,
    },
  };
}

function rowKeyHolds(rowKey: RowKey, hit: UINode, env: Env): boolean {
  const binding = bindingFor(rowKey.value, env.ctx.bindings);
  if (binding === null) return false;
  const cell = tableCellOf(hit, env);
  if (cell === null || cell.tablePosition === null) return false;
  const table = pathKey(cell.containerPath);
  const rowIndex = cell.tablePosition.rowIndex;

  const keyCells = env.ctx.observation.nodes.filter((candidate) => {
    const position = candidate.tablePosition;
    return (
      position !== null &&
      position.rowIndex === rowIndex &&
      position.colHeader !== null &&
      pathKey(candidate.containerPath) === table &&
      matchText(rowKey.columnHeader, position.colHeader, "identity", env.ctx)
    );
  });
  // Exactly one cell, unmasked, equal. Two cells claiming to be the key column is an ambiguity and
  // fails closed - this is the last gate before an irreversible action, and a masked cell has had
  // its text blanked by the taint model, so comparing against it would be comparing against a blank.
  const keyCell = keyCells.length === 1 ? keyCells[0] : undefined;
  if (keyCell === undefined || keyCell.masked) return false;
  return foldText(env, readableTextOf(keyCell)) === foldText(env, binding.value);
}

// ---------------------------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------------------------

function candidateOf(
  outcome: Outcome,
  verdict: DescriptorVerdict,
  nodes: readonly UINode[],
): TargetCandidate {
  return {
    descriptorId: outcome.descriptorId,
    kind: outcome.kind,
    evidenceSource: outcome.evidenceSource,
    verdict,
    nodeId: outcome.hit === null ? null : outcome.hit.id,
    fingerprint: outcome.hit === null ? null : fingerprintOf(outcome.hit, nodes),
    rendered: outcome.rendered.slice(0, 1000),
  };
}

function explainOutcome(outcome: Outcome): string {
  if (outcome.verdict === "non-unique") {
    return `${outcome.descriptorId} matched ${outcome.matched} nodes`;
  }
  return `${outcome.descriptorId} - ${ABSTAIN_PROSE[outcome.reason ?? "no-match"]}`;
}

function dedupe(warnings: readonly RunWarning[]): readonly RunWarning[] {
  const seen = new Set<string>();
  const kept: RunWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}|${warning.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(warning);
  }
  return kept;
}

/**
 * Resolve a target against ONE observation.
 *
 * Every descriptor is evaluated against the same snapshot, and that is load-bearing: if the
 * resolver re-observed between descriptors, two of them could legitimately disagree because the
 * page changed underneath them, and the whole agreement mechanism would be measuring latency
 * instead of ambiguity.
 */
export function resolveTarget(input: ResolveTargetInput): TargetResolutionResult {
  const { target, ctx } = input;
  const disabled = new Set(input.disabledDescriptors ?? []);
  const byId = new Map<string, UINode>();
  for (const candidate of ctx.observation.nodes) byId.set(candidate.id, candidate);
  const scopeNodes = nodesInScope(target.scope, ctx);
  const warnings: RunWarning[] = [];
  const env: Env = {
    target,
    ctx,
    capabilities: input.capabilities,
    scopeNodes,
    byId,
    scopePresent: scopeNodes.length > 0,
    warnings,
  };

  const outcomes: Outcome[] = [];
  for (const descriptor of target.descriptors) {
    if (disabled.has(descriptor.id)) {
      warnings.push({
        code: "descriptor-disabled-by-overlay",
        stepId: null,
        detail: `${descriptor.id} (${descriptor.kind}) is disabled for this tenant`,
      });
      outcomes.push(outcomeOf(descriptor, "disabled", { reason: "disabled-by-overlay" }));
      continue;
    }
    outcomes.push(resolveDescriptor(descriptor, env, target.role));
  }

  const agreeing = outcomes.filter(
    (outcome): outcome is Outcome & { hit: UINode } =>
      outcome.verdict === "resolved" && outcome.hit !== null,
  );
  // SPEC section 5.1 defines agreement as EQUAL FINGERPRINTS; within one snapshot this compares the
  // node itself, which is strictly stronger and deliberately so. Two different controls with
  // identical fingerprints - the same role, name and quantised size in the same container - are the
  // most dangerous thing on the screen, and fingerprint equality would call them agreement and then
  // have to choose one. `fingerprintsEqual` is what the drift report compares against
  // `recordedNode`, which is a comparison ACROSS observations and the case it was written for.
  const distinctNodes = new Set(agreeing.map((outcome) => outcome.hit.id));

  // ------------------------------------------------------------------------------------------
  // Two independent descriptions of "the control" named different controls. REFUSE TO ACT. This is
  // not a case for a fallback ranking; it is the case a ranking would hide.
  // ------------------------------------------------------------------------------------------
  if (distinctNodes.size > 1) {
    return {
      status: "ambiguous",
      failure: "target-ambiguous",
      nodeId: null,
      fingerprint: null,
      assertion: null,
      reason: `${agreeing.length} descriptors resolved to ${distinctNodes.size} different nodes and the run refused to choose between them`,
      candidates: outcomes.map((outcome) =>
        candidateOf(
          outcome,
          outcome.verdict === "resolved" ? "disagreed" : outcome.verdict,
          ctx.observation.nodes,
        ),
      ),
      warnings: dedupe(warnings),
    };
  }

  const candidates = outcomes.map((outcome) =>
    candidateOf(outcome, outcome.verdict, ctx.observation.nodes),
  );
  const agreed = agreeing[0];
  if (agreed === undefined) {
    return {
      status: "not-found",
      failure: "target-not-found",
      nodeId: null,
      fingerprint: null,
      assertion: null,
      reason: `no descriptor resolved: ${outcomes.map(explainOutcome).join("; ")}`.slice(0, 1000),
      candidates,
      warnings: dedupe(warnings),
    };
  }

  // ------------------------------------------------------------------------------------------
  // The quorum. Count the agreeing descriptors, and count the INDEPENDENT evidence beneath them.
  // ------------------------------------------------------------------------------------------
  // `requireIdentical`, `expectUnique` and `onUnderQuorum` are typed as literals and are therefore
  // not branched on anywhere in this file - not because they were forgotten, but because identical
  // is the only comparison implemented, several matches always abstain, and under quorum always
  // fails. A configurable version of any of the three would be a fallback chain with a flag.
  const quorum = target.quorum;
  const declaredSources = [...new Set(agreeing.map((outcome) => outcome.evidenceSource))];
  const evidenceKeys = new Set(agreeing.map((outcome) => outcome.evidenceKey ?? LAYOUT_EVIDENCE));
  // The smaller of the two counts. Declared sources catch a target built entirely out of one KIND
  // of evidence; evidence keys catch descriptors that declare different sources and then read the
  // same words off the same screen - the case that looks safe and is not.
  const independentSources = Math.min(declaredSources.length, evidenceKeys.size);

  if (agreeing.length < quorum.min || independentSources < quorum.distinctEvidenceSources) {
    return {
      status: "underdetermined",
      failure: "target-underdetermined",
      nodeId: null,
      fingerprint: null,
      assertion: null,
      reason:
        agreeing.length < quorum.min
          ? `${agreeing.length} of the ${quorum.min} required descriptors resolved`
          : `${agreeing.length} descriptors agreed but they rest on ${independentSources} independent piece(s) of evidence, and ${quorum.distinctEvidenceSources} are required`,
      candidates,
      warnings: dedupe(warnings),
    };
  }

  const fingerprint = fingerprintOf(agreed.hit, ctx.observation.nodes);
  const assertion = evaluateAssertion(target, agreed.hit, env);
  const failedClauses = assertion.trace.clauses.filter((clause) => !clause.verdict);
  if (failedClauses.length > 0 || fingerprint === null) {
    return {
      status: "assert-failed",
      failure: "target-assert-failed",
      nodeId: agreed.hit.id,
      fingerprint,
      assertion: assertion.trace,
      reason: (failedClauses.length > 0
        ? `the resolved node failed its own assertion: it ${failedClauses
            .map((clause) => clause.rendered)
            .join(", and it ")}`
        : "the resolved node carries no role of its own, so nothing may be dispatched at it"
      ).slice(0, 1000),
      candidates,
      warnings: dedupe(warnings),
    };
  }

  // A run that succeeded on two of four descriptors succeeded - and the operator should know the
  // margin is thinning before the day it reaches zero.
  for (const outcome of outcomes) {
    if (outcome.verdict !== "abstained" && outcome.verdict !== "non-unique") continue;
    warnings.push({
      code: "descriptor-abstaining",
      stepId: null,
      detail:
        outcome.verdict === "non-unique"
          ? `${outcome.descriptorId} matched ${outcome.matched} nodes and abstained`
          : `${outcome.descriptorId} abstained: ${ABSTAIN_PROSE[outcome.reason ?? "no-match"]}`,
    });
  }

  return {
    status: "resolved",
    nodeId: agreed.hit.id,
    resolvedNode: agreed.hit,
    fingerprint,
    agreeingDescriptors: agreeing.map((outcome) => outcome.descriptorId),
    declaredSources,
    independentSources,
    assertion: assertion.trace,
    candidates,
    warnings: dedupe(warnings),
  };
}
