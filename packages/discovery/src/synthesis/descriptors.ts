// `deriveDescriptors` - SPEC section 5.2. The model's entire contribution to a locator is a NODE ID
// from the observation it was shown; this file computes the locator.
//
// The model never sees a descriptor, never writes one, and never edits one. It picked `n7` off a
// filtered listing; deterministic code then reads the frozen `Observation` that `n7` indexed into
// and computes a ranked set of INDEPENDENTLY DERIVED descriptions of that node. That separation is
// BRIEF section 3.2 and it is the reason a recording can be reviewed: every identity in the
// artifact is a function of a snapshot a reviewer can also read.
//
// TWO DERIVATION RULES DO THE WORK, both from SPEC section 5.2:
//
//   1. A descriptor is emitted only if it resolves to EXACTLY ONE node in the recorded observation,
//      and that node is the one the model picked. Uniqueness is a verified property at record time,
//      not a hope at replay time.
//   2. The emitted set must cover at least two distinct `EvidenceSource` values, and `geometry` +
//      `ordinal` cannot satisfy that between them - both are properties of LAYOUT, and layout is
//      the one thing that legitimately changes when a tenant rebrands.
//
// RULE 1 IS CHECKED WITH THE REPLAY RESOLVER ITSELF, not with a second implementation. Each
// candidate is evaluated by `resolveTarget` from `@crr/core` as a single-descriptor probe. Writing
// a private uniqueness check here would be writing a second definition of "matches", and the day
// the two disagreed the artifact would record a descriptor the engine cannot resolve - a
// wrong-target bug invisible to every test in either module. It is the same argument `evaluate.ts`
// makes about detectors and targets sharing `resolveCell`, with a package boundary added.
//
// What is NOT here, deliberately: no stylesheet selector, no document path expression, no node id,
// no ranked fallback chain. Rank exists - it lives in `@crr/core`, never in the artifact - and it
// decides which candidates are worth computing and in what order a human reads them. It never
// decides anything at replay time, where disagreement is a refusal (SPEC section 5.4).

import {
  type ContainerMatcher,
  type ContainerSegment,
  type ContainerSegmentMatcher,
  type Descriptor,
  type DescriptorKind,
  type EvalContext,
  type EvidenceSource,
  type LabelToken,
  LabelTokenSchema,
  type NodeFingerprint,
  type NodeId,
  type NonGeometricDescriptor,
  type Observation,
  type Quorum,
  type ResolvedBinding,
  type Role,
  type RowKey,
  type SurfaceCapabilities,
  type TargetAssertion,
  type TargetRef,
  type TextMatcher,
  type UINode,
  containerMatches,
  fingerprintOf,
  resolveTarget,
  unsafeTextReason,
} from "@crr/core";
import {
  type ValueBinding,
  containsBoundValue,
  labelTokenOf,
  parameterizeText,
  uniqueName,
} from "./values.js";

// ---------------------------------------------------------------------------------------------
// The vocabulary - SPEC section 9.3, the multi-tenant hinge
// ---------------------------------------------------------------------------------------------

/**
 * Every piece of screen WORDING that reaches a document goes through here and comes back as a
 * symbolic token, with the tenant's actual spelling recorded once in `flow.vocabulary`.
 *
 * That is what makes the second tenant a nine-line overlay instead of an edit at forty matchers:
 * an overlay REPLACES a token's synonym list, so "Member ID" versus "Member #" is one line rather
 * than a re-record. Deriving the tokens here rather than asking the model for them also keeps the
 * model's own phrasing out of the artifact.
 *
 * The one exception, and it is the important one: wording that CONTAINS A BOUND VALUE never becomes
 * a token. A vocabulary entry reading "No member found for 50001" would persist the member number
 * in the one file that is committed, reviewed and signed. Such wording becomes a `template` matcher
 * with a parameter hole instead - which is exactly the construct SPEC section 5.6 says regular
 * expressions were refused in favour of.
 */
export class Vocabulary {
  private readonly tokenByText = new Map<string, LabelToken>();
  private readonly synonyms = new Map<string, readonly string[]>();
  private readonly taken = new Set<string>();

  constructor(private readonly bindings: readonly ValueBinding[]) {}

  /**
   * A matcher for a piece of wording, or `null` when there is nothing to match on.
   *
   * `std.label@1` rather than `std.text@1` because this is a LABEL position: it folds case and
   * whitespace, strips a trailing colon, and strips the tenant's branding tokens, which is what
   * makes "Member ID:" at one tenant and "Member ID" at the next the same identity.
   */
  matcher(text: string): TextMatcher | null {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;
    if (containsBoundValue(trimmed, this.bindings)) {
      return {
        mode: "template",
        value: parameterizeText(trimmed, this.bindings),
        normalize: "std.label@1",
      };
    }
    // Wording that has the SHAPE of regulated data never becomes a vocabulary entry, even though no
    // parameter was bound to it. Parameterization only removes values the GOAL mentioned; a card
    // number or an email address that happens to be printed on the screen was never a parameter and
    // would otherwise ride into the committed vocabulary on the back of a label-anchored
    // descriptor. `unsafeTextReason` is the same guard the artifact validator applies at seal time,
    // so refusing here turns a confusing late rejection into a missing descriptor and a note.
    if (unsafeTextReason(trimmed) !== null) return null;
    return { mode: "token", token: this.token(trimmed), normalize: "std.label@1" };
  }

  private token(text: string): LabelToken {
    const key = text.trim().toLowerCase();
    const existing = this.tokenByText.get(key);
    if (existing !== undefined) return existing;
    const minted = LabelTokenSchema.parse(uniqueName(labelTokenOf(text, "label"), this.taken));
    this.tokenByText.set(key, minted);
    this.synonyms.set(minted, [text.trim()]);
    return minted;
  }

  /** `flow.vocabulary`. One synonym per token: what this tenant's screen actually said. */
  record(): Readonly<Record<string, readonly string[]>> {
    const out: Record<string, readonly string[]> = {};
    for (const [token, spellings] of this.synonyms) out[token] = spellings;
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------

/** `ContainerMatcher.path` is capped at 8 and a node's `containerPath` at 16, so a deeply nested
 *  node keeps the INNERMOST eight - the segments nearest the control are the ones that discriminate
 *  between two controls that look alike. */
const MAX_CONTAINER_SEGMENTS = 8;

/**
 * A node's breadcrumb as a matcher.
 *
 * Frame names are matched EXACTLY and everything else by token. That split is not cosmetic: a frame
 * name is author-assigned markup that no user ever reads (driver rule D3 keeps the name chain
 * precisely because it is stable), while a landmark's name, a section's heading and a table's
 * column headers are WORDING that a tenant rebrands. Putting the second group in the vocabulary is
 * what lets an overlay repair them; putting the first group there would invite an overlay to
 * rewrite the application's structure.
 *
 * A heading section's LEVEL is deliberately dropped. The words in the heading are the identity; the
 * markup level is the kind of detail a redesign changes without changing what the screen means.
 */
export function containerMatcherOf(
  path: readonly ContainerSegment[],
  vocabulary: Vocabulary,
): ContainerMatcher | null {
  const kept = path.slice(Math.max(0, path.length - MAX_CONTAINER_SEGMENTS));
  const segments: ContainerSegmentMatcher[] = [];
  for (const segment of kept) {
    const matcher = segmentMatcherOf(segment, vocabulary);
    if (matcher !== null) segments.push(matcher);
  }
  if (segments.length === 0) return null;
  return { path: segments };
}

function segmentMatcherOf(
  segment: ContainerSegment,
  vocabulary: Vocabulary,
): ContainerSegmentMatcher | null {
  switch (segment.kind) {
    case "frame":
      return {
        kind: "frame",
        name: { mode: "exact", value: segment.name, normalize: "std.identity@1" },
      };
    case "landmark": {
      const name = segment.name === null ? null : vocabulary.matcher(segment.name);
      return name === null
        ? { kind: "landmark", role: segment.role }
        : { kind: "landmark", role: segment.role, name };
    }
    case "heading-section": {
      const heading = vocabulary.matcher(segment.heading);
      if (heading === null) return null;
      return { kind: "heading-section", heading };
    }
    case "table": {
      const headers: TextMatcher[] = [];
      for (const header of segment.headers) {
        const matcher = vocabulary.matcher(header);
        if (matcher !== null) headers.push(matcher);
      }
      if (headers.length === 0) return null;
      return { kind: "table", headers };
    }
    case "screen":
      return {
        kind: "screen",
        id: { mode: "exact", value: segment.id, normalize: "std.identity@1" },
      };
  }
}

/** The breadcrumb up to and including the innermost `table` segment, or `null` when the node is
 *  not inside a table at all. */
function tableMatcherOf(
  path: readonly ContainerSegment[],
  vocabulary: Vocabulary,
): ContainerMatcher | null {
  let last = -1;
  path.forEach((segment, index) => {
    if (segment.kind === "table") last = index;
  });
  if (last < 0) return null;
  return containerMatcherOf(path.slice(0, last + 1), vocabulary);
}

// ---------------------------------------------------------------------------------------------
// Distances
// ---------------------------------------------------------------------------------------------

interface Distance {
  readonly unit: "px" | "cell";
  readonly value: number;
}

/**
 * A measured gap, rounded up to a round number and then doubled.
 *
 * SPEC section 5.6 refuses recorded TIMINGS as replay budgets - "recording that the page took
 * 840 ms and setting an 840 ms timeout is the classic way to manufacture flake". A recorded
 * DISTANCE has the same failure mode for the same reason: a font that renders one pixel wider at
 * the next tenant would put the control outside a tight bound. So the measurement decides the
 * order of magnitude and nothing finer, with a factor of two of headroom - and the descriptor is
 * kept only if it still resolves uniquely at that width.
 */
function distanceBucket(gap: number, unit: "px" | "cell"): Distance {
  const step = unit === "px" ? 16 : 2;
  const rounded = Math.max(step, Math.ceil(Math.max(0, gap) / step) * step);
  return { unit, value: Math.min(10_000, rounded * 2) };
}

// ---------------------------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------------------------

export interface DeriveDescriptorsInput {
  /** The frozen observation the node id indexes into. Nothing else is read. */
  readonly observation: Observation;
  readonly nodeId: NodeId;
  /** What the driver says it can resolve, so a descriptor kind this surface cannot evaluate is
   *  never recorded as evidence it will never supply. */
  readonly capabilities: SurfaceCapabilities;
  /** Values that became parameters. They make row keys and template holes resolvable at derivation
   *  time, which is what lets uniqueness be VERIFIED here with the same values the run used. */
  readonly bindings: readonly ValueBinding[];
  readonly vocabulary: Vocabulary;
}

/** A candidate that did not survive, and why. Reported rather than dropped: a target down to two
 *  descriptors is a target whose margin is thinning, and SPEC section 5.5 says the operator should
 *  know before the day it reaches zero. */
export interface RejectedDescriptor {
  readonly kind: DescriptorKind;
  readonly reason: string;
}

export interface DescriptorDerivation {
  readonly scope: ContainerMatcher;
  readonly role: Role;
  readonly descriptors: readonly Descriptor[];
  readonly rejected: readonly RejectedDescriptor[];
  readonly evidenceSources: readonly EvidenceSource[];
  /**
   * True when the emitted set satisfies SPEC section 5.2 rule 2. False means the recorder found a
   * plausible node and not enough independent evidence to act on it - which blocks approval and is
   * NOT repaired by inventing a sixth strategy.
   */
  readonly independent: boolean;
  readonly recordedNode: NodeFingerprint;
  /** The row key this node's row is addressed by, when one exists. Reused by control C1. */
  readonly rowKey: RowKey | null;
}

/** Layout is one source of evidence however many descriptors read it. SPEC section 5.2's second
 *  rule, as a set. */
const LAYOUT_SOURCES: ReadonlySet<EvidenceSource> = new Set(["ordinal", "geometry"]);

/**
 * The ranked, independently computed descriptions of one node.
 *
 * Pure and deterministic: same observation and same node id, same output, with nothing running.
 * That is what makes SPEC section 11's acceptance test for this unit - "frozen-Observation
 * derivation tests" - a test rather than an integration.
 */
export function deriveDescriptors(input: DeriveDescriptorsInput): DescriptorDerivation | null {
  const { observation, nodeId, capabilities, vocabulary } = input;
  const node = observation.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined || node.ariaRole === null) return null;

  const scope = containerMatcherOf(node.containerPath, vocabulary);
  if (scope === null) return null;

  const role = node.ariaRole;
  const rejected: RejectedDescriptor[] = [];
  const kept: Descriptor[] = [];
  const byId = new Map(observation.nodes.map((one) => [one.id as string, one]));
  const rowKey = rowKeyFor(node, observation, input.bindings, vocabulary, byId);

  // The evaluation context is rebuilt for every probe, and that is not wastefulness. Building a
  // candidate MINTS vocabulary tokens, and `evalContextOf` snapshots the vocabulary; a context
  // captured once would be missing the very token the descriptor it is about to evaluate refers to,
  // and every `token` matcher would abstain with "unknown token". The bug reads as "no descriptor
  // could be derived", which is the most misleading shape it could have taken.
  const consider = (candidate: Descriptor | null, kind: DescriptorKind, absent: string): void => {
    if (candidate === null) {
      rejected.push({ kind, reason: absent });
      return;
    }
    if (!capabilities.resolvableDescriptors.includes(kind)) {
      rejected.push({ kind, reason: "this surface does not resolve descriptors of that kind" });
      return;
    }
    const verdict = probe(candidate, scope, role, evalContextOf(input), capabilities, nodeId);
    if (verdict === "unique") kept.push(candidate);
    else rejected.push({ kind, reason: verdict });
  };

  consider(roleNameOf(node, vocabulary), "role-name", "the node has no accessible name");
  consider(
    labelAnchoredOf(node, observation, capabilities, vocabulary),
    "label-anchored",
    "no label is associated with the node, by markup or by position",
  );
  consider(
    tableCellOf(node, rowKey, vocabulary, byId),
    "table-cell",
    "the node is not in a table row addressable by a bound value",
  );
  consider(
    ordinalOf(node, scope, evalContextOf(input)),
    "ordinal-in-container",
    "the node has no stable position among its same-role siblings",
  );

  // Rank 5 last, and only once something better has survived. A geometric descriptor is a fixed
  // spatial relation to another control; on its own it is a coordinate, and SPEC section 5.1 is
  // blunt that a coordinate is the character grid's stylesheet selector.
  const anchored = kept.some(isNonGeometric);
  consider(
    anchored ? geometricOf(node, observation, capabilities, vocabulary) : null,
    "geometric",
    anchored
      ? "the node carries no geometry relative to a named anchor"
      : "no non-positional descriptor survived to anchor to",
  );

  const ordered = rank(kept);
  const sources = [...new Set(ordered.map((descriptor) => descriptor.evidenceSource))];
  const nonLayout = sources.filter((source) => !LAYOUT_SOURCES.has(source));
  const independent = ordered.length >= 2 && sources.length >= 2 && nonLayout.length >= 1;

  const fingerprint = fingerprintOf(node, observation.nodes);
  if (fingerprint === null) return null;

  return {
    scope,
    role,
    descriptors: ordered.slice(0, 8),
    rejected,
    evidenceSources: sources,
    independent,
    recordedNode: scrubFingerprint(fingerprint, input.bindings),
    rowKey,
  };
}

/**
 * The recorded fingerprint, with any bound value replaced by its parameter hole.
 *
 * This field is the easiest place in the whole document to persist a member number by accident:
 * `NodeFingerprint.name` is the raw accessible name, the schema types it as a plain string because
 * a fingerprint is compared rather than matched, and nobody reads it during review. A cell whose
 * accessible name IS the member number would carry it straight into the signed artifact. Replay
 * folds the observed name the same way before comparing, so a hole compares equal to a hole and the
 * drift signal keeps working.
 */
function scrubFingerprint(
  fingerprint: NodeFingerprint,
  bindings: readonly ValueBinding[],
): NodeFingerprint {
  const position = fingerprint.tablePosition;
  return {
    ariaRole: fingerprint.ariaRole,
    name: fingerprint.name === null ? null : parameterizeText(fingerprint.name, bindings),
    containerPath: fingerprint.containerPath,
    boundsBucket: fingerprint.boundsBucket,
    tablePosition:
      position === null
        ? null
        : {
            rowHeader:
              position.rowHeader === null ? null : parameterizeText(position.rowHeader, bindings),
            colHeader:
              position.colHeader === null ? null : parameterizeText(position.colHeader, bindings),
          },
  };
}

function isNonGeometric(descriptor: Descriptor): descriptor is NonGeometricDescriptor {
  return descriptor.kind !== "geometric";
}

const RANK: Readonly<Record<DescriptorKind, number>> = {
  "role-name": 1,
  "label-anchored": 2,
  "table-cell": 3,
  "ordinal-in-container": 4,
  geometric: 5,
};

/** Declaration order is rank order, so a human reading the artifact sees the strongest identity
 *  first. Presentation only: the resolver evaluates all of them and compares (SPEC section 5.3). */
function rank(descriptors: readonly Descriptor[]): readonly Descriptor[] {
  return [...descriptors].sort((a, b) => RANK[a.kind] - RANK[b.kind]);
}

// ---------------------------------------------------------------------------------------------
// The five candidate builders
// ---------------------------------------------------------------------------------------------

function roleNameOf(node: UINode, vocabulary: Vocabulary): Descriptor | null {
  if (node.ariaRole === null) return null;
  const name = vocabulary.matcher(node.name);
  if (name === null) return null;
  return {
    id: "role-name",
    kind: "role-name",
    evidenceSource: "accessibleName",
    role: node.ariaRole,
    name,
  };
}

/**
 * The wording this node is labelled BY, in preference order, before any vocabulary token is minted.
 *
 * Split out of `labelAnchoredOf` because two different units need the same evidence and neither may
 * be allowed to compute it a second time. `labelAnchoredOf` turns it into a `label-anchored`
 * DESCRIPTOR; `inferParameters` (SPEC section 6.3) turns it into the parameter's NAME when the
 * field itself has no accessible name, which on a `<font>`-tag frameset is the normal case rather
 * than the exception. A private copy in the parameter namer would be a second definition of "what
 * this field is called", and the day the two disagreed the artifact would resolve one label and
 * publish an argument named after another.
 *
 * Preference order, and the reason for it: `labelledBy` first because that is the APPLICATION
 * telling us what the label is; the nearest adjacent text second because a legacy layout table
 * routinely associates a label with a field by putting them in neighbouring cells and nothing else.
 * Returns `[]` - never a guess - when the node carries neither.
 */
export interface LabelAnchor {
  readonly text: string;
  readonly relation: "labelled-by" | "right-of" | "below";
  /** Distance to the anchor in `unit`s. Always 0 for `labelled-by`: that association is structural,
   *  and the field exists only because the spatial relations need it. */
  readonly gap: number;
}

export function labelAnchorsOf(
  node: UINode,
  observation: Observation,
  unit: "px" | "cell" | null,
): readonly LabelAnchor[] {
  const anchors: LabelAnchor[] = [];

  const explicit = node.labelledBy
    .map((labelId) => observation.nodes.find((one) => one.id === labelId))
    .filter((one): one is UINode => one !== undefined);
  const marked = explicit.map(readableName).join(" ").trim();
  if (marked.length > 0) anchors.push({ text: marked, relation: "labelled-by", gap: 0 });

  if (unit === null) return anchors;
  const nearest = nearestLabel(node, observation, unit);
  if (nearest === null) return anchors;
  const adjacent = readableName(nearest.node).trim();
  if (adjacent.length > 0) {
    anchors.push({ text: adjacent, relation: nearest.relation, gap: nearest.gap });
  }
  return anchors;
}

/**
 * "The box next to Member ID", by markup association first and by position second.
 *
 * The first anchor whose wording the vocabulary will accept wins. Falling through rather than
 * failing matters: `Vocabulary.matcher` refuses wording that carries a regulated shape, and a
 * markup label the vocabulary will not take must not shadow an adjacent one it would.
 */
function labelAnchoredOf(
  node: UINode,
  observation: Observation,
  capabilities: SurfaceCapabilities,
  vocabulary: Vocabulary,
): Descriptor | null {
  if (node.ariaRole === null) return null;
  const unit = capabilities.boundsUnit;
  for (const anchor of labelAnchorsOf(node, observation, unit)) {
    const label = vocabulary.matcher(anchor.text);
    if (label === null) continue;
    return {
      id: "label-anchored",
      kind: "label-anchored",
      evidenceSource: "labelText",
      label,
      role: node.ariaRole,
      relation: anchor.relation,
      maxDistance: distanceBucket(anchor.gap, unit ?? "px"),
    };
  }
  return null;
}

interface LabelHit {
  readonly node: UINode;
  /** Where the CONTROL sits relative to the label, which is the direction the descriptor states. */
  readonly relation: "right-of" | "below";
  readonly gap: number;
}

/**
 * How far a spatial label association may reach, as a multiple of the CONTROL's own height.
 *
 * A label is adjacent by definition. Without a ceiling, the nearest text ANYWHERE above a control
 * qualifies - so a lone field at the bottom of a form gets "labelled" by the heading four hundred
 * pixels up, the descriptor resolves uniquely on the recorded screen, and the recorder reports two
 * independent evidence sources where there is really one. The failure is worse than a missing
 * descriptor, because it is a missing descriptor wearing a quorum.
 *
 * Expressed as a multiple of the control's own height rather than as a pixel count so that it means
 * the same thing on a character grid, where the unit is a cell. Eight is generous - a form label
 * sits within a line or two - and still an order of magnitude tighter than a screen's width.
 */
const LABEL_REACH_HEIGHTS = 8;

/** The label a person would read as belonging to this control: the nearest text to its left, then
 *  the nearest above it. Left before above, because that is the reading order of a form. */
function nearestLabel(
  node: UINode,
  observation: Observation,
  unit: "px" | "cell",
): LabelHit | null {
  const bounds = node.bounds;
  if (bounds === null || bounds.unit !== unit) return null;
  const reach = Math.max(1, bounds.h) * LABEL_REACH_HEIGHTS;
  let best: LabelHit | null = null;
  for (const candidate of observation.nodes) {
    if (candidate.id === node.id) continue;
    if (candidate.ariaRole === node.ariaRole) continue;
    const other = candidate.bounds;
    if (other === null || other.unit !== unit) continue;
    if (readableName(candidate).trim().length === 0) continue;
    // The contents of a DATA row are data, not labels. Anchoring on one would make a locator out of
    // one member's name and put that name in the committed vocabulary - and it would break on the
    // next member anyway, which is the tell that it was never an identity in the first place.
    if (candidate.tablePosition !== null && candidate.tablePosition.rowIndex > 0) continue;
    const overlapsRow = other.y < bounds.y + bounds.h && bounds.y < other.y + other.h;
    const overlapsColumn = other.x < bounds.x + bounds.w && bounds.x < other.x + other.w;
    if (overlapsRow && other.x + other.w <= bounds.x) {
      const gap = bounds.x - (other.x + other.w);
      if (gap > reach) continue;
      if (best === null || gap < best.gap) best = { node: candidate, relation: "right-of", gap };
      continue;
    }
    if (overlapsColumn && other.y + other.h <= bounds.y) {
      const gap = bounds.y - (other.y + other.h);
      if (gap > reach) continue;
      if (best === null || gap < best.gap) best = { node: candidate, relation: "below", gap };
    }
  }
  return best;
}

function readableName(node: UINode): string {
  if (node.name.trim().length > 0) return node.name;
  return node.text ?? "";
}

/**
 * "The Select link on the row whose Member ID is the member we were asked about" - how a person
 * does it, and the one descriptor that cannot click the wrong member's row.
 *
 * It requires a ROW KEY BOUND TO A PARAMETER. A row addressed by index replays perfectly against a
 * grid that returned its rows in a different order and reads the wrong member's balance, so a table
 * row with no value-addressable key produces no descriptor at all rather than a positional one
 * wearing a table's clothes.
 */
function tableCellOf(
  node: UINode,
  rowKey: RowKey | null,
  vocabulary: Vocabulary,
  byId: ReadonlyMap<string, UINode>,
): Descriptor | null {
  if (node.ariaRole === null || rowKey === null) return null;
  const cell = enclosingCell(node, byId);
  if (cell === null || cell.tablePosition === null) return null;
  // `resolveCell` looks for nodes whose role is `cell`. A structural wrapper that merely carries a
  // table position is not addressable, and must not be described as if it were.
  if (cell.ariaRole !== "cell") return null;
  const table = tableMatcherOf(cell.containerPath, vocabulary);
  if (table === null) return null;
  const columnHeader = vocabulary.matcher(cell.tablePosition.colHeader ?? "");
  if (columnHeader === null) return null;
  const provenance = cell.tablePosition.headerProvenance;
  if (cell.id === node.id) {
    return {
      id: "table-cell",
      kind: "table-cell",
      evidenceSource: "columnHeader",
      table,
      rowKey,
      columnHeader,
      headerProvenance: provenance,
    };
  }
  return {
    id: "table-cell",
    kind: "table-cell",
    evidenceSource: "columnHeader",
    table,
    rowKey,
    columnHeader,
    childRole: node.ariaRole,
    headerProvenance: provenance,
  };
}

/** The node's own table cell, or the nearest ancestor that is one. A Select link lives INSIDE the
 *  cell that carries the position, not on it. */
function enclosingCell(node: UINode, byId: ReadonlyMap<string, UINode>): UINode | null {
  let current: UINode | null = node;
  for (let depth = 0; depth < 16 && current !== null; depth += 1) {
    if (current.tablePosition !== null) return current;
    current = current.parent === null ? null : (byId.get(current.parent) ?? null);
  }
  return null;
}

/**
 * The column whose cell in this node's row holds a value the caller supplied. Exported because an
 * extraction wants the same row addressing a target does - reading a balance out of a grid is as
 * exposed to the wrong row as clicking one is.
 *
 * The rest of the doc comment:
 *
 * This is the wrong-row killer of SPEC section 5.1 in derived form, and it is where
 * parameterization pays for itself a second time: with no parameter there is no value to address
 * the row by, and the only remaining way to name a row is its index.
 */
export function rowKeyFor(
  node: UINode,
  observation: Observation,
  bindings: readonly ValueBinding[],
  vocabulary: Vocabulary,
  byId: ReadonlyMap<string, UINode>,
): RowKey | null {
  const cell = enclosingCell(node, byId);
  if (cell === null || cell.tablePosition === null) return null;
  const rowIndex = cell.tablePosition.rowIndex;
  const table = JSON.stringify(cell.containerPath);
  for (const candidate of observation.nodes) {
    const position = candidate.tablePosition;
    if (position === null || position.rowIndex !== rowIndex) continue;
    if (candidate.ariaRole !== "cell" || position.colHeader === null) continue;
    if (JSON.stringify(candidate.containerPath) !== table) continue;
    const text = (candidate.value ?? candidate.text ?? candidate.name).trim();
    const binding = bindings.find((one) => one.value.trim() === text);
    if (binding === undefined) continue;
    const columnHeader = vocabulary.matcher(position.colHeader);
    if (columnHeader === null) continue;
    return { columnHeader, value: { from: "param", param: binding.param } };
  }
  return null;
}

/**
 * Position among same-role siblings, counted the way the resolver counts it.
 *
 * `selectOrdinal` groups candidates by the CONCRETE container the scope matcher landed on - the
 * shortest prefix of the node's breadcrumb the matcher still matches - so that two dialogs matching
 * the same description are two groups rather than one numbered across both. Re-deriving that here
 * from the shared `containerMatches` rather than approximating it with "the same breadcrumb" is
 * what keeps the recorded index and the replayed index the same number.
 */
function ordinalOf(node: UINode, scope: ContainerMatcher, ctx: EvalContext): Descriptor | null {
  if (node.ariaRole === null) return null;
  const key = groupKey(scope, node.containerPath, ctx);
  if (key === null) return null;
  const group = ctx.observation.nodes.filter(
    (candidate) =>
      candidate.ariaRole === node.ariaRole && groupKey(scope, candidate.containerPath, ctx) === key,
  );
  const index = group.findIndex((candidate) => candidate.id === node.id);
  if (index < 0 || index > 1000) return null;
  return {
    id: "ordinal-in-container",
    kind: "ordinal-in-container",
    evidenceSource: "ordinal",
    container: scope,
    role: node.ariaRole,
    index,
  };
}

function groupKey(
  scope: ContainerMatcher,
  path: readonly ContainerSegment[],
  ctx: EvalContext,
): string | null {
  for (let end = 0; end <= path.length; end += 1) {
    if (containerMatches(scope, path.slice(0, end), ctx)) return JSON.stringify(path.slice(0, end));
  }
  return null;
}

/**
 * Rank 5. A spatial relation to a NAMED anchor, never to a coordinate.
 *
 * The anchor is inline and may not itself be geometric, which makes a cycle impossible by
 * construction rather than by a graph check somebody has to remember to run (SPEC section 10
 * check 12, discharged by the type). It is built with the same `role-name` builder the target uses,
 * pointed at the label the control sits next to.
 */
function geometricOf(
  node: UINode,
  observation: Observation,
  capabilities: SurfaceCapabilities,
  vocabulary: Vocabulary,
): Descriptor | null {
  if (node.ariaRole === null) return null;
  const unit = capabilities.boundsUnit;
  if (unit === null) return null;
  const reference = nearestLabel(node, observation, unit);
  if (reference === null) return null;
  const anchor = roleNameOf(reference.node, vocabulary);
  if (anchor === null || anchor.kind !== "role-name") return null;
  return {
    id: "geometric",
    kind: "geometric",
    evidenceSource: "geometry",
    anchor: { ...anchor, id: "geometric-anchor" },
    role: node.ariaRole,
    direction: reference.relation,
    maxDistance: distanceBucket(reference.gap, unit),
  };
}

// ---------------------------------------------------------------------------------------------
// Rule 1: uniqueness, checked with the replay resolver
// ---------------------------------------------------------------------------------------------

const PROBE_QUORUM: Quorum = {
  // One descriptor, one source: the probe asks "does THIS description name exactly one node", and
  // the real quorum - two descriptors, two independent sources - is applied to the surviving set.
  min: 1,
  distinctEvidenceSources: 1,
  requireIdentical: true,
  onUnderQuorum: "fail",
  expectUnique: true,
};

/** Shape only. `resolveTarget` never reads `recordedNode` - that is the drift comparison, made
 *  against a LATER observation - so the probe supplies the cheapest legal value. */
const PROBE_FINGERPRINT: NodeFingerprint = {
  ariaRole: "text",
  name: null,
  containerPath: [],
  tablePosition: null,
  boundsBucket: null,
};

/**
 * `unique` when the descriptor selects exactly the node the model picked, otherwise the reason.
 *
 * The probe target is never persisted; it lives for the length of this call. What matters is that
 * the ANSWER comes from `@crr/core`'s resolver, so "resolves uniquely at record time" and "resolves
 * uniquely at replay time" are the same sentence evaluated by the same code.
 */
function probe(
  descriptor: Descriptor,
  scope: ContainerMatcher,
  role: Role,
  ctx: EvalContext,
  capabilities: SurfaceCapabilities,
  nodeId: NodeId,
): "unique" | string {
  const target: TargetRef = {
    scope,
    role,
    descriptors: [descriptor],
    quorum: PROBE_QUORUM,
    assert: { role },
    recordedNode: PROBE_FINGERPRINT,
  };
  const resolution = resolveTarget({ target, ctx, capabilities });
  if (resolution.status !== "resolved") {
    const candidate = resolution.candidates[0];
    return candidate === undefined
      ? resolution.status
      : `${resolution.status}: the descriptor ${candidate.verdict}`;
  }
  if (resolution.nodeId !== nodeId) {
    return "it resolves to a different node than the one the model acted on";
  }
  return "unique";
}

function evalContextOf(input: DeriveDescriptorsInput): EvalContext {
  return {
    observation: input.observation,
    program: {
      routes: [],
      vocabulary: input.vocabulary.record(),
      continuity: [],
      outputs: {},
      brandingTokens: [],
      maxEffect: "READ",
      restartSafeUpToPc: 0,
      resumePoints: [],
    },
    bindings: resolvedBindingsOf(input.bindings),
  };
}

/** The parameters, as the evaluator's binding list. `handle` is null because derivation runs over
 *  an observation the driver has already masked; nothing here reveals a bound value. */
function resolvedBindingsOf(bindings: readonly ValueBinding[]): readonly ResolvedBinding[] {
  return bindings.map((binding) => ({
    name: binding.param,
    origin: "param" as const,
    value: binding.value,
    sensitivity: binding.sensitivity,
    handle: null,
  }));
}

// ---------------------------------------------------------------------------------------------
// The target
// ---------------------------------------------------------------------------------------------

/**
 * The quorum every derived target carries.
 *
 * Two descriptors and two INDEPENDENT sources, and not more. Requiring every surviving descriptor
 * to agree would fail a run that succeeded on two of four - SPEC section 5.5 is explicit that such
 * a run succeeded and that a thinning margin is a ticket rather than an outage. The three literal
 * fields are literals in the schema too, so no overlay can configure the refusal away.
 */
export const DERIVED_QUORUM: Quorum = {
  min: 2,
  distinctEvidenceSources: 2,
  requireIdentical: true,
  onUnderQuorum: "fail",
  expectUnique: true,
};

/**
 * Control C1: what must be true of the node before anything is dispatched at it.
 *
 * `rowKeyEquals` is included whenever the row is addressable, because it is the cheapest control in
 * the design and it converts the worst silent failure - acting on the wrong member's row - into a
 * loud one. The name clause re-derives the identity from the vocabulary rather than from where the
 * node sits.
 */
export function assertionOf(
  derivation: DescriptorDerivation,
  node: UINode,
  vocabulary: Vocabulary,
): TargetAssertion {
  const name = vocabulary.matcher(node.name);
  const base: TargetAssertion = {
    role: derivation.role,
    enabled: !node.state.disabled,
    visible: node.state.visible,
  };
  const withName: TargetAssertion = name === null ? base : { ...base, name };
  return derivation.rowKey === null ? withName : { ...withName, rowKeyEquals: derivation.rowKey };
}

/** The derivation as the `TargetRef` a step carries. */
export function targetRefOf(
  derivation: DescriptorDerivation,
  node: UINode,
  vocabulary: Vocabulary,
): TargetRef {
  return {
    scope: derivation.scope,
    role: derivation.role,
    descriptors: derivation.descriptors,
    quorum: DERIVED_QUORUM,
    assert: assertionOf(derivation, node, vocabulary),
    recordedNode: derivation.recordedNode,
  };
}
